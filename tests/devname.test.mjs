// "Device name" (e.g. George's iPhone) is written as the iPhone's own name and verified on read-back.
import assert from "assert/strict";
import { readFileSync } from "fs";
import { buildTags, verify } from "../src/core/tags.js";
import { runBatch } from "../src/vendor/exiftool.js";
let pass = 0; const t = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
const base = { kind: "photo", t: Date.UTC(2023, 6, 4, 14, 30), off: -420, la: 39.74, lo: -104.99, alt: null, dev: "iPhone 14 Pro", full: false, label: true, write: { date: true, gps: true, device: true } };
await t("name becomes HostComputer even without the full tag set", () => { const b = buildTags({ ...base, name: "George's iPhone" }); assert.equal(b.tags["IFD0:HostComputer"], "George's iPhone"); assert.equal(b.expect["IFD0:HostComputer"], "George's iPhone"); assert.equal(b.tags["IFD0:Model"], "iPhone 14 Pro"); assert.match(b.summary.join(" "), /George's iPhone/); });
await t("with the full tag set the name still wins over the model", () => assert.equal(buildTags({ ...base, full: true, name: "George's iPhone" }).tags["IFD0:HostComputer"], "George's iPhone"));
await t("no name: behaviour unchanged", () => { const b = buildTags({ ...base, full: true }); assert.equal(b.tags["IFD0:HostComputer"], "iPhone 14 Pro"); assert.equal(buildTags({ ...base }).tags["IFD0:HostComputer"], undefined); });
await t("no device written: no name written either", () => assert.equal(buildTags({ ...base, name: "George's iPhone", write: { date: true, gps: true, device: false } }).tags["IFD0:HostComputer"], undefined));
await t("round trip through the engine, apostrophe intact", async () => {
  const wasm = readFileSync("w/zeroperl.wasm"), wf = () => Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
  const b = buildTags({ ...base, name: "George's iPhone" });
  const lines = ["-m", ...Object.entries(b.tags).map(([k, v]) => `-${k}=${v}`), "-o", "/o.jpg", "/i.jpg", "-execute"];
  const w = await runBatch([{ path: "/i.jpg", data: new File([readFileSync("tests/fixtures/plain.jpg")], "i") }, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], wf, ["/o.jpg"]);
  const r = await runBatch([{ path: "/o.jpg", data: new File([w.outs["/o.jpg"]], "o") }], ["-json", "-n", "-G1", "-IFD0:all", "-ExifIFD:all", "-GPS:all", "/o.jpg"], wf);
  const exp = Object.fromEntries(Object.entries(b.expect).filter(([k]) => !k.startsWith("Composite"))); const v = verify(JSON.parse(r.out)[0], exp); assert.ok(v.ok, v.diffs.join("; ")); assert.equal(JSON.parse(r.out)[0]["IFD0:HostComputer"], "George's iPhone");
});
for (const [file, ext] of [["tests/fixtures/plain.jpg", "jpg"], ["tests/fixtures/san/base.png", "png"], ["tests/fixtures/san/base.webp", "webp"], ["tests/fixtures/san/base.tif", "tif"]]) await t("the app's own read-back (READ_ARGS) sees the device name on ." + ext, async () => {
  const wasm = readFileSync("w/zeroperl.wasm"), wf = () => Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
  const { READ_ARGS } = await import("../src/core/existing.js");
  const b = buildTags({ ...base, name: "George's iPhone", full: true });
  const lines = ["-m", ...Object.entries(b.tags).map(([k, v]) => `-${k}=${v}`), "-o", "/o." + ext, "/i." + ext, "-execute"];
  const w = await runBatch([{ path: "/i." + ext, data: new File([readFileSync(file)], "i") }, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], wf, ["/o." + ext]);
  const r = await runBatch([{ path: "/o." + ext, data: new File([w.outs["/o." + ext]], "o") }], [...READ_ARGS, "/o." + ext], wf);
  const v = verify(JSON.parse(r.out)[0], b.expect); assert.ok(v.ok, v.diffs.join("; "));
});
console.log(`devname: ${pass} checks passed`); process.exit(process.exitCode || 0);
