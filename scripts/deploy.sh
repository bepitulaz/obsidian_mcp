#!/usr/bin/env bash
set -euo pipefail

# Build the bundled server and copy the single dist/index.js to the VPS.
#
# Usage:
#   VPS=user@host [DEST=obsidian-multivault-mcp] [NODE_BIN=node] ./scripts/deploy.sh
#
# DEST     remote dir, relative to the remote home (default: obsidian-multivault-mcp).
# NODE_BIN path to node ON THE VPS. Default "node" assumes node is on the
#          non-interactive SSH PATH; if node is under a version manager
#          (asdf/nvm), set the absolute shim, e.g.
#          NODE_BIN=/home/youruser/.asdf/shims/node

VPS="${VPS:?set VPS=user@host}"
DEST="${DEST:-obsidian-multivault-mcp}"
NODE_BIN="${NODE_BIN:-node}"

cd "$(dirname "$0")/.."
npm run build

ssh "$VPS" "mkdir -p \"$DEST\""
scp dist/index.js "$VPS:$DEST/index.js"

# If the HTTP service (for Claude mobile) is installed on the VPS, restart it so
# it picks up the new bundle. No-op on stdio-only hosts (see README for the
# one-time systemd + Caddy bootstrap).
ssh "$VPS" 'sudo systemctl restart obsidian-multivault-mcp 2>/dev/null && echo "restarted obsidian-multivault-mcp service" || true'

echo
echo "Deployed to $VPS:$DEST/index.js"
echo "Smoke-test on the VPS:  ssh $VPS $NODE_BIN \"$DEST/index.js\" /absolute/path/to/vault"
echo "Claude Desktop command:  ssh $VPS $NODE_BIN $DEST/index.js /absolute/path/to/vault"
