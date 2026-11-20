/**
 * 算法 id → 中文显示名（全站唯一实现）。
 *
 * 事件时间轴、历史回看、观测面板与 ESKF 面板都要显示同一批算法名；
 * 各处复制会让「纯陀螺仪积分 / 纯陀螺积分」这类措辞在面板间漂移。
 * 本模块保持零依赖（只依赖类型），可被任意按需 chunk 引用而不拖入 UI。
 */
import type { EstimatorId } from "../core/experiment-config";

export const ESTIMATOR_LABELS: Record<EstimatorId, string> = {
  pure: "纯陀螺仪积分",
  comp: "互补滤波",
  mahony: "Mahony",
  madg: "Madgwick",
  kalman: "卡尔曼滤波",
};

export function estimatorLabel(id: EstimatorId): string {
  return ESTIMATOR_LABELS[id] ?? id;
}
