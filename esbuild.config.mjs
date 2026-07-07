import esbuild from "esbuild";

// Bundle the whole server (SDK + zod included) into a single dist/index.js so
// deploying to the VPS is just copying one file — no node_modules on the remote.
const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.js",
  // Bundled deps (express/body-parser/debug) do dynamic `require()` of Node
  // built-ins. esbuild's ESM output stubs `require` to throw, so re-create a
  // real one from import.meta.url. Shebang must stay the first line.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.error("[esbuild] watching…");
} else {
  await esbuild.build(options);
}
