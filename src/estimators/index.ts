import type { Quat, V3 } from "../core/quat";
import { qFromEuler, qId, qIntegrate, qNorm, qSlerp, qToEuler } from "../core/quat";

export interface Estimator {
  id: "truth" | "pure" | "comp" | "mahony" | "madg";
  label: string;
  color: string;
  q: Quat;
  update(gyro: V3, accel: V3, dt: number): void;
  reset(): void;
}

/** 1. 纯陀螺积分：q ← q ⊗ Δq(ω·dt)。无校正，零偏与噪声逐步累积 → 漂移 */
export class PureGyroEstimator implements Estimator {
  id = "pure" as const;
  label = "纯陀螺积分";
  color = "#f85149";
  q = qId();
  update(gyro: V3, _accel: V3, dt: number): void {
    this.q = qIntegrate(this.q, gyro, dt);
  }
  reset(): void {
    this.q = qId();
  }
}

/** 2. 互补滤波：陀螺积分提供高频，加计倾角提供低频，按 α 速率融合。偏航不可观，随陀螺漂移 */
export class ComplementaryEstimator implements Estimator {
  id = "comp" as const;
  label = "互补滤波";
  color = "#ffa657";
  q = qId();
  alpha = 1; // 加计融合速率（1/s）
  update(gyro: V3, accel: V3, dt: number): void {
    const qGyro = qIntegrate(this.q, gyro, dt);
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    if (norm < 1e-6) {
      this.q = qGyro;
      return;
    }
    const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
    const rollAcc = Math.atan2(ay, az);
    const pitchAcc = Math.atan2(-ax, Math.hypot(ay, az));
    const { yaw } = qToEuler(qGyro); // 偏航沿用陀螺（加计看不出偏航）
    const qAcc = qFromEuler(rollAcc, pitchAcc, yaw);
    this.q = qSlerp(qGyro, qAcc, 1 - Math.exp(-this.alpha * dt));
  }
  reset(): void {
    this.q = qId();
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
  update(gyro: V3, accel: V3, dt: number): void {
    const { w, x, y, z } = this.q;
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    let omega: V3 = [gyro[0], gyro[1], gyro[2]];
    if (norm > 1e-6) {
      const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
      // 预测的重力方向（机体系）：Rᵀ(q)·[0,0,1]
      const vx = 2 * (x * z - w * y);
      const vy = 2 * (w * x + y * z);
      const vz = 1 - 2 * x * x - 2 * y * y;
      // 误差 = 实测 × 预测（叉积）
      const ex = ay * vz - az * vy;
      const ey = az * vx - ax * vz;
      const ez = ax * vy - ay * vx;
      this.eInt = [this.eInt[0] + ex * dt, this.eInt[1] + ey * dt, this.eInt[2] + ez * dt];
      const iCap = Math.hypot(this.eInt[0], this.eInt[1], this.eInt[2]);
      const scale = iCap > 5 ? 5 / iCap : 1; // 积分限幅
      omega = [
        gyro[0] + this.kp * ex + this.ki * this.eInt[0] * scale,
        gyro[1] + this.kp * ey + this.ki * this.eInt[1] * scale,
        gyro[2] + this.kp * ez + this.ki * this.eInt[2] * scale,
      ];
    }
    this.q = qIntegrate(this.q, omega, dt);
  }
  reset(): void {
    this.q = qId();
    this.eInt = [0, 0, 0];
  }
}

/** 4. Madgwick：以梯度下降最小化「预测重力方向 vs 实测加计方向」，β 控制步长 */
export class MadgwickEstimator implements Estimator {
  id = "madg" as const;
  label = "Madgwick";
  color = "#7ee787";
  q = qId();
  beta = 0.1;
  update(gyro: V3, accel: V3, dt: number): void {
    const { w, x, y, z } = this.q;
    // 陀螺微分项：q̇ = ½ q ⊗ ω（此处不乘 dt，最后统一乘）
    const gdW = 0.5 * (-x * gyro[0] - y * gyro[1] - z * gyro[2]);
    const gdX = 0.5 * (w * gyro[0] + y * gyro[2] - z * gyro[1]);
    const gdY = 0.5 * (w * gyro[1] - x * gyro[2] + z * gyro[0]);
    const gdZ = 0.5 * (w * gyro[2] + x * gyro[1] - y * gyro[0]);

    let dw = gdW, dx = gdX, dy = gdY, dz = gdZ;
    const norm = Math.hypot(accel[0], accel[1], accel[2]);
    if (norm > 1e-6) {
      const ax = accel[0] / norm, ay = accel[1] / norm, az = accel[2] / norm;
      // 目标函数 f = 预测重力方向 − 实测方向
      const f1 = 2 * (x * z - w * y) - ax;
      const f2 = 2 * (w * x + y * z) - ay;
      const f3 = 2 * (0.5 - x * x - y * y) - az;
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
  }
  reset(): void {
    this.q = qId();
  }
}
