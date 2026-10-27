// "Start clean": old metadata is removed before the new values are written; orientation survives.
import assert from "assert/strict";
import { readFileSync } from "fs";
import { runBatch } from "../src/vendor/exiftool.js";
let pass = 0; const t = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
const wasm = readFileSync("w/zeroperl.wasm"), wf = () => Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
const run = async (data, lines, outs) => runBatch([{ path: "/i.jpg", data: new File([data], "i") }, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], wf, outs);
const read = async (data) => JSON.parse((await runBatch([{ path: "/o.jpg", data: new File([data], "o") }], ["-json", "-n", "-G1", "-a", "/o.jpg"], wf)).out)[0];
const CLEAN = ["-EXIF:all=", "-GPS:all=", "-IPTC:all=", "-XMP:all=", "-MakerNotes:all=", "-Photoshop:all=", "-Comment=", "-tagsfromfile", "@", "-IFD0:Orientation"];
const stale = async (extra) => (await run(readFileSync("tests/fixtures/plain.jpg"), ["-m", "-IFD0:Make=OldCam", "-IFD0:Orientation#=6", "-EXIF:DateTimeOriginal=2001:01:01 01:01:01", "-GPS:GPSLatitude=10", "-GPS:GPSLatitudeRef=N", "-XMP-dc:Description=old note", "-IPTC:Keywords=old", ...extra, "-o", "/o.jpg", "/i.jpg", "-execute"], ["/o.jpg"])).outs["/o.jpg"];
await t("old data removed, new data written, orientation kept", async () => {
  const src = await stale([]);
  const w = await run(src, ["-m", ...CLEAN, "-EXIF:DateTimeOriginal=2023:07:04 14:30:00", "-o", "/o.jpg", "/i.jpg", "-execute"], ["/o.jpg"]);
  const r = await read(w.outs["/o.jpg"]);
  assert.equal(r["IFD0:Make"], undefined); assert.equal(r["GPS:GPSLatitude"], undefined); assert.equal(r["XMP-dc:Description"], undefined); assert.equal(r["IPTC:Keywords"], undefined);
  assert.equal(r["ExifIFD:DateTimeOriginal"], "2023:07:04 14:30:00"); assert.equal(r["IFD0:Orientation"], 6);
});
await t("without clean the old data is still there", async () => { const r = await read(await stale([])); assert.equal(r["IFD0:Make"], "OldCam"); });
console.log(`clean: ${pass} checks passed`); process.exit(process.exitCode || 0);
