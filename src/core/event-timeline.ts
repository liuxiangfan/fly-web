/**
 * 教学事件时间轴（F-05 的纯基础层）。
 *
 * 设计约束：
 * - 只存数据，不碰 DOM、不存类实例；`before/after` 在入口与出口都做深拷贝，
 *   调用方后续修改原对象不会污染已记录事件。
 * - 环形缓冲固定容量，超出后淘汰最旧事件并累计 `dropped`；`size` 不会超过 `capacity`。
 * - `seq` 在**一轮**内单调递增；同一 `t` 的多条事件按 `seq` 稳定排序。
 * - `runId` 切换必须显式 `reset(runId)`；旧轮事件会被清空，不能落到新时间轴里。
 * - 非有限时间（NaN / ±Infinity）直接拒绝，避免排序与最近事件查询出现不可预期结果。
 *
 * 这里不判断“什么算事件”：调用方从真实状态边沿、真实用户动作或真实数据源状态产生事件。
 * 本模块也不负责重试、合并或补发假结束事件——持续状态用 start/end，重置时由 `EdgeTracker`
 * 丢弃未封口状态，而不是自动补一个 end。
 */
import type { EstimatorId } from "./experiment-config";

export const LEARNING_EVENT_KINDS = [
  "align",
  "gate-reject",
  "gate-recovery",
  "gate-saturation",
  "data-gap",
  "data-recover",
  "data-reconnect",
  "param-change",
  "view-change",
  "experiment-load",
  "custom",
] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

export const LEARNING_EVENT_PHASES = ["instant", "start", "end"] as const;
export type LearningEventPhase = (typeof LEARNING_EVENT_PHASES)[number];

export const LEARNING_EVENT_SOURCES = ["solve-loop", "sensor", "transport", "user-action"] as const;
export type LearningEventSource = (typeof LEARNING_EVENT_SOURCES)[number];

/** 事件契约（见 docs/TEACHING-INTERACTION-EXPANSION-PLAN.md B.6）。 */
export interface LearningEvent {
  runId: number;
  /** 一轮内单调递增；同一 t 的多条事件靠它稳定排序 */
  seq: number;
  /** 仿真／数据时间轴；用户动作使用当前 state.simTime，不伪造未来时刻 */
  t: number;
  kind: LearningEventKind;
  estimator: EstimatorId | "all" | null;
  phase: LearningEventPhase;
  summary: string;
  before?: unknown;
  after?: unknown;
  source: LearningEventSource;
}

/** 调用方提交的事件内容：runId 与 seq 由 EventTimeline 统一分配。 */
export type LearningEventInput = Omit<LearningEvent, "runId" | "seq">;

export interface EventListFilter {
  runId?: number;
  kind?: LearningEventKind | readonly LearningEventKind[];
  /** `null` 是有效过滤值：只保留不归属单个估计器的事件 */
  estimator?: EstimatorId | "all" | null;
  /** 闭区间下界 */
  since?: number;
  /** 闭区间上界 */
  until?: number;
}

const ESTIMATOR_IDS: readonly EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId < 0) {
    throw new RangeError(`runId 必须是非负安全整数，收到 ${String(runId)}`);
  }
}

function assertFiniteTime(t: number, label: string): void {
  if (!Number.isFinite(t)) {
    throw new RangeError(`${label} 必须是有限数值，收到 ${String(t)}`);
  }
}

function assertOneOf<T extends string>(value: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} 取值非法：${String(value)}`);
  }
}

function assertEstimator(value: LearningEvent["estimator"]): void {
  if (value === null || value === "all" || (ESTIMATOR_IDS as readonly string[]).includes(value)) return;
  throw new TypeError(`estimator 取值非法：${String(value)}`);
}

/**
 * 深拷贝成 JSON 可表达的纯数据。
 *
 * 只接受 null / 字符串 / 布尔 / 有限数值 / undefined / 数组 / 纯对象。
 * 类实例、DOM 节点、函数、Symbol、BigInt、循环引用都会被拒绝——它们一旦进入事件，
 * 导出、Worker 传输或后续快照会得到不可预期结果。
 */
function cloneJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("事件 before/after 中的数值必须是有限数");
      return value;
    case "object": {
      if (seen.has(value)) throw new TypeError("事件 before/after 不得包含循环引用");
      if (Array.isArray(value)) {
        seen.add(value);
        try {
          return value.map((item) => cloneJsonValue(item, seen));
        } finally {
          seen.delete(value);
        }
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("事件 before/after 只接受纯对象、数组与 JSON 原始值");
      }
      seen.add(value);
      try {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) out[key] = cloneJsonValue(item, seen);
        return out;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`事件 before/after 含不可序列化类型：${typeof value}`);
  }
}

function copyLearningEvent(event: LearningEvent): LearningEvent {
  const copy: LearningEvent = {
    runId: event.runId,
    seq: event.seq,
    t: event.t,
    kind: event.kind,
    estimator: event.estimator,
    phase: event.phase,
    summary: event.summary,
    source: event.source,
  };
  if (event.before !== undefined) copy.before = cloneJsonValue(event.before);
  if (event.after !== undefined) copy.after = cloneJsonValue(event.after);
  return copy;
}

/**
 * 固定容量事件环形缓冲。
 *
 * 只保留当前一轮：`reset(newRunId)` 会清空上一轮事件、`dropped` 与 `seq` 计数。
 * `add` 拒绝与当前轮不一致的 runId，避免旧生产者把事件写进新时间轴。
 */
export class EventTimeline {
  readonly capacity: number;
  private readonly buffer: Array<LearningEvent | undefined>;
  private head = 0;
  private count = 0;
  private droppedCount = 0;
  private nextSeq = 0;
  private activeRun: number | null = null;

  constructor(capacity = 512) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity 必须是正整数，收到 ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.buffer = new Array<LearningEvent | undefined>(capacity);
  }

  /** 当前保留的事件数，永不超过 capacity。 */
  get size(): number {
    return this.count;
  }

  /** 自上次 reset/clear 以来被淘汰的事件总数。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /** 当前轮次；尚未 add 也未 reset 时为 null。 */
  get currentRunId(): number | null {
    return this.activeRun;
  }

  /**
   * 追加一条事件。`runId` 必须与当前轮一致（首条 add 会建立当前轮）。
   * 返回的是副本，修改它不会影响时间轴内部数据。
   */
  add(runId: number, event: LearningEventInput): LearningEvent {
    assertRunId(runId);
    assertFiniteTime(event.t, "事件时间 t");
    assertOneOf(event.kind, LEARNING_EVENT_KINDS, "kind");
    assertOneOf(event.phase, LEARNING_EVENT_PHASES, "phase");
    assertOneOf(event.source, LEARNING_EVENT_SOURCES, "source");
    assertEstimator(event.estimator);
    if (typeof event.summary !== "string") throw new TypeError("事件 summary 必须是字符串");

    if (this.activeRun !== null && this.activeRun !== runId) {
      throw new Error(`事件 runId ${runId} 与当前轮次 ${this.activeRun} 不一致；请先调用 reset(runId)`);
    }

    // 先完成证据拷贝再消耗 seq：不可序列化的证据不能留下一个“空号”。
    let before: unknown;
    let after: unknown;
    if (event.before !== undefined) before = cloneJsonValue(event.before);
    if (event.after !== undefined) after = cloneJsonValue(event.after);

    if (this.activeRun === null) this.activeRun = runId;
    const seq = ++this.nextSeq;
    const stored: LearningEvent = {
      runId,
      seq,
      t: event.t,
      kind: event.kind,
      estimator: event.estimator,
      phase: event.phase,
      summary: event.summary,
      source: event.source,
    };
    if (before !== undefined) stored.before = before;
    if (after !== undefined) stored.after = after;

    if (this.count === this.capacity) {
      // 覆盖最旧槽位，然后 head 前移——size 保持不变，dropped 精确加一。
      this.buffer[this.head] = stored;
      this.head = (this.head + 1) % this.capacity;
      this.droppedCount++;
    } else {
      const tail = (this.head + this.count) % this.capacity;
      this.buffer[tail] = stored;
      this.count++;
    }
    return copyLearningEvent(stored);
  }

  /**
   * 查询事件。返回按 `t` 升序、同 `t` 按 `seq` 升序的副本数组；
   * `since/until` 均为闭区间。
   */
  list(filter: EventListFilter = {}): LearningEvent[] {
    if (filter.runId !== undefined) assertRunId(filter.runId);
    if (filter.since !== undefined) assertFiniteTime(filter.since, "since");
    if (filter.until !== undefined) assertFiniteTime(filter.until, "until");
    const kinds: readonly LearningEventKind[] | null = filter.kind === undefined
      ? null
      : Array.isArray(filter.kind)
        ? filter.kind
        : [filter.kind];
    if (kinds) {
      for (const kind of kinds) assertOneOf(kind, LEARNING_EVENT_KINDS, "kind");
    }
    if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) return [];

    const out: LearningEvent[] = [];
    for (let i = 0; i < this.count; i++) {
      const event = this.buffer[(this.head + i) % this.capacity];
      if (!event) continue;
      if (filter.runId !== undefined && event.runId !== filter.runId) continue;
      if (kinds && !kinds.includes(event.kind)) continue;
      if (filter.estimator !== undefined && event.estimator !== filter.estimator) continue;
      if (filter.since !== undefined && event.t < filter.since) continue;
      if (filter.until !== undefined && event.t > filter.until) continue;
      out.push(copyLearningEvent(event));
    }
    out.sort((a, b) => a.t - b.t || a.seq - b.seq);
    return out;
  }

  /** 按 seq 精确查找；已淘汰或不存在时返回 null。 */
  atSeq(seq: number): LearningEvent | null {
    if (!Number.isSafeInteger(seq)) return null;
    for (let i = 0; i < this.count; i++) {
      const event = this.buffer[(this.head + i) % this.capacity];
      if (event && event.seq === seq) return copyLearningEvent(event);
    }
    return null;
  }

  /**
   * 最近的 t。距离相同取更早的 t；同一 t 取更小的 seq。
   * 空时间轴返回 null；非有限目标时间拒绝。
   */
  nearest(t: number): LearningEvent | null {
    assertFiniteTime(t, "目标时间 t");
    let best: LearningEvent | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.count; i++) {
      const event = this.buffer[(this.head + i) % this.capacity];
      if (!event) continue;
      const dist = Math.abs(event.t - t);
      if (
        best === null ||
        dist < bestDist ||
        (dist === bestDist && (event.t < best.t || (event.t === best.t && event.seq < best.seq)))
      ) {
        best = event;
        bestDist = dist;
      }
    }
    return best ? copyLearningEvent(best) : null;
  }

  /** 开始新一轮：清空旧轮事件、dropped 与 seq，后续 add 必须使用同一 runId。 */
  reset(runId: number): void {
    assertRunId(runId);
    this.clearStorage();
    this.activeRun = runId;
  }

  /** 清空全部内容并回到“无当前轮”状态。 */
  clear(): void {
    this.clearStorage();
    this.activeRun = null;
  }

  private clearStorage(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.droppedCount = 0;
    this.nextSeq = 0;
  }
}

export type EdgeTransition = "start" | "end";
export type EdgeHandler = (key: string, t: number) => void;

/**
 * 布尔状态边沿归并器（观测门控、断流、饱和等持续状态共用）。
 *
 * 首次 `true` 产生 start，持续 `true` 不重复；`true → false` 产生 end。
 * `reset` 只丢弃状态，不调用 onEnd——取消／重置时不能自动补一个假结束事件，
 * 未封口的 start 由事件列表保留，由上层决定如何标注。
 */
export class EdgeTracker {
  private readonly active = new Map<string, true>();

  /**
   * 推进一个键的状态。只在发生边沿时调用对应回调并返回 "start"/"end"。
   * 非有限 t、非字符串键、非布尔 active 都直接拒绝。
   */
  step(
    key: string,
    active: boolean,
    t: number,
    onStart?: EdgeHandler,
    onEnd?: EdgeHandler,
  ): EdgeTransition | null {
    if (typeof key !== "string" || key.length === 0) throw new TypeError("边沿 key 必须是非空字符串");
    if (typeof active !== "boolean") throw new TypeError("边沿 active 必须是布尔值");
    assertFiniteTime(t, "边沿时间 t");
    const wasActive = this.active.has(key);
    if (active === wasActive) return null;
    if (active) {
      this.active.set(key, true);
      onStart?.(key, t);
      return "start";
    }
    this.active.delete(key);
    onEnd?.(key, t);
    return "end";
  }

  /** 清除一个键或全部键的状态；不触发任何回调。 */
  reset(key?: string): void {
    if (key === undefined) this.active.clear();
    else this.active.delete(key);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  /** 当前处于 active 的键，按字典序排列，便于稳定快照。 */
  activeKeys(): string[] {
    return [...this.active.keys()].sort();
  }

  get size(): number {
    return this.active.size;
  }
}
