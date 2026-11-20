/**
 * 教学诊断（C/D）的按需控制器。
 *
 * 设计边界
 * --------
 * - 四个功能各自有按钮；**首次点击才加载模块并开始对应采样**，默认路径不分配
 *   事件记录器、回看缓冲或 ESKF 诊断回调。
 * - 本模块不直接 import 任何重模块：`event-recorder`、`review-buffer`、面板与
 *   `observability` 都在用户动作后动态 import。因此它自身可以很小。
 * - 回看只把帧交给宿主做**展示覆盖**，不写回估计器、世界或 INS；ESKF 采集
 *   通过宿主挂/摘 sink，关闭时恢复 undefined。
 * - 事件与回看缓冲都有容量上限；重置/换源由宿主调用 `reset(runId)`。
 */
import type { Estimator } from "../estimators";
import type { EstimatorId } from "../core/experiment-config";
import type { ImuSample } from "../core/imu";
import { qConj, qMul, type Quat, type V3 } from "../core/quat";
import type { ReviewFrame } from "../core/review-buffer";
import type { ObservabilitySnapshot } from "./observability-panel";
import type { KalmanStepSnapshot } from "../estimators";

export interface DiagnosticsDeps {
  /** 当前估计器组（不含 truth） */
  getEstimators(): readonly Estimator[];
  getSelectedEstimator(): Estimator | null;
  getRunId(): number;
  getTime(): number;
  getReference(): { kind: "groundTruth" | "external" | "mahony" | "none"; q: Quat | null; label: string };
  /** 回看帧只作为展示覆盖；null = 返回实时。 */
  setReviewFrame(frame: ReviewFrame | null): void;
  /** 挂/摘 ESKF 诊断 sink；null = 关闭采集。 */
  setEskfSink(sink: ((snap: KalmanStepSnapshot) => void) | null): void;
  openDocs(page: string, anchor?: string): void;
  toast(msg: string, color?: string): void;
}

export interface DiagnosticsApi {
  openObservability(): Promise<void>;
  openEvents(): Promise<void>;
  openReview(): Promise<void>;
  openEskf(): Promise<void>;
  /** 每次生产解算后调用；未开启任何功能时立即返回。 */
  sample(t: number, sample: ImuSample, consumed: { gyro: V3; accel: V3; mag: V3 }, aligned: boolean): void;
  /** 10 Hz 刷新面板。 */
  update(): void;
  reset(runId: number): void;
  state(): {
    observability: boolean;
    events: boolean;
    review: boolean;
    eskf: boolean;
    status: string;
  };
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function host(id: string): HTMLElement {
  const el = $(id);
  if (!el) throw new Error(`缺少诊断容器 #${id}`);
  return el;
}

function setPressed(id: string, on: boolean): void {
  $(id)?.setAttribute("aria-pressed", on ? "true" : "false");
}

export function createDiagnosticsController(deps: DiagnosticsDeps): DiagnosticsApi {
  let observabilityPanel: import("./observability-panel").ObservabilityPanelApi | null = null;
  let eventPanel: import("./event-panel").EventPanelApi | null = null;
  let reviewPanel: import("./review-panel").ReviewPanelApi | null = null;
  let eskfPanel: import("./eskf-panel").EskfPanelApi | null = null;
  let eventRecorder: import("../core/event-recorder").EventRecorder | null = null;
  let reviewBuffer: import("../core/review-buffer").ReviewBuffer | null = null;
  let buildFrame: typeof import("../core/review-buffer").buildReviewFrame | null = null;
  let axisErrors: typeof import("../core/observability").axisErrorView | null = null;
  let reviewRecording = false;
  let reviewSeq = 0;
  let lastReviewT = -Infinity;
  let latestSnapshot: KalmanStepSnapshot | null = null;
  let status = "未开启任何诊断：实时路径不记录事件、回看帧或 ESKF 快照。";

  const setStatus = (text: string): void => {
    status = text;
    const el = $("diag-status");
    if (el) el.textContent = text;
  };

  async function openObservability(): Promise<void> {
    if (!observabilityPanel) {
      const [ui, obs] = await Promise.all([import("./observability-panel"), import("../core/observability-axis")]);
      axisErrors = obs.axisErrorView;
      observabilityPanel = ui.mountObservabilityPanel(host("diag-obs-host"), {
        getSnapshot: (): ObservabilitySnapshot | null => {
          const est = deps.getSelectedEstimator();
          if (!est) return null;
          const ref = deps.getReference();
          const hasTruth = ref.kind === "groundTruth" || ref.kind === "external";
          const rel = hasTruth && ref.q ? qMul(ref.q, qConj(est.q)) : null;
          return {
            estimatorId: est.id as EstimatorId,
            estimatorLabel: est.label,
            telemetry: est.telemetry,
            relativeTruthQuat: rel,
            referenceLabel: ref.label,
            magEnabled: est.magEnabled,
            gateEnabled: est.id === "comp" || est.id === "mahony" || est.id === "madg"
              ? Boolean((est as Estimator & { accelGate?: boolean }).accelGate)
              : false,
          };
        },
        openDocs: deps.openDocs,
      });
      setPressed("btn-diag-obs", true);
      setStatus("误差与可观性已开启：显示当前算法的观测状态与分轴误差。");
    }
    observabilityPanel.update();
  }

  async function openEvents(): Promise<void> {
    if (!eventRecorder) {
      const [rec, ui] = await Promise.all([import("../core/event-recorder"), import("./event-panel")]);
      eventRecorder = new rec.EventRecorder(512);
      eventPanel = ui.mountEventPanel(host("diag-events-host"), {
        getTimeline: () => {
          if (!eventRecorder) throw new Error("事件记录器未初始化");
          return eventRecorder.timeline();
        },
        seek: () => { /* 由宿主曲线游标联动；当前面板只显示事件列表。 */ },
        openDocs: deps.openDocs,
      });
      setPressed("btn-diag-events", true);
      setStatus("事件时间轴已开启：从现在起记录门控、粗对准等状态边沿（不回溯开启前）。");
    }
    eventPanel?.update();
  }

  async function openReview(): Promise<void> {
    if (!reviewBuffer) {
      const [rb, ui] = await Promise.all([import("../core/review-buffer"), import("./review-panel")]);
      reviewBuffer = new rb.ReviewBuffer(750);
      buildFrame = rb.buildReviewFrame;
      reviewPanel = ui.mountReviewPanel(host("diag-review-host"), {
        getBuffer: () => reviewBuffer as import("../core/review-buffer").ReviewBuffer,
        getRunId: () => deps.getRunId(),
        enterReview: (frame) => deps.setReviewFrame(frame),
        exitReview: () => deps.setReviewFrame(null),
        openDocs: deps.openDocs,
      });
      reviewRecording = true;
      setPressed("btn-diag-review", true);
      setStatus("历史回看已开启：从现在起按 25 Hz 记录有界帧；点「回看模式」查看最近帧。");
    }
    reviewPanel?.update();
  }

  async function openEskf(): Promise<void> {
    if (!eskfPanel) {
      const ui = await import("./eskf-panel");
      eskfPanel = ui.mountEskfPanel(host("diag-eskf-host"), {
        getSnapshot: () => latestSnapshot,
        getTime: () => deps.getTime(),
        openDocs: deps.openDocs,
      });
      deps.setEskfSink((snap) => { latestSnapshot = snap; });
      setPressed("btn-diag-eskf", true);
      setStatus("ESKF 单步解剖已开启：暂停/单步后查看最近一次真实更新；关闭采集会恢复默认路径。");
    }
    eskfPanel.update();
  }

  function sample(t: number, sample: ImuSample, consumed: { gyro: V3; accel: V3; mag: V3 }, aligned: boolean): void {
    if (!eventRecorder && !reviewRecording) return;
    if (eventRecorder) {
      eventRecorder.sample(
        deps.getRunId(),
        t,
        deps.getEstimators()
          .filter((e) => e.id !== "truth")
          .map((e) => ({ id: e.id as EstimatorId, telemetry: e.telemetry })),
        { aligned },
      );
    }
    if (reviewRecording && reviewBuffer && buildFrame && axisErrors) {
      if (t - lastReviewT < 0.04) return;
      lastReviewT = t;
      const est = deps.getSelectedEstimator();
      if (!est) return;
      const ref = deps.getReference();
      const qTruth = ref.kind === "groundTruth" || ref.kind === "external" ? ref.q : null;
      const rel = qTruth ? qMul(qTruth, qConj(est.q)) : null;
      const axis = axisErrors(rel);
      reviewBuffer.push(buildFrame({
        runId: deps.getRunId(),
        seq: reviewSeq++,
        t,
        truthKind: ref.kind,
        truthQ: qTruth,
        estimateId: est.id as EstimatorId,
        estimateQ: est.q,
        raw: sample,
        consumed,
        telemetry: est.telemetry,
        totalDeg: axis?.totalDeg ?? null,
        tiltDeg: axis?.tiltDeg ?? null,
        yawDeg: axis?.yawDeg ?? null,
      }));
    }
  }

  return {
    openObservability,
    openEvents,
    openReview,
    openEskf,
    sample,
    update(): void {
      observabilityPanel?.update();
      eventPanel?.update();
      reviewPanel?.update();
      eskfPanel?.update();
    },
    reset(runId: number): void {
      eventRecorder?.reset(runId);
      reviewBuffer?.reset();
      reviewSeq = 0;
      lastReviewT = -Infinity;
      deps.setReviewFrame(null);
      reviewPanel?.update();
    },
    state: () => ({
      observability: observabilityPanel !== null,
      events: eventRecorder !== null,
      review: reviewRecording,
      eskf: eskfPanel !== null,
      status,
    }),
  };
}
