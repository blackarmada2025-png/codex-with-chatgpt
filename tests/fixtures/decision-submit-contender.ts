import fs from "node:fs";
import { DecisionService } from "../../src/task/decision-service.ts";
import { TaskStateError, TaskStateStore } from "../../src/task/state.ts";

const [stateDir, workspaceRoot, contractRoot, taskId, revision, leaseId, ownerSessionMarker, requestId, packetJson, payloadJson, ready, start, started] = process.argv.slice(2);
if ([stateDir, workspaceRoot, contractRoot, taskId, revision, leaseId, ownerSessionMarker, requestId, packetJson, payloadJson, ready, start, started].some((value) => !value)) process.exit(2);
const mark=(file:string,value:string)=>{const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,value);fs.renameSync(tmp,file);};
mark(ready,"READY");while(!fs.existsSync(start))await new Promise((resolve)=>setTimeout(resolve,2));mark(started,"STARTED");
const store=new TaskStateStore({stateDir,now:()=>new Date("2026-01-01T00:00:00.000Z")});
const service=new DecisionService({workspaceRoot,stateStore:store,contractRoot,now:()=>new Date("2026-01-01T00:00:00.000Z")});
for(let attempt=0;attempt<40;attempt++)try{const value=service.submitDecisionResponse("ws",taskId,Number(revision),{leaseId,ownerSessionMarker},requestId,JSON.parse(payloadJson));console.log(`SUCCESS:${value.activeContract?.contractId??value.state}`);process.exit(0);}catch(error){const code=error instanceof TaskStateError?error.code:error instanceof Error&&"code" in error?(error as {code:string}).code:String(error);if(code==="TASK_STATE_LOCK_HELD"){await new Promise((resolve)=>setTimeout(resolve,2));continue;}console.log(code);process.exit(0);}console.log("TASK_STATE_LOCK_HELD");
