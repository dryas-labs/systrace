// SPDX-License-Identifier: Apache-2.0
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "../config.example.js";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig() {
  const file = resolve(root, "config.js");
  let local = {};
  try {
    await access(file);
    local = (await import(pathToFileURL(file).href)).default;
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Cannot load config.js. Check the local configuration syntax.");
  }
  if (!local || typeof local !== "object")
    throw new Error("config.js must export a configuration object.");
  return {
    engine: { ...defaults.engine, ...local.engine },
    editors: { ...defaults.editors, ...local.editors },
    tests: { ...defaults.tests, ...local.tests },
  };
}

export async function writeDebugEnvironment() {
  const config = await loadConfig();
  const lines = Object.entries({
    DRYAS_LSP_PATH: config.engine.lspPath,
    DRYAS_API_PATH: config.engine.apiPath,
  }).map(([key, value]) => {
    if (typeof value !== "string" || /[\r\n\0]/.test(value))
      throw new Error("Invalid executable setting in config.js.");
    return `${key}=${JSON.stringify(value.replaceAll("\\", "/"))}`;
  });
  await mkdir(resolve(root, ".tmp"), { recursive: true });
  await writeFile(resolve(root, ".tmp/development.env"), lines.join("\n") + "\n");
}

if (process.argv.includes("--init")) {
  try {
    await copyFile(
      resolve(root, "config.example.js"),
      resolve(root, "config.js"),
      constants.COPYFILE_EXCL,
    );
    console.log("Created ignored config.js. Set your local engine and editor paths there.");
  } catch (error) {
    if (error.code === "EEXIST") console.log("config.js already exists; left unchanged.");
    else throw error;
  }
}
