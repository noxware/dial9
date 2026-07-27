import type {
  RecordBatch,
  ViewerExtensionManifest,
} from "../types.js";

export interface ExtensionWorkerStart {
  readonly kind: "start";
  readonly id: string;
  readonly name: string;
  readonly module: ArrayBuffer;
}

export interface ExtensionWorkerInput {
  readonly kind: "input";
  readonly bytes: ArrayBuffer;
}

export interface ExtensionWorkerFinish {
  readonly kind: "finish";
}

export type ExtensionWorkerRequest =
  | ExtensionWorkerStart
  | ExtensionWorkerInput
  | ExtensionWorkerFinish;

export interface ExtensionWorkerReady {
  readonly kind: "ready";
  readonly id: string;
  readonly name: string;
  readonly manifest: ViewerExtensionManifest;
}

export interface ExtensionWorkerBatch {
  readonly kind: "batch";
  readonly batch: RecordBatch;
}

export interface ExtensionWorkerComplete {
  readonly kind: "complete";
}

export interface ExtensionWorkerError {
  readonly kind: "error";
  readonly name: string;
  readonly message: string;
}

export type ExtensionWorkerResponse =
  | ExtensionWorkerReady
  | ExtensionWorkerBatch
  | ExtensionWorkerComplete
  | ExtensionWorkerError;

export type WorkerPost = (
  message: ExtensionWorkerResponse,
  transfer?: Transferable[],
) => void;

export interface ExtensionWorkerPort {
  postMessage(message: ExtensionWorkerRequest, transfer?: Transferable[]): void;
  onMessage(callback: (message: ExtensionWorkerResponse) => void): void;
  onError(callback: (error: unknown) => void): void;
  terminate(): void;
}

export type ExtensionWorkerFactory = () => ExtensionWorkerPort;
