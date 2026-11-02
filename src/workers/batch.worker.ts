/**
 * 批量评测 Worker：主线程生成种子，Worker 共用 runner 的唯一数值内核并回传指标。
 *
 * 任务对象持有各自的取消状态；新 start 按入站顺序替代旧 job。
 * 每有限步让出事件循环，才能在单种子中途处理 cancel（同步 onmessage 循环做不到）。
 * UI 的 Worker.terminate() 硬停止路径保持不变。
 */
import { runExperimentAsync, type EstimatorRunMetrics } from "../core/runner";
import type { BatchRequest, BatchResponse } from "../core/batch-protocol";

const HEARTBEAT_MS = 2000;
const post = (msg: BatchResponse): void => {
  (self as unknown as { postMessage: (m: BatchResponse) => void }).postMessage(msg);
};

interface Job {
  id: number;
  total: number;
  cancelled: boolean;
  metricsList: EstimatorRunMetrics[][];
}
let activeJob: Job | null = null;
let latestJobId = -Infinity;

/** 只发一次终止消息；后续旧异步 continuation 不允许再发 progress/done/error。 */
function cancelJob(job: Job): void {
  if (job.cancelled) return;
  job.cancelled = true;
  post({ type: "cancelled", jobId: job.id, done: job.metricsList.length, total: job.total });
  if (activeJob === job) activeJob = null;
}

async function execute(req: Extract<BatchRequest, { type: "start" }>, job: Job): Promise<void> {
  const { config, seeds } = req;
  const t0 = Date.now();
  let lastBeat = t0;
  const isCurrent = (): boolean => activeJob === job && !job.cancelled;
  try {
    for (let i = 0; i < seeds.length; i++) {
      if (!isCurrent()) return;
      const run = await runExperimentAsync({ ...config, seed: seeds[i] }, {
        stepsPerSlice: 128,
        progressEverySec: 0.5,
        shouldCancel: () => !isCurrent(),
        onProgress: () => {
          if (!isCurrent()) return false;
          const now = Date.now();
          if (now - lastBeat >= HEARTBEAT_MS) {
            lastBeat = now;
            post({ type: "heartbeat", jobId: job.id, done: i, total: seeds.length, elapsedMs: now - t0 });
          }
          return true;
        },
      });
      if (!isCurrent()) return;
      if (run.termination.reason === "cancelled") { cancelJob(job); return; }
      // 只有真正完成的种子入账；取消种子的部分指标不能混进摘要。
      job.metricsList.push(run.metrics);
      post({ type: "progress", jobId: job.id, done: i + 1, total: seeds.length, seed: seeds[i] });
      const now = Date.now();
      if (now - lastBeat >= HEARTBEAT_MS) {
        lastBeat = now;
        post({ type: "heartbeat", jobId: job.id, done: i + 1, total: seeds.length, elapsedMs: now - t0 });
      }
    }
    if (isCurrent()) post({ type: "done", jobId: job.id, metricsList: job.metricsList, elapsedMs: Date.now() - t0 });
  } catch (err) {
    if (isCurrent()) post({ type: "error", jobId: job.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (activeJob === job) activeJob = null;
  }
}

self.onmessage = (ev: MessageEvent<BatchRequest>): void => {
  const req = ev.data;
  if (!req) return;
  if (req.type === "cancel") {
    if (activeJob?.id === req.jobId) cancelJob(activeJob);
    return;
  }
  // 协议要求单调递增 jobId：迟到/重复 start 不得复活旧任务或抢占新任务。
  if (req.type !== "start" || req.jobId <= latestJobId) return;
  latestJobId = req.jobId;
  if (activeJob) cancelJob(activeJob);
  const job: Job = { id: req.jobId, total: req.seeds.length, cancelled: false, metricsList: [] };
  activeJob = job;
  void execute(req, job);
};
