/**
 * F-03 的“误差来源与可观性”面板（DOM 装配层）。
 *
 * 边界
 * ----
 * - 只读调用方提供的**同一解算子步快照**；不在面板里重新推算姿态或误差。
 * - 观测状态优先使用估计器遥测显式给出的 `accelState/magState`；仅当旧遥测
 *   没有这些字段时才回退到 `explainExistingTelemetry` 的保守解释。
 * - `relativeTruthQuat === null` 时绝不显示 0° 或近似分轴误差，只写“无真值”。
 * - 文案只描述本步状态与几何约束，不把单步拒绝写成传感器故障或系统级结论。
 * - 纯文本 + 原生控件：使用 `textContent` 写入全部外部标签，不拼接 HTML。
 */
import type { EstimatorTelemetry } from "../estimators";
import type { EstimatorId } from "../core/experiment-config";
import type { Quat } from "../core/quat";
import {
  describeObservation,
  observationEvidenceText,
  explainExistingTelemetry,
  type ObservationEvidence,
  type ObservationExplanation,
  type ObservationState,
} from "../core/observability";

export const OBSERVABILITY_DOC_PAGE = "math";
export const OBSERVABILITY_DOC_ANCHOR = "m-observability";

export const OBSERVATION_STATE_LABELS: Record<ObservationState, string> = {
  "not-applicable": "不适用",
  disabled: "未启用",
  invalid: "无效",
  rejected: "被拒绝",
  "accepted-not-applied": "已接受·未应用",
  unrecorded: "未记录",
  applied: "已应用",
};

/** 稳定原因码 → 中文短语；未知码原样展示，不猜测含义。 */
export const OBSERVATION_REASON_LABELS: Record<string, string> = {
  applied: "本步实际应用",
  "no-correction-channel": "算法没有该观测修正通道",
  "accel-norm-zero": "加计模长接近零",
  "accel-norm-out-of-range": "加计模长超出可信范围",
  "accel-norm-invalid": "加计模长非有限",
  "mag-norm-out-of-range": "磁模长超出可信范围",
  "gate-direction": "方向门控拒绝",
  "gate-rejected": "门控拒绝",
  "gate-mahalanobis": "χ² 马氏距离门控拒绝",
  "not-accepted": "观测未被接受",
  "not-recorded": "遥测未记录本步应用状态",
  "mag-disabled": "磁观测未启用",
  "mag-not-evaluated": "本步未评估磁通道",
  "update-degenerate": "更新退化，未应用",
};

export interface ObservabilitySnapshot {
  estimatorId: EstimatorId;
  estimatorLabel: string;
  telemetry: EstimatorTelemetry;
  /**
   * 世界系相对参考四元数 q_ref ⊗ q_est⁻¹。`null` 表示没有可用真值；
   * 调用方不得用 Mahony 基准或 0° 冒充它。
   */
  relativeTruthQuat: Quat | null;
  /** 参考的显示名（例如“真值”“外部参考”“Mahony 基准”）；面板不自行判定真值 */
  referenceLabel: string;
  magEnabled: boolean;
  gateEnabled: boolean;
}

export interface ObservabilityPanelDeps {
  getSnapshot(): ObservabilitySnapshot | null;
  openDocs(page: string, anchor?: string): void;
}

export interface ChannelPanelView {
  channel: "accel" | "mag";
  state: ObservationState;
  stateLabel: string;
  reasonCode: string | null;
  reasonLabel: string;
  evidence: ObservationEvidence;
  evidenceText: string;
  explanation: string;
}

export interface AxisPanelView {
  available: boolean;
  tiltDeg: number | null;
  yawDeg: number | null;
  totalDeg: number | null;
  tiltText: string;
  yawText: string;
  totalText: string;
  note: string;
}

export interface ObservabilityViewModel {
  estimatorId: EstimatorId;
  estimatorLabel: string;
  referenceLabel: string;
  accel: ChannelPanelView;
  mag: ChannelPanelView;
  axis: AxisPanelView;
  note: string;
}

export interface ObservabilityPanelState {
  view: ObservabilityViewModel | null;
}

export interface ObservabilityPanelApi {
  /** 由调用方按自己的 UI 节奏调用（例如 10 Hz）；每次都读取最新快照。 */
  update(): ObservabilityViewModel | null;
  state(): ObservabilityPanelState;
  destroy(): void;
}

const CONSERVATIVE_NOTE =
  "以上只描述本步遥测与当前算法通道；单步拒绝、无效或未记录不构成对传感器故障或完整系统可观性的结论。";

function reasonLabel(code: string | null): string {
  if (code === null) return "无附加原因码";
  return OBSERVATION_REASON_LABELS[code] ?? code;
}

function channelView(
  channel: "accel" | "mag",
  state: ObservationState,
  code: string | null,
  evidence: ObservationEvidence,
): ChannelPanelView {
  // 不把 evidence 再塞进说明句：面板另有“证据”行，避免同一数字重复两次。
  const explanation: ObservationExplanation = {
    channel,
    state,
    reasonCode: code,
    evidence: {},
    explanationKey: `obs.${channel}.${state}`,
  };
  return {
    channel,
    state,
    stateLabel: OBSERVATION_STATE_LABELS[state],
    reasonCode: code,
    reasonLabel: reasonLabel(code),
    evidence: { ...evidence },
    evidenceText: observationEvidenceText(evidence),
    explanation: describeObservation(explanation),
  };
}

function axisDegText(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}°`;
}

/**
 * 纯函数：把一份生产快照变成面板可渲染的数据。
 *
 * 显式遥测状态优先；没有显式字段的旧遥测才使用 conservative fallback。
 * 无真值时 axis 三个数值保持 `null`，不生成 0°。
 */
export function buildObservabilityView(snapshot: ObservabilitySnapshot): ObservabilityViewModel {
  const fallback = explainExistingTelemetry(snapshot.estimatorId, snapshot.telemetry, {
    magEnabled: snapshot.magEnabled,
    gateEnabled: snapshot.gateEnabled,
    relativeTruthQuat: snapshot.relativeTruthQuat,
  });
  const accelState = snapshot.telemetry.accelState ?? fallback.accel.state;
  const magState = snapshot.telemetry.magState ?? fallback.mag.state;
  const accelCode = snapshot.telemetry.accelReasonCode !== undefined
    ? snapshot.telemetry.accelReasonCode
    : fallback.accel.reasonCode;
  const magCode = snapshot.telemetry.magReasonCode !== undefined
    ? snapshot.telemetry.magReasonCode
    : fallback.mag.reasonCode;
  const referenceLabel = snapshot.referenceLabel.trim().length > 0
    ? snapshot.referenceLabel
    : "（未提供参考标签）";
  const axis = fallback.axisErrors ?? null;
  const axisView: AxisPanelView = axis === null
    ? {
        available: false,
        tiltDeg: null,
        yawDeg: null,
        totalDeg: null,
        tiltText: "—",
        yawText: "—",
        totalText: "—",
        note: "无真值，误差分量不可计算。仍显示本步观测接受状态；不使用 0° 或近似值冒充结果。",
      }
    : {
        available: true,
        tiltDeg: axis.tiltDeg,
        yawDeg: axis.yawDeg,
        totalDeg: axis.totalDeg,
        tiltText: axisDegText(axis.tiltDeg),
        yawText: axisDegText(axis.yawDeg),
        totalText: axisDegText(axis.totalDeg),
        note: `相对「${referenceLabel}」的世界系姿态差，按固定世界重力轴 [0,0,1] 分解；倾角与偏航均为非负幅值。`,
      };
  return {
    estimatorId: snapshot.estimatorId,
    estimatorLabel: snapshot.estimatorLabel.trim().length > 0 ? snapshot.estimatorLabel : snapshot.estimatorId,
    referenceLabel,
    accel: channelView("accel", accelState, accelCode, fallback.accel.evidence),
    mag: channelView("mag", magState, magCode, fallback.mag.evidence),
    axis: axisView,
    note: CONSERVATIVE_NOTE,
  };
}

function make(doc: Document, tag: string, className?: string): HTMLElement {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

interface ChannelElements {
  block: HTMLElement;
  badge: HTMLElement;
  reason: HTMLElement;
  evidence: HTMLElement;
  explanation: HTMLElement;
}

function createChannelBlock(doc: Document, title: string): ChannelElements {
  const block = make(doc, "div", "obs-channel");
  const head = make(doc, "div", "obs-channel-head");
  const name = make(doc, "b");
  name.textContent = title;
  const badge = make(doc, "span", "obs-state");
  head.appendChild(name);
  head.appendChild(badge);
  const reason = make(doc, "div", "obs-reason dim");
  const evidence = make(doc, "div", "obs-evidence dim");
  const explanation = make(doc, "p", "obs-explanation");
  block.appendChild(head);
  block.appendChild(reason);
  block.appendChild(evidence);
  block.appendChild(explanation);
  return { block, badge, reason, evidence, explanation };
}

function renderChannel(elements: ChannelElements, view: ChannelPanelView): void {
  elements.badge.textContent = view.stateLabel;
  elements.badge.setAttribute("data-state", view.state);
  elements.reason.textContent = view.reasonCode === null || view.reasonLabel === view.reasonCode
    ? `原因：${view.reasonLabel}`
    : `原因：${view.reasonLabel}（${view.reasonCode}）`;
  elements.evidence.textContent = view.evidenceText.length > 0 ? `证据：${view.evidenceText}` : "证据：—";
  elements.explanation.textContent = view.explanation;
}

export function mountObservabilityPanel(
  root: HTMLElement,
  deps: ObservabilityPanelDeps,
): ObservabilityPanelApi {
  const doc = root.ownerDocument;
  const container = make(doc, "div", "obs-panel");
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "误差来源与可观性");

  const head = make(doc, "div", "obs-head");
  const title = make(doc, "b", "obs-title");
  title.textContent = "误差来源与可观性";
  const estimatorLine = make(doc, "span", "obs-estimator dim");
  head.appendChild(title);
  head.appendChild(estimatorLine);

  const empty = make(doc, "div", "obs-empty dim");
  empty.textContent = "当前没有可显示的估计器。";

  const body = make(doc, "div", "obs-body");
  const axisTitle = make(doc, "b", "obs-axis-title");
  axisTitle.textContent = "分轴误差（相对参考）";
  const axisList = make(doc, "dl", "obs-axis");
  const axisValue = (label: string): HTMLElement => {
    const dt = make(doc, "dt");
    dt.textContent = label;
    const dd = make(doc, "dd");
    dd.textContent = "—";
    axisList.appendChild(dt);
    axisList.appendChild(dd);
    return dd;
  };
  const tiltValue = axisValue("倾角误差");
  const yawValue = axisValue("偏航误差");
  const totalValue = axisValue("总误差");
  const axisNote = make(doc, "p", "obs-axis-note dim");

  const accel = createChannelBlock(doc, "加速度计");
  const mag = createChannelBlock(doc, "磁力计");

  const footer = make(doc, "div", "obs-footer");
  const note = make(doc, "p", "obs-note dim");
  const docsButton = doc.createElement("button");
  docsButton.type = "button";
  docsButton.className = "pt-btn";
  docsButton.textContent = "查看可观性说明";
  docsButton.addEventListener("click", () => deps.openDocs(OBSERVABILITY_DOC_PAGE, OBSERVABILITY_DOC_ANCHOR));
  footer.appendChild(note);
  footer.appendChild(docsButton);

  body.appendChild(axisTitle);
  body.appendChild(axisList);
  body.appendChild(axisNote);
  body.appendChild(accel.block);
  body.appendChild(mag.block);
  body.appendChild(footer);
  container.appendChild(head);
  container.appendChild(empty);
  container.appendChild(body);
  root.appendChild(container);

  let lastView: ObservabilityViewModel | null = null;

  const update = (): ObservabilityViewModel | null => {
    const snapshot = deps.getSnapshot();
    const view = snapshot === null ? null : buildObservabilityView(snapshot);
    lastView = view;
    if (view === null) {
      empty.hidden = false;
      body.hidden = true;
      estimatorLine.textContent = "当前算法：—";
      return null;
    }
    empty.hidden = true;
    body.hidden = false;
    estimatorLine.textContent = `当前算法：${view.estimatorLabel} · 参考：${view.referenceLabel}`;
    tiltValue.textContent = view.axis.tiltText;
    yawValue.textContent = view.axis.yawText;
    totalValue.textContent = view.axis.totalText;
    axisNote.textContent = view.axis.note;
    renderChannel(accel, view.accel);
    renderChannel(mag, view.mag);
    note.textContent = view.note;
    return view;
  };

  update();

  return {
    update,
    state: () => ({ view: lastView }),
    destroy: () => {
      container.remove();
    },
  };
}
