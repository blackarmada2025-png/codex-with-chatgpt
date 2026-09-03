import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStateStore } from "../src/task/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const make = () => { const dir = makeTmpDir("task-state-review"); dirs.push(dir); return { dir, store: new TaskStateStore({ stateDir: dir, now: () => new Date("2026-01-02T00:00:00.000Z") }) }; };
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (name: string, args: string[]) => new Promise<string>((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), path.join(process.cwd(), "tests", "fixtures", name), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data.toString(); });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`fixture ${name} exited ${code}: ${stderr}`)));
});

describe("FIR-01 TaskState path identity binding", () => {
  it("CASE_TASK_STATE_WORKSPACE_ID_MISMATCH CASE_TASK_STATE_IDENTITY_MISMATCH_BLOCKS_CAS CASE_TASK_STATE_IDENTITY_MISMATCH_BLOCKS_TRANSITION", () => {
    const { store } = make(), task = store.createTaskState("ws-a");
    const misplaced = store.taskFile("ws-b", task.taskId); fs.mkdirSync(path.dirname(misplaced), { recursive: true }); fs.copyFileSync(store.taskFile("ws-a", task.taskId), misplaced);
    expect(store.readTaskState("ws-b", task.taskId)).toEqual({ status: "CORRUPT", error: "TASK_STATE_IDENTITY_MISMATCH" });
    expect(() => store.updateTaskState("ws-b", task.taskId, 0, (state) => state)).toThrow(/TASK_STATE_IDENTITY_MISMATCH/);
    expect(() => store.transitionTask("ws-b", task.taskId, 0, "BUILDING")).toThrow(/TASK_STATE_IDENTITY_MISMATCH/);
  });
  it("CASE_TASK_STATE_TASK_ID_MISMATCH CASE_TASK_STATE_FILES_SWAPPED", () => {
    const { store } = make(), left = store.createTaskState("ws"), right = store.createTaskState("ws");
    const leftFile = store.taskFile("ws", left.taskId), rightFile = store.taskFile("ws", right.taskId), leftJson = fs.readFileSync(leftFile), rightJson = fs.readFileSync(rightFile);
    fs.writeFileSync(leftFile, rightJson); fs.writeFileSync(rightFile, leftJson);
    expect(store.readTaskState("ws", left.taskId)).toEqual({ status: "CORRUPT", error: "TASK_STATE_IDENTITY_MISMATCH" });
    expect(store.readTaskState("ws", right.taskId)).toEqual({ status: "CORRUPT", error: "TASK_STATE_IDENTITY_MISMATCH" });
  });
});

describe("FIR-04 malformed stale metadata fails closed", () => {
  it("CASE_LOCK_METADATA_MISSING_PID CASE_LOCK_METADATA_INVALID_PID CASE_LOCK_METADATA_INVALID_TIMESTAMP CASE_LOCK_METADATA_WRONG_WORKSPACE CASE_LOCK_METADATA_WRONG_TASK", () => {
    for (const patch of [{ ownerPid: undefined }, { ownerPid: 0 }, { acquiredAt: "invalid" }, { workspaceId: "other" }, { taskId: "other" }]) {
      const { store } = make(), task = store.createTaskState("ws"), lock = store.acquireTaskStateLock("ws", task.taskId), metadata = JSON.parse(fs.readFileSync(path.join(lock, "lock.json"), "utf8"));
      Object.assign(metadata, patch); fs.writeFileSync(path.join(lock, "lock.json"), JSON.stringify(metadata));
      expect(() => store.takeOverStaleTaskStateLock("ws", task.taskId, 1)).toThrow(/MALFORMED_LOCK_METADATA/);
      expect(fs.existsSync(lock)).toBe(true); expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.includes(".stale-")).length).toBe(0);
      fs.rmSync(lock, { recursive: true });
    }
  });
  it("CASE_LEASE_METADATA_MISSING_LEASE_ID CASE_LEASE_METADATA_MISSING_SESSION_MARKER CASE_LEASE_METADATA_INVALID_PID CASE_LEASE_METADATA_INVALID_TIMESTAMP CASE_LEASE_METADATA_WRONG_WORKSPACE CASE_LEASE_METADATA_WRONG_TASK", () => {
    for (const patch of [{ leaseId: undefined }, { ownerSessionMarker: undefined }, { ownerPid: -1 }, { heartbeatAt: "invalid" }, { workspaceId: "other" }, { taskId: "other" }]) {
      const { store } = make(), task = store.createTaskState("ws"), lease = store.acquireWorkspaceMutationLease("ws", task.taskId, "session"), leaseDir = (store as any).lease("ws"), metadata = JSON.parse(fs.readFileSync(path.join(leaseDir, "lease.json"), "utf8"));
      Object.assign(metadata, patch); metadata.heartbeatAt = metadata.heartbeatAt === "invalid" ? "invalid" : "2020-01-01T00:00:00.000Z"; fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(metadata));
      const expected = patch.taskId === "other" ? /RECOVERY_REQUIRED/ : /MALFORMED_LEASE_METADATA/;
      expect(() => store.takeOverStaleWorkspaceMutationLease("ws", task.taskId, "new", 1)).toThrow(expected);
      expect(fs.existsSync(leaseDir)).toBe(true); expect(fs.readdirSync(path.dirname(leaseDir)).filter((name) => name.startsWith(".mutation-lease.stale.")).length).toBe(0);
      fs.rmSync(leaseDir, { recursive: true }); void lease;
    }
  });
});

describe("FIR-02/FIR-03 independent-process competition", () => {
  it("CASE_REAL_CONCURRENT_REVISION_CAS CASE_REAL_CONCURRENT_CAS_ONE_COMMIT CASE_REAL_CONCURRENT_CAS_FINAL_REVISION_PLUS_ONE CASE_REAL_CONCURRENT_CAS_NO_LOST_UPDATE", async () => {
    for (let run = 0; run < 5; run++) {
      const { dir, store } = make(), task = store.createTaskState("ws"), start = path.join(dir, `cas-${run}.start`);
      const first = fixture("task-state-cas-contender.ts", [dir, "ws", task.taskId, "0", start]), second = fixture("task-state-cas-contender.ts", [dir, "ws", task.taskId, "0", start]);
      await wait(50); fs.writeFileSync(start, "go"); const results = await Promise.all([first, second]);
      expect(results.filter((result) => result === "SUCCESS")).toHaveLength(1); expect(results.filter((result) => result === "STALE_TASK_STATE")).toHaveLength(1);
      expect(store.readTaskState("ws", task.taskId)).toMatchObject({ status: "VALID", state: { revision: 1, attempt: 1 } });
    }
  });
  it("CASE_REAL_COMPETING_STALE_TAKEOVER CASE_REAL_STALE_TAKEOVER_ONLY_ONE_WINNER CASE_STALE_ARCHIVE_CREATED_ONCE CASE_NEW_LEASE_CREATED_ONCE CASE_LOSER_CANNOT_OVERWRITE_WINNER", async () => {
    for (let run = 0; run < 5; run++) {
      const { dir, store } = make(), task = store.createTaskState("ws"), lease = store.acquireWorkspaceMutationLease("ws", task.taskId, "old"), leaseDir = (store as any).lease("ws"), stale = { ...lease, ownerPid: 99999999, heartbeatAt: "2020-01-01T00:00:00.000Z" }, start = path.join(dir, `lease-${run}.start`);
      fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(stale));
      const first = fixture("mutation-lease-contender.ts", [dir, "ws", task.taskId, "one", start]), second = fixture("mutation-lease-contender.ts", [dir, "ws", task.taskId, "two", start]);
      await wait(50); fs.writeFileSync(start, "go"); const results = await Promise.all([first, second]), winner = results.find((result) => result.startsWith("SUCCESS:"));
      expect(winner).toBeDefined(); expect(results.filter((result) => result.startsWith("SUCCESS:")), results.join(" | ")).toHaveLength(1); expect(results.filter((result) => /LEASE_TAKEOVER_RACE|LEASE_NOT_STALE|WORKSPACE_MUTATION_LEASE_HELD|MALFORMED_LEASE_METADATA/.test(result)), results.join(" | ")).toHaveLength(1);
      expect(fs.readdirSync(path.dirname(leaseDir)).filter((name) => name.startsWith(".mutation-lease.stale.")).length).toBe(1);
      const current = JSON.parse(fs.readFileSync(path.join(leaseDir, "lease.json"), "utf8")); expect(current.ownerSessionMarker).toBe((winner as string).split(":")[2]);
    }
  });
});
