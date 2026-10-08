// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./config.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const rules = [
  ["absolute host path", /(?:^|[\s"'(])[A-Za-z]:[\\/]|\/(?:Users|home)\/[^/\s"']+/m],
  ["time zone", /\b(?:Asia|America|Europe|Africa|Australia|Pacific)\/[A-Za-z_]+/],
  [
    "credential pattern",
    /(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/,
  ],
];
const identifiers = [process.env.USERNAME, process.env.COMPUTERNAME];
try {
  identifiers.push(
    execFileSync("git", ["config", "user.name"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
} catch {
  /* A CI checkout may not have an author configured. */
}
const genericNames = new Set([
  "root",
  "user",
  "admin",
  "runner",
  "runneradmin",
  "developer",
  "test",
]);
for (const value of identifiers)
  if (value && value.length >= 4 && !genericNames.has(value.toLowerCase()))
    rules.push([
      "host identifier",
      new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    ]);
const findings = [];
for (const file of files) {
  if (
    /^(selection|designs|artifacts|\.tmp|\.vscode-test|\.engine-ci)\//.test(file) ||
    file === "config.js" ||
    (/^\.env(\.|$)/.test(file) && file !== ".env.example")
  ) {
    findings.push(`${file}: local-only file is tracked`);
    continue;
  }
  const data = await readFile(resolve(root, file));
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  for (const [label, pattern] of rules) if (pattern.test(text)) findings.push(`${file}: ${label}`);
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Source-content checks passed; local configuration and evaluation archives remain excluded.",
  );
