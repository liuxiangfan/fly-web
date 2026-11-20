import {
  IMU_EXPORT_COLUMNS,
  serializeAttitudeCsv,
  serializeRawImuCsv,
  type LogRow,
  type RawRow,
} from "../core/csv-export";
import type { ReferenceKind } from "../core/data-source";
import type { ImuParams, ImuSample } from "../core/imu";

export interface ExportDialogDeps {
  logRows(): readonly LogRow[];
  rawRecord(): { rows: readonly RawRow[]; sourceCalibrated: boolean };
  state(): { simTime: number; real: boolean; lastImu: ImuSample | null };
  estimatorIds(): readonly string[];
  comp(): { alpha: number };
  mahony(): { kp: number; ki: number };
  madg(): { beta: number };
  kalman(): { gyroNoiseDps: number; obsNoise: number };
  imuParams(): ImuParams;
  solveState(): { hz: number };
  insState(): { on: boolean; scale: string };
  scenarioSelect(): HTMLSelectElement;
  experimentConfig(): { seed: number };
  dataSourceLabel(): string;
  hasGroundTruth(): boolean;
  currentReferenceKind(): ReferenceKind;
  logRowCap(): number;
  toast(text: string, color?: string): void;
  downloadExport(contents: string, type: string, name: string, extension: string): void;
}

let deps: ExportDialogDeps;
let listenersBound = false;
let exportIncludeQuat = false;
/** 是否附加原始 IMU 九列（勾上后这份文件可直接用「导入 IMU 日志回放」喂回装置） */
let exportIncludeImu = false;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

function openExportDialog(): void {
  const dlg = document.getElementById("export-dialog") as HTMLDialogElement | null;
  if (!dlg) return;
  const logRows = deps.logRows();
  const rawRecord = deps.rawRecord();
  if (logRows.length === 0 && rawRecord.rows.length === 0) {
    deps.toast("还没有记录到数据——等一两秒再导出", "#fbbf24");
    return;
  }
  const meta = document.getElementById("export-meta");
  if (meta) {
    const state = deps.state();
    const span = logRows.length > 1 ? state.simTime - logRows[0].t : 0;
    // 记录是滚动窗口（有上限）：长时间运行后最早的行会被丢弃，这一点必须说出来，
    // 否则用户会以为「导出的行数」= 实际运行时长
    const capped = logRows.length >= deps.logRowCap() ? `（滚动窗口上限 ${deps.logRowCap()} 行，更早的已丢弃）` : "";
    const scenarioSelect = deps.scenarioSelect();
    meta.textContent =
      `已记录 ${logRows.length} 行（25 Hz，约 ${span.toFixed(1)} s）${capped} · ` +
      `数据源：${deps.dataSourceLabel()}${deps.hasGroundTruth() ? `（基准 = 真值，剧本 ${scenarioSelect.selectedOptions[0]?.textContent ?? "—"}）` : `（基准 = ${deps.currentReferenceKind() === "external" ? "外部参考" : "Mahony"}）`}`;
  }
  // 单选组必须**恰好**选中一个：旧写法 `(value === "quat") === exportIncludeQuat`
  // 在 exportIncludeQuat=false 时会把 "angles" 与 "raw" 同时选中（浏览器取最后一个 → 默认档变成全帧导出）。
  const scopeWanted = exportIncludeQuat ? "quat" : "angles";
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="export-scope"]')) {
    r.checked = r.value === scopeWanted;
  }
  ($("export-imu") as HTMLInputElement).checked = exportIncludeImu;
  updateExportCount();
  dlg.showModal();
}

function exportCsv(quatOn: boolean, imuOn: boolean, imuCalibratedCols = false): void {
  /**
   * 源列语义必须**逐行**判定（ROUND11 P1）：校准日志回放录下的源读数已经是校准后的，
   * 旧实现无条件写 `# imu=raw`，于是这份文件再导入时会被二次校准（实测磁值 25 → 20）。
   * 一份 CSV 的表头只能描述一种语义：混语义时明确拒绝，而不是挑一个标签骗下游。
   */
  const logRows = deps.logRows();
  const anyCalSrc = logRows.some((r) => r.sourceCalibrated);
  const anyRawSrc = logRows.some((r) => !r.sourceCalibrated);
  if (imuOn && !imuCalibratedCols && anyCalSrc && anyRawSrc) {
    deps.toast("这批记录混了「原始」与「已校准」两种源读数——表头只能标一种语义，请分段导出", "#f85149");
    return;
  }
  const srcSemantics: "raw" | "calibrated" = anyCalSrc && !anyRawSrc ? "calibrated" : "raw";
  const refKind = deps.currentReferenceKind();
  const state = deps.state();
  const scenarioSelect = deps.scenarioSelect();
  const comp = deps.comp();
  const mahony = deps.mahony();
  const madg = deps.madg();
  const kalman = deps.kalman();
  const meta = [
    `# quaternion-attitude-demo export`,
    `# mode=${state.real ? "real-serial" : "simulation"} scenario=${state.real ? "serial" : scenarioSelect.value}`,
    `# algorithm_params=${JSON.stringify({
      compAlpha: comp.alpha,
      mahonyKp: mahony.kp,
      mahonyKi: mahony.ki,
      madgwickBeta: madg.beta,
      kalmanQ: kalman.gyroNoiseDps,
      kalmanR: kalman.obsNoise,
      magEnabled: ($("mag-enable") as HTMLInputElement).checked,
      magMode: $<HTMLSelectElement>("mag-mode").value,
      accelGate: ($("gate-toggle") as HTMLInputElement).checked,
      gateDeg: $<HTMLInputElement>("gate-deg").valueAsNumber,
      gateMagPct: $<HTMLInputElement>("gate-mag").valueAsNumber / 100,
      gateRecovery: ($("gate-recovery") as HTMLInputElement).checked,
      solveRateHz: deps.solveState().hz,
      insEnabled: deps.insState().on,
      insScale: deps.insState().scale,
    })}`,
    `# imu_params=${JSON.stringify(deps.imuParams())}`,
    // 三路滞后（各通道采样时刻与当前时刻之差）：有带宽/降采样/延迟时才存在
    ...(state.lastImu?.times
      ? [`# sensor_lag_ms=gyro:${((state.simTime - state.lastImu.times.gyro) * 1000).toFixed(2)},accel:${((state.simTime - state.lastImu.times.accel) * 1000).toFixed(2)},mag:${((state.simTime - state.lastImu.times.mag) * 1000).toFixed(2)}`]
      : []),
    // IMU 列语义：回放侧据此决定是否再次应用校准，避免「校准后导出 → 回放」被二次校准
    // 源列不能恒写 raw——校准来源的源读数本来就是校准后的（ROUND11）
    ...(imuOn ? [`# imu=${imuCalibratedCols ? "calibrated" : srcSemantics}`] : []),
    ...(imuOn
      ? [
          "# imu_note=记录时刻快照，不随后续改标定变化",
        ]
      : []),
    `# note: reference = ${state.real ? "Mahony (real mode has no ground truth)" : "ground truth (simulation)"}`,
  ];
  const csv = serializeAttitudeCsv(logRows, deps.estimatorIds(), refKind, quatOn, imuOn, imuCalibratedCols, meta);
  deps.downloadExport(csv, "text/csv;charset=utf-8", "log", "csv");
  deps.toast(`已导出 ${logRows.length} 行 CSV${imuOn ? `（IMU 列=${imuCalibratedCols ? "消费" : srcSemantics}）` : ""}`);
}

/**
 * 全帧源 IMU 导出：按数据源真实帧率写 t + 九轴；列名与回放识别规则一致，
 * 因此这份文件可以直接用「导入 IMU 日志回放」喂回装置（与 25 Hz 记录导出的闭环互补）。
 *
 * 「源」而不是「原始」：记录点在校准链之前，所以模拟/串口来源写出的确实是原始读数；
 * 但**回放一份声明了 `# imu=calibrated` 的日志**时，记录下来的本来就是校准后读数。
 * 早期版本无条件写 `# imu=raw`，于是这种文件被再导入时会被**二次校准**（复核实测：
 * 实际消费的磁值 25 → 20 → 20，多轮往返持续走偏）。
 */
function exportRawCsv(): void {
  const rawRecord = deps.rawRecord();
  if (rawRecord.rows.length === 0) {
    deps.toast("全帧记录为空——先在 IMU 面板勾选「记录全帧源 IMU」，让它跑一会儿再导出", "#fbbf24");
    return;
  }
  // 记录期间换过来源也不会混语义：recordRaw 在语义变化时已清空重记，这里直接读标注
  const calibrated = rawRecord.sourceCalibrated;
  const state = deps.state();
  const meta = [
    "# quaternion-attitude-demo raw IMU export",
    `# source=${deps.dataSourceLabel()} scenario=${state.real ? "external" : deps.scenarioSelect().value} seed=${deps.experimentConfig().seed}`,
    `# rows=${rawRecord.rows.length} duration_s=${(rawRecord.rows[rawRecord.rows.length - 1].t - rawRecord.rows[0].t).toFixed(3)}`,
    // 语义标注：raw = 校准链之前的读数（回放时按需补校准）；calibrated = 已经是校准后读数（回放不得再校准）
    `# imu=${calibrated ? "calibrated" : "raw"}`,
    "# note: 列名与「导入 IMU 日志回放」的识别规则一致，导出后可直接回放",
  ];
  deps.downloadExport(serializeRawImuCsv(rawRecord.rows, meta), "text/csv;charset=utf-8", "raw-imu", "csv");
  deps.toast(
    `已导出 ${rawRecord.rows.length} 帧全帧源 IMU（可直接回放，标注 # imu=${calibrated ? "calibrated" : "raw"}）`,
  );
}

/** 导出弹窗的实时列数：让「多 24 列 / 多 9 列」这种代价在选择前就可见 */
function updateExportCount(): void {
  const el = document.getElementById("export-count");
  if (!el) return;
  const picked = document.querySelector<HTMLInputElement>('input[name="export-scope"]:checked')?.value;
  if (picked === "raw") {
    const rawRecord = deps.rawRecord();
    el.textContent = `将导出 ${1 + IMU_EXPORT_COLUMNS.length} 列全帧源 IMU（当前已记录 ${rawRecord.rows.length} 帧，标注 # imu=${rawRecord.sourceCalibrated ? "calibrated" : "raw"}，可直接回放）`;
    return;
  }
  const quat = picked === "quat";
  const imu = ($("export-imu") as HTMLInputElement).checked;
  const calBox = $<HTMLInputElement>("export-imu-calibrated");
  if (calBox) calBox.disabled = !imu || picked === "raw";
  const cols = 24 + (quat ? 24 : 0) + (imu ? IMU_EXPORT_COLUMNS.length : 0);
  const imuKind = imu ? (calBox?.checked ? "（含校准后 IMU 列，标注 # imu=calibrated）" : "（含原始 IMU，可再导入回放）") : "";
  el.textContent = `将导出 ${cols} 列${imuKind}`;
}

function bindListeners(): void {
  document.getElementById("export-cancel")?.addEventListener("click", () => {
    (document.getElementById("export-dialog") as HTMLDialogElement | null)?.close();
  });
  document.querySelectorAll('input[name="export-scope"]').forEach((r) =>
    r.addEventListener("change", updateExportCount),
  );
  $("export-imu").addEventListener("change", updateExportCount);
  $("export-imu-calibrated").addEventListener("change", updateExportCount);

  document.getElementById("export-confirm")?.addEventListener("click", () => {
    const picked = document.querySelector<HTMLInputElement>('input[name="export-scope"]:checked');
    const scope = picked?.value ?? "angles";
    (document.getElementById("export-dialog") as HTMLDialogElement | null)?.close();
    if (scope === "raw") {
      exportRawCsv();
      return;
    }
    exportIncludeQuat = scope === "quat";
    const imuOn = ($("export-imu") as HTMLInputElement).checked;
    const imuCalCols = imuOn && ($("export-imu-calibrated") as HTMLInputElement).checked;
    exportIncludeImu = imuOn;
    exportCsv(exportIncludeQuat, imuOn, imuCalCols);
  });
}

/** 首次创建时绑定弹窗监听；重复创建复用同一会话态与监听。 */
export function createExportDialog(nextDeps: ExportDialogDeps): { open(): void } {
  deps = nextDeps;
  if (!listenersBound) {
    bindListeners();
    listenersBound = true;
  }
  return { open: openExportDialog };
}
