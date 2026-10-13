// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
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
    roots: new Map<string, string[]>(),
    opened: [] as string[],
    picks: [] as string[],
    errors: [] as string[],
  };
});
vi.mock("vscode", () => ({
  Uri: { file: host.uri },
  Range: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  RelativePattern: class {},
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
    showQuickPick: async (items: { label: string; directory: string }[]) => {
      const choice = host.picks.shift();
      return items.find((item) => item.label === choice);
    },
    showInformationMessage: (message: string) => host.errors.push(message),
    showTextDocument: async (document: { uri: ReturnType<typeof host.uri> }) => {
      host.opened.push(document.uri.fsPath);
    },
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
    getConfiguration: (_section: string, uri: ReturnType<typeof host.uri>) => ({
      get: (_key: string, fallback: string[]) => host.roots.get(uri.fsPath) ?? fallback,
    }),
    openTextDocument: async (uri: ReturnType<typeof host.uri>) => ({ uri }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({
      onDidCreate() {},
      onDidDelete() {},
      onDidChange() {},
      dispose() {},
    }),
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
import { ProjectTree, type ContentNode } from "../src/project-tree.js";
let root: string;
let projects: Projects;
beforeEach(async () => {
  host.folders.length = 0;
  host.dialogs.length = 0;
  host.names.length = 0;
  host.roots.clear();
  host.opened.length = 0;
  host.picks.length = 0;
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

it("shows root files directly under the project and configured source folders by their actual names", async () => {
  await mkdir(join(root, "architecture"));
  await mkdir(join(root, "requirements"));
  await writeFile(join(root, "system.sysml"), "package System;");
  await projects.open(host.uri(root) as unknown as import("vscode").Uri);
  const folder = projects.current!;
  const tree = new ProjectTree(
    { symbols: async () => [], libraries: async () => [], refreshLibraries() {} },
    () => {},
  );
  try {
    const direct = await tree.children(folder);
    const file = direct.find((node) => node.label === "system.sysml")!;
    expect(file.parent).toBe(folder);
    expect(direct.some((node) => node.nodeType === "source")).toBe(false);
    expect(direct.at(-1)?.nodeType).toBe("libraries");
    host.roots.set(root, ["architecture", "requirements"]);
    expect((await tree.children(folder)).map((node) => node.label)).toEqual([
      "architecture",
      "requirements",
      "Standard Library",
    ]);
  } finally {
    tree.dispose();
  }
});

it("creates a namespace in the clicked project's source folder without switching the current project or overwriting files", async () => {
  const a = join(root, "A"),
    b = join(root, "B");
  await mkdir(join(a, "design"), { recursive: true });
  await mkdir(b);
  await projects.open(host.uri(a) as unknown as import("vscode").Uri);
  const folder = projects.current!;
  host.roots.set(a, ["design"]);
  const target: ContentNode = {
    nodeType: "directory",
    id: "design",
    label: "design",
    folder,
    parent: folder,
    uri: host.uri(join(a, "design")) as unknown as import("vscode").Uri,
  };
  await projects.open(host.uri(b) as unknown as import("vscode").Uri);
  host.names.push("Electrical");
  await host.commands.get("dryas.newNamespaceInFolder")!(target);
  const file = join(a, "design", "Electrical.sysml");
  expect(await readFile(file, "utf8")).toBe("package 'Electrical' {\n\n}\n");
  expect(host.opened).toEqual([file]);
  expect(host.errors).toEqual([]);
  expect(projects.current?.uri.fsPath).toBe(b);
  await writeFile(file, "package Electrical { part def Battery; }");
  host.names.push("Electrical");
  await projects.newNamespace(target);
  expect(await readFile(file, "utf8")).toBe("package Electrical { part def Battery; }");
  expect(host.errors.at(-1)).toContain("already exists");
});

it("uses the chosen source root for project-level namespace creation and cancels without creating a file", async () => {
  await mkdir(join(root, "architecture"));
  await mkdir(join(root, "requirements"));
  await projects.open(host.uri(root) as unknown as import("vscode").Uri);
  host.roots.set(root, ["architecture", "requirements"]);
  host.picks.push("requirements");
  host.names.push("Power system");
  await projects.newNamespace();
  expect(await readFile(join(root, "requirements", "Power system.sysml"), "utf8")).toContain(
    "package 'Power system'",
  );
  await expect(access(join(root, "Power system.sysml"))).rejects.toMatchObject({ code: "ENOENT" });
  host.names.push("Cancelled");
  await projects.newNamespace();
  await expect(access(join(root, "requirements", "Cancelled.sysml"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("opens the folder picker when the title-bar command supplies a selected tree node instead of a URI", async () => {
  const folder = join(root, "ToolbarProject");
  await mkdir(folder);
  host.dialogs.push([host.uri(folder)]);
  const focused = {
    nodeType: "file",
    uri: host.uri(join(root, "selected.sysml")),
    label: "selected.sysml",
  };
  await host.commands.get("dryas.openProject")!(focused, [focused]);
  expect(projects.current?.uri.fsPath).toBe(folder);
  expect(host.dialogs).toHaveLength(0);
  expect(host.errors).toEqual([]);
});

it("uses the current project when New Namespace is invoked from the title bar", async () => {
  await projects.open(host.uri(root) as unknown as import("vscode").Uri);
  host.names.push("FromToolbar");
  const focused = { nodeType: "namespace", uri: { scheme: "library" }, label: "SI" };
  await host.commands.get("dryas.newNamespace")!(focused, [focused]);
  expect(await readFile(join(root, "FromToolbar.sysml"), "utf8")).toContain(
    "package 'FromToolbar'",
  );
});
