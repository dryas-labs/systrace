// SPDX-License-Identifier: Apache-2.0
import { build, context } from "esbuild";
import { mkdir, copyFile, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDebugEnvironment } from "./config.mjs";
import { generateProjectIcons } from "./generate-project-icons.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await writeDebugEnvironment();
await generateProjectIcons();
const jobs = [
  ["packages/engine-adapter/src/index.ts", "packages/engine-adapter/dist/index.js", "esm"],
  [
    "packages/engine-adapter/src/lsp-diagnostics-cli.ts",
    "packages/engine-adapter/dist/lsp-diagnostics.cjs",
    "cjs",
  ],
  ["packages/extension/src/extension.ts", "packages/extension/dist/extension.cjs", "cjs"],
  ["test/host/diagnostics.ts", "test/host/dist/diagnostics.cjs", "cjs"],
  ["test/host/index.ts", "test/host/dist/index.cjs", "cjs"],
  ["test/host/projects.ts", "test/host/dist/projects.cjs", "cjs"],
  ["test/host/references.ts", "test/host/dist/references.cjs", "cjs"],
];
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  metafile: true,
  alias: {
    "@dryas/engine-adapter": resolve(root, "packages/engine-adapter/src/index.ts"),
    "jsonc-parser": resolve(root, "node_modules/jsonc-parser/lib/esm/main.js"),
  },
  logLevel: "warning",
};
const watch = process.argv.includes("--watch");
const results = [];
for (const [entry, outfile, format] of jobs) {
  const plugins = entry.endsWith("/lsp-diagnostics-cli.ts")
    ? [
        {
          name: "sync-diagnostics-bundle",
          setup(builder) {
            builder.onEnd(async (result) => {
              if (!result.errors.length) {
                await mkdir(join(root, "packages/extension/dist"), { recursive: true });
                await copyFile(
                  join(root, outfile),
                  join(root, "packages/extension/dist/lsp-diagnostics.cjs"),
                );
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
  join(root, "packages/engine-adapter/dist/lsp-diagnostics.cjs"),
  join(root, "packages/extension/dist/lsp-diagnostics.cjs"),
);
await copyFile(join(root, "LICENSE"), join(root, "packages/extension/LICENSE"));
const skill = join(root, "packages/extension/skills/sysml-diagnostics");
await mkdir(join(skill, "scripts"), { recursive: true });
await copyFile(join(root, "skills/sysml-diagnostics/SKILL.md"), join(skill, "SKILL.md"));
await copyFile(
  join(root, "packages/engine-adapter/dist/lsp-diagnostics.cjs"),
  join(skill, "scripts/diagnostics.cjs"),
);
await copyFile(
  join(root, "skills/sysml-diagnostics/scripts/run-diagnostics.cjs"),
  join(skill, "scripts/run-diagnostics.cjs"),
);
await copyFile(join(root, "LICENSE"), join(skill, "LICENSE"));

const packages = new Set();
for (const result of results.filter((_result, index) => jobs[index][0].startsWith("packages/")))
  for (const input of Object.keys(result.metafile.inputs)) {
    const parts = input.split("/");
    const offset = parts.lastIndexOf("node_modules");
    if (offset < 0) continue;
    const end = offset + (parts[offset + 1].startsWith("@") ? 3 : 2);
    packages.add(parts.slice(0, end).join("/"));
  }
let notices =
  "# Third-party notices\n\nGenerated from dependencies included in the extension and command bundles.\nNative language-engine, standard-library and Go dependency notices are provided separately in runtime/licenses; corresponding engine source is in runtime/source/source.zip.\n\n";
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
await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(skill, "THIRD_PARTY_NOTICES.md"));
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
    : "Built adapter, LSP diagnostics command, extension and host tests; refreshed bundled notices.",
);
