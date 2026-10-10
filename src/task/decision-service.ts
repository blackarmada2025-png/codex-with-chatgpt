import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { findExecutionRecordByConsumption } from "../execution/records.js";
import {
  bindDecisionResponse,
  canonicalizeScopeDescriptor,
  decisionResponseDigest,
  DecisionProtocolError,
  DecisionResponsePayloadV1Schema,
  DecisionResponseV1Schema,
  ExecutionContractV1Schema,
  validateActionFact,
  materializeExecutionContract,
  isScopeSubset,
  reasoningPacketDigest,
  scopeDigest,
  validateContractBinding,
  validatePacket,
  type DecisionResponsePayloadV1,
  type DecisionReceiptV1,
  type ApprovedAuthorityV1,
  type ExecutionContractV1,
  type ReasoningPacketV1,
} from "./decision-protocol.js";
import { TaskStateError, TaskStateStore, type ActiveContractReference, type MutationLeaseOwner, type TaskState } from "./state.js";
import { CONTROLLED_WRITE_SCOPE, type ControlledWriteAuthorization } from "../workspace/controlled-write.js";

export class DecisionServiceError extends Error {
  constructor(public code: string, message = code) { super(message); this.name = "DecisionServiceError"; }
}

export type ContractRecoveryResult = "READY_TO_BEGIN" | "RESUME_SAME_CONSUMPTION" | "RECEIPT_FINALIZED" | "ALREADY_CONSUMED";

export interface DecisionServiceOptions {
  workspaceRoot: string;
  stateStore: TaskStateStore;
  now?: () => Date;
  contractRoot?: string;
}

/** Phase 2 domain service. MCP and CLI adapters never own these invariants. */
export class DecisionService {
  private readonly root: string;
  private readonly now: () => Date;
  constructor(private readonly options: DecisionServiceOptions) {
    this.root = path.resolve(options.contractRoot ?? path.join(getStateDir(), "contracts"));
    this.now = options.now ?? (() => new Date());
  }

  /** Invalid action expiry is never authorization: only a finite future time is fresh. */
  private activeActionIsFresh(validUntil: string): boolean {
    const expiresAt = Date.parse(validUntil);
    return Number.isFinite(expiresAt) && expiresAt > this.now().getTime();
  }

  private artifactPath(workspaceId: string, contractId: string): string {
    return path.join(this.root, workspaceId, `${contractId}.json`);
  }

  private atomicWriteImmutable(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // link is create-only: a pre-existing artifact is never replaced.
      fs.linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DecisionServiceError("CONTRACT_ARTIFACT_COLLISION");
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.rmSync(temp, { force: true }); } catch { /* preserve original failure */ }
    }
  }

  private readContract(reference: NonNullable<TaskState["activeContract"]>): ExecutionContractV1 {
    if (path.resolve(reference.artifactPath) !== this.artifactPath(reference.binding.workspaceId, reference.contractId)) {
      throw new DecisionServiceError("CONTRACT_ARTIFACT_PATH_MISMATCH");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(reference.artifactPath, "utf8")); }
    catch { throw new DecisionServiceError("CONTRACT_ARTIFACT_UNREADABLE"); }
    const contract = ExecutionContractV1Schema.safeParse(parsed);
    if (!contract.success) throw new DecisionServiceError("CONTRACT_ARTIFACT_INVALID");
    if (contract.data.contractId !== reference.contractId || contract.data.digest !== reference.contractDigest) {
      throw new DecisionServiceError("CONTRACT_ARTIFACT_BINDING_MISMATCH");
    }
    return contract.data;
  }

  /** Historical receipts make transport retries idempotent after current references roll forward. */
  private decisionReceipt(state: TaskState, requestId: string): DecisionReceiptV1 | undefined {
    return state.decisionReceipts?.find((receipt) => receipt.requestId === requestId);
  }

  private resolveDecisionRetry(state: TaskState, requestId: string, rawPayload: unknown): TaskState | undefined {
    const receipt = this.decisionReceipt(state, requestId);
    if (!receipt) return undefined;
    const payload = DecisionResponsePayloadV1Schema.parse(rawPayload);
    const candidate = DecisionResponseV1Schema.parse({
      ...payload,
      workspaceId: receipt.response.workspaceId,
      taskId: receipt.response.taskId,
      semanticRequestId: receipt.response.semanticRequestId,
      requestId: receipt.response.requestId,
      actionEpoch: receipt.response.actionEpoch,
      packetDigest: receipt.response.packetDigest,
      scopeDigest: receipt.response.scopeDigest,
      receivedAt: receipt.response.receivedAt,
    });
    if (decisionResponseDigest(candidate) !== receipt.responseDigest) throw new DecisionServiceError("DECISION_RESPONSE_CONFLICT");
    if (state.pendingReasoning?.packet.requestId === requestId) throw new DecisionServiceError("DECISION_REQUEST_REOPEN_CONFLICT");
    const action = state.activeAction;
    if (!action || action.resolvedAt || !receipt.activeActionId
      || action.actionId !== receipt.activeActionId
      || action.semanticRequestId !== receipt.response.semanticRequestId
      || action.actionEpoch !== receipt.response.actionEpoch
      || !this.activeActionIsFresh(action.validUntil)) {
      throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT");
    }
    const authority = this.approvedAuthority(state, state.workspaceId);
    if (!action.actionDescriptor || !action.actionDigest) throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT");
    let facts;
    try { facts = validateActionFact({ actionDescriptor: action.actionDescriptor, actionDigest: action.actionDigest }); }
    catch { throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT"); }
    if (receipt.actionDigest !== facts.actionDigest
      || receipt.response.workspaceId !== state.workspaceId
      || receipt.response.taskId !== state.taskId
      || receipt.response.scopeDigest !== authority.approvedScopeDigest
      || facts.actionDescriptor.approvedScopeDigest !== authority.approvedScopeDigest) {
      throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT");
    }
    if (receipt.response.disposition === "EXECUTE") {
      const reference = state.activeContract;
      if (state.state !== "CONTRACT_READY" || !reference || reference.lifecycle !== "READY"
        || reference.contractId !== receipt.contractId || reference.contractDigest !== receipt.contractDigest
        || reference.artifactPath !== receipt.artifactPath
        || reference.binding.workspaceId !== state.workspaceId || reference.binding.taskId !== state.taskId
        || reference.binding.semanticRequestId !== action.semanticRequestId
        || reference.binding.requestId !== requestId || reference.binding.actionEpoch !== action.actionEpoch
        || reference.binding.activeActionId !== action.actionId || reference.binding.actionDigest !== facts.actionDigest
        || reference.binding.scopeDigest !== authority.approvedScopeDigest) {
        throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT");
      }
    } else if (state.state !== (receipt.response.disposition === "STOP" ? "STOPPED" : "HUMAN_GATE_REQUIRED")) {
      throw new DecisionServiceError("HISTORICAL_RECEIPT_ACTION_CONFLICT");
    }
    return state;
  }

  private appendDecisionReceipt(state: TaskState, receipt: DecisionReceiptV1): TaskState {
    if (this.decisionReceipt(state, receipt.requestId)) throw new DecisionServiceError("DECISION_RESPONSE_CONFLICT");
    return { ...state, decisionReceipts: [...(state.decisionReceipts ?? []), receipt] };
  }

  private consumptionRequest(reference: ActiveContractReference, actionId: string, requestedActionId: string, requestedScopeDigest: string): NonNullable<ActiveContractReference["consumptionRequest"]> {
    if (!reference.binding.actionDigest) throw new DecisionServiceError("MISSING_ACTION_DIGEST_DENIED");
    return { contractId: reference.contractId, actionId, requestedActionId, scopeDigest: requestedScopeDigest, actionEpoch: reference.binding.actionEpoch, actionDigest: reference.binding.actionDigest };
  }

  private sameConsumptionRequest(actual: ActiveContractReference["consumptionRequest"], expected: NonNullable<ActiveContractReference["consumptionRequest"]>): boolean {
    return !!actual && actual.contractId === expected.contractId && actual.actionId === expected.actionId && actual.requestedActionId === expected.requestedActionId && actual.scopeDigest === expected.scopeDigest && actual.actionEpoch === expected.actionEpoch && actual.actionDigest === expected.actionDigest;
  }

  private assertExecutionRecord(workspaceId: string, taskId: string, reference: ActiveContractReference, consumptionId: string, executionRecordId: string, resultDigest: string) {
    const record = findExecutionRecordByConsumption(workspaceId, taskId, reference.contractId, consumptionId, executionRecordId);
    if (!record || record.resultDigest !== resultDigest) throw new DecisionServiceError("EXECUTION_RECEIPT_NOT_PROVEN");
    return record;
  }

  private validateConsumptionAuthority(workspaceId: string, current: TaskState, reference: ActiveContractReference, actionId: string, requestedActionId: string, requestedScopeDigest: string, allowResolved = false): NonNullable<ActiveContractReference["consumptionRequest"]> {
    const request = this.consumptionRequest(reference, actionId, requestedActionId, requestedScopeDigest);
    const contract = this.readContract(reference);
    validateContractBinding(contract, reference.binding, this.now());
    if (contract.binding.scopeDigest !== requestedScopeDigest) throw new DecisionServiceError("CONTRACT_SCOPE_DIGEST_MISMATCH");
    const authority = this.approvedAuthority(current, workspaceId);
    if (!current.activeAction?.actionDescriptor || !current.activeAction?.actionDigest) throw new DecisionServiceError("MISSING_ACTION_DIGEST_DENIED");
    let facts;
    try { facts = validateActionFact({ actionDescriptor: current.activeAction.actionDescriptor, actionDigest: current.activeAction.actionDigest }); }
    catch (error) { throw new DecisionServiceError(error instanceof DecisionProtocolError ? error.code : "ACTION_DIGEST_MISMATCH"); }
    if (facts.actionDescriptor.approvedScopeDigest !== authority.approvedScopeDigest || contract.binding.actionDigest !== facts.actionDigest) throw new DecisionServiceError("ACTION_DIGEST_MISMATCH");
    if (authority.globalForbiddenActionIds.includes(requestedActionId) || contract.approvedAuthority.globalForbiddenActionIds.includes(requestedActionId)) throw new DecisionServiceError("GLOBAL_DENY_ACTION");
    if (!contract.allowedActionIds.includes(requestedActionId) || contract.forbiddenActionIds.includes(requestedActionId)) throw new DecisionServiceError("CONTRACT_ACTION_FORBIDDEN");
    const action = current.activeAction;
    if (!action || (!allowResolved && action.resolvedAt) || action.actionId !== actionId || action.semanticRequestId !== contract.binding.semanticRequestId || action.actionEpoch !== contract.binding.actionEpoch) throw new DecisionServiceError("ACTIVE_ACTION_CONFLICT");
    return request;
  }

  private consumptionRetry(state: TaskState, workspaceId: string, actionId: string, requestedActionId: string, requestedScopeDigest: string): { state: TaskState; consumptionId: string } | undefined {
    const reference = state.activeContract;
    if (!reference || (reference.lifecycle !== "APPLYING" && reference.lifecycle !== "CONSUMED")) return undefined;
    const request = this.consumptionRequest(reference, actionId, requestedActionId, requestedScopeDigest);
    if (!this.sameConsumptionRequest(reference.consumptionRequest, request)) throw new DecisionServiceError("CONSUMPTION_REQUEST_CONFLICT");
    if (!reference.consumptionId) throw new DecisionServiceError("CONSUMPTION_BINDING_INVALID");
    if (reference.lifecycle === "CONSUMED") {
      this.validateConsumptionAuthorityForFinalize(workspaceId, state.taskId, state, reference, reference.consumptionId, reference.executionRecordId ?? "", reference.resultDigest ?? "", true);
    } else {
      this.validateConsumptionAuthority(workspaceId, state, reference, actionId, requestedActionId, requestedScopeDigest);
    }
    return { state, consumptionId: reference.consumptionId };
  }

  /** Completion evidence is never authority by itself: re-prove the durable contract/action/consumption binding. */
  private validateConsumptionAuthorityForFinalize(workspaceId: string, taskId: string, state: TaskState, reference: ActiveContractReference, consumptionId: string, executionRecordId: string, resultDigest: string, allowConsumed = false): void {
    if (state.workspaceId !== workspaceId || state.taskId !== taskId || reference.consumptionId !== consumptionId) throw new DecisionServiceError("CONSUMPTION_BINDING_INVALID");
    if (reference.lifecycle !== "APPLYING" && (!allowConsumed || reference.lifecycle !== "CONSUMED")) throw new TaskStateError("CONSUMPTION_NOT_APPLYING");
    if (!reference.mutationStartedAt) throw new DecisionServiceError("MUTATION_START_NOT_PROVEN");
    const request = reference.consumptionRequest;
    if (!request || request.contractId !== reference.contractId || request.scopeDigest !== reference.binding.scopeDigest || request.actionEpoch !== reference.binding.actionEpoch || request.actionDigest !== reference.binding.actionDigest) {
      throw new DecisionServiceError("CONSUMPTION_BINDING_INVALID");
    }
    this.validateConsumptionAuthority(workspaceId, state, reference, request.actionId, request.requestedActionId, request.scopeDigest, allowConsumed);
    if (reference.lifecycle === "CONSUMED" && (reference.executionRecordId !== executionRecordId || reference.resultDigest !== resultDigest)) throw new DecisionServiceError("CONSUMPTION_RESULT_CONFLICT");
    this.assertExecutionRecord(workspaceId, taskId, reference, consumptionId, executionRecordId, resultDigest);
  }

  private ensureActiveBinding(state: TaskState, packet: ReasoningPacketV1, packetDigest: string): void {
    const action = state.activeAction;
    if (!action || action.resolvedAt || action.actionId !== packet.activeActionId || action.semanticRequestId !== packet.semanticRequestId || action.actionEpoch !== packet.actionEpoch) {
      throw new DecisionServiceError("ACTIVE_ACTION_BINDING_MISMATCH");
    }
    if (!this.activeActionIsFresh(action.validUntil)) throw new DecisionServiceError("ACTIVE_ACTION_EXPIRED");
    if (state.workspaceId !== packet.workspaceId || state.taskId !== packet.taskId || reasoningPacketDigest(packet) !== packetDigest) {
      throw new DecisionServiceError("PACKET_BINDING_MISMATCH");
    }
    const authority = this.approvedAuthority(state, packet.workspaceId);
    if (!action.actionDescriptor || !action.actionDigest || !packet.actionDigest) throw new DecisionServiceError("MISSING_ACTION_DIGEST_DENIED");
    let facts;
    try { facts = validateActionFact({ actionDescriptor: action.actionDescriptor, actionDigest: action.actionDigest }); }
    catch (error) { throw new DecisionServiceError(error instanceof DecisionProtocolError ? error.code : "ACTION_DIGEST_MISMATCH"); }
    if (facts.actionDescriptor.approvedScopeDigest !== authority.approvedScopeDigest) throw new DecisionServiceError("ACTION_APPROVED_SCOPE_DIGEST_MISMATCH");
    if (packet.actionDigest !== facts.actionDigest) throw new DecisionServiceError("ACTION_DIGEST_MISMATCH");
  }

  private approvedAuthority(state: TaskState, workspaceId: string): ApprovedAuthorityV1 {
    const authority = state.activeAction?.approvedAuthority;
    if (!authority) throw new DecisionServiceError("MISSING_APPROVED_AUTHORITY_DENIED");
    if (!authority.approvedScopeDescriptor || !authority.approvedScopeDigest) throw new DecisionServiceError("MISSING_APPROVED_SCOPE_DENIED");
    if (!authority.approvedActionIds?.length) throw new DecisionServiceError("MISSING_APPROVED_ACTIONS_DENIED");
    const scope = canonicalizeScopeDescriptor(this.options.workspaceRoot, authority.approvedScopeDescriptor);
    if (scope.workspaceId !== workspaceId) throw new DecisionServiceError("MISSING_APPROVED_SCOPE_DENIED");
    if (authority.approvedScopeDigest !== scopeDigest(scope)) throw new DecisionServiceError("APPROVED_SCOPE_DIGEST_MISMATCH");
    return { ...authority, approvedScopeDescriptor: scope, approvedScopeDigest: scopeDigest(scope), approvedActionIds: [...new Set(authority.approvedActionIds)].sort(), globalForbiddenActionIds: [...new Set(authority.globalForbiddenActionIds)].sort() };
  }

  createDecisionRequest(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner, rawPacket: unknown): TaskState {
    const packet = validatePacket(rawPacket);
    if (packet.workspaceId !== workspaceId || packet.taskId !== taskId) throw new DecisionServiceError("PACKET_TASK_BINDING_MISMATCH");
    if (Date.parse(packet.validUntil) <= this.now().getTime()) throw new DecisionServiceError("PACKET_EXPIRED");
    const canonicalScope = canonicalizeScopeDescriptor(this.options.workspaceRoot, packet.scopeDescriptor);
    if (canonicalScope.workspaceId !== workspaceId) throw new DecisionServiceError("SCOPE_WORKSPACE_MISMATCH");
    const normalizedPacket = { ...packet, scopeDescriptor: canonicalScope };
    const packetDigest = reasoningPacketDigest(normalizedPacket);
    const first = this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, expectedRevision, owner, (state) => {
      if (state.state !== "BUILDING") throw new TaskStateError("TASK_NOT_READY_FOR_REASONING");
      if (this.decisionReceipt(state, normalizedPacket.requestId)) throw new DecisionServiceError("DECISION_REQUEST_ALREADY_CLOSED");
      if (state.pendingReasoning || state.activeContract) throw new TaskStateError("DECISION_REQUEST_ALREADY_ACTIVE");
      this.ensureActiveBinding(state, normalizedPacket, packetDigest);
      const authority = this.approvedAuthority(state, workspaceId);
      if (canonicalScope.accessMode === "WRITE" && authority.approvedScopeDescriptor.accessMode !== "WRITE") throw new DecisionServiceError("READ_ONLY_CANNOT_ESCALATE_TO_WRITE");
      if (!isScopeSubset(canonicalScope, authority.approvedScopeDescriptor) || normalizedPacket.candidateActionIds.some((action) => !authority.approvedActionIds.includes(action))) throw new DecisionServiceError("APPROVED_AUTHORITY_CEILING_DENIED");
      return { ...state, state: "WAIT_REASONING", reasoningCycle: state.reasoningCycle + 1, pendingReasoning: { packet: normalizedPacket, packetDigest, status: "WAIT_REASONING", createdAt: this.now().toISOString() } };
    });
    // If the process stops before this CAS, recoverDecisionRequest() is the only allowed resume path.
    return this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, first.revision, owner, (state) => {
      if (state.state !== "WAIT_REASONING" || !state.pendingReasoning || state.pendingReasoning.packetDigest !== packetDigest) throw new TaskStateError("DECISION_REQUEST_STATE_MISMATCH");
      return { ...state, state: "WAITING_DECISION", pendingReasoning: { ...state.pendingReasoning, status: "WAITING_DECISION" } };
    });
  }

  recoverDecisionRequest(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner): TaskState {
    return this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, expectedRevision, owner, (state) => {
      if (state.state !== "WAIT_REASONING" || !state.pendingReasoning) throw new TaskStateError("DECISION_REQUEST_NOT_RECOVERABLE");
      this.ensureActiveBinding(state, state.pendingReasoning.packet, state.pendingReasoning.packetDigest);
      return { ...state, state: "WAITING_DECISION", pendingReasoning: { ...state.pendingReasoning, status: "WAITING_DECISION" } };
    });
  }

  readPendingDecision(workspaceId: string, taskId: string, requestId: string): ReasoningPacketV1 {
    const read = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (read.status !== "VALID") throw new DecisionServiceError("DECISION_REQUEST_NOT_FOUND");
    const pending = read.state.pendingReasoning;
    if (read.state.state !== "WAITING_DECISION" || !pending || pending.status !== "WAITING_DECISION" || pending.packet.requestId !== requestId) {
      throw new DecisionServiceError("DECISION_REQUEST_NOT_PENDING");
    }
    this.ensureActiveBinding(read.state, pending.packet, pending.packetDigest);
    return pending.packet;
  }

  submitDecisionResponse(
    workspaceId: string,
    taskId: string,
    expectedRevision: number,
    owner: MutationLeaseOwner,
    requestId: string,
    rawPayload: unknown,
  ): TaskState {
    const payload = DecisionResponsePayloadV1Schema.parse(rawPayload) as DecisionResponsePayloadV1;
    const submit = (revision: number): TaskState => this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, revision, owner, (state) => {
      const retry = this.resolveDecisionRetry(state, requestId, payload);
      if (retry) return retry;
      const pending = state.pendingReasoning;
      if (state.state !== "WAITING_DECISION" || !pending || pending.packet.requestId !== requestId) throw new TaskStateError("DECISION_NOT_PENDING");
      this.ensureActiveBinding(state, pending.packet, pending.packetDigest);
      if (Date.parse(pending.packet.validUntil) <= this.now().getTime()) throw new DecisionServiceError("PACKET_EXPIRED");
      const response = bindDecisionResponse(pending.packet, pending.packetDigest, payload, this.now().toISOString());
      const responseDigest = decisionResponseDigest(response);
      if (response.disposition === "HUMAN_GATE_REQUIRED") {
        return this.appendDecisionReceipt({ ...state, state: "HUMAN_GATE_REQUIRED", pendingReasoning: undefined }, { requestId, packetDigest: pending.packetDigest, activeActionId: pending.packet.activeActionId, actionDigest: pending.packet.actionDigest!, response, responseDigest, decidedAt: this.now().toISOString() });
      }
      if (response.disposition === "STOP") return this.appendDecisionReceipt({ ...state, state: "STOPPED", pendingReasoning: undefined }, { requestId, packetDigest: pending.packetDigest, activeActionId: pending.packet.activeActionId, actionDigest: pending.packet.actionDigest!, response, responseDigest, decidedAt: this.now().toISOString() });
      const contract = materializeExecutionContract({
        contractId: `contract_${crypto.randomBytes(16).toString("hex")}`,
        packet: pending.packet,
        packetDigest: pending.packetDigest,
        response,
        approvedAuthority: this.approvedAuthority(state, workspaceId),
        activeAction: validateActionFact({ actionDescriptor: state.activeAction?.actionDescriptor, actionDigest: state.activeAction?.actionDigest }),
        preconditions: pending.packet.constraints,
        acceptanceCriteria: ["Complete only the contract's declared actions within its declared scope."],
        stopConditions: ["Contract binding, freshness, scope, or active-action validation fails."],
      });
      const artifactPath = this.artifactPath(workspaceId, contract.contractId);
      // An orphan artifact is inert until the following TaskState CAS succeeds.
      this.atomicWriteImmutable(artifactPath, contract);
      return this.appendDecisionReceipt({ ...state, state: "CONTRACT_READY", pendingReasoning: undefined, activeContract: { contractId: contract.contractId, artifactPath, contractDigest: contract.digest, binding: contract.binding, lifecycle: "READY" } }, { requestId, packetDigest: pending.packetDigest, activeActionId: pending.packet.activeActionId, actionDigest: pending.packet.actionDigest!, response, responseDigest, contractId: contract.contractId, contractDigest: contract.digest, artifactPath, decidedAt: this.now().toISOString() });
    });
    try { return submit(expectedRevision); }
    catch (error) {
      if (!(error instanceof TaskStateError) || error.code !== "STALE_TASK_STATE") throw error;
      const read = this.options.stateStore.readTaskState(workspaceId, taskId);
      if (read.status !== "VALID") throw error;
      const retry = this.resolveDecisionRetry(read.state, requestId, payload);
      if (retry) return retry;
      throw error;
    }
  }

  beginContractConsumption(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner, actionId: string, requestedActionId: string, requestedScopeDigest: string): { state: TaskState; consumptionId: string } {
    const consumptionId = `consume_${crypto.randomBytes(16).toString("hex")}`;
    this.options.stateStore.requireMutationLeaseOwner(workspaceId, taskId, owner);
    const existing = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (existing.status !== "VALID") throw new TaskStateError(existing.status, "error" in existing ? existing.error : undefined);
    const retry = this.consumptionRetry(existing.state, workspaceId, actionId, requestedActionId, requestedScopeDigest);
    if (retry) return retry;
    const begin = (revision: number): { state: TaskState; consumptionId: string } => {
      const state = this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, revision, owner, (current) => {
      const reference = current.activeContract;
      if (!reference) throw new TaskStateError("CONTRACT_NOT_READY");
      if (reference.lifecycle === "APPLYING" || reference.lifecycle === "CONSUMED") {
        // A concurrent owner won the transition. Reload before classifying its durable result.
        throw new TaskStateError("STALE_TASK_STATE");
      }
      if (current.state !== "CONTRACT_READY" || reference.lifecycle !== "READY") throw new TaskStateError("CONTRACT_NOT_READY");
      const request = this.validateConsumptionAuthority(workspaceId, current, reference, actionId, requestedActionId, requestedScopeDigest);
      return { ...current, state: "BUILDING", activeContract: { ...reference, lifecycle: "APPLYING", consumptionId, consumptionRequest: request, applyingAt: this.now().toISOString() } };
      });
      return { state, consumptionId: state.activeContract?.consumptionId ?? consumptionId };
    };
    try { return begin(expectedRevision); }
    catch (error) {
      if (!(error instanceof TaskStateError) || error.code !== "STALE_TASK_STATE") throw error;
      const read = this.options.stateStore.readTaskState(workspaceId, taskId);
      if (read.status !== "VALID") throw error;
      const recovered = this.consumptionRetry(read.state, workspaceId, actionId, requestedActionId, requestedScopeDigest);
      if (recovered) return recovered;
      throw error;
    }
  }

  markMutationStarted(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner, consumptionId: string): TaskState {
    return this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, expectedRevision, owner, (state) => {
      const reference = state.activeContract;
      if (state.workspaceId !== workspaceId || state.taskId !== taskId || !reference || reference.lifecycle !== "APPLYING" || reference.consumptionId !== consumptionId) {
        throw new TaskStateError("CONSUMPTION_NOT_APPLYING");
      }
      // A consumption handle is only an idempotency identity. Starting a mutation
      // must re-prove the current contract, authority, action, scope, and freshness
      // while the state transition is protected.
      if (reference.mutationStartedAt) throw new DecisionServiceError("MUTATION_ALREADY_STARTED_NON_AUTHORIZING");
      const request = reference.consumptionRequest;
      if (!request || request.contractId !== reference.contractId || request.scopeDigest !== reference.binding.scopeDigest || request.actionEpoch !== reference.binding.actionEpoch || request.actionDigest !== reference.binding.actionDigest) {
        throw new DecisionServiceError("CONSUMPTION_BINDING_INVALID");
      }
      this.validateConsumptionAuthority(workspaceId, state, reference, request.actionId, request.requestedActionId, request.scopeDigest);
      return { ...state, activeContract: { ...reference, mutationStartedAt: this.now().toISOString() } };
    });
  }

  finalizeContractConsumption(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner, consumptionId: string, executionRecordId: string, resultDigest: string): TaskState {
    this.options.stateStore.requireMutationLeaseOwner(workspaceId, taskId, owner);
    const existing = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (existing.status !== "VALID") throw new TaskStateError(existing.status, "error" in existing ? existing.error : undefined);
    const existingReference = existing.state.activeContract;
    if (existingReference?.lifecycle === "CONSUMED" && existingReference.consumptionId === consumptionId) {
      this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, existing.state, existingReference, consumptionId, executionRecordId, resultDigest, true);
      return existing.state;
    }
    const finalize = (revision: number): TaskState => this.options.stateStore.updateTaskStateUnderMutationLease(workspaceId, taskId, revision, owner, (state) => {
      const reference = state.activeContract;
      if (!reference || reference.consumptionId !== consumptionId) throw new TaskStateError("CONSUMPTION_NOT_APPLYING");
      if (reference.lifecycle === "CONSUMED") {
        throw new TaskStateError("STALE_TASK_STATE");
      }
      if (reference.lifecycle !== "APPLYING") throw new TaskStateError("CONSUMPTION_NOT_APPLYING");
      this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, state, reference, consumptionId, executionRecordId, resultDigest);
      return { ...state, activeAction: state.activeAction ? { ...state.activeAction, resolvedAt: state.activeAction.resolvedAt ?? this.now().toISOString() } : undefined, activeContract: { ...reference, lifecycle: "CONSUMED", consumedAt: this.now().toISOString(), executionRecordId, resultDigest } };
    });
    try { return finalize(expectedRevision); }
    catch (error) {
      if (!(error instanceof TaskStateError) || error.code !== "STALE_TASK_STATE") throw error;
      const read = this.options.stateStore.readTaskState(workspaceId, taskId);
      if (read.status !== "VALID") throw error;
      const reference = read.state.activeContract;
      if (reference?.lifecycle === "APPLYING" && reference.consumptionId === consumptionId) {
        // A competing durable update won the CAS. Re-prove authority before reporting the stale result.
        this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, read.state, reference, consumptionId, executionRecordId, resultDigest);
      }
      if (reference?.lifecycle === "CONSUMED" && reference.consumptionId === consumptionId) {
        this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, read.state, reference, consumptionId, executionRecordId, resultDigest, true);
        return read.state;
      }
      throw error;
    }
  }

  recoverContractConsumption(workspaceId: string, taskId: string, expectedRevision: number, owner: MutationLeaseOwner): ContractRecoveryResult {
    const read = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (read.status !== "VALID") throw new DecisionServiceError("TASK_STATE_NOT_VALID");
    const reference = read.state.activeContract;
    if (!reference) throw new DecisionServiceError("CONTRACT_NOT_FOUND");
    if (reference.lifecycle === "READY") return "READY_TO_BEGIN";
    if (reference.lifecycle === "CONSUMED") {
      this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, read.state, reference, reference.consumptionId ?? "", reference.executionRecordId ?? "", reference.resultDigest ?? "", true);
      return "ALREADY_CONSUMED";
    }
    const record = findExecutionRecordByConsumption(workspaceId, taskId, reference.contractId, reference.consumptionId ?? "");
    if (record) {
      this.validateConsumptionAuthorityForFinalize(workspaceId, taskId, read.state, reference, reference.consumptionId ?? "", record.recordId!, record.resultDigest!);
      this.finalizeContractConsumption(workspaceId, taskId, expectedRevision, owner, reference.consumptionId!, record.recordId!, record.resultDigest!);
      return "RECEIPT_FINALIZED";
    }
    // The start marker is written before the future action runner may mutate.
    if (!reference.mutationStartedAt) return "RESUME_SAME_CONSUMPTION";
    throw new DecisionServiceError("REPLAY_NOT_PROVEN");
  }

  assertContractWriteScope(contract: ExecutionContractV1, target: string): string {
    const descriptor = canonicalizeScopeDescriptor(this.options.workspaceRoot, contract.scopeDescriptor);
    if (descriptor.accessMode !== "WRITE") throw new DecisionServiceError("CONTRACT_WRITE_NOT_ALLOWED");
    const candidate = canonicalizeScopeDescriptor(this.options.workspaceRoot, { ...descriptor, canonicalRootRelativePaths: [target], excludedPaths: [] }).canonicalRootRelativePaths[0];
    const excluded = descriptor.excludedPaths.some((item) => candidate === item || candidate.startsWith(`${item}/`));
    const allowed = descriptor.canonicalRootRelativePaths.some((item) => candidate === item || candidate.startsWith(`${item}/`));
    if (!allowed || excluded) throw new DecisionServiceError("CONTRACT_WRITE_SCOPE_VIOLATION");
    return candidate;
  }

  /**
   * Server-owned bridge from a current execution contract to the unregistered
   * controlled-write fixture.  Caller values select a candidate only; every
   * authorization fact is reloaded from this service's TaskStateStore.
   */
  bindCurrentDecisionToControlledWrite(workspaceId: string, taskId: string, requestId: string, target: string, actionClass: string): {
    authorization: ControlledWriteAuthorization;
    allowedPathPrefixes: string[];
  } {
    const read = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (read.status !== "VALID") throw new DecisionServiceError("TASK_STATE_NOT_VALID");
    const state = read.state;
    if (state.workspaceId !== workspaceId || state.taskId !== taskId || state.state !== "CONTRACT_READY") {
      throw new DecisionServiceError("CURRENT_DECISION_NOT_WRITABLE");
    }
    const reference = state.activeContract;
    const receipt = this.decisionReceipt(state, requestId);
    if (!reference || reference.lifecycle !== "READY" || !receipt || receipt.response.disposition !== "EXECUTE") {
      throw new DecisionServiceError("CURRENT_DECISION_NOT_WRITABLE");
    }
    if (receipt.response.workspaceId !== state.workspaceId || receipt.response.taskId !== state.taskId || receipt.response.requestId !== requestId
      || receipt.contractId !== reference.contractId || receipt.contractDigest !== reference.contractDigest || receipt.artifactPath !== reference.artifactPath) {
      throw new DecisionServiceError("DECISION_RECEIPT_BINDING_MISMATCH");
    }
    const contract = this.readContract(reference);
    validateContractBinding(contract, reference.binding, this.now());
    const action = state.activeAction;
    if (!action || action.resolvedAt || !this.activeActionIsFresh(action.validUntil) || !action.actionDescriptor || !action.actionDigest) {
      throw new DecisionServiceError("CURRENT_ACTIVE_ACTION_INVALID");
    }
    const facts = validateActionFact({ actionDescriptor: action.actionDescriptor, actionDigest: action.actionDigest });
    const authority = this.approvedAuthority(state, workspaceId);
    if (!reference.binding.activeActionId || reference.binding.activeActionId !== action.actionId
      || contract.binding.workspaceId !== state.workspaceId || contract.binding.taskId !== state.taskId
      || contract.binding.requestId !== requestId || contract.binding.semanticRequestId !== action.semanticRequestId
      || contract.binding.actionEpoch !== action.actionEpoch || contract.binding.actionDigest !== facts.actionDigest
      || contract.binding.scopeDigest !== authority.approvedScopeDigest
      || facts.actionDescriptor.approvedScopeDigest !== authority.approvedScopeDigest
      || receipt.actionDigest !== facts.actionDigest || receipt.response.actionEpoch !== action.actionEpoch
      || receipt.response.scopeDigest !== authority.approvedScopeDigest) {
      throw new DecisionServiceError("CURRENT_DECISION_BINDING_MISMATCH");
    }
    if (actionClass !== facts.actionDescriptor.actionType || !contract.allowedActionIds.includes(actionClass) || contract.forbiddenActionIds.includes(actionClass)) {
      throw new DecisionServiceError("ACTION_CLASS_DENIED");
    }
    const approvedTarget = this.assertContractWriteScope(contract, facts.actionDescriptor.target);
    const requestedTarget = this.assertContractWriteScope(contract, target);
    if (approvedTarget !== requestedTarget) throw new DecisionServiceError("APPROVED_TARGET_MISMATCH");
    return {
      authorization: {
        authorizationRef: `decision:${receipt.requestId}:${reference.contractId}:${reference.contractDigest}`,
        boundTaskId: state.taskId,
        boundWorkspaceId: state.workspaceId,
        scopes: [CONTROLLED_WRITE_SCOPE],
      },
      allowedPathPrefixes: [approvedTarget],
    };
  }
}
