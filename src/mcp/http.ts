import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger/index.js";

// ChatGPT Connector compatibility alias. This is an inbound transport alias,
// not an MCP canonical tool name and must never be included in tools/list.
const CONNECTOR_TOOL_NAMESPACE = "orbnexa_c2c_dev_test";
const CANONICAL_TOOL_NAMES = new Set([
  "workspace_info",
  "git_status",
  "git_diff",
  "search_workspace",
  "read_file",
  "list_directory",
  "test_status",
  "execution_summary",
  "execution_output",
]);

export function normalizeConnectorToolName(name: unknown): unknown {
  if (typeof name !== "string" || CANONICAL_TOOL_NAMES.has(name)) return name;
  const prefix = `${CONNECTOR_TOOL_NAMESPACE}.`;
  if (!name.startsWith(prefix)) return name;
  const suffix = name.slice(prefix.length);
  return CANONICAL_TOOL_NAMES.has(suffix) ? suffix : name;
}

function normalizeInboundToolCall(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || typeof request.params !== "object" || request.params === null) return;
  const params = request.params as { name?: unknown };
  params.name = normalizeConnectorToolName(params.name);
}

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST.
 * This maximizes compatibility with remote MCP clients (including ChatGPT)
 * and avoids cross-request session state on a public endpoint.
 */
export function createMcpHttpHandler(
  makeServer: () => McpServer,
  logger: Logger,
  options: { connectorToolNameCompatibility?: boolean } = {}
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless mode: no server-initiated streams, no sessions to delete.
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
      return;
    }
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      if (options.connectorToolNameCompatibility) normalizeInboundToolCall(req.body);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request handling failed", { message: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
