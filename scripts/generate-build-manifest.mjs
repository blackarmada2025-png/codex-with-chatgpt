import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const outputDir = path.join(root, "artifacts");
const output = path.join(outputDir, "build-manifest.json");
const testResultArg = process.argv.find((arg) => arg.startsWith("--test-result="));
const testResult = testResultArg?.slice("--test-result=".length) ?? "NOT_RUN";

function hash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

if (!fs.existsSync(dist)) throw new Error("dist is missing; run the build first");
const relativeFiles = files(dist).sort().map((file) => ({
  path: path.relative(root, file).replaceAll("\\", "/"),
  sha256: hash(file),
}));
const productionCriticalFiles = [
  "ops/cutover/c2c-production-cutover.ps1",
  "ops/watchdog/c2c-production-watchdog.ps1",
  "ops/watchdog/c2c-production-watchdog.config.example.json",
  "scripts/install-production-watchdog.ps1",
  "scripts/generate-build-manifest.mjs",
].map((relative) => {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`production-critical file is missing: ${relative}`);
  return { path: relative, sha256: hash(file) };
});
const releaseCriticalFiles = [
  "ops/cutover/c2c-production-cutover.ps1",
  "ops/watchdog/c2c-production-watchdog.ps1",
  "ops/watchdog/c2c-production-watchdog.config.example.json",
  "scripts/install-production-watchdog.ps1",
  "scripts/generate-build-manifest.mjs",
  "tests/cutover-isolated-integration.test.ts",
  "tests/scheduled-task-control-plane.probe.ps1",
].map((relative) => {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`release-critical file is missing: ${relative}`);
  return { path: relative, sha256: hash(file) };
});
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const lockfile = path.join(root, "pnpm-lock.yaml");
const manifest = {
  sourceRemote: git("remote", "get-url", "origin"),
  sourceBranch: git("branch", "--show-current") || "DETACHED",
  sourceCommit: git("rev-parse", "HEAD"),
  nodeVersion: process.version,
  packageLockHash: hash(lockfile),
  buildCommand: "pnpm run build",
  buildTimestamp: new Date().toISOString(),
  distFileCount: relativeFiles.length,
  distSha256Manifest: relativeFiles,
  productionCriticalSha256Manifest: productionCriticalFiles,
  releaseCriticalSha256Manifest: releaseCriticalFiles,
  testResult,
  deploymentTarget: "UNSET — this reconstruction is not production",
  historicalR3SourceCommit: "UNKNOWN",
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(output);
