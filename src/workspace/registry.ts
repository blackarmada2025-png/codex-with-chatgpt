import path from "node:path";
import { Workspace } from "./manager.js";

export type GatewayWorkspaceErrorCode =
  | "MISSING_WORKSPACE_ID"
  | "WORKSPACE_NOT_ALLOWED"
  | "WORKSPACE_ID_ROOT_MISMATCH"
  | "WORKSPACE_OUTSIDE_GATEWAY_BOUNDARY";

export class GatewayWorkspaceError extends Error {
  constructor(
    public readonly code: GatewayWorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GatewayWorkspaceError";
  }
}

export interface GatewayWorkspaceEntry {
  expectedWorkspaceId: string;
  root: string;
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Explicit, fail-closed workspace registry for an opt-in code gateway.
 * It reuses Workspace's canonical-root identity; it never accepts a root from
 * an MCP request and therefore cannot become a second identity system.
 */
export class GatewayWorkspaceRegistry {
  private readonly byId = new Map<string, GatewayWorkspaceEntry>();
  readonly boundaryRoot: string;

  constructor(codeRoot: string, entries: GatewayWorkspaceEntry[]) {
    this.boundaryRoot = new Workspace(codeRoot).root;
    for (const entry of entries) {
      if (!entry.expectedWorkspaceId || this.byId.has(entry.expectedWorkspaceId)) {
        throw new GatewayWorkspaceError("WORKSPACE_NOT_ALLOWED", "Gateway workspace registry is invalid");
      }
      const workspace = this.verifyEntry(entry);
      this.byId.set(entry.expectedWorkspaceId, { expectedWorkspaceId: workspace.id, root: workspace.root });
    }
  }

  resolve(workspaceId: unknown): Workspace {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      throw new GatewayWorkspaceError("MISSING_WORKSPACE_ID", "workspace_id is required in gateway mode");
    }
    const entry = this.byId.get(workspaceId);
    if (!entry) {
      throw new GatewayWorkspaceError("WORKSPACE_NOT_ALLOWED", "Requested workspace is not allowed by this gateway");
    }
    return this.verifyEntry(entry);
  }

  private verifyEntry(entry: GatewayWorkspaceEntry): Workspace {
    const workspace = new Workspace(entry.root);
    if (!contains(this.boundaryRoot, workspace.root)) {
      throw new GatewayWorkspaceError(
        "WORKSPACE_OUTSIDE_GATEWAY_BOUNDARY",
        "Gateway workspace root is outside the code boundary"
      );
    }
    if (workspace.id !== entry.expectedWorkspaceId) {
      throw new GatewayWorkspaceError(
        "WORKSPACE_ID_ROOT_MISMATCH",
        "Gateway workspace root no longer matches its expected workspace identity"
      );
    }
    return workspace;
  }
}
