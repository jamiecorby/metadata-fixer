// Settings, named templates and last used settings. Local first; synced to the account when signed in.
import { localZone } from "../core/tz.js";
import { acct, cloudGet, cloudSet } from "./account.js";
const K = { settings: "mf2.settings", templates: "mf2.templates", last: "mf2.last", ctx: "mf2.ctx" };
export const DEFAULTS = () => ({ zone: localZone(), policy: "fill", dev: "none", full: true, label: true, pattern: "{orig}", seq: 1, delivery: "auto", authMode: "always", devName: "", clean: false });
const get = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export function loadSettings() { return { ...DEFAULTS(), ...get(K.settings, {}) }; }
export function saveSettings(s) { put(K.settings, s); }
export let templates = get(K.templates, {});
export let lastUsed = get(K.last, null);
// carry over v1 templates (pattern-only and full) once
try {
  const v1 = JSON.parse(localStorage.getItem("mf.templates.v2") || "null");
  if (v1 && !Object.keys(templates).length) {
    for (const [n, o] of Object.entries(v1)) templates[n] = { settings: { pattern: o.pat || "{orig}", dev: o.gdev || "era", full: o.full !== false }, ctx: { month: o.mo || "", year: o.yr || "", hint: o.hint || "" } };
    put(K.templates, templates);
  }
} catch (e) {}

export async function syncFromCloud() {
  if (!acct.user) return false;
  const [t, l] = await Promise.all([cloudGet("templates"), cloudGet("last")]);
  if (t && typeof t === "object") { templates = { ...templates, ...t }; put(K.templates, templates); if (Object.keys(templates).length !== Object.keys(t).length) cloudSet("templates", templates); }
  else if (Object.keys(templates).length) cloudSet("templates", templates);
  if (l) { lastUsed = l; put(K.last, l); }
  return true;
}
export async function saveTemplate(name, snap) { templates = { ...templates, [name]: snap }; put(K.templates, templates); return acct.user ? cloudSet("templates", templates) : true; }
export async function deleteTemplate(name) { const t = { ...templates }; delete t[name]; templates = t; put(K.templates, templates); return acct.user ? cloudSet("templates", templates) : true; }
export function saveLast(snap) { lastUsed = snap; put(K.last, snap); if (acct.user) cloudSet("last", snap); }
export const loadCtx = () => get(K.ctx, null);
export const saveCtx = (c) => put(K.ctx, c);
