import { spawn } from "node:child_process";
import type { VaultFS } from "./vault.js";
import path from "node:path";

export interface SearchHit {
  path: string; // vault-relative
  line: number;
  text: string;
}

/**
 * Case-insensitive literal (non-regex) full-text search over the vault.
 * Prefers ripgrep, then grep (both fast, run locally on the VPS), and falls
 * back to a pure-JS scan if neither binary is available.
 */
export async function searchNotes(
  vault: VaultFS,
  query: string,
  maxResults = 200,
): Promise<SearchHit[]> {
  const root = vault.rootPath;
  const attempts: Array<() => Promise<SearchHit[] | null>> = [
    () =>
      runGrepLike(
        "rg",
        ["--no-heading", "-n", "-F", "-i", "--color=never", "-g", "*.md", "-g", "*.markdown", "--", query, root],
        root,
        maxResults,
      ),
    () =>
      runGrepLike(
        "grep",
        ["-rniIF", "--include=*.md", "--include=*.markdown", "--", query, root],
        root,
        maxResults,
      ),
  ];
  for (const attempt of attempts) {
    const res = await attempt();
    if (res) return res;
  }
  return jsSearch(vault, query, maxResults);
}

function runGrepLike(
  bin: string,
  args: string[],
  root: string,
  max: number,
): Promise<SearchHit[] | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const done = (v: SearchHit[] | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    proc.on("error", () => done(null)); // binary missing (ENOENT)
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.on("close", (code) => {
      // grep/rg: 0 = matches, 1 = no matches, >1 = real error
      if (code !== 0 && code !== 1) return done(null);
      done(parseHits(stdout, root, max));
    });
  });
}

function parseHits(out: string, root: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const rel = path.relative(root, m[1]);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    hits.push({ path: rel, line: Number(m[2]), text: m[3] });
    if (hits.length >= max) break;
  }
  return hits;
}

async function jsSearch(vault: VaultFS, query: string, max: number): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const files = await vault.listNotes();
  const hits: SearchHit[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = await vault.readNote(rel);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: rel, line: i + 1, text: lines[i] });
        if (hits.length >= max) return hits;
      }
    }
  }
  return hits;
}
