import { describe, expect, it } from "vitest";
import path from "node:path";
import { AuthStore, filterScopes } from "../src/auth/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("AuthStore durable multi-client state", () => {
  it("merges stale writers instead of losing either client", () => {
    const dir = makeTmpDir("auth-concurrent");
    const file = path.join(dir, "store.json");
    try {
      const writerA = new AuthStore("workspace", { file });
      const writerB = new AuthStore("workspace", { file });
      const clientA = writerA.registerClient({ clientName: "A", redirectUris: ["https://a.example/callback"] });
      const clientB = writerB.registerClient({ clientName: "B", redirectUris: ["https://b.example/callback"] });

      const restarted = new AuthStore("workspace", { file });
      expect(restarted.getClient(clientA.clientId)).toBeDefined();
      expect(restarted.getClient(clientB.clientId)).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  it("keeps another client valid across refresh and restart", () => {
    const dir = makeTmpDir("auth-refresh");
    const file = path.join(dir, "store.json");
    try {
      const store = new AuthStore("workspace", { file });
      const clientA = store.registerClient({ redirectUris: ["https://a.example/callback"] });
      const clientB = store.registerClient({ redirectUris: ["https://b.example/callback"] });
      const a = store.issueTokens({ clientId: clientA.clientId, scopes: ["workspace.read", "offline_access"] });
      const b = store.issueTokens({ clientId: clientB.clientId, scopes: ["workspace.read", "offline_access"] });
      const refresh = store.refresh(a.refreshToken!, clientA.clientId);
      expect(refresh.ok).toBe(true);
      expect(store.verifyAccessToken(b.accessToken).ok).toBe(true);

      const restarted = new AuthStore("workspace", { file });
      expect(restarted.getClient(clientA.clientId)).toBeDefined();
      expect(restarted.getClient(clientB.clientId)).toBeDefined();
      expect(restarted.verifyAccessToken(b.accessToken).ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});


describe("OAuth scope filtering safety", () => {
  it("defaults missing, empty, and whitespace-only scopes to read-only", () => {
    expect(filterScopes(undefined)).toEqual(["workspace.read"]);
    expect(filterScopes("")).toEqual(["workspace.read"]);
    expect(filterScopes("   ")).toEqual(["workspace.read"]);
  });

  it("does not expand unknown-only or mixed scope requests", () => {
    expect(filterScopes("unknown.scope")).toEqual([]);
    expect(filterScopes("workspace.read unknown.scope")).toEqual(["workspace.read"]);
  });

  it("preserves explicit read and write requests without implicit expansion", () => {
    expect(filterScopes("workspace.read")).toEqual(["workspace.read"]);
    expect(filterScopes("workspace.write")).toEqual(["workspace.write"]);
    expect(filterScopes("workspace.write workspace.read")).toEqual(["workspace.write", "workspace.read"]);
  });

  it("inherits refresh-token scopes exactly and never adds write permission", () => {
    const dir = makeTmpDir("auth-scope-refresh");
    const file = path.join(dir, "store.json");
    try {
      const store = new AuthStore("workspace", { file });
      const clientId = store.registerClient({ redirectUris: ["https://client.example/callback"] }).clientId;
      const issued = store.issueTokens({ clientId, scopes: filterScopes(undefined) });
      expect(issued.scopes).toEqual(["workspace.read"]);
      expect(issued.refreshToken).toBeNull();

      const withRefresh = store.issueTokens({ clientId, scopes: ["workspace.read", "offline_access"] });
      const refreshed = store.refresh(withRefresh.refreshToken!, clientId);
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) {
        expect(refreshed.tokens.scopes).toEqual(["workspace.read", "offline_access"]);
        expect(refreshed.tokens.scopes).not.toContain("workspace.write");
      }
    } finally {
      cleanup(dir);
    }
  });
});
