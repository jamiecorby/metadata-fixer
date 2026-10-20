// Shared helpers for Metadata Fixer edge functions.
import { createClient } from "jsr:@supabase/supabase-js@2";
export const ALLOWED_ORIGINS = ["https://jamiecorby.github.io", "http://127.0.0.1:8770", "http://localhost:8770"];
export function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
export const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json" } });
export const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
export async function userFrom(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin().auth.getUser(jwt);
  return error ? null : data.user;
}
export const PACKS: Record<string, { credits: number; cents: number; name: string }> = {
  pack_100: { credits: 100, cents: 500, name: "Metadata Fixer - 100 AI credits" },
  pack_500: { credits: 500, cents: 1900, name: "Metadata Fixer - 500 AI credits" },
  pack_2000: { credits: 2000, cents: 5900, name: "Metadata Fixer - 2,000 AI credits" },
};
