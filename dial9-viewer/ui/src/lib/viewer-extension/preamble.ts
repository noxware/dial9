const TRACE_MAGIC = [0x54, 0x52, 0x43, 0x00] as const;
const HEADER_BYTES = 5;
const EMBEDDED_FILE_TAG = 0x07;
const EMBEDDED_FILE_HEADER_BYTES = 7;

export interface ScannedEmbeddedFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export class ExtensionPreambleError extends Error {
  constructor(message: string) {
    super(`Invalid trace attachment preamble: ${message}`);
    this.name = "ExtensionPreambleError";
  }
}

class ByteQueue {
  #chunks: Uint8Array[] = [];
  #headIndex = 0;
  #headOffset = 0;
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.byteLength;
  }

  at(index: number): number {
    if (index < 0 || index >= this.#length) throw new RangeError("queue index");
    let remaining = index + this.#headOffset;
    for (let index = this.#headIndex; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index]!;
      if (remaining < chunk.byteLength) return chunk[remaining]!;
      remaining -= chunk.byteLength;
    }
    throw new RangeError("queue index");
  }

  take(length: number): Uint8Array {
    if (length < 0 || length > this.#length) throw new RangeError("queue take");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this.#chunks[this.#headIndex]!;
      const available = head.byteLength - this.#headOffset;
      const count = Math.min(available, length - written);
      result.set(
        head.subarray(this.#headOffset, this.#headOffset + count),
        written,
      );
      written += count;
      this.#headOffset += count;
      this.#length -= count;
      if (this.#headOffset === head.byteLength) {
        this.#headIndex += 1;
        this.#headOffset = 0;
      }
    }
    if (this.#headIndex > 64 && this.#headIndex * 2 > this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#headIndex);
      this.#headIndex = 0;
    }
    return result;
  }

  clear(): void {
    this.#chunks = [];
    this.#headIndex = 0;
    this.#headOffset = 0;
    this.#length = 0;
  }
}

/**
 * Incrementally discovers only the first D9TF header's contiguous attachment
 * preamble. It never parses ordinary frames or later headers.
 */
export class FirstPreambleScanner {
  #queue = new ByteQueue();
  #files: ScannedEmbeddedFile[] = [];
  #headerRead = false;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(chunk: Uint8Array): readonly ScannedEmbeddedFile[] | undefined {
    if (this.#closed) return undefined;
    this.#queue.push(chunk);
    return this.#scan();
  }

  finish(): readonly ScannedEmbeddedFile[] {
    if (this.#closed) return [];
    const result = this.#scan();
    if (result !== undefined) return result;
    if (!this.#headerRead) {
      throw new ExtensionPreambleError("truncated D9TF header");
    }
    if (this.#queue.length !== 0) {
      throw new ExtensionPreambleError("truncated embedded file");
    }
    return this.#close();
  }

  #scan(): readonly ScannedEmbeddedFile[] | undefined {
    if (!this.#headerRead) {
      if (this.#queue.length < HEADER_BYTES) return undefined;
      const header = this.#queue.take(HEADER_BYTES);
      for (let index = 0; index < TRACE_MAGIC.length; index += 1) {
        if (header[index] !== TRACE_MAGIC[index]) {
          throw new ExtensionPreambleError("missing D9TF header");
        }
      }
      this.#headerRead = true;
    }

    while (this.#queue.length !== 0) {
      if (this.#queue.at(0) !== EMBEDDED_FILE_TAG) return this.#close();
      if (this.#queue.length < EMBEDDED_FILE_HEADER_BYTES) return undefined;
      const nameLength = this.#queue.at(1) | (this.#queue.at(2) << 8);
      const dataLength =
        this.#queue.at(3) |
        (this.#queue.at(4) << 8) |
        (this.#queue.at(5) << 16) |
        (this.#queue.at(6) << 24);
      const unsignedDataLength = dataLength >>> 0;
      const frameLength =
        EMBEDDED_FILE_HEADER_BYTES + nameLength + unsignedDataLength;
      if (!Number.isSafeInteger(frameLength)) {
        throw new ExtensionPreambleError("embedded file length overflows");
      }
      if (this.#queue.length < frameLength) return undefined;

      this.#queue.take(EMBEDDED_FILE_HEADER_BYTES);
      const nameBytes = this.#queue.take(nameLength);
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      } catch {
        throw new ExtensionPreambleError(
          "embedded file name is not valid UTF-8",
        );
      }
      if (name.length === 0) {
        throw new ExtensionPreambleError("embedded file name is empty");
      }
      this.#files.push({
        name,
        data: this.#queue.take(unsignedDataLength),
      });
    }
    return undefined;
  }

  #close(): readonly ScannedEmbeddedFile[] {
    this.#closed = true;
    this.#queue.clear();
    const files = this.#files;
    this.#files = [];
    return files;
  }
}
