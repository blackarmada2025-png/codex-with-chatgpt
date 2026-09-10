import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "ops", "watchdog", "c2c-production-watchdog.ps1");

function resolveContract(gateway: object, tunnel: object) {
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-watchdog-")), "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({ gateway, tunnel }));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ContractTest", "-ContractFixture", fixture], { encoding: "utf8" });
  fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
  return { status: result.status, body: JSON.parse(result.stdout) as { gatewayAction: string; tunnelAction: string; exitCode: number } };
}

const healthyGateway = { portOwner: 101, identityHealthy: true };
const healthyTunnel = { existingCount: 1, identityHealthy: true, publicHealthy: true };

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

  it("models the cutover handoff as a successful zero-exit adoption", () => {
    const result = resolveContract(healthyGateway, healthyTunnel);
    expect(result).toMatchObject({ status: 0, body: { gatewayAction: "adopt", tunnelAction: "adopt", exitCode: 0 } });
  });
});
