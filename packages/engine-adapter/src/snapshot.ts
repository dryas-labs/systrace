// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AdapterError } from "./errors.js";

export interface ModelDocument {
  name: string;
  content: string;
  language: "sysml" | "kerml";
}
export interface Snapshot {
  roots: string[];
  documents: ModelDocument[];
}
const maxFiles = 2000;
const maxBytes = 32 * 1024 * 1024;

export function relativeName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (
    !name ||
    isAbsolute(name) ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new AdapterError(
      "INVALID_PATH",
      "Paths must stay inside the project and use relative names.",
    );
  }
  return normalized.replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function resolveModelRoots(project: string, roots: string[]): Promise<string[]> {
  if (!roots.length)
    throw new AdapterError("INVALID_PATH", "Configure at least one model source folder.");
  try {
    const base = await realpath(project);
    const resolved: string[] = [];
    for (const name of roots) {
      const requested = resolve(base, relativeName(name));
      const segments = relative(base, requested).split(sep).filter(Boolean);
      if (
        segments.some(
          (segment) =>
            ["selection", "designs", "node_modules"].includes(segment) || segment.startsWith("."),
        )
      )
        throw new AdapterError(
          "INVALID_PATH",
          "Model roots must stay outside local archives and hidden directories.",
        );
      let parent = base;
      for (const segment of segments) {
        parent = join(parent, segment);
        if ((await lstat(parent)).isSymbolicLink())
          throw new AdapterError(
            "INVALID_PATH",
            "Model roots cannot pass through symbolic links or junctions.",
          );
      }
      const path = await realpath(requested);
      if (!inside(base, path) || !(await stat(path)).isDirectory())
        throw new AdapterError(
          "INVALID_PATH",
          "A model root is not a directory inside the project.",
        );
      if (!resolved.includes(path)) resolved.push(path);
    }
    return resolved;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      "INVALID_PATH",
      "A configured project or model folder could not be opened.",
    );
  }
}

export async function readSnapshot(
  project: string,
  roots: string[],
  signal?: AbortSignal,
  allowEmpty = false,
): Promise<Snapshot> {
  try {
    const base = await realpath(project);
    const folders = await resolveModelRoots(base, roots);
    const docs = new Map<string, ModelDocument>();
    let bytes = 0,
      directories = 0;
    async function visit(folder: string): Promise<void> {
      if (signal?.aborted) throw new AdapterError("CANCELLED", "The request was cancelled.");
      if (++directories > 4000)
        throw new AdapterError(
          "LIMIT_EXCEEDED",
          "The model source tree exceeds the directory limit.",
        );
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory() && ["selection", "designs"].includes(entry.name))
          throw new AdapterError(
            "INVALID_PATH",
            "Choose model folders that do not contain local selection or design archives.",
          );
        const file = join(folder, entry.name);
        if (entry.isSymbolicLink())
          throw new AdapterError(
            "INVALID_PATH",
            "Symbolic links and junctions inside model folders are not supported.",
          );
        const canonical = await realpath(file);
        if (!inside(base, canonical))
          throw new AdapterError("INVALID_PATH", "A model entry points outside the project.");
        if (entry.isDirectory()) {
          await visit(file);
          continue;
        }
        if (!/\.(sysml|kerml)$/i.test(entry.name) || !entry.isFile()) continue;
        const name = relative(base, file).split(sep).join("/");
        if (docs.has(name)) continue;
        const before = await lstat(file);
        if (before.isSymbolicLink())
          throw new AdapterError("PROJECT_CHANGED", "A model file changed during loading.");
        bytes += before.size;
        if (before.size > 2 * 1024 * 1024 || bytes > maxBytes || docs.size >= maxFiles)
          throw new AdapterError(
            "LIMIT_EXCEEDED",
            "The project exceeds the model file or byte limit.",
          );
        const data = await readFile(file);
        const after = await lstat(file);
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          after.isSymbolicLink() ||
          (await realpath(file)) !== canonical
        )
          throw new AdapterError("PROJECT_CHANGED", "A model file changed during loading.");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
        docs.set(name, { name, content, language: /\.kerml$/i.test(name) ? "kerml" : "sysml" });
      }
    }
    for (const folder of folders) await visit(folder);
    if (!docs.size && !allowEmpty)
      throw new AdapterError(
        "EMPTY_PROJECT",
        "No SysML or KerML files were found in the configured model folders.",
      );
    return {
      roots: folders,
      documents: [...docs.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      "PROJECT_CHANGED",
      "Project files could not be read consistently as UTF-8.",
    );
  }
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.roots.length === b.roots.length &&
    a.roots.every((r, i) => r === b.roots[i]) &&
    a.documents.length === b.documents.length &&
    a.documents.every(
      (d, i) => d.name === b.documents[i]?.name && d.content === b.documents[i]?.content,
    )
  );
}
