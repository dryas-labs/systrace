// SPDX-License-Identifier: Apache-2.0
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

// Parse JSONC without evaluating editor settings as JavaScript.
function parseJsonc(text) {
  let clean = "",
    quoted = false,
    escaped = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      clean += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= text.length) throw new Error("Unterminated JSONC comment");
      i++;
      clean += " ";
    } else clean += c;
  }
  let result = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (!quoted && c === "," && /^[\s]*[}\]]/.test(clean.slice(i + 1))) continue;
    result += c;
    if (escaped) escaped = false;
    else if (quoted && c === "\\") escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return JSON.parse(result);
}

function expand(value, env, home) {
  return value
    .replace(/^~(?=[/\\]|$)/, home)
    .replace(/\$\{env:([^}]+)\}|%([^%]+)%/g, (match, a, b) => env[a || b] ?? match);
}

function executable(value, env, home, platform) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Engine path must be a nonempty string");
  value = expand(value.trim(), env, home);
  const suffixes = platform === "win32" ? ["", ".exe"] : [""];
  const roots =
    path.isAbsolute(value) || /[/\\]/.test(value)
      ? [path.resolve(value)]
      : (env.PATH || env.Path || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir.replace(/^"|"$/g, ""), value));
  for (const root of roots)
    for (const suffix of suffixes) {
      try {
        const file = root + suffix;
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return file;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  throw new Error(`Executable is not accessible in this agent environment: ${value}`);
}

function settingsFiles(env, home, platform) {
  const root =
    platform === "win32"
      ? env.APPDATA
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return root
    ? ["Code", "Code - Insiders", "Cursor", "VSCodium"].map((name) =>
        path.join(root, name, "User", "settings.json"),
      )
    : [];
}

function resolveEngine(options = {}) {
  const env = options.env || process.env,
    home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const skillRoot = options.skillRoot || path.join(__dirname, "..");
  const configFile = options.configFile || path.join(skillRoot, "engine.local.json");
  const checked = [],
    issues = [];
  const select = (value, source) => ({
    executable: executable(value, env, home, platform),
    source,
    checked,
    issues,
  });
  if (options.lsp) return select(options.lsp, "--lsp");
  if (env.SYSML_LSP_PATH) return select(env.SYSML_LSP_PATH, "SYSML_LSP_PATH");
  let config = {};
  if (fs.existsSync(configFile)) {
    config = parseJsonc(fs.readFileSync(configFile, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error(`Invalid config: ${configFile}`);
  }
  // An explicitly selected settings file overrides the remembered discovery source.
  if (!options.vscodeSettings && config.lspPath) return select(config.lspPath, configFile);
  const requestedSettings =
    options.vscodeSettings || env.SYSML_VSCODE_SETTINGS || config.vscodeSettings;
  const files = requestedSettings
    ? [path.resolve(expand(requestedSettings, env, home))]
    : settingsFiles(env, home, platform);
  // Both layouts are fixed package-relative locations, never an installation scan.
  if (!requestedSettings) {
    const target = `${platform}-${options.arch || process.arch}`;
    const name = "sysml-lsp" + (platform === "win32" ? ".exe" : "");
    const bundled = [
      path.join(skillRoot, "runtime", target, name),
      path.resolve(skillRoot, "..", "..", "runtime", target, name),
    ];
    for (const file of bundled) {
      if (!fs.existsSync(file)) continue;
      const result = select(file, "bundled");
      result.relativeExecutable = path
        .relative(skillRoot, result.executable)
        .split(path.sep)
        .join("/");
      return result;
    }
  }
  const candidates = [];
  for (const file of files) {
    checked.push(file);
    try {
      if (!fs.existsSync(file)) {
        if (requestedSettings) throw new Error(`Settings file does not exist: ${file}`);
        continue;
      }
      const settings = parseJsonc(fs.readFileSync(file, "utf8"));
      const value = settings["dryas.lspPath"];
      if (value) candidates.push(select(value, `${file}: dryas.lspPath`));
      else if (requestedSettings) throw new Error(`dryas.lspPath is not set in ${file}`);
    } catch (error) {
      if (requestedSettings) throw error;
      issues.push(`${file}: ${error.message}`);
    }
  }
  const unique = new Map(
    candidates.map((item) => [
      platform === "win32" ? item.executable.toLowerCase() : item.executable,
      item,
    ]),
  );
  if (unique.size > 1)
    throw new Error(
      `Multiple editor engine paths found. Select --vscode-settings <settings.json> or --lsp <executable>. Sources: ${candidates.map((c) => c.source).join("; ")}`,
    );
  if (unique.size === 1) return unique.values().next().value;
  try {
    return select("sysml-lsp", "PATH");
  } catch {
    throw new Error(
      `ENGINE_NOT_FOUND: Set --lsp <executable>, SYSML_LSP_PATH, or run --configure-lsp <executable> once. For profiles, portable or remote editors, use --vscode-settings <settings.json> or --configure-vscode-settings <settings.json>. The engine must be accessible in this agent environment. Checked: ${checked.join("; ")}. ${issues.join("; ")}`,
    );
  }
}

function main(args) {
  const extra = {},
    forwarded = [];
  const custom = new Set(["--vscode-settings", "--configure-lsp", "--configure-vscode-settings"]);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (flag === "--engine-context") {
      extra.context = true;
      continue;
    }
    if (custom.has(flag) || flag === "--lsp") {
      const value = inline === undefined ? args[++i] : inline;
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      extra[flag] = value;
    } else forwarded.push(args[i]);
  }
  const configFile = path.join(__dirname, "..", "engine.local.json");
  if (extra["--configure-lsp"] && extra["--configure-vscode-settings"])
    throw new Error("Choose one configuration source");
  if (extra["--configure-lsp"] || extra["--configure-vscode-settings"]) {
    const config = extra["--configure-lsp"]
      ? { lspPath: resolveEngine({ lsp: extra["--configure-lsp"] }).executable }
      : {
          vscodeSettings: path.resolve(
            expand(extra["--configure-vscode-settings"], process.env, os.homedir()),
          ),
        };
    if (config.vscodeSettings)
      resolveEngine({
        vscodeSettings: config.vscodeSettings,
        env: { ...process.env, SYSML_LSP_PATH: "" },
      });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ configured: configFile, ...config }) + "\n");
    return;
  }
  // Project context/help do not need the engine at all.
  const bypass =
    !extra.context && forwarded.some((arg) => ["--context", "--help", "-h"].includes(arg));
  if (forwarded.some((arg) => ["--help", "-h"].includes(arg))) {
    process.stdout.write(
      "Skill launcher options:\n  --engine-context                         Show engine discovery without launching LSP\n  --vscode-settings <settings.json>         Select editor/profile settings for this run\n  --configure-lsp <executable>              Remember an accessible engine path\n  --configure-vscode-settings <settings.json> Remember editor/profile settings\nEnvironment: SYSML_LSP_PATH, SYSML_VSCODE_SETTINGS\nDiscovery: --lsp > SYSML_LSP_PATH > explicit/local configuration > bundled runtime > editor user settings > PATH\nAll diagnostic options below are forwarded.\n\n",
    );
  }
  if (!bypass) {
    const engine = resolveEngine({
      lsp: extra["--lsp"],
      vscodeSettings: extra["--vscode-settings"],
    });
    if (extra.context) {
      process.stdout.write(
        JSON.stringify(
          { ...engine, executable: engine.relativeExecutable || engine.executable },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    forwarded.push("--lsp", engine.executable);
    process.stderr.write(
      `Engine: ${engine.source === "bundled" ? "bundled runtime" : "configured language engine"}\n`,
    );
  }
  const child = spawn(process.execPath, [path.join(__dirname, "diagnostics.cjs"), ...forwarded], {
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

module.exports = { parseJsonc, resolveEngine, main };
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
