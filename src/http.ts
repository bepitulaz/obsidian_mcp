import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type RequestHandler } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { VaultFS } from "./vault.js";
import { createMcpServer } from "./server-factory.js";
import { LoginError, VaultOAuthProvider } from "./oauth-provider.js";

/** One user of the HTTP server: a login passphrase mapped to their own vault. */
export interface HttpUser {
  id: string;
  passphrase: string;
  vault: VaultFS;
}

export interface HttpOptions {
  port: number;
  host: string;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

/**
 * Serve one or more vaults over Streamable HTTP (for Claude's remote connectors,
 * incl. the mobile app), guarded by a self-hosted OAuth 2.1 layer.
 *
 * Each user logs in with their own passphrase; the issued token carries their id
 * and every /mcp request is routed to that user's vault. With a single user this
 * is just a one-vault server.
 *
 * Auth is on by default. Set MCP_NO_AUTH=1 to disable it — for LOCAL testing
 * only; it serves the first user's vault to everyone with no login.
 */
export async function startHttp(users: HttpUser[], opts: HttpOptions): Promise<void> {
  if (!users.length) throw new Error("startHttp requires at least one user");

  const authEnabled = process.env.MCP_NO_AUTH !== "1";
  const publicUrl = (process.env.MCP_PUBLIC_URL ?? `http://${opts.host}:${opts.port}`).replace(
    /\/+$/,
    "",
  );
  const resourceUrl = `${publicUrl}/mcp`;

  const vaults = new Map(users.map((u) => [u.id, u.vault]));
  const defaultVault = users[0].vault; // used only when auth is disabled

  const app = express();
  app.disable("x-powered-by");

  app.use(
    cors({
      exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
      allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id", "MCP-Protocol-Version"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });

  let bearer: RequestHandler | undefined;

  if (authEnabled) {
    const jwtSecret = process.env.MCP_JWT_SECRET;
    if (!jwtSecret) {
      throw new Error(
        "HTTP mode requires MCP_JWT_SECRET (or set MCP_NO_AUTH=1 for local testing only).",
      );
    }
    const provider = new VaultOAuthProvider({
      issuer: publicUrl,
      resource: resourceUrl,
      users: users.map((u) => ({ id: u.id, passphrase: u.passphrase })),
      jwtSecret,
      clientsFile:
        process.env.MCP_CLIENTS_FILE ??
        path.join(path.dirname(new URL(import.meta.url).pathname), "oauth-clients.json"),
    });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(publicUrl),
        resourceServerUrl: new URL(resourceUrl),
      }),
    );

    app.get("/login", (req, res) => {
      const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
      res.type("html").send(provider.renderLoginPage(ticket));
    });
    app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
      const ticket = String(req.body.ticket ?? "");
      const passphraseInput = String(req.body.passphrase ?? "");
      try {
        const { redirectTo } = provider.submitLogin(ticket, passphraseInput);
        res.redirect(302, redirectTo);
      } catch (e) {
        const msg = e instanceof LoginError ? e.message : "Sign-in failed.";
        res.status(401).type("html").send(provider.renderLoginPage(ticket, msg));
      }
    });

    bearer = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl)),
    });
  }

  // ---- the MCP endpoint (session-managed Streamable HTTP) ----------------
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionUsers: Record<string, string> = {}; // sessionId -> userId
  const guard: RequestHandler[] = bearer ? [bearer] : [];

  // Identify the user for a request (from the verified token, or "default" without auth).
  const userIdOf = (req: express.Request): string =>
    authEnabled ? String((req.auth?.extra?.userId as string | undefined) ?? "") : "default";

  app.post("/mcp", ...guard, express.json(), async (req, res) => {
    const userId = userIdOf(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports[sid] : undefined;

    if (transport) {
      // Guard against a session id being reused with a different user's token.
      if (sessionUsers[sid!] !== userId) {
        res.status(403).json(jsonRpcError(-32000, "Session does not belong to this user"));
        return;
      }
    } else {
      if (sid) {
        res.status(404).json(jsonRpcError(-32000, "Unknown or expired session id"));
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json(jsonRpcError(-32000, "No session id and not an initialize request"));
        return;
      }
      const vault = authEnabled ? vaults.get(userId) : defaultVault;
      if (!vault) {
        res.status(403).json(jsonRpcError(-32000, `No vault configured for user "${userId}"`));
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid: string) => {
          transports[newSid] = created;
          sessionUsers[newSid] = userId;
        },
      });
      created.onclose = () => {
        if (created.sessionId) {
          delete transports[created.sessionId];
          delete sessionUsers[created.sessionId];
        }
      };
      const server = createMcpServer(vault);
      await server.connect(created);
      transport = created;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const streamOrDelete: RequestHandler = async (req, res) => {
    const userId = userIdOf(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports[sid] : undefined;
    if (!transport) {
      res.status(400).json(jsonRpcError(-32000, "Missing or unknown mcp-session-id"));
      return;
    }
    if (sessionUsers[sid!] !== userId) {
      res.status(403).json(jsonRpcError(-32000, "Session does not belong to this user"));
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", ...guard, streamOrDelete);
  app.delete("/mcp", ...guard, streamOrDelete);

  await new Promise<void>((resolve) => {
    app.listen(opts.port, opts.host, () => resolve());
  });

  const vaultList = users.map((u) => `${u.id}→${u.vault.rootPath}${u.vault.readOnly ? " (ro)" : ""}`);
  console.error(
    `[obsidian-multivault-mcp] HTTP serving on http://${opts.host}:${opts.port}/mcp` +
      ` (public ${resourceUrl}) — users: ${vaultList.join(", ")}` +
      (authEnabled ? "" : " — AUTH DISABLED"),
  );
}
