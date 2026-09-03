import fs from "node:fs";
import { TaskStateError, TaskStateStore } from "../../src/task/state.ts";

const [stateDir, workspaceId, taskId, marker, startFile] = process.argv.slice(2);
if (!stateDir || !workspaceId || !taskId || !marker || !startFile) process.exit(2);

while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));

try {
  const lease = new TaskStateStore({ stateDir }).takeOverStaleWorkspaceMutationLease(workspaceId, taskId, marker, 60_000);
  console.log(`SUCCESS:${lease.leaseId}:${lease.ownerSessionMarker}`);
} catch (error) {
  console.log(error instanceof TaskStateError ? error.code : String(error));
}
