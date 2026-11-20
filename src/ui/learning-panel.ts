/**
 * F-02 预测—验证式学习面板（自包含、可懒加载）。
 *
 * 运行边界：
 * - 本模块**不** import `learning-activity-data.ts`，题目从 `public/data/activities.json` fetch；
 * - 不修改 index.html / 全局样式：所有 DOM 由 JS 创建，只复用现有 `.panel-section`、`.btn`、
 *   `.doc-page`、`.tscroll` 等类；
 * - 不写 localStorage / sessionStorage，所有记录只存在于本面板实例的内存里；
 * - 所有动态文本一律走 `textContent` / `textarea.value`，不拼 `innerHTML`；
 * - `mount()` 与 `run()` 都把错误转成面板提示 + toast，不返回未处理的 rejection。
 */
import { escapeHtml, errorText as errorTextOf } from "../core/html-escape";
export { escapeHtml };
import {
  canonicalizeExperimentConfig,
  cloneExperimentConfig,
  defaultExperimentConfig,
} from "../core/experiment-config";
import type { EstimatorId, ExperimentConfig } from "../core/experiment-config";
import type { EstimatorRunMetrics, RunTermination } from "../core/runner";
import {
  LEARNING_METRIC_KEYS,
  parseLearningActivities,
  type EvidencePatchOverride,
  type EvidencePredicate,
  type LearningActivity,
  type LearningMetricKey,
  type PredictionAnswer,
  type PredictionVerdict,
} from "./learning-activities";
import {
  addReflection,
  bindRun,
  canReveal,
  cancelRun,
  completeRun,
  createActivityState,
  exportActivityRecord,
  failRun,
  restart,
  startAttempt,
  submitPrediction as submitPredictionState,
  type ActivityState,
  type ActivityStateFailure,
  type AttemptStatus,
  type EvidenceSummary,
  type EvidencePlanEntry,
  type EvidenceRunSummary,
  type LearningActivityLookup,
  type RunRef,
} from "./activity-state";
import type { TaskDescriptor } from "./task-strip";
import { mountClaimLinks } from "./claim-links";

export interface LearningPanelDeps {
  /**
   * 运行一组固定的证据配置。`shouldCancel` 若被调用方接进 runner，
   * 旧运行会在下一片上停止；面板同时用配对的 isActive 检查拒绝绑定旧结果。
   */
  runEvidence(
    config: ExperimentConfig,
    activity: LearningActivity,
    shouldCancel?: () => boolean,
  ): Promise<{ metrics: EstimatorRunMetrics[]; termination: RunTermination }>;
  openDocs(page: string, anchor?: string): void;
  toast(msg: string, color?: string): void;
  /** 教材 claim 动作需要：关闭文档层并打开单变量对照台（主入口注入）。 */
  closeDocs?(): void;
  loadExperiment?(id: string): Promise<void>;
  ensureComparison?(): Promise<{ freeze(): void; selectVariable(id: string): void }>;
  onTask?(task: TaskDescriptor): void;
  ensureTaskStrip?(): Promise<unknown>;
}

export interface LearningPanelState {
  loaded: boolean;
  activityCount: number;
  activityId: string | null;
  activityTitle: string | null;
  attemptId: number | null;
  status: AttemptStatus;
  predictionText: string;
  hasPrediction: boolean;
  canRun: boolean;
  canReveal: boolean;
  verdict: PredictionVerdict | null;
  evidence: EvidenceSummary | null;
  /** 本次尝试绑定的证据配置摘要（未绑定为 null）。 */
  configDigest: string | null;
  attempts: number;
  error: string | null;
}

export interface LearningPanelApi {
  mount(root: HTMLElement): Promise<void>;
  setActivity(id: string): void;
  submitPrediction(answer: PredictionAnswer): { ok: boolean; error?: string };
  run(): Promise<{ ok: boolean; error?: string }>;
  state(): LearningPanelState;
  reset(): void;
}

/** 固定证据时长（秒）：题面允许的阅读窗口与现场实时曲线可以不同。 */
export const EVIDENCE_DURATION_SEC = 5;

/** fetch 的相对路径；测试与主入口都从这里取，避免两处硬编码漂移。 */
export const ACTIVITIES_DATA_PATH = "data/activities.json";

/** 把相对路径解析为绝对 URL（纯函数，便于无 DOM 测试）。 */
export function activitiesDataUrl(baseURI: string): string {
  return new URL(ACTIVITIES_DATA_PATH, baseURI).href;
}

/**
 * 把 `evidencePatch` 应用到配置副本上（不修改入参）。
 *
 * 题面条件只由 patch 决定：patch 出现的字段覆盖现场，没出现的字段仍沿用现场
 * （种子、解算频率等）；`magEnabled` 一次性设置五个算法。
 */
function applyEvidencePatch(config: ExperimentConfig, patch: EvidencePatchOverride): void {
  if (patch.durationSec !== undefined) config.durationSec = patch.durationSec;
  if (patch.scenario !== undefined) config.scenario = patch.scenario;
  if (patch.imu !== undefined) Object.assign(config.imu, patch.imu);
  if (patch.magEnabled !== undefined) {
    for (const id of Object.keys(config.estimators) as EstimatorId[]) {
      config.estimators[id].magEnabled = patch.magEnabled;
    }
  }
  if (patch.autoCoarseAlign !== undefined) config.autoCoarseAlign = patch.autoCoarseAlign;
  if (patch.initialAttitude !== undefined) {
    const initial = patch.initialAttitude;
    config.initialAttitude =
      initial.kind === "fixed-axis"
        ? {
            kind: "fixed-axis",
            axis: [...(initial.axis ?? [1, 0, 0])] as [number, number, number],
            angleDeg: initial.angleDeg ?? 30,
          }
        : { kind: initial.kind };
  }
  if (patch.estimators !== undefined) {
    for (const [id, estPatch] of Object.entries(patch.estimators)) {
      if (!estPatch) continue;
      const tuning = config.estimators[id as EstimatorId];
      if (!tuning) continue;
      const view = tuning as unknown as Record<string, unknown>;
      for (const key of [
        "enabled",
        "magEnabled",
        "accelGate",
        "gateDeg",
        "gateMagPct",
        "gateRecovery",
        "rampEnabled",
        "magMode",
        "kalmanGate",
        "kalmanChi2",
        "kalmanResetCov",
      ] as const) {
        if (estPatch[key] !== undefined) view[key] = estPatch[key];
      }
      if (estPatch.params !== undefined) {
        Object.assign(tuning.params, estPatch.params);
      }
    }
  }
}

/**
 * 固定教学基线：所有题目都从这里构造，绝不读取现场滑块、校准或 A/B 状态。
 * 全部 IMU 误差/扰动归零、全部估计器先关闭，活动 patch 再显式打开并覆盖所需字段。
 */
export function teachingBaseConfig(): ExperimentConfig {
  const base = defaultExperimentConfig();
  base.seed = 0x5eed;
  base.scenario = "hover";
  base.durationSec = EVIDENCE_DURATION_SEC;
  base.initialAttitude = { kind: "level" };
  base.autoCoarseAlign = true;
  base.steadyFromSec = null;
  base.magModel = "diag";
  base.magTargetUts = 50;
  base.magCalibration = null;
  base.accelCalibration = null;
  base.magCalibrationApplied = false;
  base.accelCalibrationApplied = false;
  delete base.ab;
  // 固定基线的全部 IMU 参数归零；题目 patch 再显式覆盖所需字段。
  for (const key of Object.keys(base.imu) as (keyof typeof base.imu)[]) base.imu[key] = 0;
  for (const id of Object.keys(base.estimators) as EstimatorId[]) {
    const tuning = base.estimators[id];
    tuning.enabled = false;
    tuning.magEnabled = false;
    tuning.accelGate = false;
    tuning.rampEnabled = false;
    tuning.gateRecovery = false;
  }
  return base;
}

/**
 * 生成本次证据运行配置：从固定教学基线复制、默认时长 5 s、移除 A/B 字段，
 * 再应用活动的 `evidencePatch`。不修改传入对象。
 */
export function evidenceConfig(
  base: ExperimentConfig,
  patch?: EvidencePatchOverride,
): ExperimentConfig {
  const config = cloneExperimentConfig(base);
  delete config.ab;
  config.durationSec = EVIDENCE_DURATION_SEC;
  if (patch) applyEvidencePatch(config, patch);
  return config;
}

/** 一次证据运行的完整配置与摘要。 */
export interface EvidenceRunConfig {
  id: string;
  config: ExperimentConfig;
  digest: string;
}

/** 稳定 JSON：递归按键名排序，不受属性插入顺序影响。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 配置摘要：canonicalize 后按稳定键序序列化，再做双种子 FNV-1a。
 * 用途是「旧结果不能冒充新配置」，不是密码学摘要。
 */
export function configDigest(config: ExperimentConfig): string {
  const text = stableJson(canonicalizeExperimentConfig(config));
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x9e3779b9)}`;
}

/**
 * 构建活动声明的全部证据运行：基线 "A" 用 `evidencePatch`，
 * 其余运行在 A 之上合并自己的覆盖（如 Ki 题的 B=Ki0.05）。
 * 没有 `evidencePatch` 的纯几何题返回空数组（不需要 runner）。
 */
export function evidenceRunConfigs(
  base: ExperimentConfig,
  activity: LearningActivity,
): EvidenceRunConfig[] {
  const patch = activity.evidencePatch;
  if (!patch) return [];
  const a = evidenceConfig(base, patch);
  const out: EvidenceRunConfig[] = [{ id: "A", config: a, digest: configDigest(a) }];
  for (const run of activity.evidenceRuns ?? []) {
    const config = cloneExperimentConfig(a);
    if (run.patch) applyEvidencePatch(config, run.patch);
    out.push({ id: run.id, config, digest: configDigest(config) });
  }
  return out;
}

const METRIC_LABELS = {
  n: "样本数",
  mean: "平均误差",
  rmse: "全程 RMSE",
  max: "峰值误差",
  p50: "P50 误差",
  p95: "P95 误差",
  steadyRmse: "稳态 RMSE",
  tiltRmse: "倾角 RMSE",
  yawRmse: "偏航 RMSE",
  convergedAt: "收敛时刻",
  gateRejects: "门控拒绝帧数",
} satisfies Record<LearningMetricKey, string>;

const METRIC_UNITS = {
  mean: "°",
  rmse: "°",
  max: "°",
  p50: "°",
  p95: "°",
  steadyRmse: "°",
  tiltRmse: "°",
  yawRmse: "°",
  convergedAt: "s",
  gateRejects: "帧",
  n: "个",
} satisfies Partial<Record<LearningMetricKey, string>>;

export function metricDisplayName(metric: string): string {
  return METRIC_LABELS[metric as LearningMetricKey] ?? metric;
}

export function metricUnit(metric: string): string {
  return METRIC_UNITS[metric as LearningMetricKey] ?? "";
}

export interface MetricSelectionOk {
  ok: true;
  value: number;
  metric: string;
  estimatorId: EstimatorId;
  label: string;
}

export interface MetricSelectionError {
  ok: false;
  error: string;
}

export type MetricSelection = MetricSelectionOk | MetricSelectionError;

/**
 * 从运行结果里取本题声明的估计器指标。
 * 找不到估计器、指标缺失或不是有限数值时返回 error；绝不把缺失值当 0。
 */
export function selectEstimatorMetric(
  metrics: readonly EstimatorRunMetrics[],
  estimatorId: EstimatorId,
  metricName: string,
): MetricSelection {
  if (!Array.isArray(metrics)) {
    return { ok: false, error: "缺少指标数组" };
  }
  const found = metrics.find((item) => item && item.id === estimatorId);
  if (!found) {
    return {
      ok: false,
      error: `运行结果缺少估计器「${estimatorId}」的指标（指标不可用，不能用 0 代替）`,
    };
  }
  if (!(LEARNING_METRIC_KEYS as readonly string[]).includes(metricName)) {
    return { ok: false, error: `未知指标「${metricName}」（指标不可用）` };
  }
  const samples = (found as unknown as Record<string, unknown>).n;
  if (typeof samples !== "number" || !Number.isFinite(samples) || samples <= 0) {
    return {
      ok: false,
      error: `${estimatorId} 没有参与统计的样本（指标不可用，不能用 0 代替）`,
    };
  }
  const raw = (found as unknown as Record<string, unknown>)[metricName];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      ok: false,
      error: `${estimatorId}.${metricName} 没有返回有限数值（指标不可用，不能用 0 代替）`,
    };
  }
  return {
    ok: true,
    value: raw,
    metric: metricName,
    estimatorId,
    label: found.label || estimatorId,
  };
}

export interface BuiltEvidence {
  numeric: number | null;
  text: string;
  passed: boolean | null;
  metricLabel: string;
  unit: string;
}

export type EvidenceBuildResult =
  | { ok: true; evidence: BuiltEvidence }
  | { ok: false; error: string };

/** 一次实际运行的结果；id 与 `evidenceRuns` 的标签对应（基线为 "A"）。 */
export interface EvidenceRunResult {
  id: string;
  metrics: readonly EstimatorRunMetrics[];
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function runOf(
  runs: readonly EvidenceRunResult[],
  id: string,
): EvidenceRunResult | undefined {
  return runs.find((run) => run.id === id);
}

function selectForPredicate(
  run: EvidenceRunResult | undefined,
  runId: string,
  estimatorId: EstimatorId,
  metric: string,
): MetricSelection {
  if (!run) {
    return { ok: false, error: `缺少运行「${runId}」的结果（指标不可用）` };
  }
  return selectEstimatorMetric(run.metrics, estimatorId, metric);
}

function compareMetric(a: number, op: "gt" | "lt" | "eq", b: number): boolean {
  if (op === "gt") return a > b;
  if (op === "lt") return a < b;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

interface PredicateValue {
  ok: true;
  value: boolean;
  note: string;
}

/**
 * 求一个选项谓词的真值。
 * 指标缺失/非有限/无样本时返回 `ok:false`——调用方必须显示「不可用」，
 * 不能把缺失当成 false，否则会凭空判用户错。
 */
function evaluatePredicate(
  predicate: EvidencePredicate,
  runs: readonly EvidenceRunResult[],
): PredicateValue | { ok: false; error: string } {
  if (predicate.kind === "always-true") return { ok: true, value: true, note: "" };
  if (predicate.kind === "always-false") return { ok: true, value: false, note: "" };

  const unit = metricUnit(predicate.metric);
  const label = metricDisplayName(predicate.metric);

  if (predicate.kind === "metric-compare-runs") {
    const selected = selectForPredicate(
      runOf(runs, predicate.run),
      predicate.run,
      predicate.estimator,
      predicate.metric,
    );
    if (!selected.ok) return selected;
    const other = selectForPredicate(
      runOf(runs, predicate.otherRun),
      predicate.otherRun,
      predicate.estimator,
      predicate.metric,
    );
    if (!other.ok) return other;
    const delta = Math.abs(selected.value - other.value);
    const value = compareMetric(selected.value, predicate.op, other.value) &&
      (predicate.minDelta === undefined || delta >= predicate.minDelta);
    const opText = predicate.op === "gt" ? ">" : predicate.op === "lt" ? "<" : "=";
    return {
      ok: true,
      value,
      note:
        `${label}（${predicate.estimator}）：${predicate.run}=` +
        `${formatNumber(selected.value)}${unit ? ` ${unit}` : ""} ${opText} ` +
        `${predicate.otherRun}=${formatNumber(other.value)}${unit ? ` ${unit}` : ""}` +
        (predicate.minDelta === undefined ? "" : `，Δ=${formatNumber(delta)} ${unit}（至少 ${formatNumber(predicate.minDelta)}）`),
    };
  }

  const runId = predicate.run ?? "A";
  const selected = selectForPredicate(
    runOf(runs, runId),
    runId,
    predicate.estimator,
    predicate.metric,
  );
  if (!selected.ok) return selected;
  const where = `${label}（${predicate.estimator}${runId === "A" ? "" : ` · ${runId}`}）`;
  const measured = `${where}=${formatNumber(selected.value)}${unit ? ` ${unit}` : ""}`;

  if (predicate.kind === "metric-range") {
    const aboveMin = predicate.min === undefined || selected.value >= predicate.min;
    const belowMax = predicate.max === undefined || selected.value <= predicate.max;
    const bound =
      predicate.min !== undefined && predicate.max !== undefined
        ? `${formatNumber(predicate.min)}–${formatNumber(predicate.max)}`
        : predicate.min !== undefined
          ? `≥ ${formatNumber(predicate.min)}`
          : `≤ ${formatNumber(predicate.max as number)}`;
    return {
      ok: true,
      value: aboveMin && belowMax,
      note: `${measured}（判据 ${bound}${unit ? ` ${unit}` : ""}）`,
    };
  }

  const value = compareMetric(selected.value, predicate.op, predicate.value);
  const opText = predicate.op === "gt" ? ">" : predicate.op === "lt" ? "<" : "=";
  return {
    ok: true,
    value,
    note: `${measured}（判据 ${opText} ${formatNumber(predicate.value)}${unit ? ` ${unit}` : ""}）`,
  };
}

export type PredicateEvaluation =
  | { ok: true; truth: Map<string, boolean>; notes: string[] }
  | { ok: false; error: string };

/**
 * 对每个选项求实测谓词。选项题必须覆盖全部选项；任何指标不可用都整体返回
 * `ok:false`（`passed` 绝不从静态正确选项列表读取）。
 */
export function evaluateEvidencePredicates(
  activity: LearningActivity,
  runs: readonly EvidenceRunResult[],
): PredicateEvaluation {
  const predicates = activity.evidencePredicates;
  if (!predicates) return { ok: false, error: "本题缺少选项谓词" };
  const choices = activity.choices ?? [];
  if (choices.length === 0) return { ok: false, error: "选项谓词缺少选项列表" };
  const truth = new Map<string, boolean>();
  const notes: string[] = [];
  for (const choice of choices) {
    const predicate = predicates[choice.id];
    if (!predicate) {
      return { ok: false, error: `选项「${choice.id}」缺少谓词（无法判定）` };
    }
    const evaluated = evaluatePredicate(predicate, runs);
    if (!evaluated.ok) {
      return { ok: false, error: `选项「${choice.id}」${evaluated.error}` };
    }
    truth.set(choice.id, evaluated.value);
    if (evaluated.note) notes.push(evaluated.note);
  }
  return { ok: true, truth, notes };
}

function selectedChoiceIds(prediction: PredictionAnswer): Set<string> {
  if (prediction.kind === "single") return new Set([prediction.choiceId]);
  if (prediction.kind === "multiple") return new Set(prediction.choiceIds);
  return new Set();
}

/**
 * 把一次或多次真实运行适配为活动证据。
 * - 数值范围题：numeric = 实测指标，交给 comparePrediction 判断是否落在用户区间；
 * - 选项题：passed 由实测谓词整题判定（选中集合必须与谓词为真的集合完全一致）；
 * - 纯几何题（runs 为空）：只允许 always-true/false 谓词；
 * - 任何缺失/非有限指标都返回 ok:false，由调用方标记运行失败，不泄露解释。
 */
export function evidenceFromRuns(
  activity: LearningActivity,
  prediction: PredictionAnswer,
  runs: readonly EvidenceRunResult[],
): EvidenceBuildResult {
  const unit = activity.expectedRange?.unit ?? metricUnit(activity.evidence.metric);
  const primaryRunId = activity.evidence.run ?? runs[0]?.id ?? "A";
  let numeric: number | null = null;
  let metricLabel: string = activity.evidence.estimatorId;
  let base = "";

  if (runs.length > 0) {
    const primary = runOf(runs, primaryRunId);
    const selection = selectForPredicate(
      primary,
      primaryRunId,
      activity.evidence.estimatorId,
      activity.evidence.metric,
    );
    if (!selection.ok) {
      return {
        ok: false,
        error: `${primaryRunId}：${selection.error}`,
      };
    }
    numeric = selection.value;
    metricLabel = selection.label;
    base =
      `${metricDisplayName(activity.evidence.metric)}（${selection.estimatorId}` +
      `${primaryRunId === "A" ? "" : ` · ${primaryRunId}`}）= ` +
      `${formatNumber(selection.value)}${unit ? ` ${unit}` : ""}`;
  }

  if (activity.answerKind === "range") {
    if (runs.length === 0) {
      return { ok: false, error: "缺少证据运行" };
    }
    if (prediction.kind !== "range") {
      return { ok: false, error: "预测类型与题目不符" };
    }
    const expected = activity.expectedRange;
    const rangeNote = expected
      ? `；题面合理区间 ${formatNumber(expected.min)}–${formatNumber(expected.max)} ${expected.unit}`
      : "";
    return {
      ok: true,
      evidence: {
        numeric,
        text: `${base}${rangeNote}`,
        passed: null,
        metricLabel,
        unit,
      },
    };
  }

  if (prediction.kind === "range") {
    return { ok: false, error: "预测类型与题目不符" };
  }

  const evaluated = evaluateEvidencePredicates(activity, runs);
  if (!evaluated.ok) return evaluated;

  const selected = selectedChoiceIds(prediction);
  const trueChoices = [...evaluated.truth.entries()]
    .filter(([, value]) => value)
    .map(([id]) => id);
  const passed =
    selected.size === trueChoices.length && trueChoices.every((id) => selected.has(id));

  const textBits: string[] = [];
  if (runs.length === 0) {
    textBits.push("几何题：证据来自演示，无需复算");
  } else if (base) {
    textBits.push(base);
  }
  if (evaluated.notes.length > 0) textBits.push(evaluated.notes.join("；"));
  textBits.push(`选项按实测谓词整题口径${passed ? "一致" : "不一致"}`);

  return {
    ok: true,
    evidence: {
      numeric,
      text: textBits.join("；"),
      passed,
      metricLabel,
      unit,
    },
  };
}

/** 单次运行的便捷入口（基线 A）；双运行题请用 `evidenceFromRuns`。 */
export function evidenceFromRun(
  activity: LearningActivity,
  prediction: PredictionAnswer,
  metrics: readonly EstimatorRunMetrics[],
): EvidenceBuildResult {
  return evidenceFromRuns(activity, prediction, [{ id: "A", metrics }]);
}

export function verdictLabel(verdict: PredictionVerdict): string {
  if (verdict === "consistent") return "与本次证据一致";
  if (verdict === "inconsistent") return "与本次证据相反";
  return "无法由本次证据判断";
}

function statusLabel(status: AttemptStatus): string {
  switch (status) {
    case "idle":
      return "空闲";
    case "answering":
      return "待预测";
    case "predicted":
      return "已锁定";
    case "running":
      return "运行中";
    case "ready":
      return "结果就绪";
    case "reviewing":
      return "已写反思";
    case "failed":
      return "运行失败";
    case "cancelled":
      return "运行已取消";
  }
}


function stateError(result: ActivityStateFailure): string {
  return result.details && result.details.length > 0
    ? `${result.error}（${result.details.join("；")}）`
    : result.error;
}

interface DraftAnswer {
  single: string;
  multiple: string[];
  min: string;
  max: string;
}

interface ActiveRun {
  activityId: string;
  attemptId: number;
  runRef: RunRef;
  cancelled: boolean;
}

let panelInstanceSeq = 0;

function emptyDraft(): DraftAnswer {
  return { single: "", multiple: [], min: "", max: "" };
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(
  doc: Document,
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = element(doc, "button", className, label);
  button.type = "button";
  button.onclick = onClick;
  return button;
}

function fact(
  doc: Document,
  keyClass: "k1" | "k2" | "k3",
  key: string,
  value: string,
): HTMLParagraphElement {
  const p = element(doc, "p");
  p.append(element(doc, "span", `k ${keyClass}`, key), doc.createTextNode(value));
  return p;
}

function numberFromInput(input: HTMLInputElement): number | null {
  const text = input.value.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * 创建面板实例。第二个参数只用于测试/已持有目录的宿主；正常 mount 会 fetch JSON。
 * 无论是否预载，API 方法都不直接访问数据模块。
 *
 * deps 用泛型约束（而不是精确类型）接住过渡期宿主可能多传的键：
 * 面板只读取 `LearningPanelDeps` 声明的成员，额外键不会被调用。
 */
export function createLearningPanel<D extends LearningPanelDeps>(
  deps: D,
  preloaded?: readonly LearningActivity[],
): LearningPanelApi {
  let activities: LearningActivity[] = [];
  let byId = new Map<string, LearningActivity>();
  let selectedId: string | null = null;
  const states = new Map<string, ActivityState>();
  const drafts = new Map<string, DraftAnswer>();
  let root: HTMLElement | null = null;
  let panelRoot: HTMLElement | null = null;
  let loadError: string | null = null;
  let panelError: string | null = null;
  let activeRun: ActiveRun | null = null;
  let nextRunId = 1;
  let claimsMounted = false;
  const instanceId = `lp${panelInstanceSeq++}`;

  const lookup: LearningActivityLookup = (id) => byId.get(id);

  function installActivities(list: readonly LearningActivity[]): void {
    activities = [...list];
    byId = new Map(activities.map((activity) => [activity.id, activity]));
  }

  if (preloaded && preloaded.length > 0) installActivities(preloaded);

  function currentActivity(): LearningActivity | null {
    return selectedId ? byId.get(selectedId) ?? null : null;
  }

  function currentState(): ActivityState | undefined {
    const activity = currentActivity();
    return activity ? states.get(activity.id) : undefined;
  }

  function draftFor(activityId: string): DraftAnswer {
    let draft = drafts.get(activityId);
    if (!draft) {
      draft = emptyDraft();
      drafts.set(activityId, draft);
    }
    return draft;
  }

  function notify(message: string, color?: string): void {
    try {
      deps.toast(message, color);
    } catch {
      // 提示失败不能影响状态机；面板内仍有错误文本。
    }
  }

  function isActive(token: ActiveRun): boolean {
    return activeRun === token && !token.cancelled;
  }

  function cancelActiveRun(message: string): boolean {
    const run = activeRun;
    if (!run) return false;
    run.cancelled = true;
    activeRun = null;
    const state = states.get(run.activityId);
    if (state?.current?.status === "running") {
      const result = cancelRun(state, state.current.runRef ?? undefined);
      if (result.ok) states.set(run.activityId, result.state);
    }
    notify(message, "#fbbf24");
    return true;
  }

  function ensureActivityState(activity: LearningActivity): ActivityState {
    let state = states.get(activity.id);
    if (!state) state = createActivityState();
    if (!state.current) {
      const started = startAttempt(state, activity.id, activity.version, lookup);
      if (!started.ok) {
        rememberError(`无法开始活动「${activity.title}」：${stateError(started)}`);
        return state;
      }
      state = started.state;
      states.set(activity.id, state);
      return state;
    }
    if (state.current.activityVersion !== activity.version) {
      const base: ActivityState = { ...state, current: null };
      const started = startAttempt(base, activity.id, activity.version, lookup);
      if (!started.ok) {
        rememberError(`活动「${activity.title}」版本已变化，无法继续：${stateError(started)}`);
        return state;
      }
      state = started.state;
      states.set(activity.id, state);
    }
    return state;
  }

  function rememberError(message: string): void {
    panelError = message;
    notify(message, "#f85149");
  }

  function reportError(message: string): { ok: false; error: string } {
    rememberError(message);
    render();
    return { ok: false, error: message };
  }

  // ---------- 渲染 ----------

  function render(): void {
    if (!panelRoot) return;
    const doc = panelRoot.ownerDocument;
    panelRoot.replaceChildren();

    if (loadError) {
      renderLoadError(doc, loadError);
      return;
    }
    if (activities.length === 0) {
      panelRoot.append(
        element(
          doc,
          "p",
          "plain",
          panelError ?? "加载中…",
        ),
      );
      return;
    }

    const activity = currentActivity();
    const state = activity ? ensureActivityState(activity) : null;
    const current = state?.current ?? null;

    const section = element(doc, "section", "panel-section");
    section.setAttribute("data-learning-panel", "");
    section.setAttribute("aria-label", "预测—验证式学习");
    section.append(element(doc, "h2", undefined, "预测—验证式学习"));
    section.append(
      element(
        doc,
        "p",
        "plain",
        "先锁定判断再复算。" +
          "仅存本页内存。",
      ),
    );

    const chooser = element(doc, "div", "row btn-row");
    chooser.setAttribute("role", "group");
    chooser.setAttribute("aria-label", "选择学习活动");
    activities.forEach((item, index) => {
      const active = item.id === activity?.id;
      const button = makeButton(
        doc,
        `${index + 1}. ${item.title}`,
        active ? "btn primary" : "btn",
        () => setActivity(item.id),
      );
      button.setAttribute("aria-pressed", active ? "true" : "false");
      chooser.append(button);
    });
    section.append(chooser);

    if (activity) {
      renderPrompt(doc, section, activity);
      if (panelError) {
        const error = element(doc, "div", "ctl");
        error.setAttribute("role", "alert");
        error.append(element(doc, "div", "ctl-name", "错误"));
        error.append(element(doc, "p", "plain", panelError));
        section.append(error);
      }
      renderForm(doc, section, activity, state, current);
      if (state && canReveal(state)) renderResult(doc, section, activity, state);
      renderHistory(doc, section, state);
    } else {
      section.append(element(doc, "p", "plain", "请选择一道学习活动。"));
    }

    panelRoot.append(section);
  }

  function renderLoadError(doc: Document, message: string): void {
    const section = element(doc, "section", "panel-section");
    section.setAttribute("data-learning-panel", "");
    section.append(element(doc, "h2", undefined, "预测—验证式学习"));
    const box = element(doc, "div", "ctl");
    box.setAttribute("role", "alert");
    box.append(element(doc, "div", "ctl-name", "活动数据不可用"));
    box.append(element(doc, "p", "plain", message));
    section.append(box);
    panelRoot?.append(section);
  }

  function renderPrompt(
    doc: Document,
    section: HTMLElement,
    activity: LearningActivity,
  ): void {
    const card = element(doc, "div", "ctl");
    const name = element(doc, "div", "ctl-name", activity.title);
    name.append(
      element(
        doc,
        "span",
        "ctl-range",
        `${answerKindLabel(activity.answerKind)} · v${activity.version}`,
      ),
    );
    card.append(name);
    card.append(fact(doc, "k1", "题", activity.prompt));
    card.append(fact(doc, "k2", "固定条件", activity.conditionsText));
    if (activity.predictionHint) {
      card.append(fact(doc, "k1", "提示", activity.predictionHint));
    }
    section.append(card);
  }

  function renderForm(
    doc: Document,
    section: HTMLElement,
    activity: LearningActivity,
    state: ActivityState | null,
    current: ActivityState["current"],
  ): void {
    const form = element(doc, "div", "ctl");
    const draft = draftFor(activity.id);
    const locked = current !== null && current.status !== "answering";
    const prediction = current?.prediction ?? null;

    form.append(element(doc, "div", "ctl-name", "你的预测"));
    if (locked && current?.predictionText) {
      form.append(fact(doc, "k3", "已锁定", current.predictionText));
    }

    const radios: HTMLInputElement[] = [];
    const checks: HTMLInputElement[] = [];
    let minInput: HTMLInputElement | null = null;
    let maxInput: HTMLInputElement | null = null;
    let unit = activity.expectedRange?.unit ?? "°";

    if (activity.answerKind === "single") {
      const name = `${instanceId}-${activity.id}-single`;
      for (const choice of activity.choices ?? []) {
        const row = element(doc, "div", "row");
        const label = element(doc, "label");
        const input = element(doc, "input");
        input.type = "radio";
        input.name = name;
        input.value = choice.id;
        input.disabled = locked;
        input.checked =
          prediction?.kind === "single"
            ? prediction.choiceId === choice.id
            : draft.single === choice.id;
        input.addEventListener("change", () => {
          if (input.checked) draft.single = choice.id;
        });
        label.append(input, doc.createTextNode(` ${choice.text}`));
        row.append(label);
        form.append(row);
        radios.push(input);
      }
    } else if (activity.answerKind === "multiple") {
      for (const choice of activity.choices ?? []) {
        const row = element(doc, "div", "row");
        const label = element(doc, "label");
        const input = element(doc, "input");
        input.type = "checkbox";
        input.value = choice.id;
        input.disabled = locked;
        input.checked =
          prediction?.kind === "multiple"
            ? prediction.choiceIds.includes(choice.id)
            : draft.multiple.includes(choice.id);
        input.addEventListener("change", () => {
          const selected = new Set(draft.multiple);
          if (input.checked) selected.add(choice.id);
          else selected.delete(choice.id);
          draft.multiple = [...selected];
        });
        label.append(input, doc.createTextNode(` ${choice.text}`));
        row.append(label);
        form.append(row);
        checks.push(input);
      }
    } else {
      unit =
        activity.expectedRange?.unit ??
        (prediction?.kind === "range" ? prediction.unit : "°");
      minInput = element(doc, "input", "num-input");
      minInput.type = "number";
      minInput.step = "any";
      minInput.placeholder = "留空 = 不限";
      minInput.id = `${instanceId}-${activity.id}-min`;
      minInput.disabled = locked;
      minInput.value =
        prediction?.kind === "range" && prediction.min !== null
          ? String(prediction.min)
          : draft.min;
      minInput.addEventListener("input", () => {
        draft.min = minInput!.value;
      });

      maxInput = element(doc, "input", "num-input");
      maxInput.type = "number";
      maxInput.step = "any";
      maxInput.placeholder = "留空 = 不限";
      maxInput.id = `${instanceId}-${activity.id}-max`;
      maxInput.disabled = locked;
      maxInput.value =
        prediction?.kind === "range" && prediction.max !== null
          ? String(prediction.max)
          : draft.max;
      maxInput.addEventListener("input", () => {
        draft.max = maxInput!.value;
      });

      const minRow = element(doc, "div", "slider-row");
      const minLabel = element(doc, "label", undefined, "下限");
      minLabel.htmlFor = minInput.id;
      minRow.append(minLabel, minInput, element(doc, "span", "dim", unit));
      form.append(minRow);

      const maxRow = element(doc, "div", "slider-row");
      const maxLabel = element(doc, "label", undefined, "上限");
      maxLabel.htmlFor = maxInput.id;
      maxRow.append(maxLabel, maxInput, element(doc, "span", "dim", unit));
      form.append(maxRow);

      form.append(
        element(
          doc,
          "p",
          "plain",
          `至少填一端；判据是实测值是否落在你的区间内，不要求逐位相等。单位固定为 ${unit}。`,
        ),
      );
    }

    const buildAnswer = (): PredictionAnswer => {
      if (activity.answerKind === "single") {
        const checked = radios.find((input) => input.checked);
        return { kind: "single", choiceId: checked?.value ?? "" };
      }
      if (activity.answerKind === "multiple") {
        return {
          kind: "multiple",
          choiceIds: checks.filter((input) => input.checked).map((input) => input.value),
        };
      }
      return {
        kind: "range",
        min: minInput ? numberFromInput(minInput) : null,
        max: maxInput ? numberFromInput(maxInput) : null,
        unit,
      };
    };

    const row = element(doc, "div", "row btn-row");
    const submit = makeButton(doc, "提交预测", "btn", () => {
      submitPrediction(buildAnswer());
    });
    submit.disabled = locked || !state?.current;
    row.append(submit);

    const evidenceSec = activity.evidencePatch?.durationSec ?? EVIDENCE_DURATION_SEC;
    const runCount = 1 + (activity.evidenceRuns?.length ?? 0);
    const runButton = makeButton(
      doc,
      current?.status === "running"
        ? "运行中…"
        : `运行证据（离线复算 ${evidenceSec} s${runCount > 1 ? ` × ${runCount} 次` : ""}）`,
      "btn primary",
      () => {
        void run().catch((error: unknown) => {
          reportError(`运行失败：${errorTextOf(error)}`);
        });
      },
    );
    runButton.disabled = current?.status !== "predicted";
    row.append(runButton);
    form.append(row);

    if (
      current &&
      (current.status === "predicted" ||
        current.status === "failed" ||
        current.status === "cancelled")
    ) {
      const restartRow = element(doc, "div", "row btn-row");
      restartRow.append(
        makeButton(doc, "重来", "btn", () => {
          reset();
        }),
      );
      form.append(restartRow);
    }

    const patchNote = activity.evidencePatch
      ? `运行按本题固定条件（${evidenceSec} s，含题面零偏/噪声/初始姿态）离线复算，不装载实验、也不读取现场滑块。`
      : "几何证据无需数值复算。";
    form.append(
      element(
        doc,
        "p",
        "plain",
        `${patchNote}现场实时曲线可能来自不同时长/条件；结果面板只陈述这次证据，不声称图表与结果逐点一致。`,
      ),
    );

    if (current?.status === "failed" || current?.status === "cancelled") {
      form.append(
        element(
          doc,
          "p",
          "plain",
          "运行未完成：不显示答案",
        ),
      );
    }

    section.append(form);
  }

  function renderResult(
    doc: Document,
    section: HTMLElement,
    activity: LearningActivity,
    state: ActivityState,
  ): void {
    const current = state.current;
    if (!current || !current.evidence || !current.comparison) return;
    const result = element(doc, "div", "ctl");
    result.append(element(doc, "div", "ctl-name", "结果对照"));

    result.append(fact(doc, "k3", "我的预测", current.predictionText || "未记录"));
    const numeric = current.evidence.numeric;
    const unit =
      activity.expectedRange?.unit ??
      (current.prediction?.kind === "range" ? current.prediction.unit : metricUnit(activity.evidence.metric));
    const actualText =
      numeric === null
        ? activity.evidencePatch
          ? "不可用（不补 0）"
          : "无需数值"
        : `${metricDisplayName(activity.evidence.metric)} = ${formatNumber(numeric)}${unit ? ` ${unit}` : ""}`;
    result.append(fact(doc, "k1", "实际证据", actualText));
    if (activity.expectedRange) {
      result.append(
        fact(
          doc,
          "k2",
          "题面合理区间",
          `${formatNumber(activity.expectedRange.min)}–${formatNumber(activity.expectedRange.max)} ${activity.expectedRange.unit}`,
        ),
      );
    }
    result.append(fact(doc, "k3", "判定", verdictLabel(current.comparison.verdict)));
    result.append(element(doc, "p", undefined, current.comparison.explanation));

    result.append(element(doc, "h3", undefined, "解释（证据就绪后）"));
    result.append(element(doc, "p", undefined, activity.explanation));
    result.append(
      element(
        doc,
        "p",
        "plain",
        "口径：曲线条件可能不同" +
          `（${activity.evidencePatch?.durationSec ?? EVIDENCE_DURATION_SEC} s）得到的离线复算证据，` +
          "不等同于图表逐点一致。",
      ),
    );

    const docsRow = element(doc, "div", "row btn-row");
    docsRow.append(
      makeButton(doc, "教材", "btn", () => {
        try {
          deps.openDocs(activity.doc.page, activity.doc.anchor);
        } catch (error) {
          reportError(`打开教材失败：${errorTextOf(error)}`);
        }
      }),
    );
    result.append(docsRow);

    result.append(element(doc, "h3", undefined, "修正理解（可选）"));
    const reflection = element(doc, "textarea", "num-input");
    reflection.rows = 2;
    reflection.style.width = "100%";
    reflection.style.boxSizing = "border-box";
    reflection.value = current.reflection;
    reflection.placeholder = "一句话即可，仅存本页内存。";
    reflection.setAttribute("aria-label", "我修正后的理解");
    result.append(reflection);

    const actions = element(doc, "div", "row btn-row");
    actions.append(
      makeButton(doc, "保存", "btn", () => {
        const latest = states.get(activity.id) ?? state;
        const saved = addReflection(latest, reflection.value);
        if (!saved.ok) {
          reportError(`保存失败：${stateError(saved)}`);
          return;
        }
        states.set(activity.id, saved.state);
        panelError = null;
        render();
        notify("反思已保存");
      }),
    );
    actions.append(
      makeButton(doc, "导出", "btn", () => {
        try {
          const latest = states.get(activity.id) ?? state;
          const record = exportActivityRecord(latest);
          const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = doc.createElement("a");
          link.href = url;
          link.download = `learning-${activity.id}-v${activity.version}.json`;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
          notify("学习记录已导出（仅本页内存）");
        } catch (error) {
          reportError(`导出学习记录失败：${errorTextOf(error)}`);
        }
      }),
    );
    actions.append(
      makeButton(doc, "重来", "btn primary", () => {
        reset();
      }),
    );
    result.append(actions);
    section.append(result);
  }

  function renderHistory(
    doc: Document,
    section: HTMLElement,
    state: ActivityState | null,
  ): void {
    if (!state || state.history.length === 0) return;
    section.append(element(doc, "h3", undefined, "尝试历史（仅内存）"));
    const scroll = element(doc, "div", "tscroll");
    const table = element(doc, "table", "docs-table");
    const head = element(doc, "thead");
    const headRow = element(doc, "tr");
    for (const label of ["尝试", "状态", "预测"]) {
      headRow.append(element(doc, "th", undefined, label));
    }
    head.append(headRow);
    table.append(head);
    const body = element(doc, "tbody");
    for (const attempt of state.history) {
      const row = element(doc, "tr");
      row.append(element(doc, "td", undefined, `#${attempt.attemptId}`));
      row.append(element(doc, "td", undefined, statusLabel(attempt.status)));
      row.append(element(doc, "td", undefined, attempt.predictionText || "—"));
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    section.append(scroll);
  }

  function answerKindLabel(kind: LearningActivity["answerKind"]): string {
    if (kind === "single") return "单选";
    if (kind === "multiple") return "多选";
    return "数值范围";
  }

  async function fetchActivities(): Promise<unknown> {
    const baseURI = root?.baseURI ?? document.baseURI;
    const url = activitiesDataUrl(baseURI);
    // no-cache：拿到最新目录；离线时由 Service Worker 的同源缓存兜底（首次联网取到之后）。
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`activities.json: HTTP ${response.status}`);
    return response.json();
  }

  // ---------- 公开 API ----------

  async function mount(rootElement: HTMLElement): Promise<void> {
    root = rootElement;
    loadError = null;
    panelError = null;
    if (!root) return;
    try {
      const doc = root.ownerDocument;
      // 在宿主容器里建一个自有子节点，避免清空 labs 文档页等既有内容；重复 mount 复用同一个子节点。
      if (!panelRoot || panelRoot.parentElement !== root) {
        panelRoot?.remove();
        panelRoot = element(doc, "div");
        panelRoot.setAttribute("data-learning-panel-host", "");
        root.append(panelRoot);
      }
      panelRoot.replaceChildren();
      panelRoot.append(element(doc, "p", "plain", "加载中…"));

      if (activities.length === 0) {
        const raw = await fetchActivities();
        const parsed = parseLearningActivities(raw);
        if (parsed.errors.length > 0) {
          loadError = `目录不可用：${parsed.errors.join("；")}`;
          notify(loadError, "#f85149");
          render();
          return;
        }
        installActivities(parsed.activities);
      }

      if (!selectedId || !byId.has(selectedId)) {
        const first = activities[0];
        if (first) {
          selectedId = first.id;
          ensureActivityState(first);
        }
      } else {
        const selected = byId.get(selectedId);
        if (selected) ensureActivityState(selected);
      }
      render();
      if (!claimsMounted) {
        claimsMounted = true;
        mountClaimLinks({
          root,
          openDocs: deps.openDocs,
          setActivity,
          toast: notify,
          closeDocs: deps.closeDocs,
          loadExperiment: deps.loadExperiment,
          ensureComparison: deps.ensureComparison,
          onTask: deps.onTask,
          ensureTaskStrip: deps.ensureTaskStrip,
        });
      }
    } catch (error) {
      loadError = `目录失败：${errorTextOf(error)}`;
      notify(loadError, "#f85149");
      try {
        render();
      } catch {
        // 最坏情况下连错误 UI 都无法渲染；mount 仍然正常结束，不抛出 rejection。
      }
    }
  }

  function setActivity(id: string): void {
    const activity = byId.get(id);
    if (!activity) {
      reportError(`未知学习活动：${id}`);
      return;
    }
    if (selectedId === id) {
      panelError = null;
      render();
      return;
    }
    if (activeRun) cancelActiveRun("已切题：原运行取消");
    selectedId = id;
    panelError = null;
    ensureActivityState(activity);
    render();
  }

  function submitPrediction(answer: PredictionAnswer): { ok: boolean; error?: string } {
    const activity = currentActivity();
    if (!activity) return reportError("先选一道题");
    const state = states.get(activity.id);
    if (!state?.current) return reportError("尝试不存在，请重选题");
    const submitted = submitPredictionState(state, answer, lookup);
    if (!submitted.ok) return reportError(stateError(submitted));
    states.set(activity.id, submitted.state);
    drafts.delete(activity.id);
    panelError = null;
    render();
    return { ok: true };
  }

  async function run(): Promise<{ ok: boolean; error?: string }> {
    const activity = currentActivity();
    if (!activity) return reportError("先选一道题");
    const state = states.get(activity.id);
    const current = state?.current;
    if (!state || !current) return reportError("尝试不存在，请重选题");
    if (current.status !== "predicted") {
      return reportError(
        current.status === "answering"
          ? "先提交预测。"
          : `不能运行：${statusLabel(current.status)}；请点「重来」开始新尝试。`,
      );
    }
    if (activity.evidence.kind !== "live") {
      return reportError("本题没有现场证据。");
    }
    if (!current.prediction) {
      return reportError("缺少预测");
    }
    if (activeRun) return reportError("运行进行中");

    // 配置完全由固定教学基线 + evidencePatch 决定；不读取现场滑块、校准或 A/B。
    let configs: EvidenceRunConfig[];
    let digest: string;
    try {
      configs = evidenceRunConfigs(teachingBaseConfig(), activity);
      if (configs.length === 0 && !activity.evidencePredicates) {
        return reportError("无可运行证据条件。");
      }
      const baseConfig = configs[0]?.config ?? evidenceConfig(teachingBaseConfig());
      digest = configDigest(baseConfig);
    } catch (error) {
      return reportError(`配置失败：${errorTextOf(error)}`);
    }
    const durationSec = activity.evidencePatch?.durationSec ?? EVIDENCE_DURATION_SEC;

    const plan: EvidencePlanEntry[] = configs.map((item) => ({ runId: item.id, configDigest: item.digest }));
    const runRef: RunRef = { kind: "live", id: nextRunId++ };
    const bound = bindRun(state, runRef, digest, plan.length > 0 ? plan : undefined);
    if (!bound.ok) return reportError(stateError(bound));
    states.set(activity.id, bound.state);

    const token: ActiveRun = {
      activityId: activity.id,
      attemptId: bound.state.current!.attemptId,
      runRef,
      cancelled: false,
    };
    activeRun = token;
    panelError = null;
    render();

    const failCurrent = (cancelled: boolean): void => {
      const stateNow = states.get(activity.id) ?? bound.state;
      const terminal = cancelled ? cancelRun(stateNow, runRef) : failRun(stateNow, runRef);
      if (terminal.ok) states.set(activity.id, terminal.state);
      activeRun = null;
    };

    try {
      const runs: EvidenceRunResult[] = [];
      const runResults: EvidenceRunSummary[] = [];
      for (const item of configs) {
        if (!isActive(token)) return { ok: false, error: "运行已取消" };
        // FIX-09：旧运行在下一片收到 shouldCancel 后停止；主入口接线后即可生效。
        const result = await deps.runEvidence(item.config, activity, () => !isActive(token));
        if (!isActive(token)) return { ok: false, error: "运行已取消" };

        const termination = result?.termination;
        if (!termination || termination.reason !== "completed") {
          const cancelled = termination?.reason === "cancelled";
          failCurrent(cancelled);
          return reportError(
            cancelled
              ? "已取消：不显示答案"
              : "未完成：不显示答案",
          );
        }
        runs.push({ id: item.id, metrics: result.metrics });
        runResults.push({ runId: item.id, termination: "completed", metrics: [...result.metrics] });
      }

      const prediction = bound.state.current?.prediction;
      if (!prediction) {
        failCurrent(false);
        return reportError("缺少预测");
      }

      const built = evidenceFromRuns(activity, prediction, runs);
      if (!built.ok) {
        failCurrent(false);
        return reportError(`证据不可用：${built.error}。预测保留，不显示答案。`);
      }

      const stateNow = states.get(activity.id) ?? bound.state;
      const completed = completeRun(
        stateNow,
        {
          attemptId: token.attemptId,
          runRef,
          configDigest: digest,
          ...(plan.length > 0 ? { evidencePlan: plan, runResults } : {}),
          numeric: built.evidence.numeric,
          text: built.evidence.text,
          passed: built.evidence.passed ?? undefined,
        },
        lookup,
      );
      if (!completed.ok) {
        failCurrent(false);
        return reportError(`绑定结果失败：${stateError(completed)}`);
      }

      states.set(activity.id, completed.state);
      activeRun = null;
      panelError = null;
      render();
      notify(
        configs.length === 0
          ? "几何证据已判定"
          : `离线复算（${durationSec} s${configs.length > 1 ? ` × ${configs.length} 次` : ""}）；仅本次证据`,
        "#7ee787",
      );
      return { ok: true };
    } catch (error) {
      if (!isActive(token)) return { ok: false, error: "运行已取消" };
      activeRun = null;
      const failed = failRun(states.get(activity.id) ?? bound.state, runRef);
      if (failed.ok) states.set(activity.id, failed.state);
      return reportError(
        `运行失败：${errorTextOf(error)}。预测保留，不显示答案。`,
      );
    }
  }

  function reset(): void {
    const activity = currentActivity();
    if (!activity) {
      reportError("先选一道题");
      return;
    }
    cancelActiveRun("当前运行已取消，开始新的尝试");
    let state = states.get(activity.id) ?? createActivityState();
    if (state.current?.status === "running") {
      const cancelled = cancelRun(state, state.current.runRef ?? undefined);
      if (cancelled.ok) state = cancelled.state;
    }
    if (state.current?.status === "answering") {
      // 未提交预测的草稿没有可保留的答案；直接放弃这一轮，历史里的正式尝试不动。
      state = { ...state, current: null };
    }
    const restarted = state.current
      ? restart(state, lookup)
      : startAttempt(state, activity.id, activity.version, lookup);
    if (!restarted.ok) {
      reportError(`无法开始新的尝试：${stateError(restarted)}`);
      return;
    }
    states.set(activity.id, restarted.state);
    drafts.delete(activity.id);
    panelError = null;
    render();
  }

  function state(): LearningPanelState {
    const activity = currentActivity();
    const current = currentState()?.current ?? null;
    const evidence = current?.evidence ?? null;
    return {
      loaded: activities.length > 0,
      activityCount: activities.length,
      activityId: activity?.id ?? null,
      activityTitle: activity?.title ?? null,
      attemptId: current?.attemptId ?? null,
      status: current?.status ?? "idle",
      predictionText: current?.predictionText ?? "",
      hasPrediction: current?.prediction !== null && current?.prediction !== undefined,
      canRun: current?.status === "predicted",
      canReveal: canReveal(currentState()),
      verdict: current?.comparison?.verdict ?? null,
      evidence: evidence ? { ...evidence, runRef: { ...evidence.runRef } } : null,
      configDigest: current?.configDigest ?? null,
      attempts: currentState()
        ? currentState()!.history.length + (currentState()!.current ? 1 : 0)
        : 0,
      error: panelError ?? loadError,
    };
  }

  return { mount, setActivity, submitPrediction, run, state, reset };
}

/**
 * 过渡期接线类型：宿主可能仍带着面板已不再使用的回调。
 * 额外键只被类型系统接受，面板绝不读取；成员类型都是函数（`never[]` 参数让
 * 未声明回调的参数获得 never，而不是隐式 any）。
 */
type TransitionalPanelDeps = LearningPanelDeps & {
  [extra: string]: ((...args: never[]) => unknown) | undefined;
};

/**
 * 便捷入口：创建并 mount，返回可继续调用的 API。mount 自身不会 reject。
 */
export async function mountLearningPanel(
  deps: TransitionalPanelDeps,
  root: HTMLElement,
): Promise<LearningPanelApi> {
  const panel = createLearningPanel(deps);
  await panel.mount(root);
  return panel;
}
