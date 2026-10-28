/**
 * 磁力计标定（纯数学，可在 Node 自检）：
 *
 *   原始读数  m_raw = S · m_true + b          （软铁矩阵 S + 硬铁偏移 b）
 *   本模块拟合  m_cal = (m_raw − offset) ⊙ scale   （对角软铁近似）
 *
 * 拟合方法是**代数球面拟合**：对无畸变的磁力计，机体系读数在任意姿态下都落在
 * 一个以原点为心、半径 = 地磁场强的球面上；硬铁把球心推走，软铁把球拉成椭球。
 * 先把球心解出来（线性最小二乘，4 个未知量，一次 4×4 高斯消元），再用各轴
 * 半极差把椭球拉回球——这正是 MotionCal / AN4246 一类工具的入门版。
 *
 * 局限（文档里会明说）：只估计对角软铁，交叉项与非正交安装误差需要
 * 完整 3×3 椭球拟合；真实工程里通常再叠加速度计六面校准与倾角补偿。
 */
import type { V3 } from "./quat";
import { percentile } from "./stats";

export interface MagCalibration {
  /** 硬铁偏移（μT），先减掉 */
  offset: V3;
  /** 软铁对角缩放（无量纲），再逐轴相乘 */
  scale: V3;
  /** 标定后的场强（μT） */
  field: number;
  /** 相对残差 RMS（0..1）：越小说明点云越接近球面 */
  residual: number;
  /** 参与拟合的样本数 */
  count: number;
}

export interface MagFitDiagnostics {
  offset: V3;
  /** 拟合球半径（μT） */
  radius: number;
  /** 各轴半极差（μT） */
  halfRanges: V3;
  /** 原始点云相对球面的 RMS 残差（μT） */
  rmsUt: number;
  count: number;
}

/** 4×4 线性方程组的高斯消元（部分主元）；奇异/病态返回 null */
function solve4(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = m[pivot];
      m[pivot] = m[col];
      m[col] = tmp;
    }
    const p = m[col][col];
    for (let c = col; c < 5; c++) m[col][c] /= p;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c < 5; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][4], m[1][4], m[2][4], m[3][4]];
}

/**
 * 代数球面拟合：min Σ (|p−c|² − R²)²。
 * 先减去样本均值再拟合（改善条件数），最后把均值加回球心。
 * 样本不足或分布退化（例如只在一个平面内转）返回 null。
 */
export function fitMagSphere(samples: readonly V3[]): MagFitDiagnostics | null {
  const n = samples.length;
  if (n < 12) return null;

  const mean: V3 = [0, 0, 0];
  for (const p of samples) {
    mean[0] += p[0];
    mean[1] += p[1];
    mean[2] += p[2];
  }
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;

  // 居中后的法方程：|y|² = 2a·y + d
  const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const atb = [0, 0, 0, 0];
  for (const p of samples) {
    const y: V3 = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
    const row = [2 * y[0], 2 * y[1], 2 * y[2], 1];
    const rhs = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
    for (let i = 0; i < 4; i++) {
      atb[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) ata[i][j] += row[i] * row[j];
    }
  }
  const sol = solve4(ata, atb);
  if (!sol) return null;
  const [ax, ay, az, d] = sol;
  const r2 = d + ax * ax + ay * ay + az * az;
  if (!Number.isFinite(r2) || r2 <= 0) return null;
  const radius = Math.sqrt(r2);
  const center: V3 = [mean[0] + ax, mean[1] + ay, mean[2] + az];
  if (!center.every(Number.isFinite) || radius < 1) return null;

  // 分布检查：三轴都必须有足够的半极差，否则球心在该轴上不可观
  const centered = samples.map((p): V3 => [p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
  const halfRanges: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const vals = centered.map((p) => p[k]);
    const lo = percentile(vals, 0.02);
    const hi = percentile(vals, 0.98);
    halfRanges[k] = (hi - lo) / 2;
  }
  const minHalf = Math.min(...halfRanges);
  if (minHalf < 0.08 * radius) return null; // 覆盖度不足（例如只绕一个轴转）

  let acc = 0;
  for (const p of samples) {
    const r = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    acc += (r - radius) * (r - radius);
  }
  return {
    offset: center,
    radius,
    halfRanges,
    rmsUt: Math.sqrt(acc / n),
    count: n,
  };
}

/**
 * 由样本点直接给出标定参数：球心 → 硬铁；各轴半极差 → 软铁对角缩放。
 * 返回 null 表示样本不足/覆盖度不够/数值退化。
 *
 * 两个读数（field / residual）的定义值得说清，因为它们最容易写成「看着像那么回事」：
 *  · 软铁缩放是**相对**修正：scale_i = 参考量 / 第 i 轴半极差。参考量取三轴半极差的均值，
 *    于是三轴公共的尺度因子自动约掉——这正是我们想要的，因为我们只知道「三轴应该等宽」，
 *    并不知道当地地磁总场强是多少（那要靠查地磁模型）。
 *  · 但半极差本身是被截断的统计量：Haar 均匀采样的单轴分量在 [−F, F] 上均匀，
 *    取 2%/98% 分位后量程只剩 96%（实测：半径 50 μT 的理想球，三轴半极差均值 47.5）。
 *    若拿它当「场强」直接报出来，会低报 5%；若拿它当残差基准，理想点云也会显示约 5% 残差
 *    （实测 5.31%）——那个数字与数据质量无关，纯属坐标选得不好。
 *  · 所以这里统一改成**自洽的定义**：先把点云标定成球，再在这批标定后的点上取
 *    field = 模长均值（= 标定球半径，实测理想球 50.00 ✓）、
 *    residual = 模长的**相对**标准差（无量纲，与公共尺度无关）。
 *    残差因此读作「这批点落在同一个球面上的紧密程度」，理想无噪球面 0.37%，与截断无关。
 */
export function calibrateMag(samples: readonly V3[]): MagCalibration | null {
  const fit = fitMagSphere(samples);
  if (!fit) return null;
  const ref = (fit.halfRanges[0] + fit.halfRanges[1] + fit.halfRanges[2]) / 3;
  if (!(ref > 0)) return null;
  const scale: V3 = [
    Math.min(5, Math.max(0.2, ref / fit.halfRanges[0])),
    Math.min(5, Math.max(0.2, ref / fit.halfRanges[1])),
    Math.min(5, Math.max(0.2, ref / fit.halfRanges[2])),
  ];
  // 标定后的模长统计：均值 = 场强（标定球半径），相对标准差 = 残差（球面有多圆）
  let sum = 0;
  let sumSq = 0;
  for (const p of samples) {
    const r = Math.hypot(
      (p[0] - fit.offset[0]) * scale[0],
      (p[1] - fit.offset[1]) * scale[1],
      (p[2] - fit.offset[2]) * scale[2],
    );
    sum += r;
    sumSq += r * r;
  }
  const field = sum / samples.length;
  const variance = Math.max(0, sumSq / samples.length - field * field);
  return {
    offset: fit.offset,
    scale,
    field,
    residual: field > 0 ? Math.sqrt(variance) / field : NaN,
    count: samples.length,
  };
}

/** 应用标定：先减硬铁，再乘软铁对角缩放。cal 为 null 时原样返回。 */
export function applyMagCalibration(m: V3, cal: MagCalibration | null): V3 {
  if (!cal) return m;
  return [
    (m[0] - cal.offset[0]) * cal.scale[0],
    (m[1] - cal.offset[1]) * cal.scale[1],
    (m[2] - cal.offset[2]) * cal.scale[2],
  ];
}
