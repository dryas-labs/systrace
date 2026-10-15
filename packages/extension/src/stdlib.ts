// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import type { LibraryDocumentProtocol } from "@dryas/engine-adapter";
type LibraryClient = Pick<LanguageClient, "initializeResult" | "sendRequest" | "sendNotification">;

/** Read the owning engine's bundled sources without copying them into the project. */
export class StdlibDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly registration: vscode.Disposable;
  private client: LibraryClient | undefined;
  private timeoutMs = 30000;
  private catalogue: Promise<import("./project-tree.js").LibraryNamespace[]> | undefined;
  private readonly internalUris = new Set<string>();

  isInternalUri(uri: vscode.Uri): boolean {
    return this.internalUris.has(uri.toString());
  }

  clearCatalog(): void {
    this.catalogue = undefined;
  }

  namespaces(scratchUri: string): Promise<import("./project-tree.js").LibraryNamespace[]> {
    if (!this.catalogue) {
      const pending = this.readCatalog(scratchUri);
      this.catalogue = pending;
      void pending.catch(() => {
        if (this.catalogue === pending) this.catalogue = undefined;
      });
    }
    return this.catalogue;
  }

  private async readCatalog(
    scratchUri: string,
  ): Promise<import("./project-tree.js").LibraryNamespace[]> {
    const client = this.client;
    if (!client || !this.protocol.catalog)
      throw new Error("Standard-library discovery is unavailable from this language service.");
    this.internalUris.add(scratchUri);
    const cancellation = new vscode.CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entries = await Promise.race([
        this.protocol.catalog(
          {
            request: (method, params) => {
              if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
              return client.sendRequest<unknown>(method, params, cancellation.token);
            },
            notify: async (method, params) => {
              await client.sendNotification(method, params);
            },
          },
          scratchUri,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancellation.cancel();
            reject(new Error("Library browsing exceeded the request deadline."));
          }, this.timeoutMs);
        }),
      ]);
      if (this.client !== client)
        throw new Error("The language service changed during library browsing. Refresh to retry.");
      return entries.map((entry) => ({
        name: entry.name,
        uri: this.uriConverters.protocol2Code(entry.uri),
        range: new vscode.Range(
          entry.range.start.line,
          entry.range.start.character,
          entry.range.end.line,
          entry.range.end.character,
        ),
      }));
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
    }
  }

  constructor(
    readonly scheme: string,
    private readonly protocol: LibraryDocumentProtocol,
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);
  }

  // Each project has its own editor scheme. LSP messages retain the engine's
  // original URI, including encoded spaces and the library-relative path.
  readonly uriConverters = {
    protocol2Code: (value: string): vscode.Uri => {
      const uri = vscode.Uri.parse(value);
      return uri.scheme === this.protocol.scheme ? uri.with({ scheme: this.scheme }) : uri;
    },
    code2Protocol: (uri: vscode.Uri): string =>
      (uri.scheme === this.scheme ? uri.with({ scheme: this.protocol.scheme }) : uri).toString(),
  };

  attach(client: LibraryClient, timeoutMs: number): boolean {
    const supported = this.protocol.supports(client.initializeResult?.capabilities);
    this.client = supported ? client : undefined;
    this.clearCatalog();
    this.timeoutMs = timeoutMs;
    if (supported)
      for (const document of vscode.workspace.textDocuments)
        if (document.uri.scheme === this.scheme) this.changed.fire(document.uri);
    return supported;
  }

  detach(): void {
    this.client = undefined;
    this.clearCatalog();
    this.internalUris.clear();
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
      const request = this.protocol.request(this.uriConverters.code2Protocol(uri));
      const result = await Promise.race([
        client.sendRequest<unknown>(request.method, request.params, cancellation.token),
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
      const text = this.protocol.decode(result);
      if (text === undefined)
        throw new Error("The language server returned invalid standard-library content.");
      return text;
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
