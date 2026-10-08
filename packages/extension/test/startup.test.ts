// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot } from "@dryas/engine-adapter";
import {
  checkExecutableSetting,
  sameConfig,
  sameLanguageConfig,
  startupError,
  verifyLanguageServer,
  type ProjectConfig,
} from "../src/startup.js";

const config: ProjectConfig = {
  projectRoot: "project",
  modelRoots: ["model"],
  lspPath: "sysml-lsp",
  engine: { executable: "sysml-grpc", expectedVersion: "v0.9.2-dryas.4", timeoutMs: 30000 },
};

it("explains missing default roots and accepts explicitly configured nested source folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "dryas-model-roots-"));
  try {
    const source = "sysml/src/training/01. Packages";
    await mkdir(join(root, source), { recursive: true });
    await writeFile(join(root, source, "Comment Example.sysml"), "package Example;\n");
    await expect(readSnapshot(root, ["model"], undefined, true)).rejects.toSatisfy(
      (error: unknown) => {
        const details = startupError(error, "model-folders");
        expect(details.code).toBe("INVALID_PATH");
        expect(details.message).toContain("dryas.modelRoots");
        expect(details.message).toContain('["model"]');
        expect(details.message).not.toContain(root);
        return true;
      },
    );
    const snapshot = await readSnapshot(root, [source], undefined, true);
    expect(snapshot.documents.map((document) => document.name)).toEqual([
      `${source}/Comment Example.sysml`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects accidentally pasted string delimiters without echoing the setting", () => {
  for (const value of ['"private-executable"', "'private-executable'", "", " tool", "tool\n"]) {
    expect(() => checkExecutableSetting(value, "dryas.lspPath")).toThrow(/plain path/);
  }
  expect(() =>
    checkExecutableSetting("program files/sysml-lsp.exe", "dryas.lspPath"),
  ).not.toThrow();
});

it("keeps private exception data out of structured startup diagnostics", () => {
  for (const [code, expected] of [
    ["ENOENT", "ENGINE_NOT_FOUND"],
    ["EPERM", "ENGINE_ACCESS_DENIED"],
    ["EACCES", "ENGINE_ACCESS_DENIED"],
    ["ENOEXEC", "INVALID_EXECUTABLE"],
    ["ETIMEDOUT", "TIMEOUT"],
  ]) {
    const error = startupError(
      {
        code,
        message: "private exception data",
        path: "private path",
        stderr: "private process output",
      },
      "version-check",
    );
    expect(error.code).toBe(expected);
    expect(error.message).not.toContain("private");
  }
  expect(startupError({ killed: true }, "version-check").code).toBe("TIMEOUT");
});

it("does not restart the LSP for an API-only change but catches model-root changes", () => {
  const api = { ...config, engine: { ...config.engine, executable: "another-api" } };
  expect(sameConfig(config, api)).toBe(false);
  expect(sameLanguageConfig(config, api)).toBe(true);
  expect(sameLanguageConfig(config, { ...config, modelRoots: ["other"] })).toBe(false);
  expect(sameConfig(config, { ...config, modelRoots: [...config.modelRoots!] })).toBe(true);
});

it("identifies a missing executable through a real spawn failure", async () => {
  await expect(
    verifyLanguageServer({
      ...config,
      lspPath: "dryas-test-nonexistent-language-server-executable",
    }),
  ).rejects.toMatchObject({ code: "ENGINE_NOT_FOUND" });
});
