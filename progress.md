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
- The TypeScript host normalizes manifests into fresh typed structures and
  resolves every known table, column, scale, scalar, reducer, and channel
  reference up front. Unknown versioned components remain as panel-local
  errors. ABI output is copied only after schema, alignment, pointer, length,
  validity, offset, and allocation-free UTF-8 validation; main keeps the
  resulting buffers chunked and decodes individual strings lazily.
- Module loading compiles inside the dedicated Worker, rejects every import,
  requires exactly one manifest section, instantiates with an empty import
  object, and verifies the numeric ABI. Worker messages are serialized through
  one queue; each push drains and acknowledges guest output before transferring
  validated column buffers to main, while abort or failure remains local to
  that instance.
- A segmented first-preamble scanner handles every chunk boundary without
  repeatedly concatenating a growing Wasm file. The coordinator sends chunks
  immediately to already-known Workers, retains only the discovery prefix,
  starts embedded `.wasm` instances at preamble close, replays that prefix once,
  then fans out later chunks with one transferable copy per instance and no
  credits. Stores publish atomically only on `complete`; failures discard one
  instance without affecting modules with identical table names.
- The component engine reads immutable chunked columns without rematerializing
  rows, lazily decodes UTF-8, indexes ordered X channels, clips interval
  reducers to the viewport, and preserves arbitrary source order only for
  `polyline/v1`. Drawing, reverse-Z hit testing, tooltip, swatch, and readout
  presentation all consume the same normalized manifest tables.
- `viewer.html` is now a Vite entry only to load a thin TypeScript adapter; its
  classic parser and panels remain in place. Buffered, gzip, and URL-streaming
  loads fan decompressed chunks out without awaiting Workers, while range
  reparses reuse published extension output. Dropped Wasm runs either against
  the retained current trace or as a pending module on the next load.
- Exact CPU presentation required two reusable manifest controls omitted from
  the initial examples: drawing `opacity` and display
  `max_fraction_digits`. Precision is independent from units, so custom units
  remain plain suffixes and the viewer does not special-case `cores`.
- `examples/viewer-extension-demo` exercises the public contract without
  ergonomic builders: fixed manifest-order `TableId`s and user-owned column
  vectors produce CPU, independently nullable context-switch series, and the
  source-order dinosaur/fire paths. Missing context fields do not suppress
  otherwise valid CPU samples.
- The opt-in `test:viewer-extension-demo` check compiles the real zero-import
  guest, generates a temporary trace with its Wasm attachment, streams it
  through the production ABI at irregular boundaries, and validates the
  resulting tables, reducers, tooltips, and lazy UTF-8.
- A queue-depth contract fixture composes an interval area plus three step
  series on two scales, three independent swatches, cursor-sampled values, and
  a viewport reducer. It requires no queue-specific component behavior.
- Dense ordered interval/line renderers now bound Canvas geometry with
  source-ordered first/min/max/last representatives per horizontal pixel while
  retaining null gaps. Hit testing narrows the original X index around the
  pointer, so sampling does not change tooltip rows; arbitrary-order
  `polyline/v1` remains lossless.
