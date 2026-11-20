/**
 * 把 `EstimatorTuning` 写入估计器实例（UI 的 A/B 克隆与 runner 共用）。
 *
 * 单独成文件的动机与 run-constants 相同：main.ts 需要这一步装配，但不需要
 * runner 的批量/统计/trace 全部代码。runner 从本模块导入并重导出，数值语义不变。
 */
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  type Estimator,
} from "../estimators";
import type { EstimatorTuning } from "./experiment-config";

export function applyTuning(e: Estimator, t: EstimatorTuning): void {
  e.magEnabled = t.magEnabled;
  e.setParams(t.params);
  if (e.id === "comp" || e.id === "mahony" || e.id === "madg") {
    const g = e as ComplementaryEstimator | MahonyEstimator | MadgwickEstimator;
    g.accelGate = t.accelGate;
    g.gateDeg = t.gateDeg;
    g.gateMagPct = t.gateMagPct;
    g.gateRecovery = t.gateRecovery;
    g.rampEnabled = t.rampEnabled;
  }
  if (e.id === "mahony" || e.id === "madg") {
    (e as MahonyEstimator | MadgwickEstimator).magMode = t.magMode;
  }
  if (e.id === "kalman") {
    const k = e as KalmanEstimator;
    if (t.kalmanGate) k.gateMode = t.kalmanGate;
    if (t.kalmanChi2 !== undefined) k.gateChi2 = t.kalmanChi2;
    if (t.kalmanResetCov !== undefined) k.resetCovOnInject = t.kalmanResetCov;
  }
}
