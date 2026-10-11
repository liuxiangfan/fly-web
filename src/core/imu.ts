import type { Quat, V3 } from "./quat";
import { qRotInv } from "./quat";
import { Gauss } from "./rng";

export const G_ACC = 9.80665;

export interface ImuParams {
  /** 陀螺恒定零偏（°/s），作用在 [1, -0.7, 0.5] 归一化方向上 */
  gyroBiasDps: number;
  /** 陀螺白噪声 σ（°/s，每采样点） */
  gyroNoiseDps: number;
  /** 加计白噪声 σ（m/s²） */
  accelNoise: number;
  /** 机动线加速度幅值（m/s²），由剧本的 accelFactor 加权 */
  linAccel: number;
  /** 电机振动强度 0..1 */
  vibration: number;
}

export interface ImuSample {
  /** 陀螺仪：机体系角速度 + 零偏 + 噪声（rad/s） */
  gyro: V3;
  /** 加速度计：重力方向投影 + 机动线加速度 + 振动 + 噪声（m/s²） */
  accel: V3;
}

const BIAS_DIR: V3 = (() => {
  const n = Math.hypot(1, -0.7, 0.5);
  return [1 / n, -0.7 / n, 0.5 / n];
})();

/**
 * 由真实姿态与角速度生成模拟 IMU 输出。
 * 加计约定：静止时输出 +g 沿机体系「下」方向（即重力在机体系的投影）。
 */
export function simulateImu(
  q: Quat,
  omegaTrue: V3,
  t: number,
  p: ImuParams,
  gauss: Gauss,
  accelFactor: number,
): ImuSample {
  const gBody = qRotInv(q, [0, 0, G_ACC]);

  const lin = p.linAccel * accelFactor;
  const vib = p.vibration;

  const gyro: V3 = [
    omegaTrue[0] + (p.gyroBiasDps * BIAS_DIR[0] + gauss.next() * p.gyroNoiseDps) / 57.29578,
    omegaTrue[1] + (p.gyroBiasDps * BIAS_DIR[1] + gauss.next() * p.gyroNoiseDps) / 57.29578,
    omegaTrue[2] + (p.gyroBiasDps * BIAS_DIR[2] + gauss.next() * p.gyroNoiseDps) / 57.29578,
  ];

  const accel: V3 = [
    gBody[0]
      + lin * Math.sin(2 * Math.PI * 0.9 * t + 1.1)
      + vib * 3.0 * Math.sin(2 * Math.PI * 31 * t)
      + gauss.next() * p.accelNoise,
    gBody[1]
      + lin * Math.sin(2 * Math.PI * 0.7 * t + 2.3)
      + vib * 3.0 * Math.sin(2 * Math.PI * 28 * t + 1.0)
      + gauss.next() * p.accelNoise,
    gBody[2]
      + lin * 0.4 * Math.sin(2 * Math.PI * 1.3 * t + 0.5)
      + vib * 1.8 * Math.sin(2 * Math.PI * 37 * t + 2.0)
      + gauss.next() * p.accelNoise,
  ];

  return { gyro, accel };
}
