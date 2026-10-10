import fs from "node:fs";
import { DecisionService } from "../../src/task/decision-service.ts";
import { TaskStateError, TaskStateStore } from "../../src/task/state.ts";

const [operation, stateDir, workspaceRoot, contractRoot, taskId, revision, leaseId, ownerSessionMarker, actionId, requestedActionId, scopeDigest, consumptionId, executionRecordId, resultDigest, ready, start, started] = process.argv.slice(2);
if ([operation, stateDir, workspaceRoot, contractRoot, taskId, revision, leaseId, ownerSessionMarker, actionId, requestedActionId, scopeDigest, ready, start, started].some((value) => !value)) process.exit(2);
process.env.C2C_STATE_DIR = stateDir;
const mark = (file: string, value: string) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, value); fs.renameSync(temp, file); };
mark(ready, "READY"); while (!fs.existsSync(start)) await new Promise((resolve) => setTimeout(resolve, 2)); mark(started, "STARTED");
const store = new TaskStateStore({ stateDir, now: () => new Date("2026-01-01T00:00:00.000Z") });
const service = new DecisionService({ workspaceRoot, stateStore: store, contractRoot, now: () => new Date("2026-01-01T00:00:00.000Z") });
for (let attempt = 0; attempt < 40; attempt++) try {
  const owner = { leaseId, ownerSessionMarker };
  if (operation === "begin") {
    const result = service.beginContractConsumption("ws", taskId, Number(revision), owner, actionId, requestedActionId, scopeDigest);
    console.log(`SUCCESS:${result.consumptionId}`); process.exit(0);
  }
  const result = service.finalizeContractConsumption("ws", taskId, Number(revision), owner, consumptionId, executionRecordId, resultDigest);
  console.log(`SUCCESS:${result.activeContract?.executionRecordId}:${result.activeContract?.consumedAt}`); process.exit(0);
} catch (error) {
  const code = error instanceof TaskStateError ? error.code : error instanceof Error && "code" in error ? (error as { code: string }).code : String(error);
  if (code === "TASK_STATE_LOCK_HELD") { await new Promise((resolve) => setTimeout(resolve, 2)); continue; }
  console.log(code); process.exit(0);
}
console.log("TASK_STATE_LOCK_HELD");
