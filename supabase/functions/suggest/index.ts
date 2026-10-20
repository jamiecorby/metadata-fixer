// AI suggestion proxy: charges one credit, calls Claude, refunds on failure. Images are never stored or logged.
import { admin, cors, json, userFrom } from "./common.ts";
import { buildPrompt, cleanAnswer } from "./prompt.js";
const MODEL = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Sign in required" }, 401);
  let body: { image?: string; ctx?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json(req, { error: "Bad request" }, 400); }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) return json(req, { error: "Image missing or too large" }, 400);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json(req, { error: "AI is not configured yet" }, 503);
  const db = admin();
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= 40) return json(req, { error: "Too many requests; slow down" }, 429);
  const { data: left, error: ce } = await db.rpc("consume_credit", { p_user: user.id });
  if (ce) return json(req, { error: "Credit check failed" }, 500);
  if (left < 0) return json(req, { error: "Out of credits", credits: 0 }, 402);
  const t0 = Date.now();
  let ok = false, usage: { input_tokens?: number; output_tokens?: number } = {}, err = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: buildPrompt((body.ctx || {}) as never) }] }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "AI error " + r.status);
    usage = j.usage || {};
    const text = (j.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    const answer = cleanAnswer(text);
    ok = true;
    await db.from("ai_requests").insert({ user_id: user.id, ok, model: MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ms: Date.now() - t0 });
    return json(req, { answer, credits: left });
  } catch (e) {
    err = String((e as Error).message || e).slice(0, 300);
    const { data: back } = await db.rpc("refund_credit", { p_user: user.id });
    await db.from("ai_requests").insert({ user_id: user.id, ok: false, model: MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ms: Date.now() - t0, error: err });
    return json(req, { error: "The AI couldn't answer this time; your credit was refunded.", credits: back }, 502);
  }
});
