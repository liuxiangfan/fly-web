/**
 * F-03 / F-05 阶段 C UI 模块的离线契约测试（Node 端，不启动浏览器）。
 *
 * 覆盖：
 *  1. EventRecorder 的边沿语义：连续拒绝归并、恢复、按估计器/通道隔离；
 *  2. runId 隔离、对齐瞬时事件去重、断流边沿、容量与 dropped；
 *  3. 不生成饱和事件（饱和必须来自真实削顶观测，本记录器不猜）；
 *  4. ObservabilityPanel 纯视图：显式遥测状态、原因/证据、无真值不伪造分轴误差、
 *     保守文案与 HTML 标签按纯文本处理；
 *  5. EventPanel 纯视图：过滤、最近 N 条、裁剪计数、空态、HTML 标签按纯文本处理；
 *  6. 两个面板的 mount/update/state 在最小假 DOM 上的状态语义与原生按钮点击；
 *  7. 模块边界：不静态 import main，不拼接 innerHTML，记录器不碰 DOM/墙钟/随机数。
 *
 * 运行：npx tsx scripts/event-observability-ui-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventRecorder, type RecorderEstimator } from "../src/core/event-recorder";
import { EventTimeline, type LearningEventInput } from "../src/core/event-timeline";
import {
  OBSERVATION_STATE_LABELS,
  buildObservabilityView,
  mountObservabilityPanel,
  type ObservabilitySnapshot,
} from "../src/ui/observability-panel";
import {
  EVENT_PANEL_LIMIT,
  buildEventPanelView,
  mountEventPanel,
} from "../src/ui/event-panel";
import { qFromAxisAngle, RAD } from "../src/core/quat";
import type { EstimatorTelemetry } from "../src/estimators";
import type { ObservationState } from "../src/core/observability";

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
    accelState: "unrecorded",
    magState: "unrecorded",
    accelReasonCode: "not-recorded",
    magReasonCode: "not-recorded",
    detail: {},
    ...overrides,
  };
}

function estimator(
  id: RecorderEstimator["id"],
  telemetry: EstimatorTelemetry,
  label: string = id,
): RecorderEstimator {
  return { id, label, telemetry };
}

function makeSnapshot(overrides: Partial<ObservabilitySnapshot> = {}): ObservabilitySnapshot {
  return {
    estimatorId: "comp",
    estimatorLabel: "互补滤波",
    telemetry: makeTelemetry(),
    relativeTruthQuat: null,
    referenceLabel: "Mahony 基准",
    magEnabled: false,
    gateEnabled: true,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LearningEventInput> = {}): LearningEventInput {
  return {
    t: 0,
    kind: "custom",
    estimator: null,
    phase: "instant",
    summary: "事件",
    source: "solve-loop",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 最小假 DOM：只实现两个面板实际使用的 API；不引入新依赖。
// ---------------------------------------------------------------------------
class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  className = "";
  hidden = false;
  type = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  private ownText = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = String(value);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    if (node.parentNode) node.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
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

function descendants(node: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of node.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

function hasClass(element: FakeElement, name: string): boolean {
  return element.className.split(/\s+/).includes(name);
}

// ---------------------------------------------------------------------------

test("EventRecorder: 连续 100 帧拒绝只形成一对 start/end", () => {
  const recorder = new EventRecorder(64);
  const rejecting = estimator(
    "comp",
    makeTelemetry({
      accelState: "rejected",
      accelReasonCode: "gate-direction",
      detail: { alignErrorDeg: 35, gateMode: 1 },
    }),
    "互补滤波",
  );
  for (let i = 0; i < 100; i++) recorder.sample(1, i * 0.01, [rejecting]);
  let events = recorder.list();
  assert.equal(events.length, 1, "100 帧拒绝只能有一条边沿事件");
  assert.equal(events[0].kind, "gate-reject");
  assert.equal(events[0].phase, "start");
  assert.equal(events[0].estimator, "comp");
  assert.match(events[0].summary, /互补滤波/);
  assert.match(events[0].summary, /加速度计/);
  const after = events[0].after as Record<string, unknown>;
  assert.equal(after.reasonCode, "gate-direction");
  assert.equal(after.angleDeg, 35);

  recorder.sample(1, 1, [estimator("comp", makeTelemetry({ accelState: "applied", accelReasonCode: "applied" }))]);
  events = recorder.list();
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, "gate-recovery");
  assert.equal(events[1].phase, "end");
  assert.match(events[1].summary, /不据此断言/);
});

test("EventRecorder: applied 不产生事件，applied→rejected 产生新开始", () => {
  const recorder = new EventRecorder(16);
  const state = (accelState: ObservationState): RecorderEstimator =>
    estimator("mahony", makeTelemetry({
      accelState,
      accelReasonCode: accelState === "rejected" ? "gate-direction" : "applied",
    }), "Mahony");
  recorder.sample(1, 0, [state("applied")]);
  assert.equal(recorder.list().length, 0, "初始 applied 不是边沿");
  recorder.sample(1, 1, [state("rejected")]);
  recorder.sample(1, 2, [state("rejected")]);
  recorder.sample(1, 3, [state("applied")]);
  recorder.sample(1, 4, [state("rejected")]);
  assert.deepEqual(
    recorder.list().map((event) => `${event.kind}/${event.phase}`),
    ["gate-reject/start", "gate-recovery/end", "gate-reject/start"],
  );
});

test("EventRecorder: runId 隔离、reset 清边沿且不补假 end", () => {
  const recorder = new EventRecorder(16);
  const rejecting = estimator("comp", makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" }));
  const applied = estimator("comp", makeTelemetry({ accelState: "applied", accelReasonCode: "applied" }));
  recorder.sample(1, 0, [rejecting]);
  assert.equal(recorder.list().length, 1);
  assert.throws(() => recorder.sample(2, 1, [applied]), /runId/, "不显式 reset 不得串轮");
  assert.equal(recorder.list().length, 1, "被拒绝的 sample 不得写事件");

  recorder.reset(2);
  assert.equal(recorder.list().length, 0);
  assert.equal(recorder.dropped(), 0);
  recorder.sample(2, 2, [applied]);
  assert.equal(recorder.list().length, 0, "reset 后旧拒绝窗不得产生假 end");
  recorder.sample(2, 3, [rejecting]);
  const events = recorder.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, 2);
  assert.equal(events[0].seq, 1, "新一轮 seq 从 1 开始");
});

test("EventRecorder: 粗对准瞬时事件同刻去重，reset 后重新记录", () => {
  const recorder = new EventRecorder(16);
  recorder.sample(1, 0.5, [], { aligned: true, referenceKind: "external" });
  recorder.sample(1, 0.5, [], { aligned: true, referenceKind: "external" });
  let events = recorder.list();
  assert.equal(events.length, 1, "同一时刻重复上报只记一次");
  assert.equal(events[0].kind, "align");
  assert.equal(events[0].phase, "instant");
  assert.equal(events[0].estimator, "all");
  assert.equal(events[0].source, "solve-loop");
  assert.deepEqual(events[0].after, { aligned: true, referenceKind: "external" });

  recorder.sample(1, 1.0, [], { aligned: true });
  assert.equal(recorder.list().length, 2, "不同时刻的对准可以分别记录");
  recorder.reset(1);
  assert.equal(recorder.list().length, 0);
  recorder.sample(1, 0.5, [], { aligned: true });
  assert.equal(recorder.list().length, 1, "reset 清除同刻去重状态");

  recorder.align(1.5, "mahony");
  recorder.align(1.5);
  recorder.sample(1, 1.5, [], { aligned: true });
  const afterExplicit = recorder.list();
  assert.equal(afterExplicit.length, 2, "align() 与 sample().aligned 同刻只记一条");
  assert.deepEqual(afterExplicit[1].after, { aligned: true, referenceKind: "mahony" });
});

test("EventRecorder: 数据断流边沿由调用方显式提交", () => {
  const recorder = new EventRecorder(16);
  assert.throws(() => recorder.dataGap(0, true), /runId/);
  recorder.sample(1, 0, []);
  recorder.dataGap(1, true, "串口超时");
  recorder.dataGap(2, true);
  recorder.dataGap(3, false);
  recorder.dataGap(4, false);
  const events = recorder.list();
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "data-gap");
  assert.equal(events[0].phase, "start");
  assert.equal(events[0].source, "transport");
  assert.equal(events[0].estimator, null);
  assert.match(events[0].summary, /串口超时/);
  assert.equal(events[1].kind, "data-recover");
  assert.equal(events[1].phase, "end");
});

test("EventRecorder: 按估计器与通道隔离，不合并成全局拒绝", () => {
  const recorder = new EventRecorder(32);
  recorder.sample(1, 0, [
    estimator("comp", makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" })),
    estimator("mahony", makeTelemetry({ accelState: "applied", accelReasonCode: "applied" })),
    estimator("kalman", makeTelemetry({
      accelState: "applied",
      accelReasonCode: "applied",
      magState: "rejected",
      magReasonCode: "gate-mahalanobis",
    })),
  ]);
  const events = recorder.list();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => `${event.estimator}/${event.kind}`),
    ["comp/gate-reject", "kalman/gate-reject"],
  );
  assert.match(events[0].summary, /加速度计/);
  assert.match(events[1].summary, /磁力计/);
});

test("EventRecorder: 容量封顶、dropped 准确、list 返回副本", () => {
  const recorder = new EventRecorder(3);
  for (let i = 0; i < 5; i++) recorder.sample(1, i, [], { aligned: true });
  assert.equal(recorder.timeline().size, 3);
  assert.equal(recorder.dropped(), 2);
  assert.deepEqual(recorder.list().map((event) => event.t), [2, 3, 4]);
  const copy = recorder.list();
  copy[0].summary = "改副本";
  copy.pop();
  assert.equal(recorder.list().length, 3);
  assert.notEqual(recorder.list()[0].summary, "改副本");
});

test("EventRecorder: onEvent 收到副本，不污染时间轴", () => {
  const seen: string[] = [];
  const recorder = new EventRecorder(4, {
    onEvent: (event) => {
      event.summary = "回调里修改";
      seen.push(event.kind);
    },
  });
  recorder.sample(1, 0, [
    estimator(
      "comp",
      makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" }),
      "互补滤波",
    ),
  ]);
  assert.deepEqual(seen, ["gate-reject"]);
  assert.notEqual(recorder.list()[0].summary, "回调里修改");
  assert.match(recorder.list()[0].summary, /互补滤波/);
});

test("EventRecorder: 不根据角速度大小或误差猜测饱和事件", () => {
  const recorder = new EventRecorder(16);
  const extreme = estimator("kalman", makeTelemetry({
    rate: [1e9, -1e9, 1e9],
    rawGyro: [1e9, -1e9, 1e9],
    accelState: "applied",
    accelReasonCode: "applied",
    magState: "applied",
    magReasonCode: "applied",
  }));
  for (let i = 0; i < 10; i++) recorder.sample(1, i, [extreme]);
  assert.equal(recorder.list().some((event) => event.kind === "gate-saturation"), false);
  const source = readFileSync(new URL("../src/core/event-recorder.ts", import.meta.url), "utf8");
  assert.match(source, /saturation\(/, "饱和只能来自显式 saturation() 真实信号入口");
});

test("EventRecorder: 饱和只来自显式真实削顶信号，连续削顶只记一对边沿", () => {
  const recorder = new EventRecorder(16);
  assert.throws(() => recorder.saturation(0, true), /runId/);
  recorder.sample(1, 0, []);
  recorder.saturation(1, true);
  recorder.saturation(2, true);
  recorder.saturation(3, true);
  recorder.saturation(4, false);
  recorder.saturation(5, false);
  const events = recorder.list();
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "gate-saturation");
  assert.equal(events[0].phase, "start");
  assert.equal(events[0].source, "sensor");
  assert.equal(events[0].estimator, null);
  assert.equal(events[1].phase, "end");
  assert.deepEqual(events[0].after, { channel: "gyro", saturated: true });
  assert.deepEqual(events[1].after, { channel: "gyro", saturated: false });
  recorder.reset(2);
  assert.equal(recorder.list().length, 0, "reset 后旧饱和事件必须清空");
});

test("EventRecorder: 重连尝试/成功/耗尽是真实传输事件", () => {
  const recorder = new EventRecorder(16);
  recorder.sample(1, 0, []);
  recorder.dataReconnect(1, "attempt", { attempt: 1, max: 3 });
  recorder.dataReconnect(2, "success", { transport: "serial" });
  recorder.dataReconnect(3, "exhausted", { transport: "ble" });
  const events = recorder.list();
  assert.deepEqual(events.map((e) => e.kind), ["data-reconnect", "data-reconnect", "data-reconnect"]);
  assert.ok(events.every((e) => e.phase === "instant" && e.source === "transport" && e.estimator === null));
  assert.match(events[0].summary, /尝试/);
  assert.match(events[1].summary, /成功/);
  assert.match(events[2].summary, /耗尽/);
  assert.throws(() => recorder.dataReconnect(4, "bogus" as never), /status|状态/);
});

test("EventRecorder: 参数/视图/实验装载是真实用户动作事件", () => {
  const recorder = new EventRecorder(16);
  recorder.sample(1, 0, []);
  recorder.userAction(1, "param-change", "解算频率 500→50 Hz", { id: "solve-rate", value: 500 }, { id: "solve-rate", value: 50 });
  recorder.userAction(2, "view-change", "切换视图：attitude→gimbal", { view: "attitude" }, { view: "gimbal" });
  recorder.userAction(3, "experiment-load", "现场已装载：方向门控救场", undefined, { id: "gate", changes: 12, reset: true });
  const events = recorder.list();
  assert.deepEqual(events.map((e) => e.kind), ["param-change", "view-change", "experiment-load"]);
  assert.ok(events.every((e) => e.phase === "instant" && e.source === "user-action" && e.estimator === null));
  assert.equal(events[0].after && (events[0].after as { value: number }).value, 50);
  assert.throws(() => recorder.userAction(4, "gate-reject" as never, "x"), /kind|类型/);
});

test("ObservabilityPanel: 显式遥测状态优先，全部状态有中文标签", () => {
  const states: ObservationState[] = [
    "not-applicable",
    "disabled",
    "invalid",
    "rejected",
    "accepted-not-applied",
    "unrecorded",
    "applied",
  ];
  for (const state of states) {
    const view = buildObservabilityView(makeSnapshot({
      telemetry: makeTelemetry({
        accelState: state,
        accelReasonCode: state === "rejected" ? "gate-direction" : null,
        magState: "disabled",
        magReasonCode: "mag-disabled",
      }),
      magEnabled: false,
    }));
    assert.equal(view.accel.state, state);
    assert.equal(view.accel.stateLabel, OBSERVATION_STATE_LABELS[state]);
    assert.equal(view.mag.stateLabel, "未启用");
  }
});

test("ObservabilityPanel: 原因与有限证据，不把明确拒绝写成 applied", () => {
  const view = buildObservabilityView(makeSnapshot({
    telemetry: makeTelemetry({
      accelState: "rejected",
      accelReasonCode: "gate-direction",
      accelNorm: 9.8,
      magState: "disabled",
      magReasonCode: "mag-disabled",
      detail: { alignErrorDeg: 35, gateMode: 1 },
    }),
    magEnabled: false,
    gateEnabled: true,
    referenceLabel: "Mahony 基准",
  }));
  assert.equal(view.accel.stateLabel, "被拒绝");
  assert.equal(view.accel.reasonCode, "gate-direction");
  assert.equal(view.accel.reasonLabel, "方向门控拒绝");
  assert.match(view.accel.evidenceText, /‖a‖=9\.80 m\/s²/);
  assert.match(view.accel.evidenceText, /夹角=35\.00°/);
  assert.match(view.accel.explanation, /单步/);
  assert.ok(!/不可观|unobservable/i.test(view.accel.explanation));
  assert.ok(!/不可观|unobservable/i.test(view.note));
  assert.equal(view.mag.stateLabel, "未启用");
  assert.equal(view.axis.available, false);
  assert.match(view.axis.note, /无真值/);
  assert.equal(view.axis.tiltDeg, null);
  assert.equal(view.axis.tiltText, "—");
});

test("ObservabilityPanel: 有相对真值才显示分轴幅值，null 时不伪造 0°", () => {
  const noTruth = buildObservabilityView(makeSnapshot({ relativeTruthQuat: null }));
  assert.equal(noTruth.axis.available, false);
  assert.equal(noTruth.axis.tiltDeg, null);
  assert.equal(noTruth.axis.yawDeg, null);
  assert.equal(noTruth.axis.totalDeg, null);

  const yawOnly = qFromAxisAngle([0, 0, 1], 12 * RAD);
  const view = buildObservabilityView(makeSnapshot({
    relativeTruthQuat: yawOnly,
    referenceLabel: "外部参考",
  }));
  assert.equal(view.axis.available, true);
  assert.ok(view.axis.tiltDeg !== null && Math.abs(view.axis.tiltDeg) < 1e-9);
  assert.ok(view.axis.yawDeg !== null && Math.abs(view.axis.yawDeg - 12) < 1e-9);
  assert.ok(view.axis.totalDeg !== null && Math.abs(view.axis.totalDeg - 12) < 1e-9);
  assert.match(view.axis.note, /外部参考/);
  assert.match(view.axis.note, /世界重力轴/);
});

test("ObservabilityPanel: 外部标签按纯文本保留，mount/state/update 语义正确", () => {
  const doc = new FakeDocument();
  const root = doc.createElement("div");
  let snapshot: ObservabilitySnapshot | null = null;
  const opened: string[] = [];
  const api = mountObservabilityPanel(root as unknown as HTMLElement, {
    getSnapshot: () => snapshot,
    openDocs: (page, anchor) => opened.push(`${page}#${anchor ?? ""}`),
  });
  assert.equal(api.state().view, null, "无快照时 state 明确为 null");

  snapshot = makeSnapshot({
    estimatorLabel: "<img src=x onerror=alert(1)>",
    telemetry: makeTelemetry({
      accelState: "rejected",
      accelReasonCode: "gate-direction",
      magState: "disabled",
      magReasonCode: "mag-disabled",
    }),
  });
  const view = api.update();
  assert.ok(view);
  assert.equal(api.state().view?.estimatorLabel, "<img src=x onerror=alert(1)>");
  assert.ok(root.textContent.includes("<img src=x onerror=alert(1)>"), "标签必须按字面文本显示");
  assert.ok(!descendants(root).some((element) => element.tagName === "img"), "标签不得被解析成元素");
  assert.ok(!/不可观|unobservable/i.test(root.textContent));

  const docsButton = descendants(root).find(
    (element) => element.tagName === "button" && element.textContent === "查看可观性说明",
  );
  assert.ok(docsButton, "面板需要可键盘操作的文档入口");
  docsButton.click();
  assert.deepEqual(opened, ["math#m-observability"]);

  api.destroy();
  assert.equal(root.children.length, 0);
});

test("EventPanel: 空态、过滤、最近 N 条倒序与裁剪计数", () => {
  const timeline = new EventTimeline(2);
  timeline.reset(7);
  let view = buildEventPanelView(timeline);
  assert.equal(view.empty, true);
  assert.match(view.emptyText, /不推断原因/);
  assert.equal(view.droppedText, "未发生裁剪");
  assert.equal(view.rows.length, 0);

  timeline.add(7, makeEvent({ t: 0, kind: "align", estimator: "all", summary: "对准" }));
  timeline.add(7, makeEvent({ t: 1, kind: "gate-reject", estimator: "comp", phase: "start", summary: "拒绝开始" }));
  timeline.add(7, makeEvent({ t: 2, kind: "gate-recovery", estimator: "comp", phase: "end", summary: "拒绝结束" }));
  view = buildEventPanelView(timeline);
  assert.equal(view.dropped, 1);
  assert.match(view.droppedText, /已裁剪 1 条更早事件/);
  assert.equal(view.total, 2);
  assert.deepEqual(view.rows.map((row) => row.t), [2, 1], "列表新→旧");
  assert.equal(view.rows[0].kindLabel, "门控恢复");
  assert.match(view.rows[0].ariaLabel, /按下后定位到该时刻/);
  assert.match(view.metaText, /容量 2/);

  const gate = buildEventPanelView(timeline, "gate");
  assert.equal(gate.visibleCount, 2);
  assert.equal(gate.rows.length, 2);
  const data = buildEventPanelView(timeline, "data");
  assert.equal(data.empty, true);
  assert.match(data.emptyText, /其他类别仍有 2 条/);
});

test("EventPanel: 超过面板上限只显示最近 N 条", () => {
  const timeline = new EventTimeline(200);
  timeline.reset(1);
  for (let i = 0; i < EVENT_PANEL_LIMIT + 5; i++) {
    timeline.add(1, makeEvent({ t: i, kind: "custom", summary: `e${i}` }));
  }
  const view = buildEventPanelView(timeline);
  assert.equal(view.shownCount, EVENT_PANEL_LIMIT);
  assert.equal(view.visibleCount, EVENT_PANEL_LIMIT + 5);
  assert.equal(view.rows[0].summary, `e${EVENT_PANEL_LIMIT + 4}`);
  assert.equal(view.rows[view.rows.length - 1].summary, "e5");
});

test("EventPanel: mount/update/state、按钮 seek、过滤器与换轮清空", () => {
  const timeline = new EventTimeline(8);
  timeline.reset(3);
  timeline.add(3, makeEvent({
    t: 1,
    kind: "gate-reject",
    estimator: "comp",
    phase: "start",
    summary: "<script>alert(1)</script>",
  }));
  timeline.add(3, makeEvent({ t: 2, kind: "align", estimator: "all", summary: "对准" }));

  const doc = new FakeDocument();
  const root = doc.createElement("div");
  const seeks: number[] = [];
  const api = mountEventPanel(root as unknown as HTMLElement, {
    getTimeline: () => timeline,
    seek: (t) => seeks.push(t),
    openDocs: () => {},
  });
  let state = api.state();
  assert.ok(state.view);
  assert.equal(state.view?.rows.length, 2);
  assert.ok(root.textContent.includes("<script>alert(1)</script>"), "事件摘要按纯文本显示");
  assert.ok(!descendants(root).some((element) => element.tagName === "script"), "摘要不得被解析成元素");

  const eventButtons = descendants(root).filter(
    (element) => element.tagName === "button" && hasClass(element, "event-item"),
  );
  assert.equal(eventButtons.length, 2);
  assert.match(eventButtons[0].textContent, /t=2\.000 s/);
  eventButtons[1].click();
  assert.deepEqual(seeks, [1], "点击事件按钮定位到该事件真实 t");
  assert.equal(api.state().selectedSeq, 1);

  const gateFilter = descendants(root).find((element) => element.getAttribute("data-filter") === "gate");
  assert.ok(gateFilter);
  gateFilter.click();
  state = api.state();
  assert.equal(state.filter, "gate");
  assert.equal(state.view?.rows.length, 1);
  assert.equal(state.view?.rows[0].kind, "gate-reject");
  assert.equal(gateFilter.getAttribute("aria-pressed"), "true");

  timeline.reset(4);
  api.update();
  state = api.state();
  assert.equal(state.view?.runId, 4);
  assert.equal(state.view?.rows.length, 0);
  assert.equal(state.selectedSeq, null, "换轮后旧选择不得保留");
  api.destroy();
  assert.equal(root.children.length, 0);
});

test("模块边界：不静态 import main、不拼接 HTML、记录器不碰 DOM/墙钟/随机", () => {
  const files = [
    ["event-recorder.ts", "../src/core/event-recorder.ts"],
    ["observability-panel.ts", "../src/ui/observability-panel.ts"],
    ["event-panel.ts", "../src/ui/event-panel.ts"],
  ] as const;
  for (const [name, url] of files) {
    const source = readFileSync(new URL(url, import.meta.url), "utf8");
    assert.ok(!/from\s+["'][^"']*main["']/.test(source), `${name} 不得静态 import main`);
    assert.ok(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
  const recorder = readFileSync(new URL("../src/core/event-recorder.ts", import.meta.url), "utf8");
  assert.ok(!/\bdocument\b|\bwindow\b|\bperformance\b/.test(recorder), "记录器不得依赖 DOM/墙钟");
  assert.ok(!/new\s+Date\b|Math\.random/.test(recorder), "记录器不得使用 Date/随机数");
});

console.log(`event-observability-ui-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
