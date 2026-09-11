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

export interface ReceiptRequest {
  objectIdentity?: string;
  objectHashOrVersion?: string;
  validationType?: string;
  scope?: string;
  environment?: string;
}

export type ReceiptResolution =
  | { kind: "reused"; receipt: ReusableEvidenceReceipt }
  | { kind: "executed"; receipt: ReusableEvidenceReceipt }
  | { kind: "invalid"; reason: "MISSING_REQUIRED_FIELD" };

function isComplete(request: ReceiptRequest): request is Required<ReceiptRequest> {
  return Boolean(
    request.objectIdentity &&
      request.objectHashOrVersion &&
      request.validationType &&
      request.scope &&
      request.environment
  );
}

function matches(receipt: ReusableEvidenceReceipt, request: Required<ReceiptRequest>): boolean {
  return (
    receipt.objectIdentity === request.objectIdentity &&
    receipt.objectHashOrVersion === request.objectHashOrVersion &&
    receipt.validationType === request.validationType &&
    receipt.scope === request.scope &&
    receipt.environment === request.environment
  );
}

/** Test-only, in-memory acceptance harness. It deliberately has no C2C persistence integration. */
export class IsolatedEvidenceReceiptStore {
  private readonly receipts: ReusableEvidenceReceipt[] = [];

  validateOrReuse(
    request: ReceiptRequest,
    validate: () => { evidenceReference: string },
    timestamp: string
  ): ReceiptResolution {
    if (!isComplete(request)) return { kind: "invalid", reason: "MISSING_REQUIRED_FIELD" };
    const existing = this.receipts.find((receipt) => matches(receipt, request));
    if (existing) return { kind: "reused", receipt: existing };

    const validation = validate();
    const receipt: ReusableEvidenceReceipt = {
      ...request,
      result: "PASS",
      timestamp,
      evidenceReference: validation.evidenceReference,
    };
    this.receipts.push(receipt);
    return { kind: "executed", receipt };
  }
}
