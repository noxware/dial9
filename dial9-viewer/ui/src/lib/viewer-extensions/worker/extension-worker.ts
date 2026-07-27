/// <reference lib="webworker" />

import { createExtensionWorkerBody } from "./body.js";
import type {
  ExtensionWorkerRequest,
  ExtensionWorkerResponse,
} from "./protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const body = createExtensionWorkerBody(
  (message: ExtensionWorkerResponse, transfer: Transferable[] = []) => {
    scope.postMessage(message, transfer);
  },
);

scope.onmessage = (event: MessageEvent<ExtensionWorkerRequest>): void => {
  body.handle(event.data);
};
