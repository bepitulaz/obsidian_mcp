# obsidian-multivault-mcp

An MCP server that gives **Claude read/write access to Obsidian vaults that live on a VPS** — built
for **multiple vaults and multiple users** from a single deployment. Everyone shares one server; each
person is routed to their **own private vault** by the passphrase they log in with (HTTP mode) or by
the vault path Claude Desktop launches with (stdio mode). The server runs *on the VPS* with direct
filesystem access to the vaults.

## Features

- **Multi-vault, multi-user** — one server serves many people, each mapped to their own vault. In HTTP
  mode everyone adds the *same* connector URL and their distinct login passphrase decides which vault
  they get; in stdio mode each Claude Desktop passes its own vault path.
- **Two transports from one codebase** — stdio over `ssh` (Claude Desktop) and an OAuth-protected
  Streamable HTTP endpoint (Claude mobile/web/desktop remote connectors).
- **Read/write tools with strict path safety** — vault-relative paths only; `..`, absolute paths,
  symlink escapes, and null bytes are rejected; writes limited to an extension allowlist. Optional
  `--read-only` and per-user `readOnly`.
- **Self-hosted OAuth 2.1** — passphrase login, PKCE, JWT access tokens, and Dynamic Client
  Registration, so no third-party auth service is needed.
- **Single-file deploy** — esbuild bundles everything to one `dist/index.js`; deploy is a one-file copy.

There is no SSH library inside the server — SSH is only the transport Claude Desktop uses to start it
and exchange JSON-RPC. Part of a "centralise the vaults on the VPS" setup:

```
  Mac                                            VPS (always-on)
  ┌ Obsidian app ──(obsidian-remote-ssh plugin)── SSH ─▶ Go daemon ─┐
  │                                                                 ├─▶  a user's vault
  └ Claude Desktop ─(ssh stdio → node index.js)── SSH ─▶ THIS server┘        ▲
                                                                     Hermes agent (direct fs)
```

## Tools

Read: `list_notes`, `read_note`, `search_notes`.
Write (disabled with `--read-only`): `write_note`, `create_note`, `append_to_note`, `edit_note`,
`delete_note`, `move_note`.

All paths are **vault-relative** and confined to the vault root — `..`, absolute paths, symlink
escapes, and null bytes are rejected; writes/deletes/moves are restricted to allowed extensions
(`.md`, `.markdown`, `.canvas`, `.txt` by default; override with `--ext`).

## Build & test locally

```bash
npm install
npm run build            # bundles to dist/index.js (single file)
npm run smoke            # spins up the server against a temp vault and exercises every tool
npm run typecheck        # optional: tsc --noEmit
```

You can also drive it interactively with the MCP Inspector:

```bash
npm run inspect -- /absolute/path/to/a/vault
```

## Deploy to the VPS

Requires **Node 20+** on the VPS.

```bash
VPS=user@your-vps DEST=obsidian-multivault-mcp ./scripts/deploy.sh
# copies dist/index.js to  ~/obsidian-multivault-mcp/index.js  on the VPS
```

Smoke-test the remote copy from your Mac (should print a startup line on stderr, then wait):

```bash
ssh user@your-vps node obsidian-multivault-mcp/index.js /absolute/path/to/vault
# Ctrl-C to stop
```

## Wire up Claude Desktop (per Mac)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-multivault": {
      "command": "ssh",
      "args": [
        "youruser@your-vps",
        "node",
        "/home/youruser/obsidian-multivault-mcp/index.js",
        "/home/youruser/alice-vault"
      ]
    }
  }
}
```

Restart Claude Desktop. A second Mac (different vault on the same VPS) uses the same block with that
Mac's vault path as the last argument.

Notes:
- `ssh` must authenticate **non-interactively** (key auth, no passphrase prompt) — test with
  `ssh user@your-vps true`.
- Add `"--read-only"` as a final arg to expose only the read tools.
- Config is passed as CLI args, not `env`, because `ssh` does not forward environment variables by
  default.

## CLI

```
node index.js <vault-root> [--read-only] [--ext .md,.canvas] [--http [--port 8787] [--host 127.0.0.1]]
```

Default (no `--http`): stdio transport, launched over ssh by Claude Desktop (above).
With `--http`: a long-lived HTTP server for Claude's **remote connectors**, including the
**mobile app** (see below).

---

# Reach it from the Claude mobile app (remote connector)

The mobile app can't use ssh. Like claude.ai / Desktop / Cowork, it connects to *remote* MCP
servers from **Anthropic's cloud**, over **Streamable HTTP** to a **public HTTPS URL**. So the same
server also runs an HTTP transport (`--http`) fronted by a self-hosted **OAuth 2.1** layer — the ssh
key gate is gone once it's public, so a login gate replaces it.

```
Claude mobile ──HTTPS──▶ Caddy (:443, auto Let's Encrypt)  ─▶  node index.js --http (127.0.0.1:8787)
                          203-0-113-10.sslip.io                 ├ OAuth 2.1 (passphrase login, PKCE, JWT)
                                                                  └ /mcp  (guarded by bearer JWT)  ─▶ vault
```

The stdio/ssh path for Claude Desktop is unchanged and runs independently.

## HTTP-mode configuration (env vars)

`--http` reads these from the environment:

| Var | Required | Meaning |
|---|---|---|
| `MCP_PUBLIC_URL` | yes | Public origin, e.g. `https://203-0-113-10.sslip.io`. Used as the OAuth issuer/audience. |
| `MCP_JWT_SECRET` | yes | 32+ random bytes used to sign access/refresh tokens. Rotating it revokes all tokens. |
| `MCP_USERS_FILE` | one of | Per-user `{id, passphrase, vault}` map (see below) — for multiple people/vaults. |
| `MCP_AUTH_PASSPHRASE` | one of | Single-user shortcut: the login passphrase for the one vault given as the CLI arg. Use this **or** `MCP_USERS_FILE`. |
| `MCP_CLIENTS_FILE` | no | Where DCR client registrations persist (default: next to `index.js`). |
| `MCP_NO_AUTH` | no | Set to `1` to disable auth — **local testing only**, never public. |

### Multiple people, multiple vaults

Point `MCP_USERS_FILE` at a JSON file with one entry per person — each **distinct** passphrase maps
to that person's own vault. Everyone adds the **same** connector URL in their own Claude account; the
passphrase they log in with is what routes them to the right vault. See
[`users.example.json`](users.example.json).

```json
{
  "users": [
    { "id": "alice", "passphrase": "a-long-passphrase",           "vault": "/home/youruser/alice-vault" },
    { "id": "bob",   "passphrase": "a-DIFFERENT-long-passphrase", "vault": "/home/youruser/bob-vault", "readOnly": false }
  ]
}
```

In this mode the CLI vault argument is not needed (`node dist/index.js --http`). Optional per-user
keys: `readOnly` and `ext`.

## Test HTTP mode locally

```bash
npm run build
npm run smoke:http           # spins up two servers: tools-over-HTTP + full OAuth handshake

# Or drive it by hand (auth disabled) with the MCP Inspector:
MCP_NO_AUTH=1 node dist/index.js /path/to/vault --http --port 8787
#   → point the Inspector (Streamable HTTP) at http://localhost:8787/mcp
```

## Deploy to a public HTTPS endpoint (VPS)

**See [`DEPLOY.md`](DEPLOY.md) for the full, copy-pasteable runbook** — installing Caddy, the
`/etc/obsidian-multivault-mcp.env` secrets, the systemd unit, the Caddyfile, firewall, verification, and
troubleshooting. It's written so an agent with shell access on the VPS can follow it end to end.

In short: `sslip.io` gives an HTTPS-capable hostname for the bare IP with no domain purchase
(`203-0-113-10.sslip.io` → `203.0.113.10`); Caddy terminates TLS on 443 and reverse-proxies to the
Node service on `127.0.0.1:8787`; the service runs under systemd reading its secrets from
`/etc/obsidian-multivault-mcp.env`. Requires **Node 20+** and **ports 80 + 443 open**.

## Add it in the Claude mobile app

Settings → **Connectors** → **Add custom connector** → paste
`https://203-0-113-10.sslip.io/mcp` → leave Advanced settings (Client ID/Secret) **blank** (the
server supports Dynamic Client Registration) → **Add**. When prompted, complete the browser login
with **your own passphrase**. All tools then appear. Each person adds the same URL in their own
Claude account and logs in with their own passphrase to reach their own vault.

## Security notes (the public surface is read + write)

- The passphrase and JWT secret live only in the mode-600 `EnvironmentFile`. Use a strong passphrase.
- Access tokens are short-lived (1h) JWTs; rotate `MCP_JWT_SECRET` to revoke everything immediately.
- Run `--read-only` in the systemd unit if you don't need mobile writes — it shrinks the blast radius.
- Keep the Node service bound to `127.0.0.1`; only Caddy faces the internet, over HTTPS.
