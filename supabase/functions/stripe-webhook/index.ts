// Stripe webhook: verifies the signature, then adds purchased credits exactly once per Checkout session.
import { admin, stripeGet } from "./common.ts";
const enc = new TextEncoder();
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 503 });
  const raw = await req.text();
  const hdr = req.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(hdr.split(",").map((p) => p.split("=", 2)).filter((x) => x.length === 2).map(([k, v]) => [k, v])) as Record<string, string>;
  const v1s = hdr.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = +parts.t;
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return new Response("stale", { status: 400 });
  const expected = await hmacHex(secret, `${t}.${raw}`);
  if (!v1s.some((v) => safeEq(v, expected))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(raw);
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    const s = ev.data.object;
    if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
      const uid = s.client_reference_id || (s.metadata && s.metadata.user_id);
      const n = parseInt(s.metadata && s.metadata.credits, 10);
      if (uid && n > 0) {
        const { error } = await admin().rpc("add_credits", { p_user: uid, p_n: n, p_reason: "purchase", p_ref: "stripe:" + s.id });
        if (error) return new Response("db error", { status: 500 });
      }
    }
  }
  // refunds and disputes take back the matching share of credits (never below zero)
  if (ev.type === "charge.refunded" || ev.type === "charge.dispute.created") {
    const o = ev.data.object;
    const piId = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id;
    if (piId) {
      try {
        const pi = await stripeGet("payment_intents/" + piId);
        const uid = pi.metadata?.user_id, credits = parseInt(pi.metadata?.credits, 10), total = +pi.amount;
        let amount = 0, ref = "";
        if (ev.type === "charge.refunded") { const prev = +(ev.data.previous_attributes?.amount_refunded ?? 0); amount = +o.amount_refunded - prev; ref = "refund:" + ev.id; }
        else { amount = +o.amount; ref = "dispute:" + o.id; }
        const n = Math.ceil((credits * Math.max(0, amount)) / (total || 1));
        if (uid && n > 0) { const { error } = await admin().rpc("remove_credits", { p_user: uid, p_n: n, p_reason: ev.type === "charge.refunded" ? "refund" : "dispute", p_ref: ref }); if (error) return new Response("db error", { status: 500 }); }
      } catch (_e) { return new Response("lookup failed", { status: 500 }); }
    }
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "content-type": "application/json" } });
});
