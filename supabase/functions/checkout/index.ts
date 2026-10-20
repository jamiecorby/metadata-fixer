// Starts a Stripe Checkout session for a credit pack.
import { cors, json, userFrom, PACKS, ALLOWED_ORIGINS } from "./common.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Sign in required" }, 401);
  const sk = Deno.env.get("STRIPE_SECRET_KEY");
  if (!sk) return json(req, { error: "Payments are not configured yet" }, 503);
  let body: { pack?: string; return_url?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Bad request" }, 400); }
  const pack = PACKS[body.pack || ""];
  if (!pack) return json(req, { error: "Unknown pack" }, 400);
  let ret = ALLOWED_ORIGINS[0] + "/metadata-fixer/";
  try { const u = new URL(body.return_url || ""); if (ALLOWED_ORIGINS.includes(u.origin) && u.pathname.startsWith("/metadata-fixer")) ret = u.origin + u.pathname; } catch { /* default */ }
  const f = new URLSearchParams({
    mode: "payment", "success_url": ret + "?checkout=success", "cancel_url": ret + "?checkout=cancel",
    "client_reference_id": user.id, "customer_email": user.email || "", "allow_promotion_codes": "true",
    "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(pack.cents),
    "line_items[0][price_data][product_data][name]": pack.name,
    "metadata[credits]": String(pack.credits), "metadata[user_id]": user.id, "metadata[pack]": body.pack!,
    "payment_intent_data[metadata][user_id]": user.id, "payment_intent_data[metadata][credits]": String(pack.credits),
  });
  if (!user.email) f.delete("customer_email");
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: "Bearer " + sk, "content-type": "application/x-www-form-urlencoded" }, body: f });
  const j = await r.json();
  if (!r.ok) return json(req, { error: (j.error && j.error.message) || "Checkout failed" }, 502);
  return json(req, { url: j.url });
});
