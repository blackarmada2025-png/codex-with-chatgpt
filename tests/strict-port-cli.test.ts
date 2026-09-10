import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "index.js");
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) cleanup(dir);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(state: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: state },
    timeout: 30_000,
  });
}

describe("strict fixed-port CLI startup", () => {
  it("supports watchdog-shaped JSON startup and restart on the exact requested port", async () => {
    const state = makeTmpDir("strict-cli-state");
    const workspace = makeTmpDir("strict-cli-workspace");
    cleanupDirs.push(state, workspace);
    write(workspace, "note.txt", "fixture");
    const port = await freePort();

    const first = run(state, ["start", "--workspace", workspace, "--port", String(port), "--json"]);
    expect(first.status).toBe(0);
    const firstJson = JSON.parse(first.stdout) as { ok: boolean; port: number; workspaceId: string };
    expect(firstJson).toMatchObject({ ok: true, port });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);

    expect(run(state, ["stop", "--workspace", workspace]).status).toBe(0);
    const second = run(state, ["start", "--workspace", workspace, "--port", String(port), "--json"]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, port });
    expect(run(state, ["stop", "--workspace", workspace]).status).toBe(0);
  }, 45_000);

  it("fails deterministically on an occupied explicit port without fallback", async () => {
    const state = makeTmpDir("strict-cli-collision-state");
    const workspace = makeTmpDir("strict-cli-collision-workspace");
    cleanupDirs.push(state, workspace);
    write(workspace, "note.txt", "fixture");
    const port = await freePort();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    try {
      const result = run(state, ["start", "--workspace", workspace, "--port", String(port), "--json"]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("STRICT_PORT_UNAVAILABLE");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 45_000);

  it.each(["0", "-1", "65536", "abc", "1.5"])("rejects invalid explicit port %s", (port) => {
    const state = makeTmpDir("strict-cli-invalid-state");
    const workspace = makeTmpDir("strict-cli-invalid-workspace");
    cleanupDirs.push(state, workspace);
    write(workspace, "note.txt", "fixture");
    const result = run(state, ["start", "--workspace", workspace, "--port", port, "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("INVALID_PORT");
  });
});
