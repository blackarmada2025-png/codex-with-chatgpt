import { DecisionService } from "./decision-service.js";
import type { ControlledWriteAuthorization } from "../workspace/controlled-write.js";

export interface ControlledWriteDecisionBinding {
  authorization: ControlledWriteAuthorization;
  allowedPathPrefixes: string[];
}

/** Unregistered adapter; DecisionService reloads the canonical TaskState itself. */
export function bindDecisionReceiptToControlledWrite(
  decisionService: DecisionService,
  input: { workspaceId: string; taskId: string; decisionRequestId: string; target: string; actionClass: string },
): ControlledWriteDecisionBinding {
  return decisionService.bindCurrentDecisionToControlledWrite(
    input.workspaceId,
    input.taskId,
    input.decisionRequestId,
    input.target,
    input.actionClass,
  );
}
