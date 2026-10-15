// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createRequire } from "node:module";
const { resolveEngine, parseJsonc } = createRequire(import.meta.url)(
  "../../../skills/sysml-diagnostics/scripts/run-diagnostics.cjs",
);
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "systrace-discovery-"));
});
afterEach(() => {
  if (!basename(root).startsWith("systrace-discovery-"))
    throw new Error("Invalid fixture directory");
  rmSync(root, { recursive: true, force: true });
});
const options = () => ({
  skillRoot: root,
  home: root,
  env: { PATH: "", APPDATA: root, XDG_CONFIG_HOME: root },
});
function settings(editor: string, engine: string) {
  const folder =
    process.platform === "darwin"
      ? join(root, "Library/Application Support", editor, "User")
      : join(root, editor, "User");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "settings.json");
  writeFileSync(
    file,
    "// JSONC\n" + JSON.stringify({ "dryas.lspPath": engine }).replace(/}$/, ",}"),
  );
  return file;
}
it("discovers editor JSONC without PATH and preserves string contents", () => {
  settings("Code", process.execPath);
  expect(resolveEngine(options()).executable).toBe(process.execPath);
  expect(parseJsonc('{"url":"https://example.test/a", "text":",}",}')).toEqual({
    url: "https://example.test/a",
    text: ",}",
  });
});
it("prefers bundled runtime, but explicit configuration overrides it", () => {
  const directory = join(root, "runtime", `${process.platform}-${process.arch}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, process.platform === "win32" ? "sysml-lsp.exe" : "sysml-lsp"),
    "fixture",
    { mode: 0o755 },
  );
  settings("Code", process.execPath);
  expect(resolveEngine(options()).source).toBe("bundled");
  expect(resolveEngine({ ...options(), lsp: process.execPath }).source).toBe("--lsp");
  writeFileSync(join(root, "engine.local.json"), JSON.stringify({ lspPath: process.execPath }));
  expect(resolveEngine(options()).executable).toBe(process.execPath);
});
it("requires selection for conflicting editors and fails for an invalid explicit path", () => {
  settings("Code", process.execPath);
  const engine = join(root, "alternative-engine");
  writeFileSync(engine, "fixture", { mode: 0o755 });
  const cursor = settings("Cursor", engine);
  expect(() => resolveEngine(options())).toThrow(/Multiple editor/);
  expect(resolveEngine({ ...options(), vscodeSettings: cursor }).executable).toBe(engine);
  expect(() => resolveEngine({ ...options(), lsp: join(root, "missing") })).toThrow(
    /not accessible/,
  );
});
