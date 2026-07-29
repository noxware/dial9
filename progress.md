# Unexpected implementation findings

- `upstream/main` has only a whole-slice Rust decoder. A WASM extension cannot
  process arbitrary input chunks without either retaining the complete trace or
  duplicating the D9TF parser inside the SDK. The implementation therefore adds
  an incremental decoder API to `dial9-trace-format`; this does not change the
  wire format, encoder, recorder, or JavaScript decoder.
- The UI's frozen-core boundary check includes benchmark sources. The extension
  benchmark must consume D9TF through the typed `lib/trace` barrel rather than
  importing `trace_parser.js` directly.
- Custom-event `u64`/varint fields are decimal strings to preserve wire
  precision. Interactive field views therefore accept finite numeric strings
  in addition to JavaScript numbers and bigints.
- The new viewer's transactional loader returns the retained decompressed D9TF
  buffer only after a successful parse. Extension fanout therefore starts from
  that buffer; failed or cancelled replacements leave the current extension
  panels intact.
- `upstream/main` now locks both `syn` 2 and 3. The extension proc-macro's
  lockfile dependency must name `syn 2.0.119` explicitly for `--locked` builds.
