import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import process from "node:process";

const MAX_RELEASE_BYTES = 128 * 1024;
const MANIFEST_SECTION = "dial9.viewer.manifest";

const wasmPath = process.argv[2];
if (wasmPath === undefined || process.argv.length !== 3) {
  console.error(
    "usage: node scripts/verify-viewer-extension-wasm.mjs <extension.wasm>",
  );
  process.exit(2);
}

const bytes = await fs.readFile(wasmPath);
assert.ok(bytes.byteLength > 0, "WASM artifact is empty");
assert.ok(
  bytes.byteLength <= MAX_RELEASE_BYTES,
  `WASM artifact is ${bytes.byteLength} bytes; expected at most ${MAX_RELEASE_BYTES}`,
);

const module = await WebAssembly.compile(bytes);
assert.deepEqual(
  WebAssembly.Module.imports(module),
  [],
  "viewer extensions must not import host capabilities",
);

const manifestSections = WebAssembly.Module.customSections(
  module,
  MANIFEST_SECTION,
);
assert.equal(
  manifestSections.length,
  1,
  `expected exactly one ${MANIFEST_SECTION} custom section`,
);

const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
  manifestSections[0],
);
const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, 1, "viewer extension manifest must be version 1");
assert.ok(Array.isArray(manifest.tables), "manifest tables must be an array");
assert.ok(Array.isArray(manifest.panels), "manifest panels must be an array");

console.log(
  `viewer extension WASM: ${bytes.byteLength} bytes, 0 imports, manifest v1`,
);
