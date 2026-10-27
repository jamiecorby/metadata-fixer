// Batch orchestration: names, collisions, partial failure, retry, ZIP and audit contents. Reads the actual ZIP bytes.
import { readFileSync } from "fs";
import { unzipSync } from "fflate";
import { runBatch, newEntry, buildZip, auditCsv, auditJson, outName, summary, processOne } from "../src/app/sanrun.js";
import { readTags } from "./san-readtags.mjs";
const D = "tests/fixtures/san/"; let bad = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL", m); } };
const f = (name, as) => { const file = new File([readFileSync(D + name)], as || name); if (as && as.includes("/")) Object.defineProperty(file, "webkitRelativePath", { value: as }); return file; };
const io = { readTags, redraw: null };
// same name in two folders, same name twice in one folder, unusual characters, one broken, one unsupported, one RAW
const files = [f("rich.jpg", "a/IMG 1.jpg"), f("rich.jpg", "b/IMG 1.jpg"), f("rich-trailer.jpg", "IMG 1.jpg"), f("rich.png", "x:y*z?.png"), f("rich.webp", "../../evil.webp"), f("bad-truncated.jpg"), f("fake.dng"), f("rich-orient.jpg")];
const E = files.map((x, i) => newEntry(x, i + 1));
const o = { redraw: false, dropAux: false };
const s = await runBatch(E, o, io);
const st = Object.fromEntries(E.map((e) => [e.path, e.state]));
ok(st["a/IMG 1.jpg"] === "limited" || st["a/IMG 1.jpg"] === "verified", "good file succeeds: " + st["a/IMG 1.jpg"]);
ok(E[5].state === "failed" && E[6].state === "unsupported", "broken and RAW files fail alone");
ok(E[7].state === "decision" && E[7].key === "redraw", "sideways JPEG waits for permission to redraw when redraw is off");
ok(s.ok >= 5 && s.failed === 1 && s.unsupported === 1 && s.decision === 1, "summary counts " + JSON.stringify(s));
const names = E.filter((e) => e.out).map((e) => e.out.name);
ok(new Set(names.map((x) => x.toLowerCase())).size === names.length, "output names are unique: " + names.join(", "));
ok(names.every((x) => /^[\w.\- ()]+$/.test(x) && !x.includes("..") && !x.startsWith(".")), "output names are safe: " + names.join(", "));
ok(outName("IMG.JPG", "jpeg", new Set(["img_sanitised.jpg"])) === "IMG_sanitised-2.jpg", "collision gets a numeric suffix");
// retry: the decision becomes a success once allowed
E[7].allowRedraw = true; E[7].state = "queued";
const redrawIo = { ...io, redraw: async (file) => new Blob([readFileSync(D + "base.jpg")]) };
await processOne(E[7], { ...o, used: new Set(names.map((x) => x.toLowerCase())) }, redrawIo);
ok(E[7].out && /^(verified|limited)$/.test(E[7].state) && E[7].rep.notes.some((x) => /rotation was applied/.test(x)), "after permission the sideways file is redrawn and noted: " + E[7].state + " " + E[7].msg);
ok(E[7].rep.method.startsWith("Pixels redrawn"), "report says the pixels were redrawn");
// failed file stays failed on retry, nothing else is touched
const before = E[0].out;
await runBatch(E, o, io); ok(E[0].out === before && E[5].state === "failed", "retrying leaves finished files alone and keeps the broken one failed");
// ZIP
const zip = unzipSync(new Uint8Array(await (await buildZip(E)).arrayBuffer())), zn = Object.keys(zip);
ok(zn.includes("a/IMG 1_sanitised.jpg") && zn.some((x) => /^b\/IMG 1_sanitised(-\d+)?\.jpg$/.test(x)), "folders are kept and same names in different folders do not clash: " + zn.join(", "));
ok(zn.filter((x) => x.includes("IMG 1_sanitised")).length === 3, "three IMG 1 files all present");
ok(zn.every((x) => !x.startsWith("/") && !x.split("/").includes("..")) && zn.includes("evil_sanitised.webp"), "no path escapes from the ZIP: " + zn.join(", "));
ok(!zn.some((x) => /truncated|fake/.test(x)), "failed and unsupported files are not in the ZIP");
ok(Object.values(zip).every((b, i) => !Buffer.from(b).includes("SENTINEL") || zn[i].startsWith("sanitisation-audit")), "no sentinel text in any sanitised file in the ZIP");
// audit
const csv = auditCsv(E), js = JSON.parse(auditJson(E));
ok(js.files.length === E.length && js.files.every((r) => r.file && r.result), "audit JSON has an entry for every file");
ok(csv.split("\r\n").filter(Boolean).length === E.length + 1, "audit CSV has a header and a row per file");
ok(/Verified/.test(csv) && /Failed/.test(csv) && /Not supported/.test(csv), "audit CSV carries each result");
ok(js.files.find((r) => r.file === "a/IMG 1.jpg").checks.length >= 5 && js.files.find((r) => r.file === "a/IMG 1.jpg").removed.length >= 5, "audit lists checks and removed items for a processed file");
const evil = newEntry(new File([readFileSync(D + "rich.jpg")], "=HYPERLINK(\"x\").jpg"), 99); await processOne(evil, { used: new Set() }, io);
ok(!/(^|,)=HYPER/.test(auditCsv([evil])), "audit CSV neutralises spreadsheet formulas in file names");
// failed verification is not offered
const tampered = newEntry(f("rich.jpg"), 100);
await processOne(tampered, { used: new Set() }, { readTags: async (blob, name) => (blob.size > 0 && name.endsWith("_sanitised.jpg") ? { "IFD0:Make": "Leaked" } : readTags(blob, name)) });
ok(tampered.state === "failed" && !tampered.out, "a file whose output fails the second-reader check is failed and not offered: " + tampered.state);
console.log(`${n - bad}/${n} checks passed`); process.exit(bad ? 1 : 0);
