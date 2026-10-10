import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { actionDigest, criticalInputDigest, scopeDigest } from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const trustedClientId = "trusted-production-client";
const requestId = "production-decision-1";
let root: string;
let bridge: Bridge;
let client: Client;

function textOf(result: { content?: unknown }): string {
  return ((result.content as { type: string; text: string }[] | undefined) ?? [])[0]?.text ?? "";
}

function seedPendingDecision(): void {
  const store = new TaskStateStore();
  const service = new DecisionService({ workspaceRoot: root, stateStore: store });
  const created = store.createTaskState(bridge.workspace.id);
  const building = store.transitionTask(bridge.workspace.id, created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease(bridge.workspace.id, created.taskId, "production-binding-fixture");
  const owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const scope = {
    schemaVersion: "scope-descriptor-v1" as const,
    workspaceId: bridge.workspace.id,
    canonicalRootRelativePaths: ["approved"],
    accessMode: "WRITE" as const,
    excludedPaths: [],
  };
  const criticalInput = {
    expectedContent: "BEFORE",
    replacementContent: "AFTER",
    expectedHash: crypto.createHash("sha256").update("BEFORE", "utf8").digest("hex").toUpperCase(),
  };
  const descriptor = {
    schemaVersion: "action-descriptor-v1" as const,
    actionType: "PATCH_EXISTING_TEXT",
    target: "approved/target.md",
    approvedScopeDigest: scopeDigest(scope),
    criticalInput,
    criticalInputDigest: criticalInputDigest(criticalInput),
  };
  const active = store.beginActiveAction(bridge.workspace.id, created.taskId, building.revision, owner, {
    actionId: "production-action-1",
    semanticRequestId: "production-semantic-1",
    actionEpoch: 1,
    validUntil: "2099-01-01T00:00:00.000Z",
    startedAt: new Date().toISOString(),
    approvedAuthority: {
      approvedScopeDescriptor: scope,
      approvedScopeDigest: scopeDigest(scope),
      approvedActionIds: ["PATCH_EXISTING_TEXT"],
      globalForbiddenActionIds: [],
    },
    actionDescriptor: descriptor,
    actionDigest: actionDigest(descriptor),
  });
  service.createDecisionRequest(bridge.workspace.id, active.taskId, active.revision, owner, {
    schemaVersion: "reasoning-packet-v1" as const,
    workspaceId: bridge.workspace.id,
    taskId: active.taskId,
    semanticRequestId: "production-semantic-1",
    requestId,
    actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY" as const,
    currentTaskState: "BUILDING",
    activeActionId: "production-action-1",
    exactIssue: "Isolated production binding fixture.",
    evidenceRefs: ["fixture:production-binding"],
    attemptedFixes: ["none"],
    constraints: ["isolated test workspace"],
    candidateActionIds: ["PATCH_EXISTING_TEXT"],
    forbiddenActionIds: [],
    scopeDescriptor: scope,
    actionDigest: actionDigest(descriptor),
    createdAt: new Date().toISOString(),
    validUntil: "2099-01-01T00:00:00.000Z",
  });
  store.releaseWorkspaceMutationLease(bridge.workspace.id, active.taskId, owner);
}

async function connect(token: string): Promise<Client> {
  const value = new Client({ name: "production-binding-test", version: "1.0.0" });
  await value.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return value;
}

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("production-binding-workspace");
  makeGitRepo(root);
  write(root, "approved/target.md", "BEFORE");
  write(root, "approved/create-target.md", "CREATE_BEFORE");
  write(root, "approved/stale-target.md", "STALE_BEFORE");
  write(root, "Mixed/case-target.md", "CASE_BEFORE");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("production-binding-auth"), "store.json"),
    trustedHumanDecisionClientId: trustedClientId,
  });
  const token = bridge.authStore.issueTokens({ clientId: trustedClientId, scopes: ["decision.submit", "workspace.write"] });
  client = await connect(token.accessToken);
  seedPendingDecision();
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

describe("production decision and controlled-write bindings", () => {
  it("publishes the three governed mutation tools with a bounded request-creation schema", async () => {
    const tools = (await client.listTools()).tools;
    const create = tools.find((tool) => tool.name === "decision_request_create");
    const decision = tools.find((tool) => tool.name === "trusted_human_decision");
    const writeTool = tools.find((tool) => tool.name === "controlled_write_patch");
    expect(create).toBeDefined();
    expect(decision).toBeDefined();
    expect(writeTool).toBeDefined();
    expect(Object.keys(create!.inputSchema.properties ?? {}).sort()).toEqual(["baseline_sha256", "operation", "patch", "scope_summary", "target_file", "task_id"]);
    expect(Object.keys(decision!.inputSchema.properties ?? {}).sort()).toEqual(["decision_request_id", "disposition"]);
    expect(Object.keys(writeTool!.inputSchema.properties ?? {}).sort()).toEqual(["decision_request_id"]);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name).sort()).toEqual([
      "controlled_write_patch", "decision_request_create", "trusted_human_decision",
    ]);
  });

  it("rejects missing scope and a non-configured client before processing the decision", async () => {
    const scopeLimited = bridge.authStore.issueTokens({ clientId: trustedClientId, scopes: ["workspace.write"] });
    const limitedClient = await connect(scopeLimited.accessToken);
    const missingScope = await limitedClient.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: requestId, disposition: "EXECUTE" } });
    expect(missingScope.isError).toBe(true);
    expect(textOf(missingScope)).toContain("INSUFFICIENT_SCOPE");
    await limitedClient.close();

    const other = bridge.authStore.issueTokens({ clientId: "other-client", scopes: ["decision.submit", "workspace.write"] });
    const otherClient = await connect(other.accessToken);
    const mismatch = await otherClient.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: requestId, disposition: "EXECUTE" } });
    expect(mismatch.isError).toBe(true);
    expect(textOf(mismatch)).toContain("TRUSTED_CLIENT_MISMATCH");
    await otherClient.close();
  });

  it("derives a one-time exact patch from the verified decision, then consumes it", async () => {
    const decision = await client.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: requestId, disposition: "EXECUTE" } });
    if (decision.isError) throw new Error(textOf(decision));
    expect(decision.isError ?? false).toBe(false);
    expect(textOf(decision)).toContain(requestId);

    const writeResult = await client.callTool({ name: "controlled_write_patch", arguments: { decision_request_id: requestId } });
    expect(writeResult.isError ?? false).toBe(false);
    expect(textOf(writeResult)).toContain('"result": "PASS"');
    expect(fs.readFileSync(path.join(root, "approved", "target.md"), "utf8")).toBe("AFTER");

    const replay = await client.callTool({ name: "controlled_write_patch", arguments: { decision_request_id: requestId } });
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toMatch(/CURRENT_DECISION_NOT_WRITABLE|CONTRACT_NOT_READY/);
  });

  it("creates an exact server-owned pending request and rejects malformed, unsafe, or mutated requests", async () => {
    const invalidTarget = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-invalid-target", target_file: "../outside.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: "0".repeat(64), patch: { expected_content: "x", replacement_content: "y" }, scope_summary: "isolated",
    } });
    expect(invalidTarget.isError).toBe(true);

    const invalidOperation = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-invalid-operation", target_file: "approved/create-target.md", operation: "DELETE_FILE",
      baseline_sha256: "0".repeat(64), patch: { expected_content: "x", replacement_content: "y" }, scope_summary: "isolated",
    } });
    expect(invalidOperation.isError).toBe(true);

    const malformedBaseline = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-invalid-baseline", target_file: "approved/create-target.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: "bad", patch: { expected_content: "x", replacement_content: "y" }, scope_summary: "isolated",
    } });
    expect(malformedBaseline.isError).toBe(true);

    const baseline = crypto.createHash("sha256").update("CREATE_BEFORE", "utf8").digest("hex").toUpperCase();
    const args = {
      task_id: "create-exact-request", target_file: "approved/create-target.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: baseline, patch: { expected_content: "CREATE_BEFORE", replacement_content: "CREATE_AFTER" }, scope_summary: "exact isolated creation",
    };
    const created = await client.callTool({ name: "decision_request_create", arguments: args });
    expect(created.isError ?? false).toBe(false);
    const body = JSON.parse(textOf(created)).request;
    expect(body).toMatchObject({ taskId: args.task_id, targetFile: args.target_file, operation: "PATCH_EXISTING_TEXT", baselineSha256: baseline, idempotent: false });
    expect(body.decisionRequestId).toMatch(/^decision_[a-f0-9]{32}$/);
    expect(body.patchSha256).toMatch(/^[a-f0-9]{64}$/);
    const read = new TaskStateStore().readTaskState(bridge.workspace.id, args.task_id);
    expect(read).toMatchObject({ status: "VALID", state: { state: "WAITING_DECISION", pendingReasoning: { packet: { requestId: body.decisionRequestId, taskId: args.task_id, scopeDescriptor: { canonicalRootRelativePaths: [args.target_file] } } } } });

    const retry = await client.callTool({ name: "decision_request_create", arguments: args });
    expect(retry.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(retry)).request).toMatchObject({ decisionRequestId: body.decisionRequestId, idempotent: true });

    const mutated = await client.callTool({ name: "decision_request_create", arguments: { ...args, patch: { ...args.patch, replacement_content: "MUTATED" } } });
    expect(mutated.isError).toBe(true);
    expect(textOf(mutated)).toContain("DECISION_REQUEST_TASK_CONFLICT");
  });

  it("fails closed on stale baseline and completes one exact created request", async () => {
    const staleBaseline = crypto.createHash("sha256").update("STALE_BEFORE", "utf8").digest("hex").toUpperCase();
    const stale = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-stale-request", target_file: "approved/stale-target.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: staleBaseline, patch: { expected_content: "STALE_BEFORE", replacement_content: "STALE_AFTER" }, scope_summary: "stale fixture",
    } });
    expect(stale.isError ?? false).toBe(false);
    const staleId = JSON.parse(textOf(stale)).request.decisionRequestId;
    fs.writeFileSync(path.join(root, "approved/stale-target.md"), "STALE_CHANGED");
    const staleDecision = await client.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: staleId, disposition: "EXECUTE" } });
    expect(staleDecision.isError ?? false).toBe(false);
    const staleWrite = await client.callTool({ name: "controlled_write_patch", arguments: { decision_request_id: staleId } });
    expect(staleWrite.isError ?? false).toBe(false);
    expect(textOf(staleWrite)).toContain("PRECONDITION_MISMATCH");
    expect(fs.readFileSync(path.join(root, "approved/stale-target.md"), "utf8")).toBe("STALE_CHANGED");

    const baseline = crypto.createHash("sha256").update("CREATE_BEFORE", "utf8").digest("hex").toUpperCase();
    const complete = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-complete-request", target_file: "approved/create-target.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: baseline, patch: { expected_content: "CREATE_BEFORE", replacement_content: "CREATE_AFTER" }, scope_summary: "exact e2e fixture",
    } });
    expect(complete.isError ?? false).toBe(false);
    const completeId = JSON.parse(textOf(complete)).request.decisionRequestId;
    const decision = await client.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: completeId, disposition: "EXECUTE" } });
    expect(decision.isError ?? false).toBe(false);
    const writeResult = await client.callTool({ name: "controlled_write_patch", arguments: { decision_request_id: completeId } });
    expect(writeResult.isError ?? false).toBe(false);
    expect(textOf(writeResult)).toContain('"result": "PASS"');
    expect(fs.readFileSync(path.join(root, "approved/create-target.md"), "utf8")).toBe("CREATE_AFTER");
  });

  it("uses the canonical case-insensitive scope binding on Windows", async () => {
    const baseline = crypto.createHash("sha256").update("CASE_BEFORE", "utf8").digest("hex").toUpperCase();
    const created = await client.callTool({ name: "decision_request_create", arguments: {
      task_id: "create-case-request", target_file: "Mixed/case-target.md", operation: "PATCH_EXISTING_TEXT",
      baseline_sha256: baseline, patch: { expected_content: "CASE_BEFORE", replacement_content: "CASE_AFTER" }, scope_summary: "canonical Windows path fixture",
    } });
    expect(created.isError ?? false).toBe(false);
    const request = JSON.parse(textOf(created)).request;
    expect(request.targetFile).toBe("mixed/case-target.md");
    expect((await client.callTool({ name: "trusted_human_decision", arguments: { decision_request_id: request.decisionRequestId, disposition: "EXECUTE" } })).isError ?? false).toBe(false);
    const writeResult = await client.callTool({ name: "controlled_write_patch", arguments: { decision_request_id: request.decisionRequestId } });
    expect(writeResult.isError ?? false).toBe(false);
    expect(fs.readFileSync(path.join(root, "Mixed/case-target.md"), "utf8")).toBe("CASE_AFTER");
  });
});
