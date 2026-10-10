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
  isScopeSubset,
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

function descriptor(roots: string[], accessMode: "READ_ONLY" | "WRITE" = "WRITE", excludedPaths: string[] = []): ScopeDescriptorV1 {
  return { schemaVersion: "scope-descriptor-v1", workspaceId: "ws", canonicalRootRelativePaths: roots, accessMode, excludedPaths };
}
function authority(scope: ScopeDescriptorV1, actions = ["ACTION_A"]): ApprovedAuthorityV1 {
  return { approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: actions, globalForbiddenActionIds: [] };
}
function actionFacts(scope: ScopeDescriptorV1, approvedScopeDigest = scopeDigest(scope)) {
  const actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest, criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  return { actionDescriptor, actionDigest: actionDigest(actionDescriptor) };
}

function setup(options: { approvedAuthority?: ApprovedAuthorityV1 | null; packetScope?: ScopeDescriptorV1; candidates?: string[] } = {}) {
  const root = directory("c2c-approved-authority-workspace");
  fs.mkdirSync(path.join(root, "src", "private"), { recursive: true }); fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const stateDir = directory("c2c-approved-authority-state"), contractRoot = directory("c2c-approved-authority-contract");
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStateStore({ stateDir, now }); const service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot, now });
  const created = store.createTaskState("ws"); const building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease("ws", created.taskId, "authority_owner"); const owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const approved = options.approvedAuthority === undefined ? authority(descriptor(["src"], "WRITE", ["src/private"])) : options.approvedAuthority;
  const facts = approved === null ? {} : actionFacts(approved.approvedScopeDescriptor, approved.approvedScopeDigest);
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, {
    actionId: "action", semanticRequestId: "semantic", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", ...(approved === null ? {} : { approvedAuthority: approved, ...facts }),
  });
  const packet: ReasoningPacketV1 = {
    schemaVersion: "reasoning-packet-v1", workspaceId: "ws", taskId: created.taskId, semanticRequestId: "semantic", requestId: "request", actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY", currentTaskState: "BUILDING", activeActionId: "action", exactIssue: "Bounded request.", evidenceRefs: ["record:1"], attemptedFixes: [], constraints: ["bounded"],
    candidateActionIds: options.candidates ?? ["ACTION_A"], forbiddenActionIds: [], scopeDescriptor: options.packetScope ?? descriptor(["src"], "WRITE", ["src/private"]), actionDigest: approved === null ? undefined : (facts as ReturnType<typeof actionFacts>).actionDigest,
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
  return { root, store, service, owner, active, packet, approved: approved ?? undefined };
}
function create(x: ReturnType<typeof setup>) { return x.service.createDecisionRequest("ws", x.active.taskId, x.active.revision, x.owner, x.packet); }
function response(packet: ReasoningPacketV1, ids = ["ACTION_A"]) {
  return bindDecisionResponse(packet, reasoningPacketDigest(packet), { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Proceed.", requestedActionIds: ids }, "2026-01-01T00:00:00.000Z");
}
function contract(packet: ReasoningPacketV1, approved: ApprovedAuthorityV1, ids = ["ACTION_A"]) {
  return materializeExecutionContract({ contractId: "contract", packet, packetDigest: reasoningPacketDigest(packet), response: response(packet, ids), approvedAuthority: approved, activeAction: actionFacts(approved.approvedScopeDescriptor) });
}
function redigest<T extends Record<string, unknown>>(value: T): T {
  const copy = { ...value }; delete copy.digest; return { ...copy, digest: sha256(copy) } as T;
}

describe("Approved authority ceiling A1", () => {
  it("APPROVED_AUTHORITY_PERSISTED", () => {
    const x = setup(), read = x.store.readTaskState("ws", x.active.taskId);
    expect(read.status).toBe("VALID"); expect(read.status === "VALID" && read.state.activeAction?.approvedAuthority).toEqual(x.approved!);
  });
  it("APPROVED_SCOPE_CEILING_EQUAL", () => { const x = setup(); expect(create(x).state).toBe("WAITING_DECISION"); });
  it("APPROVED_SCOPE_CHILD_ALLOWED", () => { const x = setup({ packetScope: descriptor(["src/task"], "WRITE", []) }); fs.mkdirSync(path.join(x.root, "src", "task")); expect(create(x).state).toBe("WAITING_DECISION"); });
  it("APPROVED_SCOPE_EXPANSION_DENIED", () => { const x = setup({ packetScope: descriptor(["docs"], "WRITE", []) }); expect(() => create(x)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/); });
  it("APPROVED_ACTION_CEILING_ALLOWED", () => { const x = setup({ candidates: ["ACTION_A"] }); expect(create(x).state).toBe("WAITING_DECISION"); });
  it("APPROVED_ACTION_EXPANSION_DENIED", () => { const x = setup({ candidates: ["ACTION_A", "ACTION_B"] }); expect(() => create(x)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/); });
  it("MISSING_APPROVED_AUTHORITY_DENIED", () => { const x = setup({ approvedAuthority: null }); const state = x.store.readTaskState("ws", x.active.taskId); expect(state.status).toBe("VALID"); expect(() => create(x)).toThrow(/MISSING_APPROVED_AUTHORITY_DENIED/); });
  it("MISSING_APPROVED_SCOPE_DENIED", () => { expect(ApprovedAuthorityV1Schema.safeParse({ approvedScopeDigest: "a".repeat(64), approvedActionIds: ["ACTION_A"] }).success).toBe(false); });
  it("MISSING_APPROVED_ACTIONS_DENIED", () => { expect(ApprovedAuthorityV1Schema.safeParse({ approvedScopeDescriptor: descriptor(["src"]), approvedScopeDigest: "a".repeat(64) }).success).toBe(false); });
  it("APPROVED_SCOPE_DIGEST_RECOMPUTED", () => { const x = setup(); expect(x.approved!.approvedScopeDigest).toBe(scopeDigest(x.approved!.approvedScopeDescriptor)); });
  it("APPROVED_SCOPE_DIGEST_MISMATCH_DENIED", () => { const x = setup({ approvedAuthority: { ...authority(descriptor(["src"])), approvedScopeDigest: "0".repeat(64) } }); expect(() => create(x)).toThrow(/APPROVED_SCOPE_DIGEST_MISMATCH/); });
  it("PACKET_SCOPE_CANNOT_EXPAND_APPROVED_SCOPE", () => { const x = setup({ packetScope: descriptor(["src"], "WRITE", []) }); expect(() => create(x)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/); });
  it("PACKET_ACTIONS_CANNOT_EXPAND_APPROVED_ACTIONS", () => { const x = setup({ candidates: ["ACTION_A", "ACTION_B"] }); expect(() => create(x)).toThrow(/APPROVED_AUTHORITY_CEILING_DENIED/); });
  it("CONTRACT_SCOPE_CANNOT_EXPAND_PACKET_SCOPE", () => {
    const x = setup(), base = contract(x.packet, x.approved!), tampered = redigest({ ...base, scopeDescriptor: descriptor(["docs"], "WRITE", []) });
    expect(() => validateContractBinding(tampered, base.binding, new Date("2026-01-01T01:00:00.000Z"))).toThrow(/CONTRACT_SCOPE_PACKET_EXPANSION/);
  });
  it("CONTRACT_SCOPE_CANNOT_EXPAND_APPROVED_SCOPE", () => {
    const x = setup(), packet = { ...x.packet, scopeDescriptor: descriptor(["docs"], "WRITE", []) };
    expect(() => contract(packet, x.approved!)).toThrow(/CONTRACT_SCOPE_AUTHORITY_EXPANSION/);
  });
  it("CONTRACT_ACTION_CANNOT_EXPAND_PACKET_ACTIONS", () => {
    const x = setup(); expect(() => contract(x.packet, x.approved!, ["ACTION_B"])).toThrow(/CONTRACT_ACTION_SCOPE_EXPANSION/);
  });
  it("CONTRACT_ACTION_CANNOT_EXPAND_APPROVED_ACTIONS", () => {
    const x = setup(), packet = { ...x.packet, candidateActionIds: ["ACTION_A", "ACTION_B"] };
    expect(() => contract(packet, x.approved!, ["ACTION_B"])).toThrow(/CONTRACT_ACTION_AUTHORITY_EXPANSION/);
  });
  it("WINDOWS_PATH_NORMALIZATION_STILL_SAFE", () => {
    const root = directory("c2c-approved-authority-paths"); fs.mkdirSync(path.join(root, "src", "private"), { recursive: true });
    const parent = canonicalizeScopeDescriptor(root, descriptor(["src\\"], "WRITE", ["src\\private"]));
    const child = canonicalizeScopeDescriptor(root, descriptor(["src\\task"], "WRITE", [])); fs.mkdirSync(path.join(root, "src", "task"));
    expect(isScopeSubset(child, parent)).toBe(true); expect(() => canonicalizeScopeDescriptor(root, descriptor(["src\\..\\docs"], "WRITE", []))).toThrow(/SCOPE_PATH_ESCAPE/);
  });
  it("PATH_TRAVERSAL_STILL_DENIED", () => { const x = setup(); expect(() => x.service.assertContractWriteScope(contract(x.packet, x.approved!), "../outside")).toThrow(/SCOPE_PATH_ESCAPE/); });
  it("SYMLINK_ESCAPE_STILL_DENIED", () => {
    const x = setup(), outside = directory("c2c-approved-authority-outside"); fs.symlinkSync(outside, path.join(x.root, "src", "escape"), "junction");
    expect(() => canonicalizeScopeDescriptor(x.root, descriptor(["src/escape/new-file"], "WRITE", []))).toThrow(/SCOPE_PATH_ESCAPE/);
  });
});
