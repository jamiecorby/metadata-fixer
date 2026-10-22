// Accounts, credits and checkout (Supabase). Everything degrades gracefully when not configured.
import { CONFIG } from "../config.js";
export const acct = { configured: !!(CONFIG.supabaseUrl && CONFIG.supabaseKey), user: null, credits: null, ready: false };
let sb = null; const subs = new Set();
export const onAccount = (fn) => subs.add(fn);
const emit = () => subs.forEach((f) => { try { f(acct); } catch (e) {} });

export async function initAccount() {
  if (!acct.configured) { acct.ready = true; emit(); return; }
  const { createClient } = await import("@supabase/supabase-js");
  sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } });
  sb.auth.onAuthStateChange((_e, session) => { const u = session ? session.user : null; const changed = (u && u.id) !== (acct.user && acct.user.id); acct.user = u; if (changed) setTimeout(refreshCredits, 0); else emit(); });
  const { data } = await sb.auth.getSession();
  acct.user = data.session ? data.session.user : null; acct.ready = true;
  if (location.hash.includes("access_token")) history.replaceState(null, "", location.pathname + location.search);
  await refreshCredits();
}
export async function refreshCredits() {
  if (!sb || !acct.user) { acct.credits = null; emit(); return; }
  const { data } = await sb.from("profiles").select("credits").eq("id", acct.user.id).maybeSingle();
  acct.credits = data ? data.credits : 0; emit();
}
export async function signIn(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(error.message);
}
export async function signOut() { await sb.auth.signOut(); acct.user = null; acct.credits = null; emit(); }

export async function callFn(name, body) {
  if (!sb) throw Object.assign(new Error("Accounts are not set up yet."), { code: "no_backend" });
  const { data: s } = await sb.auth.getSession();
  if (!s.session) throw Object.assign(new Error("Sign in first."), { code: "signin" });
  let r;
  try {
    r = await fetch(`${CONFIG.supabaseUrl}/functions/v1/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.session.access_token, apikey: CONFIG.supabaseKey }, body: JSON.stringify(body) });
  } catch (e) { throw Object.assign(new Error("Could not reach the server. Check your connection."), { code: "network" }); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (typeof j.credits === "number") { acct.credits = j.credits; emit(); }
  if (r.status === 402) throw Object.assign(new Error("You're out of AI credits."), { code: "no_credits" });
  if (r.status === 401) throw Object.assign(new Error("Please sign in again."), { code: "signin" });
  if (r.status === 429) throw Object.assign(new Error("Too many requests at once. Wait a moment."), { code: "rate_limited" });
  if (!r.ok) throw Object.assign(new Error(j.error || "Server error " + r.status), { code: "server" });
  if (typeof j.credits === "number") { acct.credits = j.credits; emit(); }
  return j;
}
export async function buy(packId) {
  const j = await callFn("checkout", { pack: packId, return_url: location.origin + location.pathname });
  if (j.url) location.href = j.url; else throw new Error("Checkout could not start.");
}
/** Per-user cloud key/value (templates, last used). */
export async function cloudGet(key) {
  if (!sb || !acct.user) return null;
  const { data } = await sb.from("user_settings").select("value").eq("user_id", acct.user.id).eq("key", key).maybeSingle();
  return data ? data.value : null;
}
export async function cloudSet(key, value) {
  if (!sb || !acct.user) return false;
  const { error } = await sb.from("user_settings").upsert({ user_id: acct.user.id, key, value, updated_at: new Date().toISOString() });
  return !error;
}
