// KaTeX 数学字体（本地打包，无 CDN 依赖）：文档公式块用它的衬线字形
import "katex/dist/katex.min.css";
import "./style.css";
import { createScene } from "./scene/setup";
import { QUAT_POSE_PAIRS } from "./scene/quatview";
import { RollingChart } from "./ui/chart";
import { World } from "./core/world";
import { scenarios } from "./core/scenarios";
import type { ImuParams, ImuSample } from "./core/imu";
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MahonyEstimator,
  MadgwickEstimator,
  PureGyroEstimator,
  type Estimator,
} from "./estimators";
import { DEG, qAngleBetween, qFromEuler, qId, qMul, qNorm, qSlerp, qToEuler, RAD, type Quat } from "./core/quat";
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
  new KalmanEstimator(),
];
const comp = ests[1] as ComplementaryEstimator;
const mahony = ests[2] as MahonyEstimator;
const madg = ests[3] as MadgwickEstimator;
const kalman = ests[4] as KalmanEstimator;

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
  attVisible: [true, true, true, true, true, true],
  errVisible: [true, true, true, true, true],
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
  euler: number[][]; // [真实, pure, comp, mahony, madg, kalman] × [φ,θ,ψ]（度，原始值）
  err: number[]; // 总误差（度）
}
const logRows: LogRow[] = [];
// 解卷绕历史：按 数据源×通道 分开记录
const attPrev = new Array<number | undefined>(18).fill(undefined);

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
    // 轨道填充比例（CSS 用 var(--fill) 画「已填充」段）
    input.style.setProperty("--fill", `${(((v - min) / (max - min)) * 100).toFixed(2)}%`);
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
bindSlider("kalman-proc", (v) => (kalman.gyroNoiseDps = v), (v) => `${v.toFixed(2)}°/s`);
bindSlider("kalman-obs", (v) => (kalman.obsNoise = v), (v) => v.toFixed(3) + "g");

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
  const on = ($("quat-neg-toggle") as HTMLInputElement).checked;
  if (($("quat-mode") as HTMLSelectElement).value === "proj") return; // 投影模式下该开关不可见
  enterQuatScene(on ? "neg" : "interp");
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

// ---------- 四元数视图组切换过渡（淡入淡出 + 轻缩放，取代瞬切） ----------
const quatFades = new Map<THREE.Group, { k: number; target: number }>();
const QUAT_FADE_SEC = 0.4;

/** 首次触碰时记录每个材质的基准透明度，淡入淡出后可精确还原 */
function prepQuatMats(g: THREE.Group): void {
  g.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mm = m as THREE.Material & { opacity: number; transparent: boolean };
      if (mm.userData.__quatBaseOp === undefined) {
        mm.userData.__quatBaseOp = mm.opacity;
        mm.userData.__quatBaseTr = mm.transparent;
      }
    }
  });
}

function quatGroupFade(g: THREE.Group, show: boolean): void {
  let f = quatFades.get(g);
  if (!f) {
    f = { k: show ? 0 : g.visible ? 1 : 0, target: show ? 1 : 0 };
    quatFades.set(g, f);
  } else {
    f.target = show ? 1 : 0;
  }
  if (show) g.visible = true;
  prepQuatMats(g);
}

function applyQuatFade(g: THREE.Group, k: number, done: boolean): void {
  const ease = k * k * (3 - 2 * k);
  g.scale.setScalar(0.93 + 0.07 * ease);
  g.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mm = m as THREE.Material & { opacity: number; transparent: boolean };
      if (mm.userData.__quatBaseOp === undefined) continue;
      if (done) {
        mm.opacity = mm.userData.__quatBaseOp;
        mm.transparent = mm.userData.__quatBaseTr;
      } else {
        mm.opacity = mm.userData.__quatBaseOp * ease;
        mm.transparent = true;
      }
    }
  });
}

function stepQuatFades(dt: number): void {
  for (const [g, f] of quatFades) {
    const dir = Math.sign(f.target - f.k);
    if (dir !== 0) f.k = Math.max(0, Math.min(1, f.k + (dt / QUAT_FADE_SEC) * dir));
    const done = f.k === f.target;
    if (f.k <= 0) {
      g.visible = false;
      applyQuatFade(g, 0, true);
    } else {
      g.visible = true;
      applyQuatFade(g, f.k, done);
    }
  }
}

/** 四元数视图三个演示组的互斥切换（带过渡） */
function enterQuatScene(which: "interp" | "neg" | "proj"): void {
  const parts = sceneHandles.quatView.parts;
  quatGroupFade(parts.interpGroup, which === "interp");
  quatGroupFade(parts.negGroup, which === "neg");
  quatGroupFade(parts.projGroup, which === "proj");
  sceneHandles.quatView.parts.sphere.visible = false; // 可见性交给 interpGroup 级淡入淡出
}

// ---------- 4D 立体投影模式 ----------
const projState = {
  q: qId() as Quat,
  anim: null as null | { from: Quat; to: Quat; t: number; dur: number },
};
const PROJ_I: Quat = { w: 0, x: 1, y: 0, z: 0 };
const PROJ_J: Quat = { w: 0, x: 0, y: 1, z: 0 };
const PROJ_K: Quat = { w: 0, x: 0, y: 0, z: 1 };

function projApply(q: Quat): void {
  $("quat-readout").textContent = `[${[q.w, q.x, q.y, q.z].map((a) => a.toFixed(3)).join(", ")}]`;
  sceneHandles.quatView.setProjection(q);
}

function projAnimateTo(target: Quat): void {
  // 弦上的归一化插值（nlerp）：不取短路径，保证终点恰为目标四元数（连按两次精确到 −q）
  projState.anim = { from: { ...projState.q }, to: target, t: 0, dur: 0.7 };
}
$("btn-proj-i").addEventListener("click", () => projAnimateTo(qMul(projState.q, PROJ_I)));
$("btn-proj-j").addEventListener("click", () => projAnimateTo(qMul(projState.q, PROJ_J)));
$("btn-proj-k").addEventListener("click", () => projAnimateTo(qMul(projState.q, PROJ_K)));
$("btn-proj-reset").addEventListener("click", () => projAnimateTo(qId()));

$("quat-mode").addEventListener("change", () => {
  const proj = ($("quat-mode") as HTMLSelectElement).value === "proj";
  document.querySelectorAll(".quat-interp-only").forEach((el) => el.classList.toggle("hidden", proj));
  $("quat-proj-group").classList.toggle("hidden", !proj);
  if (proj) {
    enterQuatScene("proj");
    projApply(projState.q);
  } else {
    enterQuatScene(($("quat-neg-toggle") as HTMLInputElement).checked ? "neg" : "interp");
  }
});

/** 投影动画推进（独立于仿真暂停） */
function stepQuatProj(dt: number): void {
  const a = projState.anim;
  if (!a) return;
  a.t += dt / a.dur;
  const u = a.t >= 1 ? 1 : a.t * a.t * (3 - 2 * a.t);
  const mid = qNorm({
    w: a.from.w + (a.to.w - a.from.w) * u,
    x: a.from.x + (a.to.x - a.from.x) * u,
    y: a.from.y + (a.to.y - a.from.y) * u,
    z: a.from.z + (a.to.z - a.from.z) * u,
  });
  if (a.t >= 1) {
    projState.q = a.to;
    projState.anim = null;
    projApply(a.to);
  } else {
    projApply(mid);
  }
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
      `陀螺仪 ${fmtVec(gyroDps)} °/s<br />加速度计 ${fmtVec(imu.accel)} m/s²`;
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
      `<span class="lg-item"><span class="lg-dot" style="background:#ffb454"></span>磁航向指示（MARG 已关：会随陀螺仪漂移偏离真北）</span>`;
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
      return `<div class="tel-line"><span class="dim">本帧加速度计权重</span><span>${(w * 100).toFixed(1)}%</span></div>` +
        `<div class="tel-line"><span class="dim">加速度计倾角 φ/θ</span><span>${fmtSigned(d.rollAccDeg ?? 0)}° ${fmtSigned(d.pitchAccDeg ?? 0)}°</span></div>` +
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
    case "kalman":
      return `<div class="tel-line"><span class="dim">零偏估计 |b|</span><span>${(d.biasNormDps ?? 0).toFixed(3)}°/s</span></div>` +
        `<div class="tel-line"><span class="dim">零偏分量 x/y/z</span><span>${fmtSigned(d.biasXDps ?? 0, 2)} ${fmtSigned(d.biasYDps ?? 0, 2)} ${fmtSigned(d.biasZDps ?? 0, 2)}°/s</span></div>` +
        `<div class="tel-line"><span class="dim">重力新息角</span><span>${fmtSigned(d.innoAccelDeg ?? 0)}°</span></div>` +
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
    st.textContent = "加速度计失效（近似自由落体）：已忽略实测方向";
    st.classList.add("warn");
  } else if (disturbed) {
    st.textContent = "加速度计受扰中（‖a‖ 偏离 g 超过 35%）：实测方向不可信";
    st.classList.add("warn");
  } else if (inHold) {
    st.textContent = "加速度计刚从受扰中恢复——机动时加速度计会被线加速度污染";
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
  if (compDemoRunning) stepCompDemo(dt);

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
  stepQuatProj(dt);
  stepQuatFades(dt);

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

// ---------- 文档页（左模块导航 + 中内容 + 右「本页目录」；按页记忆滚动位置） ----------
const docsOverlay = document.getElementById("docs-overlay")!;
const docPagesEl = document.querySelector<HTMLElement>(".doc-pages")!;
const chapterToc = document.getElementById("docs-chapter-toc")!;
const docModuleBtns = [...document.querySelectorAll<HTMLButtonElement>(".docs-toc .module-link")];
const docPageEls = [...document.querySelectorAll<HTMLElement>(".doc-page")];

/** 页面 → 所属大模块（「完整推导」独立页归滤波算法讲解模块） */
function docModuleOf(page: string): string {
  return page.endsWith("-detail") ? "filters" : page;
}

let activeDocPage = "manual";
/** 每个页面各自的滚动位置；退出/切页时保存，回来时恢复 */
const docScrollMemory = new Map<string, number>();

/** 右侧「本页目录」：由当前页的 section[id]（章）与 h3[id]（推导步骤）生成 */
function buildChapterToc(page: HTMLElement): void {
  const anchors = [...page.querySelectorAll<HTMLElement>("section[id], h3[id]")];
  const items: Array<{ id: string; text: string; sub: boolean }> = [];
  for (const el of anchors) {
    if (el.tagName === "SECTION") {
      const head = el.querySelector("h2, h3");
      if (head) items.push({ id: el.id, text: head.textContent!.trim(), sub: head.tagName === "H3" });
    } else {
      items.push({ id: el.id, text: el.textContent!.trim(), sub: true });
    }
  }
  chapterToc.innerHTML =
    `<div class="ct-title">本页目录</div>` +
    (items.length
      ? items
          .map((it) => `<a href="#${it.id}"${it.sub ? ' class="ct-sub"' : ""}>${it.text}</a>`)
          .join("")
      : `<div class="ct-empty">（本页无小节）</div>`);
}

function showDocPage(id: string, restore = false): void {
  const page = docPageEls.find((p) => p.dataset.docPage === id);
  if (!page) return;
  if (activeDocPage !== id) docScrollMemory.set(activeDocPage, docPagesEl.scrollTop);
  activeDocPage = id;
  for (const p of docPageEls) p.hidden = p !== page;
  for (const b of docModuleBtns) b.classList.toggle("active", b.dataset.doc === docModuleOf(id));
  buildChapterToc(page);
  docPagesEl.scrollTop = restore ? (docScrollMemory.get(id) ?? 0) : 0;
  updateCompDemoRun();
}

function setDocsOpen(open: boolean): void {
  docsOverlay.hidden = !open;
  if (open) {
    document.body.style.overflow = "hidden";
    showDocPage(activeDocPage, true);
  } else {
    docScrollMemory.set(activeDocPage, docPagesEl.scrollTop);
    document.body.style.overflow = "";
  }
  updateCompDemoRun();
}
$("btn-docs").addEventListener("click", () => setDocsOpen(true));
$("btn-docs-close").addEventListener("click", () => setDocsOpen(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !docsOverlay.hidden) setDocsOpen(false);
});

/** 统一的文档内锚点跳转：目标在当前页 → 平滑滚动；在别的页 → 先切页再滚 */
function jumpToHash(target: HTMLElement): void {
  const page = target.closest(".doc-page") as HTMLElement | null;
  if (page && page.dataset.docPage !== activeDocPage) showDocPage(page.dataset.docPage!);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}
for (const container of [docPagesEl, chapterToc]) {
  container.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !a.hash) return;
    const target = document.getElementById(a.hash.slice(1));
    if (!target) return;
    e.preventDefault();
    jumpToHash(target);
  });
}

// 左栏模块按钮：点击即切换到该模块
for (const btn of docModuleBtns) {
  btn.addEventListener("click", () => showDocPage(btn.dataset.doc!));
}

// 滚动跟随高亮：右栏目录中当前章节（隐藏页的元素不会相交，天然只作用于当前页）
const chapterObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const id = (en.target as HTMLElement).id;
      chapterToc.querySelectorAll("a").forEach((a) => {
        a.classList.toggle("active", a.hash === "#" + id);
      });
    }
  },
  { root: docPagesEl, rootMargin: "-15% 0px -70% 0px" },
);
for (const p of docPageEls) {
  for (const el of p.querySelectorAll<HTMLElement>("section[id], h3[id]")) chapterObserver.observe(el);
}

// ---------- 文档页小演示：互补滤波三路信号实时对比 ----------
const compDemoCanvas = document.getElementById("fig-comp-demo") as HTMLCanvasElement | null;
const compDemoCtx = compDemoCanvas ? compDemoCanvas.getContext("2d") : null;
let compDemoRunning = false;
let compDemoT = 0;
const cdState = { gyro: 0, fused: 0 };
const cdBuf: number[][] = [[], [], [], []];
const CD_N = 560; // 一轮样本数（画满即停顿重播，起点永远在左端）
const CD_HOLD = 1.4; // 画满后的停顿秒数
let cdHoldT = 0;
const CD_COLORS = ["#16202f", "#e5484d", "#94a3b8", "#d97706"];

/** 仅当文档层打开且停留在滤波概览页时运转（主循环里每帧调用一次步进） */
function updateCompDemoRun(): void {
  compDemoRunning = !docsOverlay.hidden && activeDocPage === "filters" && compDemoCtx !== null;
}

function stepCompDemo(dt: number): void {
  if (!compDemoCtx || !compDemoCanvas) return;
  if (cdBuf[0].length >= CD_N) {
    // 停顿相位：冻结画面，倒计时结束后清空从头重播
    cdHoldT += dt;
    if (cdHoldT < CD_HOLD) return;
    cdHoldT = 0;
    compDemoT = 0;
    cdState.gyro = 0;
    cdState.fused = 0;
    for (const b of cdBuf) b.length = 0;
    drawCompDemo();
    return;
  }
  compDemoT += dt;
  const truth = 16 * Math.sin(0.55 * compDemoT) + 7 * Math.sin(0.17 * compDemoT);
  const dTruth =
    16 * 0.55 * Math.cos(0.55 * compDemoT) + 7 * 0.17 * Math.cos(0.17 * compDemoT);
  const gyroRate = dTruth + 0.8 + (Math.random() - 0.5) * 4; // 陀螺仪：零偏 0.8°/s + 噪声
  const accel = truth + (Math.random() - 0.5) * 26; // 加速度计：重噪声、不漂
  cdState.gyro += gyroRate * dt;
  cdState.fused += gyroRate * dt + 1.4 * (accel - cdState.fused) * dt; // 互补 α=1.4
  cdBuf[0].push(truth);
  cdBuf[1].push(cdState.gyro);
  cdBuf[2].push(accel);
  cdBuf[3].push(cdState.fused);
  drawCompDemo();
}

function drawCompDemo(): void {
  if (!compDemoCtx || !compDemoCanvas) return;
  const ctx = compDemoCtx;
  const W = compDemoCanvas.width;
  const H = compDemoCanvas.height;
  const L = 40, T = 34, B = 16, R = 8; // 顶部 34px 留给图例，曲线不与图例重叠
  const mid = T + (H - T - B) / 2;
  const sc = (H - T - B) / 2 / 40;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#e5eaf2";
  ctx.lineWidth = 1;
  for (const v of [-30, -15, 15, 30]) {
    ctx.beginPath();
    ctx.moveTo(L, mid - v * sc);
    ctx.lineTo(W - R, mid - v * sc);
    ctx.stroke();
  }
  ctx.strokeStyle = "#c9d4e4";
  ctx.beginPath();
  ctx.moveTo(L, mid);
  ctx.lineTo(W - R, mid);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, H - B);
  ctx.stroke();
  const n = cdBuf[0].length;
  if (n >= 2) {
    const widths = [1.6, 1.5, 1, 2.6];
    cdBuf.forEach((buf, k) => {
      ctx.strokeStyle = CD_COLORS[k];
      ctx.lineWidth = widths[k];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = L + ((W - L - R) * i) / (CD_N - 1);
        const y = mid - Math.max(-38, Math.min(38, buf[i])) * sc;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
  }
  // 当前时刻圆点（描画笔头）：四路信号各自的最新点
  if (n >= 1) {
    cdBuf.forEach((buf, k) => {
      const x = L + ((W - L - R) * (n - 1)) / (CD_N - 1);
      const y = mid - Math.max(-38, Math.min(38, buf[n - 1])) * sc;
      ctx.beginPath();
      ctx.arc(x, y, k === 3 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = CD_COLORS[k];
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    });
  }
  // 起点：左端刻度 + 标注
  ctx.strokeStyle = "#b9c6d8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(L, T - 6);
  ctx.lineTo(L, H - B + 6);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText("起点", L - 2, T - 10);
  ctx.fillStyle = "#64748c";
  ctx.fillText("起点", L - 2, T - 10);
  // 底部进度条：本轮画到哪了
  const prog = n / CD_N;
  ctx.fillStyle = "#e5eaf2";
  ctx.fillRect(L, H - 8, W - L - R, 3);
  ctx.fillStyle = "#d97706";
  ctx.fillRect(L, H - 8, (W - L - R) * prog, 3);
  // 图例最后绘制并加白色描边光晕，压线也可读
  const legend = ["真实角", "陀螺仪积分（漂移）", "加速度计（噪声）", "融合"];
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "alphabetic";
  legend.forEach((t, i) => {
    const x = L + 10 + i * 152;
    const y = 20;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.strokeText(t, x, y);
    ctx.fillStyle = CD_COLORS[i];
    ctx.fillText(t, x, y);
  });
  const scaleLabel = "±30°";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText(scaleLabel, 6, mid - 28 * sc + 4);
  ctx.fillStyle = "#64748c";
  ctx.fillText(scaleLabel, 6, mid - 28 * sc + 4);
}

// ---------- 初始化 ----------
updateSourceChip();
setGimbalAngles(0, 0, 0);
applyView("attitude"); // 视图不持久化，始终从四轴姿态视图开始
setTelemetryVisible(false); // 玻璃盒默认关闭，写 body[data-telemetry] 供 CSS 使用
updateGravityLegend();
updateMagLegend();
