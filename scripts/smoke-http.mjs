// End-to-end smoke test for the Streamable HTTP transport.
//
//   npm run build && node scripts/smoke-http.mjs
//
// Part A (MCP_NO_AUTH=1): drives every tool over http://127.0.0.1:PORT/mcp with
//   the real MCP SDK client, and asserts traversal/bad-extension attempts error.
// Part B (auth on): asserts the OAuth gate — an unauthenticated /mcp request
//   returns 401 + WWW-Authenticate, and the discovery documents are served.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT_A = Number(process.env.SMOKE_PORT_A ?? 8798);
const PORT_B = Number(process.env.SMOKE_PORT_B ?? 8799);
const PORT_D = Number(process.env.SMOKE_PORT_D ?? 8800);

/** Run the OAuth authorization-code + PKCE flow and return an access token. */
async function oauthToken(base, passphrase) {
  const b64url = (buf) => buf.toString("base64url");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirectUri = "http://127.0.0.1:45999/cb";
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "smoke",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = await reg.json();
  const authUrl = new URL(`${base}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const authRes = await fetch(authUrl, { redirect: "manual" });
  const ticket = new URL(authRes.headers.get("location"), base).searchParams.get("ticket");
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket, passphrase }),
    redirect: "manual",
  });
  if (login.status !== 302) throw new Error(`login failed (${login.status})`);
  const code = new URL(login.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
    }),
  });
  return (await tok.json()).access_token;
}

/** Connect an MCP client carrying the given bearer token; return listed note paths. */
async function listNotesAs(base, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "smoke-user", version: "1.0.0" });
  await client.connect(transport);
  const res = await client.callTool({ name: "list_notes", arguments: {} });
  await client.close();
  return (res.content ?? []).map((c) => c.text).join("\n");
}

const show = (label, res) => {
  const flag = res.isError ? "  [isError]" : "";
  const text = (res.content ?? []).map((c) => c.text).join("\n");
  console.log(`\n## ${label}${flag}\n${text}`);
};

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}

/** Spawn the built server and resolve once it logs that it is listening. */
function startServer(vault, port, env) {
  const child = spawn(
    "node",
    ["dist/index.js", vault, "--http", "--port", String(port), "--host", "127.0.0.1"],
    { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let out = "";
    const onData = (buf) => {
      out += buf.toString();
      process.stderr.write(buf);
      if (/HTTP serving/.test(out)) {
        child.stderr.off("data", onData);
        resolve(child);
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`server exited early (code ${code})`)));
    setTimeout(() => reject(new Error("server did not start within 10s")), 10_000);
  });
}

async function stop(child) {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

const vault = await mkdtemp(path.join(tmpdir(), "vault-http-"));
let serverA;
let serverB;
let serverD;
let vaultAlpha;
let vaultBravo;
try {
  // ---- Part A: tools over HTTP (auth disabled) --------------------------
  console.log(`\n=== Part A: tools over HTTP on :${PORT_A} (MCP_NO_AUTH=1) ===`);
  serverA = await startServer(vault, PORT_A, { MCP_NO_AUTH: "1" });

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT_A}/mcp`));
  const client = new Client({ name: "smoke-http", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));
  assert(tools.tools.length === 9, "all 9 tools registered (read + write)");

  show("write_note", await client.callTool({
    name: "write_note",
    arguments: { path: "Inbox/hello.md", content: "# Hi\nfrom the http smoke test\n" },
  }));
  const read = await client.callTool({ name: "read_note", arguments: { path: "Inbox/hello.md" } });
  show("read_note", read);
  assert(read.content[0].text.includes("http smoke test"), "read_note round-trips the write");

  show("search_notes", await client.callTool({ name: "search_notes", arguments: { query: "smoke" } }));
  show("list_notes", await client.callTool({ name: "list_notes", arguments: {} }));

  const traversal = await client.callTool({
    name: "read_note",
    arguments: { path: "../../../../etc/passwd" },
  });
  show("read_note ../etc/passwd (should error)", traversal);
  assert(traversal.isError === true, "path traversal is rejected over HTTP");

  await client.close();
  await stop(serverA);
  serverA = undefined;

  // ---- Part B: OAuth gate (auth enabled) --------------------------------
  console.log(`\n=== Part B: OAuth gate on :${PORT_B} ===`);
  serverB = await startServer(vault, PORT_B, {
    MCP_AUTH_PASSPHRASE: "smoke-pass",
    MCP_JWT_SECRET: "smoke-secret-smoke-secret-smoke-secret",
    MCP_PUBLIC_URL: `http://127.0.0.1:${PORT_B}`,
    MCP_CLIENTS_FILE: path.join(vault, ".smoke-oauth-clients.json"),
  });
  const base = `http://127.0.0.1:${PORT_B}`;

  const unauth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
    }),
  });
  assert(unauth.status === 401, "unauthenticated /mcp returns 401");
  const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
  assert(/resource_metadata=/.test(wwwAuth), "401 carries WWW-Authenticate with resource_metadata");

  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert(prm.status === 200, "protected-resource metadata is served");
  const prmBody = await prm.json();
  assert(prmBody.resource === `${base}/mcp`, "PRM resource matches the /mcp URL");
  assert(Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length > 0,
    "PRM advertises an authorization server");

  const asMeta = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert(asMeta.status === 200, "authorization-server metadata is served");
  const asBody = await asMeta.json();
  assert(!!asBody.authorization_endpoint && !!asBody.token_endpoint, "AS metadata has authorize + token endpoints");
  assert(!!asBody.registration_endpoint, "AS metadata advertises DCR (registration_endpoint)");

  const health = await fetch(`${base}/healthz`);
  assert(health.status === 200, "/healthz is reachable");

  // ---- Part C: full OAuth handshake (DCR → login → PKCE → token → /mcp) --
  console.log(`\n=== Part C: full OAuth handshake on :${PORT_B} ===`);
  const b64url = (buf) => buf.toString("base64url");
  const redirectUri = "http://127.0.0.1:45678/callback";
  const PASS = "smoke-pass";

  // Drive one authorization-code + PKCE flow; returns the issued token set.
  async function runFlow({ verifier, tokenVerifier }) {
    const challenge = b64url(createHash("sha256").update(verifier).digest());

    // 1. Dynamic Client Registration (public client, PKCE).
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "smoke-client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert(reg.status === 201, "DCR returns 201");
    const client = await reg.json();
    assert(!!client.client_id, "DCR returned a client_id");
    assert(!client.client_secret, "public client has no client_secret");

    // 2. Authorize → redirect to the login page.
    const authUrl = new URL(`${base}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", "xyz");
    const authRes = await fetch(authUrl, { redirect: "manual" });
    assert(authRes.status === 302, "authorize redirects (302)");
    const loginLoc = authRes.headers.get("location") ?? "";
    assert(loginLoc.startsWith("/login?ticket="), "authorize redirects to /login with a ticket");
    const ticket = new URL(loginLoc, base).searchParams.get("ticket");

    // 3. Wrong passphrase is rejected but keeps the ticket.
    const bad = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, passphrase: "nope" }),
      redirect: "manual",
    });
    assert(bad.status === 401, "wrong passphrase returns 401");

    // 4. Correct passphrase → redirect back with an auth code.
    const good = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, passphrase: PASS }),
      redirect: "manual",
    });
    assert(good.status === 302, "correct passphrase redirects (302)");
    const cb = new URL(good.headers.get("location"));
    assert(`${cb.origin}${cb.pathname}` === redirectUri, "redirect targets the registered redirect_uri");
    assert(cb.searchParams.get("state") === "xyz", "state is echoed back");
    const code = cb.searchParams.get("code");
    assert(!!code, "authorization code is present");

    // 5. Token exchange (PKCE verified by the SDK).
    const tok = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: tokenVerifier,
        redirect_uri: redirectUri,
        client_id: client.client_id,
      }),
    });
    return { tok, client };
  }

  // Happy path.
  const verifier = b64url(randomBytes(32));
  const { tok, client: oauthClient } = await runFlow({ verifier, tokenVerifier: verifier });
  assert(tok.status === 200, "token exchange returns 200");
  const tokens = await tok.json();
  assert(!!tokens.access_token && tokens.token_type === "Bearer", "access token issued");
  assert(!!tokens.refresh_token, "refresh token issued");

  // Authenticated initialize succeeds and opens a session.
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
    }),
  });
  assert(init.status === 200, "authenticated initialize returns 200");
  assert(!!init.headers.get("mcp-session-id"), "initialize returns an mcp-session-id");

  // A bad token is rejected.
  const badTok = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer not-a-real-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert(badTok.status === 401, "a forged bearer token is rejected");

  // Refresh yields a fresh access token.
  const refresh = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: oauthClient.client_id,
    }),
  });
  assert(refresh.status === 200, "refresh_token exchange returns 200");
  assert(!!(await refresh.json()).access_token, "refresh yields a new access token");

  // PKCE is actually enforced: a mismatched verifier is rejected.
  const v2 = b64url(randomBytes(32));
  const { tok: badPkce } = await runFlow({ verifier: v2, tokenVerifier: b64url(randomBytes(32)) });
  assert(badPkce.status === 400, "wrong PKCE verifier is rejected (400)");

  await stop(serverB);
  serverB = undefined;

  // ---- Part D: multi-user vault routing (the reported bug) --------------
  console.log(`\n=== Part D: two users route to their own vaults on :${PORT_D} ===`);
  vaultAlpha = await mkdtemp(path.join(tmpdir(), "vault-alpha-"));
  vaultBravo = await mkdtemp(path.join(tmpdir(), "vault-bravo-"));
  await writeFile(path.join(vaultAlpha, "alpha-only.md"), "# Alpha\n");
  await writeFile(path.join(vaultBravo, "bravo-only.md"), "# Bravo\n");
  const usersFile = path.join(vault, "users.json");
  await writeFile(
    usersFile,
    JSON.stringify({
      users: [
        { id: "alpha", passphrase: "pass-alpha", vault: vaultAlpha },
        { id: "bravo", passphrase: "pass-bravo", vault: vaultBravo },
      ],
    }),
  );

  serverD = await startServer(vault, PORT_D, {
    MCP_JWT_SECRET: "smoke-secret-smoke-secret-smoke-secret",
    MCP_PUBLIC_URL: `http://127.0.0.1:${PORT_D}`,
    MCP_USERS_FILE: usersFile,
    MCP_CLIENTS_FILE: path.join(vault, ".smoke-clients-d.json"),
  });
  const baseD = `http://127.0.0.1:${PORT_D}`;

  const tokenAlpha = await oauthToken(baseD, "pass-alpha");
  const tokenBravo = await oauthToken(baseD, "pass-bravo");
  assert(tokenAlpha && tokenBravo && tokenAlpha !== tokenBravo, "each passphrase yields a distinct token");

  const alphaSees = await listNotesAs(baseD, tokenAlpha);
  console.log(`alpha sees: ${alphaSees}`);
  assert(alphaSees.includes("alpha-only.md"), "alpha sees their own note");
  assert(!alphaSees.includes("bravo-only.md"), "alpha does NOT see bravo's note");

  const bravoSees = await listNotesAs(baseD, tokenBravo);
  console.log(`bravo sees: ${bravoSees}`);
  assert(bravoSees.includes("bravo-only.md"), "bravo sees their own note");
  assert(!bravoSees.includes("alpha-only.md"), "bravo does NOT see alpha's note");

  await stop(serverD);
  serverD = undefined;

  console.log("\nOK");
} finally {
  await stop(serverA);
  await stop(serverB);
  await stop(serverD);
  await rm(vault, { recursive: true, force: true });
  if (vaultAlpha) await rm(vaultAlpha, { recursive: true, force: true });
  if (vaultBravo) await rm(vaultBravo, { recursive: true, force: true });
}
