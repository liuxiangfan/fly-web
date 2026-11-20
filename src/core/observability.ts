/**
 * 观测可解释性与分轴误差（F-03 的纯基础层）。
 *
 * 这里只回答两个保守问题：
 * 1. 基于**现有遥测字段**，本步该通道处于什么状态（未适用／未启用／无效／被拒绝／未记录／已应用）；
 * 2. 给定明确的世界系相对真值四元数时，误差的倾角／偏航幅值是多少。
 *
 * 不根据误差大小、校准残差或单帧拒绝去推断传感器故障，也不对整体滤波器的长期
 * 观测能力下结论。`applied` 只由显式的 `accelAccepted/magAccepted === true` 或
 * 调用方明确提供的已应用证据支持；互补/Mahony/Madgwick 当前没有这类字段，
 * 因此使用 `unrecorded`，不把 `accelValid/magValid` 猜成“已修正”。
 */
import type { EstimatorTelemetry } from "../estimators";
import type { EstimatorId } from "./experiment-config";
import { DEG, type Quat, type V3 } from "./quat";

/**
 * B.5 的五个状态之外的显式扩展：
 * `unrecorded` 表示现有遥测没有记录“本步是否实际应用”，不能安全映射到
 * applied/rejected。它比编造一个状态更诚实，也避免 UI 把“观测有效”误读成“已修正”。
 */
export type ObservationState =
  | "not-applicable"
  | "disabled"
  | "invalid"
  | "rejected"
  /** 只有“已接受但确实没有执行更新”的生产语义存在时才使用；现有遥测不产生它 */
  | "accepted-not-applied"
  | "unrecorded"
  | "applied";

export interface ObservationEvidence {
  /** 加计模长（m/s²）；磁通道当前遥测没有模长字段，不填造 */
  norm?: number;
  /** 新息／对齐夹角（度），仅在遥测确有有限值时记录 */
  angleDeg?: number;
  /** 卡尔曼新息马氏距离，仅在遥测确有有限值时记录 */
  nis?: number;
  /** 门控阈值；角度门控为度，χ² 门控为无量纲阈值 */
  threshold?: number;
}

export interface ObservationExplanation {
  channel: "accel" | "mag";
  state: ObservationState;
  reasonCode: string | null;
  evidence: ObservationEvidence;
  explanationKey: string;
}

export type KalmanGateMode = "angle" | "mahalanobis";

export interface ObservationOptions {
  magEnabled: boolean;
  /** 仅对互补/Mahony/Madgwick 的加计门控生效；卡尔曼使用自己的门控 */
  gateEnabled: boolean;
  kalmanGateMode?: KalmanGateMode;
  /** 覆盖门控阈值：角度门控为度，χ² 门控为阈值；不传时用实现默认值 */
  threshold?: number;
  /**
   * 可选扩展：只有调用方明确提供世界系相对真值时才计算分轴误差。
   * 不传则结果不含 axisErrors；传 null 表示“无真值”，axisErrors 为 null。
   */
  relativeTruthQuat?: Quat | null;
  /** 世界重力轴，默认 NED 下 [0,0,1] */
  gravityWorld?: V3;
}

export interface AxisErrorView {
  /** 误差幅值，非负 */
  tiltDeg: number;
  /** 绕世界重力轴的误差幅值，非负 */
  yawDeg: number;
  /** 总转角（SO(3) 短弧角），非负 */
  totalDeg: number;
}

export interface TelemetryObservationView {
  accel: ObservationExplanation;
  mag: ObservationExplanation;
  axisErrors?: AxisErrorView | null;
}

/** 互补/Mahony/Madgwick 的方向门控默认阈值（与 estimators 内的 ACCEL_GATE_DEG 一致） */
export const FUSION_ACCEL_GATE_DEG = 20;
/** 卡尔曼默认新息夹角门控（与实现一致） */
export const KALMAN_ANGLE_GATE_DEG = 40;
/** χ² 三自由度 99% 分位（与实现一致） */
export const KALMAN_CHI2_GATE_THRESHOLD = 11.345;

function detailNumber(telemetry: EstimatorTelemetry, key: string): number | undefined {
  const value = telemetry.detail[key];
  return Number.isFinite(value) ? value : undefined;
}

function finiteOption(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function accelEvidence(telemetry: EstimatorTelemetry): ObservationEvidence {
  const evidence: ObservationEvidence = {};
  if (Number.isFinite(telemetry.accelNorm)) evidence.norm = telemetry.accelNorm;
  // 卡尔曼优先用更新前的新息角；其余算法只有 alignErrorDeg。
  const angle = detailNumber(telemetry, "innoAccelDeg") ?? detailNumber(telemetry, "alignErrorDeg");
  if (angle !== undefined) evidence.angleDeg = angle;
  const nis = detailNumber(telemetry, "nisAccel");
  if (nis !== undefined) evidence.nis = nis;
  return evidence;
}

function magEvidence(telemetry: EstimatorTelemetry): ObservationEvidence {
  const evidence: ObservationEvidence = {};
  const angle = detailNumber(telemetry, "innoMagDeg");
  if (angle !== undefined) evidence.angleDeg = angle;
  const nis = detailNumber(telemetry, "nisMag");
  if (nis !== undefined) evidence.nis = nis;
  return evidence;
}

function makeExplanation(
  channel: ObservationExplanation["channel"],
  state: ObservationState,
  reasonCode: string,
  evidence: ObservationEvidence = {},
  threshold?: number,
): ObservationExplanation {
  const copiedEvidence: ObservationEvidence = { ...evidence };
  if (threshold !== undefined && Number.isFinite(threshold)) copiedEvidence.threshold = threshold;
  return {
    channel,
    state,
    reasonCode,
    evidence: copiedEvidence,
    explanationKey: `obs.${channel}.${state}`,
  };
}

function kalmanMode(telemetry: EstimatorTelemetry, opts: ObservationOptions): KalmanGateMode {
  if (opts.kalmanGateMode === "angle" || opts.kalmanGateMode === "mahalanobis") return opts.kalmanGateMode;
  return detailNumber(telemetry, "kalmanGateMode") === 1 ? "mahalanobis" : "angle";
}

function kalmanThreshold(opts: ObservationOptions, mode: KalmanGateMode): number {
  const override = finiteOption(opts.threshold);
  if (override !== undefined) return override;
  return mode === "mahalanobis" ? KALMAN_CHI2_GATE_THRESHOLD : KALMAN_ANGLE_GATE_DEG;
}

function fusionThreshold(opts: ObservationOptions): number {
  return finiteOption(opts.threshold) ?? FUSION_ACCEL_GATE_DEG;
}

function explainFusionAccel(telemetry: EstimatorTelemetry, opts: ObservationOptions): ObservationExplanation {
  const evidence = accelEvidence(telemetry);
  if (telemetry.accelAccepted === true) {
    return makeExplanation("accel", "applied", "applied", evidence);
  }
  if (evidence.norm === undefined || evidence.norm <= 1e-6) {
    return makeExplanation("accel", "invalid", "accel-norm-zero", evidence);
  }
  // 模长异常是观测本身的事实，与门控是否开启无关；不能因为门控关闭就把它当成“未记录”。
  if (telemetry.accelValid === false) {
    return makeExplanation("accel", "invalid", "accel-norm-out-of-range", evidence);
  }
  const gateRejected = opts.gateEnabled && detailNumber(telemetry, "gateMode") === 1;
  if (gateRejected) {
    // 到这里没有 accelValid=false 的证据：按“有效观测被方向门控拒绝”处理。
    const threshold = fusionThreshold(opts);
    const angle = evidence.angleDeg;
    return makeExplanation(
      "accel",
      "rejected",
      angle !== undefined && angle >= threshold ? "gate-direction" : "gate-rejected",
      evidence,
      threshold,
    );
  }
  if (telemetry.accelAccepted === false) {
    return makeExplanation("accel", "rejected", "not-accepted", evidence);
  }
  // 门控放行（或门控关闭/启动 ramp 期间）且没有显式 applied 字段：不猜“已应用”。
  return makeExplanation("accel", "unrecorded", "not-recorded", evidence);
}

function fusionMagEvaluated(telemetry: EstimatorTelemetry, opts: ObservationOptions): boolean {
  if (!Number.isFinite(telemetry.accelNorm) || telemetry.accelNorm <= 1e-6) return false;
  // 现有实现把磁更新放在加计可用分支内部；门控拒绝时 magValid 恒 false，不能据此说磁测量退化。
  return !(opts.gateEnabled && detailNumber(telemetry, "gateMode") === 1);
}

function explainFusionMag(telemetry: EstimatorTelemetry, opts: ObservationOptions): ObservationExplanation {
  if (!opts.magEnabled) return makeExplanation("mag", "disabled", "mag-disabled");
  const evidence = magEvidence(telemetry);
  if (telemetry.magAccepted === true) {
    return makeExplanation("mag", "applied", "applied", evidence);
  }
  if (telemetry.magValid === false) {
    // 磁通道可能在加计分支内根本没被评估；此时 unrecorded，而不是“磁测量退化”。
    if (!fusionMagEvaluated(telemetry, opts)) {
      return makeExplanation("mag", "unrecorded", "mag-not-evaluated", evidence);
    }
    return makeExplanation("mag", "invalid", "mag-norm-out-of-range", evidence);
  }
  if (telemetry.magAccepted === false) {
    return makeExplanation("mag", "rejected", "not-accepted", evidence);
  }
  // magValid=true 只说明测量可信，不说明实际修正量非零（增益可能为 0），因此仍不标 applied。
  return makeExplanation("mag", "unrecorded", "not-recorded", evidence);
}

function explainKalmanAccel(telemetry: EstimatorTelemetry, opts: ObservationOptions): ObservationExplanation {
  const evidence = accelEvidence(telemetry);
  if (telemetry.accelAccepted === true) {
    return makeExplanation("accel", "applied", "applied", evidence);
  }
  if (telemetry.accelValid === false) {
    return makeExplanation("accel", "invalid", "accel-norm-out-of-range", evidence);
  }
  if (telemetry.accelAccepted === false) {
    const code = detailNumber(telemetry, "accelRejectCode");
    if (code === 1) return makeExplanation("accel", "invalid", "accel-norm-out-of-range", evidence);
    if (code === 4) return makeExplanation("accel", "rejected", "update-degenerate", evidence);
    if (code === 3) {
      return makeExplanation("accel", "rejected", "gate-mahalanobis", evidence, kalmanThreshold(opts, "mahalanobis"));
    }
    if (code === 2) {
      return makeExplanation("accel", "rejected", "gate-direction", evidence, kalmanThreshold(opts, "angle"));
    }
    if (kalmanMode(telemetry, opts) === "mahalanobis") {
      return makeExplanation("accel", "rejected", "gate-mahalanobis", evidence, kalmanThreshold(opts, "mahalanobis"));
    }
    return makeExplanation("accel", "rejected", "gate-direction", evidence, kalmanThreshold(opts, "angle"));
  }
  return makeExplanation("accel", "unrecorded", "not-recorded", evidence);
}

function explainKalmanMag(telemetry: EstimatorTelemetry, opts: ObservationOptions): ObservationExplanation {
  if (!opts.magEnabled) return makeExplanation("mag", "disabled", "mag-disabled");
  const evidence = magEvidence(telemetry);
  if (telemetry.magAccepted === true) {
    return makeExplanation("mag", "applied", "applied", evidence);
  }
  if (telemetry.magValid === false) {
    return makeExplanation("mag", "invalid", "mag-norm-out-of-range", evidence);
  }
  if (telemetry.magAccepted === false) {
    const code = detailNumber(telemetry, "magRejectCode");
    if (code === 5) return makeExplanation("mag", "rejected", "update-degenerate", evidence);
    if (code === 4) {
      return makeExplanation("mag", "rejected", "gate-mahalanobis", evidence, kalmanThreshold(opts, "mahalanobis"));
    }
    if (code === 3) {
      return makeExplanation("mag", "rejected", "gate-direction", evidence, kalmanThreshold(opts, "angle"));
    }
    if (code === 2) return makeExplanation("mag", "invalid", "mag-norm-out-of-range", evidence);
    // 遥测说“磁被禁用”但当前配置说启用：配置与遥测不一致，保守标 unrecorded。
    if (code === 1) return makeExplanation("mag", "unrecorded", "not-recorded", evidence);
    if (kalmanMode(telemetry, opts) === "mahalanobis") {
      return makeExplanation("mag", "rejected", "gate-mahalanobis", evidence, kalmanThreshold(opts, "mahalanobis"));
    }
    return makeExplanation("mag", "rejected", "gate-direction", evidence, kalmanThreshold(opts, "angle"));
  }
  return makeExplanation("mag", "unrecorded", "not-recorded", evidence);
}

/**
 * 由当前遥测解释加计／磁观测状态。
 *
 * 纯积分：两个通道都 `not-applicable`（不是 disabled/rejected）。
 * 卡尔曼：使用 `accelAccepted/magAccepted` 与拒绝码，能区分 applied/invalid/rejected/disabled。
 * 互补/Mahony/Madgwick：现有遥测没有本步“已应用”标志，除明确拒绝或明确无效外使用
 * `unrecorded`，不把 accelValid/magValid 猜成已修正。
 */
export function explainExistingTelemetry(
  estimatorId: EstimatorId,
  telemetry: EstimatorTelemetry,
  opts: ObservationOptions,
): TelemetryObservationView {
  let accel: ObservationExplanation;
  let mag: ObservationExplanation;
  if (estimatorId === "pure") {
    accel = makeExplanation("accel", "not-applicable", "no-correction-channel");
    mag = makeExplanation("mag", "not-applicable", "no-correction-channel");
  } else if (estimatorId === "kalman") {
    accel = explainKalmanAccel(telemetry, opts);
    mag = explainKalmanMag(telemetry, opts);
  } else {
    accel = explainFusionAccel(telemetry, opts);
    mag = explainFusionMag(telemetry, opts);
  }
  const view: TelemetryObservationView = { accel, mag };
  if (opts.relativeTruthQuat !== undefined) {
    view.axisErrors = axisErrorView(opts.relativeTruthQuat, opts.gravityWorld);
  }
  return view;
}

/**
 * SO(3) 分轴误差幅值。输入必须是**世界系**相对误差四元数 q_rel = q_truth ⊗ q_est⁻¹，
 * 世界重力轴固定 [0,0,1]。返回的 tilt/yaw 都是非负幅值，不擅自给方向符号。
 *
 * 公式与 core/runner.ts 的 so3ErrorSplit 保持同一数值口径（短弧 log 旋转向量，
 * 不用小角近似）。这里不直接 import runner：runner 会拖入完整实验内核，而本模块
 * 只应依赖 quat 与估计器遥测类型；契约测试会把两者在纯偏航、纯倾角、倾斜姿态与
 * 万向节锁邻域逐项对比。后续如需单一来源，可把公式上提到 core/so3.ts 再由两边复用。
 *
 * 无真值（null/undefined）、零模长、非有限四元数或无效重力轴均返回 null，
 * 不生成 0° 这种“看起来有结论”的假结果。
 */
export function axisErrorView(
  relativeTruthQuat: Quat | null | undefined,
  gravityWorld: V3 = [0, 0, 1],
): AxisErrorView | null {
  if (relativeTruthQuat === null || relativeTruthQuat === undefined) return null;
  const { w, x, y, z } = relativeTruthQuat;
  if (!Number.isFinite(w) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  const qn = Math.hypot(w, x, y, z);
  if (!(qn > 1e-15)) return null;
  if (
    !gravityWorld ||
    !Number.isFinite(gravityWorld[0]) ||
    !Number.isFinite(gravityWorld[1]) ||
    !Number.isFinite(gravityWorld[2])
  ) {
    return null;
  }
  const gn = Math.hypot(gravityWorld[0], gravityWorld[1], gravityWorld[2]);
  if (!(gn > 1e-15)) return null;

  const nw = w / qn;
  const nx = x / qn;
  const ny = y / qn;
  const nz = z / qn;
  const gx = gravityWorld[0] / gn;
  const gy = gravityWorld[1] / gn;
  const gz = gravityWorld[2] / gn;
  // q 与 −q 同姿态：先落到短弧，再取精确转角 2·atan2(|vec|, |w|)。
  const sign = nw < 0 ? -1 : 1;
  const vx = sign * nx;
  const vy = sign * ny;
  const vz = sign * nz;
  const vn = Math.hypot(vx, vy, vz);
  const theta = 2 * Math.atan2(vn, Math.abs(nw));
  if (!(vn > 1e-15)) return { tiltDeg: 0, yawDeg: 0, totalDeg: 0 };
  const ax = vx / vn;
  const ay = vy / vn;
  const az = vz / vn;
  const parallel = ax * gx + ay * gy + az * gz;
  const perpSq = Math.max(0, 1 - parallel * parallel);
  return {
    tiltDeg: theta * Math.sqrt(perpSq) * DEG,
    yawDeg: theta * Math.abs(parallel) * DEG,
    totalDeg: theta * DEG,
  };
}

/** 证据摘要的唯一实现：面板行与说明句都从这里取，避免两处格式漂移。 */
export function observationEvidenceText(evidence: ObservationEvidence): string {
  const parts: string[] = [];
  if (evidence.norm !== undefined) parts.push(`‖a‖=${evidence.norm.toFixed(2)} m/s²`);
  if (evidence.angleDeg !== undefined) parts.push(`夹角=${evidence.angleDeg.toFixed(2)}°`);
  if (evidence.nis !== undefined) parts.push(`NIS=${evidence.nis.toFixed(2)}`);
  if (evidence.threshold !== undefined) parts.push(`阈值=${evidence.threshold.toFixed(2)}`);
  return parts.join(" · ");
}

/** 说明句里的证据后缀（带全角括号）。 */
function evidenceSuffix(evidence: ObservationEvidence): string {
  const text = observationEvidenceText(evidence);
  return text ? `（${text.split(" · ").join("，")}）` : "";
}

/**
 * 保守中文说明。只描述本步状态与几何约束，不把单步拒绝写成整体系统结论，
 * 也不使用“系统不可观”这类超出当前证据的措辞。
 */
export function describeObservation(explanation: ObservationExplanation): string {
  const channel = explanation.channel === "accel" ? "加速度计" : "磁力计";
  let text: string;
  switch (explanation.state) {
    case "not-applicable":
      text = `${channel}通道不适用于当前算法；本步没有来自该通道的观测修正。`;
      break;
    case "disabled":
      text = `${channel}观测当前未启用；本步没有来自该通道的修正。`;
      break;
    case "invalid":
      // 门控关闭时无效观测仍可能被算法使用；这里只陈述观测无效，不替实现断言“未应用”。
      text = `${channel}观测本步无效（模长或数值异常）；不据此确认该通道修正已应用。`;
      break;
    case "rejected":
      text = `${channel}观测本步被门控拒绝；本步没有应用该通道修正。这是单步状态，不扩展到整体滤波器的长期结论。`;
      break;
    case "accepted-not-applied":
      text = `${channel}观测已被接受，但本步没有实际应用修正。`;
      break;
    case "unrecorded":
      text = `现有遥测未记录${channel}观测本步是否实际应用；不据此推断修正状态。`;
      break;
    case "applied":
      text = explanation.channel === "accel"
        ? "重力观测已应用：对倾角提供约束；绕重力轴的方向没有来自重力的直接信息。"
        : "磁观测已应用：对本步航向提供约束。";
      break;
    default:
      text = "未知观测状态；不作修正状态推断。";
      break;
  }
  return text + evidenceSuffix(explanation.evidence);
}
