// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, delimiter } from "node:path";
import { archiveEntry, archiveName, assertPublicData, filesUnder } from "./package-utils.mjs";

export async function stageRuntime(root, engineDirectory) {
  const manifest = JSON.parse(await readFile(join(root, "config/engine.json"), "utf8"));
  const extension = await realpath(join(root, "packages/extension"));
  const destination = join(extension, "runtime");
  // This directory is generated; never remove a link or a target outside the extension.
  if ((await realpath(dirname(destination))) !== extension || basename(destination) !== "runtime")
    throw new Error("Invalid generated runtime directory.");
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error("Runtime directory cannot be a link.");
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const source = engineDirectory ? resolve(engineDirectory) : join(root, ".engine-ci");
  const binaries = engineDirectory ? source : join(source, "bin");
  const target = `${process.platform}-${process.arch}`;
  const extensionSuffix = process.platform === "win32" ? ".exe" : "";
  const notices = join(destination, "licenses");
  await mkdir(join(destination, target), { recursive: true });
  await mkdir(notices, { recursive: true });
  await mkdir(join(destination, "source"), { recursive: true });
  for (const file of ["LICENSE", "NOTICE", "CHANGES.md", "CHANGES.zh-Hans.md", "UPSTREAM.md"])
    await copyFile(join(source, file), join(notices, file));
  const stdlib = engineDirectory
    ? join(source, "stdlib-notices")
    : join(source, "internal/workspace/libs/stdlib");
  await mkdir(join(notices, "stdlib"));
  for (const file of ["NOTICE", "LICENSE-EPL-2.0"])
    await copyFile(join(stdlib, file), join(notices, "stdlib", file));
  await copyFile(join(root, "licenses/Go-LICENSE"), join(notices, "Go-LICENSE"));
  const sourceZip = join(destination, "source/source.zip");
  if (engineDirectory) await copyFile(join(source, "source.zip"), sourceZip);
  else
    execFileSync(
      "git",
      ["-C", source, "archive", "--format=zip", "--output", sourceZip, manifest.commit],
      { windowsHide: true, stdio: "pipe" },
    );
  const archive = await archiveEntry(sourceZip, "go.mod");
  if (archive.comment !== manifest.commit)
    throw new Error("The engine source archive does not match the selected revision.");
  const nativeModule = /^module\s+(\S+)/m.exec(archive.data.toString("utf8"))?.[1];
  if (!nativeModule)
    throw new Error("The selected engine source does not declare its native module.");
  const dependencies = new Map();
  const checksums = {};
  for (const name of ["sysml-lsp", "sysml-grpc"]) {
    const filename = name + extensionSuffix;
    const executable = join(binaries, filename);
    const version = execFileSync(executable, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    if (!version.includes(manifest.version) || !version.includes(manifest.commit))
      throw new Error(`The ${name} build does not match the selected version and revision.`);
    const data = await readFile(executable);
    const start = data.indexOf(Buffer.from(`\nmod\t${nativeModule}\t`));
    if (start < 0) throw new Error(`Missing ${name} native build metadata.`);
    const lines = data
      .subarray(start, start + 65536)
      .toString("utf8")
      .split("\n")
      .slice(1);
    const metadata = [];
    for (const line of lines) {
      if (!/^(mod|dep|build|=>)\t/.test(line)) break;
      metadata.push(line);
      if (line.startsWith("dep\t")) {
        const [, module, version] = line.split("\t");
        if (!version || version === "(devel)")
          throw new Error("Native dependency metadata needs a versioned module.");
        dependencies.set(`${module}@${version}`, { module, version });
      }
    }
    if (!metadata.some((line) => line === "build\t-trimpath=true"))
      throw new Error(`The ${name} build must use -trimpath before distribution.`);
    assertPublicData(data, `runtime/${target}/${filename}`, root);
    const output = join(destination, target, filename);
    await copyFile(executable, output);
    if (process.platform !== "win32") await chmod(output, 0o755);
    checksums[`${target}/${filename}`] = createHash("sha256").update(data).digest("hex");
  }
  const cache =
    process.env.GOMODCACHE ||
    join((process.env.GOPATH || join(homedir(), "go")).split(delimiter)[0], "pkg/mod");
  const escapeModule = (value) => value.replace(/[A-Z]/g, (letter) => "!" + letter.toLowerCase());
  const inventory = [];
  for (const dependency of [...dependencies.values()].sort((a, b) =>
    a.module.localeCompare(b.module),
  )) {
    const directory = join(
      cache,
      `${escapeModule(dependency.module)}@${escapeModule(dependency.version)}`,
    );
    const files = (await readdir(directory)).filter((file) =>
      /^(licen[cs]e|notice|copying)(\.|$)/i.test(file),
    );
    if (!files.length)
      throw new Error(`Missing notices for native dependency ${dependency.module}.`);
    const relative = `dependencies/${encodeURIComponent(dependency.module)}@${dependency.version}`;
    await mkdir(join(notices, relative), { recursive: true });
    for (const file of files) await copyFile(join(directory, file), join(notices, relative, file));
    inventory.push({ ...dependency, notices: files.map((file) => `${relative}/${file}`) });
  }
  await writeFile(
    join(notices, "dependencies.json"),
    JSON.stringify(
      {
        goLicense: "Go-LICENSE",
        goLicenseSource: "https://go.dev/LICENSE",
        dependencies: inventory,
      },
      null,
      2,
    ) + "\n",
  );
  const runtime = {
    version: manifest.version,
    commit: manifest.commit,
    target,
    executables: {
      lsp: `${target}/sysml-lsp${extensionSuffix}`,
      api: `${target}/sysml-grpc${extensionSuffix}`,
    },
    licenses: "licenses",
    source: "source/source.zip",
    sourceRepository: manifest.source,
    checksums,
  };
  await writeFile(join(destination, "manifest.json"), JSON.stringify(runtime, null, 2) + "\n");
  const files = await filesUnder(destination);
  for (const file of files)
    assertPublicData(await readFile(file), `runtime/${archiveName(destination, file)}`, root);
  return { directory: destination, files, target };
}
