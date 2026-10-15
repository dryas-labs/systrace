// SPDX-License-Identifier: Apache-2.0
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { AdapterError } from "./errors.js";
import {
  PROJECT_FILE,
  readProjectDefinition,
  resolveProjectGraph,
  referenceSummaries,
  type ProjectDefinition,
} from "./project-graph.js";

export interface DiagnosticsProjectOptions {
  projectRoot?: string;
  modelRoots?: string[];
  cwd?: string;
}

async function folderSettings(root: string): Promise<string[] | undefined> {
  try {
    const errors: ParseError[] = [];
    const settings = parse(await readFile(join(root, ".vscode", "settings.json"), "utf8"), errors, {
      allowTrailingComma: true,
    });
    if (errors.length) throw new Error();
    const roots = settings?.["dryas.modelRoots"];
    return roots === undefined ? undefined : z.array(z.string().min(1)).min(1).parse(roots);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "Cannot read project-local dryas.modelRoots. Check .vscode/settings.json.",
    );
  }
}

async function localDefinition(
  root: string,
  fallbackRoots?: string[],
): Promise<{ definition: ProjectDefinition; configuration: string | null }> {
  try {
    await stat(join(root, PROJECT_FILE));
    return { definition: await readProjectDefinition(root), configuration: PROJECT_FILE };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const roots = fallbackRoots ?? (await folderSettings(root));
  return {
    definition: { version: 1, modelRoots: roots ?? ["."], references: [] },
    configuration: !fallbackRoots && roots ? ".vscode/settings.json" : null,
  };
}

/** Resolve a saved project scope without connecting to an editor or starting an engine. */
export async function resolveDiagnosticsProject(options: DiagnosticsProjectOptions = {}) {
  const explicit = options.projectRoot !== undefined;
  if (explicit && !options.projectRoot!.trim())
    throw new AdapterError("INVALID_ARGUMENT", "The project folder must not be empty.");
  let root: string;
  try {
    root = await realpath(resolve(options.cwd ?? process.cwd(), options.projectRoot ?? "."));
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new AdapterError("INVALID_PATH", "The project or working directory cannot be opened.");
  }
  let local = await localDefinition(root, explicit ? options.modelRoots : undefined);
  while (!explicit && !local.configuration) {
    const parent = dirname(root);
    if (parent === root)
      throw new AdapterError(
        "PROJECT_NOT_FOUND",
        "No Systrace project configuration was found. Supply --project <folder>.",
      );
    root = parent;
    local = await localDefinition(root);
  }
  const definition = options.modelRoots
    ? { ...local.definition, modelRoots: options.modelRoots }
    : local.definition;
  const graph = await resolveProjectGraph(root, ["."], new Map([[root, definition]]));
  return {
    graph,
    context: {
      project: {
        root,
        name: graph.projects[0]!.name,
        modelRoots: definition.modelRoots,
        configuration: local.configuration,
        selection: explicit ? ("argument" as const) : ("working-directory" as const),
      },
      references: referenceSummaries(graph),
    },
  };
}
