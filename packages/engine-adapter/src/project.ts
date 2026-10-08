// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { z } from "zod";
import categoryMap from "./category-map.json" with { type: "json" };
import { AdapterError } from "./errors.js";
import { EngineConnection, type EngineOptions, type ServerInfo } from "./engine.js";
import { readSnapshot, relativeName, sameSnapshot, type Snapshot } from "./snapshot.js";
import {
  NativeQueries,
  parseInput,
  findInputSchema,
  describeInputSchema,
  libraryInputSchema,
  type FindInput,
  type DescribeInput,
  type LibraryInput,
  type ElementSummary,
  type ElementDescription,
  type QueryAnswer,
} from "./queries.js";

const diagnosticSchema = z.object({
  severity: z
    .string()
    .refine((s) => ["error", "warning", "info", "hint"].includes(s.toLowerCase())),
  message: z.string(),
  code: z.string().default(""),
  span: z
    .object({
      file: z.string().default(""),
      startLine: z.number().int().nonnegative().default(0),
      startCol: z.number().int().nonnegative().default(0),
      endLine: z.number().int().nonnegative().default(0),
      endCol: z.number().int().nonnegative().default(0),
    })
    .default({ file: "", startLine: 0, startCol: 0, endLine: 0, endCol: 0 }),
});
const parseSchema = z.object({
  modelHash: z.string().min(1),
  diagnostics: z.array(diagnosticSchema).default([]),
  error: z.string().default(""),
});
export interface ProjectOptions {
  projectRoot: string;
  modelRoots?: string[];
  engine: EngineOptions;
}
export interface ValidateInput {
  paths?: string[];
  cursor?: string;
  limit?: number;
}
interface Cursor {
  revision: number;
  offset: number;
  paths: string[];
}
type RawDiagnostic = z.infer<typeof diagnosticSchema>;
interface Diagnostic {
  id: string;
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  category: string;
  message: string;
  raw: RawDiagnostic;
}
interface Counts {
  errors: number;
  warnings: number;
}
export interface ValidationResult {
  status: "errors" | "incomplete";
  engine: { name: "OpenSysML"; version: string };
  library: { name: string; identity: "bundled-with-engine"; version: null };
  completeness: {
    parse: "unknown";
    libraryLoad: "unknown";
    resolution: "unknown";
    reasons: string[];
  };
  checks: { performed: string[]; notProven: string[] };
  content: {
    sessionId: string;
    projectRevision: number;
    files: { file: string; revision: number }[];
  };
  project: Counts;
  scope: Counts & { paths: string[] };
  diagnostics: Diagnostic[];
  nextCursor: string | null;
}
interface Cache {
  snapshot: Snapshot;
  diagnostics: Diagnostic[];
  info: ServerInfo;
  modelHash: string;
  generation: number;
}

type QueryItem = ElementSummary | ElementDescription;
type QueryKind = "find_element" | "describe_element" | "library_lookup";
export interface ModelQueryResult<T = QueryItem> {
  status: "answered" | "partial";
  source: "project" | "bundled-library";
  engine: { name: "OpenSysML"; version: string };
  content: { sessionId: string; projectRevision: number | null };
  validation: ({ status: "errors" | "incomplete" } & Counts) | null;
  items: T[];
  total: number;
  nextCursor: string | null;
  limitations: string[];
}
interface QueryPage {
  kind: QueryKind;
  filters: string;
  snapshot: Snapshot | null;
  revision: number;
  generation: number;
  offset: number;
  answer: QueryAnswer<QueryItem>;
}

function counts(diagnostics: Diagnostic[]): Counts {
  return {
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };
}
function category(d: RawDiagnostic): string {
  return (
    categoryMap.rules.find(
      (rule) =>
        (!rule.code || rule.code === d.code) &&
        (!rule.messageRegex || new RegExp(rule.messageRegex, "i").test(d.message)),
    )?.category ?? "UNCLASSIFIED"
  );
}

export class ProjectSession {
  private readonly engine: EngineConnection;
  private readonly sessionId = randomUUID();
  private revision = 0;
  private cache: Cache | undefined;
  private versions = new Map<string, number>();
  private cursors = new Map<string, Cursor>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private libraryCache: { modelHash: string; generation: number } | undefined;
  private queryPages = new Map<string, QueryPage>();

  constructor(private readonly options: ProjectOptions) {
    this.engine = new EngineConnection(options.engine);
  }

  validate(input: ValidateInput = {}, signal?: AbortSignal): Promise<ValidationResult> {
    return this.enqueue(() => this.validateNow(input, signal), signal);
  }

  async findElement(input: FindInput = {}, signal?: AbortSignal): Promise<ModelQueryResult> {
    return this.query("find_element", parseInput(findInputSchema, input), signal);
  }

  async describeElement(input: DescribeInput, signal?: AbortSignal): Promise<ModelQueryResult> {
    return this.query("describe_element", parseInput(describeInputSchema, input), signal);
  }

  async libraryLookup(input: LibraryInput, signal?: AbortSignal): Promise<ModelQueryResult> {
    return this.query("library_lookup", parseInput(libraryInputSchema, input), signal);
  }

  private enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new AdapterError("ENGINE_UNAVAILABLE", "The project session is closed."),
      );
    if (this.pending >= 8)
      return Promise.reject(
        new AdapterError("QUEUE_FULL", "The project already has too many pending requests."),
      );
    this.pending += 1;
    const operation = this.queue
      .then(async () => {
        if (this.closed)
          throw new AdapterError("ENGINE_UNAVAILABLE", "The project session is closed.");
        if (signal?.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
        return work();
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.queue = operation.catch(() => undefined);
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new AdapterError("CANCELLED", "The request was cancelled."));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async validateNow(input: ValidateInput, signal?: AbortSignal): Promise<ValidationResult> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new AdapterError("LIMIT_EXCEEDED", "The page limit must be an integer from 1 to 500.");
    const requestedPaths = [...new Set((input.paths ?? []).map(relativeName))].sort();
    const previous = this.cache;
    const before = await readSnapshot(
      this.options.projectRoot,
      this.options.modelRoots ?? ["model"],
      signal,
    );
    let offset = 0,
      paths = requestedPaths;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor);
      if (
        !cursor ||
        !previous ||
        !this.engine.connected ||
        previous.generation !== this.engine.generation ||
        cursor.revision !== this.revision ||
        !sameSnapshot(previous.snapshot, before)
      )
        throw new AdapterError(
          "STALE_CURSOR",
          "The diagnostic page belongs to an expired project revision.",
        );
      if (input.paths && JSON.stringify(requestedPaths) !== JSON.stringify(cursor.paths))
        throw new AdapterError(
          "STALE_CURSOR",
          "A diagnostic cursor cannot change its path filter.",
        );
      offset = cursor.offset;
      paths = cursor.paths;
    }
    await this.loadSnapshot(before, signal);
    const cached = this.cache;
    if (!cached)
      throw new AdapterError(
        "ENGINE_UNAVAILABLE",
        "Validation did not produce a project snapshot.",
      );
    const scoped = cached.diagnostics.filter(
      (d) =>
        paths.length === 0 ||
        paths.some((p) => p === "." || d.file === p || d.file.startsWith(p + "/")),
    );
    const page = scoped.slice(offset, offset + limit);
    let nextCursor: string | null = null;
    if (offset + limit < scoped.length) {
      if (this.cursors.size >= 512) this.cursors.delete(this.cursors.keys().next().value!);
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, { revision: this.revision, offset: offset + limit, paths });
    }
    const project = counts(cached.diagnostics);
    return {
      status: project.errors ? "errors" : "incomplete",
      engine: { name: "OpenSysML", version: cached.info.version },
      library: {
        name: "OpenSysML bundled standard library",
        identity: "bundled-with-engine",
        version: null,
      },
      completeness: {
        parse: "unknown",
        libraryLoad: "unknown",
        resolution: "unknown",
        reasons: [
          "The native API returns diagnostics but does not certify validation completeness or report an independently verified library version.",
        ],
      },
      checks: {
        performed: ["OpenSysML ParseSources in strict conformance mode"],
        notProven: [
          "Complete standard coverage",
          "Missing-library detection",
          "Independent acceptance",
        ],
      },
      content: {
        sessionId: this.sessionId,
        projectRevision: this.revision,
        files: cached.snapshot.documents.map((d) => ({
          file: d.name,
          revision: this.versions.get(d.name)!,
        })),
      },
      project,
      scope: { ...counts(scoped), paths },
      diagnostics: page,
      nextCursor,
    };
  }

  private async loadSnapshot(before: Snapshot, signal?: AbortSignal): Promise<Cache> {
    const previous = this.cache;
    if (
      !previous ||
      !sameSnapshot(previous.snapshot, before) ||
      !this.engine.connected ||
      previous.generation !== this.engine.generation
    ) {
      const info = await this.engine.start(signal);
      if (
        !["parse_sources", "strict_conformance", "inline_language"].every((c) =>
          info.capabilities.includes(c),
        )
      )
        throw new AdapterError(
          "UNSUPPORTED_CAPABILITY",
          "The engine does not advertise the required multi-file validation capabilities.",
        );
      const parsed = parseSchema.safeParse(
        await this.engine.request(
          "ParseSources",
          { documents: before.documents, strictConformance: true },
          signal,
        ),
      );
      if (!parsed.success || parsed.data.error)
        throw new AdapterError(
          "ENGINE_PROTOCOL_ERROR",
          "The engine did not return a complete validation response.",
        );
      const after = await readSnapshot(
        this.options.projectRoot,
        this.options.modelRoots ?? ["model"],
        signal,
      );
      if (!sameSnapshot(before, after))
        throw new AdapterError(
          "PROJECT_CHANGED",
          "Project files changed during validation; validate the saved files again.",
        );
      for (const doc of before.documents) {
        if (previous?.snapshot.documents.find((d) => d.name === doc.name)?.content !== doc.content)
          this.versions.set(doc.name, (this.versions.get(doc.name) ?? 0) + 1);
      }
      this.revision += 1;
      this.cursors.clear();
      this.cache = {
        snapshot: before,
        info,
        modelHash: parsed.data.modelHash,
        generation: this.engine.generation,
        diagnostics: parsed.data.diagnostics.map((d, i) => ({
          id: `r${this.revision}-d${i + 1}`,
          file: d.span.file || "<engine>",
          line: d.span.startLine,
          column: d.span.startCol,
          severity: d.severity.toLowerCase() as Diagnostic["severity"],
          category: category(d),
          message: d.message,
          raw: d,
        })),
      };
    }
    return this.cache!;
  }

  private query(
    kind: QueryKind,
    input: FindInput | DescribeInput | LibraryInput,
    signal?: AbortSignal,
  ): Promise<ModelQueryResult> {
    return this.enqueue(async () => {
      const deadline = AbortSignal.timeout(this.options.engine.timeoutMs ?? 30000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        return await this.queryNow(kind, input, combined);
      } catch (error) {
        if (deadline.aborted && !signal?.aborted)
          throw new AdapterError("TIMEOUT", "The model query exceeded its total deadline.");
        throw error;
      }
    }, signal);
  }

  private async queryNow(
    kind: QueryKind,
    input: FindInput | DescribeInput | LibraryInput,
    signal: AbortSignal,
  ): Promise<ModelQueryResult> {
    const library = kind === "library_lookup";
    const limit = "limit" in input ? (input.limit ?? 50) : 50;
    const cursor = "cursor" in input ? input.cursor : undefined;
    const filters: Record<string, unknown> = { ...input };
    delete filters.cursor;
    delete filters.limit;
    const fingerprint = JSON.stringify(filters);
    const before = library
      ? null
      : await readSnapshot(this.options.projectRoot, this.options.modelRoots ?? ["model"], signal);
    let page: QueryPage;
    if (cursor) {
      const stored = this.queryPages.get(cursor);
      if (
        !stored ||
        stored.kind !== kind ||
        !this.engine.connected ||
        stored.generation !== this.engine.generation ||
        (!library &&
          (!before ||
            !stored.snapshot ||
            stored.revision !== this.revision ||
            !sameSnapshot(before, stored.snapshot))) ||
        (Object.keys(filters).length > 0 && fingerprint !== stored.filters)
      )
        throw new AdapterError(
          "STALE_CURSOR",
          "This cursor belongs to another query, session or project revision.",
        );
      page = stored;
    } else {
      const info = await this.engine.start(signal);
      if (!info.capabilities.includes("query"))
        throw new AdapterError(
          "UNSUPPORTED_CAPABILITY",
          "The engine does not advertise native model queries.",
        );
      let modelHash: string;
      if (library) {
        if (!this.libraryCache || this.libraryCache.generation !== this.engine.generation) {
          if (
            !["parse_sources", "strict_conformance", "inline_language"].every((c) =>
              info.capabilities.includes(c),
            )
          )
            throw new AdapterError(
              "UNSUPPORTED_CAPABILITY",
              "The engine cannot initialize the required library query context.",
            );
          const parsed = parseSchema.safeParse(
            await this.engine.request(
              "ParseSources",
              {
                documents: [{ name: "library-query.sysml", language: "sysml", content: "" }],
                strictConformance: true,
              },
              signal,
            ),
          );
          if (
            !parsed.success ||
            parsed.data.error ||
            parsed.data.diagnostics.some((d) => d.severity.toLowerCase() === "error")
          )
            throw new AdapterError(
              "QUERY_UNAVAILABLE",
              "The engine could not initialize an isolated bundled-library model.",
            );
          this.libraryCache = {
            modelHash: parsed.data.modelHash,
            generation: this.engine.generation,
          };
        }
        modelHash = this.libraryCache.modelHash;
      } else {
        modelHash = (await this.loadSnapshot(before!, signal)).modelHash;
      }
      const reader = new NativeQueries(this.engine, modelHash, signal);
      const answer: QueryAnswer<QueryItem> =
        kind === "find_element"
          ? await reader.find(input as FindInput)
          : kind === "describe_element"
            ? await reader.describe(input as DescribeInput)
            : await reader.library(input as LibraryInput);
      page = {
        kind,
        filters: fingerprint,
        snapshot: before,
        revision: this.revision,
        generation: this.engine.generation,
        offset: 0,
        answer,
      };
    }
    if (!library) {
      const after = await readSnapshot(
        this.options.projectRoot,
        this.options.modelRoots ?? ["model"],
        signal,
      );
      if (!before || !sameSnapshot(before, after))
        throw new AdapterError(
          "PROJECT_CHANGED",
          "Saved project files changed during the query; request a fresh result.",
        );
    }
    if (signal.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
    let nextCursor: string | null = null;
    if (page.offset + limit < page.answer.items.length) {
      if (this.queryPages.size >= 32) this.queryPages.delete(this.queryPages.keys().next().value!);
      nextCursor = randomUUID();
      this.queryPages.set(nextCursor, { ...page, offset: page.offset + limit });
    }
    const info = await this.engine.start(signal);
    if (this.engine.generation !== page.generation)
      throw new AdapterError(
        "STALE_CURSOR",
        "The engine restarted while the query result was being read.",
      );
    const diagnostics = !library && this.cache ? counts(this.cache.diagnostics) : null;
    const result: ModelQueryResult = {
      status: page.answer.limitations.length ? "partial" : "answered",
      source: library ? "bundled-library" : "project",
      engine: { name: "OpenSysML", version: info.version },
      content: { sessionId: this.sessionId, projectRevision: library ? null : page.revision },
      validation: diagnostics
        ? { ...diagnostics, status: diagnostics.errors ? "errors" : "incomplete" }
        : null,
      items: page.answer.items.slice(page.offset, page.offset + limit),
      total: page.answer.items.length,
      nextCursor,
      limitations: page.answer.limitations,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 2 * 1024 * 1024)
      throw new AdapterError(
        "LIMIT_EXCEEDED",
        "The query response exceeds 2 MiB; use a narrower scope or smaller page.",
      );
    return result;
  }

  close(): void {
    this.closed = true;
    this.cursors.clear();
    this.cache = undefined;
    this.libraryCache = undefined;
    this.queryPages.clear();
    this.engine.close();
  }
}
