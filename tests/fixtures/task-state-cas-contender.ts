import fs from "node:fs";
import { TaskStateError, TaskStateStore } from "../../src/task/state.ts";

const [stateDir, workspaceId, taskId, revisionText, readyFile, startFile, startedFile] = process.argv.slice(2);
if (!stateDir || !workspaceId || !taskId || !revisionText || !readyFile || !startFile || !startedFile) process.exit(2);

const mark = (file: string, content: string) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, content); fs.renameSync(temp, file); };
mark(readyFile, "READY");
while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));
mark(startedFile, "STARTED");

const store = new TaskStateStore({ stateDir });
const revision = Number(revisionText);
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    store.updateTaskState(workspaceId, taskId, revision, (state) => ({ ...state, attempt: state.attempt + 1 }));
    console.log("SUCCESS");
    process.exit(0);
  } catch (error) {
    const code = error instanceof TaskStateError ? error.code : String(error);
    if (code === "TASK_STATE_LOCK_HELD") {
      await new Promise((resolve) => setTimeout(resolve, 2));
      continue;
    }
    console.log(code);
    process.exit(0);
  }
}
console.log("TASK_STATE_LOCK_HELD");
