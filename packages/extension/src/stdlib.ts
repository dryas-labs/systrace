// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

const engineScheme = "sysml-stdlib";
type LibraryClient = Pick<LanguageClient, "initializeResult" | "sendRequest">;

/** Read the owning engine's bundled sources without copying them into the project. */
export class StdlibDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly registration: vscode.Disposable;
  private client: LibraryClient | undefined;
  private timeoutMs = 30000;

  constructor(readonly scheme: string) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);
  }

  // Each project has its own editor scheme. LSP messages retain the engine's
  // original URI, including encoded spaces and the library-relative path.
  readonly uriConverters = {
    protocol2Code: (value: string): vscode.Uri => {
      const uri = vscode.Uri.parse(value);
      return uri.scheme === engineScheme ? uri.with({ scheme: this.scheme }) : uri;
    },
    code2Protocol: (uri: vscode.Uri): string =>
      (uri.scheme === this.scheme ? uri.with({ scheme: engineScheme }) : uri).toString(),
  };

  attach(client: LibraryClient, timeoutMs: number): boolean {
    const experimental: unknown = client.initializeResult?.capabilities.experimental;
    const supported =
      !!experimental &&
      typeof experimental === "object" &&
      "openSysmlStdlibContent" in experimental &&
      experimental.openSysmlStdlibContent === true;
    this.client = supported ? client : undefined;
    this.timeoutMs = timeoutMs;
    if (supported)
      for (const document of vscode.workspace.textDocuments)
        if (document.uri.scheme === this.scheme) this.changed.fire(document.uri);
    return supported;
  }

  detach(): void {
    this.client = undefined;
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    if (uri.scheme !== this.scheme)
      throw new Error("The library document belongs to another project.");
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const client = this.client;
    if (!client)
      throw new Error(
        "The project's language server is unavailable or does not support standard-library browsing.",
      );
    const cancellation = new vscode.CancellationTokenSource();
    const timeoutError = new Error("Reading the standard library exceeded dryas.requestTimeoutMs.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: vscode.Disposable | undefined;
    try {
      const result = await Promise.race([
        client.sendRequest<unknown>(
          "opensysml/stdlibContent",
          { uri: this.uriConverters.code2Protocol(uri) },
          cancellation.token,
        ),
        new Promise<never>((_, reject) => {
          listener = token.onCancellationRequested(() => {
            reject(new vscode.CancellationError());
            cancellation.cancel();
          });
          timer = setTimeout(() => {
            reject(timeoutError);
            cancellation.cancel();
          }, this.timeoutMs);
        }),
      ]).catch((error: unknown) => {
        if (error === timeoutError || error instanceof vscode.CancellationError) throw error;
        throw new Error("The language server could not read this standard-library document.");
      });
      if (this.client !== client)
        throw new Error(
          "The language server changed while reading the standard library. Open the definition again.",
        );
      if (
        !result ||
        typeof result !== "object" ||
        !("text" in result) ||
        typeof result.text !== "string"
      )
        throw new Error("The language server returned invalid standard-library content.");
      return result.text;
    } finally {
      clearTimeout(timer);
      listener?.dispose();
      cancellation.dispose();
    }
  }

  dispose(): void {
    this.detach();
    this.registration.dispose();
    this.changed.dispose();
  }
}
