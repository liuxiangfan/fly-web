/**
 * 档案 → 界面 → 读回 的**离线模型**（纯逻辑，可在 Node 自检）。
 *
 * 为什么需要它：导入失败必须是**严格零副作用**事务。旧实现靠「把配置真的写进控件、
 * 再读回比较」来探测可表达性，于是探测本身就会触发真实事件——例如场景切到运动学一致
 * 剧本时，`syncLoopAvailability()` 会把闭环开关**取消勾选**；回滚只把场景写回去，
 * `loop.checked` 再也回不来（复核 P0）。写控件还有 toast、首帧提示、说明文字等一堆
 * 未进入 `ExperimentConfig` 的副作用，不可能逐一列举并可靠恢复。
 *
 * 因此这里把「控件 + 事件处理器」这条流水线**建模成纯函数**：给定配置与控件约束
 * （min/max/step/选项，运行时从真实 DOM 读取，只读属性、不触发事件），算出界面会读回的
 * 配置。判定全部通过后才真正提交一次。控件约束从 DOM 读，模型不会与页面漂移；
 * `writeArchiveState` 与模型共用同一张绑定表，语义也不会与写入漂移。
 *
 * 边界（写进来避免二次误读）：
 *  - 本模块只覆盖**档案往返比较涉及**的字段；校准对象、seed、粗对准、稳态窗口在界面里
 *    是直接写入/直接读出的，模型照抄即可。
 *  - 模型判「不可表达」的档案会被**拒绝**；判「可表达」的档案仍会在提交后用真实读回
 *    再核一次（防模型失真的兜底断言）。
 */
import {
  DEFAULT_ESTIMATOR_TUNING,
  DEFAULT_IMU_PARAMS,
  defaultExperimentConfig,
  experimentConfigProblems,
  archiveRoundTripProblems,
  canonicalizeExperimentConfig,
  type ConfigProblem,
  type EstimatorId,
  type ExperimentConfig,
  type EstimatorTuning,
} from "./experiment-config";
import type { ImuParams } from "./imu";

/** IMU 参数 → 主界面控件（含「控件值 = 物理值 × scale」的换算）；写控件与离线模型共用。 */
export const ARCHIVE_IMU_CONTROLS: ReadonlyArray<readonly [keyof ImuParams, string, number]> = [
  ["gyroBiasDps", "imu-gyro-bias", 1],
  ["gyroNoiseDps", "imu-gyro-noise", 1],
  ["gyroWalkDps", "imu-gyro-walk", 1],
  ["accelNoise", "imu-accel-noise", 1],
  ["accelCrossAxis", "imu-cross-axis", 100],
  ["accelNonlin", "imu-accel-nonlin", 100],
  ["linAccel", "imu-lin-accel", 1],
  ["vibration", "imu-vibration", 1],
  ["magNoise", "imu-mag-noise", 1],
  ["magQuantUts", "imu-mag-quant", 1],
  ["disturbMag", "imu-mag-disturb", 1],
  ["hardIron", "imu-hard-iron", 1],
  ["magSoftIron", "imu-soft-iron", 1],
  ["sensorDelayMs", "imu-delay", 1],
  ["gyroScaleErr", "imu-gyro-scale", 100],
  ["gyroMisalign", "imu-gyro-misalign", 100],
  ["sensorBandwidthHz", "imu-bandwidth", 1],
  ["sensorDelaySkewMs", "imu-delay-skew", 1],
  ["sensorSampleHz", "imu-sample-rate", 1],
];

/** 档案提交时按序执行的界面步骤（顺序即语义：逐算法参数必须排在「全局开关广播」之后）。 */
export type ArchiveUiStep =
  | { kind: "slider"; id: string; value: number }
  | { kind: "select"; id: string; value: string }
  | { kind: "check"; id: string; value: boolean };

/**
 * 配置 → 界面步骤表（**唯一来源**）。
 *
 * `writeArchiveState` 逐条执行它；离线模型按同一条表反推读回值。两者不会再各写一份映射，
 * 于是「写了却读不回」这类不一致只能在测试里出现，不会在生产里悄悄发生。
 */
export function archiveUiSteps(cfg: ExperimentConfig): ArchiveUiStep[] {
  const steps: ArchiveUiStep[] = [];
  const slider = (id: string, value: number): void => { steps.push({ kind: "slider", id, value }); };
  const select = (id: string, value: string): void => { steps.push({ kind: "select", id, value }); };
  const check = (id: string, value: boolean): void => { steps.push({ kind: "check", id, value }); };

  // 导入的是具体数值：预设标签切到「自定义」，避免界面显示某预设名却跑另一组参数
  select("imu-preset", "custom");
  for (const [key, id, scale] of ARCHIVE_IMU_CONTROLS) slider(id, (cfg.imu[key] ?? 0) * scale);
  // 0 也要显式写回：gyroRangeDps=0（不限量程）时若跳过下拉，导入后仍停在上一个量程，
  // 读回比较会把它当成「档案无法恢复」——其实是这里漏写。
  select("imu-gyro-range", String(cfg.imu.gyroRangeDps ?? 0));
  select("scenario-select", cfg.scenario);
  select("solve-rate", String(cfg.solveRateHz));
  // 初始姿态是档案的一部分（random 对应「随机初始偏差」开关）
  check("init-offset-toggle", cfg.initialAttitude.kind === "random");
  if (cfg.estimators.comp.params.alpha !== undefined) slider("comp-alpha", cfg.estimators.comp.params.alpha);
  if (cfg.estimators.mahony.params.kp !== undefined) slider("mahony-kp", cfg.estimators.mahony.params.kp);
  if (cfg.estimators.mahony.params.ki !== undefined) slider("mahony-ki", cfg.estimators.mahony.params.ki);
  if (cfg.estimators.madg.params.beta !== undefined) slider("madg-beta", cfg.estimators.madg.params.beta);
  if (cfg.estimators.kalman.params.gyroNoiseDps !== undefined) slider("kalman-proc", cfg.estimators.kalman.params.gyroNoiseDps);
  if (cfg.estimators.kalman.params.obsNoise !== undefined) slider("kalman-obs", cfg.estimators.kalman.params.obsNoise);
  const trio = cfg.estimators.comp;
  check("mag-enable", trio.magEnabled);
  check("gate-toggle", trio.accelGate);
  check("gate-recovery", trio.gateRecovery);
  slider("gate-deg", trio.gateDeg);
  slider("gate-mag", trio.gateMagPct * 100);
  select("mag-mode", cfg.estimators.mahony.magMode);
  if (cfg.estimators.kalman.kalmanGate) select("kalman-gate", cfg.estimators.kalman.kalmanGate);
  check("kalman-reset-cov", cfg.estimators.kalman.kalmanResetCov === true);
  const manual = cfg.manualTargetDeg ?? [0, 0, 0];
  slider("man-roll", manual[0]);
  slider("man-pitch", manual[1]);
  slider("man-yaw", manual[2]);
  select("ab-mode", cfg.ab?.mode ?? "same-start");
  select("magcal-model", cfg.magCalibration?.kind ?? cfg.magModel ?? "diag");
  return steps;
}

/** 控件类型与约束（运行时从真实 DOM 只读采集，不触发事件）。 */
export interface ControlSpec {
  kind: "slider" | "select" | "check";
  /** 仅 slider：HTML range 的 min/max/step（step 非法时按 bindSlider 回落到 0.01） */
  min?: number;
  max?: number;
  step?: number;
  /** 仅 select：全部合法选项值 */
  options?: readonly string[];
}
export type ControlSpecs = Record<string, ControlSpec>;

/**
 * 滑块的量化规则（**唯一来源**：界面的 `bindSlider` 与离线模型都调它）。
 *
 * 规则 = 先夹到 [min,max]，再按 step（基准 min）对齐；对齐后若越过 max，
 * 退到范围内**最大**的网格点。
 *
 * 为什么最后一步不能直接夹到 max（复核 SW-03）：`(max−min)` 不是 step 整数倍时
 * （用户把步距框改成 2，而区间是 0…5），`round` 会得到 6；旧实现把 6 夹成 5——
 * 而 5 不在 0/2/4 这条网格上。于是离线模型预测"读回 5"、真实控件读回 4，
 * 读回比较要么误放行、要么把合法档案判成"界面无法恢复"。现在两边都对到 4。
 */
export function quantizeSliderValue(raw: number, min: number, max: number, step: number): number {
  const s = Number.isFinite(step) && step > 0 ? step : 0.01;
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 100;
  const v = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : lo;
  const snapped = lo + Math.round((v - lo) / s) * s;
  const gridMax = lo + Math.floor((hi - lo) / s) * s;
  const clamped = snapped > hi ? gridMax : snapped;
  return Math.min(hi, Math.max(lo, parseFloat(clamped.toFixed(6))));
}

/**
 * 复现 `bindSlider` 的量化：先按 range 的 min/max 夹紧，再按 step（基准 = min）对齐，
 * 最后 `toFixed(6)` 去浮点毛刺再夹一次。浏览器对 `input.value = "..."` 自己做的
 * 也是「夹紧 + 按 step 对齐」，两步复合后与这里的单步等价。
 */
export function snapSliderValue(spec: ControlSpec | undefined, raw: number): number {
  return quantizeSliderValue(raw, spec?.min ?? 0, spec?.max ?? 100, spec?.step ?? 0.01);
}

function cloneTuning(id: EstimatorId): EstimatorTuning {
  const t = DEFAULT_ESTIMATOR_TUNING[id];
  return { ...t, params: { ...t.params } };
}

/**
 * 离线读回模型：把「写步骤 + 控件约束」重放成 `currentExperimentConfig()` 会给出的配置。
 *
 * 每个字段都对应 main.ts 里的一段真实语义（写步骤的顺序、处理器的广播/换算）。
 * 只要模型判定的读回值与期望值逐字段一致，就保证真实提交后读回比较也一定一致。
 */
export function predictedArchiveReadback(cfg: ExperimentConfig, specs: ControlSpecs): ExperimentConfig {
  const c = defaultExperimentConfig();
  const slider = (id: string, raw: number): number => snapSliderValue(specs[id], raw);
  /** select 写入不存在的选项时，浏览器把 value 置空（"-1 未选中"），处理器再按空值回落。 */
  const select = (id: string, want: string): string => {
    const s = specs[id];
    if (!s || s.kind !== "select") return want;
    return s.options && s.options.includes(want) ? want : "";
  };
  const check = (id: string, on: boolean): boolean => on && specs[id]?.kind === "check";

  c.seed = cfg.seed;
  c.scenario = select("scenario-select", cfg.scenario);
  // solve-rate 处理器：hz = Number(value)；非有限或 <1 → 500
  const hz = Number(select("solve-rate", String(cfg.solveRateHz)));
  c.solveRateHz = Number.isFinite(hz) && hz >= 1 ? hz : 500;

  c.imu = { ...DEFAULT_IMU_PARAMS };
  for (const [key, id, scale] of ARCHIVE_IMU_CONTROLS) c.imu[key] = slider(id, (cfg.imu[key] ?? 0) * scale) / scale;
  // 量程下拉处理器：gyroRangeDps = Number(select.value)（无匹配选项 → "" → 0）
  c.imu.gyroRangeDps = Number(select("imu-gyro-range", String(cfg.imu.gyroRangeDps ?? 0)));

  // 全局开关 → 广播：mag-enable / gate-* 取自 comp 组，再刷给全部相关算法
  const magOn = check("mag-enable", cfg.estimators.comp.magEnabled);
  const gateOn = check("gate-toggle", cfg.estimators.comp.accelGate);
  const gateDeg = slider("gate-deg", cfg.estimators.comp.gateDeg);
  const gateMagPct = slider("gate-mag", cfg.estimators.comp.gateMagPct * 100) / 100;
  const gateRec = check("gate-recovery", cfg.estimators.comp.gateRecovery);
  const magMode = select("mag-mode", cfg.estimators.mahony.magMode);
  for (const id of Object.keys(DEFAULT_ESTIMATOR_TUNING) as EstimatorId[]) {
    const t = cloneTuning(id);
    t.enabled = true;
    // pure 没有磁观测：magEnabled 恒为 false（与默认配置/tuningOf 同形）
    t.magEnabled = id === "pure" ? false : magOn;
    // 逐算法 ramp 由 applyNonUiTunings 写回，只有 comp/mahony/madg 参与
    if (id === "comp" || id === "mahony" || id === "madg") {
      t.accelGate = gateOn;
      t.gateDeg = gateDeg;
      t.gateMagPct = gateMagPct;
      t.gateRecovery = gateRec;
      t.rampEnabled = cfg.estimators[id].rampEnabled !== false;
    }
    if (id === "mahony" || id === "madg") t.magMode = magMode === "full" ? "full" : "yaw";
    if (id === "comp") t.params.alpha = slider("comp-alpha", cfg.estimators.comp.params.alpha!);
    if (id === "mahony") {
      t.params.kp = slider("mahony-kp", cfg.estimators.mahony.params.kp!);
      t.params.ki = slider("mahony-ki", cfg.estimators.mahony.params.ki!);
    }
    if (id === "madg") t.params.beta = slider("madg-beta", cfg.estimators.madg.params.beta!);
    if (id === "kalman") {
      t.params.gyroNoiseDps = slider("kalman-proc", cfg.estimators.kalman.params.gyroNoiseDps!);
      t.params.obsNoise = slider("kalman-obs", cfg.estimators.kalman.params.obsNoise!);
      t.kalmanGate = select("kalman-gate", cfg.estimators.kalman.kalmanGate ?? "angle") as "angle" | "mahalanobis";
      t.kalmanResetCov = check("kalman-reset-cov", cfg.estimators.kalman.kalmanResetCov === true);
      // 界面无独立控件：applyNonUiTunings 直接写内核（有限值即原样保留）
      t.kalmanChi2 = cfg.estimators.kalman.kalmanChi2;
    }
    c.estimators[id] = t;
  }

  c.initialAttitude = check("init-offset-toggle", cfg.initialAttitude.kind === "random") ? { kind: "random" } : { kind: "level" };
  const modelWanted = select("magcal-model", cfg.magCalibration?.kind ?? cfg.magModel ?? "diag");
  c.magModel = modelWanted === "full" ? "full" : "diag";
  c.magCalibration = cfg.magCalibration;
  c.magCalibrationApplied = c.magCalibration !== null && cfg.magCalibrationApplied !== false;
  c.magTargetUts = c.magCalibration?.field ?? 50;
  c.accelCalibration = cfg.accelCalibration ?? null;
  c.accelCalibrationApplied = c.accelCalibration !== null && cfg.accelCalibrationApplied !== false;
  c.autoCoarseAlign = cfg.autoCoarseAlign !== false;
  c.steadyFromSec = cfg.steadyFromSec ?? null;
  c.manualTargetDeg = [
    slider("man-roll", (cfg.manualTargetDeg ?? [0, 0, 0])[0]),
    slider("man-pitch", (cfg.manualTargetDeg ?? [0, 0, 0])[1]),
    slider("man-yaw", (cfg.manualTargetDeg ?? [0, 0, 0])[2]),
  ] as [number, number, number];
  c.ab = { mode: select("ab-mode", cfg.ab?.mode ?? "same-start") === "online-fork" ? "online-fork" : "same-start" };
  return canonicalizeExperimentConfig(c);
}

/**
 * 导入前的**离线往返判定**（不写任何控件、不触发任何事件）。
 *
 * 把「写步骤 + 控件约束」重放成界面会读回的配置，与规范形期望值逐字段比对；
 * 返回空数组 = 界面能逐字段表达这份配置，可以提交；否则返回具体字段路径，
 * 调用方直接拒绝——此时现场一个字节都没动过。
 */
export function archiveControlRoundTripProblems(cfg: ExperimentConfig, specs: ControlSpecs): ConfigProblem[] {
  // 先验：schema 层本身必须合法（同一把尺子，避免"能渲染但不能解析"）
  const schema = experimentConfigProblems(cfg, true);
  if (schema.length) return schema;
  const want = canonicalizeExperimentConfig(cfg);
  return archiveRoundTripProblems(want, predictedArchiveReadback(want, specs));
}
