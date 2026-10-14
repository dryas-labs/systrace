// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "node:util";
import { observeLspDiagnostics } from "./lsp-diagnostics.js";
import { AdapterError } from "./errors.js";

export async function runDiagnosticsCommand(
  args: string[],
  io: {
    input: AsyncIterable<Uint8Array | string>;
    out(text: string): void;
    error(text: string): void;
  },
  observe = observeLspDiagnostics,
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        project: { type: "string" },
        lsp: { type: "string" },
        "model-root": { type: "string", multiple: true },
        path: { type: "string", multiple: true },
        overlay: { type: "string" },
        "expected-version": { type: "string" },
        "timeout-ms": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.out(
        "dryas-lsp-diagnostics --project <folder> [--lsp sysml-lsp] [--model-root .] [--path relative-file] [--overlay relative-file] [--timeout-ms 30000] [--expected-version build]\nOverlay reads UTF-8 text from stdin and does not write files. Paths filter output only. Exit 0 reports an observation, not validation success.\n",
      );
      return 0;
    }
    if (!values.project)
      throw new AdapterError("INVALID_ARGUMENT", "A project folder is required (--project).");
    let text = "";
    if (values.overlay) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of io.input) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024)
          throw new AdapterError("LIMIT_EXCEEDED", "Overlay text exceeds the file size limit.");
        chunks.push(data);
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    }
    const result = await observe({
      projectRoot: values.project,
      ...(values.lsp ? { lspPath: values.lsp } : {}),
      ...(values["model-root"] ? { modelRoots: values["model-root"] } : {}),
      ...(values.path ? { paths: values.path } : {}),
      ...(values.overlay ? { overlay: { path: values.overlay, text } } : {}),
      ...(values["expected-version"] ? { expectedVersion: values["expected-version"] } : {}),
      ...(values["timeout-ms"] ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    });
    io.out(JSON.stringify(result) + "\n");
    return 0;
  } catch (error: unknown) {
    const code = error instanceof AdapterError ? error.code : "DIAGNOSTICS_FAILED";
    const messages: Record<string, string> = {
      INVALID_ARGUMENT: "Check command arguments and project-local configuration.",
      INVALID_PATH: "Check the project, source folders and relative file paths.",
      ENGINE_VERSION_MISMATCH: "The language-server version does not match the expected build.",
      TIMEOUT: "The language server could not initialize before the deadline.",
      LIMIT_EXCEEDED: "The input exceeds the supported size or file limit.",
    };
    io.error(
      `${code}: ${messages[code] ?? "Cannot obtain the LSP diagnostic observation. Check the executable and project configuration."}\n`,
    );
    return 1;
  }
}
