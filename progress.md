# Unexpected implementation findings

- `upstream/main` has only a whole-slice Rust decoder. A WASM extension cannot
  process arbitrary input chunks without either retaining the complete trace or
  duplicating the D9TF parser inside the SDK. The implementation therefore adds
  an incremental decoder API to `dial9-trace-format`; this does not change the
  wire format, encoder, recorder, or JavaScript decoder.
- The UI's frozen-core boundary check includes benchmark sources. The extension
  benchmark must consume D9TF through the typed `lib/trace` barrel rather than
  importing `trace_parser.js` directly.
