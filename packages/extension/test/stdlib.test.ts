// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LanguageClient } from "vscode-languageclient/node";

const host = vi.hoisted(() => {
  class Uri {
    constructor(private readonly value: URL) {}
    static parse(value: string) {
      return new Uri(new URL(value));
    }
    get scheme() {
      return this.value.protocol.slice(0, -1);
    }
    get path() {
      return decodeURIComponent(this.value.pathname);
    }
    with({ scheme }: { scheme: string }) {
      const value = new URL(this.toString());
      value.protocol = scheme + ":";
      return new Uri(value);
    }
    toString() {
      return this.value.toString();
    }
  }
  class EventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };
    fire(value: T) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  class CancellationTokenSource {
    private readonly changed = new EventEmitter<void>();
    token = { isCancellationRequested: false, onCancellationRequested: this.changed.event };
    cancel() {
      this.token.isCancellationRequested = true;
      this.changed.fire();
    }
    dispose() {
      this.changed.dispose();
    }
  }
  return {
    Uri,
    EventEmitter,
    CancellationTokenSource,
    documents: [] as { uri: Uri }[],
    providers: new Map<string, unknown>(),
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  EventEmitter: host.EventEmitter,
  CancellationTokenSource: host.CancellationTokenSource,
  CancellationError: class extends Error {},
  workspace: {
    textDocuments: host.documents,
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      host.providers.set(scheme, provider);
      return {
        dispose: () => {
          host.providers.delete(scheme);
        },
      };
    },
  },
}));

import * as vscode from "vscode";
import { StdlibDocuments } from "../src/stdlib.js";

const engineUri =
  "sysml-stdlib:/Domain%20Libraries/Quantities%20and%20Units/ISQElectromagnetism.sysml";
const providers: StdlibDocuments[] = [];
function make(scheme = "dryas-stdlib-test-one", text = "attribute voltage;") {
  const provider = new StdlibDocuments(scheme);
  providers.push(provider);
  const request = vi.fn(
    async (
      _method: string,
      _params: unknown,
      _token: vscode.CancellationToken,
    ): Promise<unknown> => ({ text }),
  );
  const client = {
    initializeResult: { capabilities: { experimental: { openSysmlStdlibContent: true } } },
    sendRequest: request,
  } as unknown as Pick<LanguageClient, "initializeResult" | "sendRequest">;
  provider.attach(client, 100);
  const uri = provider.uriConverters.protocol2Code(engineUri);
  const token = new vscode.CancellationTokenSource();
  return { provider, client, request, uri, token };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  providers.splice(0).forEach((provider) => provider.dispose());
  host.documents.length = 0;
  vi.useRealTimers();
});

it("reads the engine's bundled source and round-trips library URIs with spaces", async () => {
  const { provider, uri, token, request } = make();
  expect(host.providers.get(uri.scheme)).toBe(provider);
  expect(uri.path).toContain("Domain Libraries/Quantities and Units/");
  expect(provider.uriConverters.code2Protocol(uri)).toBe(engineUri);
  expect(await provider.provideTextDocumentContent(uri, token.token)).toBe("attribute voltage;");
  expect(request).toHaveBeenCalledWith(
    "opensysml/stdlibContent",
    { uri: engineUri },
    expect.anything(),
  );
  const workspaceUri = "file:///model/definitions.sysml";
  expect(provider.uriConverters.protocol2Code(workspaceUri).toString()).toBe(workspaceUri);
});

it("keeps two engines' standard-library documents and requests separate", async () => {
  const first = make("dryas-stdlib-test-one", "first engine source");
  const second = make("dryas-stdlib-test-two", "second engine source");
  expect(first.uri.toString()).not.toBe(second.uri.toString());
  expect(await first.provider.provideTextDocumentContent(first.uri, first.token.token)).toBe(
    "first engine source",
  );
  expect(await second.provider.provideTextDocumentContent(second.uri, second.token.token)).toBe(
    "second engine source",
  );
  await expect(
    first.provider.provideTextDocumentContent(second.uri, first.token.token),
  ).rejects.toThrow("another project");
  expect(first.provider.uriConverters.code2Protocol(second.uri)).toBe(second.uri.toString());
});

it("refreshes only its own open documents after a restart, using the new client", async () => {
  const { provider, uri, token, request } = make();
  host.documents.push({ uri: uri as unknown as InstanceType<typeof host.Uri> });
  host.documents.push({ uri: host.Uri.parse("dryas-stdlib-other:/Base.kerml") });
  const changed = vi.fn();
  provider.onDidChange(changed);
  provider.detach();
  await expect(provider.provideTextDocumentContent(uri, token.token)).rejects.toThrow(
    "unavailable",
  );
  const replacement = make("dryas-stdlib-unused", "replacement source");
  provider.attach(replacement.client, 100);
  expect(changed).toHaveBeenCalledExactlyOnceWith(uri);
  expect(await provider.provideTextDocumentContent(uri, token.token)).toBe("replacement source");
  expect(request).not.toHaveBeenCalled();
});

it("does not serve a late response from a detached engine", async () => {
  const { provider, uri, token, request } = make();
  let finish!: (value: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = provider.provideTextDocumentContent(uri, token.token);
  provider.detach();
  finish({ text: "stale source" });
  await expect(pending).rejects.toThrow("changed while reading");
});

it("reports a missing capability instead of supplying empty or copied library text", async () => {
  const { provider, uri, client, token, request } = make();
  client.initializeResult!.capabilities.experimental = {};
  expect(provider.attach(client, 100)).toBe(false);
  await expect(provider.provideTextDocumentContent(uri, token.token)).rejects.toThrow(
    "does not support",
  );
  expect(request).not.toHaveBeenCalled();
});

it("rejects malformed content and does not expose raw engine errors", async () => {
  const { provider, uri, token, request } = make();
  request.mockResolvedValueOnce({ text: null });
  await expect(provider.provideTextDocumentContent(uri, token.token)).rejects.toThrow(
    "invalid standard-library content",
  );
  request.mockRejectedValueOnce(new Error("private engine details"));
  await expect(provider.provideTextDocumentContent(uri, token.token)).rejects.toThrow(
    "could not read this standard-library document",
  );
});

it("forwards cancellation without waiting for an engine response", async () => {
  const { provider, uri, token, request } = make();
  request.mockImplementation(() => new Promise(() => {}));
  const pending = provider.provideTextDocumentContent(uri, token.token);
  const rejected = expect(pending).rejects.toBeInstanceOf(vscode.CancellationError);
  token.cancel();
  await rejected;
  expect(request.mock.calls[0]![2].isCancellationRequested).toBe(true);
});

it("bounds a stalled library read by the configured timeout", async () => {
  const { provider, uri, token, request } = make();
  request.mockImplementation(() => new Promise(() => {}));
  const rejected = expect(provider.provideTextDocumentContent(uri, token.token)).rejects.toThrow(
    "exceeded dryas.requestTimeoutMs",
  );
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(request.mock.calls[0]![2].isCancellationRequested).toBe(true);
});
