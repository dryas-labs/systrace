// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { CancellationTokenSource } from "vscode-jsonrpc";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import type { LanguageClient } from "vscode-languageclient/node";
import { AdapterError } from "@dryas/engine-adapter";

type DraftClient = Pick<LanguageClient, "initializeResult" | "sendRequest" | "sendNotification">;
interface PendingDraft {
  hasErrors: boolean;
  reported(): void;
  cancel(error: AdapterError): void;
}

/** Check generated source using the project's LSP; no local identifier or keyword rules. */
export class NamespaceDrafts {
  private readonly pending = new Map<string, PendingDraft>();
  // Retain closed URIs until the client stops, so late diagnostics stay out of Problems.
  private readonly ownedUris = new Set<string>();
  private stopped = false;

  acceptDiagnostics(uri: string, hasErrors: boolean): boolean {
    if (!this.ownedUris.has(uri)) return false;
    const draft = this.pending.get(uri);
    if (draft) {
      draft.hasErrors ||= hasErrors;
      draft.reported();
    }
    return true;
  }

  async prepare(
    client: DraftClient,
    name: string,
    createUri: () => string,
    timeoutMs: number,
  ): Promise<string> {
    if (this.stopped)
      throw new AdapterError(
        "ENGINE_UNAVAILABLE",
        "The language service stopped before checking this namespace name.",
      );
    if (!client.initializeResult?.capabilities.documentSymbolProvider)
      throw new AdapterError(
        "UNSUPPORTED_CAPABILITY",
        "The language service cannot confirm the requested namespace declaration.",
      );
    const quoted = `'${name.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    for (const spelling of [name, quoted]) {
      const source = `package ${spelling} {\n\n}\n`;
      if (await this.inspect(client, name, source, createUri(), timeoutMs)) return source;
    }
    throw new AdapterError(
      "QUERY_UNAVAILABLE",
      "The language engine could not confirm this namespace name with or without quotes. No file was created.",
    );
  }

  private async inspect(
    client: DraftClient,
    name: string,
    source: string,
    uri: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.stopped)
      throw new AdapterError(
        "ENGINE_UNAVAILABLE",
        "The language service stopped before checking this namespace name.",
      );
    const cancellation = new CancellationTokenSource();
    let reported!: () => void;
    let interrupted!: (error: AdapterError) => void;
    const diagnostics = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const failure = new Promise<never>((_, reject) => {
      interrupted = reject;
    });
    const draft: PendingDraft = {
      hasErrors: false,
      reported,
      cancel: (error) => {
        interrupted(error);
        cancellation.cancel();
      },
    };
    this.pending.set(uri, draft);
    this.ownedUris.add(uri);
    // A unique enclosing package keeps a candidate from shadowing project/library names.
    const owner = `__systrace_namespace_${randomUUID().replaceAll("-", "_")}`;
    const textDocument = { uri };
    const timer = setTimeout(
      () =>
        draft.cancel(
          new AdapterError(
            "TIMEOUT",
            "The language service did not finish checking this namespace name. No file was created.",
          ),
        ),
      timeoutMs,
    );
    try {
      return await Promise.race([
        (async () => {
          await client.sendNotification("textDocument/didOpen", {
            textDocument: {
              ...textDocument,
              version: 1,
              languageId: "sysml",
              text: `package ${owner} {\n${source}}\n`,
            },
          });
          // Each spelling gets its own URI. The engine may omit diagnostic versions;
          // a fresh URI prevents results for an older spelling from satisfying this check.
          await diagnostics;
          if (cancellation.token.isCancellationRequested)
            throw new AdapterError("CANCELLED", "Namespace checking was cancelled.");
          const symbols = await client.sendRequest<DocumentSymbol[] | null>(
            "textDocument/documentSymbol",
            { textDocument },
            cancellation.token,
          );
          const root = symbols?.[0];
          const child = root?.children?.[0];
          // A recovering parser may return a symbol even for invalid source. Both
          // diagnostics and the exact, empty package declaration must agree.
          return (
            !draft.hasErrors &&
            symbols?.length === 1 &&
            root?.kind === 4 &&
            root.name === owner &&
            root.children?.length === 1 &&
            child?.kind === 4 &&
            child.name === name &&
            !child.children?.length
          );
        })(),
        failure,
      ]);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "QUERY_UNAVAILABLE",
        "The language service could not finish checking this namespace name. No file was created.",
      );
    } finally {
      clearTimeout(timer);
      this.pending.delete(uri);
      cancellation.dispose();
      await client
        .sendNotification("textDocument/didClose", { textDocument })
        .catch(() => undefined);
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const draft of this.pending.values())
      draft.cancel(
        new AdapterError(
          "ENGINE_UNAVAILABLE",
          "The language service stopped before checking this namespace name. No file was created.",
        ),
      );
    this.pending.clear();
  }
}
