// File sanitisation. Format-aware, lossless container rewrites: image data is copied byte for byte, everything else that is not
// needed to display the file is dropped. Runs entirely on the user's device. No dependency on the recovery code (nothing here can
// restore a date, place, name or sidecar value). Pure functions over Blob/Uint8Array so Node can test them.
//
// What it is not: a pixel re-encoder (see bakeOrientation in app/sanitise.js for the one case that needs it) and not a video
// transcoder. Anything it cannot inspect or remove is reported as a limitation, never silently ignored.

export class Unsupported extends Error { constructor(m) { super(m); this.code = "unsupported"; } }
export class Damaged extends Error { constructor(m) { super(m); this.code = "damaged"; } }
export class NeedsDecision extends Error { constructor(m, key) { super(m); this.code = "decision"; this.key = key; } }
/** The file carries something (rotation, a non-sRGB colour profile) that can only be removed by redrawing the pixels. */
export class NeedsReencode extends Error { constructor(m, why) { super(m); this.code = "reencode"; this.why = why; } }
export const LIMITS = { image: 250 * 1024 * 1024, video: 1536 * 1024 * 1024, pixels: 500e6, moov: 64 * 1024 * 1024 };

export const asc = (b, s, e) => { let t = ""; for (let i = s; i < e && i < b.length; i++) t += String.fromCharCode(b[i]); return t; };
export const u16 = (b, o) => (b[o] << 8) | b[o + 1];
export const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const w32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const w16 = (b, o, v) => { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; };
const cstr = (b, o, e) => { let i = o; while (i < e && b[i] !== 0) i++; return [asc(b, o, i), i + 1]; };
const cat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const bytes = (...a) => Uint8Array.from(a);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

let CRC = null;
export function crc32(b, s, e) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = s; i < e; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}

export const RAW_EXT = /\.(dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|orf|rw2|raf|pef|srw|x3f|3fr|erf|mef|mos|kdc|dcr|raw)$/i;

/** An ICC profile is safe to drop only if it is sRGB, the colour space every viewer assumes when there is no profile. */
export const isSrgbProfile = (p) => { const t = asc(p, 0, Math.min(p.length, 600)); return /sRGB/i.test(t) && !/Display P3|Adobe RGB|ProPhoto|Rec\.? ?2020/i.test(t); };
/** @returns {"jpeg"|"png"|"webp"|"tiff"|"bigtiff"|"heif"|"mp4"|"gif"|null} */
export function detect(h) {
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "jpeg";
  if (h[0] === 0x89 && asc(h, 1, 4) === "PNG" && h[4] === 0x0d) return "png";
  if (asc(h, 0, 4) === "RIFF" && asc(h, 8, 12) === "WEBP") return "webp";
  if ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2a && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 0x2a)) return "tiff";
  if ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2b && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 0x2b)) return "bigtiff";
  if (asc(h, 0, 3) === "GIF") return "gif";
  const t = asc(h, 4, 8);
  if (t === "ftyp") return /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|mif2|avif|avis|heif|miaf)/.test(asc(h, 8, 12)) ? "heif" : "mp4";
  if (["moov", "mdat", "wide", "free", "skip"].includes(t)) return "mp4";
  return null;
}

const newRep = (format, method) => ({ format, method, removed: [], retained: [], limits: [], notes: [] });
function rm(rep, what, count = 1, size = 0) { const e = rep.removed.find((x) => x.what === what); if (e) { e.count += count; e.bytes += size; } else rep.removed.push({ what, count, bytes: size }); }
const keep = (rep, what) => { if (!rep.retained.includes(what)) rep.retained.push(what); };
const lim = (rep, what) => { if (!rep.limits.includes(what)) rep.limits.push(what); };
function checkDims(w, h) {
  if (!(w > 0 && h > 0)) throw new Damaged("The image has no valid dimensions.");
  if (w * h > LIMITS.pixels) throw new Unsupported(`The image is ${w} x ${h} pixels, which is over the ${LIMITS.pixels / 1e6} megapixel safety limit.`);
}

/* ---------------------------------------------------------------- JPEG */
const isSOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
export function jpegWalk(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Damaged("Not a JPEG.");
  let p = 2; const segs = []; let eoi = -1;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new Damaged("The JPEG is damaged (bad marker).");
    while (b[p + 1] === 0xff) p++;
    const m = b[p + 1];
    if (m === 0xd9) { eoi = p + 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { segs.push({ m, s: p, e: p + 2, ps: p + 2 }); p += 2; continue; }
    if (p + 4 > b.length) throw new Damaged("The JPEG is cut short.");
    const len = u16(b, p + 2);
    if (len < 2 || p + 2 + len > b.length) throw new Damaged("The JPEG is cut short.");
    const seg = { m, s: p, e: p + 2 + len, ps: p + 4 };
    if (m === 0xda) {
      let q = seg.e;
      while (q < b.length - 1) { if (b[q] === 0xff) { const n = b[q + 1]; if (n === 0 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; } if (n === 0xff) { q++; continue; } break; } q++; }
      if (q >= b.length - 1) throw new Damaged("The JPEG is cut short (no end marker).");
      seg.e = q; segs.push(seg); p = q; continue;
    }
    segs.push(seg); p = seg.e;
  }
  if (eoi < 0) throw new Damaged("The JPEG is cut short (no end marker).");
  return { segs, eoi };
}
/** Reads what a TIFF/EXIF block holds that matters for reporting. b[s..e) is the TIFF header onward. */
export function exifInfo(b, s, e) {
  const o = { orient: 1, gps: false, thumb: false, maker: false, serial: false, fields: 0 };
  try {
    const le = b[s] === 0x49;
    const r16 = (p) => (le ? b[s + p] | (b[s + p + 1] << 8) : (b[s + p] << 8) | b[s + p + 1]);
    const r32 = (p) => (le ? (b[s + p] | (b[s + p + 1] << 8) | (b[s + p + 2] << 16) | (b[s + p + 3] << 24)) >>> 0 : ((b[s + p] << 24) | (b[s + p + 1] << 16) | (b[s + p + 2] << 8) | b[s + p + 3]) >>> 0);
    if (r16(2) !== 42) return o;
    const ifd = (off, depth) => {
      if (off + 2 > e - s) return 0;
      const n = Math.min(r16(off), 300); o.fields += n;
      for (let i = 0; i < n; i++) {
        const p = off + 2 + i * 12; if (p + 12 > e - s) break;
        const tag = r16(p);
        if (tag === 0x0112 && depth === 0) o.orient = r16(p + 8) >= 1 && r16(p + 8) <= 8 ? r16(p + 8) : 1;
        else if (tag === 0x8825) o.gps = true;
        else if (tag === 0x927c) o.maker = true;
        else if (tag === 0xa431 || tag === 0xa435 || tag === 0xc62f) o.serial = true;
        else if (tag === 0x8769 && depth === 0) ifd(r32(p + 8), 1);
      }
      return r32(off + 2 + n * 12);
    };
    const next = ifd(r32(4), 0);
    if (next) o.thumb = true;
  } catch (er) { /* a damaged EXIF block is dropped anyway */ }
  return o;
}
function segId(b, s) { return asc(b, s.ps, Math.min(s.e, s.ps + 48)); }
function labelApp(m, id, info) {
  if (m === 0xfe) return "JPEG comment";
  if (m === 0xe1 && id.startsWith("Exif\0\0")) return "EXIF" + (info ? [info.gps && "GPS", info.thumb && "embedded thumbnail", info.maker && "maker note", info.serial && "serial number"].filter(Boolean).map((x, i) => (i ? ", " : " (") + x).join("") + (info.gps || info.thumb || info.maker || info.serial ? ")" : "") : "");
  if (m === 0xe1 && id.startsWith("http://ns.adobe.com/xap/1.0/")) return "XMP";
  if (m === 0xe1 && id.startsWith("http://ns.adobe.com/xmp/extension/")) return "Extended XMP";
  if (m === 0xe1) return "APP1 data (" + id.replace(/[^\x20-\x7e]/g, "").slice(0, 20) + ")";
  if (m === 0xed && id.startsWith("Photoshop")) return "Photoshop / IPTC";
  if (m === 0xeb) return "JUMBF / content-credentials manifest";
  if (m === 0xe2 && id.startsWith("MPF")) return "Multi-picture index";
  if (m === 0xe2 && id.startsWith("FPXR")) return "FlashPix data";
  if (m === 0xe2) return "APP2 data (" + id.replace(/[^\x20-\x7e]/g, "").slice(0, 16) + ")";
  if (m === 0xe0 && id.startsWith("JFXX")) return "JFIF thumbnail extension";
  if (m === 0xee) return "Adobe colour flag";
  if (m === 0xec) return "Ducky / picture info";
  return "APP" + (m - 0xe0) + " segment" + (id ? " (" + id.replace(/[^\x20-\x7e]/g, "").slice(0, 14) + ")" : "");
}
function jpegApp1Orientation(orient) {
  const b = new Uint8Array(36); b.set([0xff, 0xe1, 0, 34]); b.set(ascii("Exif\0\0"), 4); b.set(ascii("MM"), 10); b[12] = 0; b[13] = 42; w32(b, 14, 8);
  w16(b, 18, 1); w16(b, 20, 0x0112); w16(b, 22, 3); w32(b, 24, 1); w16(b, 28, orient); w32(b, 32, 0); return b;
}
export function classifyTrailing(b, from) {
  const n = b.length - from; if (n <= 0) return null;
  if (b[from] === 0xff && b[from + 1] === 0xd8) return { kind: "image", label: "an embedded JPEG (multi-picture, gain map or preview)", size: n };
  for (let i = from; i < Math.min(b.length - 8, from + 4096); i++) if (b[i + 4] === 0x66 && b[i + 5] === 0x74 && b[i + 6] === 0x79 && b[i + 7] === 0x70) return { kind: "video", label: "an embedded video (motion photo)", size: n };
  let zero = true; for (let i = from; i < Math.min(b.length, from + 4096); i++) if (b[i] !== 0 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x20) { zero = false; break; }
  return { kind: zero && n <= 4096 ? "padding" : "data", label: zero && n <= 4096 ? "padding" : "appended data", size: n };
}
function sanJpeg(b, o) {
  const rep = newRep("JPEG", o.reencoded ? "Pixels redrawn, then every segment removed" : "Lossless segment rewrite: image data copied unchanged");
  const { segs, eoi } = jpegWalk(b);
  let comps = 0, wd = 0, ht = 0;
  for (const s of segs) if (isSOF(s.m)) { ht = u16(b, s.ps + 1); wd = u16(b, s.ps + 3); comps = b[s.ps + 5]; break; }
  checkDims(wd, ht);
  const tr = classifyTrailing(b, eoi);
  if (tr && (tr.kind === "image" || tr.kind === "video") && !o.dropAux) throw new NeedsDecision(`This JPEG contains ${tr.label} of ${Math.round(tr.size / 1024)} KB. Sanitising removes it.`, "aux");
  let orient = 1, iccBytes = null; const body = [];
  for (const s of segs) {
    const m = s.m;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      const id = segId(b, s), size = s.e - s.s;
      if (m === 0xe1 && id.startsWith("Exif\0\0")) { const info = exifInfo(b, s.ps + 6, s.e); if (info.orient > 1) orient = info.orient; rm(rep, labelApp(m, id, info), 1, size); continue; }
      if (m === 0xe2 && id.startsWith("ICC_PROFILE\0")) { iccBytes = iccBytes ? cat([iccBytes, b.subarray(s.ps + 14, s.e)]) : b.slice(s.ps + 14, s.e); rm(rep, "ICC colour profile", 1, size); continue; }
      if (m === 0xee && id.startsWith("Adobe") && comps === 4) { body.push(b.subarray(s.s, s.e)); lim(rep, "A four-channel (CMYK) JPEG keeps its 12-byte decoder flag, because without it the colours are wrong. It holds no descriptive data."); continue; }
      if (m === 0xe0 && id.startsWith("JFIF\0")) { rm(rep, "JFIF header" + (b[s.ps + 12] || b[s.ps + 13] ? " with thumbnail" : ""), 1, size); continue; }
      rm(rep, labelApp(m, id, null), 1, size); continue;
    }
    body.push(b.subarray(s.s, s.e));
  }
  if (!o.reencoded) {
    if (orient > 1) throw new NeedsReencode("This photo is stored sideways and relies on a rotation tag. Removing the tag without redrawing the pixels would turn it on its side.", "rotation");
    if (iccBytes && !isSrgbProfile(iccBytes)) throw new NeedsReencode("This photo uses a wide-gamut colour profile. Removing it without converting the pixels would change its colours.", "colour");
  }
  if (tr) rm(rep, tr.kind === "padding" ? "Padding after the end of the image" : tr.kind === "data" ? "Data appended after the end of the image" : "Embedded " + (tr.kind === "video" ? "motion-photo video" : "second image (gain map, preview or multi-picture)"), 1, tr.size);
  const out = cat([bytes(0xff, 0xd8), ...body, bytes(0xff, 0xd9)]);
  rep.dims = [wd, ht]; rep.orientation = 1;
  return { out, rep };
}

/* ---------------------------------------------------------------- PNG */
export const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "acTL", "fcTL", "fdAT"]);
export function pngWalk(b) {
  if (!(b[0] === 0x89 && asc(b, 1, 4) === "PNG")) throw new Damaged("Not a PNG.");
  let p = 8; const chunks = [];
  while (p + 12 <= b.length) {
    const len = u32(b, p), type = asc(b, p + 4, p + 8);
    if (len > 0x7fffffff || p + 12 + len > b.length) throw new Damaged("The PNG is cut short.");
    if (u32(b, p + 8 + len) !== crc32(b, p + 4, p + 8 + len)) throw new Damaged(`The PNG is damaged (bad checksum in ${type}).`);
    chunks.push({ type, s: p, e: p + 12 + len, ps: p + 8, len }); p += 12 + len;
    if (type === "IEND") break;
  }
  if (!chunks.length || chunks[0].type !== "IHDR") throw new Damaged("The PNG has no header.");
  if (chunks[chunks.length - 1].type !== "IEND") throw new Damaged("The PNG is cut short (no end chunk).");
  return { chunks, end: p };
}
function labelPng(b, c) {
  if (c.type === "eXIf") return "EXIF";
  if (c.type === "tIME") return "Modification time";
  if (c.type === "caBX") return "JUMBF / content-credentials manifest";
  if (c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt") { const k = asc(b, c.ps, Math.min(c.ps + 60, c.ps + c.len)).split("\0")[0]; return /xmp/i.test(k) ? "XMP" : "PNG text chunk"; }
  if (c.type === "iCCP") return "ICC colour profile";
  if (["gAMA", "cHRM", "sRGB", "sBIT", "pHYs", "cICP", "mDCV", "cLLI", "bKGD", "hIST", "sPLT"].includes(c.type)) return "PNG display hint (" + c.type + ")";
  return "PNG chunk " + c.type;
}
function sanPng(b, o) {
  const rep = newRep("PNG", o.reencoded ? "Pixels redrawn, then every chunk removed" : "Lossless chunk rewrite: image data copied unchanged");
  const { chunks, end } = pngWalk(b);
  if (!o.reencoded) {
    const animated = chunks.some((c) => c.type === "acTL"), bad = (m, w) => { throw animated ? new Unsupported(m + " Animated PNG can't be redrawn in the browser, so it was not changed.") : new NeedsReencode(m, w); };
    if (chunks.some((c) => c.type === "cICP" || c.type === "mDCV")) bad("This PNG carries HDR colour signalling that can't be removed without converting its pixels.", "colour");
    const ic = chunks.find((c) => c.type === "iCCP");
    if (ic) { const z = b.subarray(ic.ps, ic.ps + ic.len), nul = z.indexOf(0); if (!isSrgbProfile(z.subarray(0, nul + 1))) bad("This PNG uses a colour profile that isn't sRGB. Removing it without converting the pixels would change its colours.", "colour"); }
  }
  checkDims(u32(b, chunks[0].ps), u32(b, chunks[0].ps + 4));
  const parts = [b.subarray(0, 8)];
  for (const c of chunks) { if (PNG_KEEP.has(c.type)) parts.push(b.subarray(c.s, c.e)); else rm(rep, labelPng(b, c), 1, c.e - c.s); }
  if (chunks.some((c) => c.type === "acTL")) keep(rep, "Animation frames (APNG)");
  if (end < b.length) rm(rep, "Data appended after the end of the image", 1, b.length - end);
  rep.dims = [u32(b, chunks[0].ps), u32(b, chunks[0].ps + 4)];
  return { out: cat(parts), rep };
}

/* ---------------------------------------------------------------- WebP */
export const WEBP_KEEP = new Set(["VP8X", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);
export function riffWalk(b) {
  if (asc(b, 0, 4) !== "RIFF" || asc(b, 8, 12) !== "WEBP") throw new Damaged("Not a WebP.");
  const total = u32le(b, 4) + 8; if (total > b.length) throw new Damaged("The WebP is cut short.");
  let p = 12; const ch = [];
  while (p + 8 <= total) { const len = u32le(b, p + 4); if (p + 8 + len > total) throw new Damaged("The WebP is cut short."); ch.push({ type: asc(b, p, p + 4), s: p, e: p + 8 + len + (len & 1), ps: p + 8, len }); p += 8 + len + (len & 1); }
  return { ch, total };
}
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function w32le(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
function sanWebp(b, o) {
  const rep = newRep("WebP", o.reencoded ? "Pixels redrawn, then every chunk removed" : "Lossless chunk rewrite: image data copied unchanged");
  const { ch, total } = riffWalk(b);
  const parts = [];
  const ic = ch.find((c) => c.type === "ICCP");
  if (ic && !o.reencoded && !isSrgbProfile(b.subarray(ic.ps, ic.ps + ic.len))) throw ch.some((c) => c.type === "ANIM") ? new Unsupported("This animated WebP uses a non-sRGB colour profile that can't be removed without changing its colours, so it was not changed.") : new NeedsReencode("This WebP uses a colour profile that isn't sRGB. Removing it without converting the pixels would change its colours.", "colour");
  for (const c of ch) {
    if (WEBP_KEEP.has(c.type)) parts.push(b.slice(c.s, Math.min(c.e, total)));
    else rm(rep, c.type === "ICCP" ? "ICC colour profile" : c.type === "EXIF" ? "EXIF" : c.type === "XMP " ? "XMP" : c.type === "C2PA" ? "JUMBF / content-credentials manifest" : "WebP chunk " + c.type.trim(), 1, c.e - c.s);
  }
  if (!parts.length) throw new Damaged("The WebP has no image data.");
  const vp = parts.find((p) => asc(p, 0, 4) === "VP8X");
  if (vp) { vp[8] &= ~(0x08 | 0x04 | 0x20); checkDims((vp[12] | (vp[13] << 8) | (vp[14] << 16)) + 1, (vp[15] | (vp[16] << 8) | (vp[17] << 16)) + 1); rep.dims = [(vp[12] | (vp[13] << 8) | (vp[14] << 16)) + 1, (vp[15] | (vp[16] << 8) | (vp[17] << 16)) + 1]; }
  if (ch.some((c) => c.type === "ANIM")) keep(rep, "Animation frames");
  if (b.length > total) rm(rep, "Data appended after the end of the image", 1, b.length - total);
  const body = cat(parts), out = new Uint8Array(12 + body.length);
  out.set(ascii("RIFF")); w32le(out, 4, 4 + body.length); out.set(ascii("WEBP"), 8); out.set(body, 12);
  return { out, rep };
}

/* ---------------------------------------------------------------- TIFF (classic, not RAW) */
const TIFF_TYPE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
export const TIFF_KEEP = new Set([254, 256, 257, 258, 259, 262, 263, 266, 277, 278, 279, 280, 281, 284, 292, 293, 317, 320, 322, 323, 324, 325, 338, 339, 347, 529, 530, 531, 532]);
const TIFF_NAME = { 270: "Image description", 271: "Camera make", 272: "Camera model", 305: "Software", 306: "Date and time", 315: "Artist", 33432: "Copyright", 34665: "EXIF block", 34853: "GPS block", 700: "XMP", 33723: "IPTC", 34377: "Photoshop data", 330: "Sub-images / thumbnails", 37724: "Photoshop layers", 33434: "Exposure data", 269: "Document name", 285: "Page name", 316: "Host computer", 339: "x" };
function tiffReader(b) {
  const le = b[0] === 0x49;
  return { le, r16: (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]), r32: (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0),
    p16: (a, p, v) => { if (le) { a[p] = v & 255; a[p + 1] = v >>> 8; } else { a[p] = v >>> 8; a[p + 1] = v & 255; } },
    p32: (a, p, v) => { if (le) { a[p] = v & 255; a[p + 1] = (v >>> 8) & 255; a[p + 2] = (v >>> 16) & 255; a[p + 3] = v >>> 24; } else { a[p] = v >>> 24; a[p + 1] = (v >>> 16) & 255; a[p + 2] = (v >>> 8) & 255; a[p + 3] = v & 255; } } };
}
export function tiffIfds(b) {
  const T = tiffReader(b), ifds = []; const seen = new Set(); let off = T.r32(4);
  while (off && ifds.length < 256) {
    if (seen.has(off) || off + 2 > b.length) throw new Damaged("The TIFF is damaged (bad directory).");
    seen.add(off);
    const n = T.r16(off); if (off + 2 + n * 12 + 4 > b.length) throw new Damaged("The TIFF is cut short.");
    const ents = [];
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12, type = T.r16(p + 2), count = T.r32(p + 4), sz = (TIFF_TYPE[type] || 1) * count;
      let vs = p + 8; if (sz > 4) { vs = T.r32(p + 8); if (vs + sz > b.length || sz > b.length) throw new Damaged("The TIFF is damaged (value out of range)."); }
      ents.push({ tag: T.r16(p), type, count, sz, vs, p });
    }
    ifds.push({ off, ents }); off = T.r32(off + 2 + n * 12);
  }
  return { T, ifds };
}
function numList(T, b, e) { const out = []; const sz = TIFF_TYPE[e.type] || 4; for (let i = 0; i < e.count; i++) out.push(sz === 2 ? T.r16(e.vs + i * 2) : T.r32(e.vs + i * 4)); return out; }
function sanTiff(b, o, name) {
  const rep = newRep("TIFF", "Lossless directory rewrite: image strips copied unchanged");
  const { T, ifds } = tiffIfds(b);
  if (!ifds.length) throw new Damaged("The TIFF has no image.");
  const plans = []; let dims = null;
  for (const ifd of ifds) {
    const find = (t) => ifd.ents.find((x) => x.tag === t);
    if (find(50706) || find(50740)) throw new Unsupported("This is a DNG/RAW file. RAW files can't be reliably sanitised without damaging their rendering, so it was not changed.");
    const comp = find(259); if (comp && T.r16(comp.vs) === 6) throw new Unsupported("This TIFF uses obsolete JPEG-in-TIFF compression, which can't be rewritten safely.");
    const kept = [], strips = [];
    const so = find(273) || find(324), sc = find(279) || find(325);
    if (!so || !sc) throw new Unsupported("This TIFF has no readable image strips or tiles.");
    const offs = numList(T, b, so), cnts = numList(T, b, sc);
    if (offs.length !== cnts.length) throw new Damaged("The TIFF is damaged (strip table mismatch).");
    for (let i = 0; i < offs.length; i++) { if (offs[i] + cnts[i] > b.length) throw new Damaged("The TIFF is cut short (missing image data)."); strips.push(b.subarray(offs[i], offs[i] + cnts[i])); }
    for (const e of ifd.ents) {
      if (e.tag === 273 || e.tag === 324) { kept.push({ ...e, strip: true }); continue; }
      if (e.tag === 274) { const v = T.r16(e.vs); if (v > 1 && v <= 8) throw new Unsupported("This TIFF is stored sideways and relies on a rotation tag. TIFF can't be redrawn in the browser, so it was not changed."); rm(rep, "Orientation tag", 1, 12); continue; }
      if (e.tag === 34675) { if (!isSrgbProfile(b.subarray(e.vs, e.vs + Math.min(e.sz, 600)))) throw new Unsupported("This TIFF uses a non-sRGB colour profile. Removing it would change its colours, and TIFF can't be redrawn in the browser, so it was not changed."); rm(rep, "ICC colour profile", 1, e.sz); continue; }
      if (TIFF_KEEP.has(e.tag)) { kept.push(e); continue; }
      const label = TIFF_NAME[e.tag] || (e.tag >= 32768 ? "Private tag " + e.tag : "TIFF tag " + e.tag);
      rm(rep, label, 1, 12 + (e.sz > 4 ? e.sz : 0));
    }
    const w = find(256), h = find(257); if (!dims && w && h) { dims = [w.type === 3 ? T.r16(w.vs) : T.r32(w.vs), h.type === 3 ? T.r16(h.vs) : T.r32(h.vs)]; checkDims(dims[0], dims[1]); }
    plans.push({ kept, strips });
  }
  // layout: header | per IFD: table, out-of-line values, strips
  const lay = []; let pos = 8;
  for (const pl of plans) {
    const n = pl.kept.length, L = { off: pos }; pos += 2 + n * 12 + 4;
    L.ext = pl.kept.map((e) => { const sz = e.strip ? 4 * e.count : e.sz; if (sz <= 4) return null; const at = pos; pos += sz + (sz & 1); return at; });
    L.data = pl.strips.map((s) => { const at = pos; pos += s.length + (s.length & 1); return at; });
    lay.push(L);
  }
  const out = new Uint8Array(pos); out.set(b.subarray(0, 4)); T.p32(out, 4, 8);
  plans.forEach((pl, i) => {
    const L = lay[i], n = pl.kept.length; T.p16(out, L.off, n);
    pl.kept.forEach((e, k) => {
      const p = L.off + 2 + k * 12; T.p16(out, p, e.tag);
      if (e.strip) { T.p16(out, p + 2, 4); T.p32(out, p + 4, e.count); const vals = pl.strips.map((_, j) => L.data[j]); if (e.count * 4 <= 4) T.p32(out, p + 8, vals[0] || 0); else { T.p32(out, p + 8, L.ext[k]); vals.forEach((v, j) => T.p32(out, L.ext[k] + j * 4, v)); } return; }
      T.p16(out, p + 2, e.type); T.p32(out, p + 4, e.count);
      if (e.sz <= 4) out.set(b.subarray(e.vs, e.vs + e.sz), p + 8); else { T.p32(out, p + 8, L.ext[k]); out.set(b.subarray(e.vs, e.vs + e.sz), L.ext[k]); }
    });
    T.p32(out, L.off + 2 + n * 12, i + 1 < plans.length ? lay[i + 1].off : 0);
    pl.strips.forEach((s, j) => out.set(s, L.data[j]));
  });
  rep.dims = dims; if (ifds.length > 1) keep(rep, `${ifds.length} pages`);
  return { out, rep };
}

/* ---------------------------------------------------------------- ISO base media: shared box helpers */
export function boxes(b, s, e) {
  const list = []; let p = s;
  while (p + 8 <= e) {
    let size = u32(b, p), hdr = 8; const type = asc(b, p + 4, p + 8);
    if (size === 1) { if (p + 16 > e) break; size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = e - p;
    if (size < hdr || p + size > e) throw new Damaged(`The file is damaged (bad '${type}' box).`);
    list.push({ type, s: p, e: p + size, ps: p + hdr, hdr }); p += size;
  }
  return { list, end: p };
}
function toFree(b, bx) { b[bx.s + 4] = 0x66; b[bx.s + 5] = 0x72; b[bx.s + 6] = 0x65; b[bx.s + 7] = 0x65; b.fill(0, bx.ps, bx.e); }
function mkbox(type, ...parts) { const body = cat(parts), o = new Uint8Array(8 + body.length); w32(o, 0, o.length); o.set(ascii(type), 4); o.set(body, 8); return o; }

/* ---- moov cleaner (MP4/MOV, and image sequences in HEIF). Works in place on b; box sizes never change, so no offset moves. */
const DROP_HANDLERS = new Set(["meta", "mebx", "tmcd", "camm", "gps ", "gpmd", "psmd"]);
const VISUAL = new Set(["avc1", "avc3", "hvc1", "hev1", "mp4v", "av01", "jpeg", "apch", "apcn", "apcs", "apco", "ap4h", "ap4x", "vp09", "dvh1", "dvhe", "s263", "vvc1"]);
function zeroTimes(b, bx) { const v = b[bx.ps]; b.fill(0, bx.ps + 4, bx.ps + (v === 1 ? 20 : 12)); }
function trackRanges(b, trak, rep) {
  const find = (p, t) => boxes(b, p.ps, p.e).list.find((x) => x.type === t);
  const mdia = find(trak, "mdia"), minf = mdia && find(mdia, "minf"), stbl = minf && find(minf, "stbl"); const out = [];
  if (!stbl) return out;
  const stsz = find(stbl, "stsz"), stsc = find(stbl, "stsc"), stco = find(stbl, "stco") || find(stbl, "co64");
  if (!stsz || !stsc || !stco) { lim(rep, "A removed metadata track's sample data could not be located, so its bytes may remain unreferenced in the media data."); return out; }
  const cnt = u32(b, stsz.ps + 8), fixed = u32(b, stsz.ps + 4), nChunks = u32(b, stco.ps + 4), big = stco.type === "co64";
  const ents = []; for (let i = 0, n = u32(b, stsc.ps + 4); i < n && i < 1e6; i++) ents.push([u32(b, stsc.ps + 8 + i * 12), u32(b, stsc.ps + 12 + i * 12)]);
  let sample = 0, ei = 0;
  for (let c = 1; c <= nChunks && c < 5e6; c++) {
    while (ei + 1 < ents.length && ents[ei + 1][0] <= c) ei++;
    const per = ents[ei] ? ents[ei][1] : 0; let size = 0;
    for (let k = 0; k < per && sample < cnt; k++, sample++) size += fixed || u32(b, stsz.ps + 12 + sample * 4);
    const off = big ? u64(b, stco.ps + 8 + (c - 1) * 8) : u32(b, stco.ps + 8 + (c - 1) * 4);
    if (size) out.push([off, off + size]);
  }
  return out;
}
/** Cleans the moov box at b[s..e). Returns absolute byte ranges (file offsets of the media data) to zero. */
export function cleanMoov(b, moov, rep) {
  const zero = []; const killed = new Set();
  const kids = boxes(b, moov.ps, moov.e).list;
  if (kids.some((k) => k.type === "cmov")) throw new Unsupported("This movie uses a compressed header, which can't be rewritten safely.");
  for (const k of kids) {
    if (k.type === "mvhd") { zeroTimes(b, k); keep(rep, "Movie header with times cleared"); }
    else if (["udta", "meta", "uuid", "XMP_", "xml ", "iods"].includes(k.type) && k.type !== "iods") { rm(rep, k.type === "udta" ? "User data (location, device, software, title)" : k.type === "meta" ? "Metadata container (keys / ilst)" : k.type === "uuid" ? "Extension data (uuid box)" : "XMP", 1, k.e - k.s); toFree(b, k); }
    else if (k.type === "trak") {
      const tk = boxes(b, k.ps, k.e).list, mdia = tk.find((x) => x.type === "mdia"), tkhd = tk.find((x) => x.type === "tkhd");
      const hdlr = mdia && boxes(b, mdia.ps, mdia.e).list.find((x) => x.type === "hdlr"); const ht = hdlr ? asc(b, hdlr.ps + 8, hdlr.ps + 12) : "";
      if (DROP_HANDLERS.has(ht)) {
        const id = tkhd ? (b[tkhd.ps] === 1 ? u32(b, tkhd.ps + 20) : u32(b, tkhd.ps + 12)) : 0; killed.add(id);
        zero.push(...trackRanges(b, k, rep)); rm(rep, ht === "tmcd" ? "Timecode track" : "Timed-metadata track (" + ht.trim() + ")", 1, k.e - k.s); toFree(b, k); continue;
      }
      if (tkhd) zeroTimes(b, tkhd);
      if (mdia) {
        const mk = boxes(b, mdia.ps, mdia.e).list; const mdhd = mk.find((x) => x.type === "mdhd"); if (mdhd) zeroTimes(b, mdhd);
        if (hdlr && hdlr.e - hdlr.ps > 24) b.fill(0, hdlr.ps + 24, hdlr.e);
        if (ht === "vide") {
          const minf = mk.find((x) => x.type === "minf"), stbl = minf && boxes(b, minf.ps, minf.e).list.find((x) => x.type === "stbl"), stsd = stbl && boxes(b, stbl.ps, stbl.e).list.find((x) => x.type === "stsd");
          if (stsd) { const n = u32(b, stsd.ps + 4); let p = stsd.ps + 8; for (let i = 0; i < n && p + 86 <= stsd.e; i++) { const sz = u32(b, p); if (VISUAL.has(asc(b, p + 4, p + 8))) b.fill(0, p + 8 + 42, p + 8 + 74); if (sz < 8) break; p += sz; } }
        }
      }
      for (const x of tk) if (["udta", "meta", "uuid"].includes(x.type)) { rm(rep, "Track-level " + (x.type === "udta" ? "user data" : x.type === "meta" ? "metadata" : "extension data"), 1, x.e - x.s); toFree(b, x); }
    }
  }
  // references from surviving tracks to removed ones
  for (const k of kids) if (k.type === "trak") for (const x of boxes(b, k.ps, k.e).list) if (x.type === "tref") {
    for (const r of boxes(b, x.ps, x.e).list) for (let p = r.ps; p + 4 <= r.e; p += 4) if (killed.has(u32(b, p))) { toFree(b, x); rm(rep, "Track reference", 1, x.e - x.s); break; }
  }
  if (kids.some((k) => k.type === "mvex")) lim(rep, "Fragmented movie: individual fragments are not inspected for track-level metadata.");
  return zero;
}
function mergeRanges(r) { r.sort((a, c) => a[0] - c[0]); const o = []; for (const x of r) { const l = o[o.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else o.push([x[0], x[1]]); } return o; }

/* ---------------------------------------------------------------- HEIF / HEIC / AVIF */
const IMAGE_ITEMS = new Set(["hvc1", "hev1", "av01", "avc1", "vvc1", "jpeg", "j2k1", "grid", "iovl", "iden", "tmap", "unci", "mski"]);
function parseIinf(b, iinf) {
  const v = b[iinf.ps], cp = iinf.ps + 4, kp = cp + (v === 0 ? 2 : 4), items = [];
  for (const x of boxes(b, kp, iinf.e).list) {
    if (x.type !== "infe") continue;
    const ver = b[x.ps]; let id, type = "", ctype = "";
    if (ver >= 2) { let p = x.ps + 4; id = ver === 2 ? u16(b, p) : u32(b, p); p += ver === 2 ? 2 : 4; p += 2; type = asc(b, p, p + 4); p += 4; const [, q] = cstr(b, p, x.e); if (type === "mime") ctype = cstr(b, q, x.e)[0]; }
    else { id = u16(b, x.ps + 4); type = "legacy"; }
    items.push({ id, type, ctype, box: x });
  }
  return { v, items, kp };
}
function parseIloc(b, iloc) {
  const v = b[iloc.ps]; let p = iloc.ps + 4; const os = b[p] >> 4, ls = b[p] & 15, bs = b[p + 1] >> 4, is = v === 1 || v === 2 ? b[p + 1] & 15 : 0; p += 2;
  const n = v < 2 ? u16(b, p) : u32(b, p); p += v < 2 ? 2 : 4; const rd = (o, s) => (s === 0 ? 0 : s === 4 ? u32(b, o) : s === 8 ? u64(b, o) : (() => { throw new Unsupported("Unusual item-location sizes."); })());
  const items = [];
  for (let i = 0; i < n; i++) {
    const it = { ext: [], cm: 0 };
    it.id = v < 2 ? u16(b, p) : u32(b, p); p += v < 2 ? 2 : 4;
    if (v === 1 || v === 2) { it.cm = u16(b, p) & 15; p += 2; }
    it.dref = u16(b, p); p += 2; it.base = rd(p, bs); p += bs; const ec = u16(b, p); p += 2;
    for (let k = 0; k < ec; k++) { if (is) p += is; const eo = rd(p, os); p += os; const el = rd(p, ls); p += ls; it.ext.push([eo, el]); }
    items.push(it);
  }
  return { v, os, ls, bs, is, items, bytes: (kept) => {
    const parts = []; const h = new Uint8Array(4 + 2 + (v < 2 ? 2 : 4)); h[0] = v; h[4] = (os << 4) | ls; h[5] = (bs << 4) | is;
    if (v < 2) w16(h, 6, kept.length); else w32(h, 6, kept.length); parts.push(h);
    const wr = (val, s) => { const a = new Uint8Array(s); if (s === 4) w32(a, 0, val); else if (s === 8) { w32(a, 0, Math.floor(val / 4294967296)); w32(a, 4, val >>> 0); } return a; };
    for (const it of kept) {
      parts.push(v < 2 ? bytes(it.id >> 8, it.id & 255) : wr(it.id, 4));
      if (v === 1 || v === 2) parts.push(bytes(0, it.cm));
      parts.push(bytes(it.dref >> 8, it.dref & 255), wr(it.base, bs), bytes(it.ext.length >> 8, it.ext.length & 255));
      for (const [eo, el] of it.ext) { if (is) parts.push(new Uint8Array(is)); parts.push(wr(eo, os), wr(el, ls)); }
    }
    return mkbox("iloc", ...parts);
  } };
}
function parseIref(b, iref) {
  const v = b[iref.ps], refs = []; const sz = v === 0 ? 2 : 4;
  for (const x of boxes(b, iref.ps + 4, iref.e).list) { let p = x.ps; const from = sz === 2 ? u16(b, p) : u32(b, p); p += sz; const n = u16(b, p); p += 2; const to = []; for (let i = 0; i < n; i++) { to.push(sz === 2 ? u16(b, p) : u32(b, p)); p += sz; } refs.push({ type: x.type, from, to }); }
  return { v, sz, refs };
}
function sanHeif(b, o) {
  const rep = newRep("HEIC / HEIF / AVIF", "Container rewrite in place: image data and offsets unchanged, other data zeroed and removed");
  const out = new Uint8Array(b);
  const { list: top, end } = boxes(b, 0, b.length);
  const meta = top.find((x) => x.type === "meta"); if (!meta) throw new Unsupported("This image has no item table and can't be rewritten safely.");
  const kids = boxes(b, meta.ps + 4, meta.e).list, get = (t) => kids.find((x) => x.type === t);
  const iinf = get("iinf"), iloc = get("iloc"), iref = get("iref"), iprp = get("iprp"), idat = get("idat"), pitm = get("pitm");
  if (!iinf || !iloc) throw new Unsupported("This image has no item table and can't be rewritten safely.");
  if ([iinf, iloc, iref, iprp].some((x) => x && x.hdr !== 8)) throw new Unsupported("Unusual box sizes in this image.");
  const inf = parseIinf(b, iinf), loc = parseIloc(b, iloc), ref = iref ? parseIref(b, iref) : { v: 0, sz: 2, refs: [] };
  const primary = pitm ? (b[pitm.ps] === 0 ? u16(b, pitm.ps + 4) : u32(b, pitm.ps + 4)) : null;
  const dead = new Set(), why = new Map();
  for (const r of ref.refs) if (r.type === "thmb") { dead.add(r.from); why.set(r.from, "Embedded thumbnail / preview image"); }
  for (const it of inf.items) {
    if (dead.has(it.id)) continue;
    if (it.type === "Exif") { dead.add(it.id); why.set(it.id, "EXIF"); }
    else if (it.type === "mime") { dead.add(it.id); why.set(it.id, /xml|rdf/i.test(it.ctype) ? "XMP" : "Embedded data item (" + (it.ctype || "mime") + ")"); }
    else if (!IMAGE_ITEMS.has(it.type)) { dead.add(it.id); why.set(it.id, it.type === "legacy" ? "Item (old-style entry)" : "Embedded item '" + it.type.trim() + "'"); }
  }
  if (primary != null && dead.has(primary)) throw new Unsupported("The main image of this file is stored in an unusual way that can't be rewritten safely.");
  const removedIds = [...dead];
  // zero the data of removed items
  const L = new Map(loc.items.map((x) => [x.id, x]));
  for (const id of removedIds) {
    const it = L.get(id); if (!it) continue;
    for (const [eo, el] of it.ext) {
      if (!el) { lim(rep, "An embedded item has an open-ended length, so its bytes could not be zeroed."); continue; }
      const at = it.cm === 1 ? (idat ? idat.ps + it.base + eo : -1) : it.cm === 0 ? it.base + eo : -1;
      if (at < 0 || at + el > out.length) { lim(rep, "An embedded item's location could not be resolved, so its bytes may remain."); continue; }
      out.fill(0, at, at + el);
    }
    rm(rep, why.get(id), 1, 0);
  }
  // rebuild tables without the removed items
  const keptInf = inf.items.filter((i) => !dead.has(i.id)), keptLoc = loc.items.filter((i) => !dead.has(i.id));
  const ih = new Uint8Array(4 + (inf.v === 0 ? 2 : 4)); ih[0] = inf.v; if (inf.v === 0) w16(ih, 4, keptInf.length); else w32(ih, 4, keptInf.length);
  const newIinf = mkbox("iinf", ih, ...keptInf.map((i) => b.subarray(i.box.s, i.box.e)));
  const newIloc = loc.bytes(keptLoc);
  let newIref = null;
  if (iref) {
    const rb = []; for (const r of ref.refs) { if (dead.has(r.from)) continue; const to = r.to.filter((t) => !dead.has(t)); if (!to.length) continue; const a = new Uint8Array(ref.sz + 2 + to.length * ref.sz); const wi = (p, v) => (ref.sz === 2 ? w16(a, p, v) : w32(a, p, v)); wi(0, r.from); w16(a, ref.sz, to.length); to.forEach((t, i) => wi(ref.sz + 2 + i * ref.sz, t)); rb.push(mkbox(r.type, a)); }
    if (rb.length) newIref = mkbox("iref", bytes(ref.v, 0, 0, 0), ...rb);
  }
  const outKids = [];
  for (const k of kids) {
    if (k === iinf) outKids.push(newIinf);
    else if (k === iloc) outKids.push(newIloc);
    else if (k === iref) { if (newIref) outKids.push(newIref); }
    else if (k === iprp) {
      const pk = boxes(b, iprp.ps, iprp.e).list, pb = [];
      for (const x of pk) {
        if (x.type === "ipco") {
          const copy = b.slice(x.s, x.e);
          for (const pr of boxes(copy, 8, copy.length).list) if (pr.type === "udes") { toFree(copy, pr); rm(rep, "Description property (udes)", 1, pr.e - pr.s); }
          pb.push(copy);
        } else if (x.type === "ipma") {
          const v = b[x.ps], big = b[x.ps + 3] & 1; let p = x.ps + 8; const n = u32(b, x.ps + 4), ent = [];
          for (let i = 0; i < n; i++) { const s0 = p, id = v < 1 ? u16(b, p) : u32(b, p); p += v < 1 ? 2 : 4; const ac = b[p]; p += 1 + ac * (big ? 2 : 1); if (!dead.has(id)) ent.push(b.subarray(s0, p)); }
          const hd = new Uint8Array(8); hd.set(b.subarray(x.ps, x.ps + 4)); w32(hd, 4, ent.length); pb.push(mkbox("ipma", hd, ...ent));
        } else pb.push(b.subarray(x.s, x.e));
      }
      outKids.push(mkbox("iprp", ...pb));
    } else if (k.type === "grpl") {
      let hit = false; for (const g of boxes(b, k.ps, k.e).list) for (let p = g.ps + 8; p + 4 <= g.e; p += 4) if (dead.has(u32(b, p))) hit = true;
      if (hit) { rm(rep, "Group of alternates", 1, k.e - k.s); } else outKids.push(b.subarray(k.s, k.e));
    } else outKids.push(b.subarray(k.s, k.e));
  }
  const content = cat(outKids), room = meta.e - (meta.ps + 4);
  if (content.length > room || (room - content.length > 0 && room - content.length < 8)) throw new Unsupported("The rewritten item tables don't fit this file's layout.");
  out.set(content, meta.ps + 4); const padAt = meta.ps + 4 + content.length;
  if (room > content.length) { out.fill(0, padAt, meta.e); w32(out, padAt, meta.e - padAt); out.set(ascii("free"), padAt + 4); }
  // top-level boxes
  let hasMoov = false;
  for (const x of top) {
    if (x.type === "meta" || x.type === "ftyp" || x.type === "mdat") continue;
    if (x.type === "moov") { hasMoov = true; const z = cleanMoov(out, x, rep); for (const [a, c] of mergeRanges(z)) if (c <= out.length) out.fill(0, a, c); continue; }
    if (x.type === "free" || x.type === "skip") { if (out.subarray(x.ps, x.e).some((v) => v)) rm(rep, "Non-empty padding box", 1, x.e - x.s); toFree(out, x); continue; }
    rm(rep, x.type === "uuid" ? "Extension data (uuid box, may hold a content-credentials manifest)" : x.type === "jumb" ? "JUMBF / content-credentials manifest" : x.type === "xml " ? "XMP" : "Top-level box '" + x.type.trim() + "'", 1, x.e - x.s); toFree(out, x);
  }
  // data in mdat that no remaining item points at
  const ok = keptLoc.every((i) => i.cm !== 2 && i.dref === 0 && i.ext.every(([, l]) => l > 0));
  if (!hasMoov && ok) {
    const cov = []; for (const it of keptLoc) for (const [eo, el] of it.ext) { const at = it.cm === 1 ? (idat ? idat.ps + it.base + eo : -1) : it.base + eo; if (at >= 0) cov.push([at, at + el]); }
    const cv = mergeRanges(cov); let stray = 0;
    for (const m of top.filter((x) => x.type === "mdat")) {
      let p = m.ps; for (const [a, c] of cv) { if (c <= p || a >= m.e) continue; for (let i = p; i < Math.min(a, m.e); i++) if (out[i]) { stray++; out[i] = 0; } p = Math.max(p, c); }
      for (let i = p; i < m.e; i++) if (out[i]) { stray++; out[i] = 0; }
    }
    if (stray) rm(rep, "Unreferenced data inside the media data", 1, stray);
  } else if (!hasMoov) lim(rep, "Some items use an indirect data layout, so unreferenced bytes inside the media data were not scanned.");
  if (end < out.length) rm(rep, "Data appended after the last box", 1, out.length - end);
  lim(rep, "Properties needed to display the picture (size, colour signalling, rotation) are part of the image structure and are kept. HEIF cannot be redrawn in the browser without changing the format.");
  if (keptInf.some((i) => ref.refs.some((r) => r.type === "auxl" && r.from === i.id))) { keep(rep, "Auxiliary images (alpha, depth or HDR gain map)"); lim(rep, "Auxiliary images (alpha, depth, gain map) are kept as they are and were not inspected for embedded data."); }
  rep.dims = null;
  return { out: out.subarray(0, end), rep };
}

/* ---------------------------------------------------------------- MP4 / MOV (works on a Blob; only the movie header is read into memory) */
async function readAt(blob, off, len) { return new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer()); }
const MP4_KEEP = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "free"]);
async function sanMp4(file) {
  const rep = newRep("MP4 / MOV", "Container rewrite in place: audio and video data and offsets unchanged");
  const tops = []; let p = 0;
  for (let g = 0; g < 200000 && p + 8 <= file.size; g++) {
    const h = await readAt(file, p, 16); let size = u32(h, 0), hdr = 8; const type = asc(h, 4, 8);
    if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = file.size - p;
    if (size < hdr || p + size > file.size) { if (!tops.length) throw new Damaged("The video is damaged (bad box)."); break; }
    tops.push({ type, s: p, e: p + size, hdr }); p += size;
  }
  if (!tops.length || !(tops.some((t) => t.type === "ftyp") || tops.some((t) => t.type === "moov"))) throw new Damaged("This doesn't look like a valid MP4 or MOV file.");
  const end = tops[tops.length - 1].e;
  const patches = []; // {s, bytes} or {s, zeroLen}
  const zeroRanges = [];
  for (const t of tops) {
    if (t.type === "moov") {
      if (t.e - t.s > LIMITS.moov) throw new Unsupported("The movie header is too large to process safely here.");
      const buf = await readAt(file, t.s, t.e - t.s); const z = cleanMoov(buf, { type: "moov", s: 0, e: buf.length, ps: t.hdr, hdr: t.hdr }, rep);
      patches.push({ s: t.s, bytes: buf }); zeroRanges.push(...z);
    } else if (!MP4_KEEP.has(t.type)) {
      const h = new Uint8Array(t.hdr); h.set(await readAt(file, t.s, t.hdr)); h.set(ascii("free"), 4);
      rm(rep, t.type === "uuid" ? "Extension data (uuid box)" : t.type === "udta" ? "User data" : t.type === "meta" ? "Metadata container" : t.type === "XMP_" || t.type === "xml " ? "XMP" : "Top-level box '" + t.type.trim() + "'", 1, t.e - t.s);
      patches.push({ s: t.s, bytes: h, zeroFrom: t.s + t.hdr, zeroTo: t.e });
    } else if (t.type === "free") {
      if (t.e - t.s > 8) { patches.push({ s: t.s + t.hdr, zeroFrom: t.s + t.hdr, zeroTo: t.e, bytes: new Uint8Array(0) }); }
    }
  }
  for (const [a, c] of mergeRanges(zeroRanges)) if (c <= end && a >= 0) patches.push({ s: a, bytes: new Uint8Array(0), zeroFrom: a, zeroTo: c });
  patches.sort((a, c) => a.s - c.s);
  // assemble: original slices between patches, patched bytes, then zero-filled spans
  const parts = []; let cur = 0; const ZERO = new Uint8Array(1 << 20);
  const zero = (n) => { while (n > 0) { const k = Math.min(n, ZERO.length); parts.push(k === ZERO.length ? ZERO : ZERO.subarray(0, k)); n -= k; } };
  const skip = (to) => { if (to > cur) { parts.push(file.slice(cur, to)); cur = to; } };
  for (const pt of patches) {
    if (pt.s < cur) continue; skip(pt.s);
    if (pt.bytes.length) { parts.push(pt.bytes); cur = pt.s + pt.bytes.length; }
    if (pt.zeroTo) { const from = Math.max(cur, pt.zeroFrom); if (pt.zeroTo > from) { zero(pt.zeroTo - from); cur = pt.zeroTo; } }
  }
  skip(end);
  if (end < file.size) rm(rep, "Data appended after the last box", 1, file.size - end);
  lim(rep, "Encoder or device text inside the video bitstream itself (for example SEI user data) can't be inspected or removed here.");
  lim(rep, "Cover-art or still-image tracks, if any, are treated as ordinary video tracks and kept.");
  keep(rep, "Audio, video and subtitle tracks, unchanged");
  return { out: new Blob(parts, { type: "video/mp4" }), rep };
}

/* ---------------------------------------------------------------- entry point */
export const EXT_FOR = { jpeg: ["jpg", "jpeg"], png: ["png"], webp: ["webp"], tiff: ["tif", "tiff"], heif: ["heic", "heif", "avif"], mp4: ["mp4", "mov", "m4v"] };
/** @returns {Promise<{kind:string, out:Uint8Array|Blob, rep:object}>} Throws Unsupported, Damaged or NeedsDecision. */
export async function sanitise(file, name, opts = {}) {
  if (RAW_EXT.test(name || "")) throw new Unsupported("RAW camera files can't be reliably sanitised without damaging their rendering, so this file was not changed.");
  if (file.size < 12) throw new Damaged("The file is empty or too small to be an image or video.");
  const kind = detect(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  if (!kind) throw new Unsupported("This isn't a supported image or video format.");
  if (kind === "gif") throw new Unsupported("GIF is not supported yet.");
  if (kind === "bigtiff") throw new Unsupported("BigTIFF is not supported.");
  if (file.size > (kind === "mp4" ? LIMITS.video : LIMITS.image)) throw new Unsupported(`The file is over the ${Math.round((kind === "mp4" ? LIMITS.video : LIMITS.image) / 1048576)} MB limit.`);
  if (kind === "mp4") return { kind, ...(await sanMp4(file)) };
  const b = new Uint8Array(await file.arrayBuffer());
  const r = kind === "jpeg" ? sanJpeg(b, opts) : kind === "png" ? sanPng(b, opts) : kind === "webp" ? sanWebp(b, opts) : kind === "tiff" ? sanTiff(b, opts, name) : sanHeif(b, opts);
  r.rep.srcSize = file.size; return { kind, ...r };
}
export { sanJpeg };
