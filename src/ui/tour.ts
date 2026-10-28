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

export const TOUR_STEPS: TourStep[] = [
  {
    id: "intro",
    title: "先说清楚：装置在回答什么问题",
    body:
      "只有三路互相矛盾的传感器读数，怎么推出「我现在头朝哪、身子歪了多少」？" +
      "陀螺仪动态准但会漂，加速度计长期稳但一动就乱，磁力计能定北但怕金属。" +
      "本装置把这三种「各有谎话」的传感器、五种化解矛盾的算法，以及它们失效的每一种方式，" +
      "做成可调、可看、可复现的现场。",
    look:
      "左边是 3D 四轴（默认显示 Mahony 的解算结果），底部三条曲线分别是<b>姿态角</b>、<b>姿态总误差</b>与 <b>IMU 原始波形</b>；" +
      "右侧栏从上到下就是「数据源 → 实验 → 传感器 → 校准 → 算法 → 显示 → 读数 → 评测」。",
    view: "attitude",
    panel: "scenario",
    sec: 45,
  },
  {
    id: "drift",
    title: "对照组：纯积分一定漂",
    body:
      "纯陀螺仪积分只信陀螺仪。陀螺仪有 3°/s 的零偏，它就每秒偏 3°，没有任何东西能把它拉回来——" +
      "误差曲线一路爬升，这就是「为什么必须有观测修正」的原因。" +
      "注意加计看不见偏航：即使有修正，偏航仍在慢慢漂。",
    look: "误差曲线里<b>红色（pure）</b>那条一路向上；蓝/绿/紫三条被加速度计拉住，但<b>偏航</b>分量仍在衰减地漂。",
    exp: "drift",
    sec: 50,
  },
  {
    id: "complementary",
    title: "互补滤波：α 就是「信谁多少」的旋钮",
    body:
      "互补滤波把陀螺仪当高频、加速度计当低频：α 越大越信陀螺仪（响应快、漂得快），越小越信加速度计（稳、但机动时被拽偏）。" +
      "它不是最优解，但只用一行公式就解决 90% 的问题——也是理解后面 Mahony / 卡尔曼的入口。",
    look:
      "文档页里那个<b>实时演示</b>：真值、陀螺仪积分（慢慢漂走）、加速度计（噪声很大）、融合线（四者中最稳）。" +
      "看完按 <b>Esc</b> 回到演示，卡片还在原处。",
    doc: { page: "filters", anchor: "f-comp", label: "互补滤波（含实时演示）" },
    sec: 55,
  },
  {
    id: "gate",
    title: "什么时候不该信加速度计",
    body:
      "机动时加速度计测的是「比力」而不是重力：横向加速度会叠加到读数上，让它指向错误的方向。" +
      "装置用两层门控挡它——幅度门控（‖a‖ 偏离 g 太多就拒绝）与方向门控（与预测重力的夹角超过阈值就拒绝），" +
      "两个阈值都是滑块。这里同时打开方向门控与玻璃盒的逐轴误差读数，方便对照。",
    look:
      "实验已把「加速度计方向门控」打开。切到右侧「算法」面板关掉它，看误差曲线怎么被污染拽起来又下去——" +
      "<b>阈值太松污染穿堂而过、太紧正常机动被误拒</b>，这就是工程取舍。",
    exp: "gate",
    panel: "algo",
    sec: 60,
  },
  {
    id: "magnetic",
    title: "偏航只能靠磁力计（也只靠得住一半）",
    body:
      "加速度计只知道「哪边是下」，对绕地轴的旋转完全无感——所以偏航角必须靠磁力计。" +
      "但磁力计最脆：硬铁偏移把原点挪走、软铁让球变成椭球、电机电流与金属结构带来交变干扰。" +
      "装置用球拟合做硬铁 + 对角软铁校准。",
    look: "启用磁力计后看<b>偏航曲线</b>：没磁时它一直漂，有磁时被拉回真值——但人为加干扰时它又跑了。",
    exp: "magnetic",
    doc: { page: "magcal", label: "磁力计校准：为什么必须做、怎么做（含可搬运代码）" },
    sec: 50,
  },
  {
    id: "margFull",
    title: "两种磁修正：只约束偏航 vs 用整条磁场向量",
    body:
      "简化做法只拿磁力计算偏航角；完整 MARG 做法把磁场向量整个用起来，连磁倾角一起补偿，参考场由测量本身构造（不需要事先知道当地地磁）。" +
      "干净磁场下两者等价；磁场有交变干扰时，完整版的平均误差从 8.5° 降到 1.0°。",
    look: "切换「磁修正形态」对比同一段干扰下的偏航误差；注意完整版也会把干扰「摊」到横滚/俯仰上——这是它的代价。",
    exp: "margFull",
    sec: 50,
  },
  {
    id: "kalman",
    title: "卡尔曼：把「我有多不确定」也画出来",
    body:
      "ESKF 用 6 个状态 <span class=\"mono\">[δθ, δb]</span>：姿态误差 + 陀螺零偏，零偏是<b>在线估计</b>的，所以卡尔曼能把零偏「学会」。" +
      "Q 是过程噪声（我多不信模型）、R 是观测噪声（我多不信传感器）——两者的比值决定它偏信谁。" +
      "右侧玻璃盒打开后能看到 3×3 姿态协方差的不确定度椭球。",
    look:
      "静止收敛时椭球收缩；观测被门控拒绝时它沿某个方向拉长；恢复瞬间猛地缩回去——这就是「增益」在几何上的样子。",
    exp: "kalman-tuning",
    panel: "telemetry",
    doc: { page: "f-kalman-detail", label: "卡尔曼完整推导（与标准做法逐项对照）" },
    sec: 70,
  },
  {
    id: "gimbalGeo",
    title: "万向节锁：几何上到底发生了什么",
    body:
      "俯仰角到 ±90° 时，内外环的旋转轴几何重合——两个环变成同一个动作，三个自由度掉成两个。" +
      "这不是数学缺陷，是<b>任何三环结构的物理必然</b>（真实的机械云台也一样会锁）。" +
      "这个视图里三圈环带、贯穿净空的连接轴与轴承都是按真实结构建的。",
    look:
      "把俯仰拖到 +90°：两环与两根轴变红、环心出现红色脉冲环，读数写「只剩 2 个自由度」。再点「一键演示」——" +
      "用横滚 +60° 与偏航 −60° 两个不同操作得到同一姿态，夹角 0.000°。",
    exp: "gimbal",
    view: "gimbal",
    doc: { page: "math", anchor: "m-lock", label: "万向节锁的矩阵证据" },
    sec: 65,
  },
  {
    id: "gimbalAlgo",
    title: "万向节锁在算法层的后果（实测数据）",
    body:
      "欧拉空间的互补滤波在俯仰恰好 ±90° 时<b>直接失效</b>（实测偏差 161°）；" +
      "四元数类算法不会失效，但在锁点附近可观测性变差，退化成「纯陀螺仪积分」——只能靠陀螺仪硬撑到姿态离开锁区。" +
      "这是「为什么用四元数」最硬的工程理由。",
    look: "看俯仰停在 +90° 那一段时间里<b>互补滤波的误差曲线</b>与四元数算法的差别；切换「滞回恢复窗」还能看到门控的另一面。",
    exp: "lockAlgo",
    view: "attitude",
    sec: 60,
  },
  {
    id: "slerp",
    title: "姿态之间怎么插值：Slerp vs 欧拉逐分量",
    body:
      "姿态不是球面上的点，而是「朝向」——参考球上画的是机头方向的取值空间。" +
      "白弧是 Slerp（旋转群测地线，恒定轴匀速），品红弧是欧拉角三个分量各自线性插值。" +
      "两弧之间的紫色带宽度就是那一处的角距离：多轴预设的中点半路分叉可达 51.6°。",
    look: "起点/终点各有线框四轴：<b>插的是姿态，不是球面上的一个点</b>。拖动「插值进度」看两条路径怎么分开再会合。",
    exp: "slerp",
    view: "quat",
    sec: 55,
  },
  {
    id: "proj",
    title: "4D 立体投影：q 与 −q 是同一个姿态",
    body:
      "四元数是四维单位球 S³ 上的点，本装置把它立体投影到三维球壳上：q 在球内（青）、−q 在球外（品红），互为倒易点。" +
      "连按两次「左乘 i」= 累计旋转 360°：3D 里的姿态复原了，但四元数变了号；按四次（720°）才真正回到 +1。" +
      "这就是「双重覆盖」——它解释了很多四元数公式里那些看着多余的符号。",
    look: "同一个姿态的两颗点（内/外）始终对称；右下 inset 的 S³ 剖面给出「抬升 → 旋转 → 投影」三段式视角。",
    exp: "proj",
    view: "quat",
    sec: 55,
  },
  {
    id: "ins",
    title: "姿态误差怎样变成「飞机飞丢了」",
    body:
      "把姿态估计喂进惯导机械编排（姿态 → 速度 → 位置），误差按时间的<b>三次方</b>增长：" +
      "陀螺零偏 b → 倾角误差 b·t → 加速度误差 g·b·t → 速度 ½g·b·t² → 位置 ⅙g·b·t³。" +
      "同样是 1°/s 的零偏，30 秒后纯积分漂 700 m，而卡尔曼只漂 1.6 m——姿态精度直接换算成位置精度。",
    look: "右侧「惯性导航」面板的俯视图：每条算法一条轨迹，越跑越开；读数表给出「最大漂移」的具体米数。",
    panel: "ins",
    doc: { page: "math", anchor: "m-ins", label: "误差预算：为什么是 t³" },
    sec: 60,
  },
  {
    id: "challenge",
    title: "动手：三道参数整定挑战 + 接下来怎么自己玩",
    body:
      "理论看完了，现在自己调：三道挑战各给一个现场，你要把参数调到评分阈值以内才算通过" +
      "（零偏整定 / 振动整定 / 磁干扰整定，阈值都是实测定的）。三题都要求至少积累 15 秒样本才允许结算——" +
      "「刚点开始就结算」也能过的话，这题目就没意义了。" +
      "之后：<b>实验库</b>有 17 组一键复现的因果链，<b>文档</b>有 13 页带着「是什么 / 起什么作用 / 改了会怎样」的控制项手册，" +
      "快捷键是 <span class=\"mono\">空格</span> 暂停、<span class=\"mono\">R</span> 重置、<span class=\"mono\">1/2/3</span> 切视图、" +
      "<span class=\"mono\">D</span> 文档、<span class=\"mono\">Ctrl/⌘+K</span> 全文搜索。",
    look: "面板里选一道题点「开始」，面板下方的提示会告诉你「改哪个滑块、看哪条曲线、阈值是多少」。",
    panel: "challenge",
    doc: { page: "labs", anchor: "l-path", label: "实验与练习：三条学习路径" },
    sec: 80,
  },
];

/** 整门课程预计用时（分钟，向上取整） */
export function tourMinutes(): number {
  return Math.ceil(TOUR_STEPS.reduce((a, s) => a + s.sec, 0) / 60);
}

/** 由宿主提供的外部动作（只有这三个是本模块办不到的） */
export interface TourHost {
  /** 装载实验库里的一条实验（复用主程序的基线复位与参数写入） */
  applyExperiment(id: string): void;
  /** 打开文档层的某一页（可带页内锚点） */
  openDocs(page: string, anchor?: string): void;
  /** 界面短暂反馈 */
  toast(msg: string): void;
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
export function mountTour(host: TourHost): Tour {
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
    const step = TOUR_STEPS[i];
    if (!card || !step) return;
    card.classList.remove("hidden");
    if (counter) counter.textContent = `第 ${i + 1} / ${TOUR_STEPS.length} 步 · 约 ${step.sec} s`;
    if (title) title.textContent = step.title;
    if (body) body.innerHTML = step.body;
    if (look) look.innerHTML = step.look;
    if (bar) bar.style.width = `${((i + 1) / TOUR_STEPS.length) * 100}%`;
    if (prevBtn) prevBtn.disabled = i === 0;
    if (nextBtn) nextBtn.textContent = i === TOUR_STEPS.length - 1 ? "完成" : "下一步";
    if (docBtn) {
      if (step.doc) {
        docBtn.textContent = `打开文档：${step.doc.label}`;
        docBtn.classList.remove("hidden");
      } else {
        docBtn.classList.add("hidden");
      }
    }
    if (summary) summary.textContent = `第 ${i + 1}/${TOUR_STEPS.length} 步：${step.title}`;
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
      apply(TOUR_STEPS[0]);
      render();
      host.toast(`引导课程已开始：${TOUR_STEPS.length} 步 / 约 ${tourMinutes()} 分钟（随时可停）`);
    },
    exit(): void {
      i = -1;
      card?.classList.add("hidden");
      intro?.classList.remove("hidden");
      startRow?.classList.remove("hidden");
      if (summary) summary.textContent = `共 ${TOUR_STEPS.length} 步 · 约 ${tourMinutes()} 分钟`;
    },
    next(): void {
      if (i < 0) return tour.start();
      if (i === TOUR_STEPS.length - 1) return tour.exit();
      i++;
      apply(TOUR_STEPS[i]);
      render();
    },
    prev(): void {
      if (i <= 0) return;
      i--;
      apply(TOUR_STEPS[i]);
      render();
    },
    goto(n: number): void {
      i = Math.max(0, Math.min(TOUR_STEPS.length - 1, n));
      apply(TOUR_STEPS[i]);
      render();
    },
    active: () => i >= 0,
    index: () => i + 1,
  };

  nextBtn?.addEventListener("click", () => tour.next());
  prevBtn?.addEventListener("click", () => tour.prev());
  $t("tour-close")?.addEventListener("click", () => tour.exit());
  $t("tour-start")?.addEventListener("click", () => tour.start());
  docBtn?.addEventListener("click", () => {
    const step = TOUR_STEPS[i];
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
