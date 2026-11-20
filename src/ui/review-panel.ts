/**
 * F-06 历史回看的 DOM 装配层（按需加载模块）。
 *
 * 边界
 * ----
 * - 本模块只读 `ReviewBuffer`，并把选中的真实帧交给 `deps.enterReview(frame)`；
 *   它不写回估计器、世界、INS 或统计，也不从当前状态反向积分。
 * - `enterReview` 的调用方负责只读场景覆盖；`exitReview` 后调用方恢复实时显示。
 * - 没有帧、容差外无帧、旧 runId 帧一律不启用，不用相邻帧或模型姿态假装成历史帧。
 * - 两个纯函数（controller / HTML）与 DOM 装配分开，契约测试可在 Node 端直接运行。
 */
import {
  DEFAULT_NEAREST_TOLERANCE_SEC,
  buildReviewFrame,
  type ReviewBuffer,
  type ReviewFrame,
} from "../core/review-buffer";
import { DEG, qToEuler, type Quat, type V3 } from "../core/quat";
import { escapeHtml } from "../core/html-escape";
import type { LearningEvent } from "../core/event-timeline";
import { OBSERVATION_STATE_LABELS } from "./observability-panel";
import { ESTIMATOR_LABELS } from "./estimator-labels";

export interface ReviewPanelDeps {
  getBuffer(): ReviewBuffer;
  getRunId(): number;
  /** 当前轮真实事件；只用于证据帧 ±0.25 s 的只读窗口。 */
  getEvents?(runId: number): readonly LearningEvent[];
  /** 调用方持有只读场景覆盖；面板只传真实帧，不返回任何可写状态。 */
  enterReview(frame: ReviewFrame): void;
  exitReview(): void;
  /**
   * 曲线/IMU 游标同步：进入回看时定位到帧时间，退出时清空交还实时游标。
   * 省略时只覆盖 3D 与面板文本（旧行为）。
   */
  setCursor?(t: number | null): void;
  openDocs?(page: string, anchor?: string): void;
}

export interface ReviewPanelState {
  active: boolean;
  t: number | null;
  runId: number;
  hasFrame: boolean;
  note: string;
}

export const REVIEW_EVENT_WINDOW_SEC = 0.25;

export interface ReviewEvidenceSnapshot {
  runId: number;
  /** 当前证据帧的隔离副本；未进入回看或跨 runId 时为 null。 */
  frame: ReviewFrame | null;
  /** 当前帧 [t-0.25, t+0.25] 内、同 runId 的真实事件副本。 */
  events: LearningEvent[];
  note: string;
}

export interface ReviewEvidenceSeekResult extends ReviewEvidenceSnapshot {
  /** 是否实际选择并 enterReview 了一帧；边界停住与失败均为 false。 */
  moved: boolean;
}

export interface ReviewPanelApi {
  update(): void;
  prev(): void;
  next(): void;
  toggle(): void;
  /**
   * F-06 联动入口：把游标定位到给定数据时间（曲线 / 事件点击时用）。
   * 超出 `DEFAULT_NEAREST_TOLERANCE_SEC` 时不伪造帧。
   */
  seek(t: number): void;
  /** 0=当前最大有限总误差，±1=前后严格局部峰值证据点。 */
  seekEvidence(delta: -1 | 0 | 1): ReviewEvidenceSeekResult;
  /** 当前证据帧、真实窗口事件与提示的隔离快照；不改变任何状态。 */
  evidence(): ReviewEvidenceSnapshot;
  /** 当前回看帧（只读）；未激活或无帧返回 null。 */
  frame(): ReviewFrame | null;
  state(): ReviewPanelState;
}

const LIVE_NOTE = "实时模式：点击「回看模式」从最近一帧开始。";
const NO_FRAME_HINT = "没有可显示的回看帧；不会用相邻帧或模型姿态代替。";

const TRUTH_KIND_LABELS: Record<ReviewFrame["truth"]["kind"], string> = {
  groundTruth: "模拟真值",
  external: "外部真值",
  mahony: "Mahony 基准",
  none: "无真值",
};


function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "不可用";
}

function fmtVec(value: V3, digits = 3): string {
  return `[${value.map((item) => fmt(item, digits)).join(", ")}]`;
}

function quatText(q: Quat): string {
  return `w=${fmt(q.w, 4)}, x=${fmt(q.x, 4)}, y=${fmt(q.y, 4)}, z=${fmt(q.z, 4)}`;
}

function errorText(value: number | null): string {
  return value === null ? "不可用" : `${fmt(value, 2)} °`;
}

function acceptedText(value: boolean | undefined): string {
  if (value === undefined) return "未记录";
  return value ? "是" : "否";
}


/**
 * 优先显示估计器给出的显式 `accelState/magState`（固定增益算法也有该字段），
 * 只有旧遥测缺状态时才回退到 `accelAccepted/magAccepted`；原因码始终随之显示。
 */
function observationText(
  state: ReviewFrame["telemetry"]["accelState"],
  accepted: boolean | undefined,
  reasonCode: string | null | undefined,
): string {
  const label =
    state !== undefined
      ? OBSERVATION_STATE_LABELS[state]
      : accepted === undefined
        ? "未记录"
        : accepted
          ? "已应用"
          : "未应用";
  const reason = reasonCode ? `（原因：${escapeHtml(reasonCode)}）` : "";
  return label + reason;
}

function noFrameNote(runId: number): string {
  return `运行 #${runId} 还没有可回看的帧；先让实时仿真运行一会儿再进入回看。`;
}

function frameIndex(list: readonly ReviewFrame[], frame: ReviewFrame): number {
  return list.findIndex((item) => item.seq === frame.seq && item.t === frame.t);
}

function copyReviewFrame(source: ReviewFrame): ReviewFrame {
  return buildReviewFrame({
    runId: source.runId,
    seq: source.seq,
    t: source.t,
    truthKind: source.truth.kind,
    truthQ: source.truth.q,
    estimateId: source.estimate.id,
    estimateQ: source.estimate.q,
    raw: source.input.raw,
    consumed: source.input.consumed,
    telemetry: source.telemetry,
    totalDeg: source.errors.totalDeg,
    tiltDeg: source.errors.tiltDeg,
    yawDeg: source.errors.yawDeg,
    ...(source.eskf !== undefined ? { eskf: source.eskf } : {}),
  });
}

function copyEventData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyEventData);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, copyEventData(item)]),
    );
  }
  return value;
}

function copyEvent(event: LearningEvent): LearningEvent {
  return {
    ...event,
    ...(event.before !== undefined ? { before: copyEventData(event.before) } : {}),
    ...(event.after !== undefined ? { after: copyEventData(event.after) } : {}),
  };
}

function selectEvidence(list: readonly ReviewFrame[]): {
  valid: ReviewFrame[];
  maximum: ReviewFrame | null;
  points: ReviewFrame[];
} {
  const valid = list.filter((frame) => Number.isFinite(frame.errors.totalDeg));
  let maximum: ReviewFrame | null = null;
  for (const frame of valid) {
    if (!maximum || frame.errors.totalDeg! > maximum.errors.totalDeg!) maximum = frame;
  }
  const points = valid.filter((frame, index) => {
    if (index === 0 || index === valid.length - 1) return false;
    return (
      frame.errors.totalDeg! > valid[index - 1].errors.totalDeg! &&
      frame.errors.totalDeg! > valid[index + 1].errors.totalDeg!
    );
  });
  if (maximum && !points.some((frame) => frame.seq === maximum!.seq && frame.t === maximum!.t)) {
    points.push(maximum);
    points.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }
  return { valid, maximum, points };
}

/**
 * 回看状态机（无 DOM）。所有帧都来自 `deps.getBuffer()`；本函数只做选择与通知。
 */
export function createReviewPanelController(deps: ReviewPanelDeps): ReviewPanelApi {
  let active = false;
  let frame: ReviewFrame | null = null;
  let runId = deps.getRunId();
  let note = LIVE_NOTE;

  const enter = (next: ReviewFrame, message: string): void => {
    active = true;
    frame = next;
    runId = next.runId;
    note = message;
    deps.enterReview(next);
    // 曲线/IMU 游标跟随回看帧时间；退出时清空交还实时游标。
    deps.setCursor?.(next.t);
  };

  const deactivate = (message: string): void => {
    const wasActive = active;
    active = false;
    frame = null;
    note = message;
    runId = deps.getRunId();
    if (wasActive) {
      deps.exitReview();
      deps.setCursor?.(null);
    }
  };

  const ensureSameRun = (): boolean => {
    const current = deps.getRunId();
    if (frame && current !== frame.runId) {
      const oldRun = frame.runId;
      deactivate(`运行已切换（#${oldRun} → #${current}），旧回看帧已失效，已返回实时。`);
      return false;
    }
    runId = current;
    return true;
  };

  const start = (): void => {
    const current = deps.getRunId();
    runId = current;
    const latest = deps.getBuffer().latest(current);
    if (!latest || latest.runId !== current) {
      active = false;
      frame = null;
      note = noFrameNote(current);
      return;
    }
    enter(
      latest,
      `正在回看历史：t=${fmt(latest.t)} s（运行 #${current}），实时仿真仍在后台推进。`,
    );
  };

  const move = (delta: -1 | 1): void => {
    if (!active || !frame) {
      note = "尚未进入回看模式或当前没有回看帧。";
      return;
    }
    if (!ensureSameRun()) return;
    const currentFrame = frame;
    const list = deps.getBuffer().list(currentFrame.runId);
    let index = frameIndex(list, currentFrame);
    if (index < 0) {
      const near = deps.getBuffer().nearest(
        currentFrame.runId,
        currentFrame.t,
        DEFAULT_NEAREST_TOLERANCE_SEC,
      );
      if (!near.frame) {
        deactivate(
          `当前回看帧已不在缓冲中（t=${fmt(currentFrame.t)} s，容差 ±${DEFAULT_NEAREST_TOLERANCE_SEC.toFixed(3)} s）；已返回实时，不会伪造帧。`,
        );
        return;
      }
      index = frameIndex(list, near.frame);
      if (index < 0) {
        deactivate(`当前回看帧已不在缓冲中（t=${fmt(currentFrame.t)} s）；已返回实时。`);
        return;
      }
    }

    const targetIndex = index + delta;
    if (targetIndex < 0) {
      note = `已到最早一帧（t=${fmt(currentFrame.t)} s）。`;
      return;
    }
    if (targetIndex >= list.length) {
      note = `已到最新一帧（t=${fmt(currentFrame.t)} s）。`;
      return;
    }
    const target = list[targetIndex];
    enter(
      target,
      `${delta < 0 ? "上一帧" : "下一帧"}：t=${fmt(target.t)} s（第 ${targetIndex + 1} / ${list.length} 帧）。`,
    );
  };

  const evidence = (): ReviewEvidenceSnapshot => {
    const current = deps.getRunId();
    if (!active || !frame) return { runId: current, frame: null, events: [], note };
    if (frame.runId !== current) {
      return {
        runId: current,
        frame: null,
        events: [],
        note: `运行已切换（#${frame.runId} → #${current}），旧证据帧已失效。`,
      };
    }
    const selected = frame;
    const events = (deps.getEvents?.(current) ?? [])
      .filter(
        (event) =>
          event.runId === current &&
          Number.isFinite(event.t) &&
          Math.abs(event.t - selected.t) <= REVIEW_EVENT_WINDOW_SEC,
      )
      .sort((a, b) => a.t - b.t || a.seq - b.seq)
      .map(copyEvent);
    return { runId: current, frame: copyReviewFrame(selected), events, note };
  };

  const seekEvidence = (delta: -1 | 0 | 1): ReviewEvidenceSeekResult => {
    const current = deps.getRunId();
    let prefix = "";
    if (active && frame && frame.runId !== current) {
      prefix = `运行已切换（#${frame.runId} → #${current}）；`;
      deactivate(prefix + "旧证据帧已失效，已返回实时。");
    }
    runId = current;
    if (delta !== 0 && (!active || !frame)) {
      note = prefix + "尚未选择证据帧；请先点击「最大误差」。";
      return { moved: false, ...evidence() };
    }

    const list = deps.getBuffer().list(current);
    const selection = selectEvidence(list);
    if (!selection.maximum) {
      note = prefix + (list.length === 0
        ? `运行 #${current} 还没有可回看的帧；无法跳到最大误差点。`
        : `运行 #${current} 的回看帧无真值或没有可用的有限总误差（frame.errors.totalDeg）；不能伪造误差点。`);
      return { moved: false, ...evidence() };
    }

    if (delta === 0) {
      const maximum = selection.maximum;
      enter(
        maximum,
        `${prefix}已跳到当前最大误差点：t=${fmt(maximum.t)} s · 总误差 ${fmt(maximum.errors.totalDeg!, 2)} °（运行 #${current}）。`,
      );
      return { moved: true, ...evidence() };
    }

    const currentFrame = frame!;
    const points = selection.points;
    let index = frameIndex(points, currentFrame);
    let targetIndex: number;
    if (index >= 0) {
      targetIndex = index + delta;
    } else if (delta < 0) {
      targetIndex = -1;
      for (let i = 0; i < points.length; i++) {
        if (points[i].t < currentFrame.t || (points[i].t === currentFrame.t && points[i].seq < currentFrame.seq)) {
          targetIndex = i;
        }
      }
    } else {
      targetIndex = points.findIndex(
        (point) => point.t > currentFrame.t || (point.t === currentFrame.t && point.seq > currentFrame.seq),
      );
      if (targetIndex < 0) targetIndex = points.length;
    }

    if (targetIndex < 0) {
      note = `已到最早的证据点（当前 t=${fmt(currentFrame.t)} s）。`;
      return { moved: false, ...evidence() };
    }
    if (targetIndex >= points.length) {
      note = `已到最新的证据点（当前 t=${fmt(currentFrame.t)} s）。`;
      return { moved: false, ...evidence() };
    }
    const target = points[targetIndex];
    index = targetIndex;
    enter(
      target,
      `${delta < 0 ? "上一证据点" : "下一证据点"}：t=${fmt(target.t)} s · 总误差 ${fmt(target.errors.totalDeg!, 2)} °（第 ${index + 1} / ${points.length} 点）。`,
    );
    return { moved: true, ...evidence() };
  };

  return {
    update(): void {
      const current = deps.getRunId();
      if (!active || !frame) {
        runId = current;
        const latest = deps.getBuffer().latest(current);
        note = latest && latest.runId === current ? LIVE_NOTE : noFrameNote(current);
        return;
      }
      if (!ensureSameRun()) return;

      const currentFrame = frame;
      const near = deps.getBuffer().nearest(
        currentFrame.runId,
        currentFrame.t,
        DEFAULT_NEAREST_TOLERANCE_SEC,
      );
      if (!near.frame) {
        deactivate(
          `t=${fmt(currentFrame.t)} s 处已无回看帧（容差 ±${DEFAULT_NEAREST_TOLERANCE_SEC.toFixed(3)} s）；已返回实时，不会用相邻帧冒充。`,
        );
        return;
      }
      if (near.frame.runId !== currentFrame.runId || near.frame.seq !== currentFrame.seq) {
        enter(
          near.frame,
          `原帧已被缓冲覆盖，改用容差内最近帧 t=${fmt(near.frame.t)} s（Δt=${fmt(near.actualDt ?? 0)} s）。`,
        );
      } else {
        frame = near.frame;
        runId = current;
      }
    },

    prev(): void {
      move(-1);
    },

    next(): void {
      move(1);
    },

    toggle(): void {
      if (active) deactivate("已返回实时：显示最新生产状态。");
      else start();
    },

    seek(t: number): void {
      if (!Number.isFinite(t)) {
        note = "定位时间必须是有限数值。";
        return;
      }
      if (active && frame && !ensureSameRun()) return;

      const current = deps.getRunId();
      const near = deps.getBuffer().nearest(current, t, DEFAULT_NEAREST_TOLERANCE_SEC);
      if (!near.frame) {
        const message =
          `t=${fmt(t)} s 附近没有回看帧（容差 ±${DEFAULT_NEAREST_TOLERANCE_SEC.toFixed(3)} s）；不会伪造帧。`;
        if (active) deactivate(`${message}已返回实时。`);
        else {
          runId = current;
          note = message;
        }
        return;
      }
      enter(
        near.frame,
        `已定位到 t=${fmt(near.frame.t)} s（请求 ${fmt(t)} s，Δt=${fmt(near.actualDt ?? 0)} s）。`,
      );
    },

    seekEvidence,

    evidence,

    frame(): ReviewFrame | null {
      return active ? frame : null;
    },

    state(): ReviewPanelState {
      return {
        active,
        t: frame ? frame.t : null,
        runId,
        hasFrame: active && frame !== null,
        note,
      };
    },
  };
}

/**
 * 一帧回看数据的纯 HTML。`note` 与所有外部字符串都转义；
 * `truth.q=null` 时只写“无真值”，不渲染真值姿态。
 */
export function reviewPanelBodyHtml(
  frame: ReviewFrame | null,
  note: string,
  events: readonly LearningEvent[] = [],
): string {
  const status = `<p class="review-note dim">${escapeHtml(note)}</p>`;
  if (!frame) return `${status}<p class="dim">${NO_FRAME_HINT}</p>`;

  const eventHtml = events.length
    ? `<ol>${events
        .map(
          (event) =>
            `<li class="mono"><b>${escapeHtml(event.kind)}</b> · t=${fmt(event.t)} s<br>` +
            `${escapeHtml(event.summary)}</li>`,
        )
        .join("")}</ol>`
    : `<p class="dim">该窗口无已记录事件。</p>`;
  const evidenceFacts =
    `<section class="review-block" data-review-block="evidence-facts">` +
    `<h4>证据事实</h4>` +
    `<p class="mono">运行 #${frame.runId} · seq ${frame.seq} · t=${fmt(frame.t)} s · ` +
    `总误差 ${errorText(frame.errors.totalDeg)}</p>` +
    `<p>前后 ±0.25 s 窗口 [${fmt(frame.t - REVIEW_EVENT_WINDOW_SEC)}, ${fmt(frame.t + REVIEW_EVENT_WINDOW_SEC)}] s：</p>` +
    eventHtml +
    `</section>`;
  const explanation =
    `<section class="review-block" data-review-block="evidence-explanation">` +
    `<h4>保守解释</h4>` +
    `<p>总误差只在与有效真值比较时可用；误差尖峰与窗口事件相邻不等于因果，不据此判断故障根因。` +
    `请结合下方原始输入、实际消费、遥测与 ESKF 同帧记录人工核对。</p>` +
    `<p class="dim">证据点算法：按 (t, seq) 排序，排除 totalDeg 为 null、NaN 或 Infinity 的帧，` +
    `取比前后有效邻帧都大的严格局部峰值，并始终加入全局最大误差点。</p>` +
    `<p class="dim">观测与门控的既有说明可通过「解读文档」打开。</p>` +
    `</section>`;

  const truthKind = TRUTH_KIND_LABELS[frame.truth.kind];
  const truth = frame.truth.q
    ? `真值四元数：${quatText(frame.truth.q)}（世界系←机体系）`
    : `无真值四元数（${truthKind}）；不渲染真值幻影。`;
  const euler = qToEuler(frame.estimate.q);
  const times = frame.input.raw.times
    ? `<p class="dim">通道时间戳：陀螺 ${fmt(frame.input.raw.times.gyro)} s · ` +
      `加计 ${fmt(frame.input.raw.times.accel)} s · 磁 ${fmt(frame.input.raw.times.mag)} s</p>`
    : `<p class="dim">通道时间戳：未记录（透传快路径，不补成当前时间）。</p>`;

  return (
    status +
    evidenceFacts +
    explanation +
    `<section class="review-block" data-review-block="frame">` +
    `<h4>帧</h4>` +
    `<p class="mono">运行 #${frame.runId} · seq ${frame.seq} · t=${fmt(frame.t)} s</p>` +
    `</section>` +
    `<section class="review-block" data-review-block="truth">` +
    `<h4>真值</h4>` +
    `<p>参考类型：${escapeHtml(truthKind)}（${escapeHtml(frame.truth.kind)}）</p>` +
    `<p class="mono">${truth}</p>` +
    `</section>` +
    `<section class="review-block" data-review-block="estimate">` +
    `<h4>当前算法姿态</h4>` +
    `<p>算法：${escapeHtml(ESTIMATOR_LABELS[frame.estimate.id])}（${escapeHtml(frame.estimate.id)}）</p>` +
    `<p class="mono">四元数：${quatText(frame.estimate.q)}（世界系←机体系）</p>` +
    `<p class="mono">欧拉角（ZYX，°）：横滚 ${fmt(euler.roll * DEG, 2)} · ` +
    `俯仰 ${fmt(euler.pitch * DEG, 2)} · 偏航 ${fmt(euler.yaw * DEG, 2)}</p>` +
    `</section>` +
    `<section class="review-block" data-review-block="errors">` +
    `<h4>误差</h4>` +
    `<p class="mono">总误差 ${errorText(frame.errors.totalDeg)} · ` +
    `倾角 ${errorText(frame.errors.tiltDeg)} · 偏航 ${errorText(frame.errors.yawDeg)}</p>` +
    `</section>` +
    `<section class="review-block" data-review-block="input">` +
    `<h4>输入（原始 / 实际消费）</h4>` +
    `<p class="mono"><b>原始</b> 陀螺 ${fmtVec(frame.input.raw.gyro)} rad/s · ` +
    `加计 ${fmtVec(frame.input.raw.accel)} m/s² · 磁 ${fmtVec(frame.input.raw.mag)} μT</p>` +
    `<p class="mono"><b>实际消费</b> 陀螺 ${fmtVec(frame.input.consumed.gyro)} rad/s · ` +
    `加计 ${fmtVec(frame.input.consumed.accel)} m/s² · 磁 ${fmtVec(frame.input.consumed.mag)} μT</p>` +
    times +
    `</section>` +
    `<section class="review-block" data-review-block="telemetry">` +
    `<h4>遥测</h4>` +
    `<p class="mono">修正角速度 correction：${fmtVec(frame.telemetry.correction)} rad/s（机体系）</p>` +
    `<p class="mono">算法总角速度 rate：${fmtVec(frame.telemetry.rate)} rad/s · ` +
    `原始陀螺 rawGyro：${fmtVec(frame.telemetry.rawGyro)} rad/s</p>` +
    `<p class="mono">加计模长 ${fmt(frame.telemetry.accelNorm, 2)} m/s² · ` +
    `加计有效 ${acceptedText(frame.telemetry.accelValid)} · ` +
    `磁有效 ${acceptedText(frame.telemetry.magValid)}</p>` +
    `<p class="mono">加计观测状态 ${observationText(frame.telemetry.accelState, frame.telemetry.accelAccepted, frame.telemetry.accelReasonCode)} · ` +
    `磁观测状态 ${observationText(frame.telemetry.magState, frame.telemetry.magAccepted, frame.telemetry.magReasonCode)}</p>` +
    `</section>`
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function makeButton(doc: Document, label: string, action: string): HTMLButtonElement {
  const button = element(doc, "button", "btn");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("data-review-action", action);
  return button;
}

/**
 * 把回看面板挂到调用方给的容器里。UI 只在第一次加载本模块时创建。
 */
export function mountReviewPanel(root: HTMLElement, deps: ReviewPanelDeps): ReviewPanelApi {
  const doc = root.ownerDocument;
  const wrap = element(doc, "div", "review-panel");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "历史回看");

  const head = element(doc, "div", "review-head btn-row");
  const toggleButton = makeButton(doc, "回看模式", "toggle");
  const evidenceMaxButton = makeButton(doc, "最大误差", "evidence-max");
  const evidencePrevButton = makeButton(doc, "上一证据", "evidence-prev");
  const evidenceNextButton = makeButton(doc, "下一证据", "evidence-next");
  const prevButton = makeButton(doc, "上一帧", "prev");
  const nextButton = makeButton(doc, "下一帧", "next");
  const exitButton = makeButton(doc, "返回实时", "exit");
  const docsButton = makeButton(doc, "解读文档", "docs");
  toggleButton.setAttribute("aria-pressed", "false");
  head.append(
    toggleButton,
    evidenceMaxButton,
    evidencePrevButton,
    evidenceNextButton,
    prevButton,
    nextButton,
    exitButton,
    docsButton,
  );

  const status = element(doc, "p", "review-status dim");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const body = element(doc, "div", "review-body");
  // 状态提示已在正文里渲染一次；这里只作为 aria-live 播报出口，避免视觉重复。
  status.hidden = true;
  body.setAttribute("role", "status");
  body.setAttribute("aria-live", "polite");
  wrap.append(head, status, body);
  root.replaceChildren(wrap);

  // 面板自己保留最后交给场景的帧，仅用于渲染；状态机仍是唯一的选择来源。
  let lastFrame: ReviewFrame | null = null;
  const controller = createReviewPanelController({
    ...deps,
    enterReview(next: ReviewFrame): void {
      lastFrame = next;
      deps.enterReview(next);
    },
    exitReview(): void {
      lastFrame = null;
      deps.exitReview();
    },
  });

  const render = (): void => {
    const state = controller.state();
    toggleButton.textContent = state.active ? "实时" : "回看模式";
    toggleButton.setAttribute("aria-pressed", state.active ? "true" : "false");
    toggleButton.setAttribute(
      "aria-label",
      state.active ? "退出回看，回到实时模式" : "进入历史回看模式",
    );
    evidencePrevButton.disabled = !state.hasFrame;
    evidenceNextButton.disabled = !state.hasFrame;
    prevButton.disabled = !state.hasFrame;
    nextButton.disabled = !state.hasFrame;
    exitButton.disabled = !state.active;
    docsButton.disabled = !state.hasFrame || !deps.openDocs;
    const evidence = controller.evidence();
    body.innerHTML = reviewPanelBodyHtml(
      state.hasFrame ? lastFrame : null,
      state.note,
      evidence.events,
    );
  };

  const api: ReviewPanelApi = {
    update(): void {
      controller.update();
      render();
    },
    prev(): void {
      controller.prev();
      render();
    },
    next(): void {
      controller.next();
      render();
    },
    toggle(): void {
      controller.toggle();
      render();
    },
    seek(t: number): void {
      controller.seek(t);
      render();
    },
    seekEvidence(delta: -1 | 0 | 1) {
      const result = controller.seekEvidence(delta);
      render();
      return result;
    },
    evidence: () => controller.evidence(),
    frame: () => controller.frame(),
    state: () => controller.state(),
  };

  toggleButton.addEventListener("click", () => api.toggle());
  evidenceMaxButton.addEventListener("click", () => api.seekEvidence(0));
  evidencePrevButton.addEventListener("click", () => api.seekEvidence(-1));
  evidenceNextButton.addEventListener("click", () => api.seekEvidence(1));
  prevButton.addEventListener("click", () => api.prev());
  nextButton.addEventListener("click", () => api.next());
  exitButton.addEventListener("click", () => api.toggle());
  docsButton.addEventListener("click", () => deps.openDocs?.("math", "m-observability"));

  api.update();
  return api;
}
