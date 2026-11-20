/**
 * F-05 的事件时间轴面板（DOM 装配层）。
 *
 * 边界
 * ----
 * - 只读调用方提供的 `EventTimeline`，按调用方节奏 `update()`；模块自己不定时。
 * - 事件文字全部来自真实 `LearningEvent`；面板不推断“为什么发生”，也不把
 *   单条门控事件解释成故障诊断。
 * - 每个事件是一个原生 `<button>`，点击调用 `seek(event.t)`；Tab/Enter/Space
 *   由浏览器原生提供，不需要自造键盘模型。
 * - 列表显示最近 N 条（新→旧），并明确报告环形缓冲已裁剪的数量。
 * - 纯文本渲染：所有 summary/label 用 `textContent` 写入，不拼接 HTML。
 */
import { estimatorLabel } from "./estimator-labels";
import {
  type EventTimeline,
  type LearningEvent,
  type LearningEventKind,
  type LearningEventPhase,
} from "../core/event-timeline";

/** 列表最多显示的最近事件数；时间轴容量仍由 EventTimeline 决定。 */
export const EVENT_PANEL_LIMIT = 50;

export type EventCategory = "all" | "align" | "gate" | "data" | "user" | "other";

export const EVENT_FILTERS: ReadonlyArray<{ id: EventCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "align", label: "粗对准" },
  { id: "gate", label: "门控" },
  { id: "data", label: "数据" },
  { id: "user", label: "参数" },
  { id: "other", label: "其他" },
];

const CATEGORY_KINDS: Record<Exclude<EventCategory, "all">, readonly LearningEventKind[]> = {
  align: ["align"],
  gate: ["gate-reject", "gate-recovery", "gate-saturation"],
  data: ["data-gap", "data-recover", "data-reconnect"],
  user: ["param-change", "view-change", "experiment-load"],
  other: ["custom"],
};

export const EVENT_KIND_LABELS: Record<LearningEventKind, string> = {
  align: "粗对准",
  "gate-reject": "门控拒绝",
  "gate-recovery": "门控恢复",
  "gate-saturation": "器件饱和",
  "data-gap": "数据断流",
  "data-recover": "数据恢复",
  "data-reconnect": "自动重连",
  "param-change": "参数改变",
  "view-change": "视图切换",
  "experiment-load": "实验装载",
  custom: "自定义",
};

export const EVENT_PHASE_LABELS: Record<LearningEventPhase, string> = {
  instant: "瞬时",
  start: "开始",
  end: "结束",
};

export { ESTIMATOR_LABELS as EVENT_ESTIMATOR_LABELS } from "./estimator-labels";

export interface EventPanelDeps {
  getTimeline(): EventTimeline;
  /** 把共享游标定位到事件时刻（单位与事件 t 相同） */
  seek(t: number): void;
  openDocs?(page: string, anchor?: string): void;
}

export interface EventRowView {
  seq: number;
  t: number;
  kind: LearningEventKind;
  phase: LearningEventPhase;
  estimator: LearningEvent["estimator"];
  summary: string;
  timeText: string;
  kindLabel: string;
  phaseLabel: string;
  estimatorLabel: string;
  text: string;
  ariaLabel: string;
}

export interface EventPanelView {
  runId: number | null;
  filter: EventCategory;
  capacity: number;
  dropped: number;
  total: number;
  /** 当前类别在时间轴中的事件数（未截断） */
  visibleCount: number;
  /** 实际渲染的行数（最多 EVENT_PANEL_LIMIT） */
  shownCount: number;
  rows: EventRowView[];
  empty: boolean;
  metaText: string;
  droppedText: string;
  emptyText: string;
}

export interface EventPanelState {
  filter: EventCategory;
  selectedSeq: number | null;
  view: EventPanelView | null;
}

export interface EventPanelApi {
  update(): EventPanelView;
  state(): EventPanelState;
  destroy(): void;
}

function estimatorText(estimator: LearningEvent["estimator"]): string {
  if (estimator === null) return "系统";
  if (estimator === "all") return "全部算法";
  return estimatorLabel(estimator);
}

function rowView(event: LearningEvent): EventRowView {
  const timeText = `t=${event.t.toFixed(3)} s`;
  const kindLabel = EVENT_KIND_LABELS[event.kind];
  const phaseLabel = EVENT_PHASE_LABELS[event.phase];
  const estimatorLabel = estimatorText(event.estimator);
  const kindPhase = `${kindLabel}（${phaseLabel}）`;
  return {
    seq: event.seq,
    t: event.t,
    kind: event.kind,
    phase: event.phase,
    estimator: event.estimator,
    summary: event.summary,
    timeText,
    kindLabel,
    phaseLabel,
    estimatorLabel,
    text: `${timeText} · ${kindPhase} · ${estimatorLabel} · ${event.summary}`,
    ariaLabel: `事件 ${timeText}，${kindPhase}，${estimatorLabel}：${event.summary}。按下后定位到该时刻。`,
  };
}

function droppedText(dropped: number): string {
  return dropped > 0 ? `已裁剪 ${dropped} 条更早事件` : "未发生裁剪";
}

function emptyTextFor(filter: EventCategory, total: number, visibleCount: number): string {
  if (total === 0) {
    return "当前没有事件。事件只来自真实状态边沿与调用方动作；空列表不推断原因。";
  }
  if (visibleCount === 0) {
    return filter === "all"
      ? "当前没有事件。事件只来自真实状态边沿与调用方动作；空列表不推断原因。"
      : `当前类别没有事件；其他类别仍有 ${total} 条。`;
  }
  return "";
}

/**
 * 纯函数：过滤、截断并生成可访问的事件行。
 *
 * 新→旧排列，最新事件在列表顶部；`seq` 用于稳定键与测试。返回的 summary
 * 保持原始字符串（渲染层用 textContent，不解释 HTML）。
 */
export function buildEventPanelView(
  timeline: EventTimeline,
  filter: EventCategory = "all",
  limit: number = EVENT_PANEL_LIMIT,
): EventPanelView {
  const matching = filter === "all"
    ? timeline.list()
    : timeline.list({ kind: CATEGORY_KINDS[filter] });
  const take = Math.max(1, Math.floor(limit));
  const rows = matching.slice(-take).reverse().map(rowView);
  const droppedCount = timeline.dropped;
  const total = timeline.size;
  const droppedLabel = droppedText(droppedCount);
  const metaParts = [`容量 ${timeline.capacity}`, `当前保留 ${total}`];
  if (filter !== "all") metaParts.push(`本类 ${matching.length}`);
  metaParts.push(droppedLabel);
  return {
    runId: timeline.currentRunId,
    filter,
    capacity: timeline.capacity,
    dropped: droppedCount,
    total,
    visibleCount: matching.length,
    shownCount: rows.length,
    rows,
    empty: rows.length === 0,
    metaText: metaParts.join(" · "),
    droppedText: droppedLabel,
    emptyText: emptyTextFor(filter, total, matching.length),
  };
}

function make(doc: Document, tag: string, className?: string): HTMLElement {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

interface ItemElements {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  signature: string;
  t: number;
  seq: number;
}

export function mountEventPanel(root: HTMLElement, deps: EventPanelDeps): EventPanelApi {
  const doc = root.ownerDocument;
  const container = make(doc, "div", "event-panel");
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "事件时间轴");

  const head = make(doc, "div", "event-head");
  const title = make(doc, "b", "event-title");
  title.textContent = "事件时间轴";
  const meta = make(doc, "span", "event-meta dim");
  head.appendChild(title);
  head.appendChild(meta);

  const items = new Map<number, ItemElements>();
  let filter: EventCategory = "all";
  let selectedSeq: number | null = null;
  let lastRunId: number | null = null;
  let lastView: EventPanelView | null = null;

  const filters = make(doc, "div", "event-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "事件类别过滤");
  const filterButtons: Array<{ id: EventCategory; button: HTMLButtonElement }> = [];
  for (const entry of EVENT_FILTERS) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pt-btn event-filter";
    button.textContent = entry.label;
    button.setAttribute("data-filter", entry.id);
    button.addEventListener("click", () => {
      filter = entry.id;
      update();
    });
    filters.appendChild(button);
    filterButtons.push({ id: entry.id, button });
  }

  const note = make(doc, "p", "event-note dim");
  note.textContent =
    "事件来自解算、传感器/传输与用户动作的真实状态或动作记录；列表只陈列事件，不推断故障原因。点击事件按钮把共享游标定位到该时刻。";

  const empty = make(doc, "div", "event-empty dim");
  const list = doc.createElement("ul");
  list.className = "event-list";
  list.setAttribute("aria-label", "最近事件，按时间倒序");

  const footer = make(doc, "div", "event-footer");
  const docsButton = doc.createElement("button");
  docsButton.type = "button";
  docsButton.className = "pt-btn";
  docsButton.textContent = "查看可观性与观测门控说明";
  const openDocs = deps.openDocs;
  if (openDocs) {
    docsButton.addEventListener("click", () => openDocs("math", "m-observability"));
    footer.appendChild(docsButton);
  }

  container.appendChild(head);
  container.appendChild(filters);
  container.appendChild(note);
  container.appendChild(empty);
  container.appendChild(list);
  if (openDocs) container.appendChild(footer);
  root.appendChild(container);

  const updateSelection = (): void => {
    for (const item of items.values()) {
      item.button.setAttribute("aria-current", item.seq === selectedSeq ? "true" : "false");
    }
  };

  const syncRows = (rows: EventRowView[]): void => {
    const wanted = new Set(rows.map((row) => row.seq));
    for (const [seq, item] of items) {
      if (!wanted.has(seq)) {
        item.li.remove();
        items.delete(seq);
      }
    }
    rows.forEach((row, index) => {
      let item = items.get(row.seq);
      if (!item) {
        const li = doc.createElement("li");
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "pt-btn event-item";
        li.appendChild(button);
        item = { li, button, signature: "", t: row.t, seq: row.seq };
        items.set(row.seq, item);
        const created = item;
        button.addEventListener("click", () => {
          selectedSeq = created.seq;
          deps.seek(created.t);
          updateSelection();
        });
      }
      const signature = `${row.t}|${row.kind}|${row.phase}|${row.estimator ?? "null"}|${row.summary}`;
      if (item.signature !== signature) {
        item.button.textContent = row.text;
        item.button.setAttribute("aria-label", row.ariaLabel);
        item.signature = signature;
      }
      item.t = row.t;
      item.seq = row.seq;
      item.button.setAttribute("aria-current", selectedSeq === row.seq ? "true" : "false");
      const current: Element | undefined = list.children[index];
      if (current !== item.li) list.insertBefore(item.li, current ?? null);
    });
  };

  function update(): EventPanelView {
    const view = buildEventPanelView(deps.getTimeline(), filter);
    lastView = view;
    if (lastRunId !== view.runId) {
      for (const item of items.values()) item.li.remove();
      items.clear();
      selectedSeq = null;
      lastRunId = view.runId;
    }
    meta.textContent = view.metaText;
    empty.textContent = view.emptyText;
    empty.hidden = !view.empty;
    list.hidden = view.empty;
    syncRows(view.rows);
    for (const entry of filterButtons) {
      entry.button.setAttribute("aria-pressed", entry.id === filter ? "true" : "false");
    }
    return view;
  }

  update();

  return {
    update,
    state: () => ({ filter, selectedSeq, view: lastView }),
    destroy: () => {
      container.remove();
    },
  };
}
