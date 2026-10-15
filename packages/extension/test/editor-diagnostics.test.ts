// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ diagnostics: [] as unknown[], documents: [] as unknown[] }));
vi.mock("vscode", () => ({
  languages: { getDiagnostics: () => host.diagnostics },
  workspace: {
    get textDocuments() {
      return host.documents;
    },
    getWorkspaceFolder: () => undefined,
  },
}));
import { observeEditorDiagnostics } from "../src/editor-diagnostics.js";
const uri = (scheme: string, path: string) => ({
  scheme,
  path,
  fsPath: path,
  toString: () => `${scheme}:${path}`,
});
it("reads all severities and unsaved/library documents without requiring a connected service", () => {
  const saved = uri("file", "one.sysml"),
    draft = uri("untitled", "Untitled-1"),
    library = uri("fixture-library", "Numbers"),
    other = uri("file", "main.ts");
  const diagnostics = [0, 1, 2, 3].map((severity) => ({
    severity,
    message: "Observation",
    source: "another-provider",
    tags: [1, 2],
    relatedInformation: [
      {
        message: "Related",
        location: {
          uri: saved,
          range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } },
        },
      },
    ],
    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } },
  }));
  host.diagnostics = [
    [saved, diagnostics],
    [draft, diagnostics],
    [library, diagnostics],
    [other, diagnostics],
  ];
  host.documents = [{ uri: draft, languageId: "sysml", isDirty: true, version: 7 }];
  const projects = [
    { project: 1, connection: "error", index: "unconfirmed" as const, message: "Disconnected" },
    { project: 2, connection: "connected", index: "unconfirmed" as const, message: "Connected" },
  ];
  const result = observeEditorDiagnostics(projects, new Set(["fixture-library"]));
  expect(result.observation).toBe("editor");
  expect(result.projects).toEqual(projects);
  expect(result.files).toHaveLength(3);
  expect(result.files[1]).toMatchObject({ unsaved: true, documentVersion: 7 });
  expect(result.files[2]!.library).toBe(true);
  expect(result.files[0]!.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
    "error",
    "warning",
    "information",
    "hint",
  ]);
  expect(result.files[0]!.diagnostics[0]!.range.start).toEqual({ line: 1, column: 4 });
  expect(result.scope).toBe("all-providers-sysml-kerml");
  expect(result.files[0]!.diagnostics[0]).toMatchObject({
    source: "another-provider",
    tags: [1, 2],
    relatedInformation: [
      {
        message: "Related",
        location: { uri: saved.toString(), range: { start: { line: 2, column: 4 } } },
      },
    ],
  });
});
it("reports an empty collection as an editor observation, not clean validation", () => {
  host.diagnostics = [];
  host.documents = [];
  const result = observeEditorDiagnostics([], new Set());
  expect(result.files).toEqual([]);
  expect(result).not.toHaveProperty("status");
  expect(result).not.toHaveProperty("settled");
});
