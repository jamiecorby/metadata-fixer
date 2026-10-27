import { runBatch } from "../src/vendor/exiftool.js";
export async function readTags(blob, name) { const ext = name.split(".").pop(), p = "/x." + ext; const r = await runBatch([{ path: p, data: blob instanceof File ? blob : new File([blob], "x") }], ["-json", "-G1", "-a", "-u", "-s", p]); try { return JSON.parse(r.out || "[{}]")[0] || {}; } catch (e) { return {}; } }
