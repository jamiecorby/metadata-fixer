// Patches @6over3/zeroperl-ts's in-memory file system so writing a file is linear, not quadratic.
// Upstream fd_write reallocates the WHOLE file on every append (exact-size growth): writing a 150 MB video in
// 64 KB pieces copied c. 170 GB and left thousands of dead 100 MB+ buffers behind, which is what killed the
// tab on iPhone. Here the file content stays an exact-length view, over a buffer that grows by 1.5x (1.25x past 32 MB, to keep the slack small on phones).
// Idempotent; run by build.mjs (via vendor.mjs) and by the test runner.
import { readFileSync, writeFileSync } from "fs";
const files = ["node_modules/@6over3/zeroperl-ts/dist/esm/index.js", "node_modules/@6over3/zeroperl-ts/dist/cjs/index.cjs"];
const OLD = "if(F>k(u.node))h=new Uint8Array(F),h.set(u.node.content,0);else h=u.node.content;";
const NEW = "if(F>k(u.node)){let o=u.node.content;if(o.byteOffset+F<=o.buffer.byteLength)h=new Uint8Array(o.buffer,o.byteOffset,F);else{let c=new Uint8Array(Math.max(65536,Math.ceil(F*(F>33554432?1.25:1.5))));c.set(o,0);h=c.subarray(0,F)}}else h=u.node.content;/*mf-linear-write*/";
for (const f of files) {
  let s; try { s = readFileSync(f, "utf8"); } catch (e) { continue; }
  if (s.includes("/*mf-linear-write*/")) continue;
  if (!s.includes(OLD)) throw new Error("zeroperl fd_write layout changed; update scripts/patch-zeroperl.mjs (" + f + ")");
  writeFileSync(f, s.replace(OLD, NEW));
  console.log("patched", f);
}
