import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inheritAuthStoreForCutover, rollbackAuthStoreCutover } from "../src/process/cutover-contract.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("AuthStore cutover contract", () => {
  it("inherits existing OAuth state with matching hashes", () => {
    const dir = makeTmpDir("cutover-inherit");
    const source = path.join(dir, "source.json");
    const target = path.join(dir, "target.json");
    try {
      fs.writeFileSync(source, '{"clients":["A","B"]}');
      const plan = inheritAuthStoreForCutover(source, target);
      expect(plan.preHash).toBe(plan.postHash);
      expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(source, "utf8"));
      rollbackAuthStoreCutover(plan);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it("backs up divergent target state and refuses destructive replacement", () => {
    const dir = makeTmpDir("cutover-divergent");
    const source = path.join(dir, "source.json");
    const target = path.join(dir, "target.json");
    try {
      fs.writeFileSync(source, '{"clients":["A"]}');
      fs.writeFileSync(target, '{"clients":["B"]}');
      expect(() => inheritAuthStoreForCutover(source, target)).toThrow("AUTHSTORE_TARGET_DIVERGED");
      const backup = `${target}.pre-cutover.bak`;
      expect(fs.readFileSync(backup, "utf8")).toContain("B");
      rollbackAuthStoreCutover({ source, target, backup, targetExisted: true, preHash: "", postHash: "" });
      expect(fs.readFileSync(target, "utf8")).toContain("B");
    } finally {
      cleanup(dir);
    }
  });
});
