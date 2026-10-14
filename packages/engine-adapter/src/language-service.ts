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

/** Display metadata supplied by the language engine, never inferred from source text. */
export interface OutlinePresentation {
  kind: string;
  declaredType?: string;
  family:
    | "package"
    | "namespace"
    | "alias"
    | "dependency"
    | "comment"
    | "documentation"
    | "textual-representation"
    | "part"
    | "item"
    | "attribute"
    | "enumeration"
    | "metadata"
    | "occurrence"
    | "individual"
    | "port"
    | "interface"
    | "connection"
    | "flow"
    | "allocation"
    | "action"
    | "state"
    | "calculation"
    | "constraint"
    | "requirement"
    | "concern"
    | "case"
    | "analysis-case"
    | "verification-case"
    | "use-case"
    | "view"
    | "viewpoint"
    | "rendering"
    | "binding"
    | "succession"
    | "connector-end"
    | "cross-feature"
    | "multiplicity"
    | "reference"
    | "class"
    | "classifier"
    | "struct"
    | "datatype"
    | "association"
    | "metaclass"
    | "type"
    | "feature"
    | "behavior"
    | "function"
    | "predicate"
    | "transition"
    | "decision"
    | "fork"
    | "join"
    | "merge"
    | "send"
    | "accept"
    | "assignment"
    | "terminate"
    | "loop"
    | "condition"
    | "subject"
    | "relationship"
    | "other";
  role: "definition" | "usage" | "other";
  definition: boolean;
  reference: boolean;
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
  readonly outlinePresentation?: (detail: string) => OutlinePresentation | undefined;
}
