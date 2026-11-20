export interface ReconnectPlan {
  attempt: number;
  delayMs: number;
  exhausted: boolean;
}

/** 串口/BLE 共用的重连编排；传输差异只由调用方注入，不复制状态分支。 */
export function scheduleReconnect(
  canRetry: boolean,
  onFailure: () => ReconnectPlan | null,
  onGap: () => void,
  onAbandon: () => void,
  onExhausted: () => void,
  onPlan: (plan: ReconnectPlan) => void,
): void {
  onGap();
  if (!canRetry) return;
  const plan = onFailure();
  if (!plan) return onAbandon();
  if (plan.exhausted) return onExhausted();
  onPlan(plan);
}

/** 传输事件汇的最小结构：由诊断 API 直接满足，核心不反向依赖 UI 模块。 */
export interface ReconnectEventSink {
  dataGap(active: boolean, reason?: string): void;
  dataReconnect(status: "attempt" | "success" | "exhausted", detail?: Record<string, unknown>): void;
}

/** 串口/BLE 的完整重连话术与事件：两处只差传输名、上限与放弃提示，不再各写一份。 */
export function scheduleTransportReconnect(
  sink: ReconnectEventSink | null,
  transport: "serial" | "ble",
  reason: string,
  max: number,
  exhaustedHint: string,
  canRetry: boolean,
  onFailure: () => ReconnectPlan | null,
  onReconnecting: () => void,
  onAbandon: () => void,
  status: (text: string, isError: boolean) => void,
): void {
  scheduleReconnect(
    canRetry,
    onFailure,
    () => sink?.dataGap(true, reason),
    onAbandon,
    () => {
      sink?.dataReconnect("exhausted", { transport, max });
      status(`${reason}——自动重连 ${max} 次仍失败，${exhaustedHint}`, true);
      onAbandon();
    },
    (plan) => {
      sink?.dataReconnect("attempt", { transport, attempt: plan.attempt, max, delayMs: plan.delayMs });
      onReconnecting();
      status(`${reason}——${(plan.delayMs / 1000).toFixed(0)} s 后自动重连（第 ${plan.attempt}/${max} 次）…`, true);
    },
  );
}
