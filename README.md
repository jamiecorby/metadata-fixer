# Metadata Fixer

Restore dates, GPS and iPhone details on photos and videos whose metadata was lost or corrupted.

- Runs entirely in your browser: ExifTool compiled to WebAssembly (`w/p0-p2.wasm`, loaded once). Your files are never uploaded.
- Optional AI suggestions (date and rough location from the image) use your own Anthropic API key, sent directly from your browser to api.anthropic.com.
- iPhone-style device profiles matched to date, month and area constraints, naming patterns, saved templates, Share / Save to Photos, ZIP for multi-folder batches.

Live: https://jamiecorby.github.io/metadata-fixer/
