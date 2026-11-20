/**
 * 单变量对照视图的纯渲染片段：只返回 HTML 字符串，不读取 DOM、不持有状态。
 *
 * 边界：
 *  - 表格行包含单位、A/B/Δ 与缺失原因（无样本/未收敛/无真值/不可用），调用方负责表头与外层容器；
 *  - 所有来自报告或配置的变量标签、字段路径、选项值都先转义；标记结构只用本文件内的固定模板；
 *  - 不提供状态 HTML：状态文案由 `core/comparison-report.ts` 的 `comparisonStatusText` 给出，
 *    调用方用 `textContent` 渲染，避免把错误消息当标记拼接。
 *
 * 复用 `ui/doc-search.ts` 的 `escapeHtml`：转义规则只保留一份（转义是契约，不是装饰）。
 */
import { comparisonMetricsRows, type ComparisonMetricRow } from "../core/comparison-metrics";
import type { ComparisonReport } from "../core/comparison-report";
import type { EstimatorRunMetrics } from "../core/runner";
import { escapeHtml } from "../core/html-escape";

const fmt = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "不可用");

function reasonText(reason: ComparisonMetricRow["reason"]): string {
  switch (reason) {
    case "no-sample":
      return "无样本";
    case "unconverged":
      return "未收敛";
    case "non-finite":
      return "不可用";
    case "unavailable":
      return "不可用";
    case "no-truth":
      return "不可用（无真值）";
    case null:
      return "";
  }
}

function valueText(value: number | null, row: ComparisonMetricRow): string {
  if (value !== null && Number.isFinite(value)) return fmt(value);
  return reasonText(row.reason) || "—";
}

function deltaText(row: ComparisonMetricRow): string {
  if (row.delta !== null && Number.isFinite(row.delta)) {
    return row.delta > 0 ? `+${fmt(row.delta)}` : fmt(row.delta);
  }
  return reasonText(row.reason) || "不可比较";
}

/**
 * 指标表行：`<th scope="row">标签</th><td>单位</td><td>A</td><td>B</td><td>Δ=B−A</td><td>缺失原因</td>`。
 * 调用方给出表头与 `<tbody>`；本函数只输出 `<tr>` 序列。
 */
export function comparisonRowsHtml(report: ComparisonReport, estimatorId: EstimatorRunMetrics["id"]): string {
  const estimator = escapeHtml(estimatorId);
  return comparisonMetricsRows(report, estimatorId)
    .map((row) => {
      const reason = row.reason ? escapeHtml(reasonText(row.reason)) : "";
      return (
        `<tr class="cmp-row" data-estimator="${estimator}" data-metric="${escapeHtml(row.key)}">` +
        `<th scope="row">${escapeHtml(row.label)}</th>` +
        `<td class="cmp-unit">${escapeHtml(row.unit)}</td>` +
        `<td class="cmp-a">${escapeHtml(valueText(row.a, row))}</td>` +
        `<td class="cmp-b">${escapeHtml(valueText(row.b, row))}</td>` +
        `<td class="cmp-delta">${escapeHtml(deltaText(row))}</td>` +
        `<td class="cmp-note">${reason || "—"}</td></tr>`
      );
    })
    .join("");
}

/** 与 `comparisonRowsHtml` 六列一一对应的表头（静态标记，不含任何外部文本）。 */
export function comparisonTableHeadHtml(): string {
  return (
    `<thead><tr><th scope="col">指标</th><th scope="col">单位</th>` +
    `<th scope="col">A（基线）</th><th scope="col">B（变量）</th>` +
    `<th scope="col">Δ = B − A</th><th scope="col">说明</th></tr></thead>`
  );
}

/**
 * 覆盖与口径说明：把 `comparisonCoverageNotes(report)` 的结果渲染成折叠区。
 * 说明文本全部转义；没有备注时返回空串，调用方据此隐藏容器。
 */
export function comparisonCoverageNotesHtml(notes: readonly string[]): string {
  const items = notes
    .filter((note) => typeof note === "string" && note.length > 0)
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");
  if (!items) return "";
  return (
    `<details class="cmp-alt cmp-coverage"><summary>覆盖与口径说明</summary>` +
    `<ul>${items}</ul></details>`
  );
}

export interface ComparisonVariableOption {
  id: string;
  label: string;
}

/** 变量下拉选项；`selectedId` 精确匹配时才输出 selected，且只输出一个。 */
export function comparisonVariableOptionsHtml(
  variables: readonly ComparisonVariableOption[],
  selectedId?: string | null,
): string {
  return variables
    .map((variable) => {
      const selected = selectedId != null && variable.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(variable.id)}"${selected}>${escapeHtml(variable.label)}</option>`;
    })
    .join("");
}

export interface ComparisonDiffEntry {
  path: string;
  a?: unknown;
  b?: unknown;
}

export type ComparisonDiffPath = string | ComparisonDiffEntry;

function displayValue(value: unknown): string {
  if (value === undefined) return "（缺失）";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * 配置差异提示：`paths` 是**除声明变量之外**仍有差异的字段路径。
 * 有额外差异时明确写出「禁止开始」，不把单变量对照悄悄变成多变量实验。
 */
export function comparisonDiffHtml(paths: readonly ComparisonDiffPath[], variableLabel: string): string {
  const label = escapeHtml(variableLabel);
  const entries: ComparisonDiffEntry[] = paths.map((entry) => (typeof entry === "string" ? { path: entry } : entry));
  if (entries.length === 0) {
    return `<p class="cmp-diff cmp-diff-ok">配置差异仅包含变量「${label}」。</p>`;
  }
  const items = entries
    .map((entry) => {
      const values = "a" in entry || "b" in entry
        ? `<span class="cmp-diff-values">${escapeHtml(displayValue(entry.a))} → ${escapeHtml(displayValue(entry.b))}</span>`
        : "";
      return `<li><code>${escapeHtml(entry.path)}</code>${values}</li>`;
    })
    .join("");
  return (
    `<div class="cmp-diff cmp-diff-warn"><p>除变量「${label}」外仍有 ${entries.length} 处配置差异，禁止开始：</p>` +
    `<ul>${items}</ul></div>`
  );
}

/**
 * 等价文本／aria 描述：固定条件、唯一变量与差值口径。
 * 返回纯文本（不转义），调用方应放进 `textContent` 或可访问性描述属性。
 */
export function comparisonLegendText(report: ComparisonReport): string {
  const base = report.baseConfig;
  const variable = report.variable;
  return (
    `固定条件：场景 ${base.scenario}，种子 ${base.seed}，时长 ${base.durationSec} s，解算频率 ${base.solveRateHz} Hz；` +
    `唯一变量「${variable.label}」：A=${displayValue(variable.a)}，B=${displayValue(variable.b)}；` +
    `指标差值 Δ = B − A；RMSE 与最大误差单位为 °，收敛时间单位为 s，样本数单位为个；` +
    `SO(3) 分轴 RMS 单位为 °，重力接受率单位为 %。`
  );
}
