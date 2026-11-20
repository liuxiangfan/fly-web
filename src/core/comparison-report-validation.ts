/**
 * 对照报告的结构校验（只读、无副作用）。
 *
 * 为什么从 `comparison-report.ts` 拆出来：报告构造/导出是学生实际会触发的路径，
 * 而完整结构校验只在测试与外部导入时使用。动态 import 的模块命名空间会把所有
 * 导出带进按需 chunk；把校验器放在独立文件后，面板只加载构造与序列化，
 * 不为一组“永远不在浏览器里跑的字段检查”付传输体积。
 */
import { validateExperimentConfig, type ExperimentConfig } from "./experiment-config";
import {
  COMPARISON_REPORT_KIND,
  COMPARISON_REPORT_RESTORE,
  COMPARISON_REPORT_SCHEMA,
  type ComparisonReport,
  type ComparisonReportMetrics,
} from "./comparison-report";
import type { EstimatorRunMetrics } from "./runner";

export type ComparisonReportValidation =
  | { ok: true; report: ComparisonReport }
  | { ok: false; path: string; error: string };

interface Problem {
  path: string;
  message: string;
}

function problem(path: string, message: string): Problem {
  return { path, message };
}

function fail(path: string, message: string): ComparisonReportValidation {
  return { ok: false, path, error: `${path}: ${message}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isReportNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNonNegativeReportNumber(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * 拒绝 JSON 无法无损表示的输入：循环引用、非有限数、函数/BigInt/Symbol、类实例。
 * undefined 对象属性按 JSON.stringify 的语义视为「缺省」跳过；undefined 数组项不跳过，
 * 由数组遍历递归后判为非法。
 */
function jsonProblem(value: unknown, path: string, seen: WeakSet<object>): { path: string; error: string } | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : { path, error: `${path || "$"}: 非有限数值不能出现在报告 JSON 中（先调用 serializeComparisonReport）` };
  }
  if (typeof value === "undefined") {
    return { path, error: `${path || "$"}: undefined 不是 JSON 可表示的值` };
  }
  if (typeof value !== "object") {
    return { path, error: `${path || "$"}: ${typeof value} 不是 JSON 可表示的值` };
  }
  if (seen.has(value)) {
    return { path, error: `${path || "$"}: 存在循环引用，不能导出为 JSON` };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = jsonProblem(value[i], `${path}[${i}]`, seen);
      if (issue) return issue;
    }
    seen.delete(value);
    return null;
  }
  if (!isPlainObject(value)) {
    return { path, error: `${path || "$"}: 只接受普通对象（不能是类实例/Date 等）` };
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child === undefined) continue;
    const issue = jsonProblem(child, path ? `${path}.${key}` : key, seen);
    if (issue) return issue;
  }
  seen.delete(value);
  return null;
}

const ESTIMATOR_IDS: ReadonlyArray<EstimatorRunMetrics["id"]> = ["pure", "comp", "mahony", "madg", "kalman"];

const METRIC_REQUIRED_NUMBERS: ReadonlyArray<keyof ComparisonReportMetrics> = [
  "n", "mean", "rmse", "max", "p50", "p95", "steadyRmse", "tiltRmse", "yawRmse", "gateRejects",
];

const METRIC_OPTIONAL_NUMBERS: ReadonlyArray<keyof ComparisonReportMetrics> = [
  "steadyFromSec", "tiltSo3Rmse", "yawSo3Rmse",
  "neesThetaMean", "neesBiasMean", "nisAccelMean", "nisMagMean", "accelAcceptPct",
];

function metricProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  if (typeof value.id !== "string" || !ESTIMATOR_IDS.includes(value.id as EstimatorRunMetrics["id"])) {
    return problem(`${path}.id`, "须为已知算法 id");
  }
  if (typeof value.label !== "string" || !value.label) return problem(`${path}.label`, "须为非空字符串");
  for (const key of METRIC_REQUIRED_NUMBERS) {
    if (!isReportNumber(value[key])) return problem(`${path}.${String(key)}`, "须为有限数或 null");
  }
  if (typeof value.n === "number" && (!Number.isInteger(value.n) || value.n < 0)) {
    return problem(`${path}.n`, "须为非负整数或 null");
  }
  if (!isReportNumber(value.convergedAt)) return problem(`${path}.convergedAt`, "须为有限数或 null");
  for (const key of METRIC_OPTIONAL_NUMBERS) {
    if (value[key] !== undefined && !isReportNumber(value[key])) {
      return problem(`${path}.${String(key)}`, "须为有限数、null 或缺省");
    }
  }
  if (value.percentileApprox !== undefined && typeof value.percentileApprox !== "boolean") {
    return problem(`${path}.percentileApprox`, "须为布尔值");
  }
  if (value.steadyMode !== undefined && value.steadyMode !== "exact" && value.steadyMode !== "early-stop") {
    return problem(`${path}.steadyMode`, '须为 "exact" 或 "early-stop"');
  }
  return null;
}

function terminationProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  if (value.reason !== "completed" && value.reason !== "cancelled") {
    return problem(`${path}.reason`, '须为 "completed" 或 "cancelled"');
  }
  for (const key of ["requestedEndSec", "endSec", "pendingTailSec"] as const) {
    if (!isNonNegativeReportNumber(value[key])) return problem(`${path}.${key}`, "须为非负有限数或 null");
  }
  if (!isNonNegativeReportNumber(value.lastSolveSec)) {
    return problem(`${path}.lastSolveSec`, "须为非负有限数或 null");
  }
  if (value.cancelledAtSec !== undefined && !isNonNegativeReportNumber(value.cancelledAtSec)) {
    return problem(`${path}.cancelledAtSec`, "须为非负有限数、null 或缺省");
  }
  return null;
}

function configProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  const problems = validateExperimentConfig(value as unknown as ExperimentConfig);
  if (!problems.length) return null;
  return problem(`${path}.${problems[0].path}`, problems[0].message);
}

function sideProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  const cfg = configProblem(value.config, `${path}.config`);
  if (cfg) return cfg;
  if (!Array.isArray(value.metrics)) return problem(`${path}.metrics`, "须为数组");
  if (value.metrics.length === 0) return problem(`${path}.metrics`, "不能为空");
  for (let i = 0; i < value.metrics.length; i++) {
    const metric = metricProblem(value.metrics[i], `${path}.metrics[${i}]`);
    if (metric) return metric;
  }
  const term = terminationProblem(value.termination, `${path}.termination`);
  if (term) return term;
  if (value.seed !== null) {
    if (!isFiniteNumber(value.seed) || !Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
      return problem(`${path}.seed`, "须为 32 位非负整数或 null");
    }
  }
  return null;
}

function variableProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  if (typeof value.id !== "string" || !value.id) return problem(`${path}.id`, "须为非空字符串");
  if (typeof value.label !== "string" || !value.label) return problem(`${path}.label`, "须为非空字符串");
  if (!Array.isArray(value.affectedPaths) || value.affectedPaths.length === 0) {
    return problem(`${path}.affectedPaths`, "须为非空字符串数组");
  }
  for (let i = 0; i < value.affectedPaths.length; i++) {
    const p = value.affectedPaths[i];
    if (typeof p !== "string" || !p) return problem(`${path}.affectedPaths[${i}]`, "须为非空字符串");
  }
  for (const key of ["a", "b"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      return problem(`${path}.${key}`, "必须显式给出");
    }
  }
  return null;
}

function buildProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  if (typeof value.commit !== "string" || !value.commit) return problem(`${path}.commit`, "须为非空字符串");
  if (!isIsoString(value.builtAt)) return problem(`${path}.builtAt`, "须为合法 ISO 时间字符串");
  if (value.buildId !== null && (typeof value.buildId !== "string" || !value.buildId)) {
    return problem(`${path}.buildId`, "须为非空字符串或 null");
  }
  return null;
}

function coverageProblem(value: unknown, path: string): Problem | null {
  if (!isPlainObject(value)) return problem(path, "须为对象");
  if (typeof value.seriesRetained !== "boolean") return problem(`${path}.seriesRetained`, "须为布尔值");
  if (!Array.isArray(value.notes)) return problem(`${path}.notes`, "须为字符串数组");
  for (let i = 0; i < value.notes.length; i++) {
    if (typeof value.notes[i] !== "string") return problem(`${path}.notes[${i}]`, "须为字符串");
  }
  return null;
}

/**
 * 结构校验（不修改输入）。
 *
 * 明确拒绝：错误 schema/kind/restore、缺失构建信息、非法配置、未知算法、
 * 非有限数值与循环引用。导出的报告先经过 `serializeComparisonReport`，
 * 因此 null 只出现在数字位置（配合 coverage.notes 的路径原因），不会被误读成 0。
 */
export function validateComparisonReport(raw: unknown): ComparisonReportValidation {
  if (!isPlainObject(raw)) return fail("$", "报告须为普通对象");
  const json = jsonProblem(raw, "", new WeakSet<object>());
  if (json) return { ok: false, path: json.path || "$", error: json.error };

  if (raw.schema !== COMPARISON_REPORT_SCHEMA) {
    return fail("schema", `对照报告 schema 须为 ${COMPARISON_REPORT_SCHEMA}`);
  }
  if (raw.kind !== COMPARISON_REPORT_KIND) {
    return fail("kind", `对照报告 kind 须为 ${COMPARISON_REPORT_KIND}`);
  }
  if (raw.restore !== COMPARISON_REPORT_RESTORE) {
    return fail("restore", `对照报告 restore 须为 ${COMPARISON_REPORT_RESTORE}（只读结果，不是配置档案）`);
  }
  if (!isIsoString(raw.createdAtIso)) return fail("createdAtIso", "须为合法 ISO 时间字符串");

  const build = buildProblem(raw.build, "build");
  if (build) return fail(build.path, build.message);

  const base = configProblem(raw.baseConfig, "baseConfig");
  if (base) return fail(base.path, base.message);

  const variable = variableProblem(raw.variable, "variable");
  if (variable) return fail(variable.path, variable.message);

  const a = sideProblem(raw.a, "a");
  if (a) return fail(a.path, a.message);

  const b = sideProblem(raw.b, "b");
  if (b) return fail(b.path, b.message);

  const coverage = coverageProblem(raw.coverage, "coverage");
  if (coverage) return fail(coverage.path, coverage.message);

  return { ok: true, report: raw as unknown as ComparisonReport };
}
