// SPDX-License-Identifier: Apache-2.0
import {
  AdapterError,
  verifyLanguageServiceVersion,
  type LanguageServiceBackend,
  type ProjectOptions,
  type ProjectGraph,
} from "@dryas/engine-adapter";

export type ProjectConfig = ProjectOptions & { lspPath: string; graph?: ProjectGraph };
export type StartupStage = "configuration" | "model-folders" | "version-check" | "lsp-initialize";

export function sameConfig(a: ProjectConfig, b: ProjectConfig): boolean {
  return sameLanguageConfig(a, b) && a.engine.executable === b.engine.executable;
}

export function sameLanguageConfig(a: ProjectConfig, b: ProjectConfig): boolean {
  return (
    a.projectRoot === b.projectRoot &&
    a.graph?.key === b.graph?.key &&
    a.lspPath === b.lspPath &&
    a.engine.expectedVersion === b.engine.expectedVersion &&
    a.engine.timeoutMs === b.engine.timeoutMs &&
    JSON.stringify(a.modelRoots) === JSON.stringify(b.modelRoots)
  );
}

export function checkExecutableSetting(value: string, setting: string): void {
  if (!value || value.trim() !== value || /[\r\n\0]/.test(value) || /^["']|["']$/.test(value))
    throw new AdapterError(
      "INVALID_EXECUTABLE",
      `${setting} must contain an executable path or name, without surrounding quotes or whitespace. Use a plain path in the Settings UI.`,
    );
}

// Classify process failures using structured fields only. Never expose commands,
// paths, stderr or exception stacks in lifecycle diagnostics.
export function startupError(error: unknown, stage: StartupStage): AdapterError {
  if (stage === "model-folders" && error instanceof AdapterError && error.code === "INVALID_PATH")
    return new AdapterError(
      error.code,
      `${error.message} Use Configure Model Source Folders or check modelRoots in .systrace/project.json; without that file, dryas.modelRoots in Workspace Folder Settings is the fallback. Source folders must exist inside the project. The default is ["."]; configure narrower source folders when needed.`,
    );
  if (error instanceof AdapterError) return error;
  const details = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (details.code === "ENOENT")
    return new AdapterError(
      "ENGINE_NOT_FOUND",
      "Cannot find the language-server executable or one of its required dependencies. Check dryas.lspPath; an API path alone is not enough.",
    );
  if (details.code === "EACCES" || details.code === "EPERM")
    return new AdapterError(
      "ENGINE_ACCESS_DENIED",
      "The language-server executable could not be accessed or started. Check its permissions.",
    );
  if (details.code === "ENOEXEC" || details.code === "EINVAL")
    return new AdapterError(
      "INVALID_EXECUTABLE",
      "The configured language server is not a runnable executable for this platform.",
    );
  if (details.code === "ETIMEDOUT" || details.killed === true)
    return new AdapterError(
      "TIMEOUT",
      `The language server exceeded the deadline during ${stage}.`,
    );
  return new AdapterError(
    "ENGINE_UNAVAILABLE",
    `The language server failed during ${stage}. Check the executable and model-folder settings.`,
  );
}

export async function verifyLanguageServer(
  config: ProjectConfig,
  backend: LanguageServiceBackend,
): Promise<void> {
  try {
    await verifyLanguageServiceVersion(
      config.lspPath,
      config.engine.expectedVersion!,
      backend,
      config.engine.timeoutMs ?? 30000,
    );
  } catch (error) {
    throw startupError(error, "version-check");
  }
}
