import { profileFor } from "./devices.js";
export const BUILTIN = {
  "Keep original name": "{orig}",
  "iPhone (IMG_0001.JPG)": "IMG_{seq4}.{EXT}",
  "Date and time": "{date}_{time}_{orig}",
  "Date, device, number": "{date}_{device}_{seq4}",
};
const slug = (x) => String(x || "").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-");
/** it: {name, t, dev}; ctx: {seq, place} */
export function applyPattern(pattern, it, ctx) {
  const pat = (pattern || "{orig}").trim() || "{orig}";
  const m = /^(.*?)(\.[^.]+)?$/.exec(it.name), base = m[1], ext = m[2] || "";
  const d = it.t != null ? new Date(it.t) : null, z = (n, w) => String(n).padStart(w, "0");
  const pr = profileFor(it.dev, it.t);
  const V = {
    orig: base,
    date: d ? `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1, 2)}-${z(d.getUTCDate(), 2)}` : "undated",
    time: d ? `${z(d.getUTCHours(), 2)}${z(d.getUTCMinutes(), 2)}${z(d.getUTCSeconds(), 2)}` : "000000",
    y: d ? d.getUTCFullYear() : "", m: d ? z(d.getUTCMonth() + 1, 2) : "", d: d ? z(d.getUTCDate(), 2) : "",
    seq: ctx.seq, seq4: z(ctx.seq, 4), device: slug(pr ? pr.model : "device"),
    place: slug(String(ctx.place || "").split(",")[0]) || "place",
    ext: ext.slice(1).toLowerCase(), EXT: ext.slice(1).toUpperCase(),
  };
  let o = pat.replace(/\{(\w+)\}/g, (x, k) => (k in V ? V[k] : x));
  if (!/\{(ext|EXT)\}/.test(pat)) o += ext;
  o = o.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").trim().replace(/^\.+/, "");
  return o || it.name;
}
export const usesSeq = (pattern) => /\{seq/.test(pattern || "");
