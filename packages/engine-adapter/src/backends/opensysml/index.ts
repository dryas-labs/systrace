// SPDX-License-Identifier: Apache-2.0
import type { EngineOptions } from "../../backend.js";
import type { LanguageEngineProvider } from "../../provider.js";
import { ENGINE_VERSION } from "./connection.js";
import { OpenSysMLBackend } from "./backend.js";
import { OPEN_SYSML_LANGUAGE_SERVICE } from "./language-service.js";

export const OPEN_SYSML_PROVIDER: LanguageEngineProvider = Object.freeze({
  id: "opensysml",
  interfaceVersion: 1,
  defaultEngineVersion: ENGINE_VERSION,
  languageService: OPEN_SYSML_LANGUAGE_SERVICE,
  createBackend: (options: EngineOptions) => new OpenSysMLBackend(options),
});
