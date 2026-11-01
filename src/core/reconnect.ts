/**
 * 断线重连退避（纯逻辑，可在 Node 自检）。
 *
 * 异常断开后按 1s → 2s → 4s 退避，最多 N 次；用户主动断开必须**取消**且不能再接回来。
 * 这条状态机此前串口与 BLE 各写了一份，且 BLE 那份要读串口那份的 `enabled` 字段
 * （命名与归属都对不上，改动时极易只改一处）。
 *
 * 有界帧队列见 ./serial-queue.ts。
 */
export interface ReconnectPolicyOptions {
  /** 最多尝试几次（不含初次连接） */
  maxAttempts?: number;
  /** 首次退避（毫秒），之后每次翻倍 */
  baseDelayMs?: number;
  /** 是否允许自动重连（界面开关；由调用方注入，policy 不持有 UI 状态） */
  enabled?: () => boolean;
  /** 排程回调：调用方注入 setTimeout（便于测试） */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

/**
 * 重连退避状态机（串口与 BLE 各持一个实例，互不干扰）：
 *
 * ```
 * 异常断开 → onFailure() → 若还能重试：返回 { delayMs, attempt }（调用方排程）
 * 连接成功 → onSuccess() → 计数清零
 * 用户断开 → cancel()    → 计数清零且不再重连
 * ```
 */
export class ReconnectPolicy {
  private attempts = 0;
  private timer: unknown = null;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly enabled: () => boolean;
  private readonly schedule: (fn: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;

  constructor(opts: ReconnectPolicyOptions = {}) {
    this.maxAttempts = Math.max(0, Math.floor(opts.maxAttempts ?? 3));
    this.baseDelayMs = Math.max(0, opts.baseDelayMs ?? 1000);
    this.enabled = opts.enabled ?? (() => true);
    this.schedule =
      opts.schedule ??
      ((fn, delayMs) => setTimeout(fn, delayMs) as unknown);
    this.cancelScheduled =
      opts.cancelScheduled ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get attemptCount(): number {
    return this.attempts;
  }
  get pending(): boolean {
    return this.timer !== null;
  }

  /**
   * 记录一次失败并（若允许）排程下一次尝试。
   * @param retry 实际执行重连的函数
   * @returns 排程信息；返回 null 表示不再重试（关闭开关/次数用尽）
   */
  onFailure(retry: () => void): { attempt: number; delayMs: number; exhausted: boolean } | null {
    if (!this.enabled()) return null;
    if (this.attempts >= this.maxAttempts) {
      return { attempt: this.attempts, delayMs: 0, exhausted: true };
    }
    const attempt = ++this.attempts;
    const delayMs = this.baseDelayMs * 2 ** (attempt - 1);
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      retry();
    }, delayMs);
    return { attempt, delayMs, exhausted: false };
  }

  /** 连接成功：清零并取消挂起的排程 */
  onSuccess(): void {
    this.attempts = 0;
    this.clearTimer();
  }

  /** 用户主动断开/关闭开关：清零且不再重连 */
  cancel(): void {
    this.attempts = 0;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.cancelScheduled(this.timer);
      this.timer = null;
    }
  }
}
