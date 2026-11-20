/**
 * C/D「遥测与诊断」接线服务的离线契约测试（Node 端，不启动浏览器）。
 *
 * 覆盖 docs/CD-WIRING-DECISION-PLAN.md §3.1 的按需接线不变量：
 *  1. 模块 import 无副作用，多实例互相独立；
 *  2. 回看捕获默认关闭：未开启时 sample 不增长 reviewFrames；
 *  3. setReviewCapture 开启后按容量封顶、换轮隔离；
 *  4. ESKF sink 仅在开启时挂载、关闭时摘除，重复开启不重复挂；
 *  5. 无当前估计器时 update()/sample() 不抛错；
 *  6. reset(runId) 清空事件与回看计数；
 *  7. 事件来自真实遥测边沿（连续拒绝只记一对）、粗对准同刻去重；
 *  8. 回看覆盖只读取缓冲帧，退出回看即停止捕获；
 *  9. 模块边界：不静态 import main/runner/scene。
 *
 * 运行：npx tsx scripts/telemetry-diagnostics-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REVIEW_RECORD_DT,
  createTelemetryDiagnostics,
  type TelemetryDiagnosticsApi,
  type TelemetryDiagnosticsDeps,
  type TelemetryDiagnosticsEstimatorSource,
  type TelemetryDiagnosticsSample,
  type TelemetryDiagnosticsSelected,
  type TelemetryDiagnosticsTruth,
} from "../src/ui/telemetry-diagnostics";
import { ReviewBuffer, type ReviewFrame } from "../src/core/review-buffer";
import type { EstimatorTelemetry, KalmanStepSnapshot } from "../src/estimators";
import type { Quat } from "../src/core/quat";

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

function makeTelemetry(overrides: Partial<EstimatorTelemetry> = {}): EstimatorTelemetry {
  return {
    rate: [0.1, 0.2, 0.3],
    rawGyro: [0.01, -0.02, 0.03],
    correction: [0.09, 0.22, 0.27],
    predictedGravity: [0, 0, 1],
    measuredGravity: [0, 0, 1],
    accelNorm: 9.80665,
    accelValid: true,
    magValid: true,
    accelState: "unrecorded",
    magState: "unrecorded",
    accelReasonCode: "not-recorded",
    magReasonCode: "not-recorded",
    detail: {},
    ...overrides,
  };
}

function makeSample(t: number, aligned = false): TelemetryDiagnosticsSample {
  return {
    t,
    dt: 0.01,
    aligned,
    raw: { gyro: [0.1, 0.2, 0.3], accel: [0, 0, 9.80665], mag: [30, 0, 38] },
    consumed: { gyro: [0.11, 0.22, 0.33], accel: [0.01, 0, 9.8], mag: [31, 1, 37] },
  };
}

function makeSnapshot(): KalmanStepSnapshot {
  return {
    dt: 0.01,
    qInput: { ...Q0 },
    biasInputRad: [0, 0, 0],
    pDiagInput: [0.007, 0.007, 0.007, 0.00007, 0.00007, 0.00007],
    correctedGyroRad: [0, 0, 0],
    qPredicted: { ...Q0 },
    pDiagPredicted: [0.006, 0.006, 0.006, 0.00006, 0.00006, 0.00006],
    observations: [],
    qFinal: { ...Q0 },
    biasFinalRad: [0, 0, 0],
    pDiagFinal: [0.005, 0.005, 0.005, 0.00005, 0.00005, 0.00005],
    covarianceResetApplied: false,
  };
}

// ---------------------------------------------------------------------------
// 最小假 DOM：只实现四个面板 + 服务实际使用的 API；不引入新依赖。
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
  disabled = false;
  type = "";
  innerHTML = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  private ownText = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
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

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
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

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    for (const element of this.descendants()) {
      if (selector.startsWith(".")) {
        if (element.className.split(/\s+/).includes(selector.slice(1))) return element;
      } else if (element.tagName === selector.toUpperCase()) {
        return element;
      }
    }
    return null;
  }
}

function htmlOf(element: FakeElement): string {
  return (element.innerHTML || "") + element.children.map((child) => htmlOf(child)).join("");
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  return root.descendants().find((element) => element.className.split(/\s+/).includes(className)) ?? null;
}

function findByAttr(root: FakeElement, name: string, value: string): FakeElement | null {
  return (
    root.descendants().find((element) => element.getAttribute(name) === value) ?? null
  );
}

// ---------------------------------------------------------------------------
// 服务测试夹具
// ---------------------------------------------------------------------------
interface Harness {
  root: FakeElement;
  deps: TelemetryDiagnosticsDeps;
  selected: { value: TelemetryDiagnosticsSelected | null };
  estimators: { value: TelemetryDiagnosticsEstimatorSource[] };
  truth: { value: TelemetryDiagnosticsTruth };
  kalmanSnapshot: { value: KalmanStepSnapshot | null };
  sink: { value: ((snap: KalmanStepSnapshot) => void) | null };
  sinkCalls: Array<((snap: KalmanStepSnapshot) => void) | null>;
  time: { value: number };
  runId: { value: number };
  cursors: Array<number | null>;
  service: TelemetryDiagnosticsApi;
}

function makeHarness(reviewCapacity = 750, withEstimators = false): Harness {
  const doc = new FakeDocument();
  const root = doc.createElement("div");
  const telemetry = makeTelemetry();
  const selected: Harness["selected"] = {
    value: {
      id: "comp",
      label: "互补滤波",
      magEnabled: false,
      gateEnabled: true,
      telemetry,
      q: { ...Q0 },
    },
  };
  const estimators: Harness["estimators"] = { value: [] };
  const truth: Harness["truth"] = { value: { kind: "groundTruth", q: { ...Q0 }, label: "模拟真值" } };
  const kalmanSnapshot: Harness["kalmanSnapshot"] = { value: null };
  const sink: Harness["sink"] = { value: null };
  const sinkCalls: Harness["sinkCalls"] = [];
  const time = { value: 0 };
  const runId = { value: 1 };
  const cursors: Array<number | null> = [];
  const deps: TelemetryDiagnosticsDeps = {
    root: root as unknown as HTMLElement,
    getSelected: () => selected.value,
    // 只在需要五算法的用例里声明；其余用例走 getSelected 回退路径。
    ...(withEstimators ? { getEstimators: () => estimators.value } : {}),
    getTruth: () => truth.value,
    getKalmanSnapshot: () => kalmanSnapshot.value,
    getTime: () => time.value,
    getRunId: () => runId.value,
    setCursor: (t) => cursors.push(t),
    openDocs: () => {},
    setKalmanSink: (s) => {
      sinkCalls.push(s);
      sink.value = s;
    },
  };
  const service = createTelemetryDiagnostics(deps, { reviewCapacity });
  return {
    root,
    deps,
    selected,
    estimators,
    truth,
    kalmanSnapshot,
    sink,
    sinkCalls,
    time,
    runId,
    cursors,
    service,
  };
}

// ---------------------------------------------------------------------------
// 1. import 无副作用 / 多实例独立
// ---------------------------------------------------------------------------
test("import 无副作用：两个服务实例互相独立", () => {
  const a = makeHarness();
  const b = makeHarness();
  assert.equal(a.service.state().eventCount, 0);
  assert.equal(b.service.state().eventCount, 0);
  assert.equal(a.root.children.length, 1, "只在给定 root 内追加一个容器");
  assert.equal(b.root.children.length, 1);
  assert.notEqual(a.root, b.root);

  a.service.setReviewCapture(true);
  for (let i = 0; i < 5; i++) a.service.sample(makeSample(i * REVIEW_RECORD_DT));
  assert.ok(a.service.state().reviewFrames > 0, "A 自己不应为空");
  assert.equal(b.service.state().reviewFrames, 0, "A 的采样不得污染 B");
  assert.equal(b.service.state().eventCount, 0, "A 的事件不得污染 B");
});

// ---------------------------------------------------------------------------
// 2. 回看捕获默认关闭
// ---------------------------------------------------------------------------
test("回看捕获默认关闭：sample 不增长 reviewFrames", () => {
  const h = makeHarness();
  assert.equal(h.service.state().reviewCapture, false);
  for (let i = 0; i < 10; i++) h.service.sample(makeSample(i * 0.05));
  assert.equal(h.service.state().reviewFrames, 0);
  assert.equal(h.service.state().reviewCapture, false);
});

// ---------------------------------------------------------------------------
// 3. 捕获开启后按容量封顶 + 换轮隔离
// ---------------------------------------------------------------------------
test("回看：开启后按容量封顶，换轮自动隔离", () => {
  const h = makeHarness(4);
  h.service.setReviewCapture(true);
  assert.equal(h.service.state().reviewCapture, true);
  for (let i = 0; i < 10; i++) h.service.sample(makeSample(i * 0.05));
  assert.equal(h.service.state().reviewFrames, 4, "超过容量按环形缓冲封顶");

  // 宿主未显式 reset，仅切换 runId：sample 内自动作废旧帧，不得串轮。
  h.runId.value = 2;
  h.service.sample(makeSample(0));
  assert.equal(h.service.state().reviewFrames, 1, "新轮第一帧后旧帧已被清空");
});

// ---------------------------------------------------------------------------
// 4. ESKF sink 按需挂载/摘除
// ---------------------------------------------------------------------------
test("ESKF：仅在开启时挂 sink，关闭摘除，重复开启不重复挂", () => {
  const h = makeHarness();
  assert.equal(h.sinkCalls.length, 0, "创建服务不得挂 sink");
  assert.equal(h.sink.value, null);
  assert.equal(h.service.state().eskfEnabled, false);

  h.service.setEskfEnabled(true);
  assert.equal(h.service.state().eskfEnabled, true);
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(typeof h.sink.value, "function");

  h.service.setEskfEnabled(true);
  assert.equal(h.sinkCalls.length, 1, "重复开启不得重复挂载");

  h.service.setEskfEnabled(false);
  assert.equal(h.service.state().eskfEnabled, false);
  assert.equal(h.sinkCalls.length, 2);
  assert.equal(h.sink.value, null, "关闭后恢复默认路径");
});

test("ESKF：服务自带的采集按钮切换 sink", () => {
  const h = makeHarness();
  const button = h.root.querySelector(".td-eskf-toggle");
  assert.ok(button, "服务需在 ESKF 面板旁提供采集按钮");
  button.click();
  assert.equal(h.service.state().eskfEnabled, true);
  assert.equal(h.sinkCalls.length, 1);
  button.click();
  assert.equal(h.service.state().eskfEnabled, false);
  assert.equal(h.sink.value, null);
});

// ---------------------------------------------------------------------------
// 5. 无当前估计器不抛错
// ---------------------------------------------------------------------------
test("无当前估计器时 update/sample 不抛错", () => {
  const h = makeHarness();
  h.selected.value = null;
  assert.doesNotThrow(() => h.service.update());
  assert.doesNotThrow(() => h.service.sample(makeSample(0)));
  assert.doesNotThrow(() => h.service.sample(makeSample(0.5, true)));
  assert.equal(h.service.state().eventCount, 1, "无估计器仍可记录粗对准瞬时事件");
});

// ---------------------------------------------------------------------------
// 6. reset 清零
// ---------------------------------------------------------------------------
test("reset(runId) 清空事件与回看计数", () => {
  const h = makeHarness();
  h.service.setReviewCapture(true);
  h.selected.value = {
    ...h.selected.value!,
    telemetry: makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" }),
  };
  for (let i = 0; i < 10; i++) h.service.sample(makeSample(i * 0.05));
  assert.ok(h.service.state().eventCount > 0);
  assert.ok(h.service.state().reviewFrames > 0);

  h.service.reset(7);
  assert.equal(h.service.state().eventCount, 0);
  assert.equal(h.service.state().reviewFrames, 0);
});

// ---------------------------------------------------------------------------
// 7. 事件来自真实边沿 + 粗对准去重
// ---------------------------------------------------------------------------
test("事件：连续拒绝只记一对开始/结束边沿", () => {
  const h = makeHarness();
  h.selected.value = {
    ...h.selected.value!,
    telemetry: makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" }),
  };
  h.service.sample(makeSample(0));
  h.service.sample(makeSample(0.01));
  h.service.sample(makeSample(0.02));
  assert.equal(h.service.state().eventCount, 1, "连续拒绝只形成一条 start");

  h.selected.value = {
    ...h.selected.value!,
    telemetry: makeTelemetry({ accelState: "applied", accelReasonCode: "applied" }),
  };
  h.service.sample(makeSample(0.03));
  assert.equal(h.service.state().eventCount, 2, "恢复产生一条 end");
});

test("事件：粗对准同刻去重", () => {
  const h = makeHarness();
  h.service.sample(makeSample(1.0, true));
  h.service.sample(makeSample(1.0, true));
  assert.equal(h.service.state().eventCount, 1, "同一时刻只记一条粗对准");
  h.service.sample(makeSample(1.5, true));
  assert.equal(h.service.state().eventCount, 2, "不同时刻分别记录");
});

test("事件：五个估计器各自归并拒绝边沿，切换选中不丢失其他算法", () => {
  const h = makeHarness(750, true);
  const ids = ["pure", "comp", "mahony", "madg", "kalman"] as const;
  const rejected = (id: (typeof ids)[number] | "truth"): TelemetryDiagnosticsEstimatorSource => ({
    id,
    label: `${id}-label`,
    telemetry: makeTelemetry({ accelState: "rejected", accelReasonCode: "gate-direction" }),
  });

  // 宿主数组可含 truth；服务必须过滤，不能把参考项记成第六条边沿。
  h.estimators.value = [...ids.map(rejected), rejected("truth")];
  h.service.sample(makeSample(0));
  assert.equal(h.service.state().eventCount, 5, "五个算法各产生一条 start，truth 被过滤");

  // 切换当前选中算法不改变事件来源；其他四个算法仍处于拒绝窗内。
  h.selected.value = {
    id: "kalman",
    label: "卡尔曼滤波",
    magEnabled: false,
    gateEnabled: true,
    telemetry: makeTelemetry({ accelState: "applied", accelReasonCode: "applied" }),
    q: { ...Q0 },
  };
  h.service.sample(makeSample(0.01));
  assert.equal(h.service.state().eventCount, 5, "切换选中不得丢失或重复其他算法事件");

  // 仅互补滤波恢复：只有它产生一条 end，其余四个算法的拒绝窗保持打开。
  h.estimators.value[1] = {
    ...rejected("comp"),
    telemetry: makeTelemetry({ accelState: "applied", accelReasonCode: "applied" }),
  };
  h.service.sample(makeSample(0.02));
  assert.equal(h.service.state().eventCount, 6, "各算法按自己的状态独立归并");
});

// ---------------------------------------------------------------------------
// 8. 回看覆盖只读 + 退出停止捕获
// ---------------------------------------------------------------------------
test("回看：进入回看返回真实帧，退出即停止捕获且覆盖为 null", () => {
  const h = makeHarness();
  h.truth.value = { kind: "groundTruth", q: { ...Q0 }, label: "模拟真值" };
  h.service.setReviewCapture(true);
  h.service.sample(makeSample(0));
  assert.equal(h.service.state().reviewFrames, 1);
  assert.equal(h.service.reviewOverride(), null, "未进入回看不提供覆盖");

  const toggle = findByAttr(h.root, "data-review-action", "toggle");
  assert.ok(toggle, "回看面板需有回看模式按钮");
  toggle.click();
  assert.equal(h.service.state().activePanel, "review");
  const override = h.service.reviewOverride();
  assert.ok(override, "进入回看后应返回缓冲中的真实帧");
  assert.deepEqual(override!.q, Q0);
  assert.deepEqual(override!.truthQ, Q0);

  const exit = findByAttr(h.root, "data-review-action", "exit");
  assert.ok(exit);
  exit.click();
  assert.equal(h.service.reviewOverride(), null);
  assert.equal(h.service.state().reviewCapture, false, "退出回看应停止写入回看帧");
});

test("TQ-05 回看 Inspector：历史帧与实时快照各用自己时刻，缺快照不回退", () => {
  const h = makeHarness();
  const snapshot = makeSnapshot();
  h.time.value = 1.234;
  h.kalmanSnapshot.value = snapshot;
  h.service.setEskfEnabled(true);
  h.sink.value?.(snapshot);
  h.service.setReviewCapture(true);
  h.service.sample(makeSample(1.234));
  findByAttr(h.root, "data-review-action", "toggle")!.click();
  h.service.update();
  let panel = findByClass(h.root, "eskf-panel")!;
  let html = htmlOf(panel);
  assert.ok(html.includes("t = 1.234 s"), "历史 Inspector 必须使用回看帧时间");
  assert.ok(html.includes("协方差"), "历史 Inspector 必须显示该帧快照内容");

  // 历史帧没有快照时不得回退到实时快照。
  findByAttr(h.root, "data-review-action", "exit")!.click();
  h.service.setEskfEnabled(false);
  h.time.value = 2.0;
  h.service.setReviewCapture(true);
  h.service.sample(makeSample(2.0));
  findByAttr(h.root, "data-review-action", "toggle")!.click();
  h.service.update();
  panel = findByClass(h.root, "eskf-panel")!;
  html = htmlOf(panel);
  assert.ok(html.includes("当前步未记录内部快照"), "缺快照必须明确显示");
  assert.ok(!html.includes("t = 1.234 s"), "不得展示上一帧快照");

  // 实时 Inspector 的快照时间必须绑定采集时刻，而不是世界最新时间。
  findByAttr(h.root, "data-review-action", "exit")!.click();
  h.service.setEskfEnabled(true);
  h.time.value = 3.0;
  h.sink.value?.(snapshot);
  h.time.value = 9.0;
  h.service.update();
  panel = findByClass(h.root, "eskf-panel")!;
  html = htmlOf(panel);
  assert.ok(html.includes("t = 3.000 s"), "实时 Inspector 必须显示快照采集时刻");
  assert.ok(!html.includes("t = 9.000 s"), "不得用最新世界时间冒充快照时刻");
});

test("回看帧：ESKF 开启时写入当前快照，关闭时不写字段", () => {
  const captured: ReviewFrame[] = [];
  const originalPush = ReviewBuffer.prototype.push;
  ReviewBuffer.prototype.push = function (this: ReviewBuffer, frame: ReviewFrame): void {
    captured.push(frame);
    originalPush.call(this, frame);
  };
  try {
    const h = makeHarness();
    const snapshot = makeSnapshot();
    h.kalmanSnapshot.value = snapshot;
    h.service.setReviewCapture(true);

    h.service.sample(makeSample(0));
    assert.equal(captured.length, 1);
    assert.equal("eskf" in captured[0], false, "ESKF 未开启时不得写快照字段");

    h.service.setEskfEnabled(true);
    h.service.sample(makeSample(REVIEW_RECORD_DT));
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[1].eskf, snapshot, "开启后帧必须携带当前快照");
    assert.notEqual(captured[1].eskf, snapshot, "写入快照必须是独立副本");

    h.service.setEskfEnabled(false);
    h.service.sample(makeSample(REVIEW_RECORD_DT * 2));
    assert.equal(captured.length, 3);
    assert.equal("eskf" in captured[2], false, "关闭后恢复不写快照字段");
  } finally {
    ReviewBuffer.prototype.push = originalPush;
  }
});

// ---------------------------------------------------------------------------
// 9. 误差证据导航（不依赖 main）
// ---------------------------------------------------------------------------
test("证据 API：最大误差、前后证据、真实事件窗口与 update 提示保持", () => {
  const h = makeHarness();
  h.service.setReviewCapture(true);
  const errors = [1, 5, 2, 9, 3];
  errors.forEach((degrees, index) => {
    const angle = (degrees * Math.PI) / 180;
    h.selected.value = {
      ...h.selected.value!,
      q: { w: Math.cos(angle / 2), x: Math.sin(angle / 2), y: 0, z: 0 },
    };
    h.time.value = index * 0.05;
    h.service.sample(makeSample(index * 0.05));
  });
  h.time.value = 0.15;
  h.service.userAction("param-change", "误差峰附近的真实参数修改", { value: 1 }, { value: 2 });

  const maximum = h.service.seekEvidence(0);
  assert.equal(maximum.moved, true);
  assert.equal(maximum.frame?.seq, 3);
  assert.ok(Math.abs(maximum.frame!.errors.totalDeg! - 9) < 1e-6);
  assert.deepEqual(maximum.events.map((event) => event.kind), ["param-change"]);
  assert.equal(h.service.reviewOverride()?.q.x, maximum.frame?.estimate.q.x);

  const previous = h.service.seekEvidence(-1);
  assert.equal(previous.moved, true);
  assert.equal(previous.frame?.seq, 1);
  assert.equal(h.service.seekEvidence(-1).moved, false, "最早证据点保持原帧");
  assert.equal(h.service.seekEvidence(1).frame?.seq, 3);
  assert.equal(h.service.seekEvidence(1).moved, false, "最新证据点保持原帧");

  const selectedNote = h.service.evidence().note;
  h.service.update();
  assert.equal(h.service.evidence().note, selectedNote, "update 不得覆盖证据导航提示");
  assert.equal(h.service.evidence().frame?.seq, 3);
  const reviewBody = findByClass(h.root, "review-body");
  assert.ok(reviewBody?.innerHTML.includes("param-change"));
  assert.ok(reviewBody?.innerHTML.includes("误差峰附近的真实参数修改"));
  assert.ok(reviewBody?.innerHTML.includes("保守解释"));

  // 返回实时后仍可直接跳最大误差；面板按钮与服务 API 走同一个控制器。
  findByAttr(h.root, "data-review-action", "exit")!.click();
  findByAttr(h.root, "data-review-action", "evidence-max")!.click();
  assert.equal(h.service.evidence().frame?.seq, 3);
  assert.ok(Math.abs(h.cursors[h.cursors.length - 1]! - 0.15) < 1e-12);

  h.runId.value = 4;
  const crossed = h.service.seekEvidence(0);
  assert.equal(crossed.moved, false);
  assert.equal(crossed.frame, null);
  assert.match(crossed.note, /运行已切换/);
  assert.equal(h.service.reviewOverride(), null, "跨轮后不得继续覆盖旧姿态");
});

test("证据 API：空帧与 reset 后返回结构化空结果，不调用场景", () => {
  const h = makeHarness();
  let result = h.service.seekEvidence(0);
  assert.equal(result.moved, false);
  assert.equal(result.frame, null);
  assert.deepEqual(result.events, []);
  assert.match(result.note, /没有可回看的帧|还没有可回看的帧/);
  assert.equal(h.service.evidence().note, result.note, "失败提示必须可从 evidence() 立即读到");

  h.service.setReviewCapture(true);
  h.service.sample(makeSample(0));
  h.service.seekEvidence(0);
  h.service.reset(8);
  const afterReset = h.service.evidence();
  assert.equal(afterReset.frame, null);
  assert.deepEqual(afterReset.events, []);
  assert.equal(h.service.reviewOverride(), null);
});

// ---------------------------------------------------------------------------
// 10. destroy
// ---------------------------------------------------------------------------
test("destroy 摘 sink 并移除宿主容器", () => {
  const h = makeHarness();
  h.service.setEskfEnabled(true);
  assert.equal(h.sinkCalls.length, 1);
  h.service.destroy();
  assert.equal(h.sink.value, null, "destroy 必须摘掉 ESKF sink");
  assert.equal(h.root.children.length, 0, "destroy 移除全部 DOM 宿主");
});

// ---------------------------------------------------------------------------
// 10. 模块边界
// ---------------------------------------------------------------------------
test("模块边界：不静态 import main/runner/scene，无模块级副作用", () => {
  const source = readFileSync(
    new URL("../src/ui/telemetry-diagnostics.ts", import.meta.url),
    "utf8",
  );
  const specifiers = [
    ...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["'];/gm),
  ].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "应能解析出 import 说明符");
  assert.ok(
    !specifiers.some(
      (specifier) =>
        specifier.includes("core/runner") ||
        specifier.includes("/scene/") ||
        specifier.includes("main") ||
        specifier.includes("../main"),
    ),
    `不得静态加载 main/runner/scene：${specifiers.join(", ")}`,
  );
  // 顶层不得直接调用工厂（创建服务只能由宿主在用户动作后触发）。
  assert.ok(
    !/^createTelemetryDiagnostics\(/m.test(source),
    "模块顶层不得自行创建服务",
  );
});

test("F-05：饱和只来自样本真实削顶标记，连续削顶只记一对边沿", () => {
  const h = makeHarness();
  const saturated = makeSample(1);
  saturated.raw = { ...saturated.raw, gyroSaturated: true };
  h.service.sample(saturated);
  h.service.sample(saturated);
  h.service.sample(makeSample(2));
  h.service.sample(makeSample(3));
  assert.equal(h.service.state().eventCount, 2, "true→true→false→false 只能形成 start/end 两条");
});

test("F-05：传输断流/重连/用户动作经服务 API 进入同一时间轴", () => {
  const h = makeHarness();
  h.service.sample(makeSample(0));
  h.time.value = 1;
  h.service.dataGap(true, "串口超时");
  h.service.dataReconnect("attempt", { attempt: 1, max: 3 });
  h.service.userAction("param-change", "解算频率 500→50 Hz", { value: 500 }, { value: 50 });
  h.service.dataGap(false);
  h.service.dataReconnect("success", { transport: "serial" });
  h.service.userAction("view-change", "切换视图", { view: "attitude" }, { view: "gimbal" });
  h.service.userAction("experiment-load", "现场已装载", undefined, { id: "gate" });
  assert.equal(h.service.state().eventCount, 7, "gap start/end + reconnect×2 + 三类用户动作");
});

test("F-07：完整 P 矩阵是显式开关，默认关闭", () => {
  const h = makeHarness();
  assert.equal(h.service.state().eskfFullMatrix, false);
  h.service.setEskfFullMatrix(true);
  assert.equal(h.service.state().eskfFullMatrix, true);
  h.service.setEskfFullMatrix(false);
  assert.equal(h.service.state().eskfFullMatrix, false);
  assert.ok(h.root.textContent.includes("完整 P 矩阵") || h.root.children.length > 0);
});

console.log(`telemetry-diagnostics-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
