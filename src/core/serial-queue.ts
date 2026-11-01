/**
 * 有界帧队列（纯逻辑）：真实 IMU 每秒几百帧，页面被挂起后会一次性涌入大量旧帧。
 * 旧帧对实时显示没有价值，只保留最新的 `max` 帧并计数丢弃。
 *
 * 这条策略此前在串口二进制与 MAVLink 两个入口各写了一遍——一处改了另一处不会跟着改。
 */
export interface BoundedPush {
  /** 是否因为超限丢掉了最旧的一帧 */
  dropped: boolean;
}

/** 入队并维持上限：超限时丢最旧（FIFO 另一端） */
export function pushBounded<T>(queue: T[], item: T, max: number): BoundedPush {
  queue.push(item);
  if (queue.length > max) {
    queue.shift();
    return { dropped: true };
  }
  return { dropped: false };
}
