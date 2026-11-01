/**
 * 实验配置：UI、深链、实验库、批量评测与导出的唯一数值状态来源。
 *
 * 设计原则
 * --------
 * 1. **纯数据**：不 import DOM、Three.js 或 main.ts，可在 Node 下序列化、校验与运行。
 * 2. **版本化**：`schemaVersion` 让旧深链/旧实验档案可以迁移，而不是静默读出错误状态。
 * 3. **逻辑单位**：数值都用物理单位（°/s、m/s²、μT、Hz、秒）；UI 的百分比/字符串只在适配层转换。
 * 4. **展示状态与数值状态分离**：面板开合、视图、曲线等属于 presentation，不进入 runner。
 *
 * 本模块不直接改 DOM；main.ts 负责把配置写进控件/从控件读取。
 */
import type { ImuParams } from "./imu";
import type { MagCalibration } from "./magcal";
import { conditionNumber3, type AccelCalibration } from "./accelcal";

/** 标定矩阵的条件数上限（刻度/交叉轴矩阵的真实条件数只有个位数，50 已非常宽松） */
export const MATRIX_MAX_COND = 50;
import type { V3 } from "./quat";
import { qFromAxisAngle, qId, RAD, type Quat } from "./quat";
import { mulberry32 } from "./rng";

export const EXPERIMENT_SCHEMA_VERSION = 3;

export type EstimatorId = "pure" | "comp" | "mahony" | "madg" | "kalman";
export type MagMode = "yaw" | "full";
/** 磁校准拟合模型：对角（offset+scale）或完整 3×3 椭球 */
export type MagCalModel = "diag" | "full";

/** 每个算法的可调参数快照（与 Estimator.getParams() 对齐） */
export interface EstimatorTuning {
  enabled: boolean;
  magEnabled: boolean;
  /** 互补/Mahony/Madgwick 共用的观测门控与启动 ramp */
  accelGate: boolean;
  gateDeg: number;
  gateMagPct: number;
  gateRecovery: boolean;
  rampEnabled: boolean;
  /** Mahony/Madgwick 的磁修正形态 */
  magMode: MagMode;
  /** 卡尔曼野值门控形态（其它算法忽略） */
  kalmanGate?: "angle" | "mahalanobis";
  /** 卡尔曼 χ² 门控阈值（3 自由度） */
  kalmanChi2?: number;
  /** 卡尔曼误差注入后是否做 P ← G·P·Gᵀ 协方差重置（默认关，教学基线） */
  kalmanResetCov?: boolean;
  /** 算法专属参数：alpha / kp,ki / beta / gyroNoiseDps,obsNoise */
  params: Record<string, number>;
}

export interface InitialAttitudeSpec {
  kind: "level" | "fixed-axis" | "random";
  /** fixed-axis：机体系轴（任意非零向量，运行前会归一化） */
  axis?: V3;
  /** fixed-axis：转角（度） */
  angleDeg?: number;
}

export interface ExperimentConfig {
  schemaVersion: number;
  /** 确定性随机种子；相同配置 + seed 必须逐帧可复现 */
  seed: number;
  scenario: string;
  durationSec: number;
  solveRateHz: number;
  imu: ImuParams;
  estimators: Record<EstimatorId, EstimatorTuning>;
  initialAttitude: InitialAttitudeSpec;
  /** 磁校准拟合模型；`magCalibration.kind` 必须与之匹配（档案/深链恢复时校验） */
  magModel: MagCalModel;
  /** 磁力计绕垂直轴目标场强（μT）；仅用于 UI 显示与拟合目标，不改变应用公式 */
  magTargetUts?: number;
  magCalibration: MagCalibration | null;
  /** 加速度计六面校准（可选） */
  accelCalibration?: AccelCalibration | null;
  /** 磁校准是否在解算输入前应用（对应界面「应用校准」复选框） */
  magCalibrationApplied?: boolean;
  /** 加计六面校准是否应用 */
  accelCalibrationApplied?: boolean;
  /** 界面静止粗对准自动重置（批量 runner 同语义；默认开） */
  autoCoarseAlign?: boolean;
  /** 稳态统计窗口起点（秒，相对本段起点）；缺省时取末段 40% */
  steadyFromSec?: number | null;
  /**
   * 手动剧本的目标角（度，[roll, pitch, yaw]）。
   * 为什么必须进配置：manual 剧本的目标角此前是**全局可变对象**（`scenarios.manualTarget`），
   * 于是「同配置 + 同 seed」并不能复现结果——改一下全局目标，返回的配置完全相同，
   * 纯积分终态却差 29.8°（复核反例）；Worker 里还有另一份默认值。
   */
  manualTargetDeg?: [number, number, number];
  /** A/B 对比模式（只影响界面执行方式；runner 不使用） */
  ab?: { mode: "same-start" | "online-fork" };
}

/** 与 main.ts 历史默认值完全一致（不要在这里“顺手优化”数值，否则旧基准会漂） */
export const DEFAULT_IMU_PARAMS: ImuParams = {
  gyroBiasDps: 1,
  gyroNoiseDps: 0.2,
  gyroWalkDps: 0,
  gyroRangeDps: 0,
  gyroScaleErr: 0,
  gyroMisalign: 0,
  accelNoise: 0.1,
  accelCrossAxis: 0,
  accelNonlin: 0,
  linAccel: 1,
  vibration: 0.3,
  magNoise: 0.8,
  magQuantUts: 0,
  hardIron: 0,
  disturbMag: 0,
  magSoftIron: 0,
  sensorDelayMs: 0,
  sensorBandwidthHz: 0,
  sensorDelaySkewMs: 0,
  sensorSampleHz: 0,
};

export const DEFAULT_ESTIMATOR_TUNING: Record<EstimatorId, EstimatorTuning> = {
  pure: {
    enabled: true, magEnabled: false,
    accelGate: false, gateDeg: 20, gateMagPct: 0.35, gateRecovery: false, rampEnabled: false, magMode: "yaw",
    params: {},
  },
  comp: {
    enabled: true, magEnabled: true,
    accelGate: true, gateDeg: 20, gateMagPct: 0.35, gateRecovery: false, rampEnabled: true, magMode: "yaw",
    params: { alpha: 1 },
  },
  mahony: {
    enabled: true, magEnabled: true,
    accelGate: true, gateDeg: 20, gateMagPct: 0.35, gateRecovery: false, rampEnabled: true, magMode: "yaw",
    params: { kp: 1, ki: 0.05 },
  },
  madg: {
    enabled: true, magEnabled: true,
    accelGate: true, gateDeg: 20, gateMagPct: 0.35, gateRecovery: false, rampEnabled: true, magMode: "yaw",
    params: { beta: 0.1 },
  },
  kalman: {
    enabled: true, magEnabled: true,
    accelGate: false, gateDeg: 40, gateMagPct: 0.35, gateRecovery: false, rampEnabled: false, magMode: "yaw",
    kalmanGate: "angle", kalmanChi2: 11.345,
    params: { gyroNoiseDps: 0.2, obsNoise: 0.05 },
  },
};

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  schemaVersion: EXPERIMENT_SCHEMA_VERSION,
  seed: 0x5eed,
  scenario: "hover",
  durationSec: 30,
  solveRateHz: 500,
  imu: { ...DEFAULT_IMU_PARAMS },
  estimators: structuredCloneTuning(DEFAULT_ESTIMATOR_TUNING),
  initialAttitude: { kind: "level" },
  manualTargetDeg: [0, 0, 0],
  magModel: "diag",
  magTargetUts: 50,
  magCalibration: null,
  accelCalibration: null,
  magCalibrationApplied: false,
  accelCalibrationApplied: false,
  autoCoarseAlign: true,
  steadyFromSec: null,
  ab: { mode: "same-start" },
};

function structuredCloneTuning(
  src: Record<EstimatorId, EstimatorTuning>,
): Record<EstimatorId, EstimatorTuning> {
  const out = {} as Record<EstimatorId, EstimatorTuning>;
  for (const id of Object.keys(src) as EstimatorId[]) {
    out[id] = { ...src[id], params: { ...src[id].params } };
  }
  return out;
}

/** 深拷贝，避免调用方修改默认配置 */
export function cloneExperimentConfig(c: ExperimentConfig): ExperimentConfig {
  return {
    ...c,
    imu: { ...c.imu },
    estimators: structuredCloneTuning(c.estimators),
    initialAttitude: {
      ...c.initialAttitude,
      // axis 是数组：浅拷会让克隆与原配置共享同一个 V3（复核反例：改 clone.axis[0]=9 污染原配置）
      ...(c.initialAttitude.axis ? { axis: [...c.initialAttitude.axis] as V3 } : {}),
    },
    manualTargetDeg: c.manualTargetDeg ? ([...c.manualTargetDeg] as [number, number, number]) : [0, 0, 0],
    ab: c.ab ? { ...c.ab } : undefined,
    magCalibration: c.magCalibration
      ? {
          ...c.magCalibration,
          offset: [...c.magCalibration.offset] as V3,
          scale: [...c.magCalibration.scale] as V3,
          ...(c.magCalibration.matrix ? { matrix: [...c.magCalibration.matrix] } : {}),
          // 验证结果与器件指纹都要深拷贝：共享引用会被后续拟合/参数变化污染
          ...(c.magCalibration.validation
            ? {
                validation: {
                  ...c.magCalibration.validation,
                  // late 是嵌套对象：浅拷会让克隆与原配置共享同一引用（复核反例：改克隆残差污染原件）
                  ...(c.magCalibration.validation.late ? { late: { ...c.magCalibration.validation.late } } : {}),
                },
              }
            : {}),
          ...(c.magCalibration.fittedWith ? { fittedWith: { ...c.magCalibration.fittedWith } } : {}),
        }
      : null,
    accelCalibration: c.accelCalibration
      ? {
          ...c.accelCalibration,
          M: [...c.accelCalibration.M],
          bias: [...c.accelCalibration.bias] as V3,
          rmse: [...c.accelCalibration.rmse] as V3,
          faces: [...c.accelCalibration.faces],
          ...(c.accelCalibration.validation ? { validation: { ...c.accelCalibration.validation } } : {}),
          ...(c.accelCalibration.fittedWith ? { fittedWith: { ...c.accelCalibration.fittedWith } } : {}),
        }
      : null,
  };
}

/** 生成默认配置（每次返回独立对象） */
export function defaultExperimentConfig(): ExperimentConfig {
  return cloneExperimentConfig(DEFAULT_EXPERIMENT_CONFIG);
}

export interface ConfigProblem {
  path: string;
  message: string;
}

/** 校验配置；只报告问题，不抛异常，方便 UI 逐项提示 */
export function validateExperimentConfig(c: ExperimentConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const finite = (path: string, v: number, min = -Infinity, max = Infinity): void => {
    if (!Number.isFinite(v)) problems.push({ path, message: `不是有限数：${v}` });
    else if (v < min || v > max) problems.push({ path, message: `超出范围 [${min}, ${max}]：${v}` });
  };
  if (!Number.isInteger(c.schemaVersion) || c.schemaVersion < 1) {
    problems.push({ path: "schemaVersion", message: `非法 schemaVersion：${c.schemaVersion}` });
  }
  if (!Number.isFinite(c.seed)) problems.push({ path: "seed", message: `非法 seed：${c.seed}` });
  if (!c.scenario) problems.push({ path: "scenario", message: "缺少 scenario" });
  finite("durationSec", c.durationSec, 0.1, 24 * 3600);
  finite("solveRateHz", c.solveRateHz, 1, 1000);
  for (const [k, v] of Object.entries(c.imu)) finite(`imu.${k}`, v as number, 0, 1e6);
  for (const id of Object.keys(c.estimators) as EstimatorId[]) {
    const t = c.estimators[id];
    if (!t) {
      problems.push({ path: `estimators.${id}`, message: "缺少算法配置" });
      continue;
    }
    finite(`estimators.${id}.params`, 0);
    if (!Number.isFinite(t.gateDeg) || t.gateDeg <= 0) problems.push({ path: `estimators.${id}.gateDeg`, message: "门控角须为正" });
    if (!Number.isFinite(t.gateMagPct) || t.gateMagPct <= 0) problems.push({ path: `estimators.${id}.gateMagPct`, message: "幅度门控须为正" });
    for (const [k, v] of Object.entries(t.params)) finite(`estimators.${id}.params.${k}`, v, 0, 1e6);
  }
  if (c.initialAttitude.kind === "fixed-axis") {    const a = c.initialAttitude.axis;
    if (!a || !a.every(Number.isFinite) || Math.hypot(a[0], a[1], a[2]) < 1e-9) {
      problems.push({ path: "initialAttitude.axis", message: "固定轴偏差需要非零有限轴" });
    }
    finite("initialAttitude.angleDeg", c.initialAttitude.angleDeg ?? NaN, 0, 180);
  }
  if (c.ab && c.ab.mode !== "same-start" && c.ab.mode !== "online-fork") {
    problems.push({ path: "ab.mode", message: `未知 A/B 起跑方式：${String(c.ab.mode)}` });
  }
  if (c.magModel !== "diag" && c.magModel !== "full") {
    problems.push({ path: "magModel", message: `未知磁校准模型：${String(c.magModel)}` });
  }
  if (c.magCalibration) {
    const kind = c.magCalibration.kind ?? "diag";
    if (kind !== c.magModel) {
      problems.push({
        path: "magModel",
        message: `模型与校准对象不一致：magModel=${c.magModel}，magCalibration.kind=${kind}`,
      });
    }
    finite("magCalibration.field", c.magCalibration.field, 1e-6);
    problems.push(...magCalibrationProblems(c.magCalibration));
  } else if (c.magCalibrationApplied) {
    // 「已应用」却没有模型 = 界面显示已校准、实际什么都没做（复核反例：Applied=true 而模型被静默丢掉）
    problems.push({ path: "magCalibrationApplied", message: "标记为已应用，但 magCalibration 为空" });
  }
  if (c.accelCalibration) {
    problems.push(...accelCalibrationProblems(c.accelCalibration));
  } else if (c.accelCalibrationApplied) {
    problems.push({ path: "accelCalibrationApplied", message: "标记为已应用，但 accelCalibration 为空" });
  }
  if (c.steadyFromSec !== undefined && c.steadyFromSec !== null) {
    finite("steadyFromSec", c.steadyFromSec, 0, 24 * 3600);
  }
  return problems;
}

/**
 * 迁移任意旧版 JSON 到当前 schema。
 * 旧深链只保存控件子集，因此迁移是「在默认配置上覆盖已知字段」，不是严格逆向。
 */
export function migrateExperimentConfig(raw: unknown): ExperimentConfig {
  const base = defaultExperimentConfig();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  base.schemaVersion = EXPERIMENT_SCHEMA_VERSION;
  base.seed = num(o.seed, base.seed);
  base.scenario = typeof o.scenario === "string" ? o.scenario : base.scenario;
  base.durationSec = num(o.durationSec, base.durationSec);
  base.solveRateHz = num(o.solveRateHz, base.solveRateHz);
  if (o.imu && typeof o.imu === "object") {
    for (const k of Object.keys(base.imu) as Array<keyof ImuParams>) {
      const v = (o.imu as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) base.imu[k] = v;
    }
  }
  if (o.estimators && typeof o.estimators === "object") {
    for (const id of Object.keys(base.estimators) as EstimatorId[]) {
      const t = (o.estimators as Record<string, unknown>)[id];
      if (!t || typeof t !== "object") continue;
      const r = t as Record<string, unknown>;
      const dst = base.estimators[id];
      dst.enabled = bool(r.enabled, dst.enabled);
      dst.magEnabled = bool(r.magEnabled, dst.magEnabled);
      dst.accelGate = bool(r.accelGate, dst.accelGate);
      dst.gateDeg = num(r.gateDeg, dst.gateDeg);
      dst.gateMagPct = num(r.gateMagPct, dst.gateMagPct);
      dst.gateRecovery = bool(r.gateRecovery, dst.gateRecovery);
      dst.rampEnabled = bool(r.rampEnabled, dst.rampEnabled);
      dst.magMode = r.magMode === "full" ? "full" : "yaw";
      if (r.kalmanGate === "mahalanobis" || r.kalmanGate === "angle") dst.kalmanGate = r.kalmanGate;
      if (typeof r.kalmanChi2 === "number" && Number.isFinite(r.kalmanChi2)) dst.kalmanChi2 = r.kalmanChi2;
      if (typeof r.kalmanResetCov === "boolean") dst.kalmanResetCov = r.kalmanResetCov;
      if (r.params && typeof r.params === "object") {
        for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) dst.params[k] = v;
        }
      }
    }
  }
  if (o.initialAttitude && typeof o.initialAttitude === "object") {
    const ia = o.initialAttitude as Record<string, unknown>;
    const kind = ia.kind === "fixed-axis" || ia.kind === "random" ? ia.kind : "level";
    base.initialAttitude = { kind };
    if (kind === "fixed-axis" && Array.isArray(ia.axis) && ia.axis.length === 3) {
      base.initialAttitude.axis = [num(ia.axis[0], 1), num(ia.axis[1], 0), num(ia.axis[2], 0)];
      base.initialAttitude.angleDeg = num(ia.angleDeg, 30);
    }
  }
  if (Array.isArray(o.manualTargetDeg) && o.manualTargetDeg.length === 3) {
    const m = o.manualTargetDeg.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0));
    base.manualTargetDeg = [m[0], m[1], m[2]];
  }
  if (o.ab && typeof o.ab === "object") {
    const mode = (o.ab as Record<string, unknown>).mode;
    base.ab = { mode: mode === "online-fork" ? "online-fork" : "same-start" };
  }
  if (o.magModel === "full" || o.magModel === "diag") base.magModel = o.magModel;
  if (typeof o.magTargetUts === "number" && Number.isFinite(o.magTargetUts) && o.magTargetUts > 0) {
    base.magTargetUts = o.magTargetUts;
  }
  base.magCalibration = parseMagCalibration(o.magCalibration);
  base.accelCalibration = parseAccelCalibration(o.accelCalibration);
  // 旧档案没有应用标志：有校准对象就视为已应用（与历史界面行为一致）
  base.magCalibrationApplied = bool(o.magCalibrationApplied, base.magCalibration !== null);
  base.accelCalibrationApplied = bool(o.accelCalibrationApplied, base.accelCalibration !== null);
  // 若未显式给模型，则校准对象的 kind 决定模型
  if (o.magModel !== "full" && o.magModel !== "diag" && base.magCalibration?.kind === "full") {
    base.magModel = "full";
  }
  base.autoCoarseAlign = bool(o.autoCoarseAlign, base.autoCoarseAlign ?? true);
  base.steadyFromSec =
    o.steadyFromSec === null ? null : typeof o.steadyFromSec === "number" && Number.isFinite(o.steadyFromSec)
      ? o.steadyFromSec
      : base.steadyFromSec;
  return base;
}

function numTriple(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return v as V3;
}

/** 宽松解析磁校准（用于深链/档案迁移）；结构不完整时返回 null，而不是半有效对象 */
export function parseMagCalibration(raw: unknown): MagCalibration | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const field = typeof o.field === "number" && Number.isFinite(o.field) && o.field > 0 ? o.field : null;
  const offset = numTriple(o.offset);
  const scale = numTriple(o.scale);
  if (!offset || !scale || field === null) return null;
  const kind: MagCalModel = o.kind === "full" ? "full" : "diag";
  const entry: MagCalibration = {
    offset,
    scale,
    field,
    residual: typeof o.residual === "number" && Number.isFinite(o.residual) ? o.residual : 0,
    count: typeof o.count === "number" && Number.isFinite(o.count) ? o.count : 0,
  };
  if (kind === "full") {
    const matrix = o.matrix;
    if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return null;
    }
    entry.kind = "full";
    entry.matrix = matrix as number[];
  } else {
    entry.kind = "diag";
  }
  // 验证结果与器件指纹一起往返（否则导入档案后「标定已过期」提示会消失）
  if (o.validation && typeof o.validation === "object") {
    const v = o.validation as Record<string, unknown>;
    const residual = typeof v.residual === "number" && Number.isFinite(v.residual) ? v.residual : NaN;
    const count = typeof v.count === "number" && Number.isFinite(v.count) ? v.count : 0;
    const maxErrUt = typeof v.maxErrUt === "number" && Number.isFinite(v.maxErrUt) ? v.maxErrUt : NaN;
    const ratio = typeof v.ratio === "number" && Number.isFinite(v.ratio) ? v.ratio : NaN;
    if (Number.isFinite(residual)) {
      entry.validation = { residual, count, maxErrUt, ratio };
      const l = v.late;
      if (l && typeof l === "object") {
        const lr = l as Record<string, unknown>;
        const lres = typeof lr.residual === "number" && Number.isFinite(lr.residual) ? lr.residual : NaN;
        if (Number.isFinite(lres)) {
          entry.validation.late = {
            residual: lres,
            count: typeof lr.count === "number" && Number.isFinite(lr.count) ? lr.count : 0,
            maxErrUt: typeof lr.maxErrUt === "number" && Number.isFinite(lr.maxErrUt) ? lr.maxErrUt : NaN,
            ratio: typeof lr.ratio === "number" && Number.isFinite(lr.ratio) ? lr.ratio : NaN,
          };
        }
      }
    }
  }
  if (o.fittedWith && typeof o.fittedWith === "object") {
    const f = o.fittedWith as Record<string, unknown>;
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    entry.fittedWith = {
      at: typeof f.at === "string" ? f.at : "",
      crossAxis: num(f.crossAxis),
      nonlin: num(f.nonlin),
      noise: num(f.noise),
      ...(f.magModel === "full" || f.magModel === "diag" ? { magModel: f.magModel } : {}),
      // 磁模型参数也要进档案，否则导入后"标定基于旧模型"会误报
      magNoise: num(f.magNoise),
      hardIron: num(f.hardIron),
      disturbMag: num(f.disturbMag),
      magSoftIron: num(f.magSoftIron),
      magQuantUts: num(f.magQuantUts),
      ...(typeof f.magTargetUts === "number" && Number.isFinite(f.magTargetUts) ? { magTargetUts: f.magTargetUts } : {}),
    };
  }
  // 结构合法性走**共用**校验（解析与配置校验同一套判据，不会出现"能导入但校验不过"）
  return magCalibrationProblems(entry).length === 0 ? entry : null;
}


const VALID_FACES = new Set(["+x", "-x", "+y", "-y", "+z", "-z"]);
/** 合法增益范围：真实器件的刻度/交叉轴只会是个位数百分比偏差（用来拦 1e-10I / 1000I） */
const GAIN_MIN = 0.01;
const GAIN_MAX = 100;
const G_ACC = 9.80665;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const det3 = (m: number[]): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const meanGain = (m: number[]): number => Math.sqrt(m.reduce((a, v) => a + v * v, 0) / 3);
/** 对称（允许器件安装项，但拒绝把非对称矩阵当合法校正结构） */
function symmetricWithin(m: number[]): boolean {
  const s = Math.max(...m.map(Math.abs), 1e-12);
  return Math.abs(m[1] - m[3]) <= 1e-3 * s && Math.abs(m[2] - m[6]) <= 1e-3 * s && Math.abs(m[5] - m[7]) <= 1e-3 * s;
}
/** 对称正定（Sylvester）：刻度矩阵必须正的，否则校正后出现镜像/反号（diag(-1,-1,1) 就是这种） */
function isPositiveDefinite(m: number[]): boolean {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a > 0 && a * e - b * d > 0 && a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) > 0;
}

/**
 * 校准模型合法性（**解析与配置校验共用**；ROUND11 P1）。
 *
 * 只验「可逆 + det>0」不够：`diag(-1,-1,1)` 行列式为正、条件数也只有 3，却是**负定**结构——
 * 导入后粗对准航向整体翻转 180°。器件刻度矩阵必须**对称正定**且增益合理，
 * 所以这里按结构验：对称、正定、平均增益在 [0.01,100]、偏置/残差在物理量级内。
 * 两个模型共用一套判据，避免"能导入但校验不过"的两套标准。
 */
export function calibrationProblems(
  kind: "mag" | "accel",
  cal: MagCalibration | AccelCalibration,
  path = kind === "mag" ? "magCalibration" : "accelCalibration",
): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const mag = kind === "mag" ? (cal as MagCalibration) : null;
  const acc = kind === "accel" ? (cal as AccelCalibration) : null;
  const full = mag ? (mag.kind ?? "diag") === "full" : false;
  if (mag && !full) {
    mag.scale.forEach((v, i) => {
      if (!(v >= GAIN_MIN && v <= GAIN_MAX)) {
        out.push({ path: `${path}.scale[${i}]`, message: `软铁缩放 ${v} 超出 [${GAIN_MIN}, ${GAIN_MAX}]` });
      }
    });
  }
  const mkey = `${path}.${mag ? "matrix" : "M"}`;
  // ROUND12：full 模型**必须**带 matrix——旧实现把这段放进 `if (M)`，缺 matrix 时直接跳过，
  // 于是"解析拒、校验过"两个标准并存
  if (mag && full && (!mag.matrix || mag.matrix.length !== 9)) {
    out.push({ path: mkey, message: "完整椭球模型缺少 matrix（9 个有限数）" });
  }
  const M = mag ? (full ? mag.matrix ?? null : null) : acc!.M;
  if (M) {
    if (M.length !== 9 || !M.every(isNum)) {
      out.push({ path: mkey, message: "需要 9 个有限数" });
    } else if (mag) {
      // 磁椭球是**校正矩阵**：约定为对称正定
      if (!symmetricWithin(M)) out.push({ path: mkey, message: "椭球矩阵不对称（不是合法校正结构）" });
      if (!isPositiveDefinite(M)) out.push({ path: mkey, message: "椭球矩阵非正定（会出现镜像/反号校正）" });
      if (!(meanGain(M) >= GAIN_MIN && meanGain(M) <= GAIN_MAX)) {
        out.push({ path: mkey, message: `平均增益 ${meanGain(M).toPrecision(3)} 超出 [${GAIN_MIN}, ${GAIN_MAX}]` });
      }
      if (!(conditionNumber3(M) <= MATRIX_MAX_COND)) out.push({ path: mkey, message: "条件数过大（接近不可逆）" });
    } else {
      // 加计刻度矩阵**允许安装失准/交叉轴**（见 core/accelcal.ts 的测量模型），
      // 因此不能套用"对称正定"。这里按本装置的结构验：对角为正且接近 1、交叉项受限、
      // 行列式为正（不镜像）、条件数可控。
      for (let i = 0; i < 3; i++) {
        const d = M[i * 3 + i];
        if (!(d > 0.2 && d < 5)) out.push({ path: mkey, message: `对角刻度 M[${i}][${i}]=${d} 不合理（应接近 1）` });
      }
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i !== j && !(Math.abs(M[i * 3 + j]) <= 0.5)) {
            out.push({ path: mkey, message: `交叉轴项 M[${i}][${j}]=${M[i * 3 + j]} 过大（应 ≤0.5）` });
          }
        }
      }
      if (!(det3(M) > 0)) out.push({ path: mkey, message: "刻度矩阵行列式为负（镜像，不是合法校正）" });
      if (!(conditionNumber3(M) <= MATRIX_MAX_COND)) out.push({ path: mkey, message: "条件数过大（接近不可逆）" });
    }
  }
  if (mag) {
    if (!mag.offset.every(isNum)) out.push({ path: `${path}.offset`, message: "硬铁偏移必须有限" });
    else if (Math.hypot(...mag.offset) > 1e4) out.push({ path: `${path}.offset`, message: "硬铁偏移模长过大" });
    if (!(mag.field > 0 && mag.field <= 1e5)) out.push({ path: `${path}.field`, message: `场强 ${mag.field} μT 不合理` });
    if (!(mag.residual >= 0 && mag.residual <= 1)) out.push({ path: `${path}.residual`, message: `残差 ${mag.residual} 应为 0..1` });
  } else {
    if (!acc!.bias.every(isNum)) out.push({ path: `${path}.bias`, message: "偏置必须有限" });
    else if (Math.max(...acc!.bias.map(Math.abs)) > 0.35 * G_ACC) {
      // 与拟合路径同一门槛（core/accelcal.ts 的 ACCEL_MAX_BIAS_G）
      out.push({ path: `${path}.bias`, message: "偏置超过 0.35g（单位或朝向错了）" });
    }
    if (!acc!.rmse.every((v) => v >= 0 && v <= 0.15 * G_ACC)) {
      out.push({ path: `${path}.rmse`, message: "残差 RMS 应为 0..0.15g（与拟合门槛一致）" });
    }
    for (const f of acc!.faces) {
      if (!VALID_FACES.has(f)) {
        out.push({ path: `${path}.faces`, message: `未知朝向 ${String(f)}` });
        break;
      }
    }
    // 六面标定至少 4 个不同朝向才有可观性（与 calibrateAccel 同一条件）
    if (new Set(acc!.faces).size < 4) {
      out.push({ path: `${path}.faces`, message: `覆盖朝向不足（${new Set(acc!.faces).size} 个，至少 4 个）` });
    }
  }
  const count = cal.count;
  if (!Number.isInteger(count) || count < 4) {
    out.push({ path: `${path}.count`, message: `样本数 ${count} 非法（至少 4）` });
  }
  return out;
}

/** 兼容入口：磁模型合法性 */
export function magCalibrationProblems(cal: MagCalibration, path?: string): ConfigProblem[] {
  return calibrationProblems("mag", cal, path);
}
/** 兼容入口：加计模型合法性 */
export function accelCalibrationProblems(cal: AccelCalibration, path?: string): ConfigProblem[] {
  return calibrationProblems("accel", cal, path);
}

export function parseAccelCalibration(raw: unknown): AccelCalibration | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.M) || o.M.length !== 9 || !o.M.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return null;
  }
  const bias = numTriple(o.bias);
  const rmse = numTriple(o.rmse);
  if (!bias || !rmse) return null;
  // 不再把非法 face 静默过滤掉：过滤会让"坏输入"在解析后变成"看起来正常"（ROUND12）
  if (o.faces !== undefined && (!Array.isArray(o.faces) || !o.faces.every((f) => typeof f === "string"))) {
    return null;
  }
  const faces = Array.isArray(o.faces) ? (o.faces as AccelCalibration["faces"]) : [];
  const cal: AccelCalibration = {
    M: o.M as number[],
    bias,
    rmse,
    count: typeof o.count === "number" && Number.isFinite(o.count) ? o.count : 0,
    faces,
  };
  if (o.validation && typeof o.validation === "object") {
    const v = o.validation as Record<string, unknown>;
    cal.validation = {
      meanNormErrMs2: typeof v.meanNormErrMs2 === "number" && Number.isFinite(v.meanNormErrMs2) ? v.meanNormErrMs2 : NaN,
      maxNormErrMs2: typeof v.maxNormErrMs2 === "number" && Number.isFinite(v.maxNormErrMs2) ? v.maxNormErrMs2 : NaN,
      heldOutFaces: typeof v.heldOutFaces === "number" && Number.isFinite(v.heldOutFaces) ? v.heldOutFaces : 0,
    };
  }
  if (o.fittedWith && typeof o.fittedWith === "object") {
    const f = o.fittedWith as Record<string, unknown>;
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    cal.fittedWith = {
      at: typeof f.at === "string" ? f.at : "",
      crossAxis: num(f.crossAxis),
      nonlin: num(f.nonlin),
      noise: num(f.noise),
    };
  }
  // 方向误差（ROUND11：曾经在解析时丢失，档案往返后这两个字段消失）
  if (cal.validation && o.validation && typeof o.validation === "object") {
    const v = o.validation as Record<string, unknown>;
    const num = (x: unknown): number | undefined =>
      typeof x === "number" && Number.isFinite(x) ? x : undefined;
    const md = num(v.meanDirErrDeg);
    const xd = num(v.maxDirErrDeg);
    if (md !== undefined) cal.validation.meanDirErrDeg = md;
    if (xd !== undefined) cal.validation.maxDirErrDeg = xd;
  }
  return accelCalibrationProblems(cal).length === 0 ? cal : null;
}

/** 由 seed 生成初始姿态；random 用 20–35° 均匀球面轴（与历史行为一致，但可复现） */
export function initialAttitudeOf(config: ExperimentConfig): Quat {
  const ia = config.initialAttitude;
  if (ia.kind === "level") return qId();
  if (ia.kind === "fixed-axis") {
    const a = ia.axis ?? [1, 0, 0];
    const n = Math.hypot(a[0], a[1], a[2]) || 1;
    return qFromAxisAngle([a[0] / n, a[1] / n, a[2] / n], (ia.angleDeg ?? 30) * RAD);
  }
  const r = mulberry32(config.seed >>> 0);
  const az = r() * 2 * Math.PI;
  const pol = Math.acos(Math.max(-1, Math.min(1, 2 * r() - 1)));
  const axis: V3 = [
    Math.sin(pol) * Math.cos(az),
    Math.sin(pol) * Math.sin(az),
    Math.cos(pol),
  ];
  return qFromAxisAngle(axis, (20 + 15 * r()) * RAD);
}
