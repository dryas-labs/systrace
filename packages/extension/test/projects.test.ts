// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext, WorkspaceFolder } from "vscode";

const host = vi.hoisted(() => {
  const uri = (path: string) => ({ fsPath: path, scheme: "file", toString: () => path });
  return {
    uri,
    folders: [] as { uri: ReturnType<typeof uri>; name: string; index: number }[],
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    state: new Map<string, string | undefined>(),
    changes: new Set<() => void>(),
    dialogs: [] as ReturnType<typeof uri>[][],
    names: [] as string[],
    errors: [] as string[],
  };
});
vi.mock("vscode", () => ({
  Uri: { file: host.uri },
  TreeItemCollapsibleState: { None: 0 },
  TreeItem: class {
    constructor(public label: string) {}
  },
  ThemeIcon: class {},
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window: {
    createTreeView: () => ({ dispose() {} }),
    showInputBox: async () => host.names.shift(),
    showOpenDialog: async () => host.dialogs.shift(),
    showQuickPick: async () => undefined,
    showErrorMessage: (message: string) => host.errors.push(message),
  },
  workspace: {
    get workspaceFolders() {
      return host.folders;
    },
    onDidChangeWorkspaceFolders: (fn: () => void) => {
      host.changes.add(fn);
      return { dispose: () => host.changes.delete(fn) };
    },
    updateWorkspaceFolders: (start: number, count: number, ...add: typeof host.folders) => {
      host.folders.splice(start, count, ...add);
      host.folders.forEach((folder, index) => {
        folder.index = index;
      });
      host.changes.forEach((fn) => fn());
      return true;
    },
  },
  commands: {
    registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
      host.commands.set(name, fn);
      return { dispose: () => host.commands.delete(name) };
    },
  },
}));

import { Projects, validProjectName } from "../src/projects.js";
let root: string;
let projects: Projects;
beforeEach(async () => {
  host.folders.length = 0;
  host.dialogs.length = 0;
  host.names.length = 0;
  host.errors.length = 0;
  host.state.clear();
  root = await mkdtemp(join(tmpdir(), "systrace-project-ui-"));
  projects = new Projects(
    {
      workspaceState: {
        get: (key: string) => host.state.get(key),
        update: async (key: string, value: string | undefined) => {
          host.state.set(key, value);
        },
      },
    } as unknown as ExtensionContext,
    () => undefined,
    () => {},
  );
});
afterEach(async () => {
  projects.dispose();
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("systrace-project-ui-"))
    throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});

it("creates a named project in the selected location without requiring a model directory", async () => {
  host.names.push("Flight System");
  host.dialogs.push([host.uri(root)]);
  await projects.create();
  const folder = join(root, "Flight System");
  await expect(access(folder)).resolves.toBeUndefined();
  await expect(access(join(folder, "model"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(projects.current?.uri.fsPath).toBe(folder);
  expect(host.state.get("dryas.currentProject")).toBe(folder);
});

it("opens existing roots, retains a captured target after selection changes, and closes without deleting", async () => {
  const a = join(root, "A"),
    b = join(root, "B");
  await mkdir(a);
  await mkdir(b);
  await projects.open(host.uri(a) as unknown as import("vscode").Uri);
  const captured = projects.current!;
  await projects.open(host.uri(b) as unknown as import("vscode").Uri);
  expect(projects.resolve(captured)?.uri.fsPath).toBe(a);
  expect(projects.current?.uri.fsPath).toBe(b);
  expect(projects.getTreeItem(captured).description).not.toContain("Current");
  await projects.select(captured);
  expect(projects.current?.uri.fsPath).toBe(a);
  await projects.close(captured);
  expect(projects.resolve(captured)).toBeUndefined();
  expect(projects.current?.uri.fsPath).toBe(b);
  await expect(access(a)).resolves.toBeUndefined();
});

it("selects an already open folder and rejects overlapping roots without changing its files", async () => {
  const nested = join(root, "nested");
  await mkdir(nested);
  await projects.open(host.uri(root) as unknown as import("vscode").Uri);
  await projects.open(host.uri(root) as unknown as import("vscode").Uri);
  expect(projects.folders).toHaveLength(1);
  await projects.open(host.uri(nested) as unknown as import("vscode").Uri);
  expect(projects.folders).toHaveLength(1);
  expect(host.errors[0]).toContain("overlap");
  expect(projects.resolve({ uri: host.uri(nested) } as WorkspaceFolder)).toBeUndefined();
});

it("rejects path traversal and reserved folder names before creating a project", () => {
  for (const name of ["../outside", "folder/name", "..", "CON", "trailing."])
    expect(validProjectName(name)).toBeTruthy();
  expect(validProjectName("Power system")).toBeUndefined();
});
