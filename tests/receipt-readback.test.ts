import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFinalReceipt, readFinalReceiptGlobal } from "../src/execution/receipt-readback.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { Logger } from "../src/logger/index.js";
import { GatewayWorkspaceRegistry } from "../src/workspace/registry.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let root: string;
let home: string;
const text = (task = "TASK-1", status = "PASS", goal = "YES") => `TASK_ID = ${task}\nFINAL_STATUS = ${status}\nGOAL_REACHED = ${goal}\nACCEPTANCE = actual final`;
const event = (type: string, payload: object) => ({ type, timestamp: "2026-09-14T09:00:00Z", payload });
function transcript(options: { task?: string; receipt?: string; complete?: boolean; cwd?: string; id?: string; phase?: string } = {}) {
  const { task = "TASK-1", receipt = text(task), complete = true, cwd = root, id = "session-1", phase = "final_answer" } = options;
  return [event("session_meta", { id, cwd }),
    event("event_msg", { type: "task_started", turn_id: "turn-1" }),
    event("turn_context", { turn_id: "turn-1", cwd }),
    event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `TASK_ID = ${task}` }] }),
    ...(receipt ? [event("response_item", { type: "message", role: "assistant", phase, id: "msg-1", content: [{ type: "output_text", text: receipt }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } })] : []),
    ...(complete ? [event("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: receipt })] : [])];
}
function save(rows: object[], name = "one.jsonl") { return write(home, `sessions/${name}`, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); }
beforeEach(() => { root = makeTmpDir("receipt-workspace"); home = path.join(root, "native-store"); fs.mkdirSync(path.join(home, "sessions"), { recursive: true }); });
afterEach(() => cleanup(root));

describe("CODEX_OUTPUT_READBACK_V1", () => {
  it("reads the exact completed final with native identity and digest", async () => {
    save(transcript());
    const result = await readFinalReceipt("TASK-1", root, home);
    expect(result.ERROR).toBeUndefined();
    expect(result).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", FINAL_RECEIPT: text(), FINAL_STATUS: "PASS", GOAL_REACHED: "YES", SESSION_ID: "session-1", TURN_ID: "turn-1", MESSAGE_ID: "msg-1", EXECUTION_ID: "codex-session:session-1/turn:turn-1" });
    expect(result.RECEIPT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.AUTHORITATIVE_SOURCE).toBe("codex-home:/sessions/one.jsonl");
  });
  it("returns NOT_FOUND for an absent exact task, not a substring match", async () => {
    save(transcript({ task: "TASK-10" }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("returns FOUND_INCOMPLETE when a task has no final", async () => {
    save(transcript({ receipt: "", complete: false }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
  });
  it("requires native completion as well as a final message", async () => {
    save(transcript({ complete: false }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
  });
  it("does not choose a latest or successful receipt when candidates disagree", async () => {
    save(transcript({ receipt: text("TASK-1", "BLOCKED", "NO") }));
    save(transcript({ id: "session-2" }), "two.jsonl");
    const result = await readFinalReceipt("TASK-1", root, home);
    expect(result.READBACK_STATUS).toBe("AMBIGUOUS");
    expect(result.CANDIDATES.map(c => c.SESSION_ID)).toEqual(["session-1", "session-2"]);
    expect(result.FINAL_RECEIPT).toBe("NOT_AVAILABLE");
  });
  it("does not equate Git PASS, Test PASS, commentary or user text with a final receipt", async () => {
    save(transcript({ receipt: "Git PASS\nTest PASS" }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
    save(transcript({ phase: "commentary" }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
  });
  it("does not return another task's receipt", async () => {
    save(transcript({ task: "TASK-1", receipt: text("OTHER") }));
    const result = await readFinalReceipt("TASK-1", root, home);
    expect(result.READBACK_STATUS).toBe("FOUND_INCOMPLETE");
    expect(JSON.stringify(result)).not.toContain("OTHER");
    expect((await readFinalReceipt("OTHER", root, home)).READBACK_STATUS).toBe("READ_ERROR");
  });
  it("filters sessions and turns by the exact workspace, not path prefix", async () => {
    const other = path.join(root, "other"); fs.mkdirSync(other);
    save(transcript({ cwd: other }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
    const rows = transcript(); rows[2] = event("turn_context", { turn_id: "turn-1", cwd: other });
    save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("returns READ_ERROR for malformed, missing or incomplete source storage", async () => {
    write(home, "sessions/broken.jsonl", "{broken}");
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("READ_ERROR");
    expect((await readFinalReceipt("TASK-1", root, path.join(home, "missing"))).READBACK_STATUS).toBe("READ_ERROR");
  });
  it("rejects duplicate fields and mismatched native turn references", async () => {
    save(transcript({ receipt: `${text()}\nFINAL_STATUS = FAIL` }));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
    const rows = transcript();
    Object.assign(rows[4].payload, { internal_chat_message_metadata_passthrough: { turn_id: "wrong-turn" } });
    save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("READ_ERROR");
  });
  it("preserves BLOCKED/NO instead of deriving task success from turn completion", async () => {
    save(transcript({ receipt: text("TASK-1", "BLOCKED", "NO") }));
    expect(await readFinalReceipt("TASK-1", root, home)).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", FINAL_STATUS: "BLOCKED", GOAL_REACHED: "NO" });
  });
  it("handles actual retained turn_context without task_started", async () => {
    save(transcript().filter(r => !(r.type === "event_msg" && "type" in r.payload && r.payload.type === "task_started")));
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_COMPLETE");
  });
  it("handles actual null last_agent_message failures without poisoning other tasks", async () => {
    const rows = transcript({ task: "FAILED", receipt: "" });
    rows[4] = event("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: null, error: { message: "failure" } });
    save(rows);
    save(transcript({ id: "session-2" }), "two.jsonl");
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_COMPLETE");
    expect((await readFinalReceipt("FAILED", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
  });
  it("treats an empty allocated rollout as containing no task", async () => {
    write(home, "sessions/empty.jsonl", "");
    save(transcript());
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_COMPLETE");
  });
  it("does not accept a completion whose final text differs", async () => {
    const rows = transcript(); rows[5] = event("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: text("OTHER") });
    save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("FOUND_INCOMPLETE");
  });
  it("includes same-task separate turns in the ambiguity set", async () => {
    const second = JSON.parse(JSON.stringify(transcript()).replaceAll("turn-1", "turn-2"));
    save([...transcript(), ...second.slice(1)]);
    const result = await readFinalReceipt("TASK-1", root, home);
    expect(result.READBACK_STATUS).toBe("AMBIGUOUS");
    expect(result.CANDIDATES.map(c => c.TURN_ID)).toEqual(["turn-1", "turn-2"]);
  });
  it("does not grant a copied fork receipt authoritative status", async () => {
    const rows = transcript(); Object.assign(rows[0].payload, { forked_from_id: "parent" }); save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("enforces execution.read and the gateway workspace selector for readback", async () => {
    save(transcript());
    const other = path.join(root, "other"); fs.mkdirSync(other);
    const workspace = new Workspace(root); const otherWorkspace = new Workspace(other);
    const gatewayRegistry = new GatewayWorkspaceRegistry(root, [workspace, otherWorkspace].map(w => ({ expectedWorkspaceId: w.id, root: w.root })));
    const server = createMcpServer({ workspace, gatewayRegistry, logger: new Logger({ file: null }), codexHome: home });
    const client = new Client({ name: "readback-scope", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    let scopes: string[] = ["workspace.read"];
    clientTransport.send = (message, options) => send(message, { ...options, authInfo: { token: "test", clientId: "local-test", scopes } });
    await server.connect(serverTransport); await client.connect(clientTransport);
    const call = (id: string) => client.callTool({ name: "execution_summary", arguments: { task_id: "TASK-1", workspace_id: id } });
    try {
      expect(await call(workspace.id)).toMatchObject({ isError: true });
      scopes = ["execution.read"];
      const selected = await call(otherWorkspace.id);
      expect(JSON.parse((selected.content as { text: string }[])[0].text).readback.READBACK_STATUS).toBe("NOT_FOUND");
      expect(await call("not-allowlisted")).toMatchObject({ isError: true });
      const allowed = await call(workspace.id);
      expect(JSON.parse((allowed.content as { text: string }[])[0].text).readback.READBACK_STATUS).toBe("FOUND_COMPLETE");
    } finally { await client.close(); await server.close(); }
  });
  it("exposes readback through the existing MCP execution_summary tool", async () => {
    save(transcript());
    const server = createMcpServer({ workspace: new Workspace(root), logger: new Logger({ file: null }), codexHome: home });
    const client = new Client({ name: "readback-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "execution_summary", arguments: { task_id: "TASK-1" } });
      expect(JSON.parse((result.content as { text: string }[])[0].text).readback.READBACK_STATUS).toBe("FOUND_COMPLETE");
      expect((await client.listTools()).tools).toHaveLength(10);
    } finally { await client.close(); await server.close(); }
  });
  it("accepts a terminal receipt with an explanatory goal result", async () => {
    const receipt = "TASK_ID = TASK-1\nFINAL_STATUS = PARTIAL\nGOAL_REACHED = waiting for normal source input";
    save(transcript({ receipt }));
    expect(await readFinalReceipt("TASK-1", root, home)).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", FINAL_STATUS: "PARTIAL", GOAL_REACHED: "waiting for normal source input" });
  });
  it("does not bind a task ID quoted inside a reviewer transcript", async () => {
    const rows = transcript({ receipt: "", complete: false });
    (rows[3] as { payload: { content: { type: string; text: string }[] } }).payload.content = [{ type: "input_text", text: ">>> TRANSCRIPT START\nTASK_ID = TASK-1\n>>> TRANSCRIPT END" }];
    save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("skips a forked transcript before an appended parent session meta", async () => {
    const rows = transcript();
    Object.assign(rows[0].payload, { forked_from_id: "parent-session" });
    rows.splice(1, 0, event("session_meta", { id: "parent-session", cwd: root }));
    save(rows);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("fails closed for duplicate metadata in a non-fork transcript", async () => {
    const rows = transcript();
    rows.splice(1, 0, event("session_meta", { id: "unexpected-session", cwd: root }));
    save(rows);
    expect(await readFinalReceipt("TASK-1", root, home)).toMatchObject({ READBACK_STATUS: "READ_ERROR", ERROR: "DUPLICATE_SESSION_METADATA" });
  });
  it("returns the only complete receipt when same-session earlier turns are incomplete", async () => {
    const earlier = JSON.parse(JSON.stringify(transcript({ receipt: "", complete: false })).replaceAll("turn-1", "turn-0"));
    save([...earlier, ...transcript().slice(1)]);
    expect(await readFinalReceipt("TASK-1", root, home)).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", TURN_ID: "turn-1" });
  });
  it("keeps two complete receipts in one session ambiguous", async () => {
    const second = JSON.parse(JSON.stringify(transcript({ receipt: text("TASK-1", "BLOCKED", "NO") })).replaceAll("turn-1", "turn-2"));
    save([...transcript(), ...second.slice(1)]);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("AMBIGUOUS");
  });
  it("keeps a complete receipt plus cross-session incomplete evidence ambiguous", async () => {
    save(transcript());
    save(transcript({ id: "session-2", receipt: "", complete: false }), "two.jsonl");
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("AMBIGUOUS");
  });
  it("keeps conflicting terminal receipts ambiguous even when only one completes natively", async () => {
    const incompleteTerminal = transcript({ receipt: text("TASK-1", "BLOCKED", "NO"), complete: false });
    const second = JSON.parse(JSON.stringify(incompleteTerminal).replaceAll("turn-1", "turn-2"));
    save([...transcript(), ...second.slice(1)]);
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("AMBIGUOUS");
  });
  it("selects one execution from a multi-session task only with its exact native session and turn", async () => {
    save(transcript({ id: "session-1" }));
    save(transcript({ id: "session-2" }), "two.jsonl");
    expect((await readFinalReceipt("TASK-1", root, home)).READBACK_STATUS).toBe("AMBIGUOUS");
    expect(await readFinalReceipt("TASK-1", root, home, { sessionId: "session-2", turnId: "turn-1" })).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", SESSION_ID: "session-2", TURN_ID: "turn-1" });
  });
  it("rejects an attempt selector with the wrong session or turn", async () => {
    save(transcript());
    expect((await readFinalReceipt("TASK-1", root, home, { sessionId: "wrong-session" })).READBACK_STATUS).toBe("NOT_FOUND");
    expect((await readFinalReceipt("TASK-1", root, home, { sessionId: "session-1", turnId: "wrong-turn" })).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("does not let a valid session selector bypass task or workspace binding", async () => {
    save(transcript());
    expect((await readFinalReceipt("OTHER", root, home, { sessionId: "session-1", turnId: "turn-1" })).READBACK_STATUS).toBe("NOT_FOUND");
    const other = path.join(root, "other"); fs.mkdirSync(other);
    expect((await readFinalReceipt("TASK-1", other, home, { sessionId: "session-1", turnId: "turn-1" })).READBACK_STATUS).toBe("NOT_FOUND");
  });
  it("reads a global native execution and preserves its actual workspace", async () => {
    const other = path.join(root, "other"); fs.mkdirSync(other);
    save(transcript({ cwd: other, id: "global-session" }), "global.jsonl");
    expect(await readFinalReceiptGlobal("TASK-1", home)).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", ACTUAL_WORKSPACE: other, SESSION_ID: "global-session" });
  });
  it("requires a session selector when a turn selector is supplied", async () => {
    save(transcript());
    expect(await readFinalReceipt("TASK-1", root, home, { turnId: "turn-1" })).toMatchObject({ READBACK_STATUS: "READ_ERROR", ERROR: "INVALID_ATTEMPT_SELECTOR" });
  });
  it("exposes exact attempt selection through execution_summary", async () => {
    save(transcript({ id: "session-1" }));
    save(transcript({ id: "session-2" }), "two.jsonl");
    const server = createMcpServer({ workspace: new Workspace(root), logger: new Logger({ file: null }), codexHome: home });
    const client = new Client({ name: "attempt-readback-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "execution_summary", arguments: { task_id: "TASK-1", session_id: "session-2", turn_id: "turn-1" } });
      expect(JSON.parse((result.content as { text: string }[])[0].text).readback).toMatchObject({ READBACK_STATUS: "FOUND_COMPLETE", SESSION_ID: "session-2", TURN_ID: "turn-1" });
    } finally { await client.close(); await server.close(); }
  });
});
