/**
 * 单变量对照的 Worker 消息协议（主线程 ↔ comparison worker）。
 *
 * 为什么不复用 `batch-protocol.ts`：
 *  - 对照结果要保留五条 `ErrorSeries`、事件流与终态姿态，形状与内存成本都和批量摘要不同；
 *    复用一个 `config/seeds/metricsList` 消息只会把「假装支持曲线」的字段塞进批量协议。
 *  - 进度以「当前侧 + 仿真时刻」表达，取消必须回报真实完成的侧数；
 *  - `done` 只在 A、B 两侧都 `termination.reason === "completed"` 时出现，主线程不能把
 *    「A 完成、B 取消」误当成最终结论。
 *
 * 纯数据：只 import 类型，worker 不得因为这里拖入 DOM/UI。消息语义：
 *  - `jobId` 单调递增；主线程只接受当前 job 的消息，Worker 丢弃迟到/重复的 start；
 *  - 每侧最多一条 `phase:"running"` 与一条 `phase:"summarizing"`；
 *  - 取消/job 替换后 Worker 只再发一条 `cancelled`，不再发 `side-complete` / `done` / `error`。
 */
import type { ComparisonVariable } from "./comparison-config";
import type { ExperimentConfig } from "./experiment-config";
import type { ComparisonSide } from "./comparison-report";

export type ComparisonSideId = "a" | "b";

/** 一侧的生命周期：正在积分 / 积分已停、正在收尾统计。 */
export type ComparisonSidePhase = "running" | "summarizing";

/** 主线程 → Worker */
export type ComparisonRequest =
  | {
      type: "start";
      /** 单调递增的任务号（主线程维护）：用于丢弃过期结果 */
      jobId: number;
      /** 冻结基线；Worker 会再次校验并用它生成 A/B（不信任主线程声明） */
      base: ExperimentConfig;
      /** 唯一对照变量；A/B 的取值与受影响路径都在这里声明 */
      variable: ComparisonVariable;
    }
  | { type: "cancel"; jobId: number };

/** Worker → 主线程 */
export type ComparisonResponse =
  | { type: "phase"; jobId: number; side: ComparisonSideId; phase: ComparisonSidePhase }
  | {
      type: "progress";
      jobId: number;
      side: ComparisonSideId;
      /** 该侧世界实际推进到的时刻（秒） */
      simulationSec: number;
      /** 该侧配置请求的总时长（秒） */
      durationSec: number;
    }
  | { type: "side-complete"; jobId: number; side: ComparisonSideId; result: ComparisonSide }
  | { type: "done"; jobId: number; a: ComparisonSide; b: ComparisonSide }
  /** `completedSides` 只统计真正完整完成的侧（0/1/2），取消侧的部分数据不算数。 */
  | { type: "cancelled"; jobId: number; completedSides: number }
  | { type: "error"; jobId: number; side: ComparisonSideId | null; message: string };

export type { ComparisonSide };
