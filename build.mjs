// Build: bundles src/ into assets/, copies the ExifTool engine (plain and gzipped) into w/, writes index.html.
import { build } from "esbuild";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from "fs";
import { gzipSync } from "zlib";

await import("./scripts/vendor.mjs");
const { CONFIG } = await import("./src/config.js");
const { plansHTML } = await import("./src/app/plans.js");
rmSync("assets", { recursive: true, force: true });
mkdirSync("assets", { recursive: true }); mkdirSync("w", { recursive: true });
await build({
  entryPoints: ["src/main.js"], outdir: "assets", bundle: true, format: "esm", splitting: true, minify: true,
  target: ["es2020", "safari15"], platform: "browser", sourcemap: false, legalComments: "none",
  external: ["node:*", "fs", "path", "url", "crypto", "worker_threads"], logLevel: "warning",
  entryNames: "[name]", chunkNames: "chunk-[hash]",
});
// Self-hosted IBM Plex (SIL OFL 1.1, via @fontsource): no third-party font requests, and fonts load from the first connection.
mkdirSync("assets/fonts", { recursive: true });
const FONTS = [["sans", 400], ["sans", 500], ["sans", 600], ["sans", 700], ["mono", 400], ["mono", 500]];
let faces = "";
for (const [fam, w] of FONTS) {
  const file = `ibm-plex-${fam}-latin-${w}-normal.woff2`;
  copyFileSync(`node_modules/@fontsource/ibm-plex-${fam}/files/${file}`, "assets/fonts/" + file);
  faces += `@font-face{font-family:"IBM Plex ${fam === "sans" ? "Sans" : "Mono"}";font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${file}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}\n`;
}
copyFileSync("node_modules/@fontsource/ibm-plex-sans/LICENSE", "assets/fonts/LICENSE-IBM-Plex.txt");
writeFileSync("assets/app.css", faces + readFileSync("src/styles.css", "utf8"));
copyFileSync("src/icon.svg", "assets/icon.svg");
const main = readFileSync("assets/main.js");
if (/from\s*["']node:/.test(main.toString())) throw new Error("A Node-only import leaked into the browser bundle");
const v = createHash("sha256").update(main).update(readFileSync("assets/app.css")).digest("hex").slice(0, 10);
for (const page of ["index.html", "privacy.html", "terms.html", "404.html"]) {
  if (!existsSync("src/" + page)) continue;
  // Inline the stylesheet (one less round trip before first paint); font URLs become page-relative.
  const css = readFileSync("assets/app.css", "utf8").replaceAll("url(fonts/", "url(assets/fonts/");
  const preload = `<link rel="preload" href="assets/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="assets/fonts/ibm-plex-sans-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>`;
  const html = readFileSync("src/" + page, "utf8");
  const tag = '<link rel="stylesheet" href="assets/app.css?v=__V__">';
  if (!html.includes(tag)) throw new Error(page + ": stylesheet link not found");
  writeFileSync(page, html.replace(tag, preload + "<style>" + css + "</style>").replace("__PLANS__", plansHTML(CONFIG)).replaceAll("__V__", v));
}
writeFileSync("assets/boot.js", readFileSync("src/boot.js", "utf8").replaceAll("__V__", v));
const wasm = readFileSync("node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm");
writeFileSync("w/zeroperl.wasm", wasm);
writeFileSync("w/zeroperl.wasm.gz", gzipSync(wasm, { level: 9 }));
for (const f of readdirSync("w")) if (/^p\d\.wasm$/.test(f)) rmSync("w/" + f);
const sz = (f) => (readFileSync(f).length / 1024).toFixed(0) + " KB";
console.log("built", v, "main", sz("assets/main.js"), "css", sz("assets/app.css"), "wasm.gz", sz("w/zeroperl.wasm.gz"), "chunks", readdirSync("assets").filter((f) => f.startsWith("chunk")).length);
