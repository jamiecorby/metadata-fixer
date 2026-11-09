// Starts the app once the page has painted and its fonts have arrived, so on a slow connection the text appears first
// and the app script does not compete with it for bandwidth.
let started = false;
const go = () => { if (started) return; started = true; import("./main.js?v=__V__"); };
if (document.readyState === "complete") go(); else { addEventListener("load", go, { once: true }); setTimeout(go, 3000); }

// Until the app is running, nothing the visitor does is lost: a drop zone still opens the file chooser, and files that
// are chosen or dropped are kept for the app (a dropped file is never opened by the browser instead).
const early = () => !window.__mfReady;
const keep = (files) => { if (files && files.length) { (window.__early = window.__early || []).push(...files); go(); } };
const openFor = (d) => { const inp = document.getElementById(d.dataset.for); if (inp) inp.click(); };
addEventListener("dragover", (e) => { if (early()) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!early()) return; e.preventDefault();
  const dt = e.dataTransfer; if (!dt) return;
  // folders must be read as entries during the drop event itself; the app walks them once it starts
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.some((x) => x.isDirectory)) { window.__earlyEntries = (window.__earlyEntries || []).concat(entries); go(); } else keep(dt.files);
});
document.addEventListener("click", (e) => { const d = early() && e.target.closest && e.target.closest(".drop"); if (d) openFor(d); });
document.addEventListener("keydown", (e) => { const d = early() && e.target.classList && e.target.classList.contains("drop") ? e.target : null; if (d && !e.repeat && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openFor(d); } });
document.addEventListener("change", (e) => { if (early() && e.target.type === "file") { keep([...e.target.files]); e.target.value = ""; } }, true);
