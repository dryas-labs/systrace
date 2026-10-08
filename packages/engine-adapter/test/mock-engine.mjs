// SPDX-License-Identifier: Apache-2.0
// Transport fixture only: it does not implement SysML semantics.
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const mode = process.argv[2] ?? "normal";
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
connection.onRequest("GetServerInfo", () => ({
  version: mode === "wrong-version" ? "other" : "v0.9.2-dryas.4",
  capabilities:
    mode === "missing-capability" ? [] : ["parse_sources", "strict_conformance", "inline_language"],
}));
connection.onRequest("Ping", () => ({ processId: process.pid }));
connection.onRequest("ParseSources", async (request) => {
  if (mode === "timeout") return new Promise(() => {});
  if (mode === "crash") {
    process.exit(2);
  }
  if (mode === "slow") await new Promise((r) => setTimeout(r, 200));
  if (mode === "malformed") return { diagnostics: "not an array" };
  const diagnostics = [];
  for (const document of request.documents) {
    if (document.content.includes("MissingType")) {
      for (let i = 0; i < 2; i++)
        diagnostics.push({
          severity: mode === "upper-severity" ? "ERROR" : "error",
          code: "unresolved",
          message: "unresolved reference: MissingType",
          span: { file: document.name, startLine: i + 2, startCol: 1 },
        });
    }
  }
  return { modelHash: "opaque-native-handle", diagnostics };
});
connection.onClose(() => {
  connection.dispose();
  process.exitCode = 0;
});
connection.listen();
