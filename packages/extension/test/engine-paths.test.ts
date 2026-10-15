// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, cp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { engineExecutable } from "../src/engine-paths.js";

const loadLauncher = createRequire(import.meta.url);
const launcher = loadLauncher("../../../skills/sysml-diagnostics/scripts/run-diagnostics.cjs") as {
  resolveEngine(options: { skillRoot: string; env: NodeJS.ProcessEnv; home: string }): {
    executable: string;
    source: string;
    relativeExecutable?: string;
  };
};
let root: string;
let temporaryRoot: string;
let extension: string;
let filename: string;
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await realpath(await mkdtemp(join(temporaryRoot, "systrace-runtime-")));
  extension = join(root, "extension");
  filename = "sysml-lsp" + (process.platform === "win32" ? ".exe" : "");
  const runtime = join(extension, "runtime", `${process.platform}-${process.arch}`);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, filename), "fixture");
  await chmod(join(runtime, filename), 0o755);
});
afterEach(async () => {
  if (dirname(root) !== temporaryRoot || !basename(root).startsWith("systrace-runtime-"))
    throw new Error("Unexpected runtime fixture root");
  await rm(root, { recursive: true, force: true });
});
it("uses the packaged runtime by default while keeping explicit and development overrides", () => {
  expect(engineExecutable("sysml-lsp", extension, "", undefined)).toBe(
    join(extension, "runtime", `${process.platform}-${process.arch}`, filename),
  );
  expect(engineExecutable("sysml-lsp", extension, "custom-engine", "development-engine")).toBe(
    "custom-engine",
  );
  expect(engineExecutable("sysml-lsp", extension, undefined, "development-engine")).toBe(
    "development-engine",
  );
});
it("locates both the VSIX and relocated portable Skill runtime without editor or PATH discovery", async () => {
  const skill = join(extension, "skills", "sysml-diagnostics");
  await mkdir(skill, { recursive: true });
  const first = launcher.resolveEngine({ skillRoot: skill, env: {}, home: root });
  expect(first.source).toBe("bundled");
  expect(first.executable).toBe(
    join(extension, "runtime", `${process.platform}-${process.arch}`, filename),
  );
  const portable = join(root, "portable", "sysml-diagnostics");
  await mkdir(portable, { recursive: true });
  await cp(join(extension, "runtime"), join(portable, "runtime"), { recursive: true });
  const second = launcher.resolveEngine({ skillRoot: portable, env: {}, home: root });
  expect(second.source).toBe("bundled");
  expect(second.relativeExecutable).toBe(`runtime/${process.platform}-${process.arch}/${filename}`);
});
