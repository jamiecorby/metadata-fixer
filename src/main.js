// Metadata Fixer - application shell and UI.
import { zipSync } from "fflate";
import { CONFIG } from "./config.js";
import { S, MONTHS, PHOTO, VIDEO, newItem, rezone, dateCands, locCands, autopick, applyAiTop, plan, status, STATUS_LABEL, warnings, describe, itemZone, zoneLabel, monthCtx, rangeCtx, inCtxDate, inCtxArea, zoneAt } from "./app/model.js";
import { human, exif, parseStamp, naive } from "./core/time.js";
import { offsetFor, fmtOffset, allZones, isZone, parseFixed, localZone } from "./core/tz.js";
import { interpretExisting, realExt } from "./core/existing.js";
import { parseTakeout, parseXmp, sidecarMatcher, isSidecar } from "./core/sidecars.js";
import { buildTags, verify } from "./core/tags.js";
import { IPHONES, profileFor } from "./core/devices.js";
import { BUILTIN, applyPattern, usesSeq } from "./core/naming.js";
import { engine, onEngine, loadEngine, readTags, writeTags, readMany, writeMany } from "./app/engine.js";
import { makeThumb, aiImage } from "./app/media.js";
import { suggest, aiMode, ownKey } from "./app/ai.js";
import { acct, onAccount, initAccount, signIn, signOut, buy, refreshCredits } from "./app/account.js";
import * as store from "./app/store.js";
import { pickLocation } from "./app/map.js";

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
const byId = (id) => S.items.find((x) => x.id === id);
const mobile = () => matchMedia("(max-width:900px)").matches;
let toastT = null;
function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms); }
function setStatus(html) { $("#status").innerHTML = html; }

S.settings = store.loadSettings();
if (!isZone(S.settings.zone) && parseFixed(S.settings.zone) == null) S.settings.zone = localZone();
const savedCtx = store.loadCtx(); if (savedCtx) Object.assign(S.ctx, savedCtx);
const persistSettings = () => store.saveSettings(S.settings);
const persistCtx = () => store.saveCtx(S.ctx);

/* ------------------------------------------------------------------ files */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
async function addFiles(list) {
  const files = [...list].filter((f) => !f.name.startsWith(".") && f.size > 0);
  const media = files.filter((f) => PHOTO.test(f.name) || VIDEO.test(f.name));
  const cars = files.filter((f) => isSidecar(f.name));
  const skipped = files.length - media.length - cars.length;
  let carOk = 0;
  for (const f of cars) {
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name)) { const d = parseTakeout(text); if (d) { S.cars.push({ name: f.name, kind: "takeout", data: d }); carOk++; } }
      else { const d = parseXmp(text); if (d) { S.cars.push({ name: f.name.replace(/^.*\//, ""), kind: "xmp", data: d }); carOk++; } }
    } catch (e) {}
  }
  S.match = sidecarMatcher(S.cars);
  const known = new Set(S.items.map((x) => x.path + "|" + x.size));
  const fresh = media.filter((f) => !known.has((f.webkitRelativePath || f.name) + "|" + f.size)).map(newItem);
  S.items.push(...fresh);
  S.items.sort((a, b) => collator.compare(a.path, b.path));
  if (carOk) for (const it of S.items) { it.side = S.match(it.name); if (it.exState === "done") autopick(it); }
  if (!S.items.length) { toast(skipped ? "None of those files are photos or videos this can fix." : "No files added."); return; }
  showWork();
  if (S.focus == null && fresh.length) { S.focus = fresh[0].id; S.sel = new Set([fresh[0].id]); }
  const msg = [fresh.length && `Added ${plural(fresh.length, "file")}`, carOk && `${plural(carOk, "sidecar")} matched by name`, skipped && `${skipped} unsupported skipped`, media.length - fresh.length > 0 && `${media.length - fresh.length} already added`].filter(Boolean).join(" . ");
  toast(msg || "Nothing new to add.");
  renderAll();
  readQueue(fresh);
}
async function readQueue(items) {
  loadEngine().catch(() => {});
  for (const it of items) it.side = S.match ? S.match(it.name) : null;
  for (let i = 0; i < items.length; i += 40) {
    const part = items.slice(i, i + 40);
    const ok = part.filter((x) => x.size <= 1.5e9);
    let res = new Map();
    try { res = await readMany(ok.map((x) => ({ id: x.id, blob: x.file, name: x.name }))); }
    catch (e) { for (const x of ok) res.set(x.id, e); }
    for (const it of part) {
      const r = it.size > 1.5e9 ? new Error("This file is too large to process in the browser (over 1.5 GB).") : res.get(it.id);
      if (r instanceof Error || !r) { it.ex = { date: null, gps: null, device: null }; it.exErr = r ? r.message : "Could not read this file."; }
      else { it.exRaw = r; it.ex = interpretExisting(r, it.kind); it.realExt = realExt(it.ex.fileExt, it.name); }
      it.exState = "done"; autopick(it); updateTile(it);
    }
    renderFilters(); renderBar();
    if (part.some((x) => x.id === S.focus || S.sel.has(x.id))) renderInspector();
  }
  // neighbours may now give better suggestions to earlier files
  for (const it of S.items) autopick(it);
  renderAll();
}
function showWork() { $("#landing").hidden = true; $("#work").hidden = false; $("#bar").hidden = false; document.body.classList.add("working"); }

/* ------------------------------------------------------------------ grid */
const tiles = new Map();
const io = "IntersectionObserver" in window ? new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { const it = byId(+e.target.dataset.id); if (it && !it.thumb && !it.prevErr) makeThumb(it).then(() => updateTile(it)); io.unobserve(e.target); } }, { rootMargin: "400px" }) : null;

const RANK = { needs: 0, loading: 0, review: 1, failed: 1, ready: 2, done: 3, ok: 4 };
// One pass computes every file's status, the visible list and the counts; it is reused until something changes.
let _view = null;
const dirty = () => { _view = null; };
function computeView() {
  const st = new Map(); for (const it of S.items) st.set(it.id, status(it));
  const f = S.filter;
  const vis = S.items.filter((it) => { const s = st.get(it.id); return f === "all" || (f === "done" ? s === "done" || s === "ok" : f === "needs" ? s === "needs" || s === "loading" : s === f); });
  const tOf = (x) => (x.date ? x.date.t : x.ex && x.ex.date && x.ex.date.t != null ? x.ex.date.t : Infinity);
  if (S.sort === "date") vis.sort((a, b) => tOf(a) - tOf(b) || collator.compare(a.path, b.path));
  else if (S.sort === "status") vis.sort((a, b) => RANK[st.get(a.id)] - RANK[st.get(b.id)] || collator.compare(a.path, b.path));
  const c = { all: S.items.length, needs: 0, review: 0, ready: 0, done: 0, failed: 0 };
  for (const it of S.items) { const s = st.get(it.id); if (s === "needs" || s === "loading") c.needs++; else if (s === "ok" || s === "done") c.done++; else c[s]++; }
  return { st, vis, counts: c };
}
const view = () => _view || (_view = computeView());
const visible = () => view().vis;
const counts = () => view().counts;
const stOf = (it) => { const s = view().st.get(it.id); return s === undefined ? status(it) : s; };
function tileHtml(it, known) {
  const s = known || status(it);
  return `${it.thumb ? `<img class="th" src="${it.thumb}" alt="" loading="lazy" decoding="async">` : `<div class="ph">${it.prevErr ? "No preview" : it.kind === "video" ? "Video" : "..."}</div>`}
  <span class="st st-${s}">${STATUS_LABEL[s]}</span>${it.kind === "video" ? '<span class="vid">VIDEO</span>' : ""}<span class="ck" data-ck="1"></span>
  <div class="meta"><div class="nm" title="${esc(it.path)}">${esc(it.name)}</div><div class="ds">${esc(describe(it))}</div></div>`;
}
function updateTile(it, known, keep) {
  if (!keep) dirty();
  const el = tiles.get(it.id); if (!el) return;
  const s = known || status(it);
  el.className = `tile st-${s}${S.sel.has(it.id) ? " sel" : ""}${S.focus === it.id ? " focus" : ""}`;
  el.innerHTML = tileHtml(it, s);
  el.setAttribute("aria-selected", S.sel.has(it.id) ? "true" : "false");
  el.tabIndex = S.focus === it.id ? 0 : -1;
}
/** Selection or focus changed: toggle classes only (no re-render of tile contents). */
function paintSel() {
  $("#grid").classList.toggle("selecting", S.selectMode || S.sel.size > 1);
  let tabbable = false;
  for (const [id, el] of tiles) {
    const on = S.sel.has(id), fo = S.focus === id;
    if (el.classList.contains("sel") !== on) { el.classList.toggle("sel", on); el.setAttribute("aria-selected", on ? "true" : "false"); }
    if (el.classList.contains("focus") !== fo) el.classList.toggle("focus", fo);
    el.tabIndex = fo ? 0 : -1; if (fo) tabbable = true;
  }
  if (!tabbable) { const f = visible()[0]; const el = f && tiles.get(f.id); if (el) el.tabIndex = 0; }
}
function selChanged() { paintSel(); renderFilters(); renderInspector(); renderBar(); }
function renderGrid() {
  const g = $("#grid"), v = view(), list = v.vis;
  g.classList.toggle("selecting", S.selectMode || S.sel.size > 1);
  if (!list.length) { g.innerHTML = `<div class="empty">${S.items.length ? "Nothing in this view." : "No files yet."}</div>`; return; }
  const frag = document.createDocumentFragment();
  for (const it of list) {
    let el = tiles.get(it.id);
    if (!el) { el = document.createElement("div"); el.dataset.id = it.id; el.tabIndex = 0; el.setAttribute("role", "option"); tiles.set(it.id, el); io && io.observe(el); if (!io) makeThumb(it).then(() => updateTile(it)); }
    updateTile(it, v.st.get(it.id), true); frag.appendChild(el);
  }
  g.replaceChildren(frag);
  if (!list.some((x) => x.id === S.focus)) { const el = tiles.get(list[0].id); if (el) el.tabIndex = 0; }
}
function renderFilters() {
  const c = counts();
  const defs = [["all", "All"], ["needs", "Needs info"], ["review", "Review"], ["ready", "Ready"], ["done", "Done"]].concat(c.failed ? [["failed", "Failed"]] : []);
  $("#filters").innerHTML = defs.map(([k, l]) => `<button role="tab" data-f="${k}" aria-selected="${S.filter === k}">${l}<span class="ct">${c[k]}</span></button>`).join("");
  const vis = visible(), selVis = vis.filter((x) => S.sel.has(x.id)).length;
  $("#selall").checked = vis.length > 0 && selVis === vis.length; $("#selall").indeterminate = selVis > 0 && selVis < vis.length;
  $("#selcount").textContent = S.sel.size > 1 ? `${S.sel.size} selected` : "Select all";
}
function renderCtxLine() {
  const parts = [], mc = monthCtx(), r = rangeCtx();
  if (S.ctx.start && S.ctx.end) parts.push(`${S.ctx.start} to ${S.ctx.end}`); else if (mc) parts.push(MONTHS[mc.m - 1] + (mc.y ? " " + mc.y : ""));
  if (S.ctx.area) parts.push(`${S.ctx.area.name ? S.ctx.area.name.split(",")[0] : "area"} (${S.ctx.area.r} km)`);
  if (S.ctx.hint) parts.push(`"${S.ctx.hint.slice(0, 40)}"`);
  $("#ctxline").textContent = parts.length ? "Trip: " + parts.join(" . ") : "";
  $("#btn-fill").disabled = !(S.ctx.area || (r && mc && mc.y) || (S.ctx.start && S.ctx.end));
}
function renderBar() {
  if (S.busy) return;
  const sel = selected(), c = counts();
  const aiT = aiTargets(), rdT = readyTargets();
  $("#b-ai").textContent = `AI suggest${aiT.length ? " (" + aiT.length + ")" : ""}`; $("#b-ai").disabled = !aiT.length;
  $("#b-ready").textContent = `Mark ready${rdT.length ? " (" + rdT.length + ")" : ""}`; $("#b-ready").disabled = !rdT.length;
  $("#b-export").textContent = `Export${c.ready ? " (" + c.ready + ")" : ""}`; $("#b-export").disabled = !c.ready;
  const loading = S.items.filter((x) => x.exState === "pending").length;
  setStatus(loading ? `Reading metadata... ${S.items.length - loading} of ${S.items.length}` : `${plural(S.items.length, "file")} . ${c.needs} need info . ${c.review} to review . ${c.ready} ready${sel.length > 1 ? ` . <b>${sel.length} selected</b>` : ""}`);
}
function renderAll() { dirty(); renderFilters(); renderGrid(); renderCtxLine(); renderInspector(); renderBar(); }
function refresh(it) { dirty(); if (it) updateTile(it); renderFilters(); renderInspector(); renderBar(); }
const selected = () => S.items.filter((x) => S.sel.has(x.id));
const aiTargets = () => { const sel = selected(); return (sel.length > 1 ? sel : S.items.filter((x) => stOf(x) === "needs")).filter((x) => x.exState === "done" && !x.out); };
const readyTargets = () => { const sel = selected(); return (sel.length > 1 ? sel : S.items).filter((x) => stOf(x) === "review"); };

/* ------------------------------------------------------------------ inspector */
const toLocalInput = (t) => (t == null ? "" : human(t).replace(" ", "T"));
const fromLocalInput = (v) => { const p = parseStamp(String(v || "").replace("T", " ")); return p ? p.t : null; };
const confBar = (c) => (c == null ? "" : `<span class="conf" title="${Math.round(c * 100)}% confidence"><i style="width:${Math.round(c * 100)}%"></i></span> ${Math.round(c * 100)}%`);
const SRC = { existing: "In the file", takeout: "Takeout sidecar", xmp: "XMP sidecar", filename: "File name", ai: "AI estimate", sequence: "Neighbouring files", context: "Your trip details", mtime: "File modified time", manual: "Entered by you", map: "Picked on map" };
function devOptions(v, withKeep) {
  return `${withKeep ? '<option value="">(no change)</option>' : ""}<option value="era"${v === "era" ? " selected" : ""}>iPhone matched to the date</option><option value="none"${v === "none" ? " selected" : ""}>Don't add device details</option>` + IPHONES.map((p) => `<option${v === p.model ? " selected" : ""}>${p.model}</option>`).join("");
}
let zoneList = null;
function zoneDatalist() { if (!zoneList) { zoneList = document.createElement("datalist"); zoneList.id = "zones"; zoneList.innerHTML = allZones().map((z) => `<option value="${z}">`).join(""); document.body.appendChild(zoneList); } }
let showAll = { d: false, l: false };

function renderInspector() {
  const el = $("#insp"); if (!el) return;
  const sel = selected();
  if (sel.length > 1) return renderBulk(el, sel);
  const it = byId(S.focus);
  if (!it) { document.body.classList.remove("sheet"); el.innerHTML = `<div class="empty">Pick a file to see its details.<br><br>Tip: select several (tick, Shift-click or <b>Select</b>) to fix them together.</div>`; el.classList.remove("open"); return; }
  zoneDatalist();
  const s = status(it), p = plan(it), dc = dateCands(it), lc = locCands(it);
  const d = it.date, l = it.loc, ex = it.ex || {};
  const built = buildTags({ kind: it.kind, t: p.t, off: p.off, la: p.la, lo: p.lo, alt: p.alt, dev: it.dev, full: S.settings.full, label: S.settings.label, write: p.write });
  const w = warnings(it);
  const idx = visible().indexOf(it), vis = visible();
  const exLine = it.exState === "pending" ? "Reading..." : [ex.date ? `date ${ex.date.t != null ? human(ex.date.t) : human(ex.date.u) + " UTC"}${ex.date.off != null ? " " + fmtOffset(ex.date.off) : ""}` : "no date", ex.gps ? `GPS ${ex.gps.la.toFixed(4)}, ${ex.gps.lo.toFixed(4)}` : "no GPS", ex.device && ex.device.model ? ex.device.model : "no device"].join(" . ");
  const sideLine = [it.side && it.side.takeoutName && `Takeout: ${it.side.takeoutName}`, it.side && it.side.xmpName && `XMP: ${it.side.xmpName}`].filter(Boolean).join(" . ");
  const candBtn = (c, i, kind) => { const on = kind === "d" ? d && d.src === c.src && Math.abs(d.t - c.t) < 1000 : l && Math.abs(l.la - c.la) < 1e-6 && Math.abs(l.lo - c.lo) < 1e-6; const v = kind === "d" ? human(c.t) + (c.off != null ? " " + fmtOffset(c.off) : "") : `${c.la.toFixed(4)}, ${c.lo.toFixed(4)}`; return `<button type="button" class="cand${on ? " on" : ""}" data-${kind}c="${i}"><span class="v">${esc(v)}</span><span class="l">${esc(c.label)}${c.note ? " . " + esc(c.note) : ""} ${confBar(c.conf)}</span></button>`; };
  const nD = showAll.d ? dc.length : 3, nL = showAll.l ? lc.length : 3;
  const zoneTxt = p.t != null ? `${it.zone ? esc(it.zone) : esc(zoneLabel(p.zone))}${p.off != null ? " (UTC" + fmtOffset(p.off) + ")" : ""}${it.zone ? "" : d && d.off != null && !it.zone ? " from the source" : l || (ex.gps) ? " from the location" : " default"}` : "";
  el.innerHTML = `
  <h2 class="sr-only">File details</h2>
  <div class="irow"><button class="ghost small back" id="i-back">&larr; Back</button><span class="badge st-${s}">${STATUS_LABEL[s]}</span><span class="rowx"><button class="ghost small" id="i-prev" ${idx <= 0 ? "disabled" : ""} aria-label="Previous">&larr;</button><button class="ghost small" id="i-next" ${idx < 0 || idx >= vis.length - 1 ? "disabled" : ""} aria-label="Next">&rarr;</button></span></div>
  <div style="margin-top:8px">${it.prevUrl ? `<img class="pv" src="${it.prevUrl}" alt="Preview of ${esc(it.name)}">` : `<div class="pvph">${it.prevErr ? esc(it.prevErr) : "Loading preview..."}</div>`}</div>
  <div class="fname" style="margin-top:8px">${esc(it.path)}</div>
  <div class="src">${(it.size / 1048576).toFixed(1)} MB . In the file: ${esc(exLine)}${sideLine ? "<br>" + esc(sideLine) : ""}${it.exErr ? `<br><span class="err">${esc(it.exErr)}</span>` : ""}</div>
  ${it.ai && it.ai.scene ? `<div class="src">AI sees: <b>${esc(it.ai.scene)}</b></div>` : ""}

  <h3>Date and time</h3>
  ${d ? `<div class="src"><b>${SRC[d.manual && d.src === "manual" ? "manual" : d.src] || d.src}</b>${d.label && d.src !== "manual" ? " . " + esc(d.label) : ""} ${confBar(d.conf)}</div>` : '<div class="src warn">No date yet: pick a suggestion, type one, or use AI.</div>'}
  <label>Local date and time<input type="datetime-local" step="1" id="i-dt" value="${toLocalInput(d ? d.t : null)}"></label>
  <label>Time zone <span class="note">(leave blank for automatic: ${esc(zoneLabel(p.zone))})</span><input id="i-zone" list="zones" placeholder="Automatic" value="${esc(it.zone || "")}"></label>
  ${zoneTxt ? `<div class="src">Offset: <b>${zoneTxt}</b></div>` : ""}
  <div class="cands">${dc.slice(0, nD).map((c, i) => candBtn(c, i, "d")).join("")}</div>
  ${dc.length > 3 ? `<button type="button" class="more" id="i-moreD">${showAll.d ? "Fewer" : "All " + dc.length + " suggestions"}</button>` : ""}

  <h3>Location</h3>
  ${l ? `<div class="src"><b>${SRC[l.src] || l.src}</b>${l.place ? " . " + esc(l.place) : ""} ${confBar(l.conf)}</div>` : '<div class="src">No location. Optional, but it also fixes the time zone.</div>'}
  <div class="two" style="margin-top:6px"><label>Latitude<input id="i-la" inputmode="decimal" value="${l ? l.la : ""}"></label><label>Longitude<input id="i-lo" inputmode="decimal" value="${l ? l.lo : ""}"></label></div>
  <div class="rowx" style="margin-top:8px"><button type="button" id="i-map">Pick on map</button>${l ? '<button type="button" class="ghost" id="i-noloc">Remove</button>' : ""}</div>
  <div class="cands">${lc.slice(0, nL).map((c, i) => candBtn(c, i, "l")).join("")}</div>
  ${lc.length > 3 ? `<button type="button" class="more" id="i-moreL">${showAll.l ? "Fewer" : "All " + lc.length + " suggestions"}</button>` : ""}

  <h3>Device</h3>
  <select id="i-dev" aria-label="Device">${devOptions(it.dev || "era")}</select>

  ${w.length ? `<div class="warnbox">${w.map(esc).join("<br>")}</div>` : ""}
  <h3>Will be written</h3>
  <div class="wplan">${built.summary.length ? esc(built.summary.join("\n")) : p.any ? "" : ex.date ? "Nothing: this file already has a date" + (S.settings.policy === "fill" ? " (fill-missing mode keeps it)" : "") + "." : "Nothing yet."}</div>
  ${it.out ? `<div class="src ${it.out.ok ? "okc" : "err"}" style="margin-top:6px">${it.out.ok ? "Written and verified." : "Verification failed: " + esc(it.out.diffs.join("; "))}</div>` : ""}
  <div class="actions">
    <button type="button" id="i-ai">${it.aiState === "busy" ? "Looking..." : it.ai ? "Ask AI again" : "AI suggest"}</button>
    ${s === "ready" ? '<button type="button" id="i-unready">Unmark</button>' : `<button type="button" class="pri" id="i-ready" ${s === "review" ? "" : "disabled"}>Mark ready</button>`}
    <button type="button" class="ghost" id="i-reset">Reset</button>
  </div>
  ${it.aiErr ? `<p class="note err">${esc(it.aiErr)}</p>` : ""}
  <p class="note">${aiMode() === "account" ? "AI suggest uses 1 credit." : aiMode() === "own" ? "AI uses your own API key." : ""}</p>`;
  el.classList.toggle("open", mobile() && S.insOpen === true); document.body.classList.toggle("sheet", mobile() && S.insOpen === true);
  const on = (id, ev, fn) => { const x = $("#" + id, el); if (x) x[ev] = fn; };
  on("i-back", "onclick", () => { S.insOpen = false; el.classList.remove("open"); document.body.classList.remove("sheet"); });
  on("i-prev", "onclick", () => focusItem(vis[idx - 1]));
  on("i-next", "onclick", () => focusItem(vis[idx + 1]));
  on("i-moreD", "onclick", () => { showAll.d = !showAll.d; renderInspector(); });
  on("i-moreL", "onclick", () => { showAll.l = !showAll.l; renderInspector(); });
  el.querySelectorAll("[data-dc]").forEach((b) => (b.onclick = () => { const c = dc[+b.dataset.dc]; it.date = { ...c, manual: true }; touched(it); }));
  el.querySelectorAll("[data-lc]").forEach((b) => (b.onclick = () => { const c = lc[+b.dataset.lc]; it.loc = { ...c, manual: true }; touched(it); }));
  on("i-dt", "onchange", (e) => { const t = fromLocalInput(e.target.value); if (t == null) { if (e.target.value) toast("That date isn't valid."); return; } it.date = { t, off: null, src: "manual", label: "Entered by you", conf: 1, manual: true }; touched(it); });
  on("i-zone", "onchange", (e) => { const v = e.target.value.trim(); if (!v) { it.zone = null; touched(it); return; } if (isZone(v) || parseFixed(v) != null) { it.zone = v; touched(it); } else toast("Unknown time zone. Try a city zone like Europe/Lisbon or an offset like +01:00."); });
  const setLL = () => { const a = parseFloat($("#i-la", el).value), b = parseFloat($("#i-lo", el).value); if ($("#i-la", el).value === "" && $("#i-lo", el).value === "") { it.loc = null; touched(it); return; } if (!(Math.abs(a) <= 90 && Math.abs(b) <= 180)) { toast("Latitude must be -90 to 90 and longitude -180 to 180."); return; } it.loc = { la: a, lo: b, alt: null, zone: zoneAt(a, b), src: "manual", label: "Entered by you", conf: 1, manual: true }; touched(it); };
  on("i-la", "onchange", setLL); on("i-lo", "onchange", setLL);
  on("i-map", "onclick", async () => { const r = await pickLocation({ title: "Where was " + it.name + " taken?", la: l ? l.la : S.ctx.area ? S.ctx.area.la : undefined, lo: l ? l.lo : S.ctx.area ? S.ctx.area.lo : undefined, name: l && l.place }); if (r) { it.loc = { la: r.la, lo: r.lo, alt: null, zone: r.zone, place: r.name, src: "map", label: "Picked on map", conf: 1, manual: true }; touched(it); } });
  on("i-noloc", "onclick", () => { it.loc = null; it.locCleared = true; touched(it); });
  on("i-dev", "onchange", (e) => { it.dev = e.target.value; touched(it); });
  on("i-ai", "onclick", () => runAI([it]));
  on("i-ready", "onclick", () => { it.ready = true; refresh(it); const nx = vis.find((x, j) => j > idx && status(x) === "review"); if (nx) focusItem(nx); toast(`${it.name} is ready.`); });
  on("i-unready", "onclick", () => { it.ready = false; refresh(it); });
  on("i-reset", "onclick", () => { it.date = null; it.loc = null; it.zone = null; it.ready = false; it.out = null; it.dev = S.settings.dev; autopick(it); refresh(it); });
}
function touched(it) { rezone(it); it.out = null; if (it.ready && status(it) !== "ready") it.ready = false; refresh(it); }
function focusItem(it, open = true) {
  if (!it) return;
  S.focus = it.id; S.sel = new Set([it.id]); showAll = { d: false, l: false };
  if (open) S.insOpen = true;
  paintSel();
  renderFilters(); renderInspector(); renderBar();
  const el = tiles.get(it.id); if (el && !mobile()) el.scrollIntoView({ block: "nearest" });
  if (el && !open) el.focus({ preventScroll: true });
  if (!it.thumb && !it.prevErr) makeThumb(it).then(() => { updateTile(it); if (S.focus === it.id) renderInspector(); });
}

/* ------------------------------------------------------------------ bulk edit */
function renderBulk(el, sel) {
  zoneDatalist();
  const by = {}; for (const it of sel) { const s = status(it); by[s] = (by[s] || 0) + 1; }
  const dated = sel.filter((x) => x.date).length;
  el.innerHTML = `
  <div class="irow"><button class="ghost small back" id="b-back">&larr; Back</button><h2>${sel.length} selected</h2><button class="ghost small" id="b-clear">Clear selection</button></div>
  <div class="src">${Object.entries(by).map(([k, n]) => `${n} ${STATUS_LABEL[k].toLowerCase()}`).join(" . ")}</div>
  <div class="bulkgrid" style="margin-top:12px">
   <div class="bulk"><h3 style="margin-top:0">Set date and time</h3><div class="rowx"><input type="datetime-local" step="1" id="b-dt" aria-label="Date and time"><button id="b-dt-go">Set for all</button></div>
     <p class="note">Or spread across a period in file order:</p><div class="two"><input type="datetime-local" step="1" id="b-from" aria-label="From"><input type="datetime-local" step="1" id="b-to" aria-label="To"></div><button id="b-spread" style="margin-top:6px">Spread ${sel.length} files</button></div>
   <div class="bulk"><h3 style="margin-top:0">Shift times</h3><p class="note">Fix a camera clock or time zone mistake on ${dated} dated file${dated === 1 ? "" : "s"}.</p><div class="rowx"><select id="b-sign" aria-label="Direction" style="width:auto"><option value="1">Later by</option><option value="-1">Earlier by</option></select><input id="b-h" aria-label="Hours" inputmode="numeric" placeholder="hours" style="width:90px"><input id="b-m" aria-label="Minutes" inputmode="numeric" placeholder="minutes" style="width:90px"><button id="b-shift">Shift</button></div></div>
   <div class="bulk"><h3 style="margin-top:0">Location</h3><div class="rowx"><button id="b-map">Pick on map for all</button><button class="ghost" id="b-noloc">Remove location</button></div></div>
   <div class="bulk"><h3 style="margin-top:0">Time zone and device</h3><div class="two"><label>Time zone<input id="b-zone" list="zones" placeholder="Automatic"></label><label>Device<select id="b-dev">${devOptions("", true)}</select></label></div><button id="b-zd" style="margin-top:6px">Apply</button></div>
   <div class="bulk"><h3 style="margin-top:0">Suggestions</h3><div class="rowx"><button id="b-best">Use best suggestion</button><button id="b-ai2">AI suggest (${sel.length})</button></div><p class="note">Best suggestion takes the strongest evidence for each file, including AI results already received.</p></div>
  </div>
  <div class="actions"><button class="pri" id="b-rdy">Mark ${sel.length} ready</button><button id="b-unrdy">Unmark</button></div>`;
  el.classList.toggle("open", mobile() && S.insOpen === true); document.body.classList.toggle("sheet", mobile() && S.insOpen === true);
  const apply = (fn, msg) => { let n = 0; for (const it of sel) if (fn(it) !== false) { rezone(it); it.out = null; if (it.ready && status(it) !== "ready") it.ready = false; n++; } for (const it of sel) updateTile(it); refresh(); toast(msg(n)); };
  $("#b-back").onclick = () => { S.insOpen = false; el.classList.remove("open"); document.body.classList.remove("sheet"); };
  $("#b-clear").onclick = () => { S.sel = new Set(S.focus ? [S.focus] : []); selChanged(); };
  $("#b-dt-go").onclick = () => { const t = fromLocalInput($("#b-dt").value); if (t == null) return toast("Enter a date and time first."); apply((it) => { it.date = { t, off: null, src: "manual", label: "Entered by you", conf: 1, manual: true }; }, (n) => `Date set on ${plural(n, "file")}.`); };
  $("#b-spread").onclick = () => { const a = fromLocalInput($("#b-from").value), b = fromLocalInput($("#b-to").value); if (a == null || b == null || b < a) return toast("Enter a valid start and end."); const n = sel.length; apply((it) => { const i = sel.indexOf(it); const t = Math.round((a + (n > 1 ? ((b - a) * i) / (n - 1) : 0)) / 1000) * 1000; it.date = { t, off: null, src: "manual", label: "Spread by you", conf: 1, manual: true }; }, (k) => `Spread ${plural(k, "file")} in file order.`); };
  $("#b-shift").onclick = () => { const h = parseInt($("#b-h").value || "0", 10), m = parseInt($("#b-m").value || "0", 10); if (!(h || m) || isNaN(h) || isNaN(m)) return toast("Enter hours and/or minutes."); const dt = +$("#b-sign").value * (h * 60 + m) * 60000; apply((it) => { const base = it.date ? it.date.t : it.ex && it.ex.date && it.ex.date.t; if (base == null) return false; it.date = { t: base + dt, off: null, src: "manual", label: `Shifted ${dt > 0 ? "+" : "-"}${h}h${m ? m + "m" : ""}`, conf: 1, manual: true }; }, (n) => `Shifted ${plural(n, "file")}.`); };
  $("#b-map").onclick = async () => { const f = sel.find((x) => x.loc); const r = await pickLocation({ title: `Where were these ${sel.length} taken?`, la: f ? f.loc.la : S.ctx.area && S.ctx.area.la, lo: f ? f.loc.lo : S.ctx.area && S.ctx.area.lo }); if (r) apply((it) => { it.loc = { la: r.la, lo: r.lo, alt: null, zone: r.zone, place: r.name, src: "map", label: "Picked on map", conf: 1, manual: true }; }, (n) => `Location set on ${plural(n, "file")}.`); };
  $("#b-noloc").onclick = () => apply((it) => { it.loc = null; }, (n) => `Location removed from ${plural(n, "file")}.`);
  $("#b-zd").onclick = () => { const z = $("#b-zone").value.trim(), dv = $("#b-dev").value; if (z && !isZone(z) && parseFixed(z) == null) return toast("Unknown time zone."); if (!z && !dv) return toast("Choose a time zone or a device."); apply((it) => { if (z) it.zone = z; if (dv) it.dev = dv; }, (n) => `Updated ${plural(n, "file")}.`); };
  $("#b-best").onclick = () => apply((it) => { if (it.date && it.date.manual) return false; it.date = null; it.loc = it.loc && it.loc.manual ? it.loc : null; autopick(it); applyAiTop(it); if (!it.date) { const c = dateCands(it)[0]; if (c) it.date = { ...c, manual: false }; } }, (n) => `Best suggestions applied to ${plural(n, "file")}. Review before exporting.`);
  $("#b-ai2").onclick = () => runAI(sel);
  $("#b-rdy").onclick = () => { let n = 0; for (const it of sel) if (status(it) === "review") { it.ready = true; n++; updateTile(it); } refresh(); toast(n ? `${plural(n, "file")} marked ready.` : "Nothing to mark: files need a date and a change to write."); };
  $("#b-unrdy").onclick = () => { for (const it of sel) { it.ready = false; updateTile(it); } refresh(); };
}

/* ------------------------------------------------------------------ selection + grid events */
let anchor = null;
$("#grid").addEventListener("click", (e) => {
  const tile = e.target.closest(".tile"); if (!tile) return;
  const it = byId(+tile.dataset.id); if (!it) return;
  const toggle = e.target.dataset.ck || S.selectMode || e.metaKey || e.ctrlKey;
  if (e.shiftKey && anchor != null) {
    const vis = visible(), a = vis.findIndex((x) => x.id === anchor), b = vis.indexOf(it);
    if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(vis[i].id); }
    S.focus = it.id;
  } else if (toggle) {
    if (S.sel.has(it.id)) S.sel.delete(it.id); else S.sel.add(it.id);
    anchor = it.id; S.focus = it.id;
    if (!S.sel.size) S.sel.add(it.id);
  } else { anchor = it.id; focusItem(it); return; }
  selChanged();
});
$("#grid").addEventListener("keydown", (e) => { if (e.key === "Enter") { const t = e.target.closest(".tile"); if (t) { focusItem(byId(+t.dataset.id)); e.preventDefault(); } } });
$("#sortby").onchange = (e) => { S.sort = e.target.value; renderAll(); };
$("#filters").onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; S.filter = b.dataset.f; renderAll(); };
$("#selall").onchange = (e) => { const vis = visible(); if (e.target.checked) vis.forEach((x) => S.sel.add(x.id)); else { S.sel = new Set(S.focus ? [S.focus] : []); } S.insOpen = e.target.checked && mobile(); selChanged(); };
$("#selmode").onclick = () => { S.selectMode = !S.selectMode; $("#selmode").setAttribute("aria-pressed", S.selectMode); $("#selmode").textContent = S.selectMode ? "Done selecting" : "Select"; if (!S.selectMode && S.sel.size > 1 && mobile()) { S.insOpen = true; } renderAll(); };

/* ------------------------------------------------------------------ AI */
let stopFlag = false;
function aiContext(it) {
  const st = (x) => (x && x.date ? human(x.date.t).slice(0, 16) : null);
  const idx = S.items.indexOf(it);
  const prev = S.items.slice(0, idx).reverse().find((x) => x.date && x.date.conf >= 0.6), next = S.items.slice(idx + 1).find((x) => x.date && x.date.conf >= 0.6);
  const mc = monthCtx(), a = S.ctx.area;
  return {
    fileName: it.name, kind: it.kind,
    knownDate: it.date && it.date.conf >= 0.9 ? human(it.date.t).slice(0, 10) : null,
    knownPlace: it.loc && it.loc.conf >= 0.9 ? it.loc.place || `${it.loc.la.toFixed(3)}, ${it.loc.lo.toFixed(3)}` : null,
    before: st(prev), after: st(next),
    month: mc ? MONTHS[mc.m - 1] : null, year: mc && mc.y ? String(mc.y) : null,
    rangeStart: S.ctx.start || null, rangeEnd: S.ctx.end || null,
    area: a ? { name: a.name, la: a.la, lo: a.lo, r: a.r } : null, hint: S.ctx.hint || null,
  };
}
async function runAI(list) {
  list = list.filter((x) => !x.out);
  if (!list.length) return;
  const mode = aiMode();
  if (mode === "none") { openSettings("ai"); return toast("AI suggestions need an account or your own API key."); }
  if (mode === "account" && !acct.user) { openAccount("signin", "Sign in to use AI suggestions. New accounts get " + CONFIG.starterCredits + " free credits."); return; }
  if (mode === "account" && acct.credits != null && acct.credits < list.length) { if (acct.credits <= 0) return openAccount("buy", "You're out of AI credits."); toast(`You have ${acct.credits} credits; the first ${acct.credits} files will be done.`); list = list.slice(0, acct.credits); }
  S.busy = true; stopFlag = false; $("#b-stop").hidden = false; $("#prog").hidden = list.length < 2; $("#prog").max = list.length; $("#prog").value = 0;
  let ok = 0, fail = 0, halt = null;
  for (let i = 0; i < list.length && !stopFlag; i++) {
    const it = list[i];
    setStatus(`Asking the AI about ${esc(it.name)} (${i + 1} of ${list.length})...`);
    it.aiState = "busy"; it.aiErr = null; if (it.id === S.focus) renderInspector();
    try {
      const img = await aiImage(it);
      it.ai = await suggest(img, aiContext(it));
      applyAiTop(it); ok++;
    } catch (e) {
      fail++; it.aiErr = e.message || "AI failed";
      if (["signin", "no_credits", "bad_key", "no_ai", "no_backend"].includes(e.code)) { halt = e; }
      if (e.code === "rate_limited") await new Promise((r) => setTimeout(r, 4000));
    }
    it.aiState = null; it.out = null; updateTile(it); if (it.id === S.focus) renderInspector();
    $("#prog").value = i + 1;
    if (halt) break;
  }
  S.busy = false; $("#b-stop").hidden = true; $("#prog").hidden = true;
  refresh();
  setStatus(`${stopFlag ? "Stopped. " : ""}AI suggestions: ${ok} done${fail ? `, <span class="err">${fail} failed</span>` : ""}. Check each before marking ready.`);
  if (halt) { if (halt.code === "signin") openAccount("signin", halt.message); else if (halt.code === "no_credits") openAccount("buy", halt.message); else toast(halt.message, 5000); }
}
$("#b-ai").onclick = () => runAI(aiTargets());
$("#b-stop").onclick = () => { stopFlag = true; };
$("#b-ready").onclick = () => { const t = readyTargets(); t.forEach((x) => { x.ready = true; updateTile(x); }); refresh(); toast(`${plural(t.length, "file")} marked ready.`); };

/* ------------------------------------------------------------------ trip details + fill blanks */
function fillBlanks() {
  const a = S.ctx.area, mc = monthCtx(); let n = 0;
  const hasRange = !!(S.ctx.start && S.ctx.end) || !!(mc && mc.y);
  for (const it of S.items) {
    if (it.out) continue;
    let ch = false;
    if (a && !it.loc && !(it.ex && it.ex.gps)) { it.loc = { la: a.la, lo: a.lo, alt: null, zone: a.zone || zoneAt(a.la, a.lo), place: a.name, src: "context", label: "Centre of your trip area", conf: 0.35, manual: false }; ch = true; }
    if (hasRange && !it.date && !(it.ex && it.ex.date && !it.ex.date.weak)) {
      const r = rangeCtx(), list = S.items, i = list.indexOf(it), k = list.length;
      const t = Math.round((r[0] + 12 * 3.6e6 + ((r[1] - r[0] - 24 * 3.6e6) * (k > 1 ? i / (k - 1) : 0.5))) / 3.6e6) * 3.6e6;
      it.date = { t, off: null, src: "context", label: "Spread through your trip dates", conf: 0.3, manual: false }; ch = true;
    }
    if (ch) { rezone(it); n++; updateTile(it); }
  }
  refresh(); toast(n ? `Filled blanks on ${plural(n, "file")}. These are rough: review them.` : "Nothing to fill: those files already have dates and places.");
}
$("#btn-fill").onclick = fillBlanks;
function openContext() {
  const d = $("#dlg-context");
  $("#cx-month").innerHTML = '<option value="">Any month</option>' + MONTHS.map((m, i) => `<option value="${i + 1}"${+S.ctx.month === i + 1 ? " selected" : ""}>${m}</option>`).join("");
  $("#cx-year").value = S.ctx.year || ""; $("#cx-start").value = S.ctx.start || ""; $("#cx-end").value = S.ctx.end || ""; $("#cx-hint").value = S.ctx.hint || "";
  const showArea = () => { $("#cx-area").textContent = S.ctx.area ? `${S.ctx.area.name || S.ctx.area.la.toFixed(3) + ", " + S.ctx.area.lo.toFixed(3)} . ${S.ctx.area.r} km` : "Anywhere"; };
  showArea();
  $("#cx-area-pick").onclick = async () => { d.close(); const a = S.ctx.area; const r = await pickLocation({ title: "Roughly where was the trip?", area: true, la: a && a.la, lo: a && a.lo, r: a ? a.r : 25, name: a && a.name }); if (r) S.ctx.area = { la: r.la, lo: r.lo, r: r.r, name: r.name, zone: r.zone }; persistCtx(); openContext(); };
  $("#cx-area-clear").onclick = () => { S.ctx.area = null; showArea(); };
  d.onclose = () => { S.ctx.month = $("#cx-month").value; S.ctx.year = $("#cx-year").value.trim(); S.ctx.start = $("#cx-start").value; S.ctx.end = $("#cx-end").value; S.ctx.hint = $("#cx-hint").value.trim(); if (S.ctx.start && S.ctx.end && S.ctx.start > S.ctx.end) { [S.ctx.start, S.ctx.end] = [S.ctx.end, S.ctx.start]; } persistCtx(); renderAll(); };
  if (!d.open) d.showModal();
}
$("#btn-context").onclick = openContext;

/* ------------------------------------------------------------------ export */
const snapshot = () => ({ settings: { ...S.settings }, ctx: JSON.parse(JSON.stringify(S.ctx)) });
const mime = (n) => (/\.mp4$/i.test(n) ? "video/mp4" : /\.(mov|qt)$/i.test(n) ? "video/quicktime" : /\.m4v$/i.test(n) ? "video/x-m4v" : /\.png$/i.test(n) ? "image/png" : /\.(heic|heif)$/i.test(n) ? "image/heic" : /\.webp$/i.test(n) ? "image/webp" : /\.tiff?$/i.test(n) ? "image/tiff" : /\.dng$/i.test(n) ? "image/x-adobe-dng" : "image/jpeg");
const fileOf = (o) => new File([o.bytes], o.name, { type: mime(o.name), lastModified: o.mt });
function downloadBlob(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000); }
function nowStamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

const fsName = (it) => (it.realExt ? it.name.replace(/\.[^.]*$/, "") + "." + it.realExt : it.name);
async function exportReady() {
  const list = S.items.filter((x) => status(x) === "ready");
  if (!list.length) return openExport();
  store.saveLast(snapshot());
  S.busy = true; $("#prog").hidden = false; $("#prog").max = list.length; $("#prog").value = 0; $("#b-export").disabled = true;
  let seq = parseInt(S.settings.seq, 10) || 1; const used = new Set(S.items.filter((x) => x.out && x.out.ok && !list.includes(x)).map((x) => x.out.key.toLowerCase()));
  try { await loadEngine(); } catch (e) { S.busy = false; $("#prog").hidden = true; renderBar(); return toast("The engine couldn't load. Check your connection and try again.", 6000); }
  const jobs = [];
  for (const it of list) {
    const p = plan(it);
    const b = buildTags({ kind: it.kind, t: p.t, off: p.off, la: p.la, lo: p.lo, alt: p.alt, dev: it.dev, full: S.settings.full, label: S.settings.label, write: p.write });
    let name = applyPattern(S.settings.pattern, { name: it.name, t: p.t, dev: it.dev }, { seq, place: (it.loc && it.loc.place) || (S.ctx.area && S.ctx.area.name) });
    if (it.realExt) name = name.replace(/\.[^.]*$/, "") + "." + it.realExt;
    if (usesSeq(S.settings.pattern)) seq++;
    const stem = name.replace(/(\.[^.]*)?$/, ""), ext = (/\.[^.]+$/.exec(name) || [""])[0];
    let key = (it.dir ? it.dir + "/" : "") + name, k = 1;
    while (used.has(key.toLowerCase())) { k++; name = `${stem}_${k}${ext}`; key = (it.dir ? it.dir + "/" : "") + name; }
    used.add(key.toLowerCase());
    jobs.push({ it, p, b, name, key, mt: p.t != null ? p.t - (p.off || 0) * 60000 : Date.now() });
  }
  let done = 0;
  for (let i = 0; i < jobs.length; i += 25) {
    const part = jobs.slice(i, i + 25);
    setStatus(`Writing and verifying ${done + 1}-${done + part.length} of ${jobs.length}...`);
    let written = new Map(), back = new Map();
    try { written = await writeMany(part.map((j) => ({ id: j.it.id, blob: j.it.file, name: fsName(j.it), tags: j.b.tags }))); } catch (e) { for (const j of part) written.set(j.it.id, e); }
    const okW = part.filter((j) => written.get(j.it.id) instanceof Uint8Array);
    try { back = await readMany(okW.map((j) => ({ id: j.it.id, blob: new Blob([written.get(j.it.id)]), name: fsName(j.it) }))); } catch (e) { for (const j of okW) back.set(j.it.id, e); }
    for (const j of part) {
      const w = written.get(j.it.id), r = back.get(j.it.id);
      if (!(w instanceof Uint8Array)) j.it.out = { ok: false, diffs: [(w && w.message) || "Write failed"], bytes: null, name: j.name, dir: j.it.dir, key: j.key, summary: j.b.summary, mt: j.mt, plan: j.p };
      else if (!r || r instanceof Error) j.it.out = { ok: false, diffs: ["Could not read the written file back: " + ((r && r.message) || "unknown")], bytes: w, name: j.name, dir: j.it.dir, key: j.key, summary: j.b.summary, mt: j.mt, plan: j.p };
      else { const v = verify(r, j.b.expect); j.it.out = { ok: v.ok, diffs: v.diffs, bytes: w, name: j.name, dir: j.it.dir, key: j.key, summary: j.b.summary, mt: j.mt, plan: j.p }; }
      j.it.ready = false; updateTile(j.it);
    }
    done += part.length; $("#prog").value = done;
  }
  S.busy = false; $("#prog").hidden = true; refresh();
  openExport();
}
function auditCsv() {
  const rows = [["original_file", "output_file", "type", "verified", "date_before", "date_after", "utc_offset", "time_zone", "date_source", "date_confidence", "lat_before", "lon_before", "lat_after", "lon_after", "location_source", "place", "device_after", "notes"]];
  for (const it of S.items) if (it.out) {
    const ex = it.ex || {}, p = it.out.plan, pr = it.out.plan.write.device ? profileFor(it.dev, p.t) : null;
    rows.push([it.path, it.out.key, it.kind, it.out.ok ? "yes" : "no", ex.date ? (ex.date.t != null ? human(ex.date.t) : human(ex.date.u) + " UTC") : "", p.write.date || p.write.offsetOnly ? human(p.t) : "", p.off != null && (p.write.date || p.write.offsetOnly) ? fmtOffset(p.off) : "", p.zone || "", p.write.date && it.date ? it.date.label : "", p.write.date && it.date ? it.date.conf.toFixed(2) : "", ex.gps ? ex.gps.la : "", ex.gps ? ex.gps.lo : "", p.write.gps ? p.la : "", p.write.gps ? p.lo : "", p.write.gps && it.loc ? it.loc.label : "", it.loc && it.loc.place ? it.loc.place : "", pr ? pr.model : "", it.out.ok ? it.out.summary.join("; ") : it.out.diffs.join("; ")]);
  }
  return rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
}
function openExport() {
  const outs = S.items.filter((x) => x.out), good = outs.filter((x) => x.out.ok), bad = outs.filter((x) => !x.out.ok);
  const dirs = new Set(good.map((x) => x.out.dir)).size;
  const files = good.map((x) => fileOf(x.out));
  let canShare = false; try { canShare = !!(navigator.canShare && files.length && navigator.canShare({ files })); } catch (e) {}
  const zipFirst = S.settings.delivery === "zip" || (S.settings.delivery === "auto" && dirs > 1);
  const body = $("#export-body");
  body.innerHTML = !outs.length ? '<p class="note">Nothing exported yet. Mark files ready, then press Export.</p>' : `
    <div class="sumline"><span class="okc"><b>${good.length}</b> written and verified</span>${bad.length ? `<span class="err"><b>${bad.length}</b> failed</span>` : ""}<span class="note" style="margin:0">Originals untouched</span></div>
    <div class="actions" style="margin-top:4px">
      ${canShare ? `<button type="button" class="${zipFirst ? "" : "pri"}" id="x-share">Save to Photos / Share (${good.length})</button>` : ""}
      <button type="button" class="${!canShare && !zipFirst ? "pri" : ""}" id="x-save" ${good.length ? "" : "disabled"}>Download ${good.length > 1 ? good.length + " files" : "file"}</button>
      <button type="button" class="${zipFirst ? "pri" : ""}" id="x-zip" ${good.length ? "" : "disabled"}>Download ZIP${dirs > 1 ? " (keeps folders)" : ""}</button>
      <button type="button" class="ghost" id="x-csv">Audit log (CSV)</button>
    </div>
    <p class="note">${canShare ? "On iPhone and iPad, Save to Photos opens the share sheet: choose Save Images / Save Videos. " : ""}Downloads are new copies with the fixed metadata.${dirs > 1 ? " Your files came from several folders, so the ZIP keeps that structure." : ""}</p>
    ${bad.length ? `<h3 class="err">Failed</h3>${bad.map((x) => `<div class="orow"><span></span><div><div class="nm">${esc(x.path)}</div><div class="s err">${esc(x.out.diffs.join("; "))}</div></div><span></span></div>`).join("")}` : ""}
    <h3>Files</h3><div class="biglist">${good.map((x, i) => `<div class="orow">${x.thumb ? `<img src="${x.thumb}" alt="">` : "<span></span>"}<div><div class="nm">${esc(x.out.key)}</div><div class="s">${esc(x.out.summary.join(" . "))}</div></div><div class="acts">${canShare ? `<button type="button" class="small" data-sh="${i}">Share</button>` : ""}<button type="button" class="small" data-dl="${i}">Save</button></div></div>`).join("")}</div>`;
  const d = $("#dlg-export"); if (!d.open) d.showModal();
  const sh = $("#x-share"); if (sh) sh.onclick = async () => { try { await navigator.share({ files }); toast("Shared."); } catch (e) { if (e.name !== "AbortError") toast("Sharing didn't work here. Use Download instead.", 5000); } };
  const sv = $("#x-save"); if (sv) sv.onclick = async () => { for (let i = 0; i < good.length; i++) { downloadBlob(files[i], good[i].out.name); await new Promise((r) => setTimeout(r, 350)); } toast(`${plural(good.length, "download")} started.`); };
  const zp = $("#x-zip"); if (zp) zp.onclick = () => { const z = {}; for (const x of good) z[x.out.key] = [x.out.bytes, { level: 0, mtime: new Date(x.out.mt) }]; downloadBlob(new Blob([zipSync(z)], { type: "application/zip" }), `${nowStamp()}_metadata-fixed.zip`); };
  $("#x-csv") && ($("#x-csv").onclick = () => downloadBlob(new Blob(["﻿" + auditCsv()], { type: "text/csv" }), `${nowStamp()}_metadata-audit.csv`));
  body.querySelectorAll("[data-sh]").forEach((b) => (b.onclick = async () => { try { await navigator.share({ files: [files[+b.dataset.sh]] }); } catch (e) { if (e.name !== "AbortError") toast("Sharing didn't work here. Use Save instead."); } }));
  body.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => downloadBlob(files[+b.dataset.dl], good[+b.dataset.dl].out.name)));
}
$("#b-export").onclick = () => (counts().ready ? exportReady() : openExport());

/* ------------------------------------------------------------------ settings */
let delArm = null;
function openSettings(focus) {
  zoneDatalist();
  const st = S.settings, tnames = Object.keys(store.templates).sort((a, b) => a.localeCompare(b));
  const presetHit = Object.keys(BUILTIN).find((k) => BUILTIN[k] === st.pattern);
  const ex = S.items[0] || { name: "IMG_1234.JPG", t: naive(2021, 7, 4, 14, 30), dev: "era" };
  const exName = applyPattern(st.pattern, { name: ex.name, t: ex.date ? ex.date.t : ex.t ?? null, dev: ex.dev || st.dev }, { seq: parseInt(st.seq, 10) || 1, place: S.ctx.area && S.ctx.area.name });
  $("#settings-body").innerHTML = `
  <h3>Templates</h3>
  <p class="note">A template saves all of these settings plus your Trip details, so you can reuse them next time.</p>
  <div class="rowx"><select id="s-tpl" aria-label="Saved templates" style="flex:1 1 200px"><option value="">${tnames.length ? "Apply a saved template..." : "No saved templates yet"}</option>${tnames.map((n) => `<option>${esc(n)}</option>`).join("")}</select><button type="button" class="ghost danger" id="s-tdel" disabled>Delete</button></div>
  <div class="rowx" style="margin-top:6px"><input id="s-tname" aria-label="Template name" maxlength="40" placeholder="Name, e.g. Lisbon July 2021" style="flex:1 1 200px"><button type="button" id="s-tsave">Save current</button></div>
  <div class="rowx" style="margin-top:6px"><button type="button" class="ghost" id="s-last" ${store.lastUsed ? "" : "disabled"}>Use last used settings</button><span class="note">${acct.user ? "Saved to your account, on every device." : "Saved in this browser." + (acct.configured ? " Sign in to keep them on every device." : "")}</span></div>
  <div class="sect"><h3>Time and writing</h3>
  <label>Default time zone (used when a file has no location or offset)<input id="s-zone" list="zones" value="${esc(st.zone)}"></label>
  <label class="chk"><input type="radio" name="pol" value="fill" ${st.policy === "fill" ? "checked" : ""}> Fill in what's missing; keep anything already in the file (recommended)</label>
  <label class="chk"><input type="radio" name="pol" value="overwrite" ${st.policy === "overwrite" ? "checked" : ""}> Overwrite existing values with the ones chosen here</label>
  <label class="chk"><input type="checkbox" id="s-label" ${st.label ? "checked" : ""}> Mark changed files with an XMP label "Reconstructed metadata"</label></div>
  <div class="sect"><h3>Device</h3>
  <label>Device details for new files<select id="s-dev">${devOptions(st.dev)}</select></label>
  <label class="chk"><input type="checkbox" id="s-full" ${st.full ? "checked" : ""}> Full iPhone tag set (lens, 35mm equivalent, metering, white balance)</label></div>
  <div class="sect"><h3>File names</h3>
  <div class="two"><label>Preset<select id="s-preset"><option value="">Custom</option>${Object.keys(BUILTIN).map((k) => `<option${presetHit === k ? " selected" : ""}>${k}</option>`).join("")}</select></label><label>Start numbering at<input id="s-seq" inputmode="numeric" value="${esc(st.seq)}"></label></div>
  <label>Pattern<input id="s-pat" value="${esc(st.pattern)}" spellcheck="false"></label>
  <p class="note">Example: <b class="mono">${esc(exName)}</b><br>Tokens: {orig} {date} {time} {y} {m} {d} {seq} {seq4} {device} {place} {ext} {EXT}</p></div>
  <div class="sect"><h3>Export</h3>
  <label>Delivery<select id="s-deliv"><option value="auto" ${st.delivery === "auto" ? "selected" : ""}>Separate files; ZIP when files came from several folders</option><option value="zip" ${st.delivery === "zip" ? "selected" : ""}>Always offer a ZIP first</option></select></label></div>
  <div class="sect" id="s-ai-sect"><h3>AI suggestions</h3>
  <p class="note">${acct.configured ? "AI suggestions use credits from your account." : "AI suggestions through an account are coming soon."} Advanced: use your own Anthropic API key instead. It stays in this browser and images go straight to Anthropic.</p>
  <div class="rowx"><input type="password" id="s-key" aria-label="Anthropic API key" placeholder="${ownKey.get() ? "Key saved (ends " + esc(ownKey.get().slice(-4)) + ")" : "sk-ant-..."}" autocomplete="off" style="flex:1 1 200px"><button type="button" id="s-keysave">Save key</button>${ownKey.get() ? '<button type="button" class="ghost" id="s-keyclr">Remove</button>' : ""}</div>
  <label class="chk"><input type="checkbox" id="s-keyrem"> Remember the key on this device</label></div>`;
  const d = $("#dlg-settings"); if (!d.open) d.showModal();
  if (focus === "ai") setTimeout(() => $("#s-ai-sect").scrollIntoView({ block: "start" }), 50);
  const upd = (k, v) => { S.settings[k] = v; persistSettings(); if (k === "dev") S.items.forEach((x) => { if (!x.out) x.dev = v; }); renderAll(); openSettings(); };
  $("#s-zone").onchange = (e) => { const v = e.target.value.trim(); if (isZone(v) || parseFixed(v) != null) upd("zone", v); else toast("Unknown time zone."); };
  $$('input[name=pol]').forEach((r) => (r.onchange = () => upd("policy", r.value)));
  $("#s-label").onchange = (e) => upd("label", e.target.checked);
  $("#s-dev").onchange = (e) => upd("dev", e.target.value);
  $("#s-full").onchange = (e) => upd("full", e.target.checked);
  $("#s-preset").onchange = (e) => { if (e.target.value) upd("pattern", BUILTIN[e.target.value]); };
  $("#s-pat").onchange = (e) => upd("pattern", e.target.value.trim() || "{orig}");
  $("#s-seq").onchange = (e) => upd("seq", Math.max(0, parseInt(e.target.value, 10) || 1));
  $("#s-deliv").onchange = (e) => upd("delivery", e.target.value);
  $("#s-tpl").onchange = (e) => { const n = e.target.value; $("#s-tdel").disabled = !n; delArm = null; $("#s-tdel").textContent = "Delete"; if (!n) return; applySnapshot(store.templates[n]); $("#s-tname").value = n; toast(`Applied template "${n}".`); openSettings(); $("#s-tpl").value = n; $("#s-tname").value = n; $("#s-tdel").disabled = false; };
  $("#s-tsave").onclick = async () => { const n = $("#s-tname").value.trim().slice(0, 40); if (!n) { $("#s-tname").focus(); return toast("Type a name for the template."); } const existed = n in store.templates; const ok = await store.saveTemplate(n, snapshot()); toast(`${existed ? "Updated" : "Saved"} template "${n}"${ok === false ? " in this browser (account sync failed)" : ""}.`); openSettings(); $("#s-tpl").value = n; $("#s-tname").value = n; $("#s-tdel").disabled = false; };
  $("#s-tdel").onclick = async () => { const n = $("#s-tpl").value; if (!n) return; if (delArm !== n) { delArm = n; $("#s-tdel").textContent = "Tap again to delete"; setTimeout(() => { if (delArm === n) { delArm = null; const b = $("#s-tdel"); if (b) b.textContent = "Delete"; } }, 4000); return; } delArm = null; await store.deleteTemplate(n); toast(`Deleted "${n}".`); openSettings(); };
  $("#s-last").onclick = () => { applySnapshot(store.lastUsed); toast("Restored your last used settings."); openSettings(); };
  $("#s-keysave").onclick = () => { const v = $("#s-key").value.trim(); if (!/^sk-/.test(v)) return toast("That doesn't look like an Anthropic API key."); ownKey.set(v, $("#s-keyrem").checked); toast("Key saved. AI suggestions now use your key."); openSettings("ai"); renderInspector(); };
  const kc = $("#s-keyclr"); if (kc) kc.onclick = () => { ownKey.set(""); toast("Key removed."); openSettings("ai"); renderInspector(); };
}
function applySnapshot(snap) {
  if (!snap) return;
  if (snap.settings) { S.settings = { ...store.DEFAULTS(), ...S.settings, ...snap.settings }; persistSettings(); }
  if (snap.ctx) { Object.assign(S.ctx, { month: "", year: "", start: "", end: "", area: null, hint: "" }, snap.ctx); persistCtx(); }
  for (const it of S.items) if (!it.out) { it.dev = S.settings.dev; autopick(it); }
  renderAll();
}
$("#btn-settings").onclick = () => openSettings();
$("#btn-help").onclick = () => $("#dlg-help").showModal();

/* ------------------------------------------------------------------ account + pricing */
function renderPlans() {
  const free = `<div class="plan"><b>Free</b><div class="price">$0</div><div class="cr">${CONFIG.starterCredits} AI credits to start</div><p>Unlimited fixing: existing metadata, Takeout and XMP sidecars, file names, bulk edits, maps, templates, audit log.</p><button type="button" id="plan-free">Start now</button></div>`;
  $("#plans").innerHTML = free + CONFIG.packs.map((p) => `<div class="plan${p.featured ? " featured" : ""}"><b>${p.credits.toLocaleString()} credits</b><div class="price">${p.price}</div><div class="cr">${p.note}</div><p>AI date and place suggestions for ${p.credits.toLocaleString()} photos or videos.</p><button type="button" class="${p.featured ? "pri" : ""}" data-buy="${p.id}">Buy</button></div>`).join("");
  $("#plan-free").onclick = () => $("#pick").click();
  $$("[data-buy]").forEach((b) => (b.onclick = () => startBuy(b.dataset.buy)));
}
async function startBuy(id) {
  if (!acct.configured) return toast("Payments are coming soon.");
  if (!acct.user) return openAccount("signin", "Sign in first, then you can buy credits.");
  try { toast("Opening secure checkout...", 8000); await buy(id); } catch (e) { toast(e.message || "Checkout could not start.", 6000); }
}
function renderAccountBtn() {
  const b = $("#btn-account");
  if (!acct.configured) { b.hidden = true; return; }
  b.hidden = false;
  if (acct.user) { b.textContent = acct.credits == null ? "Account" : `${acct.credits} credits`; b.classList.add("credits"); }
  else { b.textContent = "Sign in"; b.classList.remove("credits"); }
}
function openAccount(mode, msg) {
  const d = $("#dlg-account"), body = $("#acct-body");
  if (!acct.configured) return toast("Accounts are coming soon.");
  if (!acct.user || mode === "signin") {
    $("#acct-title").textContent = "Sign in";
    body.innerHTML = `${msg ? `<p>${esc(msg)}</p>` : ""}<p class="note">No password: we email you a sign-in link. New accounts get ${CONFIG.starterCredits} free AI credits.</p>
      <label>Email<input type="email" id="a-email" autocomplete="email" required placeholder="you@example.com"></label>
      <div class="actions"><button type="button" class="pri" id="a-send">Email me a sign-in link</button></div><p class="note" id="a-msg"></p>`;
    $("#a-send").onclick = async () => { const e = $("#a-email").value.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return ($("#a-msg").textContent = "Enter a valid email address."); $("#a-send").disabled = true; try { await signIn(e); $("#a-msg").innerHTML = '<span class="okc">Check your inbox and open the link on this device. You can close this.</span>'; } catch (err) { $("#a-msg").innerHTML = `<span class="err">${esc(err.message)}</span>`; $("#a-send").disabled = false; } };
  } else {
    $("#acct-title").textContent = mode === "buy" ? "Buy AI credits" : "Your account";
    body.innerHTML = `${msg ? `<p>${esc(msg)}</p>` : ""}<p>Signed in as <b>${esc(acct.user.email || "")}</b></p><p>Balance: <b class="mono">${acct.credits ?? "..."}</b> AI credits</p>
      <h3>Buy credits</h3><div class="bulkgrid">${CONFIG.packs.map((p) => `<div class="bulk rowx" style="justify-content:space-between"><span><b>${p.credits.toLocaleString()} credits</b> . ${p.price}<br><span class="note">${p.note}</span></span><button type="button" class="${p.featured ? "pri" : ""}" data-buy2="${p.id}">Buy</button></div>`).join("")}</div>
      <p class="note">Secure payment by Stripe. Credits never expire. Failed AI suggestions are refunded automatically.</p>
      <div class="actions"><button type="button" class="ghost" id="a-out">Sign out</button></div>`;
    body.querySelectorAll("[data-buy2]").forEach((b) => (b.onclick = () => startBuy(b.dataset.buy2)));
    $("#a-out").onclick = async () => { await signOut(); d.close(); toast("Signed out."); };
  }
  if (!d.open) d.showModal();
}
$("#btn-account").onclick = () => openAccount(acct.user ? "account" : "signin");
$("#lnk-pricing").onclick = (e) => { if (!$("#landing").hidden) return; e.preventDefault(); openAccount(acct.user ? "buy" : "signin"); };
$("#lnk-support").href = CONFIG.supportUrl;

/* ------------------------------------------------------------------ input wiring */
$("#pick").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#dirpick").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#pickdir").onclick = () => $("#dirpick").click();
$("#add-more").onclick = () => $("#pick").click();
$("#add-dir").onclick = () => $("#dirpick").click();
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { dragDepth++; $("#drop").classList.add("over"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").classList.remove("over"); } });
addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
addEventListener("drop", async (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault(); dragDepth = 0; $("#drop").classList.remove("over");
  const items = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.some((x) => x.isDirectory)) {
    const out = [];
    const walk = (ent, path) => new Promise((res) => { if (ent.isFile) ent.file((f) => { try { Object.defineProperty(f, "webkitRelativePath", { value: path + f.name }); } catch (er) {} out.push(f); res(); }, () => res()); else { const r = ent.createReader(), all = []; const rd = () => r.readEntries(async (es) => { if (!es.length) { for (const c of all) await walk(c, path + ent.name + "/"); res(); } else { all.push(...es); rd(); } }, () => res()); rd(); } });
    for (const it of items) await walk(it, "");
    addFiles(out);
  } else addFiles(e.dataTransfer.files);
});
addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]") || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName) || $("#work").hidden) return;
  const vis = visible(), it = byId(S.focus), i = it ? vis.indexOf(it) : -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); focusItem(vis[Math.min(vis.length - 1, i + 1)] || vis[0], false); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); focusItem(vis[Math.max(0, i - 1)] || vis[0], false); }
  else if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); vis.forEach((x) => S.sel.add(x.id)); selChanged(); }
  else if (e.key === "a" && it && status(it) === "review") { it.ready = true; refresh(it); const nx = vis.find((x, j) => j > i && status(x) === "review"); if (nx) focusItem(nx, false); }
  else if (e.key === "s" && it) runAI([it]);
  else if (e.key === " " && it) { e.preventDefault(); if (S.sel.has(it.id) && S.sel.size > 1) S.sel.delete(it.id); else S.sel.add(it.id); selChanged(); }
  else if (e.key === "Escape") { S.sel = new Set(S.focus ? [S.focus] : []); S.selectMode = false; $("#selmode").setAttribute("aria-pressed", "false"); $("#selmode").textContent = "Select"; selChanged(); }
  else if (e.key === "?") $("#dlg-help").showModal();
});
addEventListener("beforeunload", (e) => { if (S.items.some((x) => x.ready || (x.out && x.out.ok)) ) { e.preventDefault(); e.returnValue = ""; } });

/* ------------------------------------------------------------------ boot */
onEngine((en) => {
  const c = $("#engine");
  if (en.state === "idle") { c.hidden = true; return; }
  c.hidden = false; c.className = "chip engine " + en.state;
  c.textContent = en.state === "loading" ? `Engine ${Math.round(en.progress * 100)}%` : en.state === "ready" ? "Engine ready" : "Engine failed";
  c.title = en.state === "error" ? String(en.error && en.error.message) : "ExifTool running in your browser";
  if (en.state === "error") toast("The metadata engine couldn't load. Check your connection and reload.", 8000);
});
let lastUid = null;
onAccount(async () => { renderAccountBtn(); const uid = acct.user ? acct.user.id : null; if (uid !== lastUid) { lastUid = uid; acct.synced = false; } if (acct.user && !acct.synced) { acct.synced = true; await store.syncFromCloud(); } if ($("#dlg-account").open && acct.user) openAccount("account"); renderInspector(); });
renderPlans(); renderAccountBtn();
initAccount().catch(() => {});
const qs = new URLSearchParams(location.search);
if (qs.get("checkout")) { history.replaceState(null, "", location.pathname); if (qs.get("checkout") === "success") { toast("Payment received. Your credits will appear in a moment.", 6000); setTimeout(() => refreshCredits(), 2500); setTimeout(() => refreshCredits(), 8000); } else toast("Checkout cancelled."); }
// start fetching the engine as soon as someone shows intent to add files
const warm = () => loadEngine().catch(() => {});
["#drop", "#pickdir", "#plan-free"].forEach((sel) => { const el = $(sel); if (el) { el.addEventListener("pointerenter", warm, { once: true }); el.addEventListener("touchstart", warm, { once: true, passive: true }); } });
addEventListener("dragenter", warm, { once: true });
window.__mf = { S, status, plan };
