// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AdapterError } from "./errors.js";
import { readSnapshot, resolveModelRoots, type Snapshot } from "./snapshot.js";

export const PROJECT_FILE = ".systrace/project.json";
const definitionSchema = z
  .object({
    version: z.literal(1),
    modelRoots: z.array(z.string().min(1)).min(1).default(["."]),
    references: z.array(z.string().min(1)).max(32).default([]),
  })
  .passthrough();
export type ProjectDefinition = z.infer<typeof definitionSchema>;
export interface ReferencedProject {
  root: string;
  path: string;
  name: string;
  id: string;
  roots: string[];
  definition: ProjectDefinition;
}
export interface ProjectGraph {
  projects: ReferencedProject[];
  key: string;
}
export interface ReferenceSummary {
  id: string;
  project: string;
  path: string;
  modelRoots: string[];
}

export function containsPath(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

export function referencePath(root: string, target: string): string {
  const path = relative(root, target).split(sep).join("/") || ".";
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path))
    throw new AdapterError(
      "INVALID_PATH",
      "Project references must use relative paths. Choose projects on the same drive.",
    );
  return path;
}

export async function readProjectDefinition(
  root: string,
  fallbackRoots: string[] = ["."],
): Promise<ProjectDefinition> {
  try {
    if (
      (await lstat(join(root, ".systrace"))).isSymbolicLink() ||
      (await lstat(join(root, PROJECT_FILE))).isSymbolicLink()
    )
      throw new AdapterError(
        "INVALID_PATH",
        "Project configuration cannot be a symbolic link or junction.",
      );
    const text = await readFile(join(root, PROJECT_FILE), "utf8");
    return definitionSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, modelRoots: fallbackRoots, references: [] };
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `Cannot read ${PROJECT_FILE} for project "${basename(root)}". Check its JSON, version and source folders.`,
    );
  }
}

export async function writeProjectDefinition(
  root: string,
  value: ProjectDefinition,
  onlyIfMissing = false,
): Promise<void> {
  const definition = definitionSchema.parse(value);
  root = await realpath(root);
  const directory = join(root, ".systrace");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new AdapterError(
      "INVALID_PATH",
      "Project configuration cannot be stored through a symbolic link or junction.",
    );
  const text = JSON.stringify(definition, null, 2) + "\n";
  if (onlyIfMissing) {
    try {
      await writeFile(join(root, PROJECT_FILE), text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return;
  }
  const temporary = join(directory, `project-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, join(root, PROJECT_FILE));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function resolveProjectGraph(
  projectRoot: string,
  fallbackRoots: string[] = ["."],
  overrides: ReadonlyMap<string, ProjectDefinition> = new Map(),
  visit?: (root: string) => void,
): Promise<ProjectGraph> {
  const base = await realpath(projectRoot);
  const projects: ReferencedProject[] = [];
  const loaded = new Set<string>();
  const stack: string[] = [];
  async function load(path: string): Promise<void> {
    visit?.(path);
    let root: string;
    try {
      root = await realpath(path);
    } catch {
      throw new AdapterError(
        "INVALID_PATH",
        `Referenced project "${basename(path)}" is missing or inaccessible.`,
      );
    }
    if (stack.includes(root))
      throw new AdapterError(
        "INVALID_ARGUMENT",
        `Project reference cycle: ${[...stack.slice(stack.indexOf(root)), root].map((entry) => basename(entry)).join(" → ")}.`,
      );
    if (loaded.has(root)) return;
    if (projects.length >= 32)
      throw new AdapterError(
        "LIMIT_EXCEEDED",
        "A project scope supports at most 32 projects including references.",
      );
    if (
      projects.some(
        (project) => containsPath(project.root, root) || containsPath(root, project.root),
      )
    )
      throw new AdapterError(
        "INVALID_PATH",
        "Referenced project roots must not overlap. Use separate project folders.",
      );
    const definition =
      overrides.get(root) ??
      (await readProjectDefinition(root, root === base ? fallbackRoots : ["."]));
    const pathFromRoot = referencePath(base, root);
    projects.push({
      root,
      path: pathFromRoot,
      name: basename(root),
      id: encodeURIComponent(pathFromRoot),
      roots: await resolveModelRoots(root, definition.modelRoots),
      definition,
    });
    stack.push(root);
    for (const entry of definition.references) {
      if (
        isAbsolute(entry) ||
        /^[A-Za-z]:/.test(entry) ||
        entry.startsWith("\\") ||
        entry.includes("\0")
      )
        throw new AdapterError("INVALID_PATH", "Project references must be relative folder paths.");
      await load(resolve(root, entry));
    }
    stack.pop();
    loaded.add(root);
  }
  await load(base);
  return {
    projects,
    key: JSON.stringify(
      projects.map(({ root, definition }) => ({
        root,
        modelRoots: definition.modelRoots,
        references: definition.references,
      })),
    ),
  };
}

export function referenceSummaries(graph: ProjectGraph): ReferenceSummary[] {
  return graph.projects.slice(1).map((project) => ({
    id: project.id,
    project: project.name,
    path: project.path,
    modelRoots: project.definition.modelRoots,
  }));
}

/** One saved scope for editor startup, validation and saved model queries. */
export async function readProjectSnapshot(
  root: string,
  fallbackRoots: string[] = ["."],
  signal?: AbortSignal,
  allowEmpty = false,
): Promise<Snapshot> {
  const graph = await resolveProjectGraph(root, fallbackRoots);
  const documents: Snapshot["documents"] = [];
  let bytes = 0;
  for (const [index, project] of graph.projects.entries()) {
    const snapshot = await readSnapshot(project.root, project.definition.modelRoots, signal, true);
    for (const document of snapshot.documents) {
      bytes += Buffer.byteLength(document.content, "utf8");
      if (documents.length >= 2000 || bytes > 32 * 1024 * 1024)
        throw new AdapterError(
          "LIMIT_EXCEEDED",
          "The project and its references exceed the model file or byte limit.",
        );
      documents.push({
        ...document,
        name: index === 0 ? document.name : `.references/${project.id}/${document.name}`,
      });
    }
  }
  if (!documents.length && !allowEmpty)
    throw new AdapterError(
      "EMPTY_PROJECT",
      "No SysML or KerML files were found in the project or its references.",
    );
  const after = await resolveProjectGraph(root, fallbackRoots);
  if (after.key !== graph.key)
    throw new AdapterError(
      "PROJECT_CHANGED",
      "Project references changed while loading the saved model.",
    );
  return {
    roots: graph.projects.flatMap((project) => project.roots),
    documents,
    scopeKey: graph.key,
    references: referenceSummaries(graph),
  };
}
