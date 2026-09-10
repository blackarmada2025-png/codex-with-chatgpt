import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "ops", "watchdog", "c2c-production-watchdog.ps1");
const cli = path.join(root, "dist", "cli", "index.js");

function resolveContract(gateway: object, tunnel: object) {
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-watchdog-")), "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({ gateway, tunnel }));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ContractTest", "-ContractFixture", fixture], { encoding: "utf8" });
  fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
  return { status: result.status, body: JSON.parse(result.stdout) as { gatewayAction: string; tunnelAction: string; exitCode: number } };
}

const healthyGateway = { portOwner: 101, identityHealthy: true };
const healthyTunnel = { existingCount: 1, identityHealthy: true, publicHealthy: true };

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

describe("production watchdog adoption contract", () => {
  it("starts when the target port and named tunnel are absent", () => {
    const result = resolveContract({ portOwner: null, identityHealthy: false }, { existingCount: 0, identityHealthy: false, publicHealthy: false });
    expect(result).toMatchObject({ status: 0, body: { gatewayAction: "start", tunnelAction: "start", exitCode: 0 } });
  });

  it("adopts a healthy target Gateway without a second start", () => {
    const result = resolveContract(healthyGateway, healthyTunnel);
    expect(result).toMatchObject({ status: 0, body: { gatewayAction: "adopt", tunnelAction: "adopt", exitCode: 0 } });
  });

  it("fails safely for an unrelated process on the target port", () => {
    const result = resolveContract({ portOwner: 999, identityHealthy: false }, healthyTunnel);
    expect(result).toMatchObject({ status: 1, body: { gatewayAction: "fail", exitCode: 1 } });
  });

  it("fails safely for a wrong-deployment Gateway", () => {
    const result = resolveContract({ portOwner: 222, identityHealthy: false }, healthyTunnel);
    expect(result).toMatchObject({ status: 1, body: { gatewayAction: "fail", exitCode: 1 } });
  });

  it("adopts one healthy named tunnel without another cloudflared start", () => {
    const result = resolveContract(healthyGateway, healthyTunnel);
    expect(result.body.tunnelAction).toBe("adopt");
  });

  it("adopts an actual isolated candidate already running on a non-production port", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-watchdog-state-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-watchdog-workspace-"));
    const port = await freePort();
    fs.writeFileSync(path.join(workspace, "note.txt"), "fixture");
    try {
      const start = spawnSync(process.execPath, [cli, "start", "--workspace", workspace, "--port", String(port), "--json"], { encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: state } });
      expect(start.status).toBe(0);
      const started = JSON.parse(start.stdout) as { workspaceId: string; port: number };
      const runtime = JSON.parse(fs.readFileSync(path.join(state, "runtime", `${started.workspaceId}.json`), "utf8")) as { pid: number; port: number };
      expect(runtime.port).toBe(port);
      const result = resolveContract({ portOwner: runtime.pid, identityHealthy: true }, healthyTunnel);
      expect(result).toMatchObject({ status: 0, body: { gatewayAction: "adopt", tunnelAction: "adopt", exitCode: 0 } });
    } finally {
      spawnSync(process.execPath, [cli, "stop", "--workspace", workspace], { encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: state } });
      fs.rmSync(state, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
