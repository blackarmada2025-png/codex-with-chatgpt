import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getStateDir } from "../config/paths.js";
import { appendExecutionRecord } from "../execution/records.js";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { CONTROLLED_WRITE_MODE, executeControlledWrite, type ControlledWriteReceipt } from "../workspace/controlled-write.js";
import { bindDecisionReceiptToControlledWrite } from "./decision-controlled-write-binding.js";
import { DecisionService } from "./decision-service.js";
import { TaskStateStore, type MutationLeaseOwner, type TaskState } from "./state.js";
import { TrustedHumanIngressAdapter, type TrustedHumanDecisionInput } from "./trusted-human-ingress.js";
import { actionDigest, canonicalizeScopeDescriptor, criticalInputDigest, scopeDigest, type ScopeDescriptorV1 } from "./decision-protocol.js";
import { z } from "zod";
import type { AuthStore } from "../auth/store.js";

export class ProductionBindingError extends Error {
  constructor(public readonly code: string, message = code, public readonly details?: Record<string, unknown>) { super(message); this.name = "ProductionBindingError"; }
}

export interface ProductionBindingsOptions {
  workspace: Workspace;
  /** Server configuration only. Never inferred from a tool argument. */
  trustedHumanClientId: string;
  authStore?: AuthStore;
  stateStore?: TaskStateStore;
  decisionService?: DecisionService;
}

interface ApprovedPatch {
  expectedContent: string;
  replacementContent: string;
  expectedHash: string;
}

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
export const DecisionRequestCreateInputSchema = z.object({
  task_id: identifier,
  target_file: z.string().min(1).max(1024),
  operation: z.literal(CONTROLLED_WRITE_MODE),
  baseline_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  patch: z.object({
    expected_content: z.string().min(1).max(1_000_000),
    replacement_content: z.string().max(1_000_000),
  }).strict(),
  scope_summary: z.string().trim().min(1).max(2_000),
}).strict();
export type DecisionRequestCreateInput = z.infer<typeof DecisionRequestCreateInputSchema>;

export interface CreatedDecisionRequest {
  decisionRequestId: string;
  taskId: string;
  workspaceId: string;
  targetFile: string;
  operation: typeof CONTROLLED_WRITE_MODE;
  baselineSha256: string;
  patchSha256: string;
  scopeDigest: string;
  createdAt: string;
  expiresAt: string;
  idempotent: boolean;
  callerClientIdentityPresent?: true;
  callerClientIdFingerprint?: string;
  callerClientRegistered?: boolean;
  callerClientRegistrationFingerprint?: string;
  configuredTrustedClientFingerprint?: string;
  trustedClientMatch?: boolean;
}

const DECISION_REQUEST_TTL_MS = 15 * 60 * 1000;

function bytesSha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function identityFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

/**
 * Production adapter for the two governed mutation surfaces. Inputs select a
 * durable server-owned decision; they never provide authority facts or write
 * parameters. The action descriptor's already-digested critical input carries
 * the sole permitted PATCH_EXISTING_TEXT payload.
 */
export class ProductionBindings {
  private readonly store: TaskStateStore;
  private readonly decisions: DecisionService;

  constructor(private readonly options: ProductionBindingsOptions) {
    if (!options.trustedHumanClientId) throw new ProductionBindingError("TRUSTED_CLIENT_CONFIGURATION_REQUIRED");
    this.store = options.stateStore ?? new TaskStateStore();
    this.decisions = options.decisionService ?? new DecisionService({ workspaceRoot: options.workspace.root, stateStore: this.store });
  }

  private assertTrustedAuth(authInfo: AuthInfo | undefined, requiredScope: string): AuthInfo {
    if (!authInfo?.clientId || !Array.isArray(authInfo.scopes)) throw new ProductionBindingError("MIDDLEWARE_AUTH_REQUIRED");
    if (authInfo.clientId !== this.options.trustedHumanClientId) {
      const registered = this.options.authStore?.getClient(authInfo.clientId);
      throw new ProductionBindingError("TRUSTED_CLIENT_MISMATCH", "TRUSTED_CLIENT_MISMATCH", {
        caller_client_identity_present: true,
        caller_client_id_fingerprint: identityFingerprint(authInfo.clientId),
        caller_client_registered: Boolean(registered),
        configured_trusted_client_fingerprint: identityFingerprint(this.options.trustedHumanClientId),
        trusted_client_match: false,
      });
    }
    if (!authInfo.scopes.includes(requiredScope)) throw new ProductionBindingError("TRUSTED_SCOPE_REQUIRED");
    return authInfo;
  }

  private locateDecisionTask(requestId: string): TaskState {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(requestId)) throw new ProductionBindingError("DECISION_REQUEST_ID_INVALID");
    const directory = path.join(getStateDir(), "tasks", this.options.workspace.id);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { throw new ProductionBindingError("SERVER_DECISION_CONTEXT_NOT_FOUND"); }
    const matches: TaskState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -".json".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(taskId)) continue;
      const read = this.store.readTaskState(this.options.workspace.id, taskId);
      if (read.status !== "VALID") continue;
      if (read.state.pendingReasoning?.packet.requestId === requestId || read.state.decisionReceipts?.some((receipt) => receipt.requestId === requestId)) {
        matches.push(read.state);
      }
    }
    if (matches.length !== 1) throw new ProductionBindingError(matches.length ? "DECISION_REQUEST_AMBIGUOUS" : "SERVER_DECISION_CONTEXT_NOT_FOUND");
    return matches[0]!;
  }

  private withServerLease<T>(taskId: string, operation: string, execute: (owner: MutationLeaseOwner) => T): T {
    const lease = this.store.acquireWorkspaceMutationLease(this.options.workspace.id, taskId, `production-${operation}-${crypto.randomBytes(12).toString("hex")}`);
    const owner = { leaseId: lease.leaseId, ownerSessionMarker: lease.ownerSessionMarker };
    try { return execute(owner); }
    finally { this.store.releaseWorkspaceMutationLease(this.options.workspace.id, taskId, owner); }
  }

  trustedClientFingerprint(): string {
    return identityFingerprint(this.options.trustedHumanClientId);
  }

  trustedPrincipalId(): string {
    return this.options.trustedHumanClientId;
  }

  trustedClientMatches(clientId: string): boolean {
    return clientId === this.options.trustedHumanClientId;
  }

  private createTarget(input: DecisionRequestCreateInput): { target: string; baselineSha256: string; scope: ScopeDescriptorV1; patchSha256: string } {
    if (input.target_file !== input.target_file.trim() || input.target_file.includes("\\") || input.target_file.includes(":")) {
      throw new ProductionBindingError("DECISION_TARGET_INVALID");
    }
    let resolved: { abs: string; rel: string };
    try { resolved = this.options.workspace.resolve(input.target_file); }
    catch (error) {
      if (error instanceof WorkspaceError) throw new ProductionBindingError("DECISION_TARGET_INVALID");
      throw error;
    }
    if (!resolved.rel || resolved.rel !== input.target_file || resolved.rel.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new ProductionBindingError("DECISION_TARGET_INVALID");
    }
    let stat: fs.Stats;
    let bytes: Buffer;
    try { stat = fs.statSync(resolved.abs); bytes = fs.readFileSync(resolved.abs); }
    catch { throw new ProductionBindingError("DECISION_TARGET_UNREADABLE"); }
    if (!stat.isFile() || stat.nlink > 1 || bytes.includes(0)) throw new ProductionBindingError("DECISION_TARGET_INVALID");
    const baselineSha256 = bytesSha256(bytes);
    if (baselineSha256 !== input.baseline_sha256.toUpperCase()) throw new ProductionBindingError("DECISION_BASELINE_MISMATCH");
    const scope = canonicalizeScopeDescriptor(this.options.workspace.root, {
      schemaVersion: "scope-descriptor-v1",
      workspaceId: this.options.workspace.id,
      canonicalRootRelativePaths: [resolved.rel],
      accessMode: "WRITE",
      excludedPaths: [],
    });
    return { target: scope.canonicalRootRelativePaths[0]!, baselineSha256, scope, patchSha256: crypto.createHash("sha256").update(JSON.stringify(input.patch), "utf8").digest("hex") };
  }

  private existingRequest(taskId: string, input: DecisionRequestCreateInput, target: ReturnType<ProductionBindings["createTarget"]>): CreatedDecisionRequest | undefined {
    const read = this.store.readTaskState(this.options.workspace.id, taskId);
    if (read.status === "NOT_FOUND") return undefined;
    if (read.status !== "VALID") throw new ProductionBindingError("DECISION_REQUEST_TASK_STATE_INVALID");
    // A consumed contract with a resolved action is a valid continuation point
    // for the same long-running task. The caller must advance the action epoch
    // before opening the next request; it is not an idempotent reuse case.
    if (
      read.state.state === "BUILDING" &&
      !read.state.pendingReasoning &&
      read.state.activeAction?.resolvedAt &&
      read.state.activeContract?.lifecycle === "CONSUMED"
    ) return undefined;
    const pending = read.state.pendingReasoning;
    const action = read.state.activeAction;
    const critical = action?.actionDescriptor?.criticalInput as Partial<ApprovedPatch> | undefined;
    if (
      read.state.state !== "WAITING_DECISION" || !pending || pending.status !== "WAITING_DECISION" || !action ||
      action.actionDescriptor?.actionType !== CONTROLLED_WRITE_MODE || action.actionDescriptor.target !== target.target ||
      critical?.expectedContent !== input.patch.expected_content || critical.replacementContent !== input.patch.replacement_content ||
      critical.expectedHash !== target.baselineSha256 || pending.packet.constraints[0] !== input.scope_summary ||
      pending.packet.scopeDescriptor.workspaceId !== this.options.workspace.id || pending.packet.scopeDescriptor.canonicalRootRelativePaths.length !== 1 ||
      pending.packet.scopeDescriptor.canonicalRootRelativePaths[0] !== target.target || pending.packet.validUntil === undefined
    ) throw new ProductionBindingError("DECISION_REQUEST_TASK_CONFLICT");
    return {
      decisionRequestId: pending.packet.requestId,
      taskId,
      workspaceId: this.options.workspace.id,
      targetFile: target.target,
      operation: CONTROLLED_WRITE_MODE,
      baselineSha256: target.baselineSha256,
      patchSha256: target.patchSha256,
      scopeDigest: scopeDigest(pending.packet.scopeDescriptor),
      createdAt: pending.createdAt,
      expiresAt: pending.packet.validUntil,
      idempotent: true,
    };
  }

  createDecisionRequest(authInfo: AuthInfo | undefined, rawInput: unknown): CreatedDecisionRequest {
    const verifiedAuth = this.assertTrustedAuth(authInfo, "decision.submit");
    const input = DecisionRequestCreateInputSchema.parse(rawInput);
    const target = this.createTarget(input);
    const existing = this.existingRequest(input.task_id, input, target);
    const callerClient = this.options.authStore?.getClient(verifiedAuth.clientId);
    const identity = {
      callerClientIdentityPresent: true as const,
      callerClientIdFingerprint: identityFingerprint(verifiedAuth.clientId),
      callerClientRegistered: Boolean(callerClient),
      callerClientRegistrationFingerprint: callerClient ? identityFingerprint(callerClient.clientId) : undefined,
      configuredTrustedClientFingerprint: identityFingerprint(this.options.trustedHumanClientId),
      trustedClientMatch: verifiedAuth.clientId === this.options.trustedHumanClientId,
    };
    if (existing) return { ...existing, ...identity };

    const prior = this.store.readTaskState(this.options.workspace.id, input.task_id);
    const continuation = prior.status === "VALID" &&
      prior.state.state === "BUILDING" &&
      !prior.state.pendingReasoning &&
      !!prior.state.activeAction?.resolvedAt &&
      prior.state.activeContract?.lifecycle === "CONSUMED";
    if (prior.status !== "NOT_FOUND" && !continuation) {
      throw new ProductionBindingError("DECISION_REQUEST_TASK_CONFLICT");
    }
    const created = prior.status === "NOT_FOUND"
      ? this.store.createTaskStateWithId(this.options.workspace.id, input.task_id)
      : prior.state;
    const building = prior.status === "NOT_FOUND"
      ? this.store.transitionTask(this.options.workspace.id, created.taskId, created.revision, "BUILDING")
      : created;
    return this.withServerLease(created.taskId, "decision-request-create", (owner) => {
      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + DECISION_REQUEST_TTL_MS).toISOString();
      const requestId = `decision_${crypto.randomBytes(16).toString("hex")}`;
      const actionId = `action_${crypto.randomBytes(16).toString("hex")}`;
      const semanticRequestId = `semantic_${crypto.randomBytes(16).toString("hex")}`;
      const approvedAuthority = continuation ? building.activeAction?.approvedAuthority : undefined;
      if (continuation && !approvedAuthority) throw new ProductionBindingError("MISSING_APPROVED_AUTHORITY_DENIED");
      const approvedScopeDigest = approvedAuthority?.approvedScopeDigest ?? scopeDigest(target.scope);
      const criticalInput: ApprovedPatch = {
        expectedContent: input.patch.expected_content,
        replacementContent: input.patch.replacement_content,
        expectedHash: target.baselineSha256,
      };
      const actionDescriptor = {
        schemaVersion: "action-descriptor-v1" as const,
        actionType: CONTROLLED_WRITE_MODE,
        target: target.target,
        approvedScopeDigest,
        criticalInput,
        criticalInputDigest: criticalInputDigest(criticalInput),
      };
      const digest = actionDigest(actionDescriptor);
      const active = this.store.beginActiveAction(this.options.workspace.id, created.taskId, building.revision, owner, {
        actionId,
        semanticRequestId,
        actionEpoch: continuation ? (building.activeAction?.actionEpoch ?? 0) + 1 : 1,
        validUntil: expiresAt,
        startedAt: createdAt,
        approvedAuthority: approvedAuthority ?? {
          approvedScopeDescriptor: target.scope,
          approvedScopeDigest,
          approvedActionIds: [CONTROLLED_WRITE_MODE],
          globalForbiddenActionIds: [],
        },
        actionDescriptor,
        actionDigest: digest,
      });
      const pending = this.decisions.createDecisionRequest(this.options.workspace.id, created.taskId, active.revision, owner, {
        schemaVersion: "reasoning-packet-v1" as const,
        workspaceId: this.options.workspace.id,
        taskId: created.taskId,
        semanticRequestId,
        requestId,
        actionEpoch: continuation ? (building.activeAction?.actionEpoch ?? 0) + 1 : 1,
        gateKind: "SPECIFICATION_AMBIGUITY",
        currentTaskState: "BUILDING",
        activeActionId: actionId,
        exactIssue: "Trusted human approval is required for one exact PATCH_EXISTING_TEXT request.",
        evidenceRefs: [`baseline:sha256:${target.baselineSha256}`, `patch:sha256:${target.patchSha256}`],
        attemptedFixes: [],
        constraints: [input.scope_summary],
        candidateActionIds: [CONTROLLED_WRITE_MODE],
        forbiddenActionIds: [],
        scopeDescriptor: target.scope,
        actionDigest: digest,
        createdAt,
        validUntil: expiresAt,
      });
      if (pending.state !== "WAITING_DECISION" || pending.pendingReasoning?.packet.requestId !== requestId) throw new ProductionBindingError("DECISION_REQUEST_CREATE_FAILED");
      return { decisionRequestId: requestId, taskId: created.taskId, workspaceId: this.options.workspace.id, targetFile: target.target, operation: CONTROLLED_WRITE_MODE, baselineSha256: target.baselineSha256, patchSha256: target.patchSha256, scopeDigest: approvedScopeDigest, createdAt, expiresAt, idempotent: false, ...identity };
    });
  }

  private approvedPatch(state: TaskState): { target: string; actionClass: string; patch: ApprovedPatch } {
    const action = state.activeAction;
    const critical = action?.actionDescriptor?.criticalInput;
    if (!action?.actionDescriptor || action.actionDescriptor.actionType !== "PATCH_EXISTING_TEXT" || !critical || typeof critical !== "object" || Array.isArray(critical)) {
      throw new ProductionBindingError("APPROVED_PATCH_REQUIRED");
    }
    const value = critical as Partial<ApprovedPatch>;
    if (typeof value.expectedContent !== "string" || typeof value.replacementContent !== "string" || typeof value.expectedHash !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.expectedHash)) {
      throw new ProductionBindingError("APPROVED_PATCH_REQUIRED");
    }
    return { target: action.actionDescriptor.target, actionClass: action.actionDescriptor.actionType, patch: { expectedContent: value.expectedContent, replacementContent: value.replacementContent, expectedHash: value.expectedHash } };
  }

  submitTrustedDecision(authInfo: AuthInfo | undefined, input: TrustedHumanDecisionInput) {
    const verified = this.assertTrustedAuth(authInfo, "decision.submit");
    const located = this.locateDecisionTask(input.decision_request_id);
    return this.withServerLease(located.taskId, "decision", (owner) => {
      const ingress = new TrustedHumanIngressAdapter({
        decisionService: this.decisions,
        stateStore: this.store,
        trustedClientId: this.options.trustedHumanClientId,
        trustedWorkspaceId: this.options.workspace.id,
      });
      return ingress.submit({ authInfo: verified, workspaceId: this.options.workspace.id, taskId: located.taskId, mutationLeaseOwner: owner }, input);
    });
  }

  executeApprovedPatch(authInfo: AuthInfo | undefined, decisionRequestId: string): ControlledWriteReceipt {
    this.assertTrustedAuth(authInfo, "workspace.write");
    const located = this.locateDecisionTask(decisionRequestId);
    return this.withServerLease(located.taskId, "controlled-write", (owner) => {
      const current = this.store.readTaskState(this.options.workspace.id, located.taskId);
      if (current.status !== "VALID") throw new ProductionBindingError("SERVER_DECISION_CONTEXT_NOT_FOUND");
      const approved = this.approvedPatch(current.state);
      const binding = bindDecisionReceiptToControlledWrite(this.decisions, {
        workspaceId: this.options.workspace.id,
        taskId: located.taskId,
        decisionRequestId,
        target: approved.target,
        actionClass: approved.actionClass,
      });
      const reference = current.state.activeContract;
      const action = current.state.activeAction;
      if (!reference || !action) throw new ProductionBindingError("CURRENT_DECISION_NOT_WRITABLE");
      const begun = this.decisions.beginContractConsumption(this.options.workspace.id, located.taskId, current.state.revision, owner, action.actionId, approved.actionClass, reference.binding.scopeDigest);
      const started = this.decisions.markMutationStarted(this.options.workspace.id, located.taskId, begun.state.revision, owner, begun.consumptionId);
      const result = executeControlledWrite({
        taskId: started.taskId,
        workspaceId: started.workspaceId,
        targetPath: approved.target,
        writeMode: "PATCH_EXISTING_TEXT",
        expectedScope: "workspace.write",
        authorizationRef: binding.authorization.authorizationRef,
        reason: `Approved decision ${decisionRequestId}`,
        patch: { expectedContent: approved.patch.expectedContent, replacementContent: approved.patch.replacementContent },
        precondition: { expectedHash: approved.patch.expectedHash },
      }, { workspace: this.options.workspace, authorization: binding.authorization, allowedPathPrefixes: binding.allowedPathPrefixes });
      if (result.receipt.mutationState === "UNKNOWN") throw new ProductionBindingError("CONTROLLED_WRITE_RESULT_UNKNOWN");
      const resultDigest = crypto.createHash("sha256").update(JSON.stringify(result.receipt), "utf8").digest("hex");
      const record = appendExecutionRecord(this.options.workspace.id, {
        taskId: started.taskId,
        iteration: started.iteration,
        changedFiles: [approved.target],
        tests: "controlled-write",
        exitStatus: result.receipt.result,
        timestamp: new Date().toISOString(),
        controlledWriteReceipt: result.receipt,
        contractId: reference.contractId,
        consumptionId: begun.consumptionId,
        resultDigest,
      });
      this.decisions.finalizeContractConsumption(this.options.workspace.id, located.taskId, started.revision, owner, begun.consumptionId, record.recordId!, resultDigest);
      return result.receipt;
    });
  }
}
