/**
 * 单变量对照 Worker：在 Worker 内重新校验 A/B，再顺序运行两侧详细实验。
 *
 * 与批量 Worker 的关键差异：
 *  - 每个 job 只有一条 A→B 流水线，结果包含五条 ErrorSeries / 事件 / 终态姿态；
 *  - `done` 只在两侧都 `termination.reason === "completed"` 且 job 仍为当前时发送；
 *  - 取消或新 job 替代会立刻把旧 job 标为 terminal 并发 `cancelled`（带真实完成侧数），
 *    之后旧 continuation 的任何 `postMessage` 都被 `isCurrent` 拦截。
 *
 * 数值内核仍是 `runExperimentDetailedAsync`（与主线程同步详细 runner 同一 generator）：
 * `stepsPerSlice` / `progressEverySec` 只改变调度与进度频率，不改变结果。
 */
import { buildComparisonPair, type ComparisonVariable } from "../core/comparison-config";
import {
  runExperimentDetailedAsync,
  type ErrorSeries,
  type HeadlessRunResult,
} from "../core/runner";
import type { ExperimentConfig } from "../core/experiment-config";
import type {
  ComparisonRequest,
  ComparisonResponse,
  ComparisonSide,
  ComparisonSideId,
} from "../core/comparison-protocol";

const post = (msg: ComparisonResponse): void => {
  (self as unknown as { postMessage: (m: ComparisonResponse) => void }).postMessage(msg);
};

interface Job {
  id: number;
  /** 收到 cancel / 被新 job 替代；一旦为真，旧 continuation 不再发任何消息。 */
  cancelled: boolean;
  /** 只统计 `termination.reason === "completed"` 的侧。 */
  completedSides: number;
  /** done / cancelled / error 至多一条。 */
  terminal: boolean;
}

let activeJob: Job | null = null;
let latestJobId = -Infinity;

function isCurrent(job: Job): boolean {
  return activeJob === job && !job.cancelled && !job.terminal;
}

function detach(job: Job): void {
  if (activeJob === job) activeJob = null;
}

/** 当前 job 的唯一取消出口：先落 terminal 再发消息，确保随后不再有 side-complete/done。 */
function cancelJob(job: Job): void {
  if (job.terminal) return;
  job.cancelled = true;
  job.terminal = true;
  detach(job);
  post({ type: "cancelled", jobId: job.id, completedSides: job.completedSides });
}

function failJob(job: Job, side: ComparisonSideId | null, err: unknown): void {
  if (job.terminal) return;
  job.terminal = true;
  detach(job);
  post({
    type: "error",
    jobId: job.id,
    side,
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * 把详细 runner 结果收束成消息载荷。
 * runTask 每侧返回全新对象；这里显式挑选字段，避免把 hooks / 内部字段带进 structured clone。
 */
function snapshot(
  config: ExperimentConfig,
  run: HeadlessRunResult & { series: ErrorSeries[] },
): ComparisonSide {
  return {
    config: run.config,
    metrics: run.metrics,
    series: run.series,
    events: run.events,
    finalQuats: run.finalQuats,
    termination: run.termination,
    seed: config.seed,
  };
}

async function runSide(
  job: Job,
  side: ComparisonSideId,
  config: ExperimentConfig,
): Promise<ComparisonSide | null> {
  if (!isCurrent(job)) return null;
  post({ type: "phase", jobId: job.id, side, phase: "running" });

  let run: HeadlessRunResult & { series: ErrorSeries[] };
  try {
    run = await runExperimentDetailedAsync(config, {
      stepsPerSlice: 128,
      progressEverySec: 0.5,
      // 每步开始前检查，取消不依赖 onProgress 的 0.5 s 频率。
      shouldCancel: () => !isCurrent(job),
      onProgress: (simulationSec) => {
        if (!isCurrent(job)) return false;
        post({
          type: "progress",
          jobId: job.id,
          side,
          simulationSec,
          durationSec: config.durationSec,
        });
        return true;
      },
      onStop: () => {
        // 积分停止、指标收尾开始。取消已经发生时不补发 phase。
        if (isCurrent(job)) post({ type: "phase", jobId: job.id, side, phase: "summarizing" });
      },
    });
  } catch (err) {
    if (isCurrent(job)) failJob(job, side, err);
    return null;
  }

  if (!isCurrent(job)) return null;
  if (run.termination.reason !== "completed") {
    // 正常路径只会在 job 不再当前时被 shouldCancel 中止，此时上面已 return；
    // 这里兜底为取消，绝不把不完整的一侧当作完成。
    cancelJob(job);
    return null;
  }
  return snapshot(config, run);
}

async function execute(job: Job, base: ExperimentConfig, variable: ComparisonVariable): Promise<void> {
  let side: ComparisonSideId | null = null;
  try {
    // 不信任主线程：重做基线校验、受控 patch、全量 schema 校验与精确差异检查。
    const pair = buildComparisonPair(base, variable);
    if (!pair.ok) {
      if (isCurrent(job)) failJob(job, null, pair.error);
      return;
    }

    const completed: Partial<Record<ComparisonSideId, ComparisonSide>> = {};
    const sides = [["a", pair.a], ["b", pair.b]] as const;
    for (const [id, config] of sides) {
      if (!isCurrent(job)) return;
      side = id;
      const result = await runSide(job, id, config);
      if (!result) return;
      // 只有完整完成的一侧才计入 completedSides；部分数据不进入任何终态计数。
      job.completedSides++;
      completed[id] = result;
      if (!isCurrent(job)) return;
      post({ type: "side-complete", jobId: job.id, side: id, result });
    }

    const a = completed.a;
    const b = completed.b;
    if (!a || !b) {
      if (isCurrent(job)) failJob(job, side, "内部错误：缺少一侧的完整结果");
      return;
    }
    // 双重确认：唯一一条 done 必须同时满足「两侧 completed」与「job 未被取消/替代」。
    if (!isCurrent(job)) return;
    if (a.termination.reason !== "completed" || b.termination.reason !== "completed") {
      cancelJob(job);
      return;
    }
    job.terminal = true;
    detach(job);
    post({ type: "done", jobId: job.id, a, b });
  } catch (err) {
    if (isCurrent(job)) failJob(job, side, err);
  }
}

self.onmessage = (ev: MessageEvent<ComparisonRequest>): void => {
  const req = ev.data;
  if (!req || typeof req !== "object") return;

  if (req.type === "cancel") {
    // 迟到/旧 job 的 cancel 只能命中当前同 id 的 job，不能影响后来者。
    if (activeJob?.id === req.jobId) cancelJob(activeJob);
    return;
  }

  // 协议要求 jobId 单调递增：迟到、重复或非整数的 start 不得复活旧任务/抢占新任务。
  if (req.type !== "start" || !Number.isSafeInteger(req.jobId) || req.jobId <= latestJobId) return;
  latestJobId = req.jobId;

  // 新 job 替代旧 job：旧 job 只发一条 cancelled（带已完成侧数），随后彻底沉默。
  if (activeJob) cancelJob(activeJob);
  const job: Job = { id: req.jobId, cancelled: false, completedSides: 0, terminal: false };
  activeJob = job;
  void execute(job, req.base, req.variable);
};
