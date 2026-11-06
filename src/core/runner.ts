/**
 * 无 DOM 实验运行内核：浏览器在线仿真、批量评测、文档基准与离线复算共用同一条数值路径。
 *
 * 它只依赖 core/ 与 estimators/，不 import main.ts / Three.js / DOM。这样：
 *  - 批量评测不会复制一套简化算法；
 *  - Node 脚本可以在 CI 中复算文档数字；
 *  - 同一配置 + 同一 seed 的结果与在线模式一致。
 */
import { World } from "./world";
import { scenarios } from "./scenarios";
import { applyMagCalibration } from "./magcal";
import { applyAccelCalibration } from "./accelcal";
import { trueGyroBiasRad } from "./imu";
import { ErrorTracker, percentile } from "./stats";
import { mulberry32 } from "./rng";
import { SolveLoop } from "./solve-loop";
import { DEG, qAngleBetween, qConj, qMul, qToEuler, type Quat, type V3 } from "./quat";
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
  type Estimator,
} from "../estimators";
import {
  cloneExperimentConfig,
  initialAttitudeOf,
  type ExperimentConfig,
  type EstimatorId,
  type EstimatorTuning,
} from "./experiment-config";

import { TraceEvents } from "./trace-events";
export const RUN_HZ = 500;
export const RUN_H = 1 / RUN_HZ;
/** 详细运行（runExperimentDetailed）保留的误差序列上限：诊断用途，长跑同样封顶 */
export const SERIES_CAP = 200_000;

export interface EstimatorRunMetrics {
  id: EstimatorId;
  label: string;
  n: number;
  mean: number;
  rmse: number;
  max: number;
  p50: number;
  p95: number;
  /** 稳态窗口（末段 40%）RMSE：与全程 RMSE 分开，避免启动暂态主导均值 */
  steadyRmse: number;
  /** 稳态窗口实际起点（秒，相对运行起点）；= 末段 40% 的切点或配置的绝对起点 */
  steadyFromSec?: number;
  /** 分位数是否来自时间均匀子集（样本数超过 STATS_CAP 时为 true；短跑为 false/undefined） */
  percentileApprox?: boolean;
  /** 稳态窗口口径：exact = 逐样本精确累计；early-stop = 实际运行短于预定窗口 */
  steadyMode?: "exact" | "early-stop";
  /** 倾角（横滚+俯仰联合）RMS，度 */
  tiltRmse: number;
  /** 偏航 RMS，度（包裹 ±180°） */
  yawRmse: number;
  /** SO(3) 小角分解的倾角 RMS（垂直重力方向分量），度——不受欧拉奇点影响 */
  tiltSo3Rmse?: number;
  /** SO(3) 小角分解的偏航 RMS（绕重力轴分量），度 */
  yawSo3Rmse?: number;
  convergedAt: number | null;
  /** 观测被拒帧数（三家固定增益算法按 detail.gateMode 统计；卡尔曼不适用时为 0） */
  gateRejects: number;
  /** 卡尔曼专有：姿态 NEES 均值（仅仿真真值可用；其它算法为 NaN） */
  neesThetaMean?: number;
  /** 卡尔曼专有：零偏 NEES 均值 */
  neesBiasMean?: number;
  /** 卡尔曼专有：重力/磁观测 NIS 均值 */
  nisAccelMean?: number;
  nisMagMean?: number;
  /** 重力观测实际接受比例（%），衡量门控激进程度 */
  accelAcceptPct?: number;
}

export interface HeadlessRunResult {
  config: ExperimentConfig;
  /** 参与统计的样本时间窗（秒） */
  window: { startSec: number; endSec: number };
  metrics: EstimatorRunMetrics[];
  /** 本次运行使用的种子（Worker 聚合路径会补上；runTask 不填） */
  seed?: number;
  finalQuats: Record<EstimatorId, Quat>;
  events: RunEvent[];
  /** 本次运行为什么结束、各时间口径分别是什么（见 RunTermination） */
  termination: RunTermination;
}

/**
 * 显式的运行终止口径。
 *
 * 为什么要有它（复核 P2-1）：旧实现用「实际结束时间 < 预定 99%」来**猜**是否被提前取消，
 * 于是 1.1 s / 1 Hz 这种正常跑完的运行（最后一步解算落在 1.0 s）被误判成 early-stop，
 * 而真正被取消的运行只要窗口够长就看不出来。现在三个时间点各自记录，不再靠猜：
 *  · requestedEndSec —— 配置请求的时长；
 *  · endSec —— 世界实际推进到的时间；
 *  · lastSolveSec —— 最后一次估计器更新的时刻（抽帧解算时可能早于 endSec）；
 *  · pendingTailSec —— 两者之差：末尾"有世界推进但没解算"的尾巴。
 */
export interface RunTermination {
  reason: "completed" | "cancelled";
  requestedEndSec: number;
  endSec: number;
  /** 无估计器更新时为 null，不能用世界终点冒充一次解算。 */
  lastSolveSec: number | null;
  pendingTailSec: number;
  /** 触发取消的世界时刻（进度钩子或 shouldCancel；仅 reason="cancelled" 时有意义） */
  cancelledAtSec?: number;
}

export interface RunEvent {
  t: number;
  type: "align" | "gate-reject" | "gate-recovery" | "kalman-gate" | "numerical";
  estimator: EstimatorId | "all";
  detail?: string;
}

export interface RunHooks {
  /**
   * 每处理约 progressEverySec 秒调用一次；返回 false 可提前终止。
   * Worker 用它发心跳；异步路径另外在分片之间让出事件循环，才能实际接收入站 cancel。
   * 同步路径可在钩子里直接中止。
   */
  onProgress?: (t: number) => boolean | void;
  progressEverySec?: number;
  /** 每个世界步开始前检查，不依赖进度回调频率；true 表示取消。 */
  shouldCancel?: () => boolean;
  /** 积分循环已结束、指标收尾尚未开始；用于区分停止与 Promise 返回时点。 */
  onStop?: () => void;
  /** **自检专用**：覆盖 STATS_CAP，用来验证「样本截断不改变均值/稳态/分位数口径」 */
  statsCapOverride?: number;
}

const EST_IDS: EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];

/**
 * SO(3) 小角误差分解（比欧拉分解更稳健，万向节锁附近不会突变）。
 *
 * 坐标系约定：`relative` 是**世界系**误差四元数 q_rel = q_truth ⊗ q_est⁻¹
 * （误差本身发生在世界系；这与 ESKF 的 δθ 世界系约定一致）。
 * 于是 vec(q_rel) 就是误差轴在世界系的方向，可直接按**世界重力轴**拆成：
 *  - 倾角：垂直于重力方向的分量（重力投影错在哪，水平漂移就出在哪）；
 *  - 偏航：绕重力轴的分量（对水平位置无影响，但对航向有影响）。
 *
 * 注意与 runner 里常见写法的差别：若传 q_truth⁻¹⊗q_est（机体系误差），
 * 姿态一旦倾斜，「绕世界重力轴的偏航」会被误分成 tilt——复核时实测过这个 1.07° 的差异。
 */
export function so3ErrorSplit(relative: Quat, gravityWorld: V3 = [0, 0, 1]): { tiltDeg: number; yawDeg: number } {
  const gn = Math.hypot(gravityWorld[0], gravityWorld[1], gravityWorld[2]) || 1;
  const gx = gravityWorld[0] / gn, gy = gravityWorld[1] / gn, gz = gravityWorld[2] / gn;
  // 用 **log 旋转向量** r = θ·axis（θ ∈ [0, π]，取短弧），而不是 2·vec(q) 的小角近似：
  // 小角近似在 90° 时把 θ 低报 10%、180° 时报 114.6°（复核反例），
  // 而这里的指标会用于大偏差（例如初始偏差 40° 与粗对准前后的跳变）。
  const sign = relative.w < 0 ? -1 : 1; // q 与 −q 同姿态
  const vx = sign * relative.x, vy = sign * relative.y, vz = sign * relative.z;
  const vn = Math.hypot(vx, vy, vz);
  if (!(vn > 1e-15)) return { tiltDeg: 0, yawDeg: 0 };
  const theta = 2 * Math.atan2(vn, Math.abs(relative.w)); // 精确到 π（shortest arc）
  const ax = vx / vn, ay = vy / vn, az = vz / vn;
  const par = ax * gx + ay * gy + az * gz; // 绕重力轴的分量（单位轴上的投影）
  const perpSq = Math.max(0, 1 - par * par);
  return { tiltDeg: theta * Math.sqrt(perpSq) * DEG, yawDeg: theta * Math.abs(par) * DEG };
}

function makeEstimators(): Estimator[] {
  return [
    new PureGyroEstimator(),
    new ComplementaryEstimator(),
    new MahonyEstimator(),
    new MadgwickEstimator(),
    new KalmanEstimator(),
  ];
}

/** 把配置写入估计器（与 main.ts 的控件监听器做同样的事） */
export function applyTuning(e: Estimator, t: EstimatorTuning): void {
  e.magEnabled = t.magEnabled;
  e.setParams(t.params);
  if (e.id === "comp" || e.id === "mahony" || e.id === "madg") {
    const g = e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator;
    g.accelGate = t.accelGate;
    g.gateDeg = t.gateDeg;
    g.gateMagPct = t.gateMagPct;
    g.gateRecovery = t.gateRecovery;
    g.rampEnabled = t.rampEnabled;
  }
  if (e.id === "mahony" || e.id === "madg") {
    (e as MahonyEstimator | MadgwickEstimator).magMode = t.magMode;
  }
  if (e.id === "kalman") {
    const k = e as KalmanEstimator;
    if (t.kalmanGate) k.gateMode = t.kalmanGate;
    if (t.kalmanChi2 !== undefined) k.gateChi2 = t.kalmanChi2;
    if (t.kalmanResetCov !== undefined) k.resetCovOnInject = t.kalmanResetCov;
  }
}

/**
 * 有界统计上限：误差序列只在前 `STATS_CAP` 个样本上**逐点保存**（分位数/稳态窗口需要），
 * 超过之后改用定长蓄水池（reservoir，确定性抽样）近似分位数——**长时间运行内存不增长**。
 * 60 s @500 Hz 以内（教学与批量的实际用法）与旧实现**逐位一致**。
 */
export const STATS_CAP = 60_000;
/**
 * 分位数子集的**定长蓄水池**容量。
 *
 * 历史实现有两次错法：先是「按到达序号蓄水池」（时间分布不均），
 * 再是「每 0.1 s 取一个样本」（**固定相位**）——后者对周期信号会混叠：
 * 10 Hz 误差信号在 0.1 s 网格上永远采到同一个相位，65000 点的 P95 从 9.98° 掉到 1.25°（复核反例）。
 * 现在用 Algorithm R 随机替换（确定性 PRNG 播种）：
 *  - 容量固定 → 长跑内存封顶；
 *  - 每个样本等概率入池 → 不存在相位混叠；
 *  - 由 seed 派生 → 同一配置 + 同 seed 的分位数仍可复现。
 */
export const STATS_RESERVOIR_CAP = 20_000;

/**
 * 运行期误差跟踪（内存有界：均值/均方/峰值走增量累加，序列只留前 STATS_CAP 个样本）。
 *
 * **导出**是为了让永久测试直接驱动生产实现：复核 6.1 指出，此前那条「容器有界/分位数不混叠」
 * 用例自己在测试里复制了一份 Algorithm R，还给假 runner 填了 m.n 当"容量"——
 * 实现再退化也照样绿。现在测试直接 new 这个类喂周期信号、直接读容量诊断。
 */
export class MetricAccumulator {
  /** 前 STATS_CAP 个样本（分位数与稳态窗口用，**精确**）；超出后不再增长 */
  readonly errors: number[] = [];
  readonly times: number[] = [];
  /**
   * 定长蓄水池（Algorithm R，容量 STATS_RESERVOIR_CAP）：
   * 样本按到达顺序等概率入池，因此沿时间均匀且**没有固定相位**（不会混叠周期信号）。
   */
  private resErr: number[] = [];
  private resT: number[] = [];
  private resSeen = 0;
  private resRng: () => number;
  /** 稳态窗口的**精确**累计（切点在第一个样本处按预定窗口算好后固定，见 `steadyCutSec`） */
  private steadySq = 0;
  private steadyN = 0;
  private steadyCutSec = NaN;
  private seen = 0;
  /** 真实的首/末样本时刻（**不能**从 errors/times 取：截断后那只到第 cap 个样本） */
  private tFirst = NaN;
  /** 是否超过 STATS_CAP（`errors/times` 停止增长，分位数改用蓄水池） */
  truncated = false;
  /** 覆盖 STATS_CAP 的阈值（测试可注入更小的值来验证"截断不改变均值/稳态口径"） */
  private readonly cap: number;
  /**
   * 预定运行窗口的结束时刻（秒），来自配置的 durationSec。
   * 稳态切点必须在开跑前就能算出来，否则只能靠"末段比例"事后近似——
   * 那正是旧实现用整桶比例折算、把窗口外异常带进窗口的来源（复核反例 97.98°）。
   */
  private readonly plannedEndSec: number;
  private readonly steadyFromSec: number | null;

  // 增量累加（与逐点 reduce 的求和顺序一致，短跑结果逐位相同）
  private sum = 0;
  private sumSq = 0;
  private maxErr = -Infinity;
  private tiltSumSq = 0;
  private yawSumSq = 0;
  private tiltSo3SumSq = 0;
  private yawSo3SumSq = 0;
  private neesThetaSum = 0;
  private neesThetaN = 0;
  private neesBiasSum = 0;
  private nisAccelSum = 0;
  private nisAccelN = 0;
  private nisMagSum = 0;
  private nisMagN = 0;

  /** 只读诊断（测试与长跑巡检用）：容器当前长度与容量，实现里不参与任何计算 */
  diagnostics(): {
    cap: number;
    errors: number;
    times: number;
    reservoirCap: number;
    reservoirErr: number;
    reservoirT: number;
    truncated: boolean;
    steadyN: number;
  } {
    return {
      cap: this.cap,
      errors: this.errors.length,
      times: this.times.length,
      reservoirCap: STATS_RESERVOIR_CAP,
      reservoirErr: this.resErr.length,
      reservoirT: this.resT.length,
      truncated: this.truncated,
      steadyN: this.steadyN,
    };
  }

  readonly tracker = new ErrorTracker({ thresholdDeg: 2, holdSec: 1 });
  accelAccepted = 0;
  samples = 0;
  gateRejects = 0;

  constructor(opts: { capOverride?: number; plannedEndSec?: number; steadyFromSec?: number | null } = {}) {
    this.cap = opts.capOverride && opts.capOverride > 0 ? Math.floor(opts.capOverride) : STATS_CAP;
    this.plannedEndSec = Number.isFinite(opts.plannedEndSec) ? (opts.plannedEndSec as number) : NaN;
    this.steadyFromSec = opts.steadyFromSec ?? null;
    this.resRng = mulberry32(0x9e3779b9);
  }

  /** 蓄水池抽样用确定性 RNG（同 seed 的长跑分位数可复现） */
  setReservoirSeed(seed: number): void {
    this.resRng = mulberry32(seed >>> 0);
  }

  /**
   * @param errDeg 总姿态误差（测地角）
   * @param relative **世界系**误差四元数 q_truth ⊗ q_est⁻¹（见 so3ErrorSplit 的坐标系约定）。
   * @param gravityWorld 真值重力方向（世界系单位向量）
   */
  add(errDeg: number, relative: Quat, t: number, gravityWorld: V3 = [0, 0, 1]): void {
    const eu = qToEuler(relative);
    const tiltDeg = Math.hypot(eu.roll, eu.pitch) * DEG;
    const yawDeg = Math.abs(eu.yaw) * DEG;
    // 小角向量分解（与欧拉分解并列保留：前者做对照，后者是指标）
    const split = so3ErrorSplit(relative, gravityWorld);

    this.seen++;
    this.sum += errDeg;
    this.sumSq += errDeg * errDeg;
    if (errDeg > this.maxErr) this.maxErr = errDeg;
    this.tiltSumSq += tiltDeg * tiltDeg;
    this.yawSumSq += yawDeg * yawDeg;
    this.tiltSo3SumSq += split.tiltDeg * split.tiltDeg;
    this.yawSo3SumSq += split.yawDeg * split.yawDeg;

    if (!(this.seen > 1)) {
      this.tFirst = t;
    } else if (t < this.tFirst) {
      this.tFirst = t;
    }
    // 稳态窗口：切点在首个样本处按「预定窗口」固定，之后逐样本精确累计（无桶、无近似）
    if (!Number.isFinite(this.steadyCutSec)) {
      const plannedEnd = Number.isFinite(this.plannedEndSec) ? this.plannedEndSec : t;
      this.steadyCutSec =
        this.steadyFromSec !== null && Number.isFinite(this.steadyFromSec)
          ? Math.max(this.tFirst, this.steadyFromSec)
          : this.tFirst + (plannedEnd - this.tFirst) * 0.6;
    }
    if (t >= this.steadyCutSec) {
      this.steadySq += errDeg * errDeg;
      this.steadyN++;
    }
    // 定长蓄水池（Algorithm R）：第 i 个样本以 CAP/i 的概率替换某个槽位
    this.resSeen++;
    if (this.resErr.length < STATS_RESERVOIR_CAP) {
      this.resErr.push(errDeg);
      this.resT.push(t);
    } else {
      const j = Math.floor(this.resRng() * this.resSeen);
      if (j < STATS_RESERVOIR_CAP) {
        this.resErr[j] = errDeg;
        this.resT[j] = t;
      }
    }
    if (this.errors.length < this.cap) {
      this.errors.push(errDeg);
      this.times.push(t);
    } else {
      this.truncated = true;
    }
    this.tracker.add(errDeg, t);
    this.samples++;
  }

  /** 卡尔曼专用的均值类统计（只需要均值，不保留序列） */
  addNees(theta: number, bias: number): void {
    if (Number.isFinite(theta)) {
      this.neesThetaSum += theta;
      this.neesThetaN++;
      this.neesBiasSum += Number.isFinite(bias) ? bias : 0;
    }
  }
  addNis(accel: number, mag: number): void {
    if (Number.isFinite(accel)) {
      this.nisAccelSum += accel;
      this.nisAccelN++;
    }
    if (Number.isFinite(mag)) {
      this.nisMagSum += mag;
      this.nisMagN++;
    }
  }

  /**
   * @param completed 本次运行是否**跑满**了请求时长（由 runTask 的显式终止口径给出）。
   *   旧实现用「endT < 预定 99%」猜提前终止，会把正常跑完的短运行误判成 early-stop，
   *   也会漏掉真正的取消——这里改成由调用方明确告知。
   */
  summary(e: Estimator, _steadyFromSec?: number | null, completed = true): EstimatorRunMetrics {
    const n = this.seen;
    const mean = n ? this.sum / n : NaN;
    const rmse = n ? Math.sqrt(this.sumSq / n) : NaN;
    // 稳态窗口：切点在首个样本处按**预定窗口**算好后固定，累计过程逐样本精确
    // （不再有「整桶比例折算」——那会把窗口外的大误差带进来：复核反例 0° 被算成 97.98°）。
    const startT = Number.isFinite(this.tFirst) ? this.tFirst : this.times.length ? this.times[0] : 0;
    const cut = Number.isFinite(this.steadyCutSec) ? this.steadyCutSec : startT;
    const steadyRmse = this.steadyN > 0 ? Math.sqrt(this.steadySq / this.steadyN) : NaN;
    // 提前终止（用户取消/progress 钩子）会让实际窗口短于预定窗口：如实标注，不假装精确。
    // 判据来自显式的完成标志，而不是"时间够不够长"的阈值猜测。
    const earlyStopped = !completed;
    const rmsOf = (sumSq: number): number => (n ? Math.sqrt(sumSq / n) : NaN);
    const t = this.tracker.summary();
    return {
      id: e.id as EstimatorId,
      label: e.label,
      n,
      mean,
      rmse,
      max: n ? this.maxErr : NaN,
      // 短跑用全样本（精确）；长跑用定长蓄水池（等概率抽样，无相位混叠）
      p50: percentile(this.truncated ? this.resErr : this.errors, 0.5),
      p95: percentile(this.truncated ? this.resErr : this.errors, 0.95),
      steadyRmse,
      steadyFromSec: cut,
      /** 分位数是否来自定长蓄水池（样本数超过 STATS_CAP 时为 true） */
      percentileApprox: this.truncated,
      /** 稳态窗口口径：exact = 逐样本精确累计（预定切点），early-stop = 实际窗口短于预定窗口 */
      steadyMode: earlyStopped ? "early-stop" : "exact",
      tiltRmse: rmsOf(this.tiltSumSq),
      yawRmse: rmsOf(this.yawSumSq),
      tiltSo3Rmse: rmsOf(this.tiltSo3SumSq),
      yawSo3Rmse: rmsOf(this.yawSo3SumSq),
      convergedAt: t.convergedAt,
      gateRejects: this.gateRejects,
      ...(this.neesThetaN
        ? {
            neesThetaMean: this.neesThetaSum / this.neesThetaN,
            neesBiasMean: this.neesBiasSum / this.neesThetaN,
            nisAccelMean: this.nisAccelN ? this.nisAccelSum / this.nisAccelN : NaN,
            nisMagMean: this.nisMagN ? this.nisMagSum / this.nisMagN : NaN,
            accelAcceptPct: this.samples ? (this.accelAccepted / this.samples) * 100 : NaN,
          }
        : {}),
    };
  }
}

/**
 * 运行一次确定性实验。
 * @param config 配置（不会被修改）
 * @param hooks 进度/中止钩子；Web Worker、Node 脚本与 UI 都可注入
 */
export function runExperiment(configIn: ExperimentConfig, hooks: RunHooks = {}): HeadlessRunResult {
  return exhaustTask(runTask(configIn, hooks, false));
}

export interface AsyncRunHooks extends RunHooks {
  /** 每片世界步数，默认 128，硬上限 512；只改变调度，不改变数值路径。 */
  stepsPerSlice?: number;
  /** 每片墙钟计算预算；单个世界步不可抢占，最多超出一个步的耗时。 */
  maxSliceMs?: number;
  /** 调度观测与测试时钟，不参与数值内核。 */
  sliceClock?: () => number;
  onSlice?: (slice: { steps: number; computeMs: number; completed: boolean }) => void;
}

/** 真正让出 macrotask：Promise.resolve() 只清空微任务，收不到 Worker 入站消息。 */
const yieldToMessages = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** 同一 generator 的异步出口；每有限步交还事件循环，cancel 可在单种子中途生效。 */
export function runExperimentAsync(configIn: ExperimentConfig, hooks: AsyncRunHooks = {}): Promise<HeadlessRunResult> {
  return exhaustTaskAsync(runTask(configIn, hooks, false), hooks);
}

function exhaustTask<T>(task: Generator<void, T, void>): T {
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}

async function exhaustTaskAsync<T>(task: Generator<void, T, void>, hooks: AsyncRunHooks): Promise<T> {
  const budget = Number.isFinite(hooks.stepsPerSlice) ? Math.max(1, Math.min(512, Math.floor(hooks.stepsPerSlice!))) : 128;
  const timeBudget = Number.isFinite(hooks.maxSliceMs) ? Math.max(1, Math.min(16, hooks.maxSliceMs!)) : Infinity;
  const clock = hooks.sliceClock ?? (() => performance.now());
  // start 后立即 cancel（含只需一片的短任务）也应有一次入站处理机会。
  await yieldToMessages();
  for (;;) {
    const started = clock();
    let steps = 0;
    do {
      const step = task.next();
      steps++;
      if (step.done) {
        hooks.onSlice?.({ steps, computeMs: clock() - started, completed: true });
        return step.value;
      }
    } while (steps < budget && clock() - started < timeBudget);
    hooks.onSlice?.({ steps, computeMs: clock() - started, completed: false });
    await yieldToMessages();
  }
}

/** 仅非整步末尾缩短 h；整步时长继续用原 RUN_H，保持默认/golden 的逐位路径。 */
function runStepSize(step: number, totalSteps: number, durationSec: number, currentSec: number): number {
  if (step + 1 < totalSteps) return RUN_H;
  const remainder = durationSec - (totalSteps - 1) * RUN_H;
  if (Math.abs(remainder - RUN_H) <= Number.EPSILON * Math.max(1, durationSec) * 8) return RUN_H;
  return Math.max(0, Math.min(RUN_H, durationSec - currentSec));
}

/**
 * **逐帧 trace**：每一步（该步发生了估计器更新时）记录时间与五算法姿态。
 * 与 `ErrorSeries` 的区别：这里给出姿态本身与事件流，因此能比较「中间过程」，
 * 而不只是终点——前面的「golden trace」只比 finalQuats，任何中途偏差都会被末态掩盖。
 */
export interface TraceStep {
  t: number;
  /** 本步估计器使用的时间步长（秒） */
  dt: number;
  /** 五算法姿态（按 EST_IDS 顺序） */
  quats: Quat[];
  /**
   * **本步**是否发生了静止粗对准。
   *
   * 旧实现在 onAlign 里给"上一步"打标记，于是实际 3.002 s 的对准被标在 3.000 s 那帧上
   * （复核 P2-4）。现在直接用 onSolve 带来的 `aligned`（与 `step()` 内部的检测结果同源）。
   */
  aligned: boolean;
  /** 本步的**源**读数（校准链之前） */
  raw: { gyro: V3; accel: V3; mag: V3 };
  /** 本步算法真正吃到的观测（校准后）：raw 与它的差别就是校准链做了什么 */
  consumed: { accel: V3; mag: V3 };
}

export interface TraceResult {
  steps: TraceStep[];
  /** 事件计数（按类型），用于核对调度语义而不只是数值 */
  eventCounts: Record<string, number>;
  /** 每次静止粗对准发生的时刻（秒）：用来核验 `aligned` 标在**正确的那一步**上 */
  alignTimes: number[];
  /**
   * **被记录下来的**最后时刻（秒）。
   *
   * 截断时它短于配置时长：旧实现无论是否被 maxSteps 截断都返回 world.t，
   * 于是「截断的 steps + 全时长 endSec + 全程事件计数」混在一起，外部按 endSec
   * 去核 schedule 会得到一个根本不存在的完整轨迹（复核 E）。
   */
  endSec: number;
  /** 配置要求的完整时长（秒）：`truncated` 为真时用来对照 */
  fullDurationSec: number;
  /** 是否因为 maxSteps 上限而提前停止（事件计数与 steps 都只覆盖到 endSec） */
  truncated: boolean;
  /** 五算法 id（按 steps[].quats 的顺序）——比较器据此校验列数与身份 */
  estimatorIds: string[];
}

/** 跑一次并返回逐帧 trace（步数上限保护，避免长跑把内存吃满） */
export function runTrace(
  configIn: ExperimentConfig,
  maxStepsIn = 20000,
): TraceResult {
  // 上限参数必须是非负安全整数：NaN 会让 `steps.length >= maxSteps` 永远为假（等于没有上限），
  // 1.5 会多记一步。非法值回落到默认上限，而不是悄悄取消保护。
  const maxSteps = Number.isFinite(maxStepsIn) && maxStepsIn >= 1 ? Math.floor(maxStepsIn) : 20000;
  const config = cloneExperimentConfig(configIn);
  const world = new World(scenarios[config.scenario] ?? scenarios.hover, config.seed);
  if (config.manualTargetDeg) world.setManualTarget(config.manualTargetDeg);
  const ests = makeEstimators();
  for (const e of ests) applyTuning(e, config.estimators[e.id as EstimatorId]);
  const q0 = initialAttitudeOf(config);
  for (const e of ests) e.reset(q0);

  const steps: TraceStep[] = [];
  const traceEvents = new TraceEvents();
  const { eventCounts, alignTimes } = traceEvents;
  const loop = new SolveLoop({
    estimators: ests,
    solveRateHz: config.solveRateHz,
    calibrate: {
      mag: (raw) => applyMagCalibration(raw, config.magCalibrationApplied ? config.magCalibration : null),
      accel: (raw) => applyAccelCalibration(raw, config.accelCalibrationApplied ? config.accelCalibration ?? null : null),
    },
    magEnabled: config.estimators.comp.magEnabled,
    autoCoarseAlign: config.autoCoarseAlign !== false,
    // 上限之后**不再记步、也不再计事件**：否则 alignTimes/事件计数会覆盖到 steps 里
    // 根本不存在的时刻，与「逐帧对齐」的契约自相矛盾。
    onAlign: (ev) => { if (steps.length < maxSteps) traceEvents.align(ev.t); },
    onSolve: ({ t, dt, sample, accel, mag, aligned }) => {
      if (steps.length >= maxSteps) return;
      steps.push({
        t,
        dt,
        quats: ests.map((e) => ({ ...e.q })),
        aligned,
        raw: { gyro: [...sample.gyro] as V3, accel: [...sample.accel] as V3, mag: [...sample.mag] as V3 },
        consumed: { accel: [...accel] as V3, mag: [...mag] as V3 },
      });
      traceEvents.solve(ests);
    },
  });
  const totalSteps = Math.ceil(config.durationSec / RUN_H);
  for (let step = 0; step < totalSteps; step++) {
    if (steps.length >= maxSteps) break; // 到上限就停：不再空跑，endSec 才是真实记录终点
    const h = runStepSize(step, totalSteps, config.durationSec, world.t);
    const sample = world.step(h, config.imu);
    loop.step(sample, h, world.t);
  }
  const truncated = steps.length >= maxSteps && world.t < config.durationSec - 1e-9;
  return {
    steps, eventCounts, alignTimes,
    endSec: world.t,
    fullDurationSec: config.durationSec,
    truncated,
    estimatorIds: ests.map((e) => e.id),
  };
}

/** 单种子结果里各算法的姿态误差时间序列（供曲线叠加、诊断） */
export interface ErrorSeries {
  id: EstimatorId;
  label: string;
  t: number[];
  errDeg: number[];
}

/** 保留完整误差序列的详细运行（批量评测不用，交互诊断时才用） */
export function runExperimentDetailed(
  configIn: ExperimentConfig,
  hooks: RunHooks = {},
): HeadlessRunResult & { series: ErrorSeries[] } {
  return exhaustTask(runTask(configIn, hooks, true));
}

/** 详细异步出口与同步详细出口使用同一序列/事件累计，可用于逐点契约检查。 */
export function runExperimentDetailedAsync(
  configIn: ExperimentConfig,
  hooks: AsyncRunHooks = {},
): Promise<HeadlessRunResult & { series: ErrorSeries[] }> {
  return exhaustTaskAsync(runTask(configIn, hooks, true), hooks);
}

/**
 * 唯一的运行内核：同步出口耗尽 generator，异步出口有限步后让出事件循环。
 * 任何语义改动（粗对准、稳态窗口、SO(3) 误差分解、校准链）都只需在这里改一次。
 */
function runTask(
  configIn: ExperimentConfig,
  hooks: RunHooks,
  keepSeries: false,
): Generator<void, HeadlessRunResult, void>;
function runTask(
  configIn: ExperimentConfig,
  hooks: RunHooks,
  keepSeries: true,
): Generator<void, HeadlessRunResult & { series: ErrorSeries[] }, void>;
function* runTask(
  configIn: ExperimentConfig,
  hooks: RunHooks,
  keepSeries: boolean,
): Generator<void, HeadlessRunResult & { series?: ErrorSeries[] }, void> {
  const config = cloneExperimentConfig(configIn);
  const world = new World(scenarios[config.scenario] ?? scenarios.hover, config.seed);
  // 手动剧本的目标角来自配置（不是全局可变对象）——否则「同配置同 seed」并不可复现
  if (config.manualTargetDeg) world.setManualTarget(config.manualTargetDeg);
  const ests = makeEstimators();
  for (const e of ests) applyTuning(e, config.estimators[e.id as EstimatorId]);
  const q0 = initialAttitudeOf(config);
  for (const e of ests) e.reset(q0);

  // statsCapOverride 只给自检用：注入更小的上限即可验证「截断不改变均值/稳态口径」
  const acc: MetricAccumulator[] = ests.map(() => {
    const a = new MetricAccumulator({
      capOverride: hooks.statsCapOverride,
      plannedEndSec: config.durationSec,
      steadyFromSec: config.steadyFromSec ?? null,
    });
    a.setReservoirSeed((config.seed ^ 0x9e3779b9) >>> 0);
    return a;
  });
  const series: ErrorSeries[] | null = keepSeries
    ? ests.map((e) => ({ id: e.id as EstimatorId, label: e.label, t: [], errDeg: [] }))
    : null;
  const events: RunEvent[] = [];
  /** 最后一次估计器更新的时刻（抽帧解算时可能早于世界结束时间） */
  let lastSolve: number | null = null;
  // 解算调度与静止粗对准与界面**共用同一份实现**（core/solve-loop.ts）：
  // 任何阈值、检查顺序、冷却时长的差异都在这一处被消除，
  // 「批量结论能否代表界面」才有可验证的前提（冒烟里用同 seed 逐帧比对）。
  const loop = new SolveLoop({
    estimators: ests,
    solveRateHz: config.solveRateHz,
    calibrate: {
      // 「拟合得到一份标定」与「应用这份标定」是两个独立状态：
      // 只取消勾选「应用」时，批量必须与界面一样吃原始读数，而不是照常校准。
      mag: (raw) => applyMagCalibration(raw, config.magCalibrationApplied ? config.magCalibration : null),
      accel: (raw) => applyAccelCalibration(raw, config.accelCalibrationApplied ? config.accelCalibration ?? null : null),
    },
    magEnabled: config.estimators.comp.magEnabled,
    autoCoarseAlign: config.autoCoarseAlign !== false,
    onAlign: (ev) => {
      events.push({
        t: ev.t,
        type: "align",
        estimator: "all",
        detail: `静止粗对准：重置 ${ev.maxErrDeg.toFixed(1)}° 偏差`,
      });
    },
    onSolve: ({ t }) => {
      lastSolve = t;
      for (let i = 0; i < ests.length; i++) {
        const e = ests[i];
        const err = qAngleBetween(e.q, world.q) * DEG;
        // SO(3) 分解在世界系做：误差四元数 = q_truth ⊗ q_est⁻¹（误差发生在世界系）
        const rel = qMul(world.q, qConj(e.q));
        acc[i].add(err, rel, t);
        if (e.id === "kalman") {
          const k = e as KalmanEstimator;
          const ne = k.neesAgainst(world.q, trueGyroBiasRad(config.imu, world.gyroWalk));
          acc[i].addNees(ne.theta, ne.bias);
          const d = e.telemetry.detail;
          acc[i].addNis(d.nisAccel, d.nisMag);
          if (e.telemetry.accelAccepted) acc[i].accelAccepted++;
        }
        const gm = e.telemetry.detail.gateMode;
        if (gm === 1) {
          acc[i].gateRejects++;
          if (acc[i].gateRejects === 1 || acc[i].gateRejects % 50 === 0) {
            events.push({ t, type: "gate-reject", estimator: e.id as EstimatorId });
          }
        } else if (gm === 2 && ((acc[i].gateRejects + 1) % 50 === 0)) {
          events.push({ t, type: "gate-recovery", estimator: e.id as EstimatorId });
        }
        if (series && series[i].t.length < SERIES_CAP) {
          series[i].t.push(t);
          series[i].errDeg.push(err);
        }
      }
    },
  });
  let nextProgress = 0;
  const every = Math.max(1, hooks.progressEverySec ?? 5);

  const totalSteps = Math.ceil(config.durationSec / RUN_H);
  let cancelledAtSec: number | null = null;
  for (let step = 0; step < totalSteps; step++) {
    if (hooks.shouldCancel?.()) {
      cancelledAtSec = world.t;
      break;
    }
    const h = runStepSize(step, totalSteps, config.durationSec, world.t);
    const sample = world.step(h, config.imu);
    loop.step(sample, h, world.t);
    if (world.t >= nextProgress) {
      nextProgress += every;
      if (hooks.onProgress?.(world.t) === false) {
        cancelledAtSec = world.t; // 显式记录：不再靠"时间不够长"去猜
        break;
      }
    }
    yield;
  }
  // 最后一个步后的让出也可能收到取消，不把末片取消记成正常完成。
  if (cancelledAtSec === null && hooks.shouldCancel?.()) cancelledAtSec = world.t;
  hooks.onStop?.();

  // 终止口径：请求时长 / 实际结束 / 最后一次解算 / 尾巴长度，四项分开报（复核 P2-1）
  const lastSolveSec = lastSolve;
  const termination: RunTermination = {
    reason: cancelledAtSec === null ? "completed" : "cancelled",
    requestedEndSec: config.durationSec,
    endSec: world.t,
    lastSolveSec,
    pendingTailSec: Math.max(0, world.t - (lastSolveSec ?? 0)),
    ...(cancelledAtSec === null ? {} : { cancelledAtSec }),
  };

  const finalQuats = {} as Record<EstimatorId, Quat>;
  const metrics: EstimatorRunMetrics[] = [];
  ests.forEach((e, i) => {
    finalQuats[e.id as EstimatorId] = { ...e.q };
    metrics.push(acc[i].summary(e, config.steadyFromSec, termination.reason === "completed"));
  });

  const base: HeadlessRunResult = {
    config,
    window: { startSec: 0, endSec: world.t },
    metrics,
    finalQuats,
    events,
    termination,
  };
  return series ? { ...base, series } : base;
}

/** 确定性种子序列：同一 baseSeed 永远得到同一批种子，便于配对比较 */
export function seedSequence(baseSeed: number, count: number): number[] {
  const out: number[] = [];
  let x = baseSeed >>> 0;
  for (let i = 0; i < count; i++) {
    // splitmix32：雪崩好，实现短，适合生成互不相关的实验种子
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    out.push((z ^ (z >>> 15)) >>> 0);
  }
  return out;
}

export interface BatchEstimatorSummary {
  id: EstimatorId;
  label: string;
  runs: number;
  /** 每个 seed 的全程 RMSE 分布（度） */
  rmseP50: number;
  rmseP95: number;
  rmseMean: number;
  /** 每个 seed 的稳态（末段 40%）RMSE 分布（度） */
  steadyRmseP50: number;
  steadyRmseP95: number;
  /** 单次运行中从未收敛的比例（convergedAt===null） */
  nonConvergedPct: number;
  /** 跨种子的单次倾斜/偏航 RMS 的 P95（不再用「最大单次 RMS」冒充分布） */
  tiltRmseP95: number;
  yawRmseP95: number;
  /** SO(3) 小角分解的倾角/偏航 P95（不受欧拉奇点影响，推荐用它看分量） */
  tiltSo3P95?: number;
  yawSo3P95?: number;
}

export interface BatchResult {
  config: ExperimentConfig;
  seeds: number[];
  runs: HeadlessRunResult[];
  summary: BatchEstimatorSummary[];
  /**
   * 是否有任何一次运行进入了近似口径（样本数 > STATS_CAP → 分位数用时间均匀子集、稳态走时间分桶）。
   * 批量档最长 30 s @500 Hz = 15000 样本，正常永远是 false；存在这个字段是为了让
   * 用户用公开 API 跑长时长时**能看见**口径变化，而不是默默变成近似值。
   */
  approximate: boolean;
}

export interface BatchOptions extends RunHooks {
  /** 进度：已完成次数 / 总次数 */
  onBatchProgress?: (done: number, total: number) => void;
}

/** 把已完成的 runs 聚合成批量摘要（主程序分片执行时复用；保证与 runMonteCarlo 同口径） */
export function summarizeRuns(
  config: ExperimentConfig,
  seeds: number[],
  runs: HeadlessRunResult[],
): BatchResult {
  const summary: BatchEstimatorSummary[] = EST_IDS.map((id) => {
    const rs = runs.map((r) => r.metrics.find((m) => m.id === id)!).filter(Boolean);
    const rmse = rs.map((m) => m.rmse);
    const steady = rs.map((m) => m.steadyRmse);
    const tilt = rs.map((m) => m.tiltRmse);
    const yaw = rs.map((m) => m.yawRmse);
    const tiltSo3 = rs.map((m) => m.tiltSo3Rmse ?? NaN);
    const yawSo3 = rs.map((m) => m.yawSo3Rmse ?? NaN);
    return {
      id,
      label: rs[0]?.label ?? id,
      runs: rs.length,
      rmseP50: percentile(rmse, 0.5),
      rmseP95: percentile(rmse, 0.95),
      rmseMean: rmse.length ? rmse.reduce((a, b) => a + b, 0) / rmse.length : NaN,
      steadyRmseP50: percentile(steady, 0.5),
      steadyRmseP95: percentile(steady, 0.95),
      nonConvergedPct: rs.length ? (rs.filter((m) => m.convergedAt === null).length / rs.length) * 100 : NaN,
      tiltRmseP95: percentile(tilt, 0.95),
      yawRmseP95: percentile(yaw, 0.95),
      tiltSo3P95: percentile(tiltSo3, 0.95),
      yawSo3P95: percentile(yawSo3, 0.95),
    };
  });
  const approximate = runs.some((r) => r.metrics.some((m) => m.percentileApprox === true));
  return { config, seeds, runs, summary, approximate };
}

/**
 * 由「每次运行的指标表」直接聚合（Worker 路径用）：
 * 与 `summarizeRuns` 同一口径，只是不需要把完整 HeadlessRunResult 传回主线程。
 */
export function summarizeMetricsLists(
  config: ExperimentConfig,
  seeds: number[],
  metricsList: EstimatorRunMetrics[][],
): BatchResult {
  const runs: HeadlessRunResult[] = metricsList.map((metrics, i) => ({
    config,
    window: { startSec: 0, endSec: config.durationSec },
    metrics,
    finalQuats: {} as Record<EstimatorId, Quat>,
    events: [],
    seed: seeds[i],
    termination: {
      reason: "completed" as const,
      requestedEndSec: config.durationSec,
      endSec: config.durationSec,
      lastSolveSec: config.durationSec,
      pendingTailSec: 0,
    },
  }));
  return summarizeRuns(config, seeds.slice(0, runs.length), runs);
}

/** 多种子配对批量评测：每个 seed 下五种算法吃完全相同的输入 */
export function runMonteCarlo(configIn: ExperimentConfig, count: number, opts: BatchOptions = {}): BatchResult {
  const config = cloneExperimentConfig(configIn);
  const n = Math.max(1, Math.min(200, Math.floor(count)));
  const seeds = seedSequence(config.seed, n);
  const runs: HeadlessRunResult[] = [];
  for (let i = 0; i < seeds.length; i++) {
    if (opts.onProgress?.(i) === false) break;
    runs.push(runExperiment({ ...config, seed: seeds[i] }, opts));
    opts.onBatchProgress?.(i + 1, seeds.length);
  }
  return summarizeRuns(config, seeds.slice(0, runs.length), runs);
}

/** 供自检/工具：把结果压成稳定 JSON（配置进 hash，seed 固定，数字保留 6 位） */
export function resultDigest(r: HeadlessRunResult): string {
  const round = (v: number): number => (Number.isFinite(v) ? Number(v.toFixed(6)) : NaN);
  return JSON.stringify({
    config: r.config,
    metrics: r.metrics.map((m) => ({ ...m, mean: round(m.mean), rmse: round(m.rmse), p95: round(m.p95) })),
  });
}
