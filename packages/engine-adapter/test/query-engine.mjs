// SPDX-License-Identifier: Apache-2.0
// A programmed transport fixture, not a SysML parser or semantic engine.
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
} from "vscode-jsonrpc/node";
const mode = process.argv[2] ?? "normal";
const rpc = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const models = new Map();
let sequence = 0;
rpc.onRequest("GetServerInfo", () => ({
  version: "v0.9.2-dryas.4",
  capabilities: [
    "parse_sources",
    "strict_conformance",
    "inline_language",
    ...(mode === "missing-query" ? [] : ["query"]),
  ],
}));
rpc.onRequest("ParseSources", (request) => {
  const modelHash = `${process.pid}-${++sequence}`;
  models.set(modelHash, request.documents);
  return { modelHash, diagnostics: [] };
});
function loaded(request) {
  if (!models.has(request.modelHash)) throw new ResponseError(5, "stale model handle");
  return models.get(request.modelHash);
}
function rows(request) {
  const documents = loaded(request);
  const name = documents.some((doc) => doc.content.includes("Revised")) ? "Revised" : "First";
  return [name, "Second", "Third"].map((name) => ({
    id: `P::${name}`,
    type: "PartDefinition",
    properties: { name, qualifiedName: `P::${name}`, owner: "P" },
  }));
}
rpc.onRequest("Query", async (request) => {
  loaded(request);
  const wanted = request.query?.where?.primitive?.value?.[0];
  if (wanted === "Hang") return new Promise(() => {});
  if (wanted === "Slow") await new Promise((r) => setTimeout(r, 250));
  if (wanted === "Reject") throw new ResponseError(3, `PRIVATE_ENGINE_DETAIL ${process.cwd()}`);
  if (wanted === "Crash") process.exit(2);
  if (mode === "malformed") return { elements: "not rows" };
  if (mode === "error-envelope") return { error: "unsupported" };
  if (mode === "duplicates") return { elements: [rows(request)[0], rows(request)[0]] };
  const all = rows(request);
  return {
    elements:
      request.query?.where?.primitive?.property === "qualifiedName"
        ? all.filter((r) => r.id === wanted)
        : all,
  };
});
rpc.onRequest("DryasDescribeProvenance", (request) => {
  loaded(request);
  if (mode === "no-overlay") throw new ResponseError(12, "PRIVATE_ENGINE_DETAIL");
  if (request.symbolId === "P::Missing") throw new ResponseError(5, "PRIVATE_ENGINE_DETAIL");
  if (request.symbolId === "P::Ambiguous") throw new ResponseError(9, "ambiguous symbol identity");
  return {};
});
rpc.onRequest("GetSymbol", (request) => {
  loaded(request);
  return {
    symbol: { id: request.symbolId, name: request.symbolId.split("::").at(-1), kind: "partDef" },
  };
});
rpc.onRequest("DryasDescribeInherited", (request) => {
  loaded(request);
  return {};
});
rpc.onRequest("DryasFindBySpecialization", (request) => ({ elements: rows(request).slice(1) }));
rpc.onClose(() => {
  rpc.dispose();
  process.exitCode = 0;
});
rpc.listen();
