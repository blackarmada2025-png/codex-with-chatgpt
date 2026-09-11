import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExecutionRecords } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "index.js");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

describe("receipt CLI integration", () => {
  it("writes a complete receipt that existing execution reads expose", () => {
    const state = makeTmpDir("receipt-cli-state");
    const workspaceRoot = makeTmpDir("receipt-cli-workspace");
    dirs.push(state, workspaceRoot);
    write(workspaceRoot, "note.txt", "fixture");
    const result = spawnSync(process.execPath, [cli, "record", "--workspace", workspaceRoot, "--task", "receipt-cli", "--iteration", "1", "--receipt-object-identity", "object", "--receipt-object-hash", "hash", "--receipt-validation-type", "contract", "--receipt-scope", "scope", "--receipt-environment", "isolated-test", "--receipt-reference", "validation:1"], { encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: state } });
    expect(result.status).toBe(0);
    process.env.C2C_STATE_DIR = state;
    const [record] = readExecutionRecords(new Workspace(workspaceRoot).id);
    expect(record.reusableEvidenceReceipt).toMatchObject({ objectIdentity: "object", objectHashOrVersion: "hash", validationType: "contract", scope: "scope", environment: "isolated-test", evidenceReference: "validation:1", result: "PASS" });
  });
});
