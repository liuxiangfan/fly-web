/**
 * F-02 学习活动会话状态机（纯内存、纯函数）。
 *
 * 状态机：
 *   idle（current === null）
 *     → answering
 *     → predicted（预测已锁定）
 *     → running（保存 runRef）
 *     → ready（结果与当前 attemptId + runRef 匹配）
 *     → reviewing（可写反思）
 *   running → failed / cancelled
 *
 * 约束：
 * - 旧 attempt 的 runRef 不能完成新 attempt；attemptId / runRef kind + id 必须同时匹配；
 * - 重复提交预测、重复绑定运行都被拒绝；
 * - failed / cancelled 不产生证据与对照结论，`canReveal` 保持 false；
 * - 反思按纯文本原样保存，不在状态层转义（视图负责）；
 * - 不访问 DOM、不读写持久化、不产生设备信息。
 */
import {
  comparePrediction,
  judgePrediction,
  predictionLabel,
  type LearningActivity,
  type PredictionAnswer,
  type PredictionComparison,
} from "./learning-activities";

/**
 * 活动定义的查找函数由调用方注入：
 * 运行时面板从 fetch 的 JSON 建立索引，Node 测试从 `learning-activity-data.ts` 建立索引。
 * 状态机因此不需要静态 import 数据模块，题目文本也不会被拖进面板 chunk。
 */
export type LearningActivityLookup = (id: string) => LearningActivity | undefined;

const NO_ACTIVITIES: LearningActivityLookup = () => undefined;

export const ATTEMPT_STATUSES = [
  "idle",
  "answering",
  "predicted",
  "running",
  "ready",
  "reviewing",
  "failed",
  "cancelled",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export interface RunRef {
  kind: "live" | "comparison";
  id: number;
}

export interface EvidenceSummary {
  attemptId: number;
  runRef: RunRef;
  /** 本次证据运行所用配置的规范摘要（canonicalize 后的哈希）。 */
  configDigest: string;
  numeric: number | null;
  text: string;
  passed: boolean | null;
}

export interface EvidencePlanEntry {
  runId: string;
  configDigest: string;
}

export interface EvidenceRunMetrics {
  id: string;
  n: number | null;
  max: number | null;
  rmse: number | null;
  steadyRmse: number | null;
  tiltRmse: number | null;
  yawRmse: number | null;
}

export interface EvidenceRunSummary {
  runId: string;
  termination: string;
  metrics: EvidenceRunMetrics[];
}

export interface ActivityAttempt {
  attemptId: number;
  activityId: string;
  activityVersion: number;
  prediction: PredictionAnswer | null;
  predictionText: string;
  status: AttemptStatus;
  runRef: RunRef | null;
  /** 绑定时锁定的证据配置摘要；未绑定为 null。旧结果不能跨摘要完成新尝试。 */
  configDigest: string | null;
  /** 所有证据侧的有序 {runId, digest} 计划；旧尝试可为 null。 */
  evidencePlan: EvidencePlanEntry[] | null;
  /** 各侧结构化关键指标与终止原因；未完成尝试为 null。 */
  runResults: EvidenceRunSummary[] | null;
  reflection: string;
  evidence: EvidenceSummary | null;
  comparison: PredictionComparison | null;
}

export interface ActivityState {
  /** null 表示 idle。 */
  current: ActivityAttempt | null;
  history: ActivityAttempt[];
  nextAttemptId: number;
}

export interface RunEvidence {
  attemptId: number;
  runRef: RunRef;
  configDigest?: string;
  evidencePlan?: EvidencePlanEntry[];
  runResults?: EvidenceRunSummary[];
  numeric?: number | null;
  text?: string;
  passed?: boolean;
}

export type ActivityStateErrorCode =
  | "invalid-state"
  | "invalid-activity"
  | "invalid-prediction"
  | "prediction-locked"
  | "invalid-run-ref"
  | "invalid-config-digest"
  | "run-already-bound"
  | "wrong-status"
  | "stale-run"
  | "invalid-evidence"
  | "invalid-reflection";

export interface ActivityStateSuccess {
  ok: true;
  state: ActivityState;
  attempt: ActivityAttempt;
}

export interface ActivityStateFailure {
  ok: false;
  code: ActivityStateErrorCode;
  error: string;
  details?: string[];
}

export type ActivityStateResult = ActivityStateSuccess | ActivityStateFailure;

export interface ActivityRecordAttempt {
  attemptId: number;
  activityId: string;
  activityVersion: number;
  prediction: PredictionAnswer | null;
  predictionText: string;
  status: AttemptStatus | "unknown";
  runRef: RunRef | null;
  configDigest: string;
  evidencePlan: EvidencePlanEntry[] | null;
  runResults: EvidenceRunSummary[] | null;
  reflection: string;
  evidence: EvidenceSummary | null;
  comparison: PredictionComparison | null;
}

export interface ActivityRecord {
  schema: "learning-activity-record/v1";
  activityId: string;
  activityVersion: number;
  currentAttemptId: number | null;
  attempts: ActivityRecordAttempt[];
}

export function createActivityState(): ActivityState {
  return { current: null, history: [], nextAttemptId: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isAttemptStatus(value: unknown): value is AttemptStatus {
  return typeof value === "string" && (ATTEMPT_STATUSES as readonly string[]).includes(value);
}

function isPredictionAnswer(value: unknown): value is PredictionAnswer {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "single":
      return typeof value.choiceId === "string";
    case "multiple":
      return (
        Array.isArray(value.choiceIds) &&
        value.choiceIds.every((id) => typeof id === "string")
      );
    case "range":
      return (
        (value.min === null ||
          (typeof value.min === "number" && Number.isFinite(value.min))) &&
        (value.max === null ||
          (typeof value.max === "number" && Number.isFinite(value.max))) &&
        typeof value.unit === "string"
      );
    default:
      return false;
  }
}

function isAttempt(value: unknown): value is ActivityAttempt {
  if (!isRecord(value)) return false;
  return (
    isPositiveInt(value.attemptId) &&
    typeof value.activityId === "string" &&
    value.activityId.length > 0 &&
    isPositiveInt(value.activityVersion) &&
    typeof value.predictionText === "string" &&
    typeof value.reflection === "string" &&
    isAttemptStatus(value.status) &&
    (value.prediction === null || isPredictionAnswer(value.prediction)) &&
    (value.runRef === null || isRecord(value.runRef)) &&
    (value.configDigest === undefined ||
      value.configDigest === null ||
      typeof value.configDigest === "string") &&
    (value.evidencePlan === undefined ||
      value.evidencePlan === null ||
      (Array.isArray(value.evidencePlan) && value.evidencePlan.every((entry) => isRecord(entry) && typeof entry.runId === "string" && typeof entry.configDigest === "string"))) &&
    (value.runResults === undefined ||
      value.runResults === null ||
      (Array.isArray(value.runResults) && value.runResults.every((run) => isRecord(run) && typeof run.runId === "string" && typeof run.termination === "string" && Array.isArray(run.metrics)))) &&
    (value.evidence === null || isRecord(value.evidence)) &&
    (value.comparison === null || isRecord(value.comparison))
  );
}

function isActivityState(value: unknown): value is ActivityState {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.history) || !value.history.every(isAttempt)) return false;
  if (!isPositiveInt(value.nextAttemptId)) return false;
  return value.current === null || isAttempt(value.current);
}

function isTerminalStatus(status: AttemptStatus): boolean {
  return (
    status === "idle" ||
    status === "ready" ||
    status === "reviewing" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function fail(
  code: ActivityStateErrorCode,
  error: string,
  details?: string[],
): ActivityStateFailure {
  return details && details.length > 0
    ? { ok: false, code, error, details }
    : { ok: false, code, error };
}

function success(state: ActivityState): ActivityStateSuccess {
  return { ok: true, state, attempt: state.current! };
}

function clonePrediction(answer: PredictionAnswer): PredictionAnswer {
  switch (answer.kind) {
    case "single":
      return { kind: "single", choiceId: answer.choiceId };
    case "multiple":
      return { kind: "multiple", choiceIds: [...answer.choiceIds] };
    case "range":
      return { kind: "range", min: answer.min, max: answer.max, unit: answer.unit };
  }
}

function cloneAttempt(attempt: ActivityAttempt): ActivityAttempt {
  return {
    ...attempt,
    prediction: attempt.prediction ? clonePrediction(attempt.prediction) : null,
    runRef: attempt.runRef ? { ...attempt.runRef } : null,
    configDigest:
      typeof attempt.configDigest === "string" ? attempt.configDigest : null,
    evidencePlan: Array.isArray(attempt.evidencePlan)
      ? attempt.evidencePlan.map((entry) => ({ runId: entry.runId, configDigest: entry.configDigest }))
      : null,
    runResults: Array.isArray(attempt.runResults)
      ? attempt.runResults.map((run) => ({
          runId: run.runId,
          termination: run.termination,
          metrics: run.metrics.map((metric) => ({ ...metric })),
        }))
      : null,
    evidence: attempt.evidence
      ? {
          attemptId: attempt.evidence.attemptId,
          runRef: { ...attempt.evidence.runRef },
          configDigest: attempt.evidence.configDigest,
          numeric: attempt.evidence.numeric,
          text: attempt.evidence.text,
          passed: attempt.evidence.passed,
        }
      : null,
    comparison: attempt.comparison ? { ...attempt.comparison } : null,
  };
}

/** 只替换 current，同时深拷贝 history，避免返回状态与入参共享数组/对象。 */
function replaceCurrent(state: ActivityState, attempt: ActivityAttempt): ActivityState {
  return {
    current: attempt,
    history: state.history.map(cloneAttempt),
    nextAttemptId: state.nextAttemptId,
  };
}

function normalizeRunRef(value: unknown): RunRef | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const id = value.id;
  if ((kind !== "live" && kind !== "comparison") || !isPositiveInt(id)) return null;
  return { kind, id };
}

function sameRunRef(a: RunRef, b: RunRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function nextAttemptId(state: ActivityState): number {
  let max = isPositiveInt(state.nextAttemptId) ? state.nextAttemptId : 1;
  const consider = (attempt: ActivityAttempt | null): void => {
    if (attempt && isPositiveInt(attempt.attemptId) && attempt.attemptId >= max) {
      max = attempt.attemptId + 1;
    }
  };
  consider(state.current);
  for (const attempt of state.history) consider(attempt);
  return max;
}

function beginAttempt(
  state: ActivityState,
  activityId: string,
  activityVersion: number,
  lookup: LearningActivityLookup,
): ActivityStateResult {
  const activity = lookup(activityId);
  if (!activity) return fail("invalid-activity", `未知学习活动：${activityId}`);
  if (activity.version !== activityVersion) {
    return fail(
      "invalid-activity",
      `活动版本不匹配：定义 v${activity.version}，请求 v${activityVersion}`,
    );
  }

  const attemptId = nextAttemptId(state);
  const history = state.history.map(cloneAttempt);
  if (state.current) history.push(cloneAttempt(state.current));

  return success({
    current: {
      attemptId,
      activityId,
      activityVersion,
      prediction: null,
      predictionText: "",
      status: "answering",
      runRef: null,
      configDigest: null,
      evidencePlan: null,
      runResults: null,
      reflection: "",
      evidence: null,
      comparison: null,
    },
    history,
    nextAttemptId: attemptId + 1,
  });
}

/** 开始一次新尝试；已有尝试必须处于终态（ready/reviewing/failed/cancelled/idle）。 */
export function startAttempt(
  state: ActivityState,
  activityId: string,
  activityVersion: number,
  lookup: LearningActivityLookup = NO_ACTIVITIES,
): ActivityStateResult {
  if (!isActivityState(state)) return fail("invalid-state", "活动状态无效");
  if (typeof activityId !== "string" || activityId.trim() === "") {
    return fail("invalid-activity", "活动 id 不能为空");
  }
  if (!isPositiveInt(activityVersion)) {
    return fail("invalid-activity", "活动版本必须是正整数");
  }
  if (state.current && !isTerminalStatus(state.current.status)) {
    return fail("wrong-status", "当前尝试尚未结束");
  }
  return beginAttempt(state, activityId, activityVersion, lookup);
}

/** 重新挑战：新建 attempt，旧 attempt 完整进入 history，不覆盖。 */
export function restart(
  state: ActivityState,
  lookup: LearningActivityLookup = NO_ACTIVITIES,
): ActivityStateResult {
  if (!isActivityState(state)) return fail("invalid-state", "活动状态无效");
  const current = state.current;
  if (!current) return fail("invalid-state", "还没有可重新挑战的尝试");
  if (current.status === "answering") {
    return fail("wrong-status", "先提交预测，再重新挑战");
  }
  if (current.status === "running") {
    return fail("wrong-status", "运行中不能重来");
  }
  if (!isTerminalStatus(current.status) && current.status !== "predicted") {
    return fail("wrong-status", `当前状态不能重新挑战：${current.status}`);
  }
  return beginAttempt(state, current.activityId, current.activityVersion, lookup);
}

/** 提交并锁定预测；只允许从 answering 进入，重复提交被拒绝。 */
export function submitPrediction(
  state: ActivityState,
  prediction: PredictionAnswer,
  lookup: LearningActivityLookup = NO_ACTIVITIES,
): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有开始的尝试");
  }
  const current = state.current;
  if (current.prediction !== null) {
    return fail("prediction-locked", "预测已锁定，不能重复提交");
  }
  if (current.status !== "answering") {
    if (
      current.status === "predicted" ||
      current.status === "running" ||
      current.status === "ready" ||
      current.status === "reviewing"
    ) {
      return fail("prediction-locked", "预测已锁定，不能重复提交");
    }
    return fail("wrong-status", `当前状态不能提交预测：${current.status}`);
  }

  const activity = lookup(current.activityId);
  if (!activity || activity.version !== current.activityVersion) {
    return fail("invalid-activity", "活动定义缺失或版本不匹配");
  }
  const judgment = judgePrediction(activity, prediction);
  if (!judgment.validated) {
    return fail("invalid-prediction", "预测格式无效", judgment.errors);
  }

  const locked = clonePrediction(prediction);
  const next = cloneAttempt(current);
  next.prediction = locked;
  next.predictionText = predictionLabel(activity, locked);
  next.status = "predicted";
  next.runRef = null;
  next.evidence = null;
  next.comparison = null;
  return success(replaceCurrent(state, next));
}

function normalizeEvidencePlan(value: unknown): EvidencePlanEntry[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: EvidencePlanEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const runId = raw.runId;
    const digest = raw.configDigest;
    if (typeof runId !== "string" || runId.trim() === "") return null;
    if (typeof digest !== "string" || !/^[0-9a-f]{16}$/.test(digest)) return null;
    if (seen.has(runId)) return null;
    seen.add(runId);
    out.push({ runId, configDigest: digest });
  }
  return out;
}

/** 绑定本次运行；只允许 predicted → running，一次尝试只能绑定一个 runRef。 */
export function bindRun(
  state: ActivityState,
  runRef: RunRef,
  configDigest?: string,
  evidencePlan?: EvidencePlanEntry[],
): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有开始的尝试");
  }
  const current = state.current;
  if (current.status !== "predicted") {
    if (current.status === "running" && current.runRef) {
      return fail("run-already-bound", "本次尝试已绑定运行");
    }
    return fail("wrong-status", `不能绑定运行：${current.status}`);
  }
  if (current.runRef !== null) {
    return fail("run-already-bound", "本次尝试已绑定运行");
  }
  const ref = normalizeRunRef(runRef);
  if (!ref) {
    return fail("invalid-run-ref", "运行引用必须是 {kind, id:正整数}");
  }
  let digest: string | null = null;
  if (configDigest !== undefined) {
    if (typeof configDigest !== "string" || configDigest.trim() === "") {
      return fail("invalid-config-digest", "配置摘要必须是非空字符串");
    }
    digest = configDigest;
  }
  const plan = normalizeEvidencePlan(evidencePlan);
  if (evidencePlan !== undefined && plan === null) {
    return fail("invalid-config-digest", "证据计划必须是非空有序列表");
  }

  const next = cloneAttempt(current);
  next.runRef = ref;
  next.configDigest = digest;
  next.evidencePlan = plan;
  next.runResults = null;
  next.status = "running";
  next.evidence = null;
  next.comparison = null;
  return success(replaceCurrent(state, next));
}

/**
 * 完成本次运行并绑定证据。
 * attemptId 与 runRef(kind + id) 必须同时匹配当前 running 尝试；否则按 stale-run 拒绝。
 */
export function completeRun(
  state: ActivityState,
  evidence: RunEvidence,
  lookup: LearningActivityLookup = NO_ACTIVITIES,
): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有运行的尝试");
  }
  const current = state.current;
  if (current.status !== "running") {
    return fail("wrong-status", "只有运行中才能绑定");
  }
  if (!current.runRef) {
    return fail("invalid-state", "缺少运行引用");
  }
  if (!isRecord(evidence)) {
    return fail("invalid-evidence", "证据必须是对象");
  }

  const attemptId = evidence.attemptId;
  if (!isPositiveInt(attemptId)) {
    return fail("invalid-evidence", "证据缺少 attemptId");
  }
  const bound = normalizeRunRef(evidence.runRef);
  if (!bound) {
    return fail("invalid-evidence", "证据缺少 runRef");
  }
  if (attemptId !== current.attemptId || !sameRunRef(bound, current.runRef)) {
    return fail("stale-run", "结果不属于当前尝试");
  }
  const rawDigest = evidence.configDigest;
  if (
    rawDigest !== undefined &&
    (typeof rawDigest !== "string" || rawDigest.trim() === "")
  ) {
    return fail("invalid-evidence", "证据摘要无效");
  }
  if (current.configDigest !== null && rawDigest !== current.configDigest) {
    return fail("stale-run", "证据摘要与尝试不一致");
  }
  const plan = normalizeEvidencePlan(evidence.evidencePlan);
  if (current.evidencePlan !== null) {
    if (!plan || plan.length !== current.evidencePlan.length ||
      plan.some((entry, index) => entry.runId !== current.evidencePlan![index].runId ||
        entry.configDigest !== current.evidencePlan![index].configDigest)) {
      return fail("stale-run", "证据计划与绑定尝试不一致");
    }
  }
  const runResults = normalizeRunResults(evidence.runResults);
  if (plan !== null && runResults === null) {
    return fail("invalid-evidence", "多侧证据缺少结构化结果");
  }
  if (plan !== null && runResults !== null &&
    (runResults.length !== plan.length || runResults.some((run, index) => run.runId !== plan[index].runId))) {
    return fail("invalid-evidence", "各侧结果与计划不一致");
  }
  if (current.prediction === null) {
    return fail("invalid-state", "缺少锁定的预测");
  }

  const activity = lookup(current.activityId);
  if (!activity || activity.version !== current.activityVersion) {
    return fail("invalid-activity", "活动定义缺失或版本不匹配");
  }

  const rawNumeric = evidence.numeric;
  if (
    rawNumeric !== undefined &&
    rawNumeric !== null &&
    (typeof rawNumeric !== "number" || !Number.isFinite(rawNumeric))
  ) {
    return fail("invalid-evidence", "numeric 必须是有限数");
  }
  const numeric = typeof rawNumeric === "number" ? rawNumeric : null;

  const rawText = evidence.text;
  if (rawText !== undefined && rawText !== null && typeof rawText !== "string") {
    return fail("invalid-evidence", "text 必须是字符串");
  }
  const text = typeof rawText === "string" ? rawText : "";

  const rawPassed = evidence.passed;
  if (rawPassed !== undefined && rawPassed !== null && typeof rawPassed !== "boolean") {
    return fail("invalid-evidence", "passed 必须是布尔");
  }
  const passed = typeof rawPassed === "boolean" ? rawPassed : null;

  if (numeric === null && text.trim() === "" && passed === null) {
    return fail("invalid-evidence", "证据至少需要一项结果");
  }

  const comparison = comparePrediction(activity, current.prediction, {
    numeric,
    text,
    passed: passed ?? undefined,
  });
  const summary: EvidenceSummary = {
    attemptId: current.attemptId,
    runRef: { ...current.runRef },
    configDigest: current.configDigest ?? (typeof rawDigest === "string" ? rawDigest : ""),
    numeric,
    text,
    passed,
  };

  const next = cloneAttempt(current);
  next.status = "ready";
  if (plan !== null) next.evidencePlan = plan;
  next.runResults = runResults;
  next.evidence = summary;
  next.comparison = comparison;
  return success(replaceCurrent(state, next));
}

function normalizeRunResults(value: unknown): EvidenceRunSummary[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: EvidenceRunSummary[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.runId !== "string" || raw.runId.trim() === "") return null;
    if (typeof raw.termination !== "string" || !Array.isArray(raw.metrics)) return null;
    if (!raw.metrics.every((metric) => isRecord(metric) && typeof metric.id === "string")) return null;
    out.push({ runId: raw.runId, termination: raw.termination, metrics: raw.metrics.map((metric) => ({ ...metric })) });
  }
  return out;
}

/** 运行失败：保留原预测，但不产生证据与答案对照。 */
export function failRun(state: ActivityState, runRef: RunRef): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有运行的尝试");
  }
  const current = state.current;
  if (current.status !== "running") {
    return fail("wrong-status", "只有运行中才能失败");
  }
  const ref = normalizeRunRef(runRef);
  if (!ref) {
    return fail("invalid-run-ref", "运行引用必须是 {kind, id:正整数}");
  }
  if (!current.runRef || !sameRunRef(current.runRef, ref)) {
    return fail("stale-run", "运行引用不属于当前尝试");
  }

  const next = cloneAttempt(current);
  next.status = "failed";
  next.evidence = null;
  next.comparison = null;
  return success(replaceCurrent(state, next));
}

/** 取消运行：可传 runRef 做旧结果校验；不传则取消当前 running 尝试。 */
export function cancelRun(state: ActivityState, runRef?: RunRef): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有运行的尝试");
  }
  const current = state.current;
  if (current.status !== "running") {
    return fail("wrong-status", "只有运行中的尝试才能取消");
  }
  if (runRef !== undefined) {
    const ref = normalizeRunRef(runRef);
    if (!ref) {
      return fail("invalid-run-ref", "运行引用必须是 {kind, id:正整数}");
    }
    if (!current.runRef || !sameRunRef(current.runRef, ref)) {
      return fail("stale-run", "运行引用不属于当前尝试");
    }
  }

  const next = cloneAttempt(current);
  next.status = "cancelled";
  next.evidence = null;
  next.comparison = null;
  return success(replaceCurrent(state, next));
}

/** 写反思：ready → reviewing；纯文本原样保存，不转义、不改写。 */
export function addReflection(state: ActivityState, reflection: string): ActivityStateResult {
  if (!isActivityState(state) || !state.current) {
    return fail("invalid-state", "还没有可反思的尝试");
  }
  const current = state.current;
  if (current.status !== "ready" && current.status !== "reviewing") {
    return fail("wrong-status", "只有结果就绪后才能写反思");
  }
  if (typeof reflection !== "string") {
    return fail("invalid-reflection", "反思必须是纯文本字符串");
  }

  const next = cloneAttempt(current);
  next.reflection = reflection;
  next.status = "reviewing";
  return success(replaceCurrent(state, next));
}

/**
 * 是否允许展示答案与解释：只有 ready / reviewing 且证据与对照都已就绪。
 * failed / cancelled / 运行中 / 预测阶段都返回 false。
 */
export function canReveal(state: ActivityState | null | undefined): boolean {
  if (!isActivityState(state) || !state.current) return false;
  const current = state.current;
  if (current.status !== "ready" && current.status !== "reviewing") return false;
  return current.evidence !== null && current.comparison !== null;
}

function safePositiveIntOrZero(value: unknown): number {
  return isPositiveInt(value) ? value : 0;
}

function sanitizePrediction(value: unknown): PredictionAnswer | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "single":
      return typeof value.choiceId === "string"
        ? { kind: "single", choiceId: value.choiceId }
        : null;
    case "multiple":
      return Array.isArray(value.choiceIds)
        ? {
            kind: "multiple",
            choiceIds: value.choiceIds.filter((id): id is string => typeof id === "string"),
          }
        : null;
    case "range":
      return {
        kind: "range",
        min:
          typeof value.min === "number" && Number.isFinite(value.min) ? value.min : null,
        max:
          typeof value.max === "number" && Number.isFinite(value.max) ? value.max : null,
        unit: typeof value.unit === "string" ? value.unit : "",
      };
    default:
      return null;
  }
}

function sanitizeRunRef(value: unknown): RunRef | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const id = value.id;
  if ((kind !== "live" && kind !== "comparison") || !isPositiveInt(id)) return null;
  return { kind, id };
}

function sanitizeEvidence(value: unknown): EvidenceSummary | null {
  if (!isRecord(value)) return null;
  const runRef = sanitizeRunRef(value.runRef);
  if (!runRef) return null;
  return {
    attemptId: safePositiveIntOrZero(value.attemptId),
    runRef,
    configDigest: typeof value.configDigest === "string" ? value.configDigest : "",
    numeric:
      typeof value.numeric === "number" && Number.isFinite(value.numeric)
        ? value.numeric
        : null,
    text: typeof value.text === "string" ? value.text : "",
    passed: typeof value.passed === "boolean" ? value.passed : null,
  };
}

function sanitizeComparison(value: unknown): PredictionComparison | null {
  if (!isRecord(value)) return null;
  const verdict = value.verdict;
  if (verdict !== "consistent" && verdict !== "inconsistent" && verdict !== "undetermined") {
    return null;
  }
  return {
    verdict,
    explanation: typeof value.explanation === "string" ? value.explanation : "",
  };
}

function sanitizeAttempt(value: unknown): ActivityRecordAttempt {
  const attempt = isRecord(value) ? value : {};
  return {
    attemptId: safePositiveIntOrZero(attempt.attemptId),
    activityId: typeof attempt.activityId === "string" ? attempt.activityId : "",
    activityVersion: safePositiveIntOrZero(attempt.activityVersion),
    prediction: sanitizePrediction(attempt.prediction),
    predictionText: typeof attempt.predictionText === "string" ? attempt.predictionText : "",
    status: isAttemptStatus(attempt.status) ? attempt.status : "unknown",
    runRef: sanitizeRunRef(attempt.runRef),
    configDigest: typeof attempt.configDigest === "string" ? attempt.configDigest : "",
    evidencePlan: normalizeEvidencePlan(attempt.evidencePlan),
    runResults: normalizeRunResults(attempt.runResults),
    reflection: typeof attempt.reflection === "string" ? attempt.reflection : "",
    evidence: sanitizeEvidence(attempt.evidence),
    comparison: sanitizeComparison(attempt.comparison),
  };
}

/**
 * 导出本地学习记录：纯 JSON 安全对象，不含设备信息、时间戳或隐式标识。
 * 非有限数值一律转为 null，缺失字段用空串/null/unknown 兜底；调用方仍应只在用户主动导出时使用。
 */
export function exportActivityRecord(state: ActivityState): ActivityRecord {
  const valid = isActivityState(state);
  const current = valid ? state.current : null;
  const attempts = valid
    ? [...state.history, ...(current ? [current] : [])].map(sanitizeAttempt)
    : [];
  const head = current ?? (valid && state.history.length > 0 ? state.history[state.history.length - 1] : null);

  return {
    schema: "learning-activity-record/v1",
    activityId: head && typeof head.activityId === "string" ? head.activityId : "",
    activityVersion: head ? safePositiveIntOrZero(head.activityVersion) : 0,
    currentAttemptId:
      current && isPositiveInt(current.attemptId) ? current.attemptId : null,
    attempts,
  };
}
