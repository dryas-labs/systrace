// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LANGUAGE_ENGINE_PROVIDER } from "../src/default-engine.js";
import { observeLspDiagnostics } from "../src/lsp-diagnostics.js";
import { runDiagnosticsCommand } from "../src/diagnostics-command.js";
let root: string;
const fake = fileURLToPath(new URL("./diagnostic-lsp.mjs", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "systrace-lsp-"));
  await writeFile(join(root, "one.sysml"), "😀 bad");
  await writeFile(join(root, "two.kerml"), "valid");
});
afterEach(async () => {
  if (!basename(root).startsWith("systrace-lsp-")) throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});
async function run(args: string[] = [], text = "", mode = "normal") {
  let stdout = "",
    stderr = "";
  const provider = {
    ...DEFAULT_LANGUAGE_ENGINE_PROVIDER,
    defaultEngineVersion: "fixture-version",
    languageService: {
      ...DEFAULT_LANGUAGE_ENGINE_PROVIDER.languageService,
      version: {
        ...DEFAULT_LANGUAGE_ENGINE_PROVIDER.languageService.version,
        args: [fake, "-version"],
      },
      launch: {
        ...DEFAULT_LANGUAGE_ENGINE_PROVIDER.languageService.launch,
        args: [fake, "-strict", "-no-record-cache", mode],
      },
    },
  };
  const code = await runDiagnosticsCommand(
    ["--project", root, "--lsp", process.execPath, ...args],
    {
      input: (async function* () {
        yield text;
      })(),
      out: (value) => {
        stdout += value;
      },
      error: (value) => {
        stderr += value;
      },
    },
    (options) => observeLspDiagnostics(options, provider),
  );
  return { code, stderr, result: stdout ? JSON.parse(stdout) : undefined };
}
it("collects UTF-16 diagnostics and counts empty publications while path filters affect only output", async () => {
  const answer = await run();
  expect(answer.code).toBe(0);
  expect(answer.result).toMatchObject({
    observation: "lsp-recompute",
    settled: true,
    index: "unconfirmed",
    positionEncoding: "utf-16",
  });
  expect(answer.result.files).toEqual([
    { file: "one.sysml", received: true },
    { file: "two.kerml", received: true },
  ]);
  expect(answer.result.diagnostics[0].range.start).toEqual({ line: 1, column: 4 });
  const filtered = await run(["--path", "two.kerml"]);
  expect(filtered.result.files).toHaveLength(2);
  expect(filtered.result.diagnostics).toEqual([]);
});
it("replaces old diagnostics with empty updates and overlays input without changing disk", async () => {
  const answer = await run(["--overlay", "one.sysml"], "clear");
  expect(answer.code).toBe(0);
  expect(answer.result.settled).toBe(true);
  expect(answer.result.diagnostics).toEqual([]);
  expect(await readFile(join(root, "one.sysml"), "utf8")).toBe("😀 bad");
});
it("returns a normal unsettled observation on timeout but fails version mismatch and process crashes", async () => {
  const timed = await run(["--timeout-ms", "1200"], "", "silent");
  expect(timed.code).toBe(0);
  expect(timed.result.settled).toBe(false);
  expect(timed.result.files.every((file: { received: boolean }) => !file.received)).toBe(true);
  const mismatched = await run(["--expected-version", "wrong"]);
  expect(mismatched.code).toBe(1);
  expect(mismatched.stderr).toContain("ENGINE_VERSION_MISMATCH");
  expect(mismatched.stderr).not.toContain(root);
  expect((await run([], "", "crash")).code).toBe(1);
});
it("uses shared roots and references, with explicit roots overriding only the main project", async () => {
  await mkdir(join(root, ".systrace"));
  await mkdir(join(root, "design"));
  await writeFile(join(root, "design/main.sysml"), "valid");
  const reference = await mkdtemp(join(tmpdir(), "systrace-lsp-"));
  if (!basename(reference).startsWith("systrace-lsp-")) throw new Error("Unexpected fixture root");
  try {
    await writeFile(join(reference, "library.sysml"), "valid");
    await writeFile(
      join(root, ".systrace/project.json"),
      JSON.stringify({
        version: 1,
        modelRoots: ["design"],
        references: ["../" + basename(reference)],
      }),
    );
    expect((await run()).result.files.map((file: { file: string }) => file.file)).toEqual([
      "design/main.sysml",
      `.references/${encodeURIComponent("../" + basename(reference))}/library.sysml`,
    ]);
    expect((await run(["--model-root", "."])).result.files).toHaveLength(4);
  } finally {
    await rm(reference, { recursive: true, force: true });
  }
});
