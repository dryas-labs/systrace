// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runDiagnosticsCommand } from "../src/diagnostics-command.js";

let temporaryRoot: string;
let fixture: string;
let project: string;
let other: string;
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  fixture = await realpath(await mkdtemp(join(temporaryRoot, "systrace-context-")));
  project = join(fixture, "Project");
  other = join(fixture, "Other");
  await mkdir(join(project, ".systrace"), { recursive: true });
  await mkdir(join(project, "model", "nested"), { recursive: true });
  await mkdir(other);
  await mkdir(join(fixture, "Shared"));
  await writeFile(
    join(project, ".systrace", "project.json"),
    JSON.stringify({ version: 1, modelRoots: ["model"], references: ["../Shared"] }),
  );
});
afterEach(async () => {
  if (dirname(fixture) !== temporaryRoot || !basename(fixture).startsWith("systrace-context-"))
    throw new Error("Unexpected fixture root");
  await rm(fixture, { recursive: true, force: true });
});

async function context(args: string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const observe = vi.fn(async () => {
    throw new Error("Unexpected LSP start");
  });
  const code = await runDiagnosticsCommand(
    ["--context", ...args],
    {
      cwd,
      input: (async function* () {})(),
      out: (value) => {
        stdout += value;
      },
      error: (value) => {
        stderr += value;
      },
    },
    observe,
  );
  expect(observe).not.toHaveBeenCalled();
  return { code, stderr, result: stdout ? JSON.parse(stdout) : undefined };
}

it("uses explicit project scope before working-directory discovery and does not start LSP", async () => {
  await mkdir(join(other, ".systrace"));
  await writeFile(join(other, ".systrace", "project.json"), '{"version":1}');
  const answer = await context(["--project", project, "--lsp", "missing-language-server"], other);
  expect(answer.code).toBe(0);
  expect(answer.result.project).toMatchObject({
    root: project,
    modelRoots: ["model"],
    configuration: ".systrace/project.json",
    selection: "argument",
  });
  expect(answer.result.references).toMatchObject([
    { project: "Shared", path: "../Shared", modelRoots: ["."] },
  ]);
});

it("discovers the nearest configured project from a nested working directory", async () => {
  await mkdir(join(fixture, ".systrace"));
  await writeFile(join(fixture, ".systrace", "project.json"), '{"version":1}');
  const answer = await context([], join(project, "model", "nested"));
  expect(answer.code).toBe(0);
  expect(answer.result.project).toMatchObject({ root: project, selection: "working-directory" });
});

it("discovers legacy model-root settings and applies an explicit source-folder override", async () => {
  await mkdir(join(other, ".vscode"));
  await mkdir(join(other, "source", "nested"), { recursive: true });
  await writeFile(
    join(other, ".vscode", "settings.json"),
    '{ // project scope\n "dryas.modelRoots": ["source"], }',
  );
  const cwd = join(other, "source", "nested");
  const answer = await context([], cwd);
  expect(answer.code).toBe(0);
  expect(answer.result.project).toMatchObject({
    root: other,
    modelRoots: ["source"],
    configuration: ".vscode/settings.json",
  });
  expect((await context(["--model-root", "."], cwd)).result.project.modelRoots).toEqual(["."]);
});

it("requests an explicit project when no configuration can identify the working-directory scope", async () => {
  const answer = await context([], other);
  expect(answer.code).toBe(1);
  expect(answer.stderr).toContain("PROJECT_NOT_FOUND");
  expect(answer.stderr).toContain("--project");
  expect(answer.stderr).not.toContain(fixture);
});

it("accepts a known project folder without configuration instead of discovering another project", async () => {
  const answer = await context(["--project", other], project);
  expect(answer.code).toBe(0);
  expect(answer.result.project).toMatchObject({
    root: other,
    modelRoots: ["."],
    configuration: null,
    selection: "argument",
  });
  expect(answer.result.references).toEqual([]);
});
