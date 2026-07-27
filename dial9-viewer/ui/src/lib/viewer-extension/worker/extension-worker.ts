import { createExtensionWorkerBody } from "./body.js";
import type { ExtensionWorkerRequest } from "./protocol.js";

interface DedicatedWorkerScope {
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as DedicatedWorkerScope;
const body = createExtensionWorkerBody((message, transfer) => {
  scope.postMessage(message, transfer);
});

scope.onmessage = (event: MessageEvent): void => {
  body.handle(event.data as ExtensionWorkerRequest);
};
