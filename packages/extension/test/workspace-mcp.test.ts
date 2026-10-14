// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Vscode from "vscode";
const host = vi.hoisted(() => ({
  folders: [] as Vscode.WorkspaceFolder[],
  trusted: true,
  events: new Map<string, (event?: unknown) => void>(),
  commands: new Map<string, () => unknown>(),
  registered: vi.fn(() => ({ dispose: vi.fn() })),
  execute: vi.fn(async () => undefined),
  messages: vi.fn(async () => undefined),
}));
vi.mock("vscode", () => {
  const event = (name: string) => (listener: (event?: unknown) => void) => {
    host.events.set(name, listener);
    return { dispose: () => host.events.delete(name) };
  };
  return {
    EventEmitter: class {
      listeners: (() => void)[] = [];
      event = (listener: () => void) => {
        this.listeners.push(listener);
        return { dispose() {} };
      };
      fire() {
        this.listeners.forEach((fn) => fn());
      }
      dispose() {
        this.listeners = [];
      }
    },
    McpStdioServerDefinition: class {
      constructor(
        public label: string,
        public command: string,
        public args: string[],
        public env: object,
        public version: string,
      ) {}
    },
    lm: { registerMcpServerDefinitionProvider: host.registered },
    workspace: {
      get isTrusted() {
        return host.trusted;
      },
      get workspaceFolders() {
        return host.folders;
      },
      onDidChangeWorkspaceFolders: event("folders"),
      onDidGrantWorkspaceTrust: event("trust"),
      onDidChangeConfiguration: event("config"),
    },
    commands: {
      registerCommand: (name: string, run: () => unknown) => {
        host.commands.set(name, run);
        return { dispose: () => host.commands.delete(name) };
      },
      getCommands: async () => ["workbench.mcp.listServer"],
      executeCommand: host.execute,
    },
    window: { showInformationMessage: host.messages },
  };
});
import { WorkspaceMcp } from "../src/workspace-mcp.js";
let provider: WorkspaceMcp;
let apiPath: string;
const state = new Map<string, unknown>();
const folder = (path: string): Vscode.WorkspaceFolder => ({
  name: "Shared",
  index: 0,
  uri: { fsPath: path, scheme: "file", toString: () => path } as Vscode.Uri,
});
const context = () =>
  ({
    extensionPath: "extension",
    extension: { packageJSON: { version: "0.1.20" } },
    workspaceState: {
      get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
  }) as unknown as Vscode.ExtensionContext;
function create() {
  return new WorkspaceMcp(context(), (entry) => ({
    projectRoot: entry.uri.fsPath,
    modelRoots: ["design"],
    engine: { executable: apiPath, expectedVersion: "test-engine", timeoutMs: 10000 },
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  state.clear();
  host.events.clear();
  host.commands.clear();
  host.trusted = true;
  host.folders = [folder("project-a"), folder("project-b")];
  apiPath = "engine-api";
  provider = create();
});
afterEach(() => provider.dispose());
it("registers distinct root-bound servers and keeps their labels stable across reordering and reactivation", async () => {
  const definitions = await provider.provideMcpServerDefinitions();
  expect(host.registered).toHaveBeenCalledWith("systrace.workspace", provider);
  expect(new Set(definitions.map((item) => item.label)).size).toBe(2);
  expect(definitions.map((item) => item.args[item.args.indexOf("--project") + 1])).toEqual([
    "project-a",
    "project-b",
  ]);
  expect(definitions[0]!.command).toBe(process.execPath);
  expect(definitions[0]!.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  host.folders.reverse();
  host.events.get("folders")!();
  provider.dispose();
  provider = create();
  expect((await provider.provideMcpServerDefinitions()).map((item) => item.label)).toEqual(
    definitions.map((item) => item.label).reverse(),
  );
});
it("refreshes engine settings and withdraws closed projects without retargeting old definitions", async () => {
  const definitions = await provider.provideMcpServerDefinitions();
  const changed = vi.fn();
  provider.onDidChangeMcpServerDefinitions(changed);
  apiPath = "replacement-api";
  host.events.get("config")!({ affectsConfiguration: (name: string) => name === "dryas.apiPath" });
  expect(changed).toHaveBeenCalledOnce();
  expect((await provider.resolveMcpServerDefinition(definitions[0]!))!.args).toContain(
    "replacement-api",
  );
  host.folders.shift();
  host.events.get("folders")!();
  expect(await provider.resolveMcpServerDefinition(definitions[0]!)).toBeUndefined();
  expect(await provider.provideMcpServerDefinitions()).toHaveLength(1);
});
it("does not offer servers outside a trusted workspace and unregisters on disposal", async () => {
  host.trusted = false;
  expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  host.trusted = true;
  host.events.get("trust")!();
  expect(await provider.provideMcpServerDefinitions()).toHaveLength(2);
  provider.dispose();
  expect(host.registered.mock.results[0]!.value.dispose).toHaveBeenCalledOnce();
  expect(await provider.provideMcpServerDefinitions()).toEqual([]);
});
it("opens host-owned connection status and controls rather than claiming an LSP connection is MCP", async () => {
  await host.commands.get("dryas.manageMcpServers")!();
  expect(host.execute).toHaveBeenCalledWith("workbench.mcp.listServer");
});
