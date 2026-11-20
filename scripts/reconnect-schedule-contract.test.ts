import assert from "node:assert/strict";
import { scheduleReconnect, scheduleTransportReconnect, type ReconnectEventSink } from "../src/core/reconnect-schedule";

const calls: string[] = [];
function run(canRetry: boolean, plan: { attempt: number; delayMs: number; exhausted: boolean } | null): void {
  scheduleReconnect(
    canRetry,
    () => plan,
    () => calls.push("gap"),
    () => calls.push("abandon"),
    () => calls.push("exhausted"),
    (value) => calls.push(`plan:${value.attempt}`),
  );
}
run(false, null);
assert.deepEqual(calls, ["gap"]);
calls.length = 0;
run(true, null);
assert.deepEqual(calls, ["gap", "abandon"]);
calls.length = 0;
run(true, { attempt: 3, delayMs: 0, exhausted: true });
assert.deepEqual(calls, ["gap", "exhausted"]);
calls.length = 0;
run(true, { attempt: 1, delayMs: 1000, exhausted: false });
assert.deepEqual(calls, ["gap", "plan:1"]);
console.log("reconnect-schedule-contract: 4 PASS / 0 FAIL");

// 传输级编排：串口/BLE 共用一份话术与事件，差异只由参数注入。
const events: string[] = [];
const statuses: string[] = [];
const sink: ReconnectEventSink = {
  dataGap: (active, reason) => events.push(`gap:${active}:${reason}`),
  dataReconnect: (status, detail) => events.push(`${status}:${JSON.stringify(detail)}`),
};
function runTransport(canRetry: boolean, plan: { attempt: number; delayMs: number; exhausted: boolean } | null, useSink = true): string[] {
  const lifecycle: string[] = [];
  scheduleTransportReconnect(
    useSink ? sink : null, "serial", "掉线", 3, "检查线缆",
    canRetry, () => plan,
    () => lifecycle.push("reconnecting"),
    () => lifecycle.push("abandon"),
    (text, isError) => statuses.push(`${isError}:${text}`),
  );
  return lifecycle;
}
events.length = 0; statuses.length = 0;
assert.deepEqual(runTransport(true, { attempt: 2, delayMs: 1000, exhausted: false }), ["reconnecting"]);
assert.deepEqual(events, ["gap:true:掉线", 'attempt:{"transport":"serial","attempt":2,"max":3,"delayMs":1000}']);
assert.match(statuses[0], /^true:掉线——1 s 后自动重连（第 2\/3 次）…$/);
console.log("reconnect-schedule-contract: 5 PASS / 0 FAIL");

events.length = 0; statuses.length = 0;
assert.deepEqual(runTransport(true, { attempt: 3, delayMs: 0, exhausted: true }), ["abandon"]);
assert.deepEqual(events, ["gap:true:掉线", 'exhausted:{"transport":"serial","max":3}']);
assert.match(statuses[0], /^true:掉线——自动重连 3 次仍失败，检查线缆$/);
console.log("reconnect-schedule-contract: 6 PASS / 0 FAIL");

events.length = 0; statuses.length = 0;
assert.deepEqual(runTransport(false, null), []);
assert.deepEqual(events, ["gap:true:掉线"]);
assert.equal(statuses.length, 0);
assert.deepEqual(runTransport(true, { attempt: 1, delayMs: 7000, exhausted: false }, false), ["reconnecting"]);
assert.match(statuses[0], /第 1\/3 次/);
console.log("reconnect-schedule-contract: 7 PASS / 0 FAIL");
