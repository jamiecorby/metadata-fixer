// Low-level browser cache (IndexedDB). One object store of key -> value; values are Blobs or plain JSON.
// Nothing here knows about photos, steps or timing. It never uses the network.
const DB = "mf-cache", STORE = "k";
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
      r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return dbp;
}
async function run(mode, fn) {
  const db = await open(); if (!db) throw new Error("The browser cache is not available.");
  return new Promise((res, rej) => {
    let req; const tx = db.transaction(STORE, mode);
    try { req = fn(tx.objectStore(STORE)); } catch (e) { try { tx.abort(); } catch (er) {} return rej(e); }
    tx.oncomplete = () => res(req && "result" in req ? req.result : undefined);
    tx.onerror = () => rej(tx.error || new Error("cache write failed"));
    tx.onabort = () => rej(tx.error || new Error("cache write aborted"));
  });
}
export const available = async () => !!(await open());
export const put = (k, v) => run("readwrite", (s) => s.put(v, k));
export const get = (k) => run("readonly", (s) => s.get(k));
export const del = (keys) => run("readwrite", (s) => { let r; for (const k of keys) r = s.delete(k); return r; });
export const keys = () => run("readonly", (s) => s.getAllKeys());
export const clear = () => run("readwrite", (s) => s.clear());
export async function room() { try { const e = await navigator.storage.estimate(); return Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch (er) { return 2e9; } }
