import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import {
  CONTROLLED_WRITE_MODE,
  CONTROLLED_WRITE_SCOPE,
  executeControlledWrite,
  type ControlledWriteContext,
  type ControlledWriteFileOps,
  type ControlledWriteRequest,
} from "../src/workspace/controlled-write.js";
import { GatewayWorkspaceRegistry } from "../src/workspace/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
const ORIGINAL = Buffer.from("\uFEFFbefore\r\nTARGET\r\nafter\r\n", "utf8");
const UPDATED = Buffer.from("\uFEFFbefore\r\nUPDATED\r\nafter\r\n", "utf8");

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function fixture(): { context: ControlledWriteContext; request: ControlledWriteRequest; file: string; workspace: Workspace } {
  const root = makeTmpDir("controlled-write");
  const file = write(root, "approved/target.md", "");
  fs.writeFileSync(file, ORIGINAL);
  write(root, ".env", "SECRET=value\n");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  write(root, ".git/config", "[core]\n");
  const workspace = new Workspace(root);
  const context: ControlledWriteContext = {
    workspace,
    authorization: {
      authorizationRef: "decision:approved-1",
      boundTaskId: "controlled-write-test",
      boundWorkspaceId: workspace.id,
      scopes: [CONTROLLED_WRITE_SCOPE],
    },
    allowedPathPrefixes: ["approved"],
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  };
  const request: ControlledWriteRequest = {
    taskId: "controlled-write-test",
    workspaceId: workspace.id,
    targetPath: "approved/target.md",
    writeMode: CONTROLLED_WRITE_MODE,
    expectedScope: CONTROLLED_WRITE_SCOPE,
    authorizationRef: "decision:approved-1",
    reason: "isolated controlled-write acceptance",
    patch: { expectedContent: "TARGET", replacementContent: "UPDATED" },
    precondition: { expectedHash: hashBytes(ORIGINAL) },
  };
  dirs.push(root);
  return { context, request, file, workspace };
}

function expectDeniedUnchanged(
  change: (request: ControlledWriteRequest, context: ControlledWriteContext) => { request?: ControlledWriteRequest; context?: ControlledWriteContext }
): void {
  const { context, request, file } = fixture();
  const before = fs.readFileSync(file);
  const changed = change(request, context);
  const outcome = executeControlledWrite(changed.request ?? request, changed.context ?? context);
  expect(outcome.receipt.writeExecuted).toBe(false);
  expect(outcome.receipt.mutationState).toBe("NOT_EXECUTED");
  expect(outcome.receipt.result).toBe("DENIED");
  expect(fs.readFileSync(file)).toEqual(before);
}

const normalFileOps: ControlledWriteFileOps = {
  readFile: (filePath) => fs.readFileSync(filePath),
  writeTempFile: (tempPath, bytes, mode) => fs.writeFileSync(tempPath, bytes, { flag: "wx", mode }),
  replaceFile: (tempPath, targetPath) => fs.renameSync(tempPath, targetPath),
  removeTempFile: (tempPath) => fs.rmSync(tempPath, { force: true }),
};

describe("governed controlled write", () => {
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("patches one UTF-8 BOM and CRLF text target, then supports independent exact-byte readback", async () => {
    const { context, request, file, workspace } = fixture();
    const outcome = executeControlledWrite(request, context);
    expect(outcome.receipt).toMatchObject({ authorizationResult: "PASS", preconditionResult: "PASS", writeExecuted: true, mutationState: "COMMITTED", result: "PASS" });
    expect(outcome.receipt.beforeRef).toBe(`sha256:${request.precondition.expectedHash}`);
    expect(outcome.receipt.afterRef).toBe(`sha256:${hashBytes(UPDATED)}`);
    expect(fs.readFileSync(file)).toEqual(UPDATED);
    const readback = await workspace.readFile("approved/target.md");
    expect(readback.content).toBe("﻿before\nUPDATED\nafter");
    // The handler result is not the readback authority; this Workspace API returns exact bytes.
    expect(await workspace.readFileBytes("approved/target.md")).toEqual(UPDATED);
    isolateStateDir();
    appendExecutionRecord(workspace.id, {
      taskId: request.taskId,
      iteration: 1,
      changedFiles: ["approved/target.md"],
      tests: "controlled-write fixture readback",
      exitStatus: "ok",
      timestamp: outcome.receipt.timestamp ?? "UNKNOWN",
      controlledWriteReceipt: outcome.receipt,
    });
    expect(readExecutionRecords(workspace.id, 1)[0]?.controlledWriteReceipt).toEqual(outcome.receipt);
  });

  it("denies task, workspace, and scope authorization mismatches without changing the file", () => {
    expectDeniedUnchanged((_request, context) => ({ context: { ...context, authorization: undefined } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, authorizationRef: "decision:other" } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, taskId: "other-task" } }));
    expectDeniedUnchanged((request, context) => ({ context: { ...context, authorization: { ...context.authorization, boundTaskId: "" } } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, workspaceId: "other-workspace" } }));
    expectDeniedUnchanged((request, context) => ({ context: { ...context, authorization: { ...context.authorization, boundWorkspaceId: "" } } }));
    expectDeniedUnchanged((request, context) => ({ context: { ...context, authorization: { ...context.authorization, scopes: [] } } }));
  });

  it("denies a registered but unauthorized second workspace", () => {
    const root = makeTmpDir("controlled-write-registry");
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstFile = write(firstRoot, "approved/target.md", "FIRST TARGET");
    const secondFile = write(secondRoot, "approved/target.md", "SECOND TARGET");
    const first = new Workspace(firstRoot);
    const second = new Workspace(secondRoot);
    const registry = new GatewayWorkspaceRegistry(root, [
      { expectedWorkspaceId: first.id, root: firstRoot },
      { expectedWorkspaceId: second.id, root: secondRoot },
    ]);
    const context: ControlledWriteContext = {
      workspace: first,
      gatewayRegistry: registry,
      authorization: { authorizationRef: "decision:first", boundTaskId: "task-first", boundWorkspaceId: first.id, scopes: [CONTROLLED_WRITE_SCOPE] },
      allowedPathPrefixes: ["approved"],
    };
    const request: ControlledWriteRequest = {
      taskId: "task-first",
      workspaceId: second.id,
      targetPath: "approved/target.md",
      writeMode: CONTROLLED_WRITE_MODE,
      expectedScope: CONTROLLED_WRITE_SCOPE,
      authorizationRef: "decision:first",
      reason: "must not cross the authorized workspace",
      patch: { expectedContent: "TARGET", replacementContent: "UPDATED" },
      precondition: { expectedHash: hashBytes(fs.readFileSync(secondFile)) },
    };
    dirs.push(root);
    const outcome = executeControlledWrite(request, context);
    expect(outcome.receipt.failureClassification).toBe("AUTHORIZATION_WORKSPACE_MISMATCH");
    expect(fs.readFileSync(firstFile).toString()).toBe("FIRST TARGET");
    expect(fs.readFileSync(secondFile).toString()).toBe("SECOND TARGET");
  });

  it("rejects non-canonical and escaping path inputs before resolution", () => {
    for (const targetPath of ["../outside.md", "approved/../approved/target.md", "/outside.md", "approved\\target.md", "C:\\outside.md", "\\\\server\\share\\target.md", "approved/%2e%2e/target.md", "workspace:/approved/target.md", "file:/approved/target.md"]) {
      expectDeniedUnchanged((request) => ({ request: { ...request, targetPath } }));
    }
  });

  it("denies sensitive, protected, non-allowlisted, and symbolic-link escape targets", () => {
    expectDeniedUnchanged((request) => ({ request: { ...request, targetPath: ".env" } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, targetPath: ".git/config" } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, targetPath: "other.md" } }));
    const { context, request, file } = fixture();
    const external = makeTmpDir("controlled-write-external");
    const externalFile = write(external, "external.md", "TARGET");
    const link = path.join(context.workspace.root, "approved", "outside-link");
    // Windows permits directory junctions under the current policy even when file symlinks are denied.
    fs.symlinkSync(external, link, "junction");
    dirs.push(external);
    const outcome = executeControlledWrite({ ...request, targetPath: "approved/outside-link/external.md", precondition: { expectedHash: hashBytes(fs.readFileSync(externalFile)) } }, context);
    expect(outcome.receipt.writeExecuted).toBe(false);
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);
    expect(fs.readFileSync(externalFile).toString()).toBe("TARGET");
  });

  it("denies Git metadata at every path component and Windows case variant without changing any target", () => {
    const { context, request, file } = fixture();
    const ordinaryBefore = fs.readFileSync(file);
    const paths = [".git/config", "approved/.git/config", "approved/nested/.git/config", "approved/.GIT/config", "approved/nested/.Git/config"];
    for (const targetPath of paths) {
      const absolute = path.join(context.workspace.root, ...targetPath.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      const before = Buffer.from(`TARGET ${targetPath}`, "utf8");
      fs.writeFileSync(absolute, before);
      const outcome = executeControlledWrite({
        ...request,
        targetPath,
        patch: { expectedContent: "TARGET", replacementContent: "UPDATED" },
        precondition: { expectedHash: hashBytes(before) },
      }, context);
      expect(outcome.receipt).toMatchObject({ result: "DENIED", writeExecuted: false, mutationState: "NOT_EXECUTED", failureClassification: "PROTECTED_PATH_DENIED" });
      expect(fs.readFileSync(absolute)).toEqual(before);
      expect(fs.readFileSync(file)).toEqual(ordinaryBefore);
    }
  });

  it("denies junction-backed Git metadata path components before junction resolution", () => {
    const { context, request } = fixture();
    const destination = path.join(context.workspace.root, "approved", "junction-destination");
    const destinationFile = path.join(destination, "config");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(destinationFile, "TARGET");
    const repo = path.join(context.workspace.root, "approved", "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.symlinkSync(destination, path.join(repo, ".git"), "junction");

    const before = fs.readFileSync(destinationFile);
    for (const gitComponent of [".git", ".GIT", ".Git"]) {
      const outcome = executeControlledWrite({
        ...request,
        targetPath: `approved/repo/${gitComponent}/config`,
        precondition: { expectedHash: hashBytes(before) },
      }, context);
      expect(outcome.receipt).toMatchObject({
        result: "DENIED",
        writeExecuted: false,
        mutationState: "NOT_EXECUTED",
        failureClassification: "PROTECTED_PATH_DENIED",
      });
      expect(fs.readFileSync(destinationFile)).toEqual(before);
    }
  });

  it("allows ordinary names containing git when they satisfy the allowlist and sensitive-file policy", () => {
    const { context, request } = fixture();
    for (const targetPath of ["approved/git-notes.md", "approved/repository-git/config.txt", "approved/.github/file.md"]) {
      const absolute = path.join(context.workspace.root, ...targetPath.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      const before = Buffer.from("TARGET", "utf8");
      fs.writeFileSync(absolute, before);
      const outcome = executeControlledWrite({
        ...request,
        targetPath,
        patch: { expectedContent: "TARGET", replacementContent: "UPDATED" },
        precondition: { expectedHash: hashBytes(before) },
      }, context);
      expect(outcome.receipt).toMatchObject({ result: "PASS", mutationState: "COMMITTED" });
      expect(fs.readFileSync(absolute)).toEqual(Buffer.from("UPDATED", "utf8"));
    }
  });

  it("denies hard-linked targets and preserves both links", () => {
    const { context, request, file } = fixture();
    const other = path.join(context.workspace.root, "outside", "other.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.linkSync(file, other);
    const outcome = executeControlledWrite(request, context);
    expect(outcome.receipt.failureClassification).toBe("HARDLINK_TARGET_DENIED");
    expect(outcome.receipt.writeExecuted).toBe(false);
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);
    expect(fs.readFileSync(other)).toEqual(ORIGINAL);
  });

  it("distinguishes zero and multiple patch matches without changing the target", () => {
    expectDeniedUnchanged((request) => ({ request: { ...request, patch: { expectedContent: "MISSING", replacementContent: "UPDATED" } } }));
    const { context, request, file } = fixture();
    const multiple = Buffer.from("\uFEFFTARGET\r\nTARGET\r\n", "utf8");
    fs.writeFileSync(file, multiple);
    const outcome = executeControlledWrite({ ...request, precondition: { expectedHash: hashBytes(multiple) } }, context);
    expect(outcome.receipt.failureClassification).toBe("PATCH_MULTIPLE_MATCH");
    expect(fs.readFileSync(file)).toEqual(multiple);
  });

  it("denies mismatched preconditions, unsupported modes, binary targets, and malformed patch payloads", () => {
    expectDeniedUnchanged((request) => ({ request: { ...request, precondition: { expectedHash: "A".repeat(64) } } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, writeMode: "DELETE" } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, writeMode: "RENAME" } }));
    expectDeniedUnchanged((request) => ({ request: { ...request, patch: { expectedContent: "TARGET\0", replacementContent: "UPDATED" } } }));
    const { context, request, file } = fixture();
    const binary = Buffer.from([0, 1, 2, 3]);
    fs.writeFileSync(file, binary);
    const outcome = executeControlledWrite({ ...request, precondition: { expectedHash: hashBytes(binary) } }, context);
    expect(outcome.receipt.failureClassification).toBe("BINARY_TARGET_DENIED");
    expect(fs.readFileSync(file)).toEqual(binary);
  });

  it("rejects isolated surrogate patch inputs and preserves the original bytes", () => {
    const isolatedHigh = String.fromCharCode(0xd800);
    const isolatedLow = String.fromCharCode(0xdc00);
    for (const patch of [
      { expectedContent: isolatedHigh, replacementContent: "UPDATED" },
      { expectedContent: isolatedLow, replacementContent: "UPDATED" },
      { expectedContent: "TARGET", replacementContent: isolatedHigh },
      { expectedContent: "TARGET", replacementContent: isolatedLow },
    ]) {
      const { context, request, file } = fixture();
      const outcome = executeControlledWrite({ ...request, patch }, context);
      expect(outcome.receipt.failureClassification).toBe("PATCH_INVALID");
      expect(outcome.receipt.result).toBe("DENIED");
      expect(fs.readFileSync(file)).toEqual(ORIGINAL);
    }
  });

  it("replaces a complete emoji while preserving non-target UTF-8 bytes, BOM, CRLF, and the trailing newline", async () => {
    const { context, request, file, workspace } = fixture();
    const before = Buffer.from("\uFEFFpré\r\nA😀B\r\n終\r\n", "utf8");
    const after = Buffer.from("\uFEFFpré\r\nAXB\r\n終\r\n", "utf8");
    fs.writeFileSync(file, before);
    const outcome = executeControlledWrite({ ...request, patch: { expectedContent: "😀", replacementContent: "X" }, precondition: { expectedHash: hashBytes(before) } }, context);
    expect(outcome.receipt.result).toBe("PASS");
    expect(outcome.receipt.afterRef).toBe(`sha256:${hashBytes(after)}`);
    expect(await workspace.readFileBytes("approved/target.md")).toEqual(after);
  });

  it("denies a patch whose final bytes would be unchanged", () => {
    const { context, request, file } = fixture();
    const outcome = executeControlledWrite({ ...request, patch: { expectedContent: "TARGET", replacementContent: "TARGET" } }, context);
    expect(outcome.receipt).toMatchObject({ result: "DENIED", writeExecuted: false, mutationState: "NOT_EXECUTED", failureClassification: "NO_EFFECTIVE_BYTE_CHANGE" });
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);
  });

  it("returns structured failures for prepare and pre-commit read errors without changing the target", () => {
    const firstReadFailure: ControlledWriteFileOps = { ...normalFileOps, readFile: () => { throw new Error("injected first read failure"); } };
    const { context, request, file } = fixture();
    const first = executeControlledWrite(request, context, firstReadFailure);
    expect(first.receipt).toMatchObject({ result: "FAILED", preconditionResult: "NOT_EVALUATED", mutationState: "NOT_EXECUTED", failureClassification: "PREPARE_READ_FAILED" });
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);

    let reads = 0;
    const preCommitReadFailure: ControlledWriteFileOps = {
      ...normalFileOps,
      readFile: (filePath) => {
        reads++;
        if (reads === 2) throw new Error("injected pre-commit read failure");
        return fs.readFileSync(filePath);
      },
    };
    const second = executeControlledWrite(request, context, preCommitReadFailure);
    expect(second.receipt).toMatchObject({ result: "FAILED", mutationState: "NOT_EXECUTED", failureClassification: "PRECOMMIT_READ_FAILED" });
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);
  });

  it("preserves the original and returns a structured failure when temp preparation or commit fails", () => {
    const beforeCommitFailure: ControlledWriteFileOps = { ...normalFileOps, writeTempFile: () => { throw new Error("injected temp write failure"); } };
    const commitFailure: ControlledWriteFileOps = { ...normalFileOps, replaceFile: () => { throw new Error("injected commit failure"); } };
    for (const fileOps of [beforeCommitFailure, commitFailure]) {
      const { context, request, file } = fixture();
      const outcome = executeControlledWrite(request, context, fileOps);
      expect(outcome.receipt.result).toBe("FAILED");
      expect(outcome.receipt.writeExecuted).toBe(false);
      expect(outcome.receipt.mutationState).toBe("NOT_EXECUTED");
      expect(outcome.receipt.failureClassification).toMatch(/TEMP_WRITE_FAILED|COMMIT_FAILED/);
      expect(fs.readFileSync(file)).toEqual(ORIGINAL);
      expect(fs.readdirSync(path.dirname(file)).some((entry) => entry.includes(".c2c-write-"))).toBe(false);
    }
  });

  it("reports temp validation and cleanup failures without silently claiming a commit", () => {
    let reads = 0;
    const tempValidationFailure: ControlledWriteFileOps = {
      ...normalFileOps,
      readFile: (filePath) => {
        reads++;
        if (reads === 3) throw new Error("injected temp validation failure");
        return fs.readFileSync(filePath);
      },
    };
    const { context, request, file } = fixture();
    const validation = executeControlledWrite(request, context, tempValidationFailure);
    expect(validation.receipt).toMatchObject({ result: "FAILED", writeExecuted: false, mutationState: "NOT_EXECUTED", failureClassification: "TEMP_VALIDATION_FAILED" });
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);

    const cleanupFailure: ControlledWriteFileOps = {
      ...normalFileOps,
      writeTempFile: () => { throw new Error("injected temp failure"); },
      removeTempFile: () => { throw new Error("injected cleanup failure"); },
    };
    const cleanup = executeControlledWrite(request, context, cleanupFailure);
    expect(cleanup.receipt).toMatchObject({ result: "FAILED", writeExecuted: false, mutationState: "NOT_EXECUTED", failureClassification: "TEMP_CLEANUP_FAILED" });
    expect(fs.readFileSync(file)).toEqual(ORIGINAL);
  });

  it("reports UNKNOWN when a commit may have completed before an error", () => {
    const commitAfterError: ControlledWriteFileOps = {
      ...normalFileOps,
      replaceFile: (tempPath, targetPath) => {
        fs.renameSync(tempPath, targetPath);
        throw new Error("injected post-commit error");
      },
    };
    const { context, request, file } = fixture();
    const outcome = executeControlledWrite(request, context, commitAfterError);
    expect(outcome.receipt).toMatchObject({ result: "FAILED", writeExecuted: "UNKNOWN", mutationState: "UNKNOWN", failureClassification: "COMMIT_FAILED" });
    expect(fs.readFileSync(file)).toEqual(UPDATED);
  });

  it("returns a structured committed result when timestamp metadata fails after commit", () => {
    const { context, request, file } = fixture();
    const outcome = executeControlledWrite(request, { ...context, now: () => { throw new Error("injected timestamp failure"); } });
    expect(outcome.receipt).toMatchObject({
      timestamp: null,
      result: "FAILED",
      writeExecuted: true,
      mutationState: "COMMITTED",
      failureClassification: "POST_COMMIT_METADATA_FAILED",
    });
    expect(fs.readFileSync(file)).toEqual(UPDATED);
  });
});
