import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const script=path.join(root,"ops","cutover","c2c-production-cutover.ps1");
describe("cutover orchestrator",()=>{it("dry run validates canonical checkpoint placement",()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),"c2c-cutover-"));try{fs.mkdirSync(path.join(d,"state","auth"),{recursive:true});const cli=path.join(d,"cli.js");fs.writeFileSync(cli,"");const r=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",script,"-CandidateCli",cli,"-OldGatewayCli",cli,"-C2CStateDir",path.join(d,"state"),"-Workspace",d,"-WorkspaceId","w","-DryRun"],{encoding:"utf8"});expect(r.status).toBe(0);expect(JSON.parse(r.stdout).checkpointPosition).toBe("AFTER_CANDIDATE_START_BEFORE_WATCHDOG")}finally{fs.rmSync(d,{recursive:true,force:true})}})});
