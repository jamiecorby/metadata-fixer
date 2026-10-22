// Visual authenticity check. Charges one credit, calls Claude with a fixed forensic prompt, refunds only when the AI service itself fails.
// Images are never stored or logged. No caller-supplied text reaches the model, so this can't be used as a general AI proxy.
import { admin, cors, json, userFrom } from "./common.ts";
import { buildAuthPrompt, cleanVision } from "./prompt.js";
const MODEL = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  if (+(req.headers.get("content-length") || 0) > 2_200_000) return json(req, { error: "Request too large" }, 413);
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Sign in required" }, 401);
  const raw = await req.text();
  if (raw.length > 2_200_000) return json(req, { error: "Request too large" }, 413);
  let body: { image?: string };
  try { body = JSON.parse(raw); } catch { return json(req, { error: "Bad request" }, 400); }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > 2_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(image)) return json(req, { error: "Image missing or invalid" }, 400);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json(req, { error: "AI is not configured yet" }, 503);
  const db = admin();
  // record the request first, so parallel requests count against the rate limit
  const { data: row, error: re } = await db.from("ai_requests").insert({ user_id: user.id, ok: false, model: MODEL, error: "pending" }).select("id").single();
  if (re || !row) return json(req, { error: "Server busy" }, 500);
  const done = (patch: Record<string, unknown>) => db.from("ai_requests").update(patch).eq("id", row.id);
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) > 30) { await done({ error: "rate_limited" }); return json(req, { error: "Too many requests; slow down" }, 429); }
  const { data: left, error: ce } = await db.rpc("consume_credit", { p_user: user.id });
  if (ce) { await done({ error: "credit_check" }); return json(req, { error: "Credit check failed" }, 500); }
  if (left < 0) { await done({ error: "no_credits" }); return json(req, { error: "Out of credits", credits: 0 }, 402); }
  const t0 = Date.now();
  let r: Response, j: { usage?: { input_tokens?: number; output_tokens?: number }; content?: { type: string; text: string }[]; error?: { message?: string } };
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: buildAuthPrompt() }] }] }),
    });
    j = await r.json();
  } catch (e) {
    const { data: back } = await db.rpc("refund_credit", { p_user: user.id });
    await done({ ms: Date.now() - t0, error: "upstream: " + String((e as Error).message || e).slice(0, 200) });
    return json(req, { error: "The AI service didn't respond; your credit was refunded.", credits: back }, 502);
  }
  const usage = j.usage || {};
  if (!r.ok) {
    const { data: back } = await db.rpc("refund_credit", { p_user: user.id });
    await done({ ms: Date.now() - t0, error: "upstream " + r.status + ": " + String(j.error?.message || "").slice(0, 200) });
    return json(req, { error: r.status === 429 || r.status === 529 ? "The AI is busy; your credit was refunded. Try again shortly." : "The AI service failed; your credit was refunded.", credits: back }, 502);
  }
  try {
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const answer = cleanVision(text);
    await done({ ok: true, error: null, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ms: Date.now() - t0 });
    return json(req, { answer, credits: left });
  } catch (e) {
    // the model answered but not in the required format: no refund (the call was made and billed)
    await done({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ms: Date.now() - t0, error: "unparseable answer" });
    return json(req, { error: "The AI couldn't give a usable answer for this image.", credits: left }, 422);
  }
});
