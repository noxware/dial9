# Progress

- `EmbeddedFile` lives in `dial9-trace-format` because it is a generic D9TF
  frame, not a viewer-extension type. `borrowed` and `owned` validate the wire
  widths at construction; names are opaque labels and are not deduplicated.
- The Rust and JavaScript decoders enforce the contiguous embedded-file
  preamble after every D9TF header. The full `dial9-trace-format` suite,
  including Rust-to-JavaScript parity, passes.
- `RecorderBuilder::embedded_file` owns only registration; `SegmentWriter`
  writes the same files before metadata and clock sync in each physical
  segment. The initial clock sync is deferred until the first batch so no
  non-preamble frame can precede attachments.
- The viewer parser exposes copied attachments from only the first D9TF header
  of a logical load. The decoder tracks the consumed header ordinal so this
  remains correct across concatenated segments and arbitrary streaming chunk
  boundaries; copying is required before the streaming buffer prefix is
  discarded.
- `dial9-trace-format::StreamingDecoder` now feeds zero-copy event callbacks
  from arbitrary chunks while retaining only an incomplete frame suffix. It
  consumes repeated attachment preambles internally and enforces the same
  placement rules as the slice decoder.
- The extension SDK moves user-owned column `Vec`s into an output queue and
  exposes their buffers through fixed numeric descriptors until host `ack`;
  it does not build a second guest-side payload. The SDK validates rectangular
  batches, validity bitmaps, and UTF-8, while the host is responsible for
  matching table IDs and column types/nullability against the static manifest.
- `manifest!` emits exactly one compacted `dial9.viewer.manifest` custom section
  without JSON dependencies. A compiled smoke module had zero imports, the
  expected ABI exports, and preserved whitespace and escapes inside strings.
- `docs/design/viewer-extensions.md` is the maintained public contract. It
  makes the ABI descriptor, manifest/component model, trust boundary,
  first-preamble activation, Worker lifecycle, rendering semantics, versioning,
  and acceptance fixtures explicit. Concurrent startup retains only the first
  preamble prefix long enough to discover Workers and replay it to them.
