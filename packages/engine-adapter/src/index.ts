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
