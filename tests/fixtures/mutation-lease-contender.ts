import fs from "node:fs";
import { TaskStateError, TaskStateStore } from "../../src/task/state.ts";

const [stateDir, workspaceId, taskId, marker, readyFile, startFile, startedFile] = process.argv.slice(2);
if (!stateDir || !workspaceId || !taskId || !marker || !readyFile || !startFile || !startedFile) process.exit(2);

const mark = (file: string, content: string) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, content); fs.renameSync(temp, file); };
mark(readyFile, "READY");
while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));
mark(startedFile, "STARTED");

try {
  const lease = new TaskStateStore({ stateDir }).takeOverStaleWorkspaceMutationLease(workspaceId, taskId, marker, 60_000);
  console.log(`SUCCESS:${lease.leaseId}:${lease.ownerSessionMarker}`);
} catch (error) {
  console.log(error instanceof TaskStateError ? error.code : String(error));
}
