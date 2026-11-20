/**
 * F-02 预测—验证式学习：类型、运行时校验与纯判断。
 *
 * 边界：
 * - 活动数据已外移到 `learning-activity-data.ts` / `public/data/activities.json`；
 *   本模块**不** import 数据模块，运行时由学习面板 fetch JSON 后交给 `parseLearningActivities`；
 * - 本模块只有类型与纯函数，不访问 DOM、不持久化、不启动实验；
 * - `judgePrediction` 只检查预测格式，不判断对错；
 * - `comparePrediction` 只回答「这次预测与这次证据的关系」，不推断学习效果；
 * - 解释与证据文本保持纯文本，转义由视图层负责。
 */
import type {
  EstimatorId,
  EstimatorTuning,
  InitialAttitudeSpec,
} from "../core/experiment-config";
import { DEFAULT_ESTIMATOR_TUNING } from "../core/experiment-config";
import type { ImuParams } from "../core/imu";

export type PredictionAnswer =
  | { kind: "single"; choiceId: string }
  | { kind: "multiple"; choiceIds: string[] }
  | { kind: "range"; min: number | null; max: number | null; unit: string };

export type PredictionVerdict = "consistent" | "inconsistent" | "undetermined";

/** 运行证据的最小机器可读形状。text 只用于展示，不参与推断。 */
export interface PredictionEvidence {
  numeric?: number | null;
  text?: string;
  /** 证据适配器按整题口径给出的判定；多选不得把部分命中包装为 true。 */
  passed?: boolean;
}

export interface PredictionComparison {
  verdict: PredictionVerdict;
  explanation: string;
}

export interface PredictionJudgment {
  validated: boolean;
  errors: string[];
}

export interface LearningActivityChoice {
  id: string;
  text: string;
}

export interface LearningActivityEvidence {
  kind: "live" | "comparison";
  experimentId?: string;
  comparisonVariableId?: string;
  estimatorId: EstimatorId;
  metric: string;
  /** 双运行题（如 Ki A/B）里展示/取数的那次运行；默认 "A"。 */
  run?: string;
}

/** 单个估计器的证据补丁：只覆盖 patch 里出现的字段，params 按键合并。 */
export type EstimatorPatch = Partial<Omit<EstimatorTuning, "params">> & {
  params?: Record<string, number>;
};

/**
 * 本题证据运行的完整条件（相对默认配置的 patch）。
 *
 * 为什么不能只依赖实验库默认值或现场滑块：题面写的是 2°/s、10 s、噪声归零，
 * 运行就必须在同一组条件下做；否则用户看到的是另一道题的证据（FIX-01 的根因）。
 * `durationSec` 必填，其余字段只在出现时覆盖。
 */
export interface EvidencePatch {
  durationSec: number;
  scenario?: string;
  imu?: Partial<ImuParams>;
  estimators?: Partial<Record<EstimatorId, EstimatorPatch>>;
  /** 一次性设置五个算法的磁修正开关（对应界面「启用磁力计」）。 */
  magEnabled?: boolean;
  autoCoarseAlign?: boolean;
  initialAttitude?: InitialAttitudeSpec;
}

/** 第二次及后续运行相对 `evidencePatch` 的覆盖（durationSec 可省略）。 */
export type EvidencePatchOverride = Omit<EvidencePatch, "durationSec"> & {
  durationSec?: number;
};

/** 命名运行：基线运行固定叫 "A"，这里声明 A 之外的 B/C… 及相对 A 的覆盖。 */
export interface EvidenceRunSpec {
  id: string;
  patch?: EvidencePatchOverride;
}

/**
 * 选项题的实测判定谓词：每个选项对应一个能从 runner 结果计算的布尔条件。
 *
 * `metric-compare-runs` 是双运行题的扩展：例如 Ki 题要求
 * B.steadyRmse < A.steadyRmse。谓词只读实测指标；指标缺失时判定为「不可用」，
 * 绝不退化成 false。`always-true/false` 只用于纯几何事实与明确错误的选项。
 */
export type EvidencePredicate =
  | { kind: "metric-range"; estimator: EstimatorId; metric: string; min?: number; max?: number; run?: string }
  | {
      kind: "metric-compare";
      estimator: EstimatorId;
      metric: string;
      op: "gt" | "lt" | "eq";
      value: number;
      run?: string;
    }
  | {
      kind: "metric-compare-runs";
      estimator: EstimatorId;
      metric: string;
      op: "gt" | "lt" | "eq";
      run: string;
      otherRun: string;
      /** 可选的绝对差值门槛：要求 |run - otherRun| 至少达到该值。 */
      minDelta?: number;
    }
  | { kind: "always-true" }
  | { kind: "always-false" };

export interface LearningActivity {
  id: string;
  version: number;
  title: string;
  prompt: string;
  conditionsText: string;
  answerKind: PredictionAnswer["kind"];
  choices?: LearningActivityChoice[];
  /**
   * 选项题的正确选项集合（整题口径：多选必须完全一致，不把部分命中当全对）。
   * 只在证据适配器内部使用，预测提交前不展示。
   */
  correctChoiceIds?: string[];
  evidence: LearningActivityEvidence;
  /** 本题证据运行的固定条件；纯几何题可省略（不需要 runner）。 */
  evidencePatch?: EvidencePatch;
  /** A 之外的第二/第三次运行（如 Ki 的 B=Ki0.05）。 */
  evidenceRuns?: readonly EvidenceRunSpec[];
  /** 选项题的实测判定谓词；选项题必须覆盖全部选项。 */
  evidencePredicates?: Record<string, EvidencePredicate>;
  explanation: string;
  doc: { page: string; anchor?: string };
  predictionHint?: string;
  /**
   * 数值题在本题固定条件下的合理证据区间（不是用户答案，预测前不展示）。
   * 实测值落在区间外时，先怀疑运行条件不匹配，返回 undetermined 而不是判用户错。
   */
  expectedRange?: { min: number; max: number; unit: string };
}

export const PREDICTION_CAVEAT =
  "这只说明本次预测与本次证据的关系，不代表已经理解原理；换一个条件仍可能得到不同结果。";

/** 学习面板允许读取的估计器指标（与 EstimatorRunMetrics 的数值字段保持一致）。 */
export const LEARNING_METRIC_KEYS = [
  "n",
  "mean",
  "rmse",
  "max",
  "p50",
  "p95",
  "steadyRmse",
  "tiltRmse",
  "yawRmse",
  "convergedAt",
  "gateRejects",
] as const;

export type LearningMetricKey = (typeof LEARNING_METRIC_KEYS)[number];

const ESTIMATOR_IDS: readonly EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];

export interface ActivityCatalogParseResult {
  activities: LearningActivity[];
  errors: string[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((id) => nonEmptyString(id))) return null;
  return value as string[];
}

const ESTIMATOR_PATCH_BOOLEAN_KEYS = [
  "enabled",
  "magEnabled",
  "accelGate",
  "gateRecovery",
  "rampEnabled",
  "kalmanResetCov",
] as const;
const ESTIMATOR_PATCH_NUMBER_KEYS = ["gateDeg", "gateMagPct", "kalmanChi2"] as const;
const ESTIMATOR_PATCH_KEYS = new Set<string>([
  ...ESTIMATOR_PATCH_BOOLEAN_KEYS,
  ...ESTIMATOR_PATCH_NUMBER_KEYS,
  "magMode",
  "kalmanGate",
  "params",
]);
const PREDICATE_OPS = new Set(["gt", "lt", "eq"]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function triple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(finiteNumber);
}

/** 证据补丁的结构校验；语义真源仍由 data 文件与契约测试保证。 */
function evidencePatchProblems(
  raw: unknown,
  where: string,
  requireDuration: boolean,
): string[] {
  const out: string[] = [];
  if (!isRecord(raw)) return [`${where} 必须是对象`];
  if (requireDuration || raw.durationSec !== undefined) {
    if (!finiteNumber(raw.durationSec) || raw.durationSec <= 0) {
      out.push(`${where}.durationSec 必须是正的有限秒数`);
    }
  }
  if (raw.scenario !== undefined && !nonEmptyString(raw.scenario)) {
    out.push(`${where}.scenario 必须是非空字符串或省略`);
  }
  for (const key of ["magEnabled", "autoCoarseAlign"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      out.push(`${where}.${key} 必须是布尔值或省略`);
    }
  }
  if (raw.imu !== undefined) {
    if (!isRecord(raw.imu)) {
      out.push(`${where}.imu 必须是对象`);
    } else {
      for (const [key, v] of Object.entries(raw.imu)) {
        if (!finiteNumber(v)) out.push(`${where}.imu.${key} 必须是有限数值`);
      }
    }
  }
  if (raw.estimators !== undefined) {
    if (!isRecord(raw.estimators)) {
      out.push(`${where}.estimators 必须是对象`);
    } else {
      for (const [id, patch] of Object.entries(raw.estimators)) {
        if (!ESTIMATOR_IDS.includes(id as EstimatorId)) {
          out.push(`${where}.estimators 含未知算法：${id}`);
          continue;
        }
        if (!isRecord(patch)) {
          out.push(`${where}.estimators.${id} 必须是对象`);
          continue;
        }
        for (const key of Object.keys(patch)) {
          if (!ESTIMATOR_PATCH_KEYS.has(key)) {
            out.push(`${where}.estimators.${id} 含未知字段：${key}`);
          }
        }
        for (const key of ESTIMATOR_PATCH_BOOLEAN_KEYS) {
          if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
            out.push(`${where}.estimators.${id}.${key} 必须是布尔值`);
          }
        }
        for (const key of ESTIMATOR_PATCH_NUMBER_KEYS) {
          if (patch[key] !== undefined && !finiteNumber(patch[key])) {
            out.push(`${where}.estimators.${id}.${key} 必须是有限数值`);
          }
        }
        if (patch.magMode !== undefined && patch.magMode !== "yaw" && patch.magMode !== "full") {
          out.push(`${where}.estimators.${id}.magMode 必须是 yaw / full`);
        }
        if (
          patch.kalmanGate !== undefined &&
          patch.kalmanGate !== "angle" &&
          patch.kalmanGate !== "mahalanobis"
        ) {
          out.push(`${where}.estimators.${id}.kalmanGate 必须是 angle / mahalanobis`);
        }
        if (patch.params !== undefined) {
          if (!isRecord(patch.params)) {
            out.push(`${where}.estimators.${id}.params 必须是对象`);
          } else {
            const knownParams = new Set(Object.keys(DEFAULT_ESTIMATOR_TUNING[id as EstimatorId].params));
            for (const [key, v] of Object.entries(patch.params)) {
              if (!knownParams.has(key)) {
                out.push(`${where}.estimators.${id}.params 含未知参数键：${key}`);
              }
              if (!finiteNumber(v)) {
                out.push(`${where}.estimators.${id}.params.${key} 必须是有限数值`);
              }
            }
          }
        }
      }
    }
  }
  if (raw.initialAttitude !== undefined) {
    const initial = raw.initialAttitude;
    if (!isRecord(initial)) {
      out.push(`${where}.initialAttitude 必须是对象`);
    } else {
      if (
        initial.kind !== "level" &&
        initial.kind !== "fixed-axis" &&
        initial.kind !== "random"
      ) {
        out.push(`${where}.initialAttitude.kind 必须是 level / fixed-axis / random`);
      }
      if (initial.axis !== undefined && !triple(initial.axis)) {
        out.push(`${where}.initialAttitude.axis 必须是三个有限数值`);
      }
      if (
        initial.angleDeg !== undefined &&
        (!finiteNumber(initial.angleDeg) || initial.angleDeg < 0 || initial.angleDeg > 180)
      ) {
        out.push(`${where}.initialAttitude.angleDeg 必须在 0–180 度`);
      }
      if (initial.kind === "fixed-axis" && !triple(initial.axis)) {
        out.push(`${where}.initialAttitude 固定轴模式必须提供 axis`);
      }
    }
  }
  return out;
}

function predicateProblems(
  raw: unknown,
  where: string,
  runIds: ReadonlySet<string>,
): string[] {
  if (!isRecord(raw)) return [`${where} 必须是对象`];
  const kind = raw.kind;
  const out: string[] = [];
  const checkMetric = (): void => {
    if (!ESTIMATOR_IDS.includes(raw.estimator as EstimatorId)) {
      out.push(`${where}.estimator 未知：${String(raw.estimator)}`);
    }
    if (
      !nonEmptyString(raw.metric) ||
      !(LEARNING_METRIC_KEYS as readonly string[]).includes(raw.metric)
    ) {
      out.push(`${where}.metric 未登记：${String(raw.metric)}`);
    }
  };
  const checkRun = (key: "run" | "otherRun"): void => {
    if (raw[key] === undefined) return;
    if (!nonEmptyString(raw[key])) {
      out.push(`${where}.${key} 必须是非空运行标签`);
    } else if (!runIds.has(raw[key] as string)) {
      out.push(`${where}.${key} 引用了不存在的运行：${String(raw[key])}`);
    }
  };
  switch (kind) {
    case "metric-range": {
      checkMetric();
      checkRun("run");
      const min = raw.min;
      const max = raw.max;
      if (min === undefined && max === undefined) {
        out.push(`${where} 至少需要 min 或 max 之一`);
      }
      if (min !== undefined && !finiteNumber(min)) out.push(`${where}.min 必须是有限数值`);
      if (max !== undefined && !finiteNumber(max)) out.push(`${where}.max 必须是有限数值`);
      if (finiteNumber(min) && finiteNumber(max) && min > max) {
        out.push(`${where} 的 min 不能大于 max`);
      }
      break;
    }
    case "metric-compare": {
      checkMetric();
      checkRun("run");
      if (!PREDICATE_OPS.has(raw.op as string)) out.push(`${where}.op 必须是 gt / lt / eq`);
      if (!finiteNumber(raw.value)) out.push(`${where}.value 必须是有限数值`);
      break;
    }
    case "metric-compare-runs": {
      checkMetric();
      if (!nonEmptyString(raw.run) || !runIds.has(raw.run)) {
        out.push(`${where}.run 必须是已存在的运行标签`);
      }
      if (!nonEmptyString(raw.otherRun) || !runIds.has(raw.otherRun)) {
        out.push(`${where}.otherRun 必须是已存在的运行标签`);
      }
      if (nonEmptyString(raw.run) && raw.run === raw.otherRun) {
        out.push(`${where} 的 run 与 otherRun 不能相同`);
      }
      if (!PREDICATE_OPS.has(raw.op as string)) out.push(`${where}.op 必须是 gt / lt / eq`);
      if (raw.minDelta !== undefined && (!finiteNumber(raw.minDelta) || raw.minDelta < 0)) {
        out.push(`${where}.minDelta 必须是非负有限数值`);
      }
      break;
    }
    case "always-true":
    case "always-false":
      break;
    default:
      out.push(`${where}.kind 未知：${String(kind)}`);
  }
  return out;
}

function isMetricPredicate(predicate: EvidencePredicate): boolean {
  return (
    predicate.kind === "metric-range" ||
    predicate.kind === "metric-compare" ||
    predicate.kind === "metric-compare-runs"
  );
}

/**
 * 校验并解析 `public/data/activities.json`。
 *
 * 运行时不信任 fetch 回来的数据：任何字段缺失、重复 id、未知指标或
 * `correctChoiceIds` 指向不存在的选项都会让整份目录拒绝加载（返回空数组 + 错误列表），
 * 而不是带着半份题目继续渲染。
 */
export function parseLearningActivities(raw: unknown): ActivityCatalogParseResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { activities: [], errors: ["activities.json 顶层必须是非空数组"] };
  }

  const errors: string[] = [];
  const activities: LearningActivity[] = [];
  const seenIds = new Set<string>();

  raw.forEach((value, index) => {
    const where = `activities[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${where}: 必须是对象`);
      return;
    }
    const itemErrors: string[] = [];
    const id = value.id;
    if (!nonEmptyString(id)) {
      itemErrors.push("id 必须是非空字符串");
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      itemErrors.push(`id 不是稳定 slug：${id}`);
    } else if (seenIds.has(id)) {
      itemErrors.push(`id 重复：${id}`);
    }
    if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) {
      itemErrors.push("version 必须是正整数");
    }
    for (const key of ["title", "prompt", "conditionsText", "explanation"] as const) {
      if (!nonEmptyString(value[key])) itemErrors.push(`${key} 必须是非空字符串`);
    }
    if (value.predictionHint !== undefined && !nonEmptyString(value.predictionHint)) {
      itemErrors.push("predictionHint 必须是非空字符串或省略");
    }

    const answerKind = value.answerKind;
    if (answerKind !== "single" && answerKind !== "multiple" && answerKind !== "range") {
      itemErrors.push("answerKind 必须是 single / multiple / range");
    }

    const doc = value.doc;
    if (!isRecord(doc) || !nonEmptyString(doc.page)) {
      itemErrors.push("doc.page 必须是非空字符串");
    } else if (doc.anchor !== undefined && !nonEmptyString(doc.anchor)) {
      itemErrors.push("doc.anchor 必须是非空字符串或省略");
    }

    const evidence = value.evidence;
    if (!isRecord(evidence)) {
      itemErrors.push("evidence 必须是对象");
    } else {
      if (evidence.kind !== "live" && evidence.kind !== "comparison") {
        itemErrors.push("evidence.kind 必须是 live / comparison");
      }
      if (!ESTIMATOR_IDS.includes(evidence.estimatorId as EstimatorId)) {
        itemErrors.push(`evidence.estimatorId 未知：${String(evidence.estimatorId)}`);
      }
      if (
        !nonEmptyString(evidence.metric) ||
        !(LEARNING_METRIC_KEYS as readonly string[]).includes(evidence.metric)
      ) {
        itemErrors.push(`evidence.metric 未登记：${String(evidence.metric)}`);
      }
      if (evidence.kind === "live" && !nonEmptyString(evidence.experimentId)) {
        itemErrors.push("live 证据必须提供 experimentId");
      }
      if (evidence.kind === "comparison" && !nonEmptyString(evidence.comparisonVariableId)) {
        itemErrors.push("comparison 证据必须提供 comparisonVariableId");
      }
    }

    const expected = value.expectedRange;
    if (expected !== undefined) {
      if (
        !isRecord(expected) ||
        typeof expected.min !== "number" ||
        !Number.isFinite(expected.min) ||
        typeof expected.max !== "number" ||
        !Number.isFinite(expected.max) ||
        expected.min >= expected.max ||
        !nonEmptyString(expected.unit)
      ) {
        itemErrors.push("expectedRange 必须是 { min < max, unit 非空 }");
      }
    }

    // 证据运行条件：patch 决定题面条件，runs 决定第二/第三次运行。
    const runIds = new Set<string>(["A"]);
    const rawPatch = value.evidencePatch;
    if (rawPatch !== undefined) {
      itemErrors.push(...evidencePatchProblems(rawPatch, "evidencePatch", true));
    }
    const rawRuns = value.evidenceRuns;
    if (rawRuns !== undefined) {
      if (!Array.isArray(rawRuns) || rawRuns.length === 0) {
        itemErrors.push("evidenceRuns 必须是非空数组或省略");
      } else {
        for (let i = 0; i < rawRuns.length; i++) {
          const run = rawRuns[i];
          if (!isRecord(run)) {
            itemErrors.push(`evidenceRuns[${i}] 必须是对象`);
            continue;
          }
          if (!nonEmptyString(run.id)) {
            itemErrors.push(`evidenceRuns[${i}].id 必须是非空字符串`);
          } else if (run.id === "A") {
            itemErrors.push('evidenceRuns 不得重复声明基线运行 "A"');
          } else if (runIds.has(run.id)) {
            itemErrors.push(`evidenceRuns 运行 id 重复：${run.id}`);
          } else {
            runIds.add(run.id);
          }
          if (run.patch !== undefined) {
            itemErrors.push(
              ...evidencePatchProblems(run.patch, `evidenceRuns[${i}].patch`, false),
            );
          }
        }
      }
      if (rawPatch === undefined) {
        itemErrors.push("evidenceRuns 必须以 evidencePatch 作为基线");
      }
    }
    if (isRecord(evidence) && evidence.run !== undefined) {
      if (!nonEmptyString(evidence.run)) {
        itemErrors.push("evidence.run 必须是非空运行标签或省略");
      } else if (!runIds.has(evidence.run)) {
        itemErrors.push(`evidence.run 引用了不存在的运行：${evidence.run}`);
      }
    }

    let choiceIds: Set<string> | null = null;
    if (answerKind === "single" || answerKind === "multiple") {
      const choices = value.choices;
      if (!Array.isArray(choices) || choices.length < 2) {
        itemErrors.push("选项题至少需要 2 个 choices");
      } else {
        const ids = new Set<string>();
        for (const choice of choices) {
          if (!isRecord(choice) || !nonEmptyString(choice.id) || !nonEmptyString(choice.text)) {
            itemErrors.push("每个 choice 都需要非空 id 与 text");
            continue;
          }
          if (ids.has(choice.id)) itemErrors.push(`choice id 重复：${choice.id}`);
          ids.add(choice.id);
        }
        choiceIds = ids;
      }
      const correct = stringArray(value.correctChoiceIds);
      if (!correct) {
        itemErrors.push("选项题必须提供非空且不重复的 correctChoiceIds");
      } else if (choiceIds) {
        if (new Set(correct).size !== correct.length) {
          itemErrors.push("correctChoiceIds 不得重复");
        }
        for (const choiceId of correct) {
          if (!choiceIds.has(choiceId)) {
            itemErrors.push(`correctChoiceIds 引用了不存在的选项：${choiceId}`);
          }
        }
        if (answerKind === "single" && correct.length !== 1) {
          itemErrors.push("单选题 correctChoiceIds 必须恰好一个");
        }
      }
    } else {
      if (!expected) itemErrors.push("数值范围题必须声明 expectedRange");
      if (value.choices !== undefined) itemErrors.push("数值范围题不应带 choices");
      if (value.correctChoiceIds !== undefined) {
        itemErrors.push("数值范围题不应带 correctChoiceIds");
      }
    }

    // 选项题谓词：必须覆盖全部选项；数值题不使用选项谓词。
    const rawPredicates = value.evidencePredicates;
    if (rawPredicates !== undefined) {
      if (answerKind === "range") {
        itemErrors.push("数值范围题不应带 evidencePredicates");
      } else if (!isRecord(rawPredicates) || Object.keys(rawPredicates).length === 0) {
        itemErrors.push("evidencePredicates 必须是非空对象");
      } else if (choiceIds) {
        for (const key of Object.keys(rawPredicates)) {
          if (!choiceIds.has(key)) {
            itemErrors.push(`evidencePredicates 引用了不存在的选项：${key}`);
          }
        }
        for (const choiceId of choiceIds) {
          if (!Object.prototype.hasOwnProperty.call(rawPredicates, choiceId)) {
            itemErrors.push(`选项「${choiceId}」缺少 evidencePredicate`);
          }
        }
        let hasMetric = false;
        for (const [key, predicate] of Object.entries(rawPredicates)) {
          itemErrors.push(...predicateProblems(predicate, `evidencePredicates.${key}`, runIds));
          if (isRecord(predicate) && isMetricPredicate(predicate as unknown as EvidencePredicate)) {
            hasMetric = true;
          }
        }
        if (hasMetric && rawPatch === undefined) {
          itemErrors.push("带数值谓词的选项题必须提供 evidencePatch");
        }
      }
    }

    if (itemErrors.length > 0) {
      errors.push(...itemErrors.map((error) => `${where}: ${error}`));
      return;
    }
    seenIds.add(id as string);
    activities.push(value as unknown as LearningActivity);
  });

  if (errors.length > 0) return { activities: [], errors };
  return { activities, errors: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findChoice(activity: LearningActivity, id: string): LearningActivityChoice | undefined {
  return Array.isArray(activity.choices)
    ? activity.choices.find((choice) => choice && choice.id === id)
    : undefined;
}

function formatNumber(value: number): string {
  return String(value);
}

/**
 * 只校验预测格式与取值范围，不判断与实验结果是否一致。
 * 数值题要求至少一端有限；NaN/Infinity、下限大于上限、空单位都拒绝。
 */
export function judgePrediction(
  activity: LearningActivity,
  answer: PredictionAnswer,
): PredictionJudgment {
  if (!isRecord(activity)) {
    return { validated: false, errors: ["活动定义缺失"] };
  }
  const expectedKind = activity.answerKind;
  if (expectedKind !== "single" && expectedKind !== "multiple" && expectedKind !== "range") {
    return { validated: false, errors: ["活动 answerKind 非法"] };
  }
  if (!isRecord(answer)) {
    return { validated: false, errors: ["预测必须是对象"] };
  }

  const errors: string[] = [];
  if (answer.kind !== expectedKind) {
    errors.push(`预测类型应为 ${expectedKind}，实际为 ${String(answer.kind)}`);
    return { validated: false, errors };
  }

  switch (answer.kind) {
    case "single": {
      if (typeof answer.choiceId !== "string" || answer.choiceId.length === 0) {
        errors.push("单选预测必须提供非空 choiceId");
      } else if (!findChoice(activity, answer.choiceId)) {
        errors.push(`未知选项：${answer.choiceId}`);
      }
      break;
    }
    case "multiple": {
      if (!Array.isArray(answer.choiceIds) || answer.choiceIds.length === 0) {
        errors.push("多选预测至少选择一个选项");
        break;
      }
      if (!Array.isArray(activity.choices) || activity.choices.length === 0) {
        errors.push("活动没有登记选项");
        break;
      }
      const seen = new Set<string>();
      for (const id of answer.choiceIds) {
        if (typeof id !== "string" || id.length === 0) {
          errors.push("多选选项 id 必须是非空字符串");
          continue;
        }
        if (seen.has(id)) errors.push(`多选选项重复：${id}`);
        seen.add(id);
        if (!findChoice(activity, id)) errors.push(`未知选项：${id}`);
      }
      break;
    }
    case "range": {
      const min = (answer as { min?: unknown }).min;
      const max = (answer as { max?: unknown }).max;
      if (min !== null && (typeof min !== "number" || !Number.isFinite(min))) {
        errors.push("范围下限必须是有限数值或 null");
      }
      if (max !== null && (typeof max !== "number" || !Number.isFinite(max))) {
        errors.push("范围上限必须是有限数值或 null");
      }
      if (min === null && max === null) {
        errors.push("范围至少需要一端");
      }
      if (typeof min === "number" && typeof max === "number" && min > max) {
        errors.push("范围下限不能大于上限");
      }
      if (typeof answer.unit !== "string" || answer.unit.trim() === "") {
        errors.push("范围必须带非空单位");
      } else if (
        activity.expectedRange &&
        typeof activity.expectedRange.unit === "string" &&
        activity.expectedRange.unit.trim() !== "" &&
        answer.unit.trim() !== activity.expectedRange.unit.trim()
      ) {
        errors.push(`范围单位应为 ${activity.expectedRange.unit}`);
      }
      break;
    }
  }

  const unique = [...new Set(errors)];
  return { validated: unique.length === 0, errors: unique };
}

/** 把预测转成可显示、可导出的纯文本；格式不合法时给出安全占位。 */
export function predictionLabel(
  activity: LearningActivity,
  answer: PredictionAnswer,
): string {
  if (!isRecord(activity) || !isRecord(answer)) return "未记录预测";
  switch (answer.kind) {
    case "single": {
      const id = typeof answer.choiceId === "string" ? answer.choiceId : "";
      const choice = id ? findChoice(activity, id) : undefined;
      return choice ? choice.text : id || "未选择";
    }
    case "multiple": {
      if (!Array.isArray(answer.choiceIds) || answer.choiceIds.length === 0) {
        return "未选择";
      }
      return answer.choiceIds
        .map((id) => {
          const choice = findChoice(activity, id);
          return choice ? choice.text : String(id);
        })
        .join("；");
    }
    case "range": {
      const min =
        typeof answer.min === "number" && Number.isFinite(answer.min)
          ? formatNumber(answer.min)
          : "…";
      const max =
        typeof answer.max === "number" && Number.isFinite(answer.max)
          ? formatNumber(answer.max)
          : "…";
      const unit = typeof answer.unit === "string" ? answer.unit.trim() : "";
      if (answer.min === null && answer.max === null) return "未填写范围";
      return `${min}–${max}${unit ? ` ${unit}` : ""}`;
    }
    default:
      return "未记录预测";
  }
}

function undetermined(explanation: string): PredictionComparison {
  return { verdict: "undetermined", explanation: `${explanation}${PREDICTION_CAVEAT}` };
}

/**
 * 比较「预测」与「本次运行证据」。
 *
 * - 数值范围题：用 `numeric` 判断实测值是否落在用户给出的区间内；
 *   若活动声明 `expectedRange`，实测值超出该合理区间或单位不一致时返回 undetermined，
 *   先提示检查运行条件，而不是把条件不匹配当成用户预测错误；
 * - 单选/多选：用证据适配器给出的 `passed` 布尔值（整题口径）；
 * - 只有 `text` 或证据缺失时返回 undetermined，不从文字反推对错；
 * - 结论只描述这一次证据关系，并始终附带“不代表已理解原理”的提醒。
 *
 * 范围题的 `numeric` 应与预测的 `unit` 使用同一单位；本模块不换算单位。
 */
export function comparePrediction(
  activity: LearningActivity,
  answer: PredictionAnswer,
  evidence: PredictionEvidence | null | undefined,
): PredictionComparison {
  const judgment = judgePrediction(activity, answer);
  if (!judgment.validated) {
    return undetermined(`预测格式无效：${judgment.errors.join("；")}。`);
  }

  const record = isRecord(evidence) ? evidence : {};
  const rawNumeric = record.numeric;
  if (
    rawNumeric !== undefined &&
    rawNumeric !== null &&
    (typeof rawNumeric !== "number" || !Number.isFinite(rawNumeric))
  ) {
    return undetermined("证据数值必须是有限数值或 null。");
  }
  const numeric = typeof rawNumeric === "number" ? rawNumeric : null;

  const rawText = record.text;
  if (rawText !== undefined && rawText !== null && typeof rawText !== "string") {
    return undetermined("证据文本必须是字符串。");
  }
  const text = typeof rawText === "string" ? rawText.trim() : "";

  const rawPassed = record.passed;
  if (rawPassed !== undefined && rawPassed !== null && typeof rawPassed !== "boolean") {
    return undetermined("证据 passed 必须是布尔值。");
  }
  const passed = typeof rawPassed === "boolean" ? rawPassed : null;

  if (numeric === null && text === "" && passed === null) {
    return undetermined("还没有可用的运行证据，不能判断预测是否符合观察。");
  }

  if (answer.kind === "range" && numeric !== null) {
    const expected = activity.expectedRange;
    if (expected) {
      const validExpected =
        typeof expected.min === "number" &&
        Number.isFinite(expected.min) &&
        typeof expected.max === "number" &&
        Number.isFinite(expected.max) &&
        expected.min <= expected.max &&
        typeof expected.unit === "string" &&
        expected.unit.trim() !== "";
      if (!validExpected) {
        return undetermined("本题的合理证据区间定义无效，无法判断。");
      }
      const answerUnit = answer.unit.trim();
      if (answerUnit !== expected.unit.trim()) {
        return undetermined(
          `预测单位「${answerUnit}」与本题证据单位「${expected.unit}」不一致，无法比较。`,
        );
      }
      if (numeric < expected.min || numeric > expected.max) {
        return undetermined(
          `实测值 ${formatNumber(numeric)} ${expected.unit} 不在本题条件下约 ` +
            `${formatNumber(expected.min)}–${formatNumber(expected.max)} ${expected.unit} 的合理区间内；` +
            "请先检查运行条件（时长、噪声、算法）是否与题面一致。",
        );
      }
    }
  }

  const label = predictionLabel(activity, answer);
  const unit =
    answer.kind === "range" && typeof answer.unit === "string" ? answer.unit.trim() : "";
  const evidenceBits: string[] = [];
  if (numeric !== null) {
    evidenceBits.push(`实测数值 ${formatNumber(numeric)}${unit ? ` ${unit}` : ""}`);
  }
  if (text !== "") evidenceBits.push(`实际观察：${text}`);
  if (passed !== null) {
    evidenceBits.push(`证据适配器判定：${passed ? "支持" : "不支持"}你的预测`);
  }

  let verdict: PredictionVerdict;
  let relation: string;

  if (activity.answerKind === "range" && numeric !== null) {
    const range = answer as Extract<PredictionAnswer, { kind: "range" }>;
    const aboveMin = range.min === null || numeric >= range.min;
    const belowMax = range.max === null || numeric <= range.max;
    const inside = aboveMin && belowMax;
    verdict = inside ? "consistent" : "inconsistent";
    relation = inside ? "实测值落在你给出的范围内。" : "实测值落在你给出的范围之外。";
  } else if (passed !== null) {
    verdict = passed ? "consistent" : "inconsistent";
    relation = passed ? "证据支持你的选择。" : "证据与你的选择相反。";
  } else if (activity.answerKind === "range") {
    return undetermined("只有文字证据、没有可比较的数值，无法判断数值范围。");
  } else {
    return undetermined("只有数值、没有整题判定，无法判断选项与证据的关系。");
  }

  const multipleNote =
    activity.answerKind === "multiple" ? "多选按整题口径判断，不把部分命中当作全对。" : "";
  return {
    verdict,
    explanation:
      `你记录的是「${label}」。${evidenceBits.join("；")}。` +
      `${relation}${multipleNote}${PREDICTION_CAVEAT}`,
  };
}
