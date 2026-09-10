import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const script=path.join(root,"ops","cutover","c2c-production-cutover.ps1");
describe("cutover orchestrator",()=>{it("dry run validates canonical checkpoint placement",()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),"c2c-cutover-"));try{fs.mkdirSync(path.join(d,"state","auth"),{recursive:true});const cli=path.join(d,"cli.js");fs.writeFileSync(cli,"");const r=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",script,"-CandidateCli",cli,"-OldGatewayCli",cli,"-C2CStateDir",path.join(d,"state"),"-Workspace",d,"-WorkspaceId","w","-DryRun"],{encoding:"utf8"});expect(r.status).toBe(0);expect(JSON.parse(r.stdout).checkpointPosition).toBe("AFTER_CANDIDATE_START_BEFORE_WATCHDOG")}finally{fs.rmSync(d,{recursive:true,force:true})}})});
function contract(fixture: Record<string, boolean>) { const d=fs.mkdtempSync(path.join(os.tmpdir(),"c2c-cutover-fixture-")); const f=path.join(d,"f.json"); fs.writeFileSync(f,JSON.stringify({...fixture,rollbackPublic:true})); const r=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",script,"-CandidateCli",script,"-OldGatewayCli",script,"-C2CStateDir",d,"-Workspace",d,"-WorkspaceId","w","-ContractTest","-ContractFixture",f],{encoding:"utf8"});fs.rmSync(d,{recursive:true,force:true});return JSON.parse(r.stdout); }
describe("failure injection uses one rollback",()=>{for(const [name,key] of [["start","start"],["identity","checkpoint"],["watchdog","watchdog"],["public","public"],["auth","auth"]] as const){it(name,()=>{const x=contract({preflight:true,start:true,checkpoint:true,watchdog:true,local:true,public:true,auth:true,[key]:false});expect(x.result).toBe("ROLLED_BACK");expect(x.events[0]).toMatch(/^rollback:/);expect(x.rollbackResult).toBe("PASS")})}});
