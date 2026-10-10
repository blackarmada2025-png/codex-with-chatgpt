import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { appendExecutionRecord, type ExecutionRecord } from "../src/execution/records.js";
import { actionDigest, criticalInputDigest, scopeDigest } from "../src/task/decision-protocol.js";
import { DecisionService } from "../src/task/decision-service.js";
import { TaskStateStore, type MutationLeaseOwner, type TaskState } from "../src/task/state.js";

const dirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
let nowValue = "2026-01-01T00:00:00.000Z";
const now = () => new Date(nowValue);
function temp(name: string) { const value = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(value); return value; }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Contender = { result: Promise<string>; failure: () => Error | undefined };
async function waitFor(files: string[], children: Contender[] = []) { for (let index = 0; index < 2_500; index++) { const failure = children.map((child) => child.failure()).find(Boolean); if (failure) throw failure; if (files.every(fs.existsSync)) return; await wait(2); } throw new Error(`fixture timeout before ready: ${files.join(",")}`); }
function contender(args: string[], ready: string): Contender { let failure: Error | undefined; const result = new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), path.join(process.cwd(), "tests", "fixtures", "contract-consumption-contender.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let out = "", err = ""; child.stdout.on("data", (value) => out += value); child.stderr.on("data", (value) => err += value); child.on("error", (error) => { failure = new Error(`child spawn error; ready=${fs.existsSync(ready)}; stdout=${out}; stderr=${err}; error=${String(error)}`); reject(failure); }); child.on("exit", (code, signal) => { if (code === 0) { resolve(out.trim()); return; } failure = new Error(`child exit code=${code}; signal=${signal}; ready=${fs.existsSync(ready)}; stdout=${out}; stderr=${err}`); reject(failure); }); }); result.catch(() => {}); return { result, failure: () => failure }; }
afterEach(() => { nowValue = "2026-01-01T00:00:00.000Z"; while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previousStateDir; });

function setup() {
  const root = temp("b3-root"); fs.mkdirSync(path.join(root, "src"));
  const stateRoot = temp("b3-state"); process.env.C2C_STATE_DIR = stateRoot;
  const contractRoot = temp("b3-contract");
  const store = new TaskStateStore({ stateDir: stateRoot, now });
  const service = new DecisionService({ workspaceRoot: root, stateStore: store, contractRoot, now });
  const created = store.createTaskState("ws"), building = store.transitionTask("ws", created.taskId, created.revision, "BUILDING");
  const lease = store.acquireWorkspaceMutationLease("ws", created.taskId, "b3_owner"), owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
  const scope = { schemaVersion: "scope-descriptor-v1" as const, workspaceId: "ws", canonicalRootRelativePaths: ["src"], accessMode: "WRITE" as const, excludedPaths: [] };
  const descriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  const active = store.beginActiveAction("ws", created.taskId, building.revision, owner, { actionId: "action_1", semanticRequestId: "semantic_A", actionEpoch: 1, validUntil: "2026-01-02T00:00:00.000Z", startedAt: now().toISOString(), approvedAuthority: { approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: ["ACTION_A"], globalForbiddenActionIds: [] }, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) });
  const packet = { schemaVersion: "reasoning-packet-v1" as const, workspaceId: "ws", taskId: created.taskId, semanticRequestId: "semantic_A", requestId: "request_1", actionEpoch: 1, gateKind: "SPECIFICATION_AMBIGUITY" as const, currentTaskState: "BUILDING", activeActionId: "action_1", exactIssue: "bounded", evidenceRefs: ["e1"], attemptedFixes: [], constraints: ["bounded"], candidateActionIds: ["ACTION_A"], forbiddenActionIds: [], scopeDescriptor: scope, actionDigest: actionDigest(descriptor), createdAt: now().toISOString(), validUntil: "2026-01-02T00:00:00.000Z" };
  const pending = service.createDecisionRequest("ws", active.taskId, active.revision, owner, packet);
  const ready = service.submitDecisionResponse("ws", pending.taskId, pending.revision, owner, "request_1", { schemaVersion: "decision-response-v1", responseId: "response_1", disposition: "EXECUTE", summary: "execute", requestedActionIds: ["ACTION_A"] });
  return { root, stateRoot, contractRoot, store, service, owner, ready };
}
function begin(x: ReturnType<typeof setup>, revision = x.ready.revision) { return x.service.beginContractConsumption("ws", x.ready.taskId, revision, x.owner, "action_1", "ACTION_A", x.ready.activeContract!.binding.scopeDigest); }
function record(x: ReturnType<typeof setup>, begun: ReturnType<typeof begin>, patch: Record<string, unknown> = {}) { return appendExecutionRecord("ws", { taskId: begun.state.taskId, iteration: 1, changedFiles: 1, tests: "ok", exitStatus: "ok", timestamp: now().toISOString(), contractId: x.ready.activeContract!.contractId, consumptionId: begun.consumptionId, resultDigest: "a".repeat(64), ...patch }); }
function mutateState(x: ReturnType<typeof setup>, state: TaskState, mutate: (current: TaskState) => TaskState): TaskState {
  return x.store.updateTaskStateUnderMutationLease("ws", state.taskId, state.revision, x.owner, mutate);
}
function finalizeWithDurableCasCollision(x: ReturnType<typeof setup>, started: TaskState, receipt: ExecutionRecord, mutate: (current: TaskState) => TaskState, expected: RegExp): TaskState {
  const original = x.store.updateTaskStateUnderMutationLease.bind(x.store);
  let collisionObserved = false;
  x.store.updateTaskStateUnderMutationLease = (workspaceId: string, taskId: string, revision: number, owner: MutationLeaseOwner, updater: (current: TaskState) => TaskState): TaskState => {
    if (!collisionObserved) {
      collisionObserved = true;
      const rival = new TaskStateStore({ stateDir: x.stateRoot, now });
      rival.updateTaskStateUnderMutationLease(workspaceId, taskId, revision, owner, mutate);
    }
    return original(workspaceId, taskId, revision, owner, updater);
  };
  try {
    expect(() => x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, started.activeContract!.consumptionId!, receipt.recordId!, receipt.resultDigest!)).toThrow(expected);
  } finally {
    x.store.updateTaskStateUnderMutationLease = original;
  }
  expect(collisionObserved).toBe(true);
  const after = x.store.readTaskState("ws", started.taskId);
  expect(after.status).toBe("VALID");
  if (after.status !== "VALID") throw new Error("fixture durable state unavailable");
  expect(after.state.revision).toBe(started.revision + 1);
  expect(after.state.activeContract?.lifecycle).toBe("APPLYING");
  expect(after.state.activeAction?.resolvedAt).toBeUndefined();
  return after.state;
}

describe("B3 contract consumption idempotency and crash recovery", () => {
  it("BEGIN_READY_CREATES_ONE_CONSUMPTION DUPLICATE_BEGIN_SAME_REQUEST_RETURNS_SAME_CONSUMPTION_ID DUPLICATE_BEGIN_ZERO_SECOND_STATE_ADVANCE", () => {
    const x = setup(), first = begin(x), retry = begin(x, x.ready.revision);
    expect(first.state.activeContract?.lifecycle).toBe("APPLYING"); expect(retry.consumptionId).toBe(first.consumptionId); expect(retry.state.revision).toBe(first.state.revision);
  });
  it("DUPLICATE_BEGIN_DIFFERENT_ACTION_DENIED DUPLICATE_BEGIN_DIFFERENT_SCOPE_DENIED DUPLICATE_BEGIN_DIFFERENT_ACTION_DIGEST_DENIED", () => {
    const x = setup(), first = begin(x), digest = x.ready.activeContract!.binding.scopeDigest;
    expect(() => x.service.beginContractConsumption("ws", first.state.taskId, first.state.revision, x.owner, "other", "ACTION_A", digest)).toThrow(/CONSUMPTION_REQUEST_CONFLICT/);
    expect(() => x.service.beginContractConsumption("ws", first.state.taskId, first.state.revision, x.owner, "action_1", "ACTION_A", "0".repeat(64))).toThrow(/CONSUMPTION_REQUEST_CONFLICT|CONTRACT_SCOPE_DIGEST_MISMATCH/);
    const tampered = x.store.updateTaskStateUnderMutationLease("ws", first.state.taskId, first.state.revision, x.owner, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, criticalInput: { version: "2" }, criticalInputDigest: criticalInputDigest({ version: "2" }) }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => x.service.beginContractConsumption("ws", tampered.taskId, tampered.revision, x.owner, "action_1", "ACTION_A", digest)).toThrow(/ACTION_DIGEST_MISMATCH/);
  });
  it("CRASH_APPLYING_BEFORE_MUTATION_RESUMES_SAME_CONSUMPTION CAS_BEGIN_RELOAD_REVALIDATE", () => {
    const x = setup(), first = begin(x), before = first.state.revision;
    expect(x.service.recoverContractConsumption("ws", first.state.taskId, before, x.owner)).toBe("RESUME_SAME_CONSUMPTION");
    const retry = begin(x, x.ready.revision); expect(retry.consumptionId).toBe(first.consumptionId); expect(retry.state.revision).toBe(before);
  });
  it("MUTATION_START_MARKER CRASH_AFTER_MUTATION_STARTED_WITHOUT_RECORD_FAILS_CLOSED AMBIGUOUS_APPLYING_REPLAY_NOT_PROVEN", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId);
    expect(started.activeContract?.mutationStartedAt).toBeDefined(); expect(() => x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toThrow(/REPLAY_NOT_PROVEN/);
  });
  it("EXPIRED_CONTRACT_MARK_DENIED DUPLICATE_MUTATION_MARK_DENIED RECOVERY_REMARK_DENIED BEGIN_LOOKUP_DOES_NOT_REAUTHORIZE", () => {
    const x = setup(), first = begin(x);
    nowValue = "2026-01-03T00:00:00.000Z";
    expect(() => x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId)).toThrow(/CONTRACT_EXPIRED/);
    const expired = x.store.readTaskState("ws", first.state.taskId); expect(expired.status === "VALID" && expired.state.revision).toBe(first.state.revision); expect(expired.status === "VALID" && expired.state.activeContract?.mutationStartedAt).toBeUndefined();

    nowValue = "2026-01-01T00:00:00.000Z";
    const started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId);
    expect(() => x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toThrow(/REPLAY_NOT_PROVEN/);
    const lookup = begin(x, x.ready.revision); expect(lookup.consumptionId).toBe(first.consumptionId); expect(lookup.state.revision).toBe(started.revision);
    expect(() => x.service.markMutationStarted("ws", lookup.state.taskId, lookup.state.revision, x.owner, lookup.consumptionId)).toThrow(/MUTATION_ALREADY_STARTED_NON_AUTHORIZING/);
    const after = x.store.readTaskState("ws", started.taskId); expect(after.status === "VALID" && after.state.revision).toBe(started.revision); expect(after.status === "VALID" && after.state.activeContract?.mutationStartedAt).toBe(started.activeContract?.mutationStartedAt);
  });
  it("MARK_REVALIDATES_ACTION_EPOCH_ACTION_DIGEST_AND_SCOPE_BEFORE_MUTATION", () => {
    const epoch = setup(), epochFirst = begin(epoch);
    const epochChanged = mutateState(epoch, epochFirst.state, state => ({ ...state, activeAction: { ...state.activeAction!, actionEpoch: 2 } }));
    expect(() => epoch.service.markMutationStarted("ws", epochChanged.taskId, epochChanged.revision, epoch.owner, epochFirst.consumptionId)).toThrow(/ACTIVE_ACTION_CONFLICT/);

    const digest = setup(), digestFirst = begin(digest);
    const digestChanged = mutateState(digest, digestFirst.state, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, criticalInput: { version: "2" }, criticalInputDigest: criticalInputDigest({ version: "2" }) }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => digest.service.markMutationStarted("ws", digestChanged.taskId, digestChanged.revision, digest.owner, digestFirst.consumptionId)).toThrow(/ACTION_DIGEST_MISMATCH/);

    const scope = setup(), scopeFirst = begin(scope);
    const scopeChanged = mutateState(scope, scopeFirst.state, state => ({ ...state, activeAction: { ...state.activeAction!, approvedAuthority: { ...state.activeAction!.approvedAuthority!, approvedScopeDigest: "b".repeat(64) } } }));
    expect(() => scope.service.markMutationStarted("ws", scopeChanged.taskId, scopeChanged.revision, scope.owner, scopeFirst.consumptionId)).toThrow(/APPROVED_SCOPE_DIGEST_MISMATCH/);
  });
  it("MARK_REVALIDATES_TARGET_ACTION_CLASS_AND_GLOBAL_DENY_BEFORE_MUTATION", () => {
    const target = setup(), targetFirst = begin(target);
    const targetChanged = mutateState(target, targetFirst.state, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, target: "src/b.ts" }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => target.service.markMutationStarted("ws", targetChanged.taskId, targetChanged.revision, target.owner, targetFirst.consumptionId)).toThrow(/ACTION_DIGEST_MISMATCH/);

    const actionClass = setup(), actionClassFirst = begin(actionClass);
    const actionClassChanged = mutateState(actionClass, actionClassFirst.state, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, actionType: "DELETE_FILE" }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => actionClass.service.markMutationStarted("ws", actionClassChanged.taskId, actionClassChanged.revision, actionClass.owner, actionClassFirst.consumptionId)).toThrow(/ACTION_DIGEST_MISMATCH/);

    const denied = setup(), deniedFirst = begin(denied);
    const deniedState = mutateState(denied, deniedFirst.state, state => ({ ...state, activeAction: { ...state.activeAction!, approvedAuthority: { ...state.activeAction!.approvedAuthority!, globalForbiddenActionIds: ["ACTION_A"] } } }));
    expect(() => denied.service.markMutationStarted("ws", deniedState.taskId, deniedState.revision, denied.owner, deniedFirst.consumptionId)).toThrow(/GLOBAL_DENY_ACTION/);
  });
  it("MARK_STALE_CAS_CANNOT_RELOAD_AND_REAUTHORIZE", () => {
    const x = setup(), first = begin(x);
    const rival = new TaskStateStore({ stateDir: x.stateRoot, now });
    const changed = rival.updateTaskStateUnderMutationLease("ws", first.state.taskId, first.state.revision, x.owner, state => ({ ...state, activeAction: { ...state.activeAction!, actionEpoch: 2 } }));
    expect(() => x.service.markMutationStarted("ws", changed.taskId, first.state.revision, x.owner, first.consumptionId)).toThrow(/STALE_TASK_STATE/);
    const after = x.store.readTaskState("ws", changed.taskId); expect(after.status === "VALID" && after.state.activeContract?.mutationStartedAt).toBeUndefined();
  });
  it("EXECUTION_RECORD_WITHOUT_MUTATION_MARKER_DENIED FINALIZE_WITHOUT_MUTATION_MARKER_DENIED RECOVERY_WITH_RECORD_BUT_NO_MARKER_DENIED", () => {
    const x = setup(), first = begin(x), receipt = record(x, first);
    expect(() => x.service.finalizeContractConsumption("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/MUTATION_START_NOT_PROVEN/);
    expect(() => x.service.recoverContractConsumption("ws", first.state.taskId, first.state.revision, x.owner)).toThrow(/MUTATION_START_NOT_PROVEN/);
  });
  it("CRASH_AFTER_EXECUTION_RECORD_BEFORE_RECEIPT_FINALIZES_ONLY_RECEIPT EXECUTION_RECORD_RECOVERY", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    expect(x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toBe("RECEIPT_FINALIZED");
    const after = x.store.readTaskState("ws", started.taskId); expect(after.status).toBe("VALID"); expect(after.status === "VALID" && after.state.activeContract).toMatchObject({ lifecycle: "CONSUMED", executionRecordId: receipt.recordId, resultDigest: "a".repeat(64) });
  });
  it("FINALIZE_VALID_RECORD_CONSUMED DUPLICATE_FINALIZE_IDEMPOTENT DUPLICATE_FINALIZE_RETURNS_ORIGINAL_RECEIPT CONSUMED_RETRY_RECEIPT", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const consumed = x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    const retry = x.service.finalizeContractConsumption("ws", consumed.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    expect(retry.revision).toBe(consumed.revision); expect(retry.activeContract?.consumedAt).toBe(consumed.activeContract?.consumedAt);
    const beginRetry = begin(x, x.ready.revision); expect(beginRetry.consumptionId).toBe(first.consumptionId); expect(beginRetry.state.revision).toBe(consumed.revision);
  });
  it("DUPLICATE_FINALIZE_DIFFERENT_RESULT_DENIED EXECUTION_RECORD_WRONG_CONTRACT_DENIED EXECUTION_RECORD_WRONG_CONSUMPTION_DENIED EXECUTION_RECORD_WRONG_RESULT_DIGEST_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    expect(() => x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, "b".repeat(64))).toThrow(/EXECUTION_RECEIPT_NOT_PROVEN/);
    const wrongContract = record(x, first, { contractId: "wrong", resultDigest: "a".repeat(64) });
    expect(() => x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, wrongContract.recordId!, wrongContract.resultDigest!)).toThrow(/EXECUTION_RECEIPT_NOT_PROVEN/);
    const wrongConsumption = record(x, first, { consumptionId: "other", resultDigest: "a".repeat(64) });
    expect(() => x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, wrongConsumption.recordId!, wrongConsumption.resultDigest!)).toThrow(/EXECUTION_RECEIPT_NOT_PROVEN/);
    const consumed = x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    expect(() => x.service.finalizeContractConsumption("ws", consumed.taskId, consumed.revision, x.owner, first.consumptionId, receipt.recordId!, "b".repeat(64))).toThrow(/CONSUMPTION_RESULT_CONFLICT/);
  });
  it("FINALIZE_ACTIVE_ACTION_CHANGED_DENIED FINALIZE_ACTION_EPOCH_CHANGED_DENIED FINALIZE_ACTION_DIGEST_CHANGED_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const changed = x.store.updateTaskStateUnderMutationLease("ws", started.taskId, started.revision, x.owner, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, criticalInput: { version: "2" }, criticalInputDigest: criticalInputDigest({ version: "2" }) }; return { ...state, activeAction: { ...state.activeAction!, actionEpoch: 2, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => x.service.finalizeContractConsumption("ws", changed.taskId, changed.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/ACTION_DIGEST_MISMATCH|ACTIVE_ACTION_CONFLICT/);
  });
  it("RECOVERY_ACTIVE_ACTION_CHANGED_DENIED RECOVERY_ACTION_DIGEST_CHANGED_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId); record(x, first);
    const changed = x.store.updateTaskStateUnderMutationLease("ws", started.taskId, started.revision, x.owner, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, criticalInput: { version: "2" }, criticalInputDigest: criticalInputDigest({ version: "2" }) }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => x.service.recoverContractConsumption("ws", changed.taskId, changed.revision, x.owner)).toThrow(/ACTION_DIGEST_MISMATCH/);
  });
  it("FINALIZE_CONTRACT_BINDING_CHANGED_DENIED FINALIZE_CONTRACT_ARTIFACT_TAMPER_DENIED RECOVERY_CONTRACT_BINDING_CHANGED_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first), artifact = x.ready.activeContract!.artifactPath;
    const contract = JSON.parse(fs.readFileSync(artifact, "utf8")); fs.writeFileSync(artifact, JSON.stringify({ ...contract, allowedActionIds: ["OTHER"] }));
    expect(() => x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/CONTRACT_DIGEST_MISMATCH|CONTRACT_ACTION_FORBIDDEN/);
    expect(() => x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toThrow(/CONTRACT_DIGEST_MISMATCH|CONTRACT_ACTION_FORBIDDEN/);
  });
  it("TASKSTATE_CONTRACT_BINDING_DRIFT_FINALIZE_DENIED TASKSTATE_CONTRACT_BINDING_DRIFT_RECOVERY_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const changed = mutateState(x, started, state => ({ ...state, activeContract: { ...state.activeContract!, binding: { ...state.activeContract!.binding, requestId: "binding_drift" } } }));
    expect(() => x.service.finalizeContractConsumption("ws", changed.taskId, changed.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/CONSUMPTION_BINDING_INVALID|CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
    expect(() => x.service.recoverContractConsumption("ws", changed.taskId, changed.revision, x.owner)).toThrow(/CONSUMPTION_BINDING_INVALID|CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
  });
  it("FINALIZE_ACTION_EPOCH_ONLY_DRIFT_DENIED RECOVERY_ACTION_EPOCH_ONLY_DRIFT_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const changed = mutateState(x, started, state => ({ ...state, activeAction: { ...state.activeAction!, actionEpoch: 2 } }));
    expect(() => x.service.finalizeContractConsumption("ws", changed.taskId, changed.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/ACTIVE_ACTION_CONFLICT/);
    expect(() => x.service.recoverContractConsumption("ws", changed.taskId, changed.revision, x.owner)).toThrow(/ACTIVE_ACTION_CONFLICT/);
  });
  it("FINALIZE_ACTION_DIGEST_ONLY_DRIFT_DENIED RECOVERY_ACTION_DIGEST_ONLY_DRIFT_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const changed = mutateState(x, started, state => ({ ...state, activeContract: { ...state.activeContract!, binding: { ...state.activeContract!.binding, actionDigest: "b".repeat(64) } } }));
    expect(() => x.service.finalizeContractConsumption("ws", changed.taskId, changed.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!)).toThrow(/CONSUMPTION_BINDING_INVALID|CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
    expect(() => x.service.recoverContractConsumption("ws", changed.taskId, changed.revision, x.owner)).toThrow(/CONSUMPTION_BINDING_INVALID|CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
  });
  it("MULTIPLE_CONFLICTING_EXECUTION_RECORDS_FAIL_CLOSED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId);
    record(x, first); record(x, first, { resultDigest: "b".repeat(64) });
    expect(() => x.service.recoverContractConsumption("ws", started.taskId, started.revision, x.owner)).toThrow(/REPLAY_NOT_PROVEN/);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATE", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    const consumed = x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    const retry = x.service.finalizeContractConsumption("ws", consumed.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    expect(retry.revision).toBe(consumed.revision);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATES_CONTRACT", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    finalizeWithDurableCasCollision(x, started, receipt, state => ({ ...state, activeContract: { ...state.activeContract!, binding: { ...state.activeContract!.binding, requestId: "binding_drift" } } }), /CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATES_ACTIVE_ACTION", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    finalizeWithDurableCasCollision(x, started, receipt, state => ({ ...state, activeAction: { ...state.activeAction!, actionId: "action_drift" } }), /ACTIVE_ACTION_CONFLICT/);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATES_ACTION_EPOCH", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    finalizeWithDurableCasCollision(x, started, receipt, state => ({ ...state, activeAction: { ...state.activeAction!, actionEpoch: 2 } }), /ACTIVE_ACTION_CONFLICT/);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATES_ACTION_DIGEST", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    finalizeWithDurableCasCollision(x, started, receipt, state => ({ ...state, activeContract: { ...state.activeContract!, binding: { ...state.activeContract!.binding, actionDigest: "b".repeat(64) } } }), /CONSUMPTION_BINDING_INVALID|CONTRACT_BINDING_MISMATCH|CONTRACT_DIGEST_MISMATCH/);
  });
  it("CAS_FINALIZE_RELOAD_REVALIDATES_MUTATION_MARKER", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first);
    finalizeWithDurableCasCollision(x, started, receipt, state => ({ ...state, activeContract: { ...state.activeContract!, mutationStartedAt: undefined } }), /MUTATION_START_NOT_PROVEN/);
  });
  it("CONSUMED_CONFLICTING_ACTION_IDENTITY_DENIED", () => {
    const x = setup(), first = begin(x), started = x.service.markMutationStarted("ws", first.state.taskId, first.state.revision, x.owner, first.consumptionId), receipt = record(x, first), consumed = x.service.finalizeContractConsumption("ws", started.taskId, started.revision, x.owner, first.consumptionId, receipt.recordId!, receipt.resultDigest!);
    const changed = x.store.updateTaskStateUnderMutationLease("ws", consumed.taskId, consumed.revision, x.owner, state => { const descriptor = { ...state.activeAction!.actionDescriptor!, criticalInput: { version: "2" }, criticalInputDigest: criticalInputDigest({ version: "2" }) }; return { ...state, activeAction: { ...state.activeAction!, actionDescriptor: descriptor, actionDigest: actionDigest(descriptor) } }; });
    expect(() => x.service.beginContractConsumption("ws", changed.taskId, changed.revision, x.owner, "action_1", "ACTION_A", x.ready.activeContract!.binding.scopeDigest)).toThrow(/ACTION_DIGEST_MISMATCH/);
  });
  it("CONCURRENT_BEGIN_ONE_CONSUMPTION", async () => {
    const x = setup(), start = path.join(x.contractRoot, "begin-go"), readyA = path.join(x.contractRoot, "begin-a"), readyB = path.join(x.contractRoot, "begin-b"), startedA = path.join(x.contractRoot, "begin-start-a"), startedB = path.join(x.contractRoot, "begin-start-b");
    const args = (ready: string, started: string) => ["begin", x.stateRoot, x.root, x.contractRoot, x.ready.taskId, String(x.ready.revision), x.owner.leaseId, x.owner.ownerSessionMarker, "action_1", "ACTION_A", x.ready.activeContract!.binding.scopeDigest, "", "", "", ready, start, started];
    const first = contender(args(readyA, startedA), readyA), second = contender(args(readyB, startedB), readyB); await waitFor([readyA, readyB], [first, second]); fs.writeFileSync(start, "GO"); await waitFor([startedA, startedB], [first, second]);
    const results = await Promise.all([first.result, second.result]); expect(results.every((value) => value.startsWith("SUCCESS:consume_"))).toBe(true); expect(new Set(results)).toHaveLength(1);
    const state = x.store.readTaskState("ws", x.ready.taskId); expect(state.status === "VALID" && state.state.activeContract?.lifecycle).toBe("APPLYING");
  });
  it("CONCURRENT_FINALIZE_ONE_RECEIPT", async () => {
    const x = setup(), begun = begin(x), started = x.service.markMutationStarted("ws", begun.state.taskId, begun.state.revision, x.owner, begun.consumptionId), receipt = record(x, begun), start = path.join(x.contractRoot, "finalize-go"), readyA = path.join(x.contractRoot, "finalize-a"), readyB = path.join(x.contractRoot, "finalize-b"), startedA = path.join(x.contractRoot, "finalize-start-a"), startedB = path.join(x.contractRoot, "finalize-start-b");
    const args = (ready: string, startedBarrier: string) => ["finalize", x.stateRoot, x.root, x.contractRoot, started.taskId, String(started.revision), x.owner.leaseId, x.owner.ownerSessionMarker, "action_1", "ACTION_A", x.ready.activeContract!.binding.scopeDigest, begun.consumptionId, receipt.recordId!, receipt.resultDigest!, ready, start, startedBarrier];
    const first = contender(args(readyA, startedA), readyA), second = contender(args(readyB, startedB), readyB); await waitFor([readyA, readyB], [first, second]); fs.writeFileSync(start, "GO"); await waitFor([startedA, startedB], [first, second]);
    const results = await Promise.all([first.result, second.result]); expect(results.every((value) => value.startsWith(`SUCCESS:${receipt.recordId}:`))).toBe(true); expect(new Set(results)).toHaveLength(1);
    const state = x.store.readTaskState("ws", started.taskId); expect(state.status === "VALID" && state.state.activeContract).toMatchObject({ lifecycle: "CONSUMED", executionRecordId: receipt.recordId });
  });
});
