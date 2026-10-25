import type { Quat, V3 } from "./quat";
import { qRotInv } from "./quat";
import { Gauss } from "./rng";

export const G_ACC = 9.80665;

export interface ImuParams {
  /** 陀螺恒定零偏（°/s），作用在 [1, -0.7, 0.5] 归一化方向上 */
  gyroBiasDps: number;
  /** 陀螺白噪声 σ（°/s，每采样点） */
  gyroNoiseDps: number;
  /** 陀螺零偏随机游走 σ（°/s/√s）——由 World 持有游走状态并每步注入；0 = 关闭（不消耗随机数） */
  gyroWalkDps: number;
  /** 加计白噪声 σ（m/s²） */
  accelNoise: number;
  /** 加计交叉轴敏感度（0..0.1）：每轴混入另外两轴各 k·a 的读数（MPU-9250 规格 ±2%）。0 = 关闭 */
  accelCrossAxis: number;
  /** 加计非线性（0..0.1）：偏离 1g 的二次压缩 a·(1 − k·(|a|/g − 1)²)（MPU-9250 规格 ±0.5%）。0 = 关闭 */
  accelNonlin: number;
  /** 机动线加速度幅值（m/s²），由剧本的 accelFactor 加权 */
  linAccel: number;
  /** 电机振动强度 0..1 */
  vibration: number;
  /** 磁力计白噪声 σ（μT）。默认 0：磁链整体关闭，噪声序列与旧版逐位一致 */
  magNoise: number;
  /** 磁力计量化步长（μT，AK8963 = 0.6）。0 = 关闭（确定性取整，不消耗随机数） */
  magQuantUts: number;
  /** 硬铁偏移 |B|（0..1，沿机体系 [0.3, -0.2, 0.8] 方向叠加恒定偏移），模拟安装金属 */
  hardIron: number;
  /** 交变磁干扰强度 0..1（叠加在 x/y 分量的低频正弦，模拟电机通电磁场） */
  disturbMag: number;
}

export interface ImuSample {
  /** 陀螺仪：机体系角速度 + 零偏 + 噪声（rad/s） */
  gyro: V3;
  /** 加速度计：重力方向投影 + 机动线加速度 + 振动 + 噪声（m/s²） */
  accel: V3;
  /** 磁力计：世界磁场在机体系的投影 + 硬铁/干扰/噪声（μT） */
  mag: V3;
}

/**
 * 世界系磁场（NED，μT 量级）：北向分量 + 向下分量（磁倾角约 49° 的简化）。
 * 常量：偏航参考就在水平分量上，MARG 解算用它约束 yaw。
 */
export const MAG_WORLD_NED: V3 = (() => {
  const B = 50; // 总场强 μT
  const dip = 49 * (Math.PI / 180); // 磁倾角
  return [B * Math.cos(dip), 0, B * Math.sin(dip)];
})();

const HARD_IRON_DIR: V3 = (() => {
  const n = Math.hypot(0.3, -0.2, 0.8);
  return [0.3 / n, -0.2 / n, 0.8 / n];
})();

const BIAS_DIR: V3 = (() => {
  const n = Math.hypot(1, -0.7, 0.5);
  return [1 / n, -0.7 / n, 0.5 / n];
})();

/**
 * 由真实姿态与角速度生成模拟 IMU 输出。
 * 加计约定：静止时输出 +g 沿机体系「下」方向（即重力在机体系的投影）。
 * gyroWalkState：陀螺零偏随机游走的累积状态（°/s，三轴），由 World 持有并在每步
 * 先推进再传入——walkDps=0 时完全不动、不消耗随机数，既有噪声序列逐位不变。
 */
export function simulateImu(
  q: Quat,
  omegaTrue: V3,
  t: number,
  p: ImuParams,
  gauss: Gauss,
  accelFactor: number,
  gyroWalkState?: V3,
): ImuSample {
  const gBody = qRotInv(q, [0, 0, G_ACC]);

  const lin = p.linAccel * accelFactor;
  const vib = p.vibration;

  // 零偏 = 恒定零偏（固定方向，°/s）+ 随机游走（World 持有的三轴状态，°/s）→ 统一转 rad/s
  const biasRad: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    biasRad[i] = (p.gyroBiasDps * BIAS_DIR[i] + (gyroWalkState?.[i] ?? 0)) / 57.29578;
  }

  const gyro: V3 = [
    omegaTrue[0] + biasRad[0] + gauss.next() * p.gyroNoiseDps / 57.29578,
    omegaTrue[1] + biasRad[1] + gauss.next() * p.gyroNoiseDps / 57.29578,
    omegaTrue[2] + biasRad[2] + gauss.next() * p.gyroNoiseDps / 57.29578,
  ];

  // 加计确定性部分：重力投影 + 机动线加速度 + 振动
  const accelBase: V3 = [
    gBody[0]
      + lin * Math.sin(2 * Math.PI * 0.9 * t + 1.1)
      + vib * 3.0 * Math.sin(2 * Math.PI * 31 * t),
    gBody[1]
      + lin * Math.sin(2 * Math.PI * 0.7 * t + 2.3)
      + vib * 3.0 * Math.sin(2 * Math.PI * 28 * t + 1.0),
    gBody[2]
      + lin * 0.4 * Math.sin(2 * Math.PI * 1.3 * t + 0.5)
      + vib * 1.8 * Math.sin(2 * Math.PI * 37 * t + 2.0),
  ];
  // 非线性：偏离 1g 的二次压缩（1g 处零偏移，真实器件的满量程弯曲形态）
  if (p.accelNonlin > 0) {
    const n = Math.hypot(accelBase[0], accelBase[1], accelBase[2]);
    const k = 1 - p.accelNonlin * (n / G_ACC - 1) * (n / G_ACC - 1);
    accelBase[0] *= k;
    accelBase[1] *= k;
    accelBase[2] *= k;
  }
  // 交叉轴敏感度：每轴混入另外两轴各 k 的读数（确定性线性混合）
  const accel: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    accel[i] = accelBase[i] + p.accelCrossAxis * (accelBase[j] + accelBase[k]) + gauss.next() * p.accelNoise;
  }

  const magSample = simulateMag(q, t, p, gauss);
  return { gyro, accel, mag: magSample };
}

/**
 * 磁力计链路（独立函数，便于噪声序列守护测试）：
 * 世界磁场 → 机体系投影 → 硬铁偏移 + 交变干扰 + 高斯噪声 + 可选量化。
 * p 全零（magNoise=0, hardIron=0, disturbMag=0, magQuantUts=0）时返回无噪声的理想投影。
 */
export function simulateMag(
  q: Quat,
  t: number,
  p: Pick<ImuParams, "magNoise" | "hardIron" | "disturbMag" | "magQuantUts">,
  gauss: Gauss,
): V3 {
  const mBody = qRotInv(q, MAG_WORLD_NED);
  const magOn = p.magNoise > 0 || p.hardIron > 0 || p.disturbMag > 0 || p.magQuantUts > 0;
  if (!magOn) return mBody; // 理想磁力计：不消耗随机数（守护既有噪声序列）

  const hi = p.hardIron * 8; // 硬铁偏移量级：最多 ±8 μT
  const di = p.disturbMag * 25; // 交变干扰量级：最多 ±25 μT
  const quant = (v: number): number =>
    p.magQuantUts > 0 ? Math.round(v / p.magQuantUts) * p.magQuantUts : v; // 确定性取整（AK8963 = 0.6 μT/LSB）
  return [
    quant(mBody[0] + hi * HARD_IRON_DIR[0] + di * Math.sin(2 * Math.PI * 2.1 * t + 0.7) + gauss.next() * p.magNoise),
    quant(mBody[1] + hi * HARD_IRON_DIR[1] + di * Math.sin(2 * Math.PI * 1.7 * t + 2.2) + gauss.next() * p.magNoise),
    quant(mBody[2] + hi * HARD_IRON_DIR[2] + gauss.next() * p.magNoise),
  ];
}
