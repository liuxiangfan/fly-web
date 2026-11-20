/**
 * F-06 历史回看的纯数据底座：有界 ReviewFrame 环形缓冲。
 *
 * 只依赖类型（无 DOM / 无 runner / 无 Three.js），浏览器与 Node 契约测试共用。
 *
 * 读写语义：
 *  - push 先完整校验再深拷贝，坏帧被拒绝时缓冲长度与淘汰计数都不变；
 *  - 所有数组、四元数、IMU 样本、telemetry.detail 都与调用方隔离；
 *  - latest / nearest / list 返回的也是深拷贝——修改返回值不会污染缓冲。
 *
 * 代价：每次读取会复制帧（默认窗口 750 帧）。游标移动、事件定位时按需调用即可，
 * 不要在 rAF 每帧复制整个窗口。
 */
import type { ImuSample } from "./imu";
import type { Quat, V3 } from "./quat";
import type { EstimatorTelemetry, KalmanStepSnapshot } from "../estimators";
import type { EstimatorId } from "./experiment-config";
import type { ReferenceKind } from "./data-source";

// ReferenceKind 的权威定义在 core/data-source.ts；这里只转出，避免两套联合漂移。
export type { ReferenceKind };

/** 30 s × 25 Hz 的默认回看窗口。 */
export const DEFAULT_REVIEW_CAPACITY = 750;
/** 最近帧容差：默认 20 ms，约为 25 Hz 记录间隔的一半。 */
export const DEFAULT_NEAREST_TOLERANCE_SEC = 0.02;

/**
 * 单个历史回看帧。字段与 docs/TEACHING-INTERACTION-EXPANSION-PLAN.md B.7 对齐。
 * `eskf` 留作 F-07 的只读快照；本模块只负责不与外部对象共享引用。
 */
export interface ReviewFrame {
  runId: number;
  seq: number;
  /** 本子步／记录点的数据时间（秒），不是 rAF 墙钟时间。 */
  t: number;
  truth: { kind: ReferenceKind; q: Quat | null };
  estimate: { id: EstimatorId; q: Quat };
  input: {
    raw: ImuSample;
    consumed: { gyro: V3; accel: V3; mag: V3 };
  };
  telemetry: EstimatorTelemetry;
  errors: { totalDeg: number | null; tiltDeg: number | null; yawDeg: number | null };
  eskf?: KalmanStepSnapshot | null;
}

/** buildReviewFrame 的入参：来源值保持原样，由 helper 负责复制与真值归一。 */
export interface BuildReviewFrameInput {
  runId: number;
  seq: number;
  t: number;
  truthKind: ReferenceKind;
  truthQ: Quat | null;
  estimateId: EstimatorId;
  estimateQ: Quat;
  raw: ImuSample;
  consumed: { gyro: V3; accel: V3; mag: V3 };
  telemetry: EstimatorTelemetry;
  totalDeg: number | null;
  tiltDeg: number | null;
  yawDeg: number | null;
  /** 本帧对应的 ESKF 单步快照；缺省不写字段，null 表示“本轮无快照”。 */
  eskf?: KalmanStepSnapshot | null;
}

/** nearest 的结果：无帧时两项都为 null；actualDt = frame.t − 请求 t（带符号）。 */
export interface NearestReviewFrame {
  frame: ReviewFrame | null;
  actualDt: number | null;
}

export interface ReviewBufferHealth {
  capacity: number;
  size: number;
  /** 因达到容量而被覆盖的最旧帧数（clear 的主动移除不计入）。 */
  dropped: number;
  full: boolean;
  /** 当前缓冲内出现过的 runId，升序；跨轮隔离查询用。 */
  runIds: number[];
  oldestT: number | null;
  newestT: number | null;
}

const REFERENCE_KINDS: readonly ReferenceKind[] = ["groundTruth", "external", "mahony", "none"];
const ESTIMATOR_IDS: readonly EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];
/**
 * `ObservationState` 的白名单副本。这里不 import observability：本模块只做数据契约，
 * 白名单本身用 `satisfies` 保证每个值都是合法的 `accelState/magState`。
 */
const OBSERVATION_STATES = [
  "applied",
  "accepted-not-applied",
  "rejected",
  "invalid",
  "disabled",
  "unrecorded",
  "not-applicable",
] as const satisfies readonly NonNullable<EstimatorTelemetry["accelState"]>[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(path: string, message: string): never {
  throw new TypeError(`ReviewFrame.${path}: ${message}`);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    bad(path, "must be a finite number");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") bad(path, "must be a boolean");
  return value;
}

function cloneV3(value: unknown, path: string): V3 {
  if (!Array.isArray(value) || value.length !== 3) {
    bad(path, "must be an array of exactly 3 numbers");
  }
  return [
    finiteNumber(value[0], `${path}[0]`),
    finiteNumber(value[1], `${path}[1]`),
    finiteNumber(value[2], `${path}[2]`),
  ];
}

function cloneQuat(value: unknown, path: string): Quat {
  if (!isRecord(value)) bad(path, "must be a quaternion object");
  return {
    w: finiteNumber(value.w, `${path}.w`),
    x: finiteNumber(value.x, `${path}.x`),
    y: finiteNumber(value.y, `${path}.y`),
    z: finiteNumber(value.z, `${path}.z`),
  };
}

function cloneReferenceKind(value: unknown): ReferenceKind {
  if (typeof value !== "string" || !(REFERENCE_KINDS as readonly string[]).includes(value)) {
    bad("truth.kind", `must be one of ${REFERENCE_KINDS.join(" / ")}`);
  }
  return value as ReferenceKind;
}

function cloneEstimatorId(value: unknown): EstimatorId {
  if (typeof value !== "string" || !(ESTIMATOR_IDS as readonly string[]).includes(value)) {
    bad("estimate.id", `must be one of ${ESTIMATOR_IDS.join(" / ")}`);
  }
  return value as EstimatorId;
}

/** 观测状态是有限枚举；非法值直接拒绝，避免 UI 把未知字符串当成已知状态。 */
function cloneObservationState(
  value: unknown,
  path: string,
): NonNullable<EstimatorTelemetry["accelState"]> {
  if (typeof value !== "string" || !(OBSERVATION_STATES as readonly string[]).includes(value)) {
    bad(path, `must be one of ${OBSERVATION_STATES.join(" / ")}`);
  }
  return value as NonNullable<EstimatorTelemetry["accelState"]>;
}

/** 原因码是开放的稳定字符串；`null` 表示“没有额外原因”，不能被折成 "null"。 */
function cloneReasonCode(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") bad(path, "must be a string or null");
  return value;
}

function cloneNullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function cloneImuSample(value: unknown, path: string): ImuSample {
  if (!isRecord(value)) bad(path, "must be an IMU sample object");
  const out: ImuSample = {
    gyro: cloneV3(value.gyro, `${path}.gyro`),
    accel: cloneV3(value.accel, `${path}.accel`),
    mag: cloneV3(value.mag, `${path}.mag`),
  };
  // times 只有真实存在时才复制；不存在表示透传快路径，不能补成当前时间。
  if (value.times !== undefined) {
    if (!isRecord(value.times)) bad(`${path}.times`, "must be an object when present");
    const times = value.times;
    out.times = {
      gyro: finiteNumber(times.gyro, `${path}.times.gyro`),
      accel: finiteNumber(times.accel, `${path}.times.accel`),
      mag: finiteNumber(times.mag, `${path}.times.mag`),
    };
  }
  return out;
}

function cloneDetail(value: unknown, path: string): Record<string, number> {
  if (!isRecord(value)) bad(path, "must be an object");
  const out: Record<string, number> = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item !== "number") bad(`${path}.${key}`, "must be a number");
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function cloneTelemetry(value: unknown): EstimatorTelemetry {
  if (!isRecord(value)) bad("telemetry", "must be an estimator telemetry object");
  const out: EstimatorTelemetry = {
    rate: cloneV3(value.rate, "telemetry.rate"),
    rawGyro: cloneV3(value.rawGyro, "telemetry.rawGyro"),
    correction: cloneV3(value.correction, "telemetry.correction"),
    predictedGravity: cloneV3(value.predictedGravity, "telemetry.predictedGravity"),
    measuredGravity: cloneV3(value.measuredGravity, "telemetry.measuredGravity"),
    accelNorm: finiteNumber(value.accelNorm, "telemetry.accelNorm"),
    accelValid: booleanValue(value.accelValid, "telemetry.accelValid"),
    magValid: booleanValue(value.magValid, "telemetry.magValid"),
    detail: cloneDetail(value.detail, "telemetry.detail"),
  };
  if (value.accelAccepted !== undefined) {
    out.accelAccepted = booleanValue(value.accelAccepted, "telemetry.accelAccepted");
  }
  if (value.magAccepted !== undefined) {
    out.magAccepted = booleanValue(value.magAccepted, "telemetry.magAccepted");
  }
  if (value.accelState !== undefined) {
    out.accelState = cloneObservationState(value.accelState, "telemetry.accelState");
  }
  if (value.magState !== undefined) {
    out.magState = cloneObservationState(value.magState, "telemetry.magState");
  }
  if (value.accelReasonCode !== undefined) {
    out.accelReasonCode = cloneReasonCode(value.accelReasonCode, "telemetry.accelReasonCode");
  }
  if (value.magReasonCode !== undefined) {
    out.magReasonCode = cloneReasonCode(value.magReasonCode, "telemetry.magReasonCode");
  }
  return out;
}

/** 只接受 JSON 形状的只读快照；F-07 的快照是纯数据 DTO。 */
function cloneOpaque(value: unknown, path: string, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "number" || kind === "string" || kind === "boolean") return value;
  if (kind !== "object") bad(path, `must be JSON-like data (got ${kind})`);
  const object = value as object;
  if (seen.has(object)) bad(path, "must not contain circular references");
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneOpaque(item, `${path}[${index}]`, seen));
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      Object.defineProperty(out, key, {
        value: cloneOpaque(source[key], `${path}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/**
 * 校验并深拷贝一帧。push / buildReviewFrame 共用同一条路径，
 * 因此手工构造的坏帧与 helper 漏字段的行为完全一致。
 */
function cloneFrame(value: unknown): ReviewFrame {
  if (!isRecord(value)) bad("frame", "must be an object");
  const runId = finiteNumber(value.runId, "runId");
  const seq = finiteNumber(value.seq, "seq");
  const t = finiteNumber(value.t, "t");

  if (!isRecord(value.truth)) bad("truth", "must be an object");
  const truthRaw = value.truth;
  const kind = cloneReferenceKind(truthRaw.kind);
  let truthQ: Quat | null = null;
  if (truthRaw.q !== null) {
    if (kind === "mahony" || kind === "none") {
      bad("truth.q", `must be null when kind is "${kind}"`);
    }
    truthQ = cloneQuat(truthRaw.q, "truth.q");
  }

  if (!isRecord(value.estimate)) bad("estimate", "must be an object");
  const estimateRaw = value.estimate;
  const estimateId = cloneEstimatorId(estimateRaw.id);
  const estimateQ = cloneQuat(estimateRaw.q, "estimate.q");

  if (!isRecord(value.input)) bad("input", "must be an object");
  const inputRaw = value.input;
  if (!isRecord(inputRaw.consumed)) bad("input.consumed", "must be an object");
  const consumedRaw = inputRaw.consumed;

  if (!isRecord(value.errors)) bad("errors", "must be an object");
  const errorsRaw = value.errors;

  const out: ReviewFrame = {
    runId,
    seq,
    t,
    truth: { kind, q: truthQ },
    estimate: { id: estimateId, q: estimateQ },
    input: {
      raw: cloneImuSample(inputRaw.raw, "input.raw"),
      consumed: {
        gyro: cloneV3(consumedRaw.gyro, "input.consumed.gyro"),
        accel: cloneV3(consumedRaw.accel, "input.consumed.accel"),
        mag: cloneV3(consumedRaw.mag, "input.consumed.mag"),
      },
    },
    telemetry: cloneTelemetry(value.telemetry),
    errors: {
      totalDeg: cloneNullableFinite(errorsRaw.totalDeg, "errors.totalDeg"),
      tiltDeg: cloneNullableFinite(errorsRaw.tiltDeg, "errors.tiltDeg"),
      yawDeg: cloneNullableFinite(errorsRaw.yawDeg, "errors.yawDeg"),
    },
  };

  if (value.eskf !== undefined) {
    out.eskf =
      value.eskf === null
        ? null
        : (cloneOpaque(value.eskf, "eskf") as KalmanStepSnapshot);
  }
  return out;
}

/**
 * 构造一帧回看数据（只建帧，不入队）。
 *
 * - truthKind 为 mahony / none 时 truthQ 一律置 null，调用方即使误传也不会产生真值幻影；
 * - 缺省误差用 null 表示，绝不折算成 0；
 * - ImuSample.times 只在来源存在时复制，不存在时不补字段。
 */
export function buildReviewFrame(input: BuildReviewFrameInput): ReviewFrame {
  const truthQ =
    input.truthKind === "mahony" || input.truthKind === "none" ? null : input.truthQ;
  return cloneFrame({
    runId: input.runId,
    seq: input.seq,
    t: input.t,
    truth: { kind: input.truthKind, q: truthQ },
    estimate: { id: input.estimateId, q: input.estimateQ },
    input: { raw: input.raw, consumed: input.consumed },
    telemetry: input.telemetry,
    errors: { totalDeg: input.totalDeg, tiltDeg: input.tiltDeg, yawDeg: input.yawDeg },
    ...(input.eskf !== undefined ? { eskf: input.eskf } : {}),
  });
}

function queryRunId(value: unknown, method: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`ReviewBuffer.${method}: runId must be a finite number`);
  }
  return value;
}

function timeBound(value: unknown, name: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`ReviewBuffer.list: ${name} must be a number (Infinity allowed)`);
  }
  return value;
}

/**
 * 定长环形缓冲。跨 runId 的帧可以共存在同一个物理缓冲里，但所有查询都按 runId 过滤；
 * reset() 后旧帧不再可读，因此新轮视图不可能混入上一轮。
 */
export class ReviewBuffer {
  readonly capacity: number;
  private readonly frames: (ReviewFrame | undefined)[];
  /** 最旧帧下标，也是下一次覆盖写入的位置。 */
  private head = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(capacity: number = DEFAULT_REVIEW_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("ReviewBuffer capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.frames = new Array<ReviewFrame | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * 入队。先校验并深拷贝，失败时缓冲保持原状。
   * 满容量时覆盖最旧帧并把 dropped 加一。
   */
  push(frame: ReviewFrame): void {
    const copy = cloneFrame(frame);
    if (this.count < this.capacity) {
      this.frames[(this.head + this.count) % this.capacity] = copy;
      this.count++;
      return;
    }
    this.frames[this.head] = copy;
    this.head = (this.head + 1) % this.capacity;
    this.droppedCount++;
  }

  /** 移除指定 runId 的全部帧，返回移除数量；其他 runId 的相对顺序不变。 */
  clear(runId: number): number {
    const id = queryRunId(runId, "clear");
    const kept: ReviewFrame[] = [];
    let removed = 0;
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAt(i);
      if (frame.runId === id) removed++;
      else kept.push(frame);
    }
    if (removed === 0) return 0;
    this.frames.fill(undefined);
    for (let i = 0; i < kept.length; i++) this.frames[i] = kept[i];
    this.head = 0;
    this.count = kept.length;
    return removed;
  }

  /** 清空全部帧与统计；旧 runId 从此不可读。 */
  reset(): void {
    this.frames.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.droppedCount = 0;
  }

  /** 指定 runId 中时间最新（同 t 取较大 seq）的帧；返回深拷贝。 */
  latest(runId: number): ReviewFrame | null {
    const id = queryRunId(runId, "latest");
    let best: ReviewFrame | null = null;
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAt(i);
      if (frame.runId !== id) continue;
      if (!best || frame.t > best.t || (frame.t === best.t && frame.seq >= best.seq)) {
        best = frame;
      }
    }
    return best ? cloneFrame(best) : null;
  }

  /**
   * 找指定 runId 中离 t 最近的帧。
   * actualDt = frame.t − t（秒，带符号）；超过容差时 frame 与 actualDt 都为 null。
   * 等距时优先更早帧（t 较小，其次 seq 较小），与事件时间轴的 nearest 口径一致。
   */
  nearest(
    runId: number,
    t: number,
    toleranceSec: number = DEFAULT_NEAREST_TOLERANCE_SEC,
  ): NearestReviewFrame {
    const id = queryRunId(runId, "nearest");
    if (typeof t !== "number" || !Number.isFinite(t)) {
      return { frame: null, actualDt: null };
    }
    if (typeof toleranceSec !== "number" || !Number.isFinite(toleranceSec) || toleranceSec < 0) {
      throw new RangeError("ReviewBuffer.nearest: toleranceSec must be a finite non-negative number");
    }

    let best: ReviewFrame | null = null;
    let bestAbs = Infinity;
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAt(i);
      if (frame.runId !== id) continue;
      const dt = Math.abs(frame.t - t);
      if (dt > toleranceSec) continue;
      if (
        best === null ||
        dt < bestAbs ||
        (dt === bestAbs && (frame.t < best.t || (frame.t === best.t && frame.seq < best.seq)))
      ) {
        best = frame;
        bestAbs = dt;
      }
    }
    if (!best) return { frame: null, actualDt: null };
    return { frame: cloneFrame(best), actualDt: best.t - t };
  }

  /**
   * 返回指定 runId 在 [fromT, toT] 内的帧，按数据时间升序、同时间按 seq 升序。
   * 默认全窗口；返回深拷贝，调用方可安全排序/标注。
   */
  list(runId: number, fromT: number = -Infinity, toT: number = Infinity): ReviewFrame[] {
    const id = queryRunId(runId, "list");
    const from = timeBound(fromT, "fromT");
    const to = timeBound(toT, "toT");
    const out: ReviewFrame[] = [];
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAt(i);
      if (frame.runId !== id) continue;
      if (frame.t < from || frame.t > to) continue;
      out.push(frame);
    }
    out.sort((a, b) => a.t - b.t || a.seq - b.seq);
    return out.map((frame) => cloneFrame(frame));
  }

  /** 只读资源/隔离状态；runIds 用于确认旧轮是否仍在缓冲中。 */
  health(): ReviewBufferHealth {
    const runIds = new Set<number>();
    let oldestT: number | null = null;
    let newestT: number | null = null;
    for (let i = 0; i < this.count; i++) {
      const frame = this.frameAt(i);
      runIds.add(frame.runId);
      if (oldestT === null || frame.t < oldestT) oldestT = frame.t;
      if (newestT === null || frame.t > newestT) newestT = frame.t;
    }
    return {
      capacity: this.capacity,
      size: this.count,
      dropped: this.droppedCount,
      full: this.count === this.capacity,
      runIds: [...runIds].sort((a, b) => a - b),
      oldestT,
      newestT,
    };
  }

  private frameAt(index: number): ReviewFrame {
    return this.frames[(this.head + index) % this.capacity] as ReviewFrame;
  }
}
