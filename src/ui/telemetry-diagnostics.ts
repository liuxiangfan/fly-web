/**
 * C/D「遥测与诊断」的按需接线服务（单一懒加载入口）。
 *
 * 设计边界（对应 docs/CD-WIRING-DECISION-PLAN.md §3.1）
 * -------------------------------------------------------
 * - **无模块级副作用**：本文件顶层只有类型、常量与函数声明；不创建面板、不建
 *   定时器、不碰全局 DOM。宿主（main）在用户打开遥测/诊断分区时才动态 import
 *   并调用 `createTelemetryDiagnostics` 一次。
 * - 四个面板在同一 root 内建自己的 DOM 宿主；不依赖 index.html 的既有 id。
 * - `EventRecorder` 在服务创建（用户已打开）时创建，但**只有 `sample()` 被调用
 *   才会记录**——本模块内没有任何后台采样。
 * - `ReviewBuffer` 默认不接收帧：`sample()` 仅在 `reviewCapture === true` 时写帧。
 *   回看面板进入回看时通过 deps 回调打开捕获、退出时关闭；也提供显式
 *   `setReviewCapture(on)` 与面板旁的小按钮（否则回看缓冲永远拿不到第一帧）。
 * - ESKF 诊断 sink **默认不挂**：只有用户开启采集（`setEskfEnabled(true)` 或
 *   点击服务自带的按钮）才调 `deps.setKalmanSink`，关闭时恢复 `null`。
 * - `reset(runId)` 与 `sample` 内检测到的轮次切换都会作废旧事件/旧回看帧，保证
 *   runId 隔离；`update()` 只读快照、按宿主节奏（约 10 Hz）刷新，模块内不定时。
 */
import type { ImuSample } from "../core/imu";
import type { Quat, V3 } from "../core/quat";
import { qConj, qMul } from "../core/quat";
import type { EstimatorTelemetry, KalmanStepSnapshot } from "../estimators";
import type { EstimatorId } from "../core/experiment-config";
import type { ReferenceKind } from "../core/data-source";
import { EventRecorder, type RecorderEstimator } from "../core/event-recorder";
import { ReviewBuffer, buildReviewFrame, type ReviewFrame } from "../core/review-buffer";
import { axisErrorView } from "../core/observability";
import { mountObservabilityPanel, type ObservabilitySnapshot } from "./observability-panel";
import { mountEventPanel } from "./event-panel";
import {
  mountReviewPanel,
  type ReviewEvidenceSeekResult,
  type ReviewEvidenceSnapshot,
  type ReviewPanelApi,
} from "./review-panel";
import { mountEskfPanel } from "./eskf-panel";

/** 回看记录下限间隔（约 25 Hz），与曲线采样同网格但保留原始 ctx.t。 */
export const REVIEW_RECORD_DT = 0.04;
export const DEFAULT_EVENT_CAPACITY = 512;
export const DEFAULT_REVIEW_CAPACITY = 750;

export interface TelemetryDiagnosticsSelected {
  id: EstimatorId;
  label: string;
  magEnabled: boolean;
  gateEnabled: boolean;
  telemetry: EstimatorTelemetry;
  q: Quat;
}

export interface TelemetryDiagnosticsTruth {
  kind: ReferenceKind;
  q: Quat | null;
  label: string;
}

/** 事件记录需要的估计器投影；`truth` 只是宿主数组里的参考项，服务会过滤掉。 */
export interface TelemetryDiagnosticsEstimatorSource {
  id: EstimatorId | "truth";
  label?: string;
  telemetry: EstimatorTelemetry;
}

/** 生产侧每个解算子步提交的输入；`dt` 保留给后续扩展，当前不进入回看帧。 */
export interface TelemetryDiagnosticsSample {
  t: number;
  dt: number;
  aligned: boolean;
  raw: ImuSample;
  consumed: { gyro: V3; accel: V3; mag: V3 };
}

export interface TelemetryDiagnosticsDeps {
  root: HTMLElement;
  getSelected(): TelemetryDiagnosticsSelected | null;
  /**
   * 全部估计器（可含 `truth`）。事件记录按“估计器 × 通道”独立归并，必须看到五个算法，
   * 不能只记当前选中项。缺省时回退到 `getSelected()`，保证旧接线仍可用。
   */
  getEstimators?(): readonly TelemetryDiagnosticsEstimatorSource[];
  getTruth(): TelemetryDiagnosticsTruth;
  /** 宿主已采集的 ESKF 快照（服务自身采集为空时的回退来源） */
  getKalmanSnapshot(): KalmanStepSnapshot | null;
  getTime(): number;
  getRunId(): number;
  setCursor(t: number | null): void;
  openDocs(page: string, anchor?: string): void;
  setKalmanSink(sink: ((snap: KalmanStepSnapshot) => void) | null): void;
  /** 可选：让 KalmanEstimator 在同一 update() 内复制完整 6×6 P（diagFullP）。 */
  setKalmanFullMatrix?(on: boolean): void;
}

export interface TelemetryDiagnosticsOptions {
  eventCapacity?: number;
  reviewCapacity?: number;
}

export interface ReviewOverride {
  q: Quat;
  truthQ: Quat | null;
}

export interface TelemetryDiagnosticsState {
  /** 真实解算轮次；换源/重置后推进，不能用动作名冒充隔离证据。 */
  runId: number;
  reviewCapture: boolean;
  eskfEnabled: boolean;
  eskfFullMatrix: boolean;
  eventCount: number;
  reviewFrames: number;
  reviewActive: boolean;
  /** 当前交互中的面板：回看模式优先，其次 ESKF 采集；无则 null。 */
  activePanel: string | null;
}

export interface TelemetryDiagnosticsApi {
  sample(input: TelemetryDiagnosticsSample): void;
  update(): void;
  setReviewCapture(on: boolean): void;
  setEskfEnabled(on: boolean): void;
  /** 显式记录完整 6×6 P；默认关闭，只记录 P 对角。 */
  setEskfFullMatrix(on: boolean): void;
  /** 当前轮次事件副本（按 t/seq 升序），供面板与浏览器核验真实生产事件。 */
  events(): import("../core/event-timeline").LearningEvent[];
  /** 传输层断流边沿：active=true 开始断流，false 恢复。 */
  dataGap(active: boolean, reason?: string): void;
  /** 重连尝试/成功/耗尽：来自真实传输状态机。 */
  dataReconnect(status: "attempt" | "success" | "exhausted", detail?: Record<string, unknown>): void;
  /** 真实用户动作：参数改变、视图切换、实验装载。 */
  userAction(kind: "param-change" | "view-change" | "experiment-load", summary: string, before?: unknown, after?: unknown): void;
  /** 回看面板处于回看模式时返回当前帧；否则 null（宿主据此覆盖场景显示）。 */
  reviewOverride(): ReviewOverride | null;
  /** 回看激活时把选择交给回看控制器（超容差由控制器如实退出）。 */
  seekReview(t: number): void;
  /** 当前证据帧、±0.25 s 真实事件和提示；只读，不依赖 main。 */
  evidence(): ReviewEvidenceSnapshot;
  /** 0=当前 runId 最大有限总误差，±1=前后局部峰值证据点。 */
  seekEvidence(delta: -1 | 0 | 1): ReviewEvidenceSeekResult;
  reset(runId: number): void;
  destroy(): void;
  state(): TelemetryDiagnosticsState;
}

function make(doc: Document, tag: string, className?: string): HTMLElement {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

function makeToggle(doc: Document, className: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = className;
  return button;
}

export function createTelemetryDiagnostics(
  deps: TelemetryDiagnosticsDeps,
  options: TelemetryDiagnosticsOptions = {},
): TelemetryDiagnosticsApi {
  const doc = deps.root.ownerDocument;
  const container = make(doc, "div", "td-root");
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "遥测与诊断");
  const obsHost = make(doc, "div", "td-host td-obs");
  const eventHost = make(doc, "div", "td-host td-events");
  const reviewHost = make(doc, "div", "td-host td-review");
  const eskfHost = make(doc, "div", "td-host td-eskf");
  container.append(obsHost, eventHost, reviewHost, eskfHost);
  deps.root.appendChild(container);

  const eventRecorder = new EventRecorder(options.eventCapacity ?? DEFAULT_EVENT_CAPACITY);
  const reviewBuffer = new ReviewBuffer(options.reviewCapacity ?? DEFAULT_REVIEW_CAPACITY);

  let reviewCapture = false;
  let eskfEnabled = false;
  let eskfFullMatrix = false;
  let reviewSeq = 0;
  let reviewLastT = -Infinity;
  let activeRunId: number | null = null;
  let latestEskf: KalmanStepSnapshot | null = null;
  let latestEskfTime: number | null = null;
  let reviewPanel: ReviewPanelApi;

  const observabilitySnapshot = (): ObservabilitySnapshot | null => {
    const frame = reviewPanel?.frame();
    if (frame) {
      const hasTruth = frame.truth.kind === "groundTruth" || frame.truth.kind === "external";
      const selected = deps.getSelected();
      const sameAlgorithm = selected?.id === frame.estimate.id;
      return {
        estimatorId: frame.estimate.id,
        estimatorLabel: sameAlgorithm ? selected.label : frame.estimate.id,
        telemetry: frame.telemetry,
        relativeTruthQuat: hasTruth && frame.truth.q ? qMul(frame.truth.q, qConj(frame.estimate.q)) : null,
        referenceLabel:
          frame.truth.kind === "groundTruth" ? "真值"
            : frame.truth.kind === "external" ? "外部参考" : "Mahony 基准",
        magEnabled: frame.telemetry.magState !== "disabled" && frame.telemetry.magState !== "not-applicable",
        gateEnabled: sameAlgorithm ? selected.gateEnabled : false,
      };
    }
    const selected = deps.getSelected();
    if (!selected) return null;
    const truth = deps.getTruth();
    const hasTruth = truth.kind === "groundTruth" || truth.kind === "external";
    const relativeTruthQuat = hasTruth && truth.q ? qMul(truth.q, qConj(selected.q)) : null;
    return {
      estimatorId: selected.id,
      estimatorLabel: selected.label,
      telemetry: selected.telemetry,
      relativeTruthQuat,
      referenceLabel: truth.label,
      magEnabled: selected.magEnabled,
      gateEnabled: selected.gateEnabled,
    };
  };

  const observabilityPanel = mountObservabilityPanel(obsHost, {
    getSnapshot: observabilitySnapshot,
    openDocs: (page, anchor) => deps.openDocs(page, anchor),
  });
  const eventPanel = mountEventPanel(eventHost, {
    getTimeline: () => eventRecorder.timeline(),
    seek: (t) => {
      if (reviewPanel?.state().active) reviewPanel.seek(t);
      else deps.setCursor(t);
    },
    openDocs: (page, anchor) => deps.openDocs(page, anchor),
  });
  reviewPanel = mountReviewPanel(reviewHost, {
    getBuffer: () => reviewBuffer,
    getRunId: () => deps.getRunId(),
    getEvents: (runId) => eventRecorder.list({ runId }),
    // 进入回看即开始记录（否则缓冲为空、面板永远进不去）；退出即停止写入。
    enterReview: () => setReviewCapture(true),
    exitReview: () => setReviewCapture(false),
    // 曲线/IMU 游标跟随回看帧时间；退出时清空交还实时游标。
    setCursor: (t) => deps.setCursor(t),
    openDocs: (page, anchor) => deps.openDocs(page, anchor),
  });
  const eskfPanel = mountEskfPanel(eskfHost, {
    getSnapshot: () => {
      const frame = reviewPanel.frame();
      if (frame) return frame.eskf ?? null;
      return latestEskf ?? deps.getKalmanSnapshot();
    },
    getTime: () => {
      const frame = reviewPanel.frame();
      if (frame) return frame.t;
      return latestEskf ? latestEskfTime : deps.getTime();
    },
    openDocs: (page, anchor) => deps.openDocs(page, anchor),
  });

  // 面板挂载时各自 replaceChildren 过宿主，因此按钮在挂载之后再追加，保证保留。
  const captureButton = makeToggle(doc, "td-capture-toggle");
  captureButton.addEventListener("click", () => setReviewCapture(!reviewCapture));
  reviewHost.appendChild(captureButton);
  const eskfButton = makeToggle(doc, "td-eskf-toggle");
  eskfButton.addEventListener("click", () => setEskfEnabled(!eskfEnabled));
  eskfHost.appendChild(eskfButton);
  const fullPButton = makeToggle(doc, "td-eskf-fullp");
  fullPButton.addEventListener("click", () => setEskfFullMatrix(!eskfFullMatrix));
  fullPButton.setAttribute("aria-label", "切换完整 6×6 P 矩阵记录（默认只记对角线）");
  eskfHost.appendChild(fullPButton);

  function updateCaptureUi(): void {
    captureButton.textContent = reviewCapture ? "停止记录回看帧" : "开始记录回看帧";
    captureButton.setAttribute("aria-pressed", reviewCapture ? "true" : "false");
    captureButton.setAttribute(
      "aria-label",
      reviewCapture ? "停止向回看缓冲写入帧" : "开始向回看缓冲写入帧",
    );
  }

  function updateEskfUi(): void {
    eskfButton.textContent = eskfEnabled ? "停止采集单步" : "开始采集单步";
    eskfButton.setAttribute("aria-pressed", eskfEnabled ? "true" : "false");
    eskfButton.setAttribute(
      "aria-label",
      eskfEnabled ? "关闭 ESKF 单步诊断采集" : "开启 ESKF 单步诊断采集",
    );
  }

  function setEskfFullMatrix(on: boolean): void {
    eskfFullMatrix = on;
    deps.setKalmanFullMatrix?.(on);
    fullPButton.textContent = on ? "停止记录完整 P 矩阵" : "记录完整 P 矩阵（6×6）";
    fullPButton.setAttribute("aria-pressed", String(on));
  }

  function setReviewCapture(on: boolean): void {
    reviewCapture = on;
    updateCaptureUi();
  }

  function setEskfEnabled(on: boolean): void {
    if (on === eskfEnabled) {
      updateEskfUi();
      return;
    }
    eskfEnabled = on;
    if (on) {
      deps.setKalmanSink((snap) => {
        latestEskf = snap;
        latestEskfTime = deps.getTime();
      });
    } else {
      deps.setKalmanSink(null);
      latestEskf = null;
      latestEskfTime = null;
    }
    updateEskfUi();
  }

  function buildFrame(
    selected: TelemetryDiagnosticsSelected,
    input: TelemetryDiagnosticsSample,
  ): ReviewFrame | null {
    const truth = deps.getTruth();
    const qTruth = truth.kind === "groundTruth" || truth.kind === "external" ? truth.q : null;
    const rel = qTruth ? qMul(qTruth, qConj(selected.q)) : null;
    const axis = axisErrorView(rel);
    try {
      return buildReviewFrame({
        runId: deps.getRunId(),
        seq: reviewSeq,
        t: input.t,
        truthKind: truth.kind,
        truthQ: qTruth,
        estimateId: selected.id,
        estimateQ: selected.q,
        raw: input.raw,
        consumed: input.consumed,
        telemetry: selected.telemetry,
        totalDeg: axis?.totalDeg ?? null,
        tiltDeg: axis?.tiltDeg ?? null,
        yawDeg: axis?.yawDeg ?? null,
        // ESKF 采集开启时把当前单步快照随帧保存；关闭时不写字段（不是伪造 null）。
        ...(eskfEnabled
          ? {
              eskf:
                latestEskf
                  ? latestEskfTime !== null && Math.abs(latestEskfTime - input.t) <= 1e-6
                    ? latestEskf
                    : null
                  : deps.getKalmanSnapshot(),
            }
          : {}),
      });
    } catch {
      // 非法帧不写入，也不消耗 seq；绝不用占位数据伪造历史。
      return null;
    }
  }

  function isolateRun(runId: number): void {
    eventRecorder.reset(runId);
    reviewBuffer.reset();
    reviewSeq = 0;
    reviewLastT = -Infinity;
    latestEskf = null;
    latestEskfTime = null;
    activeRunId = runId;
  }

  /** 直接事件（非 sample 路径）也要先绑定当前 runId，否则记录器会拒绝。 */
  function ensureEventRun(): void {
    const runId = deps.getRunId();
    if (activeRunId === null) {
      activeRunId = runId;
      eventRecorder.reset(runId);
    } else if (activeRunId !== runId) isolateRun(runId);
  }

  function dataGap(active: boolean, reason?: string): void {
    ensureEventRun();
    eventRecorder.dataGap(deps.getTime(), active, reason);
  }

  function dataReconnect(status: "attempt" | "success" | "exhausted", detail?: Record<string, unknown>): void {
    ensureEventRun();
    eventRecorder.dataReconnect(deps.getTime(), status, detail);
  }

  function userAction(
    kind: "param-change" | "view-change" | "experiment-load",
    summary: string,
    before?: unknown,
    after?: unknown,
  ): void {
    ensureEventRun();
    eventRecorder.userAction(deps.getTime(), kind, summary, before, after);
  }

  function sample(input: TelemetryDiagnosticsSample): void {
    if (!Number.isFinite(input.t)) return;
    const runId = deps.getRunId();
    if (activeRunId === null) activeRunId = runId;
    else if (activeRunId !== runId) isolateRun(runId);

    const selected = deps.getSelected();
    const provided = deps.getEstimators?.();
    const estimators: RecorderEstimator[] = provided
      ? provided
          .filter((estimator) => estimator.id !== "truth")
          .map((estimator) => ({
            id: estimator.id as EstimatorId,
            label: estimator.label,
            telemetry: estimator.telemetry,
          }))
      : selected
        ? [{ id: selected.id, label: selected.label, telemetry: selected.telemetry }]
        : [];
    eventRecorder.sample(
      runId,
      input.t,
      estimators,
      input.aligned ? { aligned: true, referenceKind: deps.getTruth().kind } : {},
    );
    // 传感器削顶只读信号：只在真实削顶分支写入；无该字段表示本帧未削顶。
    eventRecorder.saturation(input.t, input.raw.gyroSaturated === true);

    // 回看默认关闭：关掉时不做任何回看侧分配。
    if (!reviewCapture || !selected) return;
    if (input.t - reviewLastT < REVIEW_RECORD_DT) return;
    const frame = buildFrame(selected, input);
    if (!frame) return;
    reviewBuffer.push(frame);
    reviewSeq++;
    reviewLastT = input.t;
  }

  function update(): void {
    observabilityPanel.update();
    eventPanel.update();
    reviewPanel.update();
    eskfPanel.update();
  }

  function reviewOverride(): ReviewOverride | null {
    const panelState = reviewPanel.state();
    if (!panelState.hasFrame || panelState.t === null) return null;
    const near = reviewBuffer.nearest(panelState.runId, panelState.t);
    if (!near.frame) return null;
    return { q: near.frame.estimate.q, truthQ: near.frame.truth.q };
  }

  function reset(runId: number): void {
    isolateRun(runId);
    update();
  }

  function destroy(): void {
    if (eskfEnabled) {
      eskfEnabled = false;
      deps.setKalmanSink(null);
    }
    latestEskf = null;
    latestEskfTime = null;
    eventRecorder.timeline().clear();
    reviewBuffer.reset();
    observabilityPanel.destroy();
    eventPanel.destroy();
    container.remove();
  }

  function state(): TelemetryDiagnosticsState {
    return {
      runId: deps.getRunId(),
      reviewCapture,
      eskfEnabled,
      eskfFullMatrix,
      eventCount: eventRecorder.timeline().size,
      reviewFrames: reviewBuffer.size,
      reviewActive: reviewPanel.state().active,
      activePanel: reviewPanel.state().active ? "review" : eskfEnabled ? "eskf" : null,
    };
  }

  updateCaptureUi();
  updateEskfUi();
  setEskfFullMatrix(false);

  return {
    sample,
    update,
    setReviewCapture,
    setEskfEnabled,
    setEskfFullMatrix,
    dataGap,
    dataReconnect,
    userAction,
    events: () => eventRecorder.list(),
    reviewOverride,
    seekReview: (t) => reviewPanel.seek(t),
    evidence: () => reviewPanel.evidence(),
    seekEvidence: (delta) => reviewPanel.seekEvidence(delta),
    reset,
    destroy,
    state,
  };
}
