import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const nodeVersion = "v24.19.0";
const archiveName = `node-${nodeVersion}-win-x64.zip`;
const origin = `https://nodejs.org/dist/${nodeVersion}/`;
const root = import.meta.dirname;
const bundle = join(root, ".bundle");
const runtime = join(bundle, "runtime");
const extracted = join(bundle, archiveName.slice(0, -4));
const archive = join(bundle, archiveName);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The rbxport Agent installer is built on Windows x64.");
}

await stat(join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
await mkdir(runtime, { recursive: true });

async function download(name) {
  const response = await fetch(new URL(name, origin), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node.js download failed for ${name} (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

const checksums = (await download("SHASUMS256.txt")).toString("utf8");
const expected = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === archiveName)?.[0];
if (!expected) throw new Error(`Missing official checksum for ${archiveName}.`);
let bytes = await readFile(archive).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
  bytes = await download(archiveName);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Checksum failed for ${archiveName}.`);
  }
  await writeFile(archive, bytes);
}

const extraction = spawnSync("tar.exe", ["-xf", archive, "-C", bundle], { stdio: "inherit" });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error("Could not extract the Node.js sidecar.");
await copyFile(join(extracted, "node.exe"), join(bundle, "rbxport-agent-node-x86_64-pc-windows-msvc.exe"));
await copyFile(join(extracted, "LICENSE"), join(runtime, "NODE-LICENSE"));

for (const name of ["package.json", "package-lock.json", "rbxport.patch.yml", "responses.ts", "library-tools.ts"]) {
  await copyFile(join(root, name), join(runtime, name));
}
const dependencies = join(runtime, "node_modules");
const installed = await realpath(dependencies).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (installed) {
  const allowed = join(await realpath(root), ".bundle", "runtime", "node_modules");
  if (installed.toLowerCase() !== allowed.toLowerCase()) throw new Error("Unexpected staged dependency directory.");
  await rm(dependencies, { recursive: true, force: true });
}
await cp(join(root, "node_modules"), dependencies, { recursive: true });
