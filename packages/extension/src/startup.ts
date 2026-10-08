// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AdapterError, engineEnvironment, type ProjectOptions } from "@dryas/engine-adapter";

export type ProjectConfig = ProjectOptions & { lspPath: string };
export type StartupStage = "configuration" | "model-folders" | "version-check" | "lsp-initialize";

export function sameConfig(a: ProjectConfig, b: ProjectConfig): boolean {
  return sameLanguageConfig(a, b) && a.engine.executable === b.engine.executable;
}

export function sameLanguageConfig(a: ProjectConfig, b: ProjectConfig): boolean {
  return (
    a.projectRoot === b.projectRoot &&
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
      `${error.message} Set dryas.modelRoots in Workspace Folder Settings to existing source folders relative to the opened workspace folder. The default is ["model"]; projects with another layout need an explicit setting.`,
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

export async function verifyLanguageServer(config: ProjectConfig): Promise<void> {
  try {
    const version = await promisify(execFile)(config.lspPath, ["-version"], {
      windowsHide: true,
      timeout: Math.min(config.engine.timeoutMs ?? 30000, 10000),
      env: engineEnvironment(),
      maxBuffer: 64 * 1024,
    });
    if (version.stdout.split(/\r?\n/)[0] !== `sysml-lsp ${config.engine.expectedVersion}`)
      throw new AdapterError(
        "ENGINE_VERSION_MISMATCH",
        "The language server does not match dryas.expectedEngineVersion. Use the configured maintenance build.",
      );
  } catch (error) {
    throw startupError(error, "version-check");
  }
}
