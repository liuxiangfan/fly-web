/**
 * F-07 ESKF 单步内部解剖的 DOM 装配层（按需加载模块）。
 *
 * 边界
 * ----
 * - 只渲染 `KalmanStepSnapshot` 的只读数值，不在界面里重算姿态、增益或协方差；
 * - 加计 / 磁观测严格按生产顺序 `observations[0]`、`[1]` 展示，不交换、不合并；
 * - 门控拒绝或 S 奇异时数组为 null：显示“未产生”，绝不以 0 代替；
 * - 没有快照时明确写“当前步未记录内部快照”，不拿下一帧或相邻帧补当前空缺；
 * - 完整 S / K / dx 矩阵放在嵌套的默认折叠区，默认视图只给标量与标签。
 */
import type { KalmanObservationSnapshot, KalmanStepSnapshot } from "../estimators";
import type { Quat, V3 } from "../core/quat";
import { escapeHtml } from "../core/html-escape";

export interface EskfPanelDeps {
  getSnapshot(): KalmanStepSnapshot | null;
  getTime(): number | null;
  openDocs?(page: string, anchor?: string): void;
}

export interface EskfPanelApi {
  update(): void;
}

const BODY_FRAME = "机体系";
const WORLD_FROM_BODY = "世界系←机体系";
const P_DIAG_UNITS = "前 3 项 rad²，后 3 项 (rad/s)²";
const P_DETAIL = "6×6 行主序";
const P_MISSING = "本步未记录（不补 0）";

const P_DIAG_LABELS = ["δθx", "δθy", "δθz", "δbx", "δby", "δbz"] as const;

function fmtNumber(value: number | null | undefined, digits = 6): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "不可用";
}

function fmtQuat(q: Quat): string {
  return `w=${fmtNumber(q.w)}, x=${fmtNumber(q.x)}, y=${fmtNumber(q.y)}, z=${fmtNumber(q.z)}`;
}

function fmtV3(value: V3 | null, unit: string): string {
  if (!value) return "未记录（不补 0）";
  const body = `[${value.map((item) => fmtNumber(item, 5)).join(", ")}]`;
  return unit ? `${body} ${unit}` : body;
}

function fmtPDiag(values: number[]): string {
  if (values.length === 0) return "未记录（不补 0）";
  return values
    .map((value, index) => `${P_DIAG_LABELS[index] ?? `P${index}`}=${fmtNumber(value)}`)
    .join("，");
}

function channelLabel(channel: "accel" | "mag"): string {
  return channel === "accel" ? "加速度计" : "磁力计";
}

function appliedText(applied: boolean): string {
  return applied ? "已应用（本观测改变了姿态/零偏/P）" : "未应用（本观测没有改变姿态）";
}


function matrixDetails(
  name: "S" | "K" | "dx" | "P",
  values: number[] | null,
  detail: string,
  missingReason: string,
): string {
  const displayName = name === "P" ? "完整 P" : name;
  if (!values) {
    return (
      `<p class="dim">${escapeHtml(displayName)}：${escapeHtml(missingReason)}；` +
      `未产生数组（不以 0 代替）。</p>`
    );
  }
  return (
    `<details class="eskf-matrix" data-matrix="${name}">` +
    `<summary>展开 ${escapeHtml(displayName)}（${escapeHtml(detail)}）</summary>` +
    `<pre class="mono">${escapeHtml(values.map((value) => fmtNumber(value)).join(", "))}</pre>` +
    `</details>`
  );
}


function observationHtml(
  obs: KalmanObservationSnapshot | undefined,
  position: number,
): string {
  if (!obs) {
    return (
      `<p class="dim">本步没有第 ${position} 条观测记录。` +
      `生产顺序通常为“先加速度计、后磁力计”；缺失时不补造数据。</p>`
    );
  }
  const label = channelLabel(obs.channel);
  const reason = !obs.available ? "观测不可用，未进入更新计算" : !obs.gate.accepted ? "门控拒绝，未进入更新计算" : !obs.applied ? "S 奇异，更新被安全跳过" : "本步未记录该量";
  return (
    `<div class="eskf-obs" data-channel="${obs.channel}" data-applied="${obs.applied ? "true" : "false"}">` +
    `<p><b>第 ${position} 条 · ${label}</b>（channel=${escapeHtml(obs.channel)}）</p>` +
    `<p>可用性：${obs.available ? "可用" : "不可用"} · 门控：` +
    `${escapeHtml(obs.gate.kind)} / 阈值 ` +
    `${obs.gate.threshold === null ? "无" : fmtNumber(obs.gate.threshold)} / ` +
    `${obs.gate.accepted ? "接受" : "拒绝"} · 原因码：${escapeHtml(obs.gate.reason)}</p>` +
    `<p>应用结果：${appliedText(obs.applied)}</p>` +
    `<p>预测方向（${BODY_FRAME}单位方向，无量纲）：${fmtV3(obs.predicted, "")}</p>` +
    `<p>实测方向（${BODY_FRAME}单位方向，无量纲）：${fmtV3(obs.measured, "")}</p>` +
    `<p>新息 innovation（${BODY_FRAME}单位方向，无量纲）：${fmtV3(obs.innovation, "")}</p>` +
    `<p>新息夹角：${obs.innovationAngleDeg === null ? "不可用（未计算）" : `${fmtNumber(obs.innovationAngleDeg, 3)} °`} · ` +
    `NIS：${obs.nis === null ? "不可用（未计算）" : fmtNumber(obs.nis, 4)}</p>` +
    `<p>q 前（${WORLD_FROM_BODY}）：${fmtQuat(obs.qBefore)}</p>` +
    `<p>q 后（${WORLD_FROM_BODY}）：${fmtQuat(obs.qAfter)}</p>` +
    `<p>零偏 b 前（${BODY_FRAME}）：${fmtV3(obs.biasBeforeRad, "rad/s")}</p>` +
    `<p>零偏 b 后（${BODY_FRAME}）：${fmtV3(obs.biasAfterRad, "rad/s")}</p>` +
    `<p>P 对角（前，${P_DIAG_UNITS}）：${fmtPDiag(obs.pDiagBefore)}</p>` +
    matrixDetails("P", obs.pFullBefore ?? null, `观测前，${P_DETAIL}`, P_MISSING) +
    `<p>P 对角（后，${P_DIAG_UNITS}）：${fmtPDiag(obs.pDiagAfter)}</p>` +
    matrixDetails("P", obs.pFullAfter ?? null, `观测后，${P_DETAIL}`, P_MISSING) +
    `<p>本观测后的协方差重置：${obs.covarianceResetApplied ? "已执行" : "未执行"}</p>` +
    matrixDetails("S", obs.S, "3×3，归一化新息协方差，无量纲²", reason) +
    matrixDetails("K", obs.K, "6×3，误差状态增益，行主序", reason) +
    matrixDetails("dx", obs.dx, "6 维，前 3 项 rad、后 3 项 rad/s", reason) +
    `</div>`
  );
}

function gateStageHtml(observations: readonly KalmanObservationSnapshot[]): string {
  if (observations.length === 0) {
    return `<p class="dim">本步没有观测记录（observations 为空）；不虚构接受/拒绝结果。</p>`;
  }
  return observations
    .map((obs, index) => {
      return (
        `<p>第 ${index + 1} 条 · ${channelLabel(obs.channel)}：` +
        `门控类型 ${escapeHtml(obs.gate.kind)}，阈值 ` +
        `${obs.gate.threshold === null ? "无" : fmtNumber(obs.gate.threshold)}，` +
        `${obs.gate.accepted ? "接受" : "拒绝"}，原因码 ${escapeHtml(obs.gate.reason)}；` +
        `${appliedText(obs.applied)}。</p>`
      );
    })
    .join("");
}

function inputStageHtml(snapshot: KalmanStepSnapshot): string {
  return (
    `<p>dt（本次解算步长）：${fmtNumber(snapshot.dt)} s</p>` +
    `<p>更新前 q（${WORLD_FROM_BODY}）：${fmtQuat(snapshot.qInput)}</p>` +
    `<p>更新前零偏 b（${BODY_FRAME}）：${fmtV3(snapshot.biasInputRad, "rad/s")}</p>` +
    `<p>更新前 P 对角（${P_DIAG_UNITS}）：${fmtPDiag(snapshot.pDiagInput)}</p>` +
    matrixDetails("P", snapshot.pFullInput ?? null, `更新前，${P_DETAIL}`, P_MISSING)
  );
}

function predictionStageHtml(snapshot: KalmanStepSnapshot): string {
  return (
    `<p>修正后陀螺 ω−b（${BODY_FRAME}）：${fmtV3(snapshot.correctedGyroRad, "rad/s")}</p>` +
    `<p>预测姿态 q⁻（${WORLD_FROM_BODY}）：${fmtQuat(snapshot.qPredicted)}</p>` +
    `<p>预测协方差 P⁻ 对角（${P_DIAG_UNITS}）：${fmtPDiag(snapshot.pDiagPredicted)}</p>` +
    matrixDetails("P", snapshot.pFullPredicted ?? null, `预测后，${P_DETAIL}`, P_MISSING) +
    `<p class="dim">零偏在预测段不更新，仍为更新前的值。</p>`
  );
}

function finalStageHtml(snapshot: KalmanStepSnapshot): string {
  return (
    `<p>预测后 / 观测注入前 q（${WORLD_FROM_BODY}）：${fmtQuat(snapshot.qPredicted)}</p>` +
    `<p>最终 q（${WORLD_FROM_BODY}）：${fmtQuat(snapshot.qFinal)}</p>` +
    `<p>更新前零偏 b（${BODY_FRAME}）：${fmtV3(snapshot.biasInputRad, "rad/s")}</p>` +
    `<p>最终零偏 b（${BODY_FRAME}）：${fmtV3(snapshot.biasFinalRad, "rad/s")}</p>` +
    `<p>预测后 P 对角（${P_DIAG_UNITS}）：${fmtPDiag(snapshot.pDiagPredicted)}</p>` +
    `<p>最终 P 对角（${P_DIAG_UNITS}）：${fmtPDiag(snapshot.pDiagFinal)}</p>` +
    matrixDetails("P", snapshot.pFullFinal ?? null, `最终，${P_DETAIL}`, P_MISSING) +
    `<p class="dim">以上均直接取自同一份单步快照；界面不做姿态或矩阵重算。</p>`
  );
}

function resetStageHtml(snapshot: KalmanStepSnapshot): string {
  if (snapshot.covarianceResetApplied) {
    return (
      `<p>协方差重置：<b>已执行</b>。</p>` +
      `<p class="dim">本步至少一条被接受观测执行了 P ← G·P·Gᵀ；标志来自快照，不是界面推断。</p>`
    );
  }
  return (
    `<p>协方差重置：<b>未执行</b>。</p>` +
    `<p class="dim">本步没有执行 P ← G·P·Gᵀ（配置关闭，或没有成功注入的观测）；` +
    `不把未启用写成省略这一步。</p>`
  );
}

function stage(key: string, title: string, body: string): string {
  return (
    `<details class="eskf-stage" data-stage="${escapeHtml(key)}">` +
    `<summary>${escapeHtml(title)}</summary>` +
    `<div class="eskf-stage-body">${body}</div>` +
    `</details>`
  );
}

/**
 * 一份 ESKF 单步快照的纯 HTML。`time` 是调用方给的数据时间（秒）；
 * 快照本身没有绝对时间，`null` 时写“时间未记录”，不伪造 t。
 */
export function eskfSnapshotHtml(
  snapshot: KalmanStepSnapshot | null,
  time: number | null,
): string {
  const timeText =
    time !== null && Number.isFinite(time) ? `t = ${time.toFixed(3)} s` : "时间未记录";
  if (!snapshot) {
    return (
      `<div class="eskf-empty" role="status">` +
      `<p><b>当前步未记录内部快照</b></p>` +
      `<p class="dim">请暂停后单步推进当前解算步，或开启诊断采集；` +
      `不会用下一帧或相邻数据补当前空缺。</p>` +
      `<p class="dim">${escapeHtml(timeText)}</p>` +
      `</div>`
    );
  }

  const first = snapshot.observations[0];
  const second = snapshot.observations[1];
  const firstTitle = first
    ? `③ 观测 1 · ${channelLabel(first.channel)}`
    : "③ 观测 1（未记录）";
  const secondTitle = second
    ? `④ 观测 2 · ${channelLabel(second.channel)}`
    : "④ 观测 2（未记录）";

  return (
    `<p class="dim eskf-meta">${escapeHtml(timeText)} · 单步只读快照，7 个阶段默认折叠。</p>` +
    stage("input", "① 更新前（输入）", inputStageHtml(snapshot)) +
    stage("prediction", "② 预测（修正后陀螺 ω−b）", predictionStageHtml(snapshot)) +
    stage("obs-1", firstTitle, observationHtml(first, 1)) +
    stage("obs-2", secondTitle, observationHtml(second, 2)) +
    stage("gate", "⑤ 观测判定", gateStageHtml(snapshot.observations)) +
    stage("inject", "⑥ 最终注入（实际变化）", finalStageHtml(snapshot)) +
    stage("reset", "⑦ 可选协方差重置", resetStageHtml(snapshot))
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

/**
 * 把 ESKF 解剖面板挂到调用方给的容器里。UI 与渲染都只在按需加载时创建。
 */
export function mountEskfPanel(root: HTMLElement, deps: EskfPanelDeps): EskfPanelApi {
  const doc = root.ownerDocument;
  const wrap = element(doc, "div", "eskf-panel");
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "ESKF 单步内部解剖");

  const head = element(doc, "div", "eskf-head");
  const title = element(doc, "b");
  title.textContent = "ESKF 单步内部解剖";
  head.append(title);

  const openDocs = deps.openDocs;
  if (openDocs) {
    const docsButton = element(doc, "button", "pt-btn");
    docsButton.type = "button";
    docsButton.textContent = "本步发生了什么";
    docsButton.setAttribute("data-eskf-action", "docs");
    docsButton.addEventListener("click", () => openDocs("f-kalman-detail", "fd-kalman-3"));
    head.append(docsButton);
  }

  const body = element(doc, "div", "eskf-body");
  wrap.append(head, body);
  root.replaceChildren(wrap);

  let painted = false;
  let lastSnapshot: KalmanStepSnapshot | null = null;
  let lastTime: number | null = null;

  const update = (): void => {
    const snapshot = deps.getSnapshot();
    const time = deps.getTime();
    if (painted && snapshot === lastSnapshot && time === lastTime) return;
    painted = true;
    lastSnapshot = snapshot;
    lastTime = time;
    body.innerHTML = eskfSnapshotHtml(snapshot, time);
  };

  update();
  return { update };
}
