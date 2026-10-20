// Time zone helpers. "Naive" times are wall-clock times stored as UTC epoch ms
// (read only with getUTC*), so they never shift with the viewer's own zone.
const cache = new Map();
function dtf(zone) {
  let f = cache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    cache.set(zone, f);
  }
  return f;
}
export function isZone(z) {
  if (!z || typeof z !== "string") return false;
  try { dtf(z); return true; } catch (e) { return false; }
}
export function parseFixed(s) {
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2}):?(\d{2})?$/.exec(String(s || "").trim());
  if (!m) return null;
  const v = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
  return Math.abs(v) <= 14 * 60 ? v : null;
}
/** Offset in minutes of an IANA zone at an absolute instant. */
export function offsetAtInstant(zone, utcMs) {
  const t = Math.floor(utcMs / 1000) * 1000;
  const p = {};
  for (const x of dtf(zone).formatToParts(new Date(t))) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUTC - t) / 60000);
}
/** Offset (minutes) that applies to a wall-clock time in a zone spec (IANA name or fixed "+01:00"). DST-correct. */
export function offsetFor(zoneSpec, naiveMs) {
  const fx = parseFixed(zoneSpec);
  if (fx != null) return fx;
  if (!isZone(zoneSpec)) return null;
  const o1 = offsetAtInstant(zoneSpec, naiveMs - 0);
  const o2 = offsetAtInstant(zoneSpec, naiveMs - o1 * 60000);
  if (o1 === o2) return o1;
  const o3 = offsetAtInstant(zoneSpec, naiveMs - o2 * 60000);
  return o3;
}
/** Wall-clock (naive) time in a zone for an absolute UTC instant. */
export function utcToNaive(zoneSpec, utcMs) {
  const fx = parseFixed(zoneSpec);
  if (fx != null) return utcMs + fx * 60000;
  if (!isZone(zoneSpec)) return null;
  return utcMs + offsetAtInstant(zoneSpec, utcMs) * 60000;
}
export function fmtOffset(min) {
  if (min == null) return "";
  const s = min < 0 ? "-" : "+", a = Math.abs(min);
  return `${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
}
export function allZones() {
  try { return Intl.supportedValuesOf("timeZone"); } catch (e) { return ["UTC"]; }
}
