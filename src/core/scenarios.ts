/** 机动剧本：给出时刻 t（秒）的目标欧拉角（°），机体以受限角速度跟踪 */
import type { V3 } from "./quat";

export interface Scenario {
  id: string;
  name: string;
  /** 机动线加速度加权（叠加在滑块之上） */
  accelFactor: number;
  /**
   * 目标姿态（度）。`world` 可选：只有 manual 剧本需要它来读**实例**的手动目标，
   * 其余剧本只用 t，保持纯函数（不依赖任何全局可变状态）。
   */
  targetEulerDeg(t: number, world?: { manual: ManualTarget }): [number, number, number];
  /**
   * **运动学一致模式**（可选）：直接规定真值姿态（欧拉角，ZYX，度）与世界系平动加速度，
   * 由 World 解析求角速度并积分真值速度/位置。用于把「姿态、角速度、比力、位置真值」
   * 接到同一条物理轨迹上，而不是姿态剧本与独立正弦扰动各走各的。
   */
  kinematic?: {
    attitudeEulerDeg(t: number): [number, number, number];
    /** 世界 NED 系平动加速度（m/s²） */
    accelWorld(t: number): V3;
    /** 初始速度（NED，m/s）；协调转弯需要 [V,0,0] 才走圆弧而不是从静止螺旋 */
    initialVelocityNed?: V3;
  };
}

type Key = [t: number, roll: number, pitch: number, yaw: number];

/** 关键帧插值（smoothstep 平滑），循环播放 */
function keyframes(keys: Key[]): (t: number) => [number, number, number] {
  const dur = keys[keys.length - 1][0];
  return (t: number): [number, number, number] => {
    const tt = dur > 0 ? t % dur : 0;
    let i = 0;
    while (i < keys.length - 2 && tt > keys[i + 1][0]) i++;
    const [t0, r0, p0, y0] = keys[i];
    const [t1, r1, p1, y1] = keys[i + 1];
    const u = t1 > t0 ? Math.min(1, Math.max(0, (tt - t0) / (t1 - t0))) : 1;
    const s = u * u * (3 - 2 * u);
    return [r0 + (r1 - r0) * s, p0 + (p1 - p0) * s, y0 + (y1 - y0) * s];
  };
}

export interface ManualTarget {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

/**
 * 手动模式的**默认**目标。仅为兼容旧调用（界面滑块历史上直接写这里）保留；
 * 正确的数据流是：配置里的 `manualTargetDeg` → `World.setManualTarget()`，
 * 这样「同配置 + 同 seed」才真的可复现（全局可变对象会让复现随进程状态漂移）。
 */
export const manualTarget: ManualTarget = { rollDeg: 0, pitchDeg: 0, yawDeg: 0 };

export const scenarios: Record<string, Scenario> = {
  hover: {
    id: "hover",
    name: "悬停微扰",
    accelFactor: 0.4,
    targetEulerDeg: (t) => [
      6 * Math.sin(2 * Math.PI * 0.18 * t + 0.6),
      5 * Math.sin(2 * Math.PI * 0.13 * t + 1.9),
      10 * Math.sin(2 * Math.PI * 0.08 * t),
    ],
  },
  manual: {
    id: "manual",
    name: "手动控制",
    accelFactor: 0.5,
    targetEulerDeg: (t, world) => {
      const m = world?.manual ?? manualTarget;
      void t;
      return [m.rollDeg, m.pitchDeg, m.yawDeg];
    },
  },
  roll360: {
    id: "roll360",
    name: "横滚 360°",
    accelFactor: 1.0,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [1.5, 0, 0, 0],
      [3.5, 360, 0, 0],
      [6, 360, 0, 0],
    ]),
  },
  pitch: {
    id: "pitch",
    name: "俯仰摆动",
    accelFactor: 0.9,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [2, 0, 45, 0],
      [4, 0, -45, 0],
      [6, 0, 45, 0],
      [8, 0, 0, 0],
    ]),
  },
  composite: {
    id: "composite",
    name: "复合机动",
    accelFactor: 1.2,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [3, 12, 25, 60],
      [6, -35, -25, 150],
      [9, 25, 30, 270],
      [12, 0, 0, 360],
    ]),
  },
  violent: {
    id: "violent",
    name: "剧烈机动",
    accelFactor: 2.0,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [1.2, 0, -50, 0],
      [2.6, 180, 35, 0],
      [4.2, -90, -60, 120],
      [5.6, 60, 50, 240],
      [7, 0, 0, 360],
    ]),
  },
  /**
   * 万向节锁 · 停驻：俯仰**精确**停在 90°，再让横滚来回走。
   *
   * 这是全装置最锋利的一条教学剧本：机械视角看到的是环轴重合（万向节锁视图），
   * 算法视角看到的是互补滤波崩坏，而四元数算法毫发无伤——同一件事的两张脸。
   *
   * 为什么必须「停驻」而不是「穿越」：欧拉参数化的奇点只在**恰好** ±90° 处退化。
   * 慢扫穿过 90° 时，500 Hz 采样的最近一帧通常落在 89.99° 或 90.01°，奇点被跳过；
   * 只有让目标角度在若干秒内恒等于 90，奇点才会被持续命中。
   *
   * 为什么横滚必须动：俯仰 90° 时重力沿机体 x 轴，加速度计对横滚**完全失去信息**
   * （g_body = (−1,0,0) 与横滚无关）。静止不动时互补滤波恰好不出错，一滚就露馅。
   */
  pitchHold: {
    id: "pitchHold",
    name: "万向节锁·停驻 90°",
    accelFactor: 0.6,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [2, 0, 90, 0],
      [3.5, 0, 90, 0],
      [6.5, 90, 90, 0],
      [8, 90, 90, 0],
      [11, 0, 90, 0],
      [13, 0, 0, 0],
    ]),
  },
  /** 万向节锁 · 穿越：俯仰 0→180° 慢扫再回到 0，看奇点附近各算法的受扰形态 */
  pitchSweep: {
    id: "pitchSweep",
    name: "穿越万向节锁 ±90°",
    accelFactor: 0.5,
    targetEulerDeg: keyframes([
      [0, 0, 0, 0],
      [2, 0, 60, 0],
      [5, 0, 120, 0],
      [7, 0, 180, 0],
      [8.5, 0, 180, 0],
      [11.5, 0, 0, 0],
    ]),
  },

  /**
   * 运动学一致 · 恒定加速度：姿态保持水平，世界北向恒定加速度 a。
   * 加计真实读数 = Rᵀ(g−a)，位置真值 = ½at²；INS 面板应看到「真值轨迹」被理想编排精确跟踪，
   * 而带噪声/零偏的算法逐渐分开——这是把「姿态误差 → 位置漂移」接到真实平动上的最简现场。
   */
  constantAccel: {
    id: "constantAccel",
    name: "平动·恒定加速度",
    accelFactor: 0,
    targetEulerDeg: () => [0, 0, 0],
    kinematic: {
      attitudeEulerDeg: () => [0, 0, 0],
      accelWorld: () => [1.5, 0, 0],
    },
  },
  /**
   * 运动学一致 · 协调转弯：速度 V、偏航角速率 r，bank = atan(V·r/g)。
   * 世界系加速度为向心加速度 V·r·[−sinψ, cosψ, 0]；姿态为 [bank, 0, ψ]。
   * 真实飞行的「机动线加速度污染」在这里不再是一条独立正弦，而是与姿态/角速度同源。
   */
  coordinatedTurn: {
    id: "coordinatedTurn",
    name: "平动·协调转弯",
    accelFactor: 0,
    targetEulerDeg: () => [0, 0, 0],
    kinematic: {
      attitudeEulerDeg: (t) => {
        const V = 8;
        const r = 0.5;
        const bank = Math.atan2(V * r, 9.80665) * (180 / Math.PI);
        const yaw = ((r * t) % (2 * Math.PI)) * (180 / Math.PI);
        return [bank, 0, yaw];
      },
      accelWorld: (t) => {
        const V = 8;
        const r = 0.5;
        const psi = r * t;
        return [-V * r * Math.sin(psi), V * r * Math.cos(psi), 0];
      },
      initialVelocityNed: [8, 0, 0],
    },
  },
};
