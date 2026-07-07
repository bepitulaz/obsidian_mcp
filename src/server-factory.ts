import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultFS } from "./vault.js";
import { registerTools } from "./tools.js";

/**
 * Build a fresh McpServer bound to the given vault.
 *
 * The stdio path calls this once. The HTTP path calls it once per session —
 * each Streamable-HTTP session needs its own McpServer (a server binds a single
 * transport), while the underlying VaultFS is stateless and shared across all.
 */
export function createMcpServer(vault: VaultFS): McpServer {
  const server = new McpServer({ name: "obsidian-multivault", version: "1.0.0" });
  registerTools(server, vault);
  return server;
}
