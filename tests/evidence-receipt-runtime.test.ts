import { afterEach, describe, expect, it } from "vitest";
import { canReuseEvidenceReceipt, createReusableEvidenceReceipt, type EvidenceReceiptRequest } from "../src/execution/evidence-receipt.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const request: Required<EvidenceReceiptRequest> = {
  objectIdentity: "Agent Governance V1",
  objectHashOrVersion: "BFFF459BDD5FCB4C8759005ABB5FC0C188D3B703DC02FC890D0C561B8C1A10FA",
  validationType: "RULE_IDS_G01_G10",
  scope: "Rule IDs only",
  environment: "isolated-test",
};

describe("runtime reusable evidence receipts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("round-trips a receipt through existing execution JSONL while legacy JSONL remains readable", () => {
    dirs.push(isolateStateDir());
    appendExecutionRecord("receipt-test", { taskId: "legacy", iteration: 1, changedFiles: 0, tests: null, exitStatus: "ok", timestamp: "2026-09-11T00:00:00.000Z" });
    const receipt = createReusableEvidenceReceipt(request, "2026-09-11T00:01:00.000Z", "validation:1");
    expect(receipt).not.toBeNull();
    appendExecutionRecord("receipt-test", { taskId: "current", iteration: 2, changedFiles: 0, tests: "pass", exitStatus: "ok", timestamp: "2026-09-11T00:01:00.000Z", reusableEvidenceReceipt: receipt ?? undefined });
    const [legacy, current] = readExecutionRecords("receipt-test", 2);
    expect(legacy.reusableEvidenceReceipt).toBeUndefined();
    expect(current.reusableEvidenceReceipt).toEqual(receipt);
  });

  it("reuses only an exact, complete passed receipt", () => {
    const receipt = createReusableEvidenceReceipt(request, "2026-09-11T00:00:00.000Z", "validation:1");
    expect(canReuseEvidenceReceipt(receipt ?? undefined, request)).toBe(true);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, { ...request, objectHashOrVersion: "changed" })).toBe(false);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, { ...request, validationType: "changed" })).toBe(false);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, { ...request, scope: "expanded" })).toBe(false);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, { ...request, environment: "changed" })).toBe(false);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, { ...request, scope: "" })).toBe(false);
  });

  it("forces revalidation for high-risk and production validation", () => {
    const receipt = createReusableEvidenceReceipt(request, "2026-09-11T00:00:00.000Z", "validation:1");
    expect(canReuseEvidenceReceipt(receipt ?? undefined, request, { highRisk: true })).toBe(false);
    expect(canReuseEvidenceReceipt(receipt ?? undefined, request, { productionValidation: true })).toBe(false);
  });
});
