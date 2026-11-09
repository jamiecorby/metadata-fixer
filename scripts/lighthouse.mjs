// Lighthouse gate: every page, mobile and desktop, must score 100 for performance, accessibility, best practices and SEO.
// Serves the built site with gzip (as GitHub Pages does) on a local port, or tests BASE=<url> when given.
// Run with `npm run lighthouse` after `npm run build`. Exit code 1 if anything is below 100.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm", ".gz": "application/gzip", ".txt": "text/plain" };
let server, base = process.env.BASE;
if (!base) {
  server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
    try {
      let body = await readFile(join(ROOT, path)); const type = TYPES[extname(path)] || "application/octet-stream";
      const headers = { "content-type": type, "cache-control": "max-age=600" };
      if (/text|javascript|svg|json/.test(type) && /gzip/.test(req.headers["accept-encoding"] || "")) { body = gzipSync(body); headers["content-encoding"] = "gzip"; headers.vary = "Accept-Encoding"; }
      res.writeHead(200, headers); res.end(body);
    } catch { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); res.end(await readFile(join(ROOT, "404.html"))); }
  });
  await new Promise((r) => server.listen(8791, "127.0.0.1", r)); base = "http://127.0.0.1:8791";
}
let chromePath = process.env.CHROME_PATH;
if (!chromePath) { try { chromePath = createRequire(import.meta.url)("playwright").chromium.executablePath(); } catch {} }
const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ["--headless=new", "--no-sandbox"] });
const CATS = ["performance", "accessibility", "best-practices", "seo"];
let failed = 0;
for (const page of ["index.html", "privacy.html", "terms.html", "404.html"]) {
  for (const ff of ["mobile", "desktop"]) {
    const cfg = ff === "desktop" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
    const { lhr } = await lighthouse(`${base}/${page}`, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: CATS }, cfg);
    const sc = CATS.map((c) => Math.round(lhr.categories[c].score * 100));
    const m = lhr.audits;
    const below = sc.some((s) => s < 100); if (below) failed++;
    console.log(`${below ? "FAIL" : "ok  "} ${(page.replace(".html", "") + " " + ff).padEnd(18)} perf ${sc[0]} a11y ${sc[1]} bp ${sc[2]} seo ${sc[3]} | FCP ${m["first-contentful-paint"].displayValue} LCP ${m["largest-contentful-paint"].displayValue} TBT ${m["total-blocking-time"].displayValue} CLS ${m["cumulative-layout-shift"].displayValue}`);
    if (below) for (const a of Object.values(m)) if (a.score !== null && a.score < 1 && !["informative", "manual", "notApplicable"].includes(a.scoreDisplayMode)) console.log("       " + a.id + " " + (a.displayValue || a.score));
  }
}
await chrome.kill(); if (server) server.close();
console.log(failed ? `${failed} page/form-factor runs below 100` : "ALL 100");
process.exit(failed ? 1 : 0);
