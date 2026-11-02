/**
 * 批量评测的 Worker 消息协议（主线程 ↔ 批处理 Worker）。
 *
 * 为什么单独成文件：主线程与 worker 都要 import 它，而 worker 里**不能** import main.ts
 * （那会把整个 UI 拖进 worker 包）。协议只包含纯数据：配置、种子序列与每次运行的指标。
 *
 * 为什么只传指标而不是整个 HeadlessRunResult：events 数组可能上千条、finalQuats 也只在
 * 交互诊断时有用；批量摘要（`summarizeRuns` 口径）只需要每个 seed 的 `EstimatorRunMetrics[]`。
 *
 * 为什么要 jobId / cancel / heartbeat（第五轮复核的 P2）：
 *  - `jobId`：用户连点两次或上一批还没结束就换了配置时，**旧批的结果不能覆盖新批的表格**；
 *    主线程只接受与当前 jobId 一致的消息，其余一律丢弃。
 *  - `cancel`：30 种子 × 30 s 的批次要跑几十秒，此前无法中止，只能刷新页面。
 *  - `heartbeat`：Worker 被浏览器节流/卡住时，主线程要能区分「还在跑」与「已经死了」，
 *    而不是一直显示「进行中」直到超时。
 */

/** 主线程 → Worker */
export type BatchRequest =
  | {
      type: "start";
      /** 单调递增的任务号（主线程维护）：用于丢弃过期结果 */
      jobId: number;
      /** 已克隆的配置（structured clone 可直接传，里面没有函数/类实例） */
      config: import("./experiment-config").ExperimentConfig;
      /** 本次要跑的种子序列（由主线程生成，保证与主线程路径逐位一致） */
      seeds: number[];
    }
  | { type: "cancel"; jobId: number };

/** Worker → 主线程 */
export type BatchResponse =
  | { type: "progress"; jobId: number; done: number; total: number; seed: number }
  | { type: "heartbeat"; jobId: number; done: number; total: number; elapsedMs: number }
  | { type: "cancelled"; jobId: number; done: number; total: number }
  | { type: "done"; jobId: number; metricsList: import("./runner").EstimatorRunMetrics[][]; elapsedMs: number }
  | { type: "error"; jobId: number; message: string };
