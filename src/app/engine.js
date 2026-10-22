// ExifTool (Perl compiled to WebAssembly) running locally. Calls are serialised: the engine is single-threaded.
let ET = null;
const lib = async () => ET || (ET = await import("../vendor/exiftool.js"));
import { READ_ARGS } from "../core/existing.js";
import { CONFIG } from "../config.js";

export const engine = { state: "idle", progress: 0, error: null };
const subs = new Set();
export const onEngine = (fn) => subs.add(fn);
const emit = () => subs.forEach((f) => { try { f(engine); } catch (e) {} });
let bytes = null, loading = null;

async function fetchWithProgress(url, expected) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok || !r.body) throw new Error("Engine download failed (" + r.status + ")");
  const total = +r.headers.get("content-length") || expected;
  const reader = r.body.getReader(), parts = []; let seen = 0, last = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); seen += value.byteLength; const p = Math.min(0.99, seen / total); if (p - last > 0.02) { last = p; engine.progress = p; emit(); } }
  const buf = new Uint8Array(seen); let o = 0; for (const x of parts) { buf.set(x, o); o += x.byteLength; }
  if (buf[0] === 0x1f && buf[1] === 0x8b) { // gzip: the host served it as-is, so decompress here
    return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  return buf; // the host already decoded it (Content-Encoding), or it was never compressed
}
export function loadEngine() {
  if (loading) return loading;
  engine.state = "loading"; engine.progress = 0; emit();
  loading = (async () => {
    let b = null;
    if (typeof DecompressionStream === "function") { try { b = await fetchWithProgress(CONFIG.wasm.gz, CONFIG.wasm.size * 0.3); } catch (e) { b = null; } }
    if (!b || b.length < 1e6 || b[0] !== 0x00 || b[1] !== 0x61) b = await fetchWithProgress(CONFIG.wasm.raw, CONFIG.wasm.size);
    await lib();
    bytes = b; engine.state = "ready"; engine.progress = 1; emit();
  })().catch((e) => { engine.state = "error"; engine.error = e; loading = null; emit(); throw e; });
  return loading;
}
const wfetch = () => Promise.resolve(new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));
let queue = Promise.resolve();
function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }
const safeName = (n) => n.replace(/[^\w.\-() ]+/g, "_").slice(-120) || "file";
function cleanErr(e) {
  const s = String(e || "Unknown error").replace(/\s+/g, " ").replace(/^error:\s*/i, "").trim();
  if (/truncated/i.test(s)) return "This file is cut short (truncated), so its metadata can't be written safely. Re-export or re-download it and try again.";
  if (/looks more like a (\w+)/i.test(s)) return `The file's contents don't match its extension (${s.match(/looks more like a (\w+)/i)[1]} data). Rename it with the right extension and try again.`;
  if (/corrupt/i.test(s)) return "The image data is corrupted, so its metadata can't be written safely. Try re-exporting or re-downloading the original.";
  if (/not a valid/i.test(s)) return "The file appears to be damaged or is not a supported format.";
  return s.slice(0, 240);
}
export function readTags(blob, name) {
  return serial(async () => {
    await loadEngine();
    const f = new File([blob], safeName(name));
    const r = await (await lib()).parseMetadata(f, { args: READ_ARGS, transform: (d) => JSON.parse(d)[0], fetch: wfetch });
    if (!r.success) throw new Error(cleanErr(r.error));
    return r.data;
  });
}
export function writeTags(blob, name, tags) {
  return serial(async () => {
    await loadEngine();
    const f = new File([blob], safeName(name));
    const r = await (await lib()).writeMetadata(f, tags, { args: ["-m"], fetch: wfetch });
    if (!r.success) throw new Error(cleanErr(r.error));
    return new Uint8Array(r.data);
  });
}

/* ---- batched operations: one Perl run per chunk (much faster than one run per file) ---- */
const extOf = (n) => ((/\.([A-Za-z0-9]{1,5})$/.exec(n) || [])[1] || "bin").toLowerCase();
function chunks(list, maxN, maxBytes) {
  const out = []; let cur = [], size = 0;
  for (const x of list) { const b = x.blob.size || x.blob.byteLength || 0; if (cur.length && (cur.length >= maxN || size + b > maxBytes)) { out.push(cur); cur = []; size = 0; } cur.push(x); size += b; }
  if (cur.length) out.push(cur);
  return out;
}
export const hardErr = (err, path) => String(err || "").split("\n").some((x) => x.includes(path) && /^\s*error/i.test(x));
const errFor = (err, path) => { const l = String(err || "").split("\n").filter((x) => x.includes(path) && /error|warning/i.test(x)); return cleanErr(l.join(" ").replace(path, "").replace(/\s+-\s*$/, "") || "Unknown error"); };
/** items [{id, blob, name}] -> Map(id -> exiftool JSON object | Error). onChunk(doneCount) */
export async function readMany(items, onChunk) {
  const res = new Map();
  for (const part of chunks(items, 40, 600e6)) {
    await serial(async () => {
      await loadEngine();
      const files = part.map((x) => ({ path: `/r${x.id}.${extOf(x.name)}`, data: x.blob instanceof File ? x.blob : new File([x.blob], "f") , id: x.id }));
      const r = await (await lib()).runBatch(files, [...READ_ARGS, ...files.map((f) => f.path)], wfetch);
      let arr = []; try { arr = JSON.parse(r.out || "[]"); } catch (e) {}
      const bySrc = new Map(arr.map((o) => [o.SourceFile, o]));
      for (const f of files) res.set(f.id, bySrc.get(f.path) || new Error(errFor(r.err, f.path)));
    });
    onChunk && onChunk(res.size);
  }
  return res;
}
/** jobs [{id, blob, name, tags}] -> Map(id -> Uint8Array | Error) */
export async function writeMany(jobs, onChunk) {
  const res = new Map();
  for (const part of chunks(jobs, 25, 400e6)) {
    await serial(async () => {
      await loadEngine();
      const lines = [], files = [], outs = [];
      for (const j of part) {
        const ext = extOf(j.name), inp = `/w${j.id}.${ext}`, out = `/o${j.id}.${ext}`;
        files.push({ path: inp, data: j.blob instanceof File ? j.blob : new File([j.blob], "f") });
        lines.push("-m");
        for (const [k, v] of Object.entries(j.tags)) lines.push(`-${k}=${String(v).replace(/[\r\n]+/g, " ")}`);
        lines.push("-o", out, inp, "-execute");
        outs.push(out); j._in = inp; j._out = out;
      }
      files.push({ path: "/args.txt", data: new File([lines.join("\n") + "\n"], "args.txt") });
      const r = await (await lib()).runBatch(files, ["-@", "/args.txt"], wfetch, outs);
      for (const j of part) res.set(j.id, !hardErr(r.err, j._in) && r.outs[j._out] && r.outs[j._out].length ? r.outs[j._out] : new Error(errFor(r.err, j._in)));
    });
    onChunk && onChunk(res.size);
  }
  return res;
}
