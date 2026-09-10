import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir, cleanup } from "./helpers.js";
import { inheritAuthStoreForCutover, rollbackAuthStoreCutover } from "../src/process/cutover-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("formal persistent state contract", () => {
  it("keeps one AuthStore through deployment and rollback copies", () => {
    const dir = makeTmpDir("formal-state");
    const source = path.join(dir, "legacy-auth.json");
    const target = path.join(dir, "state", "auth", "workspace.json");
    try {
      fs.writeFileSync(source, '{"clients":["a","b"],"tokens":["1","2","3"]}');
      const plan = inheritAuthStoreForCutover(source, target);
      expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(source, "utf8"));
      rollbackAuthStoreCutover(plan);
      expect(fs.existsSync(target)).toBe(false);
    } finally { cleanup(dir); }
  });

  it("binds installer and watchdog to an explicit C2C state directory", () => {
    const installer = fs.readFileSync(path.join(root, "scripts", "install-production-watchdog.ps1"), "utf8");
    const watchdog = fs.readFileSync(path.join(root, "ops", "watchdog", "c2c-production-watchdog.ps1"), "utf8");
    expect(installer).toContain("c2cStateDir");
    expect(watchdog).toContain("C2C_STATE_DIR");
  });
});
