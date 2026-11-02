import assert from "node:assert/strict";
import { compareTrace, solveSchedule } from "./trace-contract.mjs";

const ids = ["pure", "comp", "mahony", "madg", "kalman"];
const schedule = solveSchedule(20, 500);
const frames = () => schedule.map(({ t, dt }, i) => ({
  t, dt, quats: ids.map(() => ({ w: 1, x: 0, y: 0, z: 0 })), aligned: i === 9,
  raw: { gyro: [1, 2, 3], accel: [0, 0, 9.8], mag: [30, 0, 40] },
  consumed: { accel: [0, 0, 9.8], mag: [25, 0, 40] },
}));
const events = () => ({ alignTimes: [0.02], eventCounts: { align: 1 } });
const compare = (a, b, opts = {}) => compareTrace(a, b, ids, 0.04, 20, { schedule, leftEvents: events(), rightEvents: events(), ...opts });
assert.equal(compare(frames(), frames()).ok, true);
const cases = [
  ["双方错误dt", (a, b) => { a[5].dt = b[5].dt = 900; }],
  ["双方错误排程", (a, b) => { a[5].t = b[5].t = 0.011; }],
  ["双方删内部帧", (a, b) => { a.splice(5, 1); b.splice(5, 1); }],
  ["null帧", (a) => { a[5] = null; }],
  ["缺姿态", (a) => { delete a[5].quats; }],
  ["NaN首时刻", (a) => { a[0].t = NaN; }],
  ["非单位q", (a) => { a[0].quats[0].w = 2; }],
  ["双方丢事件标记", (a, b) => { a[9].aligned = b[9].aligned = false; }],
  ["输入NaN", (a) => { a[0].raw.gyro[0] = NaN; }],
  ["消费值变化", (a) => { a[0].consumed.mag[0] = 20; }],
];
for (const [name, mutate] of cases) {
  const a = frames(); const b = frames(); mutate(a, b);
  assert.equal(compare(a, b).ok, false, name);
}
assert.equal(compare(frames(), frames(), { rightEvents: { alignTimes: [], eventCounts: {} } }).ok, false);
assert.equal(compareTrace(frames(), frames(), ids.map(() => "pure"), 0.04, 20).ok, false);
console.log(`[PASS] 独立trace判定 — 正向fixture及${cases.length + 2}类坏结构/双侧错误/事件丢失反例`);
