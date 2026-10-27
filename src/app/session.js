// Saves unfinished work in this browser so an interruption (reload, closed tab, crash) doesn't mean starting again,
// and clears it after 30 minutes without activity. The files stay on this device: nothing here uses the network.
import * as C from "./cache.js";

export const IDLE_MS = 30 * 60 * 1000;
export const cfg = { idleMs: IDLE_MS, tickMs: 1500, now: () => Date.now(), maxFile: 600e6, maxTotal: 2e9 };

let H = null, timer = null, lastActive = 0, metaWritten = 0, staleBefore = false, expired = false, tickBusy = false;
let held = false, lastSig = "", used = 0, quotaHit = false, dropped = 0, on = () => {};
const stored = new Set(), skipped = new Map(), outVer = new WeakMap(); let verN = 0;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const sizeOf = (b) => (b && b.size) || 0;

/** While an earlier session is waiting for Resume or Discard, nothing is written over it. */
export const hold = (v) => { held = !!v; };
export const tagOut = (o, n) => { if (o) { outVer.set(o, n); verN = Math.max(verN, n); } };
export const status = () => ({ lastActive, expired, used, quotaHit, dropped, keys: stored.size });

/** Stores one value once. Returns false when it was not kept (too large, no room). */
async function ensure(key, make, size) {
  if (stored.has(key)) return true;
  if (size > cfg.maxFile || used + size > cfg.maxTotal) return false;
  if (skipped.has(key) && cfg.now() < skipped.get(key)) return false;       // a failed write is tried again after a pause
  if (size > (await C.room()) * 0.8) { skipped.set(key, cfg.now() + 30000); return false; }
  try { await C.put(key, make()); stored.add(key); skipped.delete(key); used += size; return true; }
  catch (e) { skipped.set(key, cfg.now() + 30000); if (/quota/i.test(String(e && (e.name || e.message)))) quotaHit = true; return false; }
}

function onActivity() {
  const t = cfg.now();
  if (lastActive && t - lastActive > cfg.idleMs) staleBefore = true;
  lastActive = t;
  if (expired) { expired = false; lastSig = ""; }   // working again after a clear: a new window starts and the work is saved again
}

async function expire() {
  try { await C.clear(); } catch (e) {}
  stored.clear(); skipped.clear(); used = 0; lastSig = ""; metaWritten = 0; expired = true; on("expired");
}

async function tick(force) {
  if (tickBusy || !H) return; tickBusy = true;
  try {
    const t = cfg.now();
    if (H.isBusy()) lastActive = t;
    if (staleBefore || t - lastActive > cfg.idleMs) {
      const wasStale = staleBefore; staleBefore = false;
      if (!expired) await expire();
      if (!wasStale) return;            // still idle: stay cleared
      expired = false;                 // the person is back: a new 30 minute window starts and the work is saved again
    }
    if (expired) return;
    if (held) { if (t - metaWritten > 10000) { await C.put("meta", { lastActive }); metaWritten = t; } return; }
    const rec = H.getRecover(), san = H.getSan(), want = new Set(["meta", "session"]);
    dropped = 0;
    const ritems = [];
    for (const it of rec.items) {
      if (!it.cid) it.cid = uid();
      const sk = `r:${it.cid}:src`; want.add(sk);
      if (!(await ensure(sk, () => it.file, it.size))) { dropped++; continue; }
      const m = { cid: it.cid, path: it.path, name: it.name, size: it.size, mtime: it.mtime, type: it.file.type || "", exState: it.exState === "done" ? "done" : "pending", exErr: it.exErr || null, realExt: it.realExt || null,
        ai: it.ai || null, aiErr: it.aiErr || null, date: it.date || null, loc: it.loc || null, locCleared: !!it.locCleared, dev: it.dev ?? null, zone: it.zone || null, ready: !!it.ready, auth: it.auth || null, hasEx: false, out: null };
      if (it.exRaw) { const ek = `r:${it.cid}:ex`; want.add(ek); m.hasEx = await ensure(ek, () => it.exRaw, 4000); }
      if (it.out) {
        let n = outVer.get(it.out); if (!n) { n = ++verN; outVer.set(it.out, n); }
        const ok = `r:${it.cid}:out:${n}`; want.add(ok);
        const o = it.out, kept = o.bytes ? await ensure(ok, () => new Blob([o.bytes]), o.bytes.byteLength || o.bytes.size || 0) : false;
        m.out = { ok: o.ok, diffs: o.diffs, name: o.name, dir: o.dir, key: o.key, summary: o.summary, mt: o.mt, plan: o.plan, ver: n, kept };
      }
      ritems.push(m);
    }
    const sents = [];
    if (san) for (const e of san.entries) {
      if (!e.cid) e.cid = uid();
      const sk = `s:${e.cid}:src`; want.add(sk);
      if (!(await ensure(sk, () => e.file, e.size))) { dropped++; continue; }
      const m = { cid: e.cid, path: e.path, name: e.name, size: e.size, mtime: e.file.lastModified || null, type: e.file.type || "", state: e.state === "working" ? "queued" : e.state, msg: e.msg, kind: e.kind, key: e.key || null, rep: e.rep, checks: e.checks, limits: e.limits, ms: e.ms, tries: e.tries, allowAux: !!e.allowAux, allowRedraw: !!e.allowRedraw, out: null };
      if (e.out) { const ok = `s:${e.cid}:out:${e.out.name}`; want.add(ok); m.out = { name: e.out.name, size: e.out.size, kept: await ensure(ok, () => e.out.blob, e.out.size) }; }
      sents.push(m);
    }
    const sess = { v: 1, mode: H.getMode(), recover: ritems.length || rec.cars.length ? { items: ritems, cars: rec.cars, focus: rec.focus, filter: rec.filter } : null, san: san && sents.length ? { entries: sents, opts: san.opts } : null, dropped, quotaHit };
    const stale = [...stored].filter((k) => !want.has(k));
    const empty = !sess.recover && !sess.san, sig = JSON.stringify(sess), changed = sig !== lastSig || force;
    if (changed) {
      if (empty) { try { await C.del(["session"]); } catch (e) {} } else { sess.savedAt = t; await C.put("session", sess); }
      lastSig = sig;
    }
    if (changed || t - metaWritten > 10000) { await C.put("meta", { lastActive }); metaWritten = t; }
    // remove what is no longer in use (files the person removed or cleared) only after the record no longer points at it
    if (stale.length) { try { await C.del(stale); for (const k of stale) stored.delete(k); } catch (e) {} }
    if (quotaHit || dropped) on("partial");
  } catch (e) { /* the cache is a convenience: never break the app */ }
  finally { tickBusy = false; }
}

/** Starts saving. `hooks`: getRecover(), getSan(), getMode(), isBusy(). */
export function start(hooks, onEvent) {
  H = hooks; on = onEvent || (() => {}); lastActive = cfg.now();
  for (const ev of ["pointerdown", "keydown", "input", "change", "drop", "touchstart", "wheel"]) addEventListener(ev, onActivity, { capture: true, passive: true });
  addEventListener("pagehide", () => { tick(true); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") tick(true); else tick(); });
  clearInterval(timer); timer = setInterval(() => tick(), cfg.tickMs);
}
export const flush = () => tick(true);
export const touch = () => onActivity();

/** Looks for saved work from an earlier visit. Clears it (and returns null) if it is older than the idle limit. */
export async function find() {
  try {
    if (!(await C.available())) return null;
    const [meta, sess] = await Promise.all([C.get("meta"), C.get("session")]);
    if (!sess) return null;
    if (!meta || cfg.now() - meta.lastActive > cfg.idleMs) { await C.clear(); return null; }
    return sess;
  } catch (e) { return null; }
}
export async function discard() {
  try { await C.clear(); } catch (e) {}
  stored.clear(); skipped.clear(); used = 0; lastSig = ""; dropped = 0; quotaHit = false;
}
export async function present() { try { return (await C.available()) && !!(await C.get("session")); } catch (e) { return false; } }

const asFile = (blob, m) => {
  const f = new File([blob], m.name, { type: m.type || blob.type, lastModified: m.mtime || undefined });
  if (m.path && m.path.includes("/")) { try { Object.defineProperty(f, "webkitRelativePath", { value: m.path }); } catch (e) {} }
  return f;
};
/** Turns a saved session back into files and records. Entries whose file was not kept are counted, not restored. */
export async function load(sess) {
  const out = { mode: sess.mode, recover: null, san: null, missing: 0, notKept: sess.dropped || 0 };
  const existing = new Set(await C.keys());
  for (const k of existing) stored.add(k);
  if (sess.recover) {
    const items = [];
    for (const m of sess.recover.items) {
      const blob = await C.get(`r:${m.cid}:src`); if (!blob) { out.missing++; continue; }
      const rec = { m, file: asFile(blob, m), exRaw: m.hasEx ? (await C.get(`r:${m.cid}:ex`)) || null : null, bytes: null };
      if (m.out && m.out.kept) { const b = await C.get(`r:${m.cid}:out:${m.out.ver}`); if (b) rec.bytes = new Uint8Array(await b.arrayBuffer()); else m.out = null; }
      else if (m.out) m.out = null;
      used += m.size; items.push(rec);
    }
    out.recover = { items, cars: sess.recover.cars || [], focus: sess.recover.focus, filter: sess.recover.filter };
  }
  if (sess.san) {
    const entries = [];
    for (const m of sess.san.entries) {
      const blob = await C.get(`s:${m.cid}:src`); if (!blob) { out.missing++; continue; }
      let o = null;
      if (m.out && m.out.kept) { const b = await C.get(`s:${m.cid}:out:${m.out.name}`); if (b) o = { blob: b, name: m.out.name, size: m.out.size }; }
      const e = { ...m, file: asFile(blob, m), out: o };
      if (!o && (e.state === "verified" || e.state === "limited")) { e.state = "queued"; e.msg = ""; }
      used += m.size; entries.push(e);
    }
    out.san = { entries, opts: sess.san.opts };
  }
  lastSig = ""; lastActive = cfg.now();
  return out;
}

/** What the saved work contains, for the resume banner. */
export function describe(sess) {
  const r = sess.recover && sess.recover.items || [], s = sess.san && sess.san.entries || [];
  return {
    savedAt: sess.savedAt, mode: sess.mode, notKept: sess.dropped || 0,
    san: s.length ? { total: s.length, done: s.filter((e) => e.state === "verified" || e.state === "limited").length, failed: s.filter((e) => e.state === "failed" || e.state === "unsupported").length } : null,
    recover: r.length ? { total: r.length, ai: r.filter((x) => x.ai).length, ready: r.filter((x) => x.ready && !x.out).length, exported: r.filter((x) => x.out && x.out.ok).length } : null,
  };
}
