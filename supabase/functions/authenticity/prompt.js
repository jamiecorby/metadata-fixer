// The optional visual authenticity prompt. Shared by the browser (own-key mode) and the server proxy.
export const AUTH_SCHEMA = `{"score":0,"confidence":0.0,"cues":[{"cue":"short label","detail":"what you see and where"}]}`;

export function buildAuthPrompt() {
  return `You are a careful image forensics analyst giving an advisory second opinion on whether a picture shows signs of AI generation or AI editing.

Look only at the pixels. Consider: implausible or inconsistent anatomy (hands, teeth, ears, eyes), garbled or nonsense text and logos, inconsistent lighting, shadows or reflections, repeating or melted textures, over-smooth skin, impossible geometry or perspective, objects merging into each other, uncanny depth of field, and seams or tone shifts typical of generative fill or compositing.

Rules:
- "score" is 0 to 100: your estimate of how likely the image is AI-generated or AI-edited. 50 means you cannot tell.
- "confidence" is 0 to 1: how much weight your visual impression deserves. Cap it at 0.7 unless there are multiple independent and unmistakable artefacts. Small, compressed or low-detail images deserve low confidence.
- A clean-looking image is not proof of authenticity, and a stylised, illustrated or heavily filtered photo is not proof of AI. Say so by lowering confidence.
- Do not identify people or places. Do not speculate about who made the image.
- List at most 5 cues, each short and concrete. If you see nothing notable, return an empty list with a score near 50 and low confidence.

Return ONLY this JSON, no other text:
${AUTH_SCHEMA}`;
}

/** Parses and bounds the model's answer. Throws if it is not usable. */
export function cleanVision(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) throw new Error("No JSON in answer");
  const j = JSON.parse(m[0]);
  const score = Math.round(Number(j.score));
  if (!Number.isFinite(score)) throw new Error("No score");
  const conf = Number(j.confidence);
  return {
    score: Math.max(0, Math.min(100, score)),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(0.7, conf)) : 0.3,
    cues: (Array.isArray(j.cues) ? j.cues : []).slice(0, 5).filter((c) => c && typeof c.cue === "string").map((c) => ({ cue: c.cue.slice(0, 60), detail: String(c.detail || "").slice(0, 160) })),
  };
}
