import type { Quat, V3 } from "../core/quat";
import { qFromEuler, qId, qIntegrate, qNorm, qRot, qRotInv, qSlerp, qToEuler } from "../core/quat";
import { MAG_WORLD_NED } from "../core/imu";

/**
 * 估计器内部量（玻璃盒可视化用）。
 * 约定：全部机体系；重力方向向量不归一化到单位长度时,length 字段说明实际模长；
 * 角速度单位 rad/s，显示层再转 °/s。
 */
export interface EstimatorTelemetry {
  /** 本帧实际用于积分的总角速度（纯积分 = 陀螺，融合 = 陀螺 + 修正） */
  rate: V3;
  /** 原始陀螺输入（未经修正），供对比「修正量」 */
  rawGyro: V3;
  /** 算法附加的修正角速度 = rate − rawGyro（纯积分恒为 0） */
  correction: V3;
  /** 预测重力方向（机体系）：当前姿态认为「下」在哪里，Rᵀ(q)·ẑ */
  predictedGravity: V3;
  /** 实测重力方向（机体系）：加计测得的「下」方向；‖a‖≈0 时置 [0,0,0] */
  measuredGravity: V3;
  /** 加计模长（m/s²），供 UI 判断受扰/失效 */
  accelNorm: number;
  /** 加计是否可信（‖a‖ 偏离 g 不超过 35%） */
  accelValid: boolean;
  /** 磁力计是否可信（‖m‖ 偏离期望场强不超过 40%）；magEnabled=false 时恒 false */
  magValid: boolean;
  /** 算法专属细节（互补：权重与两路倾角；Mahony：P/I 占比；Madgwick：残差），任意结构 */
  detail: Record<string, number>;
}

/** 供四个估计器复用的空遥测（数值框显示占位） */
export function emptyTelemetry(): EstimatorTelemetry {
  return {
    rate: [0, 0, 0],
    rawGyro: [0, 0, 0],
    correction: [0, 0, 0],
    predictedGravity: [0, 0, 0],
    measuredGravity: [0, 0, 0],
    accelNorm: 0,
    accelValid: false,
    magValid: false,
    detail: {},
  };
}

/** 磁修正形态（Mahony / Madgwick 共有）：
 *  - `yaw`：只用磁场约束偏航（本装置最初的简化，见文档「磁力计与 MARG」）
 *  - `full`：完整磁场向量 + 磁倾角补偿参考场（Madgwick 2011 / Mahony 2008 的标准做法） */
export type MagMode = "yaw" | "full";

export interface Estimator {
  id: "truth" | "pure" | "comp" | "mahony" | "madg" | "kalman";  label: string;
  color: string;
  q: Quat;
  /** 最近一帧 update() 填充的内部量（玻璃盒可视化只读） */
  telemetry: EstimatorTelemetry;
  /** magEnabled=true 时启用磁力计（MARG），偏航由磁场约束 */
  magEnabled: boolean;
  update(gyro: V3, accel: V3, mag: V3, dt: number): void;
  /**
   * 重置到初始状态。initial 缺省 = 单位姿态（水平）；传入非单位姿态即
   * 「初始姿态偏差」演示——观察各算法从错误初值收敛到观测（初始对准的逆过程）。
   */
  reset(initial?: Quat): void;
  /** 可调参数快照（A/B 对比用）：键名各算法不同（α / Kp,Ki / β / Q,R） */
  getParams(): Record<string, number>;
  setParams(p: Record<string, number>): void;
}

/**
 * 启动增益 ramp（Fusion 库同款思想）：reset 后 RAMP_SEC 秒内把修正增益从
 * RAMP_BOOST 倍线性降回 1 倍——初始姿态偏差大时快速「拉」到观测，之后恢复
 * 用户整定的稳态增益。只放大比例/梯度修正，不放大积分项（避免暂态 windup）。
 */
const RAMP_SEC = 2.5;
const RAMP_BOOST = 6;
function rampK(age: number, enabled: boolean): number {
  return enabled && age < RAMP_SEC ? 1 + (RAMP_BOOST - 1) * (1 - age / RAMP_SEC) : 1;
}

/**
 * 加速度计观测门控（互补/Mahony/Madgwick，卡尔曼用自己的 40° 新息门控）：
 * ① 幅度门控——‖a‖ 偏离 g 超 `gateMagPct`（默认 35%，线加速度沿重力分量/自由落体）；
 * ② 方向门控——实测方向与预测重力夹角超过 `gateDeg`（默认 20°）——垂直于重力的污染
 *    对范数只有二阶影响（4 m/s² 侧向 → 范数仅偏 8%），幅度门控看不见它，
 *    Fusion 库同样以方向拒绝为主手段。
 * 启动 ramp 期间（Fusion 同款语义）两类拒绝都关闭——初始偏差演示里的收敛
 * 正需要「硬拉」，此时拒绝会把估计卡死在错误姿态上。
 *
 * 两个阈值都是**实例字段**（`gateDeg` / `gateMagPct`），面板滑块可实时改：
 * 阈值太松污染穿堂而过，太紧正常机动被误拒——这条 U 形权衡本身就是教学点。
 */
export const ACCEL_GATE_DEG = 20;
export const ACCEL_GATE_MAG_PCT = 0.35;
function accelGateActive(gateOn: boolean, rampEnabled: boolean, age: number): boolean {
  return gateOn && !(rampEnabled && age < RAMP_SEC);
}

/* --------------------------------------------------------------------------
   观测拒绝的**滞回恢复**（Fusion 库同款思想）
   -------------------------------------------------------------------------- */

/** 统计窗口（秒）与窗口内分桶数 */
const GATE_WIN_SEC = 5;
const GATE_BUCKETS = 20;
const GATE_BUCKET_SEC = GATE_WIN_SEC / GATE_BUCKETS;
/** 窗口内拒绝时间占比超此值 → 判定「估计已经跑偏」，开启恢复窗 */
const GATE_RECOVER_RATIO = 0.9;
/** 恢复窗时长（秒）：期间无条件放行观测，把姿态拉回观测后再交还门控 */
const GATE_RECOVER_SEC = 1.5;
/** 窗口内至少积累这么多秒才有统计意义 */
const GATE_MIN_SAMPLES_SEC = GATE_WIN_SEC * 0.8;

/**
 * 门控的状态机（每估计器一份）：
 *
 *   正常（0）──窗口拒绝占比 > 90%，且恢复开关已开──▶ 恢复（2，1.5 s 无条件放行）──▶ 正常
 *        └──本帧被拒──▶ 拒绝（1）
 *
 * 为什么需要它：纯阈值门控在阈值边界会**抖振**——同一段机动里观测一帧收一帧拒，
 * 估计在「信观测」与「信陀螺」之间来回横跳。而真正的危险场景（传感器装反、器件故障）
 * 会让观测被长时间连续拒绝，此时陀螺零偏照常累积、估计越跑越偏，门控却因为
 * 「反正观测不可信」永远不松口。工业库（Fusion）的做法是：拒绝太久就承认
 * 「可能是我自己偏了」，主动放行一段时间重新收敛。这就是滞回。
 *
 * **默认关闭**（`gateRecovery = false`），因为它是双刃剑：持续单向线加速度（协调转弯）
 * 同样会触发恢复窗，于是被污染的观测被放进来、姿态反而被拉偏——本装置的
 * 「方向门控救场」实验要的正是「拒绝到底」。因此做成显式开关，两种行为都能在面板上
 * 当场对照（这本身就是一个值得讲的工程取舍）。
 */
class GateRecovery {
  private rej = new Float64Array(GATE_BUCKETS);
  private tot = new Float64Array(GATE_BUCKETS);
  private acc = 0;
  private idx = 0;
  /** > 0 表示恢复窗剩余秒数 */
  recovering = 0;
  /** 上一次判定的窗口拒绝占比（遥测/教学读数） */
  ratio = 0;

  /** 每帧调用：传入「按纯阈值本帧是否该拒」，返回「是否应当强制放行」 */
  step(dt: number, wouldReject: boolean, gateOn: boolean, recoveryEnabled: boolean): boolean {
    if (this.recovering > 0) {
      this.recovering = Math.max(0, this.recovering - dt);
      this.ratio = 1;
      return true;
    }
    this.acc += dt;
    this.tot[this.idx] += dt;
    if (wouldReject) this.rej[this.idx] += dt;
    while (this.acc >= GATE_BUCKET_SEC) {
      this.acc -= GATE_BUCKET_SEC;
      this.idx = (this.idx + 1) % GATE_BUCKETS;
      this.rej[this.idx] = 0;
      this.tot[this.idx] = 0;
    }
    let r = 0;
    let t = 0;
    for (let i = 0; i < GATE_BUCKETS; i++) {
      r += this.rej[i];
      t += this.tot[i];
    }
    this.ratio = t > 1e-9 ? r / t : 0;
    if (recoveryEnabled && gateOn && t >= GATE_MIN_SAMPLES_SEC && this.ratio > GATE_RECOVER_RATIO) {
      this.recovering = GATE_RECOVER_SEC;
      this.rej.fill(0);
      this.tot.fill(0);
      this.acc = 0;
      return true;
    }
    return false;
  }

  /** 状态码：0 正常 / 1 本帧拒绝 / 2 恢复窗（供玻璃盒读数与曲线标注） */
  mode(wouldReject: boolean): number {
    if (this.recovering > 0) return 2;
    return wouldReject ? 1 : 0;
  }

  reset(): void {
    this.rej.fill(0);
    this.tot.fill(0);
    this.acc = 0;
    this.idx = 0;
    this.recovering = 0;
    this.ratio = 0;
  }
}

/* --------------------------------------------------------------------------
   完整 MARG 的磁参考场构造（磁倾角补偿）
   -------------------------------------------------------------------------- */

/**
 * 由**当前姿态 + 磁测量本身**构造世界系参考磁场 b = [0, bx, 0, bz]。
 *
 * 这是 Madgwick 2011 报告与 Mahony MARG 的标准做法，也是本装置曾经的简化版
 * （「磁只约束偏航」）与文献实现的**唯一实质性差别**：
 *
 *   1. 把机体系磁测量旋到世界系：h = q ⊗ m ⊗ q⁻¹
 *   2. 丢掉水平面内的 y 分量（世界 y = 东）：bx = √(hx² + hy²)，bz = hz
 *   3. 归一化成单位参考场 b
 *
 * 第 2 步就是「磁倾角补偿」：参考场与**实测场具有相同的倾角**，于是磁场误差里
 * 「倾角不一致」的成分被结构性地消掉了（硬铁/软铁造成的倾角畸变不再被误读成
 * 姿态误差），磁场只在偏航上说话——而且不再需要外部的磁场参考常量。
 * 只用「倾斜补偿磁航向取一个 yaw 角」的简化版做不到这一点，还额外依赖欧拉角。
 */
function magReferenceFromMeasurement(q: Quat, m: V3): { bx: number; bz: number } {
  const h = qRot(q, m);
  const bx = Math.hypot(h[0], h[1]);
  const bz = h[2];
  const n = Math.hypot(bx, bz);
  if (!(n > 1e-9)) return { bx: 1, bz: 0 };
  return { bx: bx / n, bz: bz / n };
}

/** 世界磁场参考模长（μT），用于磁力计可信度判定 */
const MAG_REF = Math.hypot(MAG_WORLD_NED[0], MAG_WORLD_NED[1], MAG_WORLD_NED[2]);

/**
 * 倾斜补偿磁航向（弧度）：用加计给出的横滚/俯仰把机体系磁向量转到水平面，
 * 再取水平分量的航向角。这是 MARG 补偏航的标准做法——磁力计只能约束偏航，
 * 横滚/俯仰仍由加计提供。
 */
function tiltCompensatedYaw(roll: number, pitch: number, mx: number, my: number, mz: number): number {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // 把机体系磁向量经 R(roll)·R(pitch) 的逆变换转到水平系
  const mxH = mx * cp + my * sr * sp + mz * cr * sp;
  const myH = my * cr - mz * sr;
  return Math.atan2(-myH, mxH); // NED 约定：北=0，东=+90°
}

/** 磁力计可信判定：‖m‖ 偏离参考场强不超过 40% */
function magIsPlausible(m: V3): boolean {
  const n = Math.hypot(m[0], m[1], m[2]);
  return n > 1e-6 && Math.abs(n - MAG_REF) < 0.4 * MAG_REF;
}

/**
 * 粗对准（三段式初始对准第一段）：静止时由加计直接解出横滚/俯仰（AN4248 公式），
 * 磁力计经倾斜补偿补偏航——与互补滤波的观测公式完全同源。
 * 静止检测确认机体不动后调用，把明显漂移/带偏差的估计直接摆回观测姿态。
 */
export function coarseAlign(accel: V3, mag: V3, magEnabled: boolean): Quat {
  const norm = Math.hypot(accel[0], accel[1], accel[2]);
  if (norm < 1e-6) return qId();
  const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
  const roll = Math.atan2(ay, az);
  const pitch = Math.atan2(-ax, Math.hypot(ay, az));
  const yaw = magEnabled && magIsPlausible(mag)
    ? tiltCompensatedYaw(roll, pitch, mag[0], mag[1], mag[2])
    : 0;
  return qFromEuler(roll, pitch, yaw);
}

const G = 9.80665;

/**
 * 计算两根重力方向向量的夹角（度），任一为零向量返回 NaN。
 * 用 atan2 而非 acos 以避免小角度下的浮点精度问题。
 */
function angleBetweenDeg(a: V3, b: V3): number {
  const cross = Math.hypot(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.atan2(cross, dot) * (180 / Math.PI);
}

/** 1. 纯陀螺积分：q ← q ⊗ Δq(ω·dt)。无校正，零偏与噪声逐步累积 → 漂移 */
export class PureGyroEstimator implements Estimator {
  id = "pure" as const;
  label = "纯陀螺仪积分";
  color = "#f85149";
  q = qId();
  telemetry = emptyTelemetry();
  magEnabled = false;
  update(gyro: V3, accel: V3, _mag: V3, dt: number): void {
    this.q = qIntegrate(this.q, gyro, dt);
    const { w, x, y, z } = this.q;
    // 遥测：correction 恒为零——这正是「漂移只增不减」的原因
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    this.telemetry = {
      rate: [gyro[0], gyro[1], gyro[2]],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      correction: [0, 0, 0],
      predictedGravity: [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y],
      measuredGravity: norm > 1e-6 ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0],
      accelNorm: norm,
      accelValid: Math.abs(norm - G) < 0.35 * G,
      magValid: false, // 纯积分无修正通道，磁力计对它无意义
      detail: { alignErrorDeg: angleBetweenDeg(this.telemetry.predictedGravity, this.telemetry.measuredGravity) },
    };
  }
  reset(initial?: Quat): void {
    this.q = initial ? { ...initial } : qId();
    this.telemetry = emptyTelemetry();
  }
  getParams(): Record<string, number> {
    return {};
  }
  setParams(): void {
    /* 纯积分无参数 */
  }
}

/** 2. 互补滤波：陀螺积分提供高频，加计倾角提供低频，按 α 速率融合。偏航不可观，随陀螺漂移 */
export class ComplementaryEstimator implements Estimator {
  id = "comp" as const;
  label = "互补滤波";
  color = "#ffa657";
  q = qId();
  alpha = 1; // 加计融合速率（1/s）
  /** 启动增益 ramp 开关（自检 A/B 对照用）：reset 后 RAMP_SEC 秒内增益放大后线性衰减 */
  rampEnabled = true;
  /** 加速度计观测门控：幅度（‖a‖ 偏 g 超 gateMagPct）+ 方向（与预测重力夹角超 gateDeg）双重拒绝 */
  accelGate = true;
  /** 方向门控阈值（度）——面板可调 */
  gateDeg = ACCEL_GATE_DEG;
  /** 幅度门控阈值（相对 g 的比例）——面板可调 */
  gateMagPct = ACCEL_GATE_MAG_PCT;
  /** 滞回恢复窗开关（默认关，见 GateRecovery 注释）：拒绝太久是否自动放行 */
  gateRecovery = false;
  private gate = new GateRecovery();
  private age = 0;
  telemetry = emptyTelemetry();
  magEnabled = false;
  update(gyro: V3, accel: V3, mag: V3, dt: number): void {
    this.age += dt;
    const qGyro = qIntegrate(this.q, gyro, dt);
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    const accelValid = Math.abs(norm - G) < this.gateMagPct * G;
    const axN = norm > 1e-6 ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0];
    const { w: pw, x: px, y: py, z: pz } = qGyro;
    const predicted: V3 = [2 * (px * pz - pw * py), 2 * (pw * px + py * pz), 1 - 2 * px * px - 2 * py * py];
    const alignDeg = angleBetweenDeg(predicted, axN as V3);
    const gateActive = accelGateActive(this.accelGate, this.rampEnabled, this.age);
    const wouldReject = gateActive && !(accelValid && alignDeg < this.gateDeg);
    const forceAccept = this.gate.step(dt, wouldReject, gateActive, this.gateRecovery);
    const usable = norm > 1e-6 && (!wouldReject || forceAccept);
    if (!usable) {
      // 受扰（幅度/方向门控拦截）或近似自由落体：跳过加计修正——磁航向的倾斜补偿
      // 依赖可信姿态，一并跳过，本帧退化为纯陀螺仪积分
      this.q = qGyro;
      this.telemetry = {
        rate: [gyro[0], gyro[1], gyro[2]],
        rawGyro: [gyro[0], gyro[1], gyro[2]],
        correction: [0, 0, 0],
        predictedGravity: predicted,
        measuredGravity: axN as V3,
        accelNorm: norm,
        accelValid,
        magValid: false,
        detail: { accelWeight: 0, alignErrorDeg: alignDeg, gateMode: this.gate.mode(wouldReject), rejectRatio: this.gate.ratio },
      };
      return;
    }
    const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
    const rollAcc = Math.atan2(ay, az);
    const pitchAcc = Math.atan2(-ax, Math.hypot(ay, az));
    // 偏航来源：IMU 模式沿用陀螺（加计看不出偏航）；MARG 模式用倾斜补偿磁航向
    let yaw: number;
    let yawMag: number | undefined;
    const magOk = this.magEnabled && magIsPlausible(mag);
    if (magOk) {
      const eAcc = qToEuler(qGyro); // 倾斜补偿用陀螺短时姿态（扰动最小）
      yawMag = tiltCompensatedYaw(eAcc.roll, eAcc.pitch, mag[0], mag[1], mag[2]);
      yaw = yawMag;
    } else {
      yaw = qToEuler(qGyro).yaw;
    }
    const qAcc = qFromEuler(rollAcc, pitchAcc, yaw);
    const wAcc = 1 - Math.exp(-this.alpha * rampK(this.age, this.rampEnabled) * dt);
    this.q = qSlerp(qGyro, qAcc, wAcc);

    const { w, x, y, z } = this.q;
    const euGyro = qToEuler(qGyro);
    this.telemetry = {
      rate: [gyro[0], gyro[1], gyro[2]],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      // 互补没有显式角速度修正，用「本帧姿态被加计/磁拉动的角度 / dt」作为等效修正量
      correction: [
        wAcc * (rollAcc - euGyro.roll) / dt,
        wAcc * (pitchAcc - euGyro.pitch) / dt,
        yawMag !== undefined ? wAcc * (yaw - euGyro.yaw) / dt : 0,
      ],
      predictedGravity: [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y],
      measuredGravity: [ax, ay, az],
      accelNorm: norm,
      accelValid,
      magValid: magOk,
      detail: {
        accelWeight: wAcc,
        rollAccDeg: rollAcc * (180 / Math.PI),
        pitchAccDeg: pitchAcc * (180 / Math.PI),
        // 用本帧预测方向（qGyro），不能读 this.telemetry——那是上一帧的旧值（曾有一帧滞后）
        alignErrorDeg: angleBetweenDeg(predicted, [ax, ay, az]),
        gateMode: this.gate.mode(wouldReject),
        rejectRatio: this.gate.ratio,
        ...(yawMag !== undefined
          ? { yawMagDeg: yawMag * (180 / Math.PI), magEnabled: 1 }
          : { magEnabled: 0 }),
      },
    };
  }
  reset(initial?: Quat): void {
    this.q = initial ? { ...initial } : qId();
    this.age = 0;
    this.gate.reset();
    this.telemetry = emptyTelemetry();
  }
  getParams(): Record<string, number> {
    return { alpha: this.alpha };
  }  setParams(p: Record<string, number>): void {
    if (Number.isFinite(p.alpha)) this.alpha = p.alpha;
  }
}

/** 3. Mahony：加计方向 × 预测重力方向 = 误差，P/I 反馈修正角速度 */
export class MahonyEstimator implements Estimator {
  id = "mahony" as const;
  label = "Mahony";
  color = "#58a6ff";
  q = qId();
  kp = 1;
  ki = 0.05;
  /** 启动增益 ramp 开关：只放大比例项（Kp），不放大积分项（避免暂态 windup） */
  rampEnabled = true;
  /** 加速度计幅度门控：受扰时跳过整帧修正（比例/积分/磁误差都不注入） */
  accelGate = true;
  private eInt: V3 = [0, 0, 0];
  private age = 0;
  telemetry = emptyTelemetry();
  magEnabled = false;
  /** 磁修正形态：`yaw` = 只用 (m×m̂)_z 约束偏航（本装置最初的简化）；
   *  `full` = 完整磁场向量叉积 + 磁倾角补偿参考场（Mahony MARG 的标准做法） */
  magMode: MagMode = "yaw";
  /** 方向门控阈值（度）/ 幅度门控阈值（相对 g）——面板可调 */
  gateDeg = ACCEL_GATE_DEG;
  gateMagPct = ACCEL_GATE_MAG_PCT;
  /** 滞回恢复窗开关（默认关，见 GateRecovery 注释） */
  gateRecovery = false;
  private gate = new GateRecovery();
  update(gyro: V3, accel: V3, mag: V3, dt: number): void {
    this.age += dt;
    const kP = this.kp * rampK(this.age, this.rampEnabled);
    const { w, x, y, z } = this.q;
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    let omega: V3 = [gyro[0], gyro[1], gyro[2]];
    const predicted: V3 = [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y];
    const measured: V3 = norm > 1e-6 ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0];
    let pTerm: V3 = [0, 0, 0];
    let iTerm: V3 = [0, 0, 0];
    let iUsage = 0;
    let magOk = false;
    let yawMagDeg = NaN;
    const accelValid = Math.abs(norm - G) < this.gateMagPct * G;
    const alignDeg = angleBetweenDeg(predicted, measured);
    const gateActive = accelGateActive(this.accelGate, this.rampEnabled, this.age);
    const wouldReject = gateActive && !(accelValid && alignDeg < this.gateDeg);
    const forceAccept = this.gate.step(dt, wouldReject, gateActive, this.gateRecovery);
    let magErrMag = 0;
    if (norm > 1e-6 && (!wouldReject || forceAccept)) {
      const ax = measured[0], ay = measured[1], az = measured[2];
      const vx = predicted[0], vy = predicted[1], vz = predicted[2];
      // 误差 = 实测 × 预测（叉积）
      let ex = ay * vz - az * vy;
      let ey = az * vx - ax * vz;
      let ez = ax * vy - ay * vx;

      magOk = this.magEnabled && magIsPlausible(mag);
      if (magOk) {
        const mn = Math.hypot(mag[0], mag[1], mag[2]);
        if (this.magMode === "full") {
          // 标准 MARG（Mahony 2008 的推广形式）：参考场由**测量本身**构造
          //（磁倾角补偿），误差取实测磁场与预测磁场的**完整向量叉积**——
          // 三个分量都参与修正，因此磁场也会修正倾角，而不是只拽偏航。
          const { bx, bz } = magReferenceFromMeasurement(this.q, mag);
          // 世界系参考场向量 = (bx, 0, bz)：北向水平分量 + 向下垂直分量（东向恒为 0）。
          // 不能写成 (0, bx, bz)——那是「东-下」平面，修正会被推错轴（实测：静态就偏 22°）。
          const mPred = qRotInv(this.q, [bx, 0, bz]);
          const mHat: V3 = [mag[0] / mn, mag[1] / mn, mag[2] / mn];
          const mex = mHat[1] * mPred[2] - mHat[2] * mPred[1];
          const mey = mHat[2] * mPred[0] - mHat[0] * mPred[2];
          const mez = mHat[0] * mPred[1] - mHat[1] * mPred[0];
          // 权重 k₂/k₁ = 0.5：磁观测比重力观测更不可信（软铁/硬铁/电机干扰）
          ex += 0.5 * mex;
          ey += 0.5 * mey;
          ez += 0.5 * mez;
          magErrMag = Math.hypot(mex, mey, mez);
        } else {
          // 简化版：只取 (m × m_pred) 的 z 分量并入 ez——磁场只约束偏航。
          const mPred = qRotInv(this.q, MAG_WORLD_NED);
          ez += ((mag[0] * mPred[1] - mag[1] * mPred[0]) / mn) * 0.5;
          // 教学读数：倾斜补偿磁航向
          const eu = qToEuler(this.q);
          yawMagDeg = tiltCompensatedYaw(eu.roll, eu.pitch, mag[0], mag[1], mag[2]) * (180 / Math.PI);
        }
      }

      this.eInt = [this.eInt[0] + ex * dt, this.eInt[1] + ey * dt, this.eInt[2] + ez * dt];
      const iCap = Math.hypot(this.eInt[0], this.eInt[1], this.eInt[2]);
      const scale = iCap > 5 ? 5 / iCap : 1; // 积分限幅
      pTerm = [kP * ex, kP * ey, kP * ez];
      iTerm = [this.ki * this.eInt[0] * scale, this.ki * this.eInt[1] * scale, this.ki * this.eInt[2] * scale];
      iUsage = Math.min(1, iCap / 5); // 限幅用量：0 表示积分项空载，1 表示已顶格
      omega = [gyro[0] + pTerm[0] + iTerm[0], gyro[1] + pTerm[1] + iTerm[1], gyro[2] + pTerm[2] + iTerm[2]];
    }
    this.q = qIntegrate(this.q, omega, dt);
    const magP = Math.hypot(pTerm[0], pTerm[1], pTerm[2]);
    const magI = Math.hypot(iTerm[0], iTerm[1], iTerm[2]);
    this.telemetry = {
      rate: [omega[0], omega[1], omega[2]],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      correction: [omega[0] - gyro[0], omega[1] - gyro[1], omega[2] - gyro[2]],
      predictedGravity: predicted,
      measuredGravity: measured,
      accelNorm: norm,
      accelValid,
      magValid: magOk,
      detail: {
        pShare: magP + magI > 1e-12 ? magP / (magP + magI) : 0, // 比例项占比（供双色条）
        iUsage,
        eIntMag: Math.hypot(this.eInt[0], this.eInt[1], this.eInt[2]),
        alignErrorDeg: alignDeg,
        gateMode: this.gate.mode(wouldReject),
        rejectRatio: this.gate.ratio,
        magErrDeg: magErrMag,
        ...(magOk && this.magMode === "full"
          ? { magModeFull: 1, magEnabled: 1 }
          : magOk
            ? { yawMagDeg, magEnabled: 1 }
            : { magEnabled: 0 }),
      },
    };
  }
  reset(initial?: Quat): void {
    this.q = initial ? { ...initial } : qId();
    this.eInt = [0, 0, 0];
    this.age = 0;
    this.gate.reset();
    this.telemetry = emptyTelemetry();
  }
  getParams(): Record<string, number> {
    return { kp: this.kp, ki: this.ki };
  }
  setParams(p: Record<string, number>): void {
    if (Number.isFinite(p.kp)) this.kp = p.kp;
    if (Number.isFinite(p.ki)) this.ki = p.ki;
  }
}

/** 4. Madgwick：以梯度下降最小化「预测重力方向 vs 实测加计方向」，β 控制步长 */
export class MadgwickEstimator implements Estimator {
  id = "madg" as const;
  label = "Madgwick";
  color = "#7ee787";
  q = qId();
  beta = 0.1;
  /** 启动增益 ramp 开关：放大梯度下降步长 */
  rampEnabled = true;
  /** 加速度计幅度门控：受扰时跳过梯度步 */
  accelGate = true;
  /** 磁修正形态：`yaw` = 独立偏航方向分量（本装置最初的简化）；`full` = 标准 6 维梯度 */
  magMode: MagMode = "yaw";
  /** 方向门控阈值（度）/ 幅度门控阈值（相对 g）——面板可调 */
  gateDeg = ACCEL_GATE_DEG;
  gateMagPct = ACCEL_GATE_MAG_PCT;
  /** 滞回恢复窗开关（默认关，见 GateRecovery 注释） */
  gateRecovery = false;
  private gate = new GateRecovery();
  private age = 0;
  telemetry = emptyTelemetry();
  magEnabled = false;
  update(gyro: V3, accel: V3, mag: V3, dt: number): void {
    this.age += dt;
    const betaEff = this.beta * rampK(this.age, this.rampEnabled);
    const { w, x, y, z } = this.q;
    // 陀螺微分项：q̇ = ½ q ⊗ ω（此处不乘 dt，最后统一乘）
    const gdW = 0.5 * (-x * gyro[0] - y * gyro[1] - z * gyro[2]);
    const gdX = 0.5 * (w * gyro[0] + y * gyro[2] - z * gyro[1]);
    const gdY = 0.5 * (w * gyro[1] - x * gyro[2] + z * gyro[0]);
    const gdZ = 0.5 * (w * gyro[2] + x * gyro[1] - y * gyro[0]);

    let dw = gdW, dx = gdX, dy = gdY, dz = gdZ;
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    const predicted: V3 = [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y];
    const measured: V3 = norm > 1e-6 ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0];
    let residual = 0;
    let magOk = false;
    let yawMagDeg = NaN;
    let magResidual = 0;
    const accelValid = Math.abs(norm - G) < this.gateMagPct * G;
    const alignDeg = angleBetweenDeg(predicted, measured);
    const gateActive = accelGateActive(this.accelGate, this.rampEnabled, this.age);
    const wouldReject = gateActive && !(accelValid && alignDeg < this.gateDeg);
    const forceAccept = this.gate.step(dt, wouldReject, gateActive, this.gateRecovery);
    if (norm > 1e-6 && (!wouldReject || forceAccept)) {
      const ax = measured[0], ay = measured[1], az = measured[2];
      magOk = this.magEnabled && magIsPlausible(mag);

      if (magOk && this.magMode === "full") {
        // ---- 标准 Madgwick MARG（2011 报告 的 6 维目标函数）----
        // 目标函数前三维同 IMU 版（重力残差）；后三维用**磁倾角补偿参考场** b：
        //   h = q ⊗ m ⊗ q⁻¹（磁测量旋到世界系）→ bx = √(hx²+hy²), bz = hz
        // 于是参考场与实测场倾角一致，硬铁/软铁造成的倾角畸变不会被误读成姿态误差。
        const mn = Math.hypot(mag[0], mag[1], mag[2]);
        const mx = mag[0] / mn, my = mag[1] / mn, mz = mag[2] / mn;
        const { bx, bz } = magReferenceFromMeasurement(this.q, mag);
        const f1 = 2 * (x * z - w * y) - ax;
        const f2 = 2 * (w * x + y * z) - ay;
        const f3 = 2 * (0.5 - x * x - y * y) - az;
        const f4 = 2 * bx * (0.5 - y * y - z * z) + 2 * bz * (x * z - w * y) - mx;
        const f5 = 2 * bx * (x * y - w * z) + 2 * bz * (w * x + y * z) - my;
        const f6 = 2 * bx * (w * y + x * z) + 2 * bz * (0.5 - x * x - y * y) - mz;
        residual = Math.hypot(f1, f2, f3);
        magResidual = Math.hypot(f4, f5, f6);
        // 梯度 Jᵀf （J 为 6×4，公式与 Madgwick 参考实现 AHRS.c 的 MARG 分支一致）
        const s0 = -2 * y * f1 + 2 * x * f2
          - 2 * bz * y * f4 + (-2 * bx * z + 2 * bz * x) * f5 + 2 * bx * y * f6;
        const s1 = 2 * z * f1 + 2 * w * f2 - 4 * x * f3
          + 2 * bz * z * f4 + (2 * bx * y + 2 * bz * w) * f5 + (2 * bx * z - 4 * bz * x) * f6;
        const s2 = -2 * w * f1 + 2 * z * f2 - 4 * y * f3
          + (-4 * bx * y - 2 * bz * w) * f4 + (2 * bx * x + 2 * bz * z) * f5 + (2 * bx * w - 4 * bz * y) * f6;
        const s3 = 2 * x * f1 + 2 * y * f2
          + (-4 * bx * z + 2 * bz * x) * f4 + (-2 * bx * w + 2 * bz * y) * f5 + 2 * bx * x * f6;
        const sNorm = Math.hypot(s0, s1, s2, s3);
        if (sNorm > 1e-9) {
          dw -= (betaEff * s0) / sNorm;
          dx -= (betaEff * s1) / sNorm;
          dy -= (betaEff * s2) / sNorm;
          dz -= (betaEff * s3) / sNorm;
        }
      } else {
        // ---- IMU 版（或简化 MARG）：只用重力梯度 ----
        const f1 = 2 * (x * z - w * y) - ax;
        const f2 = 2 * (w * x + y * z) - ay;
        const f3 = 2 * (0.5 - x * x - y * y) - az;
        residual = Math.hypot(f1, f2, f3);
        let s0 = -2 * y * f1 + 2 * x * f2;
        let s1 = 2 * z * f1 + 2 * w * f2 - 4 * x * f3;
        let s2 = -2 * w * f1 + 2 * z * f2 - 4 * y * f3;
        let s3 = 2 * x * f1 + 2 * y * f2;
        // 简化 MARG：磁场只约束偏航——构造「绕机体系 z 轴」的梯度方向分量，
        // 与重力梯度**并列**参与同一次归一化（而不是独立的 dt 缩放步）：
        // 绕 z 转 δ 的下降方向是 ½·q⊗(0,0,δ)，对 (dw,dx,dy,dz) 的贡献与陀螺微分项同构。
        // δ 取偏航最短角差 yawErr（已是角度而非角速度），与重力残差无量纲化后等权竞争。
        if (magOk) {
          const eu = qToEuler({ w, x, y, z });
          const yawMag = tiltCompensatedYaw(eu.roll, eu.pitch, mag[0], mag[1], mag[2]);
          yawMagDeg = yawMag * (180 / Math.PI);
          let yawErr = yawMag - eu.yaw;
          while (yawErr > Math.PI) yawErr -= 2 * Math.PI;
          while (yawErr < -Math.PI) yawErr += 2 * Math.PI;
          const dir = yawErr > 0 ? 1 : -1;
          const magS = 0.5 * Math.min(1, Math.abs(yawErr)); // 修正强度随误差饱和（避免过冲）
          dw += dir * magS * (-z);
          dx += dir * magS * (y);
          dy += dir * magS * (-x);
          dz += dir * magS * (w);
        }
        const sNorm = Math.hypot(s0, s1, s2, s3);
        if (sNorm > 1e-9) {
          s0 /= sNorm; s1 /= sNorm; s2 /= sNorm; s3 /= sNorm;
          dw -= betaEff * s0;
          dx -= betaEff * s1;
          dy -= betaEff * s2;
          dz -= betaEff * s3;
        }
      }
    }
    this.q = qNorm({ w: w + dw * dt, x: x + dx * dt, y: y + dy * dt, z: z + dz * dt });
    // 梯度步对应的等效角速度修正：Δq = ½·ε·q·dt，取 Δq 的旋转增量部分得 ω_corr = 2·vec(ε·q⁻¹)
    const cx = 0.5 * (dx * w - dy * z + dz * y);
    const cy = 0.5 * (dx * z + dy * w - dz * x);
    const cz = 0.5 * (-dx * y + dy * x + dz * w);
    this.telemetry = {
      rate: [gyro[0] + 2 * cx, gyro[1] + 2 * cy, gyro[2] + 2 * cz],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      correction: [2 * cx, 2 * cy, 2 * cz],
      predictedGravity: predicted,
      measuredGravity: measured,
      accelNorm: norm,
      accelValid,
      magValid: magOk,
      detail: {
        residual,
        stepNorm: Math.hypot(dx, dy, dz) * dt,
        alignErrorDeg: alignDeg,
        gateMode: this.gate.mode(wouldReject),
        rejectRatio: this.gate.ratio,
        magResidual,
        ...(magOk && this.magMode === "full"
          ? { magModeFull: 1, magEnabled: 1 }
          : magOk
            ? { yawMagDeg, magEnabled: 1 }
            : { magEnabled: 0 }),
      },
    };
  }
  reset(initial?: Quat): void {
    this.q = initial ? { ...initial } : qId();
    this.age = 0;
    this.gate.reset();
    this.telemetry = emptyTelemetry(); // 与其它估计器一致：重置后不残留上一轮读数
  }
  getParams(): Record<string, number> {
    return { beta: this.beta };
  }
  setParams(p: Record<string, number>): void {
    if (Number.isFinite(p.beta)) this.beta = p.beta;
  }
}

/* ==========================================================================
   5. 误差状态卡尔曼滤波（MEKF 风格）
   状态 = 姿态四元数 q + 陀螺仪零偏 b；协方差维护在 6 维误差状态上：
   x = [δθ(3), δb(3)]，δθ 为机体系小角误差（q_true ≈ q ⊗ [1, δθ/2]）。
   预测：陀螺积分 + F·P·Fᵀ + Q；观测：加速度计重力方向 / 磁场方向（独立门控）。
   卡尔曼增益 = 预测方差与观测方差的最优加权——这就是它区别于固定增益
   （Kp/β/α）融合的本质：不确定度大时多信观测，小时多信预测。
   ========================================================================== */

/** 3x3 反对称矩阵（行主序）：skew(v)·x = v×x */
function skew(v: V3): number[] {
  return [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
}

/** 行主序稠密矩阵乘 (n×m)·(m×p) */
function matMul(a: ArrayLike<number>, b: ArrayLike<number>, n: number, m: number, p: number): number[] {
  const out = new Array<number>(n * p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const aik = a[i * m + k];
      if (aik === 0) continue;
      for (let j = 0; j < p; j++) out[i * p + j] += aik * b[k * p + j];
    }
  }
  return out;
}

/** 行主序矩阵转置 (n×m) → (m×n) */
function matTranspose(a: ArrayLike<number>, n: number, m: number): number[] {
  const out = new Array<number>(n * m).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[j * n + i] = a[i * m + j];
  return out;
}

/** 3x3 求逆（伴随法），退化时返回单位阵保护 */
function mat3Inverse(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = 1 / det;
  return [
    A * s, B * s, C * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/** 观测矩阵 H = [skew(v) | 0(3x3)]（3x6 行主序：前 3 列对姿态小角，后 3 列对零偏恒为零） */
function obsMatrix(v: V3): number[] {
  const sk = skew(v);
  return [
    sk[0], sk[1], sk[2], 0, 0, 0,
    sk[3], sk[4], sk[5], 0, 0, 0,
    sk[6], sk[7], sk[8], 0, 0, 0,
  ];
}

/** 零偏物理限幅（rad/s）：真实 MEMS 零偏远小于 1 rad/s（≈57°/s），
 *  限幅只在异常数据/数值发散时兜底，正常教学范围内绝不触发。 */
const BIAS_LIMIT = 1.0;
/** 协方差对角线下限：保证 P 永远正定，防止长时间运行后矩阵病态 */
const P_FLOOR = 1e-12;

export class KalmanEstimator implements Estimator {
  id = "kalman" as const;
  label = "卡尔曼滤波";
  color = "#e05fb0";
  q = qId();
  /** 过程噪声：陀螺仪角速度噪声 σ（°/s）——预测有多不可信 */
  gyroNoiseDps = 0.2;
  /** 观测噪声：加速度计方向噪声 σ（单位 g）——观测有多不可信 */
  obsNoise = 0.05;
  /** 零偏随机游走强度 σ_b（rad/s/√s）：固定小值，让积分通道慢慢「学会」零偏 */
  private readonly biasWalk = 0.004;
  private bias: V3 = [0, 0, 0];
  /** 6x6 误差状态协方差 P = Cov([δθ, δb])，行主序 */
  private P: number[] = [];
  telemetry = emptyTelemetry();
  magEnabled = false;

  constructor() {
    this.initCovariance();
  }

  private initCovariance(): void {
    // 初始不确定度：姿态误差 σ≈5°（0.087 rad），零偏 σ≈0.5°/s（0.0087 rad/s）
    const dTheta = 0.087 * 0.087;
    const dBias = 0.0087 * 0.0087;
    this.P = new Array<number>(36).fill(0);
    for (let i = 0; i < 3; i++) {
      this.P[i * 6 + i] = dTheta;
      this.P[(i + 3) * 6 + i + 3] = dBias;
    }
  }

  update(gyro: V3, accel: V3, mag: V3, dt: number): void {
    const sig = this.gyroNoiseDps * (Math.PI / 180); // °/s → rad/s
    const w: V3 = [gyro[0] - this.bias[0], gyro[1] - this.bias[1], gyro[2] - this.bias[2]];

    // ---- 预测：姿态积分 + 协方差传播 ----
    this.q = qIntegrate(this.q, w, dt);
    // Φ = I + A·dt，A = [[−[ω]×, −I],[0, 0]]（机体系误差状态转移矩阵）
    const Phi = new Array<number>(36).fill(0);
    for (let i = 0; i < 6; i++) Phi[i * 6 + i] = 1;
    const sk = skew(w);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) Phi[i * 6 + j] -= sk[i * 3 + j] * dt;
      Phi[i * 6 + (i + 3)] = -dt; // δθ̇ 中的 −δb 项
    }
    const PhiT = matTranspose(Phi, 6, 6);
    this.P = matMul(matMul(Phi, this.P, 6, 6, 6), PhiT, 6, 6, 6);
    // Q·dt：陀螺噪声注入 δθ，零偏随机游走注入 δb
    for (let i = 0; i < 3; i++) {
      this.P[i * 6 + i] += sig * sig * dt;
      this.P[(i + 3) * 6 + i + 3] += this.biasWalk * this.biasWalk * dt;
    }

    // ---- 观测：重力（横滚/俯仰）与磁场（偏航），共用同一套增益公式 ----
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    const accelValid = norm > 1e-6 && Math.abs(norm - G) < 0.35 * G;
    let innoAccelDeg = NaN;
    if (accelValid) {
      const aHat: V3 = [accel[0] / norm, accel[1] / norm, accel[2] / norm];
      const gPred = qRotInv(this.q, [0, 0, 1]);
      innoAccelDeg = angleBetweenDeg(aHat, gPred);
      if (innoAccelDeg < 40) {
        // 线性化：z = â − ĝ ≈ [ĝ]×·δθ + v ⇒ H = [skew(ĝ), 0]
        const H = obsMatrix(gPred);
        this.applyUpdate(H, [aHat[0] - gPred[0], aHat[1] - gPred[1], aHat[2] - gPred[2]], this.obsNoise * this.obsNoise);
      }
    }
    const magOk = this.magEnabled && magIsPlausible(mag);
    let innoMagDeg = NaN;
    if (magOk) {
      const mHat = qRotInv(this.q, MAG_WORLD_NED);
      const mh = Math.hypot(mHat[0], mHat[1], mHat[2]);
      const mm = Math.hypot(mag[0], mag[1], mag[2]);
      const mHatN: V3 = [mHat[0] / mh, mHat[1] / mh, mHat[2] / mh];
      const mMeasN: V3 = [mag[0] / mm, mag[1] / mm, mag[2] / mm];
      innoMagDeg = angleBetweenDeg(mMeasN, mHatN);
      if (innoMagDeg < 40) {
        const H = obsMatrix(mHatN);
        const sigmaM = Math.max(2 * this.obsNoise, 0.04); // 磁方向噪声（归一化）
        this.applyUpdate(
          H,
          [mMeasN[0] - mHatN[0], mMeasN[1] - mHatN[1], mMeasN[2] - mHatN[2]],
          sigmaM * sigmaM,
        );
      }
    }

    const predicted: V3 = qRotInv(this.q, [0, 0, 1]);
    const measured: V3 = accelValid ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0];
    this.telemetry = {
      rate: [w[0], w[1], w[2]],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      // 等效修正角速度 = −零偏估计（滤波增益修正在姿态域完成，不落在角速度通道）
      correction: [-this.bias[0], -this.bias[1], -this.bias[2]],
      predictedGravity: predicted,
      measuredGravity: measured,
      accelNorm: norm,
      accelValid,
      magValid: magOk,
      detail: {
        biasXDps: this.bias[0] * (180 / Math.PI),
        biasYDps: this.bias[1] * (180 / Math.PI),
        biasZDps: this.bias[2] * (180 / Math.PI),
        biasNormDps: Math.hypot(this.bias[0], this.bias[1], this.bias[2]) * (180 / Math.PI),
        innoAccelDeg,
        innoMagDeg,
        covTrace: this.P[0] + this.P[7] + this.P[14],
        alignErrorDeg: angleBetweenDeg(predicted, measured),
        ...(magOk ? { magEnabled: 1 } : { magEnabled: 0 }),
      },
    };
  }

  /** 单次观测更新：K = P·Hᵀ·(H·P·Hᵀ+R)⁻¹，δx = K·z，回填姿态/零偏并收缩 P */
  private applyUpdate(H: number[], z: V3, rVar: number): void {
    const PHt = matMul(this.P, matTranspose(H, 3, 6), 6, 6, 3); // (6x3)
    const HPHt = matMul(H, PHt, 3, 6, 3); // (3x3)
    const S = mat3Inverse(HPHt.map((v, i) => (i % 4 === 0 ? v + rVar : v)));
    const K = matMul(PHt, S, 6, 3, 3); // (6x3)
    const dx = [
      K[0] * z[0] + K[1] * z[1] + K[2] * z[2],
      K[3] * z[0] + K[4] * z[1] + K[5] * z[2],
      K[6] * z[0] + K[7] * z[1] + K[8] * z[2],
      K[9] * z[0] + K[10] * z[1] + K[11] * z[2],
      K[12] * z[0] + K[13] * z[1] + K[14] * z[2],
      K[15] * z[0] + K[16] * z[1] + K[17] * z[2],
    ];
    // 野值保护：小角修正限幅
    for (let i = 0; i < 3; i++) dx[i] = Math.max(-0.35, Math.min(0.35, dx[i]));
    // q ← q ⊗ [1, δθ/2]（机体系误差右乘）
    const { w: qw, x: qx, y: qy, z: qz } = this.q;
    const hw = 1, hx = dx[0] / 2, hy = dx[1] / 2, hz = dx[2] / 2;
    this.q = qNorm({
      w: qw * hw - qx * hx - qy * hy - qz * hz,
      x: qw * hx + qx * hw + qy * hz - qz * hy,
      y: qw * hy - qx * hz + qy * hw + qz * hx,
      z: qw * hz + qx * hy - qy * hx + qz * hw,
    });
    let bx = this.bias[0] + dx[3];
    let by = this.bias[1] + dx[4];
    let bz = this.bias[2] + dx[5];
    // 限幅按**向量模长**（逐分量限幅的模长上限是 √3·LIMIT，仍可能飞出）
    const bn = Math.hypot(bx, by, bz);
    if (bn > BIAS_LIMIT) {
      const k = BIAS_LIMIT / bn;
      bx *= k;
      by *= k;
      bz *= k;
    }
    this.bias = [bx, by, bz];
    // Joseph 形式协方差更新：P ← (I−KH)·P·(I−KH)ᵀ + K·R·Kᵀ
    // 比教科书简写 (I−KH)·P 多一次转置乘法，但**对任意 K 都保持对称正定**——
    // 长时间运行、强非线性观测（磁场翻转/门控边界）时不会把 P 推出正定域。
    const KH = matMul(K, H, 6, 3, 6);
    const IKH = new Array<number>(36).fill(0);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) IKH[i * 6 + j] = (i === j ? 1 : 0) - KH[i * 6 + j];
    const IKHt = matTranspose(IKH, 6, 6);
    const Pn = matMul(matMul(IKH, this.P, 6, 6, 6), IKHt, 6, 6, 6);
    // K·R·Kᵀ（R = rVar·I₃）
    const KR = K.map((v) => v * rVar);
    const KRKt = matMul(KR, matTranspose(K, 6, 3), 6, 3, 6);
    for (let i = 0; i < 36; i++) Pn[i] += KRKt[i];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < i; j++) {
        const avg = (Pn[i * 6 + j] + Pn[j * 6 + i]) / 2;
        Pn[i * 6 + j] = avg;
        Pn[j * 6 + i] = avg;
      }
    for (let i = 0; i < 6; i++) Pn[i * 6 + i] = Math.max(P_FLOOR, Pn[i * 6 + i]);
    this.P = Pn;
  }

  reset(initial?: Quat): void {
    this.q = initial ? { ...initial } : qId();
    this.bias = [0, 0, 0];
    this.initCovariance();
    this.telemetry = emptyTelemetry();
  }
  getParams(): Record<string, number> {
    return { gyroNoiseDps: this.gyroNoiseDps, obsNoise: this.obsNoise };
  }
  setParams(p: Record<string, number>): void {
    if (Number.isFinite(p.gyroNoiseDps)) this.gyroNoiseDps = p.gyroNoiseDps;
    if (Number.isFinite(p.obsNoise)) this.obsNoise = p.obsNoise;
  }
  /** 协方差矩阵只读快照（自检/诊断用）：验证对称性与正定性 */
  getCovariance(): number[] {
    return [...this.P];
  }
}
