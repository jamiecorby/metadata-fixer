// Runs every suite in order and fails if any does. `npm test` runs this; BASE=<url> points the browser tests at a live site.
import { spawnSync } from "child_process";
const suites = [
  ["unit: core", "node", ["tests/core.test.mjs"]],
  ["unit: model", "node", ["tests/model.test.mjs"]],
  ["engine: batch", "node", ["tests/batch.test.mjs"]],
  ["engine: damaged files", "node", ["tests/damaged.test.mjs"]],
  ["unit: AI provider layer", "node", ["tests/gemini.test.mjs"]],
  ["engine: authenticity", "node", ["tests/authenticity.test.mjs"]],
  ["browser: end to end", "python3", ["-W", "ignore", "tests/e2e.py"]],
  ["browser: damaged files", "python3", ["-W", "ignore", "tests/damaged.py"]],
  ["browser: map", "python3", ["-W", "ignore", "tests/map.py"]],
  ["browser: authenticity check", "python3", ["-W", "ignore", "tests/auth.py"]],
  ["browser: content security policy", "python3", ["-W", "ignore", "tests/csp.py"]],
];
if (process.env.PERF) suites.push(["browser: 200-file performance", "python3", ["-W", "ignore", "tests/perf.py"]]);
let bad = 0;
for (const [name, cmd, args] of suites) {
  const t = Date.now(), r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  const out = (r.stdout || "") + (r.stderr || "");
  const failed = r.status !== 0 || /^FAIL/m.test(out);
  console.log(`${failed ? "FAIL" : "ok  "} ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (failed) { bad++; console.log(out.split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 15).join("\n")); }
}
process.exit(bad ? 1 : 0);
