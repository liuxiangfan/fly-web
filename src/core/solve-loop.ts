/**
 * 解算调度与静止粗对准（UI 与 runner/Worker 共用的唯一实现）。
 *
 * 为什么要有这个文件：界面主循环与无 DOM 运行内核此前各写了一份「解算抽帧 + 静止检测 +
 * 粗对准 + A/B 同步重置」的调度逻辑。两份实现即使当时数值相同，也会**各自漂移**——
 * 而第五轮复核已经证明「看起来一样」并不等于一样（粗对准的先后顺序、冷却时长、
 * 判据取哪些估计器，任何一处差异都会让批量的结论无法代表界面）。
 *
 * 本类只管**估计器侧的调度**，不碰世界与 DOM：
 *  - 解算抽帧：仿真路径按 `solveRateHz` 累积 dt（1/f 秒才更新一次估计器）；
 *  - 真实/回放路径：`applyFrame` 每帧更新一次，超过 `maxSubstep` 的间隔拆子步；
 *  - 静止粗对准：|ω| < 3°/s 持续 3 s、偏差 > 8°、冷却 5 s（与界面完全同一套阈值），
 *    触发时把**非纯积分**的主组与 B 组一起摆回「加计+磁」观测姿态；
 *  - 校准链由调用方注入：界面注入读实时状态实现，runner 注入读配置对象的实现。
 *
 * 调用顺序（与界面一致，历史上 runner 曾把对准放在解算之前）：**先解算、后静止检测**。
 * 这样对准用的是「本帧更新之后」的遥测，界面与 runner 才不会差一帧。
 */
import type { Estimator } from "../estimators";
import { coarseAlign } from "../estimators";
import type { ImuSample } from "./imu";
import { DEG, type Quat, type V3 } from "./quat";

/** 校准链：把原始读数变成算法真正吃到的读数 */
export interface CalibrationChain {
  mag(raw: V3): V3;
  accel(raw: V3): V3;
}

export interface SolveContext {
  /** 本次解算使用的步长（秒） */
  dt: number;
  /** 本帧原始采样（界面用它推进 INS：位置积分要三轴原始读数） */
  sample: ImuSample;
  /** 校准后的观测（指标、INS、遥测都用这一份） */
  accel: V3;
  mag: V3;
  /** 仿真/数据时钟（秒） */
  t: number;
  /** 本帧是否发生了静止粗对准 */
  aligned: boolean;
}

/** 一拍没做完的帧：剩余时长与时间游标（下次 applyFrame 继续补） */
interface PendingFrame {
  sample: ImuSample;
  remaining: number;
  /** 已经积分到的时刻（下一个子步的结束时刻 = cursor + step） */
  cursor: number;
  /** 本帧的原始终止时刻（仅诊断用） */
  tEnd: number;
}

export interface AlignEvent {
  q: Quat;
  maxErrDeg: number;
  t: number;
}

export interface SolveLoopOptions {
  /** 主组（界面 A 组 / runner 唯一一组） */
  estimators: Estimator[];
  /** 次级组（界面 B 组克隆）：与主组吃同一份数据、同步 reset，但参数独立 */
  secondary?: Estimator[];
  /** 解算频率；<=0 或非有限值表示「每帧解算」（真实/回放路径） */
  solveRateHz: number;
  calibrate: CalibrationChain;
  /** 粗对准是否用磁（界面读「启用磁力计」开关；runner 读 comp.magEnabled） */
  magEnabled: boolean;
  autoCoarseAlign: boolean;
  /** 静止阈值（秒）：默认 3 s */
  stillSec?: number;
  /** 触发对准的偏差门限（度）：默认 8° */
  alignErrorDeg?: number;
  /** 两次对准之间的冷却（秒）：默认 5 s */
  alignCooldownSec?: number;
  /** 每次估计器更新之后的回调（INS 积分、指标累计、遥测） */
  onSolve?: (ctx: SolveContext) => void;
  /** 粗对准触发时的回调（界面用来弹提示条） */
  onAlign?: (ev: AlignEvent) => void;
}

export class SolveLoop {
  private readonly primary: Estimator[];
  private secondary: Estimator[];
  private solveRateHz: number;
  private calibrate: CalibrationChain;
  private magEnabled: boolean;
  autoCoarseAlign: boolean;
  private readonly stillSec: number;
  private readonly alignErrorDeg: number;
  private readonly alignCooldownSec: number;
  private onSolve?: (ctx: SolveContext) => void;
  private onAlign?: (ev: AlignEvent) => void;

  /** 抽帧累积器（判断该不该解算；减去周期保留余量，使长期平均频率等于所选值） */
  private solveAcc = 0;
  /** 自上次解算以来**真实经过**的时间（估计器的 dt；与累积器分开，否则余量会被重复计入） */
  private tSinceSolve = 0;
  /** 连续静止时长（秒） */
  private stillSeconds = 0;
  /** 上次粗对准的时刻（秒）；-1e9 表示从未 */
  private lastAlignT = -1e9;
  /** 最近一次粗对准事件（界面提示条与自动化断言用） */
  lastAlign: AlignEvent | null = null;

  constructor(opts: SolveLoopOptions) {
    this.primary = opts.estimators;
    this.secondary = opts.secondary ?? [];
    this.solveRateHz = opts.solveRateHz;
    this.calibrate = opts.calibrate;
    this.magEnabled = opts.magEnabled;
    this.autoCoarseAlign = opts.autoCoarseAlign;
    this.stillSec = opts.stillSec ?? 3;
    this.alignErrorDeg = opts.alignErrorDeg ?? 8;
    this.alignCooldownSec = opts.alignCooldownSec ?? 5;
    this.onSolve = opts.onSolve;
    this.onAlign = opts.onAlign;
  }

  /** 复位调度状态（不 reset 估计器：初值由调用方决定，A/B 需要同步） */
  reset(): void {
    this.solveAcc = 0;
    this.tSinceSolve = 0;
    this.stillSeconds = 0;
    this.lastAlignT = -1e9;
    this.lastAlign = null;
    // 未积分队列属于「上一轮」：必须一起清，否则上一轮的时间会漏进新轮（ROUND12）
    this.pendingQueue.length = 0;
    this.coalescedDropped = 0;
  }

  /** 运行期改解算频率（界面下拉可改） */
  setSolveRate(hz: number): void {
    this.solveRateHz = hz;
  }

  /** 运行期替换 B 组（界面开关 A/B、快照、分叉都用它） */
  setSecondary(estimators: Estimator[]): void {
    this.secondary = estimators;
  }

  /** 运行期改校准链（界面的校准状态是活的；runner 一般不需要） */
  setCalibration(chain: CalibrationChain): void {
    this.calibrate = chain;
  }

  /** 运行期改磁开关（粗对准是否需要磁观测） */
  setMagEnabled(on: boolean): void {
    this.magEnabled = on;
  }

  /** 运行期改回调（界面在文档演示等场景会临时换掉） */
  setHooks(hooks: { onSolve?: (ctx: SolveContext) => void; onAlign?: (ev: AlignEvent) => void }): void {
    if (hooks.onSolve) this.onSolve = hooks.onSolve;
    if (hooks.onAlign) this.onAlign = hooks.onAlign;
  }

  /** 估计器组（只读引用） */
  get primaryGroup(): readonly Estimator[] {
    return this.primary;
  }
  get secondaryGroup(): readonly Estimator[] {
    return this.secondary;
  }

  /**
   * 仿真路径：推进一个仿真步。按解算率抽帧；**每个仿真步**都做静止检测。
   * @returns 本步是否跑了估计器更新
   */
  step(sample: ImuSample, h: number, t: number): boolean {
    const step = this.solveRateHz > 0 && Number.isFinite(this.solveRateHz) ? 1 / this.solveRateHz : h;
    this.solveAcc += h;
    this.tSinceSolve += h;
    let solved = false;
    let dt = 0;
    let accel: V3 | null = null;
    let mag: V3 | null = null;
    if (this.solveAcc + 1e-12 >= step) {
      // 两个量必须分开：
      //  · dt = 自上次解算以来**真实经过**的时间（估计器按它积分；Σdt 必须等于总时长）；
      //  · solveAcc 只负责排程，减一个周期并**保留余量**，否则 200 Hz 在 500 Hz 仿真下
      //    会退化成「每 3 步一次」= 166.7 Hz（自检实测 250 步只解算 83 次），
      //    而下拉框写着 200 Hz——比较不同解算频率的实验会得出错误结论。
      dt = this.tSinceSolve;
      this.tSinceSolve = 0;
      this.solveAcc = Math.max(0, this.solveAcc - step);
      const obs = this.updateEstimators(sample, dt);
      accel = obs.accel;
      mag = obs.mag;
      solved = true;
    }
    // 顺序：先解算、后静止检测（与界面一致；runner 历史上曾反过来，会差一帧遥测）
    const aligned = this.checkStillness(sample, h, t);
    // 对准事件只在这里发一次：checkStillness 不再自己发（复核 P2-3：一次 reset 曾触发两次 onAlign）
    if (aligned) this.onAlign?.(this.lastAlign as AlignEvent);
    if (solved && accel && mag) {
      this.onSolve?.({ dt, sample, accel, mag, t, aligned });
    }
    return solved;
  }

  /**
   * 真实数据路径：把本帧的间隔拆成 **≤maxSubstep** 的子步，**逐子步即时更新并立即回调**。
   * 静止检测按整帧间隔累计一次（与界面一致）。
   *
   * 四条契约（ROUND11 复核修正；旧实现违反第 1/3/4 条）：
   *  1. **即时回调**：每个子步更新完就调用 onSolve，消费者（INS/遥测/统计）读到的 live 状态
   *     就是该子步的状态。旧实现先把所有子步更新完、再批量回调，于是读 live 四元数的 INS
   *     把**末姿态**重复用于之前的每个子步：1 s 拆 20 步时东向位置 3.925 m，而逐子步正确值是
   *     1.556 m（终态姿态却相差 0°，所以只比末态发现不了）。
   *  2. **0 dt 不积分**：dt ≤ 0 或非有限 → 直接返回（回放首帧就是这种「初值帧」）。
   *     旧实现在 0 dt 下仍调用估计器，互补滤波的 correction 会算出 NaN。
   *  3. **子步长度永不因数量上限而变大**：上限只限制「这一拍做多少子步」，超出部分
   *     记入 `deferredSec` 并**如实上报**，绝不把 50 ms 的安全步长悄悄放大到 250 ms
   *     （复核实测 1000 s 空洞 → dt=0.25 s，Madgwick 终姿态差 23.3°、Kalman 差 60.9°）。
   *  4. **对齐事件独立**：静止粗对准发生在帧末，事件只发一次（onAlign + lastAlign），
   *     不把 aligned 追溯标到前面的子步上（旧实现会标到末子步，前面的子步却已用旧姿态）。
   */
  applyFrame(sample: ImuSample, dtSec: number, t: number, maxSubstep = 0.05, maxSubsteps = 4000): void {
    const sub = Number.isFinite(maxSubstep) && maxSubstep > 0 ? maxSubstep : 0.05;
    const cap = Number.isFinite(maxSubsteps) && maxSubsteps > 0 ? Math.max(1, Math.floor(maxSubsteps)) : 4000;
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    if (dt > 0) {
      // 入队：本帧从头开始积分，时间游标从 t-dt 出发
      if (this.pendingQueue.length >= SolveLoop.PENDING_MAX) {
        this.pendingQueue.shift(); // 丢最旧：它离当前时刻最远，且一定会被计数上报
        this.coalescedDropped++;
      }
      this.pendingQueue.push({ sample, remaining: dt, cursor: t - dt, tEnd: t });
    }
    // **FIFO 消费**：先补上一拍没做完的（顺序优先，后到的帧绝不超车）
    let budget = cap;
    while (this.pendingQueue.length && budget > 0) {
      const item = this.pendingQueue[0] as PendingFrame;
      // 本拍只积分 min(剩余, 预算×子步上限) —— 子步因此恒 ≤ sub，绝不放大安全步长
      const integrate = Math.min(item.remaining, budget * sub);
      const n = Math.min(budget, Math.max(1, Math.ceil(integrate / sub)));
      const step = integrate / n;
      const finishes = item.remaining - integrate <= 1e-12; // 本拍把这一帧做完
      for (let i = 0; i < n; i++) {
        const obs = this.updateEstimators(item.sample, step);
        item.cursor += step;
        this.onSolve?.({
          dt: step,
          sample: item.sample,
          accel: obs.accel,
          mag: obs.mag,
          // 最后一个子步对齐到帧的**原始时刻**：避免浮点累积把终态时间推后 1 ulp
          t: finishes && i === n - 1 ? item.tEnd : item.cursor,
          aligned: false,
        });
      }
      item.remaining -= integrate;
      budget -= n;
      if (item.remaining <= 1e-12) this.pendingQueue.shift();
    }
    // 顺序与 step() 一致：先解算、后静止检测；对准事件只发一次
    const aligned = this.checkStillness(sample, dt, t);
    if (aligned) this.onAlign?.(this.lastAlign as AlignEvent);
  }

  /**
   * 未积分的后续帧队列（**真正分拍**）。
   *
   * ROUND11 的第一版实现只把超限时间记进一个计数器就不再处理：300 s 的回放日志
   * 只积分了 200 s，界面却显示“回放完成”，也没有任何提示（ROUND12 实测）。
   * 现在改成 FIFO：单拍最多积分 `maxSubsteps` 个子步（每个 ≤maxSubstep），
   * 余下的留在队列里，**下一拍的 applyFrame 会先把它补完再处理新帧**——
   * 时间既不丢，也不会把安全步长放大成 250 ms。队列有上限（超出丢弃并计数，
   * 供界面/报告显示），避免病态输入把内存吃光。
   */
  private pendingQueue: PendingFrame[] = [];
  /** 队列上限：超过就丢最新的（并计数），防止无界增长 */
  private static readonly PENDING_MAX = 8;
  /** 因队列上限被丢弃的帧数（>0 说明数据真的没积上，必须显示出来） */
  private coalescedDropped = 0;

  /** 尚未积分的秒数（界面用它显示“待积分 x.x s”，>0 时不能宣称回放完成） */
  get pendingSec(): number {
    let sum = 0;
    for (const p of this.pendingQueue) sum += p.remaining;
    return sum;
  }
  /** 因队列上限被丢弃的帧数 */
  get droppedFrames(): number {
    return this.coalescedDropped;
  }

  /** 校准后观测（供界面在解算之外读取，例如真实模式的读数显示） */
  observations(sample: ImuSample): { accel: V3; mag: V3 } {
    return { accel: this.calibrate.accel(sample.accel), mag: this.calibrate.mag(sample.mag) };
  }

  private updateEstimators(sample: ImuSample, dt: number): { accel: V3; mag: V3 } {
    const mag = this.calibrate.mag(sample.mag);
    const accel = this.calibrate.accel(sample.accel);
    for (const e of this.primary) e.update(sample.gyro, accel, mag, dt);
    for (const c of this.secondary) c.update(sample.gyro, accel, mag, dt);
    return { accel, mag };
  }

  /**
   * 静止粗对准：静止够久 + 融合类算法明显偏离观测 + 冷却已过 → 一起摆回观测姿态。
   * @returns 本次是否触发
   */
  private checkStillness(sample: ImuSample, dt: number, t: number): boolean {
    if (!this.autoCoarseAlign) return false;
    const wDps = Math.hypot(sample.gyro[0], sample.gyro[1], sample.gyro[2]) * DEG;
    this.stillSeconds = wDps < 3 ? this.stillSeconds + dt : 0;
    if (this.stillSeconds < this.stillSec || t - this.lastAlignT <= this.alignCooldownSec) return false;
    let maxErr = 0;
    for (const e of [...this.primary, ...this.secondary]) {
      if (e.id === "pure") continue; // 纯积分没有观测通道，不参与对准（保留作漂移对照）
      maxErr = Math.max(maxErr, Number(e.telemetry.detail.alignErrorDeg ?? 0) || 0);
    }
    if (maxErr <= this.alignErrorDeg) return false; // 收敛良好：不重置，避免抹掉已学到的零偏
    const { accel, mag } = this.observations(sample);
    const q = coarseAlign(accel, mag, this.magEnabled);
    for (const e of this.primary) if (e.id !== "pure") e.reset(q);
    for (const c of this.secondary) c.reset(q);
    this.lastAlignT = t;
    const ev: AlignEvent = { q: { ...q }, maxErrDeg: maxErr, t };
    this.lastAlign = ev;
    return true;
  }
}
