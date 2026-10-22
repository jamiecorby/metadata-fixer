// One vision call from the browser with the user's own key. The provider is detected from the key's prefix.
export const keyProvider = (k) => (/^AIza/.test(String(k || "")) ? "gemini" : "anthropic");
export const validKey = (k) => /^sk-/.test(k) || /^AIza[\w-]{20,}$/.test(k);
const fail = (msg, code) => Object.assign(new Error(msg), { code });

/** @returns {Promise<string>} the model's text answer */
export async function callOwnKey(key, { image, prompt, maxTokens }) {
  const gem = keyProvider(key) === "gemini";
  let r;
  try {
    r = gem
      ? await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: image } }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: Math.max(4096, maxTokens * 4), temperature: 0.2 } }) })
      : await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: prompt }] }] }) });
  } catch (e) { throw fail(gem ? "Could not reach the Gemini API." : "Could not reach the Anthropic API.", "network"); }
  if (r.status === 401 || r.status === 403 || (gem && r.status === 400 && /API key/i.test(await r.clone().text().catch(() => "")))) throw fail("Your API key was rejected. Check it in Settings.", "bad_key");
  if (r.status === 429 || r.status === 529 || r.status === 503) throw fail("The AI is busy. Wait a moment and try again.", "rate_limited");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail((j.error && j.error.message) || "AI error " + r.status, "api");
  const text = gem ? ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((x) => x.text || "").join("") : (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (!text) throw fail("The AI returned no answer for this image.", "unparseable");
  return text;
}
