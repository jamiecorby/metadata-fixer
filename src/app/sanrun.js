// Sanitisation batch orchestration. No DOM, no network, no recovery code: it takes File objects and returns Blobs and reports.
// The browser supplies `io.redraw` (canvas) and `io.readTags` (ExifTool); tests supply their own.
import { zipBlobs } from "./zipstream.js";
import { sanitise, detect, Unsupported, Damaged, NeedsDecision, NeedsReencode, EXT_FOR, RAW_EXT } from "../core/sanitise.js";
import { verifyOutput, metaTagValues } from "../core/sanverify.js";

export const SUPPORTED = /\.(jpe?g|png|webp|tiff?|heic|heif|avif|mp4|mov|m4v)$/i;
export const READ_BIG = 200 * 1024 * 1024; // above this the ExifTool read-back is skipped and reported as a limitation
export const ZIP_MAX = 1024 * 1024 * 1024;
export const ST = { queued: "Waiting", working: "Working", verified: "Verified", limited: "Verified with limitations", failed: "Failed", unsupported: "Not supported", decision: "Needs a decision" };

const stem = (n) => n.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
const clean = (s) => s.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"|?*\\/]+/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 100) || "file";
function extFor(kind, name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name); const e = m ? m[1].toLowerCase() : "";
  const ok = EXT_FOR[kind] || []; return ok.includes(e) ? e : ok[0] || "bin";
}
/** Safe, unique output name. `used` is a Set of lower-cased names already taken in the same folder. */
export function outName(name, kind, used) {
  const base = clean(stem(name)) + "_sanitised", ext = extFor(kind, name); let n = `${base}.${ext}`, i = 2;
  while (used.has(n.toLowerCase())) n = `${base}-${i++}.${ext}`;
  used.add(n.toLowerCase()); return n;
}
const safeDir = (p) => (p.includes("/") ? p.replace(/\/[^/]*$/, "").split("/").filter((x) => x && x.trim() && !/^\.+$/.test(x.trim())).map(clean).join("/") : "");

export function newEntry(file, id) {
  const path = file.webkitRelativePath || file.name;
  return { id, file, name: file.name, path, size: file.size, state: "queued", msg: "", kind: null, rep: null, checks: [], limits: [], out: null, ms: 0, tries: 0 };
}

/** Reads the first bytes to name the format for a redraw. */
async function kindOf(file) { return detect(new Uint8Array(await file.slice(0, 64).arrayBuffer())); }

export async function processOne(e, o, io) {
  const t0 = Date.now(); e.state = "working"; e.msg = ""; e.out = null; e.rep = null; e.checks = []; e.limits = []; e.tries++;
  try {
    if (RAW_EXT.test(e.name)) throw new Unsupported("RAW camera files can't be reliably sanitised without damaging their rendering, so this file was not changed.");
    if (!SUPPORTED.test(e.name) && !(await kindOf(e.file))) throw new Unsupported("This isn't a supported image or video format.");
    let r, redrawn = false;
    try { r = await sanitise(e.file, e.name, { dropAux: !!(o.dropAux || e.allowAux) }); }
    catch (er) {
      if (!(er instanceof NeedsReencode)) throw er;
      if (!(o.redraw || e.allowRedraw)) throw new NeedsDecision(er.message + " Allow redrawing to continue.", "redraw");
      if (!io.redraw) throw new Unsupported(er.message + " This browser can't redraw the image.");
      const kind = await kindOf(e.file), blob = await io.redraw(e.file, kind);
      r = await sanitise(blob, e.name, { dropAux: !!(o.dropAux || e.allowAux), reencoded: true }); redrawn = true;
      r.rep.notes.push(er.why === "rotation" ? "The picture was stored sideways. Its rotation was applied to the pixels and the rotation tag removed." : "The picture's colours were converted to sRGB and the colour profile removed.");
      r.rep.notes.push("The image was decoded and encoded again, so its pixels are not byte-identical to the original.");
    }
    const kind = r.kind, outBlob = r.out instanceof Blob ? r.out : new Blob([r.out], { type: kind === "png" ? "image/png" : kind === "webp" ? "image/webp" : kind === "tiff" ? "image/tiff" : kind === "heif" ? "image/heic" : "image/jpeg" });
    const nm = outName(e.name, kind, o.used || new Set());
    let needles = [], readBack = null;
    if (io.readTags && e.file.size <= READ_BIG) {
      try { needles = metaTagValues(await io.readTags(e.file, e.name)); } catch (er) { needles = []; }
      if (outBlob.size <= READ_BIG) readBack = (b) => io.readTags(b, nm);
    }
    const v = await verifyOutput({ srcBlob: e.file, outBlob, kind, rep: r.rep, reencoded: redrawn, needles, readBack });
    if (e.file.size > READ_BIG) v.limits.push("The file is large, so the second-reader (ExifTool) check was skipped.");
    e.kind = kind; e.rep = r.rep; e.checks = v.checks; e.limits = [...new Set(v.limits)];
    if (v.status === "failed") { e.state = "failed"; e.msg = "Verification failed: " + v.checks.filter((c) => c.result === "fail").map((c) => c.label).join("; "); }
    else { e.state = v.status; e.out = { blob: outBlob, name: nm, size: outBlob.size }; e.msg = ""; }
    if (e.state === "failed") o.used && o.used.delete(nm.toLowerCase());
  } catch (er) {
    e.rep = e.rep || null;
    if (er instanceof NeedsDecision) { e.state = "decision"; e.msg = er.message; e.key = er.key; }
    else if (er instanceof Unsupported) { e.state = "unsupported"; e.msg = er.message; }
    else if (er instanceof Damaged) { e.state = "failed"; e.msg = er.message; }
    else { e.state = "failed"; e.msg = "Processing failed" + (er && er.message ? ": " + String(er.message).slice(0, 120) : "."); }
  }
  e.ms = Date.now() - t0; return e;
}

/** Runs the entries that are waiting (or retryable) one after another; one failure never stops the rest. */
export async function runBatch(entries, o, io, on = () => {}) {
  o.used = o.used || new Set(entries.filter((x) => x.out).map((x) => x.out.name.toLowerCase()));
  const todo = entries.filter((x) => x.state === "queued" || x.state === "failed" || x.state === "decision");
  let done = 0; on({ done, total: todo.length });
  for (const e of todo) { if (o.cancelled && o.cancelled()) break; on({ done, total: todo.length, current: e }); await processOne(e, o, io); done++; on({ done, total: todo.length, current: e }); await new Promise((r) => setTimeout(r, 0)); }
  return summary(entries);
}
export function summary(entries) {
  const c = { total: entries.length, verified: 0, limited: 0, failed: 0, unsupported: 0, decision: 0, queued: 0, working: 0 };
  for (const e of entries) c[e.state]++; c.ok = c.verified + c.limited; return c;
}

/* ---- audit */
export function auditRecord(e) {
  return {
    file: e.path, result: ST[e.state] || e.state, detail: e.msg || "", format: e.rep ? e.rep.format : "", method: e.rep ? e.rep.method : "",
    bytes_in: e.size, bytes_out: e.out ? e.out.size : null, output: e.out ? e.out.name : "",
    removed: e.rep ? e.rep.removed.map((x) => ({ item: x.what, count: x.count, bytes: x.bytes })) : [],
    notes: e.rep ? e.rep.notes : [], checks: e.checks.map((c) => ({ check: c.label, result: c.result === "pass" ? "passed" : c.result === "fail" ? "FAILED" : "not completed", detail: c.detail || "" })),
    limitations: e.limits || [],
  };
}
const q = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + (/^[=+\-@\t]/.test(s) ? "'" : "") + s.replace(/"/g, '""') + '"' : s; };
export function auditCsv(entries) {
  const rows = [["File", "Result", "Format", "Method", "Bytes in", "Bytes out", "Output file", "Removed", "Checks not passed or not completed", "Limitations", "Notes"]];
  for (const e of entries) {
    const a = auditRecord(e);
    rows.push([a.file, a.result + (a.detail ? ": " + a.detail : ""), a.format, a.method, a.bytes_in, a.bytes_out ?? "", a.output, a.removed.map((x) => `${x.item}${x.count > 1 ? " x" + x.count : ""}`).join("; "), a.checks.filter((c) => c.result !== "passed").map((c) => `${c.check} [${c.result}]${c.detail ? " " + c.detail : ""}`).join("; "), a.limitations.join("; "), a.notes.join("; ")]);
  }
  return rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}
export const auditJson = (entries) => JSON.stringify({ tool: "Metadata Fixer sanitise", note: "Describes what this run removed and checked. It does not claim that every possible embedded structure was found.", files: entries.map(auditRecord) }, null, 2);

/* ---- ZIP of the successful outputs (stored, not compressed: they are already compressed). Fixed timestamps, so the archive adds no date. */
export async function buildZip(entries, withAudit = true) {
  const good = entries.filter((e) => e.out && (e.state === "verified" || e.state === "limited"));
  const total = good.reduce((a, e) => a + e.out.size, 0);
  if (total > ZIP_MAX) throw new Error("These files total over 1 GB, which is too much to bundle in the browser. Download them one by one.");
  const used = new Map(), list = [], date = new Date("1980-01-01T00:00:00");
  for (const e of good) {
    const dir = safeDir(e.path), set = used.get(dir) || new Set(); used.set(dir, set);
    let n = e.out.name; const base = n.replace(/\.[^.]+$/, ""), ext = n.slice(base.length); let i = 2;
    while (set.has(n.toLowerCase())) n = `${base}-${i++}${ext}`; set.add(n.toLowerCase());
    list.push({ name: (dir ? dir + "/" : "") + n, blob: e.out.blob, date });
  }
  if (withAudit) { list.push({ name: "sanitisation-audit.csv", text: auditCsv(entries), date, level: 6 }, { name: "sanitisation-audit.json", text: auditJson(entries), date, level: 6 }); }
  return zipBlobs(list);
}
