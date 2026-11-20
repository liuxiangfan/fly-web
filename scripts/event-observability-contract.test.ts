/**
 * F-03（分轴误差/可观性解释）与 F-05（事件时间轴）纯基础层的独立契约测试。
 *
 * 不启动浏览器、不改 main.ts：
 *  1. 事件环形缓冲的容量/淘汰/runId 隔离/同刻排序/过滤/最近事件与深拷贝；
 *  2. EdgeTracker 只在状态边沿发事件，连续拒绝不炸成逐帧记录，reset 不补假 end；
 *  3. axisErrorView 与 runner 的 so3ErrorSplit 在纯偏航、纯倾角、倾斜与万向节锁邻域一致；
 *  4. 现有遥测只能支持保守状态：纯积分 not-applicable；卡尔曼按显式接受字段区分；
 *     互补/Mahony/Madgwick 没有 applied 字段时使用 unrecorded，不猜“已修正”；
 *  5. 说明文案不把单步拒绝写成整体系统结论。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EdgeTracker,
  EventTimeline,
  type LearningEventInput,
} from "../src/core/event-timeline";
import {
  FUSION_ACCEL_GATE_DEG,
  KALMAN_ANGLE_GATE_DEG,
  KALMAN_CHI2_GATE_THRESHOLD,
  axisErrorView,
  describeObservation,
  explainExistingTelemetry,
  type ObservationOptions,
  type ObservationState,
} from "../src/core/observability";
import { so3ErrorSplit } from "../src/core/runner";
import { DEG, qAngleBetween, qFromAxisAngle, qFromEuler, qId, RAD, type Quat } from "../src/core/quat";
import type { EstimatorTelemetry } from "../src/estimators";

let pass = 0;
let fail = 0;

function test(name: string, body: () => void): void {
  try {
    body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function approx(actual: number, expected: number, eps = 1e-9, label = "数值"): void {
  assert.ok(Number.isFinite(actual), `${label} 不是有限数：${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${label} 期望 ${expected}，实际 ${actual}`);
}

function makeEvent(overrides: Partial<LearningEventInput> = {}): LearningEventInput {
  return {
    t: 1,
    kind: "custom",
    estimator: null,
    phase: "instant",
    summary: "事件",
    source: "solve-loop",
    ...overrides,
  };
}

function makeTelemetry(overrides: Partial<EstimatorTelemetry> = {}): EstimatorTelemetry {
  return {
    rate: [0, 0, 0],
    rawGyro: [0, 0, 0],
    correction: [0, 0, 0],
    predictedGravity: [0, 0, 1],
    measuredGravity: [0, 0, 1],
    accelNorm: 9.80665,
    accelValid: true,
    magValid: false,
    detail: {},
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ObservationOptions> = {}): ObservationOptions {
  return { magEnabled: true, gateEnabled: true, ...overrides };
}

test("EventTimeline: 默认容量 512，环形淘汰与 dropped 精确", () => {
  const defaults = new EventTimeline();
  assert.equal(defaults.capacity, 512);
  assert.equal(defaults.size, 0);
  assert.equal(defaults.dropped, 0);
  assert.equal(defaults.currentRunId, null);
  assert.throws(() => new EventTimeline(0), /capacity/);
  assert.throws(() => new EventTimeline(1.5), /capacity/);

  const tl = new EventTimeline(3);
  tl.reset(1);
  for (let i = 0; i < 5; i++) tl.add(1, makeEvent({ t: i, summary: `e${i}` }));
  assert.equal(tl.size, 3);
  assert.equal(tl.dropped, 2);
  assert.deepEqual(tl.list().map((event) => event.summary), ["e2", "e3", "e4"]);
  assert.deepEqual(tl.list().map((event) => event.seq), [3, 4, 5]);
  assert.equal(tl.atSeq(1), null);
  assert.equal(tl.atSeq(2), null);
  assert.equal(tl.atSeq(5)?.summary, "e4");

  tl.reset(1);
  assert.equal(tl.size, 0);
  assert.equal(tl.dropped, 0);
  assert.equal(tl.atSeq(5), null);
});

test("EventTimeline: runId 隔离，reset 清空旧轮且拒绝串轮写入", () => {
  const tl = new EventTimeline(8);
  assert.throws(() => tl.reset(-1), /runId/);
  tl.reset(10);
  const first = tl.add(10, makeEvent({ summary: "run10-1" }));
  assert.equal(first.runId, 10);
  assert.equal(first.seq, 1);

  assert.throws(() => tl.add(11, makeEvent()), /runId/);
  assert.equal(tl.size, 1);
  assert.equal(tl.dropped, 0);
  const second = tl.add(10, makeEvent({ summary: "run10-2" }));
  assert.equal(second.seq, 2, "被拒绝的 add 不得消耗 seq");

  tl.reset(11);
  assert.equal(tl.size, 0);
  assert.equal(tl.dropped, 0);
  assert.deepEqual(tl.list({ runId: 10 }), []);
  assert.equal(tl.atSeq(1), null);
  const third = tl.add(11, makeEvent({ summary: "run11-1" }));
  assert.equal(third.runId, 11);
  assert.equal(third.seq, 1);
  assert.deepEqual(tl.list({ runId: 11 }).map((event) => event.summary), ["run11-1"]);

  tl.clear();
  assert.equal(tl.size, 0);
  assert.equal(tl.dropped, 0);
  assert.equal(tl.currentRunId, null);
});

test("EventTimeline: 同一时刻按 seq 稳定排序，list 输出确定", () => {
  const tl = new EventTimeline(10);
  tl.reset(3);
  tl.add(3, makeEvent({ t: 5, summary: "a" }));
  tl.add(3, makeEvent({ t: 1, summary: "b" }));
  tl.add(3, makeEvent({ t: 5, summary: "c" }));
  tl.add(3, makeEvent({ t: 1, summary: "d" }));
  assert.deepEqual(tl.list().map((event) => event.summary), ["b", "d", "a", "c"]);
  assert.deepEqual(tl.list().map((event) => event.seq), [2, 4, 1, 3]);
  assert.equal(JSON.stringify(tl.list()), JSON.stringify(tl.list()));
  assert.notEqual(tl.list(), tl.list(), "list 每次返回新数组");
});

test("EventTimeline: 类别/估计器/时间/runId 过滤与 atSeq", () => {
  const tl = new EventTimeline(16);
  tl.reset(4);
  tl.add(4, makeEvent({ t: 0, kind: "align", estimator: "all", summary: "align" }));
  tl.add(4, makeEvent({ t: 1, kind: "gate-reject", estimator: "comp", phase: "start", summary: "reject-start" }));
  tl.add(4, makeEvent({ t: 2, kind: "gate-recovery", estimator: "comp", phase: "end", summary: "recovery-end" }));
  tl.add(4, makeEvent({ t: 3, kind: "custom", estimator: null, source: "user-action", summary: "user" }));
  tl.add(4, makeEvent({ t: 4, kind: "data-gap", estimator: "kalman", phase: "start", source: "transport", summary: "gap" }));

  assert.deepEqual(tl.list({ kind: "gate-reject" }).map((event) => event.summary), ["reject-start"]);
  assert.deepEqual(tl.list({ kind: ["align", "custom"] }).map((event) => event.summary), ["align", "user"]);
  assert.deepEqual(tl.list({ estimator: "comp" }).map((event) => event.summary), ["reject-start", "recovery-end"]);
  assert.deepEqual(tl.list({ estimator: null }).map((event) => event.summary), ["user"]);
  assert.deepEqual(tl.list({ estimator: "all" }).map((event) => event.summary), ["align"]);
  assert.deepEqual(tl.list({ since: 1, until: 3 }).map((event) => event.summary), ["reject-start", "recovery-end", "user"]);
  assert.deepEqual(
    tl.list({ kind: "custom", estimator: null, since: 3, until: 3 }).map((event) => event.summary),
    ["user"],
  );
  assert.deepEqual(tl.list({ kind: [] }), []);
  assert.deepEqual(tl.list({ runId: 999 }), []);
  assert.throws(() => tl.list({ since: Number.NaN }), /since/);
  assert.throws(() => tl.list({ until: Number.POSITIVE_INFINITY }), /until/);
  assert.throws(() => tl.list({ runId: -1 }), /runId/);

  assert.equal(tl.atSeq(2)?.summary, "reject-start");
  assert.equal(tl.atSeq(999), null);
  assert.equal(tl.atSeq(Number.NaN), null);
});

test("EventTimeline: 深拷贝证据，入口与出口都不可变，JSON 可序列化", () => {
  const tl = new EventTimeline(4);
  tl.reset(1);
  const before: Record<string, unknown> = { nested: { v: 1 }, arr: [1, { x: 2 }], text: "原" };
  const after: Record<string, unknown> = { ok: true };
  const input = makeEvent({ before, after });
  const stored = tl.add(1, input);

  before.nested = { v: 99 };
  (before.arr as unknown[])[1] = { x: 99 };
  after.ok = false;
  assert.deepEqual(stored.before, { nested: { v: 1 }, arr: [1, { x: 2 }], text: "原" });
  assert.notEqual(stored.before, input.before);

  const fetched = tl.atSeq(stored.seq);
  assert.ok(fetched);
  (fetched.before as { nested: { v: number } }).nested.v = 42;
  assert.deepEqual(tl.atSeq(stored.seq)?.before, { nested: { v: 1 }, arr: [1, { x: 2 }], text: "原" });
  assert.equal(typeof JSON.stringify(tl.list()), "string");
});

test("EventTimeline: 拒绝类实例/循环引用/非有限证据且不消耗 seq", () => {
  class Box {
    value = 1;
  }
  const tl = new EventTimeline(4);
  tl.reset(1);
  const first = tl.add(1, makeEvent({ summary: "first" }));
  assert.equal(first.seq, 1);

  assert.throws(() => tl.add(1, makeEvent({ before: new Box() })), /纯对象|可序列化/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => tl.add(1, makeEvent({ after: cycle })), /循环/);
  assert.throws(() => tl.add(1, makeEvent({ before: { bad: Number.NaN } })), /有限/);
  assert.throws(() => tl.add(1, makeEvent({ t: Number.POSITIVE_INFINITY })), /有限/);
  assert.equal(tl.size, 1);

  const second = tl.add(1, makeEvent({ summary: "second" }));
  assert.equal(second.seq, 2);
});

test("EventTimeline: nearest 的平局规则与空窗处理", () => {
  const tl = new EventTimeline(10);
  assert.equal(tl.nearest(0), null);
  tl.reset(1);
  assert.equal(tl.nearest(0), null);
  tl.add(1, makeEvent({ t: 0, summary: "zero" }));
  tl.add(1, makeEvent({ t: 2, summary: "two-a" }));
  tl.add(1, makeEvent({ t: 2, summary: "two-b" }));
  tl.add(1, makeEvent({ t: 5, summary: "five" }));

  assert.equal(tl.nearest(1)?.summary, "zero", "等距取更早时间");
  assert.equal(tl.nearest(2)?.summary, "two-a", "同 t 取更小 seq");
  assert.equal(tl.nearest(2.1)?.summary, "two-a");
  assert.equal(tl.nearest(3.5)?.summary, "two-a", "等距且 t 不同取更早时间");
  assert.equal(tl.nearest(4)?.summary, "five");
  assert.throws(() => tl.nearest(Number.NaN), /有限/);
});

test("EdgeTracker: 只发边沿，连续 100 帧只形成一对 start/end", () => {
  const tracker = new EdgeTracker();
  const calls: string[] = [];
  const onStart = (key: string, t: number): void => {
    calls.push(`start:${key}:${t}`);
  };
  const onEnd = (key: string, t: number): void => {
    calls.push(`end:${key}:${t}`);
  };

  assert.equal(tracker.step("accel", true, 0, onStart, onEnd), "start");
  assert.equal(tracker.step("accel", true, 0.1, onStart, onEnd), null);
  assert.equal(tracker.step("mag", true, 0.2, onStart, onEnd), "start");
  assert.equal(tracker.step("accel", false, 0.3, onStart, onEnd), "end");
  assert.equal(tracker.step("accel", false, 0.4, onStart, onEnd), null);
  assert.deepEqual(calls, ["start:accel:0", "start:mag:0.2", "end:accel:0.3"]);
  assert.equal(tracker.size, 1);
  assert.deepEqual(tracker.activeKeys(), ["mag"]);
  assert.equal(tracker.isActive("accel"), false);

  tracker.reset("mag");
  assert.equal(calls.length, 3, "reset 不得补发 end");
  assert.equal(tracker.size, 0);
  assert.equal(tracker.step("mag", true, 1.0, onStart, onEnd), "start", "reset 后重新 true 应重新发 start");
  assert.deepEqual(calls.slice(-1), ["start:mag:1"]);
  tracker.reset();
  assert.equal(tracker.isActive("mag"), false);
  assert.equal(tracker.size, 0);

  const burst = new EdgeTracker();
  let transitions = 0;
  for (let i = 0; i < 100; i++) {
    burst.step("gate", true, i, () => {
      transitions++;
    });
  }
  assert.equal(transitions, 1);
  burst.step("gate", false, 100, undefined, () => {
    transitions++;
  });
  assert.equal(transitions, 2);
  assert.equal(burst.isActive("gate"), false);
});

test("EdgeTracker: 非法 key/active/time 有确定处理", () => {
  const tracker = new EdgeTracker();
  assert.throws(() => tracker.step("", true, 0), /key/);
  assert.throws(() => tracker.step("x", 1 as unknown as boolean, 0), /布尔/);
  assert.throws(() => tracker.step("x", true, Number.NaN), /有限/);
  assert.equal(tracker.step("x", false, 1), null, "首次 false 不是边沿");
});

test("axisErrorView: 纯偏航/纯倾角幅值并与 runner 同源对比", () => {
  const yawQ = qFromAxisAngle([0, 0, 1], 30 * RAD);
  const yaw = axisErrorView(yawQ);
  assert.ok(yaw);
  approx(yaw.tiltDeg, 0, 1e-9, "纯偏航 tilt");
  approx(yaw.yawDeg, 30, 1e-9, "纯偏航 yaw");
  approx(yaw.totalDeg, 30, 1e-9, "纯偏航 total");
  const yawRunner = so3ErrorSplit(yawQ, [0, 0, 1]);
  approx(yaw.tiltDeg, yawRunner.tiltDeg, 1e-9, "runner 纯偏航 tilt");
  approx(yaw.yawDeg, yawRunner.yawDeg, 1e-9, "runner 纯偏航 yaw");

  const tiltQ = qFromAxisAngle([1, 0, 0], 20 * RAD);
  const tilt = axisErrorView(tiltQ);
  assert.ok(tilt);
  approx(tilt.tiltDeg, 20, 1e-9, "纯倾角 tilt");
  approx(tilt.yawDeg, 0, 1e-9, "纯倾角 yaw");
  approx(tilt.totalDeg, 20, 1e-9, "纯倾角 total");
  const tiltRunner = so3ErrorSplit(tiltQ);
  approx(tilt.tiltDeg, tiltRunner.tiltDeg, 1e-9, "runner 纯倾角 tilt");
  approx(tilt.yawDeg, tiltRunner.yawDeg, 1e-9, "runner 纯倾角 yaw");
});

test("axisErrorView: 倾斜姿态、万向节锁邻域与 q/−q 对比 runner", () => {
  const cases: Array<[number, number, number]> = [
    [25, -15, 40],
    [60, 20, -120],
    [89, 0, 45],
    [0, 89, 30],
    [-45, 30, 170],
  ];
  for (const [roll, pitch, yawDeg] of cases) {
    const q = qFromEuler(roll * RAD, pitch * RAD, yawDeg * RAD);
    const view = axisErrorView(q);
    assert.ok(view, `${roll}/${pitch}/${yawDeg} 应有结果`);
    const runner = so3ErrorSplit(q, [0, 0, 1]);
    approx(view.tiltDeg, runner.tiltDeg, 1e-9, `${roll}/${pitch}/${yawDeg} tilt`);
    approx(view.yawDeg, runner.yawDeg, 1e-9, `${roll}/${pitch}/${yawDeg} yaw`);
    approx(view.totalDeg, qAngleBetween(q, qId()) * DEG, 1e-9, `${roll}/${pitch}/${yawDeg} total`);
    assert.ok(Number.isFinite(view.tiltDeg) && Number.isFinite(view.yawDeg));
  }

  const q = qFromEuler(25 * RAD, -15 * RAD, 40 * RAD);
  const negated: Quat = { w: -q.w, x: -q.x, y: -q.y, z: -q.z };
  const a = axisErrorView(q);
  const b = axisErrorView(negated);
  assert.ok(a);
  assert.ok(b);
  approx(a.tiltDeg, b.tiltDeg, 1e-9, "q/−q tilt");
  approx(a.yawDeg, b.yawDeg, 1e-9, "q/−q yaw");
  approx(a.totalDeg, b.totalDeg, 1e-9, "q/−q total");
});

test("axisErrorView: 无真值/零模长/非有限/无效重力轴返回 null", () => {
  assert.equal(axisErrorView(null), null);
  assert.equal(axisErrorView(undefined), null);
  assert.equal(axisErrorView({ w: 0, x: 0, y: 0, z: 0 }), null);
  assert.equal(axisErrorView({ w: Number.NaN, x: 0, y: 0, z: 0 }), null);
  assert.equal(axisErrorView({ w: 1, x: Number.POSITIVE_INFINITY, y: 0, z: 0 }), null);
  const q = qFromEuler(10 * RAD, 20 * RAD, 30 * RAD);
  assert.equal(axisErrorView(q, [0, 0, 0]), null);
  assert.equal(axisErrorView(q, [Number.NaN, 0, 1]), null);
});

test("axisErrorView: 非单位四元数先归一化", () => {
  const q = qFromEuler(10 * RAD, 20 * RAD, 30 * RAD);
  const scaled: Quat = { w: q.w * 7, x: q.x * 7, y: q.y * 7, z: q.z * 7 };
  const a = axisErrorView(q);
  const b = axisErrorView(scaled);
  assert.ok(a);
  assert.ok(b);
  approx(a.tiltDeg, b.tiltDeg, 1e-9, "非单位 tilt");
  approx(a.yawDeg, b.yawDeg, 1e-9, "非单位 yaw");
  approx(a.totalDeg, b.totalDeg, 1e-9, "非单位 total");
});

test("explainExistingTelemetry: 纯积分两通道 not-applicable，即使遥测有门控字段", () => {
  const telemetry = makeTelemetry({ accelAccepted: true, magAccepted: true, detail: { gateMode: 1 } });
  const view = explainExistingTelemetry("pure", telemetry, makeOptions());
  assert.equal(view.accel.state, "not-applicable");
  assert.equal(view.mag.state, "not-applicable");
  assert.equal(view.accel.reasonCode, "no-correction-channel");
  assert.equal(view.mag.reasonCode, "no-correction-channel");
  assert.equal(view.accel.explanationKey, "obs.accel.not-applicable");
  assert.equal(view.mag.explanationKey, "obs.mag.not-applicable");
  assert.equal("axisErrors" in view, false);
});

test("explainExistingTelemetry: 只有显式提供相对真值时才附 axisErrors", () => {
  const q = qFromAxisAngle([0, 0, 1], 12 * RAD);
  const withTruth = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ accelAccepted: true }),
    makeOptions({ relativeTruthQuat: q }),
  );
  const axis = withTruth.axisErrors;
  assert.ok(axis);
  approx(axis.yawDeg, 12, 1e-9, "附带的偏航误差");
  approx(axis.tiltDeg, 0, 1e-9, "附带的倾角误差");

  const noTruth = explainExistingTelemetry("kalman", makeTelemetry({ accelAccepted: true }), makeOptions());
  assert.equal("axisErrors" in noTruth, false);
  const nullTruth = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ accelAccepted: true }),
    makeOptions({ relativeTruthQuat: null }),
  );
  assert.equal("axisErrors" in nullTruth, true);
  assert.equal(nullTruth.axisErrors, null);
});

test("explainExistingTelemetry: 卡尔曼 applied/invalid/rejected/disabled 可区分", () => {
  const applied = explainExistingTelemetry(
    "kalman",
    makeTelemetry({
      accelValid: true,
      accelNorm: 9.8,
      accelAccepted: true,
      magValid: false,
      magAccepted: false,
      detail: { innoAccelDeg: 0.5, alignErrorDeg: 0.4, nisAccel: 1.2 },
    }),
    makeOptions({ magEnabled: false }),
  );
  assert.equal(applied.accel.state, "applied");
  assert.equal(applied.accel.reasonCode, "applied");
  assert.equal(applied.accel.evidence.norm, 9.8);
  assert.equal(applied.accel.evidence.angleDeg, 0.5);
  assert.equal(applied.accel.evidence.nis, 1.2);
  assert.equal(applied.mag.state, "disabled");
  assert.equal(applied.mag.reasonCode, "mag-disabled");

  const invalid = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ accelValid: false, accelNorm: 0, accelAccepted: false }),
    makeOptions(),
  );
  assert.equal(invalid.accel.state, "invalid");
  assert.equal(invalid.accel.reasonCode, "accel-norm-out-of-range");

  const rejected = explainExistingTelemetry(
    "kalman",
    makeTelemetry({
      accelValid: true,
      accelNorm: 9.8,
      accelAccepted: false,
      detail: { innoAccelDeg: 55, alignErrorDeg: 54, nisAccel: 3, accelRejectCode: 2, kalmanGateMode: 0 },
    }),
    makeOptions(),
  );
  assert.equal(rejected.accel.state, "rejected");
  assert.equal(rejected.accel.reasonCode, "gate-direction");
  assert.equal(rejected.accel.evidence.threshold, KALMAN_ANGLE_GATE_DEG);
  assert.equal(rejected.accel.evidence.angleDeg, 55);

  const unrecorded = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ accelValid: true, accelNorm: 9.8 }),
    makeOptions(),
  );
  assert.equal(unrecorded.accel.state, "unrecorded");
  assert.equal(unrecorded.accel.reasonCode, "not-recorded");
});

test("explainExistingTelemetry: 卡尔曼磁通道 disabled/invalid/rejected/applied 与 χ² 阈值", () => {
  const disabled = explainExistingTelemetry("kalman", makeTelemetry(), makeOptions({ magEnabled: false }));
  assert.equal(disabled.mag.state, "disabled");

  const invalid = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ magValid: false }),
    makeOptions({ magEnabled: true }),
  );
  assert.equal(invalid.mag.state, "invalid");
  assert.equal(invalid.mag.reasonCode, "mag-norm-out-of-range");

  const applied = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ magValid: true, magAccepted: true, detail: { innoMagDeg: 1.5, nisMag: 2.5 } }),
    makeOptions({ magEnabled: true }),
  );
  assert.equal(applied.mag.state, "applied");
  assert.equal(applied.mag.evidence.angleDeg, 1.5);
  assert.equal(applied.mag.evidence.nis, 2.5);

  const rejected = explainExistingTelemetry(
    "kalman",
    makeTelemetry({
      magValid: true,
      magAccepted: false,
      detail: { innoMagDeg: 52, nisMag: 30, magRejectCode: 3, kalmanGateMode: 0 },
    }),
    makeOptions({ magEnabled: true }),
  );
  assert.equal(rejected.mag.state, "rejected");
  assert.equal(rejected.mag.reasonCode, "gate-direction");
  assert.equal(rejected.mag.evidence.threshold, KALMAN_ANGLE_GATE_DEG);

  const mahalanobis = explainExistingTelemetry(
    "kalman",
    makeTelemetry({
      magValid: true,
      magAccepted: false,
      detail: { magRejectCode: 4, kalmanGateMode: 1, nisMag: 25, innoMagDeg: 20 },
    }),
    makeOptions({ magEnabled: true }),
  );
  assert.equal(mahalanobis.mag.state, "rejected");
  assert.equal(mahalanobis.mag.reasonCode, "gate-mahalanobis");
  assert.equal(mahalanobis.mag.evidence.threshold, KALMAN_CHI2_GATE_THRESHOLD);

  const thresholdOverride = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ magValid: true, magAccepted: false, detail: { magRejectCode: 4, kalmanGateMode: 1 } }),
    makeOptions({ magEnabled: true, threshold: 9.5 }),
  );
  assert.equal(thresholdOverride.mag.evidence.threshold, 9.5);

  const modeOverride = explainExistingTelemetry(
    "kalman",
    makeTelemetry({ accelValid: true, accelAccepted: false, detail: { nisAccel: 20 } }),
    makeOptions({ kalmanGateMode: "mahalanobis" }),
  );
  assert.equal(modeOverride.accel.state, "rejected");
  assert.equal(modeOverride.accel.reasonCode, "gate-mahalanobis");
  assert.equal(modeOverride.accel.evidence.threshold, KALMAN_CHI2_GATE_THRESHOLD);
});

test("explainExistingTelemetry: 互补/Mahony/Madgwick 无 applied 字段时用 unrecorded", () => {
  for (const id of ["comp", "mahony", "madg"] as const) {
    const telemetry = makeTelemetry({
      accelNorm: 9.8,
      accelValid: true,
      magValid: true,
      detail: { gateMode: 0, alignErrorDeg: 1 },
    });
    const view = explainExistingTelemetry(id, telemetry, makeOptions({ magEnabled: true, gateEnabled: true }));
    assert.equal(view.accel.state, "unrecorded", `${id} 加计不得猜 applied`);
    assert.equal(view.accel.reasonCode, "not-recorded");
    assert.equal(view.mag.state, "unrecorded", `${id} 磁通道不得猜 applied`);
    assert.equal(view.mag.reasonCode, "not-recorded");
    assert.equal(view.accel.explanationKey, "obs.accel.unrecorded");

    const gateOff = explainExistingTelemetry(
      id,
      makeTelemetry({ accelNorm: 9.8, accelValid: true, magValid: false }),
      makeOptions({ magEnabled: true, gateEnabled: false }),
    );
    assert.equal(gateOff.accel.state, "unrecorded", `${id} 门控关闭仍不猜 applied`);
    assert.equal(gateOff.mag.state, "invalid", "加计可用且磁已启用时，magValid=false 是测量退化");
    assert.equal(gateOff.mag.reasonCode, "mag-norm-out-of-range");

    const magnitudeInvalid = explainExistingTelemetry(
      id,
      makeTelemetry({ accelNorm: 15, accelValid: false, magValid: false, detail: { gateMode: 0 } }),
      makeOptions({ magEnabled: true, gateEnabled: false }),
    );
    assert.equal(magnitudeInvalid.accel.state, "invalid", `${id} 门控关闭时模长异常仍是 invalid`);
    assert.equal(magnitudeInvalid.accel.reasonCode, "accel-norm-out-of-range");

    const magDisabled = explainExistingTelemetry(
      id,
      makeTelemetry({ accelNorm: 9.8, accelValid: true, magValid: false }),
      makeOptions({ magEnabled: false, gateEnabled: true }),
    );
    assert.equal(magDisabled.mag.state, "disabled", `${id} 磁关闭与磁退化必须区分`);
    assert.equal(magDisabled.mag.reasonCode, "mag-disabled");
  }
});

test("explainExistingTelemetry: 加计有效但被门控拒绝 => rejected；幅度异常 => invalid", () => {
  for (const id of ["comp", "mahony", "madg"] as const) {
    const rejected = explainExistingTelemetry(
      id,
      makeTelemetry({
        accelNorm: 9.8,
        accelValid: true,
        magValid: false,
        detail: { gateMode: 1, alignErrorDeg: 35, rejectRatio: 1 },
      }),
      makeOptions({ magEnabled: true, gateEnabled: true }),
    );
    assert.equal(rejected.accel.state, "rejected", `${id} 有效观测被拒不得标 applied`);
    assert.equal(rejected.accel.reasonCode, "gate-direction");
    assert.equal(rejected.accel.evidence.angleDeg, 35);
    assert.equal(rejected.accel.evidence.threshold, FUSION_ACCEL_GATE_DEG);
    assert.equal(rejected.mag.state, "unrecorded", `${id} 加计分支被跳过时磁通道未评估`);
    assert.equal(rejected.mag.reasonCode, "mag-not-evaluated");

    const invalid = explainExistingTelemetry(
      id,
      makeTelemetry({
        accelNorm: 15,
        accelValid: false,
        magValid: false,
        detail: { gateMode: 1, alignErrorDeg: 5 },
      }),
      makeOptions({ magEnabled: true, gateEnabled: true }),
    );
    assert.equal(invalid.accel.state, "invalid", `${id} 幅度异常是 invalid 而不是有效被拒`);
    assert.equal(invalid.accel.reasonCode, "accel-norm-out-of-range");
    assert.equal(invalid.mag.state, "unrecorded");
    assert.equal(invalid.mag.reasonCode, "mag-not-evaluated");
  }
});

test("explainExistingTelemetry: 只有显式 accelAccepted/magAccepted 才标 applied", () => {
  for (const id of ["comp", "mahony", "madg"] as const) {
    const view = explainExistingTelemetry(
      id,
      makeTelemetry({
        accelAccepted: true,
        magAccepted: true,
        accelValid: true,
        magValid: true,
        detail: { gateMode: 0 },
      }),
      makeOptions(),
    );
    assert.equal(view.accel.state, "applied", `${id} 显式 accelAccepted=true`);
    assert.equal(view.mag.state, "applied", `${id} 显式 magAccepted=true`);
    assert.equal(view.accel.reasonCode, "applied");
    assert.equal(view.mag.reasonCode, "applied");
  }
});

test("explainExistingTelemetry: 非有限证据不出现在 evidence 中", () => {
  const view = explainExistingTelemetry(
    "kalman",
    makeTelemetry({
      accelNorm: Number.NaN,
      accelValid: true,
      accelAccepted: false,
      detail: { innoAccelDeg: Number.NaN, nisAccel: Number.NaN, accelRejectCode: 2 },
    }),
    makeOptions(),
  );
  assert.equal(view.accel.state, "rejected");
  assert.equal(view.accel.evidence.norm, undefined);
  assert.equal(view.accel.evidence.angleDeg, undefined);
  assert.equal(view.accel.evidence.nis, undefined);
  assert.equal(view.accel.evidence.threshold, KALMAN_ANGLE_GATE_DEG);
});

test("describeObservation: 中文保守文案，不含整体系统不可观结论", () => {
  const states: ObservationState[] = [
    "not-applicable",
    "disabled",
    "invalid",
    "rejected",
    "accepted-not-applied",
    "unrecorded",
    "applied",
  ];
  for (const channel of ["accel", "mag"] as const) {
    for (const state of states) {
      const text = describeObservation({
        channel,
        state,
        reasonCode: null,
        evidence: {},
        explanationKey: "test",
      });
      assert.ok(text.length > 0);
      assert.ok(!/不可观/.test(text), `不得出现“不可观”：${text}`);
      assert.ok(!/unobservable/i.test(text), `不得出现 unobservable：${text}`);
      assert.ok(!/永远|永久/.test(text), `不得写成永久结论：${text}`);
    }
  }

  const accelApplied = describeObservation({
    channel: "accel",
    state: "applied",
    reasonCode: "applied",
    evidence: { norm: 9.8 },
    explanationKey: "obs.accel.applied",
  });
  assert.ok(accelApplied.includes("倾角"));
  assert.ok(accelApplied.includes("重力轴"));
  const magApplied = describeObservation({
    channel: "mag",
    state: "applied",
    reasonCode: "applied",
    evidence: { angleDeg: 1 },
    explanationKey: "obs.mag.applied",
  });
  assert.ok(magApplied.includes("航向"));
  const rejected = describeObservation({
    channel: "accel",
    state: "rejected",
    reasonCode: "gate-direction",
    evidence: { angleDeg: 55, threshold: 20 },
    explanationKey: "obs.accel.rejected",
  });
  assert.ok(rejected.includes("单步"));
  assert.ok(rejected.includes("55.00"));
  assert.ok(rejected.includes("20.00"));
});

test("模块边界：无 DOM/全局窗口/渲染依赖", () => {
  const sources = [
    ["event-timeline.ts", readFileSync(new URL("../src/core/event-timeline.ts", import.meta.url), "utf8")],
    ["observability.ts", readFileSync(new URL("../src/core/observability.ts", import.meta.url), "utf8")],
  ] as const;
  for (const [name, source] of sources) {
    assert.ok(!/\bdocument\b/.test(source), `${name} 不得引用 document`);
    assert.ok(!/\bwindow\b/.test(source), `${name} 不得引用 window`);
    assert.ok(
      !/querySelector|HTMLElement|innerHTML|localStorage|sessionStorage|indexedDB/.test(source),
      `${name} 不得依赖 DOM/持久化`,
    );
    assert.ok(
      !/from\s+["'][^"']*(?:main|three|runner)["']/.test(source),
      `${name} 不得 import UI/渲染/完整 runner`,
    );
  }
});

console.log(`event-observability-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
