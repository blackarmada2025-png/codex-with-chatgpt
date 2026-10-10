import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovedAuthorityV1Schema,
  actionDigest,
  bindDecisionResponse,
  canonicalizeScopeDescriptor,
  criticalInputDigest,
  materializeExecutionContract,
  reasoningPacketDigest,
  scopeDigest,
  validatePacket,
  type ApprovedAuthorityV1,
  type ReasoningPacketV1,
  type ScopeDescriptorV1,
} from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";

const dirs: string[] = [];
function directory(label: string): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function descriptor(accessMode: "READ_ONLY" | "WRITE" = "WRITE", roots = ["src"]): ScopeDescriptorV1 {
  return { schemaVersion: "scope-descriptor-v1", workspaceId: "ws", canonicalRootRelativePaths: roots, accessMode, excludedPaths: [] };
}
function authority(scope: ScopeDescriptorV1, forbidden: string[] = []): ApprovedAuthorityV1 {
  return { approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: ["ACTION_A"], globalForbiddenActionIds: forbidden };
}
function actionFacts(scope: ScopeDescriptorV1) {
  const actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/file.txt", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  return { actionDescriptor, actionDigest: actionDigest(actionDescriptor) };
}
function packet(taskId = "task", scope = descriptor()): ReasoningPacketV1 {
  return {
    schemaVersion: "reasoning-packet-v1", workspaceId: "ws", taskId, semanticRequestId: "semantic", requestId: "request", actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY", currentTaskState: "BUILDING", activeActionId: "action", exactIssue: "Bounded action.", evidenceRefs: ["record:1"], attemptedFixes: [], constraints: ["bounded"],
    candidateActionIds: ["ACTION_A"], forbiddenActionIds: [], scopeDescriptor: scope, actionDigest: actionFacts(scope).actionDigest,
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
}
function directContract(scope = descriptor(), forbidden: string[] = []) {
  const request = packet("task", scope), digest = reasoningPacketDigest(request);
  const response = bindDecisionResponse(request, digest, { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Execute A.", requestedActionIds: ["ACTION_A"] }, "2026-01-01T00:00:00.000Z");
  const approved = authority(scope, forbidden);
  return materializeExecutionContract({ contractId: "contract", packet: request, packetDigest: digest, response, approvedAuthority: approved, activeAction: actionFacts(approved.approvedScopeDescriptor) });
}
function setup(forbidden: string[] = []) {
  const root = directory("c2c-global-deny-workspace"); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src", "file.txt"), "x");
  const stateDir = directory("c2c-global-deny-state"), contractRoot = directory("c2c-global-deny-contract");
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStateStore({ stateDir, now }); const service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot, now });
  const created = store.createTaskState("ws"), building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease("ws", created.taskId, "global_deny_owner"); const owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const scope = descriptor();
  const approved = authority(scope, forbidden), facts = actionFacts(approved.approvedScopeDescriptor);
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, { actionId: "action", semanticRequestId: "semantic", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", approvedAuthority: approved, ...facts });
  return { root, store, service, owner, active, request: { ...packet(active.taskId, scope), actionDigest: facts.actionDigest } };
}
function ready(x: ReturnType<typeof setup>) {
  const pending = x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.request);
  return x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Execute A.", requestedActionIds: ["ACTION_A"] });
}

describe("Global deny priority A3", () => {
  it("GLOBAL_DENY_OVERRIDES_APPROVED_ACTION", () => { expect(() => directContract(descriptor(), ["ACTION_A"])).toThrow(/GLOBAL_DENY_ACTION/); });
  it("GLOBAL_DENY_OVERRIDES_PACKET_ACTION", () => { const x = setup(["ACTION_A"]); expect(() => ready(x)).toThrow(/GLOBAL_DENY_ACTION/); });
  it("GLOBAL_DENY_OVERRIDES_CONTRACT_ALLOW", () => {
    const x = setup(), contract = ready(x).activeContract!;
    const current = x.store.readTaskState("ws", x.active.taskId); expect(current.status).toBe("VALID");
    const updated = x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, current.state.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, approvedAuthority: { ...state.activeAction!.approvedAuthority!, globalForbiddenActionIds: ["ACTION_A"] } } }));
    expect(() => x.service.beginContractConsumption("ws", updated.taskId, updated.revision, x.owner, "action", "ACTION_A", contract.binding.scopeDigest)).toThrow(/GLOBAL_DENY_ACTION/);
  });
  it("GLOBAL_DENY_BLOCKS_MATERIALIZATION", () => { const x = setup(["ACTION_A"]); expect(() => ready(x)).toThrow(/GLOBAL_DENY_ACTION/); });
  it("GLOBAL_DENY_BLOCKS_CONSUMPTION", () => {
    const x = setup(), contract = ready(x).activeContract!, current = x.store.readTaskState("ws", x.active.taskId);
    if (current.status !== "VALID") throw new Error("fixture state missing");
    const updated = x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, current.state.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, approvedAuthority: { ...state.activeAction!.approvedAuthority!, globalForbiddenActionIds: ["ACTION_A"] } } }));
    expect(() => x.service.beginContractConsumption("ws", updated.taskId, updated.revision, x.owner, "action", "ACTION_A", contract.binding.scopeDigest)).toThrow(/GLOBAL_DENY_ACTION/);
  });
  it("GLOBAL_DENY_WITH_WRITE_SCOPE_STILL_DENIED", () => { expect(() => directContract(descriptor("WRITE"), ["ACTION_A"])).toThrow(/GLOBAL_DENY_ACTION/); });
  it("GLOBAL_DENY_WITH_VALID_BINDING_STILL_DENIED", () => {
    const x = setup(), result = ready(x), contract = result.activeContract!;
    const changed = x.store.updateTaskStateUnderMutationLease("ws", result.taskId, result.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, approvedAuthority: { ...state.activeAction!.approvedAuthority!, globalForbiddenActionIds: ["ACTION_A"] } } }));
    expect(() => x.service.beginContractConsumption("ws", changed.taskId, changed.revision, x.owner, "action", "ACTION_A", contract.binding.scopeDigest)).toThrow(/GLOBAL_DENY_ACTION/);
  });
  it("GLOBAL_DENY_CANNOT_BE_REMOVED_BY_DECISION_RESPONSE", () => {
    const request = packet(), digest = reasoningPacketDigest(request);
    expect(() => bindDecisionResponse(request, digest, { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "remove deny", requestedActionIds: ["ACTION_A"], globalForbiddenActionIds: [] }, "2026-01-01T00:00:00.000Z")).toThrow();
    expect(() => directContract(descriptor(), ["ACTION_A"])).toThrow(/GLOBAL_DENY_ACTION/);
  });
  it("GLOBAL_DENY_CANNOT_BE_REMOVED_BY_PACKET", () => { expect(() => validatePacket({ ...packet(), globalForbiddenActionIds: [] })).toThrow(); });
  it("VALID_EMPTY_GLOBAL_DENY_SET_ALLOWED", () => {
    const x = setup([]), completed = ready(x), reference = completed.activeContract!;
    expect(JSON.parse(fs.readFileSync(reference.artifactPath, "utf8")).approvedAuthority.globalForbiddenActionIds).toEqual([]);
  });
  it("MISSING_OR_CORRUPT_GLOBAL_DENY_FAIL_CLOSED", () => {
    const value = authority(descriptor());
    expect(ApprovedAuthorityV1Schema.safeParse({ ...value, globalForbiddenActionIds: undefined }).success).toBe(false);
    expect(ApprovedAuthorityV1Schema.safeParse({ ...value, globalForbiddenActionIds: ["bad action"] }).success).toBe(false);
  });
  it("A1_AUTHORITY_CEILING_STILL_PASS", () => {
    const x = setup(); const narrowed = { ...x.request, scopeDescriptor: descriptor("WRITE", ["docs"]) };
    expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, narrowed)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/);
  });
  it("A2_READ_ONLY_WRITE_DENY_STILL_PASS", () => { const root = directory("c2c-global-deny-readonly"); fs.mkdirSync(path.join(root, "src")); const service = new DecisionService({ workspaceRoot: root, stateStore: new TaskStateStore({ stateDir: directory("c2c-global-deny-readonly-state") }) }); const contract = directContract(descriptor("READ_ONLY")); expect(() => service.assertContractWriteScope(contract, "src/file.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("PATH_TRAVERSAL_STILL_DENIED", () => { const root = directory("c2c-global-deny-traversal"); fs.mkdirSync(path.join(root, "src")); const service = new DecisionService({ workspaceRoot: root, stateStore: new TaskStateStore({ stateDir: directory("c2c-global-deny-traversal-state") }) }); const raw = descriptor("WRITE"); const canonical = canonicalizeScopeDescriptor(root, raw); const contract = directContract(canonical); expect(() => service.assertContractWriteScope(contract, "../escape.txt")).toThrow(/SCOPE_PATH_ESCAPE/); });
  it("SYMLINK_ESCAPE_STILL_DENIED", () => { const root = directory("c2c-global-deny-symlink"); fs.mkdirSync(path.join(root, "src")); const outside = directory("c2c-global-deny-outside"); fs.symlinkSync(outside, path.join(root, "src", "escape"), "junction"); const service = new DecisionService({ workspaceRoot: root, stateStore: new TaskStateStore({ stateDir: directory("c2c-global-deny-symlink-state") }) }); const canonical = canonicalizeScopeDescriptor(root, descriptor("WRITE")); const contract = directContract(canonical); expect(() => service.assertContractWriteScope(contract, "src/escape/new.txt")).toThrow(/SCOPE_PATH_ESCAPE/); });
});
