import type { Quat, V3 } from "./quat";
import { qRotInv } from "./quat";
import { Gauss } from "./rng";

export const G_ACC = 9.80665;

export interface ImuParams {
  /** 陀螺恒定零偏（°/s），作用在 [1, -0.7, 0.5] 归一化方向上 */
  gyroBiasDps: number;
  /** 陀螺白噪声 σ（°/s，每采样点） */
  gyroNoiseDps: number;
  /** 陀螺零偏随机游走 σ（°/s/√s）——由 World 持有游走状态并每步注入；0 = 关闭（不消耗随机数） */
  gyroWalkDps: number;
  /** 陀螺满量程（°/s）：读数被削平在 ±量程。0 = 关闭（不截断）。
   *  真实器件在剧烈机动/碰撞时会饱和，积分器拿到一串恒定最大速率 → 姿态大幅跑偏。 */
  gyroRangeDps: number;
  /** 陀螺刻度因子误差（0..0.05）：各轴增益失配（确定性、三轴符号固定）。
   *  速率相关的姿态误差——**零偏估计吸收不了它**（它随 ω 变号，不是常数偏置）。 */
  gyroScaleErr: number;
  /** 陀螺三轴非正交/安装失准（0..0.05）：各轴混入另外两轴的比例项 */
  gyroMisalign: number;
  /** 加计白噪声 σ（m/s²） */
  accelNoise: number;
  /** 加计交叉轴敏感度（0..0.1）：每轴混入另外两轴各 k·a 的读数（MPU-9250 规格 ±2%）。0 = 关闭 */
  accelCrossAxis: number;
  /** 加计非线性（0..0.1）：偏离 1g 的二次压缩 a·(1 − k·(|a|/g − 1)²)（MPU-9250 规格 ±0.5%）。0 = 关闭 */
  accelNonlin: number;
  /** 机动线加速度幅值（m/s²），由剧本的 accelFactor 加权 */
  linAccel: number;
  /** 电机振动强度 0..1 */
  vibration: number;
  /** 磁力计白噪声 σ（μT）。默认 0：磁链整体关闭，噪声序列与旧版逐位一致 */
  magNoise: number;
  /** 磁力计量化步长（μT，AK8963 = 0.6）。0 = 关闭（确定性取整，不消耗随机数） */
  magQuantUts: number;
  /** 硬铁偏移 |B|（0..1，沿机体系 [0.3, -0.2, 0.8] 方向叠加恒定偏移），模拟安装金属 */
  hardIron: number;
  /** 交变磁干扰强度 0..1（叠加在 x/y 分量的低频正弦，模拟电机通电磁场） */
  disturbMag: number;
  /** 软铁畸变强度 0..0.4：作用一个 3×3 矩阵 S = I + g·SOFT_IRON_M，模拟机身铁磁材料导磁
   *  把磁球压成椭球。矩阵**同时含对角增益与交叉项**——对角增益随便哪个球拟合都能收掉，
   *  交叉项（椭球轴不与机体轴对齐）则是对角标定吸收不掉的那一半，这正是「完整做法要
   *  3×3 椭球拟合」的现场证据。0 = 矩阵严格退化为单位阵（不消耗随机数） */
  magSoftIron: number;
  /** 传感器群延迟（ms，0..30）：整帧采样延后交给算法。
   *  真实 MEMS 的传输 + 抗混叠滤波会带来群延迟；机动中它让姿态**滞后** ω·τ，
   *  在控制回路里吃掉相位裕度（增益加到某个值就振）。0 = 关闭 */
  sensorDelayMs: number;
  /** 传感器带宽（Hz，0 = 关闭）：一阶低通，模拟抗混叠滤波与器件带宽；
   *  开启后高频振动被衰减、同时引入相位滞后（与群延迟叠加） */
  sensorBandwidthHz?: number;
  /** 陀螺/加计/磁的相对延迟差（ms，0..20）：陀螺提前 skew、磁滞后 skew、加计取基准——
   *  用于演示「三路时间戳不同步」比整帧延迟更接近真实；
   *  0 = 三路共用同一条整帧延迟（历史默认行为，逐位一致） */
  sensorDelaySkewMs?: number;
  /** 传感器采样率（Hz；0/undefined = 跟随仿真步长）。低于仿真步长时按零阶保持抽样，
   *  模拟「传感器采样率 ≠ 算法解算率」；高于奈奎斯特的运动会因此折回低频（混叠） */
  sensorSampleHz?: number;
}

export interface ImuSample {
  /** 陀螺仪：机体系角速度 + 零偏 + 噪声（rad/s） */
  gyro: V3;
  /** 加速度计：重力方向投影 + 机动线加速度 + 振动 + 噪声（m/s²） */
  accel: V3;
  /** 磁力计：世界磁场在机体系的投影 + 硬铁/干扰/噪声（μT） */
  mag: V3;
  /**
   * 各通道自己的采样时刻（秒，与调用方时间轴同源）。
   * 只有经过 `SensorPipeline` 且**真有延迟/带宽/降采样**时才带上；
   * 三路延迟不同步时 `times.gyro/accel/mag` 会分开，可直接读出各通道滞后。
   * 透传快路径不带该字段（保持历史逐位一致的契约）。
   */
  times?: { gyro: number; accel: number; mag: number };
  /**
   * 陀螺仪本帧是否真的被满量程削顶（只读观测信号）。
   * 只在**实际削顶分支**发生变化时写入 true；未启用或本帧未削顶时不带字段，
   * 保持既有 ImuSample 透传与逐位一致契约。事件层只能读它，不能按 |gyro|≈range 猜测。
   */
  gyroSaturated?: boolean;
}

/**
 * 世界系磁场（NED，μT 量级）：北向分量 + 向下分量（磁倾角约 49° 的简化）。
 * 常量：偏航参考就在水平分量上，MARG 解算用它约束 yaw。
 */
export const MAG_WORLD_NED: V3 = (() => {
  const B = 50; // 总场强 μT
  const dip = 49 * (Math.PI / 180); // 磁倾角
  return [B * Math.cos(dip), 0, B * Math.sin(dip)];
})();

const HARD_IRON_DIR: V3 = (() => {
  const n = Math.hypot(0.3, -0.2, 0.8);
  return [0.3 / n, -0.2 / n, 0.8 / n];
})();

/**
 * 软铁畸变矩阵（确定性常量，不消耗随机数）：S = I + g·M。
 * 对角项给三轴不同的增益（椭球三轴伸缩），交叉项让椭球轴偏开机体轴——
 * 后者是对角软铁标定收不掉的部分。
 */
export const SOFT_IRON_M: readonly V3[] = [
  [0.85, 0.30, -0.16],
  [0.26, -0.72, 0.22],
  [-0.14, 0.34, 0.6],
];

/** 软铁矩阵对角增益（标定读数的可读换算：±13% 之类） */
export function softIronGains(g: number): V3 {
  return SOFT_IRON_M.map((row, i) => 1 + g * row[i]) as unknown as V3;
}

const BIAS_DIR: V3 = (() => {
  const n = Math.hypot(1, -0.7, 0.5);
  return [1 / n, -0.7 / n, 0.5 / n];
})();

/**
 * 模拟器实际注入的陀螺零偏真值（rad/s）：恒定零偏 + World 持有的随机游走状态。
 * 仅供仿真内诊断（NEES/误差分解）使用；真实数据没有这个量。
 */
export function trueGyroBiasRad(p: ImuParams, gyroWalkState?: V3): V3 {
  return [0, 1, 2].map(
    (i) => (p.gyroBiasDps * BIAS_DIR[i] + (gyroWalkState?.[i] ?? 0)) / 57.29578,
  ) as unknown as V3;
}

/**
 * 由真实姿态与角速度生成模拟 IMU 输出。
 * 加计约定：静止时输出 +g 沿机体系「下」方向（即重力在机体系的投影）。
 * gyroWalkState：陀螺零偏随机游走的累积状态（°/s，三轴），由 World 持有并在每步
 * 先推进再传入——walkDps=0 时完全不动、不消耗随机数，既有噪声序列逐位不变。
 */
/**
 * 加计**单点**链路：理想比力 → 非线性（按模长压缩，1g 处零偏移）→ 交叉轴混合（每轴混入
 * 另外两轴各 k）→ 白噪声。抽成独立函数的原因是**校准独立验证必须与生产模型逐位同构**：
 * 旧实现自己写了一份 `2k` 交叉轴 + 逐分量非线性的版本，验证的是另一颗虚构器件（复核反例）。
 */
export function accelChannel(
  accelBase: V3,
  p: Pick<ImuParams, "accelNonlin" | "accelCrossAxis" | "accelNoise">,
  gauss: Gauss,
): V3 {
  let bx = accelBase[0];
  let by = accelBase[1];
  let bz = accelBase[2];
  if (p.accelNonlin > 0) {
    const n = Math.hypot(bx, by, bz);
    const k = 1 - p.accelNonlin * (n / G_ACC - 1) * (n / G_ACC - 1);
    bx *= k;
    by *= k;
    bz *= k;
  }
  const k = p.accelCrossAxis;
  return [
    bx + k * (by + bz) + gauss.next() * p.accelNoise,
    by + k * (bx + bz) + gauss.next() * p.accelNoise,
    bz + k * (bx + by) + gauss.next() * p.accelNoise,
  ];
}

export function simulateImu(
  q: Quat,
  omegaTrue: V3,
  t: number,
  p: ImuParams,
  gauss: Gauss,
  accelFactor: number,
  gyroWalkState?: V3,
  /**
   * 磁力计独立随机流（可选）。为什么必须能分开：磁噪声/硬铁开关会改变磁链是否消耗随机数；
   * 若与陀螺/加计共用高斯流，同 seed 下“只打开磁干扰”会连带改变后续陀螺噪声序列，
   * A/B 与批量配对比较就不再是单变量。传入独立流后，磁链变化不影响陀螺/加计样本。
   */
  magGauss: Gauss = gauss,
  /**
   * 运动学一致模式的世界系平动加速度（可选）。给出时按下式生成比力投影：
   *   ã = Rᵀ(q)·g_world − Rᵀ(q)·a_world
   * 而不是叠加几条独立正弦——这样姿态、角速度、比力来自同一条物理轨迹。
   */
  accelWorld?: V3,
): ImuSample {
  const gBody = qRotInv(q, [0, 0, G_ACC]);

  const lin = p.linAccel * accelFactor;
  const vib = p.vibration;

  // 零偏 = 恒定零偏（固定方向，°/s）+ 随机游走（World 持有的三轴状态，°/s）→ 统一转 rad/s
  const biasRad = trueGyroBiasRad(p, gyroWalkState);

  const gyro: V3 = [
    omegaTrue[0] + biasRad[0] + gauss.next() * p.gyroNoiseDps / 57.29578,
    omegaTrue[1] + biasRad[1] + gauss.next() * p.gyroNoiseDps / 57.29578,
    omegaTrue[2] + biasRad[2] + gauss.next() * p.gyroNoiseDps / 57.29578,
  ];

  // 刻度因子误差 + 三轴非正交（安装失准）：作用于**真实角速度**，再叠加零偏与噪声。
  // 确定性矩阵（不适配随机数），各轴符号固定以便复现。这两项都是**速率相关**误差，
  // 与零偏（常数项）性质不同：6 维 ESKF 的零偏状态吸收不了它们。
  if (p.gyroScaleErr > 0 || p.gyroMisalign > 0) {
    const s = p.gyroScaleErr;
    const m = p.gyroMisalign;
    const M = [
      [1 + s, m * 0.6, -m * 0.4],
      [-m * 0.5, 1 - s * 0.6, m * 0.3],
      [m * 0.7, -m * 0.3, 1 + s * 0.3],
    ];
    const w0 = omegaTrue[0], w1 = omegaTrue[1], w2 = omegaTrue[2];
    for (let i = 0; i < 3; i++) {
      gyro[i] += M[i][0] * w0 + M[i][1] * w1 + M[i][2] * w2 - omegaTrue[i];
    }
  }
  // 满量程饱和：读数在 ±range 处被削平（真实器件输出即如此），
  // 积分器拿到一串「恒定最大速率」→ 姿态落后于真实机动且无法察觉
  let gyroSaturated = false;
  if (p.gyroRangeDps > 0) {
    const lim = p.gyroRangeDps / 57.29578;
    for (let i = 0; i < 3; i++) {
      const clamped = Math.max(-lim, Math.min(lim, gyro[i]));
      if (clamped !== gyro[i]) gyroSaturated = true;
      gyro[i] = clamped;
    }
  }

  // 加计确定性部分：重力投影 − 平动加速度投影 + 振动（运动学一致模式）；否则用旧的独立正弦扰动
  const aBody = accelWorld ? qRotInv(q, accelWorld) : null;
  const accelBase: V3 = [
    gBody[0] - (aBody?.[0] ?? 0)
      + (accelWorld
        ? 0
        : lin * Math.sin(2 * Math.PI * 0.9 * t + 1.1))
      + vib * 3.0 * Math.sin(2 * Math.PI * 31 * t),
    gBody[1] - (aBody?.[1] ?? 0)
      + (accelWorld
        ? 0
        : lin * Math.sin(2 * Math.PI * 0.7 * t + 2.3))
      + vib * 3.0 * Math.sin(2 * Math.PI * 28 * t + 1.0),
    gBody[2] - (aBody?.[2] ?? 0)
      + (accelWorld
        ? 0
        : lin * 0.4 * Math.sin(2 * Math.PI * 1.3 * t + 0.5))
      + vib * 1.8 * Math.sin(2 * Math.PI * 37 * t + 2.0),
  ];
  const accel = accelChannel(accelBase, p, gauss);

  const magSample = simulateMag(q, t, p, magGauss);
  return { gyro, accel, mag: magSample, ...(gyroSaturated ? { gyroSaturated: true } : {}) };
}

/**
 * 磁力计链路（独立函数，便于噪声序列守护测试）：
 * 世界磁场 → 机体系投影 → **软铁矩阵** → + 硬铁偏移 + 交变干扰 + 高斯噪声 + 可选量化。
 * 即 m_meas = S·B_body + b + d + n（软铁乘在真实场之前，与真机一致：导磁材料扭曲的是磁场本身）。
 * p 全零（magNoise=0, hardIron=0, disturbMag=0, magQuantUts=0, magSoftIron=0）时返回
 * 无噪声的理想投影，且与旧版逐位一致（g=0 时 S 严格等于单位阵）。
 */
export function simulateMag(
  q: Quat,
  t: number,
  p: Pick<ImuParams, "magNoise" | "hardIron" | "disturbMag" | "magQuantUts" | "magSoftIron">,
  gauss: Gauss,
): V3 {
  const mBody = qRotInv(q, MAG_WORLD_NED);
  const magOn =
    p.magNoise > 0 || p.hardIron > 0 || p.disturbMag > 0 || p.magQuantUts > 0 || p.magSoftIron > 0;
  if (!magOn) return mBody; // 理想磁力计：不消耗随机数（守护既有噪声序列）

  // 软铁：S = I + g·M。g=0 时逐项等于 mBody（乘法退化为 1×，浮点上一模一样）
  let s0 = mBody[0];
  let s1 = mBody[1];
  let s2 = mBody[2];
  if (p.magSoftIron > 0) {
    const g = p.magSoftIron;
    s0 = (1 + g * SOFT_IRON_M[0][0]) * mBody[0] + g * SOFT_IRON_M[0][1] * mBody[1] + g * SOFT_IRON_M[0][2] * mBody[2];
    s1 = g * SOFT_IRON_M[1][0] * mBody[0] + (1 + g * SOFT_IRON_M[1][1]) * mBody[1] + g * SOFT_IRON_M[1][2] * mBody[2];
    s2 = g * SOFT_IRON_M[2][0] * mBody[0] + g * SOFT_IRON_M[2][1] * mBody[1] + (1 + g * SOFT_IRON_M[2][2]) * mBody[2];
  }

  const hi = p.hardIron * 8; // 硬铁偏移量级：最多 ±8 μT
  const di = p.disturbMag * 25; // 交变干扰量级：最多 ±25 μT
  const quant = (v: number): number =>
    p.magQuantUts > 0 ? Math.round(v / p.magQuantUts) * p.magQuantUts : v; // 确定性取整（AK8963 = 0.6 μT/LSB）
  return [
    quant(s0 + hi * HARD_IRON_DIR[0] + di * Math.sin(2 * Math.PI * 2.1 * t + 0.7) + gauss.next() * p.magNoise),
    quant(s1 + hi * HARD_IRON_DIR[1] + di * Math.sin(2 * Math.PI * 1.7 * t + 2.2) + gauss.next() * p.magNoise),
    quant(s2 + hi * HARD_IRON_DIR[2] + gauss.next() * p.magNoise),
  ];
}
