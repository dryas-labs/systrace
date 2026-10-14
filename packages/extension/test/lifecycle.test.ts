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
      protocol: unknown;
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }[],
    commands: new Map<string, () => unknown>(),
    clients: [] as {
      id: string;
      options: { errorHandler: { closed(): unknown }; documentSelector: { scheme: string }[] };
      stop: ReturnType<typeof vi.fn>;
    }[],
    events: {} as Record<string, (event: unknown) => void>,
    logs: [] as string[],
    spawns: [] as { command: string; args: string[]; options: { env: NodeJS.ProcessEnv } }[],
    sessions: [] as { config: unknown; backend: unknown; close: ReturnType<typeof vi.fn> }[],
    watchers: [] as { pattern: string; dispose: ReturnType<typeof vi.fn> }[],
    failClientConstruction: false,
  };
});

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  realpath: async (path: string) => path,
}));

vi.mock("vscode", () => {
  const event = (name: string) => (callback: (event: unknown) => void) => {
    host.events[name] = callback;
    return { dispose() {} };
  };
  return {
    lm: undefined,
    McpStdioServerDefinition: undefined,
    Uri: { file: host.uri },
    TreeItemCollapsibleState: { None: 0 },
    TreeItem: class {},
    ThemeIcon: class {},
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    RelativePattern: class {
      constructor(
        _root: unknown,
        public pattern: string,
      ) {}
    },
    StatusBarAlignment: { Left: 1 },
    window: {
      createTreeView: () => ({ dispose() {} }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
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
      createFileSystemWatcher: (pattern: { pattern: string }) => {
        const watcher = {
          pattern: pattern.pattern,
          dispose: vi.fn(),
          onDidCreate() {},
          onDidChange() {},
          onDidDelete() {},
        };
        host.watchers.push(watcher);
        return watcher;
      },
    },
    commands: {
      registerCommand: (name: string, callback: () => unknown) => {
        host.commands.set(name, callback);
        return { dispose() {} };
      },
    },
  };
});

vi.mock("node:child_process", async (original) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await original<typeof import("node:child_process")>()),
    spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      host.spawns.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  };
});

vi.mock("vscode-languageclient/node", () => ({
  CloseAction: { DoNotRestart: 1 },
  ErrorAction: { Shutdown: 1 },
  LanguageClient: class {
    stop = vi.fn(async () => {});
    constructor(
      public id: string,
      _name: string,
      private readonly server: () => Promise<unknown>,
      public options: {
        errorHandler: { closed(): unknown };
        documentSelector: { scheme: string }[];
      },
    ) {
      if (host.failClientConstruction) throw new Error("private client constructor detail");
      host.clients.push(this);
    }
    async start() {
      await this.server();
    }
    async sendNotification() {}
  },
}));

vi.mock("../src/project-tree.js", async (original) => ({
  ...(await original<typeof import("../src/project-tree.js")>()),
  ProjectTree: class {
    refresh() {}
    dispose() {}
  },
}));

vi.mock("../src/stdlib.js", () => ({
  StdlibDocuments: class {
    attach = vi.fn(() => true);
    detach = vi.fn();
    dispose = vi.fn();
    constructor(
      public scheme: string,
      public protocol: unknown,
    ) {
      host.libraries.push(this);
    }
  },
}));

function fixtureGraph(root: string, roots: string[] = ["."]) {
  return {
    key: JSON.stringify([root, roots]),
    projects: [
      {
        root,
        path: ".",
        id: ".",
        name: root,
        roots: [root + "/model"],
        definition: { version: 1, modelRoots: roots, references: [] },
      },
    ],
  };
}

vi.mock("@dryas/engine-adapter", async (original) => ({
  ...(await original<typeof import("@dryas/engine-adapter")>()),
  readSnapshot: async (root: string) => ({ roots: [root + "/model"], documents: [] }),
  resolveProjectGraph: async (
    root: string,
    roots: string[],
    _overrides: unknown,
    visit?: (root: string) => void,
  ) => {
    visit?.(root);
    return fixtureGraph(root, roots);
  },
  readProjectSnapshot: async (root: string, roots: string[]) => ({
    roots: [root + "/model"],
    documents: [],
    scopeKey: fixtureGraph(root, roots).key,
  }),
  ProjectSession: class {
    close = vi.fn();
    constructor(
      public config: unknown,
      public backend: unknown,
    ) {
      host.sessions.push(this);
    }
  },
}));
vi.mock("../src/startup.js", async (original) => ({
  ...(await original<typeof import("../src/startup.js")>()),
  verifyLanguageServer: vi.fn(async () => {}),
}));

import { activate, deactivate, Manager } from "../src/extension.js";
import type { ExtensionContext } from "vscode";
import type { LanguageBackend, LanguageEngineProvider } from "@dryas/engine-adapter";
import { verifyLanguageServer } from "../src/startup.js";
import { TEST_LANGUAGE_SERVICE } from "./language-service-fixture.js";

beforeEach(() => {
  vi.useFakeTimers();
  host.folders.splice(
    0,
    host.folders.length,
    { uri: host.uri("project-one"), name: "one", index: 0 },
    { uri: host.uri("project-two"), name: "two", index: 1 },
  );
  host.configs.clear();
  host.state.clear();
  host.libraries.length = 0;
  host.clients.length = 0;
  host.logs.length = 0;
  host.spawns.length = 0;
  host.sessions.length = 0;
  host.watchers.length = 0;
  host.failClientConstruction = false;
  vi.mocked(verifyLanguageServer).mockClear();
});
afterEach(async () => {
  await deactivate();
  vi.useRealTimers();
});

function context(): ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {
      get: (key: string) => host.state.get(key),
      update: async (key: string, value: string) => {
        host.state.set(key, value);
      },
    },
  } as unknown as ExtensionContext;
}
async function open() {
  const pending = activate(context());
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

function fixtureProvider() {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected model query in lifecycle wiring test.");
  };
  const backends: LanguageBackend[] = [];
  const provider: LanguageEngineProvider = {
    id: "fixture-language-engine",
    interfaceVersion: 1,
    defaultEngineVersion: "fixture-build",
    languageService: TEST_LANGUAGE_SERVICE,
    createBackend: vi.fn(() => {
      const backend: LanguageBackend = {
        id: "fixture-language-engine",
        interfaceVersion: 1,
        generation: 0,
        connected: false,
        start: unexpected,
        validate: unexpected,
        openLibrary: unexpected,
        findElement: unexpected,
        describeElement: unexpected,
        libraryLookup: unexpected,
        close: vi.fn(),
      };
      backends.push(backend);
      return backend;
    }),
  };
  return { provider, backends };
}

it("uses one injected provider for language startup, library access and saved-project backends", async () => {
  const { provider, backends } = fixtureProvider();
  const injected = new Manager(context(), provider);
  try {
    const ready = injected.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    expect(host.spawns).toHaveLength(2);
    expect(host.spawns.every((call) => call.args.join(" ") === "--fixture-language-server")).toBe(
      true,
    );
    expect(
      host.spawns.every((call) => call.options.env.DRYAS_TEST_LANGUAGE_BUILD === "fixture-build"),
    ).toBe(true);
    expect(verifyLanguageServer).toHaveBeenCalledTimes(2);
    expect(verifyLanguageServer).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: expect.objectContaining({ expectedVersion: "fixture-build" }),
      }),
      TEST_LANGUAGE_SERVICE,
    );
    expect(
      host.libraries.every((library) => library.protocol === TEST_LANGUAGE_SERVICE.standardLibrary),
    ).toBe(true);
    expect(host.sessions.map((session) => session.backend)).toEqual(backends);
    expect(backends).toHaveLength(2);
    // An API-only change must continue using this provider while retaining the LSP.
    host.configs.set("project-one", { apiPath: "fixture-api" });
    host.events.configuration!({ affectsConfiguration: () => true });
    await vi.advanceTimersByTimeAsync(750);
    expect(host.spawns).toHaveLength(2);
    expect(provider.createBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ executable: "fixture-api" }),
    );
    expect(host.sessions[2]!.backend).toBe(backends[2]);
  } finally {
    await injected.dispose();
  }
});

it("isolates restored library tabs between providers while retaining each provider's identities", async () => {
  await open();
  const originalSchemes = host.libraries.map((library) => library.scheme);
  expect(host.state.has("dryas.stdlib.project-one")).toBe(true);
  await deactivate();
  const { provider } = fixtureProvider();
  const alternate = new Manager(context(), provider);
  let alternateSchemes: string[];
  try {
    const ready = alternate.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    alternateSchemes = host.libraries.slice(2).map((library) => library.scheme);
    expect(alternateSchemes).toHaveLength(2);
    expect(alternateSchemes.every((scheme) => !originalSchemes.includes(scheme))).toBe(true);
    expect(host.state.has("dryas.fixture-library.project-one")).toBe(true);
  } finally {
    await alternate.dispose();
  }
  const restarted = new Manager(context(), provider);
  try {
    const ready = restarted.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    expect(host.libraries.slice(4).map((library) => library.scheme)).toEqual(alternateSchemes);
  } finally {
    await restarted.dispose();
  }
});

it("preserves an existing saved-model session when replacement provider creation fails", async () => {
  const { provider } = fixtureProvider();
  const injected = new Manager(context(), provider);
  try {
    const ready = injected.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    const original = host.sessions[0]!;
    const factory = vi.mocked(provider.createBackend);
    factory.mockImplementationOnce(() => {
      throw new Error("private backend factory detail");
    });
    host.configs.set("project-one", { apiPath: "failing-api" });
    host.events.configuration!({ affectsConfiguration: () => true });
    await vi.advanceTimersByTimeAsync(750);
    expect(original.close).not.toHaveBeenCalled();
    expect(host.sessions).toHaveLength(2);
    expect(host.spawns).toHaveLength(2);
    expect(injected.getStatus()[0]).toMatchObject({
      connection: "connected",
      stage: "saved-validation-configuration",
      errorCode: "ENGINE_UNAVAILABLE",
    });
    expect(injected.getStatus()[0]!.message).toContain("previous saved-validation settings");
    expect(host.logs.join("\n")).not.toContain("private backend factory detail");
    // Returning to the active configuration clears the warning without discarding its session.
    host.configs.delete("project-one");
    host.events.configuration!({ affectsConfiguration: () => true });
    await vi.advanceTimersByTimeAsync(750);
    expect(original.close).not.toHaveBeenCalled();
    expect(injected.getStatus()[0]).not.toHaveProperty("errorCode");
    expect(injected.getStatus()[0]!.stage).toBe("connected");
    // A later valid configuration replaces the old session exactly once.
    host.configs.set("project-one", { apiPath: "replacement-api" });
    host.events.configuration!({ affectsConfiguration: () => true });
    await vi.advanceTimersByTimeAsync(750);
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(host.sessions).toHaveLength(3);
    expect(injected.getStatus()[0]).toMatchObject({ connection: "connected", stage: "connected" });
    expect(injected.getStatus()[0]).not.toHaveProperty("errorCode");
    expect(host.spawns).toHaveLength(2);
  } finally {
    await injected.dispose();
  }
});

it("keeps only configuration watchers when the provider factory fails at startup", async () => {
  const { provider } = fixtureProvider();
  vi.mocked(provider.createBackend).mockImplementation(() => {
    throw new Error("private factory failure");
  });
  const injected = new Manager(context(), provider);
  try {
    const ready = injected.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    expect(host.watchers.filter((w) => w.pattern !== ".systrace/project.json")).toHaveLength(0);
    expect(host.clients).toHaveLength(0);
    expect(host.sessions).toHaveLength(0);
    expect(injected.getStatus().every((status) => status.connection === "error")).toBe(true);
    expect(host.logs.join("\n")).not.toContain("private factory failure");
  } finally {
    await injected.dispose();
  }
});

it("disposes sessions and watchers when language-client construction fails after provider creation", async () => {
  const { provider } = fixtureProvider();
  host.failClientConstruction = true;
  const injected = new Manager(context(), provider);
  try {
    const ready = injected.refresh("activation");
    await vi.advanceTimersByTimeAsync(0);
    await ready;
    expect(host.sessions).toHaveLength(2);
    expect(host.watchers.filter((w) => w.pattern !== ".systrace/project.json")).toHaveLength(2);
    expect(host.sessions.every((session) => session.close.mock.calls.length === 1)).toBe(true);
    expect(
      host.watchers
        .filter((w) => w.pattern !== ".systrace/project.json")
        .every((watcher) => watcher.dispose.mock.calls.length === 1),
    ).toBe(true);
    expect(host.clients).toHaveLength(0);
    expect(host.logs.join("\n")).not.toContain("private client constructor detail");
  } finally {
    await injected.dispose();
  }
});

it("keeps language client identities distinct when closing a project shifts folder indexes", async () => {
  const api = await open();
  const retained = host.clients[1]!.id;
  host.folders.shift();
  host.folders[0]!.index = 0;
  host.folders.push({ uri: host.uri("project-three"), name: "three", index: 1 });
  host.events.workspace!({});
  await vi.advanceTimersByTimeAsync(0);
  expect(host.clients[0]!.stop).toHaveBeenCalledOnce();
  expect(host.clients[1]!.stop).not.toHaveBeenCalled();
  expect(host.clients[2]!.id).not.toBe(retained);
  expect(api.getLanguageServiceStatus()).toHaveLength(2);
});
