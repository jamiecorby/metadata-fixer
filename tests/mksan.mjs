// Builds the sanitisation fixtures: files that carry a known set of metadata, previews, manifests and trailing data.
// The sentinel strings are searched for in the sanitised bytes by tests/sanitise.test.mjs.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { writeMetadata } from "@uswriting/exiftool";
import { crc32 } from "../src/core/sanitise.js";
const D = "tests/fixtures/san/"; mkdirSync(D, { recursive: true });
const rd = (n) => new Uint8Array(readFileSync(D + n)), wr = (n, b) => writeFileSync(D + n, b);
const cat = (...p) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const A = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));
const be32 = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255), le32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
export const SENTINELS = ["SENTINEL-Camera-Maker", "SENTINEL-Model-X9", "SENTINEL-Software-Photoshop", "SENTINEL-Artist-Jane", "SENTINEL-Copyright-2026", "SENTINEL-Caption-Beach", "SENTINEL-Keyword-Holiday", "SENTINEL-Serial-123456", "SENTINEL-Prompt-a-red-fox", "SENTINEL-History-Edited"];
const tags = { "IFD0:Make": SENTINELS[0], "IFD0:Model": SENTINELS[1], "IFD0:Software": SENTINELS[2], "IFD0:Artist": SENTINELS[3], "IFD0:Copyright": SENTINELS[4], "IFD0:ImageDescription": SENTINELS[5], "ExifIFD:DateTimeOriginal": "2019:07:04 14:30:00", "ExifIFD:SerialNumber": SENTINELS[7], "GPS:GPSLatitude": 51.5072, "GPS:GPSLatitudeRef": "N", "GPS:GPSLongitude": 0.1276, "GPS:GPSLongitudeRef": "W", "XMP-xmp:CreatorTool": SENTINELS[2], "XMP-dc:Creator": SENTINELS[3], "XMP-dc:Description": SENTINELS[8], "XMP-photoshop:History": SENTINELS[9], "XMP-photoshop:Headline": SENTINELS[5] };
const ex = async (name, data, t, args = []) => { const w = await writeMetadata(new File([data], name), t, { args: ["-m", ...args] }); if (!w.data) throw new Error(name + ": " + w.error); if (!w.success) console.log("note", name, String(w.error).trim().slice(0, 100)); return new Uint8Array(w.data); };
const seg = (m, payload) => cat(Uint8Array.of(0xff, m, (payload.length + 2) >> 8, (payload.length + 2) & 255), payload);
const insertAfterSoi = (jpg, ...segs) => cat(jpg.subarray(0, 2), ...segs, jpg.subarray(2));
const MANIFEST = cat(A("JP"), Uint8Array.of(0, 1, 0, 0), A("jumb....c2pa SENTINEL-C2PA-Manifest claim_generator OpenAI"));
const ICC_SRGB = cat(new Uint8Array(128), A("desc....sRGB IEC61966-2.1  HP"), new Uint8Array(40)), ICC_P3 = cat(new Uint8Array(128), A("desc....Display P3   Apple"), new Uint8Array(40));
const icc = (p) => seg(0xe2, cat(A("ICC_PROFILE\0"), Uint8Array.of(1, 1), p));

// ---- JPEG
const base = rd("base.jpg");
let rich = await ex("a.jpg", base, { ...tags, "IPTC:Keywords": SENTINELS[6], "IPTC:Caption-Abstract": SENTINELS[5], "Comment": "SENTINEL-Comment-Text", "ThumbnailImage": "base64:" + Buffer.from(base).toString("base64") });
rich = insertAfterSoi(rich, seg(0xeb, MANIFEST), icc(ICC_SRGB), seg(0xe2, cat(A("MPF\0"), new Uint8Array(20))), seg(0xe1, cat(A("http://ns.adobe.com/xmp/extension/\0"), A("ext SENTINEL-ExtendedXMP"))));
wr("rich.jpg", rich);
wr("rich-orient.jpg", await ex("o.jpg", rich, { "IFD0:Orientation#": 6 }));
wr("rich-p3.jpg", insertAfterSoi(base, icc(ICC_P3)));
wr("rich-aux.jpg", cat(rich, cat(Uint8Array.of(0xff, 0xd8), seg(0xe1, A("Exif\0\0SENTINEL-GainMap")), Uint8Array.of(0xff, 0xd9))));
wr("rich-motion.jpg", cat(rich, cat(be32(24), A("ftypisom"), new Uint8Array(12), A("moov SENTINEL-MotionVideo"))));
wr("rich-trailer.jpg", cat(rich, A("SENTINEL-Appended-Payload-0123456789")));
wr("bad-truncated.jpg", rich.subarray(0, Math.floor(rich.length * 0.6)));
// ---- PNG
const png = rd("base.png"); const chunk = (t, d) => { const td = cat(A(t), d); return cat(be32(d.length), td, be32(crc32(td, 0, td.length))); };
const iend = png.length - 12;
wr("rich.png", cat(png.subarray(0, iend), chunk("tEXt", A("Software\0SENTINEL-Software-Photoshop")), chunk("iTXt", cat(A("XML:com.adobe.xmp\0\0\0\0\0"), A("<x:xmpmeta>SENTINEL-History-Edited</x:xmpmeta>"))), chunk("tEXt", A("parameters\0SENTINEL-Prompt-a-red-fox")), chunk("eXIf", A("MM\0*SENTINEL-Model-X9")), chunk("tIME", Uint8Array.of(7, 234, 7, 4, 14, 30, 0)), chunk("pHYs", cat(be32(2835), be32(2835), Uint8Array.of(1))), chunk("caBX", A("jumb SENTINEL-C2PA-Manifest")), chunk("iCCP", cat(A("sRGB IEC61966-2.1\0\0"), new Uint8Array(10))), png.subarray(iend), A("SENTINEL-Appended-Payload-0123456789")));
wr("bad-crc.png", (() => { const b = new Uint8Array(rd("rich.png")); b[40] ^= 0xff; return b; })());
// ---- WebP: wrap the simple bitstream in an extended file with metadata chunks
const wp = rd("base.webp"), vp8 = wp.subarray(12);
const rc = (t, d) => cat(A(t), le32(d.length), d, d.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
const dims = (() => { const d = vp8.subarray(8); return [1 + (d[1] | ((d[2] & 0x3f) << 8)), 1 + ((d[2] >> 6) | (d[3] << 2) | ((d[4] & 0xf) << 10))]; })();
const vp8x = rc("VP8X", cat(Uint8Array.of(0x20 | 0x08 | 0x04, 0, 0, 0), Uint8Array.of((dims[0] - 1) & 255, ((dims[0] - 1) >> 8) & 255, 0, (dims[1] - 1) & 255, ((dims[1] - 1) >> 8) & 255, 0)));
const body = cat(A("WEBP"), vp8x, rc("ICCP", ICC_SRGB), vp8, rc("EXIF", cat(A("MM\0*"), A("SENTINEL-Model-X9"))), rc("XMP ", A("<x:xmpmeta>SENTINEL-History-Edited</x:xmpmeta>")), rc("C2PA", A("jumb SENTINEL-C2PA-Manifest")));
wr("rich.webp", cat(A("RIFF"), le32(body.length), body, A("SENTINEL-Appended-Payload-0123456789")));
// ---- TIFF
wr("rich.tif", await ex("a.tif", rd("base.tif"), { ...tags, "IPTC:Keywords": SENTINELS[6] }));
wr("rich-orient.tif", await ex("a.tif", rd("rich.tif"), { "IFD0:Orientation#": 6 }));
wr("fake.dng", cat(rd("rich.tif"))); // extension only; a real DNG test uses the DNGVersion tag below
// ---- AVIF/HEIF: metadata written by ExifTool (Exif + XMP items)
try { wr("rich.avif", await ex("a.avif", rd("base.avif"), { "IFD0:Make": SENTINELS[0], "IFD0:Model": SENTINELS[1], "IFD0:Software": SENTINELS[2], "XMP-dc:Creator": SENTINELS[3], "XMP-dc:Description": SENTINELS[8], "GPS:GPSLatitude": 51.5, "GPS:GPSLatitudeRef": "N", "GPS:GPSLongitude": 0.12, "GPS:GPSLongitudeRef": "W" })); } catch (e) { console.log("avif metadata not writable:", e.message); }
// ---- video
const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const meta = ["-metadata", "title=SENTINEL-Title-Holiday", "-metadata", "artist=SENTINEL-Artist-Jane", "-metadata", "comment=SENTINEL-Comment-Text", "-metadata", "location=+51.5072-000.1276/", "-metadata", "encoder=SENTINEL-Encoder", "-metadata", "creation_time=2019-07-04T14:30:00Z", "-metadata", "make=SENTINEL-Camera-Maker", "-metadata", "model=SENTINEL-Model-X9"];
ff(["-i", D + "base.mp4", "-c", "copy", ...meta, "-movflags", "use_metadata_tags", D + "_m.mp4"]);
wr("rich.mp4", cat(rd("_m.mp4"), cat(be32(40), A("uuid"), new Uint8Array(16), A("SENTINEL-XMP-uuid-payload")), A("SENTINEL-Appended-Payload-0123456789")));
ff(["-i", D + "base.mov", "-c", "copy", ...meta, "-movflags", "use_metadata_tags", D + "_m.mov"]);
wr("rich.mov", rd("_m.mov"));
wr("bad-truncated.mp4", rd("rich.mp4").subarray(0, 30));
import { unlinkSync } from "fs"; for (const f of ["_m.mp4", "_m.mov"]) unlinkSync(D + f);
console.log("sanitise fixtures ok");
