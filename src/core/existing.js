// Interpret ExifTool output (-json -n -G1 -a) into the facts we trust.
import { parseStamp, plausible } from "./time.js";

const PHOTO_DATES = ["ExifIFD:DateTimeOriginal", "XMP-exif:DateTimeOriginal", "XMP-photoshop:DateCreated", "Composite:DateTimeCreated", "ExifIFD:CreateDate", "XMP-xmp:CreateDate", "PNG:CreationTime", "IFD0:ModifyDate"];
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
    let dayOnly = null;
    for (const tag of PHOTO_DATES) {
      const p = parseStamp(r[tag]);
      if (!p || !plausible(p.t, now)) continue;
      if (!p.hasTime) { if (!dayOnly) dayOnly = { t: p.t, off: null, tag, weak: false, dateOnly: true }; continue; }
      let off = p.off;
      if (off == null) for (const o of OFFSETS) { const v = offStr(r[o]); if (v != null) { off = v; break; } }
      date = { t: p.t, off, tag, weak: tag === "IFD0:ModifyDate" };
      break;
    }
    if (!date || (date.weak && dayOnly)) date = dayOnly || date;
  }
  let gps = null;
  for (const [A, B, tag] of [["Composite:GPSLatitude", "Composite:GPSLongitude", "GPS"], ["XMP-exif:GPSLatitude", "XMP-exif:GPSLongitude", "XMP GPS"]]) {
    const la = +r[A], lo = +r[B];
    if (r[A] != null && r[B] != null && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (Math.abs(la) > 1e-7 || Math.abs(lo) > 1e-7)) {
      const alt = r["Composite:GPSAltitude"] != null ? +r["Composite:GPSAltitude"] : null;
      gps = { la, lo, alt: Number.isFinite(alt) ? alt : null, tag }; break;
    }
  }
  if (!gps) {
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
  const issue = damage(r, kind);
  return { date, gps, device: make || model ? { make, model } : null, issue, fileExt: r["File:FileTypeExtension"] ? String(r["File:FileTypeExtension"]).toLowerCase() : null };
}
const FAMILY = { jpg: "jpeg", jpeg: "jpeg", jpe: "jpeg", png: "png", tif: "tiff", tiff: "tiff", heic: "heic", heif: "heic", webp: "webp", avif: "avif", mov: "qt", qt: "qt", mp4: "qt", m4v: "qt", "3gp": "qt", "3g2": "qt" };
/** The file's real extension when it differs from what the name claims (e.g. a PNG saved as .jpg), else null. */
export function realExt(fileExt, name) {
  const e = String(fileExt || "").toLowerCase(), claimed = String(name || "").toLowerCase().replace(/^.*\./, "");
  if (!e || !name || !FAMILY[e] || !FAMILY[claimed] || FAMILY[e] === FAMILY[claimed]) return null;
  return e === "jpeg" ? "jpg" : e;
}
/** A short human message when ExifTool says the file is damaged or unreadable, else null. */
function damage(r, kind) {
  const e = String(r["ExifTool:Error"] || "").trim(), w = String(r["ExifTool:Warning"] || "").trim();
  if (e) return "ExifTool could not read this file properly: " + e.slice(0, 160);
  const fe = String(r["File:FileTypeExtension"] || "").toLowerCase();
  if (fe && !FAMILY[fe] && fe !== "dng") return `This file isn't a ${kind} (its contents look like ${fe.toUpperCase()}).`;
  if (kind === "photo" && r["File:ImageWidth"] == null && r["File:FileType"] == null && r["Composite:ImageSize"] == null) return "No picture data could be read: the file may be damaged or not an image.";
  if (/truncated|corrupt|bad |invalid|unexpected|end of file|not a valid/i.test(w)) return "The file looks damaged (" + w.slice(0, 140) + "). Metadata can still be written, but check the result opens correctly.";
  return null;
}
export const READ_ARGS = ["-json", "-n", "-G1", "-a", "-time:all", "-gps:all", "-Keys:all", "-UserData:all", "-IFD0:Make", "-IFD0:Model", "-IFD0:Software", "-IFD0:HostComputer", "-ExifIFD:LensModel", "-XMP:all", "-IPTC:all", "-Composite:DateTimeCreated", "-Composite:GPSLatitude", "-Composite:GPSLongitude", "-Composite:GPSAltitude", "-File:ImageWidth", "-File:ImageHeight", "-Composite:ImageSize", "-File:FileType", "-File:FileTypeExtension", "-ExifTool:Warning", "-ExifTool:Error",
  // for the authenticity check
  "-PNG:all", "-JUMBF:all", "-MakerNotes:all", "-ExifIFD:ExposureTime", "-ExifIFD:FNumber", "-ExifIFD:ISO", "-ExifIFD:FocalLength", "-ExifIFD:FocalLengthIn35mmFormat", "-ExifIFD:LensMake", "-IFD0:ImageDescription", "-IFD0:Artist", "-ExifIFD:UserComment", "-File:Comment"];
