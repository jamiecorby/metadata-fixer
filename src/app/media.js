// Thumbnails and previews. Decoding is queued so large batches stay responsive.
const HEIC = /\.(heic|heif)$/i;
let active = 0; const waiting = [];
function slot(fn) { return new Promise((res, rej) => { const run = async () => { active++; try { res(await fn()); } catch (e) { rej(e); } finally { active--; const n = waiting.shift(); if (n) n(); } }; active < 2 ? run() : waiting.push(run); }); }

async function decodable(it) {
  if (HEIC.test(it.name)) {
    try { const bmp = await createImageBitmap(it.file); bmp.close(); return it.file; } catch (e) {}
    const heic2any = (await import("heic2any")).default;
    const out = await heic2any({ blob: it.file, toType: "image/jpeg", quality: 0.9 });
    return Array.isArray(out) ? out[0] : out;
  }
  return it.file;
}
async function videoFrame(file) {
  const u = URL.createObjectURL(file), v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "metadata"; v.src = u;
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("This browser can't decode this video")); setTimeout(() => rej(new Error("timeout")), 10000); });
    v.currentTime = Math.min(1, (v.duration || 2) / 3);
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
    if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; setTimeout(r, 3000); });
    const c = document.createElement("canvas"), s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
    c.width = c.height = 0;
    return out;
  } finally { v.removeAttribute("src"); try { v.load(); } catch (e) {} URL.revokeObjectURL(u); }
}
async function scaled(src, max, q = 0.82) {
  const bmp = await createImageBitmap(src);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return await new Promise((r) => c.toBlob(r, "image/jpeg", q));
}
/** Builds it.thumb (small) and it.prevUrl (inspector preview). */
export function makeThumb(it) {
  if (it.thumbP) return it.thumbP;
  it.thumbP = slot(async () => {
    try {
      const src = it.kind === "video" ? await videoFrame(it.file) : await decodable(it);
      it.prevSrc = src;
      it.thumb = URL.createObjectURL(await scaled(src, 360));
      it.prevUrl = it.kind === "video" || HEIC.test(it.name) || /\.(tiff?|dng)$/i.test(it.name) ? URL.createObjectURL(await scaled(src, 1600, 0.9)) : URL.createObjectURL(it.file);
    } catch (e) { it.prevErr = e.message || "No preview"; }
  });
  return it.thumbP;
}
/** A small, metadata-free JPEG for the AI (re-encoded through a canvas, so no EXIF survives). */
export async function aiImage(it) {
  await makeThumb(it);
  if (!it.prevSrc) throw Object.assign(new Error("No preview could be made for this file, so there is nothing to show the AI. Enter the values, or use Trip details and Fill blanks."), { code: "no_preview" });
  return scaled(it.prevSrc, 1024, 0.85);
}
