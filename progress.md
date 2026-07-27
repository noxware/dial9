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
