import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateCli = path.join(root, "dist", "cli", "index.js");
const cutover = path.join(root, "ops", "cutover", "c2c-production-cutover.ps1");
const watchdog = path.join(root, "ops", "watchdog", "c2c-production-watchdog.ps1");
const template = path.join(root, "ops", "watchdog", "c2c-production-watchdog.config.example.json");
const fixtures: string[] = [];
const fixturePids = new Set<number>();

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    const runtimeDir = path.join(dir, "state", "runtime");
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir)) {
        try { fixturePids.add(JSON.parse(fs.readFileSync(path.join(runtimeDir, entry), "utf8")).pid); } catch { /* ignore malformed fixture state */ }
      }
    }
    for (const pid of fixturePids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* process already exited */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fixturePids.clear();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function run(args: string[]) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cutover, ...args], { stdio: "ignore", timeout: 60_000, windowsHide: true });
}

async function fixture(hostname = "127.0.0.1:1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-cutover-real-"));
  fixtures.push(dir);
  const state = path.join(dir, "state");
  const workspace = path.join(dir, "workspace");
  const runtime = path.join(dir, "watchdog");
  const oldDist = path.join(dir, "old-dist");
  const oldCli = path.join(oldDist, "cli", "index.js");
  const port = await freePort();
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "note.txt"), "isolated fixture");
  const workspaceRoot = fs.realpathSync.native(workspace);
  fs.cpSync(path.join(root, "dist"), oldDist, { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  const started = spawnSync(process.execPath, [oldCli, "start", "--workspace", workspaceRoot, "--port", String(port), "--json"], { encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: state } });
  expect(started.status, started.stderr).toBe(0);
  const start = JSON.parse(started.stdout) as { workspaceId: string };
  const runtimeFile = path.join(state, "runtime", `${start.workspaceId}.json`);
  const oldRuntime = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as { pid: number };
  fixturePids.add(oldRuntime.pid);
  const auth = path.join(state, "auth", `${start.workspaceId}.json`);
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  fs.writeFileSync(auth, JSON.stringify({ clients: [{ clientId: "fixture" }], tokens: [{ hash: "fixture", revoked: false }] }));
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(watchdog, path.join(runtime, "orbnexa-vault-c2c-prod-watchdog.ps1"));
  const config = JSON.parse(fs.readFileSync(template, "utf8"));
  Object.assign(config, { workspace: workspaceRoot, workspaceId: start.workspaceId, requiredPort: port, gatewayCli: oldCli, c2cStateDir: state, runtimePath: runtimeFile, hostname });
  fs.writeFileSync(path.join(runtime, "c2c-production-watchdog.config.json"), JSON.stringify(config));
  return { auth, oldCli, oldPid: oldRuntime.pid, port, runtime, runtimeFile, state, workspace: workspaceRoot, workspaceId: start.workspaceId };
}

function args(f: Awaited<ReturnType<typeof fixture>>, simulate = false) {
  return ["-CandidateCli", candidateCli, "-OldGatewayCli", f.oldCli, "-C2CStateDir", f.state, "-Workspace", f.workspace, "-WorkspaceId", f.workspaceId, "-Port", String(f.port), "-WatchdogRuntimeDirectory", f.runtime, "-IsolatedTestMode", ...(simulate ? ["-SimulatePublicNetwork"] : [])];
}

describe("isolated production cutover execution path", () => {
  it("performs the complete handoff against only isolated resources", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.auth, "utf8");
    const result = run(args(f, true));
    expect(result.status).toBe(0);
    expect(isAlive(f.oldPid)).toBe(false);
    const identity = JSON.parse(fs.readFileSync(f.runtimeFile, "utf8")) as { pid: number; port: number; workspaceId: string; workspaceRoot: string };
    expect(identity).toMatchObject({ port: f.port, workspaceId: f.workspaceId, workspaceRoot: f.workspace });
    expect(identity.pid).not.toBe(f.oldPid);
    expect(isAlive(identity.pid)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${f.port}/health`)).ok).toBe(true);
    expect(fs.readFileSync(f.auth, "utf8")).toBe(before);
    const installed = JSON.parse(fs.readFileSync(path.join(f.runtime, "c2c-production-watchdog.config.json"), "utf8").replace(/^\uFEFF/, ""));
    expect(installed).toMatchObject({ gatewayCli: candidateCli, c2cStateDir: f.state, workspaceId: f.workspaceId, requiredPort: f.port, hostname: "127.0.0.1:1" });
  }, 90_000);

  it("stops the candidate, releases the port, and restores the old fixture after a simulated public failure", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.auth, "utf8");
    const result = run(args(f));
    expect(result.status).toBe(0);
    const restored = JSON.parse(fs.readFileSync(f.runtimeFile, "utf8")) as { pid: number; port: number; workspaceId: string };
    expect(restored).toMatchObject({ port: f.port, workspaceId: f.workspaceId });
    expect(restored.pid).not.toBe(f.oldPid);
    expect(isAlive(f.oldPid)).toBe(false);
    expect(isAlive(restored.pid)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${f.port}/health`)).ok).toBe(true);
    expect(fs.readFileSync(f.auth, "utf8")).toBe(before);
  }, 90_000);

  it("has no runtime side effect when isolated preflight fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-cutover-preflight-"));
    fixtures.push(dir);
    const result = run(["-CandidateCli", path.join(dir, "missing.js"), "-OldGatewayCli", path.join(dir, "old.js"), "-C2CStateDir", path.join(dir, "state"), "-Workspace", dir, "-WorkspaceId", "missing", "-Port", "49321", "-WatchdogRuntimeDirectory", path.join(dir, "watchdog"), "-SimulatePublicNetwork"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dir, "state", "runtime", "missing.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "watchdog"))).toBe(false);
  });
});
