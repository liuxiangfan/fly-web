/** 校准入口的共同结构/质量契约；拟合与导入不能使用两套阈值。 */
import type { MagCalibration } from "./magcal";
import { conditionNumber3, type AccelCalibration } from "./accelcal";

export interface CalibrationProblem { path: string; message: string }
export const MATRIX_MAX_COND = 50;
export const ACCEL_MAX_BIAS_G = 0.35;
export const ACCEL_MAX_RMSE_G = 0.15;
const G_ACC = 9.80665;
const GAIN_MIN = 0.01, GAIN_MAX = 100;
const FACES = new Set(["+x", "-x", "+y", "-y", "+z", "-z"]);
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const det3 = (m: number[]): number => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** 先验原始结构，再验物理质量；未知扩展字段忽略，已知字段绝不清洗或过滤。 */
export function calibrationProblems(
  kind: "mag" | "accel", raw: unknown,
  path = kind === "mag" ? "magCalibration" : "accelCalibration",
): CalibrationProblem[] {
  const out: CalibrationProblem[] = [];
  const problem = (p: string, message: string): void => { out.push({ path: p, message }); };
  if (!isRecord(raw)) return [{ path, message: "须为校准对象" }];
  const number = (o: Record<string, unknown>, k: string, p: string, min = 0, max = Infinity, integer = false): void => {
    const v = o[k];
    if (!isFiniteNumber(v) || v < min || v > max || (integer && !Number.isInteger(v))) problem(`${p}.${k}`, `须为${integer ? "整数" : "有限数"}，范围 [${min}, ${max}]`);
  };
  const array = (k: string, length: number): number[] | null => {
    const a = raw[k];
    if (!Array.isArray(a) || a.length !== length) { problem(`${path}.${k}`, `需要 ${length} 个有限数`); return null; }
    let valid = true;
    for (let i = 0; i < length; i++) if (!isFiniteNumber(a[i])) { problem(`${path}.${k}[${i}]`, "须为有限数"); valid = false; }
    return valid ? a as number[] : null;
  };
  number(raw, "count", path, 4, Infinity, true);
  let matrix: number[] | null = null;
  if (kind === "mag") {
    const offset = array("offset", 3), scale = array("scale", 3);
    if (offset && Math.hypot(...offset) > 1e4) problem(`${path}.offset`, "硬铁偏移模长过大");
    if (scale) scale.forEach((v, i) => { if (v < GAIN_MIN || v > GAIN_MAX) problem(`${path}.scale[${i}]`, `增益超出 [${GAIN_MIN}, ${GAIN_MAX}]`); });
    number(raw, "field", path, Number.MIN_VALUE, 1e5);
    number(raw, "residual", path, 0, 1);
    if (raw.kind !== undefined && raw.kind !== "diag" && raw.kind !== "full") problem(`${path}.kind`, "须为 diag/full");
    // 模型标签必须与携带的数据一致：`applyMagCalibration` 会优先用 matrix，
    // 于是「kind=diag + matrix」的档案在界面上显示"对角模型"、实际却走完整矩阵——
    // 模型标签与解算结果脱钩（复核反例：diag 声明的矩阵把 [1,0,0] 变成 [2,0.2,0]）。
    if (raw.kind === "diag" && raw.matrix !== undefined) {
      problem(`${path}.matrix`, "diag 模型不得携带 matrix（应用路径会优先用矩阵，模型标签与实际不一致）");
    }
    if (raw.kind === "full" || raw.matrix !== undefined) matrix = array("matrix", 9);
    if (matrix) {
      // Sylvester 只用于对称磁校正矩阵，绝不拿来判断加计测量矩阵。
      const s = Math.max(...matrix.map(Math.abs), 1e-12);
      const symmetric = Math.abs(matrix[1] - matrix[3]) <= 1e-3 * s && Math.abs(matrix[2] - matrix[6]) <= 1e-3 * s && Math.abs(matrix[5] - matrix[7]) <= 1e-3 * s;
      if (!symmetric) problem(`${path}.matrix`, "椭球矩阵不对称");
      // 容差内对称时对称化后应用 Sylvester，不能对非对称输入套主子式判据。
      const m = [...matrix]; m[1] = m[3] = (m[1] + m[3]) / 2; m[2] = m[6] = (m[2] + m[6]) / 2; m[5] = m[7] = (m[5] + m[7]) / 2;
      if (symmetric && !(m[0] > 0 && m[0] * m[4] - m[1] * m[3] > 0 && det3(m) > 0)) problem(`${path}.matrix`, "椭球矩阵非正定（镜像/反号）");
      const gain = Math.sqrt(matrix.reduce((sum, v) => sum + v * v, 0) / 3);
      if (gain < GAIN_MIN || gain > GAIN_MAX) problem(`${path}.matrix`, "平均增益超出合法范围");
    }
  } else {
    matrix = array("M", 9);
    const bias = array("bias", 3), rmse = array("rmse", 3);
    if (bias && Math.max(...bias.map(Math.abs)) > ACCEL_MAX_BIAS_G * G_ACC) problem(`${path}.bias`, "偏置超过 0.35g");
    if (rmse) rmse.forEach((v, i) => { if (v < 0 || v > ACCEL_MAX_RMSE_G * G_ACC) problem(`${path}.rmse[${i}]`, "残差 RMS 应为 0..0.15g"); });
    const faces = raw.faces;
    if (!Array.isArray(faces)) problem(`${path}.faces`, "须为朝向数组");
    else {
      for (let i = 0; i < faces.length; i++) if (typeof faces[i] !== "string" || !FACES.has(faces[i])) problem(`${path}.faces[${i}]`, "未知朝向");
      if (new Set(faces).size < 4) problem(`${path}.faces`, "至少需要 4 个不同朝向");
    }
    if (matrix) {
      for (let i = 0; i < 9; i++) {
        if (i % 4 === 0 ? !(matrix[i] > 0.2 && matrix[i] < 5) : Math.abs(matrix[i]) > 0.5) problem(`${path}.M[${i}]`, "对角须接近 1（0.2..5），交叉轴须 ≤0.5");
      }
      if (!(det3(matrix) > 0)) problem(`${path}.M`, "刻度矩阵不是正向可逆结构（镜像/奇异）");
    }
  }
  if (matrix && !(conditionNumber3(matrix) <= MATRIX_MAX_COND)) problem(`${path}.${kind === "mag" ? "matrix" : "M"}`, "条件数过大（接近不可逆）");

  const validation = raw.validation;
  if (validation !== undefined) {
    const p = `${path}.validation`;
    if (!isRecord(validation)) problem(p, "须为验证对象");
    else if (kind === "mag") {
      const stats = (v: Record<string, unknown>, at: string): void => {
        number(v, "residual", at); number(v, "count", at, 1, Infinity, true); number(v, "maxErrUt", at);
        // 零训练残差时生产 ratio=NaN，JSON 会写 null；null 是合法的“不适用”，不是补默认值。
        if (v.ratio !== null) number(v, "ratio", at);
      };
      stats(validation, p);
      if (validation.late !== undefined) {
        if (!isRecord(validation.late)) problem(`${p}.late`, "须为后段验证对象");
        else stats(validation.late, `${p}.late`);
      }
    } else {
      number(validation, "meanNormErrMs2", p); number(validation, "maxNormErrMs2", p); number(validation, "heldOutFaces", p, 1, 6, true);
      for (const k of ["meanDirErrDeg", "maxDirErrDeg"]) if (validation[k] !== undefined) number(validation, k, p, 0, 180);
    }
  }
  const fitted = raw.fittedWith;
  if (fitted !== undefined) {
    const p = `${path}.fittedWith`;
    if (!isRecord(fitted)) problem(p, "须为器件指纹对象");
    else {
      if (typeof fitted.at !== "string" || !fitted.at) problem(`${p}.at`, "须为非空字符串");
      for (const k of ["crossAxis", "nonlin", "noise"]) number(fitted, k, p, 0, 1e6);
      for (const k of ["magNoise", "hardIron", "disturbMag", "magSoftIron", "magQuantUts", "magTargetUts"]) if (fitted[k] !== undefined) number(fitted, k, p, k === "magTargetUts" ? Number.MIN_VALUE : 0, 1e6);
      if (fitted.magModel !== undefined && fitted.magModel !== "diag" && fitted.magModel !== "full") problem(`${p}.magModel`, "须为 diag/full");
    }
  }
  return out;
}

/** 白名单复制合法模型，不共享输入数组/metadata；缺省 kind 是历史公开约定。 */
export function copyCalibration(kind: "mag", raw: Record<string, unknown>): MagCalibration;
export function copyCalibration(kind: "accel", raw: Record<string, unknown>): AccelCalibration;
export function copyCalibration(kind: "mag" | "accel", raw: Record<string, unknown>): MagCalibration | AccelCalibration {
  const out: Record<string, unknown> = {};
  if (kind === "mag") {
    // **键序固定**：kind 的位置由推导结果决定，而不是"存在就按输入序、缺失就补到末尾"。
    // 复核 SW-04：旧实现先按输入顺序拷 `matrix`，再把推导出的 `kind` 追加到最后，于是
    // 「省略 kind 的 full 模型」第一次复制是 `…count,matrix,kind`、第二次变成 `…count,kind,matrix`，
    // 导出字节首轮就不稳定（规范形必须幂等）。
    for (const k of ["offset", "scale", "field", "residual", "count"]) {
      if (raw[k] !== undefined) out[k] = Array.isArray(raw[k]) ? [...(raw[k] as unknown[])] : raw[k];
    }
    out.kind = raw.kind === "diag" || raw.kind === "full" ? raw.kind : (raw.matrix !== undefined ? "full" : "diag");
    if (raw.matrix !== undefined) out.matrix = Array.isArray(raw.matrix) ? [...raw.matrix] : raw.matrix;
  } else {
    for (const k of ["M", "bias", "rmse", "count", "faces"]) {
      if (raw[k] !== undefined) out[k] = Array.isArray(raw[k]) ? [...(raw[k] as unknown[])] : raw[k];
    }
  }
  if (isRecord(raw.validation)) {
    const v = raw.validation, dst: Record<string, unknown> = {};
    const keys = kind === "mag" ? ["residual", "count", "maxErrUt", "ratio"] : ["meanNormErrMs2", "maxNormErrMs2", "heldOutFaces", "meanDirErrDeg", "maxDirErrDeg"];
    for (const k of keys) if (v[k] !== undefined) dst[k] = v[k];
    if (kind === "mag" && isRecord(v.late)) { const late: Record<string, unknown> = {}; for (const k of keys) late[k] = v.late[k]; dst.late = late; }
    out.validation = dst;
  }
  if (isRecord(raw.fittedWith)) {
    const f: Record<string, unknown> = {};
    for (const k of ["at", "crossAxis", "nonlin", "noise", "magModel", "magNoise", "hardIron", "disturbMag", "magSoftIron", "magQuantUts", "magTargetUts"]) if (raw.fittedWith[k] !== undefined) f[k] = raw.fittedWith[k];
    out.fittedWith = f;
  }
  return out as unknown as MagCalibration | AccelCalibration;
}
