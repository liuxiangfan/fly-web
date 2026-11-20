/**
 * 对照指标行（纯数据）。
 *
 * 从 `comparison-report.ts` 拆出的动机：UI 只需要“指标行 + B−A”的展示模型，
 * 不应为此静态导入报告模块——报告为了 coverage 说明会导入 runner 常量，
 * 结果会把整个数值内核拖进教学 UI chunk。这里只依赖**类型**，运行时零依赖。
 */
import type { EstimatorRunMetrics } from "./runner";
import type { ComparisonReport, ComparisonReportMetrics } from "./comparison-report";

export type ComparisonMetricKey =
  | "rmse"
  | "steadyRmse"
  | "max"
  | "convergedAt"
  | "n"
  | "tiltSo3Rmse"
  | "yawSo3Rmse"
  | "accelAcceptPct";

/** 差值不可比较的原因；绝不以 0 代替。 */
export type ComparisonMissingReason =
  | "no-sample"
  | "non-finite"
  | "unconverged"
  | "unavailable"
  | "no-truth";

export interface ComparisonMetricRow {
  key: ComparisonMetricKey;
  label: string;
  unit: string;
  a: number | null;
  b: number | null;
  /** 统一口径：B − A；任一侧不可用时为 null。 */
  delta: number | null;
  /** delta 为 null 时的原因；可比较时为 null。 */
  reason: ComparisonMissingReason | null;
}

const METRIC_DEFS: ReadonlyArray<{ key: ComparisonMetricKey; label: string; unit: string }> = [
  { key: "rmse", label: "全程 RMSE", unit: "°" },
  { key: "steadyRmse", label: "稳态 RMSE", unit: "°" },
  { key: "max", label: "最大误差", unit: "°" },
  { key: "convergedAt", label: "收敛时间", unit: "s" },
  { key: "n", label: "样本数", unit: "个" },
  { key: "tiltSo3Rmse", label: "SO(3) 倾角 RMS", unit: "°" },
  { key: "yawSo3Rmse", label: "SO(3) 偏航 RMS", unit: "°" },
  { key: "accelAcceptPct", label: "重力接受率", unit: "%" },
];

/** 由模拟真值分解出来的指标：字段缺省表示本次运行没有可用真值，而不是 0。 */
function truthDerived(key: ComparisonMetricKey): boolean {
  return key === "tiltSo3Rmse" || key === "yawSo3Rmse";
}

function hasNonFinite(metric: ComparisonReportMetrics | null, key: ComparisonMetricKey): boolean {
  if (!metric) return false;
  const raw = metric[key] as number | null | undefined;
  return typeof raw === "number" && !Number.isFinite(raw);
}

function missingField(metric: ComparisonReportMetrics | null, key: ComparisonMetricKey): boolean {
  if (!metric) return true;
  const raw = metric[key] as number | null | undefined;
  return raw === undefined || raw === null;
}

function metricNumber(metric: ComparisonReportMetrics | null, key: ComparisonMetricKey): number | null {
  if (!metric) return null;
  const raw = metric[key] as number | null | undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function noSample(metric: ComparisonReportMetrics | null): boolean {
  if (!metric) return true;
  return typeof metric.n !== "number" || !Number.isFinite(metric.n) || metric.n <= 0;
}

function rowReason(
  key: ComparisonMetricKey,
  aMetric: ComparisonReportMetrics | null,
  bMetric: ComparisonReportMetrics | null,
  aValue: number | null,
  bValue: number | null,
): ComparisonMissingReason | null {
  if (!aMetric || !bMetric) return "unavailable";
  if (noSample(aMetric) || noSample(bMetric)) return "no-sample";
  if (key === "convergedAt") {
    return aValue === null || bValue === null ? "unconverged" : null;
  }
  if (truthDerived(key)) {
    // 真值分解指标缺字段 = 本次运行没有可用真值；不能补 0 冒充「完全对准」。
    if (missingField(aMetric, key) || missingField(bMetric, key)) return "no-truth";
    return hasNonFinite(aMetric, key) || hasNonFinite(bMetric, key) ? "non-finite" : null;
  }
  if (key === "accelAcceptPct") {
    // 只有卡尔曼路径会记录接受率；固定增益算法缺字段时不伪造 0%。
    if (missingField(aMetric, key) || missingField(bMetric, key)) return "unavailable";
    return hasNonFinite(aMetric, key) || hasNonFinite(bMetric, key) ? "non-finite" : null;
  }
  return aValue === null || bValue === null ? "non-finite" : null;
}

/**
 * 指定算法的对照指标：原有五条（总 RMSE、稳态 RMSE、最大误差、收敛时间、样本数）
 * 加三条统计边界指标（SO(3) 倾角/偏航 RMS、重力接受率）。
 * 缺失真值或算法不适用时返回 null + 原因，绝不补 0。
 */
export function comparisonMetricsRows(report: ComparisonReport, estimatorId: EstimatorRunMetrics["id"]): ComparisonMetricRow[] {
  const aMetric = report.a.metrics.find((m) => m.id === estimatorId) ?? null;
  const bMetric = report.b.metrics.find((m) => m.id === estimatorId) ?? null;
  // 重力接受率只对卡尔曼路径有意义；其它算法即使上报了 0 也不当作"0% 接受"。
  const accelApplicable = estimatorId === "kalman";
  return METRIC_DEFS.map(({ key, label, unit }) => {
    if (key === "accelAcceptPct" && !accelApplicable) {
      return { key, label, unit, a: null, b: null, delta: null, reason: "unavailable" as const };
    }
    const aValue = metricNumber(aMetric, key);
    const bValue = metricNumber(bMetric, key);
    let reason = rowReason(key, aMetric, bMetric, aValue, bValue);
    let delta: number | null = null;
    if (reason === null && aValue !== null && bValue !== null) {
      const diff = bValue - aValue;
      if (Number.isFinite(diff)) delta = diff;
      else reason = "non-finite";
    }
    return { key, label, unit, a: aValue, b: bValue, delta, reason: delta === null ? reason : null };
  });
}
