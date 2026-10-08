// SPDX-License-Identifier: Apache-2.0
import { build, context } from "esbuild";
import { mkdir, copyFile, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDebugEnvironment } from "./config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await writeDebugEnvironment();
const jobs = [
  ["packages/engine-adapter/src/index.ts", "packages/engine-adapter/dist/index.js", "esm"],
  ["packages/mcp-server/src/server.ts", "packages/mcp-server/dist/server.js", "esm"],
  ["packages/mcp-server/src/cli.ts", "packages/mcp-server/dist/cli.cjs", "cjs"],
  ["packages/extension/src/extension.ts", "packages/extension/dist/extension.cjs", "cjs"],
  ["test/host/index.ts", "test/host/dist/index.cjs", "cjs"],
];
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  metafile: true,
  alias: { "@dryas/engine-adapter": resolve(root, "packages/engine-adapter/src/index.ts") },
  logLevel: "warning",
};
const watch = process.argv.includes("--watch");
const results = [];
for (const [entry, outfile, format] of jobs) {
  const plugins = entry.endsWith("/cli.ts")
    ? [
        {
          name: "sync-mcp-bundle",
          setup(builder) {
            builder.onEnd(async (result) => {
              if (!result.errors.length) {
                await mkdir(join(root, "packages/extension/dist"), { recursive: true });
                await copyFile(join(root, outfile), join(root, "packages/extension/dist/mcp.cjs"));
              }
            });
          },
        },
      ]
    : [];
  const options = {
    ...common,
    plugins,
    entryPoints: [entry],
    outfile,
    format,
    ...(format === "esm"
      ? {
          banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
          },
        }
      : {}),
  };
  results.push(await build(options));
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  }
}
await copyFile(
  join(root, "packages/mcp-server/dist/cli.cjs"),
  join(root, "packages/extension/dist/mcp.cjs"),
);
await copyFile(join(root, "LICENSE"), join(root, "packages/extension/LICENSE"));

const packages = new Set();
for (const result of results.slice(0, -1))
  for (const input of Object.keys(result.metafile.inputs)) {
    const parts = input.split("/");
    const offset = parts.lastIndexOf("node_modules");
    if (offset < 0) continue;
    const end = offset + (parts[offset + 1].startsWith("@") ? 3 : 2);
    packages.add(parts.slice(0, end).join("/"));
  }
let notices =
  "# Third-party notices\n\nGenerated from dependencies included in the extension and MCP bundles.\nOpenSysML is configured as an external executable and is not included in this VSIX.\n\n";
const seen = new Map();
for (const path of [...packages].sort()) {
  const folder = join(root, path);
  const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  const files = (await readdir(folder)).filter((f) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(f),
  );
  if (!files.length) throw new Error(`Bundled dependency has no license text: ${pkg.name}`);
  let body = "";
  for (const file of files.sort())
    body += `### ${file}\n\n~~~text\n${(await readFile(join(folder, file), "utf8")).trim()}\n~~~\n\n`;
  const identity = `${pkg.name}@${pkg.version}`;
  if (seen.has(identity)) {
    if (seen.get(identity) !== body)
      throw new Error(`Conflicting bundled license copies: ${identity}`);
    continue;
  }
  seen.set(identity, body);
  notices += `## ${pkg.name} ${pkg.version}\n\nLicense: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)}\n\n${body}`;
}
await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), notices.trimEnd() + "\n");
await copyFile(
  join(root, "THIRD_PARTY_NOTICES.md"),
  join(root, "packages/extension/THIRD_PARTY_NOTICES.md"),
);
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(
  join(root, "artifacts/build-meta.json"),
  JSON.stringify(
    results.map((r) => r.metafile),
    null,
    2,
  ),
);
console.log(
  watch
    ? "DRYAS builds ready; watching source files."
    : "Built adapter, MCP server, extension and host tests; refreshed bundled notices.",
);
