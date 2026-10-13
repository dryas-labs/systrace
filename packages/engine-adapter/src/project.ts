// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { AdapterError } from "./errors.js";
import {
  LANGUAGE_ENGINE_INTERFACE_VERSION,
  type LanguageBackend,
  type EngineOptions,
  type BackendInfo,
  type BackendCapability,
  type BackendDiagnostic,
  type ModelHandle,
  type ValidationEvidence,
} from "./backend.js";
import { createLanguageBackend } from "./provider.js";
import { DEFAULT_LANGUAGE_ENGINE_PROVIDER } from "./default-engine.js";
import { readSnapshot, relativeName, sameSnapshot, type Snapshot } from "./snapshot.js";
import {
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
interface Diagnostic extends BackendDiagnostic {
  id: string;
}

interface Counts {
  errors: number;
  warnings: number;
}
export interface ValidationResult {
  status: "errors" | "incomplete";
  engine: { name: string; version: string };
  library: ValidationEvidence["library"];
  completeness: ValidationEvidence["completeness"];
  checks: ValidationEvidence["checks"];
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
  info: BackendInfo;
  model: ModelHandle;
  evidence: ValidationEvidence;
  generation: number;
}

type QueryItem = ElementSummary | ElementDescription;
type QueryKind = "find_element" | "describe_element" | "library_lookup";
export interface ModelQueryResult<T = QueryItem> {
  status: "answered" | "partial";
  source: "project" | "bundled-library";
  engine: { name: string; version: string };
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
export class ProjectSession {
  private readonly engine: LanguageBackend;
  private readonly sessionId = randomUUID();
  private revision = 0;
  private cache: Cache | undefined;
  private versions = new Map<string, number>();
  private cursors = new Map<string, Cursor>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private libraryCache: ModelHandle | undefined;
  private queryPages = new Map<string, QueryPage>();

  constructor(
    private readonly options: ProjectOptions,
    backend?: LanguageBackend,
  ) {
    this.engine =
      backend ?? createLanguageBackend(DEFAULT_LANGUAGE_ENGINE_PROVIDER, options.engine);
    if (this.engine.interfaceVersion !== LANGUAGE_ENGINE_INTERFACE_VERSION) {
      this.engine.close();
      throw new AdapterError(
        "ENGINE_PROTOCOL_ERROR",
        "The language backend implements an incompatible interface version.",
      );
    }
  }

  private async requireCapability(
    capability: BackendCapability,
    signal?: AbortSignal,
  ): Promise<BackendInfo> {
    const info = await this.engine.start(signal);
    if (!info.capabilities.includes(capability))
      throw new AdapterError(
        "UNSUPPORTED_CAPABILITY",
        "The language engine does not support the requested operation.",
      );
    return info;
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
      this.options.modelRoots ?? ["."],
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
      engine: { ...cached.info.engine },
      library: cached.evidence.library,
      completeness: cached.evidence.completeness,
      checks: cached.evidence.checks,
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
      const info = await this.requireCapability("validate", signal);
      const documents = Object.freeze(
        before.documents.map((document) => Object.freeze({ ...document })),
      );
      const validated = await this.engine.validate(documents, signal);
      if (!this.engine.connected || validated.model.generation !== this.engine.generation)
        throw new AdapterError("STALE_MODEL", "The engine changed while validating the project.");
      const after = await readSnapshot(
        this.options.projectRoot,
        this.options.modelRoots ?? ["."],
        signal,
      );
      if (!sameSnapshot(before, after))
        throw new AdapterError(
          "PROJECT_CHANGED",
          "Project files changed during validation; validate the saved files again.",
        );
      if (!this.engine.connected || validated.model.generation !== this.engine.generation)
        throw new AdapterError(
          "STALE_MODEL",
          "The engine changed while the saved snapshot was being verified.",
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
        model: validated.model,
        evidence: validated.evidence,
        generation: validated.model.generation,
        diagnostics: validated.diagnostics.map((d, i) => ({
          id: `r${this.revision}-d${i + 1}`,
          file: d.file,
          line: d.line,
          column: d.column,
          severity: d.severity,
          category: d.category,
          message: d.message,
          raw: d.raw,
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
      : await readSnapshot(this.options.projectRoot, this.options.modelRoots ?? ["."], signal);
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
      await this.requireCapability(kind, signal);
      let model: ModelHandle;
      if (library) {
        if (!this.libraryCache || this.libraryCache.generation !== this.engine.generation)
          this.libraryCache = await this.engine.openLibrary(signal);
        model = this.libraryCache;
      } else {
        model = (await this.loadSnapshot(before!, signal)).model;
      }
      const answer: QueryAnswer<QueryItem> =
        kind === "find_element"
          ? await this.engine.findElement(model, input as FindInput, signal)
          : kind === "describe_element"
            ? await this.engine.describeElement(model, input as DescribeInput, signal)
            : await this.engine.libraryLookup(model, input as LibraryInput, signal);
      if (!this.engine.connected || model.generation !== this.engine.generation)
        throw new AdapterError(
          "STALE_MODEL",
          "The engine changed while answering the model query.",
        );
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
        this.options.modelRoots ?? ["."],
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
      engine: { ...info.engine },
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
