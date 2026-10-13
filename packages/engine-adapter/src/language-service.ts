// SPDX-License-Identifier: Apache-2.0

export interface LibraryCatalogEntry {
  name: string;
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}
export interface LibraryCatalogTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
}

/** Native standard-library protocol, translated at the language-engine boundary. */
export interface LibraryDocumentProtocol {
  readonly scheme: string;
  /** Stable editor storage namespace, unique to this engine/library protocol. */
  readonly storageKeyPrefix: string;
  supports(capabilities: unknown): boolean;
  request(uri: string): { method: string; params: unknown };
  decode(result: unknown): string | undefined;
  /** Optional discovery through the engine; never a bundled, hard-coded library inventory. */
  catalog?(transport: LibraryCatalogTransport, scratchUri: string): Promise<LibraryCatalogEntry[]>;
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
