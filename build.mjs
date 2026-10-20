// Build: bundles src/ into assets/, copies the ExifTool engine (plain and gzipped) into w/, writes index.html.
import { build } from "esbuild";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from "fs";
import { gzipSync } from "zlib";

await import("./scripts/vendor.mjs");
rmSync("assets", { recursive: true, force: true });
mkdirSync("assets", { recursive: true }); mkdirSync("w", { recursive: true });
await build({
  entryPoints: ["src/main.js"], outdir: "assets", bundle: true, format: "esm", splitting: true, minify: true,
  target: ["es2020", "safari15"], platform: "browser", sourcemap: false, legalComments: "none",
  external: ["node:*", "fs", "path", "url", "crypto", "worker_threads"], logLevel: "warning",
  entryNames: "[name]", chunkNames: "chunk-[hash]",
});
copyFileSync("src/styles.css", "assets/app.css");
copyFileSync("src/icon.svg", "assets/icon.svg");
const main = readFileSync("assets/main.js");
if (/from\s*["']node:/.test(main.toString())) throw new Error("A Node-only import leaked into the browser bundle");
const v = createHash("sha256").update(main).update(readFileSync("assets/app.css")).digest("hex").slice(0, 10);
for (const page of ["index.html", "privacy.html", "terms.html", "404.html"]) {
  if (existsSync("src/" + page)) writeFileSync(page, readFileSync("src/" + page, "utf8").replaceAll("__V__", v));
}
const wasm = readFileSync("node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm");
writeFileSync("w/zeroperl.wasm", wasm);
writeFileSync("w/zeroperl.wasm.gz", gzipSync(wasm, { level: 9 }));
for (const f of readdirSync("w")) if (/^p\d\.wasm$/.test(f)) rmSync("w/" + f);
const sz = (f) => (readFileSync(f).length / 1024).toFixed(0) + " KB";
console.log("built", v, "main", sz("assets/main.js"), "css", sz("assets/app.css"), "wasm.gz", sz("w/zeroperl.wasm.gz"), "chunks", readdirSync("assets").filter((f) => f.startsWith("chunk")).length);
