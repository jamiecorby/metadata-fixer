// Public configuration. The Supabase URL and publishable key are safe to ship to browsers.
export const CONFIG = {
  supabaseUrl: "https://xdoaleatsyvvwwqkomkq.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhkb2FsZWF0c3l2dnd3cWtvbWtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MzU4NzIsImV4cCI6MjEwODExMTg3Mn0.SpB5glXInvcYYbOiLSNv11woe9Y3w7RDb1h3-8LN6kE",
  starterCredits: 25,
  packs: [
    { id: "pack_100", credits: 100, price: "$5", note: "c. 5 cents per suggestion" },
    { id: "pack_500", credits: 500, price: "$19", note: "Best for a big library", featured: true },
    { id: "pack_2000", credits: 2000, price: "$59", note: "Archivists and families" },
  ],
  supportUrl: "https://github.com/jamiecorby/metadata-fixer/issues",
  wasm: { gz: "w/zeroperl.wasm.gz", raw: "w/zeroperl.wasm", size: 25358252 },
};
