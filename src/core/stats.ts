/**
 * 运行期误差统计（评测面板与自检共用，纯函数/纯数据，不碰 DOM）。
 *
 * 与曲线图的分工：曲线图回答「此刻/刚才发生了什么」，统计回答
 * 「这一轮跑下来谁更准、抖多大、多久收敛」。两者用同一份误差样本，
 * 避免 UI 里出现两套口径。
 */
export interface ErrorSummary {
  /** 样本数 */
  n: number;
  /** 最近一次误差（度） */
  last: number;
  /** 算术平均（度） */
  mean: number;
  /** 均方根误差 RMSE（度）——对大误差更敏感 */
  rmse: number;
  /** 本窗口最大误差（度） */
  max: number;
  /** 从 reset 起首次稳定低于阈值的时刻（秒，相对 reset）；未收敛为 null */
  convergedAt: number | null;
}

export interface ErrorTrackerOptions {
  /** 收敛判定阈值（度） */
  thresholdDeg?: number;
  /** 需连续低于阈值的时长（秒），抗单帧抖动 */
  holdSec?: number;
}

/**
 * 误差累加器。样本按 25 Hz 左右喂入即可；内部只在 add 时做常数时间更新，
 * summary 时才做除法——主循环里没有任何数组增长或遍历。
 */
export class ErrorTracker {
  private n = 0;
  private sum = 0;
  private sumSq = 0;
  private maxV = 0;
  private lastV = NaN;
  private belowSince: number | null = null;
  private convergedAt: number | null = null;
  private startT = 0;
  private readonly threshold: number;
  private readonly hold: number;

  constructor(opts: ErrorTrackerOptions = {}) {
    this.threshold = opts.thresholdDeg ?? 2;
    this.hold = opts.holdSec ?? 1;
  }

  reset(startT = 0): void {
    this.n = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.maxV = 0;
    this.lastV = NaN;
    this.belowSince = null;
    this.convergedAt = null;
    this.startT = startT;
  }

  /** 喂入一个误差样本（度）与当前时刻（秒） */
  add(errorDeg: number, t: number): void {
    if (!Number.isFinite(errorDeg)) return;
    const v = Math.max(0, errorDeg);
    this.n++;
    this.sum += v;
    this.sumSq += v * v;
    if (v > this.maxV) this.maxV = v;
    this.lastV = v;
    // 收敛判定：连续 hold 秒位于阈值内；一旦超阈就重新计时（避免把暂态算作收敛）
    if (this.convergedAt === null) {
      if (v <= this.threshold) {
        if (this.belowSince === null) this.belowSince = t;
        if (t - this.belowSince >= this.hold) this.convergedAt = this.belowSince - this.startT;
      } else {
        this.belowSince = null;
      }
    }
  }

  summary(): ErrorSummary {
    const n = this.n;
    return {
      n,
      last: this.lastV,
      mean: n > 0 ? this.sum / n : NaN,
      rmse: n > 0 ? Math.sqrt(this.sumSq / n) : NaN,
      max: n > 0 ? this.maxV : NaN,
      convergedAt: this.convergedAt,
    };
  }
}

/** 一组数值的均方根（自检/诊断脚本用） */
export function rms(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let acc = 0;
  for (const v of values) acc += v * v;
  return Math.sqrt(acc / values.length);
}

/** 百分位数（线性插值，输入会被复制排序；自检/校准用） */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
