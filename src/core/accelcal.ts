/**
 * 加速度计六面校准（纯数学）。
 *
 * 测量模型（与磁力计校准同一族）：raw = M · a_true + b
 *   a_true 是「真实比力方向 × g」；按本装置的重力投影约定，静止时读数指向机体「下」。
 *   六面法让机体六个轴向依次朝下，因此六个位置的 a_true 分别是 ±g·e_x/±g·e_y/±g·e_z。
 *
 * 解算：每个输出轴各自是一个 4 参数最小二乘 `raw_j = t·m_j + b_j`，
 * 4×4 正规方程（带部分主元高斯消元）即可稳定求解；不需要 12 维大矩阵。
 * 输出 M（3×3）与 b（偏置），以及每个轴的残差 RMS。
 *
 * 为什么不能只做「零偏 + 刻度」：真实器件同时有安装失准/交叉轴，
 * 只有完整 M 才能把它们一起收掉。文档页给出可搬运的推导与限制。
 */
import type { V3 } from "./quat";
import { calibrationProblems, ACCEL_MAX_BIAS_G, ACCEL_MAX_RMSE_G, MATRIX_MAX_COND as ACCEL_MAX_COND } from "./calibration-validation";
export { ACCEL_MAX_BIAS_G, ACCEL_MAX_RMSE_G } from "./calibration-validation";

export type AccelFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export interface AccelCalibrationSample {
  /** 该面朝下时的三轴原始读数（m/s²，本装置约定静止时机体 z≈+9.81） */
  raw: V3;
  /** 记录时哪一个机体轴朝下 */
  face: AccelFace;
}

export interface AccelCalibration {
  /** 3×3 刻度/交叉轴矩阵，行主序：raw ≈ M·true + bias */
  M: number[];
  /** 三轴偏置（m/s²） */
  bias: V3;
  /** 每轴残差 RMS（m/s²），三个分量 */
  rmse: V3;
  /** 参与拟合的样本数（按面统计，允许每面多次取均值） */
  count: number;
  /** 覆盖到的面 */
  faces: AccelFace[];
  /** 拟合时的器件指纹：用于「标定已过期」提示（见 core/calib-meta.ts） */
  fittedWith?: import("./calib-meta").CalibrationFingerprint;
  /**
   * 独立验证（留一法）：每次留一个朝向不参与拟合，用其余朝向预测它，
   * 报告预测模长与 g 的偏差，以及预测**方向**与真实朝向的夹角。
   * 它回答的是"没见过的朝向上是否也准"，而不是"拟合用的点上残差多小"。
   * 方向误差必须一起报：模长对了但方向错了（错标/交叉轴错配）同样会让姿态解算偏。
   */
  validation?: {
    /** 留一预测的平均模长误差（m/s²，||a_pred| − g|） */
    meanNormErrMs2: number;
    /** 留一预测的最大模长误差（m/s²） */
    maxNormErrMs2: number;
    /** 参与留一的朝向数 */
    heldOutFaces: number;
    /** 留一预测的平均方向误差（度）：校正后读数与真实重力方向的夹角 */
    meanDirErrDeg?: number;
    /** 留一预测的最大方向误差（度） */
    maxDirErrDeg?: number;
  };
}

export const G_ACCEL = 9.80665;

/** 条件数上限：真实器件的刻度/交叉轴矩阵条件数只有个位数（±20% 刻度误差 ≈ 1.25），
 *  50 已经非常宽松；再大说明矩阵接近不可逆，应用时会把噪声放大成百上千倍。 */
export { MATRIX_MAX_COND as ACCEL_MAX_COND } from "./calibration-validation";
/** 面一致性：主轴读数必须占模长的这个比例以上，其余轴不得超过这个比例 */
const FACE_MAJOR_MIN = 0.6;
const FACE_CROSS_MAX = 0.5;

const FACE_AXIS: Record<AccelFace, { axis: number; sign: number }> = {
  "+x": { axis: 0, sign: 1 },
  "-x": { axis: 0, sign: -1 },
  "+y": { axis: 1, sign: 1 },
  "-y": { axis: 1, sign: -1 },
  "+z": { axis: 2, sign: 1 },
  "-z": { axis: 2, sign: -1 },
};

/**
 * 采样面与读数是否自洽：声称「+x 朝下」时，读数的 x 分量必须明显为正、且是三者中最大的，
 * 另两轴不得过大（允许真实安装倾斜/交叉轴，所以阈值只要求"主方向确实占优"）。
 *
 * 复核反例（P1-E）：把 +z 的真实读数（[0,0,9.81]）标成 +x 面，六面拟合**照样成功**，
 * 只是 RMSE 变成 2.31 m/s²——最小二乘只关心残差总量，不关心「这个朝向是否真的发生过」。
 * 这种错标的标定会被应用并把解算拉偏，界面却显示「拟合成功」。
 */
export function faceMatchesReading(s: AccelCalibrationSample): boolean {
  const face = FACE_AXIS[s.face];
  if (!face || !Array.isArray(s.raw) || s.raw.length !== 3 || !s.raw.every(Number.isFinite)) return false;
  const { axis, sign } = face;
  const norm = Math.hypot(s.raw[0], s.raw[1], s.raw[2]);
  if (!(norm > 1e-9)) return false;
  const major = s.raw[axis] * sign;
  const others = [0, 1, 2].filter((i) => i !== axis).map((i) => Math.abs(s.raw[i]));
  return major >= FACE_MAJOR_MIN * norm && Math.max(...others) <= FACE_CROSS_MAX * norm;
}

/**
 * 条件数**上界**估计：σmax/σmin ≤ ‖M‖_F · ‖M⁻¹‖_F（Frobenius 范数，严格成立）。
 * 这里只需要一个"是否病态"的判据，用上界足够：真实标定矩阵（单位阵附近）的上界是 3~4，
 * 而 diag(1,1,2e-6) 的上界是 7e5——两者隔着四个数量级，判据不会因为保守而误判。
 * 用 3 行代替 Jacobi 特征分解，省下的体积给了连接所有权与导出不可变的实现。
 * 奇异（不可逆）时返回 Infinity。
 */
export function conditionNumber3(m: number[]): number {
  const inv = invert3(m);
  if (!inv) return Infinity;
  const fro = (x: number[]): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0));
  const up = fro(m) * fro(inv);
  return Number.isFinite(up) ? up : Infinity;
}

export interface StaticWindowAssessment {
  ok: boolean;
  /** 平均模长（m/s²）：用于「是否真的搁在某个朝向下」的判断 */
  meanNormMs2?: number;
  /** 模长是否接近 1g（freefall / 2g 会为 false） */
  normOk?: boolean;
  /** 窗口内平均角速度模长（°/s） */
  meanGyroDps: number;
  /** 窗口内最大单帧角速度模长（°/s）：平均值为 0 的来回摆动会被它抓住 */
  maxGyroDps: number;
  /** 加速度计模长的样本标准差（m/s²）：搬运/触碰导致的读数变化 */
  accelNormStd: number;
  samples: number;
}

/**
 * 静止窗口质量判据（六面校准采集时使用）：
 * 平均角速度只反映「净转动」，正负摆动会互相抵消；因此同时检查
 * 最大单帧角速度与加速度模长标准差——三者都达标才算一次可信的静置。
 */
export function assessStaticWindow(
  samples: readonly { gyro: V3; accel: V3 }[],
): StaticWindowAssessment {
  // 判据要求足够点数：两点（甚至同刻两点）也能满足「平均/最大角速度 + 模长标准差」，
  // 复核反例里 t=0/0.5 的两点窗口就成功记录了一面。真实静止窗口至少要有可观的时间覆盖。
  if (samples.length < MIN_STATIC_SAMPLES) {
    return { ok: false, meanGyroDps: NaN, maxGyroDps: NaN, accelNormStd: NaN, samples: samples.length };
  }
  let gx = 0, gy = 0, gz = 0, maxG = 0;
  let nSum = 0, nSumSq = 0;
  for (const s of samples) {
    const gm = Math.hypot(s.gyro[0], s.gyro[1], s.gyro[2]);
    maxG = Math.max(maxG, gm);
    gx += s.gyro[0]; gy += s.gyro[1]; gz += s.gyro[2];
    const n = Math.hypot(s.accel[0], s.accel[1], s.accel[2]);
    nSum += n;
    nSumSq += n * n;
  }
  const meanGyro = Math.hypot(gx, gy, gz) / samples.length;
  const meanNorm = nSum / samples.length;
  const variance = Math.max(0, nSumSq / samples.length - meanNorm * meanNorm);
  const meanGyroDps = meanGyro * (180 / Math.PI);
  const maxGyroDps = maxG * (180 / Math.PI);
  const accelNormStd = Math.sqrt(variance);
  // 模长也要接近 1g：全零（freefall）或恒定 2g 都不是「静止放在某个朝向下」。
  // 注意 `accelNormStd` 只测抖动，不测绝对水平，所以水平检查必须单列。
  const normOk = Math.abs(meanNorm - G_ACCEL) < 0.35 * G_ACCEL;
  const ok = meanGyroDps < 3 && maxGyroDps < 6 && accelNormStd < 0.15 && normOk;
  return { ok, meanGyroDps, maxGyroDps, accelNormStd, samples: samples.length, meanNormMs2: meanNorm, normOk };
}

/** 静止窗口的最少样本数（对应约 0.1 s @500 Hz）：两点窗口不能算「静置过」 */
export const MIN_STATIC_SAMPLES = 50;

/** 六个面朝下时对应的真实重力投影（本装置约定：读数 = 重力方向投影） */
export function faceTrueVector(face: AccelFace): V3 {
  switch (face) {
    case "+x": return [G_ACCEL, 0, 0];
    case "-x": return [-G_ACCEL, 0, 0];
    case "+y": return [0, G_ACCEL, 0];
    case "-y": return [0, -G_ACCEL, 0];
    case "+z": return [0, 0, G_ACCEL];
    case "-z": return [0, 0, -G_ACCEL];
  }
}

function solve4(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    const scale = Math.max(...m.map((row) => Math.abs(row[col])));
    if (Math.abs(m[pivot][col]) < 1e-12 * Math.max(1, scale)) return null;
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
 * 六面校准。至少需要 4 个**不同朝向**的样本（真实使用建议六面、每面多次静置取均值），
 * 朝向不足时矩阵不可观，返回 null 而不是给出一个看似正常的 M。
 */
export function calibrateAccel(samples: readonly AccelCalibrationSample[]): AccelCalibration | null {
  if (samples.length < 4 || samples.some(s => !faceMatchesReading(s))) return null;
  const faces = [...new Set(samples.map((s) => s.face))];
  if (faces.length < 4) return null;

  // 每个输出轴一套 4×4 正规方程；同时直接按样本累加（重复面自动获得更高权重）
  const ata = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => [0, 0, 0, 0]));
  const atb = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const s of samples) {
    const t = faceTrueVector(s.face);
    const row = [t[0], t[1], t[2], 1];
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < 4; i++) {
        atb[axis][i] += row[i] * s.raw[axis];
        for (let j = 0; j < 4; j++) ata[axis][i][j] += row[i] * row[j];
      }
    }
  }
  const sol = [0, 1, 2].map((axis) => solve4(ata[axis], atb[axis]));
  if (sol.some((s) => s === null)) return null;
  const M = [
    sol[0]![0], sol[0]![1], sol[0]![2],
    sol[1]![0], sol[1]![1], sol[1]![2],
    sol[2]![0], sol[2]![1], sol[2]![2],
  ];
  const bias: V3 = [sol[0]![3], sol[1]![3], sol[2]![3]];
  if (!M.every(Number.isFinite) || !bias.every(Number.isFinite)) return null;

  // 可观性/合法性校验（复核反例：六面全填同一读数会得到 M=0、rmse=0 的「零残差成功」）：
  //  · 行列式接近 0 → 矩阵不可逆，应用时会静默透传，等于没校准；
  //  · 对角元必须为正（刻度因子），否则是朝向/符号错配；
  //  · 条件数过大 → 矩阵本身"几乎不可逆"（复核反例 diag(1,1,2e-6)：cond≈5e5 却通过了
  //    "det>1e-6" 的宽松判据），把噪声放大成千倍；
  //  · 偏置荒谬 → 采集面错配或读数单位不对；
  //  · 每个朝向的实测模长必须接近 g：freefall（全部 0）或恒定 2g 都不是六面标定的有效输入；
  //  · 每个样本的读数方向必须与它声称的朝向一致（复核反例：+z 误标 +x 仍"拟合成功"）。
  const detAbs = Math.abs(
    M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]),
  );
  const scaleMax = Math.max(...M.map((v) => Math.abs(v)), 1e-12);
  if (!(detAbs > 1e-6 * scaleMax ** 3)) return null;
  if (!(M[0] > 1e-6 && M[4] > 1e-6 && M[8] > 1e-6)) return null;
  if (!(conditionNumber3(M) <= ACCEL_MAX_COND)) return null;
  if (Math.max(Math.abs(bias[0]), Math.abs(bias[1]), Math.abs(bias[2])) > ACCEL_MAX_BIAS_G * G_ACCEL) return null;
  for (const s of samples) {
    const norm = Math.hypot(s.raw[0], s.raw[1], s.raw[2]);
    if (!(Math.abs(norm - G_ACCEL) < 0.35 * G_ACCEL)) return null;
    if (!faceMatchesReading(s)) return null; // 面与读数不自洽：宁可判失败，也不给一个"看起来成功"的错标定
  }

  const acc: V3 = [0, 0, 0];
  for (const s of samples) {
    const t = faceTrueVector(s.face);
    for (let axis = 0; axis < 3; axis++) {
      const pred = M[axis * 3] * t[0] + M[axis * 3 + 1] * t[1] + M[axis * 3 + 2] * t[2] + bias[axis];
      const e = s.raw[axis] - pred;
      acc[axis] += e * e;
    }
  }
  const n = samples.length;
  const rmse: V3 = [Math.sqrt(acc[0] / n), Math.sqrt(acc[1] / n), Math.sqrt(acc[2] / n)];
  // 残差也要过门槛：模型与数据不符（例如少采了一面、或器件非线性很强）时不该报"成功"
  if (Math.max(rmse[0], rmse[1], rmse[2]) > ACCEL_MAX_RMSE_G * G_ACCEL) return null;
  const model: AccelCalibration = { M, bias, rmse, count: n, faces };
  return calibrationProblems("accel", model).length === 0 ? model : null;
}

/** 应用校准：raw_cal = M⁻¹·(raw − bias)。M 奇异时原样返回。 */
export function applyAccelCalibration(raw: V3, cal: AccelCalibration | null): V3 {
  if (!cal) return raw;
  const inv = invert3(cal.M);
  if (!inv) return raw;
  const d: V3 = [raw[0] - cal.bias[0], raw[1] - cal.bias[1], raw[2] - cal.bias[2]];
  return [
    inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2],
    inv[3] * d[0] + inv[4] * d[1] + inv[5] * d[2],
    inv[6] * d[0] + inv[7] * d[1] + inv[8] * d[2],
  ];
}

/** 3×3 求逆，奇异返回 null */
export function invert3(m: number[]): number[] | null {
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

/** 由已知 M / bias 合成六面样本（自检与文档演示用，确定性、不消耗随机数） */
export function synthesizeAccelSamples(
  M: number[],
  bias: V3,
  noise = 0,
  seed = 12345,
): AccelCalibrationSample[] {
  const faces: AccelFace[] = ["+x", "-x", "+y", "-y", "+z", "-z"];
  let state = seed >>> 0;
  const rnd = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 2;
  };
  return faces.map((face) => {
    const t = faceTrueVector(face);
    const raw: V3 = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      raw[axis] =
        M[axis * 3] * t[0] + M[axis * 3 + 1] * t[1] + M[axis * 3 + 2] * t[2] + bias[axis] + noise * rnd();
    }
    return { raw, face };
  });
}

/* --------------------------------------------------------------------------
   独立验证：留一朝向 + 用未参与拟合的新样本核对
   -------------------------------------------------------------------------- */

/** 用标定参数预测某个朝向上的读数模长误差（m/s²） */
function predictNormErr(cal: AccelCalibration, s: AccelCalibrationSample): number {
  const corrected = applyAccelCalibration(s.raw, cal);
  return Math.abs(Math.hypot(corrected[0], corrected[1], corrected[2]) - G_ACCEL);
}

/** 用标定参数预测某个朝向上的**方向**误差（度）：校正后读数与真实重力方向的夹角 */
function predictDirErrDeg(cal: AccelCalibration, s: AccelCalibrationSample): number {
  const t = faceTrueVector(s.face);
  const corrected = applyAccelCalibration(s.raw, cal);
  const n = Math.hypot(corrected[0], corrected[1], corrected[2]);
  if (!(n > 1e-9)) return NaN;
  const dot = (corrected[0] * t[0] + corrected[1] * t[1] + corrected[2] * t[2]) / (n * G_ACCEL);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/**
 * 留一验证：对每个朝向留出它、用其余朝向重新拟合，再看它对留出朝向的预测误差
 * （模长误差 + 方向误差——只报模长会漏掉"错标/交叉轴错配"这类方向性问题）。
 * 至少需要 4 个不同朝向（原来判定可拟合的门槛）才会返回结果。
 */
export function validateAccelCalibration(samples: readonly AccelCalibrationSample[]): AccelCalibration["validation"] {
  const byFace = new Map<string, AccelCalibrationSample>();
  for (const s of samples) byFace.set(s.face, s);
  const faces = [...byFace.values()];
  if (faces.length < 4) return undefined;
  let sum = 0;
  let max = 0;
  let dirSum = 0;
  let dirMax = 0;
  let dirN = 0;
  let n = 0;
  for (const held of faces) {
    const train = faces.filter((s) => s !== held);
    const cal = calibrateAccel(train);
    if (!cal) continue;
    const e = predictNormErr(cal, held);
    if (!Number.isFinite(e)) continue;
    sum += e;
    max = Math.max(max, e);
    n++;
    const d = predictDirErrDeg(cal, held);
    if (Number.isFinite(d)) {
      dirSum += d;
      dirMax = Math.max(dirMax, d);
      dirN++;
    }
  }
  if (!n) return undefined;
  const out: NonNullable<AccelCalibration["validation"]> = {
    meanNormErrMs2: sum / n,
    maxNormErrMs2: max,
    heldOutFaces: n,
  };
  if (dirN) {
    out.meanDirErrDeg = dirSum / dirN;
    out.maxDirErrDeg = dirMax;
  }
  return out;
}

/**
 * 用**新样本**核对已拟合的标定（独立验证集，不参与拟合）：
 * 返回标定前后「模长偏离 g」的均值/最大值，直接看校准是否真的把椭球拉回了球。
 */
export function verifyAccelCalibration(
  cal: AccelCalibration | null,
  samples: readonly AccelCalibrationSample[],
): { count: number; beforeMeanMs2: number; afterMeanMs2: number; beforeMaxMs2: number; afterMaxMs2: number } {
  let bSum = 0, aSum = 0, bMax = 0, aMax = 0, n = 0;
  for (const s of samples) {
    const before = Math.abs(Math.hypot(s.raw[0], s.raw[1], s.raw[2]) - G_ACCEL);
    const c = applyAccelCalibration(s.raw, cal);
    const after = Math.abs(Math.hypot(c[0], c[1], c[2]) - G_ACCEL);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    bSum += before; aSum += after;
    bMax = Math.max(bMax, before); aMax = Math.max(aMax, after);
    n++;
  }
  return {
    count: n,
    beforeMeanMs2: n ? bSum / n : NaN,
    afterMeanMs2: n ? aSum / n : NaN,
    beforeMaxMs2: n ? bMax : NaN,
    afterMaxMs2: n ? aMax : NaN,
  };
}
