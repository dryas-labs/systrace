// SPDX-License-Identifier: Apache-2.0
import { AdapterError } from "./errors.js";
import {
  LANGUAGE_ENGINE_INTERFACE_VERSION,
  type EngineOptions,
  type LanguageBackend,
} from "./backend.js";
import type { LanguageServiceBackend } from "./language-service.js";

/** Selects the model API and editor service together for one language-engine implementation. */
export interface LanguageEngineProvider {
  readonly id: string;
  readonly interfaceVersion: number;
  readonly defaultEngineVersion: string;
  readonly languageService: LanguageServiceBackend;
  createBackend(options: EngineOptions): LanguageBackend;
}
export function assertLanguageEngineProvider(provider: LanguageEngineProvider): void {
  if (
    provider.interfaceVersion !== LANGUAGE_ENGINE_INTERFACE_VERSION ||
    provider.languageService.interfaceVersion !== LANGUAGE_ENGINE_INTERFACE_VERSION ||
    provider.languageService.id !== provider.id
  ) {
    throw new AdapterError(
      "ENGINE_PROTOCOL_ERROR",
      "The language-engine provider does not implement a compatible, consistent interface.",
    );
  }
}

/** Instantiate one model session without allowing LSP and model API to select different engines. */
export function createLanguageBackend(
  provider: LanguageEngineProvider,
  options: EngineOptions,
): LanguageBackend {
  assertLanguageEngineProvider(provider);
  const backend = provider.createBackend(options);
  if (
    backend.id !== provider.id ||
    backend.interfaceVersion !== LANGUAGE_ENGINE_INTERFACE_VERSION
  ) {
    backend.close();
    throw new AdapterError(
      "ENGINE_PROTOCOL_ERROR",
      "The model backend does not match the selected language-engine provider.",
    );
  }
  return backend;
}
