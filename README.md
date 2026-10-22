# Metadata Fixer

Restore capture dates, time zones, locations and device details on photos and videos whose metadata was lost: exports, transfers, messaging apps, Google Takeout.

Live: https://jamiecorby.github.io/metadata-fixer/

## How it works
- **Private by design.** ExifTool (Perl compiled to WebAssembly) reads and writes metadata in the browser. Files are never uploaded.
- **Evidence first.** Values are recovered, in order of reliability, from surviving tags, Google Takeout JSON sidecars, XMP sidecars, file names (Android, Pixel, Samsung, WhatsApp, screenshots, Signal, Snapchat, Dropbox, epoch timestamps), neighbouring files, the user's trip details, AI estimates and file modified times. Only strong evidence is applied automatically; every value shows its source and confidence.
- **Correct output.** DST-correct offsets from IANA time zones (zone looked up from GPS offline). Photos get EXIF dates + OffsetTime*, GPS with UTC GPS date/time stamps, and XMP mirrors. Videos get QuickTime UTC dates, Keys CreationDate with offset, and ISO 6709 location in Keys and UserData. Fill-missing mode never overwrites good data.
- **Verified.** Every written file is read back and compared with what was intended; an audit CSV records before/after, source and confidence.
- **Fast.** Files are processed in batches inside one ExifTool run (200 photos: c. 6 s to read, c. 25 s to write and verify on a laptop).

## Commercial backend (Supabase project `metadata-fixer`)
- `supabase/migrations`: profiles (credits), credit ledger, AI usage, per-user settings; row-level security; atomic credit functions callable only by the server.
- `supabase/functions/suggest`: AI proxy. Charges one credit, calls Claude, refunds automatically on failure. Never stores images.
- `supabase/functions/checkout`: Stripe Checkout for credit packs (prices defined server-side).
- `supabase/functions/stripe-webhook`: verifies Stripe signatures and adds credits exactly once per session.
- Secrets to set in Supabase: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (optional `AI_MODEL`).

## Develop
```
npm install
npm run build        # bundles src/ -> assets/, copies the engine to w/, writes index.html
npm test             # unit, engine, damaged-file, browser end-to-end and map suites (BASE=<url> tests a live site; PERF=1 adds the 200-file run)
```
Source lives in `src/`; `index.html`, `assets/`, `w/` and the legal pages at the root are build output served by GitHub Pages.
