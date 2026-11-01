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
import { symmetricEigen3 } from "./quat";
import { percentile } from "./stats";

export interface MagCalibration {
  /** 硬铁偏移（μT），先减掉 */
  offset: V3;
  /** 软铁对角缩放（无量纲），再逐轴相乘（kind="diag" 时使用） */
  scale: V3;
  /** 标定后的场强（μT） */
  field: number;
  /** 相对残差 RMS（0..1）：越小说明点云越接近球面 */
  residual: number;
  /** 参与拟合的样本数 */
  count: number;
  /** 拟合时的器件指纹（交叉轴/非线性/噪声 + 拟合模型）：用于「标定已过期」提示 */
  fittedWith?: import("./calib-meta").CalibrationFingerprint;
  /** 模型：缺省/`diag` = 对角软铁；`full` = 完整 3×3 椭球（使用 matrix） */
  kind?: "diag" | "full";
  /** 完整模型的行主序 3×3 矩阵：m_cal = matrix·(m_raw − offset)，已缩放到 field */
  matrix?: number[];
  /**
   * 独立验证结果（拟合集/验证集分离）：残差只用**没参与拟合**的样本算，
   * 避免「用同一批点既拟合又打分」把残差说得比实际好。
   */
  validation?: {
    /** 验证集上的标定后模长相对标准差（与 `residual` 同量纲，可直接对比） */
    residual: number;
    /** 验证集样本数 */
    count: number;
    /** 验证集上最大模长偏差（μT） */
    maxErrUt: number;
    /** 验证集/拟合集残差之比：接近 1 说明没有过拟合 */
    ratio: number;
    /**
     * **后段留出**（按采集顺序用**前 75% 拟合、最后 25% 评分**）：
     * 交错划分（上面的 residual）证明「没记住噪声」，后段留出证明「过一会儿还准」——
     * 温漂、电池电压变化、姿态分布漂移都只在后者暴露。
     *
     * 注意：必须用**前段**重新拟合后再打分。历史实现对同一份交错训练集打分，
     * 于是末段 100 点里有 75 点已经参与训练（复核反例：只把末段 x 加 20 μT，
     * 「后段残差」就会异常变大，拟合参数也被末段污染）。
     */
    late?: {
      residual: number;
      count: number;
      maxErrUt: number;
      /** 后段残差 / 拟合残差：>1 说明随时间变差（时间漂移的迹象） */
      ratio: number;
    };
  };
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
    kind: "diag",
  };
}

/* --------------------------------------------------------------------------
   完整 3×3 椭球校准（对照模型）
   -------------------------------------------------------------------------- */

/** n×n 线性方程的高斯消元（部分主元），奇异返回 null */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    const scale = Math.max(...m.map((row) => Math.abs(row[col])));
    if (Math.abs(m[pivot][col]) < 1e-12 * Math.max(1, scale)) return null;
    if (pivot !== col) {
      const tmp = m[pivot];
      m[pivot] = m[col];
      m[col] = tmp;
    }
    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/**
 * 3×3 对称正定阵的**对称平方根** sqrt(Q) = V·diag(√λ)·Vᵀ。
 * 必须用对称平方根而不是 Cholesky：Cholesky 给出的下三角因子只保证 AᵀA=Q，
 * 与真实逆软铁矩阵之间会差一个正交因子（对**对称软铁**而言那正是方向误差的来源）。
 */
function symSqrt3(q: number[]): number[] | null {
  const { values, vectors } = symmetricEigen3(q);
  if (!values.every((v) => v > 1e-12)) return null;
  const r = values.map(Math.sqrt);
  // vectors 按列存主轴：V·diag(r)·Vᵀ
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += vectors[i * 3 + k] * r[k] * vectors[j * 3 + k];
      out[i * 3 + j] = sum;
    }
  }
  return out;
}

/**
 * 完整椭球拟合：拟合二次曲面 mᵀQm + uᵀm + c = 0，再化为
 *   m_cal = F · (Lᵀ·(m − center)) / √k，其中 Q = L·Lᵀ、k = centerᵀQ·center − c。
 *
 * 重要边界：仅凭点云形状**无法确定绝对场强**（椭球可以整体缩放）。这里把结果缩放到
 * 调用方给出的 `targetField`（默认 50 μT，与本装置世界磁场一致）；真实使用时应填当地地磁总场强。
 */
export function calibrateMagFull(samples: readonly V3[], targetField = 50): MagCalibration | null {
  const n = samples.length;
  if (n < 20) return null;

  // 设计矩阵：每行 [x²,y²,z²,2xy,2xz,2yz,2x,2y,2z,1]
  const A: number[][] = samples.map((p) => [
    p[0] * p[0], p[1] * p[1], p[2] * p[2],
    2 * p[0] * p[1], 2 * p[0] * p[2], 2 * p[1] * p[2],
    2 * p[0], 2 * p[1], 2 * p[2], 1,
  ]);

  // 依次尝试把某个二次项系数固定为 1（选列范数最大的那几列），求解其余 9 个未知量。
  const colNorm = Array.from({ length: 6 }, (_, j) => Math.sqrt(A.reduce((s, row) => s + row[j] * row[j], 0)));
  const order = [0, 1, 2, 3, 4, 5].sort((a, b) => colNorm[b] - colNorm[a]);
  let solution: MagCalibration | null = null;
  for (const fixed of order) {
    if (colNorm[fixed] < 1e-9) continue;
    const cols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((c) => c !== fixed);
    const ata = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    const atb = new Array<number>(9).fill(0);
    for (const row of A) {
      for (let i = 0; i < 9; i++) {
        atb[i] += row[cols[i]] * -row[fixed];
        for (let j = 0; j < 9; j++) ata[i][j] += row[cols[i]] * row[cols[j]];
      }
    }
    const sol = solveLinear(ata, atb);
    if (!sol) continue;
    const p = new Array<number>(10).fill(0);
    p[fixed] = 1;
    cols.forEach((c, i) => (p[c] = sol[i]));
    // Q 对称化
    const Q = [p[0], p[3], p[4], p[3], p[1], p[5], p[4], p[5], p[2]];
    const c = p[9];
    const sqrtQ = symSqrt3(Q);
    if (!sqrtQ) continue;
    const invQ = invert3Sym(Q);
    if (!invQ) continue;
    // 二次曲面 mᵀQm + uᵀm + c = 0，其中 u = 2·[p6,p7,p8]；球心 = −½Q⁻¹u = −Q⁻¹[p6,p7,p8]
    const g3: V3 = [p[6], p[7], p[8]];
    const center: V3 = [
      -(invQ[0] * g3[0] + invQ[1] * g3[1] + invQ[2] * g3[2]),
      -(invQ[3] * g3[0] + invQ[4] * g3[1] + invQ[5] * g3[2]),
      -(invQ[6] * g3[0] + invQ[7] * g3[1] + invQ[8] * g3[2]),
    ];
    if (!center.every(Number.isFinite)) continue;
    const k = center[0] * (Q[0] * center[0] + Q[1] * center[1] + Q[2] * center[2])
      + center[1] * (Q[3] * center[0] + Q[4] * center[1] + Q[5] * center[2])
      + center[2] * (Q[6] * center[0] + Q[7] * center[1] + Q[8] * center[2])
      - c;
    if (!(k > 0)) continue;
    const s = targetField / Math.sqrt(k);
    // m_cal = F/√k · sqrt(Q)·(m − center)；对对称软铁 sqrt(Q)=S⁻¹，方向可恢复。
    const matrix = sqrtQ.map((v) => s * v);
    // 覆盖度检查：标定后三轴半极差不能太小（否则椭球在某方向不可观）
    const cal = samples.map((pnt) => applyMatrix(pnt, center, matrix));
    const half: V3 = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const vals = cal.map((v) => v[axis]).sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * 0.02)];
      const hi = vals[Math.floor(vals.length * 0.98)];
      half[axis] = (hi - lo) / 2;
    }
    if (Math.min(...half) < 0.15 * targetField) continue;

    let sum = 0;
    let sumSq = 0;
    for (const v of cal) {
      const r = Math.hypot(v[0], v[1], v[2]);
      sum += r;
      sumSq += r * r;
    }
    const field = sum / cal.length;
    const variance = Math.max(0, sumSq / cal.length - field * field);
    solution = {
      offset: center,
      scale: [1, 1, 1],
      field,
      residual: field > 0 ? Math.sqrt(variance) / field : NaN,
      count: samples.length,
      kind: "full",
      matrix,
    };
    break;
  }
  return solution;
}

function applyMatrix(p: V3, center: V3, m: number[]): V3 {
  const d: V3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
  return [
    m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
    m[3] * d[0] + m[4] * d[1] + m[5] * d[2],
    m[6] * d[0] + m[7] * d[1] + m[8] * d[2],
  ];
}

/** 对称 3×3 求逆（供球心计算），奇异返回 null */
function invert3Sym(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const det = a * A + b * B + c * C;
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(e), Math.abs(f), Math.abs(g), Math.abs(h), Math.abs(i));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18 * Math.max(1e-30, scale ** 3)) return null;
  const s = 1 / det;
  return [
    A * s, B * s, C * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/** 应用标定：完整模型用 3×3 矩阵；对角模型先减硬铁再乘对角缩放。cal 为 null 时原样返回。 */
export function applyMagCalibration(m: V3, cal: MagCalibration | null): V3 {
  if (!cal) return m;
  const d: V3 = [m[0] - cal.offset[0], m[1] - cal.offset[1], m[2] - cal.offset[2]];
  if (cal.matrix && cal.matrix.length === 9) {
    const k = cal.matrix;
    return [
      k[0] * d[0] + k[1] * d[1] + k[2] * d[2],
      k[3] * d[0] + k[4] * d[1] + k[5] * d[2],
      k[6] * d[0] + k[7] * d[1] + k[8] * d[2],
    ];
  }
  return [d[0] * cal.scale[0], d[1] * cal.scale[1], d[2] * cal.scale[2]];
}

/* --------------------------------------------------------------------------
   拟合集 / 验证集分离 + 独立姿态验证（不只是"看残差")
   -------------------------------------------------------------------------- */

/** 训练/验证划分结果（确定性：每 step 个样本里取第 step-1 个作验证，不消耗随机数） */
export interface FitSplit<T> {
  fit: T;
  validate: T;
}

/**
 * 确定性划分：从每个 `step` 样本里取 1 个进验证集（默认 4 → 25% 验证）。
 * 用固定相位（每组的最后一个）而不是随机打乱，保证同一份数据永远得到同一条划分。
 */
export function splitFitValidate<T>(samples: readonly T[], step = 4): FitSplit<T[]> {
  const fit: T[] = [];
  const validate: T[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (step > 1 && (i + 1) % step === 0) validate.push(samples[i]);
    else fit.push(samples[i]);
  }
  return { fit, validate };
}

/**
 * 在给定样本集上算标定后的模长相对标准差与最大偏差（导出供测试与诊断使用）。
 * 「留出验证是否独立」这件事必须能被外部检查：只把模型与样本交给它，结果就不依赖内部状态。
 */
export function magFieldResidual(
  cal: MagCalibration,
  samples: readonly V3[],
): { residual: number; maxErrUt: number } {
  return fieldStats(cal, samples);
}

/** 在给定样本集上算标定后的模长相对标准差与最大偏差 */
function fieldStats(cal: MagCalibration, samples: readonly V3[]): { residual: number; maxErrUt: number } {
  if (!samples.length) return { residual: NaN, maxErrUt: NaN };
  let sum = 0;
  let maxErr = 0;
  for (const p of samples) {
    const c = applyMagCalibration(p, cal);
    const r = Math.hypot(c[0], c[1], c[2]);
    sum += r;
    maxErr = Math.max(maxErr, Math.abs(r - cal.field));
  }
  const field = sum / samples.length;
  let sumSq = 0;
  for (const p of samples) {
    const c = applyMagCalibration(p, cal);
    const r = Math.hypot(c[0], c[1], c[2]);
    sumSq += (r - field) * (r - field);
  }
  const sd = Math.sqrt(sumSq / samples.length);
  return { residual: field > 0 ? sd / field : NaN, maxErrUt: maxErr };
}

/**
 * 拟合 + 独立验证一步到位：用 75% 样本拟合（对角或完整模型），
 * 在剩余 25% 上算残差并写回 `validation`。样本不足或拟合退化时返回 null。
 */
export function calibrateMagWithValidation(
  samples: readonly V3[],
  model: "diag" | "full" = "diag",
  holdoutStep = 4,
): MagCalibration | null {
  const { fit, validate } = splitFitValidate(samples, holdoutStep);
  if (fit.length < 12 || validate.length < 4) return null;
  const cal = model === "full" ? calibrateMagFull(fit) : calibrateMag(fit);
  if (!cal) return null;
  const v = fieldStats(cal, validate);
  // 后段留出：**只用前 75% 训练**（绝不与后段有交集），再在最后 25% 上打分
  const lateStart = Math.floor(samples.length * 0.75);
  const earlySamples = samples.slice(0, lateStart);
  const lateSamples = samples.slice(lateStart);
  const earlyCal =
    lateSamples.length >= 4 && earlySamples.length >= 12
      ? model === "full"
        ? calibrateMagFull(earlySamples)
        : calibrateMag(earlySamples)
      : null;
  const late = earlyCal ? fieldStats(earlyCal, lateSamples) : null;
  return {
    ...cal,
    count: samples.length, // 对外报告的是实际采到的点数
    validation: {
      residual: v.residual,
      count: validate.length,
      maxErrUt: v.maxErrUt,
      ratio: cal.residual > 0 ? v.residual / cal.residual : NaN,
      ...(late && earlyCal
        ? {
            late: {
              residual: late.residual,
              count: lateSamples.length,
              maxErrUt: late.maxErrUt,
              // 比值以**前段自己的拟合残差**为基准，才是同口径的「时间漂移」指标
              ratio: earlyCal.residual > 0 ? late.residual / earlyCal.residual : NaN,
            },
          }
        : {}),
    },
  };
}

/**
 * 独立姿态验证：**不依赖拟合集**，用真值姿态把「标定前后磁航向误差」量化出来。
 *
 * 做法：给出 (真值姿态 q、该姿态下的原始磁读数) 若干组，
 * 用 q 把读数转回世界系；无畸变时它应当与真实地磁场方向重合，
 * 于是「水平分量的夹角」就是这份数据会让 MARG 解算吃到的偏航误差。
 * 这比看拟合残差更接近实际后果：残差小但方向偏，航向照样偏。
 */
export function magHeadingErrorDeg(
  cal: MagCalibration | null,
  qTrue: { w: number; x: number; y: number; z: number },
  magRaw: V3,
  refFieldNed: V3 = [22.5, 0, 43.4],
): number {
  const m = applyMagCalibration(magRaw, cal);
  // 世界系 = R(q)·m_body
  const w = qTrue.w, x = qTrue.x, y = qTrue.y, z = qTrue.z;
  const wx = (1 - 2 * (y * y + z * z)) * m[0] + 2 * (x * y - w * z) * m[1] + 2 * (x * z + w * y) * m[2];
  const wy = 2 * (x * y + w * z) * m[0] + (1 - 2 * (x * x + z * z)) * m[1] + 2 * (y * z - w * x) * m[2];
  const refH = Math.hypot(refFieldNed[0], refFieldNed[1]);
  const mH = Math.hypot(wx, wy);
  if (refH < 1e-9 || mH < 1e-9) return NaN;
  const cosA = (wx * refFieldNed[0] + wy * refFieldNed[1]) / (mH * refH);
  return Math.acos(Math.max(-1, Math.min(1, cosA))) * (180 / Math.PI);
}

export interface MagVerification {
  count: number;
  /** 未标定时的平均/最大航向误差（度） */
  beforeMeanDeg: number;
  beforeMaxDeg: number;
  /** 标定后的平均/最大航向误差（度） */
  afterMeanDeg: number;
  afterMaxDeg: number;
}

/** 对一组 (真值姿态, 原始磁读数) 算标定前后的航向误差统计 */
export function verifyMagCalibration(
  cal: MagCalibration | null,
  points: ReadonlyArray<{ qTrue: { w: number; x: number; y: number; z: number }; magRaw: V3 }>,
  refFieldNed: V3 = [22.5, 0, 43.4],
): MagVerification {
  let beforeSum = 0, afterSum = 0, beforeMax = 0, afterMax = 0, n = 0;
  for (const pt of points) {
    const b = magHeadingErrorDeg(null, pt.qTrue, pt.magRaw, refFieldNed);
    const a = magHeadingErrorDeg(cal, pt.qTrue, pt.magRaw, refFieldNed);
    if (!Number.isFinite(b) || !Number.isFinite(a)) continue;
    beforeSum += b; afterSum += a;
    beforeMax = Math.max(beforeMax, b); afterMax = Math.max(afterMax, a);
    n++;
  }
  return {
    count: n,
    beforeMeanDeg: n ? beforeSum / n : NaN,
    beforeMaxDeg: n ? beforeMax : NaN,
    afterMeanDeg: n ? afterSum / n : NaN,
    afterMaxDeg: n ? afterMax : NaN,
  };
}
