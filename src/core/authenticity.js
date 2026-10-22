// Authenticity check: how likely is it that an image or video is AI-generated or AI-edited, and is its metadata honest?
//
// Deterministic evidence first (declared provenance, generator signatures, prompt fields, impossible camera/date combinations),
// then an optional visual estimate that can only nudge the result. The score is a heuristic summary of evidence, never proof.
// Fixes only ever ADD disclosure or remove metadata that contradicts the provenance; AI provenance is never removed or weakened.
import { parseStamp } from "./time.js";
import { IPHONES } from "./devices.js";

const SKIP_GROUP = /^(System|File|ExifTool|Composite|SourceFile)$/;
const DST_BASE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
export const DST = { trained: DST_BASE + "trainedAlgorithmicMedia", composite: DST_BASE + "compositeWithTrainedAlgorithmicMedia" };

const GENERATORS = [
  [/\bMidjourney\b|(?:^|\s)--(?:v|ar|style|stylize|chaos|niji)\s*[\d.:a-z]+/i, "Midjourney"],
  [/\bDALL[-·\s]?E\b|\bgpt-image\b|\bChatGPT\b/i, "OpenAI DALL-E / GPT Image"],
  [/\bStable[\s_-]?Diffusion\b|\bSDXL\b|\bAutomatic1111\b|\bInvokeAI\b|\bFooocus\b|\bDreamStudio\b/i, "Stable Diffusion"],
  [/\bComfyUI\b/i, "ComfyUI"],
  [/\bAdobe\s+Firefly\b/i, "Adobe Firefly"],
  [/\bImagen\s?\d?\b|\bMade with Google AI\b|\bGoogle\s+Gemini\b|\bNano Banana\b|\bSynthID\b/i, "Google AI"],
  [/\bLeonardo\.?\s?Ai\b/i, "Leonardo.Ai"], [/\bNightCafe\b/i, "NightCafe"], [/\bIdeogram\b/i, "Ideogram"], [/\bFLUX\.1\b|\bBlack Forest Labs\b/i, "FLUX"],
  [/\bRunway\s?ML\b|\bRunway\s+Gen[-\s]?\d/i, "Runway"], [/\bCraiyon\b/i, "Craiyon"], [/\bNovelAI\b/i, "NovelAI"], [/\bPlayground\s?AI\b/i, "Playground AI"],
  [/\bBing Image Creator\b|\bMicrosoft Designer\b|\bCopilot Designer\b/i, "Microsoft Designer"], [/\bMeta AI\b|\bImagine with Meta\b/i, "Meta AI"], [/\bOpenAI\b/i, "OpenAI"],
];
const AI_FIELD_KEYS = /(AISystemUsed|AIPromptInformation|AIPromptWriterName|AISystemVersionUsed)$/;
const EDITORS = /Photoshop|Lightroom|GIMP|Affinity|Pixelmator|Snapseed|Capture One|Canva|Paint\.NET|darktable|Luminar|Photopea|Picsart|PicsArt|VSCO|Polarr|Fotor|Luminar/i;
const AI_ENHANCERS = /\bLensa\b|\bRemini\b|\bFaceApp\b|\bFacetune\b|\bTopaz\b|\bGigapixel\b|\bMagic (Eraser|Editor)\b|\bGenerative (Fill|Expand|Remove)\b|\bGenerative Fill\b/i;
const MAKE_MODEL = [
  [/^apple$/i, /iPhone|iPad|iPod/i], [/^canon$/i, /Canon|EOS|PowerShot|IXUS|IXY/i], [/^nikon/i, /NIKON|COOLPIX|\bZ\s?\d|\bD\d{2,4}/i],
  [/^sony$/i, /ILCE|DSC|ILME|ZV|DSLR|NEX|SLT|ILCA|Xperia|Sony/i], [/^google$/i, /Pixel/i], [/^samsung/i, /SM-|GT-|Galaxy|SAMSUNG|SCH-/i], [/^fuji/i, /X-|GFX|FinePix|FUJIFILM/i],
];
const GEN_SIZES = new Set([512, 576, 640, 704, 768, 832, 896, 960, 1024, 1152, 1216, 1280, 1344, 1536, 1664, 1792, 1920, 2048]);
const MAKER_GROUPS = /^(Apple|Canon|Nikon|Sony|Olympus|Panasonic|Fuji|FujiFilm|Samsung|Pentax|Leica|Casio|Sigma|Ricoh|Minolta|Google|Hasselblad|DJI|Kodak|MakerNotes)/i;

const str = (v) => (v == null ? "" : String(v));
const snippet = (s, re) => { const m = re.exec(s); if (!m) return s.slice(0, 80); const i = Math.max(0, m.index - 20); return (i ? "..." : "") + s.slice(i, i + 90).replace(/\s+/g, " ") + (s.length > i + 90 ? "..." : ""); };
const tail = (k) => k.slice(k.indexOf(":") + 1);

/** The camera facts we compare. */
function camera(raw, kind) {
  const g = (...ks) => { for (const k of ks) if (raw[k] != null && raw[k] !== "") return raw[k]; return null; };
  return {
    make: str(g("IFD0:Make", "Keys:Make", "UserData:Make")), model: str(g("IFD0:Model", "Keys:Model", "UserData:Model")), lens: str(g("ExifIFD:LensModel")),
    fl: g("ExifIFD:FocalLength"), fn: g("ExifIFD:FNumber"), iso: g("ExifIFD:ISO"), et: g("ExifIFD:ExposureTime"), kind,
  };
}
const cameraKeys = (raw) => Object.keys(raw).filter((k) => /^(IFD0:(Make|Model)|ExifIFD:(LensMake|LensModel|LensInfo|LensSerialNumber|FocalLength|FocalLengthIn35mmFormat|FNumber|ExposureTime|ISO|ExposureProgram|MeteringMode|Flash|BodySerialNumber|SerialNumber)|Keys:(Make|Model))$/.test(k));

/**
 * @param {object} i
 *  raw   exiftool -json -n -G1 output for the file (or {})
 *  kind  "photo" | "video"
 *  c2pa  claims from readClaims(scanContainer(file)) or null
 *  plan  {t, off, devModel, writeDevice, la, lo} what the export will write (optional)
 *  offsetAt (la, lo, naiveMs) => minutes|null, for offset-vs-place checks
 *  vision {score, confidence, cues[]}|null
 *  now   ms
 */
export function assess(i) {
  const raw = i.raw || {}, now = i.now || Date.now(), kind = i.kind || "photo";
  const ev = []; // {id, tone: ai|camera|warn|info|vision, w, title, detail}
  const add = (id, tone, w, title, detail) => ev.push({ id, tone, w, title, detail: detail || "" });
  const f = { declared: false, fullyGenerated: false, composite: false, generator: null, contradictoryCamera: false, modifyBeforeCapture: false, c2pa: false, editor: null, camTags: cameraKeys(raw) };

  // ---- 1. declared provenance
  const dsts = Object.entries(raw).filter(([k]) => /DigitalSourceType$/.test(k)).map(([k, v]) => [k, str(v)]);
  for (const [k, v] of dsts) {
    if (/compositeWithTrainedAlgorithmicMedia/i.test(v)) { f.declared = f.composite = true; add("dst-composite", "ai", 3.5, "Declares AI-edited content", `${k} says: composite with trained algorithmic media.`); }
    else if (/trainedAlgorithmicMedia/i.test(v)) { f.declared = f.fullyGenerated = true; add("dst-ai", "ai", 6, "Declares itself AI-generated", `${k} says: trained algorithmic media.`); }
    else if (/compositeSynthetic/i.test(v)) { f.declared = f.composite = true; add("dst-synthetic", "ai", 2, "Declares synthetic elements", `${k} says: composite synthetic.`); }
    else if (/algorithmicMedia/i.test(v)) { f.declared = f.fullyGenerated = true; add("dst-algo", "ai", 3, "Declares algorithmic media", `${k} says: algorithmic media.`); }
    else if (/digitalCapture|computationalCapture/i.test(v)) add("dst-capture", "camera", -1, "Declares a camera capture", `${k} says: digital capture.`);
  }
  const aiFields = Object.keys(raw).filter((k) => AI_FIELD_KEYS.test(k) && str(raw[k]).trim());
  if (aiFields.length) { f.declared = true; f.fullyGenerated = f.fullyGenerated || !f.composite; add("ai-fields", "ai", 5, "Records the AI system or prompt", `${aiFields.map(tail).join(", ")} ${aiFields.length > 1 ? "are" : "is"} filled in.`); }

  // ---- 2. Content Credentials
  const c = i.c2pa || null;
  if (c && c.present) {
    f.c2pa = true;
    if (c.aiGenerated) { f.declared = f.fullyGenerated = true; add("c2pa-ai", "ai", 6, "Content Credentials say AI-generated", `A C2PA manifest${c.aiVendor ? " from " + c.aiVendor : ""} marks the content as generated.`); }
    else if (c.composite) { f.declared = f.composite = true; add("c2pa-composite", "ai", 3.5, "Content Credentials include AI editing", `A C2PA manifest${c.aiVendor ? " from " + c.aiVendor : ""} records AI-assisted edits.`); }
    else if (c.capture) add("c2pa-capture", "camera", -2.5, "Content Credentials record a camera capture", `A C2PA manifest${c.issuer ? " (" + c.issuer + ")" : ""} says this was captured by a device. Signature not validated here.`);
    else add("c2pa-present", "info", 0, "Has Content Credentials", `A C2PA manifest${c.generator ? " from " + c.generator : ""} is present; nothing in it marks the image as AI.`);
  }

  // ---- 3. generator names, prompt fields, generative edits in any text field
  const seen = new Set(); let sdParams = false, comfy = false, mj = false;
  for (const [k, v] of Object.entries(raw)) {
    const g = k.split(":")[0];
    if (SKIP_GROUP.test(g) || typeof v !== "string" || !v || /^(IFD0:(Make|Model)|ExifIFD:Lens)/.test(k)) continue;
    const s = v.slice(0, 20000);
    if (/Steps:\s*\d+.*Sampler:|CFG scale:\s*[\d.]+|Negative prompt:/s.test(s) && !sdParams) { sdParams = true; f.fullyGenerated = true; add("sd-params", "ai", 6, "Contains Stable Diffusion generation settings", `${k} holds prompt settings (steps, sampler, CFG scale).`); }
    if (/"class_type"\s*:/.test(s) && !comfy) { comfy = true; f.fullyGenerated = true; add("comfy", "ai", 6, "Contains a ComfyUI workflow", `${k} holds a node graph.`); }
    for (const [re, name] of GENERATORS) {
      if (seen.has(name) || !re.test(s)) continue;
      if (/^(Midjourney)$/.test(name)) mj = true;
      if (name === "OpenAI" && seen.has("OpenAI DALL-E / GPT Image")) continue;
      seen.add(name); f.generator = f.generator || name; if (name === "Adobe Firefly") f.composite = true; else f.fullyGenerated = true;
      add("gen-" + name.toLowerCase().replace(/\W+/g, "-"), "ai", 5, `Names an AI generator: ${name}`, `${k}: "${snippet(s, re)}"`);
    }
    if (AI_ENHANCERS.test(s) && !seen.has("enh")) { seen.add("enh"); f.composite = true; add("ai-edit", "ai", 3, "Records an AI editing feature", `${k}: "${snippet(s, AI_ENHANCERS)}"`); }
    else if (EDITORS.test(s) && /Software|CreatorTool|History/i.test(k) && !f.editor) { f.editor = (EDITORS.exec(s) || [])[0]; add("editor", "info", 0, `Edited with ${f.editor}`, `${k}: "${snippet(s, EDITORS)}". Editing is not the same as AI generation.`); }
  }
  if (f.generator && !mj && seen.size > 3) f.generator = [...seen][0];

  // ---- 4. camera genuineness and consistency
  const cam = camera(raw, kind), t0 = parseStamp(raw["ExifIFD:DateTimeOriginal"] || raw["XMP-exif:DateTimeOriginal"] || raw["Keys:CreationDate"]);
  const hasMake = !!(cam.make && cam.model);
  let camNeg = 0;
  if (kind === "photo") {
    const trip = [cam.et, cam.fn, cam.iso, cam.fl].filter((x) => x != null).length;
    if (trip >= 4) { camNeg -= 1.5; add("exposure", "camera", -1.5, "Full exposure record", "Exposure time, aperture, ISO and focal length are all present, as a camera writes them."); }
    else if (trip >= 2) { camNeg -= 0.6; add("exposure-part", "camera", -0.6, "Partial exposure record", `${trip} of 4 exposure fields present.`); }
    if (cam.lens) { camNeg -= 0.5; add("lens", "camera", -0.5, "Lens recorded", cam.lens); }
    const maker = Object.keys(raw).filter((k) => MAKER_GROUPS.test(k.split(":")[0]) && !/^MakerNotes:?$/.test(k)).length;
    if (maker >= 5) { camNeg -= 1.2; add("makernotes", "camera", -1.2, "Manufacturer maker notes present", `${maker} camera-specific fields that generators do not write.`); }
  }
  if (hasMake) { camNeg -= 0.8; add("make-model", "camera", -0.8, "Camera make and model recorded", `${cam.make} ${cam.model}`); }
  if (raw["GPS:GPSLatitude"] != null || raw["Composite:GPSLatitude"] != null) { camNeg -= 0.3; add("gps", "camera", -0.3, "Has GPS coordinates", "Location data is rarely present on generated images."); }
  camNeg = Math.max(camNeg, -4.5);

  // ---- 5. implausible combinations (these also count mildly toward doubt)
  let warnW = 0; const warn = (id, w, title, detail) => { warnW += w; add(id, "warn", w, title, detail); };
  const model = IPHONES.find((p) => p.model === cam.model || (cam.model && cam.model.startsWith(p.model + " ")) || cam.model === p.model);
  if (model && t0 && model.released > t0.t + 86400000) warn("camera-before-release", 1.5, "Camera is newer than the date", `${cam.model} was released ${new Date(model.released).toISOString().slice(0, 10)}, after the recorded ${new Date(t0.t).toISOString().slice(0, 10)}.`);
  if (hasMake) {
    const row = MAKE_MODEL.find(([mk]) => mk.test(cam.make));
    if (row && !row[1].test(cam.model)) warn("make-model-mismatch", 1.5, "Make and model do not belong together", `${cam.make} does not make a "${cam.model}".`);
    if (/^apple$/i.test(cam.make) && cam.lens && !/iPhone|iPad/i.test(cam.lens)) warn("lens-mismatch", 1.2, "Lens does not fit the camera", `"${cam.lens}" is not an Apple lens.`);
    if (/iPhone/i.test(cam.model) && cam.fl != null && +cam.fl > 15) warn("focal-impossible", 1.2, "Focal length is impossible for a phone", `${cam.fl} mm on ${cam.model}.`);
  }
  if (cam.fn != null && (+cam.fn < 0.7 || +cam.fn > 64)) warn("aperture-impossible", 1, "Aperture out of range", `f/${cam.fn}`);
  if (cam.fl != null && (+cam.fl <= 0 || +cam.fl > 2500)) warn("focal-range", 1, "Focal length out of range", `${cam.fl} mm`);
  if (cam.iso != null && (+cam.iso <= 0 || +cam.iso > 12800000)) warn("iso-range", 1, "ISO out of range", `ISO ${cam.iso}`);
  if (t0 && t0.t > now + 2 * 86400000) warn("future-date", 1.5, "Capture date is in the future", new Date(t0.t).toISOString().slice(0, 16).replace("T", " "));
  const mod = parseStamp(raw["IFD0:ModifyDate"]);
  if (t0 && mod && mod.t < t0.t - 60000) { f.modifyBeforeCapture = true; warn("modify-before-capture", 0.8, "Modified before it was taken", `Modify date ${new Date(mod.t).toISOString().slice(0, 16).replace("T", " ")} is earlier than the capture date.`); }
  const lat = raw["Composite:GPSLatitude"], lon = raw["Composite:GPSLongitude"], offStr = raw["ExifIFD:OffsetTimeOriginal"] || raw["ExifIFD:OffsetTime"];
  if (t0 && lat != null && lon != null && offStr && i.offsetAt) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(str(offStr).trim()), want = i.offsetAt(+lat, +lon, t0.t);
    if (m && want != null) { const have = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]); if (have !== want) warn("offset-vs-place", 0.8, "Time zone does not match the location", `Recorded offset ${offStr}, but the GPS position is in a zone at ${want >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(want) / 60)).padStart(2, "0")}:${String(Math.abs(want) % 60).padStart(2, "0")}.`); }
  }
  const gd = str(raw["GPS:GPSDateStamp"]), gt = str(raw["GPS:GPSTimeStamp"]);
  if (t0 && t0.off != null || (t0 && offStr)) {
    const gu = parseStamp(gd.replace(/\//g, ":") + " " + gt);
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(str(offStr || "").trim()), o = t0.off != null ? t0.off : m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
    if (gu && o != null && Math.abs(gu.t - (t0.t - o * 60000)) > 15 * 60000) warn("gps-clock", 1, "GPS clock disagrees with the capture time", "The GPS UTC time and the local time plus offset differ by more than 15 minutes.");
  }
  if (f.fullyGenerated && (hasMake || f.camTags.length >= 3)) { f.contradictoryCamera = true; add("ai-with-camera", "warn", 0, "Camera details contradict the AI marker", "The file declares or shows AI generation but also carries camera fields, which cannot both be true."); }
  warnW = Math.min(warnW, 3);

  // ---- 6. size and emptiness cues (weak)
  const dims = (/^(\d+) (\d+)$/.exec(str(raw["Composite:ImageSize"])) || []).slice(1).map(Number);
  const w = +raw["File:ImageWidth"] || dims[0] || 0, h = +raw["File:ImageHeight"] || dims[1] || 0;
  let weak = 0;
  if (kind === "photo" && w && h && GEN_SIZES.has(w) && GEN_SIZES.has(h) && !hasMake && !camNeg && !ev.some((e) => e.tone === "ai" && e.w >= 2)) { weak += w === h ? 0.6 : 0.4; add("gen-size", "ai", w === h ? 0.6 : 0.4, "Typical generator image size", `${w} x ${h} is a size AI image tools commonly output, and there is no camera data.`); }
  const meaningful = Object.keys(raw).filter((k) => !SKIP_GROUP.test(k.split(":")[0]) && k !== "SourceFile" && !/^(PNG:(ImageWidth|ImageHeight|BitDepth|ColorType|Compression|Filter|Interlace|PixelsPerUnit.*|SRGBRendering|Gamma))$/.test(k) && !/^JFIF:/.test(k)).length;
  if (!ev.some((e) => e.tone === "ai" || e.tone === "camera") && meaningful === 0) { add("stripped", "info", 0.2, "No provenance metadata at all", "Social apps, messengers and screenshots strip metadata, and so do some AI tools. This says little either way."); }

  // ---- 7. optional visual estimate (can only nudge)
  let vis = null;
  if (i.vision && Number.isFinite(i.vision.score)) {
    const conf = Math.max(0, Math.min(1, i.vision.confidence ?? 0.5)), wv = Math.max(-1.6, Math.min(1.6, ((i.vision.score - 50) / 50) * 2.4 * (0.4 + 0.6 * conf)));
    vis = { score: i.vision.score, confidence: conf, cues: (i.vision.cues || []).slice(0, 6), w: wv };
    add("vision", "vision", wv, `Visual check: ${i.vision.score >= 60 ? "signs of generation or editing" : i.vision.score <= 40 ? "looks like an ordinary photo" : "inconclusive"}`, (vis.cues.length ? vis.cues.map((x) => x.cue + (x.detail ? " - " + x.detail : "")).join("; ") : "No specific cues listed.") + " This is an AI estimate from the picture, not proof.");
  }

  // ---- combine
  const det = ev.filter((e) => e.tone === "ai" && e.w > 0 || e.tone === "camera");
  const sumAi = ev.filter((e) => e.tone === "ai").reduce((a, e) => a + e.w, 0);
  const strongAi = Math.min(8, sumAi - weak) + Math.min(weak, 1.6);
  const x = -0.8 + strongAi + camNeg + warnW * 0.6 + (vis ? vis.w : 0) + (ev.find((e) => e.id === "stripped") ? 0.2 : 0) + (c && c.present && c.capture ? 0 : 0);
  // a strong declaration overrides camera-looking fields (they are exactly what a faker would add)
  const xf = f.fullyGenerated ? Math.max(x, 4.5 + Math.min(1.5, sumAi / 6)) : f.composite ? Math.max(x, 1.0 + Math.min(0.6, sumAi / 10)) : x;
  const p = 1 / (1 + Math.exp(-xf));
  const score = Math.max(1, Math.min(99, Math.round(p * 100)));
  const S = ev.reduce((a, e) => a + Math.abs(e.tone === "vision" ? e.w * 0.5 : e.w), 0);
  let half = Math.max(3, Math.round(32 / (1 + S * 0.9)));
  const onlyVision = vis && !ev.some((e) => e.tone !== "vision" && Math.abs(e.w) >= 1);
  if (onlyVision) half = Math.max(half, 22);
  const lo = Math.max(1, score - half), hi = Math.min(99, score + half);
  const confidence = half <= 8 ? "high" : half <= 18 ? "medium" : "low";
  const enough = ev.some((e) => Math.abs(e.w) >= 1);
  let level;
  if (!enough) level = "Not enough evidence";
  else if (score >= 85) level = "AI-generated (strong evidence)";
  else if (score >= 60) level = "Likely AI-generated or AI-edited";
  else if (score >= 35) level = "Unclear";
  else if (score >= 15) level = "Probably a genuine capture";
  else level = "Very likely a genuine capture";
  const warned = ev.some((e) => e.tone === "warn" && e.w > 0);
  if (enough && warned && score < 60) level = "Metadata looks inconsistent";
  const flagged = score >= 60 || ev.some((e) => e.tone === "warn" && e.w > 0) || f.contradictoryCamera;

  // ---- plain suggestions
  const sug = [];
  const needsLabel = (f.fullyGenerated || f.composite) && !dsts.some(([, v]) => /trainedAlgorithmicMedia|algorithmicMedia/i.test(v));
  if (needsLabel) sug.push(f.composite && !f.fullyGenerated ? "Add an \"AI-edited\" disclosure label (Fix does this)." : "Add an \"AI-generated\" disclosure label so other apps can see it (Fix does this).");
  if (f.contradictoryCamera) sug.push("Remove the camera fields that contradict the AI marker (Fix does this). The AI marker itself is never touched.");
  if (f.modifyBeforeCapture) sug.push("Set the modify date to the capture date (Fix does this).");
  if (ev.some((e) => e.id === "camera-before-release" || e.id === "make-model-mismatch" || e.id === "lens-mismatch" || e.id === "focal-impossible")) sug.push("The camera details cannot be true for this file. Check the device in the editor, or choose \"Don't add device details\".");
  if (ev.some((e) => e.id === "future-date")) sug.push("The date is in the future. Correct it in the editor.");
  if (ev.some((e) => e.id === "offset-vs-place" || e.id === "gps-clock")) sug.push("The time zone or clock disagrees with the GPS position. Check the time zone in the editor.");
  if (f.c2pa) sug.push("This file has Content Credentials. Saving any change makes its signature invalid, but the manifest is kept, never removed.");
  if (!enough && !vis) sug.push("No evidence either way. If you know how it was made, choose a disclosure label below; a visual check can add a second opinion.");
  if (vis && onlyVision) sug.push("The visual check is an estimate only. Treat it as a prompt to look closer, not as proof.");
  if (!sug.length) sug.push(score < 35 ? "Nothing to fix." : "Review the evidence above before relying on this file's provenance.");

  return { score, band: [lo, hi], confidence, level, evidence: ev.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)), suggestions: sug, flags: f, flagged, vision: vis, c2pa: c || null, x: +xf.toFixed(2) };
}

/**
 * The corrective actions for a file. Never removes or weakens AI provenance:
 *  - ADDS the IPTC DigitalSourceType disclosure (and the AI system name) when the evidence supports it or the user asks for it
 *  - REMOVES camera fields only when the file is marked as fully AI-generated, because they contradict the marker
 *  - sets a modify date that precedes the capture date to the capture date
 * @param {object} a assess() result  @param {object} raw existing tags  @param {{disclosure?: "auto"|"ai"|"composite"|"none"}} opts
 */
export function planFix(a, raw, opts = {}) {
  const tags = {}, expect = {}, absent = [], actions = [];
  const mode = opts.disclosure || "auto", f = a.flags;
  const existing = Object.entries(raw).filter(([k]) => /DigitalSourceType$/.test(k)).map(([, v]) => str(v));
  const hasAi = existing.some((v) => /trainedAlgorithmicMedia/i.test(v)), hasComposite = existing.some((v) => /compositeWithTrainedAlgorithmicMedia/i.test(v));
  let target = mode === "ai" ? "trained" : mode === "composite" ? "composite" : mode === "none" ? null : f.fullyGenerated || (a.c2pa && a.c2pa.aiGenerated) ? "trained" : f.composite ? "composite" : null;
  // evidence that is only a visual estimate never writes a label by itself
  if (mode === "auto" && target && !a.evidence.some((e) => e.tone === "ai" && e.id !== "gen-size")) target = null;
  if (target === "trained" && !hasAi) {
    tags["XMP-iptcExt:DigitalSourceType"] = DST.trained; expect["XMP-iptcExt:DigitalSourceType"] = DST.trained;
    actions.push(hasComposite ? "Raise the disclosure from AI-edited to AI-generated (the existing label is kept in the manifest)" : "Add the disclosure label: AI-generated");
  } else if (target === "composite" && !hasAi && !hasComposite) {
    tags["XMP-iptcExt:DigitalSourceType"] = DST.composite; expect["XMP-iptcExt:DigitalSourceType"] = DST.composite; actions.push("Add the disclosure label: AI-edited");
  }
  if (target && f.generator && !raw["XMP-iptcExt:AISystemUsed"]) { tags["XMP-iptcExt:AISystemUsed"] = f.generator; expect["XMP-iptcExt:AISystemUsed"] = f.generator; actions.push(`Record the AI system: ${f.generator}`); }
  if (f.fullyGenerated && f.contradictoryCamera) {
    for (const k of f.camTags) { tags[k] = ""; absent.push(k); }
    if (Object.keys(raw).some((k) => MAKER_GROUPS.test(k.split(":")[0]) && !/^MakerNotes:?$/.test(k))) { tags["MakerNotes:All"] = ""; }
    if (f.camTags.length) actions.push(`Remove ${f.camTags.length} camera field${f.camTags.length === 1 ? "" : "s"} that contradict the AI marker`);
  }
  if (f.modifyBeforeCapture) {
    const dto = str(raw["ExifIFD:DateTimeOriginal"]); if (dto) { tags["EXIF:ModifyDate"] = dto; expect["IFD0:ModifyDate"] = dto; actions.push("Set the modify date to the capture date"); }
  }
  return { tags, expect, absent, actions, target };
}

/** The AI-provenance entries in a read (key -> value), so an export can prove none were lost. */
const PROV_KEY = /(DigitalSourceType|AISystemUsed|AIPromptInformation|AIPromptWriterName|AISystemVersionUsed|Software|CreatorTool|Parameters|Prompt|Workflow|Comment|Description|UserComment|History|Title|Source|Credit|Artist|Author|Producer|HostComputer)$/;
export function provenanceSnapshot(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (SKIP_GROUP.test(k.split(":")[0]) || typeof v !== "string" || !PROV_KEY.test(k)) continue;
    const isAi = /trainedAlgorithmicMedia|algorithmicMedia/i.test(v) || GENERATORS.some(([re]) => re.test(v)) || /Steps:\s*\d+.*Sampler:|"class_type"/s.test(v) || AI_FIELD_KEYS.test(k);
    if (isAi) out[k] = v;
  }
  return out;
}
/** Every AI-provenance entry that was in `before` must still be in `after` with the same value. */
export function provenanceLost(before, after) {
  const lost = [];
  for (const [k, v] of Object.entries(provenanceSnapshot(before))) {
    const nv = after && after[k];
    if (nv == null || String(nv).trim() !== String(v).trim()) {
      // a stronger DigitalSourceType replacing a weaker one is an upgrade, not a loss
      if (/DigitalSourceType$/.test(k) && /trainedAlgorithmicMedia/i.test(str(nv)) && !/compositeWith/.test(str(nv))) continue;
      lost.push(k);
    }
  }
  return lost;
}
