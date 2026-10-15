// SPDX-License-Identifier: Apache-2.0
export { AdapterError, publicError } from "./errors.js";
export {
  EngineConnection,
  ENGINE_VERSION,
  engineEnvironment,
  type EngineOptions,
} from "./engine.js";
export { readSnapshot, resolveModelRoots, relativeName, type Snapshot } from "./snapshot.js";
export {
  ProjectSession,
  type ProjectOptions,
  type ValidateInput,
  type ValidationResult,
  type ModelQueryResult,
} from "./project.js";
export {
  findInputSchema,
  describeInputSchema,
  libraryInputSchema,
  type FindInput,
  type DescribeInput,
  type LibraryInput,
  type ElementSummary,
  type ElementDescription,
} from "./queries.js";

export {
  LANGUAGE_ENGINE_INTERFACE_VERSION,
  type LanguageBackend,
  type BackendInfo,
  type BackendCapability,
  type EngineIdentity,
  type ModelHandle,
  type BackendDiagnostic,
  type BackendValidation,
  type ValidationEvidence,
} from "./backend.js";
export {
  type LanguageEngineProvider,
  assertLanguageEngineProvider,
  createLanguageBackend,
} from "./provider.js";
export { type LanguageServiceBackend, type LibraryDocumentProtocol } from "./language-service.js";
export type { QueryAnswer, TypeInfo, DeclaredSpecialization } from "./queries.js";
export { DEFAULT_LANGUAGE_ENGINE_PROVIDER } from "./default-engine.js";

export { observeLspDiagnostics } from "./lsp-diagnostics.js";
export { runDiagnosticsCommand } from "./diagnostics-command.js";
export { resolveDiagnosticsProject } from "./diagnostics-project.js";
