import type { ExecutionRecord } from "../execution/records.js";
import type { TaskCheckpoint } from "../session/state.js";

export type UpgradeSignalId = "S01" | "S02" | "S03" | "S04" | "S05" | "S06" | "S07" | "S08" | "S09" | "S10";
export type UpgradeEventKind =
  | "MANUAL_RELAY"
  | "CONFIRMATION"
  | "NO_INFORMATION_GAIN"
  | "TIMEOUT"
  | "VALIDATION_STEP"
  | "NATIVE_CAPABILITY_UNUSED";

export interface UpgradeSignalEvent {
  eventId: string;
  taskId: string;
  kind: UpgradeEventKind;
  groupKey: string;
  evidenceRef: string;
}

export interface ExistingMaintenance {
  maintenanceId: string;
  signalIds: UpgradeSignalId[];
}

export interface UpgradeCandidateSuggestion {
  signalId: UpgradeSignalId;
  problem: string;
  sourceTask: string;
  evidenceRefs: string[];
  independentEventCount: number;
  evidenceStrength: "NOT_ENOUGH_EVIDENCE" | "SUPPORTED" | "STRONG";
  value: "LOW" | "MEDIUM" | "HIGH";
  risk: "LOW" | "MEDIUM" | "HIGH";
  nativeCapabilityReuse: boolean;
  proposedChange: string;
  validationTarget: string;
  recommendedAction: "IGNORE" | "OBSERVE" | "VALIDATE" | "PROPOSE_UPGRADE" | "HUMAN_GATE";
  existingMaintenanceMatch: "YES" | "NO";
  newCandidateRequired: boolean;
}

export interface UnsupportedUpgradeSignal {
  signalId: UpgradeSignalId;
  evidenceStrength: "NOT_ENOUGH_EVIDENCE";
}

export interface UpgradeCandidateAnalyzerInput {
  checkpoint?: Pick<TaskCheckpoint, "taskId" | "nativeThreadId">;
  executionRecords?: readonly Pick<ExecutionRecord, "taskId" | "nativeThreadId">[];
  signalEvents?: readonly UpgradeSignalEvent[];
  existingMaintenance?: readonly ExistingMaintenance[];
}

const SIGNALS: Record<UpgradeEventKind, { id: UpgradeSignalId; problem: string; proposedChange: string; validationTarget: string; nativeCapabilityReuse: boolean }> = {
  MANUAL_RELAY: {
    id: "S01",
    problem: "Repeated manual relay between task surfaces.",
    proposedChange: "Reuse the existing native thread correlation before adding a new relay step.",
    validationTarget: "Two independent relays resolve through the existing native thread path.",
    nativeCapabilityReuse: true,
  },
  CONFIRMATION: {
    id: "S02",
    problem: "Repeated confirmation under the same authorization scope.",
    proposedChange: "Reuse the existing authorization receipt for the unchanged scope.",
    validationTarget: "A repeated same-scope action proceeds without a duplicate confirmation request.",
    nativeCapabilityReuse: false,
  },
  NO_INFORMATION_GAIN: {
    id: "S03",
    problem: "Repeated path produced no new information.",
    proposedChange: "Record the stop condition and route to a different evidence path.",
    validationTarget: "The second no-gain attempt produces a STOP or reframe decision.",
    nativeCapabilityReuse: false,
  },
  TIMEOUT: {
    id: "S04",
    problem: "Repeated timeout in the same execution path.",
    proposedChange: "Validate a bounded alternative collection or retry path.",
    validationTarget: "Two independent timeouts are correlated without automatic implementation.",
    nativeCapabilityReuse: false,
  },
  VALIDATION_STEP: {
    id: "S06",
    problem: "Repeated validation step with reusable evidence.",
    proposedChange: "Reuse the validated check through the existing task workflow.",
    validationTarget: "Repeated validation reuses an evidence receipt without reducing required coverage.",
    nativeCapabilityReuse: false,
  },
  NATIVE_CAPABILITY_UNUSED: {
    id: "S10",
    problem: "Available native thread capability was not used.",
    proposedChange: "Prefer the existing native thread correlation path for the applicable task.",
    validationTarget: "An eligible task uses existing native thread correlation without new infrastructure.",
    nativeCapabilityReuse: true,
  },
};

const UNSUPPORTED_SIGNALS: readonly UpgradeSignalId[] = ["S05", "S07", "S08", "S09"];

function nativeCapabilityUnused(input: UpgradeCandidateAnalyzerInput): UpgradeSignalEvent[] {
  const checkpoint = input.checkpoint;
  if (!checkpoint?.nativeThreadId) return [];
  const used = input.executionRecords?.some(
    (record) => record.taskId === checkpoint.taskId && record.nativeThreadId === checkpoint.nativeThreadId
  );
  if (used) return [];
  return [{
    eventId: `native-unused:${checkpoint.taskId}:${checkpoint.nativeThreadId}`,
    taskId: checkpoint.taskId,
    kind: "NATIVE_CAPABILITY_UNUSED",
    groupKey: checkpoint.nativeThreadId,
    evidenceRef: `checkpoint:${checkpoint.taskId}`,
  }];
}

/**
 * Read-only deterministic analysis. It creates no Maintenance Pool records;
 * callers must use the existing controlled-write process for any promotion.
 */
export function analyzeUpgradeCandidates(input: UpgradeCandidateAnalyzerInput): UpgradeCandidateSuggestion[] {
  const uniqueEvents = new Map<string, UpgradeSignalEvent>();
  for (const event of [...(input.signalEvents ?? []), ...nativeCapabilityUnused(input)]) {
    if (SIGNALS[event.kind]) uniqueEvents.set(event.eventId, event);
  }

  const groups = new Map<string, UpgradeSignalEvent[]>();
  for (const event of uniqueEvents.values()) {
    const signal = SIGNALS[event.kind];
    const key = `${signal.id}:${event.taskId}:${event.groupKey}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  const maintenance = input.existingMaintenance ?? [];
  const suggestions: UpgradeCandidateSuggestion[] = [];
  for (const events of groups.values()) {
    const first = events[0];
    const signal = SIGNALS[first.kind];
    const independentEventCount = events.length;
    if (independentEventCount < 2) continue;
    const matched = maintenance.some((entry) => entry.signalIds.includes(signal.id));
    suggestions.push({
      signalId: signal.id,
      problem: signal.problem,
      sourceTask: first.taskId,
      evidenceRefs: events.map((event) => event.evidenceRef),
      independentEventCount,
      evidenceStrength: independentEventCount >= 2 ? "STRONG" : "NOT_ENOUGH_EVIDENCE",
      value: "MEDIUM",
      risk: "LOW",
      nativeCapabilityReuse: signal.nativeCapabilityReuse,
      proposedChange: signal.proposedChange,
      validationTarget: signal.validationTarget,
      recommendedAction: matched ? "OBSERVE" : "PROPOSE_UPGRADE",
      existingMaintenanceMatch: matched ? "YES" : "NO",
      newCandidateRequired: !matched,
    });
  }
  return suggestions;
}

/** Signals intentionally deferred until their source telemetry has direct evidence. */
export function unsupportedUpgradeSignals(): readonly UnsupportedUpgradeSignal[] {
  return UNSUPPORTED_SIGNALS.map((signalId) => ({ signalId, evidenceStrength: "NOT_ENOUGH_EVIDENCE" }));
}
