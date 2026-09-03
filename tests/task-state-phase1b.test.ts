import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStateStore } from "../src/task/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";
const dirs:string[]=[]; const make=(pid:(id:number)=>boolean|undefined,now:Date)=>{const d=makeTmpDir("task-state-phase1b");dirs.push(d);return new TaskStateStore({stateDir:d,pidExists:pid,now:()=>now});}; afterEach(()=>{while(dirs.length)cleanup(dirs.pop()!);});
describe("Phase 1B mutation foundation",()=>{
 it("CASE_TASK_STATE_LOCK_OWNER_ALIVE_NOT_STALE",()=>{const now=new Date("2026-01-02T00:00:00Z"),s=make(()=>true,now),t=s.createTaskState("ws"),l=s.acquireTaskStateLock("ws",t.taskId);expect(()=>s.takeOverStaleTaskStateLock("ws",t.taskId,0)).toThrow(/NOT_STALE/);s.releaseTaskStateLock(l);});
 it("fails closed when task-lock owner liveness is uncertain",()=>{const now=new Date("2026-01-02T00:00:00Z"),s=make(()=>undefined,now),t=s.createTaskState("ws"),l=s.acquireTaskStateLock("ws",t.taskId);const metadata=JSON.parse(fs.readFileSync(`${l}\\lock.json`,`utf8`));metadata.acquiredAt="2020-01-01T00:00:00Z";fs.writeFileSync(`${l}\\lock.json`,JSON.stringify(metadata));expect(()=>s.takeOverStaleTaskStateLock("ws",t.taskId,1)).toThrow(/NOT_STALE/);s.releaseTaskStateLock(l);});
 it("CASE_TASK_STATE_LOCK_STALE_OWNER_DEAD_RECOVERY",()=>{const now=new Date("2026-01-02T00:00:00Z"),s=make(()=>false,now),t=s.createTaskState("ws"),l=s.acquireTaskStateLock("ws",t.taskId);const old=JSON.parse(fs.readFileSync(`${l}\\lock.json`,`utf8`));old.acquiredAt="2020-01-01T00:00:00Z";fs.writeFileSync(`${l}\\lock.json`,JSON.stringify(old));const next=s.takeOverStaleTaskStateLock("ws",t.taskId,1);s.releaseTaskStateLock(next);const a=s.acquireWorkspaceMutationLease("ws",t.taskId,"a");expect(()=>s.requireMutationLeaseOwner("ws",t.taskId,{leaseId:a.leaseId,ownerSessionMarker:"b"})).toThrow(/NOT_OWNED/);s.releaseWorkspaceMutationLease("ws",t.taskId,{leaseId:a.leaseId,ownerSessionMarker:"a"});});
});
