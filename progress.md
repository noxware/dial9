# Progress

- Local `.bin.gz` drops were retained compressed even though URL-streamed
  traces retain decompressed bytes. The extension adapter normalizes local
  input once before both parsers so post-trace WASM replay always receives the
  same decompressed D9TF bytes.
