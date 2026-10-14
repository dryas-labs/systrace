// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AdapterError } from "./errors.js";
import type { LanguageServiceBackend } from "./language-service.js";

export async function verifyLanguageServiceVersion(
  executable: string,
  expected: string,
  backend: LanguageServiceBackend,
  timeoutMs = 10000,
): Promise<void> {
  const result = await promisify(execFile)(executable, [...backend.version.args], {
    windowsHide: true,
    timeout: Math.min(timeoutMs, 10000),
    env: backend.launch.environment(),
    maxBuffer: 64 * 1024,
  });
  if (!backend.version.matchesOutput(result.stdout, expected))
    throw new AdapterError(
      "ENGINE_VERSION_MISMATCH",
      "The language-server version does not match the expected build.",
    );
}
