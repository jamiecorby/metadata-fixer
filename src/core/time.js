// Naive date-time helpers (UTC fields hold the wall clock).
const p2 = (n) => String(n).padStart(2, "0");
export function naive(y, mo, d, h = 12, mi = 0, s = 0) {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const x = new Date(t);
  if (isNaN(t) || x.getUTCFullYear() !== y || x.getUTCMonth() !== mo - 1 || x.getUTCDate() !== d || x.getUTCHours() !== h || x.getUTCMinutes() !== mi || x.getUTCSeconds() !== s) return null;
  return t;
}
/** Parse "YYYY-MM-DD HH:MM[:SS]" or EXIF "YYYY:MM:DD HH:MM:SS" (any trailing offset is returned separately). */
export function parseStamp(s) {
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s || "").trim());
  if (!m) return null;
  const t = naive(+m[1], +m[2], +m[3], m[4] != null ? +m[4] : 12, m[5] != null ? +m[5] : 0, m[6] != null ? +m[6] : 0);
  if (t == null) return null;
  let off = null;
  if (m[7] === "Z") off = 0;
  else if (m[7]) { const o = m[7].replace(":", ""); off = (o[0] === "-" ? -1 : 1) * (+o.slice(1, 3) * 60 + +o.slice(3, 5)); }
  return { t, off, hasTime: m[4] != null };
}
export const exif = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}:${p2(d.getUTCMonth() + 1)}:${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
export const human = (t) => exif(t).replace(/^(\d+):(\d+):(\d+)/, "$1-$2-$3");
export const dayOnly = (t) => human(t).slice(0, 10);
export function plausible(t, now = Date.now()) {
  if (t == null || isNaN(t)) return false;
  const y = new Date(t).getUTCFullYear();
  return y >= 1990 && t <= now + 2 * 86400000;
}
export { p2 };
