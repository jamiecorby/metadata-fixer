// AI suggestions: through our server (credits) when signed in, or the user's own API key.
import { buildPrompt, cleanAnswer } from "../core/prompt.js";
import { buildAuthPrompt, cleanVision } from "../core/authprompt.js";
import { acct, callFn } from "./account.js";
import { callOwnKey } from "./llm.js";
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
  return cleanAnswer(await callOwnKey(ownKey.get(), { image, prompt: buildPrompt(ctx), maxTokens: 1200 }));
}
/** Optional visual authenticity check on a small metadata-free copy. Costs one AI credit in account mode. Returns {score, confidence, cues}. */
export async function authVision(imageBlob) {
  const mode = aiMode();
  if (mode === "none") throw Object.assign(new Error("The visual check needs an account or your own API key."), { code: "no_ai" });
  const image = await b64(imageBlob);
  if (mode === "account") {
    if (!acct.user) throw Object.assign(new Error("Sign in to use the visual check."), { code: "signin" });
    const j = await callFn("authenticity", { image });
    return j.answer;
  }
  const text = await callOwnKey(ownKey.get(), { image, prompt: buildAuthPrompt(), maxTokens: 500 });
  try { return cleanVision(text); } catch (e) { throw Object.assign(new Error("The AI couldn't give a usable answer for this image."), { code: "unparseable" }); }
}
/** Place search (OpenStreetMap Nominatim). Called only on an explicit search, per the Nominatim usage policy. */
// Nominatim allows about one request a second; rate-limited replies carry no CORS headers, so they surface as network errors.
let lastNom = 0;
async function nominatimGate() { const wait = 1100 - (Date.now() - lastNom); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastNom = Date.now(); }
export async function geocode(q) {
  let j = null, last = null;
  for (let attempt = 0; attempt < 3 && !j; attempt++) {
    await nominatimGate();
    try { const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=" + encodeURIComponent(q)); if (!r.ok) throw new Error("Place search failed (" + r.status + ")"); j = await r.json(); } catch (e) { last = e; }
  }
  if (!j) throw last || new Error("Place search failed");
  return j.map((p) => {
    const la = +p.lat, lo = +p.lon, bb = (p.boundingbox || []).map(Number);
    let rad = 5;
    if (bb.length === 4) { const h = Math.abs(bb[1] - bb[0]) * 111, w = Math.abs(bb[3] - bb[2]) * 111 * Math.cos((la * Math.PI) / 180); rad = Math.max(1, Math.min(500, Math.round(Math.max(h, w) / 2))); }
    return { name: String(p.display_name || "").split(", ").filter((x, i, a) => i < 2 || i === a.length - 1).join(", "), la, lo, r: rad };
  });
}
export async function reverseName(la, lo) {
  await nominatimGate();
  try { const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=en&lat=${la}&lon=${lo}`); const j = await r.json(); const a = j.address || {}; return [a.city || a.town || a.village || a.municipality || a.county, a.state, a.country].filter(Boolean).join(", ") || null; } catch (e) { return null; }
}
