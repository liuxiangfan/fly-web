/**
 * 数据源与误差参考的显式语义（P1）。
 *
 * 旧代码用 `state.real` 一个布尔值同时表示三件事：
 * 「数据来自外部」「没有真值」「误差以 Mahony 为基准」。
 * 三者在未来会出现交叉组合（例如离线回放带外部真值、飞控 ATTITUDE 作为参考），
 * 因此这里先把类型与判定拆开；UI 仍可从 kind 派生兼容布尔值。
 */

export type DataSourceKind = "simulation" | "serial" | "ble" | "replay";

export type ReferenceKind =
  | "groundTruth"
  | "mahony"
  | "external"
  | "none";

export interface DataSourceState {
  kind: DataSourceKind;
  /** 外部参考存在的条件（例如日志含真值列、飞控提供姿态）；默认 false */
  externalReference: boolean;
}

export function isExternalSource(s: DataSourceState): boolean {
  return s.kind !== "simulation";
}

export function referenceKindOf(s: DataSourceState): ReferenceKind {
  if (s.kind === "simulation") return "groundTruth";
  if (s.externalReference) return "external";
  return "mahony";
}

/** 误差基准是否可用于“物理精度”表述（external/groundTruth 才可以；mahony 只能算算法间偏差） */
export function hasPhysicalReference(s: DataSourceState): boolean {
  const r = referenceKindOf(s);
  return r === "groundTruth" || r === "external";
}

export function sourceLabelOf(s: DataSourceState): string {
  switch (s.kind) {
    case "simulation": return "模拟";
    case "serial": return "真实 IMU";
    case "ble": return "BLE IMU";
    case "replay": return "离线回放";
  }
}
