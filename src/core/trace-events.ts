import type { Estimator } from "../estimators";

/** 拒绝帧数与恢复入口次数分开计量；同一恢复窗口不能每帧重复计一次事件。 */
export class TraceEvents {
  readonly alignTimes: number[] = [];
  readonly eventCounts: Record<string, number> = {};
  private modes = new Map<string, unknown>();

  align(t: number): void {
    this.alignTimes.push(t);
    this.eventCounts.align = (this.eventCounts.align ?? 0) + 1;
  }

  solve(estimators: readonly Estimator[]): void {
    for (const e of estimators) {
      const mode = e.telemetry.detail.gateMode;
      if (mode === 1) this.increment("gate-reject");
      if (mode === 2 && this.modes.get(e.id) !== 2) this.increment("gate-recovery");
      if (e.id === "kalman") {
        if (e.telemetry.detail.accelRejectCode) this.increment("kalman-accel-reject");
        if (e.telemetry.detail.magRejectCode) this.increment("kalman-mag-reject");
      }
      this.modes.set(e.id, mode);
    }
  }

  private increment(type: string): void {
    this.eventCounts[type] = (this.eventCounts[type] ?? 0) + 1;
  }
}
