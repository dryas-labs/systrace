// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectSession } from "../packages/engine-adapter/dist/index.js";
import { root, loadConfig } from "./config.mjs";

const config = await loadConfig();
await mkdir(resolve(root, ".tmp"), { recursive: true });
const project = await mkdtemp(resolve(root, ".tmp/engine-smoke-"));
await cp(resolve(root, "test/fixtures/hello-system/model"), resolve(project, "model"), {
  recursive: true,
});
const session = new ProjectSession({
  projectRoot: project,
  engine: { executable: config.engine.apiPath },
});
try {
  const good = await session.validate();
  assert.equal(good.project.errors, 0);
  assert.equal(good.status, "incomplete");
  await writeFile(
    resolve(project, "model/system.sysml"),
    "package System { private import Components::*; part battery : MissingType; }\n",
  );
  const bad = await session.validate();
  assert.equal(bad.status, "errors");
  assert(bad.diagnostics.some((d) => d.category === "UNRESOLVED_NAME"));
  assert(bad.diagnostics.every((d) => d.file.startsWith("model/")));
} finally {
  session.close();
}

const client = new Client({ name: "dryas-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(root, "packages/mcp-server/dist/cli.cjs"),
    "--project",
    project,
    "--engine",
    config.engine.apiPath,
  ],
  stderr: "pipe",
});
transport.stderr?.resume();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["validate", "find_element", "describe_element", "library_lookup"],
  );
  const result = await client.callTool({
    name: "validate",
    arguments: { paths: ["model/definitions.sysml"], limit: 1 },
  });
  assert(!result.isError);
  const report = result.structuredContent;
  assert.equal(report.status, "errors");
  assert(report.project.errors > 0);
  assert.equal(report.scope.errors, 0);
  console.log(
    "Native checks passed: cross-file validation, real unresolved-name diagnostics, relative locations, MCP discovery and filtered counts.",
  );
} finally {
  await client.close();
}
