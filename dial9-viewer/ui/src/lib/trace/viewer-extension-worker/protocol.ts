export const MAX_VIEWER_EXTENSION_COUNT = 8;

export interface ViewerExtensionWorkerStart {
  readonly kind: "start";
  readonly urls: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ViewerExtensionWorkerNext {
  readonly kind: "next";
}

export interface ViewerExtensionWorkerLocalModule {
  readonly name: string;
  readonly buffer: ArrayBuffer;
}

/** Start a disposable session over modules supplied by the local viewer UI. */
export interface ViewerExtensionWorkerLocalStart {
  readonly kind: "start-local";
  readonly modules: readonly ViewerExtensionWorkerLocalModule[];
}

/** One bounded copy from the viewer's retained decompressed trace buffer. */
export interface ViewerExtensionWorkerLocalChunk {
  readonly kind: "local-chunk";
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface ViewerExtensionWorkerLocalFinish {
  readonly kind: "local-finish";
}

export type ViewerExtensionWorkerRequest =
  | ViewerExtensionWorkerStart
  | ViewerExtensionWorkerNext
  | ViewerExtensionWorkerLocalStart
  | ViewerExtensionWorkerLocalChunk
  | ViewerExtensionWorkerLocalFinish;

export interface ViewerExtensionWorkerReady {
  readonly kind: "ready";
  readonly extensions: readonly string[];
  readonly warnings: readonly string[];
}

/** Module validation, compilation, and instantiation are about to run. */
export interface ViewerExtensionWorkerInitializing {
  readonly kind: "initializing";
}

/** One or more guest ABI calls for the current chunk are about to run. */
export interface ViewerExtensionWorkerExecuting {
  readonly kind: "executing";
}

/** Every guest ABI call for the current chunk returned. */
export interface ViewerExtensionWorkerGuestReady {
  readonly kind: "guest-ready";
}

export interface ViewerExtensionWorkerChunk {
  readonly kind: "chunk";
  readonly buffer: ArrayBuffer;
  /** Logical byte view; the transferred backing buffer may include stripped bytes. */
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface ViewerExtensionOutputBuffer {
  readonly name: string;
  readonly buffer: ArrayBuffer;
}

export interface ViewerExtensionWorkerDone {
  readonly kind: "done";
  readonly outputs: readonly ViewerExtensionOutputBuffer[];
  readonly warnings: readonly string[];
}

/** The final guest call has started; no more trace chunks will be emitted. */
export interface ViewerExtensionWorkerFinishing {
  readonly kind: "finishing";
}

export interface ViewerExtensionWorkerError {
  readonly kind: "error";
  readonly name: string;
  readonly message: string;
}

export type ViewerExtensionWorkerResponse =
  | ViewerExtensionWorkerInitializing
  | ViewerExtensionWorkerReady
  | ViewerExtensionWorkerExecuting
  | ViewerExtensionWorkerGuestReady
  | ViewerExtensionWorkerChunk
  | ViewerExtensionWorkerFinishing
  | ViewerExtensionWorkerDone
  | ViewerExtensionWorkerError;

export type ViewerExtensionWorkerPost = (
  message: ViewerExtensionWorkerResponse,
  transfer?: ArrayBuffer[],
) => void;

export interface ViewerExtensionWorkerPort {
  postMessage(
    message: ViewerExtensionWorkerRequest,
    transfer?: readonly ArrayBuffer[],
  ): void;
  onMessage(fn: (message: ViewerExtensionWorkerResponse) => void): void;
  onError(fn: (error: unknown) => void): void;
  terminate(): void;
}

export type ViewerExtensionWorkerFactory = () => ViewerExtensionWorkerPort;
