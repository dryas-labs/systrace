// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { archiveName, auditArchive, writeArchive } from "./package-utils.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { "engine-dir": { type: "string" }, "engine-source": { type: "string" } },
});
const { version, repository } = JSON.parse(
  await readFile(resolve(root, "packages/extension/package.json"), "utf8"),
);
const runtime = await stageRuntime(root, values["engine-dir"], values["engine-source"]);
const repositoryUrl = repository.url.replace(/\.git$/, "");
const documentationPath = repository.directory;
await mkdir(resolve(root, "artifacts"), { recursive: true });
const vsix = resolve(root, `artifacts/dryas-systrace-${version}.vsix`);
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/@vscode/vsce/vsce"),
    "package",
    "--no-dependencies",
    "--target",
    runtime.target,
    "--baseContentUrl",
    `${repositoryUrl}/blob/HEAD/${documentationPath}`,
    "--baseImagesUrl",
    `${repositoryUrl}/raw/HEAD/${documentationPath}`,
    "--out",
    vsix,
  ],
  { cwd: resolve(root, "packages/extension"), stdio: "inherit", windowsHide: true },
);
const skillRoot = resolve(root, "packages/extension/skills/sysml-diagnostics");
const skillZip = resolve(root, `artifacts/systrace-diagnostics-skill-${version}.zip`);
await writeArchive(skillZip, [
  ...[
    "SKILL.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "scripts/diagnostics.cjs",
    "scripts/run-diagnostics.cjs",
  ].map((name) => ({
    source: join(skillRoot, name),
    name: `sysml-diagnostics/${name}`,
  })),
  ...runtime.files.map((file) => ({
    source: file,
    name: `sysml-diagnostics/runtime/${archiveName(runtime.directory, file)}`,
    executable: /sysml-(lsp|grpc)(\.exe)?$/.test(file),
  })),
]);
await auditArchive(vsix, root);
await auditArchive(skillZip, root);
console.log(
  `Packaged ${runtime.target} VSIX and self-contained Skill; archive privacy checks passed.`,
);
