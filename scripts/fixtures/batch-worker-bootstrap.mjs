// 实际 Node Worker 中加载生产 Worker；只适配 Web Worker 的消息接口，不替换运行内核。
import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const port = parentPort;
if (!port) throw new Error("必须在 Node Worker 内运行");
const scope = { onmessage: null, postMessage: message => port.postMessage(message) };
globalThis.self = scope;
await import("../../src/workers/batch.worker.ts");
port.on("message", data => {
  if (data?.type === "fixture-close") { port.close(); return; }
  scope.onmessage?.({ data });
});
port.postMessage({ type: "fixture-ready" });
