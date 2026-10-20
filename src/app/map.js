// Map picker (Leaflet + OpenStreetMap), loaded only when first opened.
import { geocode, reverseName } from "./ai.js";
import { zoneAt } from "./model.js";
const LV = "1.9.4";
let loaded = null;
function loadLeaflet() {
  if (loaded) return loaded;
  loaded = new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LV}/leaflet.min.css`; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LV}/leaflet.min.js`; s.onload = () => res(window.L); s.onerror = () => { loaded = null; rej(new Error("The map could not load. Check your connection.")); }; document.head.appendChild(s);
  });
  return loaded;
}
const $ = (s, r = document) => r.querySelector(s);
let map = null, mark = null, circ = null;

/**
 * @param {{title:string, la?:number, lo?:number, r?:number, area?:boolean, name?:string}} o
 * @returns {Promise<null|{la:number, lo:number, r?:number, name:string|null, zone:string|null}>}
 */
export function pickLocation(o) {
  const dlg = $("#dlg-map");
  $("#map-title").textContent = o.title;
  $("#map-radius-row").hidden = !o.area;
  $("#map-q").value = ""; $("#map-results").innerHTML = ""; $("#map-err").textContent = "";
  const rad = $("#map-r"); rad.value = String(o.r || 25); $("#map-r-val").textContent = rad.value + " km";
  let cur = Number.isFinite(o.la) && Number.isFinite(o.lo) ? { la: o.la, lo: o.lo } : null, name = o.name || null;
  dlg.showModal();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    const draw = () => {
      if (!map || !cur) return;
      const L = window.L, ll = [cur.la, cur.lo];
      if (!mark) mark = L.circleMarker(ll, { radius: 8, color: "#0f766e", weight: 3, fillOpacity: 0.9 }).addTo(map); else mark.setLatLng(ll);
      if (o.area) { const r = +rad.value * 1000; if (!circ) circ = L.circle(ll, { radius: r, color: "#0f766e", weight: 1, fillOpacity: 0.08 }).addTo(map); else { circ.setLatLng(ll); circ.setRadius(r); } }
      else if (circ) { circ.remove(); circ = null; }
      $("#map-pos").textContent = `${cur.la.toFixed(5)}, ${cur.lo.toFixed(5)}${name ? " . " + name : ""}`;
      $("#map-ok").disabled = false;
    };
    $("#map-ok").disabled = !cur; $("#map-pos").textContent = cur ? "" : "Search, or tap the map to drop a pin.";
    const safe = (fn) => { try { fn(); } catch (e) { console.warn("map:", e && e.message); } };
    loadLeaflet().then((L) => {
      requestAnimationFrame(() => safe(() => {
        if (!map) {
          map = L.map("map-canvas", { worldCopyJump: true, center: cur ? [cur.la, cur.lo] : [30, 0], zoom: cur ? 10 : 2 });
          L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
        }
        map.off("click"); if (mark) mark.remove(); if (circ) circ.remove(); mark = circ = null;
        map.invalidateSize();
        map.on("click", async (e) => { cur = { la: e.latlng.lat, lo: e.latlng.lng }; name = null; draw(); name = await reverseName(cur.la, cur.lo); draw(); });
        if (cur) { map.setView([cur.la, cur.lo], o.area ? Math.max(4, 12 - Math.round(Math.log2(+rad.value || 1))) : 12); draw(); } else map.setView([30, 0], 2);
      }));
    }).catch((e) => { $("#map-err").textContent = e.message + " You can still search for a place."; });
    rad.oninput = () => { $("#map-r-val").textContent = rad.value + " km"; safe(draw); };
    const doSearch = async () => {
      const q = $("#map-q").value.trim(); if (q.length < 2) return;
      $("#map-results").innerHTML = '<p class="note">Searching...</p>';
      try {
        const res = await geocode(q);
        $("#map-results").innerHTML = res.map((x, i) => `<button type="button" class="res" data-i="${i}">${x.name.replace(/[&<>"]/g, "")}</button>`).join("") || '<p class="note">No places found.</p>';
        $("#map-results").onclick = (ev) => { const b = ev.target.closest(".res"); if (!b) return; const x = res[+b.dataset.i]; cur = { la: x.la, lo: x.lo }; name = x.name; if (o.area) { rad.value = String(Math.max(1, Math.min(500, x.r))); $("#map-r-val").textContent = rad.value + " km"; } $("#map-results").innerHTML = ""; safe(() => { if (map) map.setView([x.la, x.lo], o.area ? Math.max(4, 12 - Math.round(Math.log2(+rad.value || 1))) : 13); draw(); }); if (!map) { $("#map-pos").textContent = `${x.la.toFixed(5)}, ${x.lo.toFixed(5)} . ${x.name}`; $("#map-ok").disabled = false; } };
      } catch (e) { $("#map-results").innerHTML = '<p class="note err">Place search is unavailable right now. Tap the map instead.</p>'; }
    };
    $("#map-go").onclick = doSearch;
    $("#map-q").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } };
    $("#map-q").oninput = null;
    $("#map-ok").onclick = () => finish(cur ? { la: +cur.la.toFixed(6), lo: +cur.lo.toFixed(6), r: o.area ? +rad.value : undefined, name, zone: zoneAt(cur.la, cur.lo) } : null);
    $("#map-cancel").onclick = () => finish(null);
    dlg.addEventListener("close", () => finish(null), { once: true });
  });
}
