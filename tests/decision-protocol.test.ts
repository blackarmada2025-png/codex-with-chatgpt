import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  actionDigest, bindDecisionResponse, canonicalizeScopeDescriptor, criticalInputDigest, DecisionProtocolError,
  DecisionResponsePayloadV1Schema, decisionResponseDigest, materializeExecutionContract, reasoningPacketDigest, scopeDigest, validateContractBinding,
  type ReasoningPacketV1,
} from "../src/task/decision-protocol.js";

const dirs: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-protocol-")); dirs.push(value); return value; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function packet(workspaceId = "ws", taskId = "task"): ReasoningPacketV1 {
  const scope = { schemaVersion: "scope-descriptor-v1" as const, workspaceId, canonicalRootRelativePaths: ["src", "src/"], accessMode: "WRITE" as const, excludedPaths: ["src/private"] };
  const actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
  return {
    schemaVersion: "reasoning-packet-v1", workspaceId, taskId, semanticRequestId: "semantic", requestId: "request", actionEpoch: 2,
    gateKind: "SPECIFICATION_AMBIGUITY", currentTaskState: "WAITING_DECISION", activeActionId: "action",
    exactIssue: "Need a bounded semantic decision.", evidenceRefs: ["record:1"], attemptedFixes: ["local fix"], constraints: ["no production"],
    candidateActionIds: ["A", "B"], forbiddenActionIds: ["FORBIDDEN"], scopeDescriptor: scope, actionDigest: actionDigest(actionDescriptor),
    createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-01-02T00:00:00.000Z",
  };
}

describe("Decision Protocol V1", () => {
  it("canonicalizes scopes deterministically and rejects traversal", () => {
    const workspace = root(); fs.mkdirSync(path.join(workspace, "src", "private"), { recursive: true });
    const canonical = canonicalizeScopeDescriptor(workspace, packet().scopeDescriptor);
    expect(canonical.canonicalRootRelativePaths).toEqual(["src"]);
    expect(scopeDigest(canonical)).toBe(scopeDigest(canonicalizeScopeDescriptor(workspace, canonical)));
    expect(() => canonicalizeScopeDescriptor(workspace, { ...canonical, canonicalRootRelativePaths: ["../escape"] })).toThrow(DecisionProtocolError);
  });

  it("rejects a symlink escape even when the final leaf does not exist", () => {
    const workspace = root(), outside = root(); fs.mkdirSync(path.join(workspace, "safe")); fs.symlinkSync(outside, path.join(workspace, "safe", "out"), "junction");
    expect(() => canonicalizeScopeDescriptor(workspace, { schemaVersion: "scope-descriptor-v1", workspaceId: "ws", canonicalRootRelativePaths: ["safe/out/new-file.md"], accessMode: "WRITE", excludedPaths: [] })).toThrow(/SCOPE_PATH_ESCAPE/);
  });

  it("binds a response locally and materializes only an in-scope contract", () => {
    const workspace = root(); fs.mkdirSync(path.join(workspace, "src", "private"), { recursive: true });
    const raw = packet(), scope = canonicalizeScopeDescriptor(workspace, raw.scopeDescriptor), actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) };
    const input = { ...raw, scopeDescriptor: scope, actionDigest: actionDigest(actionDescriptor) };
    const digest = reasoningPacketDigest(input), authority = { approvedScopeDescriptor: input.scopeDescriptor, approvedScopeDigest: scopeDigest(input.scopeDescriptor), approvedActionIds: ["A", "B"], globalForbiddenActionIds: [] };
    const response = bindDecisionResponse(input, digest, { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Proceed with A.", requestedActionIds: ["A"] }, "2026-01-01T01:00:00.000Z");
    const activeAction = { actionDescriptor, actionDigest: input.actionDigest! };
    const contract = materializeExecutionContract({ contractId: "contract", packet: input, packetDigest: digest, response, approvedAuthority: authority, activeAction });
    validateContractBinding(contract, contract.binding, new Date("2026-01-01T02:00:00.000Z"));
    expect(contract.allowedActionIds).toEqual(["A"]);
    expect(contract.preconditions).toEqual([]);
    expect(contract.acceptanceCriteria).toEqual([]);
    expect(contract.stopConditions).toEqual([]);
    expect(() => materializeExecutionContract({ contractId: "bad", packet: input, packetDigest: digest, response: { ...response, requestedActionIds: ["ESCAPE"] }, approvedAuthority: authority, activeAction })).toThrow(/CONTRACT_ACTION_SCOPE_EXPANSION/);
  });

  it("rejects stale, digest-mismatched, and non-executing decisions", () => {
    const workspace = root(); fs.mkdirSync(path.join(workspace, "src", "private"), { recursive: true });
    const raw = packet(), scope = canonicalizeScopeDescriptor(workspace, raw.scopeDescriptor), actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) }, input = { ...raw, scopeDescriptor: scope, actionDigest: actionDigest(actionDescriptor) }, digest = reasoningPacketDigest(input), authority = { approvedScopeDescriptor: input.scopeDescriptor, approvedScopeDigest: scopeDigest(input.scopeDescriptor), approvedActionIds: ["A", "B"], globalForbiddenActionIds: [] };
    const response = bindDecisionResponse(input, digest, { schemaVersion: "decision-response-v1", responseId: "response", disposition: "EXECUTE", summary: "Proceed.", requestedActionIds: ["A"] }, "2026-01-01T01:00:00.000Z");
    const activeAction = { actionDescriptor, actionDigest: input.actionDigest! };
    const contract = materializeExecutionContract({ contractId: "contract", packet: input, packetDigest: digest, response, approvedAuthority: authority, activeAction });
    expect(() => validateContractBinding(contract, { ...contract.binding, requestId: "other" }, new Date("2026-01-01T02:00:00.000Z"))).toThrow(/CONTRACT_BINDING_MISMATCH/);
    expect(() => validateContractBinding({ ...contract, digest: "0".repeat(64) }, contract.binding, new Date("2026-01-01T02:00:00.000Z"))).toThrow(/CONTRACT_DIGEST_MISMATCH/);
    expect(() => validateContractBinding(contract, contract.binding, new Date("2026-01-03T00:00:00.000Z"))).toThrow(/CONTRACT_EXPIRED/);
    const stop = bindDecisionResponse(input, digest, { schemaVersion: "decision-response-v1", responseId: "stop", disposition: "STOP", summary: "Stop.", requestedActionIds: [] }, "2026-01-01T01:00:00.000Z");
    expect(() => materializeExecutionContract({ contractId: "no-contract", packet: input, packetDigest: digest, response: stop, approvedAuthority: authority, activeAction })).toThrow(/DECISION_DOES_NOT_AUTHORIZE_CONTRACT/);
  });

  it("preserves every EXECUTE constraint, adds local mandatory constraints, and binds both digests", () => {
    const workspace = root(); fs.mkdirSync(path.join(workspace, "src", "private"), { recursive: true });
    const raw = packet(), scope = canonicalizeScopeDescriptor(workspace, raw.scopeDescriptor), actionDescriptor = { schemaVersion: "action-descriptor-v1" as const, actionType: "WRITE_FILE", target: "src/a.ts", approvedScopeDigest: scopeDigest(scope), criticalInput: { version: "1" }, criticalInputDigest: criticalInputDigest({ version: "1" }) }, input = { ...raw, scopeDescriptor: scope, actionDigest: actionDigest(actionDescriptor) }, digest = reasoningPacketDigest(input), authority = { approvedScopeDescriptor: input.scopeDescriptor, approvedScopeDigest: scopeDigest(input.scopeDescriptor), approvedActionIds: ["A", "B"], globalForbiddenActionIds: [] };
    const payload = { schemaVersion: "decision-response-v1", responseId: "constrained", disposition: "EXECUTE" as const, summary: "Human summary only.", requestedActionIds: ["A"], preconditions: ["Tests pass", "Scope remains unchanged"], acceptanceCriteria: ["Result is read back", "No unrelated files change"], stopConditions: ["Scope changes", "Validation fails"] };
    const response = bindDecisionResponse(input, digest, payload, "2026-01-01T01:00:00.000Z");
    const contract = materializeExecutionContract({ contractId: "constrained-contract", packet: input, packetDigest: digest, response, approvedAuthority: authority, activeAction: { actionDescriptor, actionDigest: input.actionDigest! }, preconditions: ["no production", "Tests pass"], acceptanceCriteria: ["Local acceptance is recorded"], stopConditions: ["Binding validation fails"] });
    expect(contract.preconditions).toEqual(["Tests pass", "Scope remains unchanged", "no production"]);
    expect(contract.acceptanceCriteria).toEqual(["Result is read back", "No unrelated files change", "Local acceptance is recorded"]);
    expect(contract.stopConditions).toEqual(["Scope changes", "Validation fails", "Binding validation fails"]);
    expect(decisionResponseDigest(response)).not.toBe(decisionResponseDigest({ ...response, stopConditions: ["Different stop"] }));
    expect(() => validateContractBinding({ ...contract, preconditions: ["tampered"] }, contract.binding, new Date("2026-01-01T02:00:00.000Z"))).toThrow(/CONTRACT_DIGEST_MISMATCH/);
  });

  it("rejects non-EXECUTE execution fields, unknown fields, bad schema versions, oversized lists, and oversized entries", () => {
    const base = { schemaVersion: "decision-response-v1", responseId: "bounded", summary: "Stop.", requestedActionIds: [], preconditions: [], acceptanceCriteria: [], stopConditions: [] };
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "HUMAN_GATE_REQUIRED", preconditions: ["must not pass"] }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "STOP", stopConditions: ["must not pass"] }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "STOP", requestedActionIds: ["A"] }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "EXECUTE", unexpected: true }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, schemaVersion: "decision-response-v2", disposition: "EXECUTE" }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "EXECUTE", preconditions: Array.from({ length: 51 }, (_, index) => `p-${index}`) }).success).toBe(false);
    expect(DecisionResponsePayloadV1Schema.safeParse({ ...base, disposition: "EXECUTE", preconditions: ["x".repeat(2_001)] }).success).toBe(false);
  });
});
