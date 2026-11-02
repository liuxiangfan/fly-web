/**
 * 回放外部真值的**逐子步时间轨**。
 *
 * 离线日志的相邻两帧之间可能隔着几秒；回放会把长间隔拆成 ≤50 ms 的子步。
 * 若在帧入队时就把 `state.externalTruth` 设成**帧末真值**，长间隔前半段的每个子步
 * 都会用几秒后的姿态算误差——实测 10 s 日志在 t=0.05 s 报出 89.55° 的假误差，
 * 真值角速度差分与真值波形也一起失真（复核反例）。
 *
 * 这个类只做一件事：把「上一帧终点真值 → 当前帧终点真值」按时刻 slerp，
 * 让误差、波形与差分角速度共用同一条与解算子步一致的时间轴。
 */
import { qSlerp, type Quat } from "./quat";

export class TruthTrack {
  private prevT = NaN;
  private prevQ: Quat | null = null;
  private nextT = NaN;
  private nextQ: Quat | null = null;
  private pendingT = NaN;
  private pendingQ: Quat | null = null;

  reset(): void {
    this.prevT = NaN;
    this.prevQ = null;
    this.nextT = NaN;
    this.nextQ = null;
    this.pendingT = NaN;
    this.pendingQ = null;
  }

  /** 新源帧入队：登记该帧**终点**时刻与真值（可在同一帧的多拍里重复调用）。 */
  push(tEndSec: number, q: Quat | null): void {
    this.nextT = tEndSec;
    this.nextQ = q ? { ...q } : null;
    this.pendingT = tEndSec;
    this.pendingQ = q ? { ...q } : null;
  }

  /** 源帧处理完成：终点值提升为下一帧的起点（真值插值左端点）。 */
  commit(): void {
    this.prevT = this.pendingT;
    this.prevQ = this.pendingQ;
  }

  /**
   * `t` 时刻的真值姿态（秒，相对首帧）。
   * 没有真值列时返回 null（调用方回退到 Mahony 基准）；
   * 只有终点真值时返回终点值（首帧/单点真值）。
   */
  at(t: number): Quat | null {
    if (!this.nextQ) return null;
    if (!this.prevQ) return { ...this.nextQ };
    const span = this.nextT - this.prevT;
    // 时间跨度非正（重复时间戳）时没有可插值区间：用终点值，绝不外推出错误姿态。
    const a = span > 1e-9 ? Math.min(1, Math.max(0, (t - this.prevT) / span)) : 1;
    return qSlerp(this.prevQ, this.nextQ, a);
  }
}
