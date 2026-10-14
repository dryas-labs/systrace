// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  readProjectSnapshot,
  resolveProjectGraph,
  writeProjectDefinition,
} from "../src/project-graph.js";
import { sameSnapshot } from "../src/snapshot.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "systrace-graph-"));
});
afterEach(async () => {
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("systrace-graph-"))
    throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});
async function project(name: string, references: string[] = []) {
  const folder = join(root, name);
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src/model.sysml"), `package ${name};`);
  await writeProjectDefinition(folder, { version: 1, modelRoots: ["src"], references });
  return folder;
}
it("loads declared scopes, deduplicates diamond dependencies and keeps same-named files distinct", async () => {
  await project("D");
  await project("B", ["../D"]);
  await project("C", ["../D"]);
  const a = await project("A", ["../B", "../C"]);
  await writeFile(join(root, "B/outside.sysml"), "outside the selected scope");
  const graph = await resolveProjectGraph(a);
  expect(graph.projects.map((p) => p.name)).toEqual(["A", "B", "D", "C"]);
  const snapshot = await readProjectSnapshot(a, ["legacy-missing"]);
  expect(snapshot.documents.map((d) => d.name)).toEqual([
    "src/model.sysml",
    ".references/..%2FB/src/model.sysml",
    ".references/..%2FD/src/model.sysml",
    ".references/..%2FC/src/model.sysml",
  ]);
  expect(snapshot.references?.map((r) => r.path)).toEqual(["../B", "../D", "../C"]);
});
it("detects saved dependency edits and removes references without removing target files", async () => {
  const b = await project("B");
  const a = await project("A", ["../B"]);
  const before = await readProjectSnapshot(a);
  await writeFile(join(b, "src/model.sysml"), "package B { part def Battery; }");
  const edited = await readProjectSnapshot(a);
  expect(sameSnapshot(before, edited)).toBe(false);
  await writeProjectDefinition(a, { version: 1, modelRoots: ["src"], references: [] });
  const removed = await readProjectSnapshot(a);
  expect(sameSnapshot(edited, removed)).toBe(false);
  expect(removed.documents).toHaveLength(1);
  expect(await readFile(join(b, "src/model.sysml"), "utf8")).toContain("Battery");
});
it("reports missing references, cycles and overlapping roots as project configuration errors", async () => {
  const a = await project("A", ["../B"]);
  await expect(resolveProjectGraph(a)).rejects.toMatchObject({
    code: "INVALID_PATH",
    message: expect.stringContaining("B"),
  });
  const b = await project("B", ["../A"]);
  await expect(resolveProjectGraph(a)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("A → B → A"),
  });
  await writeProjectDefinition(b, { version: 1, modelRoots: ["src"], references: ["src"] });
  await expect(resolveProjectGraph(a)).rejects.toMatchObject({
    code: "INVALID_PATH",
    message: expect.stringContaining("overlap"),
  });
});
