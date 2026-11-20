/**
 * 单变量对照报告：纯数据、无 DOM、无 runner 调度。
 *
 * 为什么单独一个模块：对照视图（`ui/comparison-view.ts`）只负责把这里的结果渲染成 HTML／文本，
 * 报告本身必须能被 Node 直接断言——B−A 的符号、未收敛/无样本/非有限值的缺失语义、
 * 导出 JSON 的安全边界都不该埋在 DOM 或 Worker 消息里。
 *
 * 数据边界：
 *  - 报告是只读结果快照（`restore: "results-read-only"`），**不是**实验档案；
 *    导入它不能恢复实时配置、曲线或运行时刻（档案仍是 `config-only`）。
 *  - 报告只保留两侧配置、指标、终止信息与种子；逐点曲线、事件和终态四元数属于交互结果，
 *    不进入默认导出（见方案 B.3「初版导出只包含摘要与配置」）。
 *  - Worker 的 postMessage 可以保留 NaN/Infinity，但导出的 JSON 不能。因此：
 *    `buildComparisonReport` 原样保留指标数值；`serializeComparisonReport` 把非有限值
 *    转成 null 并把路径原因追加到 coverage.notes；`validateComparisonReport` 拒绝
 *    仍含非有限值的原始对象——调用方必须先序列化，再校验/保存。
 */
import {
  SERIES_CAP,
  STATS_CAP,
} from "./run-constants";
import type {
  ErrorSeries,
  EstimatorRunMetrics,
  HeadlessRunResult,
  RunTermination,
} from "./runner";
import {
  cloneExperimentConfig,
  type ExperimentConfig,
} from "./experiment-config";

export const COMPARISON_REPORT_SCHEMA = 1 as const;
export const COMPARISON_REPORT_KIND = "quaternion-attitude-demo/comparison" as const;
export const COMPARISON_REPORT_RESTORE = "results-read-only" as const;

/** 构建信息：与页面自查出口同形（commit / builtAt / buildId）。 */
export interface ComparisonBuildInfo {
  commit: string;
  builtAt: string;
  buildId: string | null;
}

/**
 * 对照变量：只要求结构形状，**不 import** 任何 comparison-config 模块。
 * 这样 `core/comparison-report.ts` 与未来的配置 patch 模块不会形成运行时依赖环。
 */
export interface ComparisonVariable {
  id: string;
  label: string;
  a: unknown;
  b: unknown;
  affectedPaths: readonly string[];
}

/**
 * 一侧的完整运行结果（Worker `done` 消息或主线程降级路径的输入）。
 * 刻意保留 series/events/finalQuats：发送方可以带上它们供交互视图使用，
 * 但 `buildComparisonReport` 只提取报告需要的摘要字段。
 */
export interface ComparisonSide {
  config: HeadlessRunResult["config"];
  metrics: HeadlessRunResult["metrics"];
  series: ErrorSeries[];
  events: HeadlessRunResult["events"];
  finalQuats: HeadlessRunResult["finalQuats"];
  termination: HeadlessRunResult["termination"];
  seed: number;
}

/** 报告中的所有数字位置：序列化后非有限值会变成 null。 */
export type ReportNumber = number | null;

type NullableNumberFields<T> = {
  [K in keyof T]: T[K] extends number
    ? ReportNumber
    : T[K] extends number | undefined
      ? ReportNumber | undefined
      : T[K];
};

export type ComparisonReportMetrics = NullableNumberFields<EstimatorRunMetrics>;
export type ComparisonReportTermination = NullableNumberFields<RunTermination>;

export interface ComparisonReportSide {
  config: ExperimentConfig;
  metrics: ComparisonReportMetrics[];
  termination: ComparisonReportTermination;
  seed: ReportNumber;
}

/** `seriesRetained=false` 表示导出/结果只保留摘要，不保留逐点曲线。 */
export interface ComparisonCoverage {
  seriesRetained: boolean;
  notes: string[];
}

export interface ComparisonReport {
  schema: typeof COMPARISON_REPORT_SCHEMA;
  kind: typeof COMPARISON_REPORT_KIND;
  restore: typeof COMPARISON_REPORT_RESTORE;
  createdAtIso: string;
  build: ComparisonBuildInfo;
  baseConfig: ExperimentConfig;
  variable: ComparisonVariable;
  a: ComparisonReportSide;
  b: ComparisonReportSide;
  coverage: ComparisonCoverage;
}

/** 深拷贝普通 JSON 数据；变量值可能是数组/对象，不能与调用方共享引用。 */
function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const src = value as Record<string, unknown>;
    for (const key of Object.keys(src)) out[key] = cloneData(src[key]);
    return out as T;
  }
  return value;
}

function reportSide(side: ComparisonSide): ComparisonReportSide {
  return {
    config: cloneExperimentConfig(side.config),
    metrics: side.metrics.map((m) => ({ ...m })),
    termination: { ...side.termination },
    // seed 缺失/非法时保留 NaN 交给序列化留下原因；undefined 归一为 null。
    seed: typeof side.seed === "number" ? side.seed : null,
  };
}

/**
 * 构造只读对照报告。
 * 输入侧不会被修改；配置与指标会复制，报告不与运行对象共享引用。
 */
export function buildComparisonReport(
  baseConfig: ExperimentConfig,
  variable: ComparisonVariable,
  a: ComparisonSide,
  b: ComparisonSide,
  buildInfo: ComparisonBuildInfo,
  coverage?: Partial<ComparisonCoverage>,
): ComparisonReport {
  return {
    schema: COMPARISON_REPORT_SCHEMA,
    kind: COMPARISON_REPORT_KIND,
    restore: COMPARISON_REPORT_RESTORE,
    createdAtIso: new Date().toISOString(),
    build: {
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
      buildId: buildInfo.buildId,
    },
    baseConfig: cloneExperimentConfig(baseConfig),
    variable: {
      id: variable.id,
      label: variable.label,
      a: cloneData(variable.a),
      b: cloneData(variable.b),
      affectedPaths: [...variable.affectedPaths],
    },
    a: reportSide(a),
    b: reportSide(b),
    coverage: {
      seriesRetained: coverage?.seriesRetained ?? (a.series.length > 0 && b.series.length > 0),
      notes: coverage?.notes ? [...coverage.notes] : [],
    },
  };
}

function sideNames(report: ComparisonReport, include: (side: ComparisonReportSide) => boolean): string {
  const names: string[] = [];
  if (include(report.a)) names.push("A");
  if (include(report.b)) names.push("B");
  return names.join("、");
}

/**
 * 报告口径说明：曲线截断、分位数近似、稳态 early-stop、未完成的运行侧。
 * 同时保留调用方/序列化写入的 coverage.notes（例如非有限值转 null 的路径原因）。
 */
export function comparisonCoverageNotes(report: ComparisonReport): string[] {
  const notes: string[] = [];
  const push = (note: string): void => {
    if (note && !notes.includes(note)) notes.push(note);
  };

  const truncated = sideNames(report, (side) =>
    side.metrics.some((m) => typeof m.n === "number" && m.n > SERIES_CAP),
  );
  if (truncated) {
    push(`${truncated} 侧的误差序列超过 ${SERIES_CAP} 点上限，逐点曲线已截断；摘要指标仍按全部样本累计。`);
  }

  const approx = sideNames(report, (side) => side.metrics.some((m) => m.percentileApprox === true));
  if (approx) {
    push(`${approx} 侧的 P50/P95 使用定长蓄水池近似（样本超过 ${STATS_CAP}），不是全样本精确分位数。`);
  }

  const early = sideNames(report, (side) => side.metrics.some((m) => m.steadyMode === "early-stop"));
  if (early) {
    push(`${early} 侧的稳态窗口为 early-stop：实际运行短于预定窗口，末段 RMSE 不是完整窗口的精确值。`);
  }

  if (!report.coverage.seriesRetained) {
    push("本报告未保留逐点误差曲线，只包含摘要、配置与终止信息。");
  }
  for (const note of report.coverage.notes) push(note);

  for (const [name, side] of [["A", report.a], ["B", report.b]] as const) {
    if (side.termination.reason === "completed") continue;
    const end = typeof side.termination.endSec === "number" && Number.isFinite(side.termination.endSec)
      ? `${side.termination.endSec} s`
      : "未知时刻";
    const requested = typeof side.termination.requestedEndSec === "number" && Number.isFinite(side.termination.requestedEndSec)
      ? `${side.termination.requestedEndSec} s`
      : "未知时长";
    const why = side.termination.reason === "cancelled" ? "已取消" : side.termination.reason;
    push(`${name} 侧未完成（${why}，结束于 ${end}，请求 ${requested}）；整个对照不能标为完成，也不应生成最终结论。`);
  }

  return notes;
}

export type ComparisonStatusState =
  | "empty"
  | "configured"
  | "running-a"
  | "running-b"
  | "done"
  | "cancelled"
  | "error"
  | "stale";

export interface ComparisonStatusDetail {
  /** 已完整完成的侧数（0/1/2）。state="done" 时用它二次确认两侧都完成。 */
  completedSides?: number;
  /** 出错/正在运行的一侧。 */
  side?: "a" | "b" | null;
  /** 错误摘要（纯文本，由调用方负责作为文本渲染）。 */
  message?: string;
}

/**
 * 对照台中文状态文案。
 *
 * `empty|configured|running-a|running-b|done|cancelled|error|stale` 与方案 C.2 一一对应。
 * state="done" 的语义是「两侧都完整完成」；若调用方提供 completedSides 且不足 2，
 * 本函数拒绝输出完成文案——避免把 A 完成、B 取消误标成最终结果。
 */
export function comparisonStatusText(state: ComparisonStatusState, detail: ComparisonStatusDetail = {}): string {
  switch (state) {
    case "empty":
      return "未创建对照：先冻结同一配置与种子，只改变一个变量后再运行。";
    case "configured":
      return "已配置：A 为基线、B 为变量值；确认完整配置差异后可点击运行对照。";
    case "running-a":
      return "正在运行 A 侧（基线）… B 尚未开始；可随时取消。";
    case "running-b":
      return "A 侧已完成；正在运行 B 侧（变量值）；两侧都完成前不显示最终差值，可随时取消。";
    case "done": {
      const complete = detail.completedSides === undefined || detail.completedSides >= 2;
      if (complete) {
        return "完成：A、B 两侧均已完整运行，可查看指标、曲线、事件并导出报告。";
      }
      return `未完成：目前只有 ${detail.completedSides} 侧完成；两侧都完成后才显示最终对照。`;
    }
    case "cancelled": {
      if (detail.completedSides === undefined) {
        return "已取消：对照未完成，不生成最终结论；可重新运行。";
      }
      return `已取消：已完成 ${detail.completedSides} 侧，对照不标为完成，也不生成最终结论；可重新运行。`;
    }
    case "error": {
      const where = detail.side ? `${detail.side.toUpperCase()} 侧` : "对照";
      const reason = detail.message ? `（${detail.message}）` : "";
      return `运行出错：${where}${reason}。当前实时装置不受影响；可重试。`;
    }
    case "stale":
      return "结果已过期：当前配置或任务已被替代；旧结果仍可查看，但不能当作当前对照。";
    default:
      return "对照状态未知。";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pushUnique(notes: string[], note: string): void {
  if (!notes.includes(note)) notes.push(note);
}

/** 递归复制并消毒：非有限数 → null，并记录路径原因；同时保证不共享引用。 */
function sanitizeForJson(value: unknown, path: string, notes: string[], seen: WeakSet<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      if (Number.isFinite(value)) return value;
      pushUnique(notes, `${path || "report"} 为非有限数值，已导出为 null`);
      return null;
    case "string":
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "bigint":
    case "symbol":
    case "function":
      pushUnique(notes, `${path || "report"} 不是 JSON 可表示的值，已导出为 null`);
      return null;
    case "object":
      break;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      pushUnique(notes, `${path || "report"} 存在循环引用，已导出为 null`);
      return null;
    }
    seen.add(value);
    const out = value.map((item, i) => {
      const sanitized = sanitizeForJson(item, `${path}[${i}]`, notes, seen);
      return sanitized === undefined ? null : sanitized;
    });
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      pushUnique(notes, `${path || "report"} 存在循环引用，已导出为 null`);
      return null;
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child === undefined) continue;
      out[key] = sanitizeForJson(child, path ? `${path}.${key}` : key, notes, seen);
    }
    seen.delete(value);
    return out;
  }
  pushUnique(notes, `${path || "report"} 不是普通 JSON 对象，已导出为 null`);
  return null;
}

/**
 * 导出用复制：JSON 安全、无活动引用。
 * 非有限数变为 null，并把具体路径追加进 coverage.notes（原因不会随 NaN 一起丢失）。
 */
export function serializeComparisonReport(report: ComparisonReport): ComparisonReport {
  const reasons: string[] = [];
  const serialized = sanitizeForJson(report, "", reasons, new WeakSet<object>());
  if (isPlainObject(serialized) && isPlainObject(serialized.coverage) && Array.isArray(serialized.coverage.notes)) {
    const existing = serialized.coverage.notes.filter((n): n is string => typeof n === "string");
    for (const reason of reasons) {
      if (!existing.includes(reason)) existing.push(reason);
    }
    serialized.coverage.notes = existing;
  }
  return serialized as unknown as ComparisonReport;
}
