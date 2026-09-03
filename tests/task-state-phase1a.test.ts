import { afterEach, describe, expect, it } from "vitest";
import { TaskStateStore } from "../src/task/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
function store(): TaskStateStore { const dir = makeTmpDir("task-state-phase1a"); dirs.push(dir); return new TaskStateStore({ stateDir: dir }); }
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe("Phase 1A durable state core", () => {
  it("CASE_TASK_STATE_LOCK_EXCLUSIVE CASE_SECOND_LOCK_OWNER_BLOCKED CASE_LOCK_RELEASE", () => {
    const s = store(); const task = s.createTaskState("ws"); const lock = s.acquireTaskStateLock("ws", task.taskId);
    expect(() => s.acquireTaskStateLock("ws", task.taskId)).toThrow(/TASK_STATE_LOCK_HELD/);
    s.releaseTaskStateLock(lock);
    const second = s.acquireTaskStateLock("ws", task.taskId); s.releaseTaskStateLock(second);
  });
  it("CASE_CONCURRENT_REVISION_CAS", async () => {
    const s = store(); const task = s.createTaskState("ws");
    const contender = () => new Promise<string>((resolve) => setImmediate(() => {
      try { s.updateTaskState("ws", task.taskId, 0, (x) => ({ ...x, attempt: 1 })); resolve("SUCCESS"); }
      catch (error) { resolve((error as Error).message); }
    }));
    const results = await Promise.all([contender(), contender()]);
    expect(results.filter((x) => x === "SUCCESS")).toHaveLength(1);
    expect(results.filter((x) => x.includes("STALE_TASK_STATE"))).toHaveLength(1);
    expect(s.readTaskState("ws", task.taskId)).toMatchObject({ status: "VALID", state: { revision: 1, attempt: 1 } });
  });
});
