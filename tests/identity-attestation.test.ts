import { describe, expect, it } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { buildCallerIdentityAttestation } from "../src/mcp/server.js";

const auth = (clientId: string): AuthInfo => ({
  clientId,
  scopes: ["workspace.read"],
  token: "redacted-test-token",
});

const store = (registered: Set<string>) => ({
  getClient: (clientId: string) => registered.has(clientId) ? { clientId, redirectUris: [], createdAt: "2026-01-01T00:00:00.000Z" } : undefined,
}) as never;

const bindings = (trustedClientId: string) => ({
  trustedPrincipalId: () => trustedClientId,
  trustedClientFingerprint: () => "TRUSTED-FINGERPRINT",
  trustedClientMatches: (clientId: string) => clientId === trustedClientId,
}) as never;

describe("read-only caller identity attestation", () => {
  it("reports a registered trusted caller without exposing credentials", () => {
    const result = buildCallerIdentityAttestation(auth("trusted"), store(new Set(["trusted"])), bindings("trusted"));
    expect(result).toMatchObject({ caller_registered: true, trusted_match: true, authority_status: "TRUSTED_MATCH" });
    expect(result?.caller_fingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("redacted-test-token");
  });

  it("distinguishes registered mismatch and unregistered callers", () => {
    expect(buildCallerIdentityAttestation(auth("other"), store(new Set(["other"])), bindings("trusted")))
      .toMatchObject({ caller_registered: true, trusted_match: false, authority_status: "TRUSTED_MISMATCH" });
    expect(buildCallerIdentityAttestation(auth("unknown"), store(new Set()), bindings("trusted")))
      .toMatchObject({ caller_registered: false, trusted_match: false, authority_status: "CALLER_UNREGISTERED" });
  });

  it("reports absent trusted authority and lookup failures fail-closed", () => {
    expect(buildCallerIdentityAttestation(auth("known"), store(new Set(["known"])), undefined))
      .toMatchObject({ caller_registered: true, trusted_principal_id: null, trusted_match: false, authority_status: "NO_TRUSTED_PRINCIPAL" });
    const failingStore = { getClient: () => { throw new Error("lookup failed"); } } as never;
    expect(buildCallerIdentityAttestation(auth("known"), failingStore, bindings("known")))
      .toMatchObject({ trusted_match: false, authority_status: "AUTHORITY_LOOKUP_ERROR" });
  });

  it("returns no attestation for an in-process unauthenticated call", () => {
    expect(buildCallerIdentityAttestation(undefined, undefined, undefined)).toBeUndefined();
  });
});
