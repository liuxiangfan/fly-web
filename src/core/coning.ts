/**
 * 圆锥效应（coning）与采样混叠的教学数值实验（纯函数）。
 *
 * 背景：连续旋转不可交换。机体同时存在两个正交轴的高频角振荡时，
 * 「逐帧把角速度当恒定小旋转」的积分会漏掉振荡间不可交换形成的净旋转矢量，
 * 这个误差随采样周期迅速增大——就是圆锥误差。它**不是传感器误差**：
 * 即使陀螺仪完全无噪声，有限采样率本身也会产生它。
 *
 * 本模块用解析角速度函数生成高采样率参考轨迹，再让不同采样率重复积分，
 * 给出「误差 vs 采样率」的可复现数字。主仿真不依赖它（不引入高频振动耦合），
 * 文档与实验页调用它把「本装置看不到」的边界变成可算的现场。
 */
import { qAngleBetween, qId, qIntegrate, type Quat, type V3 } from "./quat";

export const DEG_PER_RAD = 180 / Math.PI;

/** 经典圆锥运动：ω = [A·sin(2πft), A·cos(2πft), 0]（rad/s）；绕两个正交轴同频、相位差 90° */
export function coningOmega(t: number, ampRadPerSec: number, freqHz: number): V3 {
  const w = 2 * Math.PI * freqHz * t;
  return [ampRadPerSec * Math.sin(w), ampRadPerSec * Math.cos(w), 0];
}

/** 用固定步长积分一段解析角速度，返回终端姿态 */
export function integrateOmega(
  omegaOf: (t: number) => V3,
  durationSec: number,
  sampleHz: number,
): Quat {
  const h = 1 / sampleHz;
  const n = Math.max(1, Math.round(durationSec * sampleHz));
  let q = qId();
  for (let i = 0; i < n; i++) q = qIntegrate(q, omegaOf(i * h), h);
  return q;
}

export interface ConingPoint {
  /** 采样率（Hz） */
  rateHz: number;
  /** 与高采样率参考的姿态误差（度） */
  errDeg: number;
}

export interface ConingOptions {
  /** 圆锥振荡频率（Hz） */
  freqHz?: number;
  /** 角速度幅值（°/s） */
  ampDps?: number;
  /** 积分时长（秒） */
  durationSec?: number;
  /** 待测采样率（Hz） */
  rates?: number[];
  /** 参考采样率（Hz），要远高于所有待测率 */
  refHz?: number;
}

export const DEFAULT_CONING_RATES = [500, 250, 125, 100, 50];

/**
 * 扫采样率得到圆锥误差曲线。
 * 参考轨迹用 refHz=20000 积分；注意这仍是数值参考（不是解析解），
 * 但它比最高待测率高一到两个数量级，足以分离出采样率主导项。
 */
export function coningSweep(opts: ConingOptions = {}): ConingPoint[] {
  const freqHz = opts.freqHz ?? 12;
  const ampDps = opts.ampDps ?? 120;
  const durationSec = opts.durationSec ?? 4;
  const rates = opts.rates ?? DEFAULT_CONING_RATES;
  const refHz = opts.refHz ?? 20000;
  const amp = ampDps / DEG_PER_RAD;
  const omegaOf = (t: number): V3 => coningOmega(t, amp, freqHz);
  const ref = integrateOmega(omegaOf, durationSec, refHz);
  return rates.map((rateHz) => ({
    rateHz,
    errDeg: qAngleBetween(integrateOmega(omegaOf, durationSec, rateHz), ref) * DEG_PER_RAD,
  }));
}

/**
 * 采样混叠：频率 f 的信号以 fs 采样后折回 [0, fs/2] 的频率（Hz）。
 * 用于教学页显示「31 Hz 的桨叶通过频率在 50 Hz 解算下看起来像 19 Hz」。
 */
export function aliasHz(f: number, fs: number): number {
  if (!(fs > 0) || !Number.isFinite(f)) return NaN;
  const a = Math.abs(f) % fs;
  return a <= fs / 2 ? a : fs - a;
}
