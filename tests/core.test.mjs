import { readFileSync } from "fs";
import assert from "assert/strict";
import { parseMetadata, writeMetadata } from "@uswriting/exiftool";
import { buildTags, verify } from "../src/core/tags.js";
import { offsetFor, utcToNaive, fmtOffset } from "../src/core/tz.js";
import { naive, human, parseStamp } from "../src/core/time.js";
import { fromFileName } from "../src/core/filenames.js";
import { parseTakeout, parseXmp, sidecarMatcher, takeoutTarget } from "../src/core/sidecars.js";
import { profileFor } from "../src/core/devices.js";
import { applyPattern } from "../src/core/naming.js";
let pass = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.log("FAIL", name, e.message); process.exitCode = 1; } };
const at = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.log("FAIL", name, e.message); process.exitCode = 1; } };

// --- time zones (DST)
t("lisbon summer", () => assert.equal(offsetFor("Europe/Lisbon", naive(2021, 7, 4, 14, 30)), 60));
t("lisbon winter", () => assert.equal(offsetFor("Europe/Lisbon", naive(2021, 1, 4, 14, 30)), 0));
t("denver summer", () => assert.equal(offsetFor("America/Denver", naive(2021, 7, 4, 14, 30)), -360));
t("denver winter", () => assert.equal(offsetFor("America/Denver", naive(2021, 12, 4, 14, 30)), -420));
t("sydney", () => assert.equal(offsetFor("Australia/Sydney", naive(2021, 1, 10, 9)), 660));
t("fixed", () => assert.equal(offsetFor("+05:30", naive(2021, 1, 10, 9)), 330));
t("utc->naive", () => assert.equal(human(utcToNaive("Europe/Lisbon", Date.UTC(2021, 6, 4, 13, 30))), "2021-07-04 14:30:00"));
t("fmtOffset", () => assert.equal(fmtOffset(-360), "-06:00"));
t("stamp invalid", () => assert.equal(parseStamp("2021-13-45 99:00:00"), null));
t("stamp offset", () => assert.equal(parseStamp("2019:07:04 14:30:00+01:00").off, 60));

// --- file names
const fn = (n) => { const r = fromFileName(n); return r && (r.utc ? "UTC " + new Date(r.t).toISOString().slice(0, 19) : human(r.t)) + " " + r.precision + " " + r.label; };
const cases = {
  "IMG_20190704_143000.jpg": "2019-07-04 14:30:00 second Android camera",
  "PXL_20190704_143000123.jpg": "2019-07-04 14:30:00 second Pixel",
  "20190704_143000.jpg": "2019-07-04 14:30:00 second Samsung camera",
  "IMG-20190704-WA0001.jpg": "2019-07-04 12:00:00 day WhatsApp",
  "WhatsApp Image 2019-07-04 at 14.30.00.jpeg": "2019-07-04 14:30:00 second WhatsApp",
  "Screenshot_2019-07-04-14-30-00.png": "2019-07-04 14:30:00 second Screenshot",
  "Screen Shot 2019-07-04 at 14.30.00.png": "2019-07-04 14:30:00 second Screenshot",
  "signal-2019-07-04-143000.jpg": "2019-07-04 14:30:00 second Signal",
  "2019-07-04 14.30.00.jpg": "2019-07-04 14:30:00 second Dropbox camera upload",
  "FB_IMG_1562250600000.jpg": "UTC 2019-07-04T14:30:00 second Facebook",
  "mmexport1562250600000.jpg": "UTC 2019-07-04T14:30:00 second WeChat",
  "Snapchat-1562250600.jpg": "UTC 2019-07-04T14:30:00 second Snapchat",
  "IMG_1234.JPG": null, "DSC01234.JPG": null, "holiday 2019.jpg": null,
  "IMG_20191345_143000.jpg": null,
};
for (const [n, want] of Object.entries(cases)) t("name " + n, () => assert.equal(fn(n), want));

// --- sidecars
const tk = parseTakeout(JSON.stringify({ title: "IMG_1234.jpg", photoTakenTime: { timestamp: "1562247000" }, geoData: { latitude: 38.7223, longitude: -9.1393, altitude: 50 }, creationTime: { timestamp: "1600000000" } }));
t("takeout parse", () => { assert.equal(tk.utc, 1562247000000); assert.equal(tk.lat, 38.7223); assert.equal(tk.alt, 50); });
t("takeout no geo", () => assert.equal(parseTakeout(JSON.stringify({ title: "a.jpg", photoTakenTime: { timestamp: "1" }, geoData: { latitude: 0, longitude: 0 } })).lat, null));
t("takeout target", () => { assert.deepEqual(takeoutTarget("IMG_1234.jpg.supplemental-metadata(1).json"), { base: "IMG_1234.jpg", dup: 1 }); assert.deepEqual(takeoutTarget("Very_long_original_file_name_2019_holiday.jpg.supple.json"), { base: "Very_long_original_file_name_2019_holiday.jpg", dup: 0 }); });
const m = sidecarMatcher([
  { name: "IMG_1234.jpg.json", kind: "takeout", data: tk },
  { name: "IMG_1234.jpg(1).json", kind: "takeout", data: { ...tk, utc: 1 } },
  { name: "Very_long_original_file_name_2019_holiday_in.json", kind: "takeout", data: { ...tk, title: null, utc: 2 } },
  { name: "DSC_0001.xmp", kind: "xmp", data: parseXmp('<x:xmpmeta><rdf:RDF><rdf:Description exif:DateTimeOriginal="2019-07-04T14:30:00+01:00" exif:GPSLatitude="38,43.338N" exif:GPSLongitude="9,8.358W"/></rdf:RDF></x:xmpmeta>') },
]);
t("match title", () => assert.equal(m("IMG_1234.jpg").takeout.utc, 1562247000000));
t("match dup", () => assert.equal(m("IMG_1234(1).jpg").takeout.utc, 1));
t("match edited", () => assert.equal(m("IMG_1234-edited.jpg").takeout.utc, 1562247000000));
t("match truncated", () => assert.equal(m("Very_long_original_file_name_2019_holiday_in_Lisbon.jpg").takeout.utc, 2));
t("match xmp", () => { const x = m("DSC_0001.NEF").xmp; assert.equal(x.dt.off, 60); assert.ok(Math.abs(x.lat - 38.7223) < 1e-3); assert.ok(x.lon < -9); });

// --- devices / naming
t("era 2019-07", () => assert.equal(profileFor("era", naive(2019, 7, 4)).model, "iPhone XS"));
t("era 2026", () => assert.equal(profileFor("era", naive(2026, 1, 1)).model, "iPhone 17 Pro"));
t("pattern", () => assert.equal(applyPattern("{date}_{time}_{orig}", { name: "x.JPG", t: naive(2021, 7, 4, 14, 30), dev: "era" }, { seq: 1 }), "2021-07-04_143000_x.JPG"));
t("pattern iphone", () => assert.equal(applyPattern("IMG_{seq4}.{EXT}", { name: "x.jpeg", t: null, dev: "era" }, { seq: 7 }), "IMG_0007.JPEG"));

// --- write + read-back with real ExifTool (WASM)
const fields = ["-json", "-n", "-G1", "-a", "-time:all", "-gps:all", "-Keys:all", "-UserData:GPSCoordinates", "-IFD0:Model", "-IFD0:Make", "-ExifIFD:LensModel", "-XMP:all", "-Composite:GPSLatitude", "-Composite:GPSLongitude"];
async function roundtrip(file, kind, opts = {}) {
  const buf = readFileSync("tests/fixtures/" + file);
  const tv = naive(2021, 7, 4, 14, 30, 5), off = offsetFor("Europe/Lisbon", tv);
  const b = buildTags({ kind, t: tv, off, la: 38.722252, lo: -9.139337, alt: opts.alt ?? null, dev: "era", full: true, label: true, write: { date: true, gps: true, device: true } });
  const w = await writeMetadata(new File([buf], file), b.tags, { args: ["-m"] });
  if (!w.success) throw new Error("write failed: " + w.error);
  const r = await parseMetadata(new File([w.data], file), { args: fields, transform: (d) => JSON.parse(d)[0] });
  const v = verify(r.data, b.expect);
  if (!v.ok) throw new Error(v.diffs.join("; "));
  return r.data;
}
await at("jpg roundtrip", async () => { const d = await roundtrip("plain.jpg", "photo", { alt: 50 }); assert.equal(d["XMP-photoshop:DateCreated"], "2021:07:04 14:30:05+01:00"); assert.equal(d["GPS:GPSTimeStamp"], "13:30:05"); assert.equal(d["GPS:GPSDateStamp"], "2021:07:04"); assert.ok(Math.abs(d["XMP-exif:GPSLatitude"] - 38.722252) < 1e-5, "xmp lat " + d["XMP-exif:GPSLatitude"]); assert.ok(d["XMP-exif:GPSLongitude"] < 0, "xmp lon sign " + d["XMP-exif:GPSLongitude"]); assert.equal(d["IFD0:Model"], "iPhone 12"); });
await at("png roundtrip", async () => { await roundtrip("plain.png", "photo"); });
await at("large jpg roundtrip", async () => { await roundtrip("large.jpg", "photo"); });
await at("mp4 roundtrip", async () => { const d = await roundtrip("plain.mp4", "video"); assert.equal(d["Keys:CreationDate"], "2021:07:04 14:30:05+01:00"); assert.match(String(d["UserData:GPSCoordinates"]), /^38\.72/); });
await at("mov roundtrip", async () => { await roundtrip("plain.mov", "video"); });
console.log(`core tests: ${pass} passed${process.exitCode ? ", some FAILED" : ""}`);
