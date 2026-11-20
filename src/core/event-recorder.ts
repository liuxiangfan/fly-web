/**
 * F-05 的生产侧事件记录器（纯逻辑，无 DOM、无墙钟、无随机数）。
 *
 * 职责边界
 * --------
 * - **只记录真实状态边沿**：加计／磁通道的状态直接来自估计器遥测的
 *   `accelState/magState`。只有显式 `"rejected"` 才算拒绝；其余状态（applied /
 *   invalid / disabled / unrecorded / not-applicable）只用于闭合已经开始的拒绝窗。
 * - 连续多帧拒绝由 `EdgeTracker` 归并为一对 start/end，不把每个解算步都变成 UI 记录。
 * - 粗对准是瞬时事件，由调用方通过 `sample(..., { aligned: true })` 或 `align(t)`
 *   提供；同一时刻重复上报会被去重（SolveLoop 的 `onSolve` 与 `onAlign` 可能同时可见）。
 * - 断流是传输层状态，本模块不猜测；调用方用 `dataGap()` 显式提交边沿。
 * - **不推断饱和**：没有来自传感器“真实削顶分支”的观测信号时，一条饱和事件也不生成。
 * - 不推断故障原因，不把单步拒绝写成整体系统结论。
 *
 * 轮次隔离：首条 `sample/reset` 绑定 runId；若后续 runId 改变而未显式
 * `reset(newRunId)`，直接报错，避免旧边沿状态污染新时间轴。`reset` 只清空
 * 边沿跟踪与事件，不补发假 end——未封口的 start 由时间轴保留并由上层处理。
 */
import type { EstimatorTelemetry } from "../estimators";
import { EdgeTracker, EventTimeline, type EventListFilter, type LearningEvent, type LearningEventKind, type LearningEventPhase } from "./event-timeline";
import type { EstimatorId } from "./experiment-config";
import type { ReferenceKind } from "./data-source";
import type { ObservationState } from "./observability";

/** 记录器只要求估计器提供这三个字段；完整 `Estimator` 结构可直接传入。 */
export interface RecorderEstimator {
  id: EstimatorId;
  /** 可选显示名；缺省用内置中文名，**不会**从 DOM 读取 */
  label?: string;
  telemetry: EstimatorTelemetry;
}

export interface EventRecorderSampleOptions {
  /** 当前误差参考类型；作为粗对准事件的上下文证据保存，不参与状态判断 */
  referenceKind?: ReferenceKind;
  /** 本步是否发生了静止粗对准（由 SolveLoop 的真实 aligned/onAlign 提供） */
  aligned?: boolean;
}

export interface EventRecorderOptions {
  /** 每写入一条事件回调一次；收到的是时间轴副本，修改它不影响存储 */
  onEvent?: (event: LearningEvent) => void;
}

const ESTIMATOR_NAMES: Record<EstimatorId, string> = {
  pure: "纯陀螺仪积分",
  comp: "互补滤波",
  mahony: "Mahony",
  madg: "Madgwick",
  kalman: "卡尔曼滤波",
};

const CHANNEL_NAMES = {
  accel: "加速度计",
  mag: "磁力计",
} as const;

type Channel = keyof typeof CHANNEL_NAMES;

function assertFiniteTime(t: number): void {
  if (!Number.isFinite(t)) throw new RangeError(`事件时间 t 必须是有限数值，收到 ${String(t)}`);
}

function estimatorName(estimator: RecorderEstimator): string {
  const label = estimator.label?.trim();
  return label && label.length > 0 ? label : ESTIMATOR_NAMES[estimator.id];
}

function finiteDetail(telemetry: EstimatorTelemetry, key: string): number | undefined {
  const value = telemetry.detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 事件证据只保留遥测里**真实存在且有限**的量；没有就不写字段，
 * 不用 0 或阈值猜测占位。`before/after` 不携带遥测对象本身。
 */
function gateEvidence(
  telemetry: EstimatorTelemetry,
  channel: Channel,
  state: ObservationState,
  reasonCode: string | null,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    channel,
    state,
    reasonCode,
  };
  if (channel === "accel" && Number.isFinite(telemetry.accelNorm)) {
    evidence.accelNorm = telemetry.accelNorm;
  }
  const angle = channel === "accel"
    ? finiteDetail(telemetry, "innoAccelDeg") ?? finiteDetail(telemetry, "alignErrorDeg")
    : finiteDetail(telemetry, "innoMagDeg");
  if (angle !== undefined) evidence.angleDeg = angle;
  const nis = finiteDetail(telemetry, channel === "accel" ? "nisAccel" : "nisMag");
  if (nis !== undefined) evidence.nis = nis;
  return evidence;
}

export class EventRecorder {
  readonly capacity: number;
  private readonly store: EventTimeline;
  private readonly gateEdges = new EdgeTracker();
  private readonly dataGapEdges = new EdgeTracker();
  private readonly saturationEdges = new EdgeTracker();
  private readonly options: EventRecorderOptions;
  private activeRunId: number | null = null;
  /** 同一时刻的粗对准只记录一次；不同时刻仍可分别记录。 */
  private lastAlignTime: number | null = null;

  constructor(capacity = 512, options: EventRecorderOptions = {}) {
    this.store = new EventTimeline(capacity);
    this.capacity = this.store.capacity;
    this.options = options;
  }

  /**
   * 开始新一轮：清空旧事件、dropped/seq 与全部边沿状态。
   * 不生成任何“结束”事件来封口上一轮——取消／重置不能伪造历史。
   */
  reset(runId: number): void {
    this.store.reset(runId);
    this.gateEdges.reset();
    this.dataGapEdges.reset();
    this.saturationEdges.reset();
    this.activeRunId = runId;
    this.lastAlignTime = null;
  }

  /**
   * 每个解算子步调用一次（建议直接放在生产 `onSolve` 内）。
   *
   * 加计与磁通道按“估计器 × 通道”分别归并：五个算法、两个通道互不混成一个
   * 全局拒绝状态。`opts.aligned` 为 true 时追加一条粗对准瞬时事件。
   */
  sample(
    runId: number,
    t: number,
    estimators: readonly RecorderEstimator[],
    opts: EventRecorderSampleOptions = {},
  ): void {
    assertFiniteTime(t);
    this.ensureRun(runId);
    for (const estimator of estimators) {
      this.sampleChannel(estimator, "accel", estimator.telemetry.accelState, estimator.telemetry.accelReasonCode, t);
      this.sampleChannel(estimator, "mag", estimator.telemetry.magState, estimator.telemetry.magReasonCode, t);
    }
    if (opts.aligned === true) this.align(t, opts.referenceKind);
  }

  /**
   * 记录一次静止粗对准瞬时事件。
   *
   * 与 `sample(..., { aligned: true })` 共用同一份同刻去重：如果主程序同时从
   * `onAlign` 和 `onSolve(ctx.aligned)` 两条真实路径上报，同一时刻也只记一条。
   * 这覆盖了「对准发生在没有解算的仿真步」的情况。
   */
  align(t: number, referenceKind?: ReferenceKind): void {
    assertFiniteTime(t);
    if (this.activeRunId === null) {
      throw new Error("EventRecorder 尚未绑定 runId：记录粗对准前请先 sample() 或 reset()");
    }
    if (this.lastAlignTime === t) return;
    this.lastAlignTime = t;
    const after: Record<string, unknown> = { aligned: true };
    if (referenceKind !== undefined) after.referenceKind = referenceKind;
    this.push(t, "align", "all", "instant", "静止粗对准触发（融合类估计器重置到对准姿态；纯积分不参与）", {
      source: "solve-loop",
      after,
    });
  }

  /**
   * 传输层断流边沿，由调用方用真实数据源状态驱动。
   * 首次 active=true 产生 data-gap start；true→false 产生 data-recover end。
   */
  dataGap(t: number, active: boolean, reason?: string): void {
    assertFiniteTime(t);
    if (this.activeRunId === null) {
      throw new Error("EventRecorder 尚未绑定 runId：记录数据断流前请先 sample() 或 reset()");
    }
    const text = reason?.trim();
    this.dataGapEdges.step(
      "transport:data-gap",
      active,
      t,
      () => {
        this.push(
          t,
          "data-gap",
          null,
          "start",
          text ? `数据断流开始（${text}）` : "数据断流开始",
          { source: "transport", after: text ? { reason: text } : { reason: null } },
        );
      },
      () => {
        this.push(t, "data-recover", null, "end", "数据断流恢复", { source: "transport" });
      },
    );
  }

  /**
   * 陀螺仪真实削顶边沿：只能由传感器 `ImuSample.gyroSaturated` 等真实信号驱动。
   * 连续削顶只产生 start/end 一对，绝不按 |gyro|≈range 或姿态误差猜测。
   */
  saturation(t: number, active: boolean): void {
    assertFiniteTime(t);
    if (this.activeRunId === null) throw new Error("EventRecorder 尚未绑定 runId：记录饱和前请先 sample() 或 reset()");
    this.saturationEdges.step(
      "sensor:gyro",
      active,
      t,
      () => this.push(t, "gate-saturation", null, "start", "陀螺仪达到满量程：读数开始被削顶", {
        source: "sensor", after: { channel: "gyro", saturated: true },
      }),
      () => this.push(t, "gate-saturation", null, "end", "陀螺仪退出满量程削顶", {
        source: "sensor", after: { channel: "gyro", saturated: false },
      }),
    );
  }

  /** 重连尝试/成功/耗尽：来自真实传输状态机的瞬时事件。 */
  dataReconnect(t: number, status: "attempt" | "success" | "exhausted", detail?: Record<string, unknown>): void {
    assertFiniteTime(t);
    if (this.activeRunId === null) throw new Error("EventRecorder 尚未绑定 runId：记录重连前请先 sample() 或 reset()");
    const labels = { attempt: "重连尝试", success: "重连成功", exhausted: "重连耗尽" } as const;
    const text = labels[status];
    if (!text) throw new TypeError(`重连事件 status 非法：${String(status)}`);
    this.push(t, "data-reconnect", null, "instant", `数据链路${text}`, {
      source: "transport", after: { status, ...(detail ?? {}) },
    });
  }

  /** 真实用户动作：参数改变、视图切换、实验装载；不存 DOM 节点。 */
  userAction(
    t: number,
    kind: "param-change" | "view-change" | "experiment-load",
    summary: string,
    before?: unknown,
    after?: unknown,
  ): void {
    assertFiniteTime(t);
    if (this.activeRunId === null) throw new Error("EventRecorder 尚未绑定 runId：记录用户动作前请先 sample() 或 reset()");
    if (kind !== "param-change" && kind !== "view-change" && kind !== "experiment-load") {
      throw new TypeError(`用户动作事件类型非法：${String(kind)}`);
    }
    this.push(t, kind, null, "instant", summary, {
      source: "user-action",
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }

  /** 当前轮次事件副本（按 t 升序、同 t 按 seq 升序）。 */
  list(filter: EventListFilter = {}): LearningEvent[] {
    return this.store.list(filter);
  }

  /** 暴露给事件面板读取；时间轴自身的 add 仍受 runId 与输入校验保护。 */
  timeline(): EventTimeline {
    return this.store;
  }

  /** 自上次 reset 以来被环形缓冲淘汰的事件数。 */
  dropped(): number {
    return this.store.dropped;
  }

  private ensureRun(runId: number): void {
    if (this.activeRunId === null) {
      this.store.reset(runId);
      this.activeRunId = runId;
      return;
    }
    if (this.activeRunId !== runId) {
      throw new Error(
        `EventRecorder 当前轮次 ${this.activeRunId} 与 sample 的 runId ${runId} 不一致；请先 reset(runId)`,
      );
    }
  }

  private sampleChannel(
    estimator: RecorderEstimator,
    channel: Channel,
    state: ObservationState | undefined,
    reasonCode: string | null | undefined,
    t: number,
  ): void {
    if (state === undefined) return;
    const key = `gate:${estimator.id}:${channel}`;
    const active = state === "rejected";
    const channelName = CHANNEL_NAMES[channel];
    this.gateEdges.step(
      key,
      active,
      t,
      () => {
        this.push(
          t,
          "gate-reject",
          estimator.id,
          "start",
          `${estimatorName(estimator)}：${channelName}观测被门控拒绝（开始；本步未应用该通道修正）`,
          {
            source: "solve-loop",
            after: gateEvidence(estimator.telemetry, channel, "rejected", reasonCode ?? null),
          },
        );
      },
      () => {
        this.push(
          t,
          "gate-recovery",
          estimator.id,
          "end",
          `${estimatorName(estimator)}：${channelName}门控拒绝状态结束（本步不再报告拒绝；不据此断言已应用修正）`,
          {
            source: "solve-loop",
            before: { channel, state: "rejected" },
            after: gateEvidence(estimator.telemetry, channel, state, reasonCode ?? null),
          },
        );
      },
    );
  }

  private push(
    t: number,
    kind: LearningEventKind,
    estimator: LearningEvent["estimator"],
    phase: LearningEventPhase,
    summary: string,
    extra: { source: LearningEvent["source"]; before?: unknown; after?: unknown },
  ): void {
    const runId = this.activeRunId;
    if (runId === null) throw new Error("EventRecorder 尚未绑定 runId");
    const event = this.store.add(runId, {
      t,
      kind,
      estimator,
      phase,
      summary,
      source: extra.source,
      ...(extra.before !== undefined ? { before: extra.before } : {}),
      ...(extra.after !== undefined ? { after: extra.after } : {}),
    });
    this.options.onEvent?.(event);
  }
}
