import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GatewayWorkspaceRegistry, GatewayWorkspaceError } from "../src/workspace/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function makeGatewayGitRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const git = (args: string[]): void => {
    const result = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "c2c-test",
        GIT_AUTHOR_EMAIL: "test@c2c.local",
        GIT_COMMITTER_NAME: "c2c-test",
        GIT_COMMITTER_EMAIL: "test@c2c.local",
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message}`);
  };
  git(["init", "-b", "main"]);
  write(root, "hello.txt", "Hello from Code Gateway!\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
}

function makeGatewayFixture(): { boundary: string; a: Workspace; b: Workspace } {
  const boundary = makeTmpDir("gateway-boundary");
  const aRoot = `${boundary}/workspace-a`;
  const bRoot = `${boundary}/workspace-b`;
  write(aRoot, "a.txt", "workspace A");
  write(bRoot, "b.txt", "workspace B");
  return { boundary, a: new Workspace(aRoot), b: new Workspace(bRoot) };
}

describe("GatewayWorkspaceRegistry", () => {
  it("resolves only canonical, allowlisted workspace identities", () => {
    const { boundary, a, b } = makeGatewayFixture();
    const registry = new GatewayWorkspaceRegistry(boundary, [
      { expectedWorkspaceId: a.id, root: a.root },
      { expectedWorkspaceId: b.id, root: b.root },
    ]);
    expect(registry.resolve(a.id).root).toBe(a.root);
    expect(registry.resolve(b.id).root).toBe(b.root);
    cleanup(boundary);
  });

  it("fails closed for missing or unknown selectors", () => {
    const { boundary, a } = makeGatewayFixture();
    const registry = new GatewayWorkspaceRegistry(boundary, [{ expectedWorkspaceId: a.id, root: a.root }]);
    expect(() => registry.resolve(undefined)).toThrow(GatewayWorkspaceError);
    try {
      registry.resolve("unknown0000");
    } catch (error) {
      expect((error as GatewayWorkspaceError).code).toBe("WORKSPACE_NOT_ALLOWED");
    }
    cleanup(boundary);
  });

  it("rejects an entry outside the code-root boundary", () => {
    const boundary = makeTmpDir("gateway-boundary");
    const outside = makeTmpDir("gateway-outside");
    const outsideWorkspace = new Workspace(outside);
    expect(
      () => new GatewayWorkspaceRegistry(boundary, [{ expectedWorkspaceId: outsideWorkspace.id, root: outside }])
    ).toThrow(GatewayWorkspaceError);
    cleanup(boundary);
    cleanup(outside);
  });

  it("rejects a workspace ID whose configured root no longer derives that identity", () => {
    const { boundary, a, b } = makeGatewayFixture();
    expect(
      () => new GatewayWorkspaceRegistry(boundary, [{ expectedWorkspaceId: a.id, root: b.root }])
    ).toThrow(GatewayWorkspaceError);
    cleanup(boundary);
  });

  it("rejects a Windows junction that resolves outside the code-root boundary", () => {
    const boundary = makeTmpDir("gateway-boundary");
    const codeRoot = path.join(boundary, "code-root");
    const outside = makeTmpDir("gateway-vault-outside");
    const junction = path.join(codeRoot, "vault-link");
    write(codeRoot, "inside.txt", "inside");
    write(outside, "outside.txt", "outside");
    fs.symlinkSync(outside, junction, "junction");
    const codeWorkspace = new Workspace(codeRoot);
    try {
      codeWorkspace.resolve("vault-link/outside.txt");
      throw new Error("expected junction escape to be rejected");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
    cleanup(boundary);
    cleanup(outside);
  });

  it("explicitly rejects a Vault-like workspace root outside the code boundary", () => {
    const boundary = makeTmpDir("gateway-code-boundary");
    const vaultRoot = makeTmpDir("gateway-vault-root");
    const vaultWorkspace = new Workspace(vaultRoot);
    try {
      new GatewayWorkspaceRegistry(boundary, [{ expectedWorkspaceId: vaultWorkspace.id, root: vaultWorkspace.root }]);
      throw new Error("expected Vault-like root to be rejected");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("WORKSPACE_OUTSIDE_GATEWAY_BOUNDARY");
    }
    cleanup(boundary);
    cleanup(vaultRoot);
  });

  it("keeps independent contexts under concurrent resolution", async () => {
    const { boundary, a, b } = makeGatewayFixture();
    const registry = new GatewayWorkspaceRegistry(boundary, [
      { expectedWorkspaceId: a.id, root: a.root },
      { expectedWorkspaceId: b.id, root: b.root },
    ]);
    const roots = await Promise.all(
      Array.from({ length: 100 }, (_, index) => Promise.resolve(registry.resolve(index % 2 ? a.id : b.id).root))
    );
    expect(new Set(roots)).toEqual(new Set([a.root, b.root]));
    cleanup(boundary);
  });
});

function textOf(result: { content?: unknown }): string {
  return ((result.content as { type: string; text: string }[] | undefined) ?? [])[0]?.text ?? "";
}

function jsonOf<T>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

describe("multi-workspace MCP gateway mode", () => {
  let boundary: string;
  let rootA: string;
  let rootB: string;
  let workspaceA: Workspace;
  let workspaceB: Workspace;
  let bridge: Bridge;
  let client: Client;

  beforeAll(async () => {
    // Vitest workers on this Windows host do not inherit the interactive Git
    // path. Keep the fixture self-contained without changing system PATH.
    const gitBin = "C:\\Program Files\\Git\\cmd";
    process.env.Path = `${gitBin};${process.env.Path ?? ""}`;
    process.env.PATH = `${gitBin};${process.env.PATH ?? ""}`;
    isolateStateDir();
    boundary = makeTmpDir("gateway-http");
    rootA = path.join(boundary, "code-root");
    rootB = path.join(rootA, "worktrees", "phase1");
    makeGatewayGitRepo(rootA);
    makeGatewayGitRepo(rootB);
    write(rootA, "origin.txt", "gateway workspace A");
    write(rootB, "phase1.txt", "gateway workspace B");
    write(rootB, "hello.txt", "Hello from workspace B with an unstaged change!\n");
    workspaceA = new Workspace(rootA);
    workspaceB = new Workspace(rootB);
    bridge = await startBridge({
      workspaceRoot: rootA,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("gateway-auth"), "store.json"),
      gatewayWorkspaceEntries: [
        { expectedWorkspaceId: workspaceA.id, root: workspaceA.root },
        { expectedWorkspaceId: workspaceB.id, root: workspaceB.root },
      ],
    });
    const accessToken = bridge.authStore.issueTokens({
      clientId: "gateway-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    }).accessToken;
    client = new Client({ name: "gateway-test-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
    );
  });

  afterAll(async () => {
    if (client) await client.close();
    if (bridge) await bridge.close();
    if (boundary) cleanup(boundary);
  });

  it("rejects a missing workspace_id at schema level and rejects unknown IDs", async () => {
    const missing = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(missing.isError).toBe(true);
    // workspace_id is required by the Gateway schema, so MCP rejects before
    // any handler can resolve or route a workspace context.
    expect(textOf(missing)).toContain("-32602");
    expect(textOf(missing)).toContain("workspace_id");
    const unknown = await client.callTool({ name: "workspace_info", arguments: { workspace_id: "unknown0000" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("WORKSPACE_NOT_ALLOWED");
  });

  it("routes all requested read tools to the requested independent workspace", async () => {
    const infoA = jsonOf<{ workspaceId: string }>(
      await client.callTool({ name: "workspace_info", arguments: { workspace_id: workspaceA.id } })
    );
    const infoB = jsonOf<{ workspaceId: string }>(
      await client.callTool({ name: "workspace_info", arguments: { workspace_id: workspaceB.id } })
    );
    expect(infoA.workspaceId).toBe(workspaceA.id);
    expect(infoB.workspaceId).toBe(workspaceB.id);
    const directoryB = jsonOf<{ entries: { path: string }[] }>(
      await client.callTool({ name: "list_directory", arguments: { workspace_id: workspaceB.id, path: "." } })
    );
    expect(directoryB.entries.map((entry) => entry.path)).toContain("phase1.txt");
    const fileB = jsonOf<{ content: string }>(
      await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceB.id, path: "phase1.txt" } })
    );
    expect(fileB.content).toContain("workspace B");
    const searchB = jsonOf<{ matches: { text: string }[] }>(
      await client.callTool({ name: "search_workspace", arguments: { workspace_id: workspaceB.id, query: "workspace B" } })
    );
    expect(searchB.matches.some((match) => match.text.includes("workspace B"))).toBe(true);
    const gitB = jsonOf<{ isRepo: boolean }>(
      await client.callTool({ name: "git_status", arguments: { workspace_id: workspaceB.id } })
    );
    expect(gitB.isRepo).toBe(true);
    const diffB = jsonOf<{ diff: string }>(
      await client.callTool({ name: "git_diff", arguments: { workspace_id: workspaceB.id } })
    );
    expect(diffB.diff).toContain("workspace B with an unstaged change");
    appendExecutionRecord(workspaceB.id, {
      taskId: "phase1-review",
      iteration: 1,
      changedFiles: ["phase1.txt"],
      tests: "pass",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const execution = jsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: { workspace_id: workspaceB.id } })
    );
    expect(execution.records[0]?.taskId).toBe("phase1-review");
    const testStatus = jsonOf<{ available: boolean; taskId: string }>(
      await client.callTool({ name: "test_status", arguments: { workspace_id: workspaceB.id } })
    );
    expect(testStatus).toMatchObject({ available: true, taskId: "phase1-review" });
    const output = saveExecutionOutput(workspaceB.id, {
      command: "npm test -- phase1",
      raw: "phase1 workspace B test output",
      exitCode: 0,
      taskId: "phase1-review",
      iteration: 1,
    });
    const outputList = jsonOf<{ items: { id: number }[] }>(
      await client.callTool({ name: "execution_output", arguments: { workspace_id: workspaceB.id, action: "list" } })
    );
    expect(outputList.items.some((item) => item.id === output.id)).toBe(true);
    const outputRead = jsonOf<{ text: string }>(
      await client.callTool({ name: "execution_output", arguments: { workspace_id: workspaceB.id, action: "read", id: output.id } })
    );
    expect(outputRead.text).toContain("workspace B test output");
  });

  it("does not reuse a previous request context under concurrent calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        client.callTool({
          name: "workspace_info",
          arguments: { workspace_id: index % 2 === 0 ? workspaceA.id : workspaceB.id },
        })
      )
    );
    for (const [index, result] of results.entries()) {
      const expected = index % 2 === 0 ? workspaceA.id : workspaceB.id;
      expect(jsonOf<{ workspaceId: string }>(result).workspaceId).toBe(expected);
    }
  });

  it("keeps path escape checks scoped to the selected workspace", async () => {
    const escaped = await client.callTool({
      name: "read_file",
      arguments: { workspace_id: workspaceB.id, path: "../../origin.txt" },
    });
    expect(escaped.isError).toBe(true);
    expect(textOf(escaped)).toContain("PATH_OUTSIDE_WORKSPACE");
  });
});
