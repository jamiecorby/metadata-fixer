// Regression tests for the model: zones applied after the fact must not shift absolute times.
import assert from "assert/strict";
import { S, newItem, autopick, plan, applyAiTop, rezone } from "../src/app/model.js";
import { interpretExisting } from "../src/core/existing.js";
import { human } from "../src/core/time.js";
let pass = 0; const t = (n, f) => { try { f(); pass++; } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
S.settings = { zone: "America/Denver", policy: "fill", dev: "none", full: true, label: true };
const mk = (name, kind = "photo") => { const it = newItem({ name, size: 1, lastModified: Date.UTC(2026, 0, 1), webkitRelativePath: "" }); it.kind = kind; it.exState = "done"; it.ex = { date: null, gps: null, device: null }; S.items.push(it); return it; };
t("epoch name + AI Tokyo keeps the instant", () => {
  const it = mk("FB_IMG_1562250600000.jpg"); autopick(it);
  it.ai = { dates: [], locations: [{ name: "Tokyo", lat: 35.68, lon: 139.69, radius_km: 20, timezone: "Asia/Tokyo", confidence: 0.9, basis: "x" }] };
  applyAiTop(it); const p = plan(it);
  assert.equal(human(p.t), "2019-07-04 23:30:00"); assert.equal(p.off, 540); assert.equal(human(it.date.t), "2019-07-04 23:30:00");
});
t("video UTC + location picked later", () => {
  const it = mk("clip.mov", "video"); it.ex = interpretExisting({ "QuickTime:CreateDate": "2019:07:04 13:30:00" }, "video"); autopick(it);
  it.loc = { la: 38.72, lo: -9.14, src: "map", conf: 1, manual: true }; rezone(it); const p = plan(it);
  assert.equal(human(p.t), "2019-07-04 14:30:00"); assert.equal(p.off, 60);
});
t("manual zone override on epoch name", () => {
  const it = mk("FB_IMG_1562250600000.jpg"); autopick(it); it.zone = "Europe/London"; rezone(it);
  assert.equal(human(plan(it).t), "2019-07-04 15:30:00"); assert.equal(plan(it).off, 60);
});
t("filename local time is NOT shifted by a later zone", () => {
  const it = mk("IMG_20190704_143000.jpg"); autopick(it); it.loc = { la: 35.68, lo: 139.69, src: "map", conf: 1, manual: true }; rezone(it);
  assert.equal(human(plan(it).t), "2019-07-04 14:30:00"); assert.equal(plan(it).off, 540);
});
t("IPTC date+time and XMP-only GPS count as existing", () => {
  const ex = interpretExisting({ "Composite:DateTimeCreated": "2019:07:04 14:30:00+01:00", "XMP-exif:GPSLatitude": 38.7, "XMP-exif:GPSLongitude": -9.1 }, "photo");
  assert.equal(human(ex.date.t), "2019-07-04 14:30:00"); assert.equal(ex.date.off, 60); assert.equal(ex.gps.lo, -9.1);
  const it = mk("IMG_20200101_120000.jpg"); it.ex = ex; autopick(it); const p = plan(it);
  assert.equal(p.write.date, false); assert.equal(p.write.gps, false);
});
t("date-only existing kept in fill mode", () => {
  const ex = interpretExisting({ "XMP-photoshop:DateCreated": "2019:07:04" }, "photo");
  assert.equal(ex.date.dateOnly, true);
  const it = mk("IMG_20200101_120000.jpg"); it.ex = ex; autopick(it);
  assert.equal(it.date.src, "existing"); assert.equal(plan(it).write.date, false);
});
console.log(`model tests: ${pass} passed${process.exitCode ? ", some FAILED" : ""}`);
t("same-day file name adds the time to a date-only value", () => {
  const it = mk("IMG_20190704_143000.jpg"); it.ex = interpretExisting({ "XMP-photoshop:DateCreated": "2019:07:04" }, "photo"); autopick(it);
  assert.equal(it.date.src, "filename"); assert.equal(plan(it).write.date, true);
});
console.log(`model tests (2): ${pass} passed${process.exitCode ? ", some FAILED" : ""}`);
