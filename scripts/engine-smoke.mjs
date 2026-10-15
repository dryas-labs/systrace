// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

console.log("Native checks passed: cross-file validation and unresolved-name diagnostics.");
