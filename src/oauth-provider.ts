import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Thrown when the interactive passphrase login fails; surfaced as an HTML page. */
export class LoginError extends Error {}

/** One login identity: a passphrase that maps to a user id (and, in http.ts, a vault). */
export interface UserCredential {
  id: string;
  passphrase: string;
}

interface PendingLogin {
  params: AuthorizationParams;
  clientId: string;
  expiresAt: number;
}

interface AuthCode {
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  clientId: string;
  userId: string;
  expiresAt: number;
}

export interface OAuthProviderConfig {
  /** Public origin of this server, e.g. https://203-0-113-10.sslip.io */
  issuer: string;
  /** Protected-resource URL (the /mcp endpoint), used as the token audience. */
  resource: string;
  /** Login identities. Each passphrase must be unique — it is what identifies the user. */
  users: UserCredential[];
  /** HMAC secret for signing JWT access/refresh tokens. */
  jwtSecret: string;
  /** File where dynamically-registered OAuth clients are persisted. */
  clientsFile: string;
}

/**
 * A minimal, self-hosted OAuth 2.1 authorization server that supports one or
 * more users, each identified by their own passphrase.
 *
 * - Login is a passphrase, entered once in the browser during the
 *   authorization-code flow. The passphrase identifies *which* user is logging
 *   in, and the issued token carries that identity in its `sub` claim so the
 *   MCP layer can route each user to their own vault.
 * - Access and refresh tokens are stateless HS256 JWTs, so a service restart
 *   never invalidates a live session and no token database is needed.
 * - PKCE (S256) is enforced by the SDK's token handler via
 *   {@link challengeForAuthorizationCode}.
 * - Dynamic Client Registration is supported and persisted to a JSON file so a
 *   restart does not force clients to re-register.
 */
export class VaultOAuthProvider implements OAuthServerProvider {
  private readonly cfg: OAuthProviderConfig;
  private readonly secretKey: Uint8Array;
  /** userId -> sha256(passphrase), for constant-time matching. */
  private readonly userHashes: { id: string; hash: Buffer }[];
  private readonly userIds: Set<string>;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly authCodes = new Map<string, AuthCode>();

  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(cfg: OAuthProviderConfig) {
    this.cfg = cfg;
    this.secretKey = new TextEncoder().encode(cfg.jwtSecret);

    if (!cfg.users.length) throw new Error("At least one user with a passphrase is required");
    this.userIds = new Set();
    const seenPass = new Set<string>();
    for (const u of cfg.users) {
      if (!u.id) throw new Error("Every user needs a non-empty id");
      if (!u.passphrase) throw new Error(`User "${u.id}" has an empty passphrase`);
      if (this.userIds.has(u.id)) throw new Error(`Duplicate user id: ${u.id}`);
      if (seenPass.has(u.passphrase)) {
        throw new Error("Two users share the same passphrase — passphrases must be unique per user");
      }
      this.userIds.add(u.id);
      seenPass.add(u.passphrase);
    }
    this.userHashes = cfg.users.map((u) => ({ id: u.id, hash: sha256(u.passphrase) }));

    this.loadClients();

    this.clientsStore = {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        this.saveClients();
        return full;
      },
    };
  }

  // ---- authorization (interactive passphrase login) ---------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const ticket = randomUUID();
    this.pendingLogins.set(ticket, {
      params,
      clientId: client.client_id,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    res.redirect(302, `/login?ticket=${encodeURIComponent(ticket)}`);
  }

  /** HTML for the passphrase login page (served by the /login GET route). */
  renderLoginPage(ticket: string, errorMsg?: string): string {
    const safeTicket = escapeHtml(ticket);
    const err = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Obsidian Multivault MCP — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 22rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  input, button { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: .75rem; cursor: pointer; }
  .err { color: #c0392b; }
</style></head><body>
<h1>Obsidian Multivault MCP</h1>
<p>Enter your passphrase to connect Claude to your vault.</p>
${err}
<form method="post" action="/login">
  <input type="hidden" name="ticket" value="${safeTicket}">
  <input type="password" name="passphrase" placeholder="Your passphrase" autofocus autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
  }

  /**
   * Validate the submitted passphrase for a login ticket. On success, mint an
   * authorization code bound to the PKCE challenge and the matched user, and
   * return the redirect URL back to the OAuth client (Claude).
   */
  submitLogin(ticket: string, passphrase: string): { redirectTo: string } {
    const pending = this.pendingLogins.get(ticket);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingLogins.delete(ticket);
      throw new LoginError("This login session expired — please reconnect from Claude.");
    }
    const userId = this.matchUser(passphrase);
    if (!userId) {
      throw new LoginError("Incorrect passphrase.");
    }
    this.pendingLogins.delete(ticket); // single use

    const code = randomUUID();
    const { params, clientId } = pending;
    this.authCodes.set(code, {
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      clientId,
      userId,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    return { redirectTo: url.href };
  }

  // ---- token endpoint hooks (called by the SDK token handler) -----------

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.getValidCode(client, authorizationCode);
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const entry = this.getValidCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.authCodes.delete(authorizationCode); // single use
    return this.issueTokens(client.client_id, entry.userId, entry.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    let userId: string;
    let tokenScopes: string[];
    try {
      const { payload } = await jwtVerify(refreshToken, this.secretKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.resource,
      });
      if (payload.typ !== "refresh") throw new Error("not a refresh token");
      userId = String(payload.sub ?? "");
      if (!this.userIds.has(userId)) throw new Error("unknown user");
      tokenScopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];
    } catch {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const finalScopes =
      scopes && scopes.length ? scopes.filter((s) => tokenScopes.includes(s)) : tokenScopes;
    return this.issueTokens(client.client_id, userId, finalScopes);
  }

  // ---- resource-server verification (called by requireBearerAuth) -------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.resource,
      });
      if (payload.typ === "refresh") throw new Error("refresh token used as access token");
      const userId = String(payload.sub ?? "");
      if (!this.userIds.has(userId)) throw new Error("unknown user");
      return {
        token,
        clientId: String(payload.client_id ?? ""),
        scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
        expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
        resource: new URL(this.cfg.resource),
        extra: { userId },
      };
    } catch {
      throw new InvalidTokenError("Invalid or expired token");
    }
  }

  // ---- internals --------------------------------------------------------

  private getValidCode(client: OAuthClientInformationFull, code: string): AuthCode {
    const entry = this.authCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      this.authCodes.delete(code);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }
    return entry;
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const access = await new SignJWT({ client_id: clientId, scopes })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.resource)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.secretKey);

    const refresh = await new SignJWT({ client_id: clientId, scopes, typ: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.resource)
      .setIssuedAt()
      .setExpirationTime(`${REFRESH_TTL_SECONDS}s`)
      .sign(this.secretKey);

    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: scopes.join(" "),
      refresh_token: refresh,
    };
  }

  /** Return the id of the user whose passphrase matches, or null. Constant-time. */
  private matchUser(candidate: string): string | null {
    const h = sha256(candidate);
    let matched: string | null = null;
    for (const u of this.userHashes) {
      // timingSafeEqual over fixed-length hashes; iterate all, don't early-return.
      if (timingSafeEqual(h, u.hash)) matched = u.id;
    }
    return matched;
  }

  private loadClients(): void {
    try {
      const raw = readFileSync(this.cfg.clientsFile, "utf8");
      const obj = JSON.parse(raw) as Record<string, OAuthClientInformationFull>;
      for (const [id, info] of Object.entries(obj)) this.clients.set(id, info);
    } catch {
      // No clients file yet — starts empty; clients register via DCR.
    }
  }

  private saveClients(): void {
    const obj = Object.fromEntries(this.clients);
    try {
      writeFileSync(this.cfg.clientsFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error("[obsidian-multivault-mcp] failed to persist OAuth clients:", e);
    }
  }
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
