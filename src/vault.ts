import { promises as fs } from "node:fs";
import path from "node:path";

/** Error type whose message is safe to surface to the MCP client. */
export class VaultError extends Error {}

const DEFAULT_EXT = [".md", ".markdown", ".canvas", ".txt"];

/**
 * Filesystem access to an Obsidian vault, confined to a single root directory.
 * Every path a caller supplies is treated as vault-relative and validated so it
 * can never escape the root — including via `..`, absolute paths, or symlinks.
 */
export class VaultFS {
  private readonly root: string; // canonical, symlink-resolved absolute path
  readonly readOnly: boolean;
  private readonly allowedExt: Set<string>;

  private constructor(root: string, readOnly: boolean, allowedExt: string[]) {
    this.root = root;
    this.readOnly = readOnly;
    this.allowedExt = new Set(
      allowedExt.map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase()),
    );
  }

  static async create(
    rootInput: string,
    opts: { readOnly?: boolean; allowedExt?: string[] } = {},
  ): Promise<VaultFS> {
    const abs = path.resolve(rootInput);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new VaultError(`Vault root does not exist: ${abs}`);
    }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new VaultError(`Vault root is not a directory: ${real}`);
    const ext = opts.allowedExt && opts.allowedExt.length ? opts.allowedExt : DEFAULT_EXT;
    return new VaultFS(real, opts.readOnly ?? false, ext);
  }

  get rootPath(): string {
    return this.root;
  }

  // ---- path confinement -------------------------------------------------

  private assertInside(abs: string): void {
    const rel = path.relative(this.root, abs);
    if (rel === "") return; // the root itself
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new VaultError("Path escapes the vault root");
    }
  }

  /**
   * Resolve a vault-relative path to an absolute path inside the root.
   * @param mustExist when true, resolves symlinks on the full target and
   *   requires it to exist; when false (writes to a possibly-new file), the
   *   parent directory is symlink-resolved and checked instead.
   */
  private async resolveConfined(userPath: string, mustExist: boolean): Promise<string> {
    if (userPath.includes("\0")) throw new VaultError("Path contains a null byte");
    const rel = userPath.replace(/^[/\\]+/, ""); // leading slash => still vault-relative
    const joined = path.resolve(this.root, rel);
    this.assertInside(joined); // structural check before touching the FS

    if (mustExist) {
      let real: string;
      try {
        real = await fs.realpath(joined);
      } catch (e: any) {
        if (e?.code === "ENOENT") throw new VaultError(`Not found: ${userPath}`);
        throw e;
      }
      this.assertInside(real);
      return real;
    }

    const parent = path.dirname(joined);
    let realParent: string;
    try {
      realParent = await fs.realpath(parent);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        // Parent doesn't exist yet; validate the deepest existing ancestor.
        this.assertInside(parent);
        return joined;
      }
      throw e;
    }
    this.assertInside(realParent);
    return path.join(realParent, path.basename(joined));
  }

  private assertExt(p: string): void {
    const ext = path.extname(p).toLowerCase();
    if (!this.allowedExt.has(ext)) {
      throw new VaultError(
        `Extension not allowed: ${ext || "(none)"} — allowed: ${[...this.allowedExt].join(", ")}`,
      );
    }
  }

  private assertWritable(): void {
    if (this.readOnly) throw new VaultError("Server is running in read-only mode");
  }

  // ---- read operations --------------------------------------------------

  async readNote(p: string): Promise<string> {
    const abs = await this.resolveConfined(p, true);
    return fs.readFile(abs, "utf8");
  }

  /** Recursively list allowed files as vault-relative paths, skipping dotfolders. */
  async listNotes(sub = ""): Promise<string[]> {
    const base = sub ? await this.resolveConfined(sub, true) : this.root;
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue; // .obsidian, .git, .trash, …
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && this.allowedExt.has(path.extname(e.name).toLowerCase())) {
          out.push(path.relative(this.root, full));
        }
      }
    };
    await walk(base);
    return out.sort();
  }

  // ---- write operations -------------------------------------------------

  async writeNote(p: string, content: string): Promise<void> {
    this.assertWritable();
    this.assertExt(p);
    const abs = await this.resolveConfined(p, false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async createNote(p: string, content: string): Promise<void> {
    this.assertWritable();
    this.assertExt(p);
    const abs = await this.resolveConfined(p, false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const fh = await fs.open(abs, "wx").catch((e: any) => {
      if (e?.code === "EEXIST") throw new VaultError(`Note already exists: ${p}`);
      throw e;
    });
    try {
      await fh.writeFile(content, "utf8");
    } finally {
      await fh.close();
    }
  }

  async appendNote(p: string, text: string): Promise<void> {
    this.assertWritable();
    this.assertExt(p);
    const abs = await this.resolveConfined(p, false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, text, "utf8");
  }

  /** Replace an exact snippet that must occur exactly once. */
  async editNote(p: string, oldText: string, newText: string): Promise<void> {
    this.assertWritable();
    const abs = await this.resolveConfined(p, true);
    const content = await fs.readFile(abs, "utf8");
    const parts = content.split(oldText);
    const count = parts.length - 1;
    if (count === 0) throw new VaultError("oldText not found in note");
    if (count > 1) {
      throw new VaultError(
        `oldText is ambiguous (appears ${count}×); include more surrounding context`,
      );
    }
    await fs.writeFile(abs, parts.join(newText), "utf8"); // string join => no $-pattern expansion
  }

  async deleteNote(p: string): Promise<void> {
    this.assertWritable();
    this.assertExt(p); // guard against nuking config/attachments
    const abs = await this.resolveConfined(p, true);
    await fs.unlink(abs);
  }

  async moveNote(from: string, to: string): Promise<void> {
    this.assertWritable();
    this.assertExt(to);
    const absFrom = await this.resolveConfined(from, true);
    const absTo = await this.resolveConfined(to, false);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
  }
}
