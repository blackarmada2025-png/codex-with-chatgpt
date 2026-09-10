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
const fixtureTasks = new Set<string>();

afterEach(() => {
  for (const task of fixtureTasks) {
    spawnSync("schtasks.exe", ["/End", "/TN", `\\${task}`], { windowsHide: true, timeout: 10_000 });
    spawnSync("schtasks.exe", ["/Delete", "/TN", `\\${task}`, "/F"], { windowsHide: true, timeout: 10_000 });
  }
  fixtureTasks.clear();
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

function ps(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

function runPowerShell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

function registerIsolatedWatchdog(taskName: string, runtimeScript: string, runtimeConfig: string) {
  const argumentsValue = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${runtimeScript}\" -ConfigPath \"${runtimeConfig}\" -IsolatedTestMode`;
  let result: ReturnType<typeof runPowerShell> | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = runPowerShell(`$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(argumentsValue)}; Register-ScheduledTask -TaskName ${ps(taskName)} -Action $action -Force | Out-Null; Start-ScheduledTask -TaskName ${ps(taskName)}`);
    if (result.status === 0) break;
    spawnSync("schtasks.exe", ["/Delete", "/TN", `\\${taskName}`, "/F"], { windowsHide: true, timeout: 10_000 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1));
  }
  expect(result?.status, result?.stderr).toBe(0);
  fixtureTasks.add(taskName);
}

function watchdogPid(runtimeScript: string, runtimeConfig: string): number {
  const result = runPowerShell(`$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(?i:powershell|pwsh)\\.exe$' -and $_.CommandLine -like '*${runtimeScript.replace(/'/g, "''")}*' -and $_.CommandLine -like '*${runtimeConfig.replace(/'/g, "''")}*' } | Select-Object -First 1 -ExpandProperty ProcessId; $p`);
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

async function waitForWatchdog(runtimeScript: string, runtimeConfig: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pid = watchdogPid(runtimeScript, runtimeConfig);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("isolated scheduled watchdog did not start");
}

function run(args: string[]) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cutover, ...args], { stdio: "ignore", timeout: 120_000, windowsHide: true });
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
  const runtimeScript = path.join(runtime, "orbnexa-vault-c2c-prod-watchdog.ps1");
  const runtimeConfig = path.join(runtime, "c2c-production-watchdog.config.json");
  const taskName = `C2C-Isolated-Watchdog-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerIsolatedWatchdog(taskName, runtimeScript, runtimeConfig);
  const initialWatchdogPid = await waitForWatchdog(runtimeScript, runtimeConfig);
  return { auth, oldCli, oldPid: oldRuntime.pid, port, runtime, runtimeConfig, runtimeFile, runtimeScript, state, workspace: workspaceRoot, workspaceId: start.workspaceId, taskName, initialWatchdogPid };
}

function args(f: Awaited<ReturnType<typeof fixture>>, simulate = false) {
  return ["-CandidateCli", candidateCli, "-OldGatewayCli", f.oldCli, "-C2CStateDir", f.state, "-Workspace", f.workspace, "-WorkspaceId", f.workspaceId, "-Port", String(f.port), "-WatchdogRuntimeDirectory", f.runtime, "-ScheduledTaskName", `\\${f.taskName}`, "-IsolatedTestMode", ...(simulate ? ["-SimulatePublicNetwork"] : [])];
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
    expect(isAlive(f.initialWatchdogPid)).toBe(false);
    const adoptedWatchdogPid = await waitForWatchdog(f.runtimeScript, f.runtimeConfig);
    expect(adoptedWatchdogPid).not.toBe(f.initialWatchdogPid);
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
    const restoredWatchdogPid = await waitForWatchdog(f.runtimeScript, f.runtimeConfig);
    expect(restoredWatchdogPid).not.toBe(f.initialWatchdogPid);
    expect((await fetch(`http://127.0.0.1:${f.port}/health`)).ok).toBe(true);
    expect(fs.readFileSync(f.auth, "utf8")).toBe(before);
    const restoredConfig = JSON.parse(fs.readFileSync(f.runtimeConfig, "utf8").replace(/^\uFEFF/, ""));
    expect(restoredConfig.gatewayCli).toBe(f.oldCli);
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
