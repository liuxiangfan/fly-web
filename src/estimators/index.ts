import type { Quat, V3 } from "../core/quat";
import { qFromEuler, qId, qIntegrate, qNorm, qSlerp, qToEuler } from "../core/quat";

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
    detail: {},
  };
}

export interface Estimator {
  id: "truth" | "pure" | "comp" | "mahony" | "madg";
  label: string;
  color: string;
  q: Quat;
  /** 最近一帧 update() 填充的内部量（玻璃盒可视化只读） */
  telemetry: EstimatorTelemetry;
  update(gyro: V3, accel: V3, dt: number): void;
  reset(): void;
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
  label = "纯陀螺积分";
  color = "#f85149";
  q = qId();
  telemetry = emptyTelemetry();
  update(gyro: V3, accel: V3, dt: number): void {
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
      detail: { alignErrorDeg: angleBetweenDeg(this.telemetry.predictedGravity, this.telemetry.measuredGravity) },
    };
  }
  reset(): void {
    this.q = qId();
    this.telemetry = emptyTelemetry();
  }
}

/** 2. 互补滤波：陀螺积分提供高频，加计倾角提供低频，按 α 速率融合。偏航不可观，随陀螺漂移 */
export class ComplementaryEstimator implements Estimator {
  id = "comp" as const;
  label = "互补滤波";
  color = "#ffa657";
  q = qId();
  alpha = 1; // 加计融合速率（1/s）
  telemetry = emptyTelemetry();
  update(gyro: V3, accel: V3, dt: number): void {
    const qGyro = qIntegrate(this.q, gyro, dt);
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    if (norm < 1e-6) {
      this.q = qGyro;
      this.telemetry = {
        ...this.telemetry,
        rate: [gyro[0], gyro[1], gyro[2]],
        rawGyro: [gyro[0], gyro[1], gyro[2]],
        correction: [0, 0, 0],
        accelNorm: 0,
        accelValid: false,
        detail: { accelWeight: 0 },
      };
      return;
    }
    const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
    const rollAcc = Math.atan2(ay, az);
    const pitchAcc = Math.atan2(-ax, Math.hypot(ay, az));
    const { yaw } = qToEuler(qGyro); // 偏航沿用陀螺（加计看不出偏航）
    const qAcc = qFromEuler(rollAcc, pitchAcc, yaw);
    const wAcc = 1 - Math.exp(-this.alpha * dt);
    this.q = qSlerp(qGyro, qAcc, wAcc);

    const { w, x, y, z } = this.q;
    const euGyro = qToEuler(qGyro);
    this.telemetry = {
      rate: [gyro[0], gyro[1], gyro[2]],
      rawGyro: [gyro[0], gyro[1], gyro[2]],
      // 互补没有显式角速度修正，用「本帧姿态被加计拉动的角度 / dt」作为等效修正量
      correction: [wAcc * (rollAcc - euGyro.roll) / dt, wAcc * (pitchAcc - euGyro.pitch) / dt, 0],
      predictedGravity: [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y],
      measuredGravity: [ax, ay, az],
      accelNorm: norm,
      accelValid: Math.abs(norm - G) < 0.35 * G,
      detail: {
        accelWeight: wAcc,
        rollAccDeg: rollAcc * (180 / Math.PI),
        pitchAccDeg: pitchAcc * (180 / Math.PI),
        alignErrorDeg: angleBetweenDeg(this.telemetry.predictedGravity, [ax, ay, az]),
      },
    };
  }
  reset(): void {
    this.q = qId();
    this.telemetry = emptyTelemetry();
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
  private eInt: V3 = [0, 0, 0];
  telemetry = emptyTelemetry();
  update(gyro: V3, accel: V3, dt: number): void {
    const { w, x, y, z } = this.q;
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    let omega: V3 = [gyro[0], gyro[1], gyro[2]];
    const predicted: V3 = [2 * (x * z - w * y), 2 * (w * x + y * z), 1 - 2 * x * x - 2 * y * y];
    const measured: V3 = norm > 1e-6 ? [accel[0] / norm, accel[1] / norm, accel[2] / norm] : [0, 0, 0];
    let pTerm: V3 = [0, 0, 0];
    let iTerm: V3 = [0, 0, 0];
    let iUsage = 0;
    if (norm > 1e-6) {
      const ax = measured[0], ay = measured[1], az = measured[2];
      const vx = predicted[0], vy = predicted[1], vz = predicted[2];
      // 误差 = 实测 × 预测（叉积）
      const ex = ay * vz - az * vy;
      const ey = az * vx - ax * vz;
      const ez = ax * vy - ay * vx;
      this.eInt = [this.eInt[0] + ex * dt, this.eInt[1] + ey * dt, this.eInt[2] + ez * dt];
      const iCap = Math.hypot(this.eInt[0], this.eInt[1], this.eInt[2]);
      const scale = iCap > 5 ? 5 / iCap : 1; // 积分限幅
      pTerm = [this.kp * ex, this.kp * ey, this.kp * ez];
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
      accelValid: Math.abs(norm - G) < 0.35 * G,
      detail: {
        pShare: magP + magI > 1e-12 ? magP / (magP + magI) : 0, // 比例项占比（供双色条）
        iUsage,
        eIntMag: Math.hypot(this.eInt[0], this.eInt[1], this.eInt[2]),
        alignErrorDeg: angleBetweenDeg(predicted, measured),
      },
    };
  }
  reset(): void {
    this.q = qId();
    this.eInt = [0, 0, 0];
    this.telemetry = emptyTelemetry();
  }
}

/** 4. Madgwick：以梯度下降最小化「预测重力方向 vs 实测加计方向」，β 控制步长 */
export class MadgwickEstimator implements Estimator {
  id = "madg" as const;
  label = "Madgwick";
  color = "#7ee787";
  q = qId();
  beta = 0.1;
  telemetry = emptyTelemetry();
  update(gyro: V3, accel: V3, dt: number): void {
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
    if (norm > 1e-6) {
      const ax = measured[0], ay = measured[1], az = measured[2];
      // 目标函数 f = 预测重力方向 − 实测方向
      const f1 = 2 * (x * z - w * y) - ax;
      const f2 = 2 * (w * x + y * z) - ay;
      const f3 = 2 * (0.5 - x * x - y * y) - az;
      residual = Math.hypot(f1, f2, f3);
      // 梯度 Jᵀf
      let s0 = -2 * y * f1 + 2 * x * f2;
      let s1 = 2 * z * f1 + 2 * w * f2 - 4 * x * f3;
      let s2 = -2 * w * f1 + 2 * z * f2 - 4 * y * f3;
      let s3 = 2 * x * f1 + 2 * y * f2;
      const sNorm = Math.hypot(s0, s1, s2, s3);
      if (sNorm > 1e-9) {
        s0 /= sNorm; s1 /= sNorm; s2 /= sNorm; s3 /= sNorm;
        dw -= this.beta * s0;
        dx -= this.beta * s1;
        dy -= this.beta * s2;
        dz -= this.beta * s3;
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
      accelValid: Math.abs(norm - G) < 0.35 * G,
      detail: {
        residual,
        stepNorm: Math.hypot(dx, dy, dz) * dt,
        alignErrorDeg: angleBetweenDeg(predicted, measured),
      },
    };
  }
  reset(): void {
    this.q = qId();
  }
}
