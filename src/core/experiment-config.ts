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
import type { AccelCalibration } from "./accelcal";
import { calibrationProblems, copyCalibration, isRecord, isFiniteNumber } from "./calibration-validation";
import { scenarios } from "./scenarios";
export { calibrationProblems, MATRIX_MAX_COND } from "./calibration-validation";
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
    // 与界面读回同形：不写这个字段时 `tuningOf()` 会补出 false，默认档案就往返失败
    kalmanResetCov: false,
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
  // 只遍历**已知算法 id**，并对缺失/空条目回落到默认值。
  //
  // 旧实现按 `Object.keys(src)` 遍历：档案里多一个 `"extension": null` 就会去读 `null.params`
  // 直接抛 TypeError（复核 SW-04：schema 校验放行、克隆却崩，parseArchive 不返回约定的失败结果）。
  // 现在克隆是**全函数**：多余的容器键被忽略（当前 schema 由 experimentConfigProblems 明确拒绝），
  // 缺失的条目补默认，不会把异常漏给调用方。
  for (const id of Object.keys(DEFAULT_ESTIMATOR_TUNING) as EstimatorId[]) {
    const t = src?.[id];
    const def = DEFAULT_ESTIMATOR_TUNING[id];
    // 默认值兜底 + 输入覆盖：缺条目、缺字段、空 params 都能克隆出**可被内核消费**的完整配置
    out[id] = {
      ...def,
      ...(t && typeof t === "object" ? t : {}),
      params: { ...def.params, ...(t?.params ?? {}) },
    };
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

/**
 * 规范形（canonical form）：任何**合法当前 schema** 的配置只有一种表示。
 *
 * 为什么需要：schema 允许若干可选字段（`magTargetUts` / `autoCoarseAlign` / `steadyFromSec` /
 * `manualTargetDeg` / `ab` / kalman 的三个可选键 / 非固定轴的 `axis,angleDeg` / 未知扩展键），
 * 于是「同一语义」可以有多种合法 JSON——默认配置自己往返稳定，一份省略了可选字段的合法档案
 * 却会解析成"另一份配置"（界面探测、深链、批量评测各看到一套）。
 *
 * 本函数是**纯函数**：把所有**可选**字段补齐为文档默认值、统一表示形态、丢掉内核不读的扩展键，
 * 并把键顺序固定为默认配置的顺序，于是 `parse → canonicalize → buildArchive` 逐字节稳定。
 *
 * 明确**不做**的事（否则会把"用户明确要求的配置"悄悄改掉，比拒绝更糟）：
 *  - 不归一化 fixed-axis 的轴方向与转角，不重算校准，不清洗任何数值；
 *  - 不改动 schema 要求的必填语义字段（`enabled` / 各算法的 `magEnabled` / 门控阈值 …）：
 *    这类"界面表达不了"的取值仍由界面层的可表达性判定拒绝，而不是在这里被抹平；
 *  - 越界/非法值仍由 `experimentConfigProblems` 拦在解析阶段。
 */
export function canonicalizeExperimentConfig(c: ExperimentConfig): ExperimentConfig {
  const magCal = c.magCalibration ? copyCalibration("mag", c.magCalibration as unknown as Record<string, unknown>) : null;
  const accelCal = c.accelCalibration ? copyCalibration("accel", c.accelCalibration as unknown as Record<string, unknown>) : null;
  const estimators = {} as Record<EstimatorId, EstimatorTuning>;
  for (const id of Object.keys(DEFAULT_ESTIMATOR_TUNING) as EstimatorId[]) {
    const src = c.estimators[id];
    // 必填语义字段原样保留（类型已在解析阶段验过）；只补可选键。
    const out: EstimatorTuning = {
      enabled: src.enabled,
      magEnabled: src.magEnabled,
      accelGate: src.accelGate,
      gateDeg: src.gateDeg,
      gateMagPct: src.gateMagPct,
      gateRecovery: src.gateRecovery,
      rampEnabled: src.rampEnabled,
      magMode: src.magMode,
      params: {},
    };
    // kalman 的三个可选键只属于 kalman：其它算法不许携带（否则同一语义有两种表示）
    if (id === "kalman") {
      out.kalmanGate = src.kalmanGate === "mahalanobis" ? "mahalanobis" : "angle";
      out.kalmanChi2 = isFiniteNumber(src.kalmanChi2) ? src.kalmanChi2 : DEFAULT_ESTIMATOR_TUNING.kalman.kalmanChi2;
      out.kalmanResetCov = src.kalmanResetCov === true;
    }
    // params：只保留内核**真正读取**的白名单键，顺序固定为默认表顺序。
    // 未知键既不落盘也不参与比较：`experimentConfigProblems` 对当前 schema 直接拒绝它们，
    // 旧 schema 迁移时由 notes 报出（不再"保留一个内核不读的参数"）。
    const params: Record<string, number> = {};
    for (const k of Object.keys(DEFAULT_ESTIMATOR_TUNING[id].params)) params[k] = src.params[k];
    out.params = params;
    estimators[id] = out;
  }
  const imu = { ...DEFAULT_IMU_PARAMS } as ImuParams;
  for (const k of Object.keys(DEFAULT_IMU_PARAMS) as Array<keyof ImuParams>) {
    const v = c.imu?.[k];
    if (isFiniteNumber(v)) (imu as unknown as Record<string, number>)[k] = v;
  }
  const kind = c.initialAttitude?.kind === "random" ? "random" : c.initialAttitude?.kind === "fixed-axis" ? "fixed-axis" : "level";
  const initial: InitialAttitudeSpec =
    kind === "fixed-axis"
      ? { kind, axis: [...(c.initialAttitude.axis ?? [1, 0, 0])] as V3, angleDeg: c.initialAttitude.angleDeg ?? 30 }
      : { kind };
  // 键顺序 = DEFAULT_EXPERIMENT_CONFIG 的顺序：规范形因此逐字节可比
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    seed: c.seed,
    scenario: c.scenario,
    durationSec: c.durationSec,
    solveRateHz: c.solveRateHz,
    imu,
    estimators,
    initialAttitude: initial,
    manualTargetDeg: c.manualTargetDeg ? ([...c.manualTargetDeg] as [number, number, number]) : [0, 0, 0],
    magModel: c.magModel === "full" ? "full" : "diag",
    magTargetUts: c.magTargetUts ?? magCal?.field ?? 50,
    magCalibration: magCal,
    accelCalibration: accelCal,
    magCalibrationApplied: magCal !== null && c.magCalibrationApplied !== false,
    accelCalibrationApplied: accelCal !== null && c.accelCalibrationApplied !== false,
    autoCoarseAlign: c.autoCoarseAlign !== false,
    steadyFromSec: c.steadyFromSec ?? null,
    ab: { mode: c.ab?.mode === "online-fork" ? "online-fork" : "same-start" },
  };
}

export interface ConfigProblem {
  path: string;
  message: string;
}

/** 界面「解算频率」下拉的全部档位（**UI 可表达的离散选项**）。 */
export const SOLVE_RATE_CHOICES = [500, 250, 125, 100, 50] as const;

/**
 * 内核支持的解算频率**物理范围**（Hz）。
 *
 * 为什么与 `SOLVE_RATE_CHOICES` 分开：数值内核（runner / Worker / 离线复算）能正确跑任意
 * 合理频率——"200 Hz 在 500 Hz 仿真下每 2.5 步解算一次"是内核的正常能力，实测也正确
 * （`SolveLoop` 的余量保留）。此前把 UI 下拉的五档当成通用 schema，于是
 * 「内核跑得对、通用校验器却拒绝 200 Hz」——UI 的枚举不该成为数值内核的契约。
 *
 * 分层：本范围用于 `experimentConfigProblems`（schema 层）；
 * `archiveExpressibilityProblems`（界面层）再要求取值落在下拉档位内。
 */
export const KERNEL_SOLVE_RATE_HZ = { min: 10, max: 1000 } as const;

/**
 * 档案里存在、但**界面上没有对应控件**的顶层字段。
 *
 * 它们不参与「导入后逐字段一致」的往返比较（界面无法表达，比较必然失败），
 * 导入提示必须把它们列为「本次未恢复」。新增字段时要么在界面上接一个控件，
 * 要么加进这个清单——不能让导入"成功"却悄悄换了一份配置。
 */
/**
 * 只保留真正无法恢复的字段。
 *
 * `steadyFromSec` / `autoCoarseAlign` 之前也被列在这里，但它们**直接改变解算结果**
 * （粗对准会重置姿态、稳态窗口会改变 RMSE）——把它们当"展示字段"会让
 * 「按同一配置重跑」在不同导入前后得到两套结论。现在两者都进了活状态并参与往返比较。
 * `durationSec` 仍然只能是"本次已跑时长"：导入后从 seed 起点重新计时。
 */
export const ARCHIVE_IGNORED_KEYS = ["durationSec"] as const;

/**
 * 界面无法表达的取值：导入必须**拒绝**，而不是解析成功后静默改写。
 * 只列出「schema 允许、界面做不到」的组合；界面能调的范围由 apply 后的读回比较兜底。
 */
export function archiveExpressibilityProblems(cfg: ExperimentConfig): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (cfg.initialAttitude?.kind === "fixed-axis") {
    out.push({ path: "initialAttitude.kind", message: "界面只支持 level / random；固定轴初始姿态只能由脚本/runner 使用" });
  }
  // 解算频率：内核允许 [10,1000] Hz 的任意整数，但**界面**只有下拉里的五档。
  // 这一条必须留在界面层：放进 schema 层会把"UI 枚举"变成"数值内核契约"（复核 P2-3）。
  if (Number.isFinite(cfg.solveRateHz) && !(SOLVE_RATE_CHOICES as readonly number[]).includes(cfg.solveRateHz)) {
    out.push({
      path: "solveRateHz",
      message: `界面下拉只有 ${SOLVE_RATE_CHOICES.join(" / ")} Hz；${cfg.solveRateHz} Hz 只能由脚本/runner 使用`,
    });
  }
  for (const id of Object.keys(cfg.estimators ?? {}) as EstimatorId[]) {
    if (cfg.estimators[id]?.enabled === false) {
      out.push({ path: `estimators.${id}.enabled`, message: "界面不允许关闭单个算法（五种算法始终同时运行）" });
    }
  }
  return out;
}

/**
 * 档案 → 界面 → 读回 的往返比较：返回不一致的字段路径（最多 8 条）。
 *
 * 为什么要读回比较：控件的 min/max/step 是"界面真相"，档案里的 999999 会被
 * 滑块夹到 5，333 Hz 会被下拉回落成 500 Hz。旧实现解析成功后直接 apply，
 * 用户看到「已导入」，实际跑的是另一份配置（复核反例）。现在导入流程在提交前
 * 用本函数核对，不一致就回滚并报具体字段。
 */
export function archiveRoundTripProblems(want: ExperimentConfig, got: ExperimentConfig): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const skip = new Set<string>(ARCHIVE_IGNORED_KEYS);
  const fmt = (v: unknown): string => {
    if (v === undefined) return "缺失";
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= 8) return;
    if (typeof a === "number" && typeof b === "number") {
      const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > tol) {
        out.push({ path, message: `档案 ${a} → 导入后 ${b}（界面会改写这个值）` });
      }
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        out.push({ path, message: `档案 ${fmt(a)} → 导入后 ${fmt(b)}` });
        return;
      }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const k of keys) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    if (a !== b) out.push({ path, message: `档案 ${fmt(a)} → 导入后 ${fmt(b)}` });
  };
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    walk((want as unknown as Record<string, unknown>)[k], (got as unknown as Record<string, unknown>)[k], k);
  }
  return out;
}

/** 原始字段契约：当前版递归 required；旧版仅验已声明的白名单字段。 */
export function experimentConfigProblems(raw: unknown, required = true): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (!isRecord(raw)) return [{ path: "config", message: "须为对象" }];
  const add = (path: string, message: string): void => { out.push({ path, message }); };
  const check = (o: Record<string, unknown>, k: string, path: string, ok: (v: unknown) => boolean, must = false): void => {
    if (o[k] === undefined && !must) return;
    if (!ok(o[k])) add(path, o[k] === undefined ? "缺少必需字段" : "字段类型、枚举或范围不合法");
  };
  const num = (min = 0, max = 1e6) => (v: unknown): boolean => isFiniteNumber(v) && v >= min && v <= max;
  const positive = (v: unknown): boolean => isFiniteNumber(v) && v > 0 && v <= 1e6;
  const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
  const bool = (v: unknown): boolean => typeof v === "boolean";
  const entry = (o: Record<string, unknown>, k: string, path: string, must = false): Record<string, unknown> | null => {
    check(o, k, path, isRecord, must); return isRecord(o[k]) ? o[k] : null;
  };
  check(raw, "schemaVersion", "schemaVersion", v => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= EXPERIMENT_SCHEMA_VERSION, required);
  // seed 直接进入 PRNG（`>>>0`）：小数/负数/超 32 位会被悄悄改语义，必须拦在解析阶段。
  check(raw, "seed", "seed", v => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff, required);
  check(raw, "scenario", "scenario", v => typeof v === "string" && Object.prototype.hasOwnProperty.call(scenarios, v), required);
  check(raw, "durationSec", "durationSec", num(0.1, 86400), required);
  // schema 层只要求内核物理范围（见 KERNEL_SOLVE_RATE_HZ）：200 Hz 是内核能力，不该被拒。
  // 「界面下拉能不能表达」由 archiveExpressibilityProblems 负责。
  check(raw, "solveRateHz", "solveRateHz",
    v => Number.isInteger(v) && (v as number) >= KERNEL_SOLVE_RATE_HZ.min && (v as number) <= KERNEL_SOLVE_RATE_HZ.max, required);
  check(raw, "magModel", "magModel", v => v === "diag" || v === "full", required);
  check(raw, "magTargetUts", "magTargetUts", positive);
  for (const k of ["magCalibrationApplied", "accelCalibrationApplied", "autoCoarseAlign"]) check(raw, k, k, bool);
  // 手动目标角由三个 ±180° 滑块表达；超出范围会被控件夹住。
  check(raw, "manualTargetDeg", "manualTargetDeg", v => triple(v) && (v as number[]).every(x => x >= -180 && x <= 180));
  check(raw, "steadyFromSec", "steadyFromSec", v => v === null || num(0, 86400)(v));
  const imu = entry(raw, "imu", "imu", required);
  if (imu) for (const k of Object.keys(DEFAULT_IMU_PARAMS)) {
    const optional = ["sensorBandwidthHz", "sensorDelaySkewMs", "sensorSampleHz"].includes(k);
    check(imu, k, `imu.${k}`, num(), required && !optional);
  }
  const estimators = entry(raw, "estimators", "estimators", required);
  if (estimators) {
    /**
     * 未知算法 id / 未知参数键：**明确报出字段路径**，不再静默保留。
     *
     * 复核 SW-04：旧实现只校验五个已知算法与已知参数，多余的键却能穿过校验被克隆进配置；
     * 运行侧（`setParams`）只读白名单里的键，于是"解析成功、运行无视、读回比较失败"三件事同时发生
     * （`unknownKernelParam=3` 就是这么来的）。现在当前 schema 直接拒绝，旧 schema 由调用方记进 notes。
     */
    for (const key of Object.keys(estimators)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_ESTIMATOR_TUNING, key)) {
        add(`estimators.${key}`, "未知算法 id（内核只认 pure / comp / mahony / madg / kalman）");
      }
    }
    for (const id of Object.keys(DEFAULT_ESTIMATOR_TUNING) as EstimatorId[]) {
      const path = `estimators.${id}`, t = entry(estimators, id, path, required);
      if (!t) continue;
      for (const k of ["enabled", "magEnabled", "accelGate", "gateRecovery", "rampEnabled"]) check(t, k, `${path}.${k}`, bool, required);
      check(t, "gateDeg", `${path}.gateDeg`, v => isFiniteNumber(v) && v > 0 && v <= 180, required);
      check(t, "gateMagPct", `${path}.gateMagPct`, positive, required);
      check(t, "magMode", `${path}.magMode`, v => v === "yaw" || v === "full", required);
      check(t, "kalmanGate", `${path}.kalmanGate`, v => v === "angle" || v === "mahalanobis");
      check(t, "kalmanChi2", `${path}.kalmanChi2`, positive);
      check(t, "kalmanResetCov", `${path}.kalmanResetCov`, bool);
      const params = entry(t, "params", `${path}.params`, required);
      if (params) {
        const knownParams = Object.keys(DEFAULT_ESTIMATOR_TUNING[id].params);
        for (const k of knownParams) check(params, k, `${path}.params.${k}`, num(), required);
        for (const key of Object.keys(params)) {
          if (!knownParams.includes(key)) {
            add(`${path}.params.${key}`, `未知参数键（${id} 只读 ${knownParams.join(" / ") || "（无参数）"}）——内核不会读取它`);
          }
        }
      }
    }
  }
  const ia = entry(raw, "initialAttitude", "initialAttitude", required);
  if (ia) {
    check(ia, "kind", "initialAttitude.kind", v => v === "level" || v === "fixed-axis" || v === "random", required);
    check(ia, "axis", "initialAttitude.axis", v => triple(v) && Math.hypot(...v) >= 1e-9, ia.kind === "fixed-axis");
    check(ia, "angleDeg", "initialAttitude.angleDeg", num(0, 180), ia.kind === "fixed-axis");
  }
  const ab = entry(raw, "ab", "ab");
  if (ab) check(ab, "mode", "ab.mode", v => v === "same-start" || v === "online-fork", true);
  for (const [key, kind] of [["magCalibration", "mag"], ["accelCalibration", "accel"]] as const) {
    if (raw[key] === undefined) { if (required && key === "magCalibration") add(key, "缺少必需字段（对象或 null）"); }
    else if (raw[key] !== null) out.push(...calibrationProblems(kind, raw[key], key));
  }
  if (raw.magCalibration == null && raw.magCalibrationApplied === true) add("magCalibrationApplied", "已应用但模型为空");
  if (raw.accelCalibration == null && raw.accelCalibrationApplied === true) add("accelCalibrationApplied", "已应用但模型为空");
  if (isRecord(raw.magCalibration) && (raw.magCalibration.kind ?? (raw.magCalibration.matrix !== undefined ? "full" : "diag")) !== raw.magModel && (required || raw.magModel !== undefined)) add("magModel", "与 magCalibration.kind 不一致");
  return out;
}

/** 校验配置只返回字段路径，不抛异常，与档案原始契约一致。 */
export function validateExperimentConfig(c: ExperimentConfig): ConfigProblem[] {
  return experimentConfigProblems(c);
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
        // 迁移宽容但**不留无效语义**：只接受默认表里认识的参数键。
        // 未知键由 notes 报出（旧 schema 走 `experimentConfigProblems(raw, false)`），
        // 但不写进迁移结果——否则"迁移成功"的配置仍会被当前 schema 校验拒绝（复核 SW-04）。
        const dstParams = dst.params;
        for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && Object.prototype.hasOwnProperty.call(dstParams, k)) dstParams[k] = v;
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

/** 原始模型先验证，合法时才复制；不清洗字段/元素或制造默认残差。 */
export function parseMagCalibration(raw: unknown): MagCalibration | null {
  return isRecord(raw) && calibrationProblems("mag", raw).length === 0 ? copyCalibration("mag", raw) : null;
}
export function parseAccelCalibration(raw: unknown): AccelCalibration | null {
  return isRecord(raw) && calibrationProblems("accel", raw).length === 0 ? copyCalibration("accel", raw) : null;
}
export function magCalibrationProblems(cal: MagCalibration, path?: string): ConfigProblem[] {
  return calibrationProblems("mag", cal, path);
}
export function accelCalibrationProblems(cal: AccelCalibration, path?: string): ConfigProblem[] {
  return calibrationProblems("accel", cal, path);
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
