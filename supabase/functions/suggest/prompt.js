// The AI dating/locating prompt. Shared by the browser (own-key mode) and the server proxy.
export const SCHEMA_HINT = `{"dates":[{"start":"YYYY-MM-DD","end":"YYYY-MM-DD","time":"HH:MM","confidence":0.0,"basis":"short reason"}],"locations":[{"name":"place, region, country","lat":0.0,"lon":0.0,"radius_km":0,"timezone":"Area/City","confidence":0.0,"basis":"short reason"}],"scene":"under 12 words"}`;

/** ctx: {fileName, kind, knownDate, knownPlace, before, after, month, year, rangeStart, rangeEnd, area:{name,la,lo,r}, hint} */
export function buildPrompt(ctx = {}) {
  const facts = [];
  if (ctx.fileName) facts.push(`File name: ${String(ctx.fileName).slice(0, 120)}`);
  if (ctx.kind === "video") facts.push("This is a frame from a video.");
  if (ctx.knownDate) facts.push(`The capture date is already known: ${ctx.knownDate}. Use it, and focus on the location.`);
  if (ctx.knownPlace) facts.push(`The location is already known: ${ctx.knownPlace}. Use it (hemisphere, climate) when judging the season, and focus on the date.`);
  if (ctx.before || ctx.after) facts.push(`Neighbouring files in the same batch were taken ${[ctx.before && "around " + ctx.before + " (before)", ctx.after && "around " + ctx.after + " (after)"].filter(Boolean).join(" and ")}.`);
  if (ctx.rangeStart && ctx.rangeEnd) facts.push(`The owner says it was taken between ${ctx.rangeStart} and ${ctx.rangeEnd}. Stay inside that range.`);
  else if (ctx.month) facts.push(`The owner says it was taken in ${ctx.month}${ctx.year ? " " + ctx.year : " (year unknown)"}.`);
  if (ctx.area && isFinite(ctx.area.la)) facts.push(`The owner says it was taken within ${ctx.area.r} km of ${ctx.area.name ? ctx.area.name + " " : ""}(${(+ctx.area.la).toFixed(3)}, ${(+ctx.area.lo).toFixed(3)}). Keep every location inside that area.`);
  if (ctx.hint) facts.push(`Owner's note: ${String(ctx.hint).slice(0, 300)}`);
  return `You are a careful photo archivist reconstructing lost capture metadata from what is visible in the image.

Work only from visible evidence: season (foliage, snow, light, clothing), time of day (sun angle, shadows, sky, lighting), era (devices, vehicles, fashion, packaging, signage, image style), and place (landmarks, language and script on signs, road markings and driving side, plates, architecture, vegetation, terrain, coastline).
${facts.length ? "\nKnown facts:\n- " + facts.join("\n- ") + "\n" : ""}
Rules:
- Return up to 3 date ranges and up to 3 locations, best first.
- Confidence is your honest probability (0 to 1) that the truth lies inside the range or radius. Narrow ranges need strong evidence; when evidence is weak, widen the range and lower the confidence rather than guessing precisely.
- Never invent precision: no street-level coordinates unless a specific landmark is clearly identified; the radius must reflect your uncertainty.
- "time" is local time of day at the place (24h). Use 12:00 if there is no evidence.
- "timezone" is the IANA zone for the location (for example Europe/Lisbon).
- If there is nothing to go on, return empty lists.

Return ONLY this JSON, no other text:
${SCHEMA_HINT}`;
}

/** Validate and clean a model response. Never trust it blindly. */
export function cleanAnswer(raw) {
  let j = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON in answer");
    j = JSON.parse(m[0]);
  }
  const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
  const conf = (c) => Math.max(0, Math.min(1, +c || 0));
  const dates = (Array.isArray(j.dates) ? j.dates : []).slice(0, 3).filter((d) => d && isDay(d.start)).map((d) => ({
    start: d.start, end: isDay(d.end) && d.end >= d.start ? d.end : d.start,
    time: /^\d{1,2}:\d{2}$/.test(d.time || "") ? d.time.padStart(5, "0") : "12:00",
    confidence: conf(d.confidence), basis: String(d.basis || "").slice(0, 160),
  }));
  const locations = (Array.isArray(j.locations) ? j.locations : []).slice(0, 3).filter((l) => l && isFinite(+l.lat) && isFinite(+l.lon) && Math.abs(+l.lat) <= 90 && Math.abs(+l.lon) <= 180).map((l) => ({
    name: String(l.name || "").slice(0, 120), lat: +(+l.lat).toFixed(4), lon: +(+l.lon).toFixed(4),
    radius_km: Math.max(0.1, Math.min(5000, +l.radius_km || 50)), timezone: typeof l.timezone === "string" ? l.timezone.slice(0, 64) : null,
    confidence: conf(l.confidence), basis: String(l.basis || "").slice(0, 160),
  }));
  return { dates, locations, scene: String(j.scene || "").slice(0, 120) };
}
