import type { ColumnarBatch } from "../columnar.js";
import type { ExtensionManifest } from "../manifest.js";

export interface ExtensionWorkerInitRequest {
  readonly kind: "init";
  readonly instance_id: string;
  readonly file_name: string;
  readonly wasm: ArrayBuffer;
}

export interface ExtensionWorkerPushRequest {
  readonly kind: "push";
  readonly chunk: ArrayBuffer;
}

export interface ExtensionWorkerFinishRequest {
  readonly kind: "finish";
}

export interface ExtensionWorkerAbortRequest {
  readonly kind: "abort";
}

export type ExtensionWorkerRequest =
  | ExtensionWorkerInitRequest
  | ExtensionWorkerPushRequest
  | ExtensionWorkerFinishRequest
  | ExtensionWorkerAbortRequest;

export interface ExtensionWorkerReadyMessage {
  readonly kind: "ready";
  readonly instance_id: string;
  readonly file_name: string;
  readonly manifest: ExtensionManifest;
}

export interface ExtensionWorkerBatchMessage {
  readonly kind: "batch";
  readonly batch: ColumnarBatch;
}

export interface ExtensionWorkerCompleteMessage {
  readonly kind: "complete";
}

export interface ExtensionWorkerErrorMessage {
  readonly kind: "error";
  readonly name: string;
  readonly message: string;
}

export type ExtensionWorkerResponse =
  | ExtensionWorkerReadyMessage
  | ExtensionWorkerBatchMessage
  | ExtensionWorkerCompleteMessage
  | ExtensionWorkerErrorMessage;

export type ExtensionWorkerPost = (
  message: ExtensionWorkerResponse,
  transfer?: readonly ArrayBuffer[],
) => void;

export interface ExtensionWorkerBody {
  handle(message: ExtensionWorkerRequest): void;
}

export interface ExtensionWorkerPort {
  postMessage(
    message: ExtensionWorkerRequest,
    transfer?: readonly ArrayBuffer[],
  ): void;
  onMessage(callback: (message: ExtensionWorkerResponse) => void): void;
  onError(callback: (error: unknown) => void): void;
  terminate(): void;
}

export type ExtensionWorkerFactory = () => ExtensionWorkerPort;
