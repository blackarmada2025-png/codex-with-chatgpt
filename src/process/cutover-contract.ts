import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface AuthStoreCutoverPlan {
  source: string;
  target: string;
  backup: string | null;
  targetExisted: boolean;
  preHash: string;
  postHash: string;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Prepares a reversible AuthStore inheritance step for a future cutover.
 * It never creates an empty state file and refuses to overwrite an existing
 * target with divergent OAuth state.
 */
export function inheritAuthStoreForCutover(source: string, target: string, backupSuffix = ".pre-cutover.bak"): AuthStoreCutoverPlan {
  if (!fs.existsSync(source)) throw new Error("AUTHSTORE_SOURCE_MISSING");
  const preHash = sha256(source);
  const backup = `${target}${backupSuffix}`;
  const targetExisted = fs.existsSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (targetExisted) {
    fs.copyFileSync(target, backup);
    if (sha256(target) !== preHash) throw new Error("AUTHSTORE_TARGET_DIVERGED");
  }
  fs.copyFileSync(source, target);
  const postHash = sha256(target);
  if (postHash !== preHash) throw new Error("AUTHSTORE_HASH_VERIFY_FAILED");
  return { source, target, backup: targetExisted ? backup : null, targetExisted, preHash, postHash };
}

export function rollbackAuthStoreCutover(plan: AuthStoreCutoverPlan): void {
  if (!plan.targetExisted) {
    fs.rmSync(plan.target, { force: true });
    return;
  }
  if (!plan.backup || !fs.existsSync(plan.backup)) throw new Error("AUTHSTORE_ROLLBACK_MISSING");
  fs.copyFileSync(plan.backup, plan.target);
}
