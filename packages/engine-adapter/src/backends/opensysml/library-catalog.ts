// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { AdapterError } from "../../errors.js";
import type { LibraryCatalogEntry, LibraryCatalogTransport } from "../../language-service.js";

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const range = z.object({ start: position, end: position });
const completion = z.object({ label: z.string(), kind: z.number().optional() });
const completions = z.union([
  z.array(completion),
  z.object({ isIncomplete: z.boolean(), items: z.array(completion) }),
]);
const location = z.union([
  z.object({ uri: z.string(), range }),
  z.object({ targetUri: z.string(), targetRange: range, targetSelectionRange: range }),
]);

/** Ask the engine for visible namespaces and their declarations. No library paths are embedded. */
export async function readLibraryCatalog(
  transport: LibraryCatalogTransport,
  scratchUri: string,
): Promise<LibraryCatalogEntry[]> {
  const textDocument = { uri: scratchUri };
  await transport.notify("textDocument/didOpen", {
    textDocument: { ...textDocument, languageId: "sysml", version: 1, text: "" },
  });
  try {
    const response = completions.parse(
      await transport.request("textDocument/completion", {
        textDocument,
        position: { line: 0, character: 0 },
      }),
    );
    if (!Array.isArray(response) && response.isIncomplete)
      throw new AdapterError(
        "QUERY_UNAVAILABLE",
        "The engine returned an incomplete library catalogue.",
      );
    const items = Array.isArray(response) ? response : response.items;
    // CompletionItemKind.Module is 9 in LSP. Resolve every candidate through the
    // engine and retain only bundled-source locations, excluding project names.
    const names = [
      ...new Set(items.filter((item) => item.kind === 9).map((item) => item.label)),
    ].sort();
    if (!names.length) return [];
    const text = names
      .map((name) => `private import '${name.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}';`)
      .join("\n");
    await transport.notify("textDocument/didChange", {
      textDocument: { ...textDocument, version: 2 },
      contentChanges: [{ text }],
    });
    const entries: LibraryCatalogEntry[] = [];
    for (const [line, name] of names.entries()) {
      const result = await transport.request("textDocument/definition", {
        textDocument,
        position: { line, character: 16 },
      });
      const targets = z.union([location, z.array(location), z.null()]).parse(result);
      for (const target of targets === null ? [] : Array.isArray(targets) ? targets : [targets]) {
        const uri = "uri" in target ? target.uri : target.targetUri;
        if (new URL(uri).protocol !== "sysml-stdlib:") continue;
        const selection = "uri" in target ? target.range : target.targetSelectionRange;
        entries.push({ name, uri, range: selection });
      }
    }
    return entries;
  } finally {
    // This in-memory document is outside all project source folders. It is never
    // saved, and is closed even when a request is cancelled or fails.
    await transport.notify("textDocument/didClose", { textDocument });
  }
}
