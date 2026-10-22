// One vision call, either provider. Returns plain text plus token counts; throws only on network failure or timeout.
export type Provider = "anthropic" | "gemini";
export type VisionResult = { ok: boolean; status: number; text: string; inTok?: number; outTok?: number; err?: string };
export const pickProvider = (v?: string | null): Provider => (v === "gemini" ? "gemini" : "anthropic");
export function modelFor(p: Provider, anthropicModel?: string | null): string {
  return p === "gemini" ? Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash" : anthropicModel || "claude-sonnet-5-5";
}
export function keyFor(p: Provider): string | undefined {
  return Deno.env.get(p === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY") || undefined;
}
export async function callVision(p: Provider, o: { key: string; model: string; image: string; prompt: string; maxTokens: number }): Promise<VisionResult> {
  if (p === "gemini") {
    // The key goes in a header, never in the URL. Thinking models count reasoning against maxOutputTokens, so leave headroom.
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`, {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-goog-api-key": o.key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: o.prompt }, { inline_data: { mime_type: "image/jpeg", data: o.image } }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: Math.max(4096, o.maxTokens * 4), temperature: 0.2 } }),
    });
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json().catch(() => ({}));
    const text = (j.candidates?.[0]?.content?.parts || []).map((x: { text?: string }) => x.text || "").join("");
    const blocked = j.promptFeedback?.blockReason || (j.candidates?.[0]?.finishReason === "SAFETY" ? "SAFETY" : "");
    return { ok: r.ok && !!text && !blocked, status: r.ok && (!text || blocked) ? 502 : r.status, text, inTok: j.usageMetadata?.promptTokenCount, outTok: j.usageMetadata?.candidatesTokenCount, err: String(j.error?.message || (blocked ? "blocked: " + blocked : !text && r.ok ? "empty answer" : "")).slice(0, 200) };
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", "x-api-key": o.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: o.image } }, { type: "text", text: o.prompt }] }] }),
  });
  // deno-lint-ignore no-explicit-any
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, text: (j.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(""), inTok: j.usage?.input_tokens, outTok: j.usage?.output_tokens, err: String(j.error?.message || "").slice(0, 200) };
}
