// Verify a DEPLOYED server end-to-end, launched over ssh stdio exactly the way
// Claude Desktop does. Creates a throwaway vault on the VPS, exercises the
// tools, then removes it — the real vaults are never touched.
//
//   node scripts/smoke-remote.mjs user@host /remote/path/to/node obsidian-multivault-mcp/index.js
//
// e.g. node scripts/smoke-remote.mjs youruser@203.0.113.10 \
//        /home/youruser/.asdf/shims/node obsidian-multivault-mcp/index.js

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";

const [vps, nodeBin, serverPath] = process.argv.slice(2);
if (!vps || !nodeBin || !serverPath) {
  console.error("usage: node scripts/smoke-remote.mjs user@host /path/to/node obsidian-multivault-mcp/index.js");
  process.exit(2);
}

const tmp = `/tmp/mcp-smoke-${Date.now()}`;
const show = (label, res) =>
  console.log(`\n## ${label}${res.isError ? " [isError]" : ""}\n${(res.content ?? []).map((c) => c.text).join("\n")}`);

execFileSync("ssh", [vps, "mkdir", "-p", tmp], { stdio: "inherit" });
try {
  const transport = new StdioClientTransport({ command: "ssh", args: [vps, nodeBin, serverPath, tmp] });
  const client = new Client({ name: "smoke-remote", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  show("write_note", await client.callTool({ name: "write_note", arguments: { path: "remote-check.md", content: "# remote ok\n" } }));
  show("read_note", await client.callTool({ name: "read_note", arguments: { path: "remote-check.md" } }));
  show("search_notes", await client.callTool({ name: "search_notes", arguments: { query: "remote ok" } }));
  show("traversal (should error)", await client.callTool({ name: "read_note", arguments: { path: "../../../etc/passwd" } }));

  await client.close();
  console.log("\nOK");
} finally {
  execFileSync("ssh", [vps, "rm", "-rf", tmp], { stdio: "inherit" });
}
