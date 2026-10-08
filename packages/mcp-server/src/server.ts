// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ProjectSession,
  publicError,
  findInputSchema,
  describeInputSchema,
  libraryInputSchema,
  type ProjectOptions,
} from "@dryas/engine-adapter";

export function createServer(options: ProjectOptions) {
  const session = new ProjectSession(options);
  const server = new McpServer({ name: "dryas-systrace", version: "0.1.0" });
  server.registerTool(
    "validate",
    {
      title: "Validate saved SysML project",
      description:
        "Validate every saved SysML/KerML source in the configured project folders. Paths filter listed diagnostics, not validation. No files are changed. Incomplete means validation coverage is not certified, even with no diagnostics. This is not proof of engineering correctness.",
      inputSchema: {
        paths: z.array(z.string()).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      try {
        const options: { paths?: string[]; cursor?: string; limit?: number } = {};
        if (input.paths) options.paths = input.paths;
        if (input.cursor) options.cursor = input.cursor;
        if (input.limit !== undefined) options.limit = input.limit;
        const result = await session.validate(options, extra.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(publicError(error)) }],
        };
      }
    },
  );
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const respond = async (operation: () => Promise<unknown>) => {
    try {
      const result = await operation();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: { ...(result as Record<string, unknown>) },
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(publicError(error)) }],
      };
    }
  };
  server.registerTool(
    "find_element",
    {
      title: "Find saved model elements",
      description:
        "Search the saved project by exact name, qualified name, native metamodel kind, scope, transitive specialization or metadata values. Names, inheritance and metadata are resolved by OpenSysML. All metadata predicates must match one annotation. Cursors are bound to a session, query and saved revision. Results may include diagnostics from an invalid model and do not certify engineering correctness.",
      inputSchema: findInputSchema,
      annotations,
    },
    (input, extra) => respond(() => session.findElement(input, extra.signal)),
  );
  server.registerTool(
    "describe_element",
    {
      title: "Describe a saved model element",
      description:
        "Read an exact native qualified name, resolved typing, declared and implicit generalizations, effective features with declaring owners, metadata and contained satisfy/connection relationships. includeInherited defaults to true. Connection endpoints unavailable in this API remain null and are explicitly reported as a limitation. This does not inspect unsaved editor buffers.",
      inputSchema: describeInputSchema,
      annotations,
    },
    (input, extra) => respond(() => session.describeElement(input, extra.signal)),
  );
  server.registerTool(
    "library_lookup",
    {
      title: "Look up the bundled standard library",
      description:
        "Use an exact qualifiedName (including re-exported names such as ISQ::voltage), or browse a namespace with optional exact name/kind filters. Uses an isolated bundled-library model, so project declarations cannot shadow results. Namespace browsing lists declarations rather than re-exported members. The engine's library version is not independently certified.",
      inputSchema: libraryInputSchema,
      annotations,
    },
    (input, extra) => respond(() => session.libraryLookup(input, extra.signal)),
  );
  server.server.onclose = () => session.close();
  return {
    server,
    close: async () => {
      session.close();
      await server.close();
    },
  };
}
