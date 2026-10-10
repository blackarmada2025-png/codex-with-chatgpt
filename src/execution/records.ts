import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { ReusableEvidenceReceipt } from "./evidence-receipt.js";
import type { ControlledWriteReceipt } from "../workspace/controlled-write.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  /** Optional for backward-compatible historical records; new records receive one. */
  recordId?: string;
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
  /** Present when Codex recorded a sanitized command output for this iteration. */
  outputId?: number;
  outputAvailable?: boolean;
  /** Native Codex thread that produced this execution result, when applicable. */
  nativeThreadId?: string;
  /** Stable references to the native turn and its final result message. */
  nativeResultReference?: {
    turnId?: string;
    messageId?: string;
  };
  /** Passed validation evidence that may be reused only through an exact, safe decision. */
  reusableEvidenceReceipt?: ReusableEvidenceReceipt;
  /** Result of a governed controlled-write attempt, when a future approved binding records one. */
  controlledWriteReceipt?: ControlledWriteReceipt;
  /** Decision-contract binding; evidence only, never execution authority. */
  contractId?: string;
  consumptionId?: string;
  resultDigest?: string;
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): ExecutionRecord {
  const file = recordsFile(workspaceId);
  const persisted = { ...record, recordId: record.recordId ?? `record_${crypto.randomBytes(16).toString("hex")}` };
  fs.appendFileSync(file, JSON.stringify(persisted) + "\n", { mode: 0o600 });
  return persisted;
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

/** Returns exactly one matching receipt; ambiguity is deliberately fail-closed. */
export function findExecutionRecordByConsumption(
  workspaceId: string,
  taskId: string,
  contractId: string,
  consumptionId: string,
  recordId?: string,
): ExecutionRecord | null {
  const matches = readExecutionRecords(workspaceId, Number.MAX_SAFE_INTEGER).filter((record) =>
    record.taskId === taskId
    && record.contractId === contractId
    && record.consumptionId === consumptionId
    && (!recordId || record.recordId === recordId),
  );
  return matches.length === 1 ? matches[0] : null;
}
