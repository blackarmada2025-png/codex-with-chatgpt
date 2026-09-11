import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const WORKSPACE_ID = "f7c6958b80ed";
const TASK_ID = "c2c_native_acceptance";
const THREAD_ID = "01a08fba-3534-7461-8810-3e51e8812f94";
const TURN_ID = "01a08fbf-0f32-7bf0-805c-77aaaf479348";
const MESSAGE_ID = "msg_053459cb970a52c3016aa3c66d846c87d099c913cb460043e3";

const nativeResultReferenceExactMatch = (
  stored: { turnId?: string; messageId?: string } | undefined,
  actual: { turnId: string; messageId: string }
): boolean =>
  stored?.turnId === actual.turnId && stored?.messageId === actual.messageId;

describe("durable native thread correlation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("reads legacy session and execution state without native metadata", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const sessionDir = path.join(stateDir, "sessions");
    const executionDir = path.join(stateDir, "executions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(executionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${WORKSPACE_ID}.json`),
      JSON.stringify({ taskId: TASK_ID, savedAt: "2026-09-11T00:00:00.000Z" })
    );
    fs.writeFileSync(
      path.join(executionDir, `${WORKSPACE_ID}.jsonl`),
      JSON.stringify({ taskId: TASK_ID, iteration: 1, changedFiles: 0, tests: null, exitStatus: "ok", timestamp: "2026-09-11T00:00:00.000Z" }) + "\n"
    );

    expect(readSession(WORKSPACE_ID)?.taskId).toBe(TASK_ID);
    const [record] = readExecutionRecords(WORKSPACE_ID);
    expect(record?.nativeThreadId).toBeUndefined();
    expect(record?.nativeResultReference).toBeUndefined();
  });

  it("round-trips native thread metadata through existing durable state", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const session = mergeSession(null, {
      taskId: TASK_ID,
      checkpoint: {
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        nativeThreadId: THREAD_ID,
        nativeWorktreePath: "C:\\isolated\\native-worktree",
        nextExpectedStep: "Read the native result and resume the same thread.",
      },
    });
    writeSession(WORKSPACE_ID, session);
    const restored = readSession(WORKSPACE_ID);
    expect(restored?.checkpoint?.taskId).toBe(TASK_ID);
    expect(restored?.checkpoint?.nativeThreadId).toBe(THREAD_ID);
    expect(restored?.checkpoint?.nativeWorktreePath).toBe("C:\\isolated\\native-worktree");
    expect(restored?.checkpoint?.nextExpectedStep).toBe("Read the native result and resume the same thread.");

    appendExecutionRecord(WORKSPACE_ID, {
      taskId: TASK_ID,
      iteration: 1,
      changedFiles: 0,
      tests: "read-only acceptance",
      exitStatus: "ok",
      timestamp: "2026-09-11T00:00:00.000Z",
      nativeThreadId: THREAD_ID,
      nativeResultReference: { turnId: TURN_ID, messageId: MESSAGE_ID },
    });
    const [record] = readExecutionRecords(WORKSPACE_ID);
    expect(record?.nativeThreadId).toBe(THREAD_ID);
    expect(record?.nativeResultReference).toEqual({ turnId: TURN_ID, messageId: MESSAGE_ID });
    expect(nativeResultReferenceExactMatch(record?.nativeResultReference, { turnId: TURN_ID, messageId: MESSAGE_ID })).toBe(true);
  });

  it("requires exact native turn and message identifiers for result recovery", () => {
    const actual = { turnId: TURN_ID, messageId: MESSAGE_ID };

    expect(nativeResultReferenceExactMatch({ turnId: TURN_ID, messageId: MESSAGE_ID }, actual)).toBe(true);
    expect(nativeResultReferenceExactMatch({ turnId: TURN_ID, messageId: `${MESSAGE_ID}x` }, actual)).toBe(false);
    expect(nativeResultReferenceExactMatch({ turnId: `${TURN_ID}x`, messageId: MESSAGE_ID }, actual)).toBe(false);
  });

  it("does not treat durable metadata roundtrip as result-reference validation", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const actual = { turnId: TURN_ID, messageId: MESSAGE_ID };
    const mismatchedReference = { turnId: TURN_ID, messageId: `${MESSAGE_ID}x` };

    appendExecutionRecord(WORKSPACE_ID, {
      taskId: TASK_ID,
      iteration: 1,
      changedFiles: 0,
      tests: "reference mismatch",
      exitStatus: "ok",
      timestamp: "2026-09-11T00:00:00.000Z",
      nativeThreadId: THREAD_ID,
      nativeResultReference: mismatchedReference,
    });

    const [record] = readExecutionRecords(WORKSPACE_ID);
    expect(record?.nativeResultReference).toEqual(mismatchedReference);
    expect(nativeResultReferenceExactMatch(record?.nativeResultReference, actual)).toBe(false);
  });
});
