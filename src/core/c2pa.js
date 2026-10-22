// Content Credentials (C2PA) detection. Finds the JUMBF manifest store in JPEG, PNG, WebP and ISO-BMFF (MP4, MOV, HEIC, AVIF)
// and reads the claims it states. It does NOT validate signatures or certificate chains: "present" means a manifest exists,
// not that it is trustworthy. Works on a File/Blob by reading only the container structure, never the whole file.

const C2PA_UUID = "d8fec3d6-1b0e-483c-9297-5828877ec481";
const CAP = 4 * 1024 * 1024; // never read more than this per manifest
const latin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const hex = (b, o, n) => [...b.subarray(o, o + n)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function readAt(blob, off, len) {
  if (off < 0 || off >= blob.size) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer());
}

/** @returns {Promise<{present:boolean, container:string|null, text:string}>} */
export async function scanContainer(blob) {
  const head = await readAt(blob, 0, 16);
  const out = { present: false, container: null, text: "" };
  const add = (u8, container) => { out.present = true; out.container = out.container || container; if (out.text.length < CAP) out.text += latin1(u8.subarray(0, CAP)) + "\n"; };
  try {
    if (head[0] === 0xff && head[1] === 0xd8) {
      // JPEG: walk the marker segments up to the start of scan; JUMBF lives in APP11 ("JP" common identifier)
      let pos = 2;
      for (let guard = 0; guard < 400 && pos < blob.size; guard++) {
        const h = await readAt(blob, pos, 4);
        if (h[0] !== 0xff) break;
        const m = h[1];
        if (m === 0xda || m === 0xd9) break;
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
        const len = (h[2] << 8) | h[3];
        if (len < 2) break;
        if (m === 0xeb) { const seg = await readAt(blob, pos + 4, Math.min(len - 2, CAP)); if (seg[0] === 0x4a && seg[1] === 0x50) add(seg.subarray(8), "JPEG"); }
        pos += 2 + len;
      }
    } else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      let pos = 8;
      for (let guard = 0; guard < 20000 && pos + 8 <= blob.size; guard++) {
        const h = await readAt(blob, pos, 8), len = u32(h, 0), type = latin1(h.subarray(4, 8));
        if (type === "caBX") add(await readAt(blob, pos + 8, Math.min(len, CAP)), "PNG");
        if (type === "IEND") break;
        pos += 12 + len;
      }
    } else if (latin1(head.subarray(0, 4)) === "RIFF" && latin1(head.subarray(8, 12)) === "WEBP") {
      let pos = 12;
      for (let guard = 0; guard < 2000 && pos + 8 <= blob.size; guard++) {
        const h = await readAt(blob, pos, 8), type = latin1(h.subarray(0, 4)), len = (h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24)) >>> 0;
        if (type === "C2PA") add(await readAt(blob, pos + 8, Math.min(len, CAP)), "WebP");
        pos += 8 + len + (len & 1);
      }
    } else if (latin1(head.subarray(4, 8)) === "ftyp" || latin1(head.subarray(4, 8)) === "moov" || latin1(head.subarray(4, 8)) === "free") {
      let pos = 0;
      for (let guard = 0; guard < 5000 && pos + 8 <= blob.size; guard++) {
        const h = await readAt(blob, pos, 32);
        let size = u32(h, 0), hdr = 8; const type = latin1(h.subarray(4, 8));
        if (size === 1) { size = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; } else if (size === 0) size = blob.size - pos;
        if (size < hdr) break;
        if (type === "uuid" && hex(h, hdr, 16).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5") === C2PA_UUID) add(await readAt(blob, pos + hdr + 16, Math.min(size - hdr - 16, CAP)), "MP4/HEIC");
        else if (type === "jumb") add(await readAt(blob, pos + hdr, Math.min(size - hdr, CAP)), "MP4/HEIC");
        pos += size;
      }
    }
  } catch (e) { /* a damaged container just means no manifest could be read */ }
  return out;
}

const AI_VENDORS = [
  [/OpenAI|DALL[-\s·]?E|ChatGPT|GPT-?4o|gpt-image/i, "OpenAI"], [/Midjourney/i, "Midjourney"], [/Adobe\s+Firefly|Firefly/i, "Adobe Firefly"],
  [/Microsoft\s+Designer|Bing\s+Image\s+Creator|Copilot\s+Designer/i, "Microsoft Designer"], [/Imagen|Google\s+AI|SynthID|Gemini/i, "Google AI"],
  [/Stable\s*Diffusion|Stability\s*AI|DreamStudio|SDXL/i, "Stable Diffusion"], [/Leonardo\.?\s?Ai/i, "Leonardo.Ai"], [/Ideogram/i, "Ideogram"],
  [/FLUX\.1|Black\s+Forest\s+Labs/i, "FLUX"], [/Runway\s?ML|Runway\s+Gen/i, "Runway"], [/Meta\s+AI|Imagine\s+with\s+Meta/i, "Meta AI"],
  [/Amazon\s+(Titan|Nova)|Nova\s+Canvas/i, "Amazon Nova"], [/Shutterstock\s+AI|Getty\s+Generative|Generative\s+AI\s+by\s+Getty/i, "Stock generative AI"],
];
const ISSUERS = ["Adobe", "OpenAI", "Truepic", "Leica", "Sony", "Nikon", "Canon", "Google", "Microsoft", "Samsung", "Fujifilm", "Lightricks", "BBC", "Qualcomm", "Meta", "Amazon", "Midjourney", "Stability", "Shutterstock", "Getty", "Publicis", "Cloudflare"];

/** Reads what the manifest claims, from the strings inside it. */
export function readClaims(scan) {
  const t = (scan && scan.text) || "";
  const c = { present: !!(scan && scan.present), container: scan ? scan.container : null, aiGenerated: false, composite: false, capture: false, generator: null, aiVendor: null, issuer: null, actions: [], validated: false };
  if (!c.present) return c;
  if (/(^|[^a-zA-Z])trainedAlgorithmicMedia/.test(t)) c.aiGenerated = true;
  if (/compositeWithTrainedAlgorithmicMedia/.test(t)) c.composite = true;
  if (/digitalCapture|computationalCapture/.test(t)) c.capture = true;
  for (const [re, name] of AI_VENDORS) if (re.test(t)) { c.aiVendor = name; break; }
  const gi = t.indexOf("claim_generator");
  if (gi >= 0 && t.slice(gi + 15, gi + 20) !== "_info") { // CBOR text string: a length byte (0x60 + n, or 0x78 n) then the characters
    const hb = t.charCodeAt(gi + 15); let val = "";
    if (hb >= 0x60 && hb <= 0x77) val = t.substr(gi + 16, hb - 0x60); else if (hb === 0x78) val = t.substr(gi + 17, t.charCodeAt(gi + 16));
    c.generator = val.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 80) || null;
  }
  c.actions = [...new Set((t.match(/c2pa\.[a-z_]+/g) || []).filter((a) => a !== "c2pa.actions" && a !== "c2pa.hash.data" && a !== "c2pa.thumbnail.claim.jpeg" && a !== "c2pa.assertions"))].slice(0, 8);
  c.issuer = ISSUERS.find((i) => t.toLowerCase().includes(i.toLowerCase())) || null;
  if (c.aiVendor) { if (/c2pa\.created/.test(t) && !c.composite) c.aiGenerated = true; else if (!c.aiGenerated) c.composite = true; }
  return c;
}
