// Interpret ExifTool output (-json -n -G1 -a) into the facts we trust.
import { parseStamp, plausible } from "./time.js";

const PHOTO_DATES = ["ExifIFD:DateTimeOriginal", "XMP-exif:DateTimeOriginal", "XMP-photoshop:DateCreated", "ExifIFD:CreateDate", "XMP-xmp:CreateDate", "IPTC:DateCreated", "PNG:CreationTime", "IFD0:ModifyDate"];
const OFFSETS = ["ExifIFD:OffsetTimeOriginal", "ExifIFD:OffsetTime", "ExifIFD:OffsetTimeDigitized"];
function offStr(s) { const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s || "").trim()); return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : null; }

/**
 * @returns {{date: null|{t?:number, u?:number, off:number|null, tag:string, weak:boolean},
 *            gps: null|{la:number, lo:number, alt:number|null, tag:string},
 *            device: null|{make:string|null, model:string|null}}}
 *  date.t = wall-clock (naive) ms when the tag is local time; date.u = absolute UTC ms (QuickTime).
 */
export function interpretExisting(r, kind, now = Date.now()) {
  r = r || {};
  let date = null;
  if (kind === "video") {
    const k = parseStamp(r["Keys:CreationDate"] || r["UserData:DateTimeOriginal"]);
    if (k && plausible(k.t, now)) date = { t: k.t, off: k.off, tag: "Keys:CreationDate", weak: false };
    if (!date) {
      for (const tag of ["QuickTime:CreateDate", "QuickTime:MediaCreateDate", "QuickTime:TrackCreateDate"]) {
        const q = parseStamp(r[tag]);
        if (q && plausible(q.t, now)) { date = { u: q.t, off: null, tag, weak: false }; break; }
      }
    }
  } else {
    for (const tag of PHOTO_DATES) {
      const p = parseStamp(r[tag]);
      if (p && p.hasTime && plausible(p.t, now)) {
        let off = p.off;
        if (off == null) for (const o of OFFSETS) { const v = offStr(r[o]); if (v != null) { off = v; break; } }
        date = { t: p.t, off, tag, weak: tag === "IFD0:ModifyDate" };
        break;
      }
    }
  }
  let gps = null;
  const la = +r["Composite:GPSLatitude"], lo = +r["Composite:GPSLongitude"];
  if (isFinite(la) && isFinite(lo) && (Math.abs(la) > 1e-7 || Math.abs(lo) > 1e-7) && r["Composite:GPSLatitude"] != null) {
    const alt = r["Composite:GPSAltitude"] != null ? +r["Composite:GPSAltitude"] : null;
    gps = { la, lo, alt: isFinite(alt) ? alt : null, tag: "GPS" };
  } else {
    for (const tag of ["Keys:GPSCoordinates", "UserData:GPSCoordinates", "Keys:LocationISO6709"]) {
      const s = r[tag];
      if (!s) continue;
      const iso = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(String(s));
      const parts = iso ? [iso[1], iso[2], iso[3]] : String(s).split(/[ ,]+/);
      const a = +parts[0], b = +parts[1];
      if (isFinite(a) && isFinite(b) && (Math.abs(a) > 1e-7 || Math.abs(b) > 1e-7)) { gps = { la: a, lo: b, alt: parts[2] != null && isFinite(+parts[2]) ? +parts[2] : null, tag }; break; }
    }
  }
  const make = r["IFD0:Make"] || r["Keys:Make"] || r["UserData:Make"] || null;
  const model = r["IFD0:Model"] || r["Keys:Model"] || r["UserData:Model"] || null;
  return { date, gps, device: make || model ? { make, model } : null };
}
export const READ_ARGS = ["-json", "-n", "-G1", "-a", "-time:all", "-gps:all", "-Keys:all", "-UserData:all", "-IFD0:Make", "-IFD0:Model", "-IFD0:Software", "-ExifIFD:LensModel", "-XMP:all", "-Composite:GPSLatitude", "-Composite:GPSLongitude", "-Composite:GPSAltitude", "-File:ImageWidth", "-File:ImageHeight", "-Composite:ImageSize"];
