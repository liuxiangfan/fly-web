/**
 * 引导课程（guided tour）：13 步走完一遍装置的全部教学内容。
 *
 * 设计取舍
 * --------
 * 1. **不重新发明现场**。绝大多数步骤的「现场」直接引用实验库里的实验 id——
 *    实验库已经承担了「参数快照 + 基线复位 + 一键复现」这件事，也有自检覆盖
 *    （每个实验引用的控件必须存在）。引导课程只负责**顺序**与**讲解**。
 * 2. **只驱动用户看得见的界面**。装载实验 = 点那个按钮；切视图 = 点那个分段控件；
 *    展开面板 = 点那个折叠标题。所以本模块不 import 主程序的任何内部状态，
 *    也不会因为主程序重构而失效——它模拟的正是用户的动作。
 * 3. **文档步骤不自动打开文档层**。文档层是整个屏幕的模态对话框，程序化打开会把
 *    「下一步」按钮盖住，用户就卡死了。改为在卡片上给一个「打开这一页文档」按钮：
 *    用户自己打开、自己 Esc 返回，回来后卡片还在原处。
 * 4. **步骤数据不在本模块**。13 步文案由宿主从 `data/tour.json` 取来后传入；本模块只负责
 *    按序驱动 DOM。这样引导课程 chunk 里没有教学文案，文案的 TS 真源在
 *    `scripts/emit-catalog.ts`（生成 JSON 用，不进运行时包），自检与契约测试仍能逐字比对。
 */

export interface TourStep {
  id: string;
  title: string;
  /** 正文（只允许 <b> / <span class="mono"> 这类内联标签） */
  body: string;
  /** 观察要点：显示在卡片底部的强调条里 */
  look: string;
  /** 装载实验库里的某条实验（id 见 ui/experiments.ts） */
  exp?: string;
  /** 切换 3D 视图（省略 = 沿用上一步的视图） */
  view?: "attitude" | "gimbal" | "quat";
  /** 展开右侧栏的某个分区（data-section 值） */
  panel?: string;
  /** 建议顺带一读的文档位置（渲染成按钮，由用户自己打开） */
  doc?: { page: string; anchor?: string; label: string };
  /** 该步预计用时（秒），用来算总时长 */
  sec: number;
}


/** 整门课程预计用时（分钟，向上取整） */
export function tourMinutes(steps: readonly TourStep[]): number {
  return Math.ceil(steps.reduce((a, s) => a + s.sec, 0) / 60);
}

/** 由宿主提供的外部动作（只有这三个是本模块办不到的） */
export interface TourHost {
  /** 装载实验库里的一条实验（复用主程序的基线复位与参数写入） */
  applyExperiment(id: string): void;
  /** 打开文档层的某一页（可带页内锚点） */
  openDocs(page: string, anchor?: string): void;
  /** 界面短暂反馈 */
  toast(msg: string): void;
  /** 每一步渲染后同步当前任务（E：任务上下文唯一来源） */
  onStep?(step: TourStep, index: number, total: number): void;
  /** 退出课程后清除任务上下文 */
  onExit?(): void;
}

export interface Tour {
  start(): void;
  exit(): void;
  next(): void;
  prev(): void;
  goto(i: number): void;
  /** 当前是否在课程中（供主程序判断是否要拦住某些快捷键） */
  active(): boolean;
  /** 当前步序号（1 起，未开始时为 0） */
  index(): number;
  /** 总步数（供主程序在课程加载后显示进度，避免把 13 硬编码到 main） */
  total(): number;
}

const $t = (id: string): HTMLElement | null => document.getElementById(id);

/** 把一页文档里的章节滚进视野（文档层是模态的，由用户自己开关，这里只管定位） */
function scrollDocsTo(anchor: string): void {
  const el = document.getElementById(anchor);
  if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
}

/**
 * 挂载引导课程。返回的控制器由主程序接到卡片上的三个按钮与「开始引导」入口。
 * 本函数只读 DOM（不 import 主程序状态），所有状态变化都发生在卡片自己的 DOM 上。
 */
export function mountTour(host: TourHost, steps: readonly TourStep[]): Tour {
  if (steps.length === 0) throw new Error("引导课程没有步骤");
  const card = $t("tour-card");
  const counter = $t("tour-counter");
  const title = $t("tour-title");
  const body = $t("tour-body");
  const look = $t("tour-look");
  const docBtn = $t("tour-doc") as HTMLButtonElement | null;
  const bar = $t("tour-bar");
  const nextBtn = $t("tour-next") as HTMLButtonElement | null;
  const prevBtn = $t("tour-prev") as HTMLButtonElement | null;
  const summary = $t("sum-tour");
  const section = $t("sec-tour");
  // 课程运行中把「开始」这一段收起来：一是避免「开始/退出」两个入口同时杵着，
  // 二是右侧栏可滚动区只有 460 px 左右，省下的这 90 px 正好让整张卡片（约 370 px）
  // 完整落在视野里——按钮被挤到折叠线以下是实测踩到过的问题。
  const intro = $t("tour-intro");
  const startRow = $t("tour-start-row");

  let i = -1; // -1 = 未开始

  /** 展开右侧栏的某个分区（点它自己的折叠标题，与用户操作同一条路径） */
  const revealPanel = (dataSection: string): void => {
    const sec = section && document.querySelector<HTMLElement>(`#panel .panel-section[data-section="${dataSection}"]`);
    if (!sec) return;
    const toggle = sec.querySelector<HTMLButtonElement>(".panel-toggle");
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const apply = (step: TourStep): void => {
    // 视图：直接点分段控件——它自带过渡与内部演示组切换
    if (step.view) {
      const btn = document.querySelector<HTMLButtonElement>(`#view-seg .seg-btn[data-view="${step.view}"]`);
      if (btn && !btn.classList.contains("active")) btn.click();
    }
    if (step.exp) host.applyExperiment(step.exp);
    if (step.panel) revealPanel(step.panel);
  };

  const render = (): void => {
    const step = steps[i];
    if (!card || !step) return;
    card.classList.remove("hidden");
    if (counter) counter.textContent = `第 ${i + 1} / ${steps.length} 步 · 约 ${step.sec} s`;
    if (title) title.textContent = step.title;
    if (body) body.innerHTML = step.body;
    if (look) look.innerHTML = step.look;
    if (bar) bar.style.width = `${((i + 1) / steps.length) * 100}%`;
    if (prevBtn) prevBtn.disabled = i === 0;
    if (nextBtn) nextBtn.textContent = i === steps.length - 1 ? "完成" : "下一步";
    if (docBtn) {
      if (step.doc) {
        docBtn.textContent = `打开文档：${step.doc.label}`;
        docBtn.classList.remove("hidden");
      } else {
        docBtn.classList.add("hidden");
      }
    }
    if (summary) summary.textContent = `第 ${i + 1}/${steps.length} 步：${step.title}`;
    host.onStep?.(step, i, steps.length);
    // block:"nearest"：已经在视野里就不动，避免每步都强迫滚动
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const tour: Tour = {
    start(): void {
      i = 0;
      if (section?.classList.contains("collapsed")) {
        section.querySelector<HTMLButtonElement>(".panel-toggle")?.click();
      }
      intro?.classList.add("hidden");
      startRow?.classList.add("hidden");
      apply(steps[0]);
      render();
      host.toast(`引导课程已开始：${steps.length} 步 / 约 ${tourMinutes(steps)} 分钟（随时可停）`);
    },
    exit(): void {
      const wasActive = i >= 0;
      i = -1;
      card?.classList.add("hidden");
      intro?.classList.remove("hidden");
      startRow?.classList.remove("hidden");
      if (summary) summary.textContent = `共 ${steps.length} 步 · 约 ${tourMinutes(steps)} 分钟`;
      if (wasActive) host.onExit?.();
    },
    next(): void {
      if (i < 0) return tour.start();
      if (i === steps.length - 1) return tour.exit();
      i++;
      apply(steps[i]);
      render();
    },
    prev(): void {
      if (i <= 0) return;
      i--;
      apply(steps[i]);
      render();
    },
    goto(n: number): void {
      i = Math.max(0, Math.min(steps.length - 1, n));
      apply(steps[i]);
      render();
    },
    active: () => i >= 0,
    index: () => i + 1,
    total: () => steps.length,
  };

  nextBtn?.addEventListener("click", () => tour.next());
  prevBtn?.addEventListener("click", () => tour.prev());
  $t("tour-close")?.addEventListener("click", () => tour.exit());
  $t("tour-start")?.addEventListener("click", () => tour.start());
  docBtn?.addEventListener("click", () => {
    const step = steps[i];
    if (!step?.doc) return;
    host.openDocs(step.doc.page, step.doc.anchor);
    if (step.doc.anchor) {
      // 文档层刚切页，章节元素要等一帧才在正确位置；直接滚会在旧布局上白跑一次
      window.setTimeout(() => scrollDocsTo(step.doc!.anchor!), 60);
    }
  });
  // 卡片自身键盘可达：焦点在卡片里时用左右方向键翻页
  card?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      tour.next();
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      tour.prev();
      e.preventDefault();
    }
  });

  tour.exit();
  return tour;
}
