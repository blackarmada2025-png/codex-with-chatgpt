import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IsolatedEvidenceReceiptStore, type ReceiptRequest } from "./helpers/reusable-evidence-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const RULE_ID_CONTENT = "RULE_ID = G01\nRULE_ID = G02\nRULE_ID = G03\nRULE_ID = G04\nRULE_ID = G05\nRULE_ID = G06\nRULE_ID = G07\nRULE_ID = G08\nRULE_ID = G09\nRULE_ID = G10\n";

function isolatedRuleValidation(): { request: Required<ReceiptRequest>; validate: () => { evidenceReference: string } } {
  const dir = makeTmpDir("reusable-evidence-receipt");
  dirs.push(dir);
  const file = path.join(dir, "canonical.md");
  fs.writeFileSync(file, RULE_ID_CONTENT);
  const bytes = fs.readFileSync(file);
  const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();

  return {
    request: {
  objectIdentity: "Agent Governance V1",
      objectHashOrVersion: hash,
  validationType: "RULE_IDS_G01_G10",
  scope: "Rule IDs only",
  environment: "isolated-test",
    },
    validate: () => {
      const ruleIds = [...fs.readFileSync(file, "utf8").matchAll(/^RULE_ID = (G\d{2})$/gm)].map((match) => match[1]);
      expect(ruleIds).toEqual(["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10"]);
      return { evidenceReference: `file:${path.basename(file)}:sha256:${hash}` };
    },
  };
}

const dirs: string[] = [];

describe("reusable evidence receipt isolated acceptance", () => {
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("executes once and reuses a receipt for an exact request", () => {
    const store = new IsolatedEvidenceReceiptStore();
    let executions = 0;
    const { request, validate: validateRuleIds } = isolatedRuleValidation();
    const validate = () => {
      executions += 1;
      return validateRuleIds();
    };

    const first = store.validateOrReuse(request, validate, "2026-09-11T00:00:00.000Z");
    const second = store.validateOrReuse(request, validate, "2026-09-11T00:01:00.000Z");

    expect(first.kind).toBe("executed");
    expect(second.kind).toBe("reused");
    expect(executions).toBe(1);
    if (first.kind === "executed" && second.kind === "reused") {
      expect(second.receipt).toEqual(first.receipt);
    }
  });

  it("invalidates the receipt when the object hash or validation contract changes", () => {
    const store = new IsolatedEvidenceReceiptStore();
    let executions = 0;
    const { request, validate: validateRuleIds } = isolatedRuleValidation();
    const validate = () => {
      executions += 1;
      return validateRuleIds();
    };
    store.validateOrReuse(request, validate, "2026-09-11T00:00:00.000Z");

    const changedHash = store.validateOrReuse({ ...request, objectHashOrVersion: "CHANGED" }, validate, "2026-09-11T00:01:00.000Z");
    const changedContract = store.validateOrReuse({ ...request, validationType: "RULE_IDS_G01_G10_V2" }, validate, "2026-09-11T00:02:00.000Z");

    expect(changedHash.kind).toBe("executed");
    expect(changedContract.kind).toBe("executed");
    expect(executions).toBe(3);
  });

  it("fails closed for missing fields and invalidates on scope or environment change", () => {
    const store = new IsolatedEvidenceReceiptStore();
    let executions = 0;
    const { request, validate: validateRuleIds } = isolatedRuleValidation();
    const validate = () => {
      executions += 1;
      return validateRuleIds();
    };
    store.validateOrReuse(request, validate, "2026-09-11T00:00:00.000Z");

    const missing = store.validateOrReuse({ ...request, scope: "" }, validate, "2026-09-11T00:01:00.000Z");
    const expandedScope = store.validateOrReuse({ ...request, scope: "Rule IDs and status" }, validate, "2026-09-11T00:02:00.000Z");
    const changedEnvironment = store.validateOrReuse({ ...request, environment: "different-isolated-test" }, validate, "2026-09-11T00:03:00.000Z");

    expect(missing).toEqual({ kind: "invalid", reason: "MISSING_REQUIRED_FIELD" });
    expect(expandedScope.kind).toBe("executed");
    expect(changedEnvironment.kind).toBe("executed");
    expect(executions).toBe(3);
  });
});
