import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const NA = "NOT_AVAILABLE";
export type ReadbackStatus = "FOUND_COMPLETE" | "FOUND_INCOMPLETE" | "NOT_FOUND" | "AMBIGUOUS" | "READ_ERROR";
export interface ExecutionAttemptSelector {
  sessionId?: string;
  turnId?: string;
}

export interface ReceiptReadback {
  TASK_ID: string;
  READBACK_STATUS: ReadbackStatus;
  FINAL_STATUS: string;
  GOAL_REACHED: string;
  FINAL_RECEIPT: string;
  SOURCE_TYPE: string;
  SOURCE_ID: string;
  SESSION_ID: string;
  TURN_ID: string;
  EXECUTION_ID: string;
  TIMESTAMP: string;
  ACTUAL_WORKSPACE: string;
  AUTHORITATIVE_SOURCE: string;
  MESSAGE_ID: string;
  RECEIPT_SHA256: string;
  CANDIDATES: Omit<ReceiptReadback, "CANDIDATES">[];
  ERROR?: string;
}

type Row = { type?: string; timestamp?: string; payload?: Record<string, any> };
type Final = { text: string; id: string; timestamp: string; line: number; turnId?: string };
type Turn = { id: string; cwd: string; tasks: Set<string>; finals: Final[]; completion?: string; timestamp: string; invalid?: string; completed?: boolean; failed?: boolean };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const field = (text: string, key: string): string | undefined => {
  const matches = [...text.replace(/\\_/g, "_").matchAll(new RegExp(`^${key}\\s*=\\s*([^\\r\\n]+)`, "gm"))];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
};
const taskIds = (text: string) => [...text.replace(/\\_/g, "_").matchAll(/^TASK_ID\s*=\s*([A-Za-z0-9][A-Za-z0-9._-]{0,199})\s*$/gm)].map(m => m[1]);
const isEmbeddedTranscript = (text: string) => text.includes(">>> TRANSCRIPT START") && text.includes(">>> TRANSCRIPT END");
const body = (p: Record<string, any>): string => Array.isArray(p.content)
  ? p.content.filter((c: any) => c.type === "output_text" || c.type === "input_text").map((c: any) => c.text ?? "").join("") : "";
const base = (taskId: string, status: ReadbackStatus): ReceiptReadback => ({
  TASK_ID: taskId, READBACK_STATUS: status, FINAL_STATUS: NA, GOAL_REACHED: NA,
  FINAL_RECEIPT: NA, SOURCE_TYPE: "CODEX_SESSION_JSONL", SOURCE_ID: NA,
  SESSION_ID: NA, TURN_ID: NA, EXECUTION_ID: NA, TIMESTAMP: NA,
  ACTUAL_WORKSPACE: NA,
  AUTHORITATIVE_SOURCE: NA, MESSAGE_ID: NA, RECEIPT_SHA256: NA, CANDIDATES: [],
});
const sameRoot = (a: string, b: string) => {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; }
};

/** Read-only, derived view. No index, record writer, daemon, or receipt-driven execution. */
export async function readFinalReceipt(
  taskId: string,
  workspaceRoot: string,
  codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex"),
  attempt?: ExecutionAttemptSelector,
): Promise<ReceiptReadback> {
  return readFinalReceiptInternal(taskId, workspaceRoot, codexHome, attempt);
}

/** Read across the native Codex store while preserving each execution's actual cwd. */
export async function readFinalReceiptGlobal(
  taskId: string,
  codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex"),
  attempt?: ExecutionAttemptSelector,
): Promise<ReceiptReadback> {
  return readFinalReceiptInternal(taskId, undefined, codexHome, attempt);
}

async function readFinalReceiptInternal(
  taskId: string,
  workspaceRoot: string | undefined,
  codexHome: string,
  attempt?: ExecutionAttemptSelector,
): Promise<ReceiptReadback> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(taskId)) return { ...base(taskId, "READ_ERROR"), ERROR: "INVALID_TASK_ID" };
  if (attempt?.turnId && !attempt.sessionId) return { ...base(taskId, "READ_ERROR"), ERROR: "INVALID_ATTEMPT_SELECTOR" };
  const candidates: ReceiptReadback[] = [];
  let files = 0;
  let stores = 0;
  try {
    // Paths are server-owned; callers can supply only task_id and the existing workspace selector.
    const home = fs.realpathSync.native(codexHome);
    async function scan(dir: string): Promise<void> {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("SOURCE_SYMLINK");
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { await scan(file); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (++files > 10000) throw new Error("SOURCE_FILE_LIMIT");
        const real = await fs.promises.realpath(file);
        if (!real.startsWith(home + path.sep)) throw new Error("SOURCE_OUTSIDE_STORE");
        const handle = await fs.promises.open(real, "r");
        try {
          const stat = await handle.stat();
          let bytes = 0;
          // A newly allocated empty rollout contains no task or receipt yet.
          if (!stat.size) continue;
          // Snapshot a prefix. Appends after stat are excluded; errors never become NOT_FOUND.
          const stream = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false, encoding: "utf8" });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          let lineNo = 0;
          let sessionId = "";
          let cwd = "";
          let forked = false;
          let turn: Turn | undefined;
          const turns = new Map<string, Turn>();
          try {
            for await (const line of lines) {
              lineNo++;
              bytes += Buffer.byteLength(line);
              if (bytes > 1024 * 1024 * 1024) throw new Error("SOURCE_BYTE_LIMIT");
              const row = JSON.parse(line) as Row;
              const p = row.payload ?? {};
              if (lineNo === 1) {
                if (row.type !== "session_meta" || typeof p.id !== "string" || typeof p.cwd !== "string") throw new Error("INVALID_SESSION_METADATA");
                sessionId = p.id; cwd = p.cwd;
                if (workspaceRoot && !sameRoot(cwd, workspaceRoot)) break;
                // Fork history is not a second authoritative execution of the original receipt.
                forked = Boolean(p.forked_from_id);
                if (forked) break;
              } else if (row.type === "session_meta") throw new Error("DUPLICATE_SESSION_METADATA");
              if (row.type === "event_msg" && p.type === "task_started") {
                if (typeof p.turn_id !== "string" || turns.has(p.turn_id)) throw new Error("INVALID_TURN_START");
                turn = { id: p.turn_id, cwd, tasks: new Set(), finals: [], timestamp: row.timestamp ?? NA };
                turns.set(turn.id, turn);
              }
              if (row.type === "turn_context") {
                if (typeof p.turn_id !== "string" || typeof p.cwd !== "string") throw new Error("TURN_CONTEXT_MISMATCH");
                // Older retained histories can have turn_context without task_started.
                turn = turns.get(p.turn_id) ?? { id: p.turn_id, cwd, tasks: new Set(), finals: [], timestamp: row.timestamp ?? NA };
                turns.set(turn.id, turn);
                turn.cwd = p.cwd;
              }
              if (row.type === "response_item" && p.type === "message" && turn) {
                const messageBody = body(p);
                if (p.role === "user" && !isEmbeddedTranscript(messageBody)) for (const id of taskIds(messageBody)) turn.tasks.add(id);
                if (p.role === "assistant" && p.phase === "final_answer") {
                  turn.finals.push({ text: messageBody, id: typeof p.id === "string" ? p.id : NA,
                    timestamp: row.timestamp ?? NA, line: lineNo,
                    turnId: p.internal_chat_message_metadata_passthrough?.turn_id });
                }
              }
              if (row.type === "event_msg" && p.type === "task_complete") {
                if (typeof p.turn_id !== "string") throw new Error("INVALID_TURN_COMPLETION");
                const completed = turns.get(p.turn_id) ?? { id: p.turn_id, cwd, tasks: new Set<string>(), finals: [], timestamp: row.timestamp ?? NA };
                turns.set(completed.id, completed);
                if (completed.completed) completed.invalid = "DUPLICATE_TURN_COMPLETION";
                completed.completed = true;
                completed.failed = Boolean(p.error);
                // A terminal error can legitimately have last_agent_message: null.
                if (typeof p.last_agent_message === "string") completed.completion = p.last_agent_message;
              }
            }
          } finally { lines.close(); stream.destroy(); }
          for (const t of turns.values()) {
            if (workspaceRoot && !sameRoot(t.cwd, workspaceRoot)) continue;
            const finals = t.finals.filter(f => field(f.text, "TASK_ID") === taskId && /^TASK_ID\s*=/.test(f.text.trim().replace(/\\_/g, "_")));
            if (!finals.length && !t.tasks.has(taskId)) continue;
            if (forked) throw new Error("FORK_HISTORY_UNSUPPORTED");
            if (t.invalid) throw new Error(t.invalid);
            const source = `codex-session:${sessionId}/turn:${t.id}`;
            const initial = { ...base(taskId, "FOUND_INCOMPLETE"), SESSION_ID: sessionId, TURN_ID: t.id,
              EXECUTION_ID: source, SOURCE_ID: source, TIMESTAMP: t.timestamp, ACTUAL_WORKSPACE: t.cwd,
              AUTHORITATIVE_SOURCE: `codex-home:/${path.relative(home, real).split(path.sep).join("/")}` };
            if (!finals.length) { candidates.push(initial); continue; }
            for (const final of finals) {
              if (final.turnId && final.turnId !== t.id) throw new Error("FINAL_TURN_MISMATCH");
              if (t.tasks.size && (!t.tasks.has(taskId) || t.tasks.size > 1)) throw new Error("TASK_BINDING_CONFLICT");
              const status = field(final.text, "FINAL_STATUS");
              const goal = field(final.text, "GOAL_REACHED");
              // Native completion plus an unambiguous terminal status proves receipt completion; goal semantics remain caller-visible.
              const complete = !t.failed && t.completion === final.text && Boolean(status);
              candidates.push({ ...initial, READBACK_STATUS: complete ? "FOUND_COMPLETE" : "FOUND_INCOMPLETE",
                FINAL_STATUS: status ?? NA, GOAL_REACHED: goal ?? NA, FINAL_RECEIPT: final.text,
                SOURCE_ID: `${source}/line:${final.line}`, MESSAGE_ID: final.id,
                TIMESTAMP: final.timestamp, RECEIPT_SHA256: hash(final.text) });
            }
          }
          const after = await fs.promises.stat(real);
          if (after.ino !== stat.ino || after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) throw new Error("SOURCE_CHANGED");
        } finally { await handle.close(); }
      }
    }
    for (const name of ["sessions", "archived_sessions"]) {
      const dir = path.join(home, name);
      try { await fs.promises.lstat(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if ((await fs.promises.lstat(dir)).isSymbolicLink()) throw new Error("SOURCE_SYMLINK");
      stores++;
      await scan(dir);
    }
    if (!stores) throw new Error("SOURCE_STORE_UNAVAILABLE");
    if (!candidates.length) return base(taskId, "NOT_FOUND");
    const ambiguous = () => ({ ...base(taskId, "AMBIGUOUS" as const), CANDIDATES: candidates.map(({ CANDIDATES: _, ...candidate }) => ({ ...candidate, FINAL_RECEIPT: NA })) });
    if (attempt?.sessionId) {
      const selected = candidates.filter(candidate => candidate.SESSION_ID === attempt.sessionId && (!attempt.turnId || candidate.TURN_ID === attempt.turnId));
      if (!selected.length) return base(taskId, "NOT_FOUND");
      return selected.length === 1 ? selected[0] : ambiguous();
    }
    if (candidates.length === 1) return candidates[0];
    const completeCandidates = candidates.filter(candidate => candidate.READBACK_STATUS === "FOUND_COMPLETE");
    const soleComplete = completeCandidates.length === 1 ? completeCandidates[0] : undefined;
    const sameSessionIncompleteHistory = soleComplete && candidates.every(candidate =>
      candidate.SESSION_ID === soleComplete.SESSION_ID &&
      (candidate === soleComplete || (candidate.READBACK_STATUS === "FOUND_INCOMPLETE" && candidate.FINAL_RECEIPT === NA && candidate.FINAL_STATUS === NA)));
    if (sameSessionIncompleteHistory) return soleComplete;
    return ambiguous();
  } catch (error) {
    // No raw filesystem error or unrelated transcript is returned to the connector.
    const message = (error as NodeJS.ErrnoException)?.code || (error instanceof Error ? error.message : "");
    return { ...base(taskId, "READ_ERROR"), ERROR: /^[A-Z_]+$/.test(message) ? message : "SOURCE_READ_FAILED" };
  }
}
