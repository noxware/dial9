import {
  copyOutputBatch,
  readGuestError,
  validateExtensionExports,
  type ExtensionAbiExports,
} from "./abi.js";
import type { ColumnarBatch } from "./columnar.js";
import {
  parseExtensionManifestBytes,
  VIEWER_EXTENSION_MANIFEST_SECTION,
  type ExtensionManifest,
} from "./manifest.js";

export class ExtensionModuleError extends Error {
  constructor(message: string) {
    super(`Invalid viewer extension module: ${message}`);
    this.name = "ExtensionModuleError";
  }
}

function fail(message: string): never {
  throw new ExtensionModuleError(message);
}

function guestFailure(
  exports: ExtensionAbiExports,
  operation: string,
): never {
  const detail = readGuestError(exports);
  return fail(
    detail.length === 0
      ? `guest ${operation} failed`
      : `guest ${operation} failed: ${detail}`,
  );
}

function wasmMemoryBuffer(memory: WebAssembly.Memory): ArrayBuffer {
  const buffer = memory.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    return fail("shared WebAssembly memory is unsupported");
  }
  return buffer;
}

function u32(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    return fail(`${name} is not a u32`);
  }
  return value;
}

export interface ExtensionGuest {
  readonly manifest: ExtensionManifest;
  readonly linearMemoryByteLength: number;
  push(chunk: Uint8Array): ColumnarBatch[];
  finish(): ColumnarBatch[];
}

class WasmExtensionGuest implements ExtensionGuest {
  readonly manifest: ExtensionManifest;
  readonly #exports: ExtensionAbiExports;
  #finished = false;

  constructor(manifest: ExtensionManifest, exports: ExtensionAbiExports) {
    this.manifest = manifest;
    this.#exports = exports;
  }

  get linearMemoryByteLength(): number {
    return wasmMemoryBuffer(this.#exports.memory).byteLength;
  }

  push(chunk: Uint8Array): ColumnarBatch[] {
    if (this.#finished) return fail("cannot push after finish");
    const length = u32(chunk.byteLength, "input length");
    const pointer = u32(
      this.#exports.dial9_input_reserve(length),
      "input pointer",
    );
    const buffer = wasmMemoryBuffer(this.#exports.memory);
    const end = pointer + length;
    if (!Number.isSafeInteger(end) || end > buffer.byteLength) {
      return fail("input range is outside WebAssembly memory");
    }
    new Uint8Array(buffer, pointer, length).set(chunk);
    if (this.#exports.dial9_push(length) !== 0) {
      return guestFailure(this.#exports, "push");
    }
    return this.#drain();
  }

  finish(): ColumnarBatch[] {
    if (this.#finished) return fail("finish may only be called once");
    this.#finished = true;
    if (this.#exports.dial9_finish() !== 0) {
      return guestFailure(this.#exports, "finish");
    }
    return this.#drain();
  }

  #drain(): ColumnarBatch[] {
    const batches: ColumnarBatch[] = [];
    for (;;) {
      const status = this.#exports.dial9_output_next();
      if (status === 0) return batches;
      if (status === -1) return guestFailure(this.#exports, "output");
      if (status !== 1) return fail(`dial9_output_next returned ${status}`);

      const pointer = this.#exports.dial9_output_descriptor_ptr();
      const length = this.#exports.dial9_output_descriptor_len();
      const batch = copyOutputBatch(
        this.#exports.memory,
        pointer,
        length,
        this.manifest,
      );
      if (this.#exports.dial9_output_ack() !== 0) {
        return guestFailure(this.#exports, "output ack");
      }
      batches.push(batch);
    }
  }
}

export async function loadExtensionModule(
  bytes: BufferSource,
): Promise<ExtensionGuest> {
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`WebAssembly compilation failed: ${message}`);
  }

  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    return fail(
      `module declares ${imports.length} import${imports.length === 1 ? "" : "s"}`,
    );
  }

  const sections = WebAssembly.Module.customSections(
    module,
    VIEWER_EXTENSION_MANIFEST_SECTION,
  );
  if (sections.length !== 1) {
    return fail(
      `expected exactly one ${VIEWER_EXTENSION_MANIFEST_SECTION} custom section; found ${sections.length}`,
    );
  }
  const manifest = parseExtensionManifestBytes(new Uint8Array(sections[0]!));

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`WebAssembly instantiation failed: ${message}`);
  }
  const exports = validateExtensionExports(instance.exports);
  return new WasmExtensionGuest(manifest, exports);
}
