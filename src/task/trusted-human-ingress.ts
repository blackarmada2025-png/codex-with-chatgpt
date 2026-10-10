import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { sha256, type DecisionReceiptV1, type DecisionResponsePayloadV1 } from "./decision-protocol.js";
import { DecisionService } from "./decision-service.js";
import { TaskStateStore, type MutationLeaseOwner, type TaskState } from "./state.js";

/** This scope is an inactive future requirement; this module does not register or grant it. */
export const TRUSTED_HUMAN_DECISION_SUBMIT_SCOPE = "decision.submit";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

/**
 * The entire untrusted decision surface.  In particular it deliberately has
 * no task, workspace, scope, target, action-class, or authority fields.
 */
export const TrustedHumanDecisionInputSchema = z.object({
  decision_request_id: identifier,
  disposition: z.enum(["EXECUTE", "HUMAN_GATE_REQUIRED", "STOP"]),
}).strict();
export type TrustedHumanDecisionInput = z.infer<typeof TrustedHumanDecisionInputSchema>;

/**
 * This context is constructed by a future authenticated server route, never
 * from a model/tool request. TRUSTED_INGRESS_REQUIRES_MIDDLEWARE_ISSUED_AUTHINFO
 * remains an integration invariant until that route is registered. It
 * intentionally reuses the existing OAuth AuthInfo shape and mutation lease.
 */
export interface TrustedHumanIngressContext {
  authInfo?: Pick<AuthInfo, "clientId" | "scopes">;
  workspaceId?: string;
  taskId?: string;
  mutationLeaseOwner?: MutationLeaseOwner;
}

export interface TrustedHumanIngressAdapterOptions {
  decisionService: DecisionService;
  stateStore: TaskStateStore;
  /** Existing registered OAuth client; no new client identity is issued here. */
  trustedClientId: string;
  /** Existing gateway workspace binding. */
  trustedWorkspaceId: string;
  /** Kept configurable only for a formally equivalent future scope. */
  requiredScope?: string;
  now?: () => Date;
}

export class TrustedHumanIngressError extends Error {
  constructor(public code: string, message = code) {
    super(message);
  }
}

/**
 * Module-only adapter for a platform-approved human decision.  It does not
 * expose an MCP action, persist a new record, issue a token, or mint a receipt.
 * Existing DecisionService remains the sole receipt/contract authority.
 */
export class TrustedHumanIngressAdapter {
  private readonly requiredScope: string;
  private readonly now: () => Date;

  constructor(private readonly options: TrustedHumanIngressAdapterOptions) {
    this.requiredScope = options.requiredScope ?? TRUSTED_HUMAN_DECISION_SUBMIT_SCOPE;
    this.now = options.now ?? (() => new Date());
  }

  private validateTrustedContext(context: TrustedHumanIngressContext): {
    workspaceId: string;
    taskId: string;
    owner: MutationLeaseOwner;
  } {
    const auth = context.authInfo;
    if (!auth?.clientId || !Array.isArray(auth.scopes)) throw new TrustedHumanIngressError("TRUSTED_AUTH_REQUIRED");
    if (auth.clientId !== this.options.trustedClientId) throw new TrustedHumanIngressError("TRUSTED_CLIENT_MISMATCH");
    if (!auth.scopes.includes(this.requiredScope)) throw new TrustedHumanIngressError("TRUSTED_SCOPE_REQUIRED");
    if (!context.workspaceId || context.workspaceId !== this.options.trustedWorkspaceId) {
      throw new TrustedHumanIngressError("TRUSTED_WORKSPACE_MISMATCH");
    }
    if (!context.taskId || !context.mutationLeaseOwner) throw new TrustedHumanIngressError("SERVER_DECISION_CONTEXT_REQUIRED");
    return { workspaceId: context.workspaceId, taskId: context.taskId, owner: context.mutationLeaseOwner };
  }

  private readState(workspaceId: string, taskId: string): TaskState {
    const read = this.options.stateStore.readTaskState(workspaceId, taskId);
    if (read.status !== "VALID") throw new TrustedHumanIngressError("SERVER_DECISION_CONTEXT_NOT_FOUND");
    return read.state;
  }

  private receipt(state: TaskState, requestId: string): DecisionReceiptV1 | undefined {
    return state.decisionReceipts?.find((candidate) => candidate.requestId === requestId);
  }

  /** Only server-derived fields enter the established DecisionResponse schema. */
  private payload(input: TrustedHumanDecisionInput, state: TaskState, existing?: DecisionReceiptV1): DecisionResponsePayloadV1 {
    let requestedActionIds: string[] = [];
    if (input.disposition === "EXECUTE") {
      if (existing) {
        requestedActionIds = existing.response.requestedActionIds;
      } else {
        const candidates = state.pendingReasoning?.packet.candidateActionIds ?? [];
        // The intentionally thin ingress has no model-controlled action selection.
        if (candidates.length !== 1) throw new TrustedHumanIngressError("EXECUTE_ACTION_SELECTION_AMBIGUOUS");
        requestedActionIds = [candidates[0]!];
      }
    }
    return {
      schemaVersion: "decision-response-v1",
      responseId: `human_${sha256({ requestId: input.decision_request_id, clientId: this.options.trustedClientId, disposition: input.disposition })}`,
      disposition: input.disposition,
      summary: `Trusted human decision: ${input.disposition}.`,
      requestedActionIds,
      preconditions: [],
      acceptanceCriteria: [],
      stopConditions: [],
    };
  }

  /**
   * Returns the receipt generated by DecisionService.  `context` is trusted
   * server context; `rawInput` is the sole model/tool-controlled value.
   */
  submit(context: TrustedHumanIngressContext, rawInput: unknown): DecisionReceiptV1 {
    const input = TrustedHumanDecisionInputSchema.parse(rawInput);
    const trusted = this.validateTrustedContext(context);
    const state = this.readState(trusted.workspaceId, trusted.taskId);
    const existing = this.receipt(state, input.decision_request_id);

    if (!existing) {
      // This existing service read verifies task/workspace, current action epoch,
      // approved scope, action digest (therefore target/action class), and packet integrity.
      const packet = this.options.decisionService.readPendingDecision(
        trusted.workspaceId,
        trusted.taskId,
        input.decision_request_id,
      );
      if (Date.parse(packet.validUntil) <= this.now().getTime()) {
        throw new TrustedHumanIngressError("DECISION_REQUEST_EXPIRED");
      }
    }

    const next = this.options.decisionService.submitDecisionResponse(
      trusted.workspaceId,
      trusted.taskId,
      state.revision,
      trusted.owner,
      input.decision_request_id,
      this.payload(input, state, existing),
    );
    const receipt = this.receipt(next, input.decision_request_id);
    if (!receipt) throw new TrustedHumanIngressError("DECISION_RECEIPT_NOT_MINTED");
    return receipt;
  }
}
