import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendExecutionRecord } from "../src/execution/records.js";
import { actionDigest, criticalInputDigest, reasoningPacketDigest, scopeDigest } from "../src/task/decision-protocol.js";
import { DecisionService, DecisionServiceError } from "../src/task/decision-service.js";
import { TaskStateStore } from "../src/task/state.js";

const dirs: string[] = [];
function directory(label: string): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); delete process.env.C2C_STATE_DIR; });

function setup() {
  const root = directory("c2c-decision-workspace"); fs.mkdirSync(path.join(root, "src"));
  const stateRoot = directory("c2c-decision-state"), contractRoot = directory("c2c-decision-contract"), executionRoot = directory("c2c-decision-execution");
  process.env.C2C_STATE_DIR = executionRoot;
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStateStore({ stateDir: stateRoot, now });
  const service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot, now });
  const created = store.createTaskState("ws");
  const building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING");
  const ownerLease = store.acquireWorkspaceMutationLease("ws", created.taskId, "owner");
  const owner = { leaseId: ownerLease.leaseId, ownerSessionMarker: ownerLease.ownerSessionMarker };
  const approvedScopeDescriptor = { schemaVersion: "scope-descriptor-v1" as const, workspaceId: "ws", canonicalRootRelativePaths: ["src"], accessMode: "WRITE" as const, excludedPaths: [] };
  const actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(approvedScopeDescriptor), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  const actionFact = { actionDescriptor, actionDigest: actionDigest(actionDescriptor) };
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, { actionId: "action", semanticRequestId: "semantic", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", approvedAuthority: { approvedScopeDescriptor, approvedScopeDigest: scopeDigest(approvedScopeDescriptor), approvedActionIds: ["ACTION_A", "ACTION_FORBIDDEN"], globalForbiddenActionIds: [] }, ...actionFact });
  const packet = {
    schemaVersion: "reasoning-packet-v1" as const, workspaceId: "ws", taskId: created.taskId, semanticRequestId: "semantic", requestId: "request", actionEpoch: 1,
    gateKind: "SPECIFICATION_AMBIGUITY" as const, currentTaskState: "BUILDING", activeActionId: "action", exactIssue: "Ambiguous expected output.", evidenceRefs: ["record:1"], attemptedFixes: ["reproduced"], constraints: ["no production"], candidateActionIds: ["ACTION_A", "ACTION_FORBIDDEN"], forbiddenActionIds: ["ACTION_FORBIDDEN"],
    scopeDescriptor: { schemaVersion: "scope-descriptor-v1" as const, workspaceId: "ws", canonicalRootRelativePaths: ["src"], accessMode: "WRITE" as const, excludedPaths: [] }, actionDigest: actionFact.actionDigest,
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
  return { root, store, service, owner, state: active, packet, contractRoot };
}

function waiting(x: ReturnType<typeof setup>) { return x.service.createDecisionRequest("ws", x.state.taskId, x.state.revision, x.owner, x.packet); }
function execute(x: ReturnType<typeof setup>) {
  const pending = waiting(x);
  return x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Perform A.", requestedActionIds: ["ACTION_A"] });
}

describe("Decision Service V1", () => {
  it("persists WAIT_REASONING then WAITING_DECISION and supports restart recovery", () => {
    const x = setup();
    // A malformed packet digest cannot enter durable TaskState.
    expect(() => x.store.updateTaskStateUnderMutationLease("ws", x.state.taskId, x.state.revision, x.owner, (state) => ({ ...state, state: "WAIT_REASONING", reasoningCycle: state.reasoningCycle + 1, pendingReasoning: { packet: x.packet, packetDigest: "bad", status: "WAIT_REASONING", createdAt: "2026-01-01T00:00:00.000Z" } }))).toThrow(/TASK_STATE_SCHEMA_INVALID/);
    const normal = setup(), digest = reasoningPacketDigest(normal.packet);
    const interrupted = normal.store.updateTaskStateUnderMutationLease("ws", normal.state.taskId, normal.state.revision, normal.owner, (state) => ({ ...state, state: "WAIT_REASONING", reasoningCycle: state.reasoningCycle + 1, pendingReasoning: { packet: normal.packet, packetDigest: digest, status: "WAIT_REASONING", createdAt: "2026-01-01T00:00:00.000Z" } }));
    const complete = normal.service.recoverDecisionRequest("ws", interrupted.taskId, interrupted.revision, normal.owner);
    expect(complete.state).toBe("WAITING_DECISION"); expect(complete.pendingReasoning?.status).toBe("WAITING_DECISION");
    expect(normal.service.readPendingDecision("ws", complete.taskId, "request").requestId).toBe("request");
  });

  it("materializes a local immutable contract and rejects duplicate or wrong binding submissions", () => {
    const x = setup(), complete = execute(x);
    expect(complete.state).toBe("CONTRACT_READY"); expect(complete.activeContract?.lifecycle).toBe("READY");
    expect(fs.existsSync(complete.activeContract!.artifactPath)).toBe(true);
    expect(() => x.service.submitDecisionResponse("ws", complete.taskId, complete.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: "second", disposition: "EXECUTE", summary: "again", requestedActionIds: ["ACTION_A"] })).toThrow(/DECISION_RESPONSE_CONFLICT/);
    expect(() => x.service.readPendingDecision("other", complete.taskId, "request")).toThrow(/DECISION_REQUEST_NOT_FOUND/);
  });

  it("rejects wrong Task, semantic identity, action epoch, scope workspace, and expired packets before they can create a request", () => {
    for (const patch of [
      { workspaceId: "other" }, { taskId: "other" }, { semanticRequestId: "other" }, { actionEpoch: 2 },
      { scopeDescriptor: { ...setup().packet.scopeDescriptor, workspaceId: "other" } }, { validUntil: "2025-01-01T00:00:00.000Z" },
    ]) {
      const x = setup();
      expect(() => x.service.createDecisionRequest("ws", x.state.taskId, x.state.revision, x.owner, { ...x.packet, ...patch })).toThrow();
    }
  });

  it("uses the same finite-and-future active-action expiry rule before new Decision materialization", () => {
    for (const validUntil of ["", "not-a-date", "2026-01-01T00:00:00.000Z", "2025-12-31T23:59:59.000Z"]) {
      const x = setup();
      const changed = x.store.updateTaskStateUnderMutationLease("ws", x.state.taskId, x.state.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, validUntil } }));
      expect(() => x.service.createDecisionRequest("ws", changed.taskId, changed.revision, x.owner, x.packet)).toThrow(/ACTIVE_ACTION_EXPIRED/);
      const after = x.store.readTaskState("ws", changed.taskId);
      expect(after).toMatchObject({ status: "VALID", state: { revision: changed.revision, state: "BUILDING" } });
    }
  });

  it("does not create a Contract for Human Gate or STOP", () => {
    for (const disposition of ["HUMAN_GATE_REQUIRED", "STOP"] as const) {
      const x = setup(), pending = waiting(x);
      const next = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: `response_${disposition}`, disposition, summary: disposition, requestedActionIds: [] });
      expect(next.activeContract).toBeUndefined(); expect(next.state).toBe(disposition === "STOP" ? "STOPPED" : "HUMAN_GATE_REQUIRED");
    }
  });

  it("persists Decision constraints to the immutable Contract and keeps constrained retries idempotent", () => {
    const x = setup(), pending = waiting(x);
    const constrained = { schemaVersion: "decision-response-v1", responseId: "constrained", disposition: "EXECUTE" as const, summary: "Proceed only under the declared conditions.", requestedActionIds: ["ACTION_A"], preconditions: ["Tests pass"], acceptanceCriteria: ["Read back the result"], stopConditions: ["Scope changes"] };
    const first = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", constrained);
    const artifact = JSON.parse(fs.readFileSync(first.activeContract!.artifactPath, "utf8"));
    expect(artifact.preconditions).toEqual(["Tests pass", "no production"]);
    expect(artifact.acceptanceCriteria).toContain("Read back the result");
    expect(artifact.stopConditions).toContain("Scope changes");
    const retry = x.service.submitDecisionResponse("ws", first.taskId, pending.revision, x.owner, "request", constrained);
    expect(retry.activeContract?.contractId).toBe(first.activeContract?.contractId);
    expect(() => x.service.submitDecisionResponse("ws", first.taskId, pending.revision, x.owner, "request", { ...constrained, preconditions: ["Different precondition"] })).toThrow(/DECISION_RESPONSE_CONFLICT/);
    expect(() => x.service.submitDecisionResponse("ws", first.taskId, pending.revision, x.owner, "request", { ...constrained, acceptanceCriteria: ["Different acceptance"] })).toThrow(/DECISION_RESPONSE_CONFLICT/);
    expect(() => x.service.submitDecisionResponse("ws", first.taskId, pending.revision, x.owner, "request", { ...constrained, stopConditions: ["Different stop"] })).toThrow(/DECISION_RESPONSE_CONFLICT/);
  });

  it("denies historical retries after active-action identity or expiry drift, including CAS reload, without minting another receipt or Contract", () => {
    const response = { schemaVersion: "decision-response-v1" as const, responseId: "response", disposition: "EXECUTE" as const, summary: "Perform A.", requestedActionIds: ["ACTION_A"] };
    for (const patch of [{ actionId: "replacement-action" }, { validUntil: "2025-12-31T23:59:59.000Z" }]) {
      const x = setup(), pending = waiting(x);
      const first = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", response);
      const changed = x.store.updateTaskStateUnderMutationLease("ws", first.taskId, first.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, ...patch } }));
      for (const revision of [changed.revision, first.revision]) {
        expect(() => x.service.submitDecisionResponse("ws", first.taskId, revision, x.owner, "request", response)).toThrow(/HISTORICAL_RECEIPT_ACTION_CONFLICT/);
      }
      const after = x.store.readTaskState("ws", first.taskId);
      expect(after).toMatchObject({ status: "VALID", state: { revision: changed.revision, decisionReceipts: [first.decisionReceipts![0]] } });
      expect(fs.readdirSync(path.join(x.contractRoot, "ws")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    }
  });

  it("fails closed for malformed active expiry across EXECUTE, STOP, and HUMAN_GATE_REQUIRED retries, including CAS reload", () => {
    const responses = [
      { schemaVersion: "decision-response-v1" as const, responseId: "execute", disposition: "EXECUTE" as const, summary: "Perform A.", requestedActionIds: ["ACTION_A"] },
      { schemaVersion: "decision-response-v1" as const, responseId: "stop", disposition: "STOP" as const, summary: "Stop.", requestedActionIds: [] },
      { schemaVersion: "decision-response-v1" as const, responseId: "human", disposition: "HUMAN_GATE_REQUIRED" as const, summary: "Human gate.", requestedActionIds: [] },
    ];
    for (const response of responses) for (const validUntil of ["", "not-a-date"]) {
      const x = setup(), pending = waiting(x);
      const first = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", response);
      const changed = x.store.updateTaskStateUnderMutationLease("ws", first.taskId, first.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, validUntil } }));
      for (const revision of [changed.revision, first.revision]) {
        expect(() => x.service.submitDecisionResponse("ws", first.taskId, revision, x.owner, "request", response)).toThrow(/HISTORICAL_RECEIPT_ACTION_CONFLICT/);
      }
      const after = x.store.readTaskState("ws", first.taskId);
      expect(after).toMatchObject({ status: "VALID", state: { revision: changed.revision, decisionReceipts: [first.decisionReceipts![0]] } });
      expect(fs.existsSync(path.join(x.contractRoot, "ws")) ? fs.readdirSync(path.join(x.contractRoot, "ws")).filter((name) => name.endsWith(".json")) : []).toHaveLength(response.disposition === "EXECUTE" ? 1 : 0);
    }
  });

  it("rejects exact-now and past active expiry while a valid future expiry keeps retry idempotent", () => {
    const response = { schemaVersion: "decision-response-v1" as const, responseId: "response", disposition: "EXECUTE" as const, summary: "Perform A.", requestedActionIds: ["ACTION_A"] };
    for (const validUntil of ["2026-01-01T00:00:00.000Z", "2025-12-31T23:59:59.000Z"]) {
      const x = setup(), pending = waiting(x);
      const first = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", response);
      const changed = x.store.updateTaskStateUnderMutationLease("ws", first.taskId, first.revision, x.owner, (state) => ({ ...state, activeAction: { ...state.activeAction!, validUntil } }));
      expect(() => x.service.submitDecisionResponse("ws", first.taskId, changed.revision, x.owner, "request", response)).toThrow(/HISTORICAL_RECEIPT_ACTION_CONFLICT/);
    }
    const x = setup(), pending = waiting(x);
    const first = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", response);
    expect(x.service.submitDecisionResponse("ws", first.taskId, pending.revision, x.owner, "request", response).decisionReceipts).toEqual(first.decisionReceipts);
  });

  it("uses READY -> APPLYING -> CONSUMED and does not duplicate an execution receipt after crash recovery", () => {
    const x = setup(), ready = execute(x);
    const begun = x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "action", "ACTION_A", ready.activeContract!.binding.scopeDigest);
    expect(begun.state.activeContract?.lifecycle).toBe("APPLYING");
    expect(x.service.recoverContractConsumption("ws", begun.state.taskId, begun.state.revision, x.owner)).toBe("RESUME_SAME_CONSUMPTION");
    const started = x.service.markMutationStarted("ws", begun.state.taskId, begun.state.revision, x.owner, begun.consumptionId);
    const receipt = appendExecutionRecord("ws", { taskId: begun.state.taskId, iteration: 1, changedFiles: 1, tests: "ok", exitStatus: "ok", timestamp: "2026-01-01T00:00:00.000Z", contractId: ready.activeContract!.contractId, consumptionId: begun.consumptionId, resultDigest: "a".repeat(64) });
    expect(x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toBe("RECEIPT_FINALIZED");
    const consumed = x.store.readTaskState("ws", started.taskId);
    expect(consumed.status).toBe("VALID"); expect(consumed.state.activeContract).toMatchObject({ lifecycle: "CONSUMED", executionRecordId: receipt.recordId, resultDigest: "a".repeat(64) });
    expect(x.service.recoverContractConsumption("ws", started.taskId, consumed.state.revision, x.owner)).toBe("ALREADY_CONSUMED");
  });

  it("fails closed for ambiguous APPLYING, active-action conflict, and write scope expansion", () => {
    const x = setup(), ready = execute(x);
    const begun = x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "action", "ACTION_A", ready.activeContract!.binding.scopeDigest);
    const started = x.service.markMutationStarted("ws", begun.state.taskId, begun.state.revision, x.owner, begun.consumptionId);
    expect(() => x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toThrow(/REPLAY_NOT_PROVEN/);
    const contract = JSON.parse(fs.readFileSync(ready.activeContract!.artifactPath, "utf8"));
    expect(() => x.service.assertContractWriteScope(contract, "../escape")).toThrow(/SCOPE_PATH_ESCAPE/);
    expect(() => x.service.beginContractConsumption("ws", started.taskId, started.revision, x.owner, "other", "OTHER", ready.activeContract!.binding.scopeDigest)).toThrow(/CONSUMPTION_REQUEST_CONFLICT/);
  });

  it("rejects a Contract-declared forbidden action before mutation starts", () => {
    const x = setup(), pending = waiting(x);
    const ready = x.service.submitDecisionResponse("ws", pending.taskId, pending.revision, x.owner, "request", { schemaVersion: "decision-response-v1", responseId: "forbidden", disposition: "EXECUTE", summary: "forbidden", requestedActionIds: ["ACTION_FORBIDDEN"] });
    expect(() => x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "action", "ACTION_FORBIDDEN", ready.activeContract!.binding.scopeDigest)).toThrow(/CONTRACT_ACTION_FORBIDDEN/);
  });

  it("rejects wrong action, scope digest, and artifact path while same consumption retry is idempotent", () => {
    const x = setup(), ready = execute(x);
    expect(() => x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "other", "ACTION_A", ready.activeContract!.binding.scopeDigest)).toThrow(/ACTIVE_ACTION_CONFLICT/);
    expect(() => x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "action", "ACTION_A", "0".repeat(64))).toThrow(/CONTRACT_SCOPE_DIGEST_MISMATCH/);
    const begun = x.service.beginContractConsumption("ws", ready.taskId, ready.revision, x.owner, "action", "ACTION_A", ready.activeContract!.binding.scopeDigest);
    const retry = x.service.beginContractConsumption("ws", begun.state.taskId, begun.state.revision, x.owner, "action", "ACTION_A", ready.activeContract!.binding.scopeDigest);
    expect(retry.consumptionId).toBe(begun.consumptionId); expect(retry.state.revision).toBe(begun.state.revision);
    const y = setup(), other = execute(y);
    const tampered = y.store.updateTaskStateUnderMutationLease("ws", other.taskId, other.revision, y.owner, (state) => ({ ...state, activeContract: { ...state.activeContract!, artifactPath: path.join(y.contractRoot, "outside.json") } }));
    expect(() => y.service.beginContractConsumption("ws", tampered.taskId, tampered.revision, y.owner, "action", "ACTION_A", other.activeContract!.binding.scopeDigest)).toThrow(/CONTRACT_ARTIFACT_PATH_MISMATCH/);
  });
});
