import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionDigest, criticalInputDigest, scopeDigest, validateActionFact, type ActionDescriptorV1, type ReasoningPacketV1, type ScopeDescriptorV1 } from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";

const dirs: string[] = [];
function dir(label: string) { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scope(accessMode: "READ_ONLY" | "WRITE" = "WRITE"): ScopeDescriptorV1 { return { schemaVersion: "scope-descriptor-v1", workspaceId: "ws", canonicalRootRelativePaths: ["src"], accessMode, excludedPaths: [] }; }
function facts(approved: ScopeDescriptorV1, patch: Partial<Omit<ActionDescriptorV1, "schemaVersion" | "approvedScopeDigest" | "criticalInputDigest">> = {}) {
  const criticalInput = patch.criticalInput ?? { version: "1" };
  const actionDescriptor: ActionDescriptorV1 = { schemaVersion: "action-descriptor-v1", actionType: patch.actionType ?? "WRITE_FILE", target: patch.target ?? "src/a.ts", approvedScopeDigest: scopeDigest(approved), criticalInput, criticalInputDigest: criticalInputDigest(criticalInput) };
  return { actionDescriptor, actionDigest: actionDigest(actionDescriptor) };
}
function setup() {
  const root = dir("c2c-action-digest-workspace"); fs.mkdirSync(path.join(root, "src"));
  const stateDir = dir("c2c-action-digest-state"), contractRoot = dir("c2c-action-digest-contract"), now = () => new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStateStore({ stateDir, now }), service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot, now });
  const created = store.createTaskState("ws"), building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING"), lease = store.acquireWorkspaceMutationLease("ws", created.taskId, "digest_owner"), owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker }, approved = scope(), fact = facts(approved);
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, { actionId: "action", semanticRequestId: "semantic", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", approvedAuthority: { approvedScopeDescriptor: approved, approvedScopeDigest: scopeDigest(approved), approvedActionIds: ["ACTION_A"], globalForbiddenActionIds: [] }, ...fact });
  const packet: ReasoningPacketV1 = { schemaVersion: "reasoning-packet-v1", workspaceId: "ws", taskId: active.taskId, semanticRequestId: "semantic", requestId: "request", actionEpoch: 1, gateKind: "SPECIFICATION_AMBIGUITY", currentTaskState: "BUILDING", activeActionId: "action", exactIssue: "Bounded action.", evidenceRefs: ["record:1"], attemptedFixes: [], constraints: ["bounded"], candidateActionIds: ["ACTION_A"], forbiddenActionIds: [], scopeDescriptor: approved, actionDigest: fact.actionDigest, createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z" };
  return { root, store, service, owner, active, approved, fact, packet };
}
function ready(x: ReturnType<typeof setup>) { const pending = x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.packet); return x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Execute.", requestedActionIds: ["ACTION_A"] }); }
function changeFacts(x: ReturnType<typeof setup>, patch: Parameters<typeof facts>[1]) { const current = x.store.readTaskState("ws", x.active.taskId); if (current.status !== "VALID") throw new Error("missing fixture state"); const next = facts(x.approved, patch); return x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, current.state.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, ...next } })); }

describe("Active action digest enforcement B1", () => {
  it("ACTION_DIGEST_CANONICAL", () => { const x = setup(); expect(actionDigest(x.fact.actionDescriptor)).toBe(x.fact.actionDigest); });
  it("ACTION_DIGEST_PERSISTED", () => { const x = setup(), read = x.store.readTaskState("ws", x.active.taskId); expect(read.status === "VALID" && read.state.activeAction?.actionDigest).toBe(x.fact.actionDigest); });
  it("ACTION_DIGEST_RECOMPUTED_LOCALLY", () => { const x = setup(); expect(() => validateActionFact({ actionDescriptor: x.fact.actionDescriptor, actionDigest: "0".repeat(64) })).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("ACTION_DIGEST_CALLER_FORGED_DENIED", () => { const x = setup(), read = x.store.readTaskState("ws", x.active.taskId); expect(read.status).toBe("VALID"); expect(() => x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, read.state.revision, x.owner, (s) => ({ ...s, activeAction: { ...s.activeAction!, actionDigest: "0".repeat(64) } }))).toThrow(/TASK_STATE_SCHEMA_INVALID/); });
  it("PACKET_BINDS_CURRENT_ACTION_DIGEST", () => { const x = setup(); expect(x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.packet).state).toBe("WAITING_DECISION"); });
  it("PACKET_ACTION_DIGEST_MISMATCH_DENIED", () => { const x = setup(); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, { ...x.packet, actionDigest: "0".repeat(64) })).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("CONTRACT_BINDS_ACTION_DIGEST", () => { const x = setup(), completed = ready(x); expect(completed.activeContract?.binding.actionDigest).toBe(x.fact.actionDigest); });
  it("CONSUMPTION_REVALIDATES_ACTION_DIGEST", () => { const x = setup(), completed = ready(x), changed = changeFacts(x, { target: "src/b.ts" }); expect(() => x.service.beginContractConsumption("ws", changed.taskId, changed.revision, x.owner, "action", "ACTION_A", completed.activeContract!.binding.scopeDigest)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("SAME_EPOCH_CHANGED_TARGET_DENIED", () => { const x = setup(); changeFacts(x, { target: "src/b.ts" }); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.store.readTaskState("ws", x.active.taskId).state.revision, x.owner, x.packet)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("SAME_EPOCH_CHANGED_SCOPE_DENIED", () => { const x = setup(), current = x.store.readTaskState("ws", x.active.taskId); if (current.status !== "VALID") throw new Error("missing"); const changed = x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, current.state.revision, x.owner, (s) => ({ ...s, activeAction: { ...s.activeAction!, approvedAuthority: { ...s.activeAction!.approvedAuthority!, approvedScopeDigest: "0".repeat(64) } } })); expect(() => x.service.createDecisionRequest("ws", changed.taskId, changed.revision, x.owner, x.packet)).toThrow(/APPROVED_SCOPE_DIGEST_MISMATCH/); });
  it("SAME_EPOCH_CHANGED_CRITICAL_INPUT_DENIED", () => { const x = setup(); changeFacts(x, { criticalInput: { version: "2" } }); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.store.readTaskState("ws", x.active.taskId).state.revision, x.owner, x.packet)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("SAME_EPOCH_CHANGED_ACTION_TYPE_DENIED", () => { const x = setup(); changeFacts(x, { actionType: "DELETE_FILE" }); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.store.readTaskState("ws", x.active.taskId).state.revision, x.owner, x.packet)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("OLD_PACKET_NEW_ACTION_DIGEST_DENIED", () => { const x = setup(); changeFacts(x, { target: "src/b.ts" }); const state = x.store.readTaskState("ws", x.active.taskId); if (state.status !== "VALID") throw new Error("missing"); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, state.state.revision, x.owner, x.packet)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("OLD_CONTRACT_NEW_ACTION_DIGEST_DENIED", () => { const x = setup(), completed = ready(x), changed = changeFacts(x, { criticalInput: { version: "2" } }); expect(() => x.service.beginContractConsumption("ws", changed.taskId, changed.revision, x.owner, "action", "ACTION_A", completed.activeContract!.binding.scopeDigest)).toThrow(/ACTION_DIGEST_MISMATCH/); });
  it("MATCHING_EPOCH_AND_DIGEST_ALLOWED", () => { const x = setup(), completed = ready(x); expect(x.service.beginContractConsumption("ws", completed.taskId, completed.revision, x.owner, "action", "ACTION_A", completed.activeContract!.binding.scopeDigest).state.state).toBe("BUILDING"); });
  it("MISSING_ACTION_DIGEST_FAIL_CLOSED", () => { const x = setup(), current = x.store.readTaskState("ws", x.active.taskId); if (current.status !== "VALID") throw new Error("missing"); const legacy = x.store.updateTaskStateUnderMutationLease("ws", x.active.taskId, current.state.revision, x.owner, (s) => ({ ...s, activeAction: { ...s.activeAction!, actionDescriptor: undefined, actionDigest: undefined } })); expect(() => x.service.createDecisionRequest("ws", legacy.taskId, legacy.revision, x.owner, x.packet)).toThrow(/MISSING_ACTION_DIGEST_DENIED/); });
});
