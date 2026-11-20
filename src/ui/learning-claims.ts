/**
 * 教材 ↔ 实验双向链接的 claim 注册表（FIX-06）。
 *
 * 一条 claim 是「教材里的一个结论」到「装置上一个可执行动作」的最小绑定：
 * - targetId 由 action 决定归属：run-experiment → 实验 id，run-prediction →
 *   学习活动 id，run-comparison → 对照变量 id；
 * - docPage/docAnchor 指向 index.html 中真实存在的文档页与锚点，教材按钮
 *   由文档层按 `[data-claim]` 占位渲染；
 * - 本模块保持纯数据（无 DOM、无配置依赖），目录契约测试会在构建期校验
 *   id 唯一、目标存在、文档锚点存在与动作类型匹配。
 */

export type LearningClaimAction = "run-experiment" | "run-prediction" | "run-comparison";

export interface LearningClaim {
  id: string;
  docPage: string;
  docAnchor: string;
  label: string;
  action: LearningClaimAction;
  /** experimentId / activityId / comparisonVariableId（由 action 决定语义） */
  targetId: string;
  /** run-experiment / run-comparison 可要求先装载的基线实验；省略表示沿用当前现场。 */
  baselineExperimentId?: string;
  /**
   * 因果验收：claim 声称的结论必须能被真实结果反驳。
   * 只声明「装载了哪个实验」不够——教材说的是「门控让误差下降」，
   * 那就必须实际跑完 A/B 并核对目标指标确实改善。
   */
  expectation?: {
    /** 对照窗口时长（秒）；与对照台 baseConfig 一致才可比。 */
    durationSec?: number;
    /** 目标算法。 */
    estimatorId: string;
    /** 目标指标（runner 指标名）。 */
    metric: string;
    /** 变量侧（B）相对基线侧（A）至少改善的绝对值。 */
    minGain: number;
    /** 变量侧必须产生的事件计数下限（例如门控拒绝次数）。 */
    minEvents?: number;
    /** 事件指标名（默认 gateRejects）。 */
    eventMetric?: string;
  };
}

/** labs 页内的 claim 快捷构造：docPage 恒为 labs，减少重复字段。 */
const claim = (
  id: string,
  docAnchor: string,
  label: string,
  action: LearningClaimAction,
  targetId: string,
  baselineExperimentId?: string,
): LearningClaim => ({
  id, docPage: "labs", docAnchor, label, action, targetId,
  ...(baselineExperimentId ? { baselineExperimentId } : {}),
});

export const LEARNING_CLAIMS: readonly LearningClaim[] = [
  // 预测式练习（题面条件 + 实测证据）
  claim("claim-drift-linear", "l-exercise", "零偏漂移", "run-prediction", "drift-linear-10s"),
  claim("claim-yaw-unobservable", "l-exercise", "偏航不可观", "run-prediction", "accel-yaw-unobservable"),
  // 单变量对照（冻结基线后只改一个变量）
  {
    ...claim("claim-gate-rescue", "l-index", "门控对照", "run-comparison", "accel-gate", "gate"),
    // 默认基线（seed 24301、500 Hz、水平初态、默认噪声/启动 ramp、磁开、恢复关）+ gate，20 s：
    // A/B rmse=15.243638770525585/12.52735392220622°；拒绝 0/8272；两侧峰值 57.600488471779435°。
    expectation: {
      durationSec: 20,
      estimatorId: "mahony",
      metric: "rmse",
      minGain: 2,
      minEvents: 100,
      eventMetric: "gateRejects",
    },
  },
  // 实验索引里的主要结论：每条都能一键装载对应实验现场
  claim("claim-vibration", "l-index", "电机振动", "run-experiment", "vibration"),
  claim("claim-magnetic", "l-index", "磁干扰偏航", "run-experiment", "magnetic"),
  claim("claim-kalman-tuning", "l-index", "卡尔曼Q/R", "run-experiment", "kalman-tuning"),
  claim("claim-gimbal-lock", "l-index", "万向节锁", "run-experiment", "gimbal"),
  claim("claim-euler-singularity", "l-index", "锁点后果", "run-experiment", "lockAlgo"),
  claim("claim-slerp-euler", "l-index", "Slerp对比", "run-experiment", "slerp"),
  claim("claim-double-cover", "l-index", "4D覆盖", "run-experiment", "proj"),
  claim("claim-sensor-delay", "l-index", "群延迟", "run-experiment", "sensorDelay"),
  claim("claim-gyro-saturation", "l-index", "量程饱和", "run-experiment", "gyroSaturation"),
  claim("claim-solve-rate", "l-index", "解算频率", "run-experiment", "solveRate"),
];

/** 按 id 取 claim；未知 id 返回 undefined（调用方必须显式处理）。 */
export function findClaim(id: string): LearningClaim | undefined {
  return LEARNING_CLAIMS.find((claim) => claim.id === id);
}

/** 某文档页上可渲染的全部 claim（顺序与注册表一致）。 */
export function claimsForPage(page: string): readonly LearningClaim[] {
  return LEARNING_CLAIMS.filter((claim) => claim.docPage === page);
}
