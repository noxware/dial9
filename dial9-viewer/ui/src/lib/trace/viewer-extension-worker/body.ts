import { fetchTraceStream } from "../../../../trace_parser.js";
import type { FetchOptions } from "../../../../trace_parser.js";
import {
  DEFAULT_EXTENSION_WASM_POLICY_LIMITS,
  validateExtensionWasm,
} from "../extension-wasm-policy.ts";
import type {
  ViewerExtensionOutputBuffer,
  ViewerExtensionWorkerPost,
  ViewerExtensionWorkerRequest,
  ViewerExtensionWorkerStart,
} from "./protocol.js";

const TRACE_HEADER = [0x54, 0x52, 0x43, 0x00] as const;
const TRACE_HEADER_BYTES = 5;
const VIEWER_EXTENSION_TAG = 0x07;
const MAX_EXTENSION_COUNT = 8;
const MAX_EXTENSION_NAME_BYTES = 4096;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_MEMORY_PAGES = 2048;
const MAX_ERROR_BYTES = 64 * 1024;
const ABI_VERSION = 1;

interface EmbeddedModule {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface RetainedModule extends EmbeddedModule {
  readonly nameBytes: Uint8Array;
}

interface ExtensionExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly dial9_abi_version: () => number;
  readonly dial9_input_alloc: (length: number) => number;
  readonly dial9_push: (length: number) => number;
  readonly dial9_finish: () => number;
  readonly dial9_output_ptr: () => number;
  readonly dial9_output_len: () => number;
  readonly dial9_error_ptr: () => number;
  readonly dial9_error_len: () => number;
}

interface ActiveExtension {
  readonly name: string;
  readonly exports: ExtensionExports;
  readonly maximumMemoryPages?: number;
  disabled: boolean;
}

export interface ViewerExtensionWorkerBody {
  handle(message: ViewerExtensionWorkerRequest): void;
}

export interface ViewerExtensionWorkerBodyDeps {
  /**
   * Open one decompressed source. The worker calls this once per URL, eagerly
   * and in URL order, with `request.urls` containing exactly that URL.
   */
  readonly openStream?: (
    request: ViewerExtensionWorkerStart,
    signal: AbortSignal,
  ) => Promise<AsyncIterator<Uint8Array>>;
  readonly instantiate?: (
    module: EmbeddedModule,
  ) => Promise<ActiveExtension>;
}

class SourceCursor {
  private chunk: Uint8Array | null = null;
  private offset = 0;
  private eof = false;

  constructor(private readonly stream: AsyncIterator<Uint8Array>) {}

  private async ensureChunk(): Promise<boolean> {
    while (
      !this.eof &&
      (this.chunk === null || this.offset === this.chunk.byteLength)
    ) {
      const next = await this.stream.next();
      if (next.done) {
        this.eof = true;
        this.chunk = null;
        return false;
      }
      if (next.value.byteLength === 0) continue;
      this.chunk = next.value;
      this.offset = 0;
    }
    return this.chunk !== null;
  }

  async peekByte(): Promise<number | null> {
    return (await this.ensureChunk()) ? this.chunk![this.offset]! : null;
  }

  advanceByte(): void {
    this.offset += 1;
  }

  async consume(
    length: number,
    visit?: (bytes: Uint8Array, offset: number) => void,
  ): Promise<boolean> {
    let consumed = 0;
    while (consumed < length) {
      if (!(await this.ensureChunk())) return false;
      const available = this.chunk!.byteLength - this.offset;
      const take = Math.min(length - consumed, available);
      visit?.(this.chunk!.subarray(this.offset, this.offset + take), consumed);
      this.offset += take;
      consumed += take;
    }
    return true;
  }

  takeRemainder(): Uint8Array | null {
    if (this.chunk === null || this.offset === this.chunk.byteLength) return null;
    const remainder = this.chunk.subarray(this.offset);
    this.chunk = null;
    this.offset = 0;
    return remainder;
  }

  isAtEof(): boolean {
    return this.eof;
  }
}

interface StrippedPreamble {
  readonly header: Uint8Array;
  readonly remainder: Uint8Array | null;
  readonly modules: readonly RetainedModule[];
  readonly mismatch?: string;
  readonly atEof: boolean;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function bytesEqualAt(
  actual: Uint8Array,
  expected: Uint8Array,
  expectedOffset: number,
): boolean {
  for (let index = 0; index < actual.byteLength; index += 1) {
    if (actual[index] !== expected[expectedOffset + index]) return false;
  }
  return true;
}

async function consumeViewerExtensionPreamble(
  stream: AsyncIterator<Uint8Array>,
  expected: readonly RetainedModule[] | null,
  sourceNumber: number,
): Promise<StrippedPreamble> {
  const cursor = new SourceCursor(stream);
  const headerStorage = new Uint8Array(TRACE_HEADER_BYTES);
  let headerLength = 0;
  await cursor.consume(TRACE_HEADER_BYTES, (bytes, offset) => {
    headerStorage.set(bytes, offset);
    headerLength += bytes.byteLength;
  });
  const header = headerStorage.subarray(0, headerLength);
  const validHeader =
    headerLength === TRACE_HEADER_BYTES &&
    TRACE_HEADER.every((byte, index) => header[index] === byte);
  if (!validHeader) {
    return {
      header,
      remainder: cursor.takeRemainder(),
      modules: [],
      ...(expected === null
        ? {}
        : {
            mismatch:
              `viewer-extension bundle in source ${sourceNumber} cannot be ` +
              "verified because the trace header is invalid",
          }),
      atEof: cursor.isAtEof(),
    };
  }

  const modules: RetainedModule[] = [];
  const names = new Set<string>();
  let moduleIndex = 0;
  let mismatch: string | undefined;
  const noteMismatch = (): void => {
    mismatch ??=
      `viewer-extension bundle in source ${sourceNumber} does not match source 1`;
  };

  for (;;) {
    const tag = await cursor.peekByte();
    if (tag === null || tag !== VIEWER_EXTENSION_TAG) break;
    cursor.advanceByte();
    if (moduleIndex >= MAX_EXTENSION_COUNT) {
      throw new Error(
        `viewer-extension count exceeds ${MAX_EXTENSION_COUNT} in source ${sourceNumber}`,
      );
    }

    const frameHeader = new Uint8Array(6);
    if (
      !(await cursor.consume(frameHeader.byteLength, (bytes, offset) => {
        frameHeader.set(bytes, offset);
      }))
    ) {
      throw new Error(`truncated viewer-extension frame in source ${sourceNumber}`);
    }
    const frameView = new DataView(frameHeader.buffer);
    const nameLength = frameView.getUint16(0, true);
    const moduleLength = frameView.getUint32(2, true);
    if (nameLength > MAX_EXTENSION_NAME_BYTES) {
      throw new Error(
        `viewer-extension name exceeds ${MAX_EXTENSION_NAME_BYTES} bytes in ` +
          `source ${sourceNumber}`,
      );
    }
    if (moduleLength > DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxModuleBytes) {
      throw new Error(
        `viewer-extension module is ${moduleLength} bytes; limit is ` +
          `${DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxModuleBytes}`,
      );
    }

    if (expected === null) {
      const nameBytes = new Uint8Array(nameLength);
      if (
        !(await cursor.consume(nameLength, (bytes, offset) => {
          nameBytes.set(bytes, offset);
        }))
      ) {
        throw new Error(
          `truncated viewer-extension name in source ${sourceNumber}`,
        );
      }
      let name: string;
      try {
        name = UTF8_DECODER.decode(nameBytes);
      } catch {
        throw new Error(
          `viewer-extension name is not valid UTF-8 in source ${sourceNumber}`,
        );
      }
      if (name.length === 0) {
        throw new Error(`viewer-extension name is empty in source ${sourceNumber}`);
      }
      if (names.has(name)) {
        throw new Error(
          `duplicate viewer-extension name ${JSON.stringify(name)} in ` +
            `source ${sourceNumber}`,
        );
      }

      const bytes = new Uint8Array(moduleLength);
      if (
        !(await cursor.consume(moduleLength, (part, offset) => {
          bytes.set(part, offset);
        }))
      ) {
        throw new Error(
          `truncated viewer-extension payload in source ${sourceNumber}`,
        );
      }
      names.add(name);
      modules.push({ name, nameBytes, bytes });
    } else {
      const expectedModule = expected[moduleIndex];
      let nameMatches =
        expectedModule !== undefined &&
        nameLength === expectedModule.nameBytes.byteLength;
      if (
        !(await cursor.consume(nameLength, (bytes, offset) => {
          if (
            nameMatches &&
            !bytesEqualAt(bytes, expectedModule!.nameBytes, offset)
          ) {
            nameMatches = false;
          }
        }))
      ) {
        throw new Error(
          `truncated viewer-extension name in source ${sourceNumber}`,
        );
      }

      let moduleMatches =
        expectedModule !== undefined &&
        moduleLength === expectedModule.bytes.byteLength;
      if (
        !(await cursor.consume(moduleLength, (bytes, offset) => {
          if (
            moduleMatches &&
            !bytesEqualAt(bytes, expectedModule!.bytes, offset)
          ) {
            moduleMatches = false;
          }
        }))
      ) {
        throw new Error(
          `truncated viewer-extension payload in source ${sourceNumber}`,
        );
      }
      if (!nameMatches || !moduleMatches) noteMismatch();
    }
    moduleIndex += 1;
  }

  // A normalized retained trace has already removed repeated bundles from
  // sources after the first. Therefore a later source may carry either no
  // extension frames or the exact first-source bundle, but never a partial or
  // different non-empty bundle.
  if (
    expected !== null &&
    moduleIndex > 0 &&
    moduleIndex !== expected.length
  ) {
    noteMismatch();
  }
  return {
    header,
    remainder: cursor.takeRemainder(),
    modules,
    ...(mismatch === undefined ? {} : { mismatch }),
    atEof: cursor.isAtEof(),
  };
}

function encodeViewerExtensionPreamble(
  header: Uint8Array,
  modules: readonly RetainedModule[],
): Uint8Array {
  const byteLength = modules.reduce(
    (total, module) =>
      total + 7 + module.nameBytes.byteLength + module.bytes.byteLength,
    header.byteLength,
  );
  const bytes = new Uint8Array(byteLength);
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  let offset = header.byteLength;
  for (const module of modules) {
    view.setUint8(offset, VIEWER_EXTENSION_TAG);
    view.setUint16(offset + 1, module.nameBytes.byteLength, true);
    view.setUint32(offset + 3, module.bytes.byteLength, true);
    offset += 7;
    bytes.set(module.nameBytes, offset);
    offset += module.nameBytes.byteLength;
    bytes.set(module.bytes, offset);
    offset += module.bytes.byteLength;
  }
  return bytes;
}

function unsigned(value: number): number {
  return value >>> 0;
}

function memorySlice(
  extension: ActiveExtension,
  pointerValue: number,
  lengthValue: number,
  limit: number,
  what: string,
): Uint8Array {
  const pointer = unsigned(pointerValue);
  const length = unsigned(lengthValue);
  if (length > limit) throw new Error(`${what} is ${length} bytes; limit is ${limit}`);
  const end = pointer + length;
  const memory = extension.exports.memory.buffer;
  if (!Number.isSafeInteger(end) || end > memory.byteLength) {
    throw new Error(`${what} points outside WebAssembly memory`);
  }
  return new Uint8Array(memory, pointer, length);
}

function extensionError(extension: ActiveExtension): string {
  try {
    const bytes = memorySlice(
      extension,
      extension.exports.dial9_error_ptr(),
      extension.exports.dial9_error_len(),
      MAX_ERROR_BYTES,
      "extension error",
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) || "extension failed";
  } catch (error) {
    return error instanceof Error ? error.message : "extension failed";
  }
}

async function instantiateExtension(
  module: EmbeddedModule,
  maximumMemoryPages: number,
): Promise<ActiveExtension> {
  const compiled = await WebAssembly.compile(module.bytes);
  const instance = await WebAssembly.instantiate(compiled, {});
  const exports = instance.exports as unknown as ExtensionExports;
  const extension: ActiveExtension = {
    name: module.name,
    exports,
    maximumMemoryPages,
    disabled: false,
  };
  if (unsigned(exports.dial9_abi_version()) !== ABI_VERSION) {
    throw new Error(
      `ABI version is ${unsigned(exports.dial9_abi_version())}; expected ${ABI_VERSION}`,
    );
  }
  return extension;
}

async function defaultOpenStream(
  request: ViewerExtensionWorkerStart,
  signal: AbortSignal,
): Promise<AsyncIterator<Uint8Array>> {
  if (request.urls.length !== 1) {
    throw new Error("viewer-extension source opener needs exactly one URL");
  }
  const fetchOptions: FetchOptions = { signal };
  if (request.headers !== undefined) {
    fetchOptions.headers = { ...request.headers };
  }
  const iterable = await fetchTraceStream(request.urls[0]!, fetchOptions);
  return iterable[Symbol.asyncIterator]();
}

interface TransferableChunk {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

interface QueuedChunk {
  readonly main: Uint8Array;
  readonly guest: Uint8Array;
}

function transferableChunk(chunk: Uint8Array): TransferableChunk {
  if (chunk.buffer instanceof ArrayBuffer) {
    return {
      buffer: chunk.buffer,
      byteOffset: chunk.byteOffset,
      byteLength: chunk.byteLength,
    };
  }
  const copy = chunk.slice();
  return {
    buffer: copy.buffer,
    byteOffset: 0,
    byteLength: copy.byteLength,
  };
}

function copyInput(extension: ActiveExtension, chunk: Uint8Array): number {
  const pointer = unsigned(extension.exports.dial9_input_alloc(chunk.byteLength));
  const target = memorySlice(
    extension,
    pointer,
    chunk.byteLength,
    chunk.byteLength,
    "extension input",
  );
  target.set(chunk);
  return chunk.byteLength;
}

/**
 * Pure worker body. The outer worker is disposable; termination is the
 * authoritative limit for compilation or guest code that never returns.
 */
export function createViewerExtensionWorkerBody(
  post: ViewerExtensionWorkerPost,
  deps: ViewerExtensionWorkerBodyDeps = {},
): ViewerExtensionWorkerBody {
  const controller = new AbortController();
  const queuedChunks: QueuedChunk[] = [];
  const warnings: string[] = [];
  let streamPromises: readonly Promise<AsyncIterator<Uint8Array>>[] = [];
  let stream: AsyncIterator<Uint8Array> | null = null;
  let sourceIndex = 0;
  let sourceAtEof = false;
  let bundleModules: readonly RetainedModule[] = [];
  let extensions: ActiveExtension[] = [];
  let started = false;
  let ready = false;
  let pulling = false;
  let finished = false;

  const reportError = (error: unknown): void => {
    if (finished) return;
    finished = true;
    controller.abort();
    const value = error as { name?: unknown; message?: unknown } | null;
    post({
      kind: "error",
      name: typeof value?.name === "string" ? value.name : "Error",
      message:
        typeof value?.message === "string" ? value.message : String(error),
    });
  };

  const queuePreamble = (
    preamble: StrippedPreamble,
    preserveBundle: boolean,
  ): void => {
    if (preamble.header.byteLength > 0) {
      queuedChunks.push({
        main: preserveBundle
          ? encodeViewerExtensionPreamble(preamble.header, bundleModules)
          : preamble.header,
        guest: preamble.header,
      });
    }
    if (preamble.remainder !== null && preamble.remainder.byteLength > 0) {
      queuedChunks.push({
        main: preamble.remainder,
        guest: preamble.remainder,
      });
    }
    sourceAtEof = preamble.atEof;
  };

  const prepareSource = async (index: number): Promise<void> => {
    sourceIndex = index;
    stream = await streamPromises[index]!;
    const preamble = await consumeViewerExtensionPreamble(
      stream,
      index === 0 ? null : bundleModules,
      index + 1,
    );
    if (index === 0) {
      bundleModules = preamble.modules;
    } else if (preamble.mismatch !== undefined) {
      warnings.push(preamble.mismatch);
      for (const extension of extensions) extension.disabled = true;
    }
    queuePreamble(preamble, index === 0);
  };

  const initialize = async (request: ViewerExtensionWorkerStart): Promise<void> => {
    if (request.urls.length === 0) throw new Error("viewer-extension worker needs a URL");
    const openStream = deps.openStream ?? defaultOpenStream;
    streamPromises = request.urls.map((url) => {
      const sourceRequest: ViewerExtensionWorkerStart = {
        kind: "start",
        urls: [url],
        ...(request.headers === undefined ? {} : { headers: request.headers }),
      };
      const promise = openStream(sourceRequest, controller.signal);
      // Later sources start fetching concurrently. Attach a handler now so a
      // failure cannot become an unhandled rejection before its ordered turn.
      promise.catch(() => {});
      return promise;
    });
    await prepareSource(0);

    // Fetch/decompression above is trusted I/O and remains abortable, but is not
    // charged to the untrusted-code deadline. Everything after this message may
    // compile, instantiate, or call the guest.
    post({ kind: "initializing" });
    const active: ActiveExtension[] = [];
    let totalMemoryPages = 0;
    for (const module of bundleModules) {
      try {
        let extension: ActiveExtension;
        if (deps.instantiate !== undefined) {
          extension = await deps.instantiate(module);
          const maximumMemoryPages = extension.maximumMemoryPages ?? 0;
          if (
            totalMemoryPages + maximumMemoryPages >
            MAX_TOTAL_MEMORY_PAGES
          ) {
            throw new Error(
              `declared memory would exceed the aggregate ` +
                `${MAX_TOTAL_MEMORY_PAGES}-page limit`,
            );
          }
          totalMemoryPages += maximumMemoryPages;
        } else {
          const policy = validateExtensionWasm(module.bytes);
          if (!policy.ok) {
            throw new Error(`${policy.error.code}: ${policy.error.message}`);
          }
          const maximumMemoryPages = policy.metadata.memory.maximumPages;
          if (totalMemoryPages + maximumMemoryPages > MAX_TOTAL_MEMORY_PAGES) {
            throw new Error(
              `declared memory would exceed the aggregate ` +
                `${MAX_TOTAL_MEMORY_PAGES}-page limit`,
            );
          }
          // Reserve before instantiation. A module whose ABI call traps may
          // leave its allocated memory alive until worker GC, so failed
          // instances must still count against the worker's peak.
          totalMemoryPages += maximumMemoryPages;
          extension = await instantiateExtension(module, maximumMemoryPages);
        }
        active.push(extension);
      } catch (error) {
        warnings.push(
          `${module.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    extensions = active;
    ready = true;
    post({
      kind: "ready",
      extensions: extensions.map(({ name }) => name),
      warnings: [...warnings],
    });
  };

  const disable = (extension: ActiveExtension, error: unknown): void => {
    extension.disabled = true;
    warnings.push(
      `${extension.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const pushChunk = (mainChunk: Uint8Array, guestChunk = mainChunk): void => {
    const lengths = new Map<ActiveExtension, number>();
    const executing = extensions.some((extension) => !extension.disabled);
    if (executing) post({ kind: "executing" });
    for (const extension of extensions) {
      if (extension.disabled) continue;
      try {
        lengths.set(extension, copyInput(extension, guestChunk));
      } catch (error) {
        disable(extension, error);
      }
    }

    // Transfer the main-facing chunk first. The parser can decode it while this
    // worker executes dial9_push against the stripped guest-facing bytes.
    const outgoing = transferableChunk(mainChunk);
    post(
      {
        kind: "chunk",
        buffer: outgoing.buffer,
        byteOffset: outgoing.byteOffset,
        byteLength: outgoing.byteLength,
      },
      [outgoing.buffer],
    );

    for (const [extension, length] of lengths) {
      if (extension.disabled) continue;
      try {
        if (extension.exports.dial9_push(length) !== 0) {
          disable(extension, extensionError(extension));
        }
      } catch (error) {
        disable(extension, error);
      }
    }
    if (executing) post({ kind: "guest-ready" });
  };

  const finish = (): void => {
    post({ kind: "finishing" });
    const outputs: ViewerExtensionOutputBuffer[] = [];
    const transfer: ArrayBuffer[] = [];
    let totalOutputBytes = 0;
    for (const extension of extensions) {
      if (extension.disabled) continue;
      try {
        if (extension.exports.dial9_finish() !== 0) {
          disable(extension, extensionError(extension));
          continue;
        }
        const outputLength = unsigned(extension.exports.dial9_output_len());
        if (totalOutputBytes + outputLength > MAX_TOTAL_OUTPUT_BYTES) {
          throw new Error(
            `aggregate extension output exceeds ${MAX_TOTAL_OUTPUT_BYTES} bytes`,
          );
        }
        const view = memorySlice(
          extension,
          extension.exports.dial9_output_ptr(),
          outputLength,
          MAX_OUTPUT_BYTES,
          "extension output",
        );
        const buffer = view.slice().buffer;
        totalOutputBytes += buffer.byteLength;
        outputs.push({ name: extension.name, buffer });
        transfer.push(buffer);
      } catch (error) {
        disable(extension, error);
      }
    }
    finished = true;
    post({ kind: "done", outputs, warnings: [...warnings] }, transfer);
  };

  const pull = async (): Promise<void> => {
    if (!ready || stream === null) throw new Error("worker is not ready");
    if (pulling) throw new Error("concurrent viewer-extension pull");
    pulling = true;
    try {
      for (;;) {
        const queued = queuedChunks.shift();
        if (queued !== undefined) {
          pushChunk(queued.main, queued.guest);
          return;
        }
        if (!sourceAtEof) {
          const next = await stream.next();
          if (!next.done) {
            if (next.value.byteLength === 0) continue;
            pushChunk(next.value);
            return;
          }
          sourceAtEof = true;
        }
        const nextSource = sourceIndex + 1;
        if (nextSource >= streamPromises.length) {
          finish();
          return;
        }
        await prepareSource(nextSource);
      }
    } finally {
      pulling = false;
    }
  };

  return {
    handle(message: ViewerExtensionWorkerRequest): void {
      if (message.kind === "start") {
        if (started) {
          reportError(new Error("viewer-extension worker already started"));
          return;
        }
        started = true;
        initialize(message).catch(reportError);
        return;
      }
      if (!started || finished) {
        reportError(new Error("viewer-extension worker cannot pull now"));
        return;
      }
      pull().catch(reportError);
    },
  };
}
