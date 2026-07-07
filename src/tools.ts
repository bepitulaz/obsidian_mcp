import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultFS, VaultError } from "./vault.js";
import { searchNotes } from "./search.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Wrap a handler so VaultErrors become clean, client-visible tool errors. */
const wrap =
  (fn: (args: any) => Promise<ToolResult>) =>
  async (args: any): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e: any) {
      if (e instanceof VaultError) return fail(`Error: ${e.message}`);
      return fail(`Unexpected error: ${e?.message ?? String(e)}`);
    }
  };

export function registerTools(server: McpServer, vault: VaultFS): void {
  // ---- read tools -------------------------------------------------------
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes (markdown/canvas files) in the vault recursively, as vault-relative paths. Optionally limit to a subfolder.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Vault-relative subfolder to list; omit for the whole vault"),
      },
    },
    wrap(async ({ folder }) => {
      const notes = await vault.listNotes(folder ?? "");
      return ok(notes.length ? notes.join("\n") : "(no notes found)");
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the full contents of a note by its vault-relative path.",
      inputSchema: {
        path: z.string().describe("Vault-relative path, e.g. 'Founder Path/Strategy.md'"),
      },
    },
    wrap(async ({ path: p }) => ok(await vault.readNote(p))),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive literal full-text search across the vault. Returns 'path:line: text' hits.",
      inputSchema: {
        query: z.string().describe("Text to search for (literal, not a regex)"),
        max_results: z.number().int().positive().max(2000).optional(),
      },
    },
    wrap(async ({ query, max_results }) => {
      const hits = await searchNotes(vault, query, max_results ?? 200);
      if (!hits.length) return ok(`No matches for "${query}"`);
      return ok(hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`).join("\n"));
    }),
  );

  // ---- write tools (skipped entirely in read-only mode) -----------------
  if (vault.readOnly) return;

  server.registerTool(
    "write_note",
    {
      title: "Write note",
      description:
        "Create or overwrite a note with the given content. Creates parent folders as needed.",
      inputSchema: { path: z.string(), content: z.string() },
    },
    wrap(async ({ path: p, content }) => {
      await vault.writeNote(p, content);
      return ok(`Wrote ${p}`);
    }),
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Create a new note. Fails if a note already exists at that path.",
      inputSchema: { path: z.string(), content: z.string() },
    },
    wrap(async ({ path: p, content }) => {
      await vault.createNote(p, content);
      return ok(`Created ${p}`);
    }),
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description: "Append text to the end of a note (creating it if missing).",
      inputSchema: { path: z.string(), text: z.string() },
    },
    wrap(async ({ path: p, text: t }) => {
      await vault.appendNote(p, t);
      return ok(`Appended to ${p}`);
    }),
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Replace an exact snippet in a note. oldText must appear exactly once — include enough surrounding context to be unique.",
      inputSchema: { path: z.string(), oldText: z.string(), newText: z.string() },
    },
    wrap(async ({ path: p, oldText, newText }) => {
      await vault.editNote(p, oldText, newText);
      return ok(`Edited ${p}`);
    }),
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete a note by its vault-relative path.",
      inputSchema: { path: z.string() },
    },
    wrap(async ({ path: p }) => {
      await vault.deleteNote(p);
      return ok(`Deleted ${p}`);
    }),
  );

  server.registerTool(
    "move_note",
    {
      title: "Move or rename note",
      description: "Move or rename a note from one vault-relative path to another.",
      inputSchema: { from: z.string(), to: z.string() },
    },
    wrap(async ({ from, to }) => {
      await vault.moveNote(from, to);
      return ok(`Moved ${from} → ${to}`);
    }),
  );
}
