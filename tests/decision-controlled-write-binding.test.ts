import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionDigest, criticalInputDigest, scopeDigest } from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";
import { TrustedHumanIngressAdapter, TRUSTED_HUMAN_DECISION_SUBMIT_SCOPE } from "../src/task/trusted-human-ingress.js";
import { bindDecisionReceiptToControlledWrite } from "../src/task/decision-controlled-write-binding.js";
import { CONTROLLED_WRITE_MODE, CONTROLLED_WRITE_SCOPE, executeControlledWrite } from "../src/workspace/controlled-write.js";
import { Workspace } from "../src/workspace/manager.js";

const dirs: string[] = [];
function temp(label: string): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function readyContract(now = () => new Date("2026-01-01T00:00:00.000Z")) {
  const root = temp("c2c-decision-write-workspace");
  fs.mkdirSync(path.join(root, "approved"));
  fs.writeFileSync(path.join(root, "approved", "target.md"), "BEFORE");
  const workspace = new Workspace(root);
  const workspaceId = workspace.id;
  const store = new TaskStateStore({ stateDir: temp("c2c-decision-write-state"), now });
  const service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot: temp("c2c-decision-write-contracts"), now });
  const created = store.createTaskState(workspaceId);
  const building = store.transitionTask(workspaceId, created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease(workspaceId, created.taskId, "fixture-owner");
  const owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const scope = { schemaVersion: "scope-descriptor-v1" as const, workspaceId, canonicalRootRelativePaths: ["approved"], accessMode: "WRITE" as const, excludedPaths: [] };
  const descriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "PATCH_EXISTING_TEXT", target: "approved/target.md", approvedScopeDigest: scopeDigest(scope), criticalInput: { before: "BEFORE" }, criticalInputDigest: criticalInputDigest({ before: "BEFORE" }) };
  const fact = { actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) };
  const active = store.beginActiveAction(workspaceId, created.taskId, building.revision, owner, {
    actionId: "active-write", semanticRequestId: "semantic-write", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
    approvedAuthority: { approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: ["PATCH_EXISTING_TEXT"], globalForbiddenActionIds: [] },
    ...fact,
  });
  const packet = {
    schemaVersion: "reasoning-packet-v1" as const, workspaceId, taskId: created.taskId, semanticRequestId: "semantic-write", requestId: "request-write", actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY" as const, currentTaskState: "BUILDING", activeActionId: "active-write", exactIssue: "Isolated fixture.", evidenceRefs: ["fixture:1"], attemptedFixes: ["none"], constraints: ["isolated"], candidateActionIds: ["PATCH_EXISTING_TEXT"], forbiddenActionIds: [], scopeDescriptor: scope, actionDigest: fact.actionDigest,
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
  const waiting = service.createDecisionRequest(workspaceId, active.taskId, active.revision, owner, packet);
  const ingress = new TrustedHumanIngressAdapter({
    decisionService: service, stateStore: store, trustedClientId: "trusted-fixture-client", trustedWorkspaceId: workspaceId, now,
  });
  ingress.submit({
    authInfo: { clientId: "trusted-fixture-client", scopes: [TRUSTED_HUMAN_DECISION_SUBMIT_SCOPE] },
    workspaceId, taskId: waiting.taskId, mutationLeaseOwner: owner,
  }, { decision_request_id: "request-write", disposition: "EXECUTE" });
  const read = store.readTaskState(workspaceId, waiting.taskId);
  if (read.status !== "VALID") throw new Error("TRUSTED_HUMAN_INGRESS_STATE_NOT_FOUND");
  return { root, state: read.state, service, store, owner, workspaceId, taskId: waiting.taskId };
}

function binding(x: ReturnType<typeof readyContract>, target = "approved/target.md", actionClass = "PATCH_EXISTING_TEXT") {
  return bindDecisionReceiptToControlledWrite(x.service, {
    workspaceId: x.workspaceId, taskId: x.taskId, decisionRequestId: "request-write", target, actionClass,
  });
}

describe("recovered decision contract → controlled write fixture", () => {
  it("admits one exact isolated write only after receipt, contract, action class, and target revalidation", () => {
    const x = readyContract(); const { root, state } = x;
    const authorized = binding(x);
    const workspace = new Workspace(root);
    const result = executeControlledWrite({
      taskId: state.taskId, workspaceId: state.workspaceId, targetPath: "approved/target.md", writeMode: CONTROLLED_WRITE_MODE, expectedScope: CONTROLLED_WRITE_SCOPE,
      authorizationRef: authorized.authorization.authorizationRef, reason: "isolated fixture", patch: { expectedContent: "BEFORE", replacementContent: "AFTER" },
      precondition: { expectedHash: crypto.createHash("sha256").update("BEFORE").digest("hex").toUpperCase() },
    }, { workspace, authorization: authorized.authorization, allowedPathPrefixes: authorized.allowedPathPrefixes });
    expect(result.receipt).toMatchObject({ result: "PASS", authorizationResult: "PASS", writeExecuted: true });
    expect(fs.readFileSync(path.join(root, "approved", "target.md"), "utf8")).toBe("AFTER");
  });

  it("fails closed for wrong task, workspace, target, scope, stale receipt, missing receipt, and action class", () => {
    const x = readyContract(); const { root, state } = x;
    const authorized = binding(x);
    const workspace = new Workspace(root);
    const request = { taskId: state.taskId, workspaceId: state.workspaceId, targetPath: "approved/target.md", writeMode: CONTROLLED_WRITE_MODE, expectedScope: CONTROLLED_WRITE_SCOPE, authorizationRef: authorized.authorization.authorizationRef, reason: "isolated fixture", patch: { expectedContent: "BEFORE", replacementContent: "AFTER" }, precondition: { expectedHash: crypto.createHash("sha256").update("BEFORE").digest("hex").toUpperCase() } };
    for (const patch of [{ taskId: "other-task" }, { workspaceId: "other-workspace" }, { targetPath: "approved/other.md" }, { expectedScope: "workspace.read" }]) {
      const outcome = executeControlledWrite({ ...request, ...patch }, { workspace, authorization: authorized.authorization, allowedPathPrefixes: authorized.allowedPathPrefixes });
      expect(outcome.receipt.result).toBe("DENIED");
    }
    expect(() => binding(x, "approved/target.md", "OTHER_ACTION")).toThrow(/ACTION_CLASS_DENIED/);
    expect(() => binding(x, "approved/other.md")).toThrow(/APPROVED_TARGET_MISMATCH/);
    x.store.updateTaskStateUnderMutationLease(x.workspaceId, x.taskId, state.revision, x.owner, current => ({ ...current, activeAction: { ...current.activeAction!, actionEpoch: 2 } }));
    expect(() => binding(x)).toThrow(/CURRENT_DECISION_BINDING_MISMATCH/);
  });

  it("reloads current state and rejects receipt substitution, receipt contract tampering, and action drift", () => {
    const x = readyContract();
    const otherTask = readyContract();
    const otherWorkspace = readyContract();
    const read = x.store.readTaskState(x.workspaceId, x.taskId);
    if (read.status !== "VALID") throw new Error("STATE_NOT_FOUND");
    const replace = (fn: (current: typeof read.state) => typeof read.state) => {
      const current = x.store.readTaskState(x.workspaceId, x.taskId);
      if (current.status !== "VALID") throw new Error("STATE_NOT_FOUND");
      return x.store.updateTaskStateUnderMutationLease(x.workspaceId, x.taskId, current.state.revision, x.owner, fn);
    };
    replace(state => ({ ...state, decisionReceipts: otherTask.state.decisionReceipts }));
    expect(() => binding(x)).toThrow(/DECISION_RECEIPT_BINDING_MISMATCH/);
    replace(state => ({ ...state, decisionReceipts: otherWorkspace.state.decisionReceipts }));
    expect(() => binding(x)).toThrow(/DECISION_RECEIPT_BINDING_MISMATCH/);
    replace(state => ({ ...state, decisionReceipts: [{ ...state.decisionReceipts![0]!, contractId: "other-contract" }] }));
    expect(() => binding(x)).toThrow(/DECISION_RECEIPT_BINDING_MISMATCH/);
    replace(state => ({ ...state, decisionReceipts: [{ ...state.decisionReceipts![0]!, contractDigest: "a".repeat(64) }] }));
    expect(() => binding(x)).toThrow(/DECISION_RECEIPT_BINDING_MISMATCH/);

    const fresh = readyContract();
    const updateAction = (patch: Record<string, unknown>) => {
      const current = fresh.store.readTaskState(fresh.workspaceId, fresh.taskId);
      if (current.status !== "VALID") throw new Error("STATE_NOT_FOUND");
      fresh.store.updateTaskStateUnderMutationLease(fresh.workspaceId, fresh.taskId, current.state.revision, fresh.owner, state => {
        const descriptor = { ...state.activeAction!.actionDescriptor!, ...(patch.actionDescriptor as object | undefined) };
        const authority = patch.authority ?? state.activeAction!.approvedAuthority!;
        return { ...state, activeAction: { ...state.activeAction!, ...patch, approvedAuthority: authority, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } };
      });
    };
    updateAction({ actionId: "other-action" });
    expect(() => binding(fresh)).toThrow(/CURRENT_DECISION_BINDING_MISMATCH/);
    const targetDrift = readyContract();
    const targetState = targetDrift.store.readTaskState(targetDrift.workspaceId, targetDrift.taskId);
    if (targetState.status !== "VALID") throw new Error("STATE_NOT_FOUND");
    targetDrift.store.updateTaskStateUnderMutationLease(targetDrift.workspaceId, targetDrift.taskId, targetState.state.revision, targetDrift.owner, state => {
      const actionDescriptor = { ...state.activeAction!.actionDescriptor!, target: "approved/other.md" };
      return { ...state, activeAction: { ...state.activeAction!, actionDescriptor, actionDigest: actionDigest(actionDescriptor) } };
    });
    expect(() => binding(targetDrift)).toThrow(/CURRENT_DECISION_BINDING_MISMATCH/);
    const classDrift = readyContract();
    const classState = classDrift.store.readTaskState(classDrift.workspaceId, classDrift.taskId);
    if (classState.status !== "VALID") throw new Error("STATE_NOT_FOUND");
    classDrift.store.updateTaskStateUnderMutationLease(classDrift.workspaceId, classDrift.taskId, classState.state.revision, classDrift.owner, state => {
      const actionDescriptor = { ...state.activeAction!.actionDescriptor!, actionType: "OTHER_ACTION" };
      return { ...state, activeAction: { ...state.activeAction!, actionDescriptor, actionDigest: actionDigest(actionDescriptor) } };
    });
    expect(() => binding(classDrift)).toThrow(/CURRENT_DECISION_BINDING_MISMATCH/);
    const scopeDrift = readyContract();
    const scopeState = scopeDrift.store.readTaskState(scopeDrift.workspaceId, scopeDrift.taskId);
    if (scopeState.status !== "VALID") throw new Error("STATE_NOT_FOUND");
    scopeDrift.store.updateTaskStateUnderMutationLease(scopeDrift.workspaceId, scopeDrift.taskId, scopeState.state.revision, scopeDrift.owner, state => {
      const approvedScopeDescriptor = { ...state.activeAction!.approvedAuthority!.approvedScopeDescriptor, canonicalRootRelativePaths: ["other"] };
      const approvedAuthority = { ...state.activeAction!.approvedAuthority!, approvedScopeDescriptor, approvedScopeDigest: scopeDigest(approvedScopeDescriptor) };
      const actionDescriptor = { ...state.activeAction!.actionDescriptor!, approvedScopeDigest: approvedAuthority.approvedScopeDigest };
      return { ...state, activeAction: { ...state.activeAction!, approvedAuthority, actionDescriptor, actionDigest: actionDigest(actionDescriptor) } };
    });
    expect(() => binding(scopeDrift)).toThrow(/CURRENT_DECISION_BINDING_MISMATCH/);
  });
});
