// AI suggestions: through our server (credits) when signed in, or the user's own API key.
import { buildPrompt, cleanAnswer } from "../core/prompt.js";
import { acct, callFn } from "./account.js";
const KEY = "mf2.apikey";
export const ownKey = { get: () => { try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }, set: (v, remember) => { try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); if (v) (remember ? localStorage : sessionStorage).setItem(KEY, v); } catch (e) {} } };
export const aiMode = () => (ownKey.get() ? "own" : acct.configured ? "account" : "none");

async function b64(blob) { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }

export async function suggest(imageBlob, ctx) {
  const mode = aiMode();
  if (mode === "none") throw Object.assign(new Error("AI suggestions are not available yet. Everything else works."), { code: "no_ai" });
  const image = await b64(imageBlob);
  if (mode === "account") {
    if (!acct.user) throw Object.assign(new Error("Sign in to use AI suggestions."), { code: "signin" });
    const j = await callFn("suggest", { image, ctx });
    return cleanAnswer(j.answer);
  }
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": ownKey.get(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1200, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: buildPrompt(ctx) }] }] }) });
  } catch (e) { throw Object.assign(new Error("Could not reach the Anthropic API."), { code: "network" }); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Your API key was rejected. Check it in Settings."), { code: "bad_key" });
  if (r.status === 429 || r.status === 529) throw Object.assign(new Error("The AI is busy. Wait a moment and try again."), { code: "rate_limited" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || "AI error " + r.status), { code: "api" });
  return cleanAnswer((j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""));
}
/** Place search (OpenStreetMap Nominatim). Called only on an explicit search, per the Nominatim usage policy. */
export async function geocode(q) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=" + encodeURIComponent(q));
  if (!r.ok) throw new Error("Place search failed");
  const j = await r.json();
  return j.map((p) => {
    const la = +p.lat, lo = +p.lon, bb = (p.boundingbox || []).map(Number);
    let rad = 5;
    if (bb.length === 4) { const h = Math.abs(bb[1] - bb[0]) * 111, w = Math.abs(bb[3] - bb[2]) * 111 * Math.cos((la * Math.PI) / 180); rad = Math.max(1, Math.min(500, Math.round(Math.max(h, w) / 2))); }
    return { name: String(p.display_name || "").split(", ").filter((x, i, a) => i < 2 || i === a.length - 1).join(", "), la, lo, r: rad };
  });
}
let lastRev = 0;
export async function reverseName(la, lo) {
  const wait = 1100 - (Date.now() - lastRev); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastRev = Date.now();
  try { const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=en&lat=${la}&lon=${lo}`); const j = await r.json(); const a = j.address || {}; return [a.city || a.town || a.village || a.municipality || a.county, a.state, a.country].filter(Boolean).join(", ") || null; } catch (e) { return null; }
}
