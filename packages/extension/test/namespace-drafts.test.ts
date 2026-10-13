// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { NamespaceDrafts } from "../src/namespace-drafts.js";

interface Reply {
  name: string;
  errors: boolean;
  report?: boolean;
}
function engine(replies: Reply[]) {
  const drafts = new NamespaceDrafts();
  const opened: { uri: string; text: string }[] = [];
  const closed: string[] = [];
  const active = new Map<string, { owner: string; reply: Reply }>();
  let number = 0;
  const client = {
    initializeResult: { capabilities: { documentSymbolProvider: true } },
    sendNotification: vi.fn(
      async (method: string, params: { textDocument: { uri: string; text?: string } }) => {
        const { uri, text } = params.textDocument;
        if (method === "textDocument/didOpen") {
          opened.push({ uri, text: text! });
          const owner = text!.slice("package ".length, text!.indexOf(" {\n"));
          const reply = replies.shift()!;
          active.set(uri, { owner, reply });
          if (reply.report !== false) drafts.acceptDiagnostics(uri, reply.errors);
        } else if (method === "textDocument/didClose") closed.push(uri);
      },
    ),
    sendRequest: vi.fn(async (_method: string, params: { textDocument: { uri: string } }) => {
      const { owner, reply } = active.get(params.textDocument.uri)!;
      return [{ kind: 4, name: owner, children: [{ kind: 4, name: reply.name, children: [] }] }];
    }),
  } as unknown as Parameters<NamespaceDrafts["prepare"]>[0];
  return {
    drafts,
    opened,
    closed,
    prepare: (name: string) =>
      drafts.prepare(client, name, () => `file:///scratch/check-${++number}.sysml`, 50),
  };
}

afterEach(() => vi.useRealTimers());

it("keeps the bare spelling when diagnostics and the parsed package name agree", async () => {
  const host = engine([{ name: "Hello", errors: false }]);
  expect(await host.prepare("Hello")).toBe("package Hello {\n\n}\n");
  expect(host.opened).toHaveLength(1);
  expect(host.closed).toEqual([host.opened[0]!.uri]);
  expect(host.drafts.acceptDiagnostics(host.opened[0]!.uri, true)).toBe(true);
  expect(host.drafts.acceptDiagnostics("file:///project/user.sysml", true)).toBe(false);
});

it("retries with quotes when a recovering parser reports a symbol alongside an error", async () => {
  const host = engine([
    { name: "part", errors: true },
    { name: "part", errors: false },
  ]);
  expect(await host.prepare("part")).toBe("package 'part' {\n\n}\n");
  expect(new Set(host.opened.map((document) => document.uri)).size).toBe(2);
  expect(host.closed).toHaveLength(2);
});

it("requires the exact requested name, even when the engine reports no errors", async () => {
  const host = engine([
    { name: "Power", errors: false },
    { name: "Power System", errors: false },
  ]);
  expect(await host.prepare("Power System")).toBe("package 'Power System' {\n\n}\n");
  expect(host.opened).toHaveLength(2);
});

it.each(["timeout", "disconnect"] as const)(
  "does not treat %s as a reason to add quotes",
  async (failure) => {
    vi.useFakeTimers();
    const host = engine([{ name: "Hello", errors: false, report: false }]);
    const pending = host.prepare("Hello");
    const rejected = expect(pending).rejects.toMatchObject({
      code: failure === "timeout" ? "TIMEOUT" : "ENGINE_UNAVAILABLE",
    });
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(50);
    else host.drafts.dispose();
    await rejected;
    expect(host.opened).toHaveLength(1);
    expect(host.closed).toHaveLength(1);
  },
);

it("refuses creation when even the quoted candidate cannot be read back as the requested name", async () => {
  const host = engine([
    { name: "O", errors: true },
    { name: "O\\'Brien", errors: false },
  ]);
  await expect(host.prepare("O'Brien")).rejects.toMatchObject({ code: "QUERY_UNAVAILABLE" });
  expect(host.closed).toHaveLength(2);
});
