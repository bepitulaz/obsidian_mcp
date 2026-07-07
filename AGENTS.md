# AGENTS.md — deploying this MCP server on the VPS

**Mission:** deploy this repository as the public, OAuth-protected **HTTPS MCP server** so Claude's
remote connectors (mobile + desktop + web) can reach the Obsidian vaults on this VPS.

The authoritative, copy-pasteable, step-by-step runbook is **[DEPLOY.md](DEPLOY.md) — follow it
exactly.** This file is the brief around it: the goal, the inputs to gather first, the guardrails,
and how to know you're done. When the two disagree, DEPLOY.md's commands win.

Do **not** touch the existing stdio-over-SSH path (used by Claude Desktop today). The HTTP service is
**additive** and runs independently as its own systemd unit.

## VPS facts (example — change to match yours)

| | |
|---|---|
| Run user | `youruser` |
| App / repo dir | `/home/youruser/obsidian-multivault-mcp` |
| Public hostname | `203-0-113-10.sslip.io` → `203.0.113.10` (sslip.io — no domain needed) |
| Local port | `8787` (Node binds `127.0.0.1` only; Caddy fronts `:443`) |
| Node | via asdf — resolve the concrete path with `asdf which node` |

Two people, each with **their own login passphrase mapped to their own vault** (this is what fixes
both landing on the same vault). Passphrases **must be distinct**:

| id | vault |
|---|---|
| `alice` | `/home/youruser/alice-vault` |
| `bob` | `/home/youruser/bob-vault` |

## Gather BEFORE you start

1. **Two strong, DISTINCT passphrases** — one for `alice`, one for `bob`
   (e.g. `openssl rand -base64 24` each). Record which is whose to report back to the human. They go
   **only** in `/etc/obsidian-multivault-mcp-users.json` (mode 600) — never in the repo.
2. **Confirm both vault paths exist:** `ls -d /home/youruser/alice-vault /home/youruser/bob-vault`.
   If either differs, stop and ask the human; adjust the users file to the real paths.
3. **Repo clone auth:** if this GitHub repo is private, set up a deploy key or token before cloning.
4. **Inbound ports 80 and 443 open** (host `ufw` **and** any cloud-provider firewall) — Let's Encrypt
   needs both.

## Do (high level — exact commands in DEPLOY.md)

1. Clone + `npm ci` + `npm run build`; optionally `npm run smoke:http` to self-verify locally.
2. Write `/etc/obsidian-multivault-mcp.env` (600): `MCP_PUBLIC_URL`, `MCP_JWT_SECRET` (`openssl rand -hex 32`),
   `MCP_CLIENTS_FILE`, `MCP_USERS_FILE`.
3. Write `/etc/obsidian-multivault-mcp-users.json` (600): the two users above, each with their passphrase.
4. Install the systemd unit — `ExecStart` uses the concrete node path and **no vault argument**;
   `ReadWritePaths` lists **both** vaults **and** the app dir. `systemctl enable --now obsidian-multivault-mcp`.
5. Install Caddy; write `/etc/caddy/Caddyfile` for `203-0-113-10.sslip.io` → `127.0.0.1:8787`; reload.
6. Open the firewall for 80/443 if `ufw` is active.

## Definition of done (verify — do not assume)

- **Local:** `systemctl is-active obsidian-multivault-mcp caddy` → both `active`;
  `curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/healthz` → `200`.
- **Public:** `curl -i https://203-0-113-10.sslip.io/healthz` → `200 ok`; and
  ```
  curl -i -X POST https://203-0-113-10.sslip.io/mcp \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  ```
  → **`401`** with a `WWW-Authenticate: Bearer ... resource_metadata="..."` header.
- **Report back to the human:** the public URL and each person's passphrase (over a secure channel),
  so `alice` and `bob` can each add the connector in their own Claude account.

## Guardrails

- **Never commit secrets.** `/etc/obsidian-multivault-mcp.env` and `/etc/obsidian-multivault-mcp-users.json` live outside
  the repo, mode 600. (`.gitignore` already blocks `*.env` and `oauth-clients.json`.)
- **Never run the public server without auth** — do not set `MCP_NO_AUTH=1` in production. The vaults
  are read + write.
- **Passphrases must be distinct per user.** The server refuses to start on duplicates, and identical
  passphrases would send both people to the same vault — the exact bug this setup avoids.
- **Node binds `127.0.0.1` only**; Caddy is the sole public listener, always over HTTPS.
- **Do not modify the stdio/SSH path.** The HTTP unit is separate and additive.
- If a step fails, consult the **Troubleshooting** table in DEPLOY.md before improvising. A common one:
  the asdf shim fails under systemd → use the concrete `asdf which node` path in `ExecStart`.

## Updating later

```bash
cd ~/obsidian-multivault-mcp && git pull && npm ci && npm run build && sudo systemctl restart obsidian-multivault-mcp
```
Caddy and the env/users files are one-time setup; only reload Caddy if you change the Caddyfile.
