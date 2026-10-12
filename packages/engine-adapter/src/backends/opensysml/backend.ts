// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import categoryMap from "./category-map.json" with { type: "json" };
import { AdapterError } from "../../errors.js";
import { EngineConnection, type ServerInfo } from "./connection.js";
import { NativeQueries } from "./queries.js";
import type {
  LanguageBackend,
  EngineOptions,
  BackendInfo,
  BackendCapability,
  BackendValidation,
  ModelHandle,
  ValidationEvidence,
} from "../../backend.js";
import type { ModelDocument } from "../../snapshot.js";
import type { FindInput, DescribeInput, LibraryInput } from "../../queries.js";

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
type RawDiagnostic = z.infer<typeof diagnosticSchema>;
function category(d: RawDiagnostic): string {
  return (
    categoryMap.rules.find(
      (rule) =>
        (!rule.code || rule.code === d.code) &&
        (!rule.messageRegex || new RegExp(rule.messageRegex, "i").test(d.message)),
    )?.category ?? "UNCLASSIFIED"
  );
}

function evidence(): ValidationEvidence {
  return {
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
  };
}

/** Adapts the maintained engine without duplicating its name resolution or semantics. */
export class OpenSysMLBackend implements LanguageBackend {
  readonly id = "opensysml";
  readonly interfaceVersion = 1;
  private readonly connection: EngineConnection;
  private readonly models = new WeakMap<
    ModelHandle,
    { hash: string; source: "project" | "library" }
  >();

  constructor(options: EngineOptions) {
    this.connection = new EngineConnection(options);
  }
  get generation(): number {
    return this.connection.generation;
  }
  get connected(): boolean {
    return this.connection.connected;
  }

  async start(signal?: AbortSignal): Promise<BackendInfo> {
    const info = await this.connection.start(signal);
    const capabilities: BackendCapability[] = [];
    if (this.canValidate(info)) capabilities.push("validate");
    if (info.capabilities.includes("query"))
      capabilities.push("find_element", "describe_element", "library_lookup");
    return { engine: { name: "OpenSysML", version: info.version }, capabilities };
  }

  private canValidate(info: ServerInfo): boolean {
    return ["parse_sources", "strict_conformance", "inline_language"].every((c) =>
      info.capabilities.includes(c),
    );
  }

  private remember(hash: string, source: "project" | "library"): ModelHandle {
    const handle = Object.freeze({ generation: this.generation });
    this.models.set(handle, { hash, source });
    return handle;
  }

  private reader(
    model: ModelHandle,
    signal: AbortSignal,
    source: "project" | "library",
  ): NativeQueries {
    const owned = this.models.get(model);
    if (
      !owned ||
      !this.connected ||
      model.generation !== this.generation ||
      owned.source !== source
    )
      throw new AdapterError(
        "STALE_MODEL",
        "The model handle does not belong to this engine session and query scope.",
      );
    return new NativeQueries(this.connection, owned.hash, signal);
  }

  async validate(
    documents: readonly ModelDocument[],
    signal?: AbortSignal,
  ): Promise<BackendValidation> {
    const info = await this.connection.start(signal);
    if (!this.canValidate(info))
      throw new AdapterError(
        "UNSUPPORTED_CAPABILITY",
        "The engine does not advertise the required multi-file validation capabilities.",
      );
    const parsed = parseSchema.safeParse(
      await this.connection.request("ParseSources", { documents, strictConformance: true }, signal),
    );
    if (!parsed.success || parsed.data.error)
      throw new AdapterError(
        "ENGINE_PROTOCOL_ERROR",
        "The engine did not return a complete validation response.",
      );
    return {
      model: this.remember(parsed.data.modelHash, "project"),
      diagnostics: parsed.data.diagnostics.map((d) => ({
        file: d.span.file || "<engine>",
        line: d.span.startLine,
        column: d.span.startCol,
        severity: d.severity.toLowerCase() as "error" | "warning" | "info" | "hint",
        category: category(d),
        message: d.message,
        raw: d,
      })),
      evidence: evidence(),
    };
  }

  async openLibrary(signal?: AbortSignal): Promise<ModelHandle> {
    const info = await this.connection.start(signal);
    if (!this.canValidate(info))
      throw new AdapterError(
        "UNSUPPORTED_CAPABILITY",
        "The engine cannot initialize the required library query context.",
      );
    const parsed = parseSchema.safeParse(
      await this.connection.request(
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
    return this.remember(parsed.data.modelHash, "library");
  }

  async findElement(model: ModelHandle, input: FindInput, signal: AbortSignal) {
    return this.reader(model, signal, "project").find(input);
  }
  async describeElement(model: ModelHandle, input: DescribeInput, signal: AbortSignal) {
    return this.reader(model, signal, "project").describe(input);
  }
  async libraryLookup(model: ModelHandle, input: LibraryInput, signal: AbortSignal) {
    return this.reader(model, signal, "library").library(input);
  }
  close(): void {
    this.connection.close();
  }
}
