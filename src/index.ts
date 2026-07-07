import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VaultFS } from "./vault.js";
import { createMcpServer } from "./server-factory.js";
import type { HttpUser } from "./http.js";

interface Args {
  root?: string;
  readOnly: boolean;
  ext?: string[];
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { readOnly: false, http: false, port: 8787, host: "127.0.0.1" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--read-only") out.readOnly = true;
    else if (a === "--http") out.http = true;
    else if (a === "--port") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) out.port = n;
    } else if (a === "--host") {
      const h = args[++i];
      if (h) out.host = h;
    } else if (a === "--ext") {
      const parsed = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (parsed.length) out.ext = parsed;
    } else if (a.startsWith("--")) {
      // ignore unknown flags
    } else if (!out.root) {
      out.root = a;
    }
  }
  return out;
}

interface UserFileEntry {
  id: string;
  passphrase: string;
  vault: string;
  readOnly?: boolean;
  ext?: string[];
}

/**
 * Build the list of HTTP users. With MCP_USERS_FILE set, each entry is a
 * {id, passphrase, vault} — one login per person, each mapped to their own
 * vault. Otherwise falls back to a single "default" user from the CLI vault +
 * MCP_AUTH_PASSPHRASE (backward compatible).
 */
async function buildHttpUsers(args: Args): Promise<HttpUser[]> {
  const usersFile = process.env.MCP_USERS_FILE;
  if (usersFile) {
    let entries: UserFileEntry[];
    try {
      const parsed = JSON.parse(readFileSync(usersFile, "utf8"));
      entries = Array.isArray(parsed) ? parsed : parsed.users;
    } catch (e: any) {
      throw new Error(`Could not read MCP_USERS_FILE (${usersFile}): ${e?.message ?? e}`);
    }
    if (!Array.isArray(entries) || !entries.length) {
      throw new Error(`MCP_USERS_FILE (${usersFile}) must contain a non-empty list of users`);
    }
    const out: HttpUser[] = [];
    for (const e of entries) {
      if (!e.id || !e.vault) throw new Error("Each user needs an id and a vault path");
      const vault = await VaultFS.create(e.vault, { readOnly: e.readOnly, allowedExt: e.ext });
      out.push({ id: e.id, passphrase: e.passphrase, vault });
    }
    return out;
  }

  // Single-user fallback.
  if (!args.root) {
    throw new Error("HTTP mode needs a vault root argument or MCP_USERS_FILE");
  }
  const vault = await VaultFS.create(args.root, { readOnly: args.readOnly, allowedExt: args.ext });
  return [{ id: "default", passphrase: process.env.MCP_AUTH_PASSPHRASE ?? "", vault }];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.http) {
    // Remote transport for Claude's connectors (incl. mobile), behind self-hosted OAuth.
    // Imported lazily so the default stdio path never loads Express.
    const { startHttp } = await import("./http.js");
    const users = await buildHttpUsers(args);
    await startHttp(users, { port: args.port, host: args.host });
    return;
  }

  // Default: stdio transport (Claude Desktop over ssh), unchanged. Single vault.
  const { root, readOnly, ext } = args;
  if (!root) {
    console.error(
      "Usage: obsidian-multivault-mcp <vault-root> [--read-only] [--ext .md,.canvas] [--http [--port 8787] [--host 127.0.0.1]]",
    );
    process.exit(2);
  }

  const vault = await VaultFS.create(root, { readOnly, allowedExt: ext });
  const server = createMcpServer(vault);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel.
  console.error(
    `[obsidian-multivault-mcp] serving ${vault.rootPath}${readOnly ? " (read-only)" : ""}`,
  );
}

main().catch((e) => {
  console.error("[obsidian-multivault-mcp] fatal:", e);
  process.exit(1);
});
