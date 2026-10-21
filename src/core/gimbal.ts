/**
 * 万向环（万向节锁）演示的纯数学核心。
 *
 * 显示坐标系：X = 北（机头方向）、Y = 上、Z = 东。与 scene/ 中的 Three.js 场景一致。
 * 万向环层级（外 → 内）：偏航 ψ → 俯仰 θ → 横滚 φ，对应显示轴
 *   偏航：绕显示 +Y 转 −ψ     俯仰：绕显示 +Z 转 θ     横滚：绕显示 +X 转 φ
 * 这三级串联组合出的内环姿态，必须严格等于主视图使用的 toDisplay(qFromEuler(φ,θ,ψ))——
 * 自检脚本用随机角度逐分量比对来守住这条不变量。
 */
import { qFromAxisAngle, qMul, type Quat } from "./quat";

export interface GimbalAngles {
  /** 弧度 */
  roll: number;
  /** 弧度 */
  pitch: number;
  /** 弧度 */
  yaw: number;
}

/** 基变换 S：把 NED(北-东-下) 坐标系转到显示坐标系（绕显示 X 轴 +90°） */
const DISPLAY_S: Quat = (() => {
  const h = Math.PI / 4;
  return { w: Math.cos(h), x: Math.sin(h), y: 0, z: 0 };
})();

const DISPLAY_S_INV: Quat = { w: DISPLAY_S.w, x: -DISPLAY_S.x, y: -DISPLAY_S.y, z: -DISPLAY_S.z };

/** NED 姿态四元数 → 显示坐标系姿态四元数（S·q·S⁻¹） */
export function toDisplayQ(qNed: Quat): Quat {
  return qMul(qMul(DISPLAY_S, qNed), DISPLAY_S_INV);
}

/**
 * NED 机体系向量 → 显示坐标系向量（S·v，左乘基变换即可）。
 * 用于把估计器遥测的重力方向画在 3D 模型上：箭头作为显示四轴的子节点，
 * 模型姿态由场景图完成，这里只负责把「机体系方向」翻转到显示约定。
 * S = 绕 X 轴 +90°：(x, y, z) → (x, −z, y)。
 */
export function toDisplayVec(v: [number, number, number]): [number, number, number] {
  return [v[0], -v[2], v[1]];
}

/**
 * 万向环链条组合出的内环世界姿态（显示坐标系）。
 * 与 scene/gimbal.ts 里 yawGroup.rotation.y = −ψ、pitchGroup.rotation.z = θ、
 * rollGroup.rotation.x = φ 的三级父子关系严格对应。
 */
export function gimbalInnerQuat(a: GimbalAngles): Quat {
  const yawQ = qFromAxisAngle([0, 1, 0], -a.yaw);
  const pitchQ = qFromAxisAngle([0, 0, 1], a.pitch);
  const rollQ = qFromAxisAngle([1, 0, 0], a.roll);
  return qMul(qMul(yawQ, pitchQ), rollQ);
}

/**
 * 外环轴（显示 +Y）与内环轴的对齐度：0 = 正交（三轴独立），1 = 完全重合（死锁）。
 * 解析式即为 |sin(俯仰)|。
 */
export function gimbalAxisAlign(pitch: number): number {
  return Math.abs(Math.sin(pitch));
}

/** 万向节锁判定：俯仰接近 ±90°，内外环轴重合，横滚与偏航退化为同一个动作 */
export function gimbalLocked(pitch: number, eps = 0.9995): boolean {
  return gimbalAxisAlign(pitch) > eps;
}

/** 「扫过 ±90°」演示的俯仰角关键帧：[进度 0..1, 俯仰角(度)]，含 ±90° 驻留段 */
const SWEEP_KEYS: Array<[number, number]> = [
  [0.0, 0],
  [0.3, 90],
  [0.42, 90],
  [0.72, -90],
  [0.84, -90],
  [1.0, 0],
];

/** 扫过演示：进度 u ∈ [0,1] → 俯仰角（度）。首尾回到 0，中途在 ±90° 各驻留一段以便观察死锁 */
export function sweepPitchDeg(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  let i = 0;
  while (i < SWEEP_KEYS.length - 2 && t > SWEEP_KEYS[i + 1][0]) i++;
  const [u0, p0] = SWEEP_KEYS[i];
  const [u1, p1] = SWEEP_KEYS[i + 1];
  const k = u1 > u0 ? (t - u0) / (u1 - u0) : 1;
  const s = k * k * (3 - 2 * k); // smoothstep
  return p0 + (p1 - p0) * s;
}

// ---------------------------------------------------------------------------
// 万向节锁完整演示：不只扫过 90°，而是把「只剩两个自由度」这件事演出来
// ---------------------------------------------------------------------------

export interface DemoPhase {
  id: string;
  dur: number;
  /** [起始, 结束]（度） */
  roll: [number, number];
  pitch: [number, number];
  yaw: [number, number];
  message: string;
  /** record：记录当前姿态作为参照；verify：与参照姿态对比 */
  compare?: "record" | "verify";
}

/**
 * 演示脚本（共约 14 秒）。
 *
 * 核心设计：俯仰停在 +90°（锁定），先用【横滚 +60°】到达某个姿态并记录下来，
 * 再退回起点、改用【偏航 −60°】。在锁定状态下这两条路径得到的姿态**完全相同**
 * （数学上 q(yaw=0)·q(pitch=90°)·q(roll=60°) ≡ q(yaw=−60°)·q(pitch=90°)·q(roll=0)），
 * 因此「两个滑块控制同一个自由度」就被直接证明了——这正是死锁的含义。
 */
const DEMO_PHASES: DemoPhase[] = [
  {
    id: "approach",
    dur: 2.2,
    roll: [0, 0],
    pitch: [0, 90],
    yaw: [0, 0],
    message: "俯仰转向 90°：注意内外环的两根轴正在逐渐靠拢",
  },
  {
    id: "locked",
    dur: 1.2,
    roll: [0, 0],
    pitch: [90, 90],
    yaw: [0, 0],
    message: "俯仰 = 90°：横滚轴与偏航轴已经重合，两环变红报警——只剩 2 个自由度",
  },
  {
    id: "rollTurn",
    dur: 2.4,
    roll: [0, 60],
    pitch: [90, 90],
    yaw: [0, 0],
    message: "现在只动【横滚】+60°：机头朝向被改变了（而外环框架不动）",
  },
  {
    id: "remember",
    dur: 1.0,
    roll: [60, 60],
    pitch: [90, 90],
    yaw: [0, 0],
    message: "记住此刻这个姿态，稍后换一种操作复现它",
    compare: "record",
  },
  {
    id: "backToStart",
    dur: 1.0,
    roll: [60, 0],
    pitch: [90, 90],
    yaw: [0, 0],
    message: "先退回起点（俯仰仍锁定在 90°）",
  },
  {
    id: "yawTurn",
    dur: 2.4,
    roll: [0, 0],
    pitch: [90, 90],
    yaw: [0, -60],
    message: "这次改只动【偏航】−60°",
  },
  {
    id: "verify",
    dur: 1.6,
    roll: [0, 0],
    pitch: [90, 90],
    yaw: [-60, -60],
    message: "对比结果",
    compare: "verify",
  },
  {
    id: "unwind",
    dur: 1.8,
    roll: [0, 0],
    pitch: [90, 0],
    yaw: [-60, 0],
    message: "退出锁定：俯仰回到 0°，三根轴重新相互独立",
  },
  {
    id: "done",
    dur: 0.8,
    roll: [0, 0],
    pitch: [0, 0],
    yaw: [0, 0],
    message: "演示结束：俯仰 90° 时横滚与偏航只能合成 1 个自由度（3 − 1 = 2）",
  },
];

export const GIMBAL_DEMO_PHASES: ReadonlyArray<{ id: string; dur: number }> = DEMO_PHASES.map((p) => ({
  id: p.id,
  dur: p.dur,
}));

export const GIMBAL_DEMO_DURATION = DEMO_PHASES.reduce((sum, p) => sum + p.dur, 0);

/** 某相位结束时的累计时间（秒），供自检脚本取关键帧 */
export function gimbalDemoPhaseEnd(id: string): number {
  let acc = 0;
  for (const p of DEMO_PHASES) {
    acc += p.dur;
    if (p.id === id) return acc;
  }
  return GIMBAL_DEMO_DURATION;
}

export interface GimbalDemoState {
  /** 度 */
  roll: number;
  /** 度 */
  pitch: number;
  /** 度 */
  yaw: number;
  message: string;
  phaseId: string;
  compare: "record" | "verify" | null;
  progress: number;
  finished: boolean;
}

/** 演示脚本求值：t（秒）→ 该时刻三个环的角度与解说 */
export function gimbalDemo(t: number): GimbalDemoState {
  const T = Math.min(Math.max(t, 0), GIMBAL_DEMO_DURATION);
  let acc = 0;
  for (let i = 0; i < DEMO_PHASES.length; i++) {
    const p = DEMO_PHASES[i];
    const isLast = i === DEMO_PHASES.length - 1;
    if (T < acc + p.dur || isLast) {
      const u = p.dur > 0 ? Math.min(1, Math.max(0, (T - acc) / p.dur)) : 1;
      const s = u * u * (3 - 2 * u); // smoothstep
      return {
        roll: p.roll[0] + (p.roll[1] - p.roll[0]) * s,
        pitch: p.pitch[0] + (p.pitch[1] - p.pitch[0]) * s,
        yaw: p.yaw[0] + (p.yaw[1] - p.yaw[0]) * s,
        message: p.message,
        phaseId: p.id,
        compare: p.compare ?? null,
        progress: GIMBAL_DEMO_DURATION > 0 ? T / GIMBAL_DEMO_DURATION : 1,
        finished: t >= GIMBAL_DEMO_DURATION,
      };
    }
    acc += p.dur;
  }
  // 理论上不可达（最后一个相位必被选中）
  return {
    roll: 0,
    pitch: 0,
    yaw: 0,
    message: "",
    phaseId: "done",
    compare: null,
    progress: 1,
    finished: true,
  };
}
