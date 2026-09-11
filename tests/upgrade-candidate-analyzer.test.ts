import { describe, expect, it } from "vitest";
import { analyzeUpgradeCandidates, unsupportedUpgradeSignals, type UpgradeSignalEvent } from "../src/learning/upgrade-candidate-analyzer.js";

function event(overrides: Partial<UpgradeSignalEvent> = {}): UpgradeSignalEvent {
  return {
    eventId: "event-1",
    taskId: "task-1",
    kind: "TIMEOUT",
    groupKey: "gateway-health",
    evidenceRef: "execution:1",
    ...overrides,
  };
}

describe("upgrade candidate analyzer", () => {
  it("does not count repeated reads of one event as independent evidence", () => {
    expect(analyzeUpgradeCandidates({ signalEvents: [event(), event()] })).toEqual([]);
  });

  it("suggests repeated independent timeouts", () => {
    const [suggestion] = analyzeUpgradeCandidates({
      signalEvents: [event(), event({ eventId: "event-2", evidenceRef: "execution:2" })],
    });
    expect(suggestion).toMatchObject({ signalId: "S04", independentEventCount: 2, evidenceStrength: "STRONG", recommendedAction: "PROPOSE_UPGRADE" });
  });

  it("suggests repeated confirmation for the same authorization scope", () => {
    const [suggestion] = analyzeUpgradeCandidates({
      signalEvents: [
        event({ kind: "CONFIRMATION", groupKey: "commit:abc/scope:tests/risk:low", eventId: "confirm-1" }),
        event({ kind: "CONFIRMATION", groupKey: "commit:abc/scope:tests/risk:low", eventId: "confirm-2", evidenceRef: "authorization:2" }),
      ],
    });
    expect(suggestion).toMatchObject({ signalId: "S02", independentEventCount: 2 });
  });

  it("does not treat one event as repeated", () => {
    expect(analyzeUpgradeCandidates({ signalEvents: [event()] })).toEqual([]);
  });

  it("reuses an explicit existing Maintenance match instead of proposing a duplicate", () => {
    const [suggestion] = analyzeUpgradeCandidates({
      signalEvents: [event({ kind: "VALIDATION_STEP", eventId: "validation-1" }), event({ kind: "VALIDATION_STEP", eventId: "validation-2", evidenceRef: "validation:2" })],
      existingMaintenance: [{ maintenanceId: "MNT-20260909-12", signalIds: ["S06"] }],
    });
    expect(suggestion).toMatchObject({ existingMaintenanceMatch: "YES", newCandidateRequired: false, recommendedAction: "OBSERVE" });
  });

  it("returns no suggestion where evidence is insufficient and keeps unsupported signals explicit", () => {
    expect(analyzeUpgradeCandidates({ signalEvents: [event({ kind: "MANUAL_RELAY" })] })).toEqual([]);
    expect(unsupportedUpgradeSignals()).toEqual([
      { signalId: "S05", evidenceStrength: "NOT_ENOUGH_EVIDENCE" },
      { signalId: "S07", evidenceStrength: "NOT_ENOUGH_EVIDENCE" },
      { signalId: "S08", evidenceStrength: "NOT_ENOUGH_EVIDENCE" },
      { signalId: "S09", evidenceStrength: "NOT_ENOUGH_EVIDENCE" },
    ]);
  });
});
