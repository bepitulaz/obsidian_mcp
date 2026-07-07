// End-to-end smoke test: launches the built server against a throwaway vault
// using the MCP SDK client, then exercises the tools and prints results.
//
//   npm run build && node scripts/smoke.mjs [vaultDir]
//
// With no vaultDir, a temp dir is created and cleaned up.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const provided = process.argv[2];
const vault = provided ?? (await mkdtemp(path.join(tmpdir(), "vault-")));

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js", vault] });
const client = new Client({ name: "smoke", version: "1.0.0" });

const show = (label, res) => {
  const flag = res.isError ? "  [isError]" : "";
  const text = (res.content ?? []).map((c) => c.text).join("\n");
  console.log(`\n## ${label}${flag}\n${text}`);
};

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  show("write_note", await client.callTool({
    name: "write_note",
    arguments: { path: "Inbox/hello.md", content: "# Hi\nfrom the smoke test\n" },
  }));
  show("read_note", await client.callTool({ name: "read_note", arguments: { path: "Inbox/hello.md" } }));
  show("append_to_note", await client.callTool({
    name: "append_to_note",
    arguments: { path: "Inbox/hello.md", text: "appended line\n" },
  }));
  show("edit_note", await client.callTool({
    name: "edit_note",
    arguments: { path: "Inbox/hello.md", oldText: "from the smoke test", newText: "from the EDITED smoke test" },
  }));
  show("read_note (after edits)", await client.callTool({ name: "read_note", arguments: { path: "Inbox/hello.md" } }));
  show("search_notes", await client.callTool({ name: "search_notes", arguments: { query: "smoke" } }));
  show("list_notes", await client.callTool({ name: "list_notes", arguments: {} }));
  show("move_note", await client.callTool({
    name: "move_note",
    arguments: { from: "Inbox/hello.md", to: "Archive/hello.md" },
  }));

  // Security: these MUST come back as errors, not succeed.
  show("read_note ../etc/passwd (should error)", await client.callTool({
    name: "read_note",
    arguments: { path: "../../../../etc/passwd" },
  }));
  show("write_note bad extension (should error)", await client.callTool({
    name: "write_note",
    arguments: { path: "evil.sh", content: "#!/bin/sh\n" },
  }));

  await client.close();
  console.log("\nOK");
} finally {
  if (!provided) await rm(vault, { recursive: true, force: true });
}
