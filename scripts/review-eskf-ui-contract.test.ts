/**
 * F-06 / F-07 界面模块的独立契约测试（Node 端，不启动浏览器）。
 *
 * 覆盖：
 *  - 回看状态机：无帧、进入/退出、上一帧/下一帧、runId 切换、容差外 seek；
 *  - 回看只通过 enterReview/exitReview 改变展示，冻结的帧/估计值不被修改；
 *  - 回看 HTML：无帧不伪造、无真值不画幻影、缺失误差显示不可用、转义；
 *  - ESKF 纯渲染：7 个折叠阶段、两条观测顺序、S 奇异 null 不显示 0、
 *    协方差重置标志、缺失快照、单位/坐标系与 HTML 转义；
 *  - mount 层：动态按钮/禁用状态与文档入口（用最小 fake DOM）。
 *
 * 运行：npx tsx scripts/review-eskf-ui-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createReviewPanelController,
  mountReviewPanel,
  reviewPanelBodyHtml,
  type ReviewPanelDeps,
} from "../src/ui/review-panel";
import {
  eskfSnapshotHtml,
  mountEskfPanel,
  type EskfPanelDeps,
} from "../src/ui/eskf-panel";
import {
  DEFAULT_NEAREST_TOLERANCE_SEC,
  ReviewBuffer,
  buildReviewFrame,
  type NearestReviewFrame,
  type ReviewBuffer as ReviewBufferType,
  type ReviewFrame,
} from "../src/core/review-buffer";
import type {
  EstimatorTelemetry,
  KalmanObservationSnapshot,
  KalmanStepSnapshot,
} from "../src/estimators";
import type { ImuSample } from "../src/core/imu";
import type { Quat } from "../src/core/quat";
import type { LearningEvent } from "../src/core/event-timeline";

let pass = 0;
let fail = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const Q0: Quat = { w: 1, x: 0, y: 0, z: 0 };
const Q_OFF: Quat = { w: 0.9238795325, x: 0.3826834324, y: 0, z: 0 };

function makeTelemetry(overrides: Partial<EstimatorTelemetry> = {}): EstimatorTelemetry {
  return {
    rate: [0.1, 0.2, 0.3],
    rawGyro: [0.01, -0.02, 0.03],
    correction: [0.09, 0.22, 0.27],
    predictedGravity: [0, 0, 9.80665],
    measuredGravity: [0.1, 0, 9.8],
    accelNorm: 9.81,
    accelValid: true,
    magValid: true,
    accelAccepted: true,
    magAccepted: false,
    detail: { accelWeight: 0.25, gateMode: 0 },
    ...overrides,
  };
}

interface FrameOptions {
  runId?: number;
  seq?: number;
  t?: number;
  truthKind?: ReviewFrame["truth"]["kind"];
  truthQ?: Quat | null;
  estimateId?: ReviewFrame["estimate"]["id"];
  estimateQ?: Quat;
  raw?: ImuSample;
  consumed?: ReviewFrame["input"]["consumed"];
  telemetry?: EstimatorTelemetry;
  totalDeg?: number | null;
  tiltDeg?: number | null;
  yawDeg?: number | null;
}

function makeFrame(opts: FrameOptions = {}): ReviewFrame {
  const {
    runId = 1,
    seq = 0,
    t = seq / 25,
    truthKind = "groundTruth",
    truthQ = Q0,
    estimateId = "comp",
    estimateQ = Q0,
    raw = { gyro: [0.1, 0.2, 0.3], accel: [0, 0, 9.80665], mag: [30, 0, 38] },
    consumed = { gyro: [0.11, 0.22, 0.33], accel: [0.01, 0, 9.8], mag: [31, 1, 37] },
    telemetry = makeTelemetry(),
    totalDeg = 1.5,
    tiltDeg = 1.0,
    yawDeg = 0.5,
  } = opts;
  return buildReviewFrame({
    runId,
    seq,
    t,
    truthKind,
    truthQ,
    estimateId,
    estimateQ,
    raw,
    consumed,
    telemetry,
    totalDeg,
    tiltDeg,
    yawDeg,
  });
}

/** 只实现 panel 需要的读方法；通过 unknown 转成 ReviewBuffer 以验证接口兼容。 */
class FakeReviewBuffer {
  forceNearestMiss = false;
  latestCalls = 0;
  nearestCalls = 0;
  listCalls = 0;
  private readonly frames: ReviewFrame[];

  constructor(frames: ReviewFrame[] = []) {
    this.frames = frames;
  }

  latest(runId: number): ReviewFrame | null {
    this.latestCalls++;
    let best: ReviewFrame | null = null;
    for (const frame of this.frames) {
      if (frame.runId !== runId) continue;
      if (!best || frame.t > best.t || (frame.t === best.t && frame.seq >= best.seq)) {
        best = frame;
      }
    }
    return best;
  }

  nearest(
    runId: number,
    t: number,
    toleranceSec: number = DEFAULT_NEAREST_TOLERANCE_SEC,
  ): NearestReviewFrame {
    this.nearestCalls++;
    if (this.forceNearestMiss || !Number.isFinite(t)) {
      return { frame: null, actualDt: null };
    }
    let best: ReviewFrame | null = null;
    let bestAbs = Infinity;
    for (const frame of this.frames) {
      if (frame.runId !== runId) continue;
      const dt = Math.abs(frame.t - t);
      if (dt > toleranceSec) continue;
      if (
        !best ||
        dt < bestAbs ||
        (dt === bestAbs && (frame.t < best.t || (frame.t === best.t && frame.seq < best.seq)))
      ) {
        best = frame;
        bestAbs = dt;
      }
    }
    return best ? { frame: best, actualDt: best.t - t } : { frame: null, actualDt: null };
  }

  list(runId: number): ReviewFrame[] {
    this.listCalls++;
    return this.frames
      .filter((frame) => frame.runId === runId)
      .sort((a, b) => a.t - b.t || a.seq - b.seq);
  }
}

function asReviewBuffer(buffer: FakeReviewBuffer): ReviewBufferType {
  return buffer as unknown as ReviewBufferType;
}

interface ReviewHarness {
  buffer: FakeReviewBuffer;
  deps: ReviewPanelDeps;
  run: { value: number };
  calls: { entered: ReviewFrame[]; exits: number };
  cursors: Array<number | null>;
  events: LearningEvent[];
}

function makeHarness(
  frames: ReviewFrame[] = [],
  runId = 1,
  events: LearningEvent[] = [],
): ReviewHarness {
  const buffer = new FakeReviewBuffer(frames);
  const run = { value: runId };
  const calls = { entered: [] as ReviewFrame[], exits: 0 };
  const cursors: Array<number | null> = [];
  const deps: ReviewPanelDeps = {
    getBuffer: () => asReviewBuffer(buffer),
    getRunId: () => run.value,
    getEvents: (id) => events.filter((event) => event.runId === id),
    enterReview: (frame) => calls.entered.push(frame),
    exitReview: () => {
      calls.exits++;
    },
    setCursor: (t) => cursors.push(t),
  };
  return { buffer, deps, run, calls, cursors, events };
}

function makeEvent(runId: number, seq: number, t: number, summary = `事件 ${seq}`): LearningEvent {
  return {
    runId,
    seq,
    t,
    kind: "custom",
    estimator: null,
    phase: "instant",
    summary,
    source: "solve-loop",
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------- 回看状态机 ----------------

test("回看：无帧时 toggle 不进入，给出明确提示", () => {
  const h = makeHarness([]);
  const api = createReviewPanelController(h.deps);
  api.update();
  let state = api.state();
  assert.equal(state.active, false);
  assert.equal(state.hasFrame, false);
  assert.equal(state.t, null);
  assert.match(state.note, /还没有可回看的帧/);

  api.toggle();
  state = api.state();
  assert.equal(h.calls.entered.length, 0);
  assert.equal(h.calls.exits, 0);
  assert.equal(state.active, false);
  assert.equal(state.hasFrame, false);
  assert.match(state.note, /还没有可回看的帧/);
});

test("回看：toggle 进入只调用 enterReview，返回实时调用 exitReview，帧不被修改", () => {
  const frame = deepFreeze(makeFrame({ runId: 7, seq: 3, t: 1.2 }));
  const before = JSON.stringify(frame);
  const h = makeHarness([frame], 7);
  const api = createReviewPanelController(h.deps);

  api.update();
  api.toggle();
  assert.equal(h.calls.entered.length, 1);
  assert.equal(h.calls.entered[0], frame, "必须把缓冲中的真实帧交给场景");
  assert.equal(h.calls.exits, 0);
  let state = api.state();
  assert.deepEqual(
    [state.active, state.hasFrame, state.t, state.runId],
    [true, true, 1.2, 7],
  );
  assert.match(state.note, /正在回看历史/);

  api.toggle();
  assert.equal(h.calls.exits, 1);
  state = api.state();
  assert.deepEqual([state.active, state.hasFrame, state.t], [false, false, null]);
  assert.match(state.note, /已返回实时/);
  assert.equal(JSON.stringify(frame), before, "回看不得修改帧里的估计值或遥测");
});

test("回看：进入/上一帧/下一帧同步曲线游标，退出清空交还实时", () => {
  const f1 = makeFrame({ runId: 7, seq: 0, t: 0.2 });
  const f2 = makeFrame({ runId: 7, seq: 1, t: 0.24 });
  const h = makeHarness([f1, f2], 7);
  const api = createReviewPanelController(h.deps);

  api.update();
  api.toggle();
  assert.deepEqual(h.cursors, [0.24], "进入回看必须把游标定位到最新帧时间");

  api.prev();
  assert.deepEqual(h.cursors, [0.24, 0.2], "上一帧必须同步游标");

  api.next();
  assert.deepEqual(h.cursors, [0.24, 0.2, 0.24], "下一帧必须同步游标");

  api.toggle();
  assert.deepEqual(h.cursors, [0.24, 0.2, 0.24, null], "退出回看必须清空游标交还实时");
  assert.equal(h.calls.exits, 1);
});

test("回看：runId 切换后 update 退出旧轮，新轮从新帧开始", () => {
  const oldFrame = makeFrame({ runId: 1, seq: 0, t: 0.5 });
  const newFrame = makeFrame({ runId: 2, seq: 0, t: 0.1, estimateQ: Q_OFF });
  const h = makeHarness([oldFrame, newFrame], 1);
  const api = createReviewPanelController(h.deps);

  api.toggle();
  assert.equal(h.calls.entered.length, 1);
  assert.equal(h.calls.entered[0].runId, 1);

  h.run.value = 2;
  api.update();
  assert.equal(h.calls.exits, 1, "运行切换必须撤销旧回看的场景覆盖");
  let state = api.state();
  assert.equal(state.active, false);
  assert.equal(state.hasFrame, false);
  assert.equal(state.runId, 2);
  assert.match(state.note, /运行已切换/);

  api.toggle();
  assert.equal(h.calls.entered.length, 2);
  assert.equal(h.calls.entered[1].runId, 2, "新轮不得复用上一轮帧");
  assert.equal(api.state().t, 0.1);
});

test("回看：nearest 超容差时不伪造帧，并退出覆盖", () => {
  const frame = makeFrame({ runId: 1, seq: 0, t: 1 });
  const h = makeHarness([frame], 1);
  const api = createReviewPanelController(h.deps);
  api.toggle();
  assert.equal(api.state().active, true);

  h.buffer.forceNearestMiss = true;
  api.update();

  assert.equal(h.calls.exits, 1);
  assert.equal(h.calls.entered.length, 1);
  const state = api.state();
  assert.deepEqual([state.active, state.hasFrame, state.t], [false, false, null]);
  assert.match(state.note, /容差/);
  assert.match(state.note, /不会用相邻帧/);
});

test("回看：seek 超容差不进入；容差内定位并报告实际 Δt", () => {
  const frames = [
    makeFrame({ seq: 0, t: 0 }),
    makeFrame({ seq: 1, t: 0.04 }),
    makeFrame({ seq: 2, t: 0.08 }),
  ];
  const h = makeHarness(frames, 1);
  const api = createReviewPanelController(h.deps);

  api.seek(5);
  assert.equal(h.calls.entered.length, 0);
  let state = api.state();
  assert.equal(state.active, false);
  assert.equal(state.hasFrame, false);
  assert.match(state.note, /容差/);
  assert.match(state.note, /不会伪造帧/);

  api.seek(0.051);
  assert.equal(h.calls.entered.length, 1);
  state = api.state();
  assert.equal(state.active, true);
  assert.equal(state.t, 0.04);
  assert.match(state.note, /Δt=-0\.011 s/);
});

test("回看：prev/next 按时间顺序移动，边界停住不重复通知", () => {
  const frames = [
    makeFrame({ seq: 0, t: 0 }),
    makeFrame({ seq: 1, t: 0.04 }),
    makeFrame({ seq: 2, t: 0.08 }),
  ];
  const h = makeHarness(frames, 1);
  const api = createReviewPanelController(h.deps);

  api.toggle();
  assert.equal(api.state().t, 0.08);
  api.prev();
  assert.equal(api.state().t, 0.04);
  api.prev();
  assert.equal(api.state().t, 0);
  api.prev();
  assert.equal(api.state().t, 0);
  assert.match(api.state().note, /最早/);
  assert.equal(h.calls.entered.length, 3);

  api.next();
  assert.equal(api.state().t, 0.04);
  api.next();
  assert.equal(api.state().t, 0.08);
  api.next();
  assert.equal(api.state().t, 0.08);
  assert.match(api.state().note, /最新/);
  assert.equal(h.calls.entered.length, 5);
  assert.equal(h.calls.exits, 0);
});

test("回看：真实 ReviewBuffer 的 seek 容差口径一致", () => {
  const buffer = new ReviewBuffer(8);
  buffer.push(makeFrame({ runId: 5, seq: 0, t: 0 }));
  buffer.push(makeFrame({ runId: 5, seq: 1, t: 0.04 }));
  buffer.push(makeFrame({ runId: 5, seq: 2, t: 0.08 }));
  const entered: ReviewFrame[] = [];
  let exits = 0;
  const api = createReviewPanelController({
    getBuffer: () => buffer,
    getRunId: () => 5,
    enterReview: (frame) => entered.push(frame),
    exitReview: () => {
      exits++;
    },
  });

  api.seek(0.041);
  assert.equal(api.state().t, 0.04);
  assert.equal(entered.length, 1);
  api.seek(10);
  assert.equal(exits, 1);
  assert.equal(api.state().active, false);
  assert.match(api.state().note, /容差/);
});

// ---------------- 误差证据导航 ----------------

test("证据导航：最大误差只看当前 runId 的有限 totalDeg，切换后提示保持", () => {
  const nan = makeFrame({ runId: 1, seq: 1, t: 0.04, totalDeg: 2 });
  nan.errors.totalDeg = Number.NaN;
  const infinity = makeFrame({ runId: 1, seq: 2, t: 0.08, totalDeg: 3 });
  infinity.errors.totalDeg = Number.POSITIVE_INFINITY;
  const h = makeHarness([
    makeFrame({ runId: 2, seq: 90, t: 0.01, totalDeg: 999 }),
    makeFrame({ runId: 1, seq: 0, t: 0, totalDeg: 2 }),
    nan,
    infinity,
    makeFrame({ runId: 1, seq: 3, t: 0.12, totalDeg: 7 }),
    makeFrame({ runId: 1, seq: 4, t: 0.16, totalDeg: null }),
  ]);
  const api = createReviewPanelController(h.deps);

  const selected = api.seekEvidence(0);
  assert.equal(selected.moved, true);
  assert.equal(selected.frame?.runId, 1);
  assert.equal(selected.frame?.seq, 3);
  assert.equal(selected.frame?.errors.totalDeg, 7);
  assert.equal(h.calls.entered.length, 1);
  assert.equal(h.calls.entered[0].seq, 3, "必须把真实最大误差帧交给现有 enterReview");
  assert.deepEqual(h.cursors, [0.12]);
  assert.match(selected.note, /最大误差/);

  const note = api.state().note;
  api.update();
  assert.equal(api.state().note, note, "更新循环不得覆盖刚选择的证据提示");
  assert.equal(api.evidence().frame?.seq, 3);
});

test("证据导航：严格局部峰值加全局最大误差，前后边界不伪造目标", () => {
  const errors = [1, 5, 2, 7, 3];
  const h = makeHarness(errors.map((totalDeg, seq) => makeFrame({ seq, t: seq * 0.04, totalDeg })));
  const api = createReviewPanelController(h.deps);
  assert.equal(api.seekEvidence(0).frame?.seq, 3);

  const previous = api.seekEvidence(-1);
  assert.equal(previous.moved, true);
  assert.equal(previous.frame?.seq, 1, "上一证据点是较早日期的局部峰值");
  const atFirst = api.seekEvidence(-1);
  assert.equal(atFirst.moved, false);
  assert.equal(atFirst.frame?.seq, 1);
  assert.match(atFirst.note, /最早.*证据点/);
  assert.equal(h.calls.entered.length, 2, "边界不得重复 enterReview");

  assert.equal(api.seekEvidence(1).frame?.seq, 3);
  const atLast = api.seekEvidence(1);
  assert.equal(atLast.moved, false);
  assert.equal(atLast.frame?.seq, 3);
  assert.match(atLast.note, /最新.*证据点/);
  assert.equal(h.calls.entered.length, 3);
});

test("证据导航：空帧、无真值误差和跨 runId 都明确失败", () => {
  const empty = createReviewPanelController(makeHarness().deps);
  let result = empty.seekEvidence(0);
  assert.equal(result.moved, false);
  assert.equal(result.frame, null);
  assert.match(result.note, /没有可回看的帧|还没有可回看的帧/);

  const noTruth = createReviewPanelController(
    makeHarness([
      makeFrame({ truthKind: "none", truthQ: null, totalDeg: null }),
      makeFrame({ seq: 1, t: 0.04, truthKind: "mahony", truthQ: null, totalDeg: null }),
    ]).deps,
  );
  result = noTruth.seekEvidence(0);
  assert.equal(result.moved, false);
  assert.match(result.note, /无真值|没有可用.*总误差/);

  const old = makeFrame({ runId: 1, seq: 0, t: 1, totalDeg: 4 });
  const h = makeHarness([old], 1);
  const api = createReviewPanelController(h.deps);
  api.seekEvidence(0);
  h.run.value = 2;
  result = api.seekEvidence(0);
  assert.equal(result.moved, false);
  assert.equal(result.frame, null, "新轮没有帧时不得保留旧轮证据帧");
  assert.match(result.note, /运行已切换/);
  assert.match(result.note, /#2/);
  assert.equal(h.calls.exits, 1);
});

test("证据窗口：只含当前帧 ±0.25 s 闭区间事件，事实与解释不自动判根因", () => {
  const events = [
    makeEvent(1, 1, 0.749, "窗口外较早事件"),
    makeEvent(1, 2, 0.75, "下边界 <b>事实</b>"),
    makeEvent(1, 3, 1.0, "同刻事件"),
    makeEvent(1, 4, 1.25, "上边界"),
    makeEvent(1, 5, 1.251, "窗口外较晚事件"),
    makeEvent(2, 6, 1.0, "其他运行事件"),
  ];
  const h = makeHarness([makeFrame({ runId: 1, seq: 0, t: 1, totalDeg: 8 })], 1, events);
  const api = createReviewPanelController(h.deps);
  const result = api.seekEvidence(0);
  assert.deepEqual(result.events.map((event) => event.seq), [2, 3, 4]);

  const evidence = api.evidence();
  assert.equal(evidence.frame?.t, 1);
  assert.deepEqual(evidence.events.map((event) => event.summary), ["下边界 <b>事实</b>", "同刻事件", "上边界"]);
  evidence.frame!.errors.totalDeg = 999;
  evidence.events[0].summary = "篡改";
  assert.equal(api.evidence().frame?.errors.totalDeg, 8, "evidence 必须返回隔离副本");
  assert.equal(api.evidence().events[0].summary, "下边界 <b>事实</b>");

  const html = reviewPanelBodyHtml(api.frame(), api.state().note, api.evidence().events);
  assert.ok(html.includes("证据事实"));
  assert.ok(html.includes("±0.25 s"));
  assert.ok(html.includes("custom"));
  assert.ok(html.includes("下边界 &lt;b&gt;事实&lt;/b&gt;"));
  assert.ok(!html.includes("下边界 <b>事实</b>"));
  assert.ok(html.includes("保守解释"));
  assert.ok(html.includes("不据此判断故障根因"));
  assert.ok(html.includes("严格局部峰值"));

  const noEvents = reviewPanelBodyHtml(makeFrame({ t: 2 }), "ok", []);
  assert.ok(noEvents.includes("该窗口无已记录事件"));
});

// ---------------- 回看 HTML ----------------

test("回看 HTML：无帧不伪造；无真值不画幻影；缺失误差显示不可用", () => {
  const empty = reviewPanelBodyHtml(null, "无帧 <script>alert(1)</script>");
  assert.ok(empty.includes("无帧 &lt;script&gt;"));
  assert.ok(!empty.includes("<script>"));
  assert.ok(!empty.includes("0.000"), "无帧时不得出现伪造的数值");

  const frame = makeFrame({
    truthKind: "mahony",
    truthQ: null,
    totalDeg: null,
    tiltDeg: null,
    yawDeg: null,
  });
  const html = reviewPanelBodyHtml(frame, "ok");
  assert.ok(html.includes("Mahony 基准"));
  assert.ok(html.includes("无真值四元数"));
  assert.ok(html.includes("不渲染真值幻影"));
  assert.ok(html.includes("不可用"));
  assert.ok(html.includes("原始"));
  assert.ok(html.includes("实际消费"));
  assert.ok(html.includes("rad/s"));
  assert.ok(html.includes("m/s²"));
  assert.ok(html.includes("μT"));
  assert.ok(html.includes("修正角速度"));
  assert.ok(html.includes("世界系←机体系"));

  const rotated = reviewPanelBodyHtml(makeFrame({ estimateQ: Q_OFF }), "ok");
  assert.ok(rotated.includes("横滚 45.00"), "四元数换算的欧拉角必须显示为度");
});

test("回看 HTML：观测状态优先于 accelAccepted，并显示原因码", () => {
  const frame = makeFrame({
    telemetry: makeTelemetry({
      accelState: "applied",
      magState: "rejected",
      accelReasonCode: "applied",
      magReasonCode: "gate-direction",
      // 故意与状态相反：显示必须以状态为准，不能退回旧布尔字段。
      accelAccepted: false,
      magAccepted: true,
    }),
  });
  const html = reviewPanelBodyHtml(frame, "ok");
  assert.ok(html.includes("加计观测状态 已应用（原因：applied）"));
  assert.ok(html.includes("磁观测状态 被拒绝（原因：gate-direction）"));
  assert.ok(!html.includes("加计观测实际应用"), "不得退回旧字段标签");

  const fallback = reviewPanelBodyHtml(
    makeFrame({ telemetry: makeTelemetry({ accelAccepted: true, magAccepted: false }) }),
    "ok",
  );
  assert.ok(fallback.includes("加计观测状态 已应用"), "缺状态时回退 accelAccepted");
  assert.ok(fallback.includes("磁观测状态 未应用"), "缺状态时回退 magAccepted");

  const missing = reviewPanelBodyHtml(
    makeFrame({
      telemetry: makeTelemetry({
        accelAccepted: undefined,
        magAccepted: undefined,
      }),
    }),
    "ok",
  );
  assert.ok(missing.includes("加计观测状态 未记录"));
  assert.ok(missing.includes("磁观测状态 未记录"));
});

test("回看 HTML：原因码经过转义，不注入标记", () => {
  const html = reviewPanelBodyHtml(
    makeFrame({
      telemetry: makeTelemetry({
        accelState: "rejected",
        accelReasonCode: '<img src=x onerror="alert(1)">',
      }),
    }),
    "ok",
  );
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
});

// ---------------- ESKF 快照渲染 ----------------

function makeObs(
  channel: "accel" | "mag",
  overrides: Partial<KalmanObservationSnapshot> = {},
): KalmanObservationSnapshot {
  return {
    channel,
    available: true,
    predicted: channel === "accel" ? [0, 0, 1] : [0.6, 0, 0.8],
    measured: channel === "accel" ? [0.01, 0, 0.9999] : [0.61, 0, 0.79],
    innovation: [0.01, 0, -0.0001],
    innovationAngleDeg: 1.25,
    nis: 2.5,
    gate: { kind: "angle", threshold: 40, accepted: true, reason: "applied" },
    S: [0.0025, 0, 0, 0, 0.0025, 0, 0, 0, 0.0025],
    K: new Array<number>(18).fill(0.05),
    dx: [0.001, 0.002, 0.003, 0.00001, 0.00002, 0.00003],
    applied: true,
    qBefore: { ...Q0 },
    qAfter: { ...Q_OFF },
    biasBeforeRad: [0, 0, 0],
    biasAfterRad: [0.0001, 0, 0],
    pDiagBefore: [0.007, 0.007, 0.007, 0.00007, 0.00007, 0.00007],
    pDiagAfter: [0.006, 0.006, 0.006, 0.00006, 0.00006, 0.00006],
    covarianceResetApplied: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<KalmanStepSnapshot> = {}): KalmanStepSnapshot {
  return {
    dt: 0.01,
    qInput: { ...Q0 },
    biasInputRad: [0, 0, 0],
    pDiagInput: [0.007, 0.007, 0.007, 0.00007, 0.00007, 0.00007],
    correctedGyroRad: [0.1, 0.2, 0.3],
    qPredicted: { ...Q_OFF },
    pDiagPredicted: [0.0065, 0.0065, 0.0065, 0.000065, 0.000065, 0.000065],
    observations: [makeObs("accel"), makeObs("mag")],
    qFinal: { ...Q_OFF },
    biasFinalRad: [0.0001, 0, 0],
    pDiagFinal: [0.006, 0.006, 0.006, 0.00006, 0.00006, 0.00006],
    covarianceResetApplied: false,
    ...overrides,
  };
}

function stageHtml(html: string, key: string): string {
  const marker = `data-stage="${key}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `缺少阶段 ${key}`);
  const next = html.indexOf('<details class="eskf-stage"', start + marker.length);
  return html.slice(start, next < 0 ? html.length : next);
}

test("ESKF：缺失快照明确提示，不输出假零值", () => {
  const html = eskfSnapshotHtml(null, null);
  assert.ok(html.includes("当前步未记录内部快照"));
  assert.ok(html.includes("不会用下一帧"));
  assert.ok(html.includes("时间未记录"));
  assert.ok(!html.includes('data-stage="'), "缺失快照不得渲染分步数值");
  assert.ok(!html.includes("0.000000"), "缺失快照不得用 0 填充");
});

test("ESKF：7 个阶段默认折叠，并写清单位与坐标系", () => {
  const html = eskfSnapshotHtml(makeSnapshot(), 1.25);
  const stages = [...html.matchAll(/data-stage="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(stages, [
    "input",
    "prediction",
    "obs-1",
    "obs-2",
    "gate",
    "inject",
    "reset",
  ]);
  assert.equal((html.match(/<details class="eskf-stage"/g) ?? []).length, 7);
  assert.ok(
    !/<details class="eskf-stage"[^>]*\bopen\b/.test(html),
    "所有阶段默认必须折叠",
  );
  assert.ok(html.includes("t = 1.250 s"));
  assert.ok(html.includes("rad/s"));
  assert.ok(html.includes("rad²"));
  assert.ok(html.includes("机体系"));
  assert.ok(html.includes("世界系←机体系"));
  assert.ok(html.includes("s"));
});

test("ESKF：两条观测保持生产顺序并分别标注加速度计/磁力计", () => {
  const accel = makeObs("accel", {
    qBefore: { w: 1, x: 0, y: 0, z: 0 },
    qAfter: { w: 1, x: 0.1, y: 0, z: 0 },
  });
  const mag = makeObs("mag", {
    qBefore: { w: 0.9, x: 0, y: 0.1, z: 0 },
    qAfter: { w: 0.8, x: 0, y: 0.2, z: 0 },
  });
  const html = eskfSnapshotHtml(makeSnapshot({ observations: [accel, mag] }), 2);
  const first = stageHtml(html, "obs-1");
  const second = stageHtml(html, "obs-2");
  assert.ok(first.includes("加速度计"));
  assert.ok(!first.includes("磁力计"));
  assert.ok(second.includes("磁力计"));
  assert.ok(!second.includes("加速度计"));
  assert.ok(html.indexOf("③ 观测 1") < html.indexOf("④ 观测 2"));

  const gate = stageHtml(html, "gate");
  assert.ok(gate.includes("第 1 条 · 加速度计"));
  assert.ok(gate.includes("第 2 条 · 磁力计"));
  assert.ok(gate.indexOf("第 1 条 · 加速度计") < gate.indexOf("第 2 条 · 磁力计"));
});

test("ESKF：S 奇异时 S/K/dx 为 null，显示未产生而不是 0", () => {
  const singular = makeObs("accel", {
    gate: { kind: "angle", threshold: 40, accepted: true, reason: "update-degenerate" },
    applied: false,
    S: null,
    K: null,
    dx: null,
    qAfter: { ...Q0 },
    biasAfterRad: [0, 0, 0],
  });
  const html = eskfSnapshotHtml(
    makeSnapshot({ observations: [singular, makeObs("mag")] }),
    3,
  );
  const first = stageHtml(html, "obs-1");
  assert.ok(first.includes("S 奇异，更新被安全跳过"));
  assert.ok(first.includes("未产生数组（不以 0 代替）"));
  assert.ok(!first.includes('data-matrix="S"'));
  assert.ok(!first.includes('data-matrix="K"'));
  assert.ok(!first.includes('data-matrix="dx"'));
  assert.ok(first.includes("未应用"));
});

test("ESKF：门控拒绝同样不产生 K/dx，并显示真实原因", () => {
  const rejected = makeObs("accel", {
    gate: { kind: "angle", threshold: 40, accepted: false, reason: "gate-direction" },
    applied: false,
    S: null,
    K: null,
    dx: null,
    qAfter: { ...Q0 },
    biasAfterRad: [0, 0, 0],
  });
  const html = eskfSnapshotHtml(
    makeSnapshot({ observations: [rejected, makeObs("mag")] }),
    3,
  );
  const first = stageHtml(html, "obs-1");
  assert.ok(first.includes("门控拒绝，未进入更新计算"));
  assert.ok(first.includes("门控拒绝"));
  assert.ok(!first.includes('data-matrix="K"'));
  assert.ok(!first.includes('data-matrix="dx"'));
});

test("ESKF：协方差重置标志直接来自快照", () => {
  const on = eskfSnapshotHtml(makeSnapshot({ covarianceResetApplied: true }), 1);
  const onReset = stageHtml(on, "reset");
  assert.ok(onReset.includes("已执行"));
  assert.ok(!onReset.includes("未执行"));

  const off = eskfSnapshotHtml(makeSnapshot({ covarianceResetApplied: false }), 1);
  const offReset = stageHtml(off, "reset");
  assert.ok(offReset.includes("未执行"));
  assert.ok(!offReset.includes("已执行"));
});

test("ESKF：observations 为空时不虚构接受/拒绝", () => {
  const html = eskfSnapshotHtml(makeSnapshot({ observations: [] }), null);
  assert.ok(stageHtml(html, "obs-1").includes("没有第 1 条观测记录"));
  assert.ok(stageHtml(html, "gate").includes("observations 为空"));
  assert.ok(html.includes("时间未记录"));
});

test("ESKF：门控类型/原因码经过 HTML 转义", () => {
  const obs = makeObs("accel", {
    gate: {
      kind: "<i>angle</i>",
      threshold: 40,
      accepted: false,
      reason: '<img src=x onerror="alert(1)">',
    },
    applied: false,
    S: null,
    K: null,
    dx: null,
  });
  const html = eskfSnapshotHtml(
    makeSnapshot({ observations: [obs, makeObs("mag")] }),
    1,
  );
  assert.ok(html.includes("&lt;i&gt;angle&lt;/i&gt;"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<i>angle"));
});

// ---------------- mount 层（最小 fake DOM） ----------------

class FakeClassList {
  private readonly names = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.names.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.names.delete(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const next = force === undefined ? !this.names.has(token) : force;
    if (next) this.names.add(token);
    else this.names.delete(token);
    return next;
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  className = "";
  textContent = "";
  innerHTML = "";
  disabled = false;
  hidden = false;
  type = "";
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(tag: string, ownerDocument: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
}

class FakeRoot extends FakeElement {
  constructor() {
    super("div", new FakeDocument());
  }
}

function allElements(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    for (const child of element.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function actionButton(root: FakeElement, action: string): FakeElement {
  const button = allElements(root).find(
    (element) =>
      element.tagName === "BUTTON" &&
      element.getAttribute("data-review-action") === action,
  );
  assert.ok(button, `缺少按钮 data-review-action=${action}`);
  return button;
}

test("mountReviewPanel：动态创建按钮、禁用状态与状态机联动", () => {
  const h = makeHarness(
    [makeFrame({ runId: 3, seq: 0, t: 0.2 }), makeFrame({ runId: 3, seq: 1, t: 0.24 })],
    3,
  );
  const root = new FakeRoot();
  const api = mountReviewPanel(root as unknown as HTMLElement, h.deps);

  const toggle = actionButton(root, "toggle");
  const prev = actionButton(root, "prev");
  const next = actionButton(root, "next");
  const exit = actionButton(root, "exit");
  assert.equal(toggle.textContent, "回看模式");
  assert.equal(prev.textContent, "上一帧");
  assert.equal(next.textContent, "下一帧");
  assert.equal(exit.textContent, "返回实时");
  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, true);
  assert.equal(exit.disabled, true);

  toggle.click();
  assert.equal(toggle.textContent, "实时");
  assert.equal(api.state().active, true);
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false);
  assert.equal(exit.disabled, false);

  const body = allElements(root).find((element) => element.className === "review-body");
  assert.ok(body);
  assert.ok(body.innerHTML.includes("正在回看历史"));
  assert.ok(body.innerHTML.includes("实际消费"));

  prev.click();
  assert.equal(api.state().t, 0.2);
  exit.click();
  assert.equal(api.state().active, false);
  assert.equal(h.calls.exits, 1);
  assert.equal(prev.disabled, true);
  assert.equal(exit.disabled, true);
});

test("mountReviewPanel：证据导航按钮复用 seek 同帧，并提供已有观测文档入口", () => {
  const h = makeHarness([
    makeFrame({ runId: 3, seq: 0, t: 0.2, totalDeg: 1 }),
    makeFrame({ runId: 3, seq: 1, t: 0.24, totalDeg: 3 }),
    makeFrame({ runId: 3, seq: 2, t: 0.28, totalDeg: 2 }),
    makeFrame({ runId: 3, seq: 3, t: 0.32, totalDeg: 4 }),
    makeFrame({ runId: 3, seq: 4, t: 0.36, totalDeg: 1 }),
  ], 3);
  const docs: Array<{ page: string; anchor?: string }> = [];
  h.deps.openDocs = (page, anchor) => docs.push({ page, anchor });
  const root = new FakeRoot();
  const api = mountReviewPanel(root as unknown as HTMLElement, h.deps);
  const maximum = actionButton(root, "evidence-max");
  const previous = actionButton(root, "evidence-prev");
  const next = actionButton(root, "evidence-next");
  const docButton = actionButton(root, "docs");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);

  maximum.click();
  assert.equal(api.state().t, 0.32);
  assert.deepEqual(h.cursors, [0.32]);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
  previous.click();
  assert.equal(api.state().t, 0.24);
  next.click();
  assert.equal(api.state().t, 0.32);

  docButton.click();
  assert.deepEqual(docs, [{ page: "math", anchor: "m-observability" }]);
});

test("mountEskfPanel：缺失提示、更新渲染与文档入口", () => {
  let snapshot: KalmanStepSnapshot | null = null;
  let time: number | null = null;
  let docs: { page: string; anchor?: string } | null = null;
  const deps: EskfPanelDeps = {
    getSnapshot: () => snapshot,
    getTime: () => time,
    openDocs: (page, anchor) => {
      docs = { page, anchor };
    },
  };
  const root = new FakeRoot();
  const api = mountEskfPanel(root as unknown as HTMLElement, deps);

  const body = allElements(root).find((element) => element.className === "eskf-body");
  assert.ok(body);
  assert.ok(body.innerHTML.includes("当前步未记录内部快照"));

  const docsButton = allElements(root).find(
    (element) => element.getAttribute("data-eskf-action") === "docs",
  );
  assert.ok(docsButton);
  docsButton.click();
  assert.deepEqual(docs, { page: "f-kalman-detail", anchor: "fd-kalman-3" });

  snapshot = makeSnapshot();
  time = 1.5;
  api.update();
  assert.ok(body.innerHTML.includes('data-stage="input"'));
  assert.ok(body.innerHTML.includes("t = 1.500 s"));
});

// ---------------- 模块边界 ----------------

test("模块边界：不加载 runner/scene/main，不写回估计器或世界状态", () => {
  const reviewSource = readFileSync(
    new URL("../src/ui/review-panel.ts", import.meta.url),
    "utf8",
  );
  const eskfSource = readFileSync(
    new URL("../src/ui/eskf-panel.ts", import.meta.url),
    "utf8",
  );
  for (const [name, source] of [
    ["review-panel", reviewSource],
    ["eskf-panel", eskfSource],
  ] as const) {
    const specifiers = [
      ...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["'];/gm),
    ].map((match) => match[1]);
    assert.ok(
      !specifiers.some(
        (specifier) =>
          specifier.includes("core/runner") ||
          specifier.includes("/scene/") ||
          specifier.includes("main"),
      ),
      `${name} 不得静态加载 runner/scene/main`,
    );
  }
  assert.ok(!/\bests\b/.test(reviewSource), "回看面板不得接触估计器数组");
  assert.ok(!/\bworld\b/.test(reviewSource), "回看面板不得接触世界状态");
  // 去掉注释再查赋值，避免把 `truth.q=null` 这类契约说明误判成写回代码。
  const reviewCode = reviewSource.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.q\s*=/.test(reviewCode), "回看面板不得写回姿态四元数");
});

console.log(`review-eskf-ui-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
