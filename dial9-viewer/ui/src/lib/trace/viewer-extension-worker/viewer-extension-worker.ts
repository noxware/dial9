import { createViewerExtensionWorkerBody } from "./body.js";
import type {
  ViewerExtensionWorkerRequest,
  ViewerExtensionWorkerResponse,
} from "./protocol.js";

const body = createViewerExtensionWorkerBody((message, transfer = []) => {
  globalThis.postMessage(message, { transfer });
});

globalThis.onmessage = (
  event: MessageEvent<ViewerExtensionWorkerRequest>,
): void => {
  body.handle(event.data);
};

export type { ViewerExtensionWorkerResponse };
