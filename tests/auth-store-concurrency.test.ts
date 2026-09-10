import { describe, expect, it } from "vitest";
import path from "node:path";
import { AuthStore } from "../src/auth/store.js";
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
