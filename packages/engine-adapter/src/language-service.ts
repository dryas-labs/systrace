// SPDX-License-Identifier: Apache-2.0

/** Native standard-library protocol, translated at the language-engine boundary. */
export interface LibraryDocumentProtocol {
  readonly scheme: string;
  /** Stable editor storage namespace, unique to this engine/library protocol. */
  readonly storageKeyPrefix: string;
  supports(capabilities: unknown): boolean;
  request(uri: string): { method: string; params: unknown };
  decode(result: unknown): string | undefined;
}

/** LSP process and optional library access. No editor or model-execution dependency. */
export interface LanguageServiceBackend {
  readonly id: string;
  readonly interfaceVersion: 1;
  readonly version: {
    readonly args: readonly string[];
    matchesOutput(stdout: string, expectedVersion: string): boolean;
  };
  readonly launch: {
    readonly args: readonly string[];
    environment(): NodeJS.ProcessEnv;
  };
  readonly standardLibrary: LibraryDocumentProtocol;
}
