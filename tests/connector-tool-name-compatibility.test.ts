import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const NAMESPACE = "orbnexa_c2c_dev_test";
const CANONICAL_TOOLS = [
  "workspace_info",
  "git_status",
  "git_diff",
  "search_workspace",
  "read_file",
  "list_directory",
  "test_status",
  "execution_summary",
  "execution_output",
] as const;

function alias(name: string): string {
  return `${NAMESPACE}.${name}`;
}

function textOf(result: { content?: unknown }): string {
  return ((result.content as { type: string; text: string }[] | undefined) ?? [])[0]?.text ?? "";
}

describe("Code Gateway connector tool-name compatibility", () => {
  let boundary: string;
  let workspace: Workspace;
  let gateway: Bridge;
  let gatewayClient: Client;
  let formal: Bridge;
  let formalClient: Client;

  beforeAll(async () => {
    isolateStateDir();
    boundary = makeTmpDir("connector-name-gateway");
    write(boundary, "hello.txt", "connector compatibility fixture\n");
    write(boundary, "src/example.ts", "export const connectorFixture = true;\n");
    workspace = new Workspace(boundary);
    gateway = await startBridge({
      workspaceRoot: boundary,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("connector-name-gateway-auth"), "store.json"),
      gatewayWorkspaceEntries: [{ expectedWorkspaceId: workspace.id, root: workspace.root }],
    });
    const gatewayToken = gateway.authStore.issueTokens({
      clientId: "connector-name-gateway-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    }).accessToken;
    gatewayClient = new Client({ name: "connector-name-gateway-client", version: "1.0.0" });
    await gatewayClient.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${gatewayToken}` } },
      })
    );

    const formalRoot = makeTmpDir("connector-name-formal");
    write(formalRoot, "hello.txt", "formal fixture\n");
    formal = await startBridge({
      workspaceRoot: formalRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("connector-name-formal-auth"), "store.json"),
    });
    const formalToken = formal.authStore.issueTokens({
      clientId: "connector-name-formal-client",
      scopes: ["workspace.read"],
    }).accessToken;
    formalClient = new Client({ name: "connector-name-formal-client", version: "1.0.0" });
    await formalClient.connect(
      new StreamableHTTPClientTransport(new URL(`${formal.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${formalToken}` } },
      })
    );
  });

  afterAll(async () => {
    await gatewayClient?.close();
    await gateway?.close();
    await formalClient?.close();
    await formal?.close();
    if (boundary) cleanup(boundary);
  });

  it("keeps tools/list canonical with no Connector aliases", async () => {
    const { tools } = await gatewayClient.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...CANONICAL_TOOLS].sort());
    for (const name of CANONICAL_TOOLS) expect(names).not.toContain(alias(name));
  });

  it("keeps bare canonical tools working", async () => {
    const result = await gatewayClient.callTool({ name: "workspace_info", arguments: { workspace_id: workspace.id } });
    expect(result.isError ?? false).toBe(false);
  });

  it("normalizes exactly the nine known Connector aliases", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "workspace_info", arguments: {} },
      { name: "git_status", arguments: {} },
      { name: "git_diff", arguments: {} },
      { name: "search_workspace", arguments: { query: "connectorFixture" } },
      { name: "read_file", arguments: { path: "hello.txt" } },
      { name: "list_directory", arguments: { path: "." } },
      { name: "test_status", arguments: {} },
      { name: "execution_summary", arguments: {} },
      { name: "execution_output", arguments: { action: "list" } },
    ];
    for (const call of calls) {
      const result = await gatewayClient.callTool({
        name: alias(call.name),
        arguments: { workspace_id: workspace.id, ...call.arguments },
      });
      expect(result.isError ?? false, call.name).toBe(false);
    }
  });

  it("fails closed for unknown namespaces, suffixes, and double namespaces", async () => {
    for (const name of [
      "random.workspace_info",
      `${NAMESPACE}.unknown_tool`,
      `${NAMESPACE}.${NAMESPACE}.workspace_info`,
    ]) {
      const result = await gatewayClient.callTool({ name, arguments: { workspace_id: workspace.id } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("-32602");
      expect(textOf(result)).toContain("not found");
    }
  });

  it("does not enable the compatibility alias for a formal single-workspace bridge", async () => {
    const result = await formalClient.callTool({ name: alias("workspace_info"), arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("-32602");
    expect(textOf(result)).toContain("not found");
  });
});
