/**
 * 校准面板的文案与结果块（纯字符串构造，无 DOM/无状态）。
 *
 * 抽出来的动机：`updateMagCalUi` / `updateAccelCalUi` 里 100 多行 HTML 拼接
 * 与「采集状态机」混在一起，改一处措辞要在一大段状态逻辑里找。
 * 现在文案集中在这里，并且「拟合残差 / 验证残差 / 留一验证 / 独立验证」四个读数的
 * **口径说明**也写在同一处——它们容易被混为一谈，而它们回答的是不同问题：
 *   · 拟合残差：训练点上的球面有多圆；
 *   · 验证残差：留出的 25% 点上还圆不圆（防"用同一批点自评自"）；
 *   · 留一验证（加计）：没参与拟合的那个朝向上预测准不准；
 *   · 独立验证：换一批全新样本，用真值姿态量实际航向误差/模长误差（最接近后果）。
 */
import type { MagCalibration } from "../core/magcal";
import type { AccelCalibration } from "../core/accelcal";

export interface MagPanelState {
  cal: MagCalibration | null;
  applied: boolean;
  collecting: boolean;
  sampleCount: number;
  message: string;
  verifyLine: string;
  /** 采集目标点数（至少这么多才提示可拟合） */
  target: number;
}

/** 磁校准状态行文本 */
export function magStatusText(s: MagPanelState): string {
  if (s.message) return s.message;
  const n = s.sampleCount;
  if (s.collecting) return `采集中：${n} 点——缓慢翻滚机体，让磁点云铺满球面（至少 ${s.target} 点）`;
  if (n > 0 && !s.cal) return `已采 ${n} 点——点「拟合并应用」解出硬铁/软铁`;
  if (s.cal) {
    return s.applied
      ? `已应用：${n} 点拟合 · 残差 ${(s.cal.residual * 100).toFixed(1)}%`
      : `已拟合（未应用）：${n} 点 · 残差 ${(s.cal.residual * 100).toFixed(1)}%`;
  }
  return "未校准。模拟模式可一键生成样本；真实模式需缓慢翻滚机体采集。";
}

/** 磁校准结果块 HTML（含验证残差、失效提示与独立验证行） */
export function magResultHtml(cal: MagCalibration | null, verifyLine: string, stale?: string | null): string {
  if (!cal) return "";
  const model = cal.kind === "full" ? "完整 3×3 椭球" : "对角软铁";
  const body =
    `<div>模型 ${model} · 硬铁 offset [${cal.offset.map((v) => v.toFixed(1)).join(", ")}] μT</div>` +
    (cal.kind === "full" && cal.matrix
      ? `<div>M = [${cal.matrix.map((v) => v.toFixed(3)).join(", ")}]</div>`
      : `<div>软铁 scale [${cal.scale.map((v) => v.toFixed(3)).join(", ")}]</div>`) +
    `<div>场强 ${cal.field.toFixed(1)} μT · 样本 ${cal.count} · 残差 ${(cal.residual * 100).toFixed(2)}%` +
    (cal.validation
      ? ` · 验证残差 ${(cal.validation.residual * 100).toFixed(2)}%（${cal.validation.count} 点，比值 ${cal.validation.ratio.toFixed(2)}）`
      : "") +
    (cal.validation?.late
      ? ` · 后段留出 ${(cal.validation.late.residual * 100).toFixed(2)}%（${cal.validation.late.count} 点，比值 ${cal.validation.late.ratio.toFixed(2)}）`
      : "") +
    `</div>` +
    (cal.kind === "full"
      ? `<div class="dim">完整模型按目标场强缩放到 ${cal.field.toFixed(1)} μT；仅凭点云无法确定绝对场强，默认取本装置世界磁场 50 μT</div>`
      : "") +
    (stale ? `<div class="dim" style="color:#fbbf24">⚠ ${stale}</div>` : "");
  return body + verifyLine;
}

/** 独立验证结果行（磁） */
export function magVerifyLineHtml(v: {
  count: number;
  beforeMeanDeg: number;
  afterMeanDeg: number;
  beforeMaxDeg: number;
  afterMaxDeg: number;
}, refField: readonly number[]): string {
  return (
    `<div>独立验证（${v.count} 组新样本，${refField.map((x) => x.toFixed(1)).join("/")} μT 真值场）：` +
    `航向误差 平均 <b>${v.beforeMeanDeg.toFixed(2)}° → ${v.afterMeanDeg.toFixed(2)}°</b>、` +
    `最大 ${v.beforeMaxDeg.toFixed(2)}° → ${v.afterMaxDeg.toFixed(2)}°</div>`
  );
}

export interface AccelPanelState {
  cal: AccelCalibration | null;
  applied: boolean;
  sampleCount: number;
  message: string;
  verifyLine: string;
  windowSeconds: number;
}

/** 加计校准状态行文本 */
export function accelStatusText(s: AccelPanelState): string {
  if (s.message) return s.message;
  if (s.cal) {
    return (
      `已拟合 ${s.cal.faces.length}/6 面 · 残差 RMS [${s.cal.rmse.map((v) => v.toFixed(3)).join(", ")}] m/s²` +
      (s.applied ? " · 已应用" : " · 未应用")
    );
  }
  return `未采集。六个朝向依次朝下、静止 ${s.windowSeconds}s 后各点一次（当前 ${s.sampleCount}/6 面）`;
}

/** 加计结果块 HTML（含留一验证、失效提示与独立验证行） */
export function accelResultHtml(cal: AccelCalibration | null, verifyLine: string, stale?: string | null): string {
  if (!cal) return "";
  const v = cal.validation;
  return (
    `<div>M = [${cal.M.map((x) => x.toFixed(4)).join(", ")}]</div>` +
    `<div>bias = [${cal.bias.map((x) => x.toFixed(3)).join(", ")}] m/s² · 样本 ${cal.count}` +
    (v ? ` · 留一验证 平均 ${v.meanNormErrMs2.toFixed(4)} / 最大 ${v.maxNormErrMs2.toFixed(4)} m/s²（${v.heldOutFaces} 朝向）` : "") +
    `</div>` +
    (stale ? `<div class="dim" style="color:#fbbf24">⚠ ${stale}</div>` : "") +
    verifyLine
  );
}

/** 独立验证结果行（加计） */
export function accelVerifyLineHtml(v: {
  count: number;
  beforeMeanMs2: number;
  afterMeanMs2: number;
  beforeMaxMs2: number;
  afterMaxMs2: number;
}, fresh: boolean): string {
  return (
    `<div>独立验证（${v.count} 组${fresh ? "新噪声" : "已采"}样本）：` +
    `模长偏离 g 平均 ${v.beforeMeanMs2.toFixed(4)} → <b>${v.afterMeanMs2.toFixed(4)}</b> m/s²、` +
    `最大 ${v.beforeMaxMs2.toFixed(4)} → ${v.afterMaxMs2.toFixed(4)} m/s²</div>`
  );
}

/* --------------------------------------------------------------------------
   校准历史（可恢复的快照列表）
   -------------------------------------------------------------------------- */

export interface CalibrationHistoryEntry {
  /** 单调递增 id（渲染 data-* 与恢复时定位） */
  id: number;
  /** 拟合时刻（本地时间字符串，面板展示用） */
  atText: string;
  model: "diag" | "full";
  sampleCount: number;
  residual: number;
  /** 后段留出残差（没有则为 null） */
  lateResidual: number | null;
  /** 该快照是否就是当前应用的标定 */
  active: boolean;
}

/**
 * 历史列表 HTML：每条给「恢复」按钮。
 * 为什么值得做：校准是「采一次、比一次」的过程，用户常想回到上一版标定；
 * 此前重新拟合会直接覆盖，唯一的回退手段是重新采集。
 */
export function magHistoryHtml(entries: CalibrationHistoryEntry[]): string {
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) =>
        `<div class="cal-hist-row" data-cal-id="${e.id}">` +
        `<span class="mono dim">${e.atText}</span> · ${e.model === "full" ? "完整椭球" : "对角"} · ` +
        `${e.sampleCount} 点 · 残差 ${(e.residual * 100).toFixed(2)}%` +
        (e.lateResidual !== null ? ` · 后段 ${(e.lateResidual * 100).toFixed(2)}%` : "") +
        (e.active
          ? ` <span class="dim">（当前）</span>`
          : ` <button type="button" class="btn btn-mini" data-cal-restore="${e.id}">恢复</button>`) +
        `</div>`,
    )
    .join("");
  return `<div class="cal-hist"><div class="dim">历史标定（最多保留 5 份，可恢复）</div>${rows}</div>`;
}
