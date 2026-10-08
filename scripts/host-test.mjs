// SPDX-License-Identifier: Apache-2.0
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { spawn, execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { root, loadConfig } from "./config.mjs";

const config = await loadConfig();
const host = process.argv.includes("--cursor") ? "cursor" : "vscode";
const executable =
  config.editors[host] ||
  (host === "vscode" ? await downloadAndUnzipVSCode(config.tests.vscodeVersion) : "");
if (!executable)
  throw new Error("Set editors.cursor in ignored config.js before running Cursor host tests.");
await mkdir(resolve(root, ".tmp"), { recursive: true });
const workspace = await mkdtemp(resolve(root, ".tmp/host-test-"));
await cp(resolve(root, "test/fixtures/hello-system"), resolve(workspace, "project"), {
  recursive: true,
});
const env = {
  ...process.env,
};
// Exercise the same User Settings path as a manually installed VSIX, without
// development environment variables silently fixing a missing setting.
delete env.DRYAS_LSP_PATH;
delete env.DRYAS_API_PATH;
await mkdir(resolve(workspace, "profile/User"), { recursive: true });
await writeFile(
  resolve(workspace, "profile/User/settings.json"),
  JSON.stringify({
    "dryas.lspPath": config.engine.lspPath,
    "dryas.apiPath": config.engine.apiPath,
  }),
);
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
delete env.VSCODE_DEV;
let extensionPath = resolve(root, "packages/extension");
if (process.argv.includes("--vsix")) {
  const { version } = JSON.parse(
    await readFile(resolve(root, "packages/extension/package.json"), "utf8"),
  );
  const installation = dirname(executable);
  let cli = resolve(
    installation,
    process.platform === "darwin" ? "../Resources/app/out/cli.js" : "resources/app/out/cli.js",
  );
  try {
    await access(cli);
  } catch {
    const candidates = [];
    for (const entry of await readdir(installation, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(installation, entry.name, "resources/app/out/cli.js");
      try {
        await access(candidate);
        candidates.push(candidate);
      } catch {
        /* Not an editor application directory. */
      }
    }
    if (candidates.length !== 1)
      throw new Error("Cannot identify the editor installation's CLI entry point.");
    cli = candidates[0];
  }
  try {
    execFileSync(
      executable,
      [
        cli,
        "--install-extension",
        resolve(root, `artifacts/dryas-systrace-${version}.vsix`),
        "--force",
        "--user-data-dir",
        resolve(workspace, "profile"),
        "--extensions-dir",
        resolve(workspace, "extensions"),
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: "pipe",
        timeout: 60000,
      },
    );
  } catch (error) {
    await writeFile(
      resolve(workspace, "install.log"),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw new Error("Cannot install the VSIX into the isolated test profile.");
  }
  const installed = (await readdir(resolve(workspace, "extensions"))).find((name) =>
    name.startsWith(`dryas-labs.systrace-${version}`),
  );
  if (!installed) throw new Error("The packaged extension was not installed in the test profile.");
  extensionPath = resolve(workspace, "extensions", installed);
}
const args = [
  resolve(workspace, "project"),
  "--new-window",
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-updates",
  "--disable-telemetry",
  "--disable-gpu",
  "--no-sandbox",
  `--user-data-dir=${resolve(workspace, "profile")}`,
  `--extensions-dir=${resolve(workspace, "extensions")}`,
  `--extensionDevelopmentPath=${extensionPath}`,
  `--extensionTestsPath=${resolve(root, "test/host/dist/index.cjs")}`,
];
let output = "";
const code = await new Promise((done, reject) => {
  const child = spawn(executable, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => {
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        /* Process may already have exited. */
      }
    } else child.kill("SIGKILL");
    reject(new Error("The isolated extension host exceeded its deadline."));
  }, 120000);
  child.once("error", () => {
    clearTimeout(timer);
    reject(new Error("Cannot start the configured extension host."));
  });
  child.once("exit", (value) => {
    clearTimeout(timer);
    done(value);
  });
});
await writeFile(resolve(workspace, "host.log"), output);
if (code !== 0 || !output.includes("DRYAS host checks passed:"))
  throw new Error("Host checks failed. Inspect the ignored .tmp host-test log.");
console.log(
  `${host}: ${process.argv.includes("--vsix") ? "VSIX installation and " : ""}activation, language features and saved validation passed in an isolated extension host.`,
);
