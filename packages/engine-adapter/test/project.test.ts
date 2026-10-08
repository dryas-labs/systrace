// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectSession } from "../src/project.js";
import { readSnapshot, relativeName } from "../src/snapshot.js";
import { EngineConnection } from "../src/engine.js";

const fixture = fileURLToPath(new URL("./mock-engine.mjs", import.meta.url));
const folders: string[] = [];
const sessions: ProjectSession[] = [];
async function project(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "dryas-project-"));
  folders.push(root);
  await mkdir(join(root, "model"));
  await writeFile(join(root, "model/definitions.sysml"), "package P { part def Battery; }");
  await writeFile(join(root, "model/system.sysml"), "package S { part x : MissingType; }");
  const session = new ProjectSession({
    projectRoot: root,
    engine: { executable: process.execPath, args: [fixture, mode], timeoutMs: 1500 },
  });
  sessions.push(session);
  return { root, session };
}
afterEach(async () => {
  sessions.splice(0).forEach((s) => s.close());
  for (const folder of folders.splice(0)) {
    if (
      dirname(folder) !== resolve(tmpdir()) ||
      !folder.startsWith(resolve(tmpdir()) + sep + "dryas-project-")
    )
      throw new Error("Unexpected test folder");
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("saved-project validation", () => {
  it("preserves native severity while exposing normalized counts", async () => {
    const { session } = await project("upper-severity");
    const result = await session.validate();
    expect(result.project.errors).toBe(2);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.raw.severity).toBe("ERROR");
  });

  it("bounds the pending request queue and rejects closed work", async () => {
    const { session } = await project("timeout");
    const pending = Promise.allSettled(Array.from({ length: 8 }, () => session.validate()));
    await expect(session.validate()).rejects.toMatchObject({ code: "QUEUE_FULL" });
    session.close();
    expect((await pending).every((result) => result.status === "rejected")).toBe(true);
  });
  it("validates all files while filtering and paging diagnostics without losing counts", async () => {
    const { session } = await project();
    const filtered = await session.validate({ paths: ["model/definitions.sysml"] });
    expect(filtered.status).toBe("errors");
    expect(filtered.project.errors).toBe(2);
    expect(filtered.scope.errors).toBe(0);
    expect(filtered.diagnostics).toEqual([]);
    const first = await session.validate({ limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    expect(first.diagnostics[0]?.category).toBe("UNRESOLVED_NAME");
    const next = await session.validate({ cursor: first.nextCursor! });
    expect(next.diagnostics).toHaveLength(1);
    expect(next.diagnostics[0]?.id).not.toBe(first.diagnostics[0]?.id);
    expect(next.nextCursor).toBeNull();
    expect(next.content.projectRevision).toBe(first.content.projectRevision);
    expect(next.diagnostics[0]?.raw.message).toBe("unresolved reference: MissingType");
  });

  it("expires cursors on edits and advances file revisions without declaring complete validity", async () => {
    const { root, session } = await project();
    const first = await session.validate({ limit: 1 });
    await writeFile(
      join(root, "model/system.sysml"),
      "package S { private import P::*; part x : Battery; }",
    );
    await expect(session.validate({ cursor: first.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    const next = await session.validate();
    expect(next.status).toBe("incomplete");
    expect(next.project.errors).toBe(0);
    expect(next.content.projectRevision).toBe(2);
    expect(next.content.files.find((f) => f.file.endsWith("system.sysml"))?.revision).toBe(2);
    expect(next.completeness.libraryLoad).toBe("unknown");
  });

  it("rejects cursor reuse across sessions and path filter changes", async () => {
    const a = await project();
    const b = await project();
    const page = await a.session.validate({ limit: 1 });
    await expect(b.session.validate({ cursor: page.nextCursor! })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    await expect(
      a.session.validate({ cursor: page.nextCursor!, paths: ["model/definitions.sysml"] }),
    ).rejects.toMatchObject({ code: "STALE_CURSOR" });
  });

  it("detects file rename and removal instead of reusing an old project", async () => {
    const { root, session } = await project();
    await session.validate();
    await rename(join(root, "model/system.sysml"), join(root, "model/renamed.sysml"));
    const renamed = await session.validate();
    expect(renamed.content.projectRevision).toBe(2);
    expect(renamed.diagnostics[0]?.file).toBe("model/renamed.sysml");
    await rm(join(root, "model/renamed.sysml"));
    const deleted = await session.validate();
    expect(deleted.project.errors).toBe(0);
    expect(deleted.content.files).toHaveLength(1);
  });

  it("refuses a result if saved files change while the engine is validating", async () => {
    const { root, session } = await project("slow");
    const pending = session.validate();
    const timer = setInterval(() => {
      void writeFile(
        join(root, "model/system.sysml"),
        `package S { part x${Date.now()} : MissingType; }`,
      );
    }, 25);
    try {
      await expect(pending).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
    } finally {
      clearInterval(timer);
    }
  });

  it("rejects an empty project and paths escaping the project", async () => {
    for (const value of ["../outside", "..\\outside", "\\\\server\\model"])
      expect(() => relativeName(value)).toThrow();
    const { root } = await project();
    await expect(readSnapshot(root, ["../"])).rejects.toMatchObject({ code: "INVALID_PATH" });
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "selection"));
    await expect(readSnapshot(root, ["selection"])).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(readSnapshot(root, ["empty"])).rejects.toMatchObject({ code: "EMPTY_PROJECT" });
    expect((await readSnapshot(root, ["model", "model"])).documents).toHaveLength(2);
  });

  it("rejects model-folder links escaping the project", async () => {
    const a = await project();
    const b = await project();
    await symlink(
      join(b.root, "model"),
      join(a.root, "model/external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(readSnapshot(a.root, ["model"])).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it.each([
    ["wrong-version", "ENGINE_VERSION_MISMATCH"],
    ["missing-capability", "UNSUPPORTED_CAPABILITY"],
    ["malformed", "ENGINE_PROTOCOL_ERROR"],
    ["timeout", "TIMEOUT"],
    ["crash", "ENGINE_UNAVAILABLE"],
  ])("reports %s as a tool failure", async (mode, code) => {
    const { session } = await project(mode!);
    await expect(session.validate()).rejects.toMatchObject({ code });
  });

  it("cancels active work and does not run a cancelled queued request", async () => {
    const { session } = await project("timeout");
    const active = new AbortController();
    const queued = new AbortController();
    const a = session.validate({}, active.signal);
    const b = session.validate({}, queued.signal);
    queued.abort();
    await expect(b).rejects.toMatchObject({ code: "CANCELLED" });
    active.abort();
    await expect(a).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("bounds crash restarts and refuses requests after close", async () => {
    const { session } = await project("crash");
    await expect(session.validate()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    await expect(session.validate()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    await expect(session.validate()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    session.close();
    await expect(session.validate()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
  });

  it("does not expose executable paths on spawn failure", async () => {
    const { root } = await project();
    const engine = new EngineConnection({
      executable: join(root, "missing-engine"),
      timeoutMs: 500,
    });
    try {
      await expect(engine.start()).rejects.toMatchObject({
        code: "ENGINE_UNAVAILABLE",
        message: "The engine process stopped unexpectedly.",
      });
    } finally {
      engine.close();
    }
  });
});
