/**
 * 校准「器件指纹」与失效提示（纯逻辑）。
 *
 * 为什么需要（第五轮复核的 P2）：标定是对**当时的器件误差模型**做的拟合。
 * 拟合之后如果用户改了交叉轴/非线性/噪声（或换了磁拟合模型），那份标定就基于旧模型——
 * 数值上仍然「能用」（不会报错），但它的残差与验证读数不再代表当前配置。
 * 此前只有「独立验证」能间接暴露这件事，而且用户得自己想到去点它。
 *
 * 这里做两件事：
 *  1. 记录拟合时的器件参数（随校准对象一起进档案，因此导入后仍能判断）；
 *  2. 给出可读的失效说明（只在真的不同时才说，避免制造噪音）。
 */
import type { ImuParams } from "./imu";
import type { MagCalModel } from "./experiment-config";

export interface CalibrationFingerprint {
  /** 拟合时刻（ISO 字符串，仅作展示） */
  at: string;
  /** 该标定关心的器件参数快照（加速度计部分） */
  crossAxis: number;
  nonlin: number;
  noise: number;
  /** 磁拟合模型（对角 / 完整椭球） */
  magModel?: MagCalModel;
  /** 磁拟合参数（快照）：这些变化同样会使旧标定不再匹配当前输入模型 */
  magNoise?: number;
  hardIron?: number;
  disturbMag?: number;
  magSoftIron?: number;
  magQuantUts?: number;
  /** 完整椭球拟合的目标场强（μT）：改变了它，标定后的绝对尺度会不同 */
  magTargetUts?: number;
}

/** 数值比较的容差：参数滑块步长是 0.1%，这里按 0.05% 判「实质变化」 */
const EPS = 5e-4;

function sameOrBothZero(a: number | undefined, b: number | undefined): boolean {
  const x = a ?? 0;
  const y = b ?? 0;
  return Math.abs(x - y) <= EPS * Math.max(1, Math.abs(x), Math.abs(y));
}

/** 由当前器件参数生成指纹 */
export function fingerprintOf(
  p: Partial<Pick<ImuParams, "accelCrossAxis" | "accelNonlin" | "accelNoise" | "magNoise" | "hardIron" | "disturbMag" | "magSoftIron" | "magQuantUts">>,
  magModel?: MagCalModel,
  now: Date = new Date(),
  magTargetUts?: number,
): CalibrationFingerprint {
  return {
    at: now.toISOString(),
    crossAxis: p.accelCrossAxis ?? 0,
    nonlin: p.accelNonlin ?? 0,
    noise: p.accelNoise ?? 0,
    ...(magModel ? { magModel } : {}),
    magNoise: p.magNoise ?? 0,
    hardIron: p.hardIron ?? 0,
    disturbMag: p.disturbMag ?? 0,
    magSoftIron: p.magSoftIron ?? 0,
    magQuantUts: p.magQuantUts ?? 0,
    ...(magTargetUts !== undefined && Number.isFinite(magTargetUts) ? { magTargetUts } : {}),
  };
}

/**
 * 标定是否已「过期」：返回一句人类可读的说明，或 null（仍然匹配）。
 * @param kind "accel" 只比器件交叉轴/非线性/噪声；"mag" 还会比拟合模型
 */
export function calibrationStaleness(
  fission: CalibrationFingerprint | undefined,
  current: Partial<Pick<ImuParams, "accelCrossAxis" | "accelNonlin" | "accelNoise" | "magNoise" | "hardIron" | "disturbMag" | "magSoftIron" | "magQuantUts">>,
  kind: "accel" | "mag",
  currentMagModel?: MagCalModel,
  currentMagTargetUts?: number,
): string | null {
  if (!fission) return null; // 旧档案/未记录：不猜
  const changed: string[] = [];
  if (!sameOrBothZero(fission.crossAxis, current.accelCrossAxis)) changed.push("交叉轴");
  if (!sameOrBothZero(fission.nonlin, current.accelNonlin)) changed.push("非线性");
  if (kind === "mag") {
    if (!sameOrBothZero(fission.magNoise, current.magNoise)) changed.push("磁噪声");
    if (!sameOrBothZero(fission.hardIron, current.hardIron)) changed.push("硬铁");
    if (!sameOrBothZero(fission.magSoftIron, current.magSoftIron)) changed.push("软铁");
    if (!sameOrBothZero(fission.disturbMag, current.disturbMag)) changed.push("交变干扰");
    if (!sameOrBothZero(fission.magQuantUts, current.magQuantUts)) changed.push("量化");
    if (fission.magTargetUts !== undefined && currentMagTargetUts !== undefined && Math.abs(fission.magTargetUts - currentMagTargetUts) > 0.1) {
      changed.push(`目标场强（${fission.magTargetUts.toFixed(1)} → ${currentMagTargetUts.toFixed(1)} μT）`);
    }
    if (currentMagModel && fission.magModel && fission.magModel !== currentMagModel) {
      changed.push(`拟合模型（标定时 ${fission.magModel === "full" ? "完整椭球" : "对角"}）`);
    }
  }
  if (!changed.length) return null;
  return `标定基于旧模型：此后改了${changed.join("、")}——残差与验证读数不再代表当前配置，建议重新采集拟合。`;
}

/** 是否为「实质的磁模型参数变化」：应用磁校准后（或新拟合了磁标定）才关心 */
export function magCalibrationRelevant(f: CalibrationFingerprint | undefined, currentMagModel?: MagCalModel): boolean {
  return f !== undefined && (f.magModel !== undefined || currentMagModel !== undefined);
}
