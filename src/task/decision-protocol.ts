import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]+$/);
const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Expected ISO timestamp.");

export const GATE_KINDS = [
  "SPECIFICATION_AMBIGUITY",
  "ARCHITECTURE_OR_POLICY_CONFLICT",
  "REPEATED_FAILURE_WITHOUT_EVIDENCE_DELTA",
  "COGNITIVE_BOUNDARY",
] as const;
export type GateKind = typeof GATE_KINDS[number];

const normalizedRootRelativePath = z.string().min(1).max(1024);
export const ScopeDescriptorV1Schema = z.object({
  schemaVersion: z.literal("scope-descriptor-v1"),
  workspaceId: identifier,
  canonicalRootRelativePaths: z.array(normalizedRootRelativePath).min(1).max(100),
  accessMode: z.enum(["READ_ONLY", "WRITE" ]),
  excludedPaths: z.array(normalizedRootRelativePath).max(100),
}).strict();
export type ScopeDescriptorV1 = z.infer<typeof ScopeDescriptorV1Schema>;

export const ApprovedAuthorityV1Schema = z.object({
  approvedScopeDescriptor: ScopeDescriptorV1Schema,
  approvedScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedActionIds: z.array(identifier).min(1).max(100),
  // Local, durable safety ceiling. This is not model-provided policy.
  globalForbiddenActionIds: z.array(identifier).max(100),
}).strict();
export type ApprovedAuthorityV1 = z.infer<typeof ApprovedAuthorityV1Schema>;

export interface ScopePathOptions { realpath?: (value: string) => string; }

function normalizeWorkspaceRelative(root: string, value: string, options: ScopePathOptions = {}): string {
  if (!value || path.isAbsolute(value)) throw new DecisionProtocolError("SCOPE_PATH_INVALID");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new DecisionProtocolError("SCOPE_PATH_ESCAPE");
  const rootReal = (options.realpath ?? fs.realpathSync.native)(path.resolve(root));
  const candidate = path.resolve(rootReal, normalized);
  const realpath = options.realpath ?? fs.realpathSync.native;
  // Resolve the nearest existing parent so a non-existent leaf cannot hide a
  // symlink escape in one of its ancestors.
  let existing = candidate;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new DecisionProtocolError("SCOPE_PATH_ESCAPE");
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const candidateReal = path.join(realpath(existing), ...missing);
  const relative = path.relative(rootReal, candidateReal).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new DecisionProtocolError("SCOPE_PATH_ESCAPE");
  }
  return relative.toLowerCase();
}

export function canonicalizeScopeDescriptor(
  workspaceRoot: string,
  descriptor: ScopeDescriptorV1,
  options: ScopePathOptions = {},
): ScopeDescriptorV1 {
  const parsed = ScopeDescriptorV1Schema.parse(descriptor);
  const canonical = (values: string[]) => [...new Set(values.map((value) => normalizeWorkspaceRelative(workspaceRoot, value, options)))].sort();
  const roots = canonical(parsed.canonicalRootRelativePaths);
  const excluded = canonical(parsed.excludedPaths);
  if (roots.some((root) => excluded.includes(root))) throw new DecisionProtocolError("SCOPE_DESCRIPTOR_CONFLICT");
  return { ...parsed, canonicalRootRelativePaths: roots, excludedPaths: excluded };
}

export function canonicalSerialize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

export function scopeDigest(descriptor: ScopeDescriptorV1): string { return sha256(descriptor); }

export const ActionDescriptorV1Schema = z.object({
  schemaVersion: z.literal("action-descriptor-v1"),
  actionType: identifier,
  // May be a workspace-relative path or a stable logical object identity.
  target: z.string().min(1).max(1024),
  approvedScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  criticalInput: z.unknown().refine((value) => value !== undefined, "Expected critical input."),
  criticalInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ActionDescriptorV1 = z.infer<typeof ActionDescriptorV1Schema>;

export const ActionFactV1Schema = z.object({
  actionDescriptor: ActionDescriptorV1Schema,
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ActionFactV1 = z.infer<typeof ActionFactV1Schema>;

export function criticalInputDigest(value: unknown): string { return sha256(value); }
export function actionDigest(descriptor: ActionDescriptorV1): string { return sha256(descriptor); }
export function validateActionFact(value: unknown): ActionFactV1 {
  const parsed = ActionFactV1Schema.parse(value);
  if (parsed.actionDescriptor.criticalInputDigest !== criticalInputDigest(parsed.actionDescriptor.criticalInput)) throw new DecisionProtocolError("CRITICAL_INPUT_DIGEST_MISMATCH");
  if (parsed.actionDigest !== actionDigest(parsed.actionDescriptor)) throw new DecisionProtocolError("ACTION_DIGEST_MISMATCH");
  return parsed;
}

export function isScopeSubset(child: ScopeDescriptorV1, parent: ScopeDescriptorV1): boolean {
  if (child.workspaceId !== parent.workspaceId) return false;
  if (parent.accessMode === "READ_ONLY" && child.accessMode !== "READ_ONLY") return false;
  const within = (value: string, roots: string[]) => roots.some((root) => value === root || value.startsWith(`${root}/`));
  if (child.canonicalRootRelativePaths.some((root) => !within(root, parent.canonicalRootRelativePaths))) return false;
  for (const approvedExclusion of parent.excludedPaths) {
    for (const childRoot of child.canonicalRootRelativePaths) {
      // A child rooted inside an excluded path is always an expansion.
      if (childRoot === approvedExclusion || childRoot.startsWith(`${approvedExclusion}/`)) return false;
      // If the child root contains an approved exclusion, it must preserve that
      // exclusion (or exclude an ancestor) rather than reopening it.
      if (approvedExclusion.startsWith(`${childRoot}/`) && !child.excludedPaths.some((excluded) => approvedExclusion === excluded || approvedExclusion.startsWith(`${excluded}/`))) return false;
    }
  }
  return true;
}

export const ReasoningPacketV1Schema = z.object({
  schemaVersion: z.literal("reasoning-packet-v1"),
  workspaceId: identifier,
  taskId: identifier,
  semanticRequestId: identifier,
  requestId: identifier,
  actionEpoch: z.number().int().nonnegative(),
  gateKind: z.enum(GATE_KINDS),
  currentTaskState: z.string().min(1),
  activeActionId: identifier,
  exactIssue: z.string().min(1).max(16_000),
  evidenceRefs: z.array(z.string().min(1)).max(100),
  attemptedFixes: z.array(z.string().min(1)).max(100),
  constraints: z.array(z.string().min(1)).max(100),
  candidateActionIds: z.array(identifier).min(1).max(100),
  forbiddenActionIds: z.array(identifier).max(100),
  scopeDescriptor: ScopeDescriptorV1Schema,
  // Optional only to keep legacy state readable. New decision paths reject its absence.
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: isoTime,
  validUntil: isoTime,
}).strict();
export type ReasoningPacketV1 = z.infer<typeof ReasoningPacketV1Schema>;

const decisionConstraint = z.string().min(1).max(2_000).refine((value) => value.trim().length > 0, "Expected non-blank constraint.");
const DecisionConstraintListSchema = z.array(decisionConstraint).max(50).default([]);
const ContractConstraintListSchema = z.array(decisionConstraint).max(100);

const DecisionResponsePayloadBaseSchema = z.object({
  schemaVersion: z.literal("decision-response-v1"),
  responseId: identifier,
  disposition: z.enum(["EXECUTE", "HUMAN_GATE_REQUIRED", "STOP"]),
  summary: z.string().min(1).max(16_000),
  requestedActionIds: z.array(identifier).max(100).default([]),
  // Machine-readable execution restrictions. Summary remains human-facing only.
  preconditions: DecisionConstraintListSchema,
  acceptanceCriteria: DecisionConstraintListSchema,
  stopConditions: DecisionConstraintListSchema,
}).strict();
function validateDecisionResponseDisposition(value: z.infer<typeof DecisionResponsePayloadBaseSchema>, context: z.RefinementCtx): void {
  if (value.disposition !== "EXECUTE") {
    if (value.requestedActionIds.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Only EXECUTE may request actions." });
    }
    for (const field of ["preconditions", "acceptanceCriteria", "stopConditions"] as const) {
      if (value[field].length > 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Only EXECUTE may carry execution constraints." });
      }
    }
  }
}
export const DecisionResponsePayloadV1Schema = DecisionResponsePayloadBaseSchema.superRefine(validateDecisionResponseDisposition);
export type DecisionResponsePayloadV1 = z.infer<typeof DecisionResponsePayloadV1Schema>;

export const DecisionResponseV1Schema = DecisionResponsePayloadBaseSchema.extend({
  workspaceId: identifier,
  taskId: identifier,
  semanticRequestId: identifier,
  requestId: identifier,
  actionEpoch: z.number().int().nonnegative(),
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: isoTime,
}).strict().superRefine(validateDecisionResponseDisposition);
export type DecisionResponseV1 = z.infer<typeof DecisionResponseV1Schema>;

/**
 * Stable decision identity for transport retries. receivedAt is transport
 * observation metadata, not decision semantics, so it is deliberately
 * excluded. All strict response fields (including future additions) remain
 * covered by the canonical serialization.
 */
export function decisionResponseDigest(response: DecisionResponseV1): string {
  const parsed = DecisionResponseV1Schema.parse(response);
  const { receivedAt: _receivedAt, ...semantic } = parsed;
  return sha256(semantic);
}

export const DecisionReceiptV1Schema = z.object({
  requestId: identifier,
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // Older receipts remain readable, but lack the authority fact required for
  // idempotent retry and therefore fail closed when retried.
  activeActionId: identifier.optional(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  response: DecisionResponseV1Schema,
  responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contractId: identifier.optional(),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  artifactPath: z.string().min(1).optional(),
  decidedAt: isoTime,
}).strict();
export type DecisionReceiptV1 = z.infer<typeof DecisionReceiptV1Schema>;

export function validateDecisionReceipt(value: unknown): DecisionReceiptV1 {
  const parsed = DecisionReceiptV1Schema.parse(value);
  if (parsed.response.requestId !== parsed.requestId || parsed.response.packetDigest !== parsed.packetDigest) throw new DecisionProtocolError("DECISION_RECEIPT_BINDING_MISMATCH");
  if (decisionResponseDigest(parsed.response) !== parsed.responseDigest) throw new DecisionProtocolError("DECISION_RESPONSE_DIGEST_MISMATCH");
  if (parsed.response.disposition === "EXECUTE" && (!parsed.contractId || !parsed.contractDigest || !parsed.artifactPath)) throw new DecisionProtocolError("DECISION_RECEIPT_CONTRACT_MISSING");
  if (parsed.response.disposition !== "EXECUTE" && (parsed.contractId || parsed.contractDigest || parsed.artifactPath)) throw new DecisionProtocolError("DECISION_RECEIPT_CONTRACT_UNEXPECTED");
  return parsed;
}

export const ContractBindingV1Schema = z.object({
  workspaceId: identifier,
  taskId: identifier,
  semanticRequestId: identifier,
  requestId: identifier,
  actionEpoch: z.number().int().nonnegative(),
  // Optional only so historical contracts remain readable. New materialized
  // contracts bind the concrete active-action identity as well.
  activeActionId: identifier.optional(),
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // Optional only for legacy state read compatibility; new contracts always bind it.
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ContractBindingV1 = z.infer<typeof ContractBindingV1Schema>;

export const ExecutionContractV1Schema = z.object({
  schemaVersion: z.literal("execution-contract-v1"),
  contractId: identifier,
  binding: ContractBindingV1Schema,
  gateKind: z.enum(GATE_KINDS),
  decisionResponseId: identifier,
  allowedActionIds: z.array(identifier).min(1).max(100),
  scopeDescriptor: ScopeDescriptorV1Schema,
  forbiddenActionIds: z.array(identifier).max(100),
  approvedAuthority: ApprovedAuthorityV1Schema,
  preconditions: ContractConstraintListSchema,
  acceptanceCriteria: ContractConstraintListSchema,
  stopConditions: ContractConstraintListSchema,
  createdAt: isoTime,
  validUntil: isoTime,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ExecutionContractV1 = z.infer<typeof ExecutionContractV1Schema>;

export interface ContractMaterializationInput {
  contractId: string;
  packet: ReasoningPacketV1;
  packetDigest: string;
  response: DecisionResponseV1;
  approvedAuthority: ApprovedAuthorityV1;
  activeAction: ActionFactV1;
  forbiddenActionIds?: string[];
  // Local mandatory conditions may only add to Decision constraints.
  preconditions?: string[];
  acceptanceCriteria?: string[];
  stopConditions?: string[];
}

export class DecisionProtocolError extends Error {
  constructor(public code: string, message = code) { super(message); this.name = "DecisionProtocolError"; }
}

export function validatePacket(packet: unknown): ReasoningPacketV1 {
  const value = ReasoningPacketV1Schema.parse(packet);
  if (Date.parse(value.validUntil) <= Date.parse(value.createdAt)) throw new DecisionProtocolError("PACKET_EXPIRY_INVALID");
  return value;
}

export function reasoningPacketDigest(packet: ReasoningPacketV1): string {
  return sha256(validatePacket(packet));
}

export function bindDecisionResponse(
  packet: ReasoningPacketV1,
  packetDigestValue: string,
  payload: unknown,
  receivedAt: string,
): DecisionResponseV1 {
  const validated = DecisionResponsePayloadV1Schema.parse(payload);
  const response: DecisionResponseV1 = {
    ...validated,
    workspaceId: packet.workspaceId,
    taskId: packet.taskId,
    semanticRequestId: packet.semanticRequestId,
    requestId: packet.requestId,
    actionEpoch: packet.actionEpoch,
    packetDigest: packetDigestValue,
    scopeDigest: scopeDigest(packet.scopeDescriptor),
    receivedAt,
  };
  return DecisionResponseV1Schema.parse(response);
}

/** Preserve Decision semantics; dedupe only exact canonical string matches. */
function mergeConstraints(decisionConstraints: string[], localConstraints: string[] | undefined): string[] {
  return [...new Set([...decisionConstraints, ...ContractConstraintListSchema.parse(localConstraints ?? [])])];
}

export function materializeExecutionContract(input: ContractMaterializationInput): ExecutionContractV1 {
  const packet = validatePacket(input.packet);
  const response = DecisionResponseV1Schema.parse(input.response);
  const expectedDigest = reasoningPacketDigest(packet);
  if (input.packetDigest !== expectedDigest || response.packetDigest !== expectedDigest) throw new DecisionProtocolError("PACKET_DIGEST_MISMATCH");
  if (response.disposition !== "EXECUTE") throw new DecisionProtocolError("DECISION_DOES_NOT_AUTHORIZE_CONTRACT");
  const packetScopeDigest = scopeDigest(packet.scopeDescriptor);
  if (response.scopeDigest !== packetScopeDigest) throw new DecisionProtocolError("SCOPE_DIGEST_MISMATCH");
  const authority = ApprovedAuthorityV1Schema.parse(input.approvedAuthority);
  const activeAction = validateActionFact(input.activeAction);
  if (!packet.actionDigest) throw new DecisionProtocolError("MISSING_ACTION_DIGEST_DENIED");
  if (packet.actionDigest !== activeAction.actionDigest) throw new DecisionProtocolError("ACTION_DIGEST_MISMATCH");
  if (activeAction.actionDescriptor.approvedScopeDigest !== authority.approvedScopeDigest) throw new DecisionProtocolError("ACTION_APPROVED_SCOPE_DIGEST_MISMATCH");
  if (authority.approvedScopeDigest !== scopeDigest(authority.approvedScopeDescriptor) || !isScopeSubset(packet.scopeDescriptor, authority.approvedScopeDescriptor)) throw new DecisionProtocolError("CONTRACT_SCOPE_AUTHORITY_EXPANSION");
  if (packet.candidateActionIds.some((action) => !authority.approvedActionIds.includes(action))) throw new DecisionProtocolError("CONTRACT_ACTION_AUTHORITY_EXPANSION");
  if (packet.candidateActionIds.some((action) => authority.globalForbiddenActionIds.includes(action))) throw new DecisionProtocolError("GLOBAL_DENY_ACTION");
  const binding: ContractBindingV1 = {
    workspaceId: packet.workspaceId, taskId: packet.taskId, semanticRequestId: packet.semanticRequestId,
    requestId: packet.requestId, actionEpoch: packet.actionEpoch, activeActionId: packet.activeActionId,
    packetDigest: expectedDigest, scopeDigest: packetScopeDigest, actionDigest: packet.actionDigest,
  };
  if (
    response.workspaceId !== binding.workspaceId || response.taskId !== binding.taskId ||
    response.semanticRequestId !== binding.semanticRequestId || response.requestId !== binding.requestId ||
    response.actionEpoch !== binding.actionEpoch
  ) throw new DecisionProtocolError("DECISION_BINDING_MISMATCH");
  const requested = [...new Set(response.requestedActionIds)].sort();
  if (!requested.length || requested.some((action) => !packet.candidateActionIds.includes(action) || !authority.approvedActionIds.includes(action))) {
    throw new DecisionProtocolError("CONTRACT_ACTION_SCOPE_EXPANSION");
  }
  if (requested.some((action) => authority.globalForbiddenActionIds.includes(action))) throw new DecisionProtocolError("GLOBAL_DENY_ACTION");
  const base = {
    schemaVersion: "execution-contract-v1" as const,
    contractId: input.contractId,
    binding,
    gateKind: packet.gateKind,
    decisionResponseId: response.responseId,
    allowedActionIds: requested,
    scopeDescriptor: packet.scopeDescriptor,
    forbiddenActionIds: [...new Set([...(input.forbiddenActionIds ?? packet.forbiddenActionIds), ...authority.globalForbiddenActionIds])].sort(),
    approvedAuthority: authority,
    preconditions: mergeConstraints(response.preconditions, input.preconditions),
    acceptanceCriteria: mergeConstraints(response.acceptanceCriteria, input.acceptanceCriteria),
    stopConditions: mergeConstraints(response.stopConditions, input.stopConditions),
    createdAt: response.receivedAt,
    validUntil: packet.validUntil,
  };
  const digest = sha256(base);
  return ExecutionContractV1Schema.parse({ ...base, digest });
}

export function validateContractBinding(contract: ExecutionContractV1, expected: ContractBindingV1, now: Date): void {
  const validated = ExecutionContractV1Schema.parse(contract);
  const withoutDigest = { ...validated } as Record<string, unknown>;
  delete withoutDigest.digest;
  if (sha256(withoutDigest) !== validated.digest) throw new DecisionProtocolError("CONTRACT_DIGEST_MISMATCH");
  if (canonicalSerialize(validated.binding) !== canonicalSerialize(expected)) throw new DecisionProtocolError("CONTRACT_BINDING_MISMATCH");
  if (scopeDigest(validated.scopeDescriptor) !== validated.binding.scopeDigest) throw new DecisionProtocolError("CONTRACT_SCOPE_PACKET_EXPANSION");
  if (!validated.binding.actionDigest) throw new DecisionProtocolError("MISSING_ACTION_DIGEST_DENIED");
  if (validated.approvedAuthority.approvedScopeDigest !== scopeDigest(validated.approvedAuthority.approvedScopeDescriptor) || !isScopeSubset(validated.scopeDescriptor, validated.approvedAuthority.approvedScopeDescriptor)) {
    throw new DecisionProtocolError("CONTRACT_SCOPE_AUTHORITY_EXPANSION");
  }
  if (validated.allowedActionIds.some((action) => !validated.approvedAuthority.approvedActionIds.includes(action))) throw new DecisionProtocolError("CONTRACT_ACTION_AUTHORITY_EXPANSION");
  if (validated.allowedActionIds.some((action) => validated.approvedAuthority.globalForbiddenActionIds.includes(action))) throw new DecisionProtocolError("GLOBAL_DENY_ACTION");
  if (Date.parse(validated.validUntil) <= now.getTime()) throw new DecisionProtocolError("CONTRACT_EXPIRED");
}
