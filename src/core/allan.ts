/**
 * Allan 方差（Allan deviation）：把「零偏稳定性」这个数据手册数字变成可读的曲线。
 *
 * 用途与口径：陀螺仪的误差不是单一白噪声——白噪声随平均时间下降，零偏随机游走却随
 * 平均时间上升，中间还有一段「闪烁噪声」不随 τ 变。Allan 偏差 σ(τ) 的 log-log 曲线
 * 把这三段画成 −½ / 0 / +½ 斜率，于是「这颗粒子适合平均多久」一眼可见。
 * 文档「控制项手册 · 传感器测量模型」里的演示图就是本模块算的。
 *
 * 为什么单独成模块：它是纯数值例程（与画布无关），值得被自检覆盖——
 * 本文件末尾的思路是：用已知 N/K 合成序列，再看算出来的曲线是否回到那三个系数。
 */

/** 合成一段陀螺静态数据：白噪声（ARW 系数 N）+ 速率随机游走（K），返回积分角序列 */
export function synthesizeGyroAngle(opts: {
  n: number;
  /** 采样频率（Hz） */
  fs: number;
  /** 角度随机游走系数 N（°/s/√Hz，数据手册里的「噪声密度」） */
  arw: number;
  /** 速率随机游走系数 K（°/s/√s） */
  rrw: number;
  /** 随机数发生器（注入以便自检复现） */
  rand: () => number;
}): { theta: Float64Array; dt: number } {
  const { n, fs, arw, rrw, rand } = opts;
  const dt = 1 / fs;
  const sigmaSample = arw * Math.sqrt(fs / 2); // 每个采样点的白噪声 σ（°/s）
  const theta = new Float64Array(n);
  let walk = 0;
  for (let i = 1; i < n; i++) {
    // Box–Muller（不依赖 core/rng，保持本模块零依赖）
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    const g1 = r * Math.cos(2 * Math.PI * v);
    const g2 = r * Math.sin(2 * Math.PI * v);
    walk += rrw * Math.sqrt(dt) * g2;
    theta[i] = theta[i - 1] + (walk + sigmaSample * g1) * dt;
  }
  return { theta, dt };
}

/**
 * 非重叠 Allan 偏差：σ(τ) = √( ½·⟨(θ_{k+2m} − 2θ_{k+m} + θ_k)²⟩ ) / τ，τ = m·dt。
 * @param mList 平均因子列表（τ = m·dt）；缺省按对数间隔自动取
 */
export function allanDeviation(
  theta: Float64Array,
  dt: number,
  mList?: number[],
): { taus: number[]; sigmas: number[] } {
  const n = theta.length;
  let ms = mList;
  if (!ms) {
    ms = [];
    for (let k = 0; k <= 18; k++) {
      const m = Math.round(Math.pow(2, k / 2));
      if (m >= 1 && 2 * m < n) ms.push(m);
    }
  }
  const taus: number[] = [];
  const sigmas: number[] = [];
  for (const m of ms) {
    if (m < 1 || 2 * m >= n) continue;
    let acc = 0;
    const cnt = n - 2 * m;
    for (let i = 0; i < cnt; i++) {
      const d = theta[i + 2 * m] - 2 * theta[i + m] + theta[i];
      acc += d * d;
    }
    const tau = m * dt;
    taus.push(tau);
    sigmas.push(Math.sqrt(acc / (2 * cnt)) / tau);
  }
  return { taus, sigmas };
}

/** 在 log-log 意义上对给定 τ 区间做最小二乘，返回斜率（用于读出「哪一段噪声主导」） */
export function allanSlope(taus: readonly number[], sigmas: readonly number[], from: number, to: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < taus.length; i++) {
    if (taus[i] >= from && taus[i] <= to) {
      xs.push(Math.log10(taus[i]));
      ys.push(Math.log10(sigmas[i]));
    }
  }
  if (xs.length < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den > 0 ? num / den : NaN;
}
