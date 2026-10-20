// Sidecar files: Google Takeout JSON and XMP. Matched to media files by name.
import { parseStamp } from "./time.js";

const SUPP = ".supplemental-metadata";
export const isSidecar = (name) => /\.(json|xmp)$/i.test(name);

/** Parse a Google Takeout photo JSON. Returns null if it is not one. */
export function parseTakeout(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  if (!j || typeof j !== "object" || !(j.photoTakenTime || j.creationTime || j.title)) return null;
  const ts = j.photoTakenTime && +j.photoTakenTime.timestamp;
  const geo = [j.geoData, j.geoDataExif].find((g) => g && (Math.abs(+g.latitude) > 1e-7 || Math.abs(+g.longitude) > 1e-7));
  return {
    title: typeof j.title === "string" ? j.title : null,
    utc: ts > 0 ? ts * 1000 : null,
    lat: geo ? +geo.latitude : null,
    lon: geo ? +geo.longitude : null,
    alt: geo && isFinite(+geo.altitude) && +geo.altitude !== 0 ? +geo.altitude : null,
    description: typeof j.description === "string" && j.description.trim() ? j.description.trim() : null,
  };
}

function dms(v) {
  // XMP GPS "39,44.4N" or "39,44,24N" or decimal
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])$/i.exec(s);
  if (m) {
    let d = +m[1] + (+(m[2] || 0)) / 60 + (+(m[3] || 0)) / 3600;
    if (/[SW]/i.test(m[4])) d = -d;
    return d;
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function attrOrElem(xml, tag) {
  const a = new RegExp(tag + '="([^"]*)"').exec(xml);
  if (a) return a[1];
  const e = new RegExp("<" + tag + ">([^<]*)</" + tag + ">").exec(xml);
  return e ? e[1] : null;
}
/** Parse an XMP sidecar for capture date and GPS. */
export function parseXmp(text) {
  const xml = String(text || "");
  if (!/x:xmpmeta|rdf:RDF/.test(xml)) return null;
  let dt = null;
  for (const tag of ["exif:DateTimeOriginal", "photoshop:DateCreated", "xmp:CreateDate", "exif:DateTimeDigitized"]) {
    const v = attrOrElem(xml, tag);
    const p = v && parseStamp(v.replace("T", " "));
    if (p && p.hasTime) { dt = p; break; }
    if (p && !dt) dt = p;
  }
  const lat = dms(attrOrElem(xml, "exif:GPSLatitude")), lon = dms(attrOrElem(xml, "exif:GPSLongitude"));
  return { dt, lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null };
}

/** Normalise a Takeout JSON file name to the media name it describes, plus a duplicate index. */
export function takeoutTarget(jsonName) {
  let b = jsonName.replace(/\.json$/i, "");
  let dup = 0;
  const d = /\((\d+)\)$/.exec(b);
  if (d) { dup = +d[1]; b = b.slice(0, -d[0].length); }
  // strip a full or truncated ".supplemental-metadata" suffix
  for (let k = SUPP.length; k >= 2; k--) { if (b.toLowerCase().endsWith(SUPP.slice(0, k))) { b = b.slice(0, -k); break; } }
  return { base: b, dup };
}
function mediaKey(name) {
  // "IMG_1234(1).jpg" -> base "IMG_1234.jpg", dup 1 ; "-edited" variants map to the original
  let dup = 0;
  let n = name.replace(/\((\d+)\)(\.[^.]+)$/, (m0, k, ext) => { dup = +k; return ext; });
  n = n.replace(/-(?:edited|bearbeitet|modifié|editado|modificato|bewerkt)(\.[^.]+)$/i, "$1");
  return { n, dup };
}
/**
 * Build a matcher over parsed sidecars.
 * @param {{name:string, kind:"takeout"|"xmp", data:object}[]} cars
 */
export function sidecarMatcher(cars) {
  const takeout = cars.filter((c) => c.kind === "takeout");
  const xmp = cars.filter((c) => c.kind === "xmp");
  return function match(mediaName) {
    const { n, dup } = mediaKey(mediaName);
    const lower = n.toLowerCase();
    let tk = null;
    // 1) by title inside the JSON (most reliable), respecting duplicate index from the JSON file name
    const byTitle = takeout.filter((c) => c.data.title && c.data.title.toLowerCase() === lower);
    if (byTitle.length) tk = byTitle.find((c) => takeoutTarget(c.name).dup === dup) || (dup === 0 ? byTitle[0] : null);
    // 2) by file name, allowing Takeout's truncation of long names
    if (!tk) {
      tk = takeout.find((c) => { const t = takeoutTarget(c.name); return t.dup === dup && t.base.length >= 8 && (lower === t.base.toLowerCase() || lower.startsWith(t.base.toLowerCase())); }) || null;
    }
    const stem = n.replace(/\.[^.]+$/, "").toLowerCase();
    const xm = xmp.find((c) => { const b = c.name.replace(/\.xmp$/i, "").toLowerCase(); return b === lower || b === stem; }) || null;
    return { takeout: tk ? tk.data : null, takeoutName: tk ? tk.name : null, xmp: xm ? xm.data : null, xmpName: xm ? xm.name : null };
  };
}
