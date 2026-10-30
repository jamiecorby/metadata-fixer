// Large files: writing a video's metadata must be linear in its size (it used to re-copy the whole file on every
// 64 KB write, which froze and then crashed phones), and ZIPs must be built without holding everything at once.
import { runBatch } from "../src/vendor/exiftool.js";
import { zipBlobs } from "../src/app/zipstream.js";
import { unzipSync } from "fflate";
import { execFileSync } from "child_process";
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
let fails = 0; const check = (n, ok, info = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : "  " + info)); if (!ok) fails++; };
const dir = mkdtempSync(tmpdir() + "/mfbig-"), vid = dir + "/big.mp4";
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=1280x720:d=1.6,geq=random(1)*255:128:128", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", vid]);
const buf = readFileSync(vid); console.log(`   test video ${(buf.length / 1048576).toFixed(0)} MB`);
check("test video is large enough to show the problem", buf.length > 40e6, buf.length);
const lines = ["-m", "-QuickTime:CreateDate=2023:05:18 13:00:00", "-o", "/o.mp4", "/i.mp4", "-execute"];
const t0 = Date.now();
const r = await runBatch([{ path: "/i.mp4", data: new File([buf], "i") }, { path: "/args.txt", data: new File([lines.join("\n") + "\n"], "a") }], ["-@", "/args.txt"], undefined, ["/o.mp4"], true);
const secs = (Date.now() - t0) / 1000, out = r.outs["/o.mp4"];
check(`video metadata written in linear time (${secs.toFixed(1)} s)`, secs < 30, secs);
check("output comes back as a Blob, not page memory", out instanceof Blob);
check("output is the full video", out && Math.abs(out.size - buf.length) < 1e6, out && out.size);
const back = await runBatch([{ path: "/b.mp4", data: out }], ["-json", "-QuickTime:CreateDate", "/b.mp4"]);
check("the written date reads back", JSON.parse(back.out)[0].CreateDate === "2023:05:18 13:00:00", back.out);
const raw = new Uint8Array(await out.arrayBuffer()), src = new Uint8Array(buf);
const mdat = (a) => { for (let i = 0; i + 8 < a.length; ) { const sz = (a[i] << 24 >>> 0) + (a[i + 1] << 16) + (a[i + 2] << 8) + a[i + 3], t = String.fromCharCode(a[i + 4], a[i + 5], a[i + 6], a[i + 7]); if (t === "mdat") return a.subarray(i + 8, i + sz); i += sz || a.length; } return null; };
const m1 = mdat(src), m2 = mdat(raw);
check("picture and sound data copied byte for byte", m1 && m2 && m1.length === m2.length && Buffer.compare(Buffer.from(m1), Buffer.from(m2)) === 0);
// streamed ZIP
const big = new Blob([buf]), t1 = Date.now();
const z = await zipBlobs([{ name: "a/big.mp4", blob: big, mt: Date.UTC(2023, 4, 18) }, { name: "audit.csv", text: "a,b\n1,2\n", level: 6, date: new Date("1980-01-01T00:00:00") }, { name: "empty.txt", blob: new Blob([]) }]);
const u = unzipSync(new Uint8Array(await z.arrayBuffer()));
check(`streamed ZIP builds (${((Date.now() - t1) / 1000).toFixed(1)} s)`, !!u);
check("ZIP keeps folders and every file", Object.keys(u).sort().join(",") === "a/big.mp4,audit.csv,empty.txt", Object.keys(u));
check("ZIP contents identical", Buffer.compare(Buffer.from(u["a/big.mp4"]), buf) === 0 && new TextDecoder().decode(u["audit.csv"]) === "a,b\n1,2\n" && u["empty.txt"].length === 0);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
