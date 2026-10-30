// Builds a ZIP as a Blob without ever holding the whole archive, or a whole input file, in the page's memory:
// each file is read in slices, and the output is handed to the browser's Blob store as it grows. Large videos on phones need this.
import { Zip, ZipPassThrough, ZipDeflate } from "fflate";

const SLICE = 8 * 1024 * 1024, FOLD = 32 * 1024 * 1024;

/** entries: [{ name, blob | text, mt (ms) | date, level (0 = store) }] -> Blob */
export async function zipBlobs(entries, type = "application/zip") {
  let parts = [], pending = [], pendingSize = 0, error = null, done = false;
  const fold = () => { if (pending.length) { parts.push(new Blob(pending)); pending = []; pendingSize = 0; } };
  const zip = new Zip((err, chunk, final) => {
    if (err) { error = err; return; }
    pending.push(chunk); pendingSize += chunk.length;
    if (pendingSize >= FOLD) fold();
    if (final) done = true;
  });
  for (const e of entries) {
    const f = e.level ? new ZipDeflate(e.name, { level: e.level }) : new ZipPassThrough(e.name);
    f.mtime = e.date || new Date(e.mt || Date.now());
    zip.add(f);
    const blob = e.blob || new Blob([e.text || ""]);
    if (!blob.size) f.push(new Uint8Array(0), true);
    for (let o = 0; o < blob.size; o += SLICE) {
      const chunk = new Uint8Array(await blob.slice(o, Math.min(blob.size, o + SLICE)).arrayBuffer());
      f.push(chunk, o + SLICE >= blob.size);
      if (error) throw error;
      if (pendingSize >= FOLD) fold();
    }
  }
  zip.end();
  if (error) throw error;
  if (!done) throw new Error("The ZIP could not be completed.");
  fold();
  return new Blob(parts, { type });
}
