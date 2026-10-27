/** 机动剧本：给出时刻 t（秒）的目标欧拉角（°），机体以受限角速度跟踪 */

export interface Scenario {
  id: string;
  name: string;
  /** 机动线加速度加权（叠加在滑块之上） */
  accelFactor: number;
  targetEulerDeg(t: number): [number, number, number];
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

/** 手动模式共享目标：UI 滑块直接写这里，World.manual 指向同一对象 */
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
    targetEulerDeg: () => [manualTarget.rollDeg, manualTarget.pitchDeg, manualTarget.yawDeg],
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
};
