/**
 * 构建产物预算检查（CI 用，也可本地跑）：
 *
 * 存在的理由：一次不经意的 `import "katex/dist/katex.min.css"` 就让产物多背了
 * 59 个字体文件（约 1.17 MB）而没人发现——**产物体积不会自己报警**。
 * 这里对几项容易失控的指标设上限；超限即失败，并在信息里给出当前值与上限。
 *
 * 前置：npm run build
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
// 判定是纯函数（SW-09）：边界值用真实数字测，不靠匹配源码字符串
import { budgetVerdict, headroomSummary, verdictLine } from "./budget-core.mjs";

const DIST = "dist";
const ASSETS = join(DIST, "assets");
if (!existsSync(DIST)) {
  console.error("找不到 dist/——先运行 npm run build");
  process.exit(2);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const files = walk(DIST);
const sizeOf = (fs) => fs.reduce((s, f) => s + statSync(f).size, 0);
const total = sizeOf(files);
const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
const fontBytes = sizeOf(fonts);
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));
const html = files.filter((f) => f.endsWith(".html"));

/**
 * 预算政策（**正式决策 · 2026-11-03**：判据从「不超过上限」改成「占用率 ≤ 90%」）
 *
 * 为什么改：原来的上限是"贴着现状"设的（主包 gzip 104/108 = 96%、全部 JS 265/272 = 97%），
 * 于是**任何一次合法改动都可能把门禁判红**，反过来逼着人抬数字——抬数字又让下一次更容易红。
 * 这不是质量信号，是把预算当成了橡皮筋。
 *
 * 更关键的是分母问题：全部 JS 合计里 **three 占 130.9/265 KB gzip（49%）**，它是上游 vendor，
 * 本项目删掉任何教学功能都不会让它变小；把这个固定量放进百分比分母，
 * 就算应用代码再省 30%，聚合项也永远到不了 10% 余量（实测三次重构尝试的结论：
 * 删死代码 0 处、PBR 材质换 Lambert 对 three chunk 体积**零影响**——其体积由上游实现决定）。
 *
 * 因此判据改为：**每个受控产物都必须留 ≥10% 余量**（占用率 ≤90%），由本脚本自己强制；
 * 上限值一次性按当前实测重设并写明来源，之后任何改动把占用率推到 90% 以上都会判红——
 * **这才是"抓得住回归、抓不住正常改动"的门禁**。vendor（three）不单列百分比判据，
 * 它随上游版本变化，只受聚合项的总额约束。
 *
 * 历史政策（复核结论：多次上调后 PASS 不等于「旧红线内无回归」）：
 *  - 每次上调都必须在本注释里写清「哪个功能带来的增量」与「为什么不能更小」；
 *  - 上调前先看界面上限：`total 2.0 MB / index.html 600 KB / htmlShell 100 KB`；
 *    当前总量占用约 93%、HTML gzip 约 96%、主包 gzip 约 99%——**已接近上限**，
 *    ROUND12：把「文档页动画演示」改为按需 chunk（首屏 −9 KB gzip），首屏主包回到原来的
 *    285 KB / gzip 108 KB 线**以内**；同时新增「全部 JS 合计 gzip」把按需 chunk/Worker/SW/three
 *    一并封顶——拆包降低首屏，但没有任何代码能溜出总预算。
 *    再要增长必须做「拆包/按需加载」这类结构改动，而不是继续抬数字。
 *  - 冻结参照：2026-10-31 第九轮后 总产物 1893 KB、主包 274 KB(104 gzip)、Worker 41 KB。
 */

/**
 * **冻结基线**（2026-11-03 · 提交 830e4e3 实测）：`Δ` 让"这轮长了多少"可比较，
 * 而不是只看"还没到上限"。基线与上限同口径（同一测量方式、同一单位）。
 * 数据来源：`.audit-current/budget-review-830e4e3.log`（该提交上跑出的预算报告）。
 */
/**
 * **2026-11-16 P2 一次性调线记录（项目所有者决策）**
 *
 * 触发：C/D（可观性＋事件时间轴、历史回看＋ESKF 解剖）接线后按原门槛实测失败——
 * 全部 JS 285.1 KiB / 有效 270、总产物 2020.4 KiB / 有效 1980、教学 chunk 123.8 KiB / 有效 115.2（阶段 E 交互收敛后最终 C/D 形态为 285.7 / 2023.3 / 123.9 KiB）。
 * P1（接线＋归因＋一轮减重）已执行并记录：共享转义、`worker-core` 统一（修复 Worker 反向引用教学 UI）、
 * 懒加载 preload 过滤均已完成；缺口来自 C/D 净新增代码，继续减只能删功能/删测试/改规则。
 *
 * 本次只调整三项上限并冻结新基线，其余项（主包 raw/gzip、外壳、字体、目录、Worker 入口等）保持不变。
 * **该理由只覆盖本次已声明的 C/D 功能，后续新增功能不得沿用。**
 * SW-09 的 244.8 KiB 减重目标保留为未达成的历史记录，本次调线不表示减重完成。
 */
const BASELINES = {
  total: 2023 * 1024, // 2026-11-16 P2 新基线（含 C/D 与阶段 E 交互收敛）
  fonts: 399 * 1024,
  fontFiles: 17,
  html: 537 * 1024,
  htmlShell: 71 * 1024,
  htmlDocs: 466 * 1024,
  htmlGzip: 186 * 1024,
  mainJs: 271 * 1024,
  docDemosJs: 22 * 1024,
  tourJs: 12 * 1024,
  catalogJs: 0,
  comparisonJs: 124 * 1024, // 2026-11-16 P2 新基线（含 C/D）
  diagnosticsJs: 48 * 1024,
  toolsUi: 0, // 新增按需分类沿用 runner 的零基线，Δ 显示其完整实测体积。
  runnerJs: 0,
  swJs: 3 * 1024,
  workerJs: 45 * 1024,
  allJsGzip: 286 * 1024, // 2026-11-16 P2 新基线（含 C/D 与阶段 E 交互收敛）
  mainJsGzip: 101 * 1024,
};

const LIMITS = {
  total: 2255 * 1024, // 2026-11-16 P2：C/D+阶段E实测 2023.3 KB + 6.2 KiB 余量；仅本次调整
  fonts: 460 * 1024,          // 字体总量（Fira 13 个子集 + KaTeX_Main 4 个）；实测 399 KB
  fontFiles: 24,              // 字体文件数
  // index.html 把全部文档内联（这是产品的核心价值，不是失误），所以上限放得够用；
  // 但**真正影响首次加载的是 gzip 后的大小**，所以两者都查。
  // 历史：开工 271 KB → 文档扩容 365 KB → 协议/BLE/挑战等章节 420 KB → 引导课程轮 424 KB
  // → 磁力计校准页（13 KB 新页：为什么/怎么用/算法+逐段代码/判据）462 KB。
  // 每轮扩容都对应新内容，所以上限是「跟着内容走」而不是「跟着报错走」；但这条线不能无限抬：
  // 若再涨 1–2 轮，正确做法是把文档拆成按需加载的 chunk（代价：全文搜索与打印需要改，
  // 因为现在的搜索是遍历 DOM、打印依赖一次性就绪），而不是继续抬上限。
  // 拆开量之后（本轮实测）：外壳 59 KB、内联文档 441 KB。
  html: 620 * 1024,           // index.html 原始体积（外壳 + 文档）；实测 538 KB
  htmlGzip: 215 * 1024,       // index.html 传输体积（用户真正下载的）；实测 186 KB
  htmlShell: 85 * 1024,       // **应用外壳硬上限**：骨架/面板/覆盖层/弹窗。事故报警线；实测 71 KB
  htmlDocs: 700 * 1024,       // 内联文档上限（宽松，只防「同一段内容被复制粘贴进两页」这类失控）
  // 主包 JS（three 单独成 chunk，不计入）。历史：开工时 111 KB → 加 INS/协议/挑战/BLE
  // 到 172 KB → 抽出文档演示模块（-10 KB）→ 再加引导课程（+10 KB）到 182 KB。
  // 2026-10-30 可复现轮：新增确定性实验配置、无 DOM runner、批量评测、实验档案、单步/游标、
  // NIS/NEES 与卡尔曼数值失败处理、Wahba/圆锥演示；随后又补 online-fork 状态复制、协方差重置、
  // 完整 3×3 磁椭球、六面校准 UI、传感器带宽/异步延迟、运动学一致场景与全帧记录。
  // 2026-10-31 闭环一致性轮：配置档案校准往返、导出 IMU 语义元数据与回放校准开关、日志真值波形、
  // 唯一运行内核 + 静止粗对准、SO(3) 误差分解、采样率噪声换算、A/B 克隆唯一来源。
  // 2026-10-31 可验证性轮：界面与 runner 共用解算调度（core/solve-loop.ts）、校准器件指纹与失效提示
  // （core/calib-meta.ts）、Worker 的 jobId/取消/心跳、逐帧比对出口（stepSimBy/runTrace）。
  // 实测主包 268 KB / gzip 102 KB（懒加载 Worker 41 KB 单独计量），上限按实测留约 5% 余量。
  mainJs: 315 * 1024,         // 实测 279 KB
  mainJsGzip: 120 * 1024,     // 实测 104 KB
  // 懒加载 Worker（批量评测数值内核的独立副本）：不计入首屏，但同样封顶
  workerJs: 56 * 1024,        // 实测 45 KB
  // Service Worker：加载后注册，不进首屏，但同样封顶（此前被算进"主包"）
  swJs: 8 * 1024,
  // 文档页动画演示（按需 chunk）：只在打开文档层时才下载
  docDemosJs: 26 * 1024,      // 实测 22 KB
  // 引导课程（按需 chunk）：13 步文案约占 6 KB gzip，只在点「开始」/按 G 时下载
  tourJs: 16 * 1024,
  // 实验库 / 参数挑战目录（按需 chunk）：纯数据，打开对应面板时才下载。
  // 从首屏主包移出后单列上限，避免它们悄悄长成第二个主包。
  catalogJs: 20 * 1024,
  // 单变量对照台（按需 chunk）：面板、视图、报告与共享配置；打开对照面板才下载。
  comparisonJs: 144 * 1024, // 2026-11-16 P2：C/D 接线实测 123.8 KB + 余量
  // 诊断 UI（可观性/事件/回看/ESKF）独立按需 chunk：与教学台分开计量，
  // 避免任一功能增长挤占对照台/任务条的余量；该项为 FIX 轮新增，未上调任何既有上限。
  diagnosticsJs: 64 * 1024,
  // CSV 导出弹窗的独立按需分类：只在打开导出弹窗时下载，不计入首屏主包；
  // 实验报告并入 teaching-ui 计量（与对照/学习面板共享文案字典，且有空闲预取）。
  toolsUi: 24 * 1024,
  // 共享数值内核（runner/trace 依赖）按需加载；主线程与 Worker 引用同一份产物，
  // 因此单列总量上限，不重复计入首屏主包。
  runnerJs: 96 * 1024,
  /**
   * **全部 JS 合计 gzip**（首屏 + 文档演示 + SW + 懒加载 Worker + three）：
   * 这是"不许有代码溜出预算"的总闸。按需拆分可以降低首屏，但总量仍被封在同一根线以内，
   * 所以拆包不能变成"把体积藏起来"。
   */
  // 2026-11-20 所有者授权（阶段3只读实验报告）：实测新增约 2.0 KiB gzip，
  // 已先做真实减重（重连编排去重、导出弹窗按需化、内嵌对照浅校验、报告并入
  // teaching-ui 共享字典）仍超线 2.0 KiB；按 P2「有归因调线」先例仅本项名义
  // 325→328 KiB（有效 292.5→295.2），其余 18 项上限与全部验收标准不动。
  allJsGzip: 328 * 1024, // 2026-11-16 P2：C/D 接线实测 285.1 KiB + 阶段 E 余量（见下方 P2 说明）；2026-11-20 阶段3授权 +3 KiB
};

/**
 * 把 index.html 拆成「应用外壳」与「内联文档」两部分。
 * 为什么要拆：文档全部内联是本产品的核心设计（单文件 + 离线 PWA + 全文搜索 + 打印），
 * 所以文档会**随着内容增长而合法地变大**；而外壳（骨架/面板/覆盖层/弹窗）一旦膨胀
 * 一定是事故（误引入、误复制）。把两者放在一个上限里，结果是「内容一涨就报警」，
 * 逼着人抬上限——那正是我们要避免的「跟着报错走」。
 * 拆开之后：外壳有硬上限（小、灵敏），文档有宽松上限（大、只防失控）。
 * 定位方式：从 .doc-pages 容器开始做 div 配对扫描（兼容构建压缩后的无引号属性，不依赖注释标记）。
 */
function splitShellAndDocs(htmlPath, text) {
  const start = text.search(/<div class=(?:"doc-pages"|doc-pages)>/);
  if (start < 0) {
    console.error(`找不到 .doc-pages 容器：${htmlPath}`);
    process.exit(2);
  }
  let depth = 0;
  let i = start;
  let end = -1;
  while (i < text.length) {
    if (text.startsWith("<div", i)) depth++;
    else if (text.startsWith("</div>", i)) {
      depth--;
      if (depth === 0) {
        end = i + 6;
        break;
      }
    }
    i++;
  }
  if (end < 0) {
    console.error(`.doc-pages 容器没有闭合：${htmlPath}`);
    process.exit(2);
  }
  const docsText = text.slice(start, end);
  return {
    docs: Buffer.byteLength(docsText, "utf8"),
    shell: Buffer.byteLength(text, "utf8") - Buffer.byteLength(docsText, "utf8"),
    docsGzip: gzipSync(Buffer.from(docsText, "utf8"), { level: 9 }).length,
  };
}
const htmlText = readFileSync(html[0], "utf8");
const split = splitShellAndDocs(html[0], htmlText);

// 懒加载的 Worker（批量评测）：只在点「运行批量评测」时才下载，不算首屏主包体积，
// 但必须单独设上限——否则它可以悄悄长成第二个主包。
const workerJs = js.filter((f) => /\.worker-/.test(f));
/**
 * 首屏主包 = index-*.js（**不含** three-、懒加载 Worker，也**不含** sw.js）。
 * sw.js 是 Service Worker：浏览器在页面加载之后才注册它，不进首屏传输路径，
 * 但它同样必须被封顶，所以单列一项（ROUND11：此前它被算进"主包"，把主包上限
 * 挤掉 1.3 KB，掩盖了真正的首屏体积）。
 */
const swJs = js.filter((f) => /sw\.js$/.test(f));
const docDemosJs = js.filter((f) => /doc-demos-/.test(f));
const tourJs = js.filter((f) => /tour-/.test(f));
const catalogJs = js.filter((f) => /experiments-/.test(f) || /challenges-/.test(f));
const comparisonJs = js.filter((f) =>
  /teaching-ui-/.test(f) || /comparison-ui-/.test(f) || /comparison-config-/.test(f) ||
  /comparison-(panel|view|report)-/.test(f) || /task-strip-/.test(f) || /learning-panel-/.test(f),
);
const diagnosticsJs = js.filter((f) => /diagnostics-ui-/.test(f));
const toolsJs = js.filter((f) => /tools-ui-/.test(f));
const runnerJs = js.filter((f) => /runner-/.test(f) || /trace-events-/.test(f));
// 首屏主包 = 除「明确按需加载」之外的全部 JS：three / Worker / SW / 文档演示 / 引导课程。
// 按需 chunk 不计入首屏，但各自有独立上限、并计入「全部 JS 合计 gzip」。
const mainJs = js.filter(
  (f) => !/three-/.test(f) && !/\.worker-/.test(f) && !/sw\.js$/.test(f) &&
    !/doc-demos-/.test(f) && !/tour-/.test(f) &&
    !/experiments-/.test(f) && !/challenges-/.test(f) &&
    !/comparison-(panel|view|report|config)-/.test(f) && !/task-strip-/.test(f) &&
    !/learning-panel-/.test(f) && !/teaching-ui-/.test(f) && !/comparison-ui-/.test(f) && !/diagnostics-ui-/.test(f) &&
    !/tools-ui-/.test(f) && !/runner-/.test(f) && !/trace-events-/.test(f),
);
const metrics = [
  { name: "产物总量", value: total, limit: LIMITS.total, baseline: BASELINES.total, detail: `${(total / 1024).toFixed(0)} KB` },
  { name: "字体总量", value: fontBytes, limit: LIMITS.fonts, baseline: BASELINES.fonts, detail: `${(fontBytes / 1024).toFixed(0)} KB` },
  { name: "字体文件数", value: fonts.length, limit: LIMITS.fontFiles, baseline: BASELINES.fontFiles, detail: `共 ${fonts.length} 个`, count: true },
  {
    name: "index.html",
    value: sizeOf(html),
    limit: LIMITS.html, baseline: BASELINES.html,
    detail: `${(sizeOf(html) / 1024).toFixed(0)} KB（gzip ${(gzipSync(readFileSync(html[0]), { level: 9 }).length / 1024).toFixed(0)} KB）`,
  },
  {
    name: "index.html · 应用外壳（骨架/面板/弹窗）",
    value: split.shell,
    limit: LIMITS.htmlShell, baseline: BASELINES.htmlShell,
    detail: `${(split.shell / 1024).toFixed(0)} KB`,
  },
  {
    name: "index.html · 内联文档（15 页，可打印/可搜索）",
    value: split.docs,
    limit: LIMITS.htmlDocs, baseline: BASELINES.htmlDocs,
    detail: `${(split.docs / 1024).toFixed(0)} KB（gzip ${(split.docsGzip / 1024).toFixed(0)} KB）`,
  },
  {
    name: "index.html（gzip 传输体积）",
    value: gzipSync(readFileSync(html[0]), { level: 9 }).length,
    limit: LIMITS.htmlGzip, baseline: BASELINES.htmlGzip,
    detail: `${(gzipSync(readFileSync(html[0]), { level: 9 }).length / 1024).toFixed(0)} KB`,
  },
  {
    name: "主包 JS",
    value: sizeOf(mainJs),
    limit: LIMITS.mainJs, baseline: BASELINES.mainJs,
    detail: mainJs.map((f) => `${(statSync(f).size / 1024).toFixed(0)}KB`).join(" + "),
  },
  {
    name: "文档页演示 JS（按需 chunk）",
    value: sizeOf(docDemosJs),
    limit: LIMITS.docDemosJs, baseline: BASELINES.docDemosJs,
    detail: docDemosJs.length
      ? `${(sizeOf(docDemosJs) / 1024).toFixed(0)} KB（gzip ${(docDemosJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）`
      : "无",
  },  {
    name: "引导课程 JS（按需 chunk）",
    value: sizeOf(tourJs),
    limit: LIMITS.tourJs, baseline: BASELINES.tourJs,
    detail: tourJs.length
      ? `${(sizeOf(tourJs) / 1024).toFixed(0)} KB（gzip ${(tourJs.reduce((sum, f) => sum + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）`
      : "无",
  },

  {
    name: "实验/挑战目录 JS（按需 chunk）",
    value: sizeOf(catalogJs),
    limit: LIMITS.catalogJs, baseline: BASELINES.catalogJs,
    detail: catalogJs.length
      ? `${(sizeOf(catalogJs) / 1024).toFixed(1)} KB（gzip ${(catalogJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(1)} KB）`
      : "无",
  },
  {
    name: "教学交互按需 JS（对照台/任务条）",
    value: sizeOf(comparisonJs),
    limit: LIMITS.comparisonJs, baseline: BASELINES.comparisonJs,
    detail: comparisonJs.length
      ? `${(sizeOf(comparisonJs) / 1024).toFixed(1)} KB（gzip ${(comparisonJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(1)} KB）`
      : "无",
  },
  {
    name: "诊断按需 JS（可观性/事件/回看/ESKF）",
    value: sizeOf(diagnosticsJs),
    limit: LIMITS.diagnosticsJs, baseline: BASELINES.diagnosticsJs,
    detail: diagnosticsJs.length
      ? `${(sizeOf(diagnosticsJs) / 1024).toFixed(1)} KB（gzip ${(diagnosticsJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(1)} KB）`
      : "无",
  },
  {
    name: "CSV 导出 JS（按需 tools-ui）",
    value: sizeOf(toolsJs),
    limit: LIMITS.toolsUi, baseline: BASELINES.toolsUi,
    detail: toolsJs.length
      ? `${(sizeOf(toolsJs) / 1024).toFixed(1)} KB（gzip ${(toolsJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(1)} KB）`
      : "无",
  },
  {
    name: "共享数值内核 JS（按需 runner/trace）",
    value: sizeOf(runnerJs),
    limit: LIMITS.runnerJs, baseline: BASELINES.runnerJs,
    detail: runnerJs.length
      ? `${(sizeOf(runnerJs) / 1024).toFixed(1)} KB（gzip ${(runnerJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(1)} KB）`
      : "无",
  },
  {
    name: "Service Worker JS（离线缓存，加载后注册）",
    value: sizeOf(swJs),
    limit: LIMITS.swJs, baseline: BASELINES.swJs,
    detail: swJs.length ? `${(sizeOf(swJs) / 1024).toFixed(0)} KB（gzip ${(swJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）` : "无",
  },
  {
    name: "评测 Worker 入口 JS（懒加载）",
    value: sizeOf(workerJs),
    limit: LIMITS.workerJs, baseline: BASELINES.workerJs,
    detail: workerJs.length ? workerJs.map((f) => `${(statSync(f).size / 1024).toFixed(0)}KB`).join(" + ") : "无",
  },
  {
    name: "全部 JS 合计（gzip，含按需 chunk/three/Worker/SW）",
    value: js.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0),
    limit: LIMITS.allJsGzip, baseline: BASELINES.allJsGzip,
    detail: `${(js.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB / 共 ${js.length} 个 JS`,
  },
  {
    name: "主包 JS（gzip 传输体积）",
    value: mainJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0),
    limit: LIMITS.mainJsGzip, baseline: BASELINES.mainJsGzip,
    detail: `${(mainJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB`,
  },
];
void css;

/**
 * 逐项判定走 `budgetVerdict`（纯函数），本文件只负责"测量"与"打印"。
 * 打印口径：名义上限 / 有效门槛 / 剩余字节 / 相对冻结基线增量——四个数缺一不可，
 * 否则"余量 10%"会被读成"已经减少了传输量"（复核点名的误读）。
 */
let failures = 0;
const rows = [];
for (const m of metrics) {
  const verdict = budgetVerdict({ value: m.value, limit: m.limit, count: !!m.count, baseline: m.baseline ?? null });
  if (!verdict.ok) failures++;
  rows.push({ name: m.name, verdict });
  console.log(`${verdictLine(m.name, verdict)} ｜ ${m.detail}`);
}
console.log(failures === 0 ? headroomSummary(rows) : `\n${failures} 项超出预算 ❌（先减重，不要抬名义上限）`);
process.exit(failures === 0 ? 0 : 1);
