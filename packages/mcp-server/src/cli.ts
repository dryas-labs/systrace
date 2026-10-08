// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      engine: { type: "string", default: "sysml-grpc" },
      "model-root": { type: "string", multiple: true },
      "expected-version": { type: "string" },
      "timeout-ms": { type: "string", default: "30000" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "dryas-mcp --project <folder> [--engine <sysml-grpc>] [--model-root model] [--expected-version <version>]\n",
    );
    return;
  }
  if (!values.project) throw new Error("A project folder is required.");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error("Invalid request deadline.");
  const app = createServer({
    projectRoot: resolve(values.project),
    modelRoots: values["model-root"] ?? ["model"],
    engine: {
      executable: values.engine,
      timeoutMs,
      ...(values["expected-version"] ? { expectedVersion: values["expected-version"] } : {}),
    },
  });
  let closing = false;
  const stop = () => {
    if (!closing) {
      closing = true;
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  await app.server.connect(new StdioServerTransport());
}

void main().catch(() => {
  process.stderr.write(
    "DRYAS MCP could not start. Check its arguments and project configuration.\n",
  );
  process.exitCode = 1;
});
