// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  type Uri = { fsPath: string; scheme: string; toString(): string };
  const uri = (name: string): Uri => ({ fsPath: name, scheme: "file", toString: () => name });
  return {
    uri,
    folders: [
      { uri: uri("project-one"), name: "one", index: 0 },
      { uri: uri("project-two"), name: "two", index: 1 },
    ],
    configs: new Map<string, Record<string, unknown>>(),
    state: new Map<string, string>(),
    libraries: [] as {
      scheme: string;
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }[],
    commands: new Map<string, () => unknown>(),
    clients: [] as {
      options: { errorHandler: { closed(): unknown }; documentSelector: { scheme: string }[] };
      stop: ReturnType<typeof vi.fn>;
    }[],
    events: {} as Record<string, (event: unknown) => void>,
    logs: [] as string[],
  };
});

vi.mock("vscode", () => {
  const event = (name: string) => (callback: (event: unknown) => void) => {
    host.events[name] = callback;
    return { dispose() {} };
  };
  return {
    Uri: { file: host.uri },
    RelativePattern: class {},
    StatusBarAlignment: { Left: 1 },
    window: {
      createOutputChannel: () => ({
        info: (text: string) => host.logs.push(text),
        error: (text: string) => host.logs.push(text),
        show() {},
        dispose() {},
      }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      onDidChangeActiveTextEditor: event("active"),
      showWarningMessage: async () => undefined,
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: host.folders,
      getConfiguration: (_section: string, uri: { fsPath: string }) => ({
        get: (key: string, fallback: unknown) => host.configs.get(uri.fsPath)?.[key] ?? fallback,
      }),
      onDidChangeConfiguration: event("configuration"),
      onDidChangeWorkspaceFolders: event("workspace"),
      onDidGrantWorkspaceTrust: event("trust"),
      onDidOpenTextDocument: event("document"),
      createFileSystemWatcher: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (name: string, callback: () => unknown) => {
        host.commands.set(name, callback);
        return { dispose() {} };
      },
    },
  };
});

vi.mock("vscode-languageclient/node", () => ({
  CloseAction: { DoNotRestart: 1 },
  ErrorAction: { Shutdown: 1 },
  LanguageClient: class {
    stop = vi.fn(async () => {});
    constructor(
      _id: string,
      _name: string,
      _server: unknown,
      public options: {
        errorHandler: { closed(): unknown };
        documentSelector: { scheme: string }[];
      },
    ) {
      host.clients.push(this);
    }
    async start() {}
    async sendNotification() {}
  },
}));

vi.mock("../src/stdlib.js", () => ({
  StdlibDocuments: class {
    attach = vi.fn(() => true);
    detach = vi.fn();
    dispose = vi.fn();
    constructor(public scheme: string) {
      host.libraries.push(this);
    }
  },
}));

vi.mock("@dryas/engine-adapter", async (original) => ({
  ...(await original<typeof import("@dryas/engine-adapter")>()),
  readSnapshot: async (root: string) => ({ roots: [root + "/model"], documents: [] }),
  ProjectSession: class {
    close() {}
  },
}));
vi.mock("../src/startup.js", async (original) => ({
  ...(await original<typeof import("../src/startup.js")>()),
  verifyLanguageServer: async () => {},
}));

import { activate, deactivate } from "../src/extension.js";
import type { ExtensionContext } from "vscode";

beforeEach(() => {
  vi.useFakeTimers();
  host.configs.clear();
  host.state.clear();
  host.libraries.length = 0;
  host.clients.length = 0;
  host.logs.length = 0;
});
afterEach(async () => {
  await deactivate();
  vi.useRealTimers();
});

async function open() {
  const pending = activate({
    subscriptions: [],
    workspaceState: {
      get: (key: string) => host.state.get(key),
      update: async (key: string, value: string) => {
        host.state.set(key, value);
      },
    },
  } as unknown as ExtensionContext);
  await vi.advanceTimersByTimeAsync(0);
  return pending;
}

it("restarts only the project whose effective language settings changed", async () => {
  const api = await open();
  host.configs.set("project-one", { requestTimeoutMs: 20000 });
  host.events.configuration!({ affectsConfiguration: () => true });
  await vi.advanceTimersByTimeAsync(750);
  expect(api.getLanguageServiceStatus().map((s) => s.generation)).toEqual([2, 1]);
  expect(host.clients[1]!.stop).not.toHaveBeenCalled();
  expect(host.libraries).toHaveLength(2);
  expect(host.libraries[0]!.attach).toHaveBeenCalledTimes(2);
  expect(host.libraries[1]!.attach).toHaveBeenCalledTimes(1);
  expect(api.getLanguageServiceStatus().every((s) => s.index === "unconfirmed")).toBe(true);
});

it("routes each project's library documents only to its own client and restores identities", async () => {
  await open();
  const schemes = host.libraries.map((library) => library.scheme);
  expect(new Set(schemes).size).toBe(2);
  for (let index = 0; index < 2; index++) {
    const selected = host.clients[index]!.options.documentSelector.map((filter) => filter.scheme);
    expect(selected).toContain(schemes[index]);
    expect(selected).not.toContain(schemes[1 - index]);
  }
  await deactivate();
  expect(host.libraries.every((library) => library.dispose.mock.calls.length === 1)).toBe(true);
  await open();
  expect(host.libraries.slice(2).map((library) => library.scheme)).toEqual(schemes);
});

it("recovers once from an unexpected disconnect without entering a restart loop", async () => {
  const api = await open();
  host.clients[0]!.options.errorHandler.closed();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getLanguageServiceStatus()[0]).toMatchObject({
    generation: 2,
    connection: "connected",
    reason: "engine-recovery",
  });
  host.clients[2]!.options.errorHandler.closed();
  await vi.advanceTimersByTimeAsync(1000);
  host.events.document!({ languageId: "sysml" });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getLanguageServiceStatus()[0]).toMatchObject({ generation: 2, connection: "error" });
  expect(host.clients).toHaveLength(3);
  expect(host.logs.some((line) => line.includes("automatic recovery limit reached"))).toBe(true);
  const pending = host.commands.get("dryas.restartLanguageServer")!();
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(api.getLanguageServiceStatus()[0]).toMatchObject({
    generation: 3,
    connection: "connected",
  });
});

it("does not let a queued setting change restart services after deactivation", async () => {
  await open();
  host.configs.set("project-one", { requestTimeoutMs: 20000 });
  host.events.configuration!({ affectsConfiguration: () => true });
  await deactivate();
  await vi.advanceTimersByTimeAsync(2000);
  expect(host.clients).toHaveLength(2);
  expect(host.clients.every((client) => client.stop.mock.calls.length === 1)).toBe(true);
});

it("keeps the recovery limit after an invalid API setting is reverted", async () => {
  const api = await open();
  host.configs.set("project-one", { apiPath: '"invalid-api"' });
  host.events.configuration!({ affectsConfiguration: () => true });
  await vi.advanceTimersByTimeAsync(750);
  host.configs.delete("project-one");
  host.events.configuration!({ affectsConfiguration: () => true });
  await vi.advanceTimersByTimeAsync(750);
  expect(api.getLanguageServiceStatus()[0]!.generation).toBe(1);
  host.clients[0]!.options.errorHandler.closed();
  await vi.advanceTimersByTimeAsync(0);
  host.clients[2]!.options.errorHandler.closed();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.getLanguageServiceStatus()[0]).toMatchObject({ generation: 2, connection: "error" });
});
