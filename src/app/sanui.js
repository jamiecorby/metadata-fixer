// Sanitise mode: the screen. Loaded on demand, so the recovery app's first load is unchanged.
// Deliberately imports nothing from the recovery workflow, the AI layer or the account layer: nothing here can restore, suggest or send anything.
import { newEntry, runBatch, summary, buildZip, auditCsv, auditJson, auditRecord, SUPPORTED, ST } from "./sanrun.js";
import { readRaw } from "./engine.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const plural = (n, w) => `${n} ${n === 1 ? w : w + "s"}`;

let E = [], nextId = 1, running = false, mounted = false, recoverFiles = () => [], toRecover = null;
const O = { redraw: true, dropAux: false, used: new Set(), cancelled: () => false };

/** Draws the picture again through a canvas: applies its rotation, converts to sRGB, and carries no metadata. */
async function redraw(file, kind) {
  const bmp = await createImageBitmap(file);
  try {
    if (bmp.width * bmp.height > 150e6) throw Object.assign(new Error("The picture is too large to redraw in the browser."), { code: "unsupported" });
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d", { colorSpace: "srgb" }).drawImage(bmp, 0, 0);
    const type = kind === "jpeg" ? "image/jpeg" : kind === "webp" ? "image/webp" : "image/png";
    const blob = await new Promise((r) => c.toBlob(r, type, 0.95));
    c.width = c.height = 0;
    if (!blob || blob.type !== type) throw new Error("This browser can't redraw this format.");
    return blob;
  } finally { bmp.close(); }
}
const io = { redraw, readTags: readRaw };

function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
function toast(m) { const t = $("#toast"); if (!t) return; t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 3500); }

/** Live state for the session cache, and the way back in after an interruption. */
export const exportState = () => ({ entries: E, opts: { redraw: O.redraw, dropAux: O.dropAux } });
export const isRunning = () => running;
export function importState(st) {
  E = st.entries.map((m) => { const e = newEntry(m.file, nextId++); const { file, ...rest } = m; Object.assign(e, rest); e.state = e.state === "working" ? "queued" : e.state; return e; });
  O.redraw = st.opts ? st.opts.redraw !== false : true; O.dropAux = !!(st.opts && st.opts.dropAux);
  O.used = new Set(E.filter((x) => x.out).map((x) => x.out.name.toLowerCase()));
  if (mounted) { $("#san-redraw").checked = O.redraw; $("#san-aux").checked = O.dropAux; }
  render();
}
/** Sanitised results as files, named and placed as in the ZIP, ready to go on to the next step. */
export function outputsAsFiles() {
  return E.filter((e) => e.out && (e.state === "verified" || e.state === "limited")).map((e) => {
    const dir = e.path.includes("/") ? e.path.replace(/\/[^/]*$/, "") + "/" : "";
    const f = new File([e.out.blob], e.out.name, { type: e.out.blob.type, lastModified: e.file.lastModified });
    try { Object.defineProperty(f, "webkitRelativePath", { value: dir + e.out.name }); } catch (er) {}
    return f;
  });
}

export function addFiles(list) {
  const known = new Set(E.map((x) => x.path + "|" + x.size));
  const files = [...list].filter((f) => !f.name.startsWith(".") && f.size > 0);
  const fresh = files.filter((f) => !known.has((f.webkitRelativePath || f.name) + "|" + f.size));
  const unsupported = fresh.filter((f) => !SUPPORTED.test(f.name) && !/\.(dng|cr2|cr3|nef|arw|orf|rw2|raf|gif)$/i.test(f.name));
  for (const f of fresh) {
    if (unsupported.includes(f)) continue;
    E.push(newEntry(f, nextId++));
  }
  const skipped = unsupported.length;
  render();
  toast(fresh.length - skipped ? `Added ${plural(fresh.length - skipped, "file")}${skipped ? `, skipped ${skipped} that are not photos or videos` : ""}.` : skipped ? "None of those are photos or videos." : "Nothing new to add.");
}

function chip(e) {
  const cls = { verified: "ok", limited: "warn", failed: "bad", unsupported: "bad", decision: "warn", working: "work", queued: "idle" }[e.state];
  return `<span class="san-chip ${cls}">${esc(ST[e.state])}</span>`;
}
function row(e) {
  const acts = [];
  if (e.rep || e.checks.length) acts.push(`<button class="ghost small" data-act="report" data-id="${e.id}">Report</button>`);
  if (e.out) acts.push(`<button class="small" data-act="dl" data-id="${e.id}">Download</button>`);
  if (e.state === "decision") acts.push(`<button class="small" data-act="allow" data-id="${e.id}">${e.key === "aux" ? "Remove it and continue" : "Redraw and continue"}</button>`);
  if (e.state === "failed") acts.push(`<button class="ghost small" data-act="retry" data-id="${e.id}">Retry</button>`);
  acts.push(`<button class="ghost small" data-act="remove" data-id="${e.id}" aria-label="Remove ${esc(e.name)} from the list">Remove</button>`);
  const note = e.state === "limited" ? (e.limits[0] || "") : e.msg;
  return `<li class="san-row" data-id="${e.id}"><div class="san-main"><b class="san-name" title="${esc(e.path)}">${esc(e.path)}</b><span class="san-meta">${kb(e.size)}${e.out ? " &rarr; " + kb(e.out.size) : ""}</span>${chip(e)}</div>${note ? `<p class="san-note">${esc(note)}</p>` : ""}<div class="san-acts">${acts.join("")}</div></li>`;
}
function render() {
  const s = summary(E), list = $("#san-list");
  list.innerHTML = E.map(row).join("");
  const waiting = E.filter((x) => x.state === "queued" || x.state === "failed" || x.state === "decision").length;
  $("#san-go").disabled = running || !E.some((x) => x.state === "queued");
  $("#san-zip").disabled = running || !s.ok; $("#san-audit").disabled = running || !E.some((x) => x.state !== "queued" && x.state !== "working");
  $("#san-clear").disabled = running || !E.length;
  const nx = $("#san-next"); if (nx) { nx.disabled = running || !s.ok || !toRecover; nx.textContent = s.ok ? `Continue in Recover (${s.ok})` : "Continue in Recover"; }
  $("#san-go").textContent = running ? "Working..." : E.length && !E.some((x) => x.state === "queued") ? "Sanitise" : E.some((x) => x.state === "queued") ? `Sanitise ${plural(E.filter((x) => x.state === "queued").length, "file")}` : "Sanitise";
  const parts = [];
  if (s.verified) parts.push(`${s.verified} verified`); if (s.limited) parts.push(`${s.limited} verified with limitations`); if (s.decision) parts.push(`${s.decision} need${s.decision === 1 ? "s" : ""} a decision`); if (s.failed) parts.push(`${s.failed} failed`); if (s.unsupported) parts.push(`${s.unsupported} not supported`); if (s.queued) parts.push(`${s.queued} waiting`);
  $("#san-sum").textContent = E.length ? `${plural(E.length, "file")}: ${parts.join(", ") || "ready"}.` : "No files yet.";
  const rf = recoverFiles(), fb = $("#san-from"); const fresh = rf.filter((f) => !E.some((x) => x.path === (f.webkitRelativePath || f.name) && x.size === f.size));
  fb.hidden = !fresh.length; fb.textContent = `Add the ${plural(fresh.length, "file")} from Recover`;
}

function reportHtml(e) {
  const a = auditRecord(e), icon = (r) => (r === "passed" ? "Passed" : r === "FAILED" ? "FAILED" : "Not completed");
  return `<p><b>${esc(e.path)}</b> - ${esc(a.result)}${e.msg ? `. ${esc(e.msg)}` : ""}</p>
  ${a.format ? `<p class="mut">${esc(a.format)}. ${esc(a.method)}. ${kb(e.size)}${e.out ? " to " + kb(e.out.size) : ""}.</p>` : ""}
  ${a.removed.length ? `<h3>Removed</h3><ul>${a.removed.map((x) => `<li>${esc(x.item)}${x.count > 1 ? ` (${x.count})` : ""}</li>`).join("")}</ul>` : e.rep ? "<h3>Removed</h3><p>Nothing was found to remove.</p>" : ""}
  ${a.notes.length ? `<h3>Notes</h3><ul>${a.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${a.checks.length ? `<h3>Checks on the output file</h3><ul class="san-checks">${a.checks.map((c) => `<li class="${c.result === "passed" ? "p" : c.result === "FAILED" ? "f" : "n"}"><b>${icon(c.result)}</b> ${esc(c.check)}${c.detail ? `<br><small>${esc(c.detail)}</small>` : ""}</li>`).join("")}</ul>` : ""}
  ${a.limitations.length ? `<h3>Known limitations</h3><ul>${a.limitations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  <p class="mut">This lists what was checked. It does not claim that every possible embedded structure was found.</p>`;
}

async function go(entries) {
  if (running) return; running = true; render();
  const prog = $("#san-prog"); prog.hidden = false; prog.value = 0;
  try {
    await runBatch(entries, O, io, ({ done, total, current }) => { prog.max = Math.max(1, total); prog.value = done; if (current) { current.state = current.state === "queued" ? "working" : current.state; $("#san-sum").textContent = `Working on ${done + (done < total ? 1 : 0)} of ${total}...`; } if (done === total || !current) return; render(); });
  } finally { running = false; prog.hidden = true; render(); }
  const s = summary(E); toast(s.failed || s.decision ? `Done. ${s.ok} ready, ${s.failed + s.decision} need attention.` : `Done. ${plural(s.ok, "file")} ready.`);
}

export function mount(api = {}) {
  recoverFiles = api.recoverFiles || (() => []); toRecover = api.toRecover || null;
  if (!mounted) {
    mounted = true;
    $("#san-pick").onchange = (ev) => { addFiles(ev.target.files); ev.target.value = ""; };
    $("#san-dirpick").onchange = (ev) => { addFiles(ev.target.files); ev.target.value = ""; };
    $("#san-dir").onclick = () => $("#san-dirpick").click();
    $("#san-from").onclick = () => addFiles(recoverFiles());
    $("#san-next").onclick = () => { if (toRecover) toRecover(outputsAsFiles()); };
    $("#san-redraw").onchange = (ev) => { O.redraw = ev.target.checked; };
    $("#san-aux").onchange = (ev) => { O.dropAux = ev.target.checked; if (O.dropAux) E.filter((x) => x.state === "decision" && x.key === "aux").forEach((x) => { x.state = "queued"; x.msg = ""; }); render(); };
    $("#san-go").onclick = () => go(E);
    $("#san-clear").onclick = () => { E = []; O.used = new Set(); render(); toast("Cleared. Nothing from these files is kept."); };
    $("#san-zip").onclick = async () => { try { const b = await buildZip(E); download(b, "sanitised-files.zip"); } catch (er) { toast(er.message); } };
    $("#san-audit").onclick = () => download(new Blob([auditCsv(E)], { type: "text/csv" }), "sanitisation-audit.csv");
    $("#san-list").onclick = (ev) => {
      const b = ev.target.closest("button[data-act]"); if (!b) return; const e = E.find((x) => x.id === +b.dataset.id); if (!e) return;
      if (b.dataset.act === "dl" && e.out) download(e.out.blob, e.out.name);
      else if (b.dataset.act === "report") { $("#san-rep").innerHTML = reportHtml(e) + `<p><button type="button" class="ghost small" id="san-rep-json">Download this report</button></p>`; $("#dlg-san").showModal(); $("#san-rep-json").onclick = () => download(new Blob([JSON.stringify(auditRecord(e), null, 2)], { type: "application/json" }), "sanitisation-report.json"); }
      else if (b.dataset.act === "retry") { e.state = "queued"; e.msg = ""; go([e]); }
      else if (b.dataset.act === "allow") { if (e.key === "aux") e.allowAux = true; else e.allowRedraw = true; e.state = "queued"; go([e]); }
      else if (b.dataset.act === "remove") { if (e.out) O.used.delete(e.out.name.toLowerCase()); E = E.filter((x) => x !== e); render(); }
    };
    const drop = $("#san-drop"); let depth = 0;
    addEventListener("dragenter", (ev) => { if (document.body.dataset.mode === "sanitise" && ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) { depth++; drop.classList.add("over"); } });
    addEventListener("dragleave", () => { if (document.body.dataset.mode === "sanitise" && --depth <= 0) { depth = 0; drop.classList.remove("over"); } });
    addEventListener("drop", () => { depth = 0; drop.classList.remove("over"); });
  }
  render();
}
