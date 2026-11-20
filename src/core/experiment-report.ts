/**
 * 只读实验报告：格式、构造与校验（纯逻辑，无 DOM / Three / UI，Worker 可安全引用）。
 *
 * 与配置档案（`experiment-archive.ts`，`restore: "config-only"`）的区别：
 * 报告是**只读查看**格式（`restore: "read-only"`）——导入它绝不应用配置、绝不重跑，
 * 只把「本轮长什么样、跑出了什么」原样展示。
 *
 * 数据边界：
 *  - `archive` 直接内嵌一份完整配置档案：报告的配置与统计口径完全等于档案。
 *  - `events: null` 与 `events: []` 语义不同：null = 本轮未开启诊断事件采集；
 *    [] = 已采集但窗口内没有事件。两者禁止混用。
 *  - `comparison: null` = 本轮未创建对照结果。
 *  - `build: null` = 无构建信息（导入查看须能显示「无构建信息」）。
 *  - 报告所有数值必须有限：`buildExperimentReport` 拒绝 NaN/Infinity，
 *    `validateExperimentReport` 拒绝任何非有限数值（与对照报告校验同一立场）。
 */
import {
  parseArchive,
  type ExperimentArchive,
} from "./experiment-archive";
import type { ComparisonReport } from "./comparison-report";
import type { LearningEvent } from "./event-timeline";

export const REPORT_SCHEMA = 1;
export const REPORT_KIND = "quaternion-attitude-demo/experiment-report";
export const REPORT_RESTORE = "read-only";

/** 构建信息：null = 无构建信息。 */
export interface ReportBuildInfo {
  buildId: string;
  sourceDigest: string;
}

/** 构建时生成的固定中文口径说明。 */
export const REPORT_NOTES: readonly string[] = [
  "报告中的配置为生成时快照，不代表当前页面配置；导入本报告不会应用任何配置。",
  "档案中的指标为本轮滚动统计，不是完整历史；窗口淘汰前的样本不计入。",
  "events 为 null 表示本轮未开启诊断事件采集；为 [] 表示已采集但窗口内没有事件，两者不是同一回事。",
  "本报告只读：只用于查看与对照，不包含设备标识，也不能用来恢复运行现场。",
  "comparison 为 null 表示本轮未创建单变量对照结果。",
];

export interface ExperimentReport {
  schema: typeof REPORT_SCHEMA;
  kind: typeof REPORT_KIND;
  restore: typeof REPORT_RESTORE;
  createdAtIso: string;
  build: ReportBuildInfo | null;
  archive: ExperimentArchive;
  events: LearningEvent[] | null;
  comparison: ComparisonReport | null;
  notes: string[];
}

/** 深拷贝普通 JSON 数据；带路径与防循环：非有限数 / 循环引用直接抛中文错误。 */
function cloneFinite(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`实验报告${path ? ` ${path}` : ""} 含非有限数值（NaN/Infinity）`);
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`实验报告${path ? ` ${path}` : ""} 含不可序列化类型：${typeof value}`);
  }
  if (seen.has(value)) throw new Error(`实验报告 ${path || "$"} 存在循环引用`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, i) => cloneFinite(item, `${path}[${i}]`, seen));
    }
    const out: Record<string, unknown> = {};
    const src = value as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      out[key] = cloneFinite(src[key], path ? `${path}.${key}` : key, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** 事件数组没有导出的原始校验器，这里做最小结构校验（不发明新事件格式）。 */
function eventProblem(event: unknown, index: number): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return `events[${index}] 须为对象`;
  }
  const e = event as Partial<LearningEvent>;
  if (typeof e.t !== "number" || !Number.isFinite(e.t)) return `events[${index}].t 须为有限数`;
  if (typeof e.kind !== "string") return `events[${index}].kind 须为字符串`;
  if (typeof e.summary !== "string") return `events[${index}].summary 须为字符串`;
  return null;
}

function eventsProblem(events: unknown): string | null {
  if (events === null) return null;
  if (!Array.isArray(events)) return "events 须为数组或 null";
  for (let i = 0; i < events.length; i++) {
    const problem = eventProblem(events[i], i);
    if (problem) return problem;
  }
  return null;
}

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * 内嵌对照只做浅结构校验：报告把对照 JSON **只读展示**，不据此恢复配置或重算指标，
 * 指标级深校验属于对照功能自身。这里若调用 validateComparisonReport，会把整套对照
 * 校验器拖进运行时包（实测：它在 src 里没有其它使用方，纯为只读查看新增约 4 KB
 * 主代码）；常量写字面量而非 import comparison-report 也是同理——不反向依赖教学 chunk。
 */
function comparisonProblem(raw: unknown): string | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "comparison 须为对象或 null";
  const c = raw as Partial<ComparisonReport>;
  if (c.schema !== 1) return "comparison.schema 须为 1";
  if (c.kind !== "quaternion-attitude-demo/comparison") return "comparison.kind 不识别";
  if (c.restore !== "results-read-only") return 'comparison.restore 须为 "results-read-only"';
  return null;
}

export interface ExperimentReportInput {
  createdAtIso: string;
  build: ReportBuildInfo | null;
  archive: ExperimentArchive;
  events: LearningEvent[] | null;
  comparison: ComparisonReport | null;
}

/**
 * 构造只读实验报告。
 *
 * 输入先过档案（`parseArchive`）的既有校验；内嵌对照只做浅结构校验（只读展示，
 * 不重算指标，见 `comparisonProblem`）。随后递归检查全部数值有限（非有限直接抛
 * 中文错误并指出路径），最后深拷贝——调用方后续修改输入对象不会影响已生成的报告。
 */
export function buildExperimentReport(input: ExperimentReportInput): ExperimentReport {
  if (!isIsoString(input.createdAtIso)) {
    throw new Error("实验报告 createdAtIso 须为合法 ISO 时间字符串");
  }
  if (input.build !== null) {
    if (!input.build || typeof input.build !== "object" || Array.isArray(input.build)) {
      throw new Error("实验报告 build 须为对象或 null");
    }
    if (typeof input.build.buildId !== "string" || !input.build.buildId) {
      throw new Error("实验报告 build.buildId 须为非空字符串");
    }
    if (typeof input.build.sourceDigest !== "string" || !input.build.sourceDigest) {
      throw new Error("实验报告 build.sourceDigest 须为非空字符串");
    }
  }
  const archiveParse = parseArchive(input.archive);
  if (!archiveParse.ok) throw new Error(`实验报告内嵌档案不合法：${archiveParse.error}`);
  const comparisonIssue = comparisonProblem(input.comparison);
  if (comparisonIssue) throw new Error(`实验报告内嵌对照不合法：${comparisonIssue}`);
  const eventsProblemMessage = eventsProblem(input.events);
  if (eventsProblemMessage) throw new Error(`实验报告 ${eventsProblemMessage}`);

  return {
    schema: REPORT_SCHEMA,
    kind: REPORT_KIND,
    restore: REPORT_RESTORE,
    createdAtIso: input.createdAtIso,
    build: input.build === null
      ? null
      : { buildId: input.build.buildId, sourceDigest: input.build.sourceDigest },
    archive: cloneFinite(input.archive, "archive", new WeakSet<object>()) as ExperimentArchive,
    events: input.events === null ? null : (cloneFinite(input.events, "events", new WeakSet<object>()) as LearningEvent[]),
    comparison: input.comparison === null
      ? null
      : (cloneFinite(input.comparison, "comparison", new WeakSet<object>()) as ComparisonReport),
    notes: [...REPORT_NOTES],
  };
}

/**
 * 只读实验报告的结构校验（不修改输入）。
 *
 * 拒绝：非普通对象、错误 schema/kind/restore、非法 createdAtIso、build 形状错误、
 * 未过档案校验的 archive、既非 null 也非合法事件数组的 events、未过浅结构校验的
 * comparison（只读展示，不重算指标）、任何非有限数值。循环引用不会导致栈崩溃。
 */
export function validateExperimentReport(raw: unknown): ExperimentReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("实验报告须为普通 JSON 对象");
  }
  // 全树先做有限数/循环引用检查（防循环：WeakSet 记录访问中的对象）。
  cloneFinite(raw, "", new WeakSet<object>());

  const o = raw as Partial<ExperimentReport> & Record<string, unknown>;
  if (o.schema !== REPORT_SCHEMA) throw new Error(`实验报告 schema 须为 ${REPORT_SCHEMA}`);
  if (o.kind !== REPORT_KIND) throw new Error(`实验报告 kind 须为 ${REPORT_KIND}`);
  if (o.restore !== REPORT_RESTORE) {
    throw new Error(`实验报告 restore 须为 "${REPORT_RESTORE}"（只读查看，不是配置档案）`);
  }
  if (!isIsoString(o.createdAtIso)) throw new Error("实验报告 createdAtIso 须为合法 ISO 时间字符串");
  if (o.build !== null) {
    if (!o.build || typeof o.build !== "object" || Array.isArray(o.build)) {
      throw new Error("实验报告 build 须为对象或 null");
    }
    const build = o.build as Partial<ReportBuildInfo>;
    if (typeof build.buildId !== "string" || !build.buildId) throw new Error("实验报告 build.buildId 须为非空字符串");
    if (typeof build.sourceDigest !== "string" || !build.sourceDigest) {
      throw new Error("实验报告 build.sourceDigest 须为非空字符串");
    }
  }
  const archiveParse = parseArchive(o.archive);
  if (!archiveParse.ok) throw new Error(`实验报告内嵌档案不合法：${archiveParse.error}`);
  const eventsProblemMessage = eventsProblem(o.events);
  if (eventsProblemMessage) throw new Error(`实验报告 ${eventsProblemMessage}`);
  const comparisonIssue = comparisonProblem(o.comparison);
  if (comparisonIssue) throw new Error(`实验报告内嵌对照不合法：${comparisonIssue}`);
  if (
    !Array.isArray(o.notes) ||
    o.notes.some((note) => typeof note !== "string")
  ) {
    throw new Error("实验报告 notes 须为字符串数组");
  }
  return raw as ExperimentReport;
}

/** 导出为 JSON 文本：先校验再序列化，保证落盘内容一定能被自家解析器读回。 */
export function serializeExperimentReport(report: ExperimentReport): string {
  validateExperimentReport(report);
  return JSON.stringify(report, null, 2);
}
