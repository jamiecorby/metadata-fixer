// Damaged and mislabelled files: the engine must flag them clearly and never report a partial write as success.
import { readFileSync } from "fs";
import assert from "assert/strict";
import crypto from "crypto";
import { runBatch } from "../src/vendor/exiftool.js";
import { READ_ARGS, interpretExisting, realExt } from "../src/core/existing.js";
import { hardErr } from "../src/app/engine.js";
const fx = (n) => readFileSync("tests/fixtures/" + n);
const wasm = readFileSync("w/zeroperl.wasm");
const wfetch = () => Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
let pass = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.log("FAIL", name, e.message); process.exitCode = 1; } };

const plain = fx("plain.jpg"), mp4 = fx("plain.mp4");
const cases = [
  ["good.jpg", plain], ["garbage.jpg", crypto.randomBytes(5000)], ["really_png.jpg", fx("plain.png")], ["trunc.mp4", mp4.subarray(0, 900)],
  ["text.jpg", Buffer.from("hello world, not an image")], ["trunc.jpg", plain.subarray(0, 1500)], ["good2.jpg", fx("complete.jpg")],
];
const files = cases.map(([n, b], i) => ({ path: `/r${i}.${n.split(".").pop()}`, data: new File([b], "f") }));
const rd = await runBatch(files, [...READ_ARGS, ...files.map((f) => f.path)], wfetch);
const by = new Map(JSON.parse(rd.out).map((o) => [o.SourceFile, o]));
const ex = (i) => interpretExisting(by.get(files[i].path), cases[i][0].endsWith("mp4") ? "video" : "photo");

t("good file has no issue", () => assert.equal(ex(0).issue, null));
t("garbage is reported", () => assert.match(ex(1).issue, /could not read/i));
t("png named jpg: detected", () => assert.equal(realExt(ex(2).fileExt, "really_png.jpg"), "png"));
t("png named jpg: no false damage", () => assert.equal(ex(2).issue, null));
t("truncated video is reported", () => assert.match(ex(3).issue, /damaged/i));
t("text file is not a photo", () => assert.match(ex(4).issue, /isn't a photo/));
t("matching extension is not flagged", () => { assert.equal(realExt("jpg", "a.JPEG"), null); assert.equal(realExt("mp4", "a.mov"), null); assert.equal(realExt("tif", "a.tiff"), null); });
t("unknown types are left alone", () => assert.equal(realExt("txt", "a.jpg"), null));

// writes: hard errors win over partial output; good files in the same run still succeed
const lines = [], outs = [];
cases.forEach(([n], i) => { const out = `/o${i}.${n.split(".").pop()}`; outs.push(out); lines.push("-m", "-EXIF:DateTimeOriginal=2020:01:02 03:04:05", "-o", out, files[i].path, "-execute"); });
const wr = await runBatch([...files, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], wfetch, outs);
const failed = cases.map((c, i) => hardErr(wr.err, files[i].path));
t("good files write", () => { assert.equal(failed[0], false); assert.equal(failed[6], false); assert.ok(wr.outs[outs[0]].length > 677); });
t("garbage, wrong type, text fail", () => { assert.equal(failed[1], true); assert.equal(failed[2], true); assert.equal(failed[4], true); });
t("truncated video fails even though partial bytes exist", () => { assert.equal(failed[3], true); assert.ok(wr.outs[outs[3]].length > 0); });
t("truncated jpeg still writes", () => assert.equal(failed[5], false));
console.log("damaged tests passed:", pass);
process.exit(process.exitCode || 0);
