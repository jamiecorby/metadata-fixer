// Builds the synthetic authenticity fixtures in tests/fixtures/auth from three plain base images.
// Genuine = camera-style EXIF; AI-tagged = real tag structures (IPTC DigitalSourceType, Stable Diffusion PNG text, Midjourney XMP, C2PA JUMBF);
// tampered = impossible camera/date combinations or camera fields on an AI file. Nothing here is a real person's photo.
import { readFileSync, writeFileSync } from "fs";
import { writeMetadata } from "@uswriting/exiftool";
const D = "tests/fixtures/auth/", B = D + "base/";
const rd = (n) => readFileSync(B + n);
const wr = async (buf, name, tags, args = ["-m"]) => { const r = await writeMetadata(new File([buf], name), tags, { args }); if (!r.success) throw new Error(name + ": " + r.error); return Buffer.from(r.data); };

// ---- PNG text chunk and CBOR/JUMBF helpers
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const chunk = (type, data) => { const t = Buffer.from(type, "latin1"), body = Buffer.concat([t, data]); return Buffer.concat([u32(data.length), body, u32(crc(body))]); };
const pngText = (png, key, val) => { const at = 8 + 25; return Buffer.concat([png.subarray(0, at), chunk("tEXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(val, "latin1")])), png.subarray(at)]); };
const cbor = (v) => { const head = (maj, n) => (n < 24 ? Buffer.from([(maj << 5) | n]) : n < 256 ? Buffer.from([(maj << 5) | 24, n]) : Buffer.from([(maj << 5) | 25, n >> 8, n & 255]));
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const e = Object.entries(v); return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(x)])]); };
const box = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, "latin1"), payload]);
const jumd = (label) => box("jumd", Buffer.concat([Buffer.from("6332706100110010800000aa00389b71", "hex"), Buffer.from([3]), Buffer.from(label + "\0")]));
// A structurally valid-looking manifest store. NOT a real signed manifest: signatures are absent, which is exactly what the app says it does not validate.
const manifest = (claim) => box("jumb", Buffer.concat([jumd("c2pa"), box("jumb", Buffer.concat([jumd("urn:uuid:1234"), box("jumb", Buffer.concat([jumd("c2pa.assertions"), box("jumb", Buffer.concat([jumd("c2pa.actions"), box("cbor", cbor(claim.actions))]))])), box("jumb", Buffer.concat([jumd("c2pa.claim"), box("cbor", cbor({ claim_generator: claim.generator, title: "fixture" }))])), box("jumb", Buffer.concat([jumd("c2pa.signature"), box("cbor", Buffer.from("fixture-signature-placeholder"))]))]))]));
const addApp11 = (jpg, jumbf) => { const payload = Buffer.concat([Buffer.from("JP"), Buffer.from([0, 1]), u32(1), jumbf]); const len = payload.length + 2; return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xeb, len >> 8, len & 255]), payload, jpg.subarray(2)]); };

const DST = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const iphone = { "IFD0:Make": "Apple", "IFD0:Model": "iPhone 12", "ExifIFD:LensMake": "Apple", "ExifIFD:LensModel": "iPhone 12 back dual wide camera 4.2mm f/1.6", "ExifIFD:FocalLength": 4.2, "ExifIFD:FNumber": 1.6, "ExifIFD:ExposureTime": "1/120", "ExifIFD:ISO": 64 };
const when = (s) => ({ "EXIF:DateTimeOriginal": s, "EXIF:CreateDate": s, "EXIF:ModifyDate": s });

// 1. genuine
writeFileSync(D + "genuine_iphone.jpg", await wr(rd("photo_640.jpg"), "a.jpg", { ...iphone, ...when("2021:07:04 14:30:00"), "ExifIFD:OffsetTimeOriginal": "+01:00", "GPS:GPSLatitude": 38.7223, "GPS:GPSLatitudeRef": "N", "GPS:GPSLongitude": 9.1393, "GPS:GPSLongitudeRef": "W", "GPS:GPSDateStamp": "2021:07:04", "GPS:GPSTimeStamp": "13:30:00" }));
// 2. AI: declared by IPTC DigitalSourceType + Firefly
writeFileSync(D + "ai_firefly.jpg", await wr(rd("gen_1024.jpg"), "a.jpg", { "XMP-iptcExt:DigitalSourceType": DST + "trainedAlgorithmicMedia", "XMP-xmp:CreatorTool": "Adobe Firefly" }));
// 3. AI: Stable Diffusion (A1111) parameters in PNG text
writeFileSync(D + "ai_sd.png", pngText(rd("gen_1024.png"), "parameters", "a lighthouse at dusk, oil painting\nNegative prompt: blurry, lowres\nSteps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 123456, Size: 1024x1024, Model: sd_xl_base_1.0"));
// 4. AI: Midjourney-style XMP description, no declaration
writeFileSync(D + "ai_midjourney.png", await wr(rd("gen_1024.png"), "a.png", { "XMP-dc:Description": "a neon city street at night, rain --ar 1:1 --v 6.1 Job ID: 3f2b9c1e-0000-4000-8000-000000000001", "XMP-xmp:CreatorTool": "Midjourney Alpha" }));
// 5. AI: C2PA manifest from OpenAI (synthetic, unsigned)
writeFileSync(D + "ai_c2pa_openai.jpg", addApp11(rd("gen_1024.jpg"), manifest({ generator: "OpenAI DALL-E 3", actions: { actions: [{ action: "c2pa.created", digitalSourceType: DST + "trainedAlgorithmicMedia" }] } })));
// 6. genuine with Content Credentials: camera capture
writeFileSync(D + "c2pa_capture.jpg", addApp11(await wr(rd("photo_640.jpg"), "a.jpg", { "IFD0:Make": "LEICA CAMERA AG", "IFD0:Model": "LEICA M11", "ExifIFD:FocalLength": 35, "ExifIFD:FNumber": 2, "ExifIFD:ExposureTime": "1/500", "ExifIFD:ISO": 200, ...when("2024:05:06 10:11:12") }), manifest({ generator: "Leica Camera AG", actions: { actions: [{ action: "c2pa.created", digitalSourceType: DST + "digitalCapture" }] } })));
// 7. tampered: iPhone 15 Pro "taken" in 2012, phone with a 35 mm lens, modified before it was taken, Canon body called an iPhone
writeFileSync(D + "tampered_device_date.jpg", await wr(rd("photo_640.jpg"), "a.jpg", { "IFD0:Make": "Apple", "IFD0:Model": "iPhone 15 Pro", "ExifIFD:FocalLength": 35, "ExifIFD:FNumber": 1.8, "ExifIFD:ExposureTime": "1/60", "ExifIFD:ISO": 100, "EXIF:DateTimeOriginal": "2012:03:04 12:00:00", "EXIF:CreateDate": "2012:03:04 12:00:00", "EXIF:ModifyDate": "2011:01:01 09:00:00" }));
writeFileSync(D + "tampered_make_model.jpg", await wr(rd("photo_640.jpg"), "a.jpg", { "IFD0:Make": "Canon", "IFD0:Model": "iPhone 12", ...when("2021:07:04 14:30:00") }));
// 8. tampered: Stable Diffusion image dressed up with Canon camera fields (undeclared)
writeFileSync(D + "tampered_fake_camera_on_ai.jpg", await wr(rd("gen_1024.jpg"), "a.jpg", { "XMP-xmp:CreatorTool": "Stable Diffusion XL via ComfyUI", "IFD0:Make": "Canon", "IFD0:Model": "Canon EOS 5D Mark IV", "ExifIFD:FocalLength": 85, "ExifIFD:FNumber": 1.4, "ExifIFD:ExposureTime": "1/200", "ExifIFD:ISO": 100, "ExifIFD:LensModel": "EF85mm f/1.4L IS USM", ...when("2023:06:01 18:00:00") }));
// 9. stripped, generator-sized
writeFileSync(D + "stripped_1024.png", rd("gen_1024.png"));
// 10. edited in Photoshop with Generative Fill (AI-edited, camera data real)
writeFileSync(D + "edited_generative_fill.jpg", await wr(rd("photo_640.jpg"), "a.jpg", { ...iphone, ...when("2021:07:04 14:30:00"), "IFD0:Software": "Adobe Photoshop 26.0 (Macintosh)", "XMP-photoshop:History": "Generative Fill: sky replaced" }));
console.log("auth fixtures ok");
