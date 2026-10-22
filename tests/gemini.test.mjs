// The server-side provider layer (supabase/functions/*/llm.ts), run under Node with Deno and fetch mocked.
import assert from "assert/strict";
import { readFileSync } from "fs";
let pass = 0; const t = async (n, fn) => { try { await fn(); pass++; } catch (e) { console.log("FAIL", n, e.message); process.exitCode = 1; } };
const env = {}; globalThis.Deno = { env: { get: (k) => env[k] } };
const m = await import("../supabase/functions/suggest/llm.ts");
await t("both function folders share one llm.ts", () => assert.equal(readFileSync("supabase/functions/suggest/llm.ts", "utf8"), readFileSync("supabase/functions/authenticity/llm.ts", "utf8")));
await t("provider defaults to anthropic and ignores junk", () => { assert.equal(m.pickProvider(undefined), "anthropic"); assert.equal(m.pickProvider("openai"), "anthropic"); assert.equal(m.pickProvider("gemini"), "gemini"); });
await t("models and keys follow the provider", () => { env.GEMINI_API_KEY = "g"; env.ANTHROPIC_API_KEY = "a"; assert.equal(m.keyFor("gemini"), "g"); assert.equal(m.keyFor("anthropic"), "a"); assert.equal(m.modelFor("gemini"), "gemini-3.8-flash"); env.GEMINI_MODEL = "gemini-x"; assert.equal(m.modelFor("gemini"), "gemini-x"); assert.equal(m.modelFor("anthropic", "claude-y"), "claude-y"); });
let seen; const mock = (status, body) => { globalThis.fetch = async (url, init) => { seen = { url: String(url), init, body: JSON.parse(init.body) }; return new Response(JSON.stringify(body), { status }); }; };
const O = { key: "AIzaSECRET", model: "gemini-3.8-flash", image: "QUJD", prompt: "P", maxTokens: 500 };
await t("gemini request: key in header only, image inline, JSON mode, thinking headroom", async () => {
  mock(200, { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 40 } });
  const r = await m.callVision("gemini", O);
  assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.ok(!seen.url.includes("AIza")); assert.equal(seen.init.headers["x-goog-api-key"], "AIzaSECRET");
  const parts = seen.body.contents[0].parts; assert.equal(parts[0].text, "P"); assert.equal(parts[1].inline_data.data, "QUJD"); assert.equal(parts[1].inline_data.mime_type, "image/jpeg");
  assert.equal(seen.body.generationConfig.responseMimeType, "application/json"); assert.ok(seen.body.generationConfig.maxOutputTokens >= 2000);
  assert.deepEqual([r.ok, r.text, r.inTok, r.outTok], [true, '{"a":1}', 700, 40]);
});
await t("gemini: safety block or empty answer is a failure (so the credit is refunded)", async () => {
  mock(200, { promptFeedback: { blockReason: "SAFETY" } }); let r = await m.callVision("gemini", O); assert.equal(r.ok, false); assert.equal(r.status, 502);
  mock(200, { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }); r = await m.callVision("gemini", O); assert.equal(r.ok, false);
});
await t("gemini: HTTP errors carry status and message", async () => { mock(429, { error: { message: "quota" } }); const r = await m.callVision("gemini", O); assert.deepEqual([r.ok, r.status, r.err], [false, 429, "quota"]); });
await t("anthropic request and answer shape unchanged", async () => {
  mock(200, { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 2 } });
  const r = await m.callVision("anthropic", { ...O, key: "sk-x", model: "claude-sonnet-5-5" });
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages"); assert.equal(seen.init.headers["x-api-key"], "sk-x"); assert.equal(seen.body.messages[0].content[0].source.data, "QUJD");
  assert.deepEqual([r.ok, r.text, r.inTok, r.outTok], [true, "hi", 5, 2]);
});
// answers the app parses: Gemini JSON output must clean through the same functions
const { cleanVision } = await import("../src/core/authprompt.js");
await t("a Gemini JSON answer cleans like a Claude one", () => assert.equal(cleanVision('{"score":70,"confidence":0.5,"cues":[]}').score, 70));
console.log(`gemini: ${pass} checks passed`); process.exit(process.exitCode || 0);
