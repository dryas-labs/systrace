// SPDX-License-Identifier: Apache-2.0
import type { ModelDocument } from "./snapshot.js";
import type {
  FindInput,
  DescribeInput,
  LibraryInput,
  ElementSummary,
  ElementDescription,
  QueryAnswer,
} from "./queries.js";

/** Version of the in-process adapter contract, independent of a native engine release. */
export const LANGUAGE_ENGINE_INTERFACE_VERSION = 1;
export interface EngineOptions {
  executable: string;
  expectedVersion?: string;
  timeoutMs?: number;
  args?: string[];
}
export type BackendCapability = "validate" | "find_element" | "describe_element" | "library_lookup";
export interface EngineIdentity {
  name: string;
  version: string;
}
export interface BackendInfo {
  engine: EngineIdentity;
  capabilities: readonly BackendCapability[];
}
/** Opaque object owned by its backend, usable only during this connection generation. */
export interface ModelHandle {
  readonly generation: number;
}
export interface BackendDiagnostic {
  file: string;
  /** 1-based line and UTF-8 byte column; zero means the native source position is unknown. */
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  category: string;
  message: string;
  raw: Record<string, unknown>;
}
export interface ValidationEvidence {
  library: { name: string; identity: string; version: string | null };
  completeness: {
    parse: "complete" | "incomplete" | "unknown";
    libraryLoad: "complete" | "incomplete" | "unknown";
    resolution: "complete" | "incomplete" | "unknown";
    reasons: string[];
  };
  checks: { performed: string[]; notProven: string[] };
}
export interface BackendValidation {
  model: ModelHandle;
  diagnostics: BackendDiagnostic[];
  evidence: ValidationEvidence;
}
/** Language analysis and queries only; execution and simulation are outside this contract. */
export interface LanguageBackend {
  readonly id: string;
  readonly interfaceVersion: number;
  readonly generation: number;
  readonly connected: boolean;
  start(signal?: AbortSignal): Promise<BackendInfo>;
  validate(documents: readonly ModelDocument[], signal?: AbortSignal): Promise<BackendValidation>;
  openLibrary(signal?: AbortSignal): Promise<ModelHandle>;
  findElement(
    model: ModelHandle,
    input: FindInput,
    signal: AbortSignal,
  ): Promise<QueryAnswer<ElementSummary>>;
  describeElement(
    model: ModelHandle,
    input: DescribeInput,
    signal: AbortSignal,
  ): Promise<QueryAnswer<ElementDescription>>;
  libraryLookup(
    model: ModelHandle,
    input: LibraryInput,
    signal: AbortSignal,
  ): Promise<QueryAnswer<ElementSummary | ElementDescription>>;
  close(): void;
}
