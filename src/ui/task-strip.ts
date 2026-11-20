/**
 * 当前学习任务条 + 参数变化反馈（F-04 的 DOM 装配层）。
 *
 * 边界
 * ----
 * - 任务文字由调用方（实验库/挑战/对照台）提供；本模块不推断教学结论；
 * - 参数反馈读 `parameter-meta.ts` 的真实控件表，不猜控件含义；
 * - 程序化装载（实验/挑战/档案/深链）期间用 begin/end 抑制，避免把一次装载
 *   变成几十条“你改了参数”；装载结束时只发一条聚合反馈；
 * - 控件事件走**冒泡阶段**：目标处理器（resetSim）先执行，反馈再读 `sawReset`；
 * - `noteReset()` 由生产 `resetSim()` 调用：反馈里的“已重置”来自实际发生，
 *   不是只看元数据猜；标记只活到本次派发的微任务，不留给下一次无关修改。
 */
import { describeParameterChange, parameterMeta, type ParameterValue } from "./parameter-meta";
import { deviatingIds, type TaskKind, type TaskSpec } from "./task-context";
export type { TaskKind };

export interface TaskDescriptor extends Omit<TaskSpec, "variablePaths"> {
  kind: Exclude<TaskKind, "free">;
  id: string;
  title: string;
  conditions: string;
  variable: string;
  observe: string;
  next: string;
  /** 属于该任务本身的控件；修改这些不算“偏离” */
  allowedIds?: readonly string[];
}

export interface TaskStripSnapshot {
  task: { kind: TaskKind; id: string; title: string; deviation: boolean } | null;
  feedback: string;
}

export interface TaskStripApi {
  setTask(task: TaskDescriptor): void;
  clearTask(): void;
  beginProgrammatic(): void;
  endProgrammatic(): void;
  noteReset(): void;
  state(): TaskStripSnapshot;
  showFeedback(main: string, detail?: string): void;
}

const byId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[id="${id}"]`);

function readValue(el: HTMLInputElement | HTMLSelectElement): ParameterValue {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  if (el instanceof HTMLInputElement && el.type === "range") return el.valueAsNumber;
  return el.value;
}

export interface TaskStripAction {
  kind: "param-change" | "view-change" | "experiment-load";
  summary: string;
  before?: unknown;
  after?: unknown;
}

export function mountTaskStrip(options: {
  onExit?: (kind: TaskKind) => void;
  /** 真实用户动作出口（F-05）：由宿主写入事件时间轴；不在这里碰 DOM 外状态。 */
  onAction?: (action: TaskStripAction) => void;
} = {}): TaskStripApi {
  const strip = byId("task-strip");
  if (strip) {
    // 外壳只保留一个空容器：任务条不是首屏内容，明细在按需模块里生成，
    // 避免把四行说明与按钮结构常驻 index.html 的应用外壳预算。
    strip.innerHTML =
      '<div class="task-strip-head"><b id="task-strip-title">自由探索</b>' +
      '<button type="button" class="pt-btn" id="task-strip-exit" aria-label="退出当前任务，回到自由探索">退出任务</button></div>' +
      '<div class="task-strip-body">' +
      '<div class="task-strip-row"><span class="task-strip-k">条件</span><span class="task-strip-v" id="task-strip-conditions"></span></div>' +
      '<div class="task-strip-row"><span class="task-strip-k">变量</span><span class="task-strip-v" id="task-strip-variable"></span></div>' +
      '<div class="task-strip-row"><span class="task-strip-k">观察</span><span class="task-strip-v" id="task-strip-observe"></span></div>' +
      '<div class="task-strip-row"><span class="task-strip-k">下一步</span><span class="task-strip-v" id="task-strip-next"></span></div>' +
      '<div class="task-deviation hidden" id="task-strip-deviation" role="status"></div></div>';
  }
  const feedbackRoot = byId("param-feedback");
  if (feedbackRoot) {
    feedbackRoot.innerHTML =
      '<div id="param-feedback-main"></div><div class="dim" id="param-feedback-detail"></div>';
  }
  const titleEl = byId("task-strip-title");
  const conditionsEl = byId("task-strip-conditions");
  const variableEl = byId("task-strip-variable");
  const observeEl = byId("task-strip-observe");
  const nextEl = byId("task-strip-next");
  const deviationEl = byId("task-strip-deviation");
  const feedbackEl = byId("param-feedback");
  const feedbackMain = byId("param-feedback-main");
  const feedbackDetail = byId("param-feedback-detail");

  let task: TaskDescriptor | null = null;
  let deviation = false;
  let programmatic = 0;
  let programmaticChanges = 0;
  let programmaticReset = false;
  let sawReset = false;
  let resetEpoch = 0;
  let feedbackTimer = 0;
  let feedback = "";
  const previous = new Map<string, ParameterValue>();

  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#panel input[id], #panel select[id]")) {
    previous.set(el.id, readValue(el));
  }

  const render = (): void => {
    if (!strip) return;
    if (!task) {
      strip.classList.add("hidden");
      if (deviationEl) deviationEl.classList.add("hidden");
      return;
    }
    strip.classList.remove("hidden");
    if (titleEl) titleEl.textContent = task.title;
    if (conditionsEl) conditionsEl.textContent = task.conditions;
    if (variableEl) variableEl.textContent = task.variable;
    if (observeEl) observeEl.textContent = task.observe;
    if (nextEl) nextEl.textContent = task.next;
    if (deviationEl) {
      deviationEl.textContent = deviation ? "已偏离原任务：改变了不在本任务声明范围内的参数。" : "";
      deviationEl.classList.toggle("hidden", !deviation);
    }
  };

  const showFeedback = (main: string, detail = ""): void => {
    feedback = detail ? `${main}｜${detail}` : main;
    if (!feedbackEl || !feedbackMain) return;
    feedbackEl.classList.remove("hidden");
    feedbackMain.textContent = main;
    if (feedbackDetail) feedbackDetail.textContent = detail;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      feedbackEl.classList.add("hidden");
      feedback = "";
    }, 4200);
  };

  /**
   * 复位标记只在触发它的那次事件派发内有效：目标处理器先 `noteReset()`，
   * 冒泡处理器同步读取；随后微任务清掉，避免被下一次无关参数修改消费。
   */
  const queueResetClear = (): void => {
    const epoch = ++resetEpoch;
    queueMicrotask(() => {
      if (resetEpoch === epoch) sawReset = false;
    });
  };

  const handleControl = (el: HTMLInputElement | HTMLSelectElement, eventType: "input" | "change"): void => {
    // range 用 input（连续拖动合并到同一反馈）；select/checkbox 用 change（一次提交）
    if (eventType === "input" && el instanceof HTMLSelectElement) return;
    if (eventType === "change" && el instanceof HTMLInputElement && el.type === "range") return;
    // checkbox/radio 的语义监听器挂在 change 上：input 只是浏览器中间态，
    // 提前处理会把同一个 change 的 reset 标记吃掉（例如 init-offset-toggle）。
    if (
      eventType === "input" &&
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio")
    ) {
      return;
    }
    if (!el.id) return;
    const meta = parameterMeta(el.id);
    if (!meta) return;
    const before = previous.get(el.id);
    const after = readValue(el);
    previous.set(el.id, after);
    const changed = before !== undefined && !Object.is(before, after);
    const reset = sawReset;
    sawReset = false;
    if (!changed) return;
    if (programmatic > 0) {
      programmaticChanges++;
      programmaticReset = programmaticReset || reset;
      return;
    }
    const d = describeParameterChange(meta, before, after, after, reset || undefined);
    showFeedback(d.head, `${d.detail} ${d.observe ? `观察：${d.observe}` : ""}`.trim());
    options.onAction?.({
      kind: "param-change",
      summary: d.head,
      before: { id: el.id, value: before },
      after: { id: el.id, value: after, reset },
    });
    // 与 task-context.markDeviation 共用同一份偏离策略：只认任务声明的变量路径。
    if (task && deviatingIds([el.id], task.allowedIds).length > 0) {
      deviation = true;
      render();
    }
  };

  // 冒泡阶段监听：目标控件自己的处理器（含 resetSim → noteReset）先执行，
  // 这里再读取 sawReset，才能报告「本次修改确实触发了复位」。
  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) handleControl(el, "input");
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) handleControl(el, "change");
  });

  byId("task-strip-exit")?.addEventListener("click", () => {
    const kind = task?.kind ?? "free";
    task = null;
    deviation = false;
    render();
    options.onExit?.(kind);
  });

  render();
  return {
    setTask(next): void {
      task = next;
      deviation = false;
      render();
    },
    clearTask(): void {
      task = null;
      deviation = false;
      render();
    },
    beginProgrammatic(): void {
      programmatic++;
    },
    endProgrammatic(): void {
      programmatic = Math.max(0, programmatic - 1);
      sawReset = false;
      if (programmatic > 0) return;
      if (programmaticChanges > 0 || programmaticReset) {
        showFeedback(
          "现场已装载",
          `${programmaticReset ? "参数已一次性写入并重置仿真" : "参数已一次性写入"}；` +
            "本次装载的控件提示已合并为一条。",
        );
        options.onAction?.({
          kind: "experiment-load",
          summary: "现场已装载（聚合提示）",
          after: { changes: programmaticChanges, reset: programmaticReset },
        });
      }
      programmaticChanges = 0;
      programmaticReset = false;
    },
    noteReset(): void {
      sawReset = true;
      // 装载阶段末尾的显式 resetSim() 不挂在控件上，也要计入聚合反馈。
      if (programmatic > 0) programmaticReset = true;
      queueResetClear();
    },
    state: () => ({
      task: task ? { kind: task.kind, id: task.id, title: task.title, deviation } : null,
      feedback,
    }),
    showFeedback,
  };
}
