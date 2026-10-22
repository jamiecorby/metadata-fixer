// Authenticity check: scoring over synthetic fixtures (tests/mkauth.mjs), the Fix plan, and write -> read-back round trips.
import { readFileSync, readdirSync } from "fs";
import assert from "assert/strict";
import { runBatch } from "../src/vendor/exiftool.js";
import { READ_ARGS } from "../src/core/existing.js";
import { scanContainer, readClaims } from "../src/core/c2pa.js";
import { assess, planFix, provenanceSnapshot, provenanceLost, DST } from "../src/core/authenticity.js";
import { verify } from "../src/core/tags.js";
const D = "tests/fixtures/auth/", names = readdirSync(D).filter((n) => /\.(jpg|png)$/.test(n));
const wasm = readFileSync("w/zeroperl.wasm"), wf = () => Promise.resolve(new Response(wasm, { headers: { "Content-Type": "application/wasm" } }));
let pass = 0; const t = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
const ext = (n) => n.split(".").pop();
const rd = async (list) => { const fs = list.map(([n, b], i) => ({ path: `/r${i}.${ext(n)}`, data: new File([b], n) })); const r = await runBatch(fs, [...READ_ARGS, ...fs.map((f) => f.path)], wf); const by = new Map(JSON.parse(r.out).map((o) => [o.SourceFile, o])); return fs.map((f) => by.get(f.path)); };
const bufs = names.map((n) => [n, readFileSync(D + n)]);
const raws = await rd(bufs);
const A = {}, C = {};
for (const [i, n] of names.entries()) { C[n] = readClaims(await scanContainer(new Blob([bufs[i][1]]))); A[n] = assess({ raw: raws[i], kind: "photo", c2pa: C[n], now: Date.parse("2026-10-22") }); }

await t("genuine photo scores low", () => { assert.ok(A["genuine_iphone.jpg"].score < 15); assert.equal(A["genuine_iphone.jpg"].flagged, false); });
await t("capture credentials score low and are read", () => { assert.ok(C["c2pa_capture.jpg"].capture); assert.ok(A["c2pa_capture.jpg"].score < 15); });
for (const n of ["ai_firefly.jpg", "ai_sd.png", "ai_midjourney.png", "ai_c2pa_openai.jpg"]) await t(n + " scores high", () => { assert.ok(A[n].score >= 85, n + " " + A[n].score); assert.equal(A[n].flagged, true); });
await t("C2PA AI manifest detected, signatures not validated", () => { assert.ok(C["ai_c2pa_openai.jpg"].aiGenerated); assert.equal(C["ai_c2pa_openai.jpg"].validated, false); assert.equal(C["ai_c2pa_openai.jpg"].generator, "OpenAI DALL-E 3"); });
await t("generative fill reads as likely AI-edited, not fully generated", () => { const a = A["edited_generative_fill.jpg"]; assert.ok(a.score >= 60 && a.score < 85, "" + a.score); assert.ok(a.flags.composite && !a.flags.fullyGenerated); });
await t("tampered device/date is flagged as inconsistent, not AI", () => { const a = A["tampered_device_date.jpg"]; assert.equal(a.flagged, true); assert.equal(a.level, "Metadata looks inconsistent"); assert.ok(a.score < 60); });
await t("tampered make/model is flagged", () => assert.equal(A["tampered_make_model.jpg"].level, "Metadata looks inconsistent"));
await t("camera fields on an AI file are contradictory", () => { assert.ok(A["tampered_fake_camera_on_ai.jpg"].flags.contradictoryCamera); assert.ok(A["tampered_fake_camera_on_ai.jpg"].score >= 85); });
await t("size alone is never enough", () => assert.ok(A["stripped_1024.png"].score < 60));
await t("vision is capped and cannot be definitive", () => { const a = assess({ raw: raws[names.indexOf("stripped_1024.png")], kind: "photo", c2pa: C["stripped_1024.png"], vision: { score: 100, confidence: 0.9, cues: [{ cue: "x" }] }, now: Date.parse("2026-10-22") }); assert.ok(a.score < 85); assert.ok(a.confidence !== "high"); });

await t("edge function prompt is identical to the browser prompt", () => assert.equal(readFileSync("supabase/functions/authenticity/prompt.js", "utf8"), readFileSync("src/core/authprompt.js", "utf8")));
await t("vision answers are bounded", async () => { const { cleanVision } = await import("../src/core/authprompt.js"); const v = cleanVision('x {"score":140,"confidence":0.99,"cues":[{"cue":"a","detail":"b"}]} y'); assert.equal(v.score, 100); assert.equal(v.confidence, 0.7); assert.throws(() => cleanVision("no json")); });

// Fix plans
await t("genuine file: nothing to fix", () => assert.deepEqual(Object.keys(planFix(A["genuine_iphone.jpg"], raws[names.indexOf("genuine_iphone.jpg")]).tags), []));
await t("fix never writes a label from vision-only evidence", () => { const n = "stripped_1024.png", a = assess({ raw: raws[names.indexOf(n)], kind: "photo", c2pa: C[n], vision: { score: 95, confidence: 0.9, cues: [{ cue: "x" }] }, now: 0 }); assert.equal(Object.keys(planFix(a, raws[names.indexOf(n)]).tags).length, 0); });
await t("fix on a user-chosen disclosure writes the label", () => { const n = "stripped_1024.png", p = planFix(A[n], raws[names.indexOf(n)], { disclosure: "ai" }); assert.equal(p.tags["XMP-iptcExt:DigitalSourceType"], DST.trained); });

// Round trips: apply every fix, write, read back, check expectations, provenance and the manifest
const plans = names.map((n, i) => planFix(A[n], raws[i]));
const fs = names.map((n, i) => ({ path: `/w${i}.${ext(n)}`, data: new File([bufs[i][1]], n) })), lines = [], outs = [];
names.forEach((n, i) => { const o = `/o${i}.${ext(n)}`; outs.push(o); lines.push("-m"); for (const [k, v] of Object.entries(plans[i].tags)) lines.push(`-${k}=${v}`); lines.push("-o", o, fs[i].path, "-execute"); });
const wr = await runBatch([...fs, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], wf, outs);
const outBufs = names.map((n, i) => [n, Buffer.from(wr.outs[outs[i]])]);
const back = await rd(outBufs);
for (const [i, n] of names.entries()) {
  await t(n + ": write succeeded", () => assert.ok(outBufs[i][1].length > 500));
  await t(n + ": fix expectations verified", () => { const v = verify(back[i], plans[i].expect); assert.ok(v.ok, v.diffs.join("; ")); });
  await t(n + ": removed fields are gone", () => { for (const k of plans[i].absent) assert.ok(back[i][k] == null || back[i][k] === "", k); });
  await t(n + ": no AI provenance lost", () => assert.deepEqual(provenanceLost(raws[i], back[i]), []));
  await t(n + ": C2PA manifest kept", async () => assert.equal((await scanContainer(new Blob([outBufs[i][1]]))).present, C[n].present));
}
await t("Stable Diffusion file now carries an AI label and keeps its parameters", () => { const i = names.indexOf("ai_sd.png"); assert.match(String(back[i]["XMP-iptcExt:DigitalSourceType"] || ""), /trainedAlgorithmicMedia/); assert.ok(Object.keys(provenanceSnapshot(back[i])).length >= 1); });
await t("camera fields on the AI-marked file are removed", () => { const i = names.indexOf("tampered_fake_camera_on_ai.jpg"); assert.equal(back[i]["IFD0:Make"] ?? null, null); assert.match(String(back[i]["XMP-iptcExt:DigitalSourceType"]), /trainedAlgorithmicMedia/); });
console.log(`authenticity: ${pass} checks passed`);
process.exit(process.exitCode || 0);
