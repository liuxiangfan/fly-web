/**
 * 捷联惯导力学编排（姿态 → 速度 → 位置）与误差增长律。
 *
 * 本装置只模拟**姿态**，不模拟平动：真值位置恒为原点。因此这里积出来的任何非零
 * 位置都纯粹是「解算误差 + 观测污染」造成的虚漂——这正是真实惯导里最难对付的那部分，
 * 也正是「姿态解算精度为什么值钱」的量化答案。
 *
 * ## 符号约定（本项目的一个坑，写清楚）
 * 模拟加速度计的输出是**重力在机体系的投影方向**：静止时 ã = Rᵀ·(0,0,+g)
 * （+g 沿机体「下」，见 core/imu.ts 的约定说明）。而标准惯导里的比力是
 * f = a − g，静止时 f_ned = (0,0,−g)、f_body = Rᵀ·(0,0,−g) = −ã。
 * 于是导航方程 a_ned = R·f_body + g_vec 在**本项目的符号下**写成：
 *
 *     a_ned = −R(q̂)·ã + (0, 0, +g)
 *
 * 姿态估计精确且无污染时，−R·ã = −(0,0,g)，与重力项相消 → 加速度为零 → 位置不动。
 * 倾角差 δθ 会让 R·ã 的横向分量变成 g·sin(δθ)，也就是教科书那句
 * 「1° 倾角误差 ≈ 0.17 m/s² 的水平加速度」。
 *
 * ## 误差增长律（本模块自检会验证）
 * 陀螺零偏 b 使倾角误差按 b·t 增长 → 水平加速度 ≈ g·b·t
 *   → 速度 ≈ ½·g·b·t²　→　位置 ≈ ⅙·g·b·t³
 * 位置对零偏是**三次方**增长：这就是纯惯导几分钟跑出几公里的原因。
 * 反过来，融合算法用加速度计把倾角钉住后，位置漂移从 t³ 掉到远低于 t 的量级。
 *
 * ## 垂直通道
 * 高度通道在纯惯导里是**不稳定的**（重力与比力相消，误差的正反馈会让它指数发散），
 * 真实系统必须用气压计/GNSS 高度约束。本模块照实积分并把它单列出来，
 * 而不是藏起来——「为什么高度要单独用气压计」正是由此而来。
 */
import { qRot, type Quat, type V3 } from "./quat";

export const G_NED = 9.80665;

export interface InsState {
  /** NED 速度（m/s） */
  v: V3;
  /** NED 位置（m，北/东/下；向下为正） */
  p: V3;
  /** 已经积了多少秒 */
  t: number;
}

/**
 * 单条姿态通道对应的位置积分器。
 *
 * 用**梯形积分**而不是简单欧拉：加速度是被噪声与污染驱动的，梯形法把速度的
 * 截断误差从 O(dt) 降到 O(dt²)——虽然对 t³ 增长律没有本质影响，
 * 但能让「零输入时确实不动」这件事在数值上站得住（自检里会验证）。
 */
export class InsIntegrator {
  v: V3 = [0, 0, 0];
  p: V3 = [0, 0, 0];
  t = 0;
  /** 最近一步的导航系加速度（读数/诊断用） */
  aNed: V3 = [0, 0, 0];
  /** 上一步的导航系加速度（梯形积分用） */
  private aNedPrev: V3 = [0, 0, 0];

  reset(): void {
    this.v = [0, 0, 0];
    this.p = [0, 0, 0];
    this.t = 0;
    this.aNed = [0, 0, 0];
    this.aNedPrev = [0, 0, 0];
  }

  /**
   * 推进一步。
   * @param qEst     该通道的姿态估计
   * @param accel    该步的加速度计读数（机体系；本项目约定 = 重力投影方向）
   * @param dt       步长（秒）
   */
  step(qEst: Quat, accel: V3, dt: number): void {
    if (!(dt > 0)) return;
    const f = qRot(qEst, accel); // 估计姿态下「重力投影」在导航系的指向
    // a_ned = −R·ã + (0,0,g)　（见文件头推导）
    const a: V3 = [-f[0], -f[1], G_NED - f[2]];
    this.aNed = a;
    const vNew: V3 = [
      this.v[0] + ((this.aNedPrev[0] + a[0]) / 2) * dt,
      this.v[1] + ((this.aNedPrev[1] + a[1]) / 2) * dt,
      this.v[2] + ((this.aNedPrev[2] + a[2]) / 2) * dt,
    ];
    this.p = [
      this.p[0] + ((this.v[0] + vNew[0]) / 2) * dt,
      this.p[1] + ((this.v[1] + vNew[1]) / 2) * dt,
      this.p[2] + ((this.v[2] + vNew[2]) / 2) * dt,
    ];
    this.aNedPrev = a;
    this.v = vNew;
    this.t += dt;
  }

  /** 水平漂移距离（北-东平面上的直线距离，米） */
  horizontalDrift(): number {
    return Math.hypot(this.p[0], this.p[1]);
  }

  snapshot(): InsState {
    return { v: [...this.v], p: [...this.p], t: this.t };
  }
}

/**
 * 理论误差增长律（文档与自检用它做「数字对照」）。
 * 给定恒定的倾角误差增长率（rad/s，典型来自陀螺零偏），t 秒后的
 * 水平速度与位置的理论值：
 *   倾角误差 θ(t) = θ̇·t
 *   水平加速度 a(t) ≈ g·θ(t) = g·θ̇·t
 *   速度 v(t) = ½·g·θ̇·t²
 *   位置 d(t) = ⅙·g·θ̇·t³
 */
export function driftLaw(thetaDotRadPerSec: number, tSec: number): { accel: number; speed: number; distance: number } {
  const accel = G_NED * thetaDotRadPerSec * tSec;
  const speed = 0.5 * G_NED * thetaDotRadPerSec * tSec * tSec;
  const distance = (G_NED * thetaDotRadPerSec * tSec * tSec * tSec) / 6;
  return { accel, speed, distance };
}
