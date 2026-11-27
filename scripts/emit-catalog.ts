/**
 * 生成 public/data/*.json —— 纯教学数据的「外部化」产物。
 *
 * 为什么要有这个脚本：
 * 实验库、挑战、引导课程与学习活动是纯数据，却和渲染逻辑一起被打进 JS chunk，按 gzip 计费。
 * 把它们写成 public/data 下的 JSON 后，运行时用 fetch 读取，JS chunk 只剩渲染/驱动代码；
 * 数据本身仍由 TS 模块（src/ui/experiments.ts、src/ui/challenges.ts、
 * src/ui/learning-activity-data.ts 与本文件里的 TOUR_STEPS）作为唯一真源，
 * 供自检、契约测试与本次生成使用。
 *
 * 产物是**确定性**的：递归按键名排序、2 空格缩进、文件末尾一个换行。
 * 同一份 TS 源重复运行 `npm run catalog` 必须产生字节相同的 JSON，因此可以提交到仓库；
 * `npm run build` 通过 `prebuild` 自动重跑本脚本，避免手改 JSON 与 TS 源漂移。
 *
 * 运行：npm run catalog（或 npm run build 的 prebuild 阶段）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENTS, type ExperimentSpec } from "../src/ui/experiments";
import { CHALLENGES, type ChallengeSpec } from "../src/ui/challenges";
import { LEARNING_ACTIVITIES } from "../src/ui/learning-activity-data";
import type { LearningActivity } from "../src/ui/learning-activities";
import type { TourStep } from "../src/ui/tour";

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
      "互补滤波把陀螺仪当高频、加速度计当低频：α 越大，观测修正速率越大（更快靠近加速度计/磁力计的测量，也更容易被它们的污染带走）；" +
      "α 越小，越依赖陀螺仪预测（更平滑，但收敛慢、漂移残留更明显）。" +
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
      "从重置开始，连按两次「右乘 i」= 累计旋转 360°：3D 姿态复原，四元数却变号；按四次（720°）才回到 +1。" +
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
      "之后：<b>实验库</b>有 19 组一键复现的因果链（每条都有实验种子与完整基线，可复现）、<b>文档</b>共 15 页（控制项手册里每个滑块都有一条「是什么 / 起什么作用 / 改了会怎样」），" +
      "快捷键是 <span class=\"mono\">空格</span> 暂停、<span class=\"mono\">R</span> 重置、<span class=\"mono\">1/2/3</span> 切视图、" +
      "<span class=\"mono\">D</span> 文档、<span class=\"mono\">Ctrl/⌘+K</span> 全文搜索。",
    look: "面板里选一道题点「开始」，面板下方的提示会告诉你「改哪个滑块、看哪条曲线、阈值是多少」。",
    panel: "challenge",
    doc: { page: "labs", anchor: "l-path", label: "实验与练习：三条学习路径" },
    sec: 80,
  },
];

export interface CatalogDocuments {
  experiments: readonly ExperimentSpec[];
  challenges: readonly ChallengeSpec[];
  tour: readonly TourStep[];
  activities: readonly LearningActivity[];
}

/** 纯函数：四份目录的唯一真源（测试与生成共用；不读写文件）。 */
export function catalogDocuments(): CatalogDocuments {
  return {
    experiments: EXPERIMENTS,
    challenges: CHALLENGES,
    tour: TOUR_STEPS,
    activities: LEARNING_ACTIVITIES,
  };
}

/** 递归排序对象键（数组保持顺序），使序列化结果与属性插入顺序无关。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = stableValue(child);
    }
    return out;
  }
  return value;
}

/** 确定性序列化：稳定键序 + 紧凑输出 + 末尾换行（只供运行时 fetch/测试解析）。 */
export function serializeCatalog(doc: unknown): string {
  // 两空格美化会额外占约 5.8 KB 总产物；目录不是人读文件，按体积预算改单行。
  return `${JSON.stringify(stableValue(doc))}\n`;
}

/** 逻辑名 → 输出文件名。顺序固定，便于报告与测试遍历。 */
export const CATALOG_FILES = {
  experiments: "experiments.json",
  challenges: "challenges.json",
  tour: "tour.json",
  activities: "activities.json",
} as const;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 写出四份 JSON，返回写入路径与字节数（供 CLI 报告）。 */
export function emitCatalog(outDir = resolve(ROOT, "public/data")): string[] {
  const docs = catalogDocuments();
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const key of Object.keys(CATALOG_FILES) as Array<keyof typeof CATALOG_FILES>) {
    const file = resolve(outDir, CATALOG_FILES[key]);
    const text = serializeCatalog(docs[key]);
    writeFileSync(file, text, "utf8");
    written.push(`${file} (${Buffer.byteLength(text, "utf8")} B)`);
  }
  return written;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  for (const line of emitCatalog()) console.log(`catalog: ${line}`);
}
