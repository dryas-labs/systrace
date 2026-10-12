// SPDX-License-Identifier: Apache-2.0
// Compatibility exports for existing development clients. Product sessions use LanguageBackend.
export {
  EngineConnection,
  ENGINE_VERSION,
  engineEnvironment,
  serverInfoSchema,
  type ServerInfo,
} from "./backends/opensysml/connection.js";
export type { EngineOptions } from "./backend.js";
