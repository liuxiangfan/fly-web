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
import { monotonicTimelineMs, type ReplayFrame } from "./replay";

export interface ReplayStep {
  frame: ReplayFrame;
  /**
   * 这一帧对应的时间间隔（秒）。**首帧恒为 0**：回放时第一帧是初值，前进多少时间
   * 由它与下一帧的差决定；这样 Σdt 恰好等于日志跨度（旧实现给首帧塞名义 5 ms，
   * 且用 `>>>0` 截断小数毫秒，1 s 的 400 Hz 日志只能积出 0.805 s）。
   */
  dtSec: number;
}

export interface ReplayWork extends ReplayStep {
  /** 首次交付才入解算队列；续拍只drain，不再制造源帧 */
  first: boolean;
  remainingSec: number;
  budgetSec: number;
  /** 相对首帧的实处理终止时刻 */
  tSec: number;
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
  private work: { step: ReplayStep; remaining: number; first: boolean } | null = null;
  private workPlayed = 0;
  private workMode = false;
  /**
   * 有效时间轴（秒，相对首帧）：`timelineSec[i] = Σ logIntervalSec(相邻帧)`。
   *
   * 不能直接用 `tMs[i] - tMs[0]`：日志允许少量时间回退（见 replay.ts），而积分时回退段
   * 被夹成 0，若时长仍按「末帧 − 首帧」算，就会出现 played > duration（实测 0.22 s vs
   * 0.18 s），进度条、状态条和实际积分各说各话。时长/进度/每帧 dt 必须共用这一条轴。
   */
  private timelineSec: number[] = [];

  constructor(opts: ReplayPlayerOptions = {}) {
    // 上限参数本身也要合法：NaN 会让 while 条件永远为假（一帧都不消费），
    // Infinity 等于没有上限。非有限/非正数一律回落到默认值，并向下取整。
    const raw = opts.maxFramesPerTick ?? 4000;
    this.maxPerTick = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4000;
  }

  private rebuildTimeline(): void {
    const n = this.frames.length;
    // 有效时间轴 = 运行最大值（单调不降），与解析器的时长提示共用同一份纯函数实现：
    // 时间列允许少量回退（见 replay.ts 的容忍策略），但**回退段不能再积分一次**。
    // 旧实现把负间隔夹成 0、却仍从回退后的时间继续累计，于是 200→150→210 会把
    // 已被 150..200 覆盖的 50 ms 再积一遍（0.40 s 的日志积出 0.44 s）。
    const mono = monotonicTimelineMs(this.frames.map((f) => f.tMs));
    const out = new Array<number>(n);
    const base = n > 0 ? mono[0]! : 0;
    for (let i = 0; i < n; i++) out[i] = (mono[i]! - base) / 1000;
    this.timelineSec = out;
  }

  load(frames: ReplayFrame[], speed = 1): void {
    this.frames = frames;
    this.rebuildTimeline();
    this.setSpeed(speed);
    this.rewind();
  }

  clear(): void {
    this.frames = [];
    this.rebuildTimeline();
    this.rewind();
  }

  /** 清掉待处理/墙钟预算，但保留日志和倍速；reset后从首帧重播。 */
  rewind(): void {
    this.index = 0;
    this.budget = 0;
    this.work = null;
    this.workPlayed = 0;
    this.workMode = false;
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
  /** 已消费到的录制时间（秒，相对首帧；与每帧 dt 同一条有效时间轴） */
  get playedSec(): number {
    if (this.workMode) return this.workPlayed;
    if (!this.frames.length) return 0;
    const k = Math.min(Math.max(this.index, 1), this.frames.length) - 1;
    return this.timelineSec[k] ?? 0;
  }
  /** 整段时长（秒）= 逐帧正间隔之和（时间列有回退时不再与积分口径打架） */
  get durationSec(): number {
    if (this.frames.length < 2) return 0;
    return this.timelineSec[this.timelineSec.length - 1] ?? 0;
  }

  /** 已交付但尚未处理的秒数（不含还没到播放时刻的后续帧）。 */
  get pendingSec(): number { return this.work?.remaining ?? 0; }

  /**
   * 带背压的生产入口。consume返回实际积分秒数；null表示拒绝接收。
   * 游标只在该源帧处理完后推进，played随实际子步推进；最多持一帧，不拷贝日志队列。
   * 同一个load期间不要混用本接口和旧advance（旧接口保留其历史即刻消费语义）。
   */
  advanceWork(dtAnimSec: number, consume: (work: ReplayWork) => number | null, maxWorkSec = 5): void {
    if (!this.loaded || this.done) return;
    if (!this.workMode) { this.workPlayed = this.playedSec; this.workMode = true; }
    // 「最快」只作用于本拍：绝不把 Infinity 写进持久预算，否则切回有限倍速后
    // 即使墙钟 dt=0 也会一路狂飙（复核反例：0.9 s 内把剩余日志全播完）。
    const unlimited = this.speed === 0;
    if (!unlimited) this.budget += Math.max(0, Number.isFinite(dtAnimSec) ? dtAnimSec : 0) * this.speed;
    let remainingBudget = Number.isFinite(maxWorkSec) && maxWorkSec >= 0 ? maxWorkSec : 5;
    let completed = 0;
    while (this.index < this.frames.length && completed < this.maxPerTick) {
      if (!this.work) {
        const frame = this.frames[this.index] as ReplayFrame;
        const dtSec = this.index > 0
          ? (this.timelineSec[this.index] ?? 0) - (this.timelineSec[this.index - 1] ?? 0)
          : 0;
        if (!unlimited && dtSec > this.budget + 1e-12) break;
        this.work = { step: { frame, dtSec }, remaining: dtSec, first: true };
        if (!unlimited) this.budget = Math.max(0, this.budget - dtSec);
      }
      const item = this.work;
      if (item.remaining > 1e-12 && remainingBudget <= 1e-12) break;
      const processed = consume({ ...item.step, first: item.first, remainingSec: item.remaining,
        budgetSec: remainingBudget, tSec: this.workPlayed + item.remaining });
      if (processed === null) break;
      if (!Number.isFinite(processed) || processed < 0 || processed > item.remaining + 1e-8 || processed > remainingBudget + 1e-8) {
        throw new Error("回放工作回执超出实际帧/单拍预算");
      }
      item.first = false;
      item.remaining = Math.max(0, item.remaining - processed);
      this.workPlayed += processed;
      remainingBudget = Math.max(0, remainingBudget - processed);
      if (item.remaining <= 1e-9) { this.work = null; this.index++; completed++; }
      else break; // 本拍消费者预算耗尽，下一拍续处理同一帧
    }
  }

  /**
   * 推进一拍（dtAnim 为动画帧时长，秒），返回本拍要消费的帧及其 dt。
   * 倍速 0 视为「不限预算」，但仍受 maxFramesPerTick 限制。
   *
   * 这是历史接口（自检在用）。生产路径用 advanceWork；同一段日志**不允许**先 advanceWork
   * 再 advance——游标/进度/待处理帧属于两套状态机，混用会得到互相矛盾的结果。
   */
  advance(dtAnimSec: number): ReplayStep[] {
    if (this.workMode) throw new Error("同一段回放不能混用 advanceWork 与 advance（请统一用 advanceWork）");
    const n = this.frames.length;
    if (!n || this.index >= n) return [];
    // 负的动画帧间隔（时钟回拨/测试）不产生预算；倍速 0 → 本拍无限预算（不写回 budget）
    const unlimited = this.speed === 0;
    if (!unlimited) this.budget += Math.max(0, Number.isFinite(dtAnimSec) ? dtAnimSec : 0) * this.speed;
    const out: ReplayStep[] = [];
    while (this.index < n && out.length < this.maxPerTick) {
      const f = this.frames[this.index] as ReplayFrame;
      // 首帧（或外部重置过索引）无前驱 → dt=0；其余帧走同一条有效时间轴
      const dtSec = this.index > 0
        ? (this.timelineSec[this.index] ?? 0) - (this.timelineSec[this.index - 1] ?? 0)
        : 0;
      if (!unlimited && dtSec > this.budget) break;
      if (!unlimited) this.budget -= dtSec;
      this.index++;
      out.push({ frame: f, dtSec });
    }
    if (!Number.isFinite(this.budget)) this.budget = 0;
    else this.budget = Math.max(0, this.budget);
    return out;
  }
}
