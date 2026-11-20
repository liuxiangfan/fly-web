/**
 * 当前学习任务的上下文（F-04 任务条）与偏离状态机。
 *
 * 纯数据、无 DOM、无配置依赖：实验/对照/课程只传**字符串摘要**和可选的
 * 配置字段路径（`variablePaths`）。参数变化由 main.ts 从真实控件事件里收集后
 * 交给 `markDeviation`；本模块不监听事件、不写控件、不持久化任何状态。
 *
 * 语义（与 Appendix D.2 的冲突矩阵一致）：
 * - 自由探索不生成「任务」，任何参数变化都不算偏离；
 * - 实验/对照只有「变量路径」内的变化保持单变量状态；
 * - 非变量参数变化只改变学习状态（任务条标「已偏离」），不锁参数、不清曲线；
 * - `exitTask` 只清学习上下文，不碰实验参数或曲线（纯函数天然如此）。
 */
import { PARAMETER_METAS, parameterMeta } from "./parameter-meta";

export type TaskKind = "free" | "experiment" | "challenge" | "comparison" | "tour" | "learning";

export interface TaskContext {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: string;
  /** 固定条件的字符串摘要（如「复合机动 · 20° 侧向污染 · 种子 24301」） */
  readonly conditions: string;
  /** 当前唯一变量的字符串摘要（如「门控方向阈值 20° → 30°」） */
  readonly variable: string;
  readonly observe: string;
  readonly next: string;
  readonly source?: string;
  /** 任务装载时的配置快照（不解释、不 import 配置，原样保留给上层） */
  readonly pinnedConfig?: unknown;
  /** 允许改变的配置字段路径；其余已登记参数变化视为偏离 */
  readonly variablePaths?: readonly string[];
  readonly deviated?: boolean;
  readonly deviationReason?: string;
  /** 任务条状态行（自由探索 / 严格单变量 / 已偏离原实验 / 已退出） */
  readonly status: string;
}

export interface TaskSpec {
  id?: string;
  title?: string;
  conditions?: string;
  variable?: string;
  variablePaths?: readonly string[];
  observe?: string;
  next?: string;
  source?: string;
  pinnedConfig?: unknown;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function pathList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** 已登记元数据里的配置路径（含 "seed" 这种没有点号的路径），用于直接路径输入。 */
const KNOWN_PATHS = new Set(PARAMETER_METAS.map((meta) => meta.path));

function allowedPaths(value: unknown): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const raw of pathList(value)) {
    allowed.add(raw);
    const meta = parameterMeta(raw);
    if (meta) allowed.add(meta.path);
  }
  return allowed;
}

function baseTask(kind: TaskKind, spec: TaskSpec | null | undefined, defaults: {
  id: string;
  title: string;
  conditions: string;
  variable: string;
  observe: string;
  next: string;
  strictPrefix: string;
  loosePrefix: string;
}): TaskContext {
  const input: TaskSpec = spec ?? {};
  const variable = text(input.variable, defaults.variable);
  const variablePaths = pathList(input.variablePaths);
  const status = variablePaths.length > 0
    ? `${defaults.strictPrefix}：只允许改变 ${variable}`
    : `${defaults.loosePrefix}：${variable}（未登记变量路径，不宣称严格单变量）`;
  const source = text(input.source, "");
  return {
    id: text(input.id, defaults.id),
    kind,
    title: text(input.title, defaults.title),
    conditions: text(input.conditions, defaults.conditions),
    variable,
    observe: text(input.observe, defaults.observe),
    next: text(input.next, defaults.next),
    ...(source ? { source } : {}),
    ...(input.pinnedConfig !== undefined ? { pinnedConfig: input.pinnedConfig } : {}),
    ...(variablePaths.length > 0 ? { variablePaths } : {}),
    status,
  };
}

/** 自由探索：不强行生成任务，也不把参数变化判为偏离。 */
export function createFreeTask(): TaskContext {
  return {
    id: "free",
    kind: "free",
    title: "自由探索",
    conditions: "无固定条件",
    variable: "无（自由调参）",
    observe: "随意改变任一参数，观察曲线、读数与 IMU 波形",
    next: "需要引导时再选择实验、对照或课程",
    status: "自由探索：不限定单变量，也不把参数变化判为偏离",
  };
}

/** 实验任务：`variablePaths` 用于区分「实验唯一变量」与「非变量参数」。 */
export function createExperimentTask(spec?: TaskSpec | null): TaskContext {
  return baseTask("experiment", spec, {
    id: "experiment",
    title: "实验",
    conditions: "未记录固定条件",
    variable: "未指定变量",
    observe: "按实验说明观察对应曲线与读数",
    next: "完成观察后可退出任务，回到自由探索",
    strictPrefix: "严格单变量",
    loosePrefix: "实验任务",
  });
}

/** 对照任务：固定配置与种子，只改变一个变量；变量路径应覆盖被比较的字段。 */
export function createComparisonTask(spec?: TaskSpec | null): TaskContext {
  return baseTask("comparison", spec, {
    id: "comparison",
    title: "参数对照",
    conditions: "固定配置与种子，只改变一个变量（A/B 对照）",
    variable: "未指定变量",
    observe: "对照 A/B 曲线与指标差异：固定条件相同，只比较被改变的变量",
    next: "运行 A/B、查看差异，或退出任务回到自由探索",
    strictPrefix: "严格单变量对照",
    loosePrefix: "对照任务",
  });
}

/**
 * 判定一批真实控件变化是否越过任务声明的变量集合。
 *
 * 生产任务条与 `markDeviation` 共用同一份策略：已登记控件先解析到配置路径，
 * 上层也可直接传配置字段路径（含无点号的 seed）；未登记/无路径的 id 不伪造影响。
 * 返回去重后的偏离控件 id（空数组 = 未偏离）。
 */
export function deviatingIds(
  changedIds: readonly string[] | null | undefined,
  variablePaths?: readonly string[] | null,
): string[] {
  const allowed = allowedPaths(variablePaths);
  const changed = Array.isArray(changedIds) ? changedIds : [];
  const out: string[] = [];
  for (const raw of changed) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    const meta = parameterMeta(id);
    // 已登记控件走元数据路径；上层也可以直接传配置字段路径（含无点号的 seed）。
    const path = meta ? meta.path : KNOWN_PATHS.has(id) || id.includes(".") ? id : undefined;
    if (!path || allowed.has(path)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 标记参数变化是否让任务偏离原始单变量条件。
 *
 * @param changedIds 真实控件 ID（或直接的配置字段路径）列表
 * @param variablePaths 可选的变量路径覆盖；省略时使用任务创建时登记的路径
 *
 * 未登记的控件 ID 不会伪造配置影响；空输入、非数组输入与已偏离任务都是幂等的。
 * 返回新对象，不修改传入的任务上下文。
 */
export function markDeviation(
  ctx: TaskContext,
  changedIds: readonly string[] | null | undefined,
  variablePaths?: readonly string[] | null,
): TaskContext {
  if (!ctx || typeof ctx !== "object") return createFreeTask();
  if (ctx.kind === "free") return ctx;
  if (ctx.deviated) return ctx;

  const ids = deviatingIds(changedIds, variablePaths ?? ctx.variablePaths);
  if (ids.length === 0) return ctx;

  const what = ctx.kind === "challenge" ? "题目" : ctx.kind === "tour" ? "课程" : "原实验";
  const reason = `改变了非变量参数：${ids.join("、")}`;
  return {
    ...ctx,
    deviated: true,
    deviationReason: reason,
    status: `已偏离${what}：${reason}；不再宣称严格单变量对照（参数未被锁定）`,
  };
}

/** 退出任务只清学习上下文；实验参数、曲线与已记录数据保持不变（本函数不触碰它们）。 */
export function exitTask(ctx?: TaskContext | null): TaskContext {
  const free = createFreeTask();
  if (!ctx || typeof ctx !== "object") return free;
  if (ctx.kind === "free") return free;
  const title = typeof ctx.title === "string" ? ctx.title.trim() : "";
  return title
    ? { ...free, status: `已退出「${title}」，回到自由探索；曲线与参数未改动` }
    : free;
}
