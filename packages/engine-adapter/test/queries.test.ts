// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSession } from "../src/project.js";
import { publicError } from "../src/errors.js";

const executable = fileURLToPath(new URL("./query-engine.mjs", import.meta.url));
const sessions: ProjectSession[] = [];
const folders: string[] = [];
async function project(mode = "normal", timeoutMs = 1500) {
  const root = await mkdtemp(join(tmpdir(), "dryas-query-"));
  folders.push(root);
  await mkdir(join(root, "model"));
  const source = join(root, "model", "types.sysml");
  await writeFile(source, "package P { part def First; part def Second; part def Third; }");
  const session = new ProjectSession({
    projectRoot: root,
    engine: { executable: process.execPath, args: [executable, mode], timeoutMs },
  });
  sessions.push(session);
  return { root, source, session };
}
afterEach(async () => {
  sessions.splice(0).forEach((s) => s.close());
  for (const folder of folders.splice(0)) {
    if (
      dirname(folder) !== resolve(tmpdir()) ||
      !folder.startsWith(resolve(tmpdir()) + sep + "dryas-query-")
    )
      throw new Error("Unexpected test folder");
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("model query sessions over a programmed transport", () => {
  it("shares the validation snapshot and keeps query filtering separate from validation", async () => {
    const { session } = await project();
    const validation = await session.validate();
    const result = await session.findElement({ specializes: "P::Base" });
    expect(result.items.map((r) => ("id" in r ? r.id : r.element.id))).toEqual([
      "P::Second",
      "P::Third",
    ]);
    expect(result.content.projectRevision).toBe(validation.content.projectRevision);
    expect(result.validation).toEqual({ status: "incomplete", errors: 0, warnings: 0 });
    expect(JSON.stringify(result)).not.toContain("modelHash");
  });
  it("binds pagination to query, tool and session while allowing a new page size", async () => {
    const a = await project(),
      b = await project();
    const first = await a.session.findElement({ name: "First", limit: 1 });
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBeTruthy();
    const rest = await a.session.findElement({ cursor: first.nextCursor!, limit: 2 });
    expect(rest.items).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
    await expect(
      a.session.findElement({ cursor: first.nextCursor!, name: "Other" }),
    ).rejects.toMatchObject({ code: "STALE_CURSOR" });
    await expect(b.session.findElement({ cursor: first.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(a.session.libraryLookup({ cursor: first.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
  });
  it("rejects stale query pages after saved edits and returns fresh identities", async () => {
    const { session, source } = await project();
    const first = await session.findElement({ limit: 1 });
    await writeFile(source, "package P { part def Revised; }");
    await expect(session.findElement({ cursor: first.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    const fresh = await session.findElement();
    expect(fresh.items[0]).toMatchObject({ id: "P::Revised" });
    expect(fresh.content.projectRevision).toBe(first.content.projectRevision! + 1);
  });
  it("refuses query output when files change while the engine is answering", async () => {
    const { session, source } = await project();
    await session.validate();
    const pending = session.findElement({ name: "Slow" });
    await new Promise((r) => setTimeout(r, 60));
    await writeFile(source, "package P { part def Revised; }");
    await expect(pending).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
  });
  it("keeps a rejected query distinct from transport failure and hides raw exceptions", async () => {
    const { session } = await project();
    let rejected: unknown;
    try {
      await session.findElement({ name: "Reject" });
    } catch (error) {
      rejected = error;
    }
    expect(publicError(rejected).code).toBe("INVALID_ARGUMENT");
    expect(publicError(rejected).message).not.toContain("PRIVATE_ENGINE_DETAIL");
    expect((await session.findElement()).total).toBe(3);
    await expect(session.describeElement({ qualifiedName: "P::Missing" })).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
    });
    await expect(session.describeElement({ qualifiedName: "P::Ambiguous" })).rejects.toMatchObject({
      code: "QUERY_UNAVAILABLE",
    });
    expect((await session.findElement()).content.projectRevision).toBe(1);
  });
  it.each([
    ["missing-query", "UNSUPPORTED_CAPABILITY"],
    ["malformed", "ENGINE_PROTOCOL_ERROR"],
    ["error-envelope", "ENGINE_PROTOCOL_ERROR"],
    ["duplicates", "AMBIGUOUS_ELEMENT"],
  ])("reports %s without returning fake empty results", async (mode, code) => {
    const { session } = await project(mode);
    await expect(session.findElement()).rejects.toMatchObject({ code });
  });
  it("reports an unavailable native overlay explicitly", async () => {
    const { session } = await project("no-overlay");
    await expect(session.describeElement({ qualifiedName: "P::First" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    expect((await session.validate()).status).toBe("incomplete");
  });
  it("reparses after a query timeout and expires old cursors", async () => {
    const { session } = await project("normal", 350);
    const first = await session.findElement({ limit: 1 });
    await expect(session.findElement({ name: "Hang" })).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(session.findElement({ cursor: first.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    const recovered = await session.findElement();
    expect(recovered.total).toBe(3);
    expect(recovered.content.projectRevision).toBeGreaterThan(first.content.projectRevision!);
  });
  it("cancels queued work and recovers once after active cancellation", async () => {
    const { session } = await project();
    await session.validate();
    const active = new AbortController(),
      queued = new AbortController();
    const running = session.findElement({ name: "Hang" }, active.signal);
    const waiting = session.findElement({}, queued.signal);
    queued.abort();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((r) => setTimeout(r, 50));
    active.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await session.findElement()).total).toBe(3);
  });
  it("keeps library pagination independent of project edits", async () => {
    const { session, source } = await project();
    const library = await session.libraryLookup({ namespace: "P", limit: 1 });
    expect(library.source).toBe("bundled-library");
    expect(library.validation).toBeNull();
    expect(library.content.projectRevision).toBeNull();
    await writeFile(source, "package P { part def Revised; }");
    await session.validate();
    expect((await session.libraryLookup({ cursor: library.nextCursor! })).items).toHaveLength(2);
  });
  it("checks arguments and refuses new work after closing", async () => {
    const { session } = await project();
    await expect(session.findElement({ limit: 501 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(session.libraryLookup({})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      session.libraryLookup({ qualifiedName: "A", namespace: "B" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    session.close();
    await expect(session.findElement()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
  });
});
