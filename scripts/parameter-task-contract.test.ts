/**
 * F-04 参数元数据 / 任务上下文的独立契约测试。
 *
 * 不启动浏览器、不复制 main.ts 的监听逻辑：
 *  1. 元数据控件 id 必须真实存在于 index.html，文档页/锚点也必须存在；
 *  2. `resets` 与 main.ts 的实际 resetSim 调用一致（注释给出证据位置）；
 *  3. 变化反馈必须报告真实重置、量化后的实际值与模式说明；
 *  4. 任务状态机只对「非变量配置变化」标偏离，退出/空输入安全且无隐藏持久化；
 *  5. 两个新模块保持无 DOM / 无 HTML / 无配置依赖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PARAMETER_METAS,
  describeParameterChange,
  parameterMeta,
  type ControlMeta,
} from "../src/ui/parameter-meta";
import {
  createComparisonTask,
  createExperimentTask,
  createFreeTask,
  exitTask,
  markDeviation,
  type TaskContext,
} from "../src/ui/task-context";
import { mountTaskStrip, type TaskStripApi } from "../src/ui/task-strip";

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

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainTs = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const parameterSource = readFileSync(new URL("../src/ui/parameter-meta.ts", import.meta.url), "utf8");
const taskSource = readFileSync(new URL("../src/ui/task-context.ts", import.meta.url), "utf8");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const docPages = new Set([...html.matchAll(/data-doc-page="([^"]+)"/g)].map((m) => m[1]));

// ---------------------------------------------------------------------------
// 最小假 DOM：只实现 task-strip 实际使用的 API，并按「捕获 → 目标 → 冒泡」
// 派发 input/change，用来锁住 FIX-10 的事件时序；不启动浏览器、不引新依赖。
// ---------------------------------------------------------------------------
type FakeListener = (event: { type: string; target: FakeElement }) => void;

class FakeClassList {
  private readonly names = new Set<string>();
  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }
  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }
  toggle(name: string, force?: boolean): void {
    if (force === true) this.names.add(name);
    else if (force === false) this.names.delete(name);
    else if (this.names.has(name)) this.names.delete(name);
    else this.names.add(name);
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeElement {
  readonly id: string;
  type = "";
  value = "";
  checked = false;
  valueAsNumber = 0;
  textContent = "";
  innerHTML = "";
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, FakeListener[]>();

  constructor(id = "") {
    this.id = id;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
}

class FakeInputElement extends FakeElement {}
class FakeSelectElement extends FakeElement {}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();
  readonly controls: FakeElement[] = [];
  private readonly capture = new Map<string, FakeListener[]>();
  private readonly bubble = new Map<string, FakeListener[]>();

  register(element: FakeElement): FakeElement {
    this.elements.set(element.id, element);
    return element;
  }

  querySelector(selector: string): FakeElement | null {
    const match = /^\[id="([^"]+)"\]$/.exec(selector);
    return match ? this.elements.get(match[1]) ?? null : null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return this.controls;
  }

  addEventListener(
    type: string,
    listener: FakeListener,
    options?: boolean | { capture?: boolean },
  ): void {
    const capture = options === true || (typeof options === "object" && options?.capture === true);
    const map = capture ? this.capture : this.bubble;
    const list = map.get(type) ?? [];
    list.push(listener);
    map.set(type, list);
  }

  dispatch(element: FakeElement, type: string): void {
    const event = { type, target: element };
    for (const listener of this.capture.get(type) ?? []) listener(event);
    for (const listener of element.listeners.get(type) ?? []) listener(event);
    for (const listener of this.bubble.get(type) ?? []) listener(event);
  }
}

interface TaskStripHarness {
  api: TaskStripApi;
  document: FakeDocument;
  control(id: string): FakeElement;
  main: FakeElement;
  detail: FakeElement;
}

function mountTaskStripHarness(): TaskStripHarness {
  const doc = new FakeDocument();
  for (const id of [
    "task-strip",
    "task-strip-title",
    "task-strip-conditions",
    "task-strip-variable",
    "task-strip-observe",
    "task-strip-next",
    "task-strip-deviation",
    "task-strip-exit",
    "param-feedback",
    "param-feedback-main",
    "param-feedback-detail",
  ]) {
    doc.register(new FakeElement(id));
  }

  const controls = new Map<string, FakeElement>();
  const addInput = (id: string, type: string, value: string): FakeElement => {
    const element = new FakeInputElement(id);
    element.type = type;
    element.value = value;
    element.valueAsNumber = Number(value);
    doc.controls.push(element);
    controls.set(id, element);
    return element;
  };
  addInput("imu-gyro-bias", "range", "1");
  addInput("imu-gyro-noise", "range", "0.2");
  addInput("init-offset-toggle", "checkbox", "");
  const solveRate = new FakeSelectElement("solve-rate");
  solveRate.value = "500";
  doc.controls.push(solveRate);
  controls.set("solve-rate", solveRate);

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = doc;
  globals.window = { setTimeout: () => 0, clearTimeout: () => undefined };
  globals.HTMLInputElement = FakeInputElement;
  globals.HTMLSelectElement = FakeSelectElement;
  globals.HTMLElement = FakeElement;

  const main = doc.querySelector('[id="param-feedback-main"]')!;
  const detail = doc.querySelector('[id="param-feedback-detail"]')!;
  return {
    api: mountTaskStrip(),
    document: doc,
    control: (id) => {
      const element = controls.get(id);
      assert.ok(element, `假 DOM 缺少控件 ${id}`);
      return element;
    },
    main,
    detail,
  };
}

const REQUIRED_IDS = [
  "imu-gyro-bias",
  "imu-gyro-noise",
  "imu-lin-accel",
  "imu-vibration",
  "imu-delay",
  "solve-rate",
  "gate-toggle",
  "gate-deg",
  "gate-mag",
  "gate-recovery",
  "mag-enable",
  "mag-mode",
  "mahony-kp",
  "mahony-ki",
  "madg-beta",
  "kalman-proc",
  "kalman-obs",
  "kalman-gate",
  "init-offset-toggle",
  "experiment-seed",
] as const;

test("元数据覆盖全部必选控件，且每个 id 都真实存在于 index.html", () => {
  assert.ok(PARAMETER_METAS.length >= REQUIRED_IDS.length, `元数据只有 ${PARAMETER_METAS.length} 条`);
  const missingMeta = REQUIRED_IDS.filter((id) => !parameterMeta(id));
  assert.deepEqual(missingMeta, [], `缺少元数据：${missingMeta.join(", ")}`);

  const missingHtml = PARAMETER_METAS.filter((meta) => !htmlIds.has(meta.id)).map((meta) => meta.id);
  assert.deepEqual(missingHtml, [], `这些 id 在 index.html 里找不到：${missingHtml.join(", ")}`);

  const ids = PARAMETER_METAS.map((meta) => meta.id);
  assert.equal(new Set(ids).size, ids.length, "元数据 id 不得重复");
  assert.equal(parameterMeta("not-a-real-control"), undefined, "未登记控件必须返回 undefined");
});

test("元数据字段完整：路径唯一、影响层合法、文档页与锚点存在", () => {
  const affects = new Set(["sensor", "estimator", "schedule", "display"]);
  const paths: string[] = [];
  for (const meta of PARAMETER_METAS) {
    assert.ok(meta.path.length > 0, `${meta.id} 缺配置路径`);
    assert.ok(meta.label.length > 0, `${meta.id} 缺标签`);
    assert.ok(meta.observe.length > 0, `${meta.id} 缺观察建议`);
    assert.ok(affects.has(meta.affects), `${meta.id} 的影响层非法：${meta.affects}`);
    paths.push(meta.path);
    if (meta.doc) {
      assert.ok(docPages.has(meta.doc.page), `${meta.id} 的文档页不存在：${meta.doc.page}`);
      if (meta.doc.anchor) {
        assert.ok(htmlIds.has(meta.doc.anchor), `${meta.id} 的文档锚点不存在：${meta.doc.anchor}`);
      }
    }
  }
  assert.equal(new Set(paths).size, paths.length, "同一配置路径不应登记两次");
});

test("重置语义与 main.ts 真实 resetSim 调用一致", () => {
  // main.ts 证据：
  //  - solve-rate 的 change 处理器末尾 resetSim()；
  //  - init-offset-toggle 的 change 直接绑定 resetSim；
  //  - experiment-seed 的 applySeed() 内 resetSim()。
  // 其余控件走 bindSlider / apply*，只热更新，不调用 resetSim。
  const expected: Record<string, boolean> = {
    "solve-rate": true,
    "init-offset-toggle": true,
    "experiment-seed": true,
    "imu-gyro-bias": false,
    "imu-gyro-noise": false,
    "imu-lin-accel": false,
    "imu-vibration": false,
    "imu-delay": false,
    "gate-toggle": false,
    "gate-deg": false,
    "gate-mag": false,
    "gate-recovery": false,
    "mag-enable": false,
    "mag-mode": false,
    "mahony-kp": false,
    "mahony-ki": false,
    "madg-beta": false,
    "kalman-proc": false,
    "kalman-obs": false,
    "kalman-gate": false,
  };
  for (const [id, resets] of Object.entries(expected)) {
    assert.equal(parameterMeta(id)?.resets, resets, `${id} 的 resets 与 main.ts 不一致`);
  }

  assert.ok(
    mainTs.includes('$("init-offset-toggle").addEventListener("change", resetSim)'),
    "main.ts 的 init-offset-toggle 应直接调用 resetSim",
  );
  const solveStart = mainTs.indexOf('$("solve-rate").addEventListener("change"');
  assert.ok(solveStart >= 0, "main.ts 缺 solve-rate change 处理器");
  const solveBlock = mainTs.slice(solveStart, mainTs.indexOf("});", solveStart) + 3);
  assert.ok(solveBlock.includes("resetSim()"), "solve-rate 处理器必须调用 resetSim");

  const seedStart = mainTs.indexOf("const applySeed");
  assert.ok(seedStart >= 0, "main.ts 缺 applySeed");
  const seedBlock = mainTs.slice(seedStart, mainTs.indexOf("seedInput.addEventListener", seedStart));
  assert.ok(seedBlock.includes("resetSim()"), "experiment-seed 的 applySeed 必须调用 resetSim");

  const functionBody = (name: string): string => {
    const start = mainTs.indexOf(`function ${name}`);
    assert.ok(start >= 0, `main.ts 缺函数 ${name}`);
    const open = mainTs.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < mainTs.length; i++) {
      if (mainTs[i] === "{") depth++;
      else if (mainTs[i] === "}") {
        depth--;
        if (depth === 0) return mainTs.slice(open, i + 1);
      }
    }
    throw new Error(`函数 ${name} 未闭合`);
  };
  for (const name of ["applyMagEnable", "applyAccelGate", "applyMagMode", "applyKalmanGate"]) {
    assert.ok(!functionBody(name).includes("resetSim()"), `${name} 不应调用 resetSim（热更新）`);
  }

  // 非重置的滑块/开关：任何包含其 id 的源码行都不得出现 resetSim。
  const nonResetIds = Object.entries(expected).filter(([, resets]) => !resets).map(([id]) => id);
  for (const id of nonResetIds) {
    const lines = mainTs.split("\n").filter((line) => line.includes(`"${id}"`));
    assert.ok(lines.length > 0, `${id} 在 main.ts 中没有任何引用`);
    assert.ok(lines.every((line) => !line.includes("resetSim")), `${id} 不应直接调用 resetSim`);
  }
});

test("变化反馈：真实重置、更新周期、量化后的实际值与观察建议", () => {
  const hz = parameterMeta("solve-rate")!;
  const reset = describeParameterChange(hz, 500, 50, undefined, true);
  assert.equal(reset.head, "解算频率：500 → 50 Hz");
  assert.ok(reset.head.includes("500") && reset.head.includes("50") && reset.head.includes("Hz"), reset.head);
  assert.ok(reset.detail.includes("估计器每 20 ms 更新；"), reset.detail);
  assert.ok(reset.detail.includes("底层仿真仍为 500 Hz"), reset.detail);
  assert.ok(reset.detail.includes("已重置仿真"), reset.detail);
  assert.equal(reset.observe, `建议观察：${hz.observe}`);

  const bias = parameterMeta("imu-gyro-bias")!;
  const hot = describeParameterChange(bias, 1, 2.5, undefined, false);
  assert.ok(hot.head.includes("陀螺仪零偏") && hot.head.includes("2.5"), hot.head);
  assert.ok(hot.detail.includes("从当前状态继续"), hot.detail);
  assert.ok(!hot.detail.includes("已重置"), hot.detail);

  const kp = parameterMeta("mahony-kp")!;
  const quantized = describeParameterChange(kp, 1, 4.93, 4.9, false);
  assert.ok(quantized.head.includes("4.9"), quantized.head);
  assert.ok(quantized.head.includes("请求 4.93"), quantized.head);
  assert.ok(quantized.head.includes("已量化"), quantized.head);
  assert.ok(quantized.detail.includes("量化：请求 4.93 → 实际 4.9"), quantized.detail);

  const exact = describeParameterChange(kp, 1, 5, 5, false);
  assert.ok(!exact.detail.includes("量化"), "实际值等于请求值时不得伪造量化说明");
});

test("变化反馈：模式说明与布尔/下拉的可读标签", () => {
  const magMode = parameterMeta("mag-mode")!;
  const full = describeParameterChange(magMode, "yaw", "full", undefined, false);
  assert.ok(full.head.includes("简化") && full.head.includes("完整 MARG"), full.head);
  assert.ok(full.detail.includes("模式说明"), full.detail);
  assert.ok(full.detail.includes("磁倾角补偿"), full.detail);

  const gate = parameterMeta("kalman-gate")!;
  const chi2 = describeParameterChange(gate, "angle", "mahalanobis", undefined, false);
  assert.ok(chi2.head.includes("新息夹角 40°") && chi2.head.includes("χ² 马氏距离"), chi2.head);
  assert.ok(chi2.detail.includes("模式说明"), chi2.detail);
  assert.ok(chi2.detail.includes("χ²"), chi2.detail);

  const mag = parameterMeta("mag-enable")!;
  const off = describeParameterChange(mag, true, false, undefined, false);
  assert.ok(off.head.includes("开") && off.head.includes("关"), off.head);
  assert.ok(off.detail.includes("即时采用新值"), off.detail);
});

test("变化反馈：元数据与实际重置不一致时必须明确报告", () => {
  const hz = parameterMeta("solve-rate")!;
  const missed = describeParameterChange(hz, 500, 50, undefined, false);
  assert.ok(missed.detail.includes("实际未重置"), missed.detail);
  assert.ok(missed.detail.includes("不一致"), missed.detail);

  const bias = parameterMeta("imu-gyro-bias")!;
  const unexpected = describeParameterChange(bias, 1, 2, undefined, true);
  assert.ok(unexpected.detail.includes("已重置仿真"), unexpected.detail);
  assert.ok(unexpected.detail.includes("由其他动作触发"), unexpected.detail);
  assert.ok(unexpected.detail.includes("登记为不重置"), unexpected.detail);

  const unverified = describeParameterChange(hz, 500, 50);
  assert.ok(unverified.detail.includes("按登记行为会重置仿真"), unverified.detail);
  assert.ok(!unverified.detail.includes("已重置"), "未传实际调用时不得声称已重置");
});

test("任务创建：自由/实验/对照保留字符串摘要与配置快照", () => {
  const free = createFreeTask();
  assert.equal(free.kind, "free");
  assert.equal(free.id, "free");
  assert.ok(free.status.includes("自由探索"));
  assert.equal(free.variablePaths, undefined);

  const pinned = { seed: 24301, solveRateHz: 500 };
  const exp = createExperimentTask({
    id: "labs-gate",
    title: "方向门控救场",
    conditions: "复合机动 · 20° 侧向污染 · 种子 24301",
    variable: "门控方向阈值 20° → 30°",
    variablePaths: ["estimators.comp.gateDeg"],
    observe: "看误差曲线是否被拽偏",
    next: "再关闭门控做对照",
    source: "#labs",
    pinnedConfig: pinned,
  });
  assert.equal(exp.kind, "experiment");
  assert.equal(exp.id, "labs-gate");
  assert.ok(exp.status.includes("严格单变量"), exp.status);
  assert.ok(exp.status.includes("门控方向阈值"), exp.status);
  assert.equal(exp.pinnedConfig, pinned, "快照必须原样保留");
  assert.deepEqual(exp.variablePaths, ["estimators.comp.gateDeg"]);

  const cmp = createComparisonTask({
    title: "Kp 1 vs 5",
    variable: "Mahony Kp",
    variablePaths: ["estimators.mahony.params.kp"],
  });
  assert.equal(cmp.kind, "comparison");
  assert.ok(cmp.conditions.includes("固定配置与种子"), cmp.conditions);
  assert.ok(cmp.status.includes("严格单变量对照"), cmp.status);
});

test("任务偏离：变量变化保持单变量，非变量配置变化才触发", () => {
  const exp = createExperimentTask({
    title: "方向门控救场",
    variable: "门控方向阈值",
    variablePaths: ["estimators.comp.gateDeg"],
  });
  const variableChange = markDeviation(exp, ["gate-deg"]);
  assert.equal(variableChange.deviated, undefined, "改变实验变量本身不应判为偏离");
  assert.equal(variableChange.status, exp.status);

  const deviation = markDeviation(exp, ["mahony-kp"]);
  assert.equal(deviation.deviated, true);
  assert.ok(deviation.status.includes("已偏离原实验"), deviation.status);
  assert.ok(deviation.status.includes("mahony-kp"), deviation.status);
  assert.ok(deviation.deviationReason?.includes("改变了非变量参数"), deviation.deviationReason ?? "");
  assert.equal(exp.deviated, undefined, "markDeviation 不得修改原任务");

  const mixed = markDeviation(exp, ["gate-deg", "kalman-proc"]);
  assert.equal(mixed.deviated, true);
  assert.ok(mixed.status.includes("kalman-proc") && !mixed.status.includes("gate-deg"), mixed.status);

  const cmp = createComparisonTask({ variablePaths: ["imu.gyroBiasDps"] });
  assert.equal(markDeviation(cmp, ["imu-gyro-bias"]).deviated, undefined);
  assert.equal(markDeviation(cmp, ["imu-gyro-noise"]).deviated, true);
});

test("任务偏离：直接配置路径、未知 id、空输入与重复标记均安全", () => {
  const exp = createExperimentTask({ variablePaths: ["solveRateHz"] });
  assert.equal(markDeviation(exp, ["solveRateHz"]).deviated, undefined, "直接变量路径应被识别");
  assert.equal(markDeviation(exp, ["estimators.mahony.params.kp"]).deviated, true, "直接配置路径应触发偏离");

  const byId = createExperimentTask({ variablePaths: ["mahony-kp"] });
  assert.equal(markDeviation(byId, ["mahony-kp"]).deviated, undefined, "变量路径写成控件 id 也应被识别");
  const seed = createExperimentTask({ variablePaths: ["experiment-seed"] });
  assert.equal(markDeviation(seed, ["seed"]).deviated, undefined, "无点号配置路径 seed 也应被识别");

  assert.equal(markDeviation(exp, []).deviated, undefined);
  assert.equal(markDeviation(exp, ["not-a-real-control"]).deviated, undefined, "未登记控件不得伪造影响");
  assert.equal(markDeviation(exp, ["scenario"]).deviated, undefined, "没有配置路径的 id 不参与判定");

  const dev = markDeviation(exp, ["mahony-kp"]);
  const again = markDeviation(dev, ["kalman-obs"]);
  assert.equal(again.deviated, true);
  assert.equal(again.status, dev.status, "已偏离后重复标记应保持同一状态");
});

test("任务退出：只回到自由探索，不修改原任务或参数", () => {
  const exp = createExperimentTask({ title: "方向门控救场" });
  const exited = exitTask(exp);
  assert.equal(exited.kind, "free");
  assert.equal(exited.id, "free");
  assert.ok(exited.status.includes("已退出"), exited.status);
  assert.ok(exited.status.includes("方向门控救场"), exited.status);
  assert.ok(exited.status.includes("自由探索"), exited.status);
  assert.equal(exp.kind, "experiment", "退出不得修改原任务");
  assert.equal(exitTask(createFreeTask()).kind, "free");
});

test("空/畸形输入安全：缺字段、null 任务、非字符串路径都不抛异常", () => {
  const empty = createExperimentTask({});
  assert.equal(empty.kind, "experiment");
  assert.ok(empty.title.length > 0 && empty.status.length > 0);
  assert.ok(empty.status.includes("未登记变量路径"), empty.status);

  const emptyCmp = createComparisonTask(null);
  assert.equal(emptyCmp.kind, "comparison");
  assert.ok(emptyCmp.conditions.length > 0);

  const weird = createExperimentTask({
    title: "   ",
    variablePaths: ["estimators.comp.gateDeg", 42 as unknown as string, "", " estimators.comp.gateDeg "] as readonly string[],
  });
  assert.equal(weird.title, "实验");
  assert.deepEqual(weird.variablePaths, ["estimators.comp.gateDeg"]);

  assert.equal(markDeviation(empty, null).deviated, undefined);
  const recovered = markDeviation(null as unknown as TaskContext, ["mahony-kp"]);
  assert.equal(recovered.kind, "free");
  assert.equal(exitTask(null).kind, "free");
  assert.equal(exitTask(undefined).kind, "free");
});

test("无隐藏持久化：新建任务互不共享、纯函数不写回调用方", () => {
  const a = createFreeTask();
  const b = createFreeTask();
  assert.notEqual(a, b, "每次创建都应是独立上下文");
  (a as { title: string }).title = "被外部改坏";
  assert.equal(createFreeTask().title, "自由探索", "模块级状态不得把外部修改带回");

  const exp = createExperimentTask({ title: "Kp 对照", variablePaths: ["estimators.mahony.params.kp"] });
  const snapshot = JSON.stringify(exp);
  const dev = markDeviation(exp, ["kalman-obs"]);
  assert.equal(JSON.stringify(exp), snapshot, "markDeviation 不得改写入参");
  assert.notEqual(dev, exp);
  assert.equal(JSON.stringify(markDeviation(exp, ["kalman-obs"])), JSON.stringify(dev), "同输入必须得到同结果");
});

test("任务条：解算频率的重置反馈在目标处理器之后读取，下一次非重置修改不继承", () => {
  const harness = mountTaskStripHarness();
  const solveRate = harness.control("solve-rate");
  // 等价 main.ts：目标控件 change 处理器先 setSolveRate 再 resetSim() → noteReset()
  solveRate.addEventListener("change", () => harness.api.noteReset());

  solveRate.value = "50";
  harness.document.dispatch(solveRate, "change");
  assert.equal(harness.main.textContent, "解算频率：500 → 50");
  assert.ok(harness.detail.textContent.includes("已重置仿真"), harness.detail.textContent);
  assert.ok(!harness.detail.textContent.includes("按登记行为"), harness.detail.textContent);

  const bias = harness.control("imu-gyro-bias");
  bias.value = "2.5";
  bias.valueAsNumber = 2.5;
  harness.document.dispatch(bias, "input");
  assert.ok(harness.main.textContent.includes("陀螺仪零偏"), harness.main.textContent);
  assert.ok(harness.detail.textContent.includes("从当前状态继续"), harness.detail.textContent);
  assert.ok(!harness.detail.textContent.includes("已重置"), harness.detail.textContent);
});

test("任务条：checkbox 的 input 中间态不消费 change 上的重置标记", () => {
  const harness = mountTaskStripHarness();
  const toggle = harness.control("init-offset-toggle");
  toggle.addEventListener("change", () => harness.api.noteReset());

  toggle.checked = true;
  harness.document.dispatch(toggle, "input");
  assert.equal(harness.main.textContent, "", "input 中间态不得产生参数反馈");

  harness.document.dispatch(toggle, "change");
  assert.ok(harness.detail.textContent.includes("已重置仿真"), harness.detail.textContent);
});

test("任务条：实验装载只产生一条聚合反馈，不逐控件弹出", () => {
  const harness = mountTaskStripHarness();
  const solveRate = harness.control("solve-rate");

  harness.api.beginProgrammatic();
  const bias = harness.control("imu-gyro-bias");
  bias.value = "2";
  bias.valueAsNumber = 2;
  harness.document.dispatch(bias, "input");
  solveRate.value = "50";
  harness.document.dispatch(solveRate, "change");
  // 等价 applyExperiment 末尾的显式 resetSim()：不挂在任何控件上。
  harness.api.noteReset();
  assert.equal(harness.main.textContent, "", "程序化装载期间不得逐条反馈");
  harness.api.endProgrammatic();

  assert.equal(harness.main.textContent, "现场已装载");
  assert.ok(harness.detail.textContent.includes("已一次性写入并重置仿真"), harness.detail.textContent);
  assert.ok(harness.detail.textContent.includes("合并为一条"), harness.detail.textContent);
  assert.ok(!harness.detail.textContent.includes("陀螺仪零偏"), "不得残留逐控件反馈");
  assert.ok(!harness.detail.textContent.includes("解算频率：500"), "不得残留逐控件反馈");
});

test("模块边界：无 DOM、无 HTML、无配置/持久化依赖", () => {
  for (const [name, source] of [
    ["parameter-meta.ts", parameterSource],
    ["task-context.ts", taskSource],
  ] as const) {
    assert.ok(!/\bdocument\b/.test(source), `${name} 不得引用 document`);
    assert.ok(!/\bwindow\b/.test(source), `${name} 不得引用 window`);
    assert.ok(!/querySelector|HTMLElement|localStorage|sessionStorage|indexedDB/.test(source), `${name} 不得依赖 DOM/持久化`);
    assert.ok(!/\.html["']/.test(source), `${name} 不得引用 HTML 文件`);
  }
  assert.ok(!taskSource.includes("experiment-config"), "task-context 不得 import 配置模块");
  assert.ok(!parameterSource.includes("from \""), "parameter-meta 必须保持零 import");
  const meta = parameterMeta("imu-gyro-bias") as ControlMeta;
  assert.equal(meta.path, "imu.gyroBiasDps");
});

test("任务条：偏离判定直接复用 task-context 的共享策略", () => {
  const harness = mountTaskStripHarness();
  harness.api.setTask({
    kind: "experiment",
    id: "shared-policy",
    title: "共享偏离策略",
    conditions: "",
    variable: "陀螺零偏",
    observe: "",
    next: "",
    allowedIds: ["imu-gyro-bias"],
  });
  const allowed = harness.control("imu-gyro-bias");
  allowed.value = "2";
  allowed.valueAsNumber = 2;
  harness.document.dispatch(allowed, "input");
  assert.equal(harness.api.state().task?.deviation, false, "任务声明的变量本身不得判为偏离");

  const other = harness.control("imu-gyro-noise");
  other.value = "0.5";
  other.valueAsNumber = 0.5;
  harness.document.dispatch(other, "input");
  assert.equal(harness.api.state().task?.deviation, true, "非变量参数必须由共享策略判为偏离");
});

console.log(`parameter-task-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
