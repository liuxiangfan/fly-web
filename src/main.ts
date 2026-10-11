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
import { DEG, qAngleBetween, qToEuler } from "./core/quat";

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
};

// ---------- 场景 ----------
const sceneHandles = createScene($("viewport"));

// ---------- 图表 ----------
const seriesDef = [
  { label: "真实", color: "#e6edf3" },
  ...ests.map((e) => ({ label: e.label, color: e.color })),
];
const attChart = new RollingChart($("att-canvas"), seriesDef, { windowSec: CHART_WINDOW });
const errChart = new RollingChart(
  $("err-canvas"),
  ests.map((e) => ({ label: e.label, color: e.color })),
  { windowSec: CHART_WINDOW },
);

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
function buildLegend(
  container: HTMLElement,
  defs: Array<{ label: string; color: string }>,
  visible: boolean[],
  onToggle: () => void,
): Array<HTMLElement | null> {
  const vals: Array<HTMLElement | null> = [];
  container.innerHTML = "";
  defs.forEach((d, i) => {
    const chip = document.createElement("span");
    chip.className = "legend-chip";
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
      chip.classList.toggle("off", !visible[i]);
      onToggle();
    });
    container.appendChild(chip);
    vals.push(val);
  });
  return vals;
}
const attValEls = buildLegend($("att-legend"), seriesDef, state.attVisible, () =>
  attChart.setVisible(state.attVisible),
);
const errValEls = buildLegend($("err-legend"), seriesDef.slice(1), state.errVisible, () =>
  errChart.setVisible(state.errVisible),
);

// ---------- 控件 ----------
function bindSlider(id: string, apply: (v: number) => void, fmt: (v: number) => string): void {
  const input = $<HTMLInputElement>(id);
  const out = $<HTMLOutputElement>(`${id}-out`);
  const sync = () => {
    const v = parseFloat(input.value);
    apply(v);
    out.textContent = fmt(v);
  };
  input.addEventListener("input", sync);
  sync();
}

bindSlider("man-roll", (v) => (world.manual.rollDeg = v), (v) => `${v.toFixed(0)}°`);
bindSlider("man-pitch", (v) => (world.manual.pitchDeg = v), (v) => `${v.toFixed(0)}°`);
bindSlider("man-yaw", (v) => (world.manual.yawDeg = v), (v) => `${v.toFixed(0)}°`);
bindSlider("imu-gyro-bias", (v) => (imuParams.gyroBiasDps = v), (v) => `${v.toFixed(1)}°/s`);
bindSlider("imu-gyro-noise", (v) => (imuParams.gyroNoiseDps = v), (v) => `${v.toFixed(2)}°/s`);
bindSlider("imu-accel-noise", (v) => (imuParams.accelNoise = v), (v) => `${v.toFixed(2)}m/s²`);
bindSlider("imu-lin-accel", (v) => (imuParams.linAccel = v), (v) => `${v.toFixed(1)}m/s²`);
bindSlider("imu-vibration", (v) => (imuParams.vibration = v), (v) => v.toFixed(2));
bindSlider("mahony-kp", (v) => (mahony.kp = v), (v) => v.toFixed(2));
bindSlider("mahony-ki", (v) => (mahony.ki = v), (v) => v.toFixed(2));
bindSlider("madg-beta", (v) => (madg.beta = v), (v) => v.toFixed(2));
bindSlider("comp-alpha", (v) => (comp.alpha = v), (v) => v.toFixed(2));

const scenarioSelect = $<HTMLSelectElement>("scenario-select");
scenarioSelect.addEventListener("change", () => {
  world.setScenario(scenarioSelect.value);
  $("manual-group").classList.toggle("hidden", scenarioSelect.value !== "manual");
  resetSim();
});

const sourceSelect = $<HTMLSelectElement>("source-select");
function sourceLabel(): string {
  return state.source === "truth" ? "真实姿态" : ests.find((e) => e.id === state.source)!.label;
}
function sourceColor(): string {
  return state.source === "truth" ? "#e6edf3" : ests.find((e) => e.id === state.source)!.color;
}
sourceSelect.addEventListener("change", () => {
  state.source = sourceSelect.value as typeof state.source;
  const chip = $("readout-source");
  chip.textContent = `模型显示：${sourceLabel()}`;
  chip.style.color = sourceColor();
});
$("readout-source").textContent = `模型显示：${sourceLabel()}`;
$("readout-source").style.color = sourceColor();

$("ghost-toggle").addEventListener("change", () => {
  sceneHandles.ghost.group.visible = ($("ghost-toggle") as HTMLInputElement).checked;
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
const fmtSigned = (v: number, d = 1): string => (v >= 0 ? "+" : "") + v.toFixed(d);
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
  attValEls.forEach((el, i) => {
    if (el) el.textContent = Number.isFinite(att[i]) ? `${att[i].toFixed(1)}°` : "--";
  });
  const err = errChart.latest();
  errValEls.forEach((el, i) => {
    if (el) el.textContent = Number.isFinite(err[i]) ? `${err[i].toFixed(2)}°` : "--";
  });
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

  if (state.playing) {
    simAcc += dt;
    if (simAcc > 0.25) simAcc = 0.25; // 标签页隐藏后恢复时，最多补 0.25s，避免疯狂快进
    while (simAcc >= H) {
      stepSim();
      simAcc -= H;
    }
    quad.props.forEach((p, i) => (p.rotation.y += (i % 2 ? 1 : -1) * 30 * dt));
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
    attChart.render();
    errChart.render();
  }
}
