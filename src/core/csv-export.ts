/** 记录快照 → CSV 的纯序列化；不读 DOM、不重算校准，也不依赖 runner。 */
import { DEG, type Quat, type V3 } from "./quat";
import type { ImuSample } from "./imu";
import type { ReferenceKind } from "./data-source";

export interface LogRow {
  t: number;
  euler: number[][]; // [真实, pure, comp, mahony, madg, kalman] × [φ,θ,ψ]（度，原始值）
  err: number[]; // 总误差（度）
  /** 必须记录原始四元数；万向节锁附近无法从欧拉角可靠反算。 */
  quats: Quat[];
  qTrue: Quat;
  /** 记录时刻的源 IMU；校准日志回放的源读数可能已校准。 */
  imu: ImuSample | null;
  /** 记录时刻实际喂给估计器的消费快照；导出不得按当前标定重算历史。 */
  imuConsumed: ImuSample | null;
  /** 消费快照对应的解算时刻（秒）；NaN = 没有可用快照。 */
  consumedSolveT: number;
  sourceCalibrated: boolean;
}

export interface RawRow {
  t: number;
  gyro: V3;
  accel: V3;
  mag: V3;
}

/** 与 core/replay.ts 的识别规则对齐：导出即可回灌。 */
export const IMU_EXPORT_COLUMNS = [
  "gyro_x_dps", "gyro_y_dps", "gyro_z_dps",
  "accel_x_ms2", "accel_y_ms2", "accel_z_ms2",
  "mag_x_ut", "mag_y_ut", "mag_z_ut",
];

function imuValues(sample: Pick<ImuSample, "gyro" | "accel" | "mag"> | null): number[] {
  return sample
    ? [...sample.gyro.map((v) => v * DEG), ...sample.accel, ...sample.mag]
    : new Array<number>(IMU_EXPORT_COLUMNS.length).fill(NaN);
}

function csvDocument<T>(header: string[], rows: readonly T[], valuesOf: (row: T) => number[], meta: readonly string[]): string {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(valuesOf(row).map((v) => Number.isFinite(v) ? v.toFixed(6) : "").join(","));
  }
  return `\ufeff${meta.join("\n")}\n${lines.join("\n")}\n`;
}

/** 元数据由装配层采集；这里仅按现有列序序列化，不读任何活状态。 */
export function serializeAttitudeCsv(
  rows: readonly LogRow[],
  estimatorIds: readonly string[],
  referenceKind: ReferenceKind,
  quatOn: boolean,
  imuOn: boolean,
  imuCalibratedCols: boolean,
  meta: readonly string[],
): string {
  const refLabel = referenceKind === "groundTruth" ? "truth" : referenceKind === "external" ? "external_ref" : "mahony_ref";
  const angles = (id: string): string[] => ["roll", "pitch", "yaw"].map((k) => `${id}_${k}_deg`);
  const quaternions = (id: string): string[] => ["w", "x", "y", "z"].map((k) => `${id}_q${k}`);
  const header = [
    "t_s",
    ...angles(refLabel),
    ...estimatorIds.flatMap(angles),
    ...estimatorIds.map((id) => `err_${id}_deg`),
    ...(quatOn ? [...estimatorIds.flatMap(quaternions), ...quaternions(refLabel)] : []),
    ...(imuOn ? IMU_EXPORT_COLUMNS : []),
  ];
  return csvDocument(header, rows, (row) => {
    const vals = [row.t, ...row.euler.flatMap((e) => [e[0], e[1], e[2]]), ...row.err];
    if (quatOn) {
      for (const q of row.quats) vals.push(q.w, q.x, q.y, q.z);
      vals.push(row.qTrue.w, row.qTrue.x, row.qTrue.y, row.qTrue.z);
    }
    if (imuOn) vals.push(...imuValues(imuCalibratedCols ? row.imuConsumed : row.imu));
    return vals;
  }, meta);
}

export function serializeRawImuCsv(rows: readonly RawRow[], meta: readonly string[]): string {
  return csvDocument(["t_s", ...IMU_EXPORT_COLUMNS], rows, (row) => [row.t, ...imuValues(row)], meta);
}
