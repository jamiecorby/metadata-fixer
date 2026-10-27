// Build the exact tags to write, and what a read-back must show.
import { exif } from "./time.js";
import { fmtOffset } from "./tz.js";
import { profileFor } from "./devices.js";

const p2 = (n) => String(n).padStart(2, "0");
const utcParts = (ms) => { const d = new Date(ms); return { date: `${d.getUTCFullYear()}:${p2(d.getUTCMonth() + 1)}:${p2(d.getUTCDate())}`, time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` }; };
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * @param {object} v
 *  kind "photo"|"video"; t naive ms|null; off minutes|null; la, lo numbers|null; alt|null;
 *  dev profile key; full bool (full iPhone tag set); label bool; write {date,gps,device} booleans
 * @returns {{tags:object, expect:object, summary:string[]}}
 */
export function buildTags(v) {
  const T = {}, E = {}, S = [];
  const video = v.kind === "video";
  const hasDate = v.write.date && v.t != null;
  const hasGps = v.write.gps && v.la != null && v.lo != null && isFinite(v.la) && isFinite(v.lo);
  const off = v.off;
  if (hasDate) {
    const local = exif(v.t);
    if (video) {
      const utc = exif(off != null ? v.t - off * 60000 : v.t);
      for (const k of ["CreateDate", "ModifyDate", "TrackCreateDate", "TrackModifyDate", "MediaCreateDate", "MediaModifyDate"]) T["QuickTime:" + k] = utc;
      T["Keys:CreationDate"] = local + (off != null ? fmtOffset(off) : "");
      E["QuickTime:CreateDate"] = utc;
      S.push(`Date ${local}${off != null ? " " + fmtOffset(off) : ""} (stored as ${utc} UTC)`);
    } else {
      T["EXIF:DateTimeOriginal"] = local; T["EXIF:CreateDate"] = local; T["EXIF:ModifyDate"] = local;
      const withOff = local + (off != null ? fmtOffset(off) : "");
      T["XMP-exif:DateTimeOriginal"] = withOff; T["XMP-xmp:CreateDate"] = withOff; T["XMP-photoshop:DateCreated"] = withOff;
      if (off != null) for (const k of ["OffsetTime", "OffsetTimeOriginal", "OffsetTimeDigitized"]) T["EXIF:" + k] = fmtOffset(off);
      E["ExifIFD:DateTimeOriginal"] = local;
      if (off != null) E["ExifIFD:OffsetTimeOriginal"] = fmtOffset(off);
      S.push(`Date ${local}${off != null ? " " + fmtOffset(off) : " (no offset)"}`);
    }
  }
  if (!hasDate && v.write.offsetOnly && v.t != null && off != null) {
    if (video) { T["Keys:CreationDate"] = exif(v.t) + fmtOffset(off); E["Keys:CreationDate"] = exif(v.t) + fmtOffset(off); }
    else { for (const k of ["OffsetTime", "OffsetTimeOriginal", "OffsetTimeDigitized"]) T["EXIF:" + k] = fmtOffset(off); E["ExifIFD:OffsetTimeOriginal"] = fmtOffset(off); }
    S.push(`Time zone ${fmtOffset(off)} added to the existing date`);
  }
  if (hasGps) {
    const la = r6(v.la), lo = r6(v.lo);
    if (video) {
      const iso = `${la}, ${lo}${v.alt != null ? ", " + Math.round(v.alt) : ""}`;
      T["Keys:GPSCoordinates"] = iso; T["UserData:GPSCoordinates"] = iso;
      E["Keys:GPSCoordinates"] = [la, lo];
    } else {
      T["GPS:GPSLatitude"] = Math.abs(la); T["GPS:GPSLatitudeRef"] = la >= 0 ? "N" : "S";
      T["GPS:GPSLongitude"] = Math.abs(lo); T["GPS:GPSLongitudeRef"] = lo >= 0 ? "E" : "W";
      if (v.alt != null) { T["GPS:GPSAltitude"] = Math.abs(v.alt); T["GPS:GPSAltitudeRef"] = v.alt >= 0 ? "Above Sea Level" : "Below Sea Level"; }
      T["XMP-exif:GPSLatitude"] = la; T["XMP-exif:GPSLongitude"] = lo;
      if (v.t != null && off != null) { const u = utcParts(v.t - off * 60000); T["GPS:GPSDateStamp"] = u.date; T["GPS:GPSTimeStamp"] = u.time; }
      E["Composite:GPSLatitude"] = la; E["Composite:GPSLongitude"] = lo;
    }
    S.push(`Location ${la.toFixed(5)}, ${lo.toFixed(5)}`);
  }
  const pr = v.write.device ? profileFor(v.dev, v.t) : null;
  if (pr) {
    if (video) { T["Keys:Make"] = "Apple"; T["Keys:Model"] = pr.model; T["Keys:Software"] = pr.ios; E["Keys:Model"] = pr.model; }
    else {
      Object.assign(T, { "IFD0:Make": "Apple", "IFD0:Model": pr.model, "IFD0:Software": pr.ios, "ExifIFD:LensMake": "Apple", "ExifIFD:LensModel": pr.lens, "ExifIFD:FocalLength": pr.fl, "ExifIFD:FNumber": pr.fn });
      if (v.full) Object.assign(T, { "IFD0:HostComputer": pr.model, "ExifIFD:FocalLengthIn35mmFormat": pr.f35, "ExifIFD:ExifVersion": "0232", "ExifIFD:SensingMethod": "One-chip color area", "ExifIFD:MeteringMode": "Multi-segment", "ExifIFD:ExposureMode": "Auto", "ExifIFD:WhiteBalance": "Auto", "ExifIFD:SceneCaptureType": "Standard" });
      E["IFD0:Model"] = pr.model;
      if (v.name) { T["IFD0:HostComputer"] = v.name; E["IFD0:HostComputer"] = v.name; } // the device name iOS records, e.g. "George's iPhone"
    }
    S.push(`Device ${pr.model} (iOS ${pr.ios})${v.name && !video ? ", named " + v.name : ""}`);
  }
  if (Object.keys(T).length && v.label) T["XMP-xmp:Label"] = "Reconstructed metadata";
  return { tags: T, expect: E, summary: S };
}

/** Compare a read-back (exiftool -json -n -G1) against expectations. */
export function verify(read, expect) {
  const diffs = [];
  for (const [k, want] of Object.entries(expect)) {
    let got = read[k];
    if (k === "Keys:GPSCoordinates") {
      const g = String(got || "").split(/[ ,]+/).map(Number);
      if (!(Math.abs(g[0] - want[0]) < 1e-4 && Math.abs(g[1] - want[1]) < 1e-4)) diffs.push(`${k}: expected ${want.join(", ")}, found ${got ?? "nothing"}`);
      continue;
    }
    if (typeof want === "number") { if (!(Math.abs(+got - want) < 1e-5)) diffs.push(`${k}: expected ${want}, found ${got ?? "nothing"}`); continue; }
    if (String(got ?? "").slice(0, String(want).length) !== String(want)) diffs.push(`${k}: expected ${want}, found ${got ?? "nothing"}`);
  }
  return { ok: diffs.length === 0, diffs };
}
