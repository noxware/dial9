# Progress

- Local `.bin.gz` drops were retained compressed even though URL-streamed
  traces retain decompressed bytes. The extension adapter normalizes local
  input once before both parsers so post-trace WASM replay always receives the
  same decompressed D9TF bytes.
- D9TF does not guarantee global event order, while the current CPU panel sorts
  every resource sample before differencing. Exact arbitrary reordering and
  bounded one-pass output are incompatible; the reference extension preserves
  bounded streaming for recorder-produced order and treats backward timestamps
  as gaps.
- Because the manifest remains a static custom section and the SDK deliberately
  has no JSON parser, the guest validates batch rectangularity and encodings
  while the host validates table IDs, column order, types, and nullability
  against the manifest. This keeps one schema-validation implementation instead
  of making generated and handwritten output follow different paths.
- The existing D9TF decoder is tied to one borrowed slice and cannot resume on a
  new chunk. Bounded decoding without duplicating private format internals
  required adding a non-breaking `StreamingDecoder` API to
  `dial9-trace-format`; the wire format, encoder, recorder, and existing decoder
  behavior remain unchanged.
- The legacy Set Range action filters events while reparsing, whereas an
  extension consumes the retained complete D9TF stream and is clipped to the
  resulting viewport. A CPU interval crossing the hard-filter boundary can
  therefore differ because the extension still sees the preceding sample.
- Node can measure the exact guest input and validated output copies, but does
  not faithfully reproduce browser Worker scheduling or `postMessage`
  cloning. This required a separate Playwright transport probe which captures
  real batch shapes and measures production fanout copy + transfer + ack, a
  prepared-transfer control, and Worker-to-main transfer +
  `ExtensionStore.append`.
- Pointer interaction initially rebuilt visible domains independently for
  coordinate lookup, hit testing, and presentation, and reran viewport reducers
  on every mouse move. Finalized stores make layout and aggregate results
  safely cacheable by viewport; reducers without an unambiguous temporal
  mapping now produce a local panel error instead of silently using all rows.
- The legacy loading path deliberately yields two animation frames before
  analysis. A replacement trace can arrive during that yield, so the extension
  generation must be rechecked afterwards before publishing the older trace.
