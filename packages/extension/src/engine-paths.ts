// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { join } from "node:path";

export function engineExecutable(
  name: "sysml-lsp" | "sysml-grpc",
  extensionRoot: string | undefined,
  configured: string | undefined,
  environment: string | undefined,
): string {
  if (configured && configured !== name) return configured;
  if (environment) return environment;
  if (extensionRoot) {
    const filename = name + (process.platform === "win32" ? ".exe" : "");
    const bundled = join(extensionRoot, "runtime", `${process.platform}-${process.arch}`, filename);
    if (existsSync(bundled)) return bundled;
  }
  return name;
}
