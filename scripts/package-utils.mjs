// SPDX-License-Identifier: Apache-2.0
import { createWriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import yauzl from "yauzl";

export async function filesUnder(root) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Package inputs cannot contain symbolic links.");
      const file = join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  await visit(root);
  return files.sort();
}

export function assertPublicData(data, name, root) {
  const generic = new Set(["root", "user", "admin", "runner", "runneradmin", "developer", "test"]);
  const username = process.env.USERNAME || process.env.USER || "";
  const paths = [root, ...(!generic.has(username.toLowerCase()) ? [homedir()] : [])];
  for (let parent = root; parent && dirname(parent) !== parent; parent = dirname(parent))
    if (["workspace", "workspaces"].includes(basename(parent).toLowerCase())) paths.push(parent);
  const utf8 = data.toString("utf8").toLowerCase();
  const utf16 = data.includes(0) ? data.toString("utf16le").toLowerCase() : "";
  for (const value of paths) {
    if (!value) continue;
    const variants = [value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")];
    if (
      variants.some(
        (part) => utf8.includes(part.toLowerCase()) || utf16.includes(part.toLowerCase()),
      )
    )
      throw new Error(`Private host information found in package entry: ${name}`);
  }
  for (const value of [username, process.env.COMPUTERNAME]) {
    if (!value || value.length < 4 || generic.has(value.toLowerCase())) continue;
    const pattern = new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(utf8) || pattern.test(utf16))
      throw new Error(`Private host identifier found in package entry: ${name}`);
  }
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    );
  });
}
async function entryBytes(zip, entry) {
  const stream = await new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, value) => (error ? reject(error) : resolve(value)));
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
export async function archiveEntry(file, wanted) {
  const zip = await openZip(await readFile(file));
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => reject(new Error(`Required source archive entry is missing: ${wanted}`)));
    zip.on("entry", async (entry) => {
      try {
        if (entry.fileName === wanted) {
          const data = await entryBytes(zip, entry);
          const comment = zip.comment;
          zip.close();
          resolve({ data, comment });
        } else zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
}
export async function auditArchive(file, root) {
  async function audit(buffer, prefix) {
    const zip = await openZip(buffer);
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", async (entry) => {
        try {
          const name = entry.fileName;
          if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."))
            throw new Error("An archive contains a non-relative entry path.");
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (/(^|\/)engine\.local\.json$/.test(name))
            throw new Error("Local engine configuration cannot be distributed.");
          const data = await entryBytes(zip, entry);
          assertPublicData(data, prefix + name, root);
          if (name.endsWith(".zip")) await audit(data, prefix + name + ":");
          zip.readEntry();
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  }
  await audit(await readFile(file), "");
}
export async function writeArchive(file, entries) {
  const zip = new yazl.ZipFile();
  const result = pipeline(zip.outputStream, createWriteStream(file));
  for (const { source, name, executable = false } of entries)
    zip.addFile(source, name, {
      mode: executable ? 0o100755 : 0o100644,
      mtime: new Date("2000-01-01T00:00:00Z"),
    });
  zip.end();
  await result;
}
export function archiveName(root, file) {
  return relative(root, file).split(sep).join("/");
}
