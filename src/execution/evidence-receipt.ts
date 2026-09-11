export interface ReusableEvidenceReceipt {
  objectIdentity: string;
  objectHashOrVersion: string;
  validationType: string;
  result: "PASS";
  scope: string;
  environment: string;
  timestamp: string;
  evidenceReference: string;
}

export interface EvidenceReceiptRequest {
  objectIdentity?: string;
  objectHashOrVersion?: string;
  validationType?: string;
  scope?: string;
  environment?: string;
}

export interface EvidenceReceiptSafetyContext {
  highRisk?: boolean;
  productionValidation?: boolean;
}

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function isCompleteEvidenceReceiptRequest(request: EvidenceReceiptRequest): request is Required<EvidenceReceiptRequest> {
  return (
    hasText(request.objectIdentity) &&
    hasText(request.objectHashOrVersion) &&
    hasText(request.validationType) &&
    hasText(request.scope) &&
    hasText(request.environment)
  );
}

export function createReusableEvidenceReceipt(
  request: EvidenceReceiptRequest,
  timestamp: string,
  evidenceReference: string
): ReusableEvidenceReceipt | null {
  if (!isCompleteEvidenceReceiptRequest(request) || !hasText(evidenceReference)) return null;
  return { ...request, result: "PASS", timestamp, evidenceReference };
}

/** Exact, fail-closed reuse decision. This never performs or skips a validation. */
export function canReuseEvidenceReceipt(
  receipt: ReusableEvidenceReceipt | undefined,
  request: EvidenceReceiptRequest,
  safety: EvidenceReceiptSafetyContext = {}
): boolean {
  if (safety.highRisk || safety.productionValidation || !receipt || !isCompleteEvidenceReceiptRequest(request)) return false;
  return (
    receipt.result === "PASS" &&
    hasText(receipt.timestamp) &&
    hasText(receipt.evidenceReference) &&
    receipt.objectIdentity === request.objectIdentity &&
    receipt.objectHashOrVersion === request.objectHashOrVersion &&
    receipt.validationType === request.validationType &&
    receipt.scope === request.scope &&
    receipt.environment === request.environment
  );
}
