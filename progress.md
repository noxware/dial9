# Progress

- `EmbeddedFile` lives in `dial9-trace-format` because it is a generic D9TF
  frame, not a viewer-extension type. `borrowed` and `owned` validate the wire
  widths at construction; names are opaque labels and are not deduplicated.
- The Rust and JavaScript decoders enforce the contiguous embedded-file
  preamble after every D9TF header. The full `dial9-trace-format` suite,
  including Rust-to-JavaScript parity, passes.
