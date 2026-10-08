// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./config.mjs";

const manifest = JSON.parse(await readFile(resolve(root, "config/engine.json"), "utf8"));
const source = resolve(root, ".engine-ci");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "inherit" });
try {
  await access(source);
} catch {
  git("clone", "--filter=blob:none", "--no-checkout", manifest.source, source);
}
const repositoryRoot = execFileSync("git", ["-C", source, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
if ((await realpath(repositoryRoot)) !== (await realpath(source)))
  throw new Error("The engine source directory must be its own Git checkout.");
git("-C", source, "config", "--local", "core.autocrlf", "false");
git("-C", source, "checkout", "--detach", manifest.commit);
const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
if (head !== manifest.commit)
  throw new Error("Engine checkout differs from the configured source revision.");
await mkdir(resolve(source, "bin"), { recursive: true });
const binaries = {};
for (const name of ["sysml-lsp", "sysml-grpc"]) {
  const output = resolve(source, "bin", name + (process.platform === "win32" ? ".exe" : ""));
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      `-ldflags=-X main.Version=${manifest.version}`,
      "-o",
      output,
      `./cmd/${name}`,
    ],
    { cwd: source, windowsHide: true, stdio: "inherit" },
  );
  binaries[name] = output;
}
const configFile = resolve(root, "config.js");
try {
  await access(configFile);
  console.log("Engine built; existing config.js left unchanged.");
} catch {
  await writeFile(
    configFile,
    `export default ${JSON.stringify({ engine: { lspPath: binaries["sysml-lsp"], apiPath: binaries["sysml-grpc"] } }, null, 2)};\n`,
  );
  console.log("Engine built; ignored local config.js created.");
}
