import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GatewayWorkspaceError, GatewayWorkspaceRegistry } from "./registry.js";
import { Workspace, WorkspaceError } from "./manager.js";

/** This scope is a handler contract only until an OAuth binding explicitly adds it. */
export const CONTROLLED_WRITE_SCOPE = "workspace.write";
export const CONTROLLED_WRITE_MODE = "PATCH_EXISTING_TEXT";
/** Pilot prerequisite: the target has no concurrent writer, including editors and sync processes. */
export const EXCLUSIVE_SINGLE_WRITER_REQUIRED = true;

export type ControlledWriteFailure =
  | "TASK_ID_REQUIRED"
  | "REASON_REQUIRED"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_TASK_MISMATCH"
  | "AUTHORIZATION_WORKSPACE_MISMATCH"
  | "WRITE_SCOPE_DENIED"
  | "WORKSPACE_NOT_ALLOWED"
  | "PATH_INPUT_INVALID"
  | "PATH_NOT_ALLOWED"
  | "PROTECTED_PATH_DENIED"
  | "TARGET_NOT_A_REGULAR_TEXT_FILE"
  | "HARDLINK_TARGET_DENIED"
  | "BINARY_TARGET_DENIED"
  | "PRECONDITION_INVALID"
  | "PRECONDITION_MISMATCH"
  | "PREPARE_READ_FAILED"
  | "PRECOMMIT_READ_FAILED"
  | "PATCH_INVALID"
  | "NO_EFFECTIVE_BYTE_CHANGE"
  | "PATCH_ZERO_MATCH"
  | "PATCH_MULTIPLE_MATCH"
  | "UNSUPPORTED_WRITE_MODE"
  | "TEMP_WRITE_FAILED"
  | "TEMP_VALIDATION_FAILED"
  | "COMMIT_FAILED"
  | "POST_COMMIT_VERIFICATION_FAILED"
  | "POST_COMMIT_METADATA_FAILED"
  | "TEMP_CLEANUP_FAILED";

export interface ControlledWriteAuthorization {
  /** Stable reference supplied by the existing authorization/decision layer. */
  authorizationRef: string;
  /** The task and workspace covered by that trusted authorization. */
  boundTaskId: string;
  boundWorkspaceId: string;
  /** Existing caller-provided scopes; this module never grants scopes. */
  scopes: readonly string[];
}

export interface ControlledWriteRequest {
  taskId: string;
  workspaceId: string;
  targetPath: string;
  writeMode: typeof CONTROLLED_WRITE_MODE | string;
  expectedScope: string;
  authorizationRef: string;
  reason: string;
  patch: { expectedContent: string; replacementContent: string };
  precondition: { expectedHash: string };
}

export interface ControlledWriteReceipt {
  taskId: string;
  workspaceId: string;
  targetPath: string;
  writeMode: string;
  authorizationResult: "PASS" | "DENIED";
  preconditionResult: "PASS" | "MISMATCH" | "NOT_EVALUATED";
  /** False means no commit was observed; UNKNOWN means commit state could not be proven. */
  writeExecuted: boolean | "UNKNOWN";
  mutationState: "NOT_EXECUTED" | "COMMITTED" | "UNKNOWN";
  beforeRef: string | null;
  afterRef: string | null;
  /** Null means receipt timestamp generation failed; it is never fabricated. */
  timestamp: string | null;
  result: "PASS" | "DENIED" | "FAILED";
  failureClassification: ControlledWriteFailure | null;
}

export interface ControlledWriteResult { receipt: ControlledWriteReceipt; }

export interface ControlledWriteContext {
  workspace: Workspace;
  gatewayRegistry?: GatewayWorkspaceRegistry;
  authorization?: ControlledWriteAuthorization;
  /** Canonical workspace-relative prefixes supplied by the binding layer. */
  allowedPathPrefixes: readonly string[];
  now?: () => Date;
}

/** Test seam for deterministic filesystem failure injection; runtime bindings use the defaults. */
export interface ControlledWriteFileOps {
  readFile(filePath: string): Buffer;
  writeTempFile(tempPath: string, bytes: Buffer, mode: number): void;
  replaceFile(tempPath: string, targetPath: string): void;
  removeTempFile(tempPath: string): void;
}

const DEFAULT_FILE_OPS: ControlledWriteFileOps = {
  readFile: (filePath) => fs.readFileSync(filePath),
  writeTempFile: (tempPath, bytes, mode) => fs.writeFileSync(tempPath, bytes, { flag: "wx", mode }),
  // Both names are sibling paths on the same volume. Node maps this to the platform replacement primitive.
  replaceFile: (tempPath, targetPath) => fs.renameSync(tempPath, targetPath),
  removeTempFile: (tempPath) => fs.rmSync(tempPath, { force: true }),
};

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex").toUpperCase(); }
function hashRef(bytes: Buffer): string { return `sha256:${sha256(bytes)}`; }
/** Git metadata is protected at every path component, using host filesystem casing rules. */
function isProtectedPath(rel: string): boolean {
  return rel.split("/").some((component) => component.toLowerCase() === ".git");
}
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }

function isUnicodeScalarSequence(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isAuthorization(value: unknown): value is ControlledWriteAuthorization {
  if (!value || typeof value !== "object") return false;
  const authorization = value as Partial<ControlledWriteAuthorization>;
  return isNonEmptyString(authorization.authorizationRef)
    && isNonEmptyString(authorization.boundTaskId)
    && isNonEmptyString(authorization.boundWorkspaceId)
    && Array.isArray(authorization.scopes)
    && authorization.scopes.every((scope) => typeof scope === "string");
}

/** Reject aliases and normalization syntax before Workspace resolves the path. */
function isCanonicalRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value !== value.trim() || value.includes("\\") || value.includes(":")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  try {
    if (decodeURIComponent(value) !== value) return false;
  } catch {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isAllowedPath(rel: string, prefixes: readonly string[]): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const candidate = normalize(rel);
  return prefixes.some((prefix) => {
    if (!isCanonicalRelativePath(prefix)) return false;
    const allowed = normalize(prefix);
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
  });
}

function tempSibling(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.c2c-write-${randomBytes(12).toString("hex")}.tmp`);
}

function result(
  request: ControlledWriteRequest,
  now: () => Date,
  values: Omit<ControlledWriteReceipt, "taskId" | "workspaceId" | "targetPath" | "writeMode" | "timestamp">
): ControlledWriteResult {
  let timestamp: string | null = null;
  try { timestamp = now().toISOString(); } catch { /* Report unknown rather than fabricating a receipt time. */ }
  return { receipt: { taskId: request.taskId, workspaceId: request.workspaceId, targetPath: request.targetPath, writeMode: request.writeMode, timestamp, ...values } };
}

function denied(
  request: ControlledWriteRequest,
  now: () => Date,
  failureClassification: ControlledWriteFailure,
  authorizationResult: ControlledWriteReceipt["authorizationResult"] = "DENIED",
  preconditionResult: ControlledWriteReceipt["preconditionResult"] = "NOT_EVALUATED",
  beforeRef: string | null = null
): ControlledWriteResult {
  return result(request, now, { authorizationResult, preconditionResult, writeExecuted: false, mutationState: "NOT_EXECUTED", beforeRef, afterRef: null, result: "DENIED", failureClassification });
}

function failed(
  request: ControlledWriteRequest,
  now: () => Date,
  failureClassification: ControlledWriteFailure,
  beforeRef: string | null,
  mutationState: ControlledWriteReceipt["mutationState"],
  preconditionResult: ControlledWriteReceipt["preconditionResult"] = "PASS"
): ControlledWriteResult {
  return result(request, now, { authorizationResult: "PASS", preconditionResult, writeExecuted: mutationState === "UNKNOWN" ? "UNKNOWN" : mutationState === "COMMITTED", mutationState, beforeRef, afterRef: null, result: "FAILED", failureClassification });
}

function resolveWorkspace(request: ControlledWriteRequest, context: ControlledWriteContext): Workspace | null {
  if (context.gatewayRegistry) {
    try {
      return context.gatewayRegistry.resolve(request.workspaceId);
    } catch (error) {
      if (error instanceof GatewayWorkspaceError) return null;
      throw error;
    }
  }
  return request.workspaceId === context.workspace.id ? context.workspace : null;
}

function targetStillMatches(targetPath: string, before: Buffer, fileOps: ControlledWriteFileOps): "NOT_EXECUTED" | "UNKNOWN" {
  try { return fileOps.readFile(targetPath).equals(before) ? "NOT_EXECUTED" : "UNKNOWN"; } catch { return "UNKNOWN"; }
}

function cleanupTemp(tempPath: string, fileOps: ControlledWriteFileOps): boolean {
  try { fileOps.removeTempFile(tempPath); return true; } catch { return false; }
}

/**
 * Applies one exact text replacement to an existing, allowlisted workspace file.
 * It is intentionally unregistered: only an approved runtime binding may supply
 * trusted authorization context and a writable OAuth scope in a later phase.
 */
export function executeControlledWrite(
  request: ControlledWriteRequest,
  context: ControlledWriteContext,
  fileOps: ControlledWriteFileOps = DEFAULT_FILE_OPS
): ControlledWriteResult {
  const now = context.now ?? (() => new Date());
  const authorization = context.authorization;
  if (!isNonEmptyString(request.taskId)) return denied(request, now, "TASK_ID_REQUIRED");
  if (!isNonEmptyString(request.reason)) return denied(request, now, "REASON_REQUIRED");
  if (!isAuthorization(authorization) || !isNonEmptyString(request.authorizationRef) || request.authorizationRef !== authorization.authorizationRef) {
    return denied(request, now, "AUTHORIZATION_REQUIRED");
  }
  if (request.taskId !== authorization.boundTaskId) return denied(request, now, "AUTHORIZATION_TASK_MISMATCH");
  if (request.workspaceId !== authorization.boundWorkspaceId) return denied(request, now, "AUTHORIZATION_WORKSPACE_MISMATCH");
  if (request.expectedScope !== CONTROLLED_WRITE_SCOPE || !authorization.scopes.includes(CONTROLLED_WRITE_SCOPE)) return denied(request, now, "WRITE_SCOPE_DENIED");
  if (request.writeMode !== CONTROLLED_WRITE_MODE) return denied(request, now, "UNSUPPORTED_WRITE_MODE", "PASS");
  if (!request.precondition || !/^[A-Fa-f0-9]{64}$/.test(request.precondition.expectedHash)) return denied(request, now, "PRECONDITION_INVALID", "PASS");
  if (!request.patch || !isNonEmptyString(request.patch.expectedContent) || typeof request.patch.replacementContent !== "string" || request.patch.expectedContent.includes("\0") || request.patch.replacementContent.includes("\0") || !isUnicodeScalarSequence(request.patch.expectedContent) || !isUnicodeScalarSequence(request.patch.replacementContent)) {
    return denied(request, now, "PATCH_INVALID", "PASS");
  }
  if (!isCanonicalRelativePath(request.targetPath)) return denied(request, now, "PATH_INPUT_INVALID", "PASS");
  // Check the request before realpath can erase a .git junction component.
  if (isProtectedPath(request.targetPath)) return denied(request, now, "PROTECTED_PATH_DENIED", "PASS");

  const workspace = resolveWorkspace(request, context);
  if (!workspace) return denied(request, now, "WORKSPACE_NOT_ALLOWED", "PASS");
  let resolved: { abs: string; rel: string };
  try {
    resolved = workspace.resolve(request.targetPath);
  } catch (error) {
    if (error instanceof WorkspaceError) return denied(request, now, error.code === "ACCESS_DENIED_SENSITIVE_FILE" ? "PROTECTED_PATH_DENIED" : "PATH_NOT_ALLOWED", "PASS");
    throw error;
  }
  if (isProtectedPath(resolved.rel) || !isAllowedPath(resolved.rel, context.allowedPathPrefixes)) return denied(request, now, isProtectedPath(resolved.rel) ? "PROTECTED_PATH_DENIED" : "PATH_NOT_ALLOWED", "PASS");

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved.abs); } catch { return denied(request, now, "TARGET_NOT_A_REGULAR_TEXT_FILE", "PASS"); }
  if (!stat.isFile()) return denied(request, now, "TARGET_NOT_A_REGULAR_TEXT_FILE", "PASS");
  if (stat.nlink > 1) return denied(request, now, "HARDLINK_TARGET_DENIED", "PASS");

  let before: Buffer;
  try { before = fileOps.readFile(resolved.abs); } catch { return failed(request, now, "PREPARE_READ_FAILED", null, "NOT_EXECUTED", "NOT_EVALUATED"); }
  const beforeRef = hashRef(before);
  const text = before.toString("utf8");
  if (before.includes(0) || !Buffer.from(text, "utf8").equals(before)) return denied(request, now, "BINARY_TARGET_DENIED", "PASS", "NOT_EVALUATED", beforeRef);
  if (sha256(before) !== request.precondition.expectedHash.toUpperCase()) return denied(request, now, "PRECONDITION_MISMATCH", "PASS", "MISMATCH", beforeRef);
  const first = text.indexOf(request.patch.expectedContent);
  if (first === -1) return denied(request, now, "PATCH_ZERO_MATCH", "PASS", "PASS", beforeRef);
  if (first !== text.lastIndexOf(request.patch.expectedContent)) return denied(request, now, "PATCH_MULTIPLE_MATCH", "PASS", "PASS", beforeRef);

  const after = Buffer.from(text.slice(0, first) + request.patch.replacementContent + text.slice(first + request.patch.expectedContent.length), "utf8");
  if (after.equals(before)) return denied(request, now, "NO_EFFECTIVE_BYTE_CHANGE", "PASS", "PASS", beforeRef);
  let immediatelyBeforeWrite: Buffer;
  try { immediatelyBeforeWrite = fileOps.readFile(resolved.abs); } catch { return failed(request, now, "PRECOMMIT_READ_FAILED", beforeRef, "NOT_EXECUTED"); }
  if (!immediatelyBeforeWrite.equals(before)) return denied(request, now, "PRECONDITION_MISMATCH", "PASS", "MISMATCH", hashRef(immediatelyBeforeWrite));

  const tempPath = tempSibling(resolved.abs);
  try {
    fileOps.writeTempFile(tempPath, after, stat.mode);
  } catch {
    const mutationState = targetStillMatches(resolved.abs, before, fileOps);
    const cleaned = cleanupTemp(tempPath, fileOps);
    return failed(request, now, cleaned ? "TEMP_WRITE_FAILED" : "TEMP_CLEANUP_FAILED", beforeRef, mutationState);
  }
  let tempBytes: Buffer;
  try {
    tempBytes = fileOps.readFile(tempPath);
  } catch {
    const cleaned = cleanupTemp(tempPath, fileOps);
    return failed(request, now, cleaned ? "TEMP_VALIDATION_FAILED" : "TEMP_CLEANUP_FAILED", beforeRef, targetStillMatches(resolved.abs, before, fileOps));
  }
  if (!tempBytes.equals(after)) {
    const cleaned = cleanupTemp(tempPath, fileOps);
    return failed(request, now, cleaned ? "TEMP_VALIDATION_FAILED" : "TEMP_CLEANUP_FAILED", beforeRef, targetStillMatches(resolved.abs, before, fileOps));
  }
  try {
    fileOps.replaceFile(tempPath, resolved.abs);
  } catch {
    const mutationState = targetStillMatches(resolved.abs, before, fileOps);
    const cleaned = cleanupTemp(tempPath, fileOps);
    return failed(request, now, cleaned ? "COMMIT_FAILED" : "TEMP_CLEANUP_FAILED", beforeRef, mutationState);
  }
  let committed: Buffer;
  try { committed = fileOps.readFile(resolved.abs); } catch { return failed(request, now, "POST_COMMIT_VERIFICATION_FAILED", beforeRef, "UNKNOWN"); }
  if (!committed.equals(after)) return failed(request, now, "POST_COMMIT_VERIFICATION_FAILED", beforeRef, "UNKNOWN");
  let afterRef: string;
  try { afterRef = hashRef(after); } catch { return failed(request, now, "POST_COMMIT_METADATA_FAILED", beforeRef, "COMMITTED"); }
  const completed = result(request, now, { authorizationResult: "PASS", preconditionResult: "PASS", writeExecuted: true, mutationState: "COMMITTED", beforeRef, afterRef, result: "PASS", failureClassification: null });
  if (completed.receipt.timestamp === null) {
    completed.receipt.result = "FAILED";
    completed.receipt.failureClassification = "POST_COMMIT_METADATA_FAILED";
  }
  return completed;
}
