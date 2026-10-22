// Items, candidates, resolution, write plans and statuses.
import tzlookup from "@photostructure/tz-lookup";
import { offsetFor, utcToNaive, fmtOffset, isZone, parseFixed } from "../core/tz.js";
import { naive, human, dayOnly, plausible } from "../core/time.js";
import { fromFileName } from "../core/filenames.js";
import { profileFor } from "../core/devices.js";

export const S = {
  items: [], cars: [], match: null,
  sel: new Set(), focus: null, filter: "all", selectMode: false,
  settings: null, ctx: { month: "", year: "", start: "", end: "", area: null, hint: "" },
  busy: false, outs: [],
};
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const PHOTO = /\.(jpe?g|heic|heif|png|tiff?|dng|webp|avif)$/i;
export const VIDEO = /\.(mp4|mov|m4v|3gp|qt)$/i;
let nextId = 1;

export function zoneAt(la, lo) { try { return tzlookup(la, lo); } catch (e) { return null; } }
export function haversine(a, b, c, d) { const t = (x) => (x * Math.PI) / 180, h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); }

export function newItem(file) {
  const path = file.webkitRelativePath || file.name;
  const i = path.lastIndexOf("/");
  return {
    id: nextId++, file, name: file.name, path, dir: i < 0 ? "" : path.slice(0, i), kind: VIDEO.test(file.name) ? "video" : "photo",
    size: file.size, mtime: file.lastModified || null,
    thumb: null, prevUrl: null, prevErr: false,
    exRaw: null, ex: null, exState: "pending", side: null,
    ai: null, aiState: null, aiErr: null,
    date: null, loc: null, dev: null, zone: null, ready: false, out: null,
  };
}

/** Zone used to read and write wall-clock times for this item. */
export function itemZone(it) {
  const st = S.settings;
  if (it.zone) return it.zone;
  if (it.loc) return it.loc.zone || zoneAt(it.loc.la, it.loc.lo) || st.zone;
  if (it.ex && it.ex.gps) return zoneAt(it.ex.gps.la, it.ex.gps.lo) || st.zone;
  return st.zone;
}
const zoneLabel = (z) => (parseFixed(z) != null ? "UTC" + fmtOffset(parseFixed(z)) : z);

function forceMonth(t, mc) {
  if (!mc) return t;
  const d = new Date(t);
  if (d.getUTCMonth() + 1 === mc.m && (!mc.y || d.getUTCFullYear() === mc.y)) return t;
  const y = mc.y || d.getUTCFullYear(), dim = new Date(Date.UTC(y, mc.m, 0)).getUTCDate();
  return Date.UTC(y, mc.m - 1, Math.min(d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
export function monthCtx() { const m = +S.ctx.month, y = parseInt(S.ctx.year, 10); return m ? { m, y: y >= 1900 && y <= 2100 ? y : null } : null; }
export function rangeCtx() {
  const mc = monthCtx();
  if (S.ctx.start && S.ctx.end && S.ctx.start <= S.ctx.end) return [Date.parse(S.ctx.start + "T00:00:00Z"), Date.parse(S.ctx.end + "T23:59:59Z")];
  if (mc && mc.y) return [Date.UTC(mc.y, mc.m - 1, 1), Date.UTC(mc.y, mc.m, 0, 23, 59, 59)];
  return null;
}
export function inCtxDate(t) { const r = rangeCtx(), mc = monthCtx(); if (r) return t >= r[0] && t <= r[1]; if (mc) return new Date(t).getUTCMonth() + 1 === mc.m; return true; }
export function inCtxArea(la, lo) { const a = S.ctx.area; return !a || haversine(a.la, a.lo, la, lo) <= a.r; }
function clampArea(la, lo) {
  const a = S.ctx.area; if (!a) return { la, lo, moved: false };
  const d = haversine(a.la, a.lo, la, lo); if (d <= a.r) return { la, lo, moved: false };
  const k = (a.r * 0.9) / d; return { la: a.la + (la - a.la) * k, lo: a.lo + (lo - a.lo) * k, moved: true };
}

const resolvedT = (it) => (it.date ? it.date.t : null);
function neighbours(it) {
  const idx = S.items.indexOf(it); let prev = null, next = null;
  for (let j = idx - 1; j >= 0; j--) if (resolvedT(S.items[j]) != null) { prev = S.items[j]; break; }
  for (let j = idx + 1; j < S.items.length; j++) if (resolvedT(S.items[j]) != null) { next = S.items[j]; break; }
  return { prev, next, idx };
}

/** All date candidates, best first. Each: {t, off|null, src, label, conf, note} */
export function dateCands(it) {
  const C = [], zone = itemZone(it);
  const add = (c) => { if (c.t == null || isNaN(c.t) || !plausible(c.t)) return; if (!C.some((x) => x.src === c.src && Math.abs(x.t - c.t) < 60000)) C.push(c); };
  const ex = it.ex && it.ex.date;
  if (ex) {
    if (ex.t != null) add({ t: ex.t, off: ex.off, src: "existing", label: `Already in the file`, note: ex.tag + (ex.dateOnly ? ", date only" : ex.off == null ? ", no time zone" : ""), conf: ex.weak ? 0.5 : ex.dateOnly ? 0.92 : 1 });
    else if (ex.u != null) add({ t: utcToNaive(zone, ex.u), u: ex.u, off: null, src: "existing", label: "Already in the file", note: `${ex.tag} (UTC), shown in ${zoneLabel(zone)}`, conf: 1 });
  }
  const tk = it.side && it.side.takeout;
  if (tk && tk.utc) { const z = tk.lat != null ? zoneAt(tk.lat, tk.lon) || zone : zone; add({ t: utcToNaive(z, tk.utc), u: tk.utc, off: null, src: "takeout", label: "Google Takeout sidecar", note: `photoTakenTime, shown in ${zoneLabel(z)}`, conf: 0.97 }); }
  const xm = it.side && it.side.xmp;
  if (xm && xm.dt) add({ t: xm.dt.t, off: xm.dt.off, src: "xmp", label: "XMP sidecar", note: xm.dt.hasTime ? "" : "date only", conf: xm.dt.hasTime ? 0.95 : 0.6 });
  const fnm = fromFileName(it.name);
  if (fnm) add({ t: fnm.utc ? utcToNaive(zone, fnm.t) : fnm.t, u: fnm.utc ? fnm.t : undefined, off: null, src: "filename", label: `From the file name (${fnm.label})`, note: fnm.precision === "day" ? "date only, time set to 12:00" : fnm.utc ? `timestamp, shown in ${zoneLabel(zone)}` : "", conf: fnm.precision === "day" ? 0.6 : 0.9 });
  if (it.ai && it.ai.dates) {
    const rng = rangeCtx(), mc = monthCtx();
    for (const d of it.ai.dates) {
      const a = Date.parse(d.start + "T00:00:00Z"), b = Date.parse(d.end + "T00:00:00Z"); const [h, m] = d.time.split(":").map(Number);
      let t = a + Math.floor((b - a) / 2 / 864e5) * 864e5 + (h * 60 + m) * 6e4, note = d.basis;
      if (rng && (t < rng[0] || t > rng[1])) { t = Math.min(Math.max(t, rng[0]), rng[1]); note += " (moved into your date range)"; }
      else if (mc && !mc.y) { const t2 = forceMonth(t, mc); if (t2 !== t) { t = t2; note += ` (moved into ${MONTHS[mc.m - 1]})`; } }
      add({ t, off: null, src: "ai", label: `AI estimate: ${d.start === d.end ? d.start : d.start + " to " + d.end}, about ${d.time}`, note, conf: d.confidence * 0.9 });
    }
  }
  const { prev, next, idx } = neighbours(it);
  if (prev && next && next.date.t > prev.date.t) add({ t: prev.date.t + Math.round((next.date.t - prev.date.t) / 2), off: null, src: "sequence", label: "Between its neighbours", note: `${prev.name} and ${next.name}`, conf: 0.45 });
  if (prev) add({ t: prev.date.t + 60000, off: null, src: "sequence", label: "1 minute after the previous file", note: prev.name, conf: 0.4 });
  if (next) add({ t: next.date.t - 60000, off: null, src: "sequence", label: "1 minute before the next file", note: next.name, conf: 0.4 });
  const mc = monthCtx();
  if (mc && mc.y) {
    const n = S.items.length, s0 = Date.UTC(mc.y, mc.m - 1, 1, 12), e0 = Date.UTC(mc.y, mc.m, 0, 12);
    add({ t: Math.round((s0 + (e0 - s0) * (n > 1 ? idx / (n - 1) : 0.5)) / 3.6e6) * 3.6e6, off: null, src: "context", label: `Spaced through ${MONTHS[mc.m - 1]} ${mc.y}`, note: "by file order", conf: 0.3 });
  }
  if (it.mtime) add({ t: utcToNaive(zone, it.mtime), u: it.mtime, off: null, src: "mtime", label: "File modified time", note: "often the date it was copied or downloaded, not taken", conf: 0.2 });
  // a dated file name on the same day refines a date-only value already in the file
  if (ex && ex.dateOnly) for (const c of C) if (c.src !== "existing" && dayOnly(c.t) === dayOnly(ex.t) && c.conf >= 0.6) { c.conf = Math.max(c.conf, 0.95); c.note = (c.note ? c.note + "; " : "") + "adds the time to the date already in the file"; }
  return C.sort((a, b) => b.conf - a.conf);
}

/** Location candidates. Each: {la, lo, alt, zone, src, label, conf, note} */
export function locCands(it) {
  const C = [];
  const add = (c) => { if (!Number.isFinite(c.la) || !Number.isFinite(c.lo)) return; if (!C.some((x) => Math.abs(x.la - c.la) < 1e-4 && Math.abs(x.lo - c.lo) < 1e-4)) C.push({ zone: zoneAt(c.la, c.lo), ...c }); };
  const g = it.ex && it.ex.gps; if (g) add({ la: g.la, lo: g.lo, alt: g.alt, src: "existing", label: "Already in the file", conf: 1 });
  const tk = it.side && it.side.takeout; if (tk && tk.lat != null) add({ la: tk.lat, lo: tk.lon, alt: tk.alt, src: "takeout", label: "Google Takeout sidecar", conf: 0.97 });
  const xm = it.side && it.side.xmp; if (xm && xm.lat != null && xm.lon != null) add({ la: xm.lat, lo: xm.lon, alt: null, src: "xmp", label: "XMP sidecar", conf: 0.95 });
  if (it.ai && it.ai.locations) for (const l of it.ai.locations) {
    const c = clampArea(l.lat, l.lon);
    add({ la: +c.la.toFixed(4), lo: +c.lo.toFixed(4), alt: null, zone: l.timezone && isZone(l.timezone) ? l.timezone : undefined, src: "ai", label: `AI estimate: ${l.name || "unnamed place"}`, note: `within c. ${Math.round(l.radius_km)} km . ${l.basis}${c.moved ? " (pulled inside your area)" : ""}`, conf: l.confidence * 0.9, place: l.name, radius: l.radius_km });
  }
  const { prev, next } = neighbours(it);
  for (const nb of [prev, next]) if (nb && nb.loc) add({ la: nb.loc.la, lo: nb.loc.lo, alt: null, src: "sequence", label: `Same as ${nb.name}`, conf: 0.5, place: nb.loc.place });
  const a = S.ctx.area; if (a) add({ la: a.la, lo: a.lo, alt: null, src: "context", label: `Centre of your area${a.name ? " (" + a.name + ")" : ""}`, conf: 0.35, place: a.name });
  return C.sort((x, y) => y.conf - x.conf);
}

/** Pick sensible defaults: only well-evidenced sources are applied automatically. Manual choices are kept. */
export function autopick(it) {
  if (!it.loc || !it.loc.manual) { const b = locCands(it).find((c) => c.conf >= 0.9); it.loc = b ? { ...b, manual: false } : it.loc && it.loc.src === "ai" ? it.loc : null; }
  if (!it.date || !it.date.manual) { const b = dateCands(it).find((c) => c.conf >= 0.6); it.date = b ? { ...b, manual: false } : it.date && it.date.src === "ai" ? it.date : null; }
  if (it.dev == null) it.dev = S.settings.dev;
  rezone(it);
}
/** Apply the top AI suggestion (date and location) unless the user already chose. */
export function applyAiTop(it) {
  const d = dateCands(it).find((c) => c.src === "ai"); const l = locCands(it).find((c) => c.src === "ai");
  if (d && (!it.date || (!it.date.manual && it.date.conf < d.conf))) it.date = { ...d, manual: false };
  if (l && (!it.loc || (!it.loc.manual && it.loc.conf < l.conf))) it.loc = { ...l, manual: false };
  rezone(it);
}

/** Keep wall-clock display in step with the zone for values that came from an absolute time. */
export function rezone(it) {
  if (it.date && it.date.u != null) { const p = plan(it); if (p.t != null) it.date = { ...it.date, t: p.t }; }
}
/** What will be written. */
export function plan(it) {
  const st = S.settings, ex = it.ex || {};
  const d = it.date, l = it.loc;
  const exDate = ex.date && !ex.date.weak ? ex.date : null;
  const overwrite = st.policy === "overwrite";
  const zone = it.zone || (l ? l.zone || zoneAt(l.la, l.lo) || st.zone : itemZone(it));
  // absolute (UTC) sources are converted with the FINAL zone, so a later location or zone change can't shift the instant
  const t = d ? (d.u != null ? utcToNaive(zone, d.u) : d.t) : null;
  const off = t == null ? null : it.zone ? offsetFor(it.zone, t) : d && d.off != null ? d.off : offsetFor(zone, t);
  const wDate = !!d && d.src !== "existing" && (overwrite || !exDate || d.manual || (exDate.dateOnly && t != null && dayOnly(t) === dayOnly(exDate.t)));
  const wGps = !!l && l.src !== "existing" && (overwrite || !ex.gps || l.manual);
  // add a missing time zone to an existing date once the place is known
  const offsetOnly = !wDate && !!exDate && exDate.off == null && !!(l || ex.gps) && t != null;
  const wDev = (it.dev || "none") !== "none" && (wDate || wGps) && (overwrite || !ex.device);
  return { t, off, zone, la: l ? l.la : null, lo: l ? l.lo : null, alt: l ? l.alt ?? null : null, write: { date: wDate, gps: wGps, device: wDev, offsetOnly }, any: wDate || wGps || wDev || offsetOnly };
}

export function status(it) {
  if (it.out) return it.out.ok ? "done" : "failed";
  if (it.exState === "pending") return "loading";
  const p = plan(it);
  const hasDate = !!(it.date || (it.ex && it.ex.date && !it.ex.date.weak));
  if (!p.any) return hasDate ? "ok" : "needs";
  if (!hasDate) return "needs";
  return it.ready ? "ready" : "review";
}
export const STATUS_LABEL = { loading: "Reading", needs: "Needs info", review: "Review", ready: "Ready", done: "Done", failed: "Failed", ok: "Complete" };

export function warnings(it) {
  const w = [], p = plan(it);
  if (it.date && it.date.src === "ai" && it.date.conf < 0.4) w.push("Low-confidence date estimate: check it before accepting.");
  if (it.date && !inCtxDate(it.date.t)) w.push("Date is outside your trip dates.");
  if (it.loc && !inCtxArea(it.loc.la, it.loc.lo)) w.push("Location is outside your trip area.");
  const pr = profileFor(it.dev, p.t);
  if (pr && it.dev !== "era" && p.t != null && pr.released > p.t) w.push(`${pr.model} was released after this date.`);
  if (p.write.date && p.off == null) w.push("No time zone known: the date will be written without an offset.");
  if (it.ex && it.ex.issue) w.push(it.ex.issue);
  if (it.realExt) w.push(`This file is really a ${it.realExt.toUpperCase()} but is named .${it.name.replace(/^.*\./, "").toLowerCase()}. It will be saved as .${it.realExt}.`);
  if (it.date && it.date.src === "mtime") w.push("File modified time is usually the copy date, not the capture date.");
  return w;
}
export function describe(it) {
  const p = plan(it), parts = [];
  if (it.date) parts.push(human(it.date.t).slice(0, 16)); else if (it.ex && it.ex.date && it.ex.date.t) parts.push(human(it.ex.date.t).slice(0, 16));
  if (it.loc && it.loc.place) parts.push(String(it.loc.place).split(",")[0]);
  else if (it.loc) parts.push(`${it.loc.la.toFixed(2)}, ${it.loc.lo.toFixed(2)}`);
  return parts.join(" . ") || (it.exState === "pending" ? "Reading..." : "No date");
}
export { human, dayOnly, naive, fmtOffset, offsetFor, zoneLabel };
