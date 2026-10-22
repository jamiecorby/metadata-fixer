// Glue between the authenticity engine and the app: per-file assessment, merging the Fix into an export, verifying it, and the audit columns.
import { scanContainer, readClaims } from "../core/c2pa.js";
import { assess, planFix, provenanceLost } from "../core/authenticity.js";
import { offsetFor } from "../core/tz.js";
import { zoneAt } from "./model.js";

const offsetAt = (la, lo, naiveMs) => { const z = zoneAt(la, lo); return z ? offsetFor(z, naiveMs) : null; };
export const CAMERA_WRITE = /(^|:)(Make|Model|LensModel|LensMake|LensInfo|FNumber|ExposureTime|ISO|FocalLength|FocalLengthIn35mmFormat|LensID|SerialNumber|Software|HostComputer)$/;

/** Reads the container once (cached) and (re)computes the assessment. Never throws. */
export async function runAssess(it) {
  const a = it.auth || (it.auth = { fix: false, disclosure: "auto", vision: null, claims: null });
  try {
    if (!a.claims) a.claims = readClaims(await scanContainer(it.file));
    a.a = assess({ raw: it.exRaw || {}, kind: it.kind === "video" ? "video" : "photo", c2pa: a.claims, vision: a.vision, offsetAt, now: Date.now() });
    a.err = null;
  } catch (e) { a.err = e.message || "Could not check this file"; a.a = null; }
  return a;
}
/** What Fix would do for this file with its current settings (null when Fix is off or there is nothing to do). */
export function fixFor(it) {
  const a = it.auth; if (!a || !a.a || !a.fix) return null;
  const p = planFix(a.a, it.exRaw || {}, { disclosure: a.disclosure });
  return p.actions.length || Object.keys(p.tags).length ? p : null;
}
export function previewFix(it) { const a = it.auth; return a && a.a ? planFix(a.a, it.exRaw || {}, { disclosure: a.disclosure }) : null; }

/** Merges the Fix into the tag plan of an export job. The Fix never touches what the user chose to write, except to avoid contradicting it. */
export function mergeFix(b, p, fix) {
  if (!fix) return b;
  const tags = { ...b.tags }, expect = { ...b.expect }, summary = [...b.summary];
  for (const [k, v] of Object.entries(fix.tags)) {
    if (/ModifyDate$/.test(k) && p.write.date) continue; // the export already sets every date
    tags[k] = v;
  }
  for (const [k, v] of Object.entries(fix.expect)) { if (/ModifyDate$/.test(k) && p.write.date) continue; expect[k] = v; }
  if (fix.absent.length) for (const k of Object.keys(tags)) if (CAMERA_WRITE.test(k) && !(k in fix.tags)) { delete tags[k]; delete expect[k]; }
  for (const x of fix.actions) summary.push(x);
  return { ...b, tags, expect, summary };
}
/** Checks a written file against its Fix and the "never lose provenance" rule. Returns extra problems (empty = fine). */
export async function verifyFix(it, fix, back, outBlob) {
  const bad = [];
  const lost = provenanceLost(it.exRaw || {}, back || {});
  if (lost.length) bad.push("AI provenance would be lost (" + lost.slice(0, 3).join(", ") + "); the file was not exported");
  if (fix) for (const k of fix.absent) { const v = back && back[k]; if (v != null && v !== "") bad.push(k + " was not removed"); }
  const had = it.auth && it.auth.claims && it.auth.claims.present;
  if (had) { try { if (!(await scanContainer(outBlob)).present) bad.push("The Content Credentials manifest was dropped; the file was not exported"); } catch (e) {} }
  return bad;
}
const q = (s) => String(s ?? "");
export function auditCols(it) {
  const a = it.auth, x = a && a.a;
  if (!x) return ["", "", "", "", "", "", "", ""];
  const c = a.claims && a.claims.present ? `present (${a.claims.container}${a.claims.issuer ? ", " + a.claims.issuer : ""}); signature not validated` : "none";
  const written = it.out && it.out.fix && it.out.fix.tags["XMP-iptcExt:DigitalSourceType"] ? it.out.fix.tags["XMP-iptcExt:DigitalSourceType"].split("/").pop() : "";
  return [String(x.score), x.band[0] + "-" + x.band[1], x.level, x.evidence.filter((e) => e.tone !== "info" && e.id !== "vision").slice(0, 6).map((e) => e.title).join("; "), c, a.vision ? a.vision.score + " (confidence " + Math.round(a.vision.confidence * 100) + "%)" : "not run", it.out && it.out.fix ? it.out.fix.actions.join("; ") : "", written];
}
export const AUDIT_HEAD = ["ai_likelihood", "ai_range", "authenticity_level", "authenticity_evidence", "content_credentials", "vision_check", "authenticity_fix", "disclosure_written"];

export function meterLabel(x) { return `AI likelihood ${x.score} out of 100, range ${x.band[0]} to ${x.band[1]}, ${x.confidence} confidence. ${x.level}.`; }
export const tone = (x) => (x.level === "Not enough evidence" ? "mid" : x.score >= 60 ? "hi" : x.level === "Metadata looks inconsistent" ? "warn" : x.score >= 35 ? "mid" : "lo");
