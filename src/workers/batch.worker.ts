/**
 * 批量评测 Worker：把「N 个种子 × 每种算法」的重复计算搬出主线程。
 *
 * 为什么需要：一次 30 种子 × 30 s 的评测在主线程上会分片执行，期间仍然要挤占渲染与交互
 * （曲线卡顿、面板刷新延迟）。搬进 Worker 后主线程只更新进度条，评测期间页面保持可用。
 *
 * 与主线程路径的关系：**同一条数值内核**（都 import core/runner）。主线程负责生成种子序列
 * 并传进来，Worker 只负责跑与回传指标——两条路径共享 `summarizeMetricsLists` 的聚合口径，
 * 所以「用不用 Worker」不影响结果，只影响卡不卡。
 *
 * 协议要点（见 core/batch-protocol.ts）：每条消息都带 `jobId`；支持 `cancel`；
 * 每约 2 s 发一次心跳，让主线程能把「还在跑」与「没响应」分开。
 */
import { runExperiment, type EstimatorRunMetrics } from "../core/runner";
import type { BatchRequest, BatchResponse } from "../core/batch-protocol";

const HEARTBEAT_MS = 2000;

const post = (msg: BatchResponse): void => {
  (self as unknown as { postMessage: (m: BatchResponse) => void }).postMessage(msg);
};

/** 已被取消的 jobId 集合：取消消息到达时正在跑的那个任务会在下一个种子结束后退出 */
const cancelled = new Set<number>();
let runningJobId = 0;

self.onmessage = (ev: MessageEvent<BatchRequest>): void => {
  const req = ev.data;
  if (!req) return;
  if (req.type === "cancel") {
    cancelled.add(req.jobId);
    return;
  }
  if (req.type !== "start") return;

  const { jobId, config, seeds } = req;
  runningJobId = jobId;
  const t0 = Date.now();
  let lastBeat = t0;
  const metricsList: EstimatorRunMetrics[][] = [];
  try {
    for (let i = 0; i < seeds.length; i++) {
      if (cancelled.has(jobId)) {
        cancelled.delete(jobId);
        post({ type: "cancelled", jobId, done: metricsList.length, total: seeds.length });
        return;
      }
      // 每个种子内部也要让主线程看到「还在跑」：0.5 s 一次进度回调，
      // 顺带检查是否已取消（此前的实现要等当前 10–30 s 的种子跑完才轮询一次）。
      const run = runExperiment({ ...config, seed: seeds[i] }, {
        progressEverySec: 0.5,
        onProgress: () => {
          if (cancelled.has(jobId)) return false;
          const now = Date.now();
          if (now - lastBeat >= HEARTBEAT_MS) {
            lastBeat = now;
            post({ type: "heartbeat", jobId, done: i, total: seeds.length, elapsedMs: now - t0 });
          }
          return true;
        },
      });
      metricsList.push(run.metrics);
      post({ type: "progress", jobId, done: i + 1, total: seeds.length, seed: seeds[i] });
      // 单个种子很慢时（长时长 × 高解算率），靠心跳告诉主线程「我还活着」
      const now = Date.now();
      if (now - lastBeat >= HEARTBEAT_MS) {
        lastBeat = now;
        post({ type: "heartbeat", jobId, done: i + 1, total: seeds.length, elapsedMs: now - t0 });
      }
    }
    if (cancelled.has(jobId)) {
      cancelled.delete(jobId);
      post({ type: "cancelled", jobId, done: metricsList.length, total: seeds.length });
      return;
    }
    post({ type: "done", jobId, metricsList, elapsedMs: Date.now() - t0 });
  } catch (err) {
    post({ type: "error", jobId, message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (runningJobId === jobId) runningJobId = 0;
  }
};
