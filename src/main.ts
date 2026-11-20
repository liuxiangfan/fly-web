// KaTeX 数学字体：只保留 KaTeX_Main 一族的 4 个 woff2（见 src/fonts.css 顶部说明）。
// 这里**不能**再 import katex/dist/katex.min.css——那会连带打进 59 个字体文件（约 1.17 MB）。
import "./fonts.css"; // 自托管 Fira 子集：国内网络/PWA 离线均不依赖 Google Fonts
import "./style.css";
import { createScene } from "./scene/setup";
import { QUAT_POSE_PAIRS } from "./scene/quatview";
import { RollingChart } from "./ui/chart";
import { World } from "./core/world";
import { scenarios } from "./core/scenarios";
import type { ImuParams, ImuSample } from "./core/imu";
import { G_ACC, MAG_WORLD_NED, simulateMag, softIronGains } from "./core/imu";
import { accelVerdict, synthesizeAccelVerification } from "./core/calib-verify";
import { calibrationStaleness, fingerprintOf } from "./core/calib-meta";
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MahonyEstimator,
  MadgwickEstimator,
  createEstimators,
  type Estimator,
} from "./estimators";
import { DEG, qAngleBetween, qConj, qFromEuler, qId, qMul, qNorm, qRotInv, qSlerp, qToAxisAngle, qToEuler, RAD, symmetricEigen3, type Quat, type V3 } from "./core/quat";
import { TruthTrack } from "./core/truth-track";
import { gimbalDemo, gimbalInnerQuat, toDisplayVec } from "./core/gimbal";
import { ArrowHelper, Color, Group, Material, Matrix4, Mesh, Vector3 } from "three";
import { selectViewAction } from "./ui/view-action";
import { applyViewDom, narrateGimbal, type UiView } from "./ui/mode";
import { errorText } from "./core/html-escape";
import { buildDocIndex, hitsHtml, MIN_QUERY_LENGTH, movedSelection, searchDocBlocks, type DocBlock } from "./ui/doc-search";
import { applyFontTier, isFontTier, loadFontTier, saveFontTier } from "./ui/preferences";
import { createFormulaCopy, formulaText, selectFormulaText } from "./ui/formula-copy";
import { Gauss, mulberry32 } from "./core/rng";
import {
  frameIntervalSec,
  parseFrame,
  parseMavlinkFrame,
  parseTextLine,
  type Mounting,
  type SerialImuFrame,
  type SerialProtocol,
} from "./core/serial";
import {
  applyMagCalibration,
  calibrateMagWithValidation,
  verifyMagCalibration,
  type MagCalibration,
} from "./core/magcal";
import {
  applyAccelCalibration,
  assessStaticWindow,
  calibrateAccel,
  faceMatchesReading,
  validateAccelCalibration,
  verifyAccelCalibration,
  type AccelCalibration,
  type AccelCalibrationSample,
  type AccelFace,
} from "./core/accelcal";
import { ErrorTracker } from "./core/stats";
import type { ExperimentSpec } from "./ui/experiments";
import type { ChallengeSpec } from "./ui/challenges";
import type { TourStep } from "./ui/tour";
import { fitInsetCanvas } from "./ui/canvas-util";
import { drawInsMap, fmtMeters } from "./ui/ins-view";
import { b64urlDecode, b64urlEncode } from "./ui/b64";
import { parseImuCsv, type ReplayFrame, type ReplayParseResult } from "./core/replay";
import type { LogRow, RawRow } from "./core/csv-export";
import { SolveLoop } from "./core/solve-loop";
import { ReplayPlayer } from "./core/replay-player";
import { pushBounded } from "./core/serial-queue";
import { ReconnectPolicy } from "./core/reconnect";
import { scheduleTransportReconnect } from "./core/reconnect-schedule";
import { NotificationSession, SerialTransportSession, TransportSession } from "./core/transport-session";
import { RUN_H } from "./core/run-constants";
import { applyTuning } from "./core/tuning";
import {
  buildArchive as buildArchiveObject,
  describeArchiveRun,
  parseArchive,
  type ArchiveRunInfo,
  type ExperimentArchive,
} from "./core/experiment-archive";
import { batchRowsHtml, batchStatusText } from "./ui/batch-table";
import {
  accelResultHtml,
  accelStatusText,
  accelVerifyLineHtml,
  fixedList,
  magHistoryHtml,
  magResultHtml,
  magStatusText,
  magVerifyLineHtml,
} from "./ui/calib-panel";
import { InsIntegrator } from "./core/ins";
import type { DocDemos } from "./ui/doc-demos";
import {
  DEFAULT_EXPERIMENT_CONFIG,
  DEFAULT_ESTIMATOR_TUNING,
  ARCHIVE_IGNORED_KEYS,
  archiveExpressibilityProblems,
  archiveRoundTripProblems,
  cloneAccelCalibration,
  cloneExperimentConfig,
  cloneMagCalibration,
  defaultExperimentConfig,
  initialAttitudeOf,
  magCalibrationProblems,
  validateExperimentConfig,
  type ExperimentConfig,
  type EstimatorId,
  type EstimatorTuning,
  type MagCalModel,
} from "./core/experiment-config";
import { archiveControlRoundTripProblems, archiveUiSteps, quantizeSliderValue, type ControlSpecs } from "./core/archive-ui";
/** 构建期注入（vite define）：线上页面必须能回答「我看的是哪个提交」 */
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;

import type { EstimatorRunMetrics, HeadlessRunResult } from "./core/runner";
import { loadRunner } from "./ui/runner-loader";
type RunnerModule = Awaited<ReturnType<typeof loadRunner>>;
type BatchSummary = ReturnType<RunnerModule["summarizeRuns"]>["summary"];
import type { BatchRequest, BatchResponse } from "./core/batch-protocol";
import type { ComparisonApplyResult, ComparisonPanelApi, ComparisonPanelSnapshot } from "./ui/comparison-panel";
import type { TaskDescriptor, TaskStripApi } from "./ui/task-strip";
import type { LearningPanelApi } from "./ui/learning-panel";
import type { PredictionAnswer } from "./ui/learning-activities";
import type { TelemetryDiagnosticsApi } from "./ui/telemetry-diagnostics";
import type { ReportPanelApi } from "./ui/report-panel-ui";
import batchWorkerUrl from "virtual:worker-url/batch";
import {
  hasPhysicalReference,
  isExternalSource,
  referenceKindOf,
  sourceLabelOf,
  type DataSourceKind,
  type DataSourceState,
  type ReferenceKind,
} from "./core/data-source";

const H = 1 / 500; // 仿真/解算步长
const LOG_DT = 0.04; // 曲线记录间隔
const CHART_WINDOW = 30;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// 仿真步异常保护：记录一次并暂停，渲染循环与交互不受影响（可切模式后继续）
let simErrorShown = false;
/** 仿真异常横幅的 DOM 引用：复位时要把它摘掉，否则那条红字会一直挂在屏幕上（实测踩到） */
let simErrorChip: HTMLElement | null = null;
function clearSimError(): void {
  simErrorShown = false;
  simErrorChip?.remove();
  simErrorChip = null;
}
function showSimError(err: unknown): void {
  if (simErrorShown) return;
  simErrorShown = true;
  console.error("仿真步异常，已暂停：", err);
  const chip = document.createElement("div");
  chip.className = "ov-chip";
  chip.style.color = "#f85149";
  chip.textContent = `仿真已暂停：${errorText(err)}（切换机动模式后点「继续」可恢复）`;
  (document.getElementById("toast-layer") ?? $("readout-overlay")).appendChild(chip);
  simErrorChip = chip;
}

// ---------- 仿真状态 ----------
/**
 * 唯一的数值实验配置（P1）：滑块直接写 `experimentConfig.imu`，
 * 估计器参数仍由 bindSlider 写实例（runner 批量评测时从界面同步成配置快照）。
 */
const experimentConfig: ExperimentConfig = defaultExperimentConfig();
/**
 * 稳态统计窗口起点（秒，相对本段起点）。界面上没有独立控件，但它会改变 RMSE/P95 口径，
 * 所以必须进活状态并随档案导入恢复，不能当"展示字段"丢掉。
 */
let steadyFromSec: number | null = null;
const world = new World(scenarios.hover, experimentConfig.seed);
const ests: Estimator[] = createEstimators();
const comp = ests[1] as ComplementaryEstimator;
const mahony = ests[2] as MahonyEstimator;
const madg = ests[3] as MadgwickEstimator;
const kalman = ests[4] as KalmanEstimator;

const imuParams: ImuParams = experimentConfig.imu;

// ---------- 磁力计标定（硬铁球心 + 对角软铁缩放） ----------
// 采集 → 拟合 → 应用。模拟模式可用「用当前磁模型自动采集」一步生成覆盖全姿态的
// 样本（含当前硬铁/干扰/噪声参数）；真实模式则在用户翻滚机体时收集串口磁读数。
const MAG_CAL_TARGET = 240;
/** 磁校准历史（最近 5 次拟合，可恢复） */
interface MagCalHistoryEntry {
  id: number;
  atText: string;
  model: "diag" | "full";
  sampleCount: number;
  residual: number;
  lateResidual: number | null;
  cal: MagCalibration;
}
const magCalHistory: MagCalHistoryEntry[] = [];
let magCalHistorySeq = 0;
/** 当前生效的历史条目 id（0 = 不是历史里的任何一条：例如从档案导入的标定） */
let activeMagCalHistoryId = 0;

function pushMagCalHistory(cal: MagCalibration, model: "diag" | "full"): void {
  const id = ++magCalHistorySeq;
  activeMagCalHistoryId = id;
  magCalHistory.unshift({
    id,
    atText: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    model,
    sampleCount: cal.count,
    residual: cal.residual,
    lateResidual: cal.validation?.late?.residual ?? null,
    cal: cloneMagCalibration(cal),
  });
  if (magCalHistory.length > 5) magCalHistory.length = 5;
}

const magCalState = {
  cal: null as MagCalibration | null,
  applied: false,
  collecting: false,
  samples: [] as V3[],
  /** 最近一次拟合失败的原因（UI 提示用） */
  message: "",
  /**
   * 最近一次「独立验证」的结果行。必须存在状态里由 updateMagCalUi 渲染，
   * 不能直接 `result.innerHTML += ...`——面板每 2 Hz 重建一次 innerHTML，追加的行会被抹掉。
   */
  verifyLine: "" as string,
};
/** 回放旁路/未应用时原样返回；否则走对应标定 */
function estimationValue(raw: V3, apply: (v: V3, cal: never) => V3, cal: unknown): V3 {
  if (calibrationBypassed()) return [raw[0], raw[1], raw[2]];
  return apply(raw, cal as never);
}
function magForEstimation(raw: V3): V3 {
  return estimationValue(raw, applyMagCalibration as never, magCalState.applied ? magCalState.cal : null);
}
function collectMagSample(raw: V3): void {
  if (!magCalState.collecting) return;
  if (magCalState.samples.length >= 2000) return;
  magCalState.samples.push([raw[0], raw[1], raw[2]]);
}

/* ---------- 加速度计六面校准（交互式采集 → 最小二乘拟合 → 应用） ---------- */
const ACCEL_CAL_SECONDS = 0.5;
const accelCalState = {
  cal: null as AccelCalibration | null,
  applied: false,
  /** 最近一次独立验证的结果行（同 magCalState.verifyLine 的理由） */
  verifyLine: "" as string,
  /** 正在采集的朝向与窗口样本 */
  pending: null as AccelFace | null,
  window: [] as Array<{ t: number; accel: V3; gyro: V3 }>,
  samples: [] as AccelCalibrationSample[],
  message: "",
};
function accelForEstimation(raw: V3): V3 {
  return estimationValue(raw, applyAccelCalibration as never, accelCalState.applied ? accelCalState.cal : null);
}
/** 主循环每帧调用：pending 时收集窗口，达到 0.5 s 就检查静止并写入一面样本 */
function tickAccelCalibration(t: number, sample: ImuSample): void {
  const pendingFace = accelCalState.pending;
  if (!pendingFace) return;
  const w = accelCalState.window;
  // 时间戳必须**严格递增**（ROUND11 P1）：同一时刻连来 4000 帧时，"样本数够多"会被当成
  // "静置了 0.5 s"——实测文案甚至写出"0.00 s 均值"。重复/倒退的时间戳直接判失败。
  if (w.length && !(t > w[w.length - 1].t)) return void failFaceCapture(pendingFace, "时间戳未推进（同一时刻重复采样不算静置）");
  w.push({ t, accel: [...sample.accel], gyro: [...sample.gyro] });
  if (w.length < 2) return;
  const span = w[w.length - 1].t - w[0].t;
  // 时间覆盖优先于样本数：**装满了也不放过**（容量只用来防内存，不代替时长条件）
  if (span < ACCEL_CAL_SECONDS) {
    if (w.length >= 4000) {
      failFaceCapture(pendingFace, `样本已达上限但只覆盖 ${span.toFixed(2)} s（需 ≥${ACCEL_CAL_SECONDS} s）`);
    }
    return;
  }
  const face: AccelFace = pendingFace;
  accelCalState.pending = null;
  const avg = (fn: (x: { accel: V3; gyro: V3 }) => V3): V3 => {
    const out: V3 = [0, 0, 0];
    for (const x of w) {
      const v = fn(x);
      out[0] += v[0]; out[1] += v[1]; out[2] += v[2];
    }
    return [out[0] / w.length, out[1] / w.length, out[2] / w.length];
  };
  const g = avg((x) => x.gyro);
  const a = avg((x) => x.accel);
  // 时间覆盖质量：最大间隙不能超过 0.15 s（中间断流说明这不是一段连续静置）
  let maxGap = 0;
  for (let i = 1; i < w.length; i++) maxGap = Math.max(maxGap, w[i].t - w[i - 1].t);
  if (maxGap > 0.15) return void failFaceCapture(face, `最大采样间隙 ${(maxGap * 1000).toFixed(0)} ms（应 ≤150 ms）`);
  // **时间加权密度**（ROUND12）：只看"最大间隙"会放过「49 点挤在开头 1 ms + 末端补一个点」的
  // 稀疏窗口——那样等权均值其实由那一小簇决定，名义上的 0.5 s 并不成立。
  // 这里把窗口均分成 10 段，每段至少要有 2 个样本；否则判失败。
  {
    const t0 = (w[0] as { t: number }).t;
    const bins = new Array<number>(10).fill(0);
    for (const x of w) bins[Math.min(9, Math.floor(((x.t - t0) / Math.max(span, 1e-9)) * 10))]++;
    const empty = bins.findIndex((c) => c < 2);
    if (empty >= 0) {
      return void failFaceCapture(
        face,
        `窗口第 ${empty + 1}/10 段样本不足（${bins[empty]} 个，需 ≥2）——采样太不连续，均值不可信`,
      );
    }
  }
  const quality = assessStaticWindow(w);
  if (!quality.ok) {
    failFaceCapture(face, `平均 ${quality.meanGyroDps.toFixed(1)}°/s、最大 ${quality.maxGyroDps.toFixed(1)}°/s、σ‖a‖ ${quality.accelNormStd.toFixed(3)}（需 <3/<6/<0.15）`);
    return;
  }
  // 朝向自洽检查：**采集时**就拒，别等到拟合。
  // 复核反例（P1-E）：按钮写着「+x 朝下」、实际读数却是 [0,0,9.81]（+z 朝下）时，
  // 旧实现照样记录成功；六面拟合也会"成功"，只是 RMSE 变成 2.31 m/s² 且标定是错的。
  if (!faceMatchesReading({ raw: a, face })) {
    const m = [0, 1, 2].reduce((best, i) => (Math.abs(a[i]) > Math.abs(a[best]) ? i : best), 0);
    failFaceCapture(face, `读数主方向是 ${a[m] >= 0 ? "+" : "-"}${"xyz"[m]}，与「${face} 朝下」不符`);
    return;
  }
  accelCalState.samples = accelCalState.samples.filter((s) => s.face !== face);
  accelCalState.samples.push({ raw: a, face });
  accelCalState.window = [];
  accelCalState.message =
    `已记录 ${face} 朝下：a = [${fixedList(a, 2)}] m/s² · ` +
    `静止质量 平均 ${quality.meanGyroDps.toFixed(2)}°/s / 最大 ${quality.maxGyroDps.toFixed(2)}°/s / σ‖a‖ ${quality.accelNormStd.toFixed(3)} ` +
    `（${accelCalState.samples.length}/6 面，${span.toFixed(2)} s 均值，陀螺均值 [${fixedList(g, 3)}] rad/s）`;
  updateAccelCalUi();
}
/** 采面失败的统一出口：清窗口 + 写一次性文案 + 刷新面板 */
function failFaceCapture(face: AccelFace, reason: string): void {
  accelCalState.pending = null;
  accelCalState.window = [];
  accelCalState.message = `采集 ${face} 失败：${reason}——重新摆放后点一次`;
  updateAccelCalUi();
}

function beginAccelCalFace(face: AccelFace): void {
  accelCalState.pending = face;
  accelCalState.window = [];
  accelCalState.message = `正在采集 ${face} 朝下（${ACCEL_CAL_SECONDS}s）……保持静止`;
  updateAccelCalUi();
}

/**
 * 任务条按需模块的句柄。声明必须在首次 `resetSim()` 调用之前：
 * `resetSim()` 会通过 `noteReset()` 上报真实复位，若 `let` 声明留在文件尾部，
 * 顶层初始化阶段会触发 TDZ（ReferenceError），页面连 attitudeDemo 都挂不上。
 */
let taskStripApi: TaskStripApi | null = null;

/** 配置版本：任何真实参数/装载/档案提交都会推进；对照报告据此判断是否 stale。 */
let configRevision = 0;
function bumpConfigRevision(): void {
  configRevision += 1;
  queueMicrotask(() => comparisonPanel?.markStaleIfChanged());
}
const onConfigEdit = (ev: Event): void => {
  const el = ev.target;
  if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.closest("#panel")) bumpConfigRevision();
};
document.addEventListener("input", onConfigEdit, false);
document.addEventListener("change", onConfigEdit, false);

/* C/D：诊断服务与 ESKF 单步快照（服务未接线时全部为空，零每帧成本） */
let diagnosticsApi: TelemetryDiagnosticsApi | null = null;
let latestKalmanStep: Parameters<NonNullable<KalmanEstimator["diagnostics"]>>[0] | null = null;

const state = {
  playing: true,
  source: "mahony" as "truth" | Estimator["id"],
  /** real=true 时数据来自串口真实 IMU：无真值基准，误差曲线改以 Mahony 为参照 */
  real: false,
  /**
   * 统一的仿真/数据时钟（秒）。模拟模式跟随 world.t；真实模式按固件 tick
   * 推进——曲线横轴、时钟读数、静止检测冷却、统计窗口全部只认它。
   * （修复：旧版真实模式从不推进 world.t，导致曲线所有点挤在 t=0。）
   */
  simTime: 0,
  channel: 0,
  attVisible: [true, true, true, true, true, true],
  errVisible: [true, true, true, true, true, true],
  errVisibleB: [false, false, false, false],
  lastImu: null as ImuSample | null,
  /** 离线日志携带的外部真值姿态（当前帧）；仅在 referenceKind=external 时作为误差基准 */
  externalTruth: null as Quat | null,
  /** 视图：四轴姿态 / 万向节锁（不持久化，每次从四轴姿态开始） */
  view: "attitude" as UiView,
};

/**
 * 真实模式下停用「只对模拟世界有意义」的控件：
 * 剧本、手动目标、IMU 污染滑块、幻影、闭环、初始偏差——它们不会影响串口数据，
 * 但旧版只是静默忽略，用户会以为滑块坏了。现在明确置灰 + 状态行说明。
 */
function setSimControlsDisabled(disabled: boolean): void {
  const scope = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    ".section-scenario input, .section-scenario select, .section-imu input, .section-imu select",
  );
  for (const el of scope) {
    // 这几个控件在「无模拟」的模式下依然要有用：
    //  · serial-mounting：安装方向对真实数据仍然有效
    //  · replay-speed：回放进行中要能改倍速（否则 1× 只能干等）
    //  · replay-file：回放中要能再导入另一份日志（按钮是程序化点击它的，
    //    禁用会让 click() 静默失效——实测踩到过）
    if (el.id === "serial-mounting" || el.id === "replay-speed" || el.id === "replay-file") continue;
    el.disabled = disabled;
  }
  // 解算频率只对模拟模式有意义（真实模式跟固件 tick 走），真实模式下禁用免得误导
  for (const id of ["solve-rate", "ghost-toggle", "loop-toggle", "init-offset-toggle", "btn-sandbox", "btn-batch", "batch-runs", "experiment-seed"]) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLButtonElement | null;
    if (el) el.disabled = disabled;
  }
  document.querySelectorAll<HTMLButtonElement>("#experiment-list button").forEach((b) => {
    b.disabled = disabled;
  });
  document.querySelectorAll<HTMLButtonElement>("#challenge-list button").forEach((b) => {
    b.disabled = disabled;
  });
  const note = document.getElementById("real-mode-note");
  if (note) {
    note.textContent = replayActive()
      ? replayState.externalReference
        ? "离线回放模式（带外部真值）：剧本 / 模拟噪声 / 手动目标 / 幻影 / 闭环 / 初始偏差已停用——数据来自日志，误差基准 = 日志真值；也可把「模型姿态来源」切到真实姿态查看真值。"
        : "离线回放模式：剧本 / 模拟噪声 / 手动目标 / 幻影 / 闭环 / 初始偏差已停用——数据完全来自导入的日志（无真值，误差基准 = Mahony）。"
      : bleState.connected && !serialState.running
        ? "BLE IMU 模式：剧本 / 模拟噪声 / 手动目标 / 幻影 / 闭环 / 初始偏差已停用——数据完全来自蓝牙通知（无真值，误差基准 = Mahony）。"
        : "真实 IMU 模式：剧本 / 模拟噪声 / 手动目标 / 幻影 / 闭环 / 初始偏差已停用——数据完全来自串口帧。";
    note.classList.toggle("hidden", !disabled);
  }
}

/** 真实/模拟模式切换的连带语义（幻影、误差参照、UI 显隐） */
/**
 * 是否处于「断线重连的过渡态」：此刻数据源暂时不可用，但**不是**用户主动切回模拟。
 * 这个区分很关键——否则每次掉线都会走到下面的「回到模拟模式」分支，
 * 把本轮实验的时钟/曲线/统计全部清零（复核实测：拔线一次，24 s 的曲线全没了）。
 */
function reconnectPending(): boolean {
  return (
    serialReconnectPolicy.pending ||
    bleReconnectPolicy.pending ||
    serialReconnectState.reconnecting ||
    bleReconnectState.reconnecting
  );
}

function applyDataSourceSemantics(): void {
  // 显式数据源语义：kind 决定「数据从哪来」，reference 决定「误差相对谁」。
  // state.real 保留为兼容派生值（外部数据源），新代码应优先用 hasGroundTruth()/currentReferenceKind()。
  state.real = isExternalSource(currentDataSource());
  document.body.dataset.imuMode = state.real ? "real" : "sim";
  setSimControlsDisabled(state.real);
  syncLoopAvailability();
  updateMagCalUi();
  $("err-title").textContent = hasGroundTruth()
    ? "姿态总误差（解算 vs 真实）"
    : `姿态偏差（各算法 vs ${currentReferenceKind() === "external" ? "外部参考" : "Mahony 基准"}）`;
  updateSourceChip(); // chip 上带「数据源：模拟/真实 IMU/离线回放」，切换时必须刷新
  // 真实模式无真值：幻影与「真实姿态」来源失去意义，强制切到 Mahony 并隐藏幻影选项区。
  // 例外：回放日志带 truth_q* 时 hasGroundTruth() 为 true，此时 truth 来源应保持可用。
  if (state.real && !hasGroundTruth()) {
    if (state.source === "truth") {
      state.source = "mahony";
      sourceSelect.value = "mahony";
      updateSourceChip();
    }
  } else if (!state.real) {
    // 断线重连途中会短暂表现为「没有真实数据源」：这时**不能**重置本轮实验，
    // 否则用户一拔线，曲线/统计/时钟就全丢——自动重连的意义也就没了。
    if (reconnectPending()) return;
    for (const e of ests) e.reset();
    for (const c of abState.clones) c.reset();
    resetSim();
  }
  // 「真实姿态」选项：只要有物理真值（模拟或外部真值）就可用；只有 Mahony 基准时禁用
  const truthOpt = sourceSelect.querySelector<HTMLOptionElement>('option[value="truth"]');
  if (truthOpt) truthOpt.disabled = !hasGroundTruth();
  // 姿态曲线图例第一项随数据源改名：外部真值 / Mahony 基准 / 模拟真值
  const truthChip = attLegend?.chips[0];
  const truthName = truthChip?.children[1] as HTMLElement | undefined;
  if (truthName) {
    const kind = currentReferenceKind();
    truthName.textContent = kind === "groundTruth" ? "真实" : kind === "external" ? "外部真值" : "基准(Mahony)";
  }
}
$("btn-serial").addEventListener("dblclick", (e) => e.preventDefault());

// ---------- A/B 参数对比 ----------
// B 组 = 某一时刻的「参数快照」克隆（状态重置、参数冻结），与 A 组吃同一份 IMU 数据；
// 误差图上 A 实线 / B 半透明虚线——调参前后谁好谁坏一眼可读。
// 纯陀螺仪积分不进 B 组：它没有参数，B 永远与 A 逐点重合（也是「取消不掉」错觉的来源）。
const AB_TARGETS = () => ests.filter((e) => e.id !== "pure");
const abState = {
  on: false,
  clones: [] as Estimator[],
  /**
   * B 组在快照时刻的算法配置快照（参数、门控、磁形态、卡尔曼门控/协方差重置）。
   * 分叉后 A 的界面控件只改 A；B 永远读取这份冻结值，保证「单变量对比」。
   */
  frozenTuning: null as Record<string, EstimatorTuning> | null,
};
/**
 * 由**冻结的配置快照**构造 B 组实例——与批量评测同一条装配路径（`applyTuning`）。
 * 不再维护第二份手写的字段拷贝逻辑：`frozenTuning` 是 B 的唯一来源，
 * 否则新增一个算法参数时极易漏拷（历史上 kalmanResetCov 就漏过一次）。
 */
function cloneFromTuning(id: EstimatorId, t: EstimatorTuning): Estimator {
  const c = createEstimators().find((e) => e.id === id)!;
  applyTuning(c, t);
  return c;
}
function snapshotAB(): void {
  const fork = ($("ab-mode") as HTMLSelectElement)?.value === "online-fork";
  // 先冻结配置快照，再由这份快照生成 B 组（唯一来源）
  abState.frozenTuning = Object.fromEntries(AB_TARGETS().map((e) => [e.id, tuningOf(e)]));
  abState.clones = AB_TARGETS().map((e) => {
    const c = cloneFromTuning(e.id as EstimatorId, abState.frozenTuning![e.id]);
    // online-fork：把 A 的**运行期状态**（q、积分器、门控窗口、协方差/零偏）复制过来，
    // 参数仍取快照；A 继续保持原轨迹不中断，B 从分叉点开始走。
    if (fork && c.copyRuntimeFrom) c.copyRuntimeFrom(e);
    return c;
  });
  // 共享调度必须拿到**新的** B 组数组（它按住的是引用，不是 by-name 查询）
  solveLoop?.setSecondary(abState.clones);
  // 此后 A 的控件变化只作用于 A（applyAccelGate/applyMagMode/applyKalmanGate 都不再碰 clones）
  metricsB = abState.clones.map(() => new ErrorTracker({ thresholdDeg: 2, holdSec: 1 }));
  if (fork) metricsB.forEach((m) => m.reset(state.simTime)); // 收敛时刻相对分叉点
  state.errVisibleB.fill(true); // 快照后默认显示 B 组虚线（否则用户只看到 A，以为 A/B 没生效）
  applyVisibility();
  if (fork) {
    toast(`A/B 已在线分叉：B 复制当前状态并冻结参数继续跑（A 不中断）`, "#7ee787");
  } else {
    // same-start：A/B 一起复位，保证两组从相同初值、相同估计器状态起跑
    resetSim();
    toast("A/B 已配对起跑：两组参数从相同初态对比", "#7ee787");
  }
}
function abAlpha(color: string): string {
  return color + "99"; // B 曲线约 60% 不透明：与 A 同色系但层次可分，重合也不完全遮挡
}
$("ab-toggle").addEventListener("change", () => {
  abState.on = ($("ab-toggle") as HTMLInputElement).checked;
  ($("btn-ab-snapshot") as HTMLButtonElement).disabled = !abState.on;
  document.body.dataset.ab = abState.on ? "on" : "off";
  if (abState.on) snapshotAB();
  else {
    abState.clones = [];
    solveLoop?.setSecondary(abState.clones);
  }
});
$("btn-ab-snapshot").addEventListener("click", () => {
  if (abState.on) snapshotAB();
});
/** 切换起跑方式时若 A/B 正在运行，立即按新模式重新分叉（否则要等下一次手动快照） */
$("ab-mode")?.addEventListener("change", () => {
  // 档案导入的**探测阶段**不许重建 B 组：那一刻还没决定是否接受这份档案，
  // 失败回滚只能把控件写回去，无法恢复已经被 snapshotAB 换掉的 B 组与 metricsB。
  if (archiveProbeDepth > 0) return;
  if (abState.on) snapshotAB();
});
/** 卡尔曼协方差重置开关：同时作用于 A/B 两组 */
$("kalman-reset-cov")?.addEventListener("change", () => {
  const on = ($("kalman-reset-cov") as HTMLInputElement).checked;
  // 只改 A；B 的协方差重置配置在快照时冻结。
  for (const e of ests) {
    if (e.id === "kalman") (e as KalmanEstimator).resetCovOnInject = on;
  }
});

// ---------- 场景 ----------
const sceneHandles = createScene($("viewport"));
// 软件光栅化（无 GPU）自动降档时明确说出来：用户能解释「为什么没有阴影」，
// 自动化也能断言当前档位；不静默改变画面。
if (sceneHandles.quality === "software") {
  console.info("[render] 检测到软件渲染（无 GPU 加速），已启用性能优先画质：关闭抗锯齿/阴影/环境贴图");
  const hint = document.getElementById("viewport-hint");
  if (hint) hint.textContent += " · 性能模式（无 GPU）";
}

// ---------- 图表 ----------
const truthSeries = { label: "真实", color: "#e6edf3" };
const estSeries = ests.map((e) => ({ label: e.label, color: e.color }));
const abSeries = AB_TARGETS().map((e) => ({ label: `${e.label} ·B`, color: abAlpha(e.color), dash: [5, 3] }));
const attChart = new RollingChart($("att-canvas"), [truthSeries, ...estSeries], { windowSec: CHART_WINDOW });
const errChart = new RollingChart($("err-canvas"), [...estSeries, ...abSeries], { windowSec: CHART_WINDOW });
// IMU 原始波形（第三面板）：18 通道 = 陀螺/加计/磁三组实测三轴 + 三组真值对照（模拟模式才有，
// 真实模式真值 NaN 不画）。页签只切 visible 掩码（RollingChart 的 y 自适应只看可见通道）。
const AXES = ["x", "y", "z"] as const;
const AXIS_COLORS = ["#e5484d", "#7ee787", "#58a6ff"];
const IMU_TAB_NAMES = ["陀螺仪", "加速度计", "磁力计"];
const imuSeriesDef = [
  ...AXES.map((a, i) => ({ label: `陀螺 ${a}`, color: AXIS_COLORS[i] })),
  ...AXES.map((a, i) => ({ label: `加计 ${a}`, color: AXIS_COLORS[i] })),
  ...AXES.map((a, i) => ({ label: `磁 ${a}`, color: AXIS_COLORS[i] })),
  ...AXES.map((a) => ({ label: `真值 ${a}`, color: "#e6edf3", dash: [4, 3] })),
  ...AXES.map((a) => ({ label: `真值 ${a}`, color: "#e6edf3", dash: [4, 3] })),
  ...AXES.map((a) => ({ label: `真值 ${a}`, color: "#e6edf3", dash: [4, 3] })),
];
const imuChart = new RollingChart($("imu-canvas"), imuSeriesDef, { windowSec: CHART_WINDOW });
const imuState = { tab: 0 as 0 | 1 | 2 };
const imuTabMask = [
  [1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1],
];
/** 用户在图例上的显隐选择（18 通道全局；页签掩码再与它相与） */
const imuVisible = new Array<boolean>(18).fill(true);
/** 当前页签显示的 6 个系列下标：3 条实测 + 3 条真值对照 */
const IMU_TAB_INDICES = [
  [0, 1, 2, 9, 10, 11],
  [3, 4, 5, 12, 13, 14],
  [6, 7, 8, 15, 16, 17],
];
function applyImuTab(): void {
  imuChart.setVisible(imuTabMask[imuState.tab].map((v, i) => v === 1 && imuVisible[i]));
  $("imu-canvas").setAttribute(
    "aria-label",
    `${IMU_TAB_NAMES[imuState.tab]}三轴原始波形（实线=实测，虚线=模拟真值）`,
  );
}
/**
 * IMU 图例：每个页签 3 条实测 + 3 条真值虚线。
 * 旧版 #imu-legend 容器从未被填充——图上有 6 条线，图例却空白，读者无法指认颜色。
 */
let imuLegend: LegendHandles;
function rebuildImuLegend(): void {
  const indices = IMU_TAB_INDICES[imuState.tab];
  const defs: LegendDef[] = [
    ...AXES.map((a, i) => ({ label: `${a} 轴`, color: AXIS_COLORS[i] })),
    ...AXES.map((a) => ({ label: `真值 ${a}`, color: "#e6edf3" })),
  ];
  imuLegend = buildLegend($("imu-legend"), defs, imuVisible, () => {
    applyImuTab();
    imuLegend.chips.forEach((c, i) => c.classList.toggle("off", !imuVisible[imuLegend.indices[i]]));
  }, indices);
  imuLegend.chips.forEach((c, i) => c.classList.toggle("off", !imuVisible[imuLegend.indices[i]]));
}

// 原始记录（切换通道时不丢历史）；快照类型与 CSV 序列化在 core/csv-export.ts。
const logRows: LogRow[] = [];
/** 记录窗口上限与一次裁剪量（导出弹窗会据此提示「更早的行已丢弃」） */
const LOG_ROW_CAP = 850;
const LOG_ROW_TRIM = 100;

/* ---------- 全帧源 IMU 记录（默认关，用于导出→回放与逐帧分析） ---------- */
const RAW_ROW_CAP = 30000; // ≈ 60 s @500 Hz
const RAW_ROW_TRIM = 5000;
/** `sourceCalibrated`：本段全帧记录里的读数是否本来就是校准后读数（回放校准日志时为真） */
const rawRecord = { on: false, rows: [] as RawRow[], sourceCalibrated: false };
function recordRaw(t: number, sample: ImuSample): void {
  if (!rawRecord.on) return;
  // 语义中途变化（例如记录中导入了一份 `# imu=calibrated` 的日志）：一份文件里混着
  // 「原始」和「校准后」两种读数，回放时无论标哪个都是错的。清空重记，只保留一种语义。
  const calibrated = sourceReadingsCalibrated();
  if (calibrated !== rawRecord.sourceCalibrated) {
    rawRecord.rows.length = 0;
    rawRecord.sourceCalibrated = calibrated;
    toast(`读数语义变为「${calibrated ? "校准后" : "原始"}」——记录清空重记，避免混语义`, "#fbbf24");
  }
  rawRecord.rows.push({
    t,
    gyro: [...sample.gyro],
    accel: [...sample.accel],
    mag: [...sample.mag],
  });
  if (rawRecord.rows.length > RAW_ROW_CAP) rawRecord.rows.splice(0, RAW_ROW_TRIM);
}
/** 当前源读数是否已是校准后读数（只有「日志声明 imu=calibrated 的回放」是） */
function sourceReadingsCalibrated(): boolean {
  return replayActive() && replayState.imuCalibrated === true;
}
$("raw-record-toggle")?.addEventListener("change", () => {
  const on = ($("raw-record-toggle") as HTMLInputElement).checked;
  rawRecord.on = on;
  if (on) {
    // 每次开启都重新标定语义：中途切换数据源（模拟→校准日志回放）时，同一个开关
    // 记录的东西已经不是同一类读数了，导出标注必须跟着变。
    rawRecord.sourceCalibrated = sourceReadingsCalibrated();
  }
  if (on && rawRecord.rows.length === 0) {
    toast(
      `已开启全帧记录（上限 30000 帧）${sourceReadingsCalibrated() ? "，标注 # imu=calibrated" : ""}`,
      "#7ee787",
    );
  }
});
// 解卷绕历史：按 数据源×通道 分开记录
const attPrev = new Array<number | undefined>(18).fill(undefined);

// 评测统计：与误差曲线同源（每 40ms 一个样本），A 组常驻，B 组随快照重建
const metricsA = ests.map(() => new ErrorTracker({ thresholdDeg: 2, holdSec: 1 }));
let metricsB: ErrorTracker[] = [];

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
  // 真实模式无真值：第一行（「真实」系列）改为 Mahony 参照基准
  const refQ = referenceQ();
  const truthE = qToEuler(refQ);
  const rows: number[][] = [[truthE.roll, truthE.pitch, truthE.yaw].map((a) => a * DEG)];
  for (const e of ests) {
    const eu = qToEuler(e.q);
    rows.push([eu.roll, eu.pitch, eu.yaw].map((a) => a * DEG));
  }
  return rows;
}

function channelValues(row: LogRow, ch: number): number[] {
  const vals = row.euler.map((r, i) => unwrap(i * 3 + ch, r[ch]));
  // 集体重定位：循环剧本（如横滚 360°）每圈解卷绕累加 360°，永不复位会把
  // 曲线与读数推到几万度。当本通道**所有系列**一起越过 ±180° 时，整体平移
  // 360°——系列之间的相对关系与单圈内的连续性都不受影响，显示值却有界。
  if (vals.length > 0) {
    if (vals.every((v) => v > 180)) {
      for (let i = 0; i < vals.length; i++) {
        vals[i] -= 360;
        const slot = i * 3 + ch;
        if (attPrev[slot] !== undefined) attPrev[slot]! -= 360;
      }
    } else if (vals.every((v) => v < -180)) {
      for (let i = 0; i < vals.length; i++) {
        vals[i] += 360;
        const slot = i * 3 + ch;
        if (attPrev[slot] !== undefined) attPrev[slot]! += 360;
      }
    }
  }
  return vals;
}

function logRow(): void {
  const refQ = referenceQ();
  const errA = ests.map((e) => qAngleBetween(e.q, refQ) * DEG);
  const src = state.lastImu;
  const row: LogRow = {
    t: state.simTime,
    euler: eulerTriples(),
    err: errA,
    quats: ests.map((e) => ({ ...e.q })),
    qTrue: { ...refQ },
    imu: src ? { gyro: [...src.gyro], accel: [...src.accel], mag: [...src.mag], times: src.times } : null,
    // 逐行冻结「当时实际喂给估计器的读数」：取自 onSolve 快照，导出只序列化，绝不事后重算标定
    imuConsumed: consumedSnapshotFor(state.simTime),
    /** 该消费值对应的解算时刻（秒）：与行时刻之差说明「这一行复用了几十毫秒前的解算输入」 */
    consumedSolveT: Number.isFinite(lastSolveInput.t) ? lastSolveInput.t : NaN,
    sourceCalibrated: sourceReadingsCalibrated(),
  };
  logRows.push(row);
  if (logRows.length > LOG_ROW_CAP) logRows.splice(0, LOG_ROW_TRIM);
  logInsTrail();
  attChart.push(state.simTime, channelValues(row, state.channel));
  // 误差图 9 通道：前 5 = A 组（活参数），后 4 = B 组（快照参数，A/B 关闭时为 NaN 不画）
  const errB = abState.on
    ? abState.clones.map((c) => qAngleBetween(c.q, refQ) * DEG)
    : AB_TARGETS().map(() => NaN);
  errChart.push(state.simTime, [...errA, ...errB]);
  // 与曲线同源喂统计（A 组常驻；B 组随快照重建）
  errA.forEach((v, i) => metricsA[i].add(v, state.simTime));
  if (abState.on) errB.forEach((v, i) => metricsB[i]?.add(v, state.simTime));
  // IMU 原始波形 18 通道：三组实测 + 真值对照（模拟 = 世界真值；外部真值回放 = 日志真值）
  const imu = state.lastImu;
  if (imu) {
    const truth = truthWaveforms();
    imuChart.push(state.simTime, [
      imu.gyro[0] * DEG, imu.gyro[1] * DEG, imu.gyro[2] * DEG,
      imu.accel[0], imu.accel[1], imu.accel[2],
      imu.mag[0], imu.mag[1], imu.mag[2],
      ...truth.gyro, ...truth.accel, ...truth.mag,
    ]);
  }
}

/**
 * 「真值波形」的三个来源，绝不把模拟世界冒充成日志真值：
 *  - `groundTruth`（模拟）：世界真值姿态与角速度；
 *  - `external`（回放带 truth_q*）：由日志真值四元数投影重力/磁场，角速度由相邻真值姿态差分得到；
 *  - 其它（真实串口 / 无真值回放）：NaN，曲线不画——Mahony 基准不是物理真值。
 */
const NAN3: [number, number, number] = [NaN, NaN, NaN];
/** 差分角速度用的上一条日志真值姿态（只在外部真值回放时维护） */
let truthPrevQ: Quat | null = null;
let truthPrevT = 0;


function truthWaveforms(): { gyro: [number, number, number]; accel: [number, number, number]; mag: [number, number, number] } {
  const kind = currentReferenceKind();
  if (kind === "groundTruth") {
    return {
      gyro: world.omega.map((v) => v * DEG) as [number, number, number],
      accel: qRotInv(world.q, [0, 0, G_ACC]) as [number, number, number],
      mag: qRotInv(world.q, MAG_WORLD_NED) as [number, number, number],
    };
  }
  if (kind === "external" && state.externalTruth) {
    const q = state.externalTruth;
    let gyro: [number, number, number] = NAN3;
    if (truthPrevQ && state.simTime > truthPrevT) {
      // ω ≈ 2·vec(q_{k-1}^{-1} ⊗ q_k)/Δt（小角差分；与四元数运动学 q̇ = ½ q⊗ω 一致）
      const dq = qMul(qConj(truthPrevQ), q);
      const dt = state.simTime - truthPrevT;
      const sign = dq.w < 0 ? -1 : 1; // q 与 −q 同姿态：取短弧
      gyro = [2 * sign * dq.x / dt * DEG, 2 * sign * dq.y / dt * DEG, 2 * sign * dq.z / dt * DEG];
    }
    truthPrevQ = { ...q };
    truthPrevT = state.simTime;
    return {
      gyro,
      accel: qRotInv(q, [0, 0, G_ACC]) as [number, number, number],
      mag: qRotInv(q, MAG_WORLD_NED) as [number, number, number],
    };
  }
  // 真实串口或无真值回放：不清空前一条差分状态，但要保证不画出假真值
  truthPrevQ = null;
  return { gyro: NAN3, accel: NAN3, mag: NAN3 };
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
  chips: HTMLButtonElement[];
  /** chip → 对应数据系列下标（IMU 面板一个页签只显示 18 通道中的 6 条） */
  indices: number[];
}

function buildLegend(
  container: HTMLElement,
  defs: LegendDef[],
  visible: boolean[],
  onToggle: () => void,
  indices?: number[],
): LegendHandles {
  const vals: Array<HTMLElement | null> = [];
  const chips: HTMLButtonElement[] = [];
  const idxMap: number[] = [];
  container.innerHTML = "";
  defs.forEach((d, i) => {
    const idx = indices ? indices[i] : i;
    // 用真正的 <button>（而不是可点击 span）：键盘 Tab/Enter 可达、读屏可识别
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "legend-chip";
    chip.setAttribute("aria-pressed", "true");
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
      visible[idx] = !visible[idx];
      chip.setAttribute("aria-pressed", String(visible[idx]));
      onToggle();
    });
    container.appendChild(chip);
    vals.push(val);
    chips.push(chip);
    idxMap.push(idx);
  });
  return { vals, chips, indices: idxMap };
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
const errLegendB = buildLegend(
  $("err-legend-b"),
  AB_TARGETS().map((e) => ({ id: `${e.id}-b`, label: `${e.label} B`, color: abAlpha(e.color) })),
  state.errVisibleB,
  () => applyVisibility(),
);

/* ==========================================================================
   配色方案：默认仪表盘色 / 色觉友好（红绿色盲可辨）
   --------------------------------------------------------------------------
   默认色里「纯积分 = 红 #f85149」与「Madgwick = 绿 #7ee787」是经典的红色盲混淆对，
   而曲线常同时在场 6–12 条，只靠颜色区分的风险是实打实的。
   色觉友好档改用 Okabe–Ito 色板（色觉研究的通用无障碍色板）：
     朱红 / 黄 / 蓝 / 蓝绿 / 品红紫 —— 在红绿色盲下靠**色相 + 明度**双重区分，深色底上也都够亮。
   数据系列色写在 JS 里（与 CSS 强调色刻意区分），所以切换要同时改估计器色、
   三个图表的系列色与图例芯片的小圆点。
   ========================================================================== */
const PALETTES = {
  default: {
    truth: "#e6edf3", pure: "#f85149", comp: "#ffa657", mahony: "#58a6ff", madg: "#7ee787", kalman: "#e05fb0",
  },
  cb: {
    truth: "#e6edf3", pure: "#D55E00", comp: "#F0E442", mahony: "#56B4E9", madg: "#009E73", kalman: "#CC79A7",
  },
} as const;
type PaletteKey = keyof typeof PALETTES;

function applyPalette(key: PaletteKey): void {
  const p = PALETTES[key];
  document.body.dataset.palette = key;
  for (const e of ests) {
    e.color = p[e.id as keyof typeof p];
  }
  attChart.setSeriesColors([p.truth, ...ests.map((e) => e.color)]);
  errChart.setSeriesColors([...ests.map((e) => e.color), ...AB_TARGETS().map((e) => abAlpha(e.color))]);
  // 图例芯片的小圆点与文字颜色同步（重建最省事，且能顺带同步 B 组）
  for (const [legend, colors] of [
    [attLegend, [p.truth, ...ests.map((e) => e.color)]],
    [errLegend, ests.map((e) => e.color)],
    [errLegendB, AB_TARGETS().map((e) => abAlpha(e.color))],
  ] as Array<[LegendHandles, string[]]>) {
    legend.chips.forEach((chip, i) => {
      const dot = chip.querySelector<HTMLElement>(".dot");
      if (dot && colors[i]) dot.style.background = colors[i];
    });
  }
  updateSourceChip();
  updateMagLegend();
}

/** 图例芯片的视觉/读屏状态同步 */
function syncChip(chip: HTMLButtonElement, on: boolean): void {
  chip.classList.toggle("off", !on);
  chip.setAttribute("aria-pressed", String(on));
}

/** 用户勾选 → 图表可见性；同时同步图例芯片的置灰状态 */
function applyVisibility(): void {
  attChart.setVisible(state.attVisible);
  errChart.setVisible([...state.errVisible, ...state.errVisibleB]);
  attLegend.chips.forEach((c, i) => syncChip(c, state.attVisible[i]));
  errLegend.chips.forEach((c, i) => syncChip(c, state.errVisible[i]));
  errLegendB.chips.forEach((c, i) => syncChip(c, state.errVisibleB[i]));
}
rebuildImuLegend();
applyImuTab();
applyVisibility(); // 初始图例状态（B 组默认关闭）与图表掩码同步

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

  // 可访问性：滑杆与数值框的可见标签只是相邻文本，读屏不会自动关联——
  // 统一从 .slider-row 的 <label> 取文案写入 aria-label / aria-valuetext
  const labelText = input.closest(".slider-row")?.querySelector("label")?.textContent?.trim() || input.id;
  input.setAttribute("aria-label", labelText);
  if (num) num.setAttribute("aria-label", `${labelText}（数值）`);
  if (stepBox) stepBox.setAttribute("aria-label", `${labelText}（步距）`);

  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const baseStep = parseFloat(input.step) || 0.01;
  const stepMin = baseStep / 100;
  const stepMax = (max - min) / 2;

  /** 夹到范围并按当前步距对齐；量化规则与离线可表达性模型**共用同一函数**（见 core/archive-ui.ts）。
   *  两边各写一份时，"越界值读回什么"会有两个答案：模型说 5、真实控件给 4（复核 SW-03）。 */
  const quantize = (raw: number): number => {
    if (!Number.isFinite(raw)) return parseFloat(input.value);
    const step = parseFloat(input.step) || baseStep;
    return quantizeSliderValue(raw, min, max, step);
  };

  /** 把值同步到滑块、数值框与（可选的）output */
  const render = (v: number): void => {
    input.value = String(v);
    input.setAttribute("aria-valuetext", fmt(v));
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

// 手动目标同时写进 World 实例与实验配置：前者驱动仿真，后者让「同配置 + 同 seed」
// 在 runner/Worker/档案里也能复现（此前只写全局对象，配置里没有这三个角）。
const syncManualTarget = (): void => {
  experimentConfig.manualTargetDeg = [world.manual.rollDeg, world.manual.pitchDeg, world.manual.yawDeg];
};
const manRoll = bindSlider("man-roll", (v) => { world.manual.rollDeg = v; syncManualTarget(); }, (v) => `${v.toFixed(0)}°`);
const manPitch = bindSlider("man-pitch", (v) => { world.manual.pitchDeg = v; syncManualTarget(); }, (v) => `${v.toFixed(0)}°`);
const manYaw = bindSlider("man-yaw", (v) => { world.manual.yawDeg = v; syncManualTarget(); }, (v) => `${v.toFixed(0)}°`);
void manRoll;
void manPitch;
void manYaw;
// ---------- IMU 器件预设（真实数据手册规格 → 滑块一键写入） ----------
// 噪声密度（°/s/√Hz、μg/√Hz）按白噪声采样换算成每采样点 σ：σ = 密度 × √(fs/2)，fs = 500 Hz（√250 ≈ 15.81）。
// 滑块按自身步距对齐，写不入的精确值在注释里保留原数。规格来源见文档·控制项手册·IMU 传感器模拟。
/**
 * 器件预设 = **器件参数的完整快照**（不是「只改我写的那几个」）。
 *
 * 契约（改预设时务必遵守）：预置只写**器件本身**的参数——
 * 零偏、陀螺噪声、加计噪声、交叉轴、非线性、磁量化；
 * 环境与器件级非理想（机动线加速度、振动、硬铁、干扰、软铁、量程、刻度、失准、群延迟）
 * 一律不动，它们各有独立滑块/开关，属于「你怎么用这台器件」而不是「这台器件是什么」。
 *
 * 为什么强调「完整快照」：早期实现用 `if (p.x !== undefined)` 逐项覆盖，于是
 * **没写的字段会继承上一颗器件的值**——选完 MPU-9250 再选 ICM-42688-P，
 * 磁力计量化会留着 AK8963 的 0.6 μT/LSB，而后者是 6 轴、根本没有磁力计。
 * 两个学生做同样的操作却因为起始状态不同得到不同结果，与「可复现」的承诺相悖。
 * 冒烟里有一条不变量用例：同一个预置，无论之前选过什么，写入结果必须一致。
 */
interface ImuPreset {
  biasDps?: number;
  gyroNoiseDps?: number;
  accelNoise?: number;
  crossAxis?: number;
  accelNonlin?: number;
  magQuantUts?: number;
  note: string;
}
const IMU_PRESETS: Record<string, ImuPreset> = {
  custom: { note: "自由调参。选择真实器件可一键写入其数据手册规格换算的噪声/零偏——换一颗传感器，看漂移差几倍。" },
  mpu9250: {
    biasDps: 2,
    gyroNoiseDps: 0.15, // 密度 0.01 °/s/√Hz × 15.81 ≈ 0.158
    accelNoise: 0.05, // 密度 300 μg/√Hz ≈ 0.0029 m/s²/√Hz × 15.81 ≈ 0.047
    crossAxis: 0.02, // 交叉轴敏感度 ±2%
    accelNonlin: 0.005, // 非线性 ±0.5%
    magQuantUts: 0.6, // 内置 AK8963 = 0.6 μT/LSB（数据手册）
    note: "MPU-9250（9 轴，2010 年代教学最常用）：陀螺噪声密度 0.01 °/s/√Hz、加计 300 μg/√Hz；初始零偏容差 ±5 °/s（取 2 为典型值，规格上限拉满更夸张）；交叉轴 ±2%、非线性 ±0.5%、AK8963 磁力计 0.6 μT/LSB。",
  },
  icm42688: {
    biasDps: 1,
    gyroNoiseDps: 0.05, // 密度 0.0028 × 15.81 ≈ 0.044
    accelNoise: 0, // 密度 70 μg/√Hz ≈ 0.011 m/s²（滑块网格对齐后为 0——比默认干净一个量级）
    magQuantUts: 0, // 这是 6 轴器件，本身没有磁力计；装置仍模拟磁链，量化为 0 = 不做量化（不沿用上一颗的值）
    note: "ICM-42688-P（现役 6 轴低噪声标杆）：陀螺噪声密度 0.0028 °/s/√Hz（约为 MPU-9250 的 1/3.6）、加计 70 μg/√Hz；片上可编程数字滤波。零偏未给典型值，保持 1 °/s。",
  },
  bno055: {
    biasDps: 0.5,
    gyroNoiseDps: 0.2, // 密度 0.014 × 15.81 ≈ 0.222
    accelNoise: 0.05, // 密度 175 μg/√Hz ≈ 0.027
    magQuantUts: 0, // 磁力计在片内与融合一起做校准，其分辨率不能直接换算到本模拟链，量化为 0（不沿用上一颗的值）
    note: "BNO055（片上融合智能传感器）：陀螺 0.014、加计 175 μg/√Hz；零偏由片上 Cortex-M0 自动校准追踪（取 0.5 °/s 模拟校准后残余）。它直接输出四元数——相当于把本页算法固化进了传感器。",
  },
};
let presetApplying = false;

/** 手动碰任一预设管理的滑块 → 回到「自定义」 */
/**
 * 器件参数变化后，若已有标定基于旧模型，**主动**提示一次（面板里那行小字要用户点开校准面板才看得到）。
 * 每个标定只提示一次：改动参数是常见操作，反复弹提示会变成噪音。
 */
let staleWarnedFor: MagCalibration | AccelCalibration | null = null;
function warnIfCalibrationStale(): void {
  const magStale = calibrationStaleness(magCalState.cal?.fittedWith, imuParams, "mag", currentMagCalModel());
  const accelStale = calibrationStaleness(accelCalState.cal?.fittedWith, imuParams, "accel");
  const stale = magCalState.cal && magStale ? magCalState.cal : accelCalState.cal && accelStale ? accelCalState.cal : null;
  if (!stale) return;
  if (staleWarnedFor === stale) return;
  staleWarnedFor = stale;
  toast(
    "器件参数已变，已有标定基于旧模型（残差与验证读数不再代表当前配置）——建议重新采集拟合",
    "#fbbf24",
  );
}

function onImuManual(): void {
  if (presetApplying) return;
  warnIfCalibrationStale();
  const sel = document.getElementById("imu-preset") as HTMLSelectElement | null;
  if (sel && sel.value !== "custom") {
    sel.value = "custom";
    const note = document.getElementById("imu-preset-note");
    if (note) note.textContent = IMU_PRESETS.custom.note;
  }
}

const imuSliders = {
  bias: bindSlider("imu-gyro-bias", (v) => { imuParams.gyroBiasDps = v; onImuManual(); }, (v) => `${v.toFixed(1)}°/s`),
  gyroNoise: bindSlider("imu-gyro-noise", (v) => { imuParams.gyroNoiseDps = v; onImuManual(); }, (v) => `${v.toFixed(2)}°/s`),
  accelNoise: bindSlider("imu-accel-noise", (v) => { imuParams.accelNoise = v; onImuManual(); }, (v) => `${v.toFixed(2)}m/s²`),
  crossAxis: bindSlider("imu-cross-axis", (v) => { imuParams.accelCrossAxis = v / 100; onImuManual(); }, (v) => `${v.toFixed(1)}%`),
  accelNonlin: bindSlider("imu-accel-nonlin", (v) => { imuParams.accelNonlin = v / 100; onImuManual(); }, (v) => `${v.toFixed(1)}%`),
  magQuant: bindSlider("imu-mag-quant", (v) => { imuParams.magQuantUts = v; onImuManual(); }, (v) => (v < 0.05 ? "关" : `${v.toFixed(1)}μT`)),
  gyroWalk: bindSlider("imu-gyro-walk", (v) => { imuParams.gyroWalkDps = v; onImuManual(); }, (v) => `${v.toFixed(2)}°/s/√s`),
};
void imuSliders;
{
  const sel = $<HTMLSelectElement>("imu-preset");
  const apply = () => {
    const p = IMU_PRESETS[sel.value];
    const note = document.getElementById("imu-preset-note");
    if (!p) return;
    if (sel.value !== "custom") {
      presetApplying = true;
      if (p.biasDps !== undefined) imuSliders.bias.set(p.biasDps);
      if (p.gyroNoiseDps !== undefined) imuSliders.gyroNoise.set(p.gyroNoiseDps);
      if (p.accelNoise !== undefined) imuSliders.accelNoise.set(p.accelNoise);
      if (p.crossAxis !== undefined) imuSliders.crossAxis.set(p.crossAxis * 100);
      if (p.accelNonlin !== undefined) imuSliders.accelNonlin.set(p.accelNonlin * 100);
      if (p.magQuantUts !== undefined) imuSliders.magQuant.set(p.magQuantUts);
      presetApplying = false;
    }
    if (note) note.textContent = p.note;
  };
  sel.addEventListener("change", () => apply());
}
bindSlider("imu-lin-accel", (v) => (imuParams.linAccel = v), (v) => `${v.toFixed(1)}m/s²`);
bindSlider("imu-vibration", (v) => (imuParams.vibration = v), (v) => v.toFixed(2));
bindSlider("imu-mag-noise", (v) => (imuParams.magNoise = v), (v) => `${v.toFixed(1)}μT`);
bindSlider("imu-mag-disturb", (v) => (imuParams.disturbMag = v), (v) => v.toFixed(2));
// 软铁畸变：导磁材料（机架、螺丝、屏蔽罩）把磁球压成椭球。读数给三轴增益的极差百分比，
// 比裸数字更接近「你能看到什么」——对角标定收得掉它，交叉项收不掉（见文档·磁力计校准）。
bindSlider(
  "imu-soft-iron",
  (v) => {
    imuParams.magSoftIron = v;
    onImuManual();
  },
  (v) => {
    if (v < 0.005) return "关";
    const g = softIronGains(v);
    const maxDev = Math.max(...g.map((x) => Math.abs(x - 1)));
    return `±${(maxDev * 100).toFixed(0)}%`;
  },
);
// 硬铁偏移：机身金属/扬声器磁铁造成的恒定偏移（旧版只存在于 ImuParams，没有 UI 入口）
bindSlider(
  "imu-hard-iron",
  (v) => {
    imuParams.hardIron = v;
    onImuManual();
  },
  (v) => (v < 0.005 ? "关" : `${(v * 8).toFixed(1)}μT`),
);
bindSlider("mahony-kp", (v) => (mahony.kp = v), (v) => v.toFixed(2));
bindSlider("mahony-ki", (v) => (mahony.ki = v), (v) => v.toFixed(2));
bindSlider("madg-beta", (v) => (madg.beta = v), (v) => v.toFixed(2));
bindSlider("comp-alpha", (v) => (comp.alpha = v), (v) => v.toFixed(2));
bindSlider("kalman-proc", (v) => (kalman.gyroNoiseDps = v), (v) => `${v.toFixed(2)}°/s`);
bindSlider("kalman-obs", (v) => (kalman.obsNoise = v), (v) => v.toFixed(3) + "g");
// 陀螺刻度误差 / 安装失准 / 群延迟：速率相关误差与非理想时延（确定性建模）
bindSlider("imu-gyro-scale", (v) => { imuParams.gyroScaleErr = v / 100; onImuManual(); }, (v) => (v < 0.05 ? "关" : `${v.toFixed(1)}%`));
bindSlider("imu-gyro-misalign", (v) => { imuParams.gyroMisalign = v / 100; onImuManual(); }, (v) => (v < 0.05 ? "关" : `${v.toFixed(1)}%`));
bindSlider("imu-delay", (v) => (imuParams.sensorDelayMs = v), (v) => (v < 0.5 ? "关" : `${v.toFixed(0)} ms`));
bindSlider("imu-bandwidth", (v) => (imuParams.sensorBandwidthHz = v), (v) => (v < 1 ? "关" : `${v.toFixed(0)} Hz`));
bindSlider("imu-delay-skew", (v) => (imuParams.sensorDelaySkewMs = v), (v) => (v < 0.25 ? "同步" : `±${v.toFixed(1)} ms`));
bindSlider(
  "imu-sample-rate",
  (v) => (imuParams.sensorSampleHz = v),
  (v) => (v < 10 || v >= 500 ? "跟随仿真" : `${v.toFixed(0)} Hz`),
);
$("imu-gyro-range").addEventListener("change", () => {
  imuParams.gyroRangeDps = Number($<HTMLSelectElement>("imu-gyro-range").value);
  onImuManual();
});

// 磁力计总开关：同时切换三个融合算法的 MARG 路径。
// 注意必须在初始化时同步一次：HTML 里 checkbox 默认勾选，但不触发 change 事件——
// 曾经只靠 change 同步，导致默认状态下 UI 显示「MARG 开」而估计器实际没用磁力计。
function applyMagEnable(): void {
  const on = ($("mag-enable") as HTMLInputElement).checked;
  // A/B 开启时 B 的配置已冻结：这里只改 A，避免「改 A 的开关悄悄改到 B」破坏单变量对比。
  // 纯积分没有磁观测：它的 magEnabled 恒为 false，与默认配置/档案读回保持同形。
  for (const e of ests) e.magEnabled = e.id === "pure" ? false : on;
  solveLoop?.setMagEnabled(on); // 粗对准的观测姿态是否含磁，与估计器口径保持一致
  updateMagLegend();
}
$("mag-enable").addEventListener("change", applyMagEnable);

/**
 * 加速度计方向/幅度门控总开关 + 两个阈值（三家固定增益融合算法）。
 * 暴露成 UI 不只是为了调参：它让「门控救场」实验可以当场 A/B——
 * 关掉后持续机动线加速度会把姿态拽偏，打开则钉在真值附近。
 * 阈值同理：太松污染穿堂而过，太紧正常机动被误拒（U 形权衡）。
 */
function applyAccelGate(): void {
  const on = ($("gate-toggle") as HTMLInputElement).checked;
  const deg = $<HTMLInputElement>("gate-deg").valueAsNumber;
  const magPct = $<HTMLInputElement>("gate-mag").valueAsNumber / 100;
  const recovery = ($("gate-recovery") as HTMLInputElement).checked;
  // A/B 开启时 B 的配置在快照时刻冻结：这里只改 A；要改 B 请重新点「存入 B 组」。
  for (const e of ests) {
    if (e.id === "comp" || e.id === "mahony" || e.id === "madg") {
      const g = e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator;
      g.accelGate = on;
      g.gateDeg = deg;
      g.gateMagPct = magPct;
      g.gateRecovery = recovery;
    }
  }
}
$("gate-toggle").addEventListener("change", applyAccelGate);
// 两个阈值走 bindSlider 而不是裸监听 range：bindSlider 会顺带把「数值框 + 步距框」接线，
// 并在绑定时把当前值写进数值框。原先只挂了 range 的 input 监听 → 右侧那两个数值框
// **永远是空的、敲进去也毫无反应**（同页其它 29 行都能键入，只有这两行不能）。
bindSlider("gate-deg", () => applyAccelGate(), (v) => `${v.toFixed(0)}°`);
bindSlider("gate-mag", () => applyAccelGate(), (v) => `${v.toFixed(0)}%`);
$("gate-recovery").addEventListener("change", applyAccelGate);

/**
 * 磁修正形态（完整 MARG vs 简化）：Mahony 与 Madgwick 同时切换。
 * 完整版用整条磁场向量 + 由测量本身构造的磁倾角补偿参考场；
 * 收益在磁场被交变干扰污染或硬铁未标定时最明显（自检 45 有量化对照）。
 */
function applyMagMode(): void {
  const mode = $<HTMLSelectElement>("mag-mode").value as "yaw" | "full";
  // 只改 A：B 的磁形态在快照时冻结（见 applyAccelGate 注释）。
  for (const e of ests) {
    if (e.id === "mahony" || e.id === "madg") {
      (e as MahonyEstimator | MadgwickEstimator).magMode = mode;
    }
  }
}
$("mag-mode").addEventListener("change", applyMagMode);

/** 卡尔曼野值门控形态：固定 40° 夹角（基线）或 χ² 马氏距离（按 P/R 自适应） */
function applyKalmanGate(): void {
  const mode = $<HTMLSelectElement>("kalman-gate").value as "angle" | "mahalanobis";
  // 只改 A：B 的门控形态在快照时冻结。
  for (const e of ests) {
    if (e.id === "kalman") (e as KalmanEstimator).gateMode = mode;
  }
}
$("kalman-gate").addEventListener("change", applyKalmanGate);

// ---------- 解算频率（降采样：仿真仍 500 Hz，算法按 N 分之一节拍更新） ----------
/**
 * 真实飞控的解算节拍与传感器采样率常常不同（传感器 1 kHz、姿态环 250 Hz…）。
 * 这里让仿真保持 500 Hz 定步长不动，只把**估计器更新**按选定频率抽帧：
 * 每 accumulate 到 1/f 秒才调用一次 update，dt = 累积的真实时长。
 * 于是低解算频率下可以直观看到「指数积分精度」「高速机动跟踪损失」两件事。
 */
const solveState = { hz: 500, acc: 0 };
$("solve-rate").addEventListener("change", () => {
  // 下限守卫：hz = 0 会让主循环里的 step = 1/hz = Infinity → 估计器**永远不再更新**
  // （真值还在动、误差曲线一路涨，界面上却毫无报错，只有下拉框空白）。深链写入非法值时踩到过。
  const hz = Number($<HTMLSelectElement>("solve-rate").value);
  solveState.hz = Number.isFinite(hz) && hz >= 1 ? hz : 500;
  solveLoop.setSolveRate(solveState.hz);
  resetSim();
});


// ---------- 万向节锁演示（独立于主仿真） ----------
const gimState = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

function applyGimbalAngles(): void {
  // 目标角度交给阻尼跟随（主循环里 step），拖动滑块/演示播放都是「追上去」而不是瞬跳
  sceneHandles.gimbal.setTargetAngles(gimState.rollDeg * RAD, gimState.pitchDeg * RAD, gimState.yawDeg * RAD);
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

function quatText(q: Quat, digits = 3): string {
  return `[${fixedList([q.w, q.x, q.y, q.z], digits)}]`;
}

function applyQuatInterpolation(
  pair: { from: [number, number, number]; to: [number, number, number]; path?: Array<[number, number, number]> },
  t: number,
): void {
  // setPair 内部按姿态对做缓存：同一对只重建一次几何，播放时每帧只移动 marker
  sceneHandles.quatView.setPair(pair.from, pair.to, pair.path);
  sceneHandles.quatView.setProgress(t);
  const k = Math.PI / 180;
  const cur = quatStateCurrentEulerDeg(pair, t);
  sceneHandles.quatView.setNegation(cur[0] / k, cur[1] / k, cur[2] / k);
  const q = qSlerp(
    qFromEuler(pair.from[0] * k, pair.from[1] * k, pair.from[2] * k),
    qFromEuler(pair.to[0] * k, pair.to[1] * k, pair.to[2] * k),
    t,
  );
  $("quat-readout").textContent = quatText(q);
  // 面板读数：两条路径的总转角与中点分叉
  const info = sceneHandles.quatView.arcInfo();
  const el = document.getElementById("quat-arcinfo");
  if (el) {
    el.innerHTML =
      `<span>端点转角 <b>${info.slerpDeg.toFixed(1)}°</b></span>` +
      `<span>欧拉路径累计 <b>${info.eulerDeg.toFixed(1)}°</b></span>` +
      `<span>中点分叉 <b class="${info.deviationDeg > 5 ? "warn" : ""}">${info.deviationDeg.toFixed(1)}°</b></span>`;
  }
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
  if (state.view === "quat") enterQuatScene(on ? "neg" : "interp");
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
const quatFades = new Map<Group, { k: number; target: number }>();
const QUAT_FADE_SEC = 0.4;

/** 首次触碰时记录每个材质的基准透明度，淡入淡出后可精确还原 */
function prepQuatMats(g: Group): void {
  g.traverse((o) => {
    const mats = (o as Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mm = m as Material & { opacity: number; transparent: boolean };
      if (mm.userData.__quatBaseOp === undefined) {
        mm.userData.__quatBaseOp = mm.opacity;
        mm.userData.__quatBaseTr = mm.transparent;
      }
    }
  });
}

function quatGroupFade(g: Group, show: boolean): void {
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

function applyQuatFade(g: Group, k: number, done: boolean): void {
  const ease = k * k * (3 - 2 * k);
  g.scale.setScalar(0.93 + 0.07 * ease);
  g.traverse((o) => {
    const mats = (o as Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const mm = m as Material & { opacity: number; transparent: boolean };
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

/** 四元数视图三个演示组的互斥切换（带过渡 + 模式级相机推拉） */
const quatCamTween = {
  active: false,
  t: 0,
  fromPos: new Vector3(), toPos: new Vector3(),
  fromTgt: new Vector3(), toTgt: new Vector3(),
};
const QUAT_FRAMING = {
  // 四元数视图：球半径 0.85 + 两侧姿态展示位 ±1.12，相机要能同时装下
  interp: { pos: [0, 1.75, 3.75], tgt: [0, 0.95, 0] },
  // 投影模式：球缩小+姿态舞台在下方，−q 最远 3×0.62≈1.86 —— 相机稍远、目标略低
  proj: { pos: [0, 1.55, 3.75], tgt: [0, 0.78, 0] },
} as const;
function startQuatCamTween(mode: "interp" | "proj"): void {
  const f = QUAT_FRAMING[mode];
  quatCamTween.fromPos.copy(sceneHandles.camera.position);
  quatCamTween.fromTgt.copy(sceneHandles.controls.target);
  quatCamTween.toPos.set(f.pos[0], f.pos[1], f.pos[2]);
  quatCamTween.toTgt.set(f.tgt[0], f.tgt[1], f.tgt[2]);
  quatCamTween.t = 0;
  quatCamTween.active = true;
}
function stepQuatCamTween(dt: number): void {
  const c = quatCamTween;
  if (!c.active) return;
  c.t = Math.min(1, c.t + dt / 0.55);
  const k = c.t * c.t * (3 - 2 * c.t);
  sceneHandles.camera.position.lerpVectors(c.fromPos, c.toPos, k);
  sceneHandles.controls.target.lerpVectors(c.fromTgt, c.toTgt, k);
  sceneHandles.controls.update();
  if (c.t >= 1) c.active = false;
}
function enterQuatScene(which: "interp" | "neg" | "proj"): void {
  const parts = sceneHandles.quatView.parts;
  quatGroupFade(parts.interpGroup, which === "interp");
  quatGroupFade(parts.negGroup, which === "neg");
  quatGroupFade(parts.projGroup, which === "proj");
  sceneHandles.quatView.parts.sphere.visible = false; // 可见性交给 interpGroup 级淡入淡出
  startQuatCamTween(which === "proj" ? "proj" : "interp");
}

// ---------- 4D 立体投影模式 ----------
const projState = {
  q: qId() as Quat,
  /** 当前画面上实际显示的 q（动画中途连按时从这里无缝续接，不跳变） */
  current: qId() as Quat,
  anim: null as null | { from: Quat; to: Quat; t: number; dur: number; reset?: boolean },
  /** 已左乘 i/j/k 的次数（重置清零）：每按一次 = 绕基轴 180°，读数把它折算成累计转角 */
  presses: 0,
};
const PROJ_I: Quat = { w: 0, x: 1, y: 0, z: 0 };
const PROJ_J: Quat = { w: 0, x: 0, y: 1, z: 0 };
const PROJ_K: Quat = { w: 0, x: 0, y: 0, z: 1 };

/**
 * 累计旋转读数：本模式下 q 只会被左乘 i/j/k 改变，从单位姿态出发必然落在
 * {±1, ±i, ±j, ±k} 八点上。按主导分量归类并给出「哪张皮」的解说——
 * 连按同一按钮两次（累计 360°）3D 姿态复原而 q 变号、四次（720°）才真正回 +1，
 * 双重覆盖从结论句变成随按钮实时刷新的数字。
 */
function updateProjTurn(q: Quat): void {
  const el = document.getElementById("proj-turn");
  if (!el) return;
  const { w, x, y, z } = q;
  const aw = Math.abs(w), ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const max = Math.max(aw, ax, ay, az);
  let name: string, note: string;
  if (max === aw) {
    name = w >= 0 ? "+1" : "−1";
    note = w >= 0
      ? "单位姿态（0° 或 720°：两张皮在此重合）"
      : "累计 360°：3D 姿态已复原，q 却变号——转一圈 ≠ 没转";
  } else {
    const axis: [string, number] = max === ax ? ["i", x] : max === ay ? ["j", y] : ["k", z];
    name = (axis[1] >= 0 ? "+" : "−") + axis[0];
    note = `物理 = 绕 ${axis[0]} 轴转 180°（S³ 赤道，${axis[1] >= 0 ? "第一" : "第二"}张皮）`;
  }
  el.textContent = `已左乘 ${projState.presses} 次 · 累计 ${projState.presses * 180}° · q = ${name}（${note}）`;
  drawProjSection(q);
}

/**
 * S³ 剖面 inset：把 q 画进「包含 +1 与 q 的大圆平面」——立体投影的「抬升」视角。
 *
 * 为什么不用固定的 w–i 平面：固定的两个坐标轴只在 q 的向量部分平行于 i 时才好看，
 * 一旦 q = j 或 k（左乘按钮的常态），q 的 w、x 分量同时为 0，q 与 −q 双双塌到圆心，
 * 剖面失去信息。改成「1 与 q 张成的平面」后，任何 q 都落在圆周上：
 * 横轴恒为 +1/−1，纵轴是 q 的虚部方向，q 的极角就是**半角 θ**（物理转角的一半）——
 * 「纬度 = 半角」这句话因此在图上直接可见。
 */
function drawProjSection(q: Quat): void {
  const c = document.getElementById("proj-section") as HTMLCanvasElement | null;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const { w: W, h: H } = fitInsetCanvas(c, 2, 300);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W / 2 - 34, H / 2 - 20);
  if (R < 12) return;

  // 半角 θ = atan2(‖vec q‖, w) ∈ [0, π]；q 在 (1, u) 基下的坐标即 (cosθ, sinθ)
  const vn = Math.hypot(q.x, q.y, q.z);
  const half = Math.atan2(vn, q.w);
  const P = (a: number, b: number): [number, number] => [cx + a * R, cy - b * R];

  // 单位圆（= S³ 与该平面的交线）：淡底 + 描边
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(34, 211, 238, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "#546a99";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 十字轴：横轴 = 实部方向（±1），纵轴 = q 的虚部方向
  ctx.strokeStyle = "#31415f";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - R - 10, cy);
  ctx.lineTo(cx + R + 10, cy);
  ctx.moveTo(cx, cy - R - 8);
  ctx.lineTo(cx, cy + R + 8);
  ctx.stroke();

  // 标签（等宽字体，与面板读数一致）
  ctx.font = '10.5px "Fira Code", Consolas, monospace';
  ctx.fillStyle = "#7b8aa3";
  ctx.textAlign = "center";
  const p1 = P(1, 0), pm1 = P(-1, 0), pv = P(0, 1), pmv = P(0, -1);
  ctx.fillText("+1", p1[0], p1[1] + 15);
  ctx.fillText("−1", pm1[0], pm1[1] + 15);
  ctx.fillText("vec(q)", pv[0], pv[1] - 5);
  ctx.fillText("−vec(q)", pmv[0], pmv[1] + 14);

  // 「抬升」弧：从 +1 沿单位圆到 q，弧长即半角
  if (half > 1e-3) {
    ctx.strokeStyle = "rgba(34, 211, 238, 0.6)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, -half, true); // canvas 的 +y 向下 → 传逆时针
    ctx.stroke();
  }

  // q 与 −q（对径点）+ 对径连线
  const qq = P(Math.cos(half), Math.sin(half));
  const qn = P(-Math.cos(half), -Math.sin(half));
  ctx.strokeStyle = "#31415f";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(qq[0], qq[1]);
  ctx.lineTo(qn[0], qn[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [p, col] of [[qq, "#22d3ee"], [qn, "#e879f9"]] as const) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 半角读数（左上角，等宽）：把「3D 姿态由半角决定」直接写成数字
  ctx.textAlign = "left";
  ctx.fillStyle = "#7b8aa3";
  ctx.fillText(`半角 θ = ${((half * 180) / Math.PI).toFixed(1)}°`, 4, 13);
  ctx.fillText(`转动 2θ = ${((2 * half * 180) / Math.PI).toFixed(1)}°`, 4, 26);
}

/** 沙盒快捷模式：一键配置「综合机动 + 中等污染 + 玻璃盒 + 初始偏差」的自由实验场 */
/** 通用控件写值：与用户操作走同一条 input/change 事件路径 */
function setSliderValue(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.value = String(value);
  el.dispatchEvent(new Event("input"));
}
function setSelectValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event("change"));
}
function setCheckValue(id: string, on: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.checked = on;
  el.dispatchEvent(new Event("change"));
}

function enterSandbox(): void {
  if (state.real) {
    toast("真实 IMU 模式下沙盒停用——先断开串口", "#f85149");
    return;
  }
  setSelectValue("scenario-select", "composite");
  setSelectValue("imu-preset", "custom");
  setSliderValue("imu-gyro-bias", 1);
  setSliderValue("imu-gyro-noise", 0.3);
  setSliderValue("imu-lin-accel", 2);
  setSliderValue("imu-vibration", 0.5);
  setSliderValue("imu-mag-disturb", 0.3);
  setCheckValue("mag-enable", true);
  setCheckValue("telemetry-toggle", true);
  setCheckValue("init-offset-toggle", true);
  setCheckValue("ab-toggle", true); // 沙盒里 A/B 快照 = 进入前的参数，随改随比
  setDocsOpen(false);
  applyView("attitude");
  resetSim();
  toast("沙盒模式已就绪：所有参数随便动，B 组虚线是进入时的参数快照");
}

// ---------- 实验库：一键复现一条因果链 ----------
/**
 * 实验基线：应用任一条实验前，先把「后来新增的」控件复位到默认，
 * 再让实验自己的声明覆盖。否则上一条实验留下的残留状态（比如 ±150°/s 量程、
 * 完整 MARG、25 ms 群延迟）会悄悄污染下一条实验的因果链——
 * 「一键复现」的可信度就靠这一步。（早期实验只声明自己关心的控件，基线保证一致性。）
 */
/** 控件在 HTML 里声明的初始值（实验基线的权威默认；select 用 defaultSelected 选项） */
const baselineDefaults = new WeakMap<HTMLElement, string | boolean>();
function baselineDefaultOf(el: HTMLInputElement | HTMLSelectElement): string | boolean {
  const cached = baselineDefaults.get(el);
  if (cached !== undefined) return cached;
  let v: string | boolean;
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.defaultSelected) ?? el.options[0];
    v = opt?.value ?? "";
  } else if (el.type === "checkbox" || el.type === "radio") {
    v = el.defaultChecked;
  } else {
    v = el.defaultValue;
  }
  baselineDefaults.set(el, v);
  return v;
}

function resetExperimentBaseline(): void {
  const baselineSelector = [
    ".section-scenario input[type=range]",
    ".section-scenario select",
    ".section-imu input[type=range]",
    ".section-imu select",
    "#mag-mode",
    "#solve-rate",
    "#gate-deg",
    "#gate-mag",
    "#gate-recovery",
    "#kalman-gate",
    "#ab-mode",
    "#kalman-reset-cov",
    "#mag-enable",
    "#gate-toggle",
    "#init-offset-toggle",
    "#ab-toggle",
    "#loop-toggle",
  ].join(", ");
  const els = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(baselineSelector)];
  // 先写回默认值，再统一派发事件：避免中途事件回调互相看到半复位状态
  for (const el of els) {
    const d = baselineDefaultOf(el);
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      el.checked = Boolean(d);
    } else {
      el.value = String(d);
    }
  }
  for (const el of els) el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  // 复选框的语义监听器挂在 change 上；input 事件不会触发它们，这里补一次 change
  for (const el of els) {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

function applyExperiment(spec: ExperimentSpec): void {
  if (state.real) {
    toast("真实 IMU 模式下模拟参数已停用——先断开串口再运行实验", "#f85149");
    return;
  }
  // 顺序：基线复位 → 剧本 → 滑块 → 开关（A/B 快照需在参数就位后）→ 视图 → 重置
  const abWasOn = abState.on; // 基线会把 A/B 复位为关闭：必须明说，否则"参数对比中"的实验语义含混
  taskStripApi?.beginProgrammatic();
  try {
    resetExperimentBaseline();
    for (const [id, v] of Object.entries(spec.selects ?? {})) setSelectValue(id, v);
    for (const [id, v] of Object.entries(spec.sliders ?? {})) setSliderValue(id, v);
    for (const [id, v] of Object.entries(spec.checks ?? {})) setCheckValue(id, v);
    if (spec.view) applyView(spec.view);
    if (spec.reset !== false) resetSim();
  } finally {
    taskStripApi?.endProgrammatic();
  }
  const note = document.getElementById("experiment-note");
  if (note) {
    note.innerHTML =
      `<b>${spec.name}</b> · ${spec.tag}<br />${spec.observe}` +
      (abWasOn
        ? '<br /><span class="dim">本次基线把 A/B 对比关闭了（实验只声明单组参数）；要做单变量对比请重新勾选 A/B 并点「快照参数」。</span>'
        : "");
    note.classList.remove("hidden");
  }
  document.querySelectorAll<HTMLButtonElement>("#experiment-list button").forEach((b) => {
    b.classList.toggle("active", b.dataset.exp === spec.id);
  });
  setTaskContext({
    kind: "experiment",
    id: spec.id,
    title: `实验：${spec.name}`,
    conditions: `实验库基线 · 种子 ${experimentConfig.seed} · 场景 ${spec.selects?.["scenario-select"] ?? "沿用当前"}`,
    variable: "实验声明的参数组（不是单变量对照）",
    observe: spec.observe,
    next: "先看曲线与读数；要做因果对照，打开「单变量对照」冻结同一配置后只改一个变量。",
    allowedIds: [
      ...Object.keys(spec.sliders ?? {}),
      ...Object.keys(spec.checks ?? {}),
      ...Object.keys(spec.selects ?? {}),
    ],
  });
  toast(`实验已就位：${spec.name}`);
}

/**
 * 实验库／挑战目录：从 public/data/*.json 读取，不再把纯数据打进 JS 包。
 *
 * 数据仍由 TS 源（ui/experiments.ts、ui/challenges.ts、scripts/emit-catalog.ts 里的
 * TOUR_STEPS）维护，`npm run catalog` 生成确定性 JSON。这里只做最小校验：
 * 顶层必须是数组、id 为非空字符串且唯一、必填字段类型正确。任何失败只影响对应面板，
 * 不向主循环抛出——console.warn + toast，页面其余部分照常可交互。
 */
let EXPERIMENTS: readonly ExperimentSpec[] = [];
let CHALLENGES: readonly ChallengeSpec[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogRows(raw: unknown, file: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${file}: 顶层必须是数组`);
  return raw;
}

function checkId(item: Record<string, unknown>, ids: Set<string>, where: string): void {
  if (typeof item.id !== "string" || item.id.length === 0) throw new Error(`${where}.id 必须是非空字符串`);
  if (ids.has(item.id)) throw new Error(`${where}: id 重复（${item.id}）`);
  ids.add(item.id);
}

function requireStrings(item: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of keys) {
    if (typeof item[key] !== "string" || item[key].length === 0) {
      throw new Error(`${where}.${key} 必须是非空字符串`);
    }
  }
}

function parseExperimentCatalog(raw: unknown): ExperimentSpec[] {
  const ids = new Set<string>();
  return catalogRows(raw, "experiments.json").map((item, i) => {
    const where = `experiments.json[${i}]`;
    if (!isRecord(item)) throw new Error(`${where}: 必须是对象`);
    checkId(item, ids, where);
    requireStrings(item, ["name", "tag", "observe"], where);
    return item as unknown as ExperimentSpec;
  });
}

function parseChallengeCatalog(raw: unknown): ChallengeSpec[] {
  const ids = new Set<string>();
  return catalogRows(raw, "challenges.json").map((item, i) => {
    const where = `challenges.json[${i}]`;
    if (!isRecord(item)) throw new Error(`${where}: 必须是对象`);
    checkId(item, ids, where);
    requireStrings(item, ["name", "scene", "goal", "hint"], where);
    const grade = item.grade;
    if (
      !isRecord(grade) ||
      typeof grade.est !== "string" ||
      !["comp", "mahony", "madg", "kalman"].includes(grade.est) ||
      typeof grade.limit !== "number" ||
      !Number.isFinite(grade.limit)
    ) {
      throw new Error(`${where}.grade 必须是 { est, limit } 评分口径`);
    }
    return item as unknown as ChallengeSpec;
  });
}

function parseTourCatalog(raw: unknown): TourStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("tour.json: 顶层必须是非空数组");
  const ids = new Set<string>();
  return raw.map((item, i) => {
    const where = `tour.json[${i}]`;
    if (!isRecord(item)) throw new Error(`${where}: 必须是对象`);
    checkId(item, ids, where);
    requireStrings(item, ["title", "body", "look"], where);
    if (typeof item.sec !== "number" || !Number.isFinite(item.sec) || item.sec <= 0) {
      throw new Error(`${where}.sec 必须是正数`);
    }
    return item as unknown as TourStep;
  });
}

async function fetchCatalog<T>(file: string, parse: (raw: unknown) => T[]): Promise<T[]> {
  const url = new URL(`data/${file}`, document.baseURI).href;
  // no-cache：拿到最新目录；离线时由 Service Worker 的 CORE 缓存兜底。
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return parse(await res.json());
}

const catalogsReadyPromise: Promise<void> = (async () => {
  const [experiments, challenges] = await Promise.allSettled([
    fetchCatalog("experiments.json", parseExperimentCatalog),
    fetchCatalog("challenges.json", parseChallengeCatalog),
  ]);
  const errors: string[] = [];
  if (experiments.status === "fulfilled") {
    EXPERIMENTS = experiments.value;
  } else {
    errors.push(errorText(experiments.reason));
    console.warn("实验库加载失败：", experiments.reason);
  }
  if (challenges.status === "fulfilled") {
    CHALLENGES = challenges.value;
  } else {
    errors.push(errorText(challenges.reason));
    console.warn("挑战目录加载失败：", challenges.reason);
  }
  // 无论成功失败都算「已尝试」：applyExperimentById 不会对已失败的目录无限重试。
  buildExperimentList();
  buildChallengeList();
  updateChallengeUi();
  if (errors.length) toast(`实验库/挑战目录加载失败：${errors.join("；")}`, "#f85149");
})().catch((err: unknown) => {
  console.warn("实验库/挑战目录初始化失败：", err);
  toast(`实验库/挑战目录初始化失败：${errorText(err)}`, "#f85149");
});

function buildExperimentList(): void {
  const list = document.getElementById("experiment-list");
  if (!list) return;
  list.innerHTML = "";
  for (const spec of EXPERIMENTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "exp-chip";
    btn.dataset.exp = spec.id;
    btn.innerHTML = `<span class="exp-name">${spec.name}</span><span class="exp-tag">${spec.tag}</span>`;
    btn.addEventListener("click", () => applyExperiment(spec));
    list.appendChild(btn);
  }
}
$("btn-sandbox").addEventListener("click", () => enterSandbox());

// ---------- 参数整定挑战（评分读的是「本轮评测」同一个 ErrorTracker） ----------
/** 把提示文本里的换行转成 <br />（写成函数是因为在 shell 里拼正则转义容易被吞） */
function nlToBr(text: string): string {
  return text.split(String.fromCharCode(10)).join("<br />");
}

/** 每道题的进度：装载时刻 + 是否已通过（会话内有效，重置仿真不清零） */
const challengeState = new Map<string, { startedAt: number; passed: boolean }>();

/** 评分需要足够样本，否则「刚点开始就结算」也能过 */
const CHALLENGE_MIN_SAMPLES = 375; // 25 Hz × 15 s

function challengeEstIndex(id: string): number {
  return ests.findIndex((e) => e.id === id);
}

/** 一键装载现场（复用实验库那套 setter 与基线复位，保证可复现） */
function startChallenge(c: ChallengeSpec): void {
  if (state.real) {
    toast("真实 IMU / 回放模式下挑战停用——那时没有真值，评分口径不成立", "#f85149");
    return;
  }
  const abWasOn = abState.on; // 基线会关闭 A/B：挑战评分读的是 A 组「本轮评测」，必须说清
  taskStripApi?.beginProgrammatic();
  try {
    resetExperimentBaseline();
    for (const [id, v] of Object.entries(c.selects ?? {})) setSelectValue(id, v);
    for (const [id, v] of Object.entries(c.sliders ?? {})) setSliderValue(id, v);
    for (const [id, v] of Object.entries(c.checks ?? {})) setCheckValue(id, v);
    resetSim();
  } finally {
    taskStripApi?.endProgrammatic();
  }
  challengeState.set(c.id, { startedAt: state.simTime, passed: challengeState.get(c.id)?.passed ?? false });
  const note = document.getElementById("challenge-note");
  if (note) {
    note.classList.remove("hidden");
    note.innerHTML =
      `<b>${c.name}</b> · ${c.goal}<br />` +
      `<span class="dim">现场：</span>${c.scene}<br />` +
      `<span class="dim">提示：</span>${nlToBr(c.hint)}<br />` +
      `<span class="dim">跑够 15 秒后点「结算」。</span>` +
      (abWasOn
        ? '<br /><span class="dim">本次装载关闭了 A/B 对比（评分只看 A 组「本轮评测」）。</span>'
        : "");
  }
  setTaskContext({
    kind: "challenge",
    id: c.id,
    title: `挑战：${c.name}`,
    conditions: c.scene,
    variable: "把面板参数调到目标阈值以内（题目不指定唯一路径）",
    observe: `${c.goal}；至少积累 15 秒样本后才允许结算。`,
    next: "调参 → 看误差曲线与当前 RMSE → 跑够 15 秒后点「结算」。",
    allowedIds: [
      ...Object.keys(c.sliders ?? {}),
      ...Object.keys(c.checks ?? {}),
      ...Object.keys(c.selects ?? {}),
    ],
  });
  toast(`挑战已装载：${c.name} —— 调参数，跑够 15 秒后结算`);
}

/** 结算：读该算法的 RMSE，与阈值比较 */
function settleChallenge(c: ChallengeSpec): void {
  const idx = challengeEstIndex(c.grade.est);
  const sum = metricsA[idx]?.summary();
  const label = ests[idx]?.label ?? c.grade.est;
  if (state.real) {
    toast("真实模式没有真值基准，挑战评分不适用", "#f85149");
    return;
  }
  if (!sum || sum.n < CHALLENGE_MIN_SAMPLES) {
    toast(`样本不够（${sum?.n ?? 0} / ${CHALLENGE_MIN_SAMPLES}）——让仿真跑够 15 秒再结算`, "#fbbf24");
    return;
  }
  const passed = sum.rmse <= c.grade.limit;
  const rec = challengeState.get(c.id) ?? { startedAt: 0, passed: false };
  challengeState.set(c.id, { ...rec, passed: rec.passed || passed });
  const note = document.getElementById("challenge-note");
  if (note) {
    note.classList.remove("hidden");
    note.innerHTML =
      `<b>${c.name}</b> 结算：${label} RMSE <span class="mono">${sum.rmse.toFixed(2)}°</span> / 阈值 ` +
      `<span class="mono">${c.grade.limit.toFixed(2)}°</span> ` +
      (passed ? `<b style="color:#7ee787">通过 ✅</b>` : `<b style="color:#fbbf24">未达标</b>（差 ${(sum.rmse - c.grade.limit).toFixed(2)}°）`) +
      `<br /><span class="dim">提示：</span>${nlToBr(c.hint)}`;
  }
  updateChallengeUi();
  toast(passed ? `通过：${c.name}（RMSE ${sum.rmse.toFixed(2)}°）` : `未达标：RMSE ${sum.rmse.toFixed(2)}° > ${c.grade.limit}°`, passed ? "#7ee787" : "#fbbf24");
}

function updateChallengeUi(): void {
  const passed = CHALLENGES.filter((c) => challengeState.get(c.id)?.passed).length;
  const sum = document.getElementById("sum-challenge");
  if (sum) sum.textContent = `${passed} / ${CHALLENGES.length} 通过`;
  // 每道题旁边实时显示当前 RMSE，省得来回看评测表
  for (const c of CHALLENGES) {
    const el = document.getElementById(`ch-live-${c.id}`);
    if (!el) continue;
    const s = metricsA[challengeEstIndex(c.grade.est)]?.summary();
    el.textContent = s && s.n > 0 ? `现在 ${s.rmse.toFixed(2)}° / 目标 ${c.grade.limit}°` : "尚未采集样本";
    el.classList.toggle("ok", Boolean(s && s.n >= CHALLENGE_MIN_SAMPLES && s.rmse <= c.grade.limit));
  }
}

function buildChallengeList(): void {
  const host = document.getElementById("challenge-list");
  if (!host) return;
  host.innerHTML = CHALLENGES.map(
    (c) =>
      `<div class="ch-item" data-ch="${c.id}">` +
      `<div class="ch-head"><b>${c.name}</b><span class="ch-live mono" id="ch-live-${c.id}">尚未采集样本</span></div>` +
      `<div class="ch-goal">${c.goal}</div>` +
      `<div class="ch-scene dim">${c.scene}</div>` +
      `<div class="row btn-row"><button type="button" class="btn" data-act="start" data-ch="${c.id}">开始</button>` +
      `<button type="button" class="btn primary" data-act="settle" data-ch="${c.id}">结算</button></div>` +
      `</div>`,
  ).join("");
}
document.getElementById("challenge-list")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-ch]");
  if (!btn) return;
  const c = CHALLENGES.find((x) => x.id === btn.dataset.ch);
  if (!c) return;
  if (btn.dataset.act === "start") startChallenge(c);
  else settleChallenge(c);
});

// ---------- 磁力计校准面板 ----------
/** 用当前模拟磁模型生成覆盖全姿态的样本（含硬铁/干扰/噪声/量化） */
function syntheticCalibrationSamples(n = 280): V3[] {
  const g = new Gauss(mulberry32(0xc0ffee));
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    // 四维高斯归一化 = 均匀分布于 SO(3)（单位四元数按 Haar 测度）
    const q = qNorm({ w: g.next(), x: g.next(), y: g.next(), z: g.next() });
    const t = (i / n) * 23.7; // 覆盖若干交变干扰周期
    out.push(simulateMag(q, t, imuParams, g));
  }
  return out;
}

/**
 * 校准面板的**渲染计划**（SW-03）。
 *
 * 为什么要有"计划"这一层：`innerHTML = ...` 是面板更新里唯一会**解析 HTML、可能抛异常**的步骤。
 * 档案导入必须在**写任何状态之前**把它做完（在脱离文档的元素上解析），于是渲染失败时现场一个字节都没动；
 * 提交阶段只剩 `replaceChildren(已解析好的节点)` 与属性赋值，不再有可失败的解析。
 * 计划的输入是**显式状态描述**而不是活全局：这样才能为"导入前 / 导入后 / 提交后"三份现场各算一份。
 */
interface MagPanelPlan {
  status: string;
  result: Node[];
  applyDisabled: boolean;
  applyChecked: boolean;
  startLabel: string;
  synthDisabled: boolean;
}
interface AccelPanelPlan {
  status: string;
  result: Node[];
  applyDisabled: boolean;
  applyChecked: boolean;
}
interface CalUiDesc {
  mag: {
    cal: MagCalibration | null; applied: boolean; collecting: boolean; sampleCount: number;
    verifyLine: string; message: string;
    history: Array<{ id: number; atText: string; model: "diag" | "full"; sampleCount: number; residual: number; lateResidual: number | null; active: boolean }>;
  };
  accel: { cal: AccelCalibration | null; applied: boolean; sampleCount: number; verifyLine: string; message: string };
  model: MagCalModel;
  /** 器件参数（决定「标定基于旧模型」提示）：档案导入会改它，所以必须显式传入 */
  imu: ImuParams;
  real: boolean;
}

/** 活状态 → 渲染描述（只读；不触发任何 DOM 写入） */
function calUiDesc(): CalUiDesc {
  return {
    mag: {
      cal: magCalState.cal,
      applied: magCalState.applied,
      collecting: magCalState.collecting,
      sampleCount: magCalState.samples.length,
      verifyLine: magCalState.verifyLine,
      message: magCalState.message,
      history: magCalHistory.map((h) => ({
        id: h.id, atText: h.atText, model: h.model, sampleCount: h.sampleCount,
        residual: h.residual, lateResidual: h.lateResidual,
        // 用历史条目 id 判「当前」：快照是深拷贝，按引用比较永远不相等（冒烟实测 5 条全带恢复按钮）
        active: h.id === activeMagCalHistoryId,
      })),
    },
    accel: {
      cal: accelCalState.cal,
      applied: accelCalState.applied,
      sampleCount: accelCalState.samples.length,
      verifyLine: accelCalState.verifyLine,
      message: accelCalState.message,
    },
    model: currentMagCalModel(),
    imu: { ...imuParams },
    real: state.real,
  };
}

/** 解析一段 HTML 成脱离文档的节点数组（在 prepare 阶段调用；这是唯一可能抛错的步骤） */
function nodesOfHtml(html: string): Node[] {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return [...holder.childNodes];
}

function planMagPanel(d: CalUiDesc): MagPanelPlan {
  const stale = calibrationStaleness(d.mag.cal?.fittedWith, d.imu, "mag", d.model);
  const result = nodesOfHtml(magResultHtml(d.mag.cal, d.mag.verifyLine, stale) + magHistoryHtml(d.mag.history));
  const base = magStatusText({
    cal: d.mag.cal, applied: d.mag.applied, collecting: d.mag.collecting,
    sampleCount: d.mag.sampleCount, message: "", verifyLine: d.mag.verifyLine, target: MAG_CAL_TARGET,
  });
  return {
    status: d.mag.message || base,
    result,
    applyDisabled: d.mag.cal === null,
    applyChecked: d.mag.applied && d.mag.cal !== null,
    startLabel: d.mag.collecting ? "停止采集" : "开始实时采集",
    synthDisabled: d.real,
  };
}

function planAccelPanel(d: CalUiDesc): AccelPanelPlan {
  const stale = calibrationStaleness(d.accel.cal?.fittedWith, d.imu, "accel");
  return {
    status: accelStatusText({
      cal: d.accel.cal, applied: d.accel.applied, sampleCount: d.accel.sampleCount,
      message: d.accel.message, verifyLine: d.accel.verifyLine, windowSeconds: ACCEL_CAL_SECONDS,
    }),
    result: nodesOfHtml(accelResultHtml(d.accel.cal, d.accel.verifyLine, stale)),
    applyDisabled: d.accel.cal === null,
    applyChecked: d.accel.applied && d.accel.cal !== null,
  };
}

type CalPanelCommonPlan = Pick<MagPanelPlan, "status" | "result" | "applyDisabled" | "applyChecked">;
/** 应用计划：只有赋值与节点搬移，没有 HTML 解析 */
function applyCalPanel(kind: "mag" | "accel", p: CalPanelCommonPlan): void {
  const status = document.getElementById(`${kind}cal-status`);
  const result = document.getElementById(`${kind}cal-result`);
  if (status) status.textContent = p.status;
  if (result) result.replaceChildren(...p.result);
  const apply = document.getElementById(`${kind}cal-apply`) as HTMLInputElement | null;
  if (apply) { apply.disabled = p.applyDisabled; apply.checked = p.applyChecked; }
}

function applyMagPanel(p: MagPanelPlan): void {
  applyCalPanel("mag", p);
  const start = document.getElementById("magcal-start") as HTMLButtonElement | null;
  if (start) start.textContent = p.startLabel;
  const synth = document.getElementById("magcal-synthetic") as HTMLButtonElement | null;
  if (synth) synth.disabled = p.synthDisabled;
}

function applyAccelPanel(p: AccelPanelPlan): void {
  applyCalPanel("accel", p);
}

function updateMagCalUi(): void {
  applyMagPanel(planMagPanel(calUiDesc()));
  magCalState.message = ""; // 提示消费掉（与旧实现一致：显示一次即清）
}

function magCalFit(): void {
  const model = ($<HTMLSelectElement>("magcal-model"))?.value === "full" ? "full" : "diag";
  // 拟合集/验证集分离：75% 点拟合、25% 点验证（验证残差与拟合残差一起显示，防止"自评自"）
  const cal = calibrateMagWithValidation(magCalState.samples, model, 4);
  if (!cal) {
    magCalState.message =
      `拟合失败（${model === "full" ? "完整椭球" : "对角"}）：样本 ${magCalState.samples.length} 点，覆盖度不足或数值退化——` +
      "请让三轴都转动起来（只绕一个轴转，球心在那两个方向不可观）";
    updateMagCalUi();
    return;
  }
  cal.fittedWith = fingerprintOf(imuParams, model, new Date(), 50); // 记录拟合时磁模型与当前磁/加计参数（完整椭球默认目标场强 50 μT）
  // 拟合与导入必须同一把尺子：生产拟合能产出 offset 20000 的模型，旧实现直接应用，
  // 但同一模型写进档案后会被解析器拒绝——"标定成功、却存不下来"。
  // 现在在提交前用同一个合法性函数判定，失败就明说，而不是先应用再在导出时暴雷。
  const problems = magCalibrationProblems(cal);
  if (problems.length) {
    magCalState.message =
      `拟合结果无法应用：${problems[0].path} ${problems[0].message}——` +
      "多半是采样点远离球心（强磁干扰）或覆盖不足；请换位置重新采集";
    updateMagCalUi();
    return;
  }
  magCalState.cal = cal;
  pushMagCalHistory(cal, model);
  magCalState.applied = true;
  magCalState.collecting = false; // 拟合完成即停止采集，状态行切到「已应用」
  magCalState.verifyLine = ""; // 换了一份标定，旧的验证结论失效
  updateMagCalUi();
  toast(
    `磁校准完成（${model === "full" ? "完整 3×3" : "对角"}）：硬铁 |b| = ${Math.hypot(...cal.offset).toFixed(1)} μT，` +
      `残差 ${(cal.residual * 100).toFixed(1)}%`,
  );
}

document.getElementById("magcal-start")?.addEventListener("click", () => {
  magCalState.collecting = !magCalState.collecting;
  if (magCalState.collecting) {
    magCalState.samples.length = 0;
    magCalState.cal = null;
    magCalState.applied = false;
  }
  updateMagCalUi();
});
document.getElementById("magcal-synthetic")?.addEventListener("click", () => {
  magCalState.samples = syntheticCalibrationSamples();
  magCalState.collecting = false;
  magCalState.cal = null;
  magCalState.applied = false;
  magCalFit();
});
document.getElementById("magcal-fit")?.addEventListener("click", () => magCalFit());

/**
 * 独立验证磁校准：**换一组新样本**（不同随机种子、独立姿态），
 * 用真值姿态量出「标定前后磁航向误差」。它检验的是实际后果（航向偏多少），
 * 而不是拟合残差——残差小但方向偏的情况只有这一步能看出来。
 */
function verifyMagCal(): void {
  const result = document.getElementById("magcal-result");
  if (state.real) {
    toast("独立验证需要真值姿态：真实/回放模式下无法给出航向误差（只能看残差与点云覆盖）", "#fbbf24");
    return;
  }
  if (!magCalState.cal) {
    toast("先拟合出一份校准，再独立验证", "#fbbf24");
    return;
  }
  // 独立采样：与拟合样本不同的高斯种子 + 不同姿态序列
  const g = new Gauss(mulberry32(0x5a17c0de));
  const points: Array<{ qTrue: Quat; magRaw: V3 }> = [];
  for (let i = 0; i < 140; i++) {
    const q = qNorm({ w: g.next(), x: g.next(), y: g.next(), z: g.next() });
    points.push({ qTrue: q, magRaw: simulateMag(q, i * 0.37, imuParams, g) });
  }
  const v = verifyMagCalibration(magCalState.cal, points, MAG_WORLD_NED);
  const line = magVerifyLineHtml(v, MAG_WORLD_NED);
  magCalState.verifyLine = line;
  if (result) result.innerHTML += line;
  // 三种结论要分开说：有效 / 改善有限（点云覆盖或模型选错）/ 本就无需校准
  const verdict =
    v.afterMeanDeg < v.beforeMeanDeg * 0.5
      ? "（校准有效）"
      : v.afterMeanDeg <= v.beforeMeanDeg
        ? "（改善有限：检查点云覆盖与拟合模型选择）"
        : "（未见改善：这批数据本身可能就没有硬铁/软铁畸变，校准只会引入新的小误差）";
  toast(
    `磁校准独立验证：平均航向误差 ${v.beforeMeanDeg.toFixed(2)}° → ${v.afterMeanDeg.toFixed(2)}°` + verdict,
    v.afterMeanDeg < v.beforeMeanDeg * 0.5 ? "#7ee787" : "#fbbf24",
  );
}
document.getElementById("magcal-verify")?.addEventListener("click", verifyMagCal);
// 历史快照恢复（事件委托：列表是每次刷新重建的）
document.getElementById("magcal-result")?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-cal-restore]");
  if (!btn) return;
  const id = Number(btn.dataset.calRestore);
  const entry = magCalHistory.find((h) => h.id === id);
  if (!entry) return;
  // 恢复的是「当时那份标定」：模型下拉也切回它拟合时的模型，否则界面与对象不一致。
  // 深克隆：历史条目是只读快照，不能与应用中的对象共享引用（否则后续编辑会改到历史）。
  const restored = cloneMagCalibration(entry.cal);
  setSelectValue("magcal-model", entry.model);
  // 采集状态一并复位：否则「恢复历史」后仍在采集中，界面与数据流互相矛盾
  magCalState.collecting = false;
  magCalState.samples = [];
  magCalState.message = "";
  magCalState.cal = restored;
  activeMagCalHistoryId = entry.id;
  magCalState.applied = true;
  magCalState.verifyLine = "";
  updateMagCalUi();
  toast(`已恢复 ${entry.atText} 的标定（${entry.model === "full" ? "完整椭球" : "对角"}，残差 ${(entry.residual * 100).toFixed(2)}%）`, "#7ee787");
});

/* ---------- 加速度计六面校准 UI ---------- */
function updateAccelCalUi(): void {
  applyAccelPanel(planAccelPanel(calUiDesc()));
  accelCalState.message = ""; // 提示消费掉（与旧实现一致）
}
function fitAccelCal(): void {
  const cal = calibrateAccel(accelCalState.samples);
  if (!cal) {
    accelCalState.message =
      `拟合失败：已记录 ${accelCalState.samples.length} 面（至少 4 个不同朝向）——六个面都记录后重试`;
    updateAccelCalUi();
    return;
  }
  // 留一朝向验证：没参与拟合的那个朝向预测得准不准
  cal.validation = validateAccelCalibration(accelCalState.samples);
  cal.fittedWith = fingerprintOf(imuParams);
  accelCalState.cal = cal;
  accelCalState.verifyLine = ""; // 换了一份标定，旧的验证结论失效
  accelCalState.applied = true;
  updateAccelCalUi();
  toast(
    `加速度计六面校准完成：残差 RMS ${Math.max(...cal.rmse).toFixed(4)} m/s²` +
      (cal.validation ? `，留一验证 ${cal.validation.meanNormErrMs2.toFixed(4)} m/s²` : "") +
      "（已应用）",
  );
}
for (const [id, face] of [
  ["accelcal-face-px", "+x"],
  ["accelcal-face-nx", "-x"],
  ["accelcal-face-py", "+y"],
  ["accelcal-face-ny", "-y"],
  ["accelcal-face-pz", "+z"],
  ["accelcal-face-nz", "-z"],
] as const) {
  document.getElementById(id)?.addEventListener("click", () => beginAccelCalFace(face));
}
document.getElementById("accelcal-fit")?.addEventListener("click", fitAccelCal);

/**
 * 独立验证加计校准：用**另一组噪声样本**（新种子，未参与拟合）核对六个朝向的模长是否都回到 g。
 * 拟合残差是"训练集上的表现"，这里问的是"新数据上还行不行"。
 */
function verifyAccelCal(): void {
  const result = document.getElementById("accelcal-result");
  if (!accelCalState.cal) {
    toast("先拟合并应用一份六面校准，再独立验证", "#fbbf24");
    return;
  }
  let fresh: AccelCalibrationSample[];
  if (state.real) {
    // 真实模式没有"合成新样本"的语义：用已采集的六面读数作为验证集（会与拟合集重叠，明确说明）
    fresh = accelCalState.samples;
    if (!fresh.length) {
      toast("真实模式下需要先采集六面读数", "#fbbf24");
      return;
    }
  } else {
    // 由 DOM-free 核心按当前器件模型生成，验证规则可在 Node 自检中独立验证。
    fresh = synthesizeAccelVerification(imuParams);
  }
  const v = verifyAccelCalibration(accelCalState.cal, fresh);
  const line = accelVerifyLineHtml(v, !state.real);
  accelCalState.verifyLine = line;
  if (result) result.innerHTML += line;
  const verdict = accelVerdict(v.beforeMeanMs2, v.afterMeanMs2);
  toast(
    `加计校准独立验证：模长偏离 ${v.beforeMeanMs2.toFixed(4)} → ${v.afterMeanMs2.toFixed(4)} m/s²` + verdict,
    v.afterMeanMs2 < v.beforeMeanMs2 * 0.5 ? "#7ee787" : "#fbbf24",
  );
}
document.getElementById("accelcal-verify")?.addEventListener("click", verifyAccelCal);
document.getElementById("accelcal-clear")?.addEventListener("click", () => {
  accelCalState.cal = null;
  accelCalState.applied = false;
  accelCalState.samples = [];
  accelCalState.window = [];
  accelCalState.pending = null;
  accelCalState.message = "";
  accelCalState.verifyLine = "";
  updateAccelCalUi();
  toast("已清除加速度计校准");
});
document.getElementById("accelcal-apply")?.addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on && !accelCalState.cal) {
    (e.target as HTMLInputElement).checked = false;
    return;
  }
  accelCalState.applied = on;
  updateAccelCalUi();
});
document.getElementById("magcal-apply")?.addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on && !magCalState.cal) {
    (e.target as HTMLInputElement).checked = false;
    return;
  }
  magCalState.applied = on;
  updateMagCalUi();
});
document.getElementById("magcal-clear")?.addEventListener("click", () => {
  magCalState.samples.length = 0;
  magCalState.cal = null;
  activeMagCalHistoryId = 0;
  magCalState.applied = false;
  magCalState.collecting = false;
  magCalState.verifyLine = "";
  updateMagCalUi();
});
updateMagCalUi();

function projApply(q: Quat): void {
  projState.current = { ...q };
  $("quat-readout").textContent = quatText(q);
  sceneHandles.quatView.setProjection(q);
  updateProjTurn(q);
}

function projAnimateTo(target: Quat, isReset = false): void {
  // 弦上的归一化插值（nlerp）：不取短路径，保证终点恰为目标四元数（连按两次精确到 −q）
  // 起点取「当前显示帧」——动画中途再按按钮时从画面位置无缝续接
  projState.anim = { from: { ...projState.current }, to: target, t: 0, dur: 0.7, reset: isReset };
}
/**
 * 连按的叠加基准：动画进行中取「目标链尾」（anim.to）而非 projState.q——
 * 后者只在动画完成时更新，快速连按（0.7s 内）会让第二次的目标仍基于旧值，
 * 导致「连按两次 = −q」落空、累计读数与实际姿态脱节。链尾叠加后每次按键
 * 恰好等于左乘一次基向量，presses 计数与 q 的实际累计严格一致。
 */
function projChainBase(): Quat {
  return projState.anim ? projState.anim.to : projState.q;
}
$("btn-proj-i").addEventListener("click", () => { projState.presses++; projAnimateTo(qMul(projChainBase(), PROJ_I)); });
$("btn-proj-j").addEventListener("click", () => { projState.presses++; projAnimateTo(qMul(projChainBase(), PROJ_J)); });
$("btn-proj-k").addEventListener("click", () => { projState.presses++; projAnimateTo(qMul(projChainBase(), PROJ_K)); });
$("btn-proj-reset").addEventListener("click", () => { projState.presses = 0; projAnimateTo(qId(), true); });

$("quat-mode").addEventListener("change", () => {
  const proj = ($("quat-mode") as HTMLSelectElement).value === "proj";
  document.body.dataset.quatMode = proj ? "proj" : "interp";
  document.querySelectorAll(".quat-interp-only").forEach((el) => el.classList.toggle("hidden", proj));
  $("quat-proj-group").classList.toggle("hidden", !proj);
  // 只有四元数视图当前可见时才动相机/淡入淡出（深链在后台切模式时不应打断姿态视图取景）
  if (state.view === "quat") enterQuatSelectedMode();
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
    projState.current = { ...a.to };
    projState.anim = null;
    projApply(a.to);
    if (a.reset) sceneHandles.quatView.clearProjectionTrails(); // 重置=干净画面：清空 q 与 −q 轨迹
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
      ? `两次操作得到的姿态完全相同（夹角 ${demoState.diffDeg.toFixed(3)}°）——横滚与偏航其实是同一个自由度`
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

/**
 * 模型显示名/颜色。切换数据源期间 state.source 可能指向一个**已不在 ests 里**的算法
 * （例如回放/真实模式会重建估计器集合），此时不能对 find() 的结果直接取属性：
 * 那会抛 TypeError 并把仿真步打断。回退到第一个可用算法，再不济用真实姿态。
 */
function sourceEstimator(): (typeof ests)[number] | undefined {
  return ests.find((e) => e.id === state.source);
}
function sourceLabel(): string {
  if (state.source === "truth") return "真实姿态";
  return sourceEstimator()?.label ?? ests[0]?.label ?? "真实姿态";
}
function sourceColor(): string {
  if (state.source === "truth") return "#e6edf3";
  return sourceEstimator()?.color ?? ests[0]?.color ?? "#e6edf3";
}
function updateSourceChip(): void {
  const chip = $("readout-source");
  chip.textContent = `模型显示：${sourceLabel()} · 数据源：${dataSourceLabel()}`;
  chip.style.color = sourceColor();
}

function syncSeg(containerId: string, dataKey: string, active: string): void {
  $(containerId)
    .querySelectorAll<HTMLButtonElement>(".seg-btn")
    .forEach((b) => {
      const on = b.dataset[dataKey] === active;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
}

/** 应用视图：显隐模型与面板、重置相机取景 */
function applyView(view: UiView): void {
  // 离开四元数视图时停掉插值播放：它在后台继续跑只会白烧 CPU，
  // 而且回来时进度已经偷偷走远（用户会以为「刚才是停着的」）
  if (state.view === "quat" && view !== "quat" && quatState.playing) {
    quatState.playing = false;
    $("btn-quat-play").textContent = "播放插值";
  }
  state.view = view;
  applyViewDom(view);
  sceneHandles.setView(view, ($("ghost-toggle") as HTMLInputElement).checked);
  syncSeg("view-seg", "view", view);
  if (view === "gimbal") updateGimbalUi();
  if (view === "quat") enterQuatSelectedMode();
}

/** 按当前下拉与 q/−q 开关进入同一套四元数演示，避免两处模式映射漂移。 */
function enterQuatSelectedMode(): void {
  if (($("quat-mode") as HTMLSelectElement).value === "proj") {
    enterQuatScene("proj");
    projApply(projState.q);
  } else {
    enterQuatScene(($("quat-neg-toggle") as HTMLInputElement).checked ? "neg" : "interp");
  }
}

/** 真实用户切换视图（F-05）：记录前后视图；程序化装载走 applyView，不记成用户动作。 */
function userSelectView(view: UiView): void {
  selectViewAction(view, state.view, applyView, (before, after) => diagnosticsApi?.userAction("view-change", `切换视图：${before}→${after}`, { view: before }, { view: after }));
}

/* ==========================================================================
   WebGL 上下文丢失 / 恢复
   --------------------------------------------------------------------------
   演示装置是「开着不动也一直跑」的常驻页面：GPU 驱动重置、系统休眠唤醒、开太多标签页
   被浏览器回收上下文，都会让 canvas 永久黑屏——而页面其它部分照常工作，用户只会觉得
   「3D 坏了」。three.js 允许我们 preventDefault 阻止默认的「上下文不可恢复」语义，
   再在 restored 时把视图重新同步一遍即可自愈。
   ========================================================================== */
const glRenderer = sceneHandles.renderer;
if (glRenderer) {
const glCanvas = glRenderer.domElement;
let glLostNotice: HTMLElement | null = null;
glCanvas.addEventListener(
  "webglcontextlost",
  (e) => {
    e.preventDefault(); // 允许后续恢复（不调用它就永远不会触发 contextrestored）
    if (glLostNotice) return;
    glLostNotice = document.createElement("div");
    glLostNotice.className = "ov-chip";
    glLostNotice.style.color = "#fbbf24";
    glLostNotice.textContent = "3D 视图的 GPU 上下文被系统回收了（驱动重置/休眠唤醒/标签页太多）——正在等待恢复，恢复后会自动重绘";
    (document.getElementById("toast-layer") ?? $("readout-overlay")).appendChild(glLostNotice);
  },
  false,
);
glCanvas.addEventListener(
  "webglcontextrestored",
  () => {
    glLostNotice?.remove();
    glLostNotice = null;
    // 重新同步尺寸与取景：场景图对象没变，但 drawing buffer 要按当前尺寸重建，
    // 视图可见性/相机也要重算一遍（与 setup.ts 里 ResizeObserver 用的是同一套调用）
    const w = glCanvas.clientWidth;
    const h = glCanvas.clientHeight;
    if (w > 0 && h > 0) {
      sceneHandles.camera.aspect = w / h;
      sceneHandles.camera.updateProjectionMatrix();
      glRenderer.setSize(w, h);
    }
    applyView(state.view);
    toast("3D 视图已恢复", "#7ee787");
  },
  false,
);
}

$("view-seg")
  .querySelectorAll<HTMLButtonElement>(".seg-btn")
  .forEach((btn) => btn.addEventListener("click", () => userSelectView(btn.dataset.view as UiView)));

scenarioSelect.addEventListener("change", () => {
  world.setScenario(scenarioSelect.value);
  $("manual-group").classList.toggle("hidden", scenarioSelect.value !== "manual");
  syncLoopAvailability();
  resetSim();
});

/**
 * 闭环可用性：运动学一致剧本直接规定真值姿态与平动，`feedbackQ` 不会进入轨迹；
 * 真实/回放模式也没有模拟控制器。两种情况都禁用开关并解释，而不是让用户点了没反应。
 */
function syncLoopAvailability(): void {
  const loop = $<HTMLInputElement>("loop-toggle");
  const kinematic = Boolean(scenarios[scenarioSelect.value]?.kinematic);
  loop.disabled = state.real || kinematic;
  if (kinematic && loop.checked) loop.checked = false;
  loop.title = kinematic
    ? "运动学一致剧本直接规定真值姿态与平动，闭环控制不适用"
    : state.real
      ? "真实/回放模式没有模拟控制器"
      : "闭环演示：机体用所选解算结果控制";
}

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
      $("att-tabs").querySelectorAll(".tab").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      state.channel = parseInt(btn.dataset.ch!, 10);
      rebuildAttChart();
    });
  });

// ---------- 曲线面板折叠：三块各自独立，且网格自动重排不留空洞 ----------
type ChartKey = "att" | "err" | "imu";
const CHART_KEYS: ChartKey[] = ["att", "err", "imu"];
const chartState: Record<ChartKey, boolean> = { att: true, err: true, imu: false };

/**
 * 依据「哪些面板展开」重排网格：
 *  - 三块都开 → att/err 并排 + imu 整行
 *  - 只开两块 → 并排整行
 *  - 只开一块 → 独占整行（高度也加大）
 * 旧版用固定 `"att err" / "imu imu"` 区域，收起任意一块都会留下半格空白——
 * 这就是「上面两块必须同时折叠才看不出空档」的根源。
 */
function layoutCharts(): void {
  const charts = document.getElementById("charts")!;
  const open = CHART_KEYS.filter((k) => chartState[k]);
  charts.dataset.openCount = String(open.length);
  // 布局完全交给 flex（展开块自适应两列、折叠块沉底成整行细条），
  // 这里只维护状态与画布高度档位——不再手工拼 grid-template-areas。
  for (const k of CHART_KEYS) {
    const block = document.getElementById(`block-${k}`)!;
    block.classList.toggle("collapsed", !chartState[k]);
    const fold = block.querySelector<HTMLButtonElement>(".fold-btn");
    fold?.setAttribute("aria-expanded", String(chartState[k]));
    const chip = document.querySelector<HTMLButtonElement>(`.cb-chip[data-chart="${k}"]`);
    if (chip) {
      chip.classList.toggle("active", chartState[k]);
      chip.setAttribute("aria-pressed", String(chartState[k]));
    }
  }
  // 展开后画布尺寸变化：让 ResizeObserver 之外再显式重绘一次，避免首帧空白
  requestAnimationFrame(() => {
    attChart.render();
    errChart.render();
    imuChart.render();
  });
}

function setChartOpen(k: ChartKey, open: boolean): void {
  chartState[k] = open;
  layoutCharts();
  updateChartSummaries();
}

/**
 * 图表的等价文本出口：三块画布对读屏软件完全不可读（canvas 只有 aria-label），
 * 这里把「当前时刻各系列读数」整理成可折叠表格——既让读屏用户拿到同样的信息，
 * 也方便学生把数字抄进作业。只在用户展开时刷新内容（省 DOM 操作）。
 */
function updateChartTables(): void {
  const secs = ["att-table", "err-table", "imu-table"];
  if (!secs.some((id) => (document.getElementById(id)?.closest("details") as HTMLDetailsElement | null)?.open)) {
    return;
  }
  const fmt = (v: number, unit = ""): string => (Number.isFinite(v) ? v.toFixed(2) + unit : "—");
  const att = attChart.latest();
  const err = errChart.latest();
  const imu = imuChart.latest();
  const attTab = ["横滚 φ", "俯仰 θ", "偏航 ψ"][state.channel];
  const imuNames = IMU_TAB_NAMES[imuState.tab];

  const put = (id: string, head: string[], body: string[][]): void => {
    const t = document.getElementById(id);
    if (!t) return;
    t.innerHTML =
      `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  };

  // 姿态角：当前通道下 6 条曲线的最新值（真实 + 五算法）
  put(
    "att-table",
    ["系列", `当前通道「${attTab}」当前值（°）`],
    [
      ["真实姿态", fmt(att[0])],
      ...ests.map((e, i) => [e.label, fmt(att[i + 1])]),
    ],
  );
  // 误差：五算法 + 可选 B 组
  put(
    "err-table",
    ["算法", "总误差（°）"],
    [
      ...ests.map((e, i) => [e.label, fmt(err[i])]),
      ...(abState.on ? AB_TARGETS().map((e, i) => [`${e.label} ·B`, fmt(err[err.length - AB_TARGETS().length + i])]) : []),
    ],
  );
  // IMU：当前页签的三轴实测（作用同「以表格查看」）
  put(
    "imu-table",
    ["通道", `当前值（${["°/s", "m/s²", "μT"][imuState.tab]}）`],
    [0, 1, 2].map((k) => [`${imuNames} ${["x", "y", "z"][k]}`, fmt(imu[imuState.tab * 3 + k])]),
  );
}

/** 折叠态标题行的摘要：显示该面板最关键的一两个读数，收起也不丢信息 */
function updateChartSummaries(): void {
  const put = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const att = attChart.latest();
  const names = ["真实", ...ests.map((e) => e.label)];
  const idx = state.channel;
  const wrap = (v: number): string => {
    if (!Number.isFinite(v)) return "--";
    let x = v;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return `${x.toFixed(1)}°`;
  };
  put(
    "att-summary",
    `${["横滚 φ", "俯仰 θ", "偏航 ψ"][idx]}：${names.map((n, i) => `${n} ${wrap(att[i])}`).join(" · ")}`,
  );
  const err = errChart.latest();
  const worst = err
    .slice(0, ests.length)
    .map((v, i) => ({ v, n: ests[i].label }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v)[0];
  put(
    "err-summary",
    worst ? `最大 ${worst.n} ${worst.v.toFixed(2)}° · 最优 ${ests[err.indexOf(Math.min(...err.slice(0, ests.length)))].label}` : "",
  );
  const imu = imuChart.latest();
  const tab = imuState.tab;
  const unit = ["°/s", "m/s²", "μT"][tab];
  put(
    "imu-summary",
    IMU_TAB_NAMES[tab] +
      "：" +
      ["x", "y", "z"]
        .map((a, i) => `${a} ${Number.isFinite(imu[tab * 3 + i]) ? imu[tab * 3 + i].toFixed(2) : "--"}`)
        .join(" · ") +
      ` ${unit}`,
  );
}

document.querySelectorAll<HTMLButtonElement>(".fold-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const k = btn.dataset.fold as ChartKey;
    setChartOpen(k, !chartState[k]);
  });
});
document.querySelectorAll<HTMLButtonElement>(".cb-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const k = chip.dataset.chart as ChartKey;
    setChartOpen(k, !chartState[k]);
  });
});
layoutCharts();

// ---------- 右侧面板手风琴 ----------
const panelSections = [...document.querySelectorAll<HTMLElement>("#panel .panel-section")];
function setSectionOpen(sec: HTMLElement, open: boolean): void {
  sec.classList.toggle("collapsed", !open);
  const btn = sec.querySelector<HTMLButtonElement>(".panel-toggle");
  btn?.setAttribute("aria-expanded", String(open));
}
for (const sec of panelSections) {
  const btn = sec.querySelector<HTMLButtonElement>(".panel-toggle");
  if (!btn) continue;
  btn.addEventListener("click", () => setSectionOpen(sec, sec.classList.contains("collapsed")));
}
/**
 * 面板摘要：每个折叠区标题右侧显示「当前值」，收起也不丢信息——
 * 这是解决「右侧栏太密集但又不想舍弃」的核心手法：把**参数状态**留在标题行，
 * 把**解释与控件**收进展开区。
 */
function updatePanelSummaries(): void {
  const set = (id: string, text: string): void => {
    const el = document.getElementById(`sum-${id}`);
    if (el) el.textContent = text;
  };
  const scenarioName = scenarioSelect.selectedOptions[0]?.textContent ?? "—";
  set("scenario", `${scenarioName}${!hasGroundTruth() ? ` · ${dataSourceLabel()}` : ""}`);
  const presets = $<HTMLSelectElement>("imu-preset").selectedOptions[0]?.textContent ?? "";
  const extras = [
    imuParams.gyroRangeDps > 0 ? `量程 ${imuParams.gyroRangeDps}°/s` : "",
    imuParams.gyroScaleErr > 0 ? `刻度 ${(imuParams.gyroScaleErr * 100).toFixed(1)}%` : "",
    imuParams.gyroMisalign > 0 ? `失准 ${(imuParams.gyroMisalign * 100).toFixed(1)}%` : "",
    imuParams.sensorDelayMs > 0 ? `延迟 ${imuParams.sensorDelayMs}ms` : "",
    (imuParams.sensorDelaySkewMs ?? 0) > 0 ? `延迟差 ±${imuParams.sensorDelaySkewMs}ms` : "",
    (imuParams.sensorSampleHz ?? 0) > 0 ? `采样 ${imuParams.sensorSampleHz}Hz` : "",
  ].filter(Boolean);
  set(
    "imu",
    `${presets.split("（")[0]} · 零偏 ${imuParams.gyroBiasDps.toFixed(1)}°/s · 噪声 ${imuParams.gyroNoiseDps.toFixed(2)}` +
      (extras.length ? ` · ${extras.join(" ")}` : ""),
  );
  set(
    "magcal",
    magCalState.cal
      ? `${magCalState.applied ? "已应用" : "已拟合"} · 残差 ${(magCalState.cal.residual * 100).toFixed(1)}%`
      : "未校准",
  );
  const magOn = ($("mag-enable") as HTMLInputElement).checked;
  const magMode = ($<HTMLSelectElement>("mag-mode").value === "full" ? "完整MARG" : "偏航MARG");
  set(
    "algo",
    `${magOn ? magMode : "IMU"} · Kp ${mahony.kp.toFixed(2)} / Ki ${mahony.ki.toFixed(2)} / β ${madg.beta.toFixed(2)}` +
      ` · 门控 ${($("gate-toggle") as HTMLInputElement).checked ? `${$<HTMLInputElement>("gate-deg").valueAsNumber}°` : "关"}`,
  );
  set("view", `来源 ${sourceLabel()}${($("telemetry-toggle") as HTMLInputElement).checked ? " · 玻璃盒" : ""}`);
  const best = metricsA
    .map((m) => m.summary())
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.n > 0 && !(state.real && x.i === 2))
    .sort((a, b) => a.s.rmse - b.s.rmse)[0];
  set("metrics", best ? `最优 ${ests[best.i].label} · RMSE ${best.s.rmse.toFixed(2)}°` : "尚无样本");
  set("telemetry", activeEstimator()?.label ?? "真实姿态无内部量");
  const pairName = QUAT_POSE_PAIRS.find((p) => p.id === quatState.pairId)?.name ?? "";
  const proj = ($("quat-mode") as HTMLSelectElement).value === "proj";
  set(
    "quat",
    proj
      ? `4D 投影 · ${(document.getElementById("proj-turn")?.textContent ?? "").match(/累计\s*\d+°[^（]*/)?.[0]?.trim() ?? "q = +1"}`
      : pairName,
  );
  set("gimbal", `φ ${gimState.rollDeg.toFixed(0)}° / θ ${gimState.pitchDeg.toFixed(0)}° / ψ ${gimState.yawDeg.toFixed(0)}°`);
}

/** 快捷入口：展开 IMU 面板并直接发起串口连接（真实硬件是主功能，不该藏在折叠区里） */
document.getElementById("btn-serial-quick")?.addEventListener("click", () => {
  const sec = document.getElementById("sec-imu");
  if (sec) setSectionOpen(sec, true);
  serialToggle();
});

document.getElementById("panel-expand-all")?.addEventListener("click", () => {
  for (const sec of panelSections) setSectionOpen(sec, true);
});
document.getElementById("panel-collapse-all")?.addEventListener("click", () => {
  for (const sec of panelSections) setSectionOpen(sec, false);
});

// IMU 原始波形页签：陀螺仪 / 加速度计 / 磁力计
$("imu-tabs")
  .querySelectorAll<HTMLButtonElement>(".tab")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      $("imu-tabs").querySelectorAll(".tab").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      imuState.tab = parseInt(btn.dataset.tab!, 10) as 0 | 1 | 2;
      rebuildImuLegend();
      applyImuTab();
      imuChart.render();
    });
  });

function setPlaying(p: boolean): void {
  state.playing = p;
  $("btn-pause").textContent = p ? "暂停" : "继续";
}
$("btn-pause").addEventListener("click", () => setPlaying(!state.playing));
$("btn-reset").addEventListener("click", resetSim);

/**
 * 单步推进：暂停后每次前进一个**解算步**（仿真仍是 500 Hz，解算频率低时内部走多步）。
 * 真实/回放模式的时间由数据到达节奏决定，不在这里伪造——给提示而不是静默无效。
 */
function stepOnce(): void {
  if (state.real) {
    toast("单步用于模拟模式；真实/回放数据按帧到达推进，请用暂停/继续", "#fbbf24");
    return;
  }
  if (state.playing) setPlaying(false);
  let guard = 0;
  while (!stepSim() && ++guard < 2000) { /* 等到生产调度真正解算，不读陈旧镜像acc */ }
  updateReadouts();
  updateLegendValues();
  attChart.render();
  errChart.render();
  imuChart.render();
  drawIns();
}
$("btn-step")?.addEventListener("click", stepOnce);

/* 三图共享时间游标：鼠标悬停/键盘方向键在暂停时查看任意历史帧 */
const sharedCharts: RollingChart[] = [attChart, errChart, imuChart];
const cursorChip = document.getElementById("chart-cursor");
let cursorT: number | null = null;
function cursorText(t: number): string {
  const att = attChart.sampleAt(t);
  const err = errChart.sampleAt(t);
  const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : "—");
  const attText = att
    ? att.values
        .slice(0, 3)
        .map((v, i) => `${["真实", ...ests.map((e) => e.label)][i] ?? `#${i}`} ${fmt(v)}°`)
        .join(" · ")
    : "—";
  const errText = err
    ? err.values
        .slice(0, 3)
        .map((v, i) => `${ests[i]?.label ?? `#${i}`} ${fmt(v, 2)}°`)
        .join(" · ")
    : "—";
  return `t = ${t.toFixed(2)} s · ${attText}｜误差 ${errText}`;
}
function setSharedCursor(t: number | null): void {
  cursorT = t;
  for (const c of sharedCharts) c.setCursor(t);
  if (!cursorChip) return;
  if (t === null) {
    cursorChip.classList.add("hidden");
    return;
  }
  cursorChip.textContent = cursorText(t);
  cursorChip.classList.remove("hidden");
}
for (const id of ["att-canvas", "err-canvas", "imu-canvas"]) {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) continue;
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const { t0, t1 } = attChart.timeRange();
    const t = t0 + frac * (t1 - t0);
    if (diagnosticsApi?.state().reviewActive) diagnosticsApi.seekReview(t);
    else setSharedCursor(t);
  });
  canvas.addEventListener("mouseleave", () => {
    // 回看锁定时鼠标离开曲线不得静默清掉历史游标。
    if (!diagnosticsApi?.state().reviewActive) setSharedCursor(null);
  });
}
window.addEventListener("keydown", (e) => {
  if (state.playing || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  const { t0, t1 } = attChart.timeRange();
  const cur = cursorT ?? t1;
  const next = Math.min(t1, Math.max(t0, cur + (e.key === "ArrowLeft" ? -0.04 : 0.04)));
  if (diagnosticsApi?.state().reviewActive) diagnosticsApi.seekReview(next);
  else setSharedCursor(next);
  e.preventDefault();
});

/** 构建标识：关于页脚 + 自动化出口（部署后 smoke 用它对「线上到底是哪个提交」） */
const BUILD_INFO = {
  commit: __BUILD_COMMIT__,
  builtAt: __BUILD_TIME__,
};
/**
 * **被服务产物**的构建身份（SW-06）：`dist/build-provenance.json` 是构建结束时写下的，
 * 它自己声明 buildId（源码摘要 + 产物摘要）。页面把它取回来，于是采集脚本能回答
 * 「服务端跑的这份产物是不是我本地刚构建的那份」——只比提交号做不到这一点：
 * 未提交的改动、换了产物没换源码，都能让两个不同的 dist 顶着同一个 commit。
 * 开发服务器/离线包里没有这个文件（dev 直接跑源码），取不到就只显示提交与时间。
 */
const BUILD_IDENTITY: { buildId: string | null; distHash: string | null; sourceDigest: string | null } = {
  buildId: null,
  distHash: null,
  sourceDigest: null,
};
function paintBuildStamp(): void {
  const el = document.getElementById("build-stamp-value");
  if (!el) return;
  const when = BUILD_INFO.builtAt.replace("T", " ").slice(0, 19);
  const artifact = BUILD_IDENTITY.buildId ? ` · 产物 ${BUILD_IDENTITY.buildId}` : "";
  el.textContent = `${BUILD_INFO.commit} · ${when} UTC${artifact}`;
}
paintBuildStamp();
async function loadBuildIdentity(): Promise<void> {
  try {
    const res = await fetch(new URL("build-provenance.json", document.baseURI).href, { cache: "no-store" });
    if (!res.ok) return;
    const raw = (await res.json()) as { buildId?: unknown; distHash?: unknown; sourceDigest?: unknown };
    if (typeof raw.buildId === "string" && raw.buildId) {
      BUILD_IDENTITY.buildId = raw.buildId;
      BUILD_IDENTITY.distHash = typeof raw.distHash === "string" ? raw.distHash : null;
      BUILD_IDENTITY.sourceDigest = typeof raw.sourceDigest === "string" ? raw.sourceDigest : null;
      paintBuildStamp();
    }
  } catch { /* 没有溯源文件（dev / 离线包）：保持只显示提交与时间 */ }
}
void loadBuildIdentity();

function resetSim(): void {
  // 档案导入的**验证阶段**禁止清现场：写控件会触发 change → resetSim，
  // 但此刻还没决定是否接受这份档案。只有 applyArchiveChecked 验证通过后
  // 才会退出抑制并显式提交一次。
  if (archiveProbeDepth > 0) return;
  taskStripApi?.noteReset();
  simResetCount++; // 诊断计数：每帧都在复位说明有控件事件在自激（时钟/曲线永远停在 0）
  // 确定性复位：World 用同一 seed 重新播种，传感器噪声序列从实验起点完整重放
  world.reset(experimentConfig.seed);
  // 「初始姿态偏差」演示：勾选后给所有算法同一个**由 seed 决定**的随机初值（20–35°，真值仍从水平出发）——
  // 观察幻影（真值）不动、各算法从错误初值收敛：互补/Mahony/Madgwick 靠启动增益 ramp 加速，
  // 卡尔曼靠大初始协方差；偏航 40° 门控的边界效应见文档·控制项手册。
  // 真实模式没有「演示用初始偏差」的意义：始终从水平出发。
  const wantOffset = !state.real && ($("init-offset-toggle") as HTMLInputElement).checked;
  experimentConfig.initialAttitude = wantOffset ? { kind: "random" } : { kind: "level" };
  const q0 = wantOffset ? initialAttitudeOf(experimentConfig) : undefined;
  for (const e of ests) e.reset(q0);
  for (const c of abState.clones) c.reset(q0); // B 组保持冻结参数，只同步初值（fork 复位后即变为同起点配对）
  solveLoop.reset();
  solveRunId++; // 新的一轮：消费快照随之作废（旧消费值不得出现在新轮记录里）
  clearSolveInput();
  diagnosticsApi?.reset(solveRunId);
  replayPlayer.rewind(); // 重置播放预算、未完成帧、游标（日志/倍速仍保留）
  replayState.idx = 0;
  replayState.acc = 0;
  replayState.announcedEnd = false;
  still.chipUntil = -1;
  state.simTime = 0;
  simAcc = 0;
  logAcc = 0;
  solveState.acc = 0;
  metricsA.forEach((m) => m.reset(0));
  metricsB.forEach((m) => m.reset(0));
  attChart.clear();
  errChart.clear();
  imuChart.clear();
  attPrev.fill(undefined);
  logRows.length = 0;
  rawRecord.rows.length = 0;
  resetIns(); // 位置积分与轨迹属于「本轮」，一并归零
  state.lastImu = null;
  state.externalTruth = null;
  truthPrevQ = null; // 日志真值差分角速度不能跨轮沿用
  truthPrevT = 0;
  replayTruth.reset();
  if (state.real) serialState.queue.length = 0; // 重置后不要把重置前的帧再回放一遍
  clearSimError(); // 连同那条红字横幅一起摘掉（只复位标志会让它一直挂在屏幕上）
  setSharedCursor(null); // 时间游标属于本轮记录
  updateMetricsTable();
}

$("init-offset-toggle").addEventListener("change", resetSim);

/** 实验种子：同一配置 + 同一种子 = 同一噪声序列、同一随机初值；改变种子即换一组实验样本 */
const seedInput = document.getElementById("experiment-seed") as HTMLInputElement | null;
if (seedInput) {
  seedInput.value = String(experimentConfig.seed >>> 0);
  const applySeed = (): void => {
    const v = Number(seedInput.value);
    experimentConfig.seed = Number.isFinite(v) && v >= 0 ? Math.floor(v) >>> 0 : DEFAULT_EXPERIMENT_CONFIG.seed;
    resetSim();
    toast(`实验种子 = ${experimentConfig.seed}（重置后噪声与随机初值随之可复现）`);
  };
  seedInput.addEventListener("change", applySeed);
}

// ---------- 读数 ----------
const fmtSigned = (v: number, d = 1): string => {
  const x = Math.abs(v) < 10 ** -d / 2 ? 0 : v; // 消除 "-0.0" 这类显示
  return (x >= 0 ? "+" : "") + x.toFixed(d);
};
const fmtVec = (v: [number, number, number]): string =>
  `[${v.map((a) => fmtSigned(a, 1)).join(", ")}]`;

/** 当前「模型姿态来源」对应的四元数；真实模式且无外部真值时回退到 Mahony 基准 */
function selectedQ(): Quat {
  if (state.source === "truth") return referenceQ();
  // 换源/回放会重建估计器集合，此刻 state.source 可能暂时指向已不存在的算法；
  // 直接对 find() 取 .q 会抛错并打断仿真步，这里回退到第一个可用算法。
  return sourceEstimator()?.q ?? ests[0]?.q ?? world.q;
}

function eulerText(e: ReturnType<typeof qToEuler>, separator = " "): string {
  return `φ ${fmtSigned(e.roll * DEG)}°${separator}θ ${fmtSigned(e.pitch * DEG)}°${separator}ψ ${fmtSigned(e.yaw * DEG)}°`;
}

function updateReadouts(): void {
  const q = selectedQ();
  const eu = qToEuler(q);
  // 真实模式无真值：这一行显示 Mahony 参照基准（图例里的「真实」即基准）
  const refQ = referenceQ();
  const te = qToEuler(refQ);
  $("readout-quat").textContent = `q = ${quatText(q, 4)}`;
  $("readout-euler").innerHTML = eulerText(eu, " &nbsp; ");
  $("readout-true").innerHTML = (!hasGroundTruth()
    ? `<span style="color:#e6edf3">基准(${currentReferenceKind() === "external" ? "外部" : "Mahony"})</span> `
    : "真实 ") + eulerText(te);
  const imu = state.lastImu;
  if (imu) {
    const gyroDps: [number, number, number] = [imu.gyro[0] * DEG, imu.gyro[1] * DEG, imu.gyro[2] * DEG];
    // 三路延迟不同步时，把「各通道滞后多少毫秒」直接写出来（来自流水线的通道时间戳）
    const lag = imu.times
      ? ` <span class="dim">滞后 陀螺 ${((state.simTime - imu.times.gyro) * 1000).toFixed(1)} / 加计 ${((state.simTime - imu.times.accel) * 1000).toFixed(1)} / 磁 ${((state.simTime - imu.times.mag) * 1000).toFixed(1)} ms</span>`
      : "";
    $("readout-imu").innerHTML =
      `陀螺仪 ${fmtVec(gyroDps)} °/s<br />加速度计 ${fmtVec(imu.accel)} m/s²${lag}`;
  }
  $("clock").textContent = `t = ${state.simTime.toFixed(1)} s`;
}

function updateLegendValues(): void {
  const att = attChart.latest();
  attLegend.vals.forEach((el, i) => {
    if (!el) return;
    if (!Number.isFinite(att[i])) {
      el.textContent = "--";
      return;
    }
    // 读数永远显示包裹到 ±180° 的角度：曲线保留连续性，读数不被循环剧本撑爆
    let v = att[i];
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    el.textContent = `${v.toFixed(1)}°`;
  });
  const err = errChart.latest();
  errLegend.vals.forEach((el, i) => {
    if (el) el.textContent = Number.isFinite(err[i]) ? `${err[i].toFixed(2)}°` : "--";
  });
  errLegendB.vals.forEach((el, i) => {
    const v = err[ests.length + i];
    if (el) el.textContent = Number.isFinite(v) ? `${v.toFixed(2)}°` : "--";
  });
  const imu = imuChart.latest();
  imuLegend.vals.forEach((el, i) => {
    const v = imu[imuLegend.indices[i]];
    if (el) el.textContent = Number.isFinite(v) ? v.toFixed(2) : "--";
  });
  // 粗对准完成提示（黏 3s，见 stepStillness）
  const chip = $("align-chip");
  chip.classList.toggle("hidden", performance.now() / 1000 > still.chipUntil);
}

// ---------- 评测表：本轮运行的误差统计 ----------
const fmtMetric = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : "—");

function metricRow(name: string, color: string, s: ReturnType<ErrorTracker["summary"]>, cls = ""): string {
  return (
    `<tr${cls ? ` class="${cls}"` : ""}><td><span class="m-dot" style="background:${color}"></span>${name}</td>` +
    `<td>${fmtMetric(s.last)}</td><td>${fmtMetric(s.mean)}</td><td>${fmtMetric(s.rmse)}</td>` +
    `<td>${fmtMetric(s.max, 1)}</td><td>${s.convergedAt === null ? "—" : `${s.convergedAt.toFixed(1)} s`}</td></tr>`
  );
}

let metricsRowsCache = "";
function updateMetricsTable(): void {
  const body = document.getElementById("metrics-body");
  if (!body) return;
  const sums = metricsA.map((m) => m.summary());
  // 最优 RMSE 高亮：真实模式下 Mahony 是基准（误差恒 0），不参与评选
  let best = -1;
  let bestV = Infinity;
  sums.forEach((s, i) => {
    if (state.real && i === 2) return;
    if (s.n > 0 && s.rmse < bestV) {
      bestV = s.rmse;
      best = i;
    }
  });
  const rows = ests.map((e, i) =>
    metricRow(
      e.label + (state.real && i === 2 ? "（基准）" : ""),
      e.color,
      sums[i],
      i === best ? "best" : state.real && i === 2 ? "ref" : "",
    ),
  );
  if (abState.on) {
    AB_TARGETS().forEach((e, i) => {
      const s = metricsB[i]?.summary();
      if (s) rows.push(metricRow(`${e.label} ·B`, abAlpha(e.color), s));
    });
  }
  uiWorkCounters.metricsAttempts++;
  const rowsHtml = rows.join("");
  const meta = document.getElementById("metrics-meta");
  if (rowsHtml !== metricsRowsCache) {
    body.innerHTML = rowsHtml;
    metricsRowsCache = rowsHtml;
    uiWorkCounters.metricsWrites++;
  }
  if (meta) {
    const n = sums.find((s) => s.n > 0)?.n ?? 0;
    meta.textContent = `本轮 ${n} 个样本（25 Hz）· 收敛 = 连续 1 s 总误差 < 2°`;
  }
}

/* ==========================================================================
   批量评测（P2）：同一批 seed 下五种算法配对比较，报告 P50/P95 与未收敛率
   --------------------------------------------------------------------------
   复用 core/runner 的无 DOM 内核（与在线仿真同一套 World/IMU/估计器/统计）。
   每跑完一个 seed 让出一次事件循环，避免长时间冻结页面。
   ========================================================================== */
let batchRunning = false;
/** Worker 多久没有任何消息就判为卡死（心跳间隔 2 s，留足余量） */
/**
 * 批量 Worker 的停滞看门狗。
 *
 * 为什么是 60 s 而不是 15 s：Worker 里每个种子是**同步**跑完的，单线程下定时器在
 * 一次长跑期间根本发不出来——也就是说「下一条 progress」要等当前种子算完。
 * 快机器上 10 s 仿真约 1 s，15 s 窗口够用；但 2 vCPU 的 CI runner（与 WebGL 主循环抢 CPU）
 * 上单个种子就可能超过 15 s，于是**慢机器会被误判成「Worker 卡死」并静默回退主线程**
 * （Windows CI 实测：界面结果正确、但 `batchMode()` 变成 `main`，与「Worker 路径失败」无法区分）。
 * 60 s 仍然能把真正死掉的 Worker（一句消息都不发）判出来，只是不再惩罚慢硬件。
 */
const WORKER_STALL_MS = 60_000;

/** 从当前实例提取完整算法配置（批量评测的输入快照） */
function tuningOf(e: Estimator): EstimatorTuning {
  const base = structuredCloneTuningSafe(DEFAULT_ESTIMATOR_TUNING[e.id as EstimatorId]);
  base.enabled = true;
  base.magEnabled = e.id === "pure" ? false : e.magEnabled;
  base.params = e.getParams();
  if (e.id === "comp" || e.id === "mahony" || e.id === "madg") {
    const g = e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator;
    base.accelGate = g.accelGate;
    base.gateDeg = g.gateDeg;
    base.gateMagPct = g.gateMagPct;
    base.gateRecovery = g.gateRecovery;
    base.rampEnabled = g.rampEnabled;
    if (e.id === "mahony" || e.id === "madg") {
      base.magMode = (e as MahonyEstimator | MadgwickEstimator).magMode;
    }
  }
  if (e.id === "kalman") {
    const k = e as KalmanEstimator;
    base.kalmanGate = k.gateMode;
    base.kalmanChi2 = k.gateChi2;
    base.kalmanResetCov = k.resetCovOnInject;
  }
  return base;
}
function structuredCloneTuningSafe(t: EstimatorTuning): EstimatorTuning {
  return { ...t, params: { ...t.params } };
}

/** 当前界面状态的完整数值配置（批量评测/实验档案共用） */
function currentMagCalModel(): MagCalModel {
  return ($<HTMLSelectElement>("magcal-model"))?.value === "full" ? "full" : "diag";
}

function currentExperimentConfig(durationSec: number): ExperimentConfig {
  const c = defaultExperimentConfig();
  c.seed = experimentConfig.seed;
  c.scenario = scenarioSelect.value;
  c.durationSec = durationSec;
  c.solveRateHz = solveState.hz;
  c.imu = { ...imuParams };
  c.initialAttitude = ($<HTMLInputElement>("init-offset-toggle")).checked ? { kind: "random" } : { kind: "level" };
  c.magModel = currentMagCalModel();
  // 校准对象与「是否应用」分开记录：只保存对象不足以复现同一输入
  c.magCalibration = magCalState.cal;
  c.magCalibrationApplied = magCalState.applied && magCalState.cal !== null;
  // 无标定时也写目标场强：它是"拟合目标"（默认 50 μT），不是"当前标定的 field"。
  // 只在有标定时才写会让自导出的档案（无标定）与默认配置在往返比较里冲突。
  c.magTargetUts = magCalState.cal?.field ?? 50;
  c.accelCalibration = accelCalState.cal;
  c.accelCalibrationApplied = accelCalState.applied && accelCalState.cal !== null;
  c.autoCoarseAlign = solveLoop.autoCoarseAlign;
  c.steadyFromSec = steadyFromSec;
  c.manualTargetDeg = [world.manual.rollDeg, world.manual.pitchDeg, world.manual.yawDeg];
  c.ab = { mode: ($<HTMLSelectElement>("ab-mode"))?.value === "online-fork" ? "online-fork" : "same-start" };
  for (const e of ests) c.estimators[e.id as EstimatorId] = tuningOf(e);
  return c;
}


/**
 * 连接世代：串口/BLE 的**在途连接**与回放导入都受它保护。
 * 任何会改变「当前数据来源意图」的操作（断开、连另一种、导入回放）都会 +1，
 * 于是尚未完成的 await 在返回时能发现「我这一代已经作废了」，不提交状态。
 */
let connectionGeneration = 0;

/**
 * 数据源**意图**：用户显式选择的来源，与「传输层此刻是否活着」分开。
 *
 * 复核反例（P1-D）：断线重连期间 `serialState.running` / `bleState.connected` 都是 false，
 * 于是 `currentDataSource()` 退回 `simulation`——记录被标成「模拟」、误差基准被当成模拟真值；
 * 更糟的是 `applyDataSourceSemantics()` 还会顺手把本轮实验清零。
 * 因此来源身份由本变量持有：只有「用户主动换源 / 彻底放弃重连」才改它。
 */
let sourceIntent: DataSourceKind = "simulation";

/** 批量评测的执行路径（自检/冒烟用来确认走的是哪一条） */
let batchLastMode: "worker" | "main" | null = null;
/**
 * 主线程降级路径的**协作取消**判据（SW-10）。
 *
 * 旧实现的问题：降级分支用同步 `runExperiment` 跑「整个种子」，只在种子之间 `setTimeout` 让出。
 * 一个 30 s 实验要 ~550 ms 才能返回，这期间事件循环完全被占住——用户点了取消、甚至点了
 * 其它控件，都得等这次计算跑完才轮到。被点名的验收目标是「取消后下一计算片即停止」与
 * 「交互响应 p95 ≤ 200 ms」，这里就按这两条留证：
 *   · `batchCancelLatencyMs`：从点取消到计算真正停下的时延（毫秒，最近一次）；
 *   · `batchPartialSeeds`：因取消而被丢弃的**未完成**种子数（半成品不许计入完成统计）。
 */
let batchCancelLatencyMs: number | null = null;
let batchPartialSeeds = 0;
let batchCancelRequestedAt: number | null = null;
const batchCancelTiming: { requestedAt: number | null; runnerStoppedAt: number | null; postAwaitAt: number | null } = {
  requestedAt: null, runnerStoppedAt: null, postAwaitAt: null,
};
/** 测试/验收开关：强制走主线程降级路径（否则本机总是 Worker，降级分支永远测不到） */
let batchWorkerDisabled = false;
/** 步数与墙钟双预算：固定步数不能保证慢机器上的响应时间。 */
const BATCH_MAIN_SLICE_STEPS = 128;
const batchSlices = { count: 0, maxComputeMs: 0 };
let batchCompletedResult: { generation: number; seeds: number[]; summary: BatchSummary } | null = null;

/**
 * Worker 路径：把 N 个种子的评测整体搬出主线程。
 * 返回 null 表示 Worker 不可用或失败（调用方回退到主线程分片路径）。
 */
/** 批量评测任务号：单调递增。旧任务的消息一律丢弃，避免连点两次时旧结果覆盖新表格。 */
let batchJobSeq = 0;
/** 当前在跑的 Worker（取消时要能给它发 cancel 并终止） */
let batchWorker: Worker | null = null;
/** 当前任务号（0 = 没有在跑） */
let activeBatchJob = 0;
/**
 * **批次世代**：每次「启动」或「取消」都 +1。所有异步回写（进度、看门狗回退、表格、
 * 主线程分片完成）都必须先确认自己的世代仍然是最新的。
 *
 * 为什么不能只看 `batchRunning`：取消后把 `batchRunning=false`，但**已经排队的定时器/
 * 已挂起的 await 仍会继续跑**。复核反例：取消旧批后 15 s 看门狗到期，仍会启动主线程回退、
 * 跑完旧 seed100…109 并把旧表格写上去（此时 `running=false`、新 job=2 正在跑）。
 */
let batchGeneration = 0;
/** 当前 Worker Promise 的结算函数：取消时必须调用它，否则 `runBatch` 的 await 永远不返回 */
let settleBatchWorker: ((v: EstimatorRunMetrics[][] | null) => void) | null = null;

/** 批量评测的取消请求：由按钮或新批次触发 */
function cancelBatch(reason: string): void {
  // 记下取消时刻：主线程降级路径会在下一个计算片停下并回报真实时延（SW-10）
  batchCancelRequestedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  batchCancelTiming.requestedAt = batchCancelRequestedAt;
  batchCancelTiming.runnerStoppedAt = batchCancelTiming.postAwaitAt = null;
  // 取消要覆盖两条路径：Worker 还在跑时终止它；Worker 已挂/不存在时正在跑主线程分片，
  // 此时 activeBatchJob 可能已经是 0——只看它会把「取消」吃掉（复核实测过这条）。
  if (!batchRunning && !activeBatchJob && !settleBatchWorker) return;
  // 世代 +1：此后所有排队的定时器、已挂起的 await、旧 Worker 消息都属于「上一代」，
  // 一律不得再写界面或启动回退（这是修掉「旧看门狗复活旧任务」的关键）。
  batchGeneration++;
  const jobId = activeBatchJob;
  activeBatchJob = 0;
  try {
    batchWorker?.postMessage({ type: "cancel", jobId } satisfies BatchRequest);
  } catch {
    /* 已经死了 */
  }
  // 结算挂起的 Promise（清看门狗 + terminate + resolve null），否则 runBatch 的 await 悬挂
  settleBatchWorker?.(null);
  settleBatchWorker = null;
  // 立即终止：Worker 会在下一个种子结束后退出，但长时长单次运行可能要等很久；
  // 用户点取消就该立刻停，不能等「跑到一半」。
  batchWorker?.terminate();
  batchWorker = null;
  batchRunning = false;
  const btn = $<HTMLButtonElement>("btn-batch");
  btn.disabled = false;
  btn.textContent = "运行批量评测";
  const status = $("batch-status");
  status.textContent = `已取消批量评测（${reason}）`;
  batchCancelCount++;
}
/** 取消次数（自动化验收用） */
let batchCancelCount = 0;

/**
 * Worker 路径：把 N 个种子的评测整体搬出主线程。
 * 返回 null 表示 Worker 不可用/失败/被取消（调用方回退或直接结束）。
 *
 * 与旧实现的差别（第五轮复核的 P2）：
 *  - 每条消息都核对 `jobId`，过期消息直接丢弃（连点两次不会互相覆盖）；
 *  - 支持取消（`cancelBatch`）；
 *  - 超时判据改为「多久没收到**任何**消息」，而不是按种子数×时长线性外推
 *    （旧公式在 30×30 档会算出 22 分钟，等于没有保护）。
 */
function runBatchInWorker(
  config: ExperimentConfig,
  seeds: number[],
  onProgress: (done: number, total: number, seed: number, viaHeartbeat: boolean) => void,
): Promise<EstimatorRunMetrics[][] | null> {
  return new Promise((resolve) => {
    const jobId = ++batchJobSeq;
    activeBatchJob = jobId;
    if (batchWorkerDisabled) {
      // 显式禁用（自动化验收用）：走与「Worker 不可用」完全相同的回退路径
      activeBatchJob = 0;
      resolve(null);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(batchWorkerUrl, { type: "module" });
    } catch {
      activeBatchJob = 0;
      resolve(null);
      return;
    }
    batchWorker = worker;
    let settled = false;
    const finish = (v: EstimatorRunMetrics[][] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      worker.terminate();
      if (batchWorker === worker) batchWorker = null;
      if (activeBatchJob === jobId) activeBatchJob = 0;
      if (settleBatchWorker === finish) settleBatchWorker = null;
      resolve(v);
    };
    // 把结算函数登记出去：cancelBatch 必须能立刻结算它（否则 await 悬挂）
    settleBatchWorker = finish;
    // 停滞看门狗：只要 Worker 还在发 progress/heartbeat 就一直续期。
    // 单次运行很久（例如 30 s 时长 + 高解算率）时，心跳保证它不会被误判为卡死。
    let stallTimer: ReturnType<typeof setTimeout>;
    const armStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.warn(`批量评测 Worker 超过 ${WORKER_STALL_MS / 1000} s 没有任何消息，回退主线程路径`);
        finish(null);
      }, WORKER_STALL_MS);
    };
    armStall();
    worker.onmessage = (ev: MessageEvent<BatchResponse>): void => {
      const msg = ev.data;
      if (!msg || msg.jobId !== jobId) return; // 过期任务的消息：丢弃
      armStall();
      if (msg.type === "progress") onProgress(msg.done, msg.total, msg.seed, false);
      else if (msg.type === "heartbeat") onProgress(msg.done, msg.total, -1, true);
      else if (msg.type === "cancelled") finish(null);
      else if (msg.type === "done") finish(msg.metricsList);
      else if (msg.type === "error") {
        console.warn("批量评测 Worker 报错：", msg.message);
        finish(null);
      }
    };
    worker.onerror = () => {
      console.warn("批量评测 Worker 启动/运行失败，回退主线程路径");
      finish(null);
    };
    worker.postMessage({ type: "start", jobId, config, seeds } satisfies BatchRequest);
  });
}

async function runBatch(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-batch");
  const status = $("batch-status");
  const body = $("batch-body");
  if (batchRunning) {
    // 再点一次 = 取消（30×30 档要跑几十秒，此前只能刷新页面）
    cancelBatch("用户取消");
    return;
  }
  if (state.real) {
    toast("真实 IMU / 回放模式没有真值，批量 RMSE 评测不适用", "#f85149");
    return;
  }
  const spec = $<HTMLSelectElement>("batch-runs").value;
  const [runCount, durText] = spec === "30x30" ? [30, 30] : [Number(spec), 10];
  const config = currentExperimentConfig(durText);
  const problems = validateExperimentConfig(config);
  if (problems.length) {
    toast(`配置不合法：${problems[0].path} ${problems[0].message}`, "#f85149");
    return;
  }
  batchRunning = true;
  btn.disabled = false; // 保持可点：运行期间它是「取消」
  btn.textContent = "取消本次评测";
  body.innerHTML = "";
  status.classList.remove("hidden");
  status.textContent = `批量评测准备中：${runCount} 个种子 × ${durText} s…`;
  // 本批次的世代必须在任何 await 之前推进：用户点下按钮的那一刻就已经是
  // 「运行中/可取消」，量具与取消逻辑不能等按需 runner 加载完才看到状态变化。
  const myGen = ++batchGeneration;
  const stale = (): boolean => batchGeneration !== myGen;
  let runner: RunnerModule;
  try {
    runner = await loadRunner();
  } catch (err) {
    if (!stale()) {
      batchRunning = false;
      btn.textContent = "运行批量评测";
      status.textContent = "批量评测失败：运行内核加载失败";
      toast(`批量评测失败：${errorText(err)}`, "#f85149");
    }
    return;
  }
  if (stale()) return; // 加载期间被取消/替代：不再启动 Worker 或主线程任务
  const seeds = runner.seedSequence(config.seed, runCount);

  const finishBatch = (res: { seeds: number[]; summary: BatchSummary; approximate?: boolean }, count: number, mode: "worker" | "main"): void => {
    // 过期批次绝不写表格：取消后旧 Worker 的回调/看门狗仍可能走到这里
    if (stale()) return;
    batchLastMode = mode;
    batchCompletedResult = { generation: myGen, seeds: res.seeds.slice(), summary: res.summary.map((row) => ({ ...row })) };
    // 表格与状态文案在 ui/batch-table.ts（纯函数，可被 Node 断言"7 列口径/口径措辞"）
    body.innerHTML = batchRowsHtml(
      res.summary,
      ests.map((e) => ({ id: e.id, label: e.label, color: e.color, isRef: state.real && e.id === "mahony" })),
    );
    status.textContent = batchStatusText({
      count,
      durationSec: durText,
      baseSeed: config.seed,
      lastSeed: seeds[count - 1],
      steadyFromSec: config.steadyFromSec,
      mode,
      approximate: res.approximate,
    });
    batchRunning = false;
    btn.disabled = false;
    btn.textContent = "运行批量评测";
    toast(`批量评测完成：${count} 次配对运行`, "#7ee787");
  };

  // ① Worker 路径（页面保持可用）；② 失败则回退主线程分片路径（行为与旧版一致）
  const metricsList = await runBatchInWorker(config, seeds, (done, total, seed, viaHeartbeat) => {
    if (stale()) return; // 过期批次的进度不得改写状态行
    status.textContent = viaHeartbeat
      ? `批量评测进行中（Worker）：${done} / ${total}（心跳正常，仍在计算本轮…）`
      : `批量评测进行中（Worker）：${done} / ${total}（当前 seed ${seed}）`;
  });
  // 取消会立刻结算 Promise（null）并把世代推进：这里必须直接结束，不能再走回退路径
  if (stale()) return;
  if (metricsList) {
    finishBatch(runner.summarizeMetricsLists(config, seeds, metricsList), metricsList.length, "worker");
    return;
  }

  /**
   * ② 主线程降级路径：用 runner 的**异步出口**逐片执行，取消在下一片生效（SW-10）。
   *
   * 与旧实现的差别：以前这里是「同步跑完一个种子 → setTimeout(0) 跑下一个」，
   * 单种子内部的 500 Hz 循环全程占住主线程（30 s 实验 ≈ 550 ms 不可交互）。
   * 现在直接复用 `runExperimentAsync` + `shouldCancel`（不另写一套积分内核）：
   *   · 每 `BATCH_MAIN_SLICE_STEPS` 步 let 出一次 macrotask（不是 microtask，
   *     否则收不到点击/计时器消息，只是"看起来让出了"）；
   *   · `shouldCancel` 每步检查，取消后当前种子立即中止；
   *   · 被中止的种子**不计入完成统计**（`termination.reason !== "completed"` 就丢掉）。
   */
  batchSlices.count = 0;
  batchSlices.maxComputeMs = 0;
  const runs: HeadlessRunResult[] = [];
  const cancelledNow = (): boolean => stale() || !batchRunning;
  for (let i = 0; i < seeds.length; i++) {
    if (cancelledNow()) return;
    const result = await runner.runExperimentAsync(
      { ...config, seed: seeds[i] },
      {
        stepsPerSlice: BATCH_MAIN_SLICE_STEPS,
        maxSliceMs: 4,
        onSlice: (slice) => {
          if (stale()) return;
          batchSlices.count++;
          batchSlices.maxComputeMs = Math.max(batchSlices.maxComputeMs, slice.computeMs);
        },
        progressEverySec: 0.5,
        shouldCancel: cancelledNow,
        onStop: () => {
          // 时刻的语义是「**这一次取消请求**之后 runner 停下」，所以判据是「有取消在等」+「批量已不在运行」，
          // 不能用 `batchGeneration === myGen + 1`：世代只负责防止旧回写，实测它会在取消与停止之间被
          // 别处推进（CI 上出现过 runner 明明在 219.9 ms 内停下、时间戳却缺失，整条断言因此判失败）。
          if (!batchRunning && batchCancelRequestedAt !== null) batchCancelTiming.runnerStoppedAt = performance.now();
        },
        onProgress: () => !cancelledNow(),
      },
    );
    if (cancelledNow()) {
      // 取消：本次种子是半成品，丢弃并回报"取消到停止"的真实时延
      batchPartialSeeds++;
      if (batchGeneration === myGen + 1 && batchCancelRequestedAt !== null) {
        batchCancelTiming.postAwaitAt = performance.now();
        batchCancelLatencyMs = batchCancelTiming.postAwaitAt - batchCancelRequestedAt;
        batchCancelRequestedAt = null;
      }
      return;
    }
    if (result.termination.reason !== "completed") {
      // 没有取消、却也没跑完：同样是"半个种子"，不能进统计
      batchPartialSeeds++;
      return;
    }
    runs.push(result);
    status.textContent = `批量评测进行中（主线程）：${runs.length} / ${seeds.length}（当前 seed ${seeds[i]}）`;
  }
  if (cancelledNow()) return;
  finishBatch(runner.summarizeRuns(config, seeds, runs), runs.length, "main");
}
$("btn-batch")?.addEventListener("click", () => void runBatch());

/* ==========================================================================
   实验档案（P3）：完整数值配置 + seed + 校准 + 本轮统计的可复现 JSON
   --------------------------------------------------------------------------
   档案的**格式与校验规则**在 core/experiment-archive.ts（纯逻辑、有独立自检）；
   这里只负责「读控件 → 构造档案」与「把档案写回控件」。
   ========================================================================== */
function buildArchive(): ExperimentArchive {
  const elapsedSec = state.simTime;
  // 时长取实际已跑时间（至少 5 s）；导入后从 seed 起点重跑同样长度的配置
  const config = currentExperimentConfig(Math.max(5, Math.round(elapsedSec) || 30));
  const run: ArchiveRunInfo = {
    elapsedSec,
    dataSource: dataSourceLabel(),
    reference: currentReferenceKind(),
    finishedAtIso: new Date().toISOString(),
    metrics: ests.map((e, i) => {
      const s = metricsA[i]?.summary();
      const n = s?.n ?? 0;
      // 零样本必须写 null（不是 NaN）：NaN 经 JSON.stringify 变 null 后会被自己的
      // 解析器当成"合法但为 null"的旧值路径，或直接判失败（复核反例：复位后导出→导入失败）。
      const stat = (v: number | undefined): number | null => (n > 0 && typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        id: e.id,
        n,
        mean: stat(s?.mean),
        rmse: stat(s?.rmse),
        max: stat(s?.max),
        convergedAt: s?.convergedAt ?? null,
      };
    }),
  };
  return buildArchiveObject(config, run);
}

/** 三类导出共用同步下载路径，click 保持在用户操作内；URL 延迟释放。 */
function downloadExport(contents: string, type: string, name: string, extension: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `attitude-${name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${extension}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportArchive(): void {
  const archive = buildArchive();
  downloadExport(JSON.stringify(archive, null, 2), "application/json;charset=utf-8", "config", "json");
  toast(`已导出配置档案（seed ${archive.config.seed}，实际跑 ${archive.run.elapsedSec.toFixed(1)} s；导入将从 seed 起点复现配置）`);
}

/** IMU 参数 → 主界面控件表在 core/archive-ui.ts（写控件与离线可表达性模型共用同一张表） */

/**
 * 档案提交期间的联动复位抑制：写控件会触发 resetSim/场景重建，
 * 但"验证是否可以导入"的阶段绝不能清除曲线、记录、校准历史与 A/B 状态。
 */
let archiveProbeDepth = 0;

/** 提示的单调计数（档案事务验收用：失败导入不得留下提示，且与提示存活时间无关） */
let toastSeq = 0;

/** 复位次数（诊断）：每帧都在复位 = 某个控件事件在自激，时钟/曲线会永远停在 0 */
let simResetCount = 0;

/** 读取档案相关控件的**约束**（min/max/step/选项）：只读属性，不触发任何事件。 */
function archiveControlSpecs(): ControlSpecs {
  const specs: ControlSpecs = {};
  for (const step of archiveUiSteps(defaultExperimentConfig())) {
    const el = document.getElementById(step.id);
    if (!el) continue;
    if (el instanceof HTMLSelectElement) {
      specs[step.id] = { kind: "select", options: [...el.options].map((o) => o.value) };
    } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
      specs[step.id] = { kind: "check" };
    } else if (el instanceof HTMLInputElement) {
      specs[step.id] = {
        kind: "slider",
        min: parseFloat(el.min),
        max: parseFloat(el.max),
        step: parseFloat(el.step) || 0.01,
      };
    }
  }
  return specs;
}

/**
 * 写活状态与控件（**非破坏性**）：不碰历史、不重置本轮现场。
 * 校验失败时可以用同一函数把旧配置原样写回，现场保持不动。
 * 写步骤来自 `archiveUiSteps`（与离线可表达性模型共用），不再手写第二份映射。
 */
function writeArchiveState(cfg: ExperimentConfig, panels?: { mag?: MagPanelPlan; accel?: AccelPanelPlan }): void {
  archiveProbeDepth++;
  try {
    // 手动目标角先写进 World 实例（驱动仿真），随后 man-* 滑块会把它对齐到控件网格——
    // 顺序反了会让读回拿到未量化的原值，与读回比较口径打架。
    world.setManualTarget(cfg.manualTargetDeg ?? [0, 0, 0]);
    for (const step of archiveUiSteps(cfg)) {
      if (step.kind === "slider") setSliderValue(step.id, step.value);
      else if (step.kind === "select") setSelectValue(step.id, step.value);
      else setCheckValue(step.id, step.value);
    }
    experimentConfig.seed = cfg.seed;
    if (seedInput) seedInput.value = String(cfg.seed);
    // 校准对象与模型：深拷贝——把档案里的对象直接挂到活状态上，之后任何一次「重新拟合」
    // 都会把历史记录/档案对象一起改写（复核反例：恢复后再改 clone.axis 污染了原配置）。
    magCalState.cal = cfg.magCalibration ? cloneMagCalibration(cfg.magCalibration) : null;
    magCalState.applied = magCalState.cal !== null && cfg.magCalibrationApplied !== false;
    // 面板渲染计划在 prepare 阶段就算好了（HTML 解析已提前完成）——这里只做赋值与节点搬移，
    // 提交路径不再有"解析失败 → 半提交"的窗口（SW-03）。
    if (panels?.mag) applyMagPanel(panels.mag); else updateMagCalUi();
    accelCalState.cal = cfg.accelCalibration ? cloneAccelCalibration(cfg.accelCalibration) : null;
    accelCalState.applied = accelCalState.cal !== null && cfg.accelCalibrationApplied !== false;
    if (panels?.accel) applyAccelPanel(panels.accel); else updateAccelCalUi();
    // 逐算法参数最后写：上面的控件事件会把「全局开关」刷给所有算法（applyMagEnable /
    // applyAccelGate / applyKalmanGate），档案里的逐算法快照必须覆盖这次广播，
    // 否则 rampEnabled / kalmanChi2 这些界面上没有独立控件的字段会被静默丢掉。
    applyNonUiTunings(cfg);
    // 粗对准与稳态窗口都直接改变结论：必须参与恢复与读回比较。
    solveLoop.autoCoarseAlign = cfg.autoCoarseAlign !== false;
    steadyFromSec = cfg.steadyFromSec ?? null;
  } finally {
    archiveProbeDepth--;
  }
}

/**
 * 提交一次档案恢复：清掉属于**上一份实验**的采集状态，并重置本轮现场。
 * 只有验证通过后才会走到这里——失败回滚只调用 writeArchiveState(before)，
 * 不会清历史/样本/曲线。
 */
function commitArchiveRestore(panels?: { mag: MagPanelPlan; accel: AccelPanelPlan }): void {
  // 档案导入会换掉标定：历史列表清空，避免「恢复」把用户带回到另一个实验的标定
  magCalHistory.length = 0;
  magCalHistorySeq = 0;
  activeMagCalHistoryId = 0;
  // 磁采集状态也要停：档案里没有原始样本，继续采集会把新数据混进"另一个实验"的标定
  magCalState.collecting = false;
  magCalState.samples.length = 0;
  magCalState.verifyLine = "";
  // 档案里没有保存六面原始样本（只有拟合结果），不能凭空造训练数据；已有模型仍可直接应用
  accelCalState.samples = [];
  accelCalState.pending = null;
  accelCalState.window = [];
  accelCalState.verifyLine = "";
  accelCalState.message = "";
  // 提交后的面板同样用 prepare 阶段算好的计划（历史已清空的那一份），不再现场解析 HTML
  if (panels) { applyMagPanel(panels.mag); applyAccelPanel(panels.accel); }
  else { updateMagCalUi(); updateAccelCalUi(); }
  resetSim();
  bumpConfigRevision();
}


/**
 * 把档案里**界面上没有独立控件**的算法参数写回活实例。
 *
 * 只写这些字段（rampEnabled / kalmanChi2）：它们真实影响解算，但在界面上没有开关，
 * 旧实现直接丢弃 → 导入后 `tuningOf()` 读回默认值，「同配置复现」不成立。
 *
 * 有控件的字段**故意不在这里写**：必须经过控件的 min/max/step（界面真相）。
 * 否则档案里的 alpha=999999 会被直接塞进估计器，滑块却显示 5——读回比较通过，
 * 界面与实际状态却对不上。不可表达的取值由导入流程的读回比较拒绝。
 */
function applyNonUiTunings(cfg: ExperimentConfig): void {
  for (const e of ests) {
    const t = cfg.estimators[e.id as EstimatorId];
    if (!t) continue;
    if (e.id === "comp" || e.id === "mahony" || e.id === "madg") {
      (e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator).rampEnabled = t.rampEnabled !== false;
    }
    if (e.id === "kalman" && Number.isFinite(t.kalmanChi2)) {
      (e as KalmanEstimator).gateChi2 = t.kalmanChi2 as number;
    }
  }
}

/**
 * 档案配置的**提交事务**：可表达性检查 → prepare（含面板渲染计划）→ 提交 → 读回比较 → 失败回滚。
 *
 * 用户导入与自动化入口（attitudeDemo.experiment.importArchive）共用这一条路径，
 * 否则测试会「绕过校验仍然绿」——正是复审指出的门禁盲区。
 *
 * SW-03 的关键改动：**所有可能抛异常的渲染**（`innerHTML` 解析）都在 prepare 阶段、
 * 在脱离文档的元素上完成；提交阶段只剩控件写入与赋值-搬移。于是"渲染失败留下半提交现场"
 * 这个窗口被消掉了：渲染失败时现场一个字节都没动，而回滚也不再需要现场重算面板。
 */
function applyArchiveChecked(cfg: ExperimentConfig):
  | { ok: true; notRestored: string[]; warnings: string[] }
  | { ok: false; error: string } {
  const fmt = (ps: Array<{ path: string; message: string }>): string => ps.map((p) => `${p.path}（${p.message}）`).join("；");
  // ① 界面根本无法表示的取值：直接拒绝（解析成功 ≠ 能恢复）。
  const impossible = archiveExpressibilityProblems(cfg);
  if (impossible.length) {
    return { ok: false, error: `档案里有界面无法表示的配置，未导入：${fmt(impossible)}` };
  }
  // ② **离线**往返判定（不写任何控件、不触发任何事件）：控件会按 min/max/step 夹值
  //    （333 Hz → 500 Hz、999999 → 5）、全局开关会向所有算法广播、下拉写不进枚举外的取值。
  //    这些判定全部在**提交之前**算完——失败时现场一个字节都没动，
  //    因此「导入失败」不再需要靠回滚去修补（旧实现回滚不全会漏掉 loop/preset/toast 等副作用）。
  const impossible2 = archiveControlRoundTripProblems(cfg, archiveControlSpecs());
  if (impossible2.length) {
    return { ok: false, error: `档案无法在界面上完整恢复（当前实验现场未改动）：${fmt(impossible2)}` };
  }
  // ③ prepare。比较的是**语义**而不是"键有没有写"：可选字段在缺失时按文档默认值恢复。
  const before = currentExperimentConfig(cfg.durationSec);
  const want = cloneExperimentConfig(cfg);
  want.autoCoarseAlign = cfg.autoCoarseAlign !== false;
  want.steadyFromSec = cfg.steadyFromSec ?? null;
  want.magTargetUts = cfg.magTargetUts ?? cfg.magCalibration?.field ?? 50;
  want.magCalibrationApplied = want.magCalibration != null && cfg.magCalibrationApplied !== false;
  want.accelCalibrationApplied = want.accelCalibration != null && cfg.accelCalibrationApplied !== false;
  want.manualTargetDeg = cfg.manualTargetDeg ? [...cfg.manualTargetDeg] as [number, number, number] : [0, 0, 0];
  want.ab = { mode: cfg.ab?.mode ?? "same-start" };
  const live = calUiDesc();
  const afterMagCal = cfg.magCalibration ?? null;
  const afterAccelCal = cfg.accelCalibration ?? null;
  const afterModel: MagCalModel = (cfg.magCalibration?.kind ?? cfg.magModel) === "full" ? "full" : "diag";
  const afterDesc: CalUiDesc = {
    mag: {
      ...live.mag,
      cal: afterMagCal,
      applied: afterMagCal !== null && cfg.magCalibrationApplied !== false,
    },
    accel: {
      ...live.accel,
      cal: afterAccelCal,
      applied: afterAccelCal !== null && cfg.accelCalibrationApplied !== false,
    },
    model: afterModel,
    imu: { ...cfg.imu },
    real: live.real,
  };
  const committedDesc: CalUiDesc = {
    ...afterDesc,
    mag: { ...afterDesc.mag, collecting: false, sampleCount: 0, verifyLine: "", history: [] },
    accel: { ...afterDesc.accel, sampleCount: 0, verifyLine: "", message: "" },
  };
  let planBefore: { mag: MagPanelPlan; accel: AccelPanelPlan };
  let planAfter: { mag: MagPanelPlan; accel: AccelPanelPlan };
  let planCommitted: { mag: MagPanelPlan; accel: AccelPanelPlan };
  try {
    planBefore = { mag: planMagPanel(live), accel: planAccelPanel(live) };
    planAfter = { mag: planMagPanel(afterDesc), accel: planAccelPanel(afterDesc) };
    planCommitted = { mag: planMagPanel(committedDesc), accel: planAccelPanel(committedDesc) };
  } catch (err) {
    // 面板渲染阶段就失败：**还没有写任何状态**，直接如实报错
    return {
      ok: false,
      error: `档案面板渲染失败（当前实验现场未改动）：${errorText(err)}`,
    };
  }
  // ④ 提交。控件写入仍可能被处理器抛错打断，因此用统一异常边界：失败就把配置与面板写回导入前的计划，
  //    且**不做**清历史/清样本/重置仿真这些不可逆动作（它们只在⑤成功之后发生）。
  try {
    writeArchiveState(cfg, planAfter);
  } catch (err) {
    try { writeArchiveState(before, planBefore); } catch { /* 回滚尽力而为；下面的错误信息已说明现场可能不完整 */ }
    return {
      ok: false,
      error: `档案应用失败（已回滚配置）：${errorText(err)}`,
    };
  }
  // ⑤ 兜底断言：真实读回必须与离线模型一致。不一致说明模型失真（离线判定与控件语义脱钩），
  //    此时回滚并如实报错，绝不"导入成功但跑的是另一份配置"。
  const mismatch = archiveRoundTripProblems(want, currentExperimentConfig(cfg.durationSec));
  if (mismatch.length) {
    writeArchiveState(before, planBefore);
    return {
      ok: false,
      error: `档案无法在界面上完整恢复（当前实验现场未改动）：${fmt(mismatch)}`,
    };
  }
  commitArchiveRestore(planCommitted);
  // 档案替换的是 A 组配置；B 组仍按导入前的快照冻结，继续对比会得出错误结论。
  // 与「装载实验基线关闭 A/B」同一约定——关闭并说明，而不是留下含混语义。
  const warnings: string[] = [];
  if (abState.on) {
    setCheckValue("ab-toggle", false); // handler 会清掉 clones 并把 B 曲线置为不可见
    warnings.push("A/B 对比已关闭（导入替换了 A 组参数，旧 B 组不再可比，请按新配置重新开启）");
  }
  // ⑥ 界面不可调整的字段：由调用方明确说"本次未恢复"。
  return {
    ok: true,
    notRestored: ARCHIVE_IGNORED_KEYS.filter((k) => (cfg as unknown as Record<string, unknown>)[k] !== undefined),
    warnings,
  };
}

async function importArchiveFile(file: File): Promise<void> {
  try {
    const parsed = parseArchive(JSON.parse(await file.text()));
    if (!parsed.ok) {
      toast(parsed.error, "#f85149");
      return;
    }
    const cfg = parsed.config;
    // 原子性（ROUND11 P1）：先把**全部**展示用的信息算出来（含 run 元数据），
    // 再提交配置。旧实现先 apply 再 describe，run.elapsedSec 类型不对时会在
    // 配置已经改过之后才抛错——界面提示失败，实际状态已经变了。
    const extra = describeArchiveRun(parsed.run);
    const note = parsed.notes?.length ? `；${parsed.notes.join("；")}` : "";
    const applied = applyArchiveChecked(cfg);
    if (!applied.ok) {
      toast(applied.error, "#f85149");
      return;
    }
    const ignored = applied.notRestored.length
      ? `；界面不可调整、本次未恢复：${applied.notRestored.join(" / ")}`
      : "";
    // 复核 P2-1：`steadyFromSec` / `autoCoarseAlign` 界面上没有独立控件，却直接改变结论
    // （稳态窗口改 RMSE 口径、粗对准会重置姿态）。可以由档案写内核状态，但**必须在提示里可见**，
    // 否则用户看不到"这次导入其实换了统计窗口/关掉了粗对准"。
    const hiddenNote = [
      cfg.steadyFromSec != null ? `稳态统计窗口起点 ${cfg.steadyFromSec} s（界面无控件）` : "",
      cfg.autoCoarseAlign === false ? "静止粗对准自动重置已关闭（界面无控件）" : "",
    ].filter(Boolean).join("；");
    const warnNote = applied.warnings.length ? `；${applied.warnings.join("；")}` : "";
    toast(
      `已导入配置档案（seed ${cfg.seed}）——将从 seed 起点按同一配置重新跑${extra}${ignored}${note}` +
        (hiddenNote ? `；${hiddenNote}` : "") + warnNote,
      parsed.notes?.length || applied.notRestored.length || hiddenNote || applied.warnings.length ? "#fbbf24" : "#7ee787",
    );
    console.info("配置档案导入：仅复现配置，不还原当前时刻/曲线；需要逐帧回放请导入全帧源 IMU CSV。", {
      run: parsed.run,
      notes: parsed.notes ?? [],
      notRestored: applied.notRestored,
      migratedFrom: parsed.migratedFrom ?? null,
    });
  } catch (err) {
    toast(`档案导入失败：${errorText(err)}`, "#f85149");
  }
}

$("btn-archive-export")?.addEventListener("click", exportArchive);
$("btn-archive-import")?.addEventListener("click", () => $("archive-file")?.click());
$("archive-file")?.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void importArchiveFile(file);
  input.value = "";
});

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
  // 打开玻璃盒 = 想看内部量：面板若还停在收起状态就自动展开（否则开关看起来没反应）
  if (on) {
    const sec = document.getElementById("sec-telemetry");
    if (sec) {
      if (sec.classList.contains("collapsed")) setSectionOpen(sec, true);
      // 面板在右栏下方，开关打开后把它滚进视野（否则用户以为没生效）
      requestAnimationFrame(() => sec.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
  }
  // 真实姿态没有内部量：即使开关打开也不显示 3D 箭头
  const est = activeEstimator();
  sceneHandles.gravityArrows.group.visible = on && est !== null && state.view === "attitude";
  updateGravityLegend();
}

function arrowLegendHtml(color: string, text: string): string {
  return `<span class="lg-item"><span class="lg-dot" style="background:${color}"></span>${text}</span>`;
}

/** 图例文字随显示源变化：真实姿态没有解算过程，说明而不是展示箭头 */
function updateGravityLegend(): void {
  const legend = $("gravity-legend");
  if (state.source === "truth") {
    legend.innerHTML = `<span class="lg-item dim">真实姿态没有解算过程——切换显示源后，这里会说明两根箭头的含义</span>`;
    return;
  }
  legend.innerHTML =
    arrowLegendHtml("#f1f5f9", "预测的「下」（当前估计姿态）") +
    arrowLegendHtml("#e879f9", "实测的「下」（加速度计）");
}

/** 磁航向图例：说明琥珀箭头，随 MARG 开关换文案 */
function updateMagLegend(): void {
  const magOn = ($("mag-enable") as HTMLInputElement).checked;
  const legend = $("mag-legend");
  legend.innerHTML = arrowLegendHtml("#ffb454", magOn
    ? "磁航向指示（MARG 开：被磁场约束，与罗盘箭头保持一致）"
    : "磁航向指示（MARG 已关：会随陀螺仪漂移偏离真北）");
}

$("palette-toggle").addEventListener("change", () => {
  applyPalette(($("palette-toggle") as HTMLInputElement).checked ? "cb" : "default");
});

// 界面文字档位（标准/大/特大，课堂投影）：独立偏好，刻意不加入 DEEP_SELS/DEEP_CHECKS。
const fontTierSelect = $("font-tier") as HTMLSelectElement;
const initialFontTier = loadFontTier();
applyFontTier(initialFontTier);
fontTierSelect.value = initialFontTier;
fontTierSelect.addEventListener("change", () => {
  const tier = isFontTier(fontTierSelect.value) ? fontTierSelect.value : "standard";
  saveFontTier(tier);
  applyFontTier(tier);
});

$("telemetry-toggle").addEventListener("change", () => {
  setTelemetryVisible(($("telemetry-toggle") as HTMLInputElement).checked);
});

const fmtDps = (v: [number, number, number]): string =>
  v.map((a) => fmtSigned(a * DEG, 1)).join("  ");

/** 算法读数共用同形行；仅插入固定标签与已格式化的数值，不接收外部文本。 */
function telemetryLine(label: string, value: string, valueAttrs = ""): string {
  return `<div class="tel-line"><span class="dim">${label}</span><span${valueAttrs}>${value}</span></div>`;
}

/** 算法专属行：互补看两路信源，Mahony 看 P/I 分工，Madgwick 看残差；MARG 开时附磁航向 */
function detailRows(est: (typeof ests)[number]): string {
  const d = est.telemetry.detail;
  // 磁行分两种形态：简化版给倾斜补偿磁航向，完整 MARG 给磁场残差角
  const magRow =
    d.magModeFull === 1
      ? telemetryLine("磁场残差（完整 MARG）", (d.magErrDeg ?? 0).toFixed(3))
      : d.magEnabled === 1
        ? telemetryLine("磁航向 ψₘ", `${fmtSigned(d.yawMagDeg ?? 0)}°`)
        : "";
  // 门控状态行：0 正常 / 1 本帧被拒 / 2 恢复窗；窗口拒绝占比是滞回判据
  const gm = d.gateMode === undefined ? "" : telemetryLine(
    "加计门控",
    `${{ 0: "放行", 1: "本帧拒绝", 2: "恢复窗（放行）" }[d.gateMode as 0 | 1 | 2] ?? "—"}` +
      ` · 窗口拒绝 ${((d.rejectRatio ?? 0) * 100).toFixed(0)}%`,
    d.gateMode === 1 ? " class=\"warn\"" : "",
  );
  switch (est.id) {
    case "comp": {
      const w = d.accelWeight ?? 0;
      return telemetryLine("本帧加速度计权重", `${(w * 100).toFixed(1)}%`) +
        telemetryLine("加速度计倾角 φ/θ", `${fmtSigned(d.rollAccDeg ?? 0)}° ${fmtSigned(d.pitchAccDeg ?? 0)}°`) +
        gm + magRow;
    }
    case "mahony": {
      const p = d.pShare ?? 0;
      return `<div class="tel-bar"><span class="dim">Kp 比例 ${(p * 100).toFixed(0)}%</span>` +
        `<span class="bar"><span class="bar-p" style="width:${(p * 100).toFixed(0)}%"></span>` +
        `<span class="bar-i" style="width:${((1 - p) * 100).toFixed(0)}%"></span></span>` +
        `<span class="dim">Ki 积分 ${((1 - p) * 100).toFixed(0)}%</span></div>` +
        telemetryLine("∫e 用量", `${((d.iUsage ?? 0) * 100).toFixed(0)}%`) +
        gm + magRow;
    }
    case "madg":
      return telemetryLine("目标残差 ‖f‖", (d.residual ?? 0).toFixed(3)) +
        telemetryLine("本帧四元数增量", `${((d.stepNorm ?? 0) * 1e3).toFixed(2)} ×10⁻³`) +
        gm + magRow;
    case "kalman":
      return telemetryLine("零偏估计 |b|", `${(d.biasNormDps ?? 0).toFixed(3)}°/s`) +
        telemetryLine("零偏分量 x/y/z", `${fmtSigned(d.biasXDps ?? 0, 2)} ${fmtSigned(d.biasYDps ?? 0, 2)} ${fmtSigned(d.biasZDps ?? 0, 2)}°/s`) +
        telemetryLine("重力新息角", `${fmtSigned(d.innoAccelDeg ?? 0)}°`) +
        telemetryLine("重力 NIS", `${fmtMetric(d.nisAccel ?? NaN, 2)}${d.accelAccepted ? " ✓接受" : " ✗拒绝"}`) +
        telemetryLine("磁 NIS", `${fmtMetric(d.nisMag ?? NaN, 2)}${d.magAccepted ? " ✓接受" : " ✗拒绝"}`) +
        telemetryLine("门控形态", d.kalmanGateMode ? "χ² 马氏距离" : "新息夹角 40°") +
        magRow;
    default:
      return "";
  }
}

/**
 * 卡尔曼的 3σ 姿态不确定度椭球（玻璃盒的一部分）。
 *
 * 用 3×3 姿态协方差块 `P[0..2][0..2]`（rad²）做特征分解：
 * 特征向量给出椭球主轴在**机体系**里的方向，特征值 λᵢ 给出该方向的方差，
 * 半轴长度取 3√λᵢ（各主轴 ±3σ）。注意 99.7% 是一维正态的 ±3σ 覆盖，
 * 三维椭球的联合覆盖率更低（各向同性高斯约 97.1%），因此读数只说「主轴 ±3σ」。
 * 轴长夹在 [0.06, 0.85] 之间：太小看不见，太大穿出机身会误导。
 *
 * 观察点：静止收敛后椭球慢慢缩小并趋于球形；机动/观测被门控时它会沿某方向拉长
 * （那正是「这个方向我不确定」），恢复观测的瞬间猛地收缩——这就是卡尔曼增益
 * 在几何上的样子。只在显示源为卡尔曼且玻璃盒打开时可见。
 */
function updateCovEllipsoid(est: (typeof ests)[number] | null): void {
  const mesh = sceneHandles.covEllipsoid;
  const wire = sceneHandles.covWire;
  const show = telState.visible && state.view === "attitude" && est?.id === "kalman";
  mesh.visible = show;
  wire.visible = show;
  if (!show || !est) return;
  const P = (est as KalmanEstimator).getCovariance();
  const block = [
    P[0], P[1], P[2],
    P[6], P[7], P[8],
    P[12], P[13], P[14],
  ];
  const { values, vectors } = symmetricEigen3(block);
  // 半轴 = 3σ × 可视化倍率，再逐轴夹紧。
  // 为什么需要倍率（COV_SCALE）：收敛后 σ_θ 只有零点几度（~0.01 rad），
  // 直接按「弧度当模型长度」画会小到看不见。取 4 模型单位/弧度（1σ），
  // 于是初始 5°(0.087 rad) 的 σ 对应 3σ×4 ≈ 1.0（几乎包住整个机身），
  // 收敛到 0.5° 时缩到 ~0.10 —— 收缩过程在视觉上有 10 倍跨度，正是要展示的东西。
  const COV_SCALE = 4;
  const half = values.map((v) => Math.min(0.9, Math.max(0.16, 3 * Math.sqrt(Math.max(0, v)) * COV_SCALE)));
  // 机体系 → 显示系的基变换：协方差主轴按 S·v 转（与 toDisplayVec 同源）
  const m = new Matrix4();
  const col = (i: number): Vector3 => {
    const v = toDisplayVec([vectors[i], vectors[3 + i], vectors[6 + i]]);
    return new Vector3(v[0], v[1], v[2]).normalize();
  };
  const e0 = col(0), e1 = col(1), e2 = col(2);
  m.set(
    e0.x * half[0], e1.x * half[1], e2.x * half[2], 0,
    e0.y * half[0], e1.y * half[1], e2.y * half[2], 0,
    e0.z * half[0], e1.z * half[1], e2.z * half[2], 0,
    0, 0, 0, 1,
  );
  // 椭球挂在四轴上（quad.group 已带机体系姿态），这里只补机体系内部的摆放
  m.premultiply(new Matrix4().makeTranslation(0, 0.09, 0));
  mesh.matrix.copy(m);
  wire.matrix.copy(m);
  mesh.matrixWorldNeedsUpdate = true;
  wire.matrixWorldNeedsUpdate = true;
}

/** 内部读数块 + 3D 双箭头（每 0.1s 刷新一次） */
let telDetailCache = "";
const uiWorkCounters = { telemetryAttempts: 0, telemetryWrites: 0, metricsAttempts: 0, metricsWrites: 0, insPlaceholderDraws: 0 };
function updateTelemetry(): void {
  const est = activeEstimator();
  const arrows = sceneHandles.gravityArrows;
  arrows.group.visible = telState.visible && est !== null && state.view === "attitude";
  updateCovEllipsoid(est);
  if (!telState.visible || !est) return;

  const t = est.telemetry;
  // 3D 箭头方向：机体系向量经 toDisplayVec 翻转到显示约定，归一化后由 ArrowHelper 定向
  const setDir = (arrow: ArrowHelper, v: [number, number, number], active: boolean) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    arrow.visible = active && len > 1e-6;
    if (active && len > 1e-6) {
      arrow.setDirection(new Vector3(v[0] / len, v[1] / len, v[2] / len));
    }
  };
  setDir(arrows.predicted, toDisplayVec(t.predictedGravity), true);
  setDir(arrows.measured, toDisplayVec(t.measuredGravity), t.accelValid);

  // 受扰状态：实测箭头降饱和；提示带黏性（见 telState 注释）
  const disturbed = !t.accelValid && t.accelNorm > 0.1 * 9.80665;
  const failed = t.accelNorm <= 0.1 * 9.80665;
  arrows.measured.setColor(new Color(disturbed || failed ? 0x8b5a92 : 0xe879f9));

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

  uiWorkCounters.telemetryAttempts++;
  const detailHtml = detailRows(est);
  if (detailHtml !== telDetailCache) {
    $("tel-detail").innerHTML = detailHtml;
    telDetailCache = detailHtml;
    uiWorkCounters.telemetryWrites++;
  }
  const ae = t.detail.alignErrorDeg;
  $("tel-alignerr").textContent = Number.isFinite(ae) ? `${ae.toFixed(2)}°` : "—";

  // 误差分解：逐轴欧拉分量之差 + 总角距。总角距用 qAngleBetween（与曲线/评测同源），
  // 逐轴差则回答「偏差主要在哪根轴上」——这两个数字回答的是不同问题，所以都给。
  // 偏航差包裹到 ±180°（否则跨 ±180° 时会显示 ±360 的假大值）。
  const refQ = referenceQ();
  $("tel-err-ref").textContent = hasGroundTruth() ? "真值" : currentReferenceKind() === "external" ? "外部参考" : "Mahony 基准";
  const eEst = qToEuler(est.q);
  const eRef = qToEuler(refQ);
  const wrap180 = (d: number): number => {
    let x = ((d + 180) % 360 + 360) % 360 - 180;
    if (Object.is(x, -180)) x = 180;
    return x;
  };
  const degDiff = (a: number, b: number): number => wrap180((a - b) * DEG);
  $("tel-err-roll").textContent = `${fmtSigned(degDiff(eEst.roll, eRef.roll), 2)}°`;
  $("tel-err-pitch").textContent = `${fmtSigned(degDiff(eEst.pitch, eRef.pitch), 2)}°`;
  $("tel-err-yaw").textContent = `${fmtSigned(degDiff(eEst.yaw, eRef.yaw), 2)}°`;
  $("tel-err-total").textContent = `${(qAngleBetween(est.q, refQ) * DEG).toFixed(2)}°`;
}

// ---------- 主循环 ----------
let simAcc = 0;
let logAcc = 0;
let lastNow = performance.now();
let uiAcc = 0;
let metricsAt = 0;
let frames = 0;
let fpsAcc = 0;

// ---------- 解算调度与静止粗对准：与 runner/Worker 共用 core/solve-loop.ts ----------
// 这一段以前是主循环里自己写的一份（抽帧 + 静止检测 + 粗对准 + A/B 同步重置）。
// 两份实现会各自漂移：复核实测过 runner 把对准放在解算之前、界面放在之后——差一帧遥测，
// 批量结论就不再严格代表界面。现在两边都走同一个 SolveLoop，冒烟里用同 seed 逐帧比对守着。
const still = { chipUntil: -1 }; // 只剩「对准完成」提示条的计时，判据与状态都在 SolveLoop 里
/**
 * **最近一次解算真正喂给估计器的观测**（ROUND11 P1）。
 *
 * 为什么必须由 onSolve 写、而不是记录时重算：`logRow` 以前会用「当前」标定重算 observations，
 * 于是「算法吃的是 25、日志写 20」这类不一致无法发现；视 15 Hz 解算时，某一行甚至早于
 * 第一次解算却仍宣称有消费值。这里冻结「谁在什么时刻真正消费了什么」。
 */
const lastSolveInput = {
  /** 这一轮实验的世代（resetSim/换源都会 +1）：快照只在**同一轮**内有效（ROUND12） */
  runId: 0,
  /** 本次解算的输入时刻（估计器看到的 t） */
  t: NaN,
  /** 该时刻的源读数与校准后观测 */
  gyro: [0, 0, 0] as V3,
  accelRaw: [0, 0, 0] as V3,
  magRaw: [0, 0, 0] as V3,
  accel: [0, 0, 0] as V3,
  mag: [0, 0, 0] as V3,
};

/** 当前实验轮次（resetSim 推进）：消费快照按轮隔离 */
let solveRunId = 0;
let uiTraceEvents = { alignTimes: [] as number[], eventCounts: {} as Record<string, number> };
/** 清掉消费快照（换轮/换源/重置时调用） */
function clearSolveInput(): void {
  lastSolveInput.runId = solveRunId;
  lastSolveInput.t = NaN;
  lastSolveInput.gyro = [0, 0, 0];
  lastSolveInput.accelRaw = [0, 0, 0];
  lastSolveInput.magRaw = [0, 0, 0];
  lastSolveInput.accel = [0, 0, 0];
  lastSolveInput.mag = [0, 0, 0];
}

/** 统一的 onSolve：INS 逐子步积分 + 冻结实际消费输入（trace 换钩子时必须复用同一个） */
function onSolveDefault(ctx: { sample: ImuSample; dt: number; accel: V3; mag: V3; t: number; aligned?: boolean }): void {
  // 回放外部真值：必须取**本子步时刻**的插值真值，而不是帧末真值。
  // 这一行要在 stepIns / logRow / 误差统计之前，三者都通过 state.externalTruth 取值。
  if (replayActive()) state.externalTruth = replayTruth.at(ctx.t);
  lastSolveInput.runId = solveRunId;
  lastSolveInput.t = ctx.t;
  lastSolveInput.gyro = [...ctx.sample.gyro];
  lastSolveInput.accelRaw = [...ctx.sample.accel];
  lastSolveInput.magRaw = [...ctx.sample.mag];
  lastSolveInput.accel = [...ctx.accel];
  lastSolveInput.mag = [...ctx.mag];
  // 位置积分与姿态同帧：喂的是各算法自己的姿态估计 + 同一份实测加计读数
  stepIns(ctx.sample, ctx.dt, ctx.accel);
  if (replayActive()) {
    state.simTime = ctx.t;
    state.lastImu = ctx.sample;
    logAcc += ctx.dt;
    if (logAcc + 1e-12 >= LOG_DT) {
      logAcc %= LOG_DT; // 不积累长空洞的记录余账，也不在同一姿态伪造旧时间行
      logRow();
    }
  }
  // C/D：服务未接线时这一行只是空判断，不产生分配。
  diagnosticsApi?.sample({
    t: ctx.t,
    dt: ctx.dt,
    aligned: ctx.aligned === true,
    raw: ctx.sample,
    consumed: { gyro: ctx.sample.gyro, accel: ctx.accel, mag: ctx.mag },
  });
}

/**
 * 一行记录对应的「实际消费」快照：取最近一次解算的输入。
 * @returns null = 这一刻还没有任何解算发生过（例如回放首帧/极低解算率）——**不编造**
 */
function consumedSnapshotFor(rowT: number): ImuSample | null {
  // 跨轮隔离：resetSim 会推进 runId 并把快照清成 null，这里的双重检查防住"重置后首个记录
  // 拿到上一轮的消费值"（ROUND12 实测：旧值可跨 reset 泄漏到新轮首行）
  if (lastSolveInput.runId !== solveRunId) return null;
  if (!Number.isFinite(lastSolveInput.t)) return null;
  // 解算时刻必须不晚于本行时刻（晚于说明是"未来的输入"，不可能被这一行消费）
  if (lastSolveInput.t > rowT + 1e-9) return null;
  return {
    gyro: [...lastSolveInput.gyro],
    accel: [...lastSolveInput.accel],
    mag: [...lastSolveInput.mag],
  };
}

const serialConsumed = { count: 0, at: 0, t: 0 };
const serialConsumptionObservers: { callback: ((event: { count: number; at: number; t: number }) => void) | null } = { callback: null };

const solveLoop = new SolveLoop({
  estimators: ests,
  secondary: abState.clones,
  solveRateHz: solveState.hz,
  // 校准链读**实时状态**（勾选框可随时旁路、回放可整体绕过），与 estimate 入口保持一致
  calibrate: {
    mag: (raw) => magForEstimation(raw),
    accel: (raw) => accelForEstimation(raw),
  },
  magEnabled: ($("mag-enable") as HTMLInputElement).checked,
  autoCoarseAlign: true,
  onAlign: () => {
    still.chipUntil = performance.now() / 1000 + 3;
  },
  onSolve: onSolveDefault,
  onFrame: ({ sample, dt, t }) => {
    if (replayActive()) {
      // 源帧完成：把它的终点真值提升为下一帧的起点（真值插值的左端点）。
      replayTruth.commit();
      // 原始记录只在源帧完成时写一次，保留0dt/同时间帧，不按子步造源帧。
      recordRaw(t, sample);
      tickAccelCalibration(t, sample);
      collectMagSample(sample.mag);
      if (dt === 0) { state.lastImu = sample; state.simTime = t; }
    } else if (sourceIntent === "serial") {
      serialConsumed.count++;
      serialConsumed.at = Date.now();
      serialConsumed.t = t;
      serialConsumptionObservers.callback?.({ ...serialConsumed });
    }
  },
});
/** 界面侧的统一解算入口（真实/回放路径用）：每帧更新一次，长间隔拆子步 */
function updateEstimatorsSubstepped(sample: ImuSample, intervalSec: number, t: number): void {
  solveLoop.applyFrame(sample, intervalSec, t);
}

/** 模拟世界推进（固定步长 H）；估计器按「解算频率」抽帧更新 */
function stepSim(): boolean {
  // 闭环演示：控制器改用所选解算结果（而非真实姿态）计算跟踪误差——
  // 「估计漂多少，机体就飞偏多少」；选真实姿态或关闭开关时为理想飞控。
  const loopOn = ($("loop-toggle") as HTMLInputElement).checked;
  const fb = loopOn && state.source !== "truth" ? sourceEstimator()?.q : undefined;
  const sample = world.step(H, imuParams, fb);
  state.simTime = world.t;
  state.lastImu = sample;
  recordRaw(world.t, sample);
  tickAccelCalibration(world.t, sample);
  // 解算抽帧 + 静止检测都在 SolveLoop 里（与 runner 同一实现）：
  // 仿真保持 500 Hz 定步长，估计器每 1/f 秒才吃一次数据（dt = 累积时长）。
  const solved = solveLoop.step(sample, H, world.t);
  collectMagSample(sample.mag);
  logAcc += H;
  if (logAcc >= LOG_DT) {
    logAcc -= LOG_DT;
    logRow();
  }
  return solved;
}

/**
 * 真实串口回放：每帧**只更新一次**，dt 取固件 tick 差——
 * 这修复了两个旧版问题：① 500 Hz 主循环反复用同一帧积分（把 200 Hz 数据
 * 当 500 Hz 用），② 断流后仍拿最后一帧空转。帧率由固件决定，算法步长随之变化，
 * 与「解算频率应跟随采样率」的工程口径一致。
 */
function stepSerialPlayback(): void {
  const queue = serialState.queue;
  if (queue.length === 0) return;
  // 一次 rAF 最多消化 64 帧（约 320 ms @200 Hz）；积压更多说明页面被挂起过，
  // 多余的旧帧没有实时价值——丢弃并在状态里计数。
  let processed = 0;
  while (queue.length > 0 && processed < 64) {
    const f = queue.shift()!;
    // 真实帧间隔（不再被 50 ms 夹紧）：总时间按它推进，积分拆子步
    const interval = serialState.lastTickMs >= 0
      ? frameIntervalSec(serialState.lastTickMs, f.tickMs)
      : 0.005;
    serialState.lastTickMs = f.tickMs;
    serialState.lastDt = interval;
    const RAD2 = Math.PI / 180;
    const sample: ImuSample = {
      gyro: [f.gyroDps[0] * RAD2, f.gyroDps[1] * RAD2, f.gyroDps[2] * RAD2],
      accel: [...f.accelMs2],
      mag: [...f.magUt],
    };
    state.lastImu = sample;
    state.simTime += interval;
    updateEstimatorsSubstepped(sample, interval, state.simTime);
    recordRaw(state.simTime, sample);
    tickAccelCalibration(state.simTime, sample);
    collectMagSample(sample.mag);
    logAcc += interval;
    if (logAcc >= LOG_DT) {
      logAcc -= LOG_DT;
      logRow();
    }
    processed++;
  }
}

const { controls, quad, ghost, toDisplay } = sceneHandles;

// 整帧保护：three.js 的 onAnimationFrame 先调回调、后调度下一帧，
// 回调里任何未捕获异常都会让渲染循环永久停摆（只能刷新页面）。这里统一兜底。
function tick(): void {
  try {
    frame();
  } catch (err) {
    setPlaying(false);
    showSimError(err);
  }
}
/** 帧循环驱动：有渲染器就用它的 setAnimationLoop；WebGL 不可用时退回 rAF，
 *  这样曲线/统计/文档演示在无 3D 环境下仍然运转。 */
(function driveFrame() {
  const r = sceneHandles.renderer;
  if (r && typeof r.setAnimationLoop === "function") r.setAnimationLoop(tick);
  else requestAnimationFrame(function loop() { tick(); requestAnimationFrame(loop); });
})();

const framePerformance = { count: 0, max: { simulation: 0, scene: 0, ui: 0, metrics: 0, frame: 0 } };
function frame(): void {
  const now = performance.now();
  let phaseAt = now;
  const markPhase = (key: keyof typeof framePerformance.max): void => {
    const at = performance.now();
    framePerformance.max[key] = Math.max(framePerformance.max[key], at - phaseAt);
    phaseAt = at;
  };
  const rawDt = (now - lastNow) / 1000;
  // 两条时间轴：
  //  · dt    —— 物理/仿真步长上限 50 ms（防止卡顿后一步跳太远）
  //  · dtAnim—— 纯动画时间轴（万向节演示、四元数播放、相机过渡），上限 250 ms。
  //    用 dt 驱动动画会让低帧率机器上的 14 秒演示播成 28 秒（实测踩到过）。
  const dt = Math.min(rawDt, 0.05);
  const dtAnim = Math.min(rawDt, 0.25);
  lastNow = now;
  docDemos?.step(dt); // 文档页动画演示（按需加载；未就绪时跳过）

  frames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    $("fps").textContent = `${Math.round(frames / fpsAcc)} fps`;
    frames = 0;
    fpsAcc = 0;
  }

  // 万向节锁演示独立于仿真，暂停时也能演示
  stepDemo(dtAnim);
  stepQuatPlay(dtAnim);
  stepQuatProj(dtAnim);
  stepQuatFades(dtAnim);
  stepQuatCamTween(dtAnim);
  sceneHandles.gimbal.step(dtAnim);

  if (state.playing) {
    if (reconnectPending()) {
      // 断线重连的过渡态：**冻结**整条数据流。
      // 复核反例：旧实现里断链让 `state.real=false`，主循环随即按 simulation 分支跑 `stepSim()`，
      // 于是真实数据的记录里混进模拟 IMU，时钟也从 24 s 掉到 0.002 s。
      // 这里什么都不推进（时钟/曲线/统计保持原样），直到重连成功或彻底放弃。
      state.lastImu = null;
    } else if (state.real) {
      // 真实数据有自己的时钟：按帧到达节奏推进，不再走 500 Hz 固定步长。
      // 离线回放走同一条路，只是数据来自文件且节奏由「倍速」缩放。
      if (replayActive()) stepReplayPlayback(dtAnim);
      else stepSerialPlayback();
    } else {
      simAcc += dt;
      if (simAcc > 0.25) simAcc = 0.25; // 标签页隐藏后恢复时，最多补 0.25s，避免疯狂快进
      while (simAcc >= H) {
        stepSim();
        simAcc -= H;
      }
    }
    for (const model of [quad, sceneHandles.gimbal.quad]) {
      model.props.forEach((p, i) => (p.rotation.y += (i % 2 ? 1 : -1) * 30 * dt));
    }
  }

  markPhase("simulation");
  const review = diagnosticsApi?.reviewOverride() ?? null;
  const q = review ? review.q : selectedQ();
  quad.group.quaternion.copy(toDisplay(q));
  // 真实模式无真值基准：幻影隐藏（它显示的是模拟剧本的姿态，与真实机体无关）
  // 幻影显示的是模拟世界的真值姿态：只有模拟模式有意义（外部真值回放不画，用它只会显示陈旧模拟姿态）
  ghost.group.visible = review
    ? review.truthQ !== null && state.view === "attitude"
    : !state.real && state.view === "attitude" && ($("ghost-toggle") as HTMLInputElement).checked;
  ghost.group.quaternion.copy(toDisplay(review?.truthQ ?? world.q));

  // 磁航向箭头：世界系水平箭头（挂 scene，不随机体姿态旋转），指向估计姿态
  // 的机头方位在水平面上的投影。四轴姿态视图可见；显示真实姿态时隐藏（无解算）。
  sceneHandles.headingArrow.visible = state.view === "attitude" && state.source !== "truth";
  if (sceneHandles.headingArrow.visible) {
    const eu = qToEuler(q);
    // 显示坐标：北=+X、东=+Z、上=+Y；NED 偏航 ψ（绕 z 下正转）在显示系是绕 +Y 的 −ψ
    sceneHandles.headingArrow.setDirection(
      new Vector3(Math.cos(eu.yaw), 0, Math.sin(eu.yaw)),
    );
  }

  // 等效旋转轴（轴角表示，青色）：q 的世界系固定旋转轴，长度随转角缩放。
  // q 与 −q 同轴同角（qToAxisAngle 落短路径）；显示真实姿态时无解算意义，隐藏。
  const axisToggle = $("axis-toggle") as HTMLInputElement;
  sceneHandles.axisArrow.visible =
    state.view === "attitude" && axisToggle.checked && state.source !== "truth";
  if (sceneHandles.axisArrow.visible) {
    const { axis, angle } = qToAxisAngle(q);
    if (angle < 0.02) {
      sceneHandles.axisArrow.visible = false; // 近零旋转：轴无定义，藏起避免误导
    } else {
      const d = toDisplayVec(axis);
      sceneHandles.axisArrow.setDirection(new Vector3(d[0], d[1], d[2]).normalize());
      sceneHandles.axisArrow.setLength(1.0 + 0.5 * (angle / Math.PI), 0.12, 0.07);
    }
  }

  controls.update();
  sceneHandles.renderer?.render(sceneHandles.scene, sceneHandles.camera);
  markPhase("scene");

  uiAcc += dt;
  if (uiAcc >= 0.1) {
    uiAcc = 0;
    updateReadouts();
    diagnosticsApi?.update();
    updateLegendValues();
    if (state.view === "gimbal") updateGimbalUi();
    updateTelemetry();
    if (chartState.att) attChart.render();
    if (chartState.err) errChart.render();
    if (chartState.imu) imuChart.render();
    updateSerialStatus();
    updateReplayStatus();
    drawIns();
    updateHash();
  }
  markPhase("ui");
  // 评测表/校准面板按**墙钟** 2 Hz 刷新（旧写法把 dt 累加在 10 Hz UI 块里，
  // 每 0.1 s 只加一帧的 16 ms，实际刷新慢了 6 倍）
  if (now - metricsAt >= 500) {
    metricsAt = now;
    updateMetricsTable();
    updateMagCalUi();
    updatePanelSummaries();
    updateChartSummaries();
    updateChartTables();
    updateInsReadout();
    updateChallengeUi();
  }
  markPhase("metrics");
  framePerformance.count++;
  framePerformance.max.frame = Math.max(framePerformance.max.frame, performance.now() - now);
}

// ---------- 文档页（左模块导航 + 中内容 + 右「本页目录」；按页记忆滚动位置） ----------
const docsOverlay = document.getElementById("docs-overlay")!;
/**
 * 模块目录的折叠外壳（SW-11）：窄屏默认收起，让首屏先看到正文。
 * 用 `<details>` 原生折叠——键盘 Enter/Space 可开合、读屏能读到展开状态，不需要自绘交互。
 */
const tocDisclosure = document.getElementById("toc-disclosure") as HTMLDetailsElement | null;
const tocCurrent = document.getElementById("toc-current");
const docsNarrow = (): boolean => window.matchMedia("(max-width: 860px)").matches;
if (tocDisclosure && docsNarrow()) tocDisclosure.open = false;
const docPagesEl = document.querySelector<HTMLElement>(".doc-pages")!;
const chapterToc = document.getElementById("docs-chapter-toc")!;
const docModuleBtns = [...document.querySelectorAll<HTMLButtonElement>(".docs-toc .module-link")];
const docPageEls = [...document.querySelectorAll<HTMLElement>(".doc-page")];

/**
 * 页面 → 所属大模块。四个「完整推导」独立页归滤波算法讲解；
 * 其余页面与模块同名（新增模块只需在这里登记一次）。
 */
const DOC_MODULE_OF: Record<string, string> = {
  manual: "manual",
  math: "math",
  "math-topics": "math-topics",
  filters: "filters",
  "f-comp-detail": "filters",
  "f-mahony-detail": "filters",
  "f-madg-detail": "filters",
  "f-kalman-detail": "filters",
  labs: "labs",
  guide: "guide",
  magcal: "guide", // 磁力计校准在「硬件与固件」模块下（真机接入流程的一部分）
  trouble: "trouble",
  glossary: "glossary",
  refs: "refs",
  about: "about",
};
function docModuleOf(page: string): string {
  return DOC_MODULE_OF[page] ?? page;
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
      // data-toc 提供目录友好的纯文本（标题里的点/帽/分数等排版记号在纯文本里会退化）
      const text = el.dataset.toc || head?.textContent?.trim() || "";
      if (head && text) items.push({ id: el.id, text, sub: head.tagName === "H3" });
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
  let activeBtn: HTMLButtonElement | null = null;
  for (const b of docModuleBtns) {
    const on = b.dataset.doc === docModuleOf(id);
    b.classList.toggle("active", on);
    if (on) activeBtn = b;
  }
  // 窄屏折叠条上要能读出现在在哪一页（只显示"文档模块"等于把导航藏起来又不说在哪）
  if (activeBtn && tocCurrent) tocCurrent.textContent = activeBtn.querySelector(".mod-name")?.textContent?.trim() ?? "";
  buildChapterToc(page);
  docPagesEl.scrollTop = restore ? (docScrollMemory.get(id) ?? 0) : 0;
  void ensureDocDemos().then(() => docDemos?.refresh());
}

let docsPrevFocus: HTMLElement | null = null;
function setDocsOpen(open: boolean): void {
  if (open === !docsOverlay.hidden) return;
  docsOverlay.hidden = !open;
  if (open) {
    docsPrevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    showDocPage(activeDocPage, true);
    // 对话框焦点入口：读屏用户不会在打开后仍停在背景按钮上
    $("btn-docs-close").focus();
  } else {
    docScrollMemory.set(activeDocPage, docPagesEl.scrollTop);
    document.body.style.overflow = "";
    // 焦点回到打开文档前的控件；若是程序化打开（activeElement=body）则回到「文档」按钮
    const back = docsPrevFocus && docsPrevFocus !== document.body ? docsPrevFocus : $<HTMLButtonElement>("btn-docs");
    back.focus();
    docsPrevFocus = null;
  }
  void ensureDocDemos().then(() => docDemos?.refresh());
}

/** 文档对话框内的 Tab 循环（aria-modal 的配套实现） */
function trapDocsFocus(e: KeyboardEvent): void {
  if (docsOverlay.hidden || e.key !== "Tab") return;
  const focusables = [
    ...docsOverlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.getClientRects().length > 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
// 窄屏选中模块后自动收起目录：否则每次切页都要手动关一次
if (tocDisclosure) tocDisclosure.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest(".module-link") && docsNarrow()) tocDisclosure.open = false;
});
$("btn-docs").addEventListener("click", () => setDocsOpen(true));
$("btn-docs-close").addEventListener("click", () => setDocsOpen(false));
// 指针点击按钮后释放焦点：否则之后按空格会被浏览器原生"激活该按钮"吞掉——
// 空格本应是全局暂停/继续，实际却重复点击了上次点过的 tab/按钮（如「俯仰」）；
// 而且一旦按键，Chrome 会把该按钮升级成 :focus-visible，亮出焦点环。
// 捕获阶段统一处理，按钮自己的 click 处理器不受影响；键盘激活
// （Enter/Space，detail === 0）不移焦点，可访问性保持不变。
document.addEventListener("click", (e) => {
  if (e.detail <= 0) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button");
  if (button instanceof HTMLElement) button.blur();
}, true);
window.addEventListener("keydown", (e) => {
  // Ctrl/⌘ + K：任何位置都能唤起文档搜索（文档层没开就顺便打开）
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    setDocsOpen(true);
    requestAnimationFrame(() => {
      const si = document.getElementById("docs-search-input") as HTMLInputElement | null;
      si?.focus();
      si?.select();
    });
    return;
  }
  // 导出对话框（原生 <dialog>）打开时让位：Esc 由它自己处理，
  // 否则同一次 Esc 会既关弹窗又去关文档层或触发别的快捷键。
  if ((document.getElementById("export-dialog") as HTMLDialogElement | null)?.open) return;
  trapDocsFocus(e);
  if (e.defaultPrevented) return;
  if (e.key === "Escape") {
    if (!docsOverlay.hidden) {
      e.preventDefault();
      setDocsOpen(false);
    }
    return;
  }
  if (!docsOverlay.hidden) return; // 文档打开时只响应 Esc（避免误触后台快捷键）
  const target = e.target;
  // 按键守卫分两级：
  //  · 文本/下拉/滑块类控件聚焦时，所有单键快捷键都让位（否则打字/调值会被劫持）；
  //  · 按钮/链接聚焦时只让位「空格」（空格本来就是激活按钮），其余快捷键照常——
  //    否则从文档返回后焦点停在「文档」按钮上，1/2/3 会全部失灵（实测踩到过）。
  // target 可能不是 Element（window/document 上派发的合成事件），不能直接 .matches()
  if (target instanceof Element) {
    if (target.matches("input, select, textarea, [contenteditable='true']")) return;
    if (e.key === " " && target.matches("button, a")) return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      setPlaying(!state.playing);
      break;
    case "r":
    case "R":
      resetSim();
      toast("已重置：估计器、曲线与统计归零");
      break;
    case "1":
      userSelectView("attitude");
      break;
    case "2":
      userSelectView("gimbal");
      break;
    case "3":
      userSelectView("quat");
      break;
    case "d":
    case "D":
      setDocsOpen(true);
      break;
    case "g":
    case "G":
      // 引导课程：停在课程中时再按一次 = 退出（避免只能靠鼠标点小叉）
      if (tour?.active()) tour.exit();
      else void ensureTour().then((t) => t.start()).catch(() => {});
      break;
    case "?":
      toast("快捷键：空格 暂停/继续 · R 重置 · 1/2/3 切视图 · D 文档 · G 引导课程 · Ctrl/⌘+K 搜索");
      break;
    default:
      break;
  }
});

/* ==========================================================================
   公式块一键复制
   --------------------------------------------------------------------------
   文档里的公式是 Unicode 纯文本（.formula 就是 pre-wrap 的文本块），所以「复制」很有意义：
   读者可以把推导直接粘进笔记 / Matlab / Python 当注释。用 Clipboard API，
   失败时（非安全上下文或用户拒绝权限）降级为「选中这段文本」让读者自己 Ctrl+C。
   ========================================================================== */
function initFormulaCopy(): void {
  const copy = createFormulaCopy({
    // 在点击时访问 API：保留用户激活，同时捕获缺方法/getter/同步调用异常。
    writeText: (text) => navigator.clipboard.writeText(text),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
  });
  const labels = {
    idle: "复制", pending: "复制中…", copied: "已复制",
    selected: "已选中，请按 Ctrl+C", manual: "请手动选中并按 Ctrl+C",
  };
  for (const block of document.querySelectorAll<HTMLElement>(".doc-page .formula")) {
    if (block.querySelector(".formula-copy")) continue;
    // 仅包裹原节点，保留数学标记和 inline 布局；反馈是正文的兄弟，永不进入复制/选区。
    const body = document.createElement("span");
    body.className = "formula-body";
    body.tabIndex = -1;
    body.append(...block.childNodes);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "formula-copy";
    btn.textContent = labels.idle;
    btn.dataset.copyState = "idle";
    btn.title = "复制这段公式（Unicode 文本）";
    btn.setAttribute("aria-live", "polite");
    const target = {
      readText: () => formulaText(body),
      select: () => selectFormulaText(body),
      show(state: keyof typeof labels): void {
        btn.textContent = labels[state];
        btn.dataset.copyState = state;
        btn.style.opacity = state === "idle" ? "" : "1";
      },
    };
    btn.addEventListener("click", () => copy.copy(target));
    block.replaceChildren(body, btn);
  }
}
initFormulaCopy();

/** 统一的文档内锚点跳转：目标在当前页 → 平滑滚动；在别的页 → 先切页再滚 */
function jumpToHash(target: HTMLElement): void {
  const page = target.closest(".doc-page") as HTMLElement | null;
  if (page && page.dataset.docPage !== activeDocPage) showDocPage(page.dataset.docPage!);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ==========================================================================
   文档全文搜索
   --------------------------------------------------------------------------
   文档总量已经到 23 万字节、13 个分页、60+ 章节——没有检索就只能靠翻。
   索引在第一次搜索时才构建（遍历 13 个页面的文本，几毫秒），之后常驻内存。
   结果项记录了「页码 + 章节 id」，点击直接复用现成的 showDocPage + jumpToHash，
   因此与左栏目录、右栏本页目录完全同源，不会出现第二套跳转逻辑。
   ========================================================================== */

/**
 * 文档全文搜索（SW-12 拆出到 `ui/doc-search.ts`）：索引/打分/片段/HTML 都在那边是纯函数，
 * 这里只做装配——什么时候建索引、怎么把结果写进容器、按键怎么走。
 */
let docBlocks: DocBlock[] | null = null;

function ensureDocIndex(): DocBlock[] {
  if (!docBlocks) docBlocks = buildDocIndex(docPageEls);
  return docBlocks;
}

const searchInput = document.getElementById("docs-search-input") as HTMLInputElement | null;
const searchHits = document.getElementById("docs-search-hits");

function renderSearchHits(query: string): void {
  if (!searchInput || !searchHits) return;
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    searchHits.classList.add("hidden");
    searchHits.innerHTML = "";
    return;
  }
  const hits = searchDocBlocks(ensureDocIndex(), q);
  searchHits.classList.remove("hidden");
  searchHits.innerHTML = hitsHtml(hits, q);
}

/** 点击结果：切到该页并滚到对应章节（复用统一的锚点跳转） */
searchHits?.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".dsh-item");
  if (!item) return;
  const page = item.dataset.page ?? "";
  const secId = item.dataset.sec ?? "";
  showDocPage(page);
  const target = secId ? document.getElementById(secId) : null;
  if (target) {
    jumpToHash(target);
  } else {
    docPagesEl.scrollTop = 0;
  }
  if (searchInput) searchInput.blur();
});

searchInput?.addEventListener("input", () => renderSearchHits(searchInput.value));
searchInput?.addEventListener("keydown", (e) => {
  const items = [...(searchHits?.querySelectorAll<HTMLElement>(".dsh-item") ?? [])];
  const cur = items.findIndex((el) => el.getAttribute("aria-selected") === "true");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = movedSelection(cur, items.length, e.key);
    if (next < 0) return;
    items.forEach((el, i) => el.setAttribute("aria-selected", String(i === next)));
    items[next]?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const pick = items[Math.max(0, cur)] ?? items[0];
    pick?.click();
    return;
  }
  if (e.key === "Escape") {
    // 第一次 Esc 只清搜索框，再按才由文档层的 Esc 处理（关闭文档）
    if (searchInput.value) {
      e.stopPropagation();
      searchInput.value = "";
      renderSearchHits("");
      searchInput.blur();
    }
  }
});
// 聚焦到搜索框时把已有结果带回来（从别处回来接着改）
searchInput?.addEventListener("focus", () => renderSearchHits(searchInput.value));
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

/**
 * 应用界面里的「见文档·…」链接（a[data-doc-open]）。
 * 为什么需要单独一条通路：文档内的锚点跳转是委托在 docPagesEl / chapterToc 上的，
 * 而面板里的链接不在那个容器里，事件不会冒泡过去——实测「点了完全没反应」。
 * 这里显式打开文档层并切页；href 保留，htmlcheck 的锚点契约因此仍会校验目标是否存在。
 */
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement)?.closest<HTMLAnchorElement>("a[data-doc-open]");
  if (!a) return;
  e.preventDefault();
  const page = a.dataset.docOpen!;
  const anchorId = a.hash ? a.hash.slice(1) : "";
  setDocsOpen(true);
  showDocPage(page);
  if (anchorId) {
    const el = document.getElementById(anchorId);
    // 切页后章节位置要等布局稳定；直接滚会按旧布局算
    if (el) requestAnimationFrame(() => jumpToHash(el));
  }
});

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

/** 空闲预取：优先让浏览器选择空闲时机；不支持时退到有界延时，不抢首屏关键路径。 */
function idlePrefetch(run: () => void, delayMs: number): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, delayMs);
}

/** 懒装配骨架：已挂载直接返回；装载失败则清缓存 Promise、报告原因并继续向上抛。 */
function lazyMount<T>(mount: () => Promise<T>, report: (err: unknown) => void): (api: T | null) => Promise<T> {
  let load: Promise<T> | null = null;
  return (api) => {
    if (api) return Promise.resolve(api);
    return load ??= mount().catch((err) => { load = null; report(err); throw err; });
  };
}
function lazyFailure(label: string): (err: unknown) => void {
  return (err) => toast(`${label}：${errorText(err)}${lazyOfflineHint}`, "#f85149");
}
function idleLoad(ensure: () => Promise<unknown>, delayMs: number): void {
  idlePrefetch(() => void ensure().catch(() => {}), delayMs);
}

/* ==========================================================================
   文档内交互演示（互补滤波三路对比 / 旋转顺序 / 校准舞蹈 / Allan 方差 /
   一维卡尔曼 / 互补频域）
   --------------------------------------------------------------------------
   实现全部在 ui/doc-demos.ts；这里只提供一条上下文「文档层是否停在该页」，
   以及文档开合 / 翻页后的刷新钩子（docDemos.refresh）。
   ========================================================================== */

/**
 * 文档页动画演示**按需加载**（ROUND12 的体积契约）。
 *
 * 它是主包里最大的一块纯展示代码（约 12.8 KB gzip），而模拟器本身完全不需要它：
 * 只有打开文档层、翻到带演示画布的分页时才用得上。改成动态 import 之后，
 * 首屏主包回到原来的体积线以内（详见 `npm run budget` 的「首屏主包」与
 * 「全部 JS 合计」两条约束——后者保证按需 chunk 同样被封顶，不会让代码"溜出"预算）。
 * 启动后空闲时预取一次，因此第一次打开文档时不会有等待感。
 */
let docDemos: DocDemos | null = null;
let docDemosLoading: Promise<void> | null = null;
function ensureDocDemos(): Promise<void> {
  if (docDemos) return Promise.resolve();
  if (!docDemosLoading) {
    docDemosLoading = import("./ui/doc-demos")
      .then(({ initDocDemos }) => {
        docDemos = initDocDemos({ isVisible: (page) => !docsOverlay.hidden && activeDocPage === page });
        void ensureDocDemos().then(() => docDemos?.refresh());
      })
      .catch(() => {
        /* 按需 chunk 加载失败：演示画布保持空白，不影响解算与其它功能 */
        docDemosLoading = null;
      });
  }
  return docDemosLoading ?? Promise.resolve();
}
// 空闲预取：不抢占首屏关键路径，但第一打开文档时已就绪
if (typeof requestIdleCallback === "function") requestIdleCallback(() => void ensureDocDemos());
else setTimeout(() => void ensureDocDemos(), 1200);

/* ==========================================================================
   引导课程：13 步顺序走完全部教学内容
   --------------------------------------------------------------------------
   步骤文案在 public/data/tour.json（TS 真源在 scripts/emit-catalog.ts），
   DOM 驱动在 ui/tour.ts。这里负责取步骤、懒加载 UI chunk，并把三个「本模块办不到」
   的动作接上：装载实验、打开文档、弹提示。刻意不引入 localStorage 之类的首次访问
   标记——本装置不落地任何持久状态（分享靠 URL 深链，见「深链分享」）。
   ========================================================================== */

/*
 * 引导课程**按需加载**：13 步文案不再进 JS 包，而是和实验/挑战一样取 data/tour.json；
 * UI chunk 只剩 DOM 驱动代码。首次点击由捕获阶段处理器负责「先取数据与模块、再启动」；
 * 加载完成后 mountTour 自己绑定的处理器接管按钮。
 */
type TourApi = import("./ui/tour").Tour;
let tour: TourApi | null = null;
let tourLoad: Promise<TourApi> | null = null;
let tourSteps: readonly TourStep[] | null = null;
let tourStepsLoad: Promise<readonly TourStep[]> | null = null;
function ensureTourSteps(): Promise<readonly TourStep[]> {
  if (tourSteps) return Promise.resolve(tourSteps);
  if (!tourStepsLoad) {
    tourStepsLoad = fetchCatalog("tour.json", parseTourCatalog)
      .then((steps) => (tourSteps = steps))
      .catch((err: unknown) => {
        tourStepsLoad = null; // 允许重试（例如离线时 JSON 没取到）
        throw err;
      });
  }
  return tourStepsLoad;
}
async function applyExperimentById(id: string): Promise<void> {
  await catalogsReadyPromise;
  const spec = EXPERIMENTS.find((e) => e.id === id);
  if (!spec) {
    console.warn(`实验引用不存在：${id}`);
    toast(`实验不存在：${id}`, "#f85149");
    return;
  }
  applyExperiment(spec);
}
const tourHost = {
  applyExperiment: applyExperimentById,
  openDocs: (page: string, anchor?: string): void => {
    showDocPage(page);
    if (anchor) {
      const el = document.getElementById(anchor);
      if (el) el.scrollIntoView({ block: "start" });
    }
  },
  toast: (msg: string): void => toast(msg),
  onStep: (step: { id: string; title: string; look: string }, index: number, total: number) => {
    setTaskContext({
      kind: "tour",
      id: step.id,
      title: `引导课程：${step.title}`,
      conditions: `第 ${index + 1}/${total} 步 · 按步骤自动装载现场`,
      variable: "按课程顺序观察，不要求改参数",
      observe: step.look,
      next: "按卡片「下一步」；可随时退出课程回到自由探索。",
      allowedIds: [],
    });
  },
  onExit: () => {
    if (taskStripApi?.state().task?.kind === "tour") setTaskContext(null);
  },
};
function ensureTour(): Promise<TourApi> {
  if (tour) return Promise.resolve(tour);
  if (!tourLoad) {
    // 数据与 UI chunk 并行取；任一失败都走同一个错误出口。
    tourLoad = Promise.all([import("./ui/tour"), ensureTourSteps()])
      .then(([{ mountTour }, steps]) => (tour = mountTour(tourHost, steps)))
      .catch((err: unknown) => {
        tourLoad = null; // 允许重试（例如离线时 chunk 没取到）
        toast(`引导课程加载失败：${errorText(err)}`, "#f85149");
        throw err;
      });
  }
  return tourLoad;
}
// 首次点击：模块还没加载，本次事件派发中新增的监听器不会被调用——这里自己接手启动。
document.getElementById("tour-start")?.addEventListener("click", (ev) => {
  if (tour) return; // 已加载：交给 mountTour 的处理器，行为与旧实现一致
  ev.stopImmediatePropagation();
  // 冷加载要下载 chunk：先给即时反馈，避免点击后一两秒没反应被当成没点上
  toast("正在加载引导课程…");
  void ensureTour().then((t) => t.start()).catch(() => {});
}, true);


// ---------- 深链分享：面板状态 ↔ URL hash（#s=base64(json)） ----------
const DEEP_KEYS = [
  "imu-gyro-bias", "imu-gyro-noise", "imu-gyro-walk", "imu-accel-noise", "imu-cross-axis",
  "imu-accel-nonlin", "imu-lin-accel", "imu-vibration", "imu-mag-noise", "imu-mag-quant",
  "imu-mag-disturb", "imu-hard-iron", "imu-soft-iron", "mahony-kp", "mahony-ki", "madg-beta", "comp-alpha",
  "kalman-proc", "kalman-obs", "man-roll", "man-pitch", "man-yaw", "quat-t",
  "gate-deg", "gate-mag", "imu-gyro-scale", "imu-gyro-misalign", "imu-delay", "experiment-seed",
  "imu-bandwidth", "imu-delay-skew", "imu-sample-rate",
  // 万向节锁演示的三个环角：分享「俯仰 90° 锁死」那一屏必须带上，否则同学打开是 0°/0°/0°
  "gim-roll", "gim-pitch", "gim-yaw",
];
const DEEP_CHECKS = [
  "mag-enable", "gate-toggle", "gate-recovery", "ghost-toggle", "telemetry-toggle", "axis-toggle",
  "init-offset-toggle", "ab-toggle", "loop-toggle", "palette-toggle", "ins-toggle", "serial-autoreconnect",
  // q/−q 是四元数视图的一个独立子模式；MAVLink 取反开关决定三轴符号——都要跟着链接走
  "quat-neg-toggle", "serial-invert", "kalman-reset-cov", "raw-record-toggle",
];
const DEEP_SELS = [
  "scenario-select", "source-select", "quat-mode", "quat-pair-select", "imu-preset",
  "mag-mode", "solve-rate", "imu-gyro-range", "serial-baud", "serial-mounting", "ins-scale", "kalman-gate", "batch-runs", "ab-mode", "magcal-model",
  // 协议最重要：同样的字节流，二进制/文本/MAVLink 解析结果完全不同，协议没带过去
  // 就不是「看起来不对」而是直接 0 帧或乱码
  "serial-protocol",
];
let lastHash = "";

function deepHash(): string {
  const o: Record<string, unknown> = { v: 2, view: state.view };
  for (const k of DEEP_KEYS) o[k] = ($<HTMLInputElement>(k))?.value;
  for (const k of DEEP_CHECKS) o[k] = ($<HTMLInputElement>(k))?.checked;
  for (const k of DEEP_SELS) o[k] = ($<HTMLSelectElement>(k))?.value;
  // 布局状态也进深链：曲线面板开合（3 位）+ 收起的分区列表（短字符串）
  o.charts = CHART_KEYS.map((k) => (chartState[k] ? 1 : 0)).join("");
  o.panels = panelSections
    .filter((sec) => sec.classList.contains("collapsed"))
    .map((sec) => sec.dataset.section)
    .join(",");
  return `#s=${b64urlEncode(JSON.stringify(o))}`;
}

function applyDeepLink(): void {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return;
  try {
    // 兼容三代编码：v2 base64url、旧版未编码 base64、外链 URL 编码 base64
    const raw = m[1];
    const json = (() => {
      try {
        return b64urlDecode(raw);
      } catch {
        return decodeURIComponent(escape(atob(decodeURIComponent(raw))));
      }
    })();
    const o = JSON.parse(json) as Record<string, unknown>;
    // 逐键容错：整体只包一个 try/catch 时，**任何**一键抛错都会让后面所有项静默不还原
    // （实测过：source-select 被写成不存在的值时抛 TypeError，view/panels/charts 全部丢失）。
    const each = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        console.warn("深链还原跳过一项：", err);
      }
    };
    for (const k of DEEP_KEYS) {
      const el = $<HTMLInputElement>(k);
      const v = o[k];
      if (v === undefined || !el) continue;
      each(() => {
        el.value = String(v);
        el.dispatchEvent(new Event("input"));
        // 实验种子监听 change（避免每敲一个数字就重置）；深链还原时补一次 change
        if (k === "experiment-seed") el.dispatchEvent(new Event("change"));
      });
    }
    for (const k of DEEP_CHECKS) {
      const el = $<HTMLInputElement>(k);
      if (o[k] === undefined || !el) continue;
      each(() => {
        el.checked = Boolean(o[k]);
        el.dispatchEvent(new Event("change"));
      });
    }
    for (const k of DEEP_SELS) {
      const el = $<HTMLSelectElement>(k);
      const v = o[k];
      if (v === undefined || !el) continue;
      each(() => {
        // 白名单：值必须真的存在于选项里，否则 el.value 会被置成 ""。
        // 对 solve-rate 这种「空值 → 0 Hz → 估计器永久冻结且不报错」的控件，
        // 静默冻结比报错难查得多；跨版本分享链接与手改 URL 都会踩到。
        const value = String(v);
        if (![...el.options].some((op) => op.value === value)) {
          console.warn("深链里的选项不存在，已跳过：", k, value);
          return;
        }
        el.value = value;
        el.dispatchEvent(new Event("change"));
      });
    }
    // 姿态对切换会把插值进度重置为 0；深链里的 t 要重新写一次才算真正还原
    if (o["quat-t"] !== undefined) {
      const el = $<HTMLInputElement>("quat-t");
      el.value = String(o["quat-t"]);
      el.dispatchEvent(new Event("input"));
    }
    // 曲线面板开合（"101" = 姿态角+IMU 展开、误差收起）
    const chartsSpec = o.charts;
    if (typeof chartsSpec === "string" && /^[01]{3}$/.test(chartsSpec)) {
      CHART_KEYS.forEach((k, i) => (chartState[k] = chartsSpec[i] === "1"));
      layoutCharts();
    }
    // 收起的分区列表
    if (typeof o.panels === "string") {
      const collapsed = new Set(o.panels.split(",").filter(Boolean));
      for (const sec of panelSections) setSectionOpen(sec, !collapsed.has(sec.dataset.section ?? ""));
    }
    if (o.view === "attitude" || o.view === "gimbal" || o.view === "quat") {
      applyView(o.view);
    }
  } catch {
    /* 无效 hash：静默忽略，按默认状态运行 */
  }
}

function updateHash(): void {
  // 四元数插值播放时 quat-t 每帧都在变：停止期间才写 hash，避免 10 Hz 的
  // history.replaceState（部分浏览器会对其限流/记录诊断信息）
  if (quatState.playing) return;
  const h = deepHash();
  if (h === lastHash) return;
  lastHash = h;
  history.replaceState(null, "", h);
}

function toast(text: string, color = "#7ee787"): void {
  // 档案探测阶段禁止弹提示：写控件会触发 onImuManual → warnIfCalibrationStale 之类的
  // "顺带提示"，而此刻还没决定是否接受这份档案。导入自己的提示在决策**之后**才发。
  if (archiveProbeDepth > 0) return;
  toastSeq++; // 单调计数：自动化用它判断"这次导入有没有留下提示"（不依赖提示的存活时间）
  const chip = document.createElement("div");
  chip.className = "ov-chip";
  chip.style.color = color;
  chip.textContent = text;
  (document.getElementById("toast-layer") ?? $("readout-overlay")).appendChild(chip);
  setTimeout(() => chip.remove(), 2400);
}

// ---------- 数据导出：弹窗与 CSV 序列化按需加载，主包只保留装配依赖 ----------
const lazyOfflineHint = "。若当前离线且该模块尚未缓存，请联网后重试";
type ExportDialogApi = { open(): void };
let exportDialogApi: ExportDialogApi | null = null;
const loadExportDialog = lazyMount(() => import("./ui/export-dialog")
  .then(({ createExportDialog }) => {
    exportDialogApi = createExportDialog({
    logRows: () => logRows,
    rawRecord: () => rawRecord,
    state: () => state,
    estimatorIds: () => ests.map((e) => e.id),
    comp: () => comp,
    mahony: () => mahony,
    madg: () => madg,
    kalman: () => kalman,
    imuParams: () => imuParams,
    solveState: () => solveState,
    insState: () => insState,
    scenarioSelect: () => scenarioSelect,
    experimentConfig: () => experimentConfig,
    dataSourceLabel,
    hasGroundTruth,
    currentReferenceKind,
    logRowCap: () => LOG_ROW_CAP,
    toast,
    downloadExport,
  });
    return exportDialogApi;
  }), lazyFailure("导出模块加载失败"));
document.getElementById("btn-export")?.addEventListener("click", () => {
  void loadExportDialog(exportDialogApi).then((api) => api.open()).catch(() => { /* 已提示 */ });
});

$("btn-share").addEventListener("click", async () => {
  const h = deepHash();
  history.replaceState(null, "", h);
  lastHash = h;
  try {
    await navigator.clipboard.writeText(location.href);
    toast("链接已复制——粘给同学即可复现这套参数与场景");
  } catch {
    toast("复制失败：请手动复制地址栏链接", "#f85149");
  }
});

// ---------- PWA：生产环境注册 Service Worker（联网访问一次后可离线使用） ----------
// 更新不由 worker 自动 skipWaiting：页面发现 waiting worker 后展示持久横幅，用户点击才确认接管。
// 首次访问的离线承诺只在 SW 接管后的空闲预热完成时成立；预热只取懒模块，不挂载、不采样。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const preheat = (): void => idlePrefetch(() => void Promise.allSettled([
      import("./ui/telemetry-diagnostics-ui"),
      import("./ui/export-dialog"),
    ]), 1200);
    let awaitUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!awaitUpdate) return;
      awaitUpdate = false;
      location.reload();
    });
    navigator.serviceWorker.register("/sw.js").then((registration) => {
      const banner = $<HTMLElement>("sw-banner");
      const button = $<HTMLButtonElement>("sw-update");
      // 横幅必须绑定 waiting worker 的真实存在：updatefound 在安装失败（→ redundant）时同样会触发，
      // 那一刻把横幅挂上去就再也消不掉，点击也是空操作（2026-11-20 线上部署窗口实测踩中）。
      const syncBanner = (): void => {
        banner.hidden = !registration.waiting || !navigator.serviceWorker.controller;
      };
      button.addEventListener("click", () => {
        const w = registration.waiting;
        if (w) {
          awaitUpdate = true;
          w.postMessage("SKIP_WAITING");
        } else {
          // 没有 waiting worker：静默无意义，主动重新检查一次更新（装成功横幅会再出现）。
          void registration.update();
        }
      });
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", syncBanner);
      });
      syncBanner();
      void navigator.serviceWorker.ready.then(preheat);
    }).catch(() => {
      /* SW 不可用不影响功能 */
    });
  });
}

/* ==========================================================================
   惯性导航：姿态 → 速度 → 位置（误差按三次方增长）
   --------------------------------------------------------------------------
   每种算法一条独立的积分器，喂的是**它自己的姿态估计**与同一份实测加速度计读数，
   于是「姿态错多少」直接翻译成「位置漂多远」。本装置不模拟平动，真值位置恒在原点，
   所以图上任何偏移都是解算误差与观测污染造成的。

   教学结论（自检与文档都引用这组数）：陀螺零偏 1°/s、30 s 后——
   纯陀螺积分漂 ~700 m、互补 66 m、Mahony 44 m、Madgwick 5.5 m、卡尔曼 1.6 m。
   同一个姿态误差，在位置上被放大了三个数量级。
   ========================================================================== */

/** 每条估计器通道一个位置积分器（与 ests 顺序一致） */
const insList = new Map<Estimator["id"], InsIntegrator>();
for (const e of ests) insList.set(e.id, new InsIntegrator());

/** 俯视图轨迹（按 25 Hz 记录，与曲线同源）：每条算法一串北-东坐标 */
const insTrails = new Map<Estimator["id"], number[]>();

const insState = { on: true, scale: "auto" as string, range: 10, placeholderKey: "" };

function resetIns(): void {
  for (const ins of insList.values()) ins.reset();
  for (const t of insTrails.values()) t.length = 0;
}

/** 每次估计器更新后推进一步（由 updateEstimators 调用，保证与姿态同帧） */
function stepIns(sample: ImuSample, dt: number, accel: V3 = sample.accel): void {
  if (!insState.on) return;
  for (const e of ests) insList.get(e.id)?.step(e.q, accel, dt);
}

/** 25 Hz 记录一个轨迹点（与 logRow 同源，曲线与俯视图的采样节奏一致） */
function logInsTrail(): void {
  if (!insState.on) return;
  for (const e of ests) {
    const ins = insList.get(e.id);
    if (!ins) continue;
    let t = insTrails.get(e.id);
    if (!t) {
      t = [];
      insTrails.set(e.id, t);
    }
    t.push(ins.p[0], ins.p[1]);
    if (t.length > 2 * 900) t.splice(0, t.length - 2 * 900); // 约 36 s 轨迹
  }
  // 运动学一致剧本：把世界真值位置也画出来，作为「理想编排能跟住什么」的参照
  if (world.scenario.kinematic) {
    let tt = insTrails.get("truth");
    if (!tt) {
      tt = [];
      insTrails.set("truth", tt);
    }
    tt.push(world.posNed[0], world.posNed[1]);
    if (tt.length > 2 * 900) tt.splice(0, tt.length - 2 * 900);
  }
}

/** 收集各通道的当前位置与轨迹，交给 ui/ins-view.ts 绘制（本函数只负责取数） */
function drawIns(): void {
  const canvas = document.getElementById("ins-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  if (!insState.on) {
    // 关闭时清空画面，避免留下一张误导性的旧图；同一尺寸只画一次占位。
    const key = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (insState.placeholderKey === key) return;
    insState.placeholderKey = key;
    uiWorkCounters.insPlaceholderDraws++;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const { w, h } = fitInsetCanvas(canvas, 1.1, 320);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0a1020";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#5b6b86";
      ctx.font = '12px "Fira Code", Consolas, monospace';
      ctx.textAlign = "center";
      ctx.fillText("位置积分已关闭", w / 2, h / 2);
    }
    return;
  }
  insState.placeholderKey = "";
  insState.range = drawInsMap(
    canvas,
    [
      ...(world.scenario.kinematic
        ? [{
            label: "真值轨迹",
            color: "#e6edf3",
            north: world.posNed[0],
            east: world.posNed[1],
            trail: insTrails.get("truth") ?? [],
          }]
        : []),
      ...ests.map((e) => {
        const ins = insList.get(e.id)!;
        return { label: e.label, color: e.color, north: ins.p[0], east: ins.p[1], trail: insTrails.get(e.id) ?? [] };
      }),
    ],
    insState.scale,
  );
}

/** 位置漂移读数表 + 面板摘要（2 Hz） */
function updateInsReadout(): void {
  const el = document.getElementById("ins-readout");
  const sum = document.getElementById("sum-ins");
  if (!insState.on) {
    const closed = '<div class="ir-head">位置积分已关闭</div>';
    if (el && el.innerHTML !== closed) el.innerHTML = closed;
    if (sum && sum.textContent !== "已关闭") sum.textContent = "已关闭";
    return;
  }
  const rows = ests.map((e) => ({ e, ins: insList.get(e.id)! }));
  if (el) {
    el.innerHTML =
      `<div class="ir-head">算法</div><div class="ir-head ir-num">水平漂移</div><div class="ir-head ir-num">垂直漂移</div>` +
      rows
        .map(
          ({ e, ins }) =>
            `<div class="ir-name"><span class="ir-dot" style="background:${e.color}"></span><span>${e.label}</span></div>` +
            `<div class="ir-num">${fmtMeters(ins.horizontalDrift())}</div>` +
            `<div class="ir-num">${fmtMeters(ins.p[2])}</div>`,
        )
        .join("");
  }
  if (sum) {
    const worst = [...rows].sort((a, b) => b.ins.horizontalDrift() - a.ins.horizontalDrift())[0];
    sum.textContent = worst ? `最大漂移 ${fmtMeters(worst.ins.horizontalDrift())}（${worst.e.label}）` : "姿态 → 速度 → 位置";
  }
}

$("ins-toggle").addEventListener("change", () => {
  insState.on = ($("ins-toggle") as HTMLInputElement).checked;
  resetIns();
  updateInsReadout();
  drawIns();
});
$("ins-scale").addEventListener("change", () => {
  insState.scale = $<HTMLSelectElement>("ins-scale").value;
  drawIns();
});
// ---------- 真实 IMU（Web Serial，帧协议见 firmware/gy87.h） ----------
// Web Serial API 的最小类型面（DOM lib 未收录；只声明我们用到的部分）
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  close(): Promise<void>;
}
declare global {
  interface Navigator {
    readonly serial?: {
      requestPort(): Promise<SerialPortLike>;
      /** 设备拔出/系统断开事件（Chrome/Edge 支持；可选，便于自动重连） */
      addEventListener?(type: "disconnect", listener: (ev: Event) => void): void;
    };
  }
}

// 状态机：idle → connecting → live →（断线/错误）→ idle。真实模式下：
// ① 剧本与模拟 IMU 滑块停用（真值/污染都来自真实世界）；
// ② 没有姿态真值 → 幻影隐藏、误差曲线改以 Mahony 为参照基准；
// ③ 帧间隔上限 dt 兜底：收不到数据时估计器不推进（避免用陈旧帧空转）。
const SERIAL_QUEUE_MAX = 128;

/**
 * 使用者选定的波特率。**必须在 open() 之前定好**——Web Serial 打开端口时就把参数固定，
 * 之后改不了（要改只能断开重连）。所以这个下拉在连接期间会被禁用，
 * 而不是「改了没反应」那样让人猜。
 * 默认 921600：够快且是 CH340/CP2102 一类 USB-UART 与 STM32 常见的可用档位；
 * 低速档（9600–57600）留给老固件或 SoftwareSerial 一类的场合。
 */
const SERIAL_BAUD_DEFAULT = 921600;

/** 当前选定的串口协议（连接前可选，连接后锁定） */
function serialProtocol(): SerialProtocol {
  const el = document.getElementById("serial-protocol") as HTMLSelectElement | null;
  const v = el?.value ?? "binary";
  return v === "text" || v === "mavlink" ? v : "binary";
}
/** MAVLink 的取反开关（RAW_IMU 的符号取决于飞控里 IMU 的安装朝向，必须可切换） */
function serialInvert(): boolean {
  return (document.getElementById("serial-invert") as HTMLInputElement | null)?.checked ?? false;
}
/** 取反开关只在 MAVLink 协议下露出 */
function syncProtocolUi(): void {
  const row = document.getElementById("serial-invert-row");
  row?.classList.toggle("hidden", serialProtocol() !== "mavlink");
}
document.getElementById("serial-protocol")?.addEventListener("change", syncProtocolUi);
syncProtocolUi();
function serialBaud(): number {
  const el = document.getElementById("serial-baud") as HTMLSelectElement | null;
  const v = el ? Number(el.value) : SERIAL_BAUD_DEFAULT;
  return Number.isFinite(v) && v > 0 ? v : SERIAL_BAUD_DEFAULT;
}

const serialState = {
  /** 连接正在进行中（防重入：见 serialConnect 注释） */
  connecting: false,
  connectingGen: -1,
  session: null as SerialTransportSession | null,
  port: null as SerialPortLike | null,
  reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
  /**
   * 连接令牌：每次 read 循环启动 +1。旧 reader 的 finally 靠它判断
   * 「我还是当前那条连接吗」——不是就不许收尾（否则会打死接替它的新连接）。
   */
  connToken: 0,
  running: false,
  buffer: new Uint8Array(0),
  /** 已解析、等待算法消费的帧队列（主循环按 rAF 节奏回放） */
  queue: [] as SerialImuFrame[],
  /** 上一帧的固件 tick（ms）；−1 = 等待首帧 */
  lastTickMs: -1,
  /** 最近一次实际使用的积分步长（秒），状态栏显示用 */
  lastDt: 0.005,
  frames: 0,
  /** seq 缺口累计（固件层丢帧） */
  dropped: 0,
  /** 主机侧队列溢出丢弃累计（页面挂起/卡顿） */
  backlogDropped: 0,
  /** 文本行协议的字符串缓冲（二进制/MAVLink 走 bytes 缓冲） */
  text: "",
  /** MAVLink：跳过的非 RAW_IMU 消息数（飞控的心跳/姿态等占大多数） */
  skippedMsgs: 0,
  /** 文本协议：坏行计数与最后一次原因（状态行提示用） */
  badLines: 0,
  lastBadReason: "" as string,
  lastSeq: -1,
  lastArrival: 0,
  /** 本次连接实际使用的波特率（状态栏显示） */
  baud: SERIAL_BAUD_DEFAULT,
  /** 状态栏用：上次采样时的帧计数与时刻 */
  uiFrames: 0,
  uiAt: 0,
  rate: 0,
  chipUntil: -1,
};

/**
 * 波特率下拉的锁定状态：连接期间禁用（Web Serial 在 open() 时固定端口参数，
 * 之后改文本框是没有意义的），并给出「断开后可改」的提示——比让用户改了半天
 * 发现没生效要好。真实模式下 setSimControlsDisabled 已经会禁用整段 IMU 控件，
 * 这里额外管的是「提示文案」与「非真实模式下的误改保护」。
 */
function setSerialBaudLocked(locked: boolean): void {
  const sel = document.getElementById("serial-baud") as HTMLSelectElement | null;
  const note = document.getElementById("serial-baud-note");
  if (sel) sel.disabled = locked;
  if (note) note.textContent = locked ? `已锁定 ${serialState.baud}` : "连接前可改";
  // 协议同理：连接期间不能换（换了要重新建缓冲与解码器）
  const proto = document.getElementById("serial-protocol") as HTMLSelectElement | null;
  if (proto) proto.disabled = locked;
  const inv = document.getElementById("serial-invert") as HTMLInputElement | null;
  if (inv) inv.disabled = locked;
}

function setChipStatus(id: string, text: string, warn = false): void {
  const chip = document.getElementById(id);
  if (!chip) return;
  chip.textContent = text;
  chip.classList.toggle("warn", warn);
  chip.classList.remove("hidden");
}

function setSerialStatus(text: string, warn = false): void {
  setChipStatus("serial-status", text, warn);
}

/** 状态行（2 Hz）：帧率、真实 dt、丢帧、断流看门狗 */
function updateSerialStatus(): void {
  const viaBle = bleState.connected && !serialState.running;
  if (!serialState.running && !viaBle) return;
  const now = performance.now();
  if (serialState.uiAt > 0) {
    const elapsed = (now - serialState.uiAt) / 1000;
    if (elapsed >= 0.5) {
      serialState.rate = (serialState.frames - serialState.uiFrames) / elapsed;
      serialState.uiAt = now;
      serialState.uiFrames = serialState.frames;
    }
  } else {
    serialState.uiAt = now;
    serialState.uiFrames = serialState.frames;
  }
  if (serialState.lastArrival === 0) {
    setSerialStatus(viaBle ? "BLE IMU 已连接——等待通知…" : "真实 IMU 已连接——等待数据帧…");
    return;
  }
  const age = (now - serialState.lastArrival) / 1000;
  if (age > 1.5) {
    setSerialStatus(
      `数据流中断 ${age.toFixed(1)} s（已收 ${serialState.frames} 帧）——检查固件是否仍在发帧 / 线缆是否松动`,
      true,
    );
    return;
  }
  const proto = serialProtocol();
  const protoText = proto === "binary" ? "" : proto === "text" ? "文本行 · " : "MAVLink · ";
  const backlog = serialState.backlogDropped > 0 ? ` · 积压丢弃 ${serialState.backlogDropped}` : "";
  // 解算入口拒绝（SolveLoop 队列满）也必须可见：它和「串口积压丢弃」是两回事，
  // 前者意味着帧已收到却没进解算，只出现在状态行里用户才能判断是不是该降采样率。
  const solveDrops = solveLoop.droppedFrames > 0 ? ` · 解算入口拒绝 ${solveLoop.droppedFrames} 帧` : "";
  // 文本协议报坏行与原因、MAVLink 报跳过的消息——这两类「不是丢帧」的情况要说清，
  // 否则用户看到帧率不对只会去怀疑线缆
  const extra =
    proto === "text" && serialState.badLines > 0
      ? ` · 坏行 ${serialState.badLines}（${serialState.lastBadReason}）`
      : proto === "mavlink" && serialState.skippedMsgs > 0
        ? ` · 跳过其它消息 ${serialState.skippedMsgs}`
        : "";
  setSerialStatus(
    `${viaBle ? "BLE IMU" : "真实 IMU"} · ${protoText}${viaBle ? "" : `${serialState.baud} · `}` +
      `${serialState.rate.toFixed(0)} 帧/s · dt ${(serialState.lastDt * 1000).toFixed(1)} ms · ` +
      `seq 丢帧 ${serialState.dropped}${backlog}${solveDrops}${extra}`,
  );
}

/**
 * 连接进行中禁用连接按钮。注意不能无条件恢复：不支持 Web Serial / Web Bluetooth 的浏览器
 * 启动时就已把这两个按钮永久置灰（见 initCapabilityNotice），这里必须尊重那个状态。
 */
function setConnectButtonsBusy(busy: boolean): void {
  const serialOk = "serial" in navigator && window.isSecureContext;
  const bleOk = typeof navigator.bluetooth !== "undefined" && window.isSecureContext;
  const apply = (id: string, ok: boolean): void => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = busy ? true : !ok;
  };
  apply("btn-serial", serialOk);
  apply("btn-serial-quick", serialOk);
  apply("btn-ble", bleOk);
}

/**
 * 清掉**仍归我**的串口槽位（绝不碰新会话的句柄）。
 *
 * 为什么必须有：切换来源时 `serialDisconnect` 只在 `running || port` 为真时才被调用，
 * 而「open 还在挂起、尚未 running」这一窗口里没有任何人会清槽位——旧实现因此留下一个
 * 已释放的死引用，之后重连的归属判断（`serialState.session !== null`）会被它挡住。
 * 这正是「切回放发生在正在 open 期间」必须收口的另一半。
 */
function clearSerialSlotIfOwned(session: SerialTransportSession | null): void {
  if (!session || serialState.session !== session) return;
  serialState.session = null;
  serialState.port = null;
  serialState.reader = null;
  serialState.running = false;
  setSerialBaudLocked(false);
}

async function serialConnect(): Promise<void> {
  if (!navigator.serial) {
    setSerialStatus("此浏览器不支持 Web Serial（需要 Chrome/Edge 且 HTTPS 或 localhost）", true);
    return;
  }
  if (serialState.running || serialState.connecting) return;
  // 新来源（手动连接）作废旧的重连排程；否则旧定时器会在新连接之后把旧链路接回来。
  cancelPendingReconnects();
  const connectGen = ++connectionGeneration;
  serialState.connecting = true;
  serialState.connectingGen = connectGen;
  setConnectButtonsBusy(true);
  let session: SerialTransportSession | null = null;
  const stale = (): boolean => connectGen !== connectionGeneration || serialState.connectingGen !== connectGen;
  try {
    const baud = serialBaud();
    // 进度可见：连接动作本身可能挂起（驱动/蓝牙栈异常），没有状态文案时界面看起来毫无反应。
    // 与 BLE 路径的「正在连接 GATT…」对称。
    setSerialStatus("正在选择端口…（需要你在弹窗里点一下授权）");
    const requested = await navigator.serial.requestPort();
    if (stale()) return; // Unopened chooser results do not own an open-port lease.
    session = createSerialSession(requested, connectGen);
    serialState.session = session;
    setSerialStatus(`正在打开端口（${baud} 8N1）…`);
    if (!(await session.open(baud)) || stale()) {
      await serialCleanup.release(session);
      clearSerialSlotIfOwned(session);
      return;
    }
    if (bleState.connected || bleState.device || bleState.session) await bleDisconnect(true, "已断开 BLE，切到串口数据");
    if (stale() || serialState.session !== session) {
      await serialCleanup.release(session);
      clearSerialSlotIfOwned(session);
      return;
    }
    serialState.port = requested;
    serialState.running = true;
    sourceIntent = "serial";
    cancelSerialReconnect();
    serialReconnectPolicy.onSuccess();
    serialReconnectState.lastPort = requested;
    serialState.baud = baud;
    if (replayActive()) {
      stopReplayData();
      toast("已退出离线回放，切到串口数据");
    }
    serialState.lastArrival = 0;
    serialState.uiAt = 0;
    serialState.uiFrames = 0;
    serialState.rate = 0;
    setSerialStatus(`真实 IMU 已连接（${baud} 8N1）——等待数据帧…`);
    setSerialBaudLocked(true);
    void serialReadLoop(session).catch(reportTransportError);
  } catch (err) {
    await serialCleanup.release(session);
    // 已有新会话接手 → 绝不碰它的状态；否则（哪怕本次尝试已作废）必须把槽位清干净。
    if (session && serialState.session !== session) return;
    clearSerialSlotIfOwned(session);
    // 这里**不**因 stale 而跳过错误文案：本次尝试确实失败了，状态行必须如实收尾
    // （否则"正在打开端口…"会永远挂在面板上）。切换来源时串口面板本就被禁用，不会误导。
    const msg = errorText(err);
    setSerialStatus(`连接失败：${msg}（未选端口 / 端口被占用 / 波特率该平台不支持——SerialWeb 等其它工具需先断开）`, true);
  } finally {
    if (serialState.connectingGen === connectGen) {
      serialState.connecting = false;
      serialState.connectingGen = -1;
      setConnectButtonsBusy(bleState.connecting);
    }
  }
}

/* ---------- 断线自动重连（真实硬件长时间演示的刚需） ----------
   为什么需要：演示现场最怕「线被碰掉一次，接下来十分钟都在手动重连」。真实 USB-TTL
   与蓝牙模块的断链是常态（供电抖动、手机热点切换、Windows 省电策略），
   所以这里把「异常断开」与「用户主动断开」分开处理：
   · 异常断开（拔线/读写报错/watchdog）→ 按 1s/2s/4s 退避自动重连，最多 3 次；
   · 用户点「断开」→ 不重连（否则按钮就成了摆设）。
   重连复用同一个已授权端口（serialState.lastPort），不需要再弹选择对话框；
   若端口已被系统回收则重试失败，最后提示手动重连。 */
const serialReconnectState = {
  /** 是否允许自动重连（面板开关，串口与 BLE 共用；默认开） */
  enabled: true,
  /** 最近一次自动重连用的端口句柄（用户主动断开时清空） */
  lastPort: null as SerialPortLike | null,
  /** 是否正处于自动重连流程（避免与用户手动连接互相打架） */
  reconnecting: false,
  /** 当前已脱离 UI 的旧会话；重连必须等待它的同一个 disposePromise。 */
  pendingSession: null as SerialTransportSession | null,
};
const SERIAL_RECONNECT_MAX = 3;
/** 自动重连成功次数（调试出口/冒烟断言用：状态条会被后续实时刷新覆盖，不能只看文案） */
let serialReconnectCount = 0;
/** 退避状态机在 core/reconnect.ts（串口与 BLE 各一份，不再共享 attempts/timer 字段） */
const serialReconnectPolicy = new ReconnectPolicy({
  maxAttempts: SERIAL_RECONNECT_MAX,
  baseDelayMs: 1000,
  enabled: () => serialReconnectState.enabled,
});

interface ReconnectSlot { reconnecting: boolean }
function cancelReconnect(state: ReconnectSlot, policy: ReconnectPolicy): void {
  policy.cancel();
  state.reconnecting = false;
}
function abandonTransport(state: ReconnectSlot, policy: ReconnectPolicy): void {
  cancelReconnect(state, policy);
  sourceIntent = "simulation";
  applyDataSourceSemantics();
}

function cancelSerialReconnect(): void {
  cancelReconnect(serialReconnectState, serialReconnectPolicy);
}

/**
 * 切换数据源前的统一事务：取消**两侧**已排程的自动重连，并放掉「可复用句柄」。
 *
 * 为什么必须有这一步（ROUND12 复核反例）：掉线 → 1 s 后才重连，这段窗口里用户完全可能
 * 切到 BLE / 串口 / 回放。旧实现只清理「当前活跃」的链路，已排程的定时器照常触发，
 * 于是 1 s 后把刚切走的来源重新接回来——实测出现 `serial=true, ble=true` 双活，
 * 或回放中 `replay=true, serial=true`，端口/GATT 也被隐藏占用。
 *
 * 取消重连 ≠ 可以不关端口：pendingSession 仍要 dispose（close 会按实际结果记账）。
 */
/**
 * 释放失败的会话**统一隔离重试**（串口与 BLE 共用一套语义）。
 *
 * 为什么必须统一：`dispose() === false` 的含义是「句柄物理上可能还开着」——
 * 旧实现里散落的 `await session.dispose(); return;` 早退分支会把 false 静默丢掉，
 * 于是端口/GATT 仍被占着、代码却再也找不到它（复核 P1：open=1、close=0、800 ms 后仍占着）。
 * 现在所有释放路径都走 `release()`：拿到 false 就入队，每 2 s 重试，直到真正释放。
 */
class CleanupQueue<S extends { dispose(): Promise<boolean> }> {
  private queue: S[] = [];
  private timer = 0;
  private warned = false;
  constructor(private readonly label: string, private readonly warn: (msg: string) => void) {}

  get size(): number { return this.queue.length; }
  has(session: S): boolean { return this.queue.includes(session); }

  /** 释放一次；false 时入队重试。返回是否已真正释放。 */
  async release(session: S | null | undefined): Promise<boolean> {
    if (!session) return true;
    if (this.has(session)) { void this.flush(); return false; }
    let released = false;
    try { released = await session.dispose(); } catch { released = false; }
    if (!released) this.add(session);
    return released;
  }

  add(session: S): void {
    if (!this.queue.includes(session)) this.queue.push(session);
    if (!this.warned) {
      this.warned = true;
      this.warn(`${this.label}关闭未完成：句柄仍被占用，正在后台重试…`);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.timer = window.setTimeout(() => { this.timer = 0; void this.flush(); }, 2000);
  }

  async flush(): Promise<void> {
    for (const session of [...this.queue]) {
      let released = false;
      try { released = await session.dispose(); } catch { released = false; }
      if (released) {
        const i = this.queue.indexOf(session);
        if (i >= 0) this.queue.splice(i, 1);
      }
    }
    if (this.queue.length) this.schedule();
    else this.warned = false;
  }
}

const serialCleanup = new CleanupQueue<SerialTransportSession>("串口", (msg) => toast(msg, "#fbbf24"));

/** BLE 侧的隔离重试队列（与串口同构；GATT 句柄同样不许悬空） */
const bleCleanupQueue = new CleanupQueue<TransportSession<BleDeviceLike>>("BLE", (msg) => bleStatus(msg, true));

function cancelPendingReconnects(): void {
  cancelSerialReconnect();
  cancelBleReconnect();
  serialReconnectState.lastPort = null;
  const pending = serialReconnectState.pendingSession;
  serialReconnectState.pendingSession = null;
  bleReconnectState.lastDevice = null;
  if (pending) {
    void pending.dispose()
      .then((released) => { if (!released) serialCleanup.add(pending); })
      .catch(reportTransportError);
  }
}

/**
 * 应用自己记的「仍处于已打开状态」的端口数。
 *
 * 为什么要有这个数：真实 Web Serial 里，**没有 close 的端口会一直占着设备**，
 * 下次 open() 直接报 "already open"，用户只能重插/刷新页面（复核实测严格端口夹具：
 * open=4 次、close=0 次）。这个计数让「有开必有关」变成可断言的量，
 * 而不是靠读代码猜（plumbing().openPorts）。
 */
let serialOpenPorts = 0;

/**
 * 释放一个（可能已失效的）端口句柄。
 *
 * 记账必须**按实际结果**更新（ROUND11 P1）：旧实现在调用 close 之前就把计数减掉，
 * 于是严格夹具里 close 因读锁未释放而失败、端口仍处于 open 状态，`openPorts` 却已经是 0——
 * 「有开必有关」变成了自我安慰。失败次数单独计数并可从 plumbing() 读出来。
 */
let portCloseFailures = 0;
function createSerialSession(port: SerialPortLike, gen: number): SerialTransportSession {
  return new SerialTransportSession(port, gen,
    () => { serialOpenPorts++; },
    (closed) => {
      if (closed) serialOpenPorts = Math.max(0, serialOpenPorts - 1);
      else portCloseFailures++;
    });
}

function reportTransportError(err: unknown): void {
  toast(`连接操作失败：${errorText(err)}`, "#f85149");
}

/**
 * 串口异常断开后的收尾：**先**进入「重连过渡态」，**再**刷新数据源语义。
 * 顺序反了就会：running=false → applyDataSourceSemantics() 判定「回到模拟」→ resetSim()
 * → 本轮曲线/统计/时钟全丢（复核实测：24 s 的曲线在第一次拔线后归零）。
 * @returns 是否排程了重连（false 表示已放弃，会回到模拟模式）
 */
function handleSerialDrop(reason: string): void {
  const willRetry = Boolean(serialReconnectState.lastPort) && serialReconnectState.enabled;
  serialReconnectState.reconnecting = willRetry;
  applyDataSourceSemantics();
  if (willRetry) {
    scheduleSerialReconnect(reason);
  } else {
    // 没有可复用端口或用户关掉了自动重连：这就是真正回到模拟模式，清零是对的
    abandonSerialTransport();
  }
}

/**
 * 彻底放弃串口链路（重连次数用尽 / 无可复用端口 / 自动重连被关掉）：
 * 三个状态必须一起清，否则 `reconnectPending()` 会永远为真，主循环**永久冻结**
 * （复核反例 P1-C：1/3/7 秒连续失败后仍 reconnecting=true、timer 未排，画面从此不动）。
 */
function abandonSerialTransport(): void {
  // 三个状态必须一起清，否则 reconnectPending() 会永远为真，主循环永久冻结。
  abandonTransport(serialReconnectState, serialReconnectPolicy);
}

/** 安排一次自动重连（多次失败后放弃并提示） */
function scheduleSerialReconnect(reason: string): void {
  scheduleTransportReconnect(
    diagnosticsApi, "serial", reason, SERIAL_RECONNECT_MAX, "检查线缆后点「连接真实 IMU」",
    serialReconnectState.lastPort !== null,
    () => serialReconnectPolicy.onFailure(() => {
      void serialAutoReconnect().catch(reportTransportError);
    }),
    () => { serialReconnectState.reconnecting = true; },
    abandonSerialTransport,
    setSerialStatus,
  );
}

/**
 * 等旧串口会话真正释放。
 *
 * close 失败通常发生在「read 刚 cancel、驱动还没释放读锁」的窗口里。直接放弃会把这次
 * 重连判死，退避到 2 s 后才再试（复核实测：锁 3 s 后放行，第一次重连已失败，界面停在
 * serial=false）。同一拍内短重试几次更贴近真实时序；仍失败则交给退避状态机下一轮。
 * 每次 dispose 都按端口实际状态重试 close（失败结果不再被永久缓存）。
 */
async function releaseOldSerialSession(session: SerialTransportSession): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (await session.dispose()) return true;
  }
  return false;
}

async function serialAutoReconnect(): Promise<void> {
  const port = serialReconnectState.lastPort;
  if (!port || serialState.running || serialState.connecting || !serialReconnectState.reconnecting) return;
  // 归属校验必须覆盖「来源意图」：排程后用户可能已切到 BLE / 回放，定时器到点时不能再把
  // 串口接回来（否则三条数据通路同时活着，见 cancelPendingReconnects 的说明）。
  if (sourceIntent === "replay" || bleState.connected || bleState.session !== null) return void abandonSerialTransport();
  const gen = connectionGeneration;
  const previous = serialReconnectState.pendingSession;
  const session = createSerialSession(port, gen);
  const stale = (): boolean => gen !== connectionGeneration || serialReconnectState.lastPort !== port ||
    !serialReconnectState.reconnecting || (serialState.session !== null && serialState.session !== session) ||
    sourceIntent === "replay" || bleState.connected || bleState.session !== null;
  serialState.session = session;
  try {
    const released = previous ? await releaseOldSerialSession(previous) : true;
    if (stale()) { await serialCleanup.release(session); clearSerialSlotIfOwned(session); return; }
    if (!released) throw new Error("端口未能释放（读锁未解除）");
    if (!(await session.open(serialState.baud)) || stale()) {
      await serialCleanup.release(session);
      clearSerialSlotIfOwned(session);
      return;
    }
    serialReconnectState.pendingSession = null;
    serialState.port = port;
    serialState.running = true;
    sourceIntent = "serial";
    serialReconnectState.reconnecting = false;
    serialReconnectPolicy.onSuccess();
    serialReconnectCount++;
    diagnosticsApi?.dataGap(false);
    diagnosticsApi?.dataReconnect("success", { transport: "serial" });
    serialState.queue.length = 0;
    serialState.lastTickMs = -1;
    serialState.lastSeq = -1;
    serialState.buffer = new Uint8Array(0);
    serialState.text = "";
    setSerialBaudLocked(true);
    setSerialStatus(`真实 IMU 已自动重连（${serialState.baud} 8N1）——等待数据帧…`);
    applyDataSourceSemantics();
    toast("串口已自动重连", "#7ee787");
    void serialReadLoop(session).catch(reportTransportError);
  } catch {
    const released = await serialCleanup.release(session);
    if (!released) return;
    if (stale()) return;
    serialState.session = null;
    scheduleSerialReconnect("自动重连失败");
  }
}

/**
 * 断开串口。
 * @param internal true = 由其它连接流程发起的「清旧链」，**不**递增世代、**不**改来源意图。
 *   递增的责任留给调用方：它已经用一次 `++connectionGeneration` 占住了本次意图，
 *   这里再递增会把调用方自己作废（复核反例 P1-B）。
 */
async function serialDisconnect(internal = false): Promise<void> {
  if (!internal) {
    connectionGeneration++; // 作废任何在途的 connect await
    sourceIntent = "simulation";
  }
  const gen = connectionGeneration;
  cancelSerialReconnect();
  serialReconnectState.lastPort = null;
  const session = serialState.session;
  const pending = serialReconnectState.pendingSession;
  serialState.session = null;
  serialState.port = null;
  serialState.reader = null;
  serialState.connecting = false;
  serialState.connectingGen = -1;
  serialState.running = false;
  serialState.connToken++;
  serialState.buffer = new Uint8Array(0);
  serialState.queue.length = 0;
  serialState.lastTickMs = -1;
  serialState.lastSeq = -1;
  serialState.rate = 0;
  magCalState.collecting = false;
  setSerialBaudLocked(false);
  if (!internal) setSerialStatus("真实 IMU 已断开——回到模拟模式");
  setConnectButtonsBusy(bleState.connecting);
  // 旧会话即使已被新连接替代也必须继续清理：release() 内部在 false 时入队，与世代检查无关。
  await Promise.all([serialCleanup.release(session), serialCleanup.release(pending)]);
  if (gen !== connectionGeneration || serialState.session) return;
  if (serialReconnectState.pendingSession === pending) serialReconnectState.pendingSession = null;
}

function dropSerialSession(session: SerialTransportSession, reason: string): void {
  if (serialState.session !== session || !serialState.running) return;
  serialState.running = false;
  serialState.session = null;
  serialState.port = null;
  serialState.reader = null;
  serialState.connToken++;
  serialReconnectState.pendingSession = session;
  void serialCleanup.release(session).catch(reportTransportError);
  serialState.queue.length = 0;
  serialState.lastTickMs = -1;
  setSerialBaudLocked(false);
  handleSerialDrop(reason);
}

async function serialReadLoop(session: SerialTransportSession): Promise<void> {
  const current = (): boolean => serialState.session === session && serialState.running && !session.disposed;
  const token = ++serialState.connToken;
  try {
    const reading = session.read(() => current() && serialState.connToken === token, (value) => {
      if (serialProtocol() === "text") {
        serialState.text += textDecoder.decode(value, { stream: true });
        if (serialState.text.length > 8192) serialState.text = serialState.text.slice(-8192);
      } else {
        const merged = new Uint8Array(serialState.buffer.length + value.length);
        merged.set(serialState.buffer);
        merged.set(value, serialState.buffer.length);
        serialState.buffer = merged.length > 4096 ? merged.subarray(merged.length - 4096) : merged;
      }
      serialDrainBuffer();
    });
    serialState.reader = session.reader;
    await reading;
  } catch {
    /* Read error / getReader failure both dispose the captured session. */
  } finally {
    if (current() && serialState.connToken === token) {
      dropSerialSession(session, "真实 IMU 连接中断（设备拔出或重置？）");
    }
    await serialCleanup.release(session);
  }
}

const textDecoder = new TextDecoder();
/** 换行符（写成常量是因为在 shell 里拼 
 转义容易被吞） */
const NEWLINE = String.fromCharCode(10);

/**
 * 按所选协议把缓冲里的完整帧弹出到回放队列。
 * 三种协议的共同下游是 serialState.queue（回放引擎与真实模式语义都不关心来源）。
 */
function serialDrainBuffer(): void {
  const proto = serialProtocol();
  if (proto === "text") serialDrainText();
  else if (proto === "mavlink") serialDrainMavlink();
  else serialDrainBinary();
}

/** 统一入队 + 统计（三种协议共用；seq 用本机计数，见下方说明） */
function serialPushFrame(frame: SerialImuFrame): void {
  // 用本机自增 seq 而不是线上的 seq：文本协议没有序号，MAVLink 的 seq 是「所有消息」共用的
  // 计数器（我们跳过了心跳/姿态等），直接拿来算丢帧会得出假的大数字。
  frame.seq = serialState.frames & 0xffff;
  serialState.lastSeq = frame.seq;
  serialState.frames++;
  serialState.lastArrival = performance.now();
  if (pushBounded(serialState.queue, frame, SERIAL_QUEUE_MAX).dropped) serialState.backlogDropped++;
}

/** 文本行协议：按 
 切行，逐行解析（表头/注释行忽略一次） */
function serialDrainText(): void {
  const mounting = ($("serial-mounting") as HTMLSelectElement).value as Mounting;
  for (;;) {
    const nl = serialState.text.indexOf(NEWLINE);
    if (nl < 0) return;
    const line = serialState.text.slice(0, nl);
    serialState.text = serialState.text.slice(nl + 1);
    const res = parseTextLine(line, mounting, serialState.lastTickMs < 0 ? 0 : serialState.lastTickMs);
    if (!res.frame) {
      if (res.reason && !res.header) {
        serialState.badLines = (serialState.badLines ?? 0) + 1;
        serialState.lastBadReason = res.reason;
      }
      continue;
    }
    serialPushFrame(res.frame);
  }
}

/** MAVLink v2：解 RAW_IMU，跳过其它消息 */
function serialDrainMavlink(): void {
  const mounting = ($("serial-mounting") as HTMLSelectElement).value as Mounting;
  for (;;) {
    const res = parseMavlinkFrame(serialState.buffer, mounting, serialInvert());
    if (res.consumed > 0) serialState.buffer = serialState.buffer.subarray(res.consumed);
    if (res.frame) serialPushFrame(res.frame);
    else if (res.reason && res.reason.startsWith("跳过消息")) serialState.skippedMsgs++;
    if (res.consumed === 0) return;
  }
}

/** 本装置二进制帧（28 字节） */
function serialDrainBinary(): void {
  const mounting = ($("serial-mounting") as HTMLSelectElement).value as Mounting;
  for (;;) {
    const { frame, consumed } = parseFrame(serialState.buffer, mounting);
    if (consumed > 0) {
      serialState.buffer = serialState.buffer.subarray(consumed);
    }
    if (!frame) break;
    // 丢帧统计：seq 应 +1（u16 回绕）
    if (serialState.lastSeq >= 0) {
      const expect = (serialState.lastSeq + 1) & 0xffff;
      if (frame.seq !== expect) serialState.dropped += (frame.seq - expect) & 0xffff;
    }
    serialState.lastSeq = frame.seq;
    serialState.frames++;
    serialState.lastArrival = performance.now();
    // 主机侧积压保护：只保留最新的帧（旧帧对实时显示没有价值）
    if (pushBounded(serialState.queue, frame, SERIAL_QUEUE_MAX).dropped) serialState.backlogDropped++;
  }
}

function serialToggle(): void {
  if (serialState.running) {
    void serialDisconnect().then(() => applyDataSourceSemantics()).catch(reportTransportError);
  } else {
    void serialConnect().then(() => {
      if (serialState.running) {
        applyDataSourceSemantics();
        // 数据源切换 = 新的一轮实验：估计器、曲线、统计、时钟全部归零
        serialState.queue.length = 0;
        serialState.lastTickMs = -1;
        serialState.lastSeq = -1;
        serialState.frames = 0;
        serialState.dropped = 0;
        serialState.backlogDropped = 0;
        resetSim();
      }
    }).catch(reportTransportError);
  }
}
$("btn-serial").addEventListener("click", () => serialToggle());

/* ==========================================================================
   浏览器能力提示
   --------------------------------------------------------------------------
   Firefox 与 Safari 至今没有 Web Serial / Web Bluetooth，只给一个 WebGL 的
   3D 视图和一块点了没反应的按钮不公平。这里在 IMU 面板顶部常驻说明：
   （1）缺哪个 API；（2）是浏览器缺还是安全上下文缺（两种成因的解法完全不同）；
   （3）把用不了的按钮置灰，避免「点了没反应」这种最难排查的失败形态。
   模拟、离线回放、五种算法与全部文档都不依赖这两个 API，因此照常可用。
   ========================================================================== */
function initCapabilityNotice(): void {
  const nav = navigator as Navigator & { serial?: unknown; bluetooth?: unknown };
  const hasSerial = "serial" in nav;
  const hasBle = typeof nav.bluetooth !== "undefined";
  const secure = window.isSecureContext;
  // 安全上下文缺失时，即使 API 存在也会在 requestPort()/requestDevice() 抛 SecurityError，
  // 所以它和「API 缺失」一样要提示——但成因与解法不同，文案必须分开。
  if (hasSerial && hasBle && secure) return;

  const box = document.getElementById("cap-notice");
  if (!box) return;
  const missing = [!hasSerial ? "Web Serial" : null, !hasBle ? "Web Bluetooth" : null].filter(Boolean);
  const title = missing.length ? `当前浏览器不支持 ${missing.join(" / ")}` : "串口与蓝牙已被浏览器屏蔽";
  const detail = !secure
    ? "页面不在安全上下文里（需要 HTTPS 或 localhost），浏览器会直接屏蔽串口与蓝牙——用 https 打开本站即可。"
    : missing.length === 2
      ? "真实硬件需要 Chrome / Edge（Firefox 与 Safari 都还没实现这两个 API）。模拟、离线回放、五种算法与全部文档不受影响，照常可用。"
      : `真实硬件需要 Chrome / Edge 的${missing[0]}。其余功能不受影响。`;
  const t = document.getElementById("cap-notice-title");
  const b = document.getElementById("cap-notice-body");
  if (t) t.textContent = title;
  if (b) b.textContent = detail;
  box.classList.remove("hidden");

  const ban = (id: string, why: string): void => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) {
      el.disabled = true;
      el.title = why;
    }
  };
  if (!hasSerial || !secure) {
    const why = secure ? "当前浏览器不支持 Web Serial——用 Chrome / Edge 打开即可" : "需要 HTTPS 或 localhost";
    ban("btn-serial", why);
    ban("btn-serial-quick", why);
  }
  if (!hasBle || !secure) ban("btn-ble", secure ? "当前浏览器不支持 Web Bluetooth——用 Chrome / Edge 打开即可" : "需要 HTTPS 或 localhost");
}
initCapabilityNotice();

$("serial-mounting").addEventListener("change", () => {
  // 换安装方向：半解析缓冲与已排队帧都可能带着旧方向，一起丢弃并重置 tick 基准。
  // 文本协议用的是另一个缓冲（serialState.text），漏掉它会让「切换前残留的半行」与切换后的
  // 新字节拼成一行、再按**新方向**解析 → 一个错帧；lastSeq 不清则多记一次假丢帧。
  serialState.buffer = new Uint8Array(0);
  serialState.text = "";
  serialState.queue.length = 0;
  serialState.lastTickMs = -1;
  serialState.lastSeq = -1;
});

/* ==========================================================================
   离线回放：把导入的 IMU 日志按录制速率喂给五种算法
   --------------------------------------------------------------------------
   与真实串口共用同一套语义（`state.real = true`）：无真值基准 → 误差曲线以 Mahony 为参照、
   幻影隐藏、模拟控件停用。区别只在数据来自文件而不是端口，所以没有「断流看门狗」，
   改成「播完提示」，并且多了倍速与进度。
   ========================================================================== */

const replayState = {
  frames: [] as ReplayFrame[],
  /** 下一帧下标 */
  idx: 0,
  /** 已累积的「录制时间」（秒）；乘以倍速后可消费 */
  acc: 0,
  speed: 1,
  fileName: "",
  /** 日志是否带外部真值姿态（truth_q*）；有真值时误差基准按物理真值而不是 Mahony */
  externalReference: false,
  /**
   * 回放是否对日志读数应用当前磁/加计校准：
   *  - 日志声明 `# imu=raw`（本装置导出默认）→ true：把校准补回来才等价于录制时的解算输入；
   *  - 日志声明 `# imu=calibrated` → false：再校准就是二次校准；
   *  - 无声明 → 默认 true，但用户可用回放面板的开关改成「按原样解算」。
   */
  applyCalibration: true,
  /** 日志元数据声明的 IMU 语义（null = 未声明） */
  imuCalibrated: null as boolean | null,
  /** 播完只提示一次 */
  announcedEnd: false,
};

/** 回放时是否绕过校准应用（校准后日志不能重复校准） */
function calibrationBypassed(): boolean {
  return replayActive() && !replayState.applyCalibration;
}

function replayActive(): boolean {
  return replayState.frames.length > 0;
}

/** 数据源的可读名字：模拟 / 真实串口 / BLE / 离线回放 */
function currentDataSource(): DataSourceState {
  // 回放优先：导入日志即进入离线回放（回放与串口/BLE 互斥，见 startReplay）。
  if (replayActive()) {
    return { kind: "replay", externalReference: replayState.externalReference };
  }
  // 传输层活着 = 该来源正在供数；否则若仍在重连过渡态，保持**用户原来的来源身份**
  // （P1-D：断链瞬间不得退回 simulation，否则真实记录被标成模拟、误差基准被当成真值）。
  const kind: DataSourceKind = bleState.connected
    ? "ble"
    : serialState.running
      ? "serial"
      : reconnectPending() && sourceIntent !== "simulation"
        ? sourceIntent
        : "simulation";
  return { kind, externalReference: false };
}
function dataSourceLabel(): string {
  return sourceLabelOf(currentDataSource());
}
/** 当前误差基准是否有物理真值（模拟/未来外部真值才有；Mahony 基准只算算法间偏差） */
function hasGroundTruth(): boolean {
  return hasPhysicalReference(currentDataSource());
}
function currentReferenceKind(): ReferenceKind {
  return referenceKindOf(currentDataSource());
}

/**
 * 当前误差基准姿态：
 *  - 模拟模式 = 世界真值；
 *  - 回放且日志带 truth_q* = 外部真值；
 *  - 其余真实数据 = Mahony（只表示算法间偏差，不是物理真值）。
 */
function referenceQ(): Quat {
  const kind = currentReferenceKind();
  if (kind === "groundTruth") return world.q;
  if (kind === "external" && state.externalTruth) return state.externalTruth;
  return (ests[2] as MahonyEstimator).q;
}

/**
 * 本段回放时长：**唯一口径** = `ReplayPlayer` 的单调有效时间轴。
 *
 * 旧实现按「末帧原始时刻 − 首帧原始时刻」算，日志末帧时间回退时它比实际积分跨度**短**——
 * 于是进度条/状态条/积分三者一致，而"已载入 X 帧（Y s）"的提示与调试出口报的是另一个数
 * （复核 P1：0.22 s vs 0.18 s）。页面所有 duration/played/toast/debug 都必须走这一条函数。
 */
function replayDuration(): number {
  return replayPlayer.durationSec;
}

/**
 * 每 rAF 推进回放：按「录制时间 × 倍速」消费帧，**逐帧用该帧自身的 dt** 更新估计器
 * （这正是离线回放的意义：算法看到的采样节奏与录制时一致）。
 */
const replayPlayer = new ReplayPlayer();
/** 外部真值时间轨（误差/波形/差分角速度共用；随 resetSim/导入清空） */
const replayTruth = new TruthTrack();

/** 单帧背压：播放器仅在积分回执完成后推进，离线日志不丢弃。 */
const REPLAY_TICK_BUDGET = 5;
function replayPendingSec(): number { return replayPlayer.pendingSec; }
function stepReplayPlayback(dtAnim: number): void {
  replayPlayer.advanceWork(dtAnim, (work) => {
    if (work.first) {
      const f = work.frame;
      const sample: ImuSample = {
        gyro: f.gyroDps.map((v) => v * Math.PI / 180) as V3,
        accel: [...f.accelMs2], mag: [...f.magUt],
      };
      if (!solveLoop.enqueueFrame(sample, work.dtSec, work.tSec)) return null;
      state.lastImu = sample;
      // 真值只登记为"本帧终点值"，实际取值由 onSolveDefault 按子步时刻插值；
      // 帧完成时（onFrame）才把它提升为下一帧的起点。
      replayTruth.push(work.tSec, f.qTrue ? { ...f.qTrue } : null);
    }
    return solveLoop.drain(0.05, 4000, work.budgetSec).processedSec;
  }, REPLAY_TICK_BUDGET);
  if (replayPlayer.done && solveLoop.pendingSec === 0 && !replayState.announcedEnd) {
    replayState.announcedEnd = true;
    updateReplayStatus();
    toast(`回放完成：${replayPlayer.frameCount} 帧 / ${replayPlayer.durationSec.toFixed(1)} s —— 曲线与评测表保留本轮结果`, '#7ee787');
  }
}

/** 回放状态行（2 Hz）：文件名、进度、倍速 */
function updateReplayStatus(): void {
  const chip = document.getElementById("replay-status");
  if (!chip) return;
  if (!replayActive()) {
    chip.classList.add("hidden");
    return;
  }
  const rp = replayState;
  const total = replayPlayer.durationSec;
  const done = replayPlayer.playedSec;
  rp.idx = replayPlayer.cursor; // 面板/自动化读到的进度与播放器一致
  const ended = replayPlayer.done && solveLoop.pendingSec === 0;
  chip.classList.toggle("warn", ended);
  const calLabel = rp.imuCalibrated === true
    ? "日志已校准"
    : rp.applyCalibration
      ? "补校准"
      : "原样解算";
  const pending = replayPendingSec();
  chip.textContent =
    `${ended ? "回放结束" : "回放中"} · ${rp.fileName} · ` +
    `${done.toFixed(1)} / ${total.toFixed(1)} s · ${rp.speed === 0 ? "最快" : `${rp.speed}×`} · ` +
    `${rp.idx}/${rp.frames.length} 帧 · IMU ${calLabel}` +
    // 长空洞需要多拍补积分：把「还剩多少秒没算」如实显示出来，而不是提前报完成
    (pending > 0.05 ? ` · 待积分 ${pending.toFixed(1)} s` : "") +
    (solveLoop.droppedFrames ? ` · 解算入口拒绝 ${solveLoop.droppedFrames} 帧` : "");
  chip.classList.remove("hidden");
}

/** 进入回放模式：清掉串口状态，切到「无真值」语义 */
function startReplay(res: ReplayParseResult, fileName: string): void {
  // 回放是第三条数据通路：进入前必须把两侧**已排程**的重连一起取消，
  // 而不只是断开「此刻还活着」的连接（复核实测：回放 1.5 s 后串口自己接了回来）。
  cancelPendingReconnects();
  connectionGeneration++; // 回放导入作废在途串口/BLE 连接
  if (serialState.running || serialState.port) void serialDisconnect(true).catch(reportTransportError);
  // BLE 也要断：三条数据通路（串口 / BLE / 回放）互斥。漏掉 BLE 时，回放期间通知仍在往同一条
  // 队列里灌帧（状态条显示的还是 BLE 帧率），退出回放的瞬间这批积压帧会被打进估计器。
  // 内部版不递增世代：本次意图已由上面那次 ++ 占住。
  if (bleState.connected || bleState.device) void bleDisconnect(true, "已断开 BLE，切到离线回放").catch(reportTransportError);
  sourceIntent = "replay";
  replayState.frames = res.frames;
  replayState.idx = 0;
  replayState.acc = 0;
  replayPlayer.load(res.frames, replayState.speed);
  replayTruth.reset();
  replayState.fileName = fileName;
  replayState.announcedEnd = false;
  replayState.externalReference = res.hasTruth;
  replayState.imuCalibrated = res.imuCalibrated;
  // 语义闭环：校准后的日志绝不再校准；原始日志把校准补回来（可用开关改）
  replayState.applyCalibration = res.imuCalibrated !== true;
  const applyBox = $<HTMLInputElement>("replay-apply-cal");
  if (applyBox) {
    applyBox.checked = replayState.applyCalibration;
    // 声明为校准后读数的日志：把开关**锁住**（不只是默认关闭）——见 change 处理器
    applyBox.disabled = res.imuCalibrated === true;
    applyBox.title = res.imuCalibrated === true
      ? "日志声明为校准后读数（# imu=calibrated）：已锁定关闭，禁止二次校准"
      : "日志按原始读数处理：勾选则用当前磁/加计校准后的输入解算（与录制时一致）";
  }
  state.externalTruth = null;
  document.getElementById("btn-replay-stop")?.classList.remove("hidden");
  applyDataSourceSemantics();
  resetSim(); // 与串口连接同一套流程：数据源切换 = 新的一轮实验，曲线/统计/时钟全部归零
  const calNote = res.imuCalibrated === true
    ? "，日志为校准后读数：回放不再二次校准"
    : res.imuCalibrated === false
      ? "，日志为原始读数：回放按当前校准设置补充校准"
      : "，日志未声明 IMU 语义：默认按原始读数 + 当前校准设置";
  toast(
    `已载入 ${res.frames.length} 帧（${replayDuration().toFixed(1)} s）——开始离线回放` +
      (res.invalidRows ? `，拒绝坏样本 ${res.invalidRows} 行` : "") +
      (res.hasTruth ? "，检测到外部真值：误差按真值评估" : "") +
      (res.skipped ? `，跳过 ${res.skipped} 行` : "") +
      calNote,
  );
  // 把识别到的列映射与单位/时间轴假设打到控制台：猜错单位不会报错，但会让数据「看起来不对」
  console.info("IMU 回放已载入：", {
    列映射: res.mapping,
    推断: res.notes,
    跳过行: res.skipped,
    拒绝坏样本: res.invalidRows,
    外部真值: res.hasTruth,
  });
}

/**
 * 清理回放**数据**（不清 UI 语义）：`replayState.frames` 与 `replayPlayer` 必须一起清。
 * 复核反例：串口连接只清 `replayState`，播放器仍 `loaded=true` 并持着 60 帧，
 * 之后任何走播放器的路径都会消费到「已经不该存在」的日志。
 */
function stopReplayData(): void {
  solveLoop.reset();
  replayState.frames = [];
  replayState.idx = 0;
  replayState.acc = 0;
  replayState.announcedEnd = false;
  replayPlayer.clear();
  document.getElementById("btn-replay-stop")?.classList.add("hidden");
  updateReplayStatus();
}

function stopReplay(): void {
  sourceIntent = "simulation"; // 用户显式退出回放 = 回到模拟
  stopReplayData();
  replayState.fileName = "";
  replayState.imuCalibrated = null;
  replayState.applyCalibration = true;
  const applyBox = $<HTMLInputElement>("replay-apply-cal");
  if (applyBox) {
    applyBox.disabled = false; // 解除「校准后日志」的锁定，否则退出回放后开关永远是灰的
    applyBox.checked = true;
  }
  document.getElementById("btn-replay-stop")?.classList.add("hidden");
  updateReplayStatus();
  applyDataSourceSemantics();
  toast("已退出回放，回到模拟模式");
}

/** 读文件 → 解析 → 进入回放（失败时把原因贴出来） */
async function importReplayFile(file: File): Promise<void> {
  let text = "";
  try {
    text = await file.text();
  } catch (err) {
    toast(`读取文件失败：${errorText(err)}`, "#f85149");
    return;
  }
  const res = parseImuCsv(text);
  if (res.error) {
    toast(`导入失败（${file.name}）：${res.error}`, "#f85149");
    console.warn("IMU 回放导入失败：", res.error, res.mapping, res.notes);
    return;
  }
  startReplay(res, file.name);
}

document.getElementById("btn-replay-import")?.addEventListener("click", () => {
  document.getElementById("replay-file")?.click();
});
document.getElementById("replay-file")?.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void importReplayFile(file);
  input.value = ""; // 允许连续导入同一个文件（否则第二次不触发 change）
});
document.getElementById("btn-replay-stop")?.addEventListener("click", () => stopReplay());
document.getElementById("replay-speed")?.addEventListener("change", () => {
  const v = Number(($("replay-speed") as HTMLSelectElement).value);
  replayState.speed = Number.isFinite(v) ? v : 1;
  replayPlayer.setSpeed(replayState.speed);
  updateReplayStatus();
});
document.getElementById("replay-apply-cal")?.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  // 日志自己声明了 `# imu=calibrated`：它的读数**已经**是校准后的，
  // 再「应用校准」就是对同一份数据校准两次。这个开关此时必须是禁用的——
  // 否则「避免二次校准」只是默认行为，用户一点就破（复核实测：勾回去后消费的磁值继续被压小）。
  if (replayState.imuCalibrated === true) {
    box.checked = false;
    replayState.applyCalibration = false;
    toast("这份日志声明为校准后读数（# imu=calibrated）：回放不再二次校准，开关已锁定", "#fbbf24");
    updateReplayStatus();
    return;
  }
  replayState.applyCalibration = box.checked;
  if (box.checked && !magCalState.applied && !accelCalState.applied) {
    toast("回放设置：勾选「应用校准」，但当前没有已应用的磁/加计校准——输入与原始读数相同", "#fbbf24");
  }
  updateReplayStatus();
});

/* ==========================================================================
   BLE IMU（Web Bluetooth）
   --------------------------------------------------------------------------
   为什么值得做：BLE 已经是小体积 IMU 模块的默认传输方式（HM-10 之类透传桥、
   WitMotion 的 BLE 系列、ESP32 板载 BLE 串口）。没有这条路径时，用户必须再找一个
   USB-TTL 转接才能接上——而「装置本身跑在浏览器里、何必再插一根线」正是它的价值。

   设计上的三个取舍：
   1) **只预置已核实过的服务 UUID**（HM-10/FFE0、Nordic UART、ABF0、通用 1000 系列，
      来自 iNav Configurator 这类真实 BLE 串口工具），另给一个自定义输入框——
      厂商 UUID 五花八门，写死一串猜来的值只会让人连不上还找不到原因。
   2) **特征不预置**：连上后枚举该服务下所有支持 notify 的特征列给用户挑。
      因为「TX/RX」的命名方向各家不一致（Nordic 与 iNav 的 read/write 命名正好相反），
      与其猜方向，不如用 `properties.notify` 这个客观属性。
   3) **复用串口的下游**：通知里的字节进同一个 `serialState.buffer/text`，再走 `serialDrainBuffer()`。
      于是三种协议（二进制/文本行/MAVLink）与「无真值」语义全部照旧。
      BLE 单个通知常只有 20 字节，28 字节的帧会被拆开——流式解析器天然处理（不完整时 consumed=0，
      缓冲继续攒），这也是这一层不必写分片逻辑的原因。
   ========================================================================== */

/** Web Bluetooth 的最小类型面（DOM lib 未收录；只声明用到的部分） */
interface BleCharacteristicLike {
  uuid: string;
  properties: { notify?: boolean; indicate?: boolean };
  value: DataView | null;
  startNotifications(): Promise<BleCharacteristicLike>;
  stopNotifications(): Promise<BleCharacteristicLike>;
  addEventListener(type: string, cb: (ev: { target: BleCharacteristicLike }) => void): void;
  /** 可选：真实实现（EventTarget）都有；假设备可能没有，所以调用处用 ?. 兜底 */
  removeEventListener?(type: string, cb: (ev: { target: BleCharacteristicLike }) => void): void;
}
interface BleServiceLike {
  getCharacteristics(): Promise<BleCharacteristicLike[]>;
}
interface BleDeviceLike {
  name?: string | null;
  id: string;
  /** 可选：真实实现（EventTarget）都有；假设备可能没有，调用处用 ?. 兜底 */
  removeEventListener?(type: string, cb: () => void): void;
  gatt?: {
    connected: boolean;
    connect(): Promise<{
      getPrimaryService(uuid: string): Promise<BleServiceLike>;
    }>;
    disconnect(): void;
  };
  addEventListener(type: string, cb: () => void): void;
}
declare global {
  interface Navigator {
    readonly bluetooth?: {
      requestDevice(options: {
        filters: Array<{ services: string[] }>;
        optionalServices?: string[];
      }): Promise<BleDeviceLike>;
    };
  }
}

interface BleSession {
  generation: number;
  device: BleDeviceLike;
  lease: TransportSession<BleDeviceLike>;
  notifications: NotificationSession<BleCharacteristicLike>;
  lost: () => void;
}

const bleState = {
  /** 连接正在进行中（防重入） */
  connecting: false,
  connectingGen: -1,
  session: null as BleSession | null,
  device: null as BleDeviceLike | null,
  char: null as BleCharacteristicLike | null,
  connected: false,
  /** 连接后发现的、支持 notify 的特征（供用户切换） */
  notifiers: [] as BleCharacteristicLike[],
};

function bleStatus(text: string, warn = false): void {
  setChipStatus("ble-status", text, warn);
}

/** 当前选定的服务 UUID（自定义档读输入框） */
function bleServiceUuid(): string {
  const sel = document.getElementById("ble-service") as HTMLSelectElement | null;
  const v = sel?.value ?? "";
  if (v === "custom") {
    return (document.getElementById("ble-custom") as HTMLInputElement | null)?.value.trim() ?? "";
  }
  return v;
}

/** 自定义档才会露出 UUID 输入框 */
function syncBleUi(): void {
  const custom = (document.getElementById("ble-service") as HTMLSelectElement | null)?.value === "custom";
  document.getElementById("ble-custom-row")?.classList.toggle("hidden", !custom);
}

/**
 * 订阅某个特征的通知；先退订旧的。
 * @param gen 当前连接世代。给了就在每个 await 之后校验；一旦过期（用户断开/切源），
 *   撤掉自己刚挂上的监听并退订，返回 false —— 不提交 `bleState.char`。
 *   复核反例 P1-A：只在 `bleSubscribe` **之前**检查世代时，`startNotifications()` 期间
 *   切到回放，完成后仍会提交 ble=true，于是回放与 BLE 同时活、旧通知继续往新实验写帧。
 * @returns 是否成功提交（true = 现在订阅的就是该特征）
 */
function createBleSession(device: BleDeviceLike, gen: number): BleSession {
  const session = { generation: gen, device } as BleSession;
  session.notifications = new NotificationSession({
    valid: () => bleState.session === session && !session.lease.disposed &&
      (bleState.connected || gen === connectionGeneration),
    attach: (char, listener) => char.addEventListener("characteristicvaluechanged", listener),
    detach: (char, listener) => char.removeEventListener?.("characteristicvaluechanged", listener),
    notify: onBleNotify,
  });
  session.lost = () => onBleDeviceLost(session);
  session.lease = new TransportSession(device, gen, async (mine) => {
    await session.notifications.dispose();
    device.removeEventListener?.("gattserverdisconnected", session.lost);
    if (mine) closeBleGatt(device);
    return true;
  });
  return session;
}

async function bleSubscribe(char: BleCharacteristicLike, gen = connectionGeneration, subToken = bleSubToken): Promise<boolean> {
  const session = bleState.session;
  if (!session || session.lease.disposed || gen !== connectionGeneration || subToken !== bleSubToken) return false;
  const current = (): boolean => bleState.session === session && !session.lease.disposed &&
    gen === connectionGeneration && subToken === bleSubToken;
  try {
    const ok = await session.notifications.subscribe(char, current);
    if (!current()) return false;
    bleState.char = session.notifications.current;
    return ok;
  } catch (err) {
    if (!current()) return false;
    bleState.char = session.notifications.current;
    if (!bleState.char) await bleDisconnect(false, "BLE 特征切换失败——已断开，请重连");
    throw err;
  }
}

/**
 * 通知到达：字节进与串口同一个缓冲，再走同一个 drain。
 * 注意这里只用 `ev.target.value` —— 不依赖 Event 的其他字段（便于用假设备测试）。
 */
function onBleNotify(ev: { target: BleCharacteristicLike }): void {
  // 归属校验：只消费**当前订阅的那个特征**的通知。
  // 复核反例 P1-A：旧连接（或已切换掉的特征）的通知会继续往同一条队列灌帧，
  // 界面显示新来源、数据却来自上一个设备的残留回调。
  if (ev.target !== bleState.char) return;
  const dv = ev.target.value;
  if (!dv || dv.byteLength === 0) return;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (serialProtocol() === "text") {
    serialState.text += textDecoder.decode(bytes, { stream: true });
    if (serialState.text.length > 8192) serialState.text = serialState.text.slice(-8192);
  } else {
    const merged = new Uint8Array(serialState.buffer.length + bytes.length);
    merged.set(serialState.buffer);
    merged.set(bytes, serialState.buffer.length);
    serialState.buffer = merged.length > 4096 ? merged.subarray(merged.length - 4096) : merged;
  }
  serialState.lastArrival = performance.now();
  serialDrainBuffer();
}

/* BLE 同样支持断线自动重连：BLE 的断链比串口更频繁（走出范围、手机抢连接）。
   与串口一致：用户主动断开不重连；异常断开按 1s/2s/4s 退避，最多 3 次。 */
const bleReconnectState = {
  /** 最近一次成功连接过的设备（重连直接用它，不再弹选择框） */
  lastDevice: null as BleDeviceLike | null,
  reconnecting: false,
  /** 最近一次成功连接时选择的服务 UUID（重连复用，不重新读下拉——防止用户在断线期间改了选择） */
  lastServiceUuid: "",
  /** 最近一次订阅的特征 uuid（重连后优先订回同一个） */
  lastCharUuid: "",
};
const BLE_RECONNECT_MAX = 3;
/** BLE 自动重连成功次数（状态条会被后续刷新覆盖，自动化只看只增不减的计数） */
let bleReconnectCount = 0;
/** 与串口共用「自动重连」开关，但退避状态独立（两条链路互不影响） */
const bleReconnectPolicy = new ReconnectPolicy({
  maxAttempts: BLE_RECONNECT_MAX,
  baseDelayMs: 1000,
  enabled: () => serialReconnectState.enabled,
});

/**
 * 订阅意图令牌：特征切换是异步的（stopNotifications/startNotifications 都要 await），
 * 两次快速切换可能乱序完成——只有最后一次意图允许提交，否则会留下活跃但无人使用的订阅。
 */
let bleSubToken = 0;

function cancelBleReconnect(): void {
  cancelReconnect(bleReconnectState, bleReconnectPolicy);
}

async function bleAutoReconnect(): Promise<void> {
  const device = bleReconnectState.lastDevice;
  if (!device || bleState.connected || bleState.connecting || !bleReconnectState.reconnecting) return;
  // 同串口：排程后用户可能已切到串口/回放，定时器到点不得把 BLE 接回来。
  if (sourceIntent === "replay" || serialState.running || serialState.session !== null || serialState.port !== null) {
    return void abandonBleTransport();
  }
  const gen = connectionGeneration;
  const session = createBleSession(device, gen);
  const stale = (): boolean => gen !== connectionGeneration || bleState.session !== session ||
    session.lease.disposed || bleReconnectState.lastDevice !== device || !bleReconnectState.reconnecting ||
    sourceIntent === "replay" || serialState.running || serialState.session !== null || serialState.port !== null;
  bleState.session = session;
  let notifiers: BleCharacteristicLike[] = [];
  try {
    await session.lease.setup(async () => {
      const server = await device.gatt?.connect();
      // 迟到完成：这次连接尝试已经作废 → **必须自己断开**。旧的 `if (stale()) return;` 只是
      // 不提交状态，物理上却留着一个没人管理的 GATT 连接（复核 SW-05 的生产路径反例）。
      if (stale()) { closeBleGatt(device); return; }
      if (!server) throw new Error("GATT 重连失败");
      const service = await server.getPrimaryService(bleReconnectState.lastServiceUuid || bleServiceUuid());
      if (stale()) { closeBleGatt(device); return; }
      const chars = await service.getCharacteristics();
      if (stale()) { closeBleGatt(device); return; }
      notifiers = chars.filter((c) => c.properties.notify || c.properties.indicate);
      if (!notifiers.length) throw new Error("服务下没有可通知特征");
    });
    if (stale()) { await disposeBleAttempt(session); return; }
    const preferred = notifiers.find((c) => c.uuid === bleReconnectState.lastCharUuid) ?? notifiers[0];
    const ok = await bleSubscribe(preferred, gen);
    if (!ok || stale()) { await disposeBleAttempt(session); return; }
    device.addEventListener("gattserverdisconnected", session.lost);
    bleState.notifiers = notifiers;
    bleState.device = device;
    bleState.connected = true;
    sourceIntent = "ble";
    bleReconnectState.reconnecting = false;
    bleReconnectPolicy.onSuccess();
    bleReconnectCount++;
    diagnosticsApi?.dataGap(false);
    diagnosticsApi?.dataReconnect("success", { transport: "ble" });
    const btn = document.getElementById("btn-ble");
    if (btn) btn.textContent = "断开 BLE";
    bleStatus(`BLE 已自动重连 · ${device.name ?? "未命名"} · 等待数据…`);
    applyDataSourceSemantics();
    toast("BLE 已自动重连", "#7ee787");
  } catch {
    await disposeBleAttempt(session);
    if (gen !== connectionGeneration || bleState.session !== session ||
      bleReconnectState.lastDevice !== device || !bleReconnectState.reconnecting) return;
    bleState.session = null;
    bleState.char = null;
    scheduleBleReconnect("BLE 自动重连失败");
  }
}

/** 关闭一条 GATT 连接（尽力而为：可能本来就没连上/已断开） */
function closeBleGatt(device: BleDeviceLike | null): void {
  try {
    device?.gatt?.disconnect();
  } catch {
    /* 已断开 */
  }
}

/**
 * 废弃一次 BLE 连接尝试：摘掉设备掉线监听 + 断开 GATT（+ 若已挂上则摘特征监听）。
 * ROUND11 P1：初连在「服务下没有 notify 特征」等失败分支上直接 return，旧实现既不断 GATT
 * 也不摘监听——状态里 connected=false，物理上却仍连着，还留着一个掉线回调等着搞下一次连接。
 */
async function disposeBleAttempt(session: BleSession | null): Promise<void> {
  // 与串口同一套语义：lease.dispose() 返回 false（GATT 尚未真正断开 / setup 未落定）
  // 一律进入隔离重试队列，不允许在这里静默丢掉。
  if (session) await bleCleanupQueue.release(session.lease);
}

function scheduleBleReconnect(reason: string): void {
  scheduleTransportReconnect(
    diagnosticsApi, "ble", reason, BLE_RECONNECT_MAX, "请靠近设备后手动重连",
    bleReconnectState.lastDevice !== null,
    () => bleReconnectPolicy.onFailure(() => {
      void bleAutoReconnect().catch(reportTransportError);
    }),
    () => { bleReconnectState.reconnecting = true; },
    abandonBleTransport,
    bleStatus,
  );
}

/** 彻底放弃 BLE 链路（次数用尽 / 无可用设备 / 自动重连被关掉） */
function abandonBleTransport(): void {
  abandonTransport(bleReconnectState, bleReconnectPolicy);
}

/**
 * BLE 设备断开回调（命名函数：重新连接时要能把它摘掉，见下）。
 *
 * 归属校验（ROUND11 P1）：浏览器会把同一个 BluetoothDevice 对象复用给后续连接，
 * 而旧设备对象上残留的掉线回调会在**新连接建立之后**才被触发——旧实现因此清掉了
 * 新串口/新 BLE 的状态（实测：旧 lost 回调把新 B 的队列清零）。只有「当前会话的那台设备」
 * 才有资格触发断开收尾。
 */
function onBleDeviceLost(session: BleSession): void {
  if (bleState.session !== session || session.lease.disposed || !bleState.connected) return;
  const hadDevice = bleReconnectState.lastDevice !== null;
  const willRetry = hadDevice && serialReconnectState.enabled;
  // 顺序与串口一致：**先**进入过渡态，**再**刷新数据源语义。
  // 反了就会 resetSim()——复核反例 P1-D：BLE 掉线后 t 从 24 s 回到 0、reset=1。
  bleReconnectState.reconnecting = willRetry;
  bleCleanup("BLE 连接已中断（设备离开范围 / 关机 / 被别的程序占用）", true, session);
  void disposeBleAttempt(session).catch(reportTransportError);
  if (willRetry) scheduleBleReconnect("BLE 连接中断");
  else abandonBleTransport();
}

/**
 * BLE 收尾（刷新状态文案 + 清会话状态）。
 * @param target 只清理**这一套**资源（设备/特征）。给了 target 且它已经不是当前会话时，
 *   只摘自己的监听、不动 bleState（ROUND11 P1：旧设备残留的掉线回调会把新连接清掉），
 *   也**不清串口缓冲/队列**——那也是"别人"的数据。
 */
function bleCleanup(
  message: string,
  warn = false,
  target?: BleSession,
): void {
  if (target && bleState.session !== target) return;
  bleState.session = null;
  bleState.connected = false;
  bleState.char = null;
  bleState.device = null;
  bleState.notifiers = [];
  serialState.buffer = new Uint8Array(0);
  serialState.text = "";
  serialState.queue.length = 0;
  serialState.lastTickMs = -1;
  serialState.lastSeq = -1;
  // lastArrival 不清的话：先连过串口（时间戳留在当时）再连 BLE，BLE 又没立刻来通知，
  // 状态条就会按陈旧时间戳报「数据流中断 X s」，其实刚连上（serialConnect 里是清了的）。
  serialState.lastArrival = 0;
  const stopBtn = document.getElementById("btn-ble");
  if (stopBtn) stopBtn.textContent = "连接 BLE IMU";
  document.getElementById("ble-char-row")?.classList.add("hidden");
  bleStatus(message, warn);
  applyDataSourceSemantics();
}

async function bleConnect(): Promise<void> {
  const bt = navigator.bluetooth;
  if (!bt) {
    bleStatus("此浏览器不支持 Web Bluetooth（需要 Chrome/Edge + HTTPS；Firefox/Safari 不支持）", true);
    return;
  }
  const serviceUuid = bleServiceUuid();
  if (!serviceUuid) {
    bleStatus("先选或填一个服务 UUID（模块手册里有）", true);
    return;
  }
  // 防重入（与 serialConnect 同理）：授权框与 GATT 连接期间按钮仍可点。第二次进来若被 catch
  // 清掉 bleState，而第一次随后才置 connected=true，就会出现「设备物理上还连着、通知还在往队列里
  // 灌，但代码已经不认它」的僵尸连接——只能刷新页面。
  if (bleState.connected || bleState.connecting) return;
  // 与串口同理：手动连 BLE 之前取消两侧的旧重连排程，避免「掉线的串口 1 s 后自己接回来」。
  cancelPendingReconnects();
  // 先占住本次意图："我要连 BLE"。之后的「清旧链」一律用不递增世代的内部版，
  // 否则串口断开时的 ++ 会把**本次 BLE 连接自己**作废
  // （复核反例 P1-B：已连串口后发起 BLE，实测 serial=false/ble=false/gatt=false/通知数 0）。
  const connectGen = ++connectionGeneration;
  bleState.connecting = true;
  bleState.connectingGen = connectGen;
  let session: BleSession | null = null;
  const stale = (): boolean => connectGen !== connectionGeneration || bleState.connectingGen !== connectGen ||
    (session !== null && (bleState.session !== session || session.lease.disposed));
  setConnectButtonsBusy(true);
  try {
    if (serialState.running || serialState.port || serialState.session) await serialDisconnect(true);
    if (stale()) return;
    if (replayActive()) stopReplay();
    bleStatus("正在弹出设备选择框…（需要你点一下授权）");
    const device = await bt.requestDevice({ filters: [{ services: [serviceUuid] }] });
    if (stale()) return; // A chooser result has no GATT resources to disconnect.
    session = createBleSession(device, connectGen);
    bleState.session = session;
    bleStatus(`已选 ${device.name ?? device.id ?? "未命名设备"} · 正在连接 GATT…`);
    let notifiers: BleCharacteristicLike[] = [];
    await session.lease.setup(async () => {
      const server = await device.gatt?.connect();
      // 迟到完成：同上——超时/切源之后到达的 GATT 连接必须由本次尝试自己断开
      if (stale()) { closeBleGatt(device); return; }
      if (!server) throw new Error("GATT 连接失败");
      const service = await server.getPrimaryService(serviceUuid);
      if (stale()) { closeBleGatt(device); return; }
      const chars = await service.getCharacteristics();
      if (stale()) { closeBleGatt(device); return; }
      notifiers = chars.filter((c) => c.properties.notify || c.properties.indicate);
      if (!notifiers.length) throw new Error("服务下没有支持通知（notify/indicate）的特征，请检查服务 UUID");
    });
    if (stale()) { await disposeBleAttempt(session); return; }
    const ok = await bleSubscribe(notifiers[0], connectGen);
    if (!ok || stale()) { await disposeBleAttempt(session); return; }
    device.addEventListener("gattserverdisconnected", session.lost);
    bleState.notifiers = notifiers;
    const sel = document.getElementById("ble-char") as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = notifiers.map((c) => `<option value="${c.uuid}">${c.uuid}</option>`).join("");
      sel.selectedIndex = 0;
      document.getElementById("ble-char-row")?.classList.remove("hidden");
    }
    bleState.device = device;
    bleState.connected = true;
    sourceIntent = "ble";
    cancelBleReconnect();
    bleReconnectPolicy.onSuccess();
    bleReconnectState.lastDevice = device;
    bleReconnectState.lastServiceUuid = serviceUuid;
    bleReconnectState.lastCharUuid = notifiers[0].uuid;
    serialState.frames = 0;
    serialState.dropped = 0;
    serialState.backlogDropped = 0;
    serialState.skippedMsgs = 0;
    serialState.badLines = 0;
    const btn = document.getElementById("btn-ble");
    if (btn) btn.textContent = "断开 BLE";
    bleStatus(
      `BLE 已连接 · ${device.name ?? "未命名"} · 服务 ${serviceUuid.slice(0, 8)} · ` +
        `通知特征 ${notifiers[0].uuid.slice(0, 8)}（共 ${notifiers.length} 个可用）· 等待数据…`,
    );
    applyDataSourceSemantics();
    resetSim();
  } catch (err) {
    const msg = errorText(err);
    // 用户点取消是常态，不该当成错误吓人
    const cancelled = /cancel|chooser|user/i.test(msg);
    // ROUND12：异常分支也必须**按归属**释放本次尝试（旧实现直接调用无 target 的全局
    // bleCleanup：新串口连接已建立的队列会被清空，服务发现抛错时 GATT 与掉线监听还会残留）
    await disposeBleAttempt(session);
    if (connectGen === connectionGeneration && bleState.connectingGen === connectGen &&
      (!session || bleState.session === session)) {
      bleCleanup(cancelled ? "已取消设备选择" : `BLE 连接失败：${msg}`, !cancelled, session ?? undefined);
    }
  } finally {
    if (bleState.connectingGen === connectGen) {
      bleState.connecting = false;
      bleState.connectingGen = -1;
      setConnectButtonsBusy(serialState.connecting);
    }
  }
}

/**
 * 断开 BLE。
 * @param internal true = 由其它连接流程发起的「清旧链」：**不**递增世代、**不**改来源意图
 *   （递增由调用方负责，见 serialDisconnect 的同名注释与复核反例 P1-B）。
 */
async function bleDisconnect(
  internal = false,
  message = "BLE 已断开——回到模拟模式",
): Promise<void> {
  if (!internal) {
    connectionGeneration++; // 作废在途 connect await
    sourceIntent = "simulation";
  }
  const gen = connectionGeneration;
  cancelBleReconnect();
  const session = bleState.session;
  bleReconnectState.lastDevice = null;
  ++bleSubToken;
  bleState.connecting = false;
  bleState.connectingGen = -1;
  if (session) void bleCleanupQueue.release(session.lease); // Invalidate immediately, before UI cleanup.
  bleCleanup(message, false, session ?? undefined);
  setConnectButtonsBusy(serialState.connecting);
  await disposeBleAttempt(session);
  if (gen !== connectionGeneration || bleState.session) return;
}

/* 自动重连开关（串口与 BLE 共用）：关掉时立刻取消已排程的重试 */
document.getElementById("serial-autoreconnect")?.addEventListener("change", (e) => {
  serialReconnectState.enabled = (e.target as HTMLInputElement).checked;
  if (!serialReconnectState.enabled) {
    // 只取消已排程的重试；当前连接与「手动重连」都不受影响。
    // cancel* 已经把「重连过渡态」清掉（reconnecting=false），这里再刷新一次语义：
    // 若此刻本来就没活连接，界面应当立刻从「重连中…」回到模拟，而不是挂着不动。
    cancelSerialReconnect();
    cancelBleReconnect();
    applyDataSourceSemantics();
  }
});

/* Web Serial 的全局断开事件：设备被拔出时不一定立刻让 read() 报错，
   这里显式接管，保证「异常断开」一定进入自动重连流程。 */
try {
  navigator.serial?.addEventListener?.("disconnect", (ev: Event) => {
    const port = (ev as unknown as { port?: SerialPortLike }).port;
    if (!serialState.running) return;
    if (port && serialState.port && port !== serialState.port) return;
    const session = serialState.session;
    if (session) dropSerialSession(session, "真实 IMU 已拔出（系统断开事件）");
  });
} catch {
  /* 不支持或不可用：不影响其它功能 */
}

document.getElementById("btn-ble")?.addEventListener("click", () => {
  if (bleState.connected) void bleDisconnect().catch(reportTransportError);
  else void bleConnect().catch(reportTransportError);
});
document.getElementById("ble-service")?.addEventListener("change", syncBleUi);
document.getElementById("ble-char")?.addEventListener("change", () => {
  const sel = document.getElementById("ble-char") as HTMLSelectElement | null;
  const uuid = sel?.value;
  const char = bleState.notifiers.find((c) => c.uuid === uuid);
  if (char) {
    if (uuid) bleReconnectState.lastCharUuid = uuid;
    // 带上当前世代与订阅令牌：并发切换时只有**最后一次**意图能提交，
    // 否则 B/C 两个 startNotifications 都会成功，留下一个没人用的活跃订阅（ROUND11 P1）
    const gen = connectionGeneration;
    const subToken = ++bleSubToken;
    void bleSubscribe(char, gen, subToken)
      .then((ok) => {
        if (!ok && sel && bleState.char) sel.value = bleState.char.uuid;
      })
      .catch((err: unknown) => {
        // 订阅失败必须是**可报告的**（旧实现只在 .then 里处理成功路径，失败直接变成
        // 未捕获拒绝、控制台报错而界面无感——ROUND12）
        toast(`切换通知特征失败：${errorText(err)}`, "#f85149");
        if (sel && bleState.char) sel.value = bleState.char.uuid;
      });
  }
});
syncBleUi();

// ---------- 初始化 ----------
updateSourceChip();
applyMagEnable(); // 复选框默认勾选但不触发 change：必须显式同步一次 MARG 状态
applyAccelGate(); // 门控开关同理：默认勾选也要显式写入估计器
applyMagMode(); // 磁修正形态同理（默认 simplified）
setGimbalAngles(0, 0, 0);
applyView("attitude"); // 默认视图；深链可在下一步覆盖
setTelemetryVisible(false); // 玻璃盒默认关闭，写 body[data-telemetry] 供 CSS 使用
updateGravityLegend();
updateMagLegend();
applyDeepLink(); // 深链最后执行：覆盖默认视图/开关/滑块（且能正确进入四元数子模式）
updateMetricsTable();
updateMagCalUi();
updateAccelCalUi();
syncLoopAvailability();
resetSim(); // 统一时钟/统计/曲线起点（不改变已还原的深链参数）
// 初始数据源属性：不调用 applyDataSourceSemantics（它会再 reset），但徽标/自动化
// 从首帧起就必须能读到 "sim"/"real"，不能等第一次切换来源才出现。
document.body.dataset.imuMode = isExternalSource(currentDataSource()) ? "real" : "sim";

/* ==========================================================================
   单变量对照台（F-01）：按需加载装配层
   --------------------------------------------------------------------------
   对照面板连同对比曲线、Worker 协议与报告逻辑只在第一次使用时下载；
   首屏不背 runner 的第二份副本。装载后复用当前界面配置与档案事务，
   不从局部控件另拼一份配置。
   ========================================================================== */
const taskStripMount = lazyMount(() => import("./ui/task-strip")
  .then(({ mountTaskStrip }) => {
    taskStripApi = mountTaskStrip({
      onExit: (kind) => {
        if (kind === "tour") void ensureTour().then((t) => t.exit()).catch(() => {});
        else if (kind === "learning") void ensureLearningPanel().then((p) => p.reset()).catch(() => {});
      },
      onAction: (a) => diagnosticsApi?.userAction(a.kind, a.summary, a.before, a.after),
    });
    return taskStripApi;
  }), (err) => console.warn("任务条加载失败：", err));
function ensureTaskStrip(): Promise<TaskStripApi> {
  return taskStripMount(taskStripApi);
}
function setTaskContext(task: TaskDescriptor | null): void {
  void ensureTaskStrip()
    .then((api) => (task ? api.setTask(task) : api.clearTask()))
    .catch(() => { /* 任务条不是核心功能：失败不阻断实验 */ });
}
idleLoad(ensureTaskStrip, 1600);

/* ---------- 预测—验证式学习：只挂在「实验与练习」文档页 ---------- */
let learningPanel: LearningPanelApi | null = null;
function openDocAt(page: string, anchor?: string): void {
  setDocsOpen(true);
  showDocPage(page);
  if (!anchor) return;
  requestAnimationFrame(() => {
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: "start" });
  });
}
const learningPanelMount = lazyMount(() => import("./ui/learning-panel-ui")
  .then(async ({ mountLearningPanel }) => {
    const page = document.getElementById("labs");
    if (!page) throw new Error("找不到 labs 文档页");
    // 入口必须可见：插在「三条学习路径」之前，而不是追加到整页底部。
    const root = document.createElement("div");
    root.id = "learning-panel-host";
    const firstSection = page.querySelector("section");
    if (firstSection) page.insertBefore(root, firstSection);
    else page.appendChild(root);
    const panel = await mountLearningPanel(
      {
        runEvidence: async (config, _activity, shouldCancel) => {
          const runner = await loadRunner();
          const result = await runner.runExperimentDetailedAsync(config, {
            stepsPerSlice: 128,
            maxSliceMs: 4,
            ...(shouldCancel ? { shouldCancel } : {}),
          });
          return { metrics: result.metrics, termination: result.termination };
        },
        currentConfig: () => currentExperimentConfig(5),
        openDocs: openDocAt,
        closeDocs: () => setDocsOpen(false),
        loadExperiment: applyExperimentById,
        ensureComparison: ensureComparisonPanel,
        onTask: setTaskContext,
        ensureTaskStrip: ensureTaskStrip,
        toast,
      },
      root,
    );
    // 预测练习也进入统一任务上下文：读取点击后的真实状态，而不是猜按钮文案。
    root.addEventListener("click", () => {
      queueMicrotask(() => {
        const st = panel.state();
        if (!st.activityId) return;
        setTaskContext({
          kind: "learning",
          id: st.activityId,
          title: `预测练习：${st.activityTitle ?? st.activityId}`,
          conditions: "固定 5 s 离线复算证据；现场曲线可来自不同时长",
          variable: "先提交预测，再看实测证据",
          observe: "题目指标、预测与实际证据的差异",
          next: st.canReveal ? "阅读解释，或重新挑战。" : "提交预测，然后运行证据。",
          allowedIds: [],
        });
      });
    });
    learningPanel = panel;
    return panel;
  }), lazyFailure("预测练习加载失败"));
function ensureLearningPanel(): Promise<LearningPanelApi> {
  return learningPanelMount(learningPanel);
}
// 文档页首次打开前不阻塞；空闲预取后点进「实验与练习」即可用。
idleLoad(ensureLearningPanel, 1800);

/* ==========================================================================
   C/D：可观性、事件时间轴、历史回看、ESKF 单步解剖
   --------------------------------------------------------------------------
   服务与四个面板都在 teaching-ui 按需 chunk 里；默认不采样、不分配。
   只有用户打开「玻璃盒」分区才创建服务；回看帧与 ESKF 快照另有各自开关。
   ========================================================================== */
function estimatorGateEnabled(e: Estimator): boolean {
  return e.id === "comp" || e.id === "mahony" || e.id === "madg"
    ? (e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator).accelGate
    : false;
}
const diagnosticsMount = lazyMount(() => import("./ui/telemetry-diagnostics-ui")
  .then(({ createTelemetryDiagnostics }) => {
    const root = document.getElementById("body-telemetry");
    if (!root) throw new Error("缺少玻璃盒面板容器");
    const getKalman = (): KalmanEstimator | undefined =>
      ests.find((e) => e.id === "kalman") as KalmanEstimator | undefined;
    diagnosticsApi = createTelemetryDiagnostics({
    root,
    getEstimators: () => ests.filter((e) => e.id !== "truth").map((e) => ({
      id: e.id as EstimatorId,
      label: e.label,
      telemetry: e.telemetry,
    })),
    getSelected: () => {
      const est = state.source === "truth"
        ? ests.find((e) => e.id === "mahony") ?? null
        : ests.find((e) => e.id === state.source) ?? null;
      if (!est) return null;
      return {
        id: est.id as EstimatorId,
        label: est.label,
        magEnabled: est.magEnabled,
        gateEnabled: estimatorGateEnabled(est),
        telemetry: est.telemetry,
        q: est.q,
      };
    },
    getTruth: () => {
      const kind = currentReferenceKind();
      const hasTruth = kind === "groundTruth" || kind === "external";
      return {
        kind,
        q: hasTruth ? referenceQ() : null,
        label: hasTruth ? (kind === "groundTruth" ? "模拟真值" : "外部参考") : "无真值参考",
      };
    },
    getKalmanSnapshot: () => latestKalmanStep,
    getTime: () => state.simTime,
    getRunId: () => solveRunId,
    setCursor: (t) => setSharedCursor(t),
    openDocs: openDocAt,
      setKalmanSink: (sink) => {
        const kalman = getKalman();
        if (!kalman) return;
        kalman.diagnostics = sink ? (snap) => { latestKalmanStep = snap; sink(snap); } : undefined;
        if (!sink) latestKalmanStep = null;
      },
      setKalmanFullMatrix: (on) => {
        const kalman = getKalman();
        if (kalman) kalman.diagFullP = on;
      },
    });
    return diagnosticsApi;
  }), lazyFailure("教学诊断面板加载失败"));
function ensureDiagnostics(): Promise<TelemetryDiagnosticsApi> {
  return diagnosticsMount(diagnosticsApi);
}
function activateDiagnostics(): void {
  void ensureDiagnostics().catch(() => { /* 已提示 */ });
}
document.querySelector<HTMLButtonElement>("#sec-telemetry .panel-toggle")?.addEventListener("click", activateDiagnostics);
document.getElementById("telemetry-toggle")?.addEventListener("change", activateDiagnostics);
// 诊断按钮的真实 GUI 入口：与自动化 open/setReviewCapture 共用同一服务，不另建面板。
const diagButtonWiring: [string, () => void][] = [
  ["btn-diag-review", () => { void ensureDiagnostics().then((api) => api.setReviewCapture(!api.state().reviewCapture)); }],
  ["btn-diag-eskf", () => { void ensureDiagnostics().then((api) => api.setEskfEnabled(!api.state().eskfEnabled)); }],
  ["btn-diag-obs", activateDiagnostics],
  ["btn-diag-events", activateDiagnostics],
];
for (const [id, onClick] of diagButtonWiring) document.getElementById(id)?.addEventListener("click", onClick);






let comparisonPanel: ComparisonPanelApi | null = null;
let comparisonTaskActive = false;
const comparisonPanelMount = lazyMount(() => import("./ui/comparison-panel")
  .then(({ mountComparisonPanel }) => {
    const panel = mountComparisonPanel({
    // 对照固定 10 s：两轮完整运行仍可交互；与在线仿真现场分开，不改当前曲线。
    baseConfig: () => currentExperimentConfig(10),
    applyConfig: (cfg) => {
      const applied = applyArchiveChecked(cfg);
      return applied.ok
        ? { ok: true, warnings: applied.warnings }
        : { ok: false, error: applied.error };
    },
    toast,
    getConfigRevision: () => configRevision,
    buildInfo: {
      commit: BUILD_INFO.commit,
      builtAt: BUILD_INFO.builtAt,
      buildId: BUILD_IDENTITY.buildId,
    },
    onTaskState: (s) => {
      if (s.state === "empty") {
        if (comparisonTaskActive) {
          comparisonTaskActive = false;
          setTaskContext(null);
        }
        return;
      }
      comparisonTaskActive = true;
      const running = s.state === "running-a" || s.state === "running-b";
      setTaskContext({
        kind: "comparison",
        id: s.kind ?? "comparison",
        title: running ? "单变量对照 · 运行中" : s.reportReady ? "单变量对照 · 已完成" : "单变量对照",
        conditions: "同一配置与种子；A/B 两次独立完整运行",
        variable: s.kind ?? "尚未选择变量",
        observe: "同窗口指标、A/B 总误差曲线与配置差异",
        next: running ? "可等待完成或取消；完成前不显示最终差值。" : s.reportReady ? "查看差值、导出报告，或显式将 B 应用到装置。" : "选择唯一变量并运行对照。",
        allowedIds: [],
      });
    },
  });
    comparisonPanel = panel;
    return panel;
  }), lazyFailure("对照台加载失败"));
function ensureComparisonPanel(): Promise<ComparisonPanelApi> {
  return comparisonPanelMount(comparisonPanel);
}
document.querySelector<HTMLButtonElement>("#sec-compare .panel-toggle")?.addEventListener("click", () => {
  void ensureComparisonPanel().catch(() => { /* 已提示 */ });
});
// 空闲预取：不占首屏关键路径；用户第一次点开时通常已就绪。
idleLoad(ensureComparisonPanel, 1500);

// ---------- 只读实验报告（tools-ui 按需 chunk）：生成 / 打印 / 导出 JSON / 导入只读查看 ----------
let reportPanel: ReportPanelApi | null = null;
const reportPanelMount = lazyMount(() => import("./ui/report-panel-ui")
  .then(({ mountReportPanel }) => {
    const root = document.getElementById("diag-report-host");
    const fileInput = document.getElementById("report-file") as HTMLInputElement | null;
    if (!root || !fileInput) throw new Error("缺少实验报告面板容器");
    reportPanel = mountReportPanel({
    root,
    fileInput,
    archive: () => buildArchive(),
    // 构建身份取不到就如实写 null（报告里显示「无构建信息」），不编造。
    build: () => BUILD_IDENTITY.buildId && BUILD_IDENTITY.sourceDigest
      ? { buildId: BUILD_IDENTITY.buildId, sourceDigest: BUILD_IDENTITY.sourceDigest }
      : null,
    // null = 诊断事件采集从未开启；[] = 已采集但窗口内无事件。两者语义不同。
    events: () => diagnosticsApi?.events() ?? null,
    comparison: () => comparisonPanel?.result() ?? null,
    toast,
    download: downloadExport,
    nowIso: () => new Date().toISOString(),
    print: () => window.print(),
  });
    return reportPanel;
  }), lazyFailure("实验报告加载失败"));
function ensureReportPanel(): Promise<ReportPanelApi> {
  return reportPanelMount(reportPanel);
}
document.getElementById("btn-diag-report")?.addEventListener("click", () => {
  void ensureReportPanel().then((api) => api.generate()).catch(() => { /* 已提示 */ });
});
document.getElementById("btn-diag-report-import")?.addEventListener("click", () => {
  void ensureReportPanel().then((api) => api.pickFile()).catch(() => { /* 已提示 */ });
});

const openLazy = (ensure: () => Promise<unknown>): (() => Promise<boolean>) =>
  async () => { await ensure(); return true; };

// 控制台调试入口（教学/自动化验收用）：不参与 UI，不影响性能
(window as unknown as { attitudeDemo: unknown }).attitudeDemo = {
  scene: sceneHandles.scene,
  /** 当前画质档（"software" = 检测到软件光栅化，已关 MSAA/阴影/IBL） */
  renderQuality: (): "high" | "software" => sceneHandles.quality,
  camera: sceneHandles.camera,
  renderer: sceneHandles.renderer,
  controls,
  state,
  ests,
  performance: (reset = false) => {
    const snapshot = { count: framePerformance.count, max: { ...framePerformance.max } };
    if (reset) {
      framePerformance.count = 0;
      for (const key of Object.keys(framePerformance.max) as Array<keyof typeof framePerformance.max>) framePerformance.max[key] = 0;
    }
    return snapshot;
  },
  serialConsumption: () => ({ ...serialConsumed }),
  installSerialConsumptionObserver: (callback: ((event: {count:number;at:number;t:number}) => void) | null): void => { serialConsumptionObservers.callback = callback; },
  world,
  imuParams,
  solveState,
  /**
   * 深链的三个清单（自动化验收用）：把「所有 range/checkbox/select」与它们做差集，
   * 就能在任何时候回答「用户改了哪个控件但分享链接没带走」——这是会随控件增加而
   * 悄悄失效的一类覆盖度问题（原先靠一次性人工审计）。
   */
  /**
   * 立刻算出当前状态的深链字符串（不依赖主循环 10 Hz 的 updateHash）。
   * 自动化测试必须用它而不是读 location.hash —— 后者是「帧循环顺手写的」，
   * 时序上可能落后于刚设的值（CI 上就这么假失败过一次），而且失败的其实是测试而不是功能。
   */
  encodeDeepLink: (): string => deepHash(),
  deepLink: (): { keys: string[]; checks: string[]; sels: string[] } => ({
    keys: [...DEEP_KEYS],
    checks: [...DEEP_CHECKS],
    sels: [...DEEP_SELS],
  }),
  /**
   * 数据通路的内部状态（自动化验收用）：三条通路是否互斥、半解析缓冲有没有清干净、
   * 帧计数在「一个通知/一帧数据」下应该只 +1。这些量在 UI 上看不到，但正是
   * 「切换特征后帧率翻倍」「换安装方向后拼出错帧」这类缺陷的判据。
   */
  plumbing: (): {
    serial: boolean;
    ble: boolean;
    replay: boolean;
    connecting: boolean;
    bytes: number;
    text: number;
    queue: number;
    frames: number;
    badLines: number;
    dropped: number;
    skipped: number;
    protocol: string;
    reconnects: number;
    bleReconnects: number;
    /** 是否处于「断线重连过渡态」（此刻数据流冻结、但实验不清零） */
    reconnectPending: boolean;
    /** 当前数据源身份：过渡态下保持用户原来的来源，不退回 simulation */
    sourceKind: DataSourceKind;
    /** 已打开但未关闭的端口数（严格端口回收的观测点：重连失败后必须为 0） */
    openPorts: number;
    /** close() 失败次数（读锁未释放等）：必须为 0，否则"有开必有关"只是自我安慰 */
    portCloseFailures: number;
    /** 解算入口拒绝的源帧数（实时队列满；离线回放必须为 0） */
    solveDropped: number;
    /** 关闭失败、仍在后台重试释放的串口会话数（应为 0） */
    pendingPortCleanup: number;
    /** BLE 侧未完成的释放数（GATT 句柄不许悬空，应为 0） */
    pendingBleCleanup: number;
    /** 复位次数（诊断）：短时间内快速增长说明有事件在自激复位 */
    simResets: number;
  } => ({
    serial: serialState.running,
    ble: bleState.connected,
    replay: replayActive(),
    connecting: serialState.connecting || bleState.connecting,
    bytes: serialState.buffer.length,
    text: serialState.text.length,
    queue: serialState.queue.length,
    frames: serialState.frames,
    badLines: serialState.badLines,
    dropped: serialState.dropped,
    skipped: serialState.skippedMsgs,
    protocol: serialProtocol(),
    /** 串口自动重连成功累计次数（异常断开 → 退避重连成功 +1） */
    reconnects: serialReconnectCount,
    /** BLE 自动重连成功累计次数 */
    bleReconnects: bleReconnectCount,
    reconnectPending: reconnectPending(),
    sourceKind: currentDataSource().kind,
    openPorts: serialOpenPorts,
    portCloseFailures,
    solveDropped: solveLoop.droppedFrames,
    pendingPortCleanup: serialCleanup.size,
    /** BLE 侧同样必须为 0：GATT 句柄不许悬空 */
    pendingBleCleanup: bleCleanupQueue.size,
    simResets: simResetCount,
  }),
  /**
   * 长跑稳定性自检出口：四个「会被不断 push」的容器当前长度与容量。
   * 装置是常驻页面（演示时一开几十分钟），所以这些数字必须**封顶**而不是随时间增长。
   */
  sizes: (): {
    simTime: number;
    logRows: number;
    logRowsCap: number;
    rawRows: number;
    rawRowsCap: number;
    insTrailMax: number;
    insTrailCap: number;
    serialQueue: number;
    serialQueueCap: number;
    charts: { count: number; cap: number; attempts: number; draws: number; skips: number }[];
    uiWork: {
      telemetryAttempts: number;
      telemetryWrites: number;
      metricsAttempts: number;
      metricsWrites: number;
      insPlaceholderDraws: number;
    };
  } => ({
    simTime: state.simTime,
    logRows: logRows.length,
    logRowsCap: LOG_ROW_CAP,
    rawRows: rawRecord.rows.length,
    rawRowsCap: RAW_ROW_CAP,
    insTrailMax: Math.max(0, ...[...insTrails.values()].map((t) => t.length)),
    insTrailCap: 2 * 900,
    serialQueue: serialState.queue.length,
    serialQueueCap: SERIAL_QUEUE_MAX,
    charts: [attChart.size, errChart.size, imuChart.size],
    uiWork: { ...uiWorkCounters },
  }),
  /**
   * 可复现实验出口（自动化与批量评测用）：
   * config() 返回当前界面的完整数值配置；run() 用无 DOM runner 跑一次并返回
   * 指标 + digest（同配置同 seed 必须逐位一致）；archive() 返回实验档案对象。
   */
  experiment: {
    config: (durationSec = 30): ExperimentConfig => currentExperimentConfig(durationSec),
    /** 批量评测的执行路径（自动化验收用）：worker = Web Worker，main = 主线程分片回退 */
    batchMode: (): "worker" | "main" | null => batchLastMode,
    batchResult: () => batchCompletedResult ? { ...batchCompletedResult, seeds: batchCompletedResult.seeds.slice(), summary: batchCompletedResult.summary.map((row) => ({ ...row })) } : null,
    /** 批量评测的运行/取消状态（自动化验收用）：running 期间再点按钮 = 取消 */
    batchState: (): {
      running: boolean; activeJob: number; cancels: number; button: string; generation: number;
      mode: "worker" | "main" | null; cancelLatencyMs: number | null; partialSeeds: number; workerDisabled: boolean;
      slices: { count: number; maxComputeMs: number };
      cancelTiming: typeof batchCancelTiming;
    } => ({
      running: batchRunning,
      activeJob: activeBatchJob,
      cancels: batchCancelCount,
      button: document.getElementById("btn-batch")?.textContent ?? "",
      /** 世代号：取消/新批次会 +1；自动化用它确认「旧世代没有回写」 */
      generation: batchGeneration,
      /** 执行路径与取消证据（SW-10）：取消时延 = 从点取消到计算真正停下 */
      mode: batchLastMode,
      cancelLatencyMs: batchCancelLatencyMs,
      partialSeeds: batchPartialSeeds,
      workerDisabled: batchWorkerDisabled,
      slices: { ...batchSlices },
      cancelTiming: { ...batchCancelTiming },
    }),
    /** 强制走主线程降级路径（自动化验收用）：返回是否已生效 */
    disableWorker: (): boolean => {
      batchWorkerDisabled = true;
      return batchWorkerDisabled;
    },
    /**
     * 同步推进**界面自己的仿真** n 个 500 Hz 步（等价于把 rAF 主循环按固定步长跑 n 次）。
     * 用途只有一个：让自动化能把「界面路径」与「runner 路径」放在同一时间基上逐帧比对
     * （真实浏览器里没法等真实时间精确对齐，而 golden trace 必须逐帧同 t）。
     *
     * 要求：数据源为模拟、闭环关闭、A/B 关闭、不要有任何延迟/带宽/降采样（否则界面
     * 的实时路径本身就不该与离线内核逐帧相同）。调用方负责把现场设成这些条件。
     */
    stepSimBy: (steps: number): { simTime: number; finalQuats: Record<string, Quat> } => {
      const n = Math.max(0, Math.floor(steps));
      for (let i = 0; i < n; i++) stepSim();
      const finalQuats: Record<string, Quat> = {};
      for (const e of ests) finalQuats[e.id] = { ...e.q };
      return { simTime: state.simTime, finalQuats };
    },
    /** runner 侧同一条 trace：同 step 数、同配置（不需要真等 500 Hz × n 的真实时间） */
    runTrace: async (steps: number): Promise<{ simTime: number; finalQuats: Record<string, Quat> }> => {
      const cfg = { ...currentExperimentConfig(1), durationSec: Math.max(0.002, steps * RUN_H) };
      const r = (await loadRunner()).runExperiment(cfg);
      const finalQuats: Record<string, Quat> = {};
      for (const [id, q] of Object.entries(r.finalQuats)) finalQuats[id] = { ...q };
      return { simTime: r.window.endSec, finalQuats };
    },
    /**
     * **逐帧 trace**（自动化验收用）：界面侧每解算一步记录时间与五算法姿态；
     * runner 侧用 `runner.runTrace`（同一份 SolveLoop）。两者逐帧比对才能发现
     * 「中途偏差被末态掩盖」的问题——只比终点是不够的。
     */
    traceFrames: async (
      steps: number,
    ): Promise<Array<{
      t: number;
      dt: number;
      quats: Array<{ w: number; x: number; y: number; z: number }>;
      aligned: boolean;
      raw: { gyro: number[]; accel: number[]; mag: number[] };
      consumed: { accel: number[]; mag: number[] };
    }>> => {
      const n = Math.max(0, Math.floor(steps));
      const frames: Array<{
        t: number;
        dt: number;
        quats: Array<{ w: number; x: number; y: number; z: number }>;
        aligned: boolean;
        raw: { gyro: number[]; accel: number[]; mag: number[] };
        consumed: { accel: number[]; mag: number[] };
      }> = [];
      const { TraceEvents } = await import("./core/trace-events");
      const events = new TraceEvents();
      let rec = true;
      solveLoop.setHooks({
        onAlign: (ev) => { still.chipUntil = performance.now() / 1000 + 3; events.align(ev.t); },
        onSolve: (ctx) => {
          onSolveDefault(ctx);
          events.solve(ests);
          if (rec) {
            frames.push({
              t: ctx.t,
              dt: ctx.dt,
              quats: ests.map((e) => ({ ...e.q })),
              aligned: ctx.aligned,
              raw: { gyro: [...ctx.sample.gyro], accel: [...ctx.sample.accel], mag: [...ctx.sample.mag] },
              consumed: { accel: [...ctx.accel], mag: [...ctx.mag] },
            });
          }
        },
      });
      for (let i = 0; i < n; i++) stepSim();
      rec = false;
      // 还原默认钩子（INS 仍在推进，但不再记录）
      solveLoop.setHooks({ onSolve: onSolveDefault, onAlign: () => { still.chipUntil = performance.now() / 1000 + 3; } });
      uiTraceEvents = { alignTimes: events.alignTimes, eventCounts: events.eventCounts };
      return frames;
    },
    /** runner 侧逐帧 trace（与 traceFrames 同口径：时间 + 五算法姿态） */
    traceEvents: () => ({ alignTimes: uiTraceEvents.alignTimes.slice(), eventCounts: { ...uiTraceEvents.eventCounts } }),
    traceFramesRunner: async (steps: number) => {
      const cfg = { ...currentExperimentConfig(1), durationSec: Math.max(0.002, steps * RUN_H) };
      const tr = (await loadRunner()).runTrace(cfg, Math.max(1, Math.floor(steps)));
      return {
        steps: tr.steps.map((st) => ({
          t: st.t,
          dt: st.dt,
          quats: st.quats.map((q) => ({ ...q })),
          aligned: st.aligned,
          raw: st.raw,
          consumed: st.consumed,
        })),
        eventCounts: tr.eventCounts,
        alignTimes: tr.alignTimes,
        estimatorIds: tr.estimatorIds,
        endSec: tr.endSec,
      };
    },
    /**
     * 主线程分片批量评测（自动化复算/Worker 降级验证用）：与面板同一条聚合口径，
     * 但同步阻塞——只应在脚本里用，不要接进界面按钮（界面走 Worker 路径）。
     */
    batchOnMain: async (durationSec = 10, count = 3): Promise<BatchSummary> => {
      const runner = await loadRunner();
      return runner.runMonteCarlo(currentExperimentConfig(durationSec), count).summary;
    },
    setSeed: (seed: number): void => {
      experimentConfig.seed = Math.max(0, Math.floor(seed)) >>> 0;
      if (seedInput) seedInput.value = String(experimentConfig.seed);
      resetSim();
    },
    run: async (durationSec = 2, seedOffset = 0): Promise<{ digest: string; metrics: EstimatorRunMetrics[] }> => {
      const runner = await loadRunner();
      const r = runner.runExperiment({ ...currentExperimentConfig(durationSec), seed: currentExperimentConfig(durationSec).seed + seedOffset });
      return { digest: runner.resultDigest(r), metrics: r.metrics };
    },
    archive: (): ExperimentArchive => buildArchive(),
    /**
     * 导入档案配置（自动化验收用）：走与用户导入完全相同的迁移 + 校验 + 应用路径，
     * 返回应用后的**校准状态快照**，用来验证「档案确实恢复了同一配置」。
     */
    importArchive: (rawArchive: unknown): {
      ok: boolean;
      error?: string;
      config?: ExperimentConfig;
      magModel?: MagCalModel;
      magApplied?: boolean;
      accelApplied?: boolean;
      magOffset?: V3;
      seed?: number;
      notRestored?: string[];
      warnings?: string[];
    } => {
      const parsed = parseArchive(rawArchive);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const cfg = parsed.config;
      const applied = applyArchiveChecked(cfg);
      if (!applied.ok) return { ok: false, error: applied.error };
      return {
        ok: true,
        config: currentExperimentConfig(cfg.durationSec),
        magModel: currentMagCalModel(),
        magApplied: magCalState.applied && magCalState.cal !== null,
        accelApplied: accelCalState.applied && accelCalState.cal !== null,
        magOffset: magCalState.cal ? ([...magCalState.cal.offset] as V3) : undefined,
        seed: experimentConfig.seed,
        notRestored: applied.notRestored,
        warnings: applied.warnings,
      };
    },
    /**
     * 导入事务的「现场快照」（自动化断言用）：**失败**的导入必须逐项不变。
     * 旧实现先真正 apply（清历史/重置仿真），再读回失败、再把旧配置写回，
     * 于是曲线/记录/校准历史/A/B 已经丢了，提示却写「已保持原配置」。
     */
    site: (): {
      simTime: number;
      chartSizes: { count: number; cap: number }[];
      logRows: number;
      rawRows: number;
      magHistory: number;
      accelSamples: number;
      abOn: boolean;
      abMode: string;
      replayIdx: number;
      replayRunning: boolean;
      seed: number;
      steadyFromSec: number | null;
      autoCoarseAlign: boolean;
      /** 闭环开关的勾选与禁用（场景联动会改写它们：探测写控件曾把它抹掉） */
      loopOn: boolean;
      loopDisabled: boolean;
      /** IMU 预设标签与说明文字（写控件会"顺手"改写它们） */
      preset: string;
      presetNote: string;
      /** 运行/暂停状态 */
      paused: boolean;
      /** 真实播放标志（与按钮文字同源，但直接读状态：二者脱钩本身就是要抓的缺陷） */
      playing: boolean;
      /** 档案探测/导入是否产生过提示（单调计数：失败导入不得留下提示） */
      toasts: number;
      /** 校准面板文字（渲染异常会在这里留下 NaN/undefined） */
      magText: string;
      accelText: string;
      /** 曲线内容摘要（写控件不得悄悄清空曲线） */
      chartDigest: number;
      /** 估计器内部状态摘要：探测不得重置解算状态 */
      estDigest: string;
      /** A/B 运行态：克隆数量、冻结参数、B 组姿态摘要 */
      abDigest: string;
      /** 加计采集的挂起/窗口状态 */
      accelPending: boolean;
      accelWindow: number;
      /** 磁采集状态 */
      magCollecting: boolean;
      magSamples: number;
    } => ({
      simTime: state.simTime,
      chartSizes: [attChart.size, errChart.size, imuChart.size],
      chartDigest: attChart.contentDigest() + errChart.contentDigest() + imuChart.contentDigest(),
      logRows: logRows.length,
      rawRows: rawRecord.rows.length,
      magHistory: magCalHistory.length,
      accelSamples: accelCalState.samples.length,
      abOn: ($("ab-toggle") as HTMLInputElement | null)?.checked ?? false,
      abMode: ($("ab-mode") as HTMLSelectElement | null)?.value ?? "",
      replayIdx: replayState.idx,
      replayRunning: replayActive(),
      seed: experimentConfig.seed,
      steadyFromSec,
      autoCoarseAlign: solveLoop.autoCoarseAlign,
      loopOn: ($("loop-toggle") as HTMLInputElement | null)?.checked ?? false,
      loopDisabled: ($("loop-toggle") as HTMLInputElement | null)?.disabled ?? false,
      preset: ($("imu-preset") as HTMLSelectElement | null)?.value ?? "",
      presetNote: document.getElementById("imu-preset-note")?.textContent ?? "",
      paused: ($("btn-pause")?.textContent ?? "") === "继续",
      playing: state.playing,
      toasts: toastSeq,
      magText: document.getElementById("magcal-result")?.textContent ?? "",
      accelText: document.getElementById("accelcal-result")?.textContent ?? "",
      estDigest: JSON.stringify(ests.map((e) => ({ id: e.id, q: e.q, mag: e.magEnabled }))),
      abDigest: JSON.stringify({
        on: abState.on,
        frozen: abState.frozenTuning,
        clones: abState.clones.map((c) => ({ id: c.id, q: c.q })),
      }),
      accelPending: accelCalState.pending !== null,
      accelWindow: accelCalState.window.length,
      magCollecting: magCalState.collecting,
      magSamples: magCalState.samples.length,
    }),
  },
  /** 构建标识（部署后 smoke 用）：线上页面报的提交必须等于被部署的那个 */
  /**
   * 单变量对照台的自动化出口（用户路径仍是右侧面板按钮）。
   * 所有会改变状态的入口都先等待按需装配层完成，避免测试在模块未挂载时读到 null
   * 却误判为功能失败。
   */
  diagnostics: {
    open: openLazy(ensureDiagnostics),
    state: () => diagnosticsApi?.state() ?? null,
    setReviewCapture: (on: boolean): void => diagnosticsApi?.setReviewCapture(on),
    setEskfEnabled: (on: boolean): void => diagnosticsApi?.setEskfEnabled(on),
    setEskfFullMatrix: (on: boolean): void => diagnosticsApi?.setEskfFullMatrix(on),
    events: () => diagnosticsApi?.events() ?? [],
    evidence: () => diagnosticsApi?.evidence() ?? null,
    seekEvidence: (delta: -1 | 0 | 1) => diagnosticsApi?.seekEvidence(delta) ?? null,
    reviewOverride: () => diagnosticsApi?.reviewOverride() ?? null,
  },
  learning: {
    open: openLazy(ensureLearningPanel),
    state: () => learningPanel?.state() ?? null,
    setActivity: async (id: string): Promise<void> => (await ensureLearningPanel()).setActivity(id),
    submitPrediction: async (answer: PredictionAnswer) => (await ensureLearningPanel()).submitPrediction(answer),
    run: async () => (await ensureLearningPanel()).run(),
    reset: async (): Promise<void> => (await ensureLearningPanel()).reset(),
  },
  task: {
    open: openLazy(ensureTaskStrip),
    state: () => taskStripApi?.state() ?? null,
    clear: async (): Promise<void> => {
      (await ensureTaskStrip()).clearTask();
    },
  },
  comparison: {
    open: openLazy(ensureComparisonPanel),
    state: (): ComparisonPanelSnapshot | null => comparisonPanel?.state() ?? null,
    result: () => comparisonPanel?.result() ?? null,
    setWindow: async (durationSec: number): Promise<void> => {
      (await ensureComparisonPanel()).setWindow(durationSec);
    },
    freeze: async (): Promise<void> => {
      (await ensureComparisonPanel()).freeze();
    },
    selectVariable: async (id: string): Promise<void> => (await ensureComparisonPanel()).selectVariable(id),
    run: async (): Promise<void> => (await ensureComparisonPanel()).run(),
    cancel: async (): Promise<void> => (await ensureComparisonPanel()).cancel(),
    disableWorker: async (): Promise<void> => (await ensureComparisonPanel()).disableWorker(),
    applyB: async (): Promise<ComparisonApplyResult> => (await ensureComparisonPanel()).applyB(),
  },
  build: () => ({ ...BUILD_INFO, ...BUILD_IDENTITY }),
  /** 校准状态快照（自动化验收用）：模型、是否应用、对象是否在 */
  calibration: (): {
    magModel: MagCalModel;
    magApplied: boolean;
    accelApplied: boolean;
    hasMag: boolean;
    hasAccel: boolean;
    /** 当前磁/加计的「标定基于旧模型」提示（null = 仍匹配） */
    magStale: string | null;
    accelStale: string | null;
    /** 拟合时记录的器件指纹（诊断用） */
    magFittedWith: ReturnType<typeof fingerprintOf> | null;
    accelFittedWith: ReturnType<typeof fingerprintOf> | null;
    imu: { accelCrossAxis: number; accelNonlin: number; accelNoise: number };
  } => ({
    magModel: currentMagCalModel(),
    magApplied: magCalState.applied && magCalState.cal !== null,
    accelApplied: accelCalState.applied && accelCalState.cal !== null,
    hasMag: magCalState.cal !== null,
    hasAccel: accelCalState.cal !== null,
    magStale: calibrationStaleness(magCalState.cal?.fittedWith, imuParams, "mag", currentMagCalModel()),
    accelStale: calibrationStaleness(accelCalState.cal?.fittedWith, imuParams, "accel"),
    magFittedWith: magCalState.cal?.fittedWith ?? null,
    accelFittedWith: accelCalState.cal?.fittedWith ?? null,
    imu: {
      accelCrossAxis: imuParams.accelCrossAxis,
      accelNonlin: imuParams.accelNonlin,
      accelNoise: imuParams.accelNoise,
    },
  }),
  /** A/B 运行期状态（自动化验收用）：分叉后 B 的 q 应与 A 快照时刻一致；同起点则两组都回到初值 */
  ab: (): {
    on: boolean;
    mode: string;
    frozen: Record<string, EstimatorTuning> | null;
    clones: Array<{ id: string; q: Quat; angleToA: number }>;
  } => ({
    on: abState.on,
    mode: ($<HTMLSelectElement>("ab-mode"))?.value ?? "same-start",
    frozen: abState.frozenTuning,
    clones: abState.clones.map((c) => {
      const a = ests.find((e) => e.id === c.id)!;
      return {
        id: c.id,
        q: { ...c.q },
        angleToA: qAngleBetween(c.q, a.q) * DEG,
      };
    }),
  }),
  /** 全帧记录/轨迹长度（长跑与导出用例用） */
  raw: (): { on: boolean; rows: number; cap: number; calibrated: boolean } => ({
    on: rawRecord.on,
    rows: rawRecord.rows.length,
    cap: RAW_ROW_CAP,
    /** 本段全帧记录的**语义**：读数是否本来就是校准后的（回放校准日志时为真）。
     *  自动化靠它做状态等待——换源后 600 ms 可能一帧都没进，固定 sleep 会读到上一段。 */
    calibrated: rawRecord.sourceCalibrated,
  }),
  /** 加速度计六面校准调试入口：注入样本 → 走真实拟合/应用路径（自动化测试用） */
  accelcal: {
    inject: (samples: AccelCalibrationSample[]): { ok: boolean; applied: boolean; rmse: number } => {
      accelCalState.samples = samples.map((s) => ({ raw: [...s.raw] as V3, face: s.face }));
      fitAccelCal();
      return {
        ok: accelCalState.cal !== null,
        applied: accelCalState.applied,
        rmse: accelCalState.cal ? Math.max(...accelCalState.cal.rmse) : NaN,
      };
    },
    /** 采面驱动（自动化验收用）：直接调用**生产**的 beginAccelCalFace/tickAccelCalibration */
    beginFace: (face: AccelFace): void => beginAccelCalFace(face),
    feed: (t: number, accel: V3, gyro: V3 = [0, 0, 0]): void =>
      tickAccelCalibration(t, { gyro: [...gyro] as V3, accel: [...accel] as V3, mag: [30, 0, 40] as V3 }),
    cancelFace: (): void => {
      accelCalState.pending = null;
      accelCalState.window = [];
    },
    info: (): { samples: number; applied: boolean; rmse: number; faces: number; message: string } => ({
      samples: accelCalState.samples.length,
      faces: accelCalState.samples.length,
      message: accelCalState.message,
      applied: accelCalState.applied,
      rmse: accelCalState.cal ? Math.max(...accelCalState.cal.rmse) : NaN,
    }),
    /** 拟合参数的只读诊断（不会重新生成样本或改变验证状态） */
    verifyDebug: (): { calM: number[] | null; bias: V3 | null } => ({
      calM: accelCalState.cal ? [...accelCalState.cal.M] : null,
      bias: accelCalState.cal ? [...accelCalState.cal.bias] as V3 : null,
    }),
  },
  /**
   * 打开某个文档分页（自动化逐页验收用）。
   * 左栏没有对应按钮的页面（四个算法详情页与磁校准页）**只能**通过它激活，
   * 否则「全部页面都测过」的断言其实是重复扫描同一页（复核反例）。
   */
  openDocPage: (page: string): boolean => {
    const exists = document.querySelector(`.doc-page[data-doc-page="${page}"]`) !== null;
    if (!exists) return false;
    showDocPage(page);
    return true;
  },
  /** 实验库/挑战目录就绪（失败也会 resolve：面板为空并已 toast，不会卡住调用方） */
  catalogReady: (): Promise<void> => catalogsReadyPromise,
  /** 引导课程的入口（自动化测试用；正常路径是右侧栏「引导课程」面板上的按钮） */
  tour: {
    start: (): void => { void ensureTour().then((t) => t.start()).catch(() => {}); },
    next: (): void => tour?.next(),
    prev: (): void => tour?.prev(),
    goto: (n: number): void => tour?.goto(n),
    exit: (): void => tour?.exit(),
    get info() {
      return { active: tour?.active() ?? false, index: tour?.index() ?? 0, total: tour?.total() ?? 0 };
    },
  },
  /** 离线回放的调试/自动化入口：直接喂 CSV 文本（绕开文件选择框，便于 E2E 测试） */
  replay: {
    import: (text: string, name = "clipboard.csv"): string => {
      const res = parseImuCsv(text);
      if (res.error) return `error: ${res.error}`;
      startReplay(res, name);
      return `ok:${res.frames.length} 帧 / ${replayDuration().toFixed(2)} s`;
    },
    stop: (): void => stopReplay(),
    get info() {
      return {
        active: replayActive(),
        frames: replayState.frames.length,
        idx: replayState.idx,
        speed: replayState.speed,
        real: state.real,
        /**
         * 时长与进度**唯一来源**是 ReplayPlayer 的有效时间轴：
         * 页面提示、状态条、调试出口读的都是这两个数，不再各自计算（末帧时间回退时旧口径会偏短）。
         */
        durationSec: replayPlayer.durationSec,
        playedSec: replayPlayer.playedSec,
        /** 日志声明的 IMU 语义（true=已校准）、当前是否在校准输入（false=原样解算） */
        imuCalibrated: replayState.imuCalibrated,
        applyCalibration: replayState.applyCalibration,
      };
    },
  },
  get sceneHandles() {
    return sceneHandles;
  },
};
