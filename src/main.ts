import "./style.css";
import { createScene } from "./scene/setup";
import { QUAT_POSE_PAIRS } from "./scene/quatview";
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
import { DEG, qAngleBetween, qFromEuler, qSlerp, qToEuler, RAD } from "./core/quat";
import { gimbalDemo, gimbalInnerQuat, toDisplayVec } from "./core/gimbal";
import * as THREE from "three";
import { applyViewDom, narrateGimbal, type UiView } from "./ui/mode";

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
  magNoise: 0.8, // 磁力计默认开启（教学主线路径），带小噪声
  hardIron: 0,
  disturbMag: 0,
};

const state = {
  playing: true,
  source: "mahony" as "truth" | Estimator["id"],
  channel: 0,
  attVisible: [true, true, true, true, true],
  errVisible: [true, true, true, true],
  lastImu: null as ImuSample | null,
  /** 视图：四轴姿态 / 万向节锁（不持久化，每次从四轴姿态开始） */
  view: "attitude" as UiView,
};

// ---------- 场景 ----------
const sceneHandles = createScene($("viewport"));

// ---------- 图表 ----------
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
  /** 估计器 id，图例芯片据此关联数据系列 */
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

/** 用户勾选 → 图表可见性；同时同步图例芯片的置灰状态 */
function applyVisibility(): void {
  attChart.setVisible(state.attVisible);
  errChart.setVisible(state.errVisible);
  attLegend.chips.forEach((c, i) => c.classList.toggle("off", !state.attVisible[i]));
  errLegend.chips.forEach((c, i) => c.classList.toggle("off", !state.errVisible[i]));
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
bindSlider("imu-mag-noise", (v) => (imuParams.magNoise = v), (v) => `${v.toFixed(1)}μT`);
bindSlider("imu-mag-disturb", (v) => (imuParams.disturbMag = v), (v) => v.toFixed(2));
bindSlider("mahony-kp", (v) => (mahony.kp = v), (v) => v.toFixed(2));
bindSlider("mahony-ki", (v) => (mahony.ki = v), (v) => v.toFixed(2));
bindSlider("madg-beta", (v) => (madg.beta = v), (v) => v.toFixed(2));
bindSlider("comp-alpha", (v) => (comp.alpha = v), (v) => v.toFixed(2));

// 磁力计总开关：同时切换三个融合算法的 MARG 路径
$("mag-enable").addEventListener("change", () => {
  const on = ($("mag-enable") as HTMLInputElement).checked;
  for (const e of ests) e.magEnabled = on;
  updateMagLegend();
});

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

// ---------- 四元数可视化视图（独立驱动，不影响主仿真） ----------
const quatState = {
  pairId: "combo" as string,
  playing: false,
  playT: 0,
  /** 播放一圈的时长（秒） */
  playDur: 6,
};

// 姿态对下拉（QUAT_POSE_PAIRS 动态填充）
{
  const sel = $<HTMLSelectElement>("quat-pair-select");
  sel.innerHTML = "";
  for (const p of QUAT_POSE_PAIRS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    quatState.pairId = sel.value;
    quatState.playing = false;
    $("btn-quat-play").textContent = "播放插值";
    const pair = QUAT_POSE_PAIRS.find((p) => p.id === sel.value)!;
    quatSlider.set(0);
    applyQuatInterpolation(pair, 0);
  });
}

const quatSlider = bindSlider(
  "quat-t",
  (v) => {
    const pair = QUAT_POSE_PAIRS.find((p) => p.id === quatState.pairId)!;
    applyQuatInterpolation(pair, v);
  },
  (v) => v.toFixed(2),
);

function applyQuatInterpolation(pair: { from: [number, number, number]; to: [number, number, number] }, t: number): void {
  sceneHandles.quatView.setInterpolation(pair.from, pair.to, t);
  // q−q 组同步显示当前 t 处的姿态
  const k = Math.PI / 180;
  const cur = quatStateCurrentEulerDeg(pair, t);
  sceneHandles.quatView.setNegation(cur[0] / k, cur[1] / k, cur[2] / k);
  // 分量读数（w,x,y,z）
  const q = qSlerp(
    qFromEuler(pair.from[0] * k, pair.from[1] * k, pair.from[2] * k),
    qFromEuler(pair.to[0] * k, pair.to[1] * k, pair.to[2] * k),
    t,
  );
  $("quat-readout").textContent = `[${[q.w, q.x, q.y, q.z].map((a) => a.toFixed(3)).join(", ")}]`;
}

/** t 处的当前欧拉角（度）——Slerp 的欧拉表示，供 q−q 组使用 */
function quatStateCurrentEulerDeg(
  pair: { from: [number, number, number]; to: [number, number, number] },
  t: number,
): [number, number, number] {
  const k = Math.PI / 180;
  const q = qSlerp(
    qFromEuler(pair.from[0] * k, pair.from[1] * k, pair.from[2] * k),
    qFromEuler(pair.to[0] * k, pair.to[1] * k, pair.to[2] * k),
    t,
  );
  const e = qToEuler(q);
  return [e.roll / k, e.pitch / k, e.yaw / k];
}

$("btn-quat-play").addEventListener("click", () => {
  quatState.playing = !quatState.playing;
  if (quatState.playing) {
    quatState.playT = quatSlider.get() >= 0.995 ? 0 : quatSlider.get();
    $("btn-quat-play").textContent = "停止播放";
  } else {
    $("btn-quat-play").textContent = "播放插值";
  }
});

$("quat-neg-toggle").addEventListener("change", () => {
  sceneHandles.quatView.showNegation(($("quat-neg-toggle") as HTMLInputElement).checked);
});

/** 插值播放推进（独立于仿真暂停状态） */
function stepQuatPlay(dt: number): void {
  if (!quatState.playing) return;
  quatState.playT += dt / quatState.playDur;
  if (quatState.playT >= 1) {
    quatState.playT = 0; // 循环播放
  }
  quatSlider.set(quatState.playT); // 内部会触发 apply 回调驱动 3D
}

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

/** 应用视图：显隐模型与面板、重置相机取景 */
function applyView(view: UiView): void {
  state.view = view;
  applyViewDom(view);
  sceneHandles.setView(view, ($("ghost-toggle") as HTMLInputElement).checked);
  syncSeg("view-seg", "view", view);
  if (view === "gimbal") updateGimbalUi();
}

$("view-seg")
  .querySelectorAll<HTMLButtonElement>(".seg-btn")
  .forEach((btn) => btn.addEventListener("click", () => applyView(btn.dataset.view as UiView)));

scenarioSelect.addEventListener("change", () => {
  world.setScenario(scenarioSelect.value);
  $("manual-group").classList.toggle("hidden", scenarioSelect.value !== "manual");
  resetSim();
});

sourceSelect.addEventListener("change", () => {
  state.source = sourceSelect.value as typeof state.source;
  updateSourceChip();
  // 内部量跟随显示源：切到真实姿态时箭头隐藏（updateTelemetry 会在下一帧收敛）
  if (telState.visible) setTelemetryVisible(true);
  updateGravityLegend();
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

// ---------- 玻璃盒：算法内部量 ----------
const telState = {
  visible: false,
  /**
   * 受扰/失效提示的黏性：剧烈机动的受扰是间歇性的（受扰帧与正常帧交替），
   * 若状态行跟着单帧抖动，用户几乎看不到提示。这里让提示一旦触发就保持
   * holdSec 秒，期间即使回到正常帧也继续显示（并注明已恢复）。
   */
  disturbedUntil: 0,
  lastFailed: false,
};
const TEL_HOLD_SEC = 1.5;

/** 当前显示源对应的估计器；真实姿态没有解算过程，返回 null */
function activeEstimator(): (typeof ests)[number] | null {
  return state.source === "truth" ? null : ests.find((e) => e.id === state.source)!;
}

function setTelemetryVisible(on: boolean): void {
  telState.visible = on;
  document.body.dataset.telemetry = on ? "on" : "off";
  // 真实姿态没有内部量：即使开关打开也不显示 3D 箭头
  const est = activeEstimator();
  sceneHandles.gravityArrows.group.visible = on && est !== null && state.view === "attitude";
  updateGravityLegend();
}

/** 图例文字随显示源变化：真实姿态没有解算过程，说明而不是展示箭头 */
function updateGravityLegend(): void {
  const legend = $("gravity-legend");
  if (state.source === "truth") {
    legend.innerHTML = `<span class="lg-item dim">真实姿态没有解算过程——切换显示源后，这里会说明两根箭头的含义</span>`;
    return;
  }
  legend.innerHTML =
    `<span class="lg-item"><span class="lg-dot" style="background:#f1f5f9"></span>预测的「下」（当前估计姿态）</span>` +
    `<span class="lg-item"><span class="lg-dot" style="background:#e879f9"></span>实测的「下」（加速度计）</span>`;
}

/** 磁航向图例：说明琥珀箭头，随 MARG 开关换文案 */
function updateMagLegend(): void {
  const magOn = ($("mag-enable") as HTMLInputElement).checked;
  const legend = $("mag-legend");
  if (!magOn) {
    legend.innerHTML =
      `<span class="lg-item"><span class="lg-dot" style="background:#ffb454"></span>磁航向指示（MARG 已关：会随陀螺漂移偏离真北）</span>`;
  } else {
    legend.innerHTML =
      `<span class="lg-item"><span class="lg-dot" style="background:#ffb454"></span>磁航向指示（MARG 开：被磁场约束，与罗盘箭头保持一致）</span>`;
  }
}

$("telemetry-toggle").addEventListener("change", () => {
  setTelemetryVisible(($("telemetry-toggle") as HTMLInputElement).checked);
});

const fmtDps = (v: [number, number, number]): string =>
  v.map((a) => fmtSigned(a * DEG, 1)).join("  ");

/** 算法专属行：互补看两路信源，Mahony 看 P/I 分工，Madgwick 看残差；MARG 开时附磁航向 */
function detailRows(est: (typeof ests)[number]): string {
  const d = est.telemetry.detail;
  const magRow =
    d.magEnabled === 1
      ? `<div class="tel-line"><span class="dim">磁航向 ψₘ</span><span>${fmtSigned(d.yawMagDeg ?? 0)}°</span></div>`
      : "";
  switch (est.id) {
    case "comp": {
      const w = d.accelWeight ?? 0;
      return `<div class="tel-line"><span class="dim">本帧加计权重</span><span>${(w * 100).toFixed(1)}%</span></div>` +
        `<div class="tel-line"><span class="dim">加计倾角 φ/θ</span><span>${fmtSigned(d.rollAccDeg ?? 0)}° ${fmtSigned(d.pitchAccDeg ?? 0)}°</span></div>` +
        magRow;
    }
    case "mahony": {
      const p = d.pShare ?? 0;
      return `<div class="tel-bar"><span class="dim">Kp 比例 ${(p * 100).toFixed(0)}%</span>` +
        `<span class="bar"><span class="bar-p" style="width:${(p * 100).toFixed(0)}%"></span>` +
        `<span class="bar-i" style="width:${((1 - p) * 100).toFixed(0)}%"></span></span>` +
        `<span class="dim">Ki 积分 ${((1 - p) * 100).toFixed(0)}%</span></div>` +
        `<div class="tel-line"><span class="dim">∫e 用量</span><span>${((d.iUsage ?? 0) * 100).toFixed(0)}%</span></div>` +
        magRow;
    }
    case "madg":
      return `<div class="tel-line"><span class="dim">目标残差 ‖f‖</span><span>${(d.residual ?? 0).toFixed(3)}</span></div>` +
        `<div class="tel-line"><span class="dim">梯度步长</span><span>${((d.stepNorm ?? 0) * 1e3).toFixed(2)} m°/s⁻¹</span></div>` +
        magRow;
    default:
      return "";
  }
}

/** 内部读数块 + 3D 双箭头（每 0.1s 刷新一次） */
function updateTelemetry(): void {
  const est = activeEstimator();
  const arrows = sceneHandles.gravityArrows;
  arrows.group.visible = telState.visible && est !== null && state.view === "attitude";
  if (!telState.visible || !est) return;

  const t = est.telemetry;
  // 3D 箭头方向：机体系向量经 toDisplayVec 翻转到显示约定，归一化后由 ArrowHelper 定向
  const setDir = (arrow: THREE.ArrowHelper, v: [number, number, number], active: boolean) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    arrow.visible = active && len > 1e-6;
    if (active && len > 1e-6) {
      arrow.setDirection(new THREE.Vector3(v[0] / len, v[1] / len, v[2] / len));
    }
  };
  setDir(arrows.predicted, toDisplayVec(t.predictedGravity), true);
  setDir(arrows.measured, toDisplayVec(t.measuredGravity), t.accelValid);

  // 受扰状态：实测箭头降饱和；提示带黏性（见 telState 注释）
  const disturbed = !t.accelValid && t.accelNorm > 0.1 * 9.80665;
  const failed = t.accelNorm <= 0.1 * 9.80665;
  arrows.measured.setColor(new THREE.Color(disturbed || failed ? 0x8b5a92 : 0xe879f9));

  const now = performance.now() / 1000;
  if (disturbed || failed) telState.disturbedUntil = now + TEL_HOLD_SEC;
  telState.lastFailed = failed;
  const inHold = now < telState.disturbedUntil;

  // 面板读数
  const st = $("tel-status");
  if (est.id === "pure") {
    st.textContent = "无修正项——预测与实测的偏差只增不减";
    st.classList.remove("warn");
  } else if (failed) {
    st.textContent = "加计失效（近似自由落体）：已忽略实测方向";
    st.classList.add("warn");
  } else if (disturbed) {
    st.textContent = "加计受扰中（‖a‖ 偏离 g 超过 35%）：实测方向不可信";
    st.classList.add("warn");
  } else if (inHold) {
    st.textContent = "加计刚从受扰中恢复——机动时加计会被线加速度污染";
    st.classList.add("warn");
  } else {
    st.textContent = "";
    st.classList.remove("warn");
  }

  $("tel-rawgyro").textContent = `${fmtDps(t.rawGyro)} °/s`;
  const corrMag = Math.hypot(t.correction[0], t.correction[1], t.correction[2]) * DEG;
  $("tel-correction").textContent =
    est.id === "pure" ? "0（无修正）" : `${fmtDps(t.correction)} °/s（|Δ| ${corrMag.toFixed(1)}）`;

  $("tel-detail").innerHTML = detailRows(est);
  const ae = t.detail.alignErrorDeg;
  $("tel-alignerr").textContent = Number.isFinite(ae) ? `${ae.toFixed(2)}°` : "—";
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
  for (const e of ests) e.update(sample.gyro, sample.accel, sample.mag, H);
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
  stepQuatPlay(dt);

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

  // 磁航向箭头：世界系水平箭头（挂 scene，不随机体姿态旋转），指向估计姿态
  // 的机头方位在水平面上的投影。四轴姿态视图可见；显示真实姿态时隐藏（无解算）。
  sceneHandles.headingArrow.visible = state.view === "attitude" && state.source !== "truth";
  if (sceneHandles.headingArrow.visible) {
    const eu = qToEuler(q);
    // 显示坐标：北=+X、东=+Z、上=+Y；NED 偏航 ψ（绕 z 下正转）在显示系是绕 +Y 的 −ψ
    sceneHandles.headingArrow.setDirection(
      new THREE.Vector3(Math.cos(eu.yaw), 0, Math.sin(eu.yaw)),
    );
  }

  controls.update();
  renderer.render(sceneHandles.scene, sceneHandles.camera);

  uiAcc += dt;
  if (uiAcc >= 0.1) {
    uiAcc = 0;
    updateReadouts();
    updateLegendValues();
    updateGimbalUi();
    updateTelemetry();
    attChart.render();
    errChart.render();
  }
}

// ---------- 使用说明文档页 ----------
const docsOverlay = document.getElementById("docs-overlay")!;
function setDocsOpen(open: boolean): void {
  docsOverlay.hidden = !open;
  if (open) {
    docsOverlay.scrollTop = 0;
    document.body.style.overflow = "hidden";
  } else {
    document.body.style.overflow = "";
  }
}
$("btn-docs").addEventListener("click", () => setDocsOpen(true));
$("btn-docs-close").addEventListener("click", () => setDocsOpen(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !docsOverlay.hidden) setDocsOpen(false);
});

// 目录滚动跟随：进入视口中部带宽的章节点亮对应目录项
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>(".docs-toc a")];
const tocById = new Map(tocLinks.map((a) => [`#${a.hash.slice(1)}`, a]));
const tocObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const key = `#${en.target.id}`;
      tocById.forEach((link, hash) => link.classList.toggle("active", hash === key));
    }
  },
  { root: docsOverlay, rootMargin: "-20% 0px -65% 0px" },
);
for (const link of tocLinks) {
  const target = document.getElementById(link.hash.slice(1));
  if (target) tocObserver.observe(target);
}

// ---------- 初始化 ----------
updateSourceChip();
setGimbalAngles(0, 0, 0);
applyView("attitude"); // 视图不持久化，始终从四轴姿态视图开始
setTelemetryVisible(false); // 玻璃盒默认关闭，写 body[data-telemetry] 供 CSS 使用
updateGravityLegend();
updateMagLegend();
