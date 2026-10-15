// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "node:util";
import { observeLspDiagnostics } from "./lsp-diagnostics.js";
import { AdapterError } from "./errors.js";
import { resolveDiagnosticsProject } from "./diagnostics-project.js";

export async function runDiagnosticsCommand(
  args: string[],
  io: {
    input: AsyncIterable<Uint8Array | string>;
    cwd?: string;
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
        context: { type: "boolean" },
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
        "dryas-lsp-diagnostics [--project <folder>] [--context] [--lsp sysml-lsp] [--model-root .] [--path relative-file] [--overlay relative-file] [--timeout-ms 30000] [--expected-version build]\n--project takes precedence; otherwise search the working directory and its ancestors for project configuration. --context reads project scope without starting LSP. A known project folder needs no configuration file; use --project . if it is the working directory.\nIf the language server is missing, supply --lsp <executable> or configure PATH. Keep the returned JSON and reuse it for summaries.\nOverlay reads UTF-8 text from stdin and does not write files. Paths filter output only. Exit 0 reports an observation, not validation success.\n",
      );
      return 0;
    }
    const projectOptions = {
      ...(values.project === undefined ? {} : { projectRoot: values.project }),
      ...(values["model-root"] ? { modelRoots: values["model-root"] } : {}),
      ...(io.cwd === undefined ? {} : { cwd: io.cwd }),
    };
    if (values.context) {
      const { context } = await resolveDiagnosticsProject(projectOptions);
      io.out(JSON.stringify(context) + "\n");
      return 0;
    }
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
      ...projectOptions,
      ...(values.lsp ? { lspPath: values.lsp } : {}),
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
      PROJECT_NOT_FOUND:
        "No Systrace project configuration was found from the working directory. Supply --project <known-folder>; configuration is optional for an explicit project root.",
      ENGINE_NOT_FOUND:
        "The language-server executable was not found. Supply --lsp <executable> or make sysml-lsp available on PATH.",
      ENGINE_ACCESS_DENIED:
        "Cannot access the configured language-server executable. Check its path and execution permissions.",
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
