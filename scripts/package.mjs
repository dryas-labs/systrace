// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version, repository } = JSON.parse(
  await readFile(resolve(root, "packages/extension/package.json"), "utf8"),
);
// VSCE does not include repository.directory when resolving README links.
const repositoryUrl = repository.url.replace(/\.git$/, "");
const documentationPath = repository.directory;
await mkdir(resolve(root, "artifacts"), { recursive: true });
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/@vscode/vsce/vsce"),
    "package",
    "--no-dependencies",
    "--baseContentUrl",
    `${repositoryUrl}/blob/HEAD/${documentationPath}`,
    "--baseImagesUrl",
    `${repositoryUrl}/raw/HEAD/${documentationPath}`,
    "--out",
    resolve(root, `artifacts/dryas-systrace-${version}.vsix`),
  ],
  { cwd: resolve(root, "packages/extension"), stdio: "inherit", windowsHide: true },
);
