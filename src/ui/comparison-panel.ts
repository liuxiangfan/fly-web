/**
 * 单变量对照台（F-01）的装配层。
 *
 * 边界
 * ----
 * - 基线由调用方通过 `baseConfig()` 提供，这里只快照，不读控件、不重置仿真；
 * - A/B 配置只由 `core/comparison-config.ts` 的白名单生成器产生，UI 不手写字段；
 * - Worker 是默认路径；Worker 不可用/报错才降级到主线程**异步**详细 runner，
 *   绝不退回同步 runner（否则长跑会冻结页面）；
 * - runner、comparison-report 与 comparison-view 都按需动态加载：它们会把数值内核
 *   （至少 SERIES_CAP/STATS_CAP）带进模块图，静态 import 就破坏了「首屏不背 runner」。
 *
 * 状态隔离
 * --------
 * `generation` 在每次运行、取消、重置时递增；Worker 消息、主线程分片回写、报告生成
 * 都必须同时满足 generation 与 jobId 才允许提交。交换变量后旧报告直接丢弃，
 * 不做「符号取反」的假交换——那会把一次没跑过的配置冒充成已验证结论。
 */
import {
  COMPARISON_AFFECTED_PATHS,
  buildComparisonPair,
  comparisonDiff,
  swapComparisonVariable,
  type ComparisonPairResult,
  type ComparisonVariable,
  type ComparisonVariableId,
} from "../core/comparison-config";
import { cloneExperimentConfig, type ExperimentConfig } from "../core/experiment-config";
import { errorText } from "../core/html-escape";
import { RollingChart } from "./chart";
import comparisonWorkerUrl from "virtual:worker-url/comparison";
import type {
  ComparisonRequest,
  ComparisonResponse,
  ComparisonSide,
} from "../core/comparison-protocol";
import type {
  ComparisonBuildInfo,
  ComparisonReport,
  ComparisonStatusState,
} from "../core/comparison-report";

type EstimatorId = "pure" | "comp" | "mahony" | "madg" | "kalman";
type Executing = "worker" | "main" | null;
type WorkerOutcome = "done" | "cancelled" | "fallback";
type SideId = "a" | "b";
/**
 * 只取实际用到的具名导出。
 *
 * 为什么不是 `typeof import(...)` 整个命名空间：面板通过动态 import 拿模块对象，
 * 一旦把整个 namespace 存起来/传出，Rollup 无法 tree-shake 未被用到的导出
 * （报告校验器等会一起进包）。这里在加载边界收窄成具体函数。
 */
interface ComparisonViewModule {
  comparisonDiffHtml: typeof import("./comparison-view").comparisonDiffHtml;
  comparisonRowsHtml: typeof import("./comparison-view").comparisonRowsHtml;
  comparisonCoverageNotesHtml: typeof import("./comparison-view").comparisonCoverageNotesHtml;
}
interface ComparisonReportModule {
  buildComparisonReport: typeof import("../core/comparison-report").buildComparisonReport;
  serializeComparisonReport: typeof import("../core/comparison-report").serializeComparisonReport;
  comparisonCoverageNotes: typeof import("../core/comparison-report").comparisonCoverageNotes;
}
type ComparisonRunnerModule = typeof import("../core/runner-ui");

export interface ComparisonPanelSnapshot {
  state: ComparisonStatusState;
  /** 当前选中的对照变量 id；未选择时为 null。 */
  kind: string | null;
  jobId: number;
  completedSides: number;
  executing: Executing;
  reportReady: boolean;
  /** 除声明变量外仍有差异的字段路径；非空时禁止开始。 */
  diffPaths: string[];
}

export interface ComparisonApplyResult {
  ok: boolean;
  error?: string;
}

export interface ComparisonPanelDeps {
  /** 冻结基线时的配置来源；claim 可通过 setWindow 指定本次对照窗口。 */
  baseConfig(): ExperimentConfig;
  applyConfig(cfg: ExperimentConfig): { ok: boolean; error?: string; warnings?: string[] };
  toast(msg: string, color?: string): void;
  buildInfo: ComparisonBuildInfo;
  /** 现场配置的单调递增版本号；用于判断已完成的对照是否仍对应当前配置。 */
  getConfigRevision(): number;
  onTaskState?(state: ComparisonPanelSnapshot): void;
}

export interface ComparisonPanelApi {
  /** 设定下次 freeze 使用的对照窗口（秒）；不改变现场。 */
  setWindow(durationSec: number): void;
  state(): ComparisonPanelSnapshot;
  result(): ComparisonReport | null;
  disableWorker(): void;
  cancel(): void;
  freeze(): void;
  selectVariable(id: string): void;
  run(): Promise<void>;
  applyB(): ComparisonApplyResult;
  /** 配置版本变化且当前为 done 时，把旧报告标成 stale；其余状态不动。 */
  markStaleIfChanged(): void;
}

interface StatusDetail {
  completedSides?: number;
  side?: SideId | null;
  message?: string;
}

interface VariableChoice {
  id: ComparisonVariableId;
  label: string;
  variable: ComparisonVariable;
  result: ComparisonPairResult;
}

interface CurvePoint {
  t: number;
  values: [number, number];
}

const VARIABLE_ORDER: readonly ComparisonVariableId[] = [
  "accel-gate",
  "mag-enabled",
  "solve-rate",
  "sensor-delay",
  "observation-noise",
];

/** 与方案 F-01 首批五类变量一一对应；文案是教学口径，不随基线改写。 */
const VARIABLE_LABELS: Readonly<Record<ComparisonVariableId, string>> = {
  "accel-gate": "方向门控（关→开）",
  "mag-enabled": "磁修正（关→开）",
  "solve-rate": "解算频率→50Hz",
  "sensor-delay": "延迟→25ms",
  "observation-noise": "观测噪声→0.2",
};

const ESTIMATORS: ReadonlyArray<{ id: EstimatorId; label: string }> = [
  { id: "pure", label: "纯积分" },
  { id: "comp", label: "互补滤波" },
  { id: "mahony", label: "Mahony" },
  { id: "madg", label: "Madgwick" },
  { id: "kalman", label: "卡尔曼" },
];

const DEFAULT_ESTIMATOR: EstimatorId = "mahony";
const PROGRESS_PAINT_MS = 100;
const WORKER_CANCEL_GRACE_MS = 150;

/** 与 core/comparison-report.ts 的文案保持一致；不静态引用它，避免把 runner 拖进首屏。 */
function statusText(state: ComparisonStatusState, detail: StatusDetail = {}): string {
  switch (state) {
    case "empty":
      return "未创建：先冻结基线并选一个变量。";
    case "configured":
      return "已配置：确认差异后运行对照。";
    case "running-a":
      return "A 侧运行中… B 未开始。";
    case "running-b":
      return "B 侧运行中；完成前不显示差值。";
    case "done": {
      const complete = detail.completedSides === undefined || detail.completedSides >= 2;
      return complete
        ? "完成：可查看指标、曲线与报告。"
        : `未完成：目前只有 ${detail.completedSides} 侧完成；两侧都完成后才显示最终对照。`;
    }
    case "cancelled": {
      if (detail.completedSides === undefined) {
        return "已取消：未生成结论。";
      }
      return `已取消：已完成 ${detail.completedSides} 侧，对照不标为完成，也不生成最终结论；可重新运行。`;
    }
    case "error": {
      const where = detail.side ? `${detail.side.toUpperCase()} 侧` : "对照";
      const reason = detail.message ? `（${detail.message}）` : "";
      return `运行出错：${where}${reason}。当前实时装置不受影响；可重试。`;
    }
    case "stale":
      return "结果已过期：不能当作当前对照。";
  }
}

function summaryText(state: ComparisonStatusState, hasVariable: boolean): string {
  switch (state) {
    case "empty":
      return "单变量对照 · 未创建";
    case "configured":
      return hasVariable ? "单变量对照 · 待运行" : "对照 · 已固定";
    case "running-a":
      return "对照 · A 运行";
    case "running-b":
      return "对照 · B 运行";
    case "done":
      return "单变量对照 · 已完成";
    case "cancelled":
      return "单变量对照 · 已取消";
    case "error":
      return "单变量对照 · 出错";
    case "stale":
      return "对照 · 已过期";
  }
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return "不可用";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

function valueText(id: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "开" : "关";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "不可用";
    switch (id) {
      case "solve-rate":
        return `${numberText(value)} Hz`;
      case "sensor-delay":
        return `${numberText(value)} ms`;
      default:
        return numberText(value);
    }
  }
  if (value === null || value === undefined) return "—";
  return String(value);
}

function cloneVariable(variable: ComparisonVariable): ComparisonVariable {
  return {
    id: variable.id,
    label: variable.label,
    a: variable.a,
    b: variable.b,
    affectedPaths: [...variable.affectedPaths],
  } as ComparisonVariable;
}

/** 从冻结基线推导 A 的「当前值」，B 固定为方案里声明的目标值。 */
function candidateVariable(id: ComparisonVariableId, base: ExperimentConfig): ComparisonVariable {
  const affectedPaths = [...COMPARISON_AFFECTED_PATHS[id]];
  switch (id) {
    case "accel-gate":
      return {
        id,
        label: VARIABLE_LABELS[id],
        a: base.estimators.comp.accelGate,
        b: true,
        affectedPaths,
      };
    case "mag-enabled":
      return {
        id,
        label: VARIABLE_LABELS[id],
        a: base.estimators.comp.magEnabled,
        b: true,
        affectedPaths,
      };
    case "solve-rate":
      return { id, label: VARIABLE_LABELS[id], a: base.solveRateHz, b: 50, affectedPaths };
    case "sensor-delay":
      return { id, label: VARIABLE_LABELS[id], a: base.imu.sensorDelayMs, b: 25, affectedPaths };
    case "observation-noise":
      return {
        id,
        label: VARIABLE_LABELS[id],
        a: base.estimators.kalman.params.obsNoise,
        b: 0.2,
        affectedPaths,
      };
  }
}

function extraDiffPaths(pair: ComparisonPairResult, variable: ComparisonVariable | null): string[] {
  if (!pair.ok || !variable) return [];
  const declared = new Set(variable.affectedPaths);
  return comparisonDiff(pair.a, pair.b).filter((path) => !declared.has(path));
}

/**
 * 加载较重模块。为什么懒加载：`comparison-view` → `comparison-report` → `runner`
 * 是运行时依赖链（report 需要 SERIES_CAP/STATS_CAP），静态 import 会把数值内核
 * 塞回应用首屏。
 */
let viewModule: ComparisonViewModule | null = null;
let viewLoading: Promise<ComparisonViewModule> | null = null;
let reportModule: ComparisonReportModule | null = null;
let reportLoading: Promise<ComparisonReportModule> | null = null;

function loadViewModule(): Promise<ComparisonViewModule> {
  if (viewModule) return Promise.resolve(viewModule);
  if (!viewLoading) {
    viewLoading = import("./comparison-view")
      .then((mod) => {
        const picked: ComparisonViewModule = {
          comparisonDiffHtml: mod.comparisonDiffHtml,
          comparisonRowsHtml: mod.comparisonRowsHtml,
          comparisonCoverageNotesHtml: mod.comparisonCoverageNotesHtml,
        };
        viewModule = picked;
        return picked;
      })
      .catch((err) => {
        viewLoading = null;
        throw err;
      });
  }
  return viewLoading;
}

function loadReportModule(): Promise<ComparisonReportModule> {
  if (reportModule) return Promise.resolve(reportModule);
  if (!reportLoading) {
    reportLoading = import("../core/comparison-report")
      .then((mod) => {
        const picked: ComparisonReportModule = {
          buildComparisonReport: mod.buildComparisonReport,
          serializeComparisonReport: mod.serializeComparisonReport,
          comparisonCoverageNotes: mod.comparisonCoverageNotes,
        };
        reportModule = picked;
        return picked;
      })
      .catch((err) => {
        reportLoading = null;
        throw err;
      });
  }
  return reportLoading;
}

export function mountComparisonPanel(deps: ComparisonPanelDeps): ComparisonPanelApi {
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`单变量对照台缺少 #${id}`);
    return el;
  };

  const card = $("cmp-card");
  const baselineEl = $("cmp-baseline");
  const varsEl = $("cmp-vars");
  const estimatorsEl = $("cmp-estimators");
  const diffEl = $("cmp-diff");
  const statusEl = $("cmp-status");
  const errorEl = $("cmp-error");
  const tableWrap = $("cmp-table-wrap");
  const tableBody = $("cmp-body");
  const chartWrap = $("cmp-chart-wrap");
  const canvas = $("cmp-canvas") as HTMLCanvasElement;
  const legendEl = $("cmp-legend");
  const altEl = $("cmp-alt") as HTMLDetailsElement;
  const altBody = $("cmp-alt-body");
  const summaryEl = $("sum-compare");

  // 覆盖说明容器由面板动态创建：index.html 的既有 id 集合保持不变。
  const coverageEl = document.createElement("div");
  coverageEl.id = "cmp-coverage";
  coverageEl.className = "cmp-coverage-wrap";
  coverageEl.hidden = true;
  card.append(coverageEl);

  const btnFreeze = $("btn-cmp-freeze") as HTMLButtonElement;
  const btnRun = $("btn-cmp-run") as HTMLButtonElement;
  const btnCancel = $("btn-cmp-cancel") as HTMLButtonElement;
  const btnSwap = $("btn-cmp-swap") as HTMLButtonElement;
  const btnApply = $("btn-cmp-apply") as HTMLButtonElement;
  const btnExport = $("btn-cmp-export") as HTMLButtonElement;
  const btnReset = $("btn-cmp-reset") as HTMLButtonElement;

  let base: ExperimentConfig | null = null;
  let choices: VariableChoice[] = [];
  let selectedVarId: ComparisonVariableId | null = null;
  let variable: ComparisonVariable | null = null;
  let pair: ComparisonPairResult | null = null;
  let pairProblem: string | null = null;
  let report: ComparisonReport | null = null;
  let serialized: ComparisonReport | null = null;
  let sides: { a: ComparisonSide; b: ComparisonSide } | null = null;
  let selectedEstimator: EstimatorId = DEFAULT_ESTIMATOR;

  let currentState: ComparisonStatusState = "empty";
  let currentJobId = 0;
  let jobSeq = 0;
  let generation = 0;
  let completedSides = 0;
  let executing: Executing = null;
  let workerDisabled = false;
  /** 冻结基线时的现场配置版本；报告完成时原样记录到 reportRevision。 */
  let frozenRevision: number | null = null;
  let reportRevision: number | null = null;

  let workerRef: Worker | null = null;
  let workerSettler: ((outcome: WorkerOutcome, terminate?: boolean) => void) | null = null;

  let chart: RollingChart | null = null;
  let chartWindowSec = 0;

  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingProgress: { side: SideId; simulationSec: number; durationSec: number } | null = null;
  let lastProgressPaint = 0;

  const isRunning = (): boolean => currentState === "running-a" || currentState === "running-b";

  function clearError(): void {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  function showError(message: string): void {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function extraDiffs(): string[] {
    return pair ? extraDiffPaths(pair, variable) : [];
  }

  function snapshot(): ComparisonPanelSnapshot {
    return {
      state: currentState,
      kind: selectedVarId,
      jobId: currentJobId,
      completedSides,
      executing,
      reportReady: report !== null,
      diffPaths: extraDiffs(),
    };
  }

  function notify(): void {
    try {
      deps.onTaskState?.(snapshot());
    } catch {
      /* 任务条回调失败不能破坏对照台自身状态 */
    }
  }

  function clearProgressTimer(): void {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    pendingProgress = null;
  }

  function flushProgress(): void {
    if (!pendingProgress || !isRunning()) {
      pendingProgress = null;
      return;
    }
    lastProgressPaint = typeof performance !== "undefined" ? performance.now() : Date.now();
    const p = pendingProgress;
    pendingProgress = null;
    const sideName = p.side === "a" ? "A 侧（基线）" : "B 侧（变量）";
    const prefix = p.side === "a" ? "正在运行" : "A 侧已完成；正在运行";
    const via = executing === "worker" ? "Worker" : "主线程";
    statusEl.textContent =
      `${prefix} ${sideName}：${p.simulationSec.toFixed(1)} / ${numberText(p.durationSec)} s（${via}）…`;
  }

  /** 进度文案最多约 10 Hz 重绘；Worker 本身每 0.5 s 才发一条，节流只是防御性上限。 */
  function queueProgress(side: SideId, simulationSec: number, durationSec: number): void {
    if (!isRunning()) return;
    pendingProgress = { side, simulationSec, durationSec };
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const wait = PROGRESS_PAINT_MS - (now - lastProgressPaint);
    if (wait <= 0) {
      flushProgress();
      return;
    }
    if (progressTimer === null) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        flushProgress();
      }, wait);
    }
  }

  function setState(next: ComparisonStatusState, detail: StatusDetail = {}, text?: string): void {
    currentState = next;
    card.dataset.state = next;
    statusEl.textContent = text ?? statusText(next, detail);
    summaryEl.textContent = summaryText(next, variable !== null);
    if (next !== "running-a" && next !== "running-b") clearProgressTimer();
    renderControls();
    notify();
  }

  function setExecuting(next: Executing): void {
    executing = next;
    renderControls();
    notify();
  }

  function renderControls(): void {
    const running = isRunning();
    const hasPair = pair !== null && pair.ok && pairProblem === null;
    btnFreeze.disabled = running;
    btnRun.disabled = running || !hasPair;
    btnCancel.disabled = !running;
    btnSwap.disabled = running || !pair || !pair.ok;
    btnApply.disabled =
      running || currentState === "stale" || currentState !== "done" || !pair || !pair.ok || report === null;
    btnExport.disabled = report === null || serialized === null;
    btnReset.disabled = !running && base === null && report === null;

    for (const btn of Array.from(varsEl.querySelectorAll<HTMLButtonElement>("button[data-cmp-var]"))) {
      const id = btn.dataset.cmpVar as ComparisonVariableId | undefined;
      const choice = id ? choices.find((c) => c.id === id) : undefined;
      const invalid = !choice || !choice.result.ok || extraDiffPaths(choice.result, choice.variable).length > 0;
      btn.disabled = running || invalid;
      btn.setAttribute("aria-pressed", id === selectedVarId ? "true" : "false");
      btn.title = !choice
        ? "先固定当前配置为基线"
        : !choice.result.ok
          ? `不可用：${choice.result.error}`
          : VARIABLE_LABELS[choice.id];
    }

    for (const btn of Array.from(estimatorsEl.querySelectorAll<HTMLButtonElement>("button[data-cmp-estimator]"))) {
      const id = btn.dataset.cmpEstimator as EstimatorId | undefined;
      btn.disabled = report === null;
      btn.setAttribute("aria-pressed", id === selectedEstimator ? "true" : "false");
    }
    card.setAttribute("aria-busy", String(running));
  }

  function renderVariableButtons(): void {
    varsEl.replaceChildren();
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    for (const id of VARIABLE_ORDER) {
      const choice = byId.get(id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmp-var";
      btn.dataset.cmpVar = id;
      btn.textContent = VARIABLE_LABELS[id];
      btn.setAttribute("aria-pressed", id === selectedVarId ? "true" : "false");
      btn.disabled = isRunning() || !choice || !choice.result.ok;
      btn.title = !choice
        ? "先固定当前配置为基线"
        : !choice.result.ok
          ? `不可用：${choice.result.error}`
          : VARIABLE_LABELS[choice.id];
      btn.addEventListener("click", () => selectVariable(id));
      varsEl.append(btn);
    }
    renderControls();
  }

  function renderEstimatorButtons(): void {
    estimatorsEl.replaceChildren();
    for (const estimator of ESTIMATORS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmp-est-btn";
      btn.dataset.cmpEstimator = estimator.id;
      btn.textContent = estimator.label;
      btn.setAttribute("aria-pressed", estimator.id === selectedEstimator ? "true" : "false");
      btn.disabled = report === null;
      btn.title = `查看 ${estimator.label} 的指标与总误差曲线`;
      btn.addEventListener("click", () => {
        selectedEstimator = estimator.id;
        renderControls();
        void renderReportViews();
      });
      estimatorsEl.append(btn);
    }
    renderControls();
  }

  function renderBaseline(): void {
    baselineEl.replaceChildren();
    if (!base) {
      const p = document.createElement("p");
      p.textContent = "尚未固定基线：点击「固定当前配置为基线」冻结场景、种子与全部参数。";
      baselineEl.append(p);
      return;
    }
    const fixed = document.createElement("p");
    fixed.textContent =
      `固定条件：场景 ${base.scenario} · 种子 ${base.seed} · 时长 ${numberText(base.durationSec)} s · ` +
      `解算频率 ${numberText(base.solveRateHz)} Hz`;
    const calibration = document.createElement("p");
    const mag = base.magCalibrationApplied === true && base.magCalibration !== null ? "已应用" : "未应用";
    const accel = base.accelCalibrationApplied === true && base.accelCalibration !== null ? "已应用" : "未应用";
    calibration.textContent = `校准：磁力计 ${mag} · 加速度计 ${accel}`;
    const ab = document.createElement("p");
    if (variable) {
      ab.textContent =
        `A（基线/当前）= ${valueText(variable.id, variable.a)} · ` +
        `B（变量目标）= ${valueText(variable.id, variable.b)}`;
    } else {
      ab.textContent = "A = 冻结基线当前值；选择一个变量后显示 B 的目标值。";
    }
    baselineEl.append(fixed, calibration, ab);
  }

  function renderDiff(): void {
    if (!base) {
      diffEl.textContent = "尚未创建对照：冻结基线并选择变量后显示完整配置差异。";
      diffEl.className = "cmp-diff";
      return;
    }
    if (!pair || !pair.ok || !variable) {
      diffEl.textContent = pairProblem ?? "已冻结基线；选择一个变量后显示完整配置差异。";
      diffEl.className = pairProblem ? "cmp-diff cmp-diff-warn" : "cmp-diff";
      return;
    }
    const extras = extraDiffPaths(pair, variable);
    diffEl.className = "cmp-diff";
    if (viewModule) {
      const html = viewModule.comparisonDiffHtml(extras, variable.label);
      diffEl.innerHTML = extras.length
        ? `<p class="cmp-diff cmp-diff-warn">额外差异：禁止开始</p>${html}`
        : html;
      return;
    }
    // 视图模块尚未加载：先给等价文本，加载完成后若仍指向同一对配置再换成完整列表。
    diffEl.textContent = extras.length
      ? `额外差异：禁止开始：${extras.join("、")}`
      : `配置差异仅包含变量「${variable.label}」。`;
    const wantedPair = pair;
    const wantedVariable = variable;
    void loadViewModule()
      .then(() => {
        if (pair === wantedPair && variable === wantedVariable) renderDiff();
        if (report) void renderReportViews();
      })
      .catch(() => {
        /* 视图模块加载失败时保留纯文本差异，不影响运行 */
      });
  }

  function discardResult(): void {
    report = null;
    serialized = null;
    sides = null;
    tableWrap.hidden = true;
    chartWrap.hidden = true;
    altEl.hidden = true;
    coverageEl.hidden = true;
    tableBody.replaceChildren();
    altBody.replaceChildren();
    coverageEl.replaceChildren();
    chart?.clear();
    legendEl.textContent = "A 实线 · B 虚线 · 总误差（°）";
    canvas.setAttribute("aria-label", "对照总误差曲线：完成运行后显示 A 与 B 两条曲线，单位度");
    for (const btn of Array.from(estimatorsEl.querySelectorAll<HTMLButtonElement>("button[data-cmp-estimator]"))) {
      btn.disabled = true;
    }
  }

  function ensureChart(windowSec: number): RollingChart {
    if (!chart || chartWindowSec !== windowSec) {
      chart?.clear();
      chartWindowSec = windowSec;
      chart = new RollingChart(
        canvas,
        [
          { label: "A（基线）", color: "#58a6ff" },
          { label: "B（变量）", color: "#ffa657", dash: [5, 4] },
        ],
        { windowSec, unit: "°" },
      );
    }
    return chart;
  }

  function curvePoints(a: ComparisonSide["series"][number], b: ComparisonSide["series"][number], end: number): CurvePoint[] {
    const step = 1 / 25;
    const out: CurvePoint[] = [];
    let ia = -1;
    let ib = -1;
    const count = Math.max(1, Math.floor(end / step));
    for (let k = 0; k <= count; k++) {
      const t = Math.min(end, k * step);
      while (ia + 1 < a.t.length && a.t[ia + 1] <= t) ia++;
      while (ib + 1 < b.t.length && b.t[ib + 1] <= t) ib++;
      const av = ia >= 0 && ia < a.errDeg.length ? a.errDeg[ia] : NaN;
      const bv = ib >= 0 && ib < b.errDeg.length ? b.errDeg[ib] : NaN;
      out.push({ t, values: [av, bv] });
      if (t >= end) break;
    }
    return out;
  }

  function chartAriaLabel(currentReport: ComparisonReport): string {
    const v = currentReport.variable;
    const estimator = ESTIMATORS.find((e) => e.id === selectedEstimator)?.label ?? selectedEstimator;
    return (
      `对照总误差曲线；固定条件：场景 ${currentReport.baseConfig.scenario}，种子 ${currentReport.baseConfig.seed}，` +
      `时长 ${numberText(currentReport.baseConfig.durationSec)} s，解算频率 ${numberText(currentReport.baseConfig.solveRateHz)} Hz；` +
      `唯一变量「${v.label}」：A=${valueText(v.id, v.a)}，B=${valueText(v.id, v.b)}；` +
      `当前算法 ${estimator}；实线 A，虚线 B；单位度。`
    );
  }

  function renderChart(currentReport: ComparisonReport, currentSides: { a: ComparisonSide; b: ComparisonSide }): void {
    const estimatorLabel = currentReport.a.metrics.find((m) => m.id === selectedEstimator)?.label
      ?? ESTIMATORS.find((e) => e.id === selectedEstimator)?.label
      ?? selectedEstimator;
    const aSeries = currentSides.a.series.find((s) => s.id === selectedEstimator);
    const bSeries = currentSides.b.series.find((s) => s.id === selectedEstimator);
    const duration = Math.max(1, currentReport.a.config.durationSec, currentReport.b.config.durationSec);
    const lastT = Math.max(
      aSeries && aSeries.t.length ? aSeries.t[aSeries.t.length - 1] : 0,
      bSeries && bSeries.t.length ? bSeries.t[bSeries.t.length - 1] : 0,
    );
    const end = Math.max(duration, Number.isFinite(lastT) ? lastT : 0);
    // 按 25 Hz 网格向上取整，避免不同变量末帧时刻的浮点差异反复重建画布观察器。
    const windowSec = Math.max(1, Math.ceil(end * 25) / 25);
    const chartNow = ensureChart(windowSec);
    chartNow.clear();
    if (aSeries && bSeries) {
      const points = curvePoints(aSeries, bSeries, end);
      for (const point of points) chartNow.push(point.t, point.values);
      chartNow.render();
    }
    legendEl.innerHTML =
      `<span class="cmp-legend-item"><i class="cmp-swatch"></i>A（基线）</span>` +
      `<span class="cmp-legend-item"><i class="cmp-swatch cmp-swatch-b"></i>B（变量）</span>` +
      `<span class="cmp-legend-item">${estimatorLabel} · 总误差（°）</span>`;
    canvas.setAttribute("aria-label", chartAriaLabel(currentReport));
  }

  async function renderReportViews(): Promise<void> {
    const currentReport = report;
    const currentSides = sides;
    if (!currentReport || !currentSides) {
      discardResult();
      renderControls();
      return;
    }
    tableWrap.hidden = false;
    chartWrap.hidden = false;
    altEl.hidden = false;
    renderChart(currentReport, currentSides);
    tableBody.textContent = "正在加载指标表…";
    altBody.textContent = "正在加载等价文本…";
    try {
      const [view, reportMod] = await Promise.all([loadViewModule(), loadReportModule()]);
      if (report !== currentReport) return;
      const rows = view.comparisonRowsHtml(report, selectedEstimator);
      tableBody.innerHTML = rows;
      altBody.innerHTML = rows;
      const coverageHtml = view.comparisonCoverageNotesHtml(
        reportMod.comparisonCoverageNotes(currentReport),
      );
      coverageEl.innerHTML = coverageHtml;
      coverageEl.hidden = coverageHtml.length === 0;
    } catch (err) {
      if (report !== currentReport) return;
      tableBody.textContent = "指标表加载失败";
      altBody.textContent = "等价文本加载失败";
      showError(`对照视图加载失败：${errorText(err)}`);
    }
    renderControls();
  }

  function buildChoices(): void {
    choices = [];
    if (!base) return;
    for (const id of VARIABLE_ORDER) {
      const candidate = candidateVariable(id, base);
      choices.push({
        id,
        label: VARIABLE_LABELS[id],
        variable: candidate,
        result: buildComparisonPair(base, candidate),
      });
    }
  }

  /** claim 指定的对照窗口；只在 freeze 时生效一次，不写回现场。 */
  let pendingWindowSec: number | null = null;
  function setWindow(durationSec: number): void {
    pendingWindowSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  }

  function freeze(): void {
    if (isRunning()) return;
    generation++;
    workerSettler?.("cancelled", true);
    workerSettler = null;
    workerRef = null;
    try {
      base = cloneExperimentConfig(deps.baseConfig());
      // 声明窗口优先（claim 的因果验收要求两侧同一窗口）；否则沿用现场。
      if (pendingWindowSec !== null) base.durationSec = pendingWindowSec;
      pendingWindowSec = null;
      frozenRevision = deps.getConfigRevision();
      reportRevision = null;
    } catch (err) {
      base = null;
      frozenRevision = null;
      reportRevision = null;
      choices = [];
      selectedVarId = null;
      variable = null;
      pair = null;
      pairProblem = null;
      discardResult();
      const message = `无法读取当前配置：${errorText(err)}`;
      showError(message);
      setState("error", { message });
      renderBaseline();
      renderVariableButtons();
      renderDiff();
      return;
    }
    selectedVarId = null;
    variable = null;
    pair = null;
    pairProblem = null;
    completedSides = 0;
    currentJobId = 0;
    executing = null;
    discardResult();
    clearError();
    buildChoices();
    renderBaseline();
    renderVariableButtons();
    renderEstimatorButtons();
    renderDiff();
    setState("configured", {}, "已固定基线：请选择一个变量（A=当前值，B=目标值）。");
  }

  function selectVariable(id: string): void {
    if (isRunning()) return;
    if (!base) {
      freeze();
      if (!base) return;
    }
    const choice = choices.find((c) => c.id === id);
    if (!choice) {
      showError(`未知对照变量：${id}`);
      return;
    }
    if (!choice.result.ok) {
      showError(`无法建立对照：${choice.result.error}`);
      return;
    }
    const extras = extraDiffPaths(choice.result, choice.variable);
    selectedVarId = choice.id;
    variable = choice.variable;
    pair = choice.result;
    pairProblem = extras.length ? "额外差异：禁止开始" : null;
    completedSides = 0;
    executing = null;
    discardResult();
    if (pairProblem) {
      showError(`${pairProblem}：${extras.join("、")}`);
      setState("error", { message: pairProblem });
    } else {
      clearError();
      setState("configured");
    }
    renderBaseline();
    renderDiff();
    renderControls();
  }

  function swapSides(): void {
    if (isRunning() || !base || !variable || !pair || !pair.ok) return;
    const swapped = swapComparisonVariable(variable);
    const nextPair = buildComparisonPair(base, swapped);
    if (!nextPair.ok) {
      const message = `交换 A/B 失败：${nextPair.error}`;
      showError(message);
      setState("error", { message });
      return;
    }
    variable = swapped;
    pair = nextPair;
    pairProblem = null;
    selectedVarId = swapped.id;
    completedSides = 0;
    executing = null;
    discardResult();
    clearError();
    renderBaseline();
    renderDiff();
    setState("configured", {}, "已交换变量，需重新运行：A/B 取值已互换，旧结果已清除。");
  }

  function applyB(): ComparisonApplyResult {
    if (isRunning()) {
      return { ok: false, error: "对照运行中，不能应用 B" };
    }
    if (!pair || !pair.ok) {
      const error = "尚未配置有效的 A/B 对照";
      showError(error);
      return { ok: false, error };
    }
    if (currentState !== "done" || report === null) {
      const error = "请先完成一次对照运行，再应用 B";
      showError(error);
      return { ok: false, error };
    }
    let applied: { ok: boolean; error?: string; warnings?: string[] };
    try {
      applied = deps.applyConfig(cloneExperimentConfig(pair.b));
    } catch (err) {
      const error = `应用 B 失败：${errorText(err)}`;
      showError(error);
      deps.toast(error, "#f85149");
      return { ok: false, error };
    }
    if (!applied.ok) {
      const error = applied.error ?? "应用 B 失败";
      showError(error);
      deps.toast(error, "#f85149");
      return { ok: false, error };
    }
    const warnings = (applied.warnings ?? []).filter((w) => typeof w === "string" && w.length > 0);
    const warningText = warnings.length ? `；注意：${warnings.join("；")}` : "";
    clearError();
    setState(
      "stale",
      {},
      `已将 B 应用到装置${warningText}。旧对照结果仍可查看，但已不再代表当前配置。`,
    );
    if (warnings.length) deps.toast(`已将 B 应用到装置${warningText}`, "#fbbf24");
    else deps.toast("已将 B 应用到当前装置", "#7ee787");
    return { ok: true };
  }

  function exportReport(): void {
    if (!serialized || !report) return;
    const stamp = report.createdAtIso.replace(/[:.]/g, "-");
    const filename = `comparison-report-${report.variable.id}-${report.baseConfig.seed}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    deps.toast(`已导出对照报告：${filename}`, "#7ee787");
  }

  async function finishReport(
    myGen: number,
    frozenBase: ExperimentConfig,
    frozenVariable: ComparisonVariable,
    reportMod: ComparisonReportModule,
    a: ComparisonSide,
    b: ComparisonSide,
  ): Promise<void> {
    if (generation !== myGen) return;
    try {
      const built = reportMod.buildComparisonReport(frozenBase, frozenVariable, a, b, deps.buildInfo, {
        seriesRetained: true,
      });
      const jsonSafe = reportMod.serializeComparisonReport(built);
      if (generation !== myGen) return;
      report = built;
      serialized = jsonSafe;
      sides = { a, b };
      reportRevision = frozenRevision;
      completedSides = 2;
      executing = null;
      setState("done", { completedSides: 2 });
      // 运行期间现场配置若已变化，完成即标 stale；未变化则保持 done。
      markStaleIfChanged();
      void renderReportViews();
    } catch (err) {
      if (generation !== myGen) return;
      executing = null;
      const message = `对照报告生成失败：${errorText(err)}`;
      showError(message);
      setState("error", { message });
    }
  }

  async function finalizeWorkerDone(
    myGen: number,
    frozenBase: ExperimentConfig,
    frozenVariable: ComparisonVariable,
    a: ComparisonSide,
    b: ComparisonSide,
  ): Promise<void> {
    if (generation !== myGen) return;
    statusEl.textContent = "两侧运行完成，正在生成对照报告…";
    try {
      const reportMod = await loadReportModule();
      if (generation !== myGen) return;
      await finishReport(myGen, frozenBase, frozenVariable, reportMod, a, b);
    } catch (err) {
      if (generation !== myGen) return;
      executing = null;
      const message = `对照报告加载失败：${errorText(err)}`;
      showError(message);
      setState("error", { message });
    }
  }

  function runInWorker(
    myGen: number,
    jobId: number,
    frozenBase: ExperimentConfig,
    frozenVariable: ComparisonVariable,
  ): Promise<WorkerOutcome> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(comparisonWorkerUrl, { type: "module" });
      } catch {
        resolve("fallback");
        return;
      }
      workerRef = worker;
      setExecuting("worker");
      let settled = false;
      const finish = (outcome: WorkerOutcome, terminate = true): void => {
        if (settled) return;
        settled = true;
        if (terminate) worker.terminate();
        if (workerRef === worker) workerRef = null;
        if (workerSettler === finish) workerSettler = null;
        resolve(outcome);
      };
      workerSettler = finish;

      worker.onmessage = (ev: MessageEvent<ComparisonResponse>): void => {
        const msg = ev.data;
        if (!msg || typeof msg.jobId !== "number" || msg.jobId !== jobId || generation !== myGen) return;
        switch (msg.type) {
          case "phase":
            setState(msg.side === "a" ? "running-a" : "running-b");
            if (msg.phase === "summarizing") {
              statusEl.textContent = `${msg.side.toUpperCase()} 侧积分完成，正在汇总指标…`;
            }
            break;
          case "progress":
            queueProgress(msg.side, msg.simulationSec, msg.durationSec);
            break;
          case "side-complete":
            completedSides = Math.max(completedSides, msg.side === "a" ? 1 : 2);
            if (msg.side === "a") statusEl.textContent = "A 侧已完成；准备运行 B 侧…";
            notify();
            break;
          case "done": {
            if (
              msg.a.termination.reason !== "completed"
              || msg.b.termination.reason !== "completed"
            ) {
              executing = null;
              const message = "Worker 返回的对照未完整完成，未生成报告";
              showError(message);
              setState("error", { message });
              finish("done", true);
              return;
            }
            void finalizeWorkerDone(myGen, frozenBase, frozenVariable, msg.a, msg.b).then(() => {
              finish("done", true);
            });
            return;
          }
          case "cancelled":
            executing = null;
            completedSides = msg.completedSides;
            setState("cancelled", { completedSides: msg.completedSides });
            finish("cancelled", true);
            return;
          case "error":
            console.warn("单变量对照 Worker 报错，回退主线程：", msg.message);
            finish("fallback", true);
            return;
        }
      };
      worker.onerror = (): void => {
        if (generation !== myGen) return;
        console.warn("单变量对照 Worker 启动/运行失败，回退主线程异步 runner");
        finish("fallback", true);
      };
      worker.onmessageerror = (): void => {
        if (generation !== myGen) return;
        console.warn("单变量对照 Worker 消息无法反序列化，回退主线程异步 runner");
        finish("fallback", true);
      };
      try {
        worker.postMessage({
          type: "start",
          jobId,
          base: frozenBase,
          variable: frozenVariable,
        } satisfies ComparisonRequest);
      } catch {
        finish("fallback", true);
      }
    });
  }

  async function runMainFallback(
    myGen: number,
    jobId: number,
    frozenBase: ExperimentConfig,
    frozenVariable: ComparisonVariable,
    frozenPair: Extract<ComparisonPairResult, { ok: true }>,
  ): Promise<void> {
    executing = "main";
    // 降级会从 A 重新跑完两侧，不能沿用 Worker 已经上报的完成侧数。
    completedSides = 0;
    renderControls();
    notify();
    let runnerMod: ComparisonRunnerModule;
    let reportMod: ComparisonReportModule;
    try {
      [runnerMod, reportMod] = await Promise.all([
        import("../core/runner-ui"),
        loadReportModule(),
      ]);
    } catch (err) {
      if (generation !== myGen) return;
      executing = null;
      const message = `主线程降级加载失败：${errorText(err)}`;
      showError(message);
      setState("error", { message });
      return;
    }
    if (generation !== myGen) return;

    const completed: Partial<Record<SideId, ComparisonSide>> = {};
    let doneSides = 0;
    const sidesToRun = [["a", frozenPair.a], ["b", frozenPair.b]] as const;
    for (const [side, config] of sidesToRun) {
      if (generation !== myGen) return;
      setState(side === "a" ? "running-a" : "running-b");
      let result: Awaited<ReturnType<typeof runnerMod.runExperimentDetailedAsync>>;
      try {
        result = await runnerMod.runExperimentDetailedAsync(config, {
          stepsPerSlice: 128,
          maxSliceMs: 4,
          progressEverySec: 0.5,
          shouldCancel: () => generation !== myGen,
          onProgress: (simulationSec) => {
            if (generation !== myGen) return false;
            queueProgress(side, simulationSec, config.durationSec);
            return true;
          },
          onStop: () => {
            if (generation !== myGen) return;
            pendingProgress = null;
            statusEl.textContent = `${side.toUpperCase()} 侧积分完成，正在汇总指标…`;
          },
        });
      } catch (err) {
        if (generation !== myGen) return;
        executing = null;
        const message = `${side.toUpperCase()} 侧运行失败：${errorText(err)}`;
        showError(message);
        setState("error", { side, message });
        return;
      }
      if (generation !== myGen) return;
      if (result.termination.reason !== "completed") {
        executing = null;
        setState("cancelled", { completedSides: doneSides });
        return;
      }
      doneSides++;
      completedSides = doneSides;
      completed[side] = {
        config: result.config,
        metrics: result.metrics,
        series: result.series,
        events: result.events,
        finalQuats: result.finalQuats,
        termination: result.termination,
        seed: config.seed,
      };
      if (side === "a") statusEl.textContent = "A 侧已完成；准备运行 B 侧…";
      notify();
    }
    const a = completed.a;
    const b = completed.b;
    if (!a || !b) {
      executing = null;
      const message = "内部错误：主线程降级缺少一侧的完整结果";
      showError(message);
      setState("error", { message });
      return;
    }
    if (generation !== myGen) return;
    statusEl.textContent = "两侧运行完成，正在生成对照报告…";
    await finishReport(myGen, frozenBase, frozenVariable, reportMod, a, b);
    if (generation === myGen && currentState === "done") {
      // jobId 仅用于隔离旧消息；这里保留最近一次任务号，便于自动化断言。
      currentJobId = jobId;
    }
  }

  async function run(): Promise<void> {
    if (isRunning()) cancel();
    if (!base) {
      freeze();
      if (!base) return;
    }
    if (!pair || !pair.ok || pairProblem !== null) {
      showError(pairProblem ?? "请先选择一个有效变量并确认配置差异");
      return;
    }
    const frozenBase = cloneExperimentConfig(base);
    const frozenVariable = cloneVariable(variable as ComparisonVariable);
    const frozenPair = pair;
    const myGen = ++generation;
    const jobId = ++jobSeq;
    currentJobId = jobId;
    completedSides = 0;
    executing = null;
    discardResult();
    clearError();
    setState("running-a");
    let outcome: WorkerOutcome = "fallback";
    if (!workerDisabled) {
      try {
        outcome = await runInWorker(myGen, jobId, frozenBase, frozenVariable);
      } catch (err) {
        console.warn("单变量对照 Worker 路径异常，回退主线程：", errorText(err));
        outcome = "fallback";
      }
    }
    if (generation !== myGen) return;
    if (outcome === "fallback") {
      statusEl.textContent = "Worker 不可用，正在切换主线程异步 runner…";
      await runMainFallback(myGen, jobId, frozenBase, frozenVariable, frozenPair);
    }
  }

  function cancel(): void {
    if (!isRunning()) return;
    generation++;
    const jobId = currentJobId;
    const worker = workerRef;
    const settle = workerSettler;
    workerRef = null;
    workerSettler = null;
    if (worker) {
      try {
        worker.postMessage({ type: "cancel", jobId } satisfies ComparisonRequest);
      } catch {
        /* Worker 已退出 */
      }
      setTimeout(() => worker.terminate(), WORKER_CANCEL_GRACE_MS);
    }
    settle?.("cancelled", false);
    executing = null;
    clearProgressTimer();
    setState("cancelled", { completedSides });
  }

  function reset(): void {
    generation++;
    const worker = workerRef;
    const settle = workerSettler;
    workerRef = null;
    workerSettler = null;
    settle?.("cancelled", false);
    worker?.terminate();
    clearProgressTimer();
    base = null;
    choices = [];
    selectedVarId = null;
    variable = null;
    pair = null;
    pairProblem = null;
    completedSides = 0;
    currentJobId = 0;
    executing = null;
    frozenRevision = null;
    reportRevision = null;
    discardResult();
    clearError();
    renderBaseline();
    renderVariableButtons();
    renderEstimatorButtons();
    renderDiff();
    setState("empty");
  }

  function disableWorker(): void {
    workerDisabled = true;
  }

  /**
   * 现场配置版本变化后调用：已完成（done）的旧报告不再代表当前配置时转为 stale。
   * 未变化（或无报告）时保持原状态，避免把一次未改配置的完成误标成过期。
   */
  function markStaleIfChanged(): void {
    if (currentState !== "done" || report === null) return;
    if (reportRevision !== null && deps.getConfigRevision() === reportRevision) return;
    setState(
      "stale",
      {},
      "现场配置已变化，旧对照结果不再代表当前配置。可重新冻结基线并运行。",
    );
  }

  function state(): ComparisonPanelSnapshot {
    return snapshot();
  }

  function result(): ComparisonReport | null {
    if (!serialized) return null;
    return JSON.parse(JSON.stringify(serialized)) as ComparisonReport;
  }

  btnFreeze.addEventListener("click", freeze);
  btnRun.addEventListener("click", () => void run());
  btnCancel.addEventListener("click", cancel);
  btnSwap.addEventListener("click", swapSides);
  btnApply.addEventListener("click", () => applyB());
  btnExport.addEventListener("click", exportReport);
  btnReset.addEventListener("click", reset);

  const dispose = (): void => {
    generation++;
    const worker = workerRef;
    const settle = workerSettler;
    workerRef = null;
    workerSettler = null;
    clearProgressTimer();
    settle?.("cancelled", false);
    worker?.terminate();
  };
  window.addEventListener("pagehide", dispose, { once: true });

  renderBaseline();
  renderVariableButtons();
  renderEstimatorButtons();
  renderDiff();
  setState("empty");

  return {
    setWindow,
    state,
    result,
    disableWorker,
    cancel,
    freeze,
    selectVariable,
    run,
    applyB,
    markStaleIfChanged,
  };
}
