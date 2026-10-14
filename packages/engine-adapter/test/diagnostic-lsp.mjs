// SPDX-License-Identifier: Apache-2.0
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
if (process.argv.includes("-version")) {
  process.stdout.write("sysml-lsp fixture-version\n");
  process.exit(0);
}
if (!process.argv.includes("-strict") || !process.argv.includes("-no-record-cache"))
  process.exit(2);
const rpc = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
rpc.onRequest("initialize", () => ({
  capabilities: { positionEncoding: "utf-16", textDocumentSync: 1 },
}));
rpc.onNotification("textDocument/didOpen", async ({ textDocument }) => {
  if (process.argv.includes("silent")) return;
  if (process.argv.includes("crash")) {
    process.exit(2);
  }
  const diagnostics = /bad|clear/.test(textDocument.text)
    ? [
        {
          range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } },
          message: "Fixture diagnostic",
          severity: 1,
        },
      ]
    : [];
  await rpc.sendNotification("textDocument/publishDiagnostics", {
    uri: textDocument.uri,
    version: 1,
    diagnostics,
  });
  if (textDocument.text.includes("clear"))
    setTimeout(() => {
      void rpc.sendNotification("textDocument/publishDiagnostics", {
        uri: textDocument.uri,
        version: 1,
        diagnostics: [],
      });
    }, 20);
});
rpc.onRequest("shutdown", () => null);
rpc.onNotification("exit", () => process.exit(0));
rpc.listen();
