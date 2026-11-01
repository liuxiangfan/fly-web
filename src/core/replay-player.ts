/**
 * 离线回放的**播放调度**（纯函数，可在 Node 自检）。
 *
 * 从 main.ts 抽出来的原因：回放「按录制时间 × 倍速消费帧」这件事有三条容易写错的规则，
 * 而它们之前只在浏览器里被间接验证：
 *  1. 每帧用**该帧自身的时间差**作为估计器的 dt（回放的意义就在于此，不能按墙钟步长积分）；
 *  2. 倍速 0 = 「最快」：一次性把剩余帧全部消费（上限保护见 `maxFramesPerTick`）；
 *  3. 时间倒退/重复时间戳要夹紧到 ≥0，不能产生负 dt。
 *
 * 播放器只负责「这一拍该消费哪几帧、每帧 dt 多少」，不碰 DOM、估计器和时钟。
 */
import type { ReplayFrame } from "./replay";
import { logIntervalSec } from "./serial";

export interface ReplayStep {
  frame: ReplayFrame;
  /**
   * 这一帧对应的时间间隔（秒）。**首帧恒为 0**：回放时第一帧是初值，前进多少时间
   * 由它与下一帧的差决定；这样 Σdt 恰好等于日志跨度（旧实现给首帧塞名义 5 ms，
   * 且用 `>>>0` 截断小数毫秒，1 s 的 400 Hz 日志只能积出 0.805 s）。
   */
  dtSec: number;
}

export interface ReplayPlayerOptions {
  /** 单拍最多消费多少帧（防止「最快」档在长日志上冻住主线程） */
  maxFramesPerTick?: number;
}

export class ReplayPlayer {
  private frames: ReplayFrame[] = [];
  /** 下一帧下标 */
  private index = 0;
  /** 已累积的「录制时间」（秒） */
  private budget = 0;
  private speed = 1;
  private readonly maxPerTick: number;

  constructor(opts: ReplayPlayerOptions = {}) {
    this.maxPerTick = Math.max(1, opts.maxFramesPerTick ?? 4000);
  }

  load(frames: ReplayFrame[], speed = 1): void {
    this.frames = frames;
    this.index = 0;
    this.budget = 0;
    this.speed = speed;
  }

  clear(): void {
    this.frames = [];
    this.index = 0;
    this.budget = 0;
  }

  setSpeed(speed: number): void {
    this.speed = Number.isFinite(speed) && speed >= 0 ? speed : 1;
  }

  get frameCount(): number {
    return this.frames.length;
  }
  get cursor(): number {
    return this.index;
  }
  get done(): boolean {
    return this.frames.length > 0 && this.index >= this.frames.length;
  }
  get loaded(): boolean {
    return this.frames.length > 0;
  }
  /** 已消费到的录制时间（秒，相对首帧） */
  get playedSec(): number {
    if (!this.frames.length) return 0;
    const k = Math.min(Math.max(this.index, 1), this.frames.length) - 1;
    return (this.frames[k].tMs - this.frames[0].tMs) / 1000;
  }
  /** 整段时长（秒） */
  get durationSec(): number {
    if (this.frames.length < 2) return 0;
    return (this.frames[this.frames.length - 1].tMs - this.frames[0].tMs) / 1000;
  }

  /**
   * 推进一拍（dtAnim 为动画帧时长，秒），返回本拍要消费的帧及其 dt。
   * 倍速 0 视为「不限预算」，但仍受 maxFramesPerTick 限制。
   */
  advance(dtAnimSec: number): ReplayStep[] {
    const n = this.frames.length;
    if (!n || this.index >= n) return [];
    // 负的动画帧间隔（时钟回拨/测试）不产生预算；倍速 0 → 无限预算
    const add = this.speed === 0 ? Number.POSITIVE_INFINITY : Math.max(0, dtAnimSec) * this.speed;
    this.budget += add;
    const out: ReplayStep[] = [];
    // 前驱时间戳：index>0 时是上一帧；index=0（或外部重置过索引）时无前驱 → 首帧 dt=0
    let prevMs = this.index > 0 ? (this.frames[this.index - 1] as ReplayFrame).tMs : NaN;
    while (this.index < n && out.length < this.maxPerTick) {
      const f = this.frames[this.index] as ReplayFrame;
      const dtSec = Number.isFinite(prevMs) ? logIntervalSec(prevMs as number, f.tMs) : 0;
      if (dtSec > this.budget) break;
      this.budget -= dtSec;
      this.index++;
      out.push({ frame: f, dtSec });
      prevMs = f.tMs; // 下一帧的前驱就是这一帧
    }
    // 预算无穷大时减完仍是 Infinity；正常情况也不允许累积成负
    if (!Number.isFinite(this.budget)) this.budget = Number.POSITIVE_INFINITY;
    else this.budget = Math.max(0, this.budget);
    return out;
  }
}
