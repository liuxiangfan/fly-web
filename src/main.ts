import "./style.css";
import { createScene } from "./scene/setup";
import { RollingChart } from "./ui/chart";
import { World } from "./core/world";
import { scenarios } from "./core/scenarios";
import type { ImuParams, ImuSample } from "./core/imu";
import {
  ComplementaryEstimator,
  MahonyEstimator,
  MadgwickEstimator,
  PureGyroEstimator,
  type Estimator,
} from "./estimators";
import { DEG, qAngleBetween, qToEuler, RAD } from "./core/quat";
import { gimbalDemo, gimbalInnerQuat } from "./core/gimbal";
import {
  applyModeDom,
  applyViewDom,
  estimatorMask,
  loadMode,
  narrateAttitude,
  narrateGimbal,
  resolveScenario,
  resolveSource,
  saveMode,
  type UiMode,
  type UiView,
} from "./ui/mode";

const H = 1 / 500; // 仿真/解算步长
const LOG_DT = 0.04; // 曲线记录间隔
const CHART_WINDOW = 30;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// 仿真步异常保护：记录一次并暂停，渲染循环与交互不受影响（可切模式后继续）
let simErrorShown = false;
function showSimError(err: unknown): void {
  if (simErrorShown) return;
  simErrorShown = true;
  console.error("仿真步异常，已暂停：", err);
  const chip = document.createElement("div");
  chip.className = "ov-chip";
  chip.style.color = "#f85149";
  chip.textContent = `仿真已暂停：${err instanceof Error ? err.message : String(err)}（切换机动模式后点「继续」可恢复）`;
  $("readout-overlay").appendChild(chip);
}

// ---------- 仿真状态 ----------
const world = new World(scenarios.hover);
const ests: Estimator[] = [
  new PureGyroEstimator(),
  new ComplementaryEstimator(),
  new MahonyEstimator(),
  new MadgwickEstimator(),
];
const comp = ests[1] as ComplementaryEstimator;
const mahony = ests[2] as MahonyEstimator;
const madg = ests[3] as MadgwickEstimator;

const imuParams: ImuParams = {
  gyroBiasDps: 1,
  gyroNoiseDps: 0.2,
  accelNoise: 0.1,
  linAccel: 1,
  vibration: 0.3,
};

const state = {
  playing: true,
  source: "mahony" as "truth" | Estimator["id"],
  channel: 0,
  attVisible: [true, true, true, true, true],
  errVisible: [true, true, true, true],
  lastImu: null as ImuSample | null,
  /** 界面模式：精简/完整，持久化在 localStorage（默认精简） */
  mode: loadMode() as UiMode,
  /** 视图：四轴姿态 / 万向节锁（不持久化，每次从四轴姿态开始） */
  view: "attitude" as UiView,
};

// ---------- 场景 ----------
const sceneHandles = createScene($("viewport"));

// ---------- 图表 ----------
// RollingChart 的曲线系列在构造时固定，精简模式不重建结构，只用可见性掩码隐藏
const truthSeries = { label: "真实", color: "#e6edf3" };
const estSeries = ests.map((e) => ({ label: e.label, color: e.color }));
const attChart = new RollingChart($("att-canvas"), [truthSeries, ...estSeries], { windowSec: CHART_WINDOW });
const errChart = new RollingChart($("err-canvas"), estSeries, { windowSec: CHART_WINDOW });

// 原始记录（切换通道时不丢历史）
interface LogRow {
  t: number;
  euler: number[][]; // [真实, pure, comp, mahony, madg] × [φ,θ,ψ]（度，原始值）
  err: number[]; // 总误差（度）
}
const logRows: LogRow[] = [];
// 解卷绕历史：按 数据源×通道 分开记录
const attPrev = new Array<number | undefined>(15).fill(undefined);

function unwrap(slot: number, v: number): number {
  const p = attPrev[slot];
  if (p !== undefined) {
    while (v - p > 180) v -= 360;
    while (p - v > 180) v += 360;
  }
  attPrev[slot] = v;
  return v;
}

function eulerTriples(): number[][] {
  const truthE = qToEuler(world.q);
  const rows: number[][] = [[truthE.roll, truthE.pitch, truthE.yaw].map((a) => a * DEG)];
  for (const e of ests) {
    const eu = qToEuler(e.q);
    rows.push([eu.roll, eu.pitch, eu.yaw].map((a) => a * DEG));
  }
  return rows;
}

function channelValues(row: LogRow, ch: number): number[] {
  return row.euler.map((r, i) => unwrap(i * 3 + ch, r[ch]));
}

function logRow(): void {
  const row: LogRow = {
    t: world.t,
    euler: eulerTriples(),
    err: ests.map((e) => qAngleBetween(e.q, world.q) * DEG),
  };
  logRows.push(row);
  if (logRows.length > 850) logRows.splice(0, 100);
  attChart.push(world.t, channelValues(row, state.channel));
  errChart.push(world.t, row.err);
}

function rebuildAttChart(): void {
  attChart.clear();
  attPrev.fill(undefined);
  for (const row of logRows) {
    attChart.push(row.t, channelValues(row, state.channel));
  }
}

// ---------- 图例 ----------
interface LegendDef {
  /** 估计器 id，用于精简模式下由 CSS 隐藏对应图例芯片 */
  id?: string;
  label: string;
  color: string;
}

interface LegendHandles {
  vals: Array<HTMLElement | null>;
  chips: HTMLElement[];
}

function buildLegend(
  container: HTMLElement,
  defs: LegendDef[],
  visible: boolean[],
  onToggle: () => void,
): LegendHandles {
  const vals: Array<HTMLElement | null> = [];
  const chips: HTMLElement[] = [];
  container.innerHTML = "";
  defs.forEach((d, i) => {
    const chip = document.createElement("span");
    chip.className = "legend-chip";
    if (d.id) chip.dataset.est = d.id;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = d.color;
    const name = document.createElement("span");
    name.textContent = d.label;
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = "--";
    chip.append(dot, name, val);
    chip.addEventListener("click", () => {
      visible[i] = !visible[i];
      onToggle();
    });
    container.appendChild(chip);
    vals.push(val);
    chips.push(chip);
  });
  return { vals, chips };
}

const EST_IDS = ests.map((e) => e.id);

const attLegend = buildLegend(
  $("att-legend"),
  [truthSeries, ...ests.map((e) => ({ id: e.id, label: e.label, color: e.color }))],
  state.attVisible,
  () => applyVisibility(),
);
const errLegend = buildLegend(
  $("err-legend"),
  ests.map((e) => ({ id: e.id, label: e.label, color: e.color })),
  state.errVisible,
  () => applyVisibility(),
);

/** 用户勾选 × 模式掩码 → 图表实际可见性；同时同步图例芯片的置灰状态 */
function applyVisibility(): void {
  const modeMask = estimatorMask(state.mode, EST_IDS);
  const attMask = [state.attVisible[0], ...EST_IDS.map((_, i) => state.attVisible[i + 1] && modeMask[i])];
  const errMask = EST_IDS.map((_, i) => state.errVisible[i] && modeMask[i]);
  attChart.setVisible(attMask);
  errChart.setVisible(errMask);
  attLegend.chips.forEach((c, i) => c.classList.toggle("off", !attMask[i]));
  errLegend.chips.forEach((c, i) => c.classList.toggle("off", !errMask[i]));
}

// ---------- 控件 ----------
/**
 * 绑定「滑块 + 数值输入框 + 步距输入框」三件套。
 *
 * 数值框与步距框都直接可编辑：
 *  - 数值框回车/失焦即生效（自动夹到 min..max 并按步距对齐）
 *  - 步距框回车/失焦即改滑块的 step（如 1 → 0.1 后可用方向键微调）
 * 步距允许范围取 slider 自身 step 的 1/100 ~ (max-min)/2，避免步距为 0 或过大。
 */
interface SliderBinding {
  /** 外部程序化改值（演示脚本用），会同步刷新滑块与数值框 */
  set(v: number): void;
  get(): number;
}

function bindSlider(
  id: string,
  apply: (v: number) => void,
  fmt: (v: number) => string,
): SliderBinding {
  const input = $<HTMLInputElement>(id);
  const num = document.querySelector<HTMLInputElement>(`[data-num="${id}"]`);
  const stepBox = document.querySelector<HTMLInputElement>(`[data-step="${id}"]`);
  // 数值输入框同时充当读数显示；若某个滑块没有数值框，退回旧的 <output>
  const out = document.querySelector<HTMLOutputElement>(`[data-out="${id}"]`) ?? document.getElementById(`${id}-out`);

  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const baseStep = parseFloat(input.step) || 0.01;
  const stepMin = baseStep / 100;
  const stepMax = (max - min) / 2;

  /** 夹到范围并按当前步距对齐，消除浮点毛刺 */
  const quantize = (raw: number): number => {
    if (!Number.isFinite(raw)) return parseFloat(input.value);
    const step = parseFloat(input.step) || baseStep;
    const clamped = Math.min(max, Math.max(min, raw));
    const snapped = Math.round((clamped - min) / step) * step + min;
    return Math.min(max, Math.max(min, parseFloat(snapped.toFixed(6))));
  };

  /** 把值同步到滑块、数值框与（可选的）output */
  const render = (v: number): void => {
    input.value = String(v);
    if (num) num.value = String(v);
    if (out) out.textContent = fmt(v);
  };

  const commit = (raw: number): void => {
    const v = quantize(raw);
    apply(v);
    render(v);
  };

  input.addEventListener("input", () => commit(parseFloat(input.value)));

  if (num) {
    const commitNumber = () => commit(parseFloat(num.value));
    num.addEventListener("change", commitNumber);
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitNumber();
        num.blur();
        return;
      }
      // 数值只靠直接键入：屏蔽上下方向键的加减行为（否则会按 step 改值）
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    });
  }

  if (stepBox) {
    stepBox.value = String(baseStep);
    const commitStep = () => {
      const raw = parseFloat(stepBox.value);
      const step = Number.isFinite(raw) ? Math.min(stepMax, Math.max(stepMin, raw)) : baseStep;
      input.step = String(step);
      stepBox.value = String(step);
      // 步距变了之后，把当前值对齐到新网格上
      commit(parseFloat(input.value));
    };
    stepBox.addEventListener("change", commitStep);
    stepBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitStep();
        stepBox.blur();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    });
  }

  commit(parseFloat(input.value));

  return {
    set: (v: number) => commit(v),
    get: () => parseFloat(input.value),
  };
}

const manRoll = bindSlider("man-roll", (v) => (world.manual.rollDeg = v), (v) => `${v.toFixed(0)}°`);
const manPitch = bindSlider("man-pitch", (v) => (world.manual.pitchDeg = v), (v) => `${v.toFixed(0)}°`);
const manYaw = bindSlider("man-yaw", (v) => (world.manual.yawDeg = v), (v) => `${v.toFixed(0)}°`);
void manRoll;
void manPitch;
void manYaw;
bindSlider("imu-gyro-bias", (v) => (imuParams.gyroBiasDps = v), (v) => `${v.toFixed(1)}°/s`);
bindSlider("imu-gyro-noise", (v) => (imuParams.gyroNoiseDps = v), (v) => `${v.toFixed(2)}°/s`);
bindSlider("imu-accel-noise", (v) => (imuParams.accelNoise = v), (v) => `${v.toFixed(2)}m/s²`);
bindSlider("imu-lin-accel", (v) => (imuParams.linAccel = v), (v) => `${v.toFixed(1)}m/s²`);
bindSlider("imu-vibration", (v) => (imuParams.vibration = v), (v) => v.toFixed(2));
bindSlider("mahony-kp", (v) => (mahony.kp = v), (v) => v.toFixed(2));
bindSlider("mahony-ki", (v) => (mahony.ki = v), (v) => v.toFixed(2));
bindSlider("madg-beta", (v) => (madg.beta = v), (v) => v.toFixed(2));
bindSlider("comp-alpha", (v) => (comp.alpha = v), (v) => v.toFixed(2));

// ---------- 万向节锁演示（独立于主仿真） ----------
const gimState = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

function applyGimbalAngles(): void {
  sceneHandles.gimbal.setAngles(gimState.rollDeg * RAD, gimState.pitchDeg * RAD, gimState.yawDeg * RAD);
}

/** 角度文本（消除 "-0°"） */
const fmtDeg = (v: number, d = 0): string => {
  const x = Math.abs(v) < 10 ** -d / 2 ? 0 : v;
  return `${x.toFixed(d)}°`;
};

function setGimbalAngles(yawDeg: number, pitchDeg: number, rollDeg: number): void {
  gimState.yawDeg = yawDeg;
  gimState.pitchDeg = pitchDeg;
  gimState.rollDeg = rollDeg;
  gimYaw.set(yawDeg);
  gimPitch.set(pitchDeg);
  gimRoll.set(rollDeg);
  applyGimbalAngles();
}

const gimYaw = bindSlider("gim-yaw", (v) => { gimState.yawDeg = v; applyGimbalAngles(); }, (v) => fmtDeg(v));
const gimPitch = bindSlider("gim-pitch", (v) => { gimState.pitchDeg = v; applyGimbalAngles(); }, (v) => fmtDeg(v));
const gimRoll = bindSlider("gim-roll", (v) => { gimState.rollDeg = v; applyGimbalAngles(); }, (v) => fmtDeg(v));

/** 手动操作即接管演示（滑块输入、数值输入、步距调整都算） */
for (const id of ["gim-yaw", "gim-pitch", "gim-roll"]) {
  const el = $<HTMLInputElement>(id);
  // 不能直接把 stopDemo 当回调：事件对象会被误传成 keepConclusion 参数
  el.addEventListener("input", () => stopDemo());
  el.addEventListener("change", () => stopDemo());
}

// ---------- 万向节锁完整演示 ----------
const demoState = {
  t: -1, // <0 表示未在演示
  paused: false,
  /** 演示到「记住此刻姿态」时记录下来的参照姿态四元数 */
  recorded: null as { w: number; x: number; y: number; z: number } | null,
  /** 「验证」相位比对出的夹角（度） */
  diffDeg: null as number | null,
};

const DEMO_BTN_IDLE = "演示：只剩 2 个自由度";

/** 暂停按钮只在演示进行中可用；暂停时保持当前角度、解说与进度，点击继续 */
function setPauseButton(paused: boolean | null): void {
  const btn = $<HTMLButtonElement>("btn-gim-pause");
  if (paused === null) {
    btn.disabled = true;
    btn.textContent = "暂停";
    return;
  }
  btn.disabled = false;
  btn.textContent = paused ? "继续" : "暂停";
}

/**
 * 结束演示。keepConclusion=true（自然播完）时保留比对结论供讲解，
 * 手动停止则一并清掉，让面板回到待机状态。
 */
function stopDemo(keepConclusion = false): void {
  const wasIdle = demoState.t < 0;
  demoState.t = -1;
  demoState.paused = false;
  $("btn-gim-demo").textContent = DEMO_BTN_IDLE;
  setPauseButton(null);
  $("gimbal-progress").style.width = "0%";
  if (!keepConclusion && !wasIdle) {
    $("gimbal-compare").textContent = "";
    $("gimbal-compare").classList.remove("warn", "ok");
  }
}

$("btn-gim-demo").addEventListener("click", () => {
  if (demoState.t >= 0) {
    stopDemo();
    return;
  }
  demoState.t = 0;
  demoState.paused = false;
  demoState.recorded = null;
  demoState.diffDeg = null;
  $("btn-gim-demo").textContent = "停止演示";
  setPauseButton(false);
  $("gimbal-compare").textContent = "";
  $("gimbal-compare").classList.remove("warn", "ok");
});

$("btn-gim-pause").addEventListener("click", () => {
  if (demoState.t < 0) return;
  demoState.paused = !demoState.paused;
  setPauseButton(demoState.paused);
});

$("btn-gim-reset").addEventListener("click", () => {
  stopDemo();
  setGimbalAngles(0, 0, 0);
  $("gimbal-compare").textContent = "";
  $("gimbal-compare").classList.remove("warn", "ok");
});

/** 万向环读数、死锁警告、比对结果与高亮（每 0.1s 调一次） */
function updateGimbalUi(): void {
  if (state.view !== "gimbal") return;
  const locked = sceneHandles.gimbal.isLocked();
  sceneHandles.gimbal.setLockVisual(locked, sceneHandles.gimbal.axisAlign());
  $("gimbal-readout").innerHTML =
    `φ ${fmtSigned(gimState.rollDeg)}° &nbsp; θ ${fmtSigned(gimState.pitchDeg)}° &nbsp; ψ ${fmtSigned(gimState.yawDeg)}°`;

  const st = $("gimbal-status");
  // 演示进行中，解说栏交给演示脚本，让讲解跟着画面走
  if (demoState.t >= 0) {
    const d = gimbalDemo(demoState.t);
    st.textContent = d.message;
    st.classList.toggle("warn", locked);
    const bar = $("gimbal-progress");
    bar.style.width = `${(d.progress * 100).toFixed(1)}%`;
  } else {
    st.textContent = narrateGimbal(gimState.pitchDeg, locked);
    st.classList.toggle("warn", locked);
    $("gimbal-progress").style.width = "0%";
  }

  // 比对结果：演示脚本要求记录时存下当前姿态，要求验证时算出与参照姿态的夹角
  const cmp = $("gimbal-compare");
  if (demoState.diffDeg !== null) {
    const same = demoState.diffDeg < 0.05;
    cmp.textContent = same
      ? `✔ 两次操作得到的姿态完全相同（夹角 ${demoState.diffDeg.toFixed(3)}°）——横滚与偏航其实是同一个自由度`
      : `姿态夹角 ${demoState.diffDeg.toFixed(2)}°`;
    cmp.classList.toggle("ok", same);
    cmp.classList.toggle("warn", !same);
  }
}

/** 演示推进（独立于仿真暂停状态）；暂停时冻结时间轴，画面与解说原地保持 */
function stepDemo(dt: number): void {
  if (demoState.t < 0 || demoState.paused) return;
  demoState.t += dt;
  const d = gimbalDemo(demoState.t);

  // 画面与滑块跟随脚本
  setGimbalAngles(d.yaw, d.pitch, d.roll);

  // 记录参照姿态
  if (d.compare === "record" && demoState.recorded === null) {
    demoState.recorded = { ...gimbalInnerQuat({ roll: d.roll * RAD, pitch: d.pitch * RAD, yaw: d.yaw * RAD }) };
    demoState.diffDeg = null;
  }
  // 与参照姿态比对
  if (d.compare === "verify" && demoState.recorded) {
    const now = gimbalInnerQuat({ roll: d.roll * RAD, pitch: d.pitch * RAD, yaw: d.yaw * RAD });
    demoState.diffDeg = qAngleBetween(now, demoState.recorded) * DEG;
  }

  if (d.finished) {
    // 自然播完：保留最终画面与结论供讲解，按钮复位、允许重播
    stopDemo(true);
  }
}

// ---------- 模式与视图 ----------
const scenarioSelect = $<HTMLSelectElement>("scenario-select");
const sourceSelect = $<HTMLSelectElement>("source-select");

function sourceLabel(): string {
  return state.source === "truth" ? "真实姿态" : ests.find((e) => e.id === state.source)!.label;
}
function sourceColor(): string {
  return state.source === "truth" ? "#e6edf3" : ests.find((e) => e.id === state.source)!.color;
}
function updateSourceChip(): void {
  const chip = $("readout-source");
  chip.textContent = `模型显示：${sourceLabel()}`;
  chip.style.color = sourceColor();
}

function syncSeg(containerId: string, dataKey: string, active: string): void {
  $(containerId)
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset[dataKey] === active));
}

/** 应用精简/完整模式：写 body 属性、收敛不允许的选择、刷新曲线可见性 */
function applyMode(mode: UiMode): void {
  state.mode = mode;
  saveMode(mode);
  applyModeDom(mode);

  const src = resolveSource(state.source, mode);
  if (src !== state.source) {
    state.source = src as typeof state.source;
    sourceSelect.value = src;
    updateSourceChip();
  }

  const sc = resolveScenario(scenarioSelect.value, mode);
  if (sc !== scenarioSelect.value) {
    scenarioSelect.value = sc;
    world.setScenario(sc);
    $("manual-group").classList.toggle("hidden", sc !== "manual");
    resetSim();
  }

  applyVisibility();
  syncSeg("mode-seg", "mode", mode);
}

/** 应用视图：显隐模型与面板、重置相机取景 */
function applyView(view: UiView): void {
  state.view = view;
  applyViewDom(view);
  sceneHandles.setView(view, ($("ghost-toggle") as HTMLInputElement).checked);
  syncSeg("view-seg", "view", view);
  if (view === "gimbal") updateGimbalUi();
}

$("mode-seg")
  .querySelectorAll<HTMLButtonElement>(".seg-btn")
  .forEach((btn) => btn.addEventListener("click", () => applyMode(btn.dataset.mode as UiMode)));
$("view-seg")
  .querySelectorAll<HTMLButtonElement>(".seg-btn")
  .forEach((btn) => btn.addEventListener("click", () => applyView(btn.dataset.view as UiView)));

scenarioSelect.addEventListener("change", () => {
  const id = resolveScenario(scenarioSelect.value, state.mode);
  scenarioSelect.value = id;
  world.setScenario(id);
  $("manual-group").classList.toggle("hidden", id !== "manual");
  resetSim();
});

sourceSelect.addEventListener("change", () => {
  const v = resolveSource(sourceSelect.value, state.mode);
  sourceSelect.value = v;
  state.source = v as typeof state.source;
  updateSourceChip();
});

$("ghost-toggle").addEventListener("change", () => {
  // 只同步显隐，不重置相机（否则用户拖好的观察角度会被打断）
  sceneHandles.syncVisibility(state.view, ($("ghost-toggle") as HTMLInputElement).checked);
});

$("att-tabs")
  .querySelectorAll<HTMLButtonElement>(".tab")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      $("att-tabs").querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.channel = parseInt(btn.dataset.ch!, 10);
      rebuildAttChart();
    });
  });

function setPlaying(p: boolean): void {
  state.playing = p;
  $("btn-pause").textContent = p ? "暂停" : "继续";
}
$("btn-pause").addEventListener("click", () => setPlaying(!state.playing));
$("btn-reset").addEventListener("click", resetSim);

function resetSim(): void {
  world.reset();
  for (const e of ests) e.reset();
  attChart.clear();
  errChart.clear();
  attPrev.fill(undefined);
  logRows.length = 0;
  state.lastImu = null;
  simErrorShown = false;
}

// ---------- 读数 ----------
const fmtSigned = (v: number, d = 1): string => {
  const x = Math.abs(v) < 10 ** -d / 2 ? 0 : v; // 消除 "-0.0" 这类显示
  return (x >= 0 ? "+" : "") + x.toFixed(d);
};
const fmtVec = (v: [number, number, number]): string =>
  `[${v.map((a) => fmtSigned(a, 1)).join(", ")}]`;

function updateReadouts(): void {
  const q = state.source === "truth" ? world.q : ests.find((e) => e.id === state.source)!.q;
  const eu = qToEuler(q);
  const te = qToEuler(world.q);
  $("readout-quat").textContent = `q = [${[q.w, q.x, q.y, q.z].map((a) => a.toFixed(4)).join(", ")}]`;
  $("readout-euler").innerHTML = `φ ${fmtSigned(eu.roll * DEG)}° &nbsp; θ ${fmtSigned(eu.pitch * DEG)}° &nbsp; ψ ${fmtSigned(eu.yaw * DEG)}°`;
  $("readout-true").textContent = `真实 φ ${fmtSigned(te.roll * DEG)}° θ ${fmtSigned(te.pitch * DEG)}° ψ ${fmtSigned(te.yaw * DEG)}°`;
  const imu = state.lastImu;
  if (imu) {
    const gyroDps: [number, number, number] = [imu.gyro[0] * DEG, imu.gyro[1] * DEG, imu.gyro[2] * DEG];
    $("readout-imu").innerHTML =
      `陀螺 ${fmtVec(gyroDps)} °/s<br />加计 ${fmtVec(imu.accel)} m/s²`;
  }
  $("clock").textContent = `t = ${world.t.toFixed(1)} s`;
}

function updateLegendValues(): void {
  const att = attChart.latest();
  attLegend.vals.forEach((el, i) => {
    if (el) el.textContent = Number.isFinite(att[i]) ? `${att[i].toFixed(1)}°` : "--";
  });
  const err = errChart.latest();
  errLegend.vals.forEach((el, i) => {
    if (el) el.textContent = Number.isFinite(err[i]) ? `${err[i].toFixed(2)}°` : "--";
  });
}

/** 精简模式解说栏：把数字换成一句中文（仅在四轴姿态视图显示） */
function updateNarrator(): void {
  if (state.mode !== "basic" || state.view !== "attitude") return;
  const err = errChart.latest(); // [pure, comp, mahony, madg]
  $("narrator").textContent = narrateAttitude(err[0], err[2]);
}

// ---------- 主循环 ----------
let simAcc = 0;
let logAcc = 0;
let lastNow = performance.now();
let uiAcc = 0;
let frames = 0;
let fpsAcc = 0;

function stepSim(): void {
  const sample = world.step(H, imuParams);
  state.lastImu = sample;
  for (const e of ests) e.update(sample.gyro, sample.accel, H);
  logAcc += H;
  if (logAcc >= LOG_DT) {
    logAcc -= LOG_DT;
    logRow();
  }
}

const { renderer, controls, quad, ghost, toDisplay } = sceneHandles;
renderer.setAnimationLoop(() => {
  // 整帧保护：three.js 的 onAnimationFrame 先调回调、后调度下一帧，
  // 回调里任何未捕获异常都会让渲染循环永久停摆（只能刷新页面）。这里统一兜底。
  try {
    frame();
  } catch (err) {
    setPlaying(false);
    showSimError(err);
  }
});

function frame(): void {
  const now = performance.now();
  const dt = Math.min((now - lastNow) / 1000, 0.05);
  lastNow = now;

  frames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    $("fps").textContent = `${Math.round(frames / fpsAcc)} fps`;
    frames = 0;
    fpsAcc = 0;
  }

  // 万向节锁演示独立于仿真，暂停时也能演示
  stepDemo(dt);

  if (state.playing) {
    simAcc += dt;
    if (simAcc > 0.25) simAcc = 0.25; // 标签页隐藏后恢复时，最多补 0.25s，避免疯狂快进
    while (simAcc >= H) {
      stepSim();
      simAcc -= H;
    }
    for (const model of [quad, sceneHandles.gimbal.quad]) {
      model.props.forEach((p, i) => (p.rotation.y += (i % 2 ? 1 : -1) * 30 * dt));
    }
  }

  const q = state.source === "truth" ? world.q : ests.find((e) => e.id === state.source)!.q;
  quad.group.quaternion.copy(toDisplay(q));
  ghost.group.quaternion.copy(toDisplay(world.q));

  controls.update();
  renderer.render(sceneHandles.scene, sceneHandles.camera);

  uiAcc += dt;
  if (uiAcc >= 0.1) {
    uiAcc = 0;
    updateReadouts();
    updateLegendValues();
    updateGimbalUi();
    updateNarrator();
    attChart.render();
    errChart.render();
  }
}

// ---------- 初始化 ----------
updateSourceChip();
setGimbalAngles(0, 0, 0);
applyView("attitude"); // 视图不持久化，始终从四轴姿态视图开始
applyMode(state.mode); // 模式读取自 localStorage（默认精简）
