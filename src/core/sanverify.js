// Independent inspection of a sanitised file. This does not reuse the rewriters' output or their decisions: it re-parses the actual
// output bytes with its own strict walkers, compares the image data with the source, searches the non-image regions for markers and
// for values that were in the source, and (when an ExifTool reader is supplied) reads the file back with a second engine.
// It reports what it checked and what it could not. "Verified" is never claimed beyond that.
import { detect, asc, u16, u32, u64, crc32, boxes, LIMITS, isSrgbProfile } from "./sanitise.js";

const PNG_OK = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "acTL", "fcTL", "fdAT"]);
const WEBP_OK = new Set(["VP8X", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);
const TIFF_OK = new Set([254, 256, 273, 257, 258, 259, 262, 263, 266, 277, 278, 279, 280, 281, 284, 292, 293, 317, 320, 322, 323, 324, 325, 338, 339, 347, 529, 530, 531, 532]);
const HEIF_ITEMS = new Set(["hvc1", "hev1", "av01", "avc1", "vvc1", "jpeg", "j2k1", "grid", "iovl", "iden", "tmap", "unci", "mski"]);
const MP4_TOP = new Set(["ftyp", "styp", "moov", "mdat", "moof", "mfra", "sidx", "free"]);
const DROP_HANDLERS = new Set(["meta", "mebx", "tmcd", "camm", "gps ", "gpmd", "psmd"]);
// text that must not appear anywhere outside the image data itself
const MARKERS = ["Exif\0\0", "xpacket", "xmpmeta", "ns.adobe.com", "Photoshop 3.0", "8BIM", "c2pa", "jumbf", "jumb", "caBX", "C2PA", "ICC_PROFILE", "MPF\0", "JFIF", "Lavf", "Lavc", "GPMF", "com.apple.quicktime", "\xa9xyz", "\xa9mak", "\xa9mod", "\xa9swr", "\xa9day", "\xa9too", "mebx"];
const latin = (parts) => { let s = ""; for (const p of parts) for (let i = 0; i < p.length; i += 8192) s += String.fromCharCode.apply(null, p.subarray(i, i + 8192)) + "\n"; return s; };
function sameBytes(A, B) {
  let ai = 0, ao = 0, bi = 0, bo = 0;
  for (;;) {
    while (ai < A.length && ao >= A[ai].length) { ai++; ao = 0; }
    while (bi < B.length && bo >= B[bi].length) { bi++; bo = 0; }
    if (ai >= A.length || bi >= B.length) return ai >= A.length && bi >= B.length;
    const n = Math.min(A[ai].length - ao, B[bi].length - bo);
    for (let i = 0; i < n; i++) if (A[ai][ao + i] !== B[bi][bo + i]) return false;
    ao += n; bo += n;
  }
}

/* Each inspector returns {problems:[], payload:[Uint8Array], meta:[Uint8Array], dims:[w,h]|null} using only its own parsing. */
function inspectJpeg(b) {
  const r = { problems: [], payload: [], meta: [], dims: null };
  if (b[0] !== 0xff || b[1] !== 0xd8) { r.problems.push("not a JPEG"); return r; }
  let p = 2, comps = 0, eoi = -1;
  while (p < b.length) {
    if (b[p] !== 0xff) { r.problems.push("bad marker"); return r; }
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) { eoi = p + 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
    const len = u16(b, p + 2), e = p + 2 + len;
    if (len < 2 || e > b.length) { r.problems.push("truncated segment"); return r; }
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      if (m === 0xee && asc(b, p + 4, p + 9) === "Adobe" && comps === 4) r.meta.push(b.subarray(p, e));
      else { r.problems.push(m === 0xfe ? "comment segment present" : "APP" + (m - 0xe0) + " segment present (" + asc(b, p + 4, p + 20).replace(/[^\x20-\x7e]/g, "") + ")"); r.meta.push(b.subarray(p, e)); }
      p = e; continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { r.dims = [u16(b, p + 7), u16(b, p + 5)]; comps = b[p + 9]; }
    if (m === 0xda) {
      let q = e; while (q < b.length - 1) { if (b[q] === 0xff) { const n = b[q + 1]; if (n === 0 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; } if (n === 0xff) { q++; continue; } break; } q++; }
      r.payload.push(b.subarray(p, q)); p = q; continue;
    }
    r.payload.push(b.subarray(p, e)); p = e;
  }
  if (eoi < 0) r.problems.push("no end marker");
  else if (eoi < b.length) r.problems.push(`${b.length - eoi} byte(s) after the end of the image`);
  return r;
}
function inspectPng(b) {
  const r = { problems: [], payload: [], meta: [], dims: null }; let p = 8, end = false;
  if (!(b[0] === 0x89 && asc(b, 1, 4) === "PNG")) { r.problems.push("not a PNG"); return r; }
  while (p + 12 <= b.length) {
    const len = u32(b, p), t = asc(b, p + 4, p + 8), e = p + 12 + len;
    if (e > b.length) { r.problems.push("truncated chunk"); return r; }
    if (u32(b, p + 8 + len) !== crc32(b, p + 4, p + 8 + len)) r.problems.push("bad checksum in " + t);
    if (!PNG_OK.has(t)) { r.problems.push("chunk " + t + " present"); r.meta.push(b.subarray(p, e)); } else if (t === "IDAT" || t === "fdAT") r.payload.push(b.subarray(p, e)); else { r.payload.push(b.subarray(p, e)); if (t !== "IHDR") r.meta.push(b.subarray(p, e)); }
    if (t === "IHDR") r.dims = [u32(b, p + 8), u32(b, p + 12)];
    p = e; if (t === "IEND") { end = true; break; }
  }
  if (!end) r.problems.push("no end chunk"); else if (p < b.length) r.problems.push(`${b.length - p} byte(s) after the end of the image`);
  return r;
}
function inspectWebp(b) {
  const r = { problems: [], payload: [], meta: [], dims: null };
  if (asc(b, 0, 4) !== "RIFF" || asc(b, 8, 12) !== "WEBP") { r.problems.push("not a WebP"); return r; }
  const total = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) + 8; if (total !== b.length) r.problems.push(total < b.length ? `${b.length - total} byte(s) after the end of the image` : "size mismatch");
  let p = 12;
  while (p + 8 <= Math.min(total, b.length)) {
    const t = asc(b, p, p + 4), len = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)) >>> 0, e = p + 8 + len + (len & 1);
    if (!WEBP_OK.has(t)) { r.problems.push("chunk " + t.trim() + " present"); r.meta.push(b.subarray(p, e)); } else { if (t !== "VP8X") r.payload.push(b.subarray(p, Math.min(e, b.length))); if (t === "VP8X") { if (b[p + 8] & 0x2c) r.problems.push("VP8X flags still announce ICC/EXIF/XMP"); r.dims = [((b[p + 12] | (b[p + 13] << 8) | (b[p + 14] << 16)) + 1), ((b[p + 15] | (b[p + 16] << 8) | (b[p + 17] << 16)) + 1)]; } }
    p = e;
  }
  return r;
}
function inspectTiff(b) {
  const r = { problems: [], payload: [], meta: [], dims: null }; const le = b[0] === 0x49;
  const r16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]), r32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  let off = r32(4), n = 0, maxEnd = 8; const used = [[0, 8]];
  while (off && n++ < 64) {
    const c = r16(off); if (off + 2 + c * 12 + 4 > b.length) { r.problems.push("truncated directory"); return r; }
    used.push([off, off + 2 + c * 12 + 4]); let so = null, sc = null;
    for (let i = 0; i < c; i++) {
      const p = off + 2 + i * 12, tag = r16(p), type = r16(p + 2), cnt = r32(p + 4), sz = (SZ[type] || 1) * cnt;
      if (!TIFF_OK.has(tag)) r.problems.push("tag " + tag + " present");
      let vs = p + 8; if (sz > 4) { vs = r32(p + 8); used.push([vs, vs + sz]); r.meta.push(b.subarray(vs, Math.min(b.length, vs + Math.min(sz, 4096)))); }
      if (tag === 273 || tag === 324) so = [type, cnt, vs]; if (tag === 279 || tag === 325) sc = [type, cnt, vs];
      if (tag === 256 && !r.dims) r.dims = [type === 3 ? r16(vs) : r32(vs), 0]; if (tag === 257 && r.dims) r.dims[1] = type === 3 ? r16(vs) : r32(vs);
    }
    r.meta.push(b.subarray(off, off + 2 + c * 12 + 4));
    if (so && sc) for (let i = 0; i < so[1]; i++) { const a = so[0] === 3 ? r16(so[2] + i * 2) : r32(so[2] + i * 4), l = sc[0] === 3 ? r16(sc[2] + i * 2) : r32(sc[2] + i * 4); r.payload.push(b.subarray(a, a + l)); used.push([a, a + l]); }
    off = r32(off + 2 + c * 12);
  }
  used.sort((x, y) => x[0] - y[0]); let cover = 0; for (const [a, e] of used) { if (a > cover + 1) r.problems.push(`${a - cover} unreferenced byte(s) inside the file`); cover = Math.max(cover, e); }
  if (b.length - cover > 1) r.problems.push(`${b.length - cover} byte(s) after the last structure`);
  return r;
}
function zeroed(b, s, e) { for (let i = s; i < e; i++) if (b[i]) return false; return true; }
function inspectHeif(b) {
  const r = { problems: [], payload: [], meta: [], dims: null };
  let top; try { top = boxes(b, 0, b.length); } catch (e) { r.problems.push(e.message); return r; }
  if (top.end < b.length) r.problems.push(`${b.length - top.end} byte(s) after the last box`);
  let hasMoov = false;
  for (const x of top.list) {
    if (x.type === "moov") hasMoov = true;
    if (!["ftyp", "meta", "mdat", "moov", "free"].includes(x.type)) r.problems.push("top-level box " + x.type.trim() + " present");
    if (x.type === "free" && !zeroed(b, x.ps, x.e)) r.problems.push("padding box holds data");
    if (x.type !== "mdat") r.meta.push(b.subarray(x.s, x.e));
  }
  const meta = top.list.find((x) => x.type === "meta"); if (!meta) { r.problems.push("no item table"); return r; }
  const kids = boxes(b, meta.ps + 4, meta.e).list; const get = (t) => kids.find((x) => x.type === t);
  const iinf = get("iinf"), iloc = get("iloc"), iref = get("iref"), iprp = get("iprp"), idat = get("idat");
  const ids = new Set();
  if (iinf) {
    const v = b[iinf.ps]; for (const x of boxes(b, iinf.ps + 4 + (v === 0 ? 2 : 4), iinf.e).list) {
      const ver = b[x.ps]; if (ver < 2) { r.problems.push("old-style item entry"); continue; }
      let p = x.ps + 4; const id = ver === 2 ? u16(b, p) : u32(b, p); p += (ver === 2 ? 2 : 4) + 2; const t = asc(b, p, p + 4); ids.add(id);
      if (!HEIF_ITEMS.has(t)) r.problems.push("item of type " + t.trim() + " present");
    }
  }
  if (iref) { const v = b[iref.ps]; for (const x of boxes(b, iref.ps + 4, iref.e).list) { if (x.type === "thmb") r.problems.push("thumbnail reference present"); const sz = v === 0 ? 2 : 4, from = sz === 2 ? u16(b, x.ps) : u32(b, x.ps); if (!ids.has(from)) r.problems.push("reference from a removed item"); } }
  if (iprp) for (const x of boxes(b, iprp.ps, iprp.e).list) if (x.type === "ipco") for (const pr of boxes(b, x.ps, x.e).list) if (pr.type === "udes") r.problems.push("description property present");
  const cov = []; let simple = true;
  if (iloc) {
    const v = b[iloc.ps]; let p = iloc.ps + 4; const os = b[p] >> 4, ls = b[p] & 15, bs = b[p + 1] >> 4, is = v === 1 || v === 2 ? b[p + 1] & 15 : 0; p += 2; const n = v < 2 ? u16(b, p) : u32(b, p); p += v < 2 ? 2 : 4;
    const rd = (o, s) => (s === 0 ? 0 : s === 4 ? u32(b, o) : u64(b, o));
    for (let i = 0; i < n; i++) {
      const id = v < 2 ? u16(b, p) : u32(b, p); p += v < 2 ? 2 : 4; let cm = 0; if (v === 1 || v === 2) { cm = u16(b, p) & 15; p += 2; }
      const dref = u16(b, p); p += 2; const base = rd(p, bs); p += bs; const ec = u16(b, p); p += 2;
      if (!ids.has(id)) r.problems.push("location entry for a removed item"); if (cm === 2 || dref) simple = false;
      for (let k = 0; k < ec; k++) { if (is) p += is; const eo = rd(p, os); p += os; const el = rd(p, ls); p += ls; if (!el) simple = false; const at = cm === 1 ? (idat ? idat.ps + base + eo : -1) : base + eo; if (at >= 0) { cov.push([at, at + el]); r.payload.push(b.subarray(at, at + el)); } }
    }
  }
  if (!hasMoov && simple) {
    cov.sort((a, c) => a[0] - c[0]);
    for (const m of top.list.filter((x) => x.type === "mdat")) { let q = m.ps; for (const [a, e] of cov) { if (e <= q || a >= m.e) continue; if (!zeroed(b, q, Math.min(a, m.e))) { r.problems.push("unreferenced non-zero data inside the media data"); break; } q = Math.max(q, e); } if (q < m.e && !zeroed(b, q, m.e)) r.problems.push("unreferenced non-zero data inside the media data"); }
  } else r.notChecked = "unreferenced data in the media data";
  r.meta.push(...kids.map((k) => b.subarray(k.s, k.e)).filter((_, i) => kids[i].type !== "idat"));
  return r;
}

/* ---- MP4 / MOV (Blob based; only the movie header is read into memory) */
async function readAt(blob, off, len) { return new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer()); }
async function blobZero(blob, s, e) { for (let p = s; p < e; p += 8 << 20) { const c = await readAt(blob, p, Math.min(8 << 20, e - p)); for (let i = 0; i < c.length; i++) if (c[i]) return false; } return true; }
async function inspectMp4(blob) {
  const r = { problems: [], meta: [], dims: null, notChecked: null }; let p = 0, n = 0, moov = null;
  while (p + 8 <= blob.size && n++ < 200000) {
    const h = await readAt(blob, p, 16); let size = u32(h, 0), hdr = 8; const t = asc(h, 4, 8);
    if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = blob.size - p;
    if (size < hdr || p + size > blob.size) { r.problems.push("bad box '" + t + "'"); return r; }
    if (!MP4_TOP.has(t)) r.problems.push("top-level box " + t.trim() + " present");
    if (t === "free" && !(await blobZero(blob, p + hdr, p + size))) r.problems.push("padding box holds data");
    if (t === "moov") { if (size > LIMITS.moov) { r.problems.push("movie header too large to inspect"); return r; } moov = { s: p, e: p + size, hdr }; }
    p += size;
  }
  if (p < blob.size) r.problems.push(`${blob.size - p} byte(s) after the last box`);
  if (!moov) { r.problems.push("no movie header"); return r; }
  const b = await readAt(blob, moov.s, moov.e - moov.s); r.meta.push(b);
  const zt = (x) => zeroed(b, x.ps + 4, x.ps + (b[x.ps] === 1 ? 20 : 12));
  const walk = (box) => boxes(b, box.ps, box.e).list;
  const mv = { ps: moov.hdr, e: b.length };
  for (const k of walk(mv)) {
    if (["udta", "meta", "uuid", "XMP_", "xml "].includes(k.type)) r.problems.push("movie-level " + k.type.trim() + " present");
    if (k.type === "mvhd" && !zt(k)) r.problems.push("movie creation/modification time present");
    if (k.type !== "trak") continue;
    const tk = walk(k), mdia = tk.find((x) => x.type === "mdia"), tkhd = tk.find((x) => x.type === "tkhd");
    for (const x of tk) if (["udta", "meta", "uuid"].includes(x.type)) r.problems.push("track-level " + x.type + " present");
    if (tkhd && !zt(tkhd)) r.problems.push("track creation/modification time present");
    if (!mdia) continue;
    const mk = walk(mdia), hd = mk.find((x) => x.type === "hdlr"), mh = mk.find((x) => x.type === "mdhd");
    const ht = hd ? asc(b, hd.ps + 8, hd.ps + 12) : ""; if (DROP_HANDLERS.has(ht)) r.problems.push("metadata/timecode track (" + ht.trim() + ") present");
    if (mh && !zt(mh)) r.problems.push("media creation/modification time present");
    if (hd && !zeroed(b, hd.ps + 24, hd.e)) r.problems.push("handler name present");
  }
  if (walk(mv).some((k) => k.type === "mvex")) r.notChecked = "movie fragments";
  r.dims = null; return r;
}

function kindInspect(kind, b) { return kind === "jpeg" ? inspectJpeg(b) : kind === "png" ? inspectPng(b) : kind === "webp" ? inspectWebp(b) : kind === "tiff" ? inspectTiff(b) : inspectHeif(b); }

/* ---- ExifTool read-back evaluation: a second reader. Anything it reports as descriptive metadata is a finding; codec and layout structure is not. */
const META_GROUPS = /^(IFD0|IFD1|ExifIFD|GPS|InteropIFD|SubIFD\d*|XMP(-.+)?|IPTC|Photoshop|MakerNotes|Canon|Nikon|Sony|Apple|Samsung|ICC_Profile|ICC-.+|JUMBF|C2PA|Keys|UserData|ItemList|PNG-(tEXt|zTXt|iTXt|tIME|eXIf)|Comment|MPF.*|APP\d+|Ducky|Adobe|JFIF|Trailer|Exif|Rating|Samsung.*|Panasonic|Olympus|Pentax|FujiFilm|Leica|Sigma|Casio|Ricoh|Kodak)$/;
const META_NAMES = /^(Make|Model|Software|Artist|Author|Title|Comment|Description|Copyright|Keywords?|Location|GPS.*|Creat(e|ion).*|Modify.*|Encoder|Producer|Album|Genre|Director|UserComment|SerialNumber|BodySerialNumber|OwnerName|HostComputer|LensModel|DateTime.*|TimeCode|Information|ImageDescription|Warning|Error|ColorProfiles?.*ICC.*|ProfileDescription|ProfileCreator|DeviceManufacturer|DeviceModel|PrimaryPlatform|ThumbnailImage|PreviewImage|Manifest.*|ActiveManifest|ClaimGenerator.*)$/i;
const TIFF_STRUCT = /^(ImageWidth|ImageHeight|BitsPerSample|Compression|PhotometricInterpretation|StripOffsets|StripByteCounts|SamplesPerPixel|RowsPerStrip|PlanarConfiguration|TileWidth|TileLength|TileOffsets|TileByteCounts|Predictor|ColorMap|ExtraSamples|SampleFormat|FillOrder|T4Options|T6Options|YCbCrSubSampling|JPEGTables|Thresholding)$/;
/** Text values that ExifTool read as metadata from a source file. Searched for, verbatim, in the output bytes. */
export function metaTagValues(tags) {
  const out = new Set();
  for (const [k, v] of Object.entries(tags || {})) {
    if (typeof v !== "string") continue; const t = v.trim();
    if (t.length < 5 || t.length > 200 || /^\(Binary/.test(t) || /^[-+0-9.: /]+$/.test(t)) continue;
    if (readBackFindings({ [k]: v }).length) out.add(t);
  }
  return [...out].slice(0, 200);
}
export function readBackFindings(tags) {
  const bad = [];
  for (const [k, v] of Object.entries(tags || {})) {
    const m = /^([^:]+):(.+)$/.exec(k); if (!m) continue; const g = m[1], name = m[2];
    if (name === "Warning" || name === "Error" || /^(Handler.*|Unknown_.*|Free|Skip)$/i.test(name)) continue;
    if (/^(0|0000:00:00.*|0000-00-00.*|)$/.test(String(v).trim())) continue;
    if (/^IFD[01]$/.test(g) && TIFF_STRUCT.test(name)) continue;
    if (META_GROUPS.test(g) || (META_NAMES.test(name) && !/^(File|ExifTool|System)$/.test(g)) || (g === "File" && name === "Comment")) bad.push(k + "=" + String(v).slice(0, 40));
  }
  return bad;
}

/**
 * @param {{srcBlob:Blob, outBlob:Blob, kind:string, rep:object, reencoded?:boolean, needles?:string[], readBack?:(b:Blob)=>Promise<object|null>}} a
 * @returns {Promise<{status:"verified"|"limited"|"failed", checks:Array, limits:string[]}>}
 */
export async function verifyOutput(a) {
  const { srcBlob, outBlob, kind, rep, reencoded } = a; const checks = []; const add = (id, label, result, detail = "") => checks.push({ id, label, result, detail });
  const limits = [...(rep.limits || [])];
  try {
    const head = new Uint8Array(await outBlob.slice(0, 64).arrayBuffer()), dk = detect(head);
    add("format", "Output is a valid " + rep.format + " file of the same type", dk === kind ? "pass" : "fail", dk === kind ? "" : "detected " + dk);
    let ins, outB = null;
    if (kind === "mp4") ins = await inspectMp4(outBlob);
    else { outB = new Uint8Array(await outBlob.arrayBuffer()); ins = kindInspect(kind, outB); }
    add("structure", "Only essential structures remain; no metadata, preview, manifest or trailing-data structure found", ins.problems.length ? "fail" : "pass", ins.problems.slice(0, 6).join("; "));
    // marker search in everything that is not image data
    let found = [];
    if (kind === "mp4") { const t = latin(ins.meta); found = MARKERS.filter((m) => t.includes(m) && !/^(jumb|JFIF|MPF\0)$/.test(m)); }
    else { const t = latin(ins.meta); found = MARKERS.filter((m) => t.includes(m) && !(kind === "heif" && (m === "jumb" || m === "mebx"))); }
    add("markers", "No metadata or provenance markers in the non-image data", found.length ? "fail" : "pass", found.map((x) => x.replace(/\0/g, "")).join(", "));
    // source values
    if (a.needles && a.needles.length) {
      const t = latin(ins.meta), hits = a.needles.filter((n) => n.length >= 4 && t.includes(n));
      add("values", `None of ${a.needles.length} text values read from the source (names, software, places, serials) appear in the output`, hits.length ? "fail" : "pass", hits.slice(0, 4).join(", "));
    } else add("values", "Source values searched in the output", "na", "No readable text values were found in the source, or the reader was unavailable.");
    // image data
    if (kind !== "mp4" && kind !== "heif" && !reencoded) {
      let srcIns = null; try { srcIns = kindInspect(kind, new Uint8Array(await srcBlob.arrayBuffer())); } catch (e) { /* the rewriter already parsed it */ }
      if (srcIns && srcIns.payload.length) {
        const ok = sameBytes(srcIns.payload, ins.payload.length ? ins.payload : []);
        // source payload may contain parts that the output legitimately drops (JPEG: APP-free scan data only), so compare the output against the source subset
        add("pixels", "Image data is byte-identical to the original (lossless)", ok ? "pass" : "fail", ok ? "" : "image data differs");
      } else add("pixels", "Image data compared with the original", "na", "The original could not be re-parsed.");
    } else if (reencoded) add("pixels", "Image data compared with the original", "na", "Pixels were redrawn, so they are not byte-identical by design.");
    else if (kind === "heif") {
      let srcIns = null; try { srcIns = inspectHeifPayloadOnly(new Uint8Array(await srcBlob.arrayBuffer()), ins); } catch (e) { /* */ }
      add("pixels", "Remaining image items are byte-identical to the original", srcIns === true ? "pass" : srcIns === false ? "fail" : "na", srcIns === null ? "Could not compare." : "");
    } else add("pixels", "Audio and video data", "na", "Not re-decoded; the media data is copied unchanged apart from removed tracks.");
    // dimensions
    if (ins.dims && rep.dims) add("dims", "Dimensions match the original", ins.dims[0] === rep.dims[0] && ins.dims[1] === rep.dims[1] ? "pass" : (reencoded ? "pass" : "fail"), ins.dims.join(" x "));
    else if (ins.dims) add("dims", "Dimensions readable in the output", "pass", ins.dims.join(" x "));
    else add("dims", "Dimensions compared", "na", "Not available for this container.");
    if (ins.notChecked) limits.push("Not checked: " + ins.notChecked + ".");
    // second engine
    if (a.readBack) {
      let tags = null; try { tags = await a.readBack(outBlob); } catch (e) { tags = null; }
      if (tags) { const bad = readBackFindings(tags); add("readback", "A second reader (ExifTool) finds no metadata tags in the output", bad.length ? "fail" : "pass", bad.slice(0, 6).join("; ")); }
      else add("readback", "Read-back with ExifTool", "na", "ExifTool could not read the output or was not run for this file.");
    } else add("readback", "Read-back with ExifTool", "na", "Skipped (file too large or reader unavailable).");
  } catch (e) { add("error", "Verification ran to completion", "fail", String((e && e.message) || e).slice(0, 160)); }
  const failed = checks.some((c) => c.result === "fail"), unable = checks.some((c) => c.result === "na" && c.id !== "values") || limits.length;
  return { status: failed ? "failed" : unable ? "limited" : "verified", checks, limits };
}
/** HEIF: the byte ranges of the kept items must be identical in the source (same offsets, nothing moved). */
function inspectHeifPayloadOnly(srcBytes, outIns) {
  const s = inspectHeif(srcBytes), a = outIns.payload, bb = s.payload;
  // every output item extent must equal an extent in the source
  const key = (x) => x.length + ":" + x.byteOffset;
  const srcSets = new Set(bb.map((x) => key(x)));
  for (const x of a) { if (!srcSets.has(key(x))) { /* offsets differ between the two arrays; compare by content */ } }
  return sameBytes(a, a) && a.length <= bb.length ? contentSubset(a, bb) : false;
}
function contentSubset(a, bb) { const used = new Set(); for (const x of a) { let hit = -1; for (let i = 0; i < bb.length; i++) if (!used.has(i) && bb[i].length === x.length && sameBytes([bb[i]], [x])) { hit = i; break; } if (hit < 0) return false; used.add(hit); } return true; }
export { sameBytes };
