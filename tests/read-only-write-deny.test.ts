import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindDecisionResponse,
  actionDigest,
  canonicalizeScopeDescriptor,
  criticalInputDigest,
  materializeExecutionContract,
  reasoningPacketDigest,
  scopeDigest,
  sha256,
  validateContractBinding,
  type ApprovedAuthorityV1,
  type ReasoningPacketV1,
  type ScopeDescriptorV1,
} from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";

const dirs: string[] = [];
function directory(label: string): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function descriptor(accessMode: "READ_ONLY" | "WRITE", roots = ["src"], excludedPaths: string[] = []): ScopeDescriptorV1 {
  return { schemaVersion: "scope-descriptor-v1", workspaceId: "ws", canonicalRootRelativePaths: roots, accessMode, excludedPaths };
}
function approved(scope: ScopeDescriptorV1): ApprovedAuthorityV1 {
  return { approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: ["WRITE_FILE"], globalForbiddenActionIds: [] };
}
function actionFacts(scope: ScopeDescriptorV1) {
  const actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/file.txt", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  return { actionDescriptor, actionDigest: actionDigest(actionDescriptor) };
}
function packet(scope: ScopeDescriptorV1): ReasoningPacketV1 {
  return {
    schemaVersion: "reasoning-packet-v1", workspaceId: "ws", taskId: "task", semanticRequestId: "semantic", requestId: "request", actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY", currentTaskState: "BUILDING", activeActionId: "action", exactIssue: "Bounded write authorization.", evidenceRefs: ["record:1"], attemptedFixes: [], constraints: ["bounded"],
    candidateActionIds: ["WRITE_FILE"], forbiddenActionIds: [], scopeDescriptor: scope, actionDigest: actionFacts(scope).actionDigest,
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
}
function contract(scope: ScopeDescriptorV1, authority = approved(scope)) {
  const request = packet(scope), digest = reasoningPacketDigest(request);
  const response = bindDecisionResponse(request, digest, { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Bounded write.", requestedActionIds: ["WRITE_FILE"] }, "2026-01-01T00:00:00.000Z");
  return materializeExecutionContract({ contractId: "contract", packet: request, packetDigest: digest, response, approvedAuthority: authority, activeAction: actionFacts(authority.approvedScopeDescriptor) });
}
function serviceWithAuthority(approval: ApprovedAuthorityV1, requestedScope: ScopeDescriptorV1) {
  const root = directory("c2c-readonly-service"); fs.mkdirSync(path.join(root, "src"));
  const stateDir = directory("c2c-readonly-state"), now = () => new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStateStore({ stateDir, now }), service = new DecisionService({ workspaceRoot: root, stateStore: store, now });
  const created = store.createTaskState("ws"), building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease("ws", created.taskId, "readonly_owner"), owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const facts = actionFacts(approval.approvedScopeDescriptor);
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, { actionId: "action", semanticRequestId: "semantic", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", approvedAuthority: approval, ...facts });
  return { service, owner, active, request: { ...packet(requestedScope), taskId: created.taskId, actionDigest: facts.actionDigest } };
}
function writeBoundary(scope: ScopeDescriptorV1) {
  const root = directory("c2c-readonly-boundary"); fs.mkdirSync(path.join(root, "src", "child"), { recursive: true }); fs.writeFileSync(path.join(root, "src", "root.txt"), "x");
  return { root, service: new DecisionService({ workspaceRoot: root, stateStore: new TaskStateStore({ stateDir: directory("c2c-readonly-boundary-state") }) }), contract: contract(scope) };
}

describe("READ_ONLY write deny A2", () => {
  it("READ_ONLY_VALID_PATH_WRITE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_ROOT_FILE_WRITE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY", ["src/root.txt"])); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_CHILD_PATH_WRITE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/child/new.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_CREATE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/create.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_MODIFY_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_DELETE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_RENAME_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_APPROVED_ACTION_STILL_WRITE_DENIED", () => { const x = writeBoundary(descriptor("READ_ONLY")); expect(x.contract.allowedActionIds).toContain("WRITE_FILE"); expect(() => x.service.assertContractWriteScope(x.contract, "src/root.txt")).toThrow(/CONTRACT_WRITE_NOT_ALLOWED/); });
  it("READ_ONLY_PACKET_CANNOT_ESCALATE_TO_WRITE", () => {
    const approval = approved(descriptor("READ_ONLY")), x = serviceWithAuthority(approval, descriptor("WRITE"));
    expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.request)).toThrow(/READ_ONLY_CANNOT_ESCALATE_TO_WRITE/);
  });
  it("READ_ONLY_CONTRACT_CANNOT_ESCALATE_TO_WRITE", () => {
    const base = contract(descriptor("READ_ONLY")); const copy = { ...base, scopeDescriptor: descriptor("WRITE") } as Record<string, unknown>; delete copy.digest;
    const tampered = { ...copy, digest: sha256(copy) } as typeof base;
    expect(() => validateContractBinding(tampered, base.binding, new Date("2026-01-01T01:00:00.000Z"))).toThrow(/CONTRACT_SCOPE_PACKET_EXPANSION/);
  });
  it("WRITE_SCOPE_WRITE_ALLOWED_WITHIN_APPROVED_PATH", () => { const x = writeBoundary(descriptor("WRITE")); expect(x.service.assertContractWriteScope(x.contract, "src/child/new.txt")).toBe("src/child/new.txt"); });
  it("WRITE_SCOPE_OUTSIDE_PATH_STILL_DENIED", () => { const x = writeBoundary(descriptor("WRITE")); expect(() => x.service.assertContractWriteScope(x.contract, "outside.txt")).toThrow(/CONTRACT_WRITE_SCOPE_VIOLATION/); });
  it("UNKNOWN_ACCESS_MODE_FAIL_CLOSED", () => { const root = directory("c2c-readonly-unknown"); fs.mkdirSync(path.join(root, "src")); expect(() => canonicalizeScopeDescriptor(root, { ...descriptor("READ_ONLY"), accessMode: "UNKNOWN" as "READ_ONLY" })).toThrow(); });
  it("PATH_TRAVERSAL_STILL_DENIED", () => { const x = writeBoundary(descriptor("WRITE")); expect(() => x.service.assertContractWriteScope(x.contract, "../outside.txt")).toThrow(/SCOPE_PATH_ESCAPE/); });
  it("SYMLINK_ESCAPE_STILL_DENIED", () => { const x = writeBoundary(descriptor("WRITE")), outside = directory("c2c-readonly-outside"); fs.symlinkSync(outside, path.join(x.root, "src", "escape"), "junction"); expect(() => x.service.assertContractWriteScope(x.contract, "src/escape/new.txt")).toThrow(/SCOPE_PATH_ESCAPE/); });
  it("A1_AUTHORITY_CEILING_STILL_PASS", () => { const x = serviceWithAuthority(approved(descriptor("WRITE", ["src"])), descriptor("WRITE", ["docs"])); expect(() => x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.request)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/); });
});
