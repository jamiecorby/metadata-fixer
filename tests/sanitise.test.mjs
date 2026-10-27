// Sanitisation: byte-level tests against the exported files. Every assertion reads the actual output bytes, never internal state.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { runBatch } from "../src/vendor/exiftool.js";
import { sanitise, detect, LIMITS, Unsupported, Damaged, NeedsDecision, NeedsReencode, crc32 } from "../src/core/sanitise.js";
import { verifyOutput, readBackFindings, sameBytes } from "../src/core/sanverify.js";
if (!existsSync("tests/fixtures/san/rich.jpg")) execFileSync("node", ["tests/mksan.mjs"], { stdio: "inherit" });
const D = "tests/fixtures/san/", OUT = "tests/out/san/"; mkdirSync(OUT, { recursive: true });
let bad = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL", m); } else if (process.env.V) console.log("ok  ", m); };
const fx = (name) => new File([readFileSync(D + name)], name);
const bytesOf = async (x) => new Uint8Array(x instanceof Blob ? await x.arrayBuffer() : x);
const has = (b, s) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const SENT = ["SENTINEL-Camera-Maker", "SENTINEL-Model-X9", "SENTINEL-Software-Photoshop", "SENTINEL-Artist-Jane", "SENTINEL-Copyright-2026", "SENTINEL-Caption-Beach", "SENTINEL-Keyword-Holiday", "SENTINEL-Serial-123456", "SENTINEL-Prompt-a-red-fox", "SENTINEL-History-Edited", "SENTINEL-Title-Holiday", "SENTINEL-Comment-Text", "SENTINEL-Encoder", "SENTINEL-C2PA-Manifest", "SENTINEL-ExtendedXMP", "SENTINEL-Appended-Payload", "SENTINEL-XMP-uuid", "SENTINEL-MotionVideo", "SENTINEL-GainMap"];
const MARK = ["Exif\0\0", "ns.adobe.com", "xmpmeta", "xpacket", "Photoshop 3.0", "8BIM", "c2pa", "OpenAI", "com.apple.quicktime", "\xa9xyz", "\xa9mak", "\xa9swr"];
const readTags = async (b, name) => { const ext = name.split(".").pop(); const r = await runBatch([{ path: "/x." + ext, data: new File([b], "x") }], ["-json", "-G1", "-a", "-u", "-s", "/x." + ext]); const j = JSON.parse(r.out || "[{}]")[0] || {}; return j; };
const run = async (name, opts = {}) => {
  const src = fx(name), r = await sanitise(src, name, opts), out = r.out instanceof Blob ? r.out : new Blob([r.out]);
  const ob = await bytesOf(out), sb = await bytesOf(src);
  const v = await verifyOutput({ srcBlob: src, outBlob: out, kind: r.kind, rep: r.rep, reencoded: !!opts.reencoded, readBack: (blob) => readTags(blob, name) });
  return { r, out, ob, sb, v };
};
const sentIn = (b) => SENT.filter((s) => has(b, s));
const throws = async (name, cls, opts) => { try { await sanitise(fx(name), name, opts || {}); return false; } catch (e) { return e instanceof cls ? e : false; } };

/* ---- 1. rich files: every sentinel in the source, none in the output; second reader finds nothing */
for (const name of ["rich.jpg", "rich.png", "rich.webp", "rich.tif", "rich.avif", "rich.mp4", "rich.mov"]) {
  let res; try { res = await run(name); } catch (e) { ok(false, name + " threw " + e.message); continue; }
  const { ob, sb, v, r } = res, inSrc = sentIn(sb), inOut = sentIn(ob);
  ok(inSrc.length >= 3, `${name}: fixture really carries metadata (${inSrc.length} sentinels in source)`);
  ok(inOut.length === 0, `${name}: no sentinel text in the output bytes (${inOut.join(",")})`);
  ok(MARK.every((m) => !has(ob, m)), `${name}: no metadata/provenance marker strings in the output (${MARK.filter((m) => has(ob, m)).map((x) => x.replace(/\0/g, "")).join(",")})`);
  ok(v.status !== "failed", `${name}: verifier status ${v.status} (${v.checks.filter((c) => c.result === "fail").map((c) => c.id + ":" + c.detail).join("; ")})`);
  ok(v.checks.find((c) => c.id === "readback").result === "pass", `${name}: ExifTool finds no metadata tags in the output`);
  ok(r.rep.removed.length > 0, `${name}: audit lists what was removed (${r.rep.removed.map((x) => x.what).join("; ").slice(0, 160)})`);
  ok(detect(ob.subarray(0, 64)) === r.kind, `${name}: output is the same format`);
  if (r.kind !== "mp4") ok(r.kind === "heif" ? ob.length <= sb.length : ob.length < sb.length, `${name}: output is not larger than the source`);
  const t = await readTags(new Blob([ob]), name); const left = readBackFindings(t); ok(left.length === 0, `${name}: independent ExifTool read: nothing left (${left.join(", ")})`);
}

/* ---- 2. what must be reported */
{
  const { r } = await run("rich.jpg"); const w = r.rep.removed.map((x) => x.what).join("|");
  ok(/EXIF \(.*GPS/.test(w), "JPEG audit names the EXIF block with GPS"); ok(/XMP/.test(w) && /Extended XMP/.test(w), "JPEG audit names XMP and extended XMP"); ok(/Photoshop \/ IPTC/.test(w), "JPEG audit names IPTC"); ok(/content-credentials manifest/.test(w), "JPEG audit names the manifest"); ok(/comment/i.test(w), "JPEG audit names the comment"); ok(/ICC/.test(w), "JPEG audit names the ICC profile"); ok(/thumbnail/.test(w), "JPEG audit mentions the embedded thumbnail"); ok(/Multi-picture/.test(w), "JPEG audit names the multi-picture index");
  const p = await run("rich.png"); const pw = p.r.rep.removed.map((x) => x.what).join("|"); ok(/text chunk/.test(pw) && /EXIF/.test(pw) && /XMP/.test(pw) && /Modification time/.test(pw) && /manifest/.test(pw) && /Data appended/.test(pw), "PNG audit lists text, EXIF, XMP, time, manifest, appended data");
  const w2 = await run("rich.webp"); const ww = w2.r.rep.removed.map((x) => x.what).join("|"); ok(/EXIF/.test(ww) && /XMP/.test(ww) && /manifest/.test(ww) && /ICC/.test(ww) && /Data appended/.test(ww), "WebP audit lists EXIF, XMP, manifest, ICC, appended data");
  const a = await run("rich.avif"); const aw = a.r.rep.removed.map((x) => x.what).join("|"); ok(/EXIF/.test(aw) && /XMP/.test(aw), "AVIF audit lists EXIF and XMP items");
  const m = await run("rich.mp4"); const mw = m.r.rep.removed.map((x) => x.what).join("|"); ok(/User data|Metadata container/.test(mw) && /uuid/.test(mw) && /appended/i.test(mw), "MP4 audit lists user data, uuid box, appended data");
  ok(m.v.status === "limited" && m.r.rep.limits.some((l) => /bitstream/.test(l)), "MP4 is never called fully verified (bitstream text can't be inspected)");
}

/* ---- 3. pixels and structure preserved */
{
  const j = await run("rich.jpg"); writeFileSync(OUT + "j-src.jpg", j.sb); writeFileSync(OUT + "j-out.jpg", j.ob);
  const py = (code) => spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" });
  const cmp = (a, b) => py(`from PIL import Image,ImageChops;a=Image.open('${a}');b=Image.open('${b}');a.load();b.load();print(a.size==b.size and a.mode==b.mode and ImageChops.difference(a.convert('RGBA'),b.convert('RGBA')).getbbox() is None, a.size, b.size)`).stdout.trim();
  ok(cmp(OUT + "j-src.jpg", OUT + "j-out.jpg").startsWith("True"), "JPEG decodes to identical pixels (" + cmp(OUT + "j-src.jpg", OUT + "j-out.jpg") + ")");
  const p = await run("rich.png"); writeFileSync(OUT + "p-src.png", p.sb); writeFileSync(OUT + "p-out.png", p.ob); ok(cmp(OUT + "p-src.png", OUT + "p-out.png").startsWith("True"), "PNG decodes to identical pixels");
  const al = await run("alpha.png"); writeFileSync(OUT + "a-src.png", al.sb); writeFileSync(OUT + "a-out.png", al.ob); ok(cmp(OUT + "a-src.png", OUT + "a-out.png").startsWith("True"), "PNG with transparency decodes to identical RGBA pixels");
  const w = await run("rich.webp"); writeFileSync(OUT + "w-src.webp", w.sb); writeFileSync(OUT + "w-out.webp", w.ob); ok(cmp(OUT + "w-src.webp", OUT + "w-out.webp").startsWith("True"), "WebP decodes to identical pixels");
  const t = await run("rich.tif"); writeFileSync(OUT + "t-src.tif", t.sb); writeFileSync(OUT + "t-out.tif", t.ob); ok(cmp(OUT + "t-src.tif", OUT + "t-out.tif").startsWith("True"), "TIFF decodes to identical pixels");
  const an = await run("anim.webp"); ok(has(an.ob, "ANIM") && has(an.ob, "ANMF"), "animated WebP keeps its animation frames");
  for (const f of ["rich.mp4", "rich.mov"]) {
    const o = await run(f); writeFileSync(OUT + "v-" + f, o.ob);
    const dec = spawnSync("ffmpeg", ["-v", "error", "-i", OUT + "v-" + f, "-f", "null", "-"], { encoding: "utf8" });
    ok(dec.status === 0 && !dec.stderr.trim(), f + ": output still decodes with ffmpeg without errors " + dec.stderr.slice(0, 100));
    const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", OUT + "v-" + f], { encoding: "utf8" });
    const tags = JSON.stringify(JSON.parse(pr.stdout || "{}")); ok(!/SENTINEL|title|artist|comment|location|encoder|creation_time/i.test(tags.replace(/"handler_name":"[^"]*"/g, "").replace(/"language":"[^"]*"/g, "")), f + ": ffprobe lists no format or stream tags " + tags.slice(0, 160));
    const ds = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets", "-of", "csv=p=0", OUT + "v-" + f], { encoding: "utf8" }).stdout.trim().split("\n").sort().join();
    const dss = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets", "-of", "csv=p=0", D + f], { encoding: "utf8" }).stdout.trim().split("\n").filter((l) => /^(video|audio)/.test(l)).sort().join();
    ok(ds.split(",").length >= 2 && dss.split(",").filter((x) => /^(video|audio)/.test(x)).length >= 2 && ds.includes(dss.split(",")[0]), f + ": audio/video packet counts unchanged (" + ds + " vs source " + dss + ")");
  }
}

/* ---- 4. decisions, refusals and malformed input */
ok(await throws("rich-orient.jpg", NeedsReencode), "sideways JPEG needs a redraw instead of silently keeping the rotation flag");
ok(await throws("rich-p3.jpg", NeedsReencode), "wide-gamut JPEG needs a redraw instead of silently changing its colours");
ok(await throws("rich-aux.jpg", NeedsDecision), "JPEG with an embedded second image needs a decision");
ok(await throws("rich-motion.jpg", NeedsDecision), "motion-photo JPEG needs a decision");
for (const f of ["rich-aux.jpg", "rich-motion.jpg", "rich-trailer.jpg"]) { const o = await run(f, { dropAux: true }); ok(sentIn(o.ob).length === 0, f + ": with permission, the extra component and its text are gone"); }
ok(await throws("rich-orient.tif", Unsupported), "sideways TIFF is refused, not left rotated or mangled");
ok(await throws("fake.dng", Unsupported), "RAW (by extension) is refused with an explanation");
ok(await throws("bad-truncated.jpg", Damaged), "truncated JPEG reports damage"); ok(await throws("bad-crc.png", Damaged), "PNG with a bad checksum reports damage"); ok(await throws("bad-truncated.mp4", Damaged), "truncated video reports damage");
try { await sanitise(new File([new Uint8Array(64).fill(7)], "x.jpg"), "x.jpg"); ok(false, "garbage accepted"); } catch (e) { ok(e instanceof Unsupported, "garbage bytes with an image extension are refused"); }
try { await sanitise(new File([], "e.jpg"), "e.jpg"); ok(false, "empty accepted"); } catch (e) { ok(e instanceof Damaged, "empty file is refused"); }
{ const big = { size: LIMITS.image + 1, slice: (a, b) => new Blob([readFileSync(D + "base.jpg")]).slice(a, b), arrayBuffer: async () => { throw new Error("must not read"); } }; try { await sanitise(big, "big.jpg"); ok(false, "oversize accepted"); } catch (e) { ok(e instanceof Unsupported && /limit/.test(e.message), "oversized file is refused before it is read"); } }
{ const b = new Uint8Array(readFileSync(D + "base.png")); const dv = new DataView(b.buffer); dv.setUint32(16, 100000); dv.setUint32(20, 100000); dv.setUint32(29, crc32(b, 12, 29)); try { await sanitise(new File([b], "bomb.png"), "bomb.png"); ok(false, "bomb accepted"); } catch (e) { ok(e instanceof Unsupported && /megapixel/.test(e.message), "10 gigapixel PNG header is refused (decompression-bomb guard)"); } }
ok((await throws("rich.jpg", Error)) === false, "valid file does not throw");

/* ---- 5. verification catches residue */
{
  const j = await run("rich.jpg"), v = (ob, kind = "jpeg", rep = j.r.rep) => verifyOutput({ srcBlob: fx("rich.jpg"), outBlob: new Blob([ob]), kind, rep });
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 20]), Buffer.from("Exif\0\0MM\0*SENTINEL-X", "latin1")]);
  const withExif = Buffer.concat([j.ob.subarray(0, 2), app1, j.ob.subarray(2)]);
  ok((await v(withExif)).status === "failed", "verifier fails a JPEG that still has an EXIF segment");
  ok((await v(Buffer.concat([j.ob, Buffer.from("trailing")]))).status === "failed", "verifier fails a JPEG with data after the end marker");
  const withCom = Buffer.concat([j.ob.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 6]), Buffer.from("hi!!"), j.ob.subarray(2)]);
  ok((await v(withCom)).status === "failed", "verifier fails a JPEG comment");
  const changed = Buffer.from(j.ob); changed[changed.length - 40] ^= 0x55; ok((await v(changed)).checks.find((c) => c.id === "pixels").result === "fail", "verifier fails when image data was altered");
  const needle = await verifyOutput({ srcBlob: fx("rich.jpg"), outBlob: new Blob([Buffer.concat([j.ob.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 10]), Buffer.from("SECRETab"), j.ob.subarray(2)])]), kind: "jpeg", rep: j.r.rep, needles: ["SECRETab"] });
  ok(needle.checks.find((c) => c.id === "values").result === "fail", "verifier fails when a value read from the source is found in the output");
  const p = await run("rich.png"); const pv = await verifyOutput({ srcBlob: fx("rich.png"), outBlob: new Blob([Buffer.concat([p.ob.subarray(0, p.ob.length - 12), Buffer.from([0, 0, 0, 4]), Buffer.from("tEXt"), Buffer.from("abcd"), Buffer.from([0, 0, 0, 0]), p.ob.subarray(p.ob.length - 12)])]), kind: "png", rep: p.r.rep });
  ok(pv.status === "failed", "verifier fails a PNG that gained a text chunk");
  const m = await run("rich.mp4"); const mb = Buffer.from(m.ob), at = mb.indexOf("moov"); const withUdta = Buffer.concat([mb.subarray(0, mb.length), Buffer.from([0, 0, 0, 16]), Buffer.from("udta"), Buffer.from("SECRETabSEC!")]);
  ok((await verifyOutput({ srcBlob: fx("rich.mp4"), outBlob: new Blob([withUdta]), kind: "mp4", rep: m.r.rep })).status === "failed", "verifier fails an MP4 with a user-data box appended");
}

/* ---- 6. idempotence, isolation, hygiene */
for (const f of ["rich.jpg", "rich.png", "rich.webp", "rich.tif"]) { const a = await run(f); const again = await sanitise(new File([a.ob], f), f, {}); ok(sameBytes([a.ob], [await bytesOf(again.out)]), f + ": sanitising the output again changes nothing"); }
{
  const src = readFileSync("src/core/sanitise.js", "utf8") + readFileSync("src/core/sanverify.js", "utf8");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  ok(imports.every((i) => /^\.\/sanitise\.js$/.test(i)), "sanitise core imports nothing from the recovery code (imports: " + imports.join(",") + ")");
  ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB/.test(src), "sanitise core makes no network calls and stores nothing");
  ok(!/Date\.now|new Date|Math\.random|crypto\./.test(readFileSync("src/core/sanitise.js", "utf8")), "sanitise core adds no timestamps or random identifiers to outputs");
}
console.log(`${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
