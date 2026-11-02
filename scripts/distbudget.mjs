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
 * 预算政策（复核结论：多次上调后 PASS 不等于「旧红线内无回归」）：
 *  - 每次上调都必须在本注释里写清「哪个功能带来的增量」与「为什么不能更小」；
 *  - 上调前先看界面上限：`total 2.0 MB / index.html 600 KB / htmlShell 100 KB`；
 *    当前总量占用约 93%、HTML gzip 约 96%、主包 gzip 约 99%——**已接近上限**，
 *    ROUND12：把「文档页动画演示」改为按需 chunk（首屏 −9 KB gzip），首屏主包回到原来的
 *    285 KB / gzip 108 KB 线**以内**；同时新增「全部 JS 合计 gzip」把按需 chunk/Worker/SW/three
 *    一并封顶——拆包降低首屏，但没有任何代码能溜出总预算。
 *    再要增长必须做「拆包/按需加载」这类结构改动，而不是继续抬数字。
 *  - 冻结参照：2026-10-31 第九轮后 总产物 1893 KB、主包 274 KB(104 gzip)、Worker 41 KB。
 */
const LIMITS = {
  total: 2.0 * 1024 * 1024,   // 全站产物（含所有字体与图标）
  fonts: 900 * 1024,          // 字体总量（Fira 13 个子集 + KaTeX_Main 4 个）
  fontFiles: 24,              // 字体文件数
  // index.html 把全部文档内联（这是产品的核心价值，不是失误），所以上限放得够用；
  // 但**真正影响首次加载的是 gzip 后的大小**，所以两者都查。
  // 历史：开工 271 KB → 文档扩容 365 KB → 协议/BLE/挑战等章节 420 KB → 引导课程轮 424 KB
  // → 磁力计校准页（13 KB 新页：为什么/怎么用/算法+逐段代码/判据）462 KB。
  // 每轮扩容都对应新内容，所以上限是「跟着内容走」而不是「跟着报错走」；但这条线不能无限抬：
  // 若再涨 1–2 轮，正确做法是把文档拆成按需加载的 chunk（代价：全文搜索与打印需要改，
  // 因为现在的搜索是遍历 DOM、打印依赖一次性就绪），而不是继续抬上限。
  // 拆开量之后（本轮实测）：外壳 59 KB、内联文档 441 KB。
  html: 600 * 1024,           // index.html 原始体积（外壳 + 文档，按内容增长）
  htmlGzip: 195 * 1024,       // index.html 传输体积（用户真正下载的；实测 173 KB）
  htmlShell: 100 * 1024,      // **应用外壳硬上限**：骨架/面板/覆盖层/弹窗。这是事故报警线
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
  mainJs: 285 * 1024,
  mainJsGzip: 108 * 1024,
  // 懒加载 Worker（批量评测数值内核的独立副本）：不计入首屏，但同样封顶
  workerJs: 64 * 1024,
  // Service Worker：加载后注册，不进首屏，但同样封顶（此前被算进"主包"）
  swJs: 8 * 1024,
  // 文档页动画演示（按需 chunk）：只在打开文档层时才下载
  docDemosJs: 24 * 1024,
  // 引导课程（按需 chunk）：13 步文案约占 6 KB gzip，只在点「开始」/按 G 时下载
  tourJs: 16 * 1024,
  /**
   * **全部 JS 合计 gzip**（首屏 + 文档演示 + SW + 懒加载 Worker + three）：
   * 这是"不许有代码溜出预算"的总闸。按需拆分可以降低首屏，但总量仍被封在同一根线以内，
   * 所以拆包不能变成"把体积藏起来"。
   */
  allJsGzip: 272 * 1024,
};

/**
 * 把 index.html 拆成「应用外壳」与「内联文档」两部分。
 * 为什么要拆：文档全部内联是本产品的核心设计（单文件 + 离线 PWA + 全文搜索 + 打印），
 * 所以文档会**随着内容增长而合法地变大**；而外壳（骨架/面板/覆盖层/弹窗）一旦膨胀
 * 一定是事故（误引入、误复制）。把两者放在一个上限里，结果是「内容一涨就报警」，
 * 逼着人抬上限——那正是我们要避免的「跟着报错走」。
 * 拆开之后：外壳有硬上限（小、灵敏），文档有宽松上限（大、只防失控）。
 * 定位方式：从 .doc-pages 容器开始做 div 配对扫描（不依赖注释标记，构建压缩后依然成立）。
 */
function splitShellAndDocs(htmlPath, text) {
  const start = text.indexOf('<div class="doc-pages">');
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
const workerJs = js.filter((f) => /batch\.worker-/.test(f));
/**
 * 首屏主包 = index-*.js（**不含** three-、懒加载 Worker，也**不含** sw.js）。
 * sw.js 是 Service Worker：浏览器在页面加载之后才注册它，不进首屏传输路径，
 * 但它同样必须被封顶，所以单列一项（ROUND11：此前它被算进"主包"，把主包上限
 * 挤掉 1.3 KB，掩盖了真正的首屏体积）。
 */
const swJs = js.filter((f) => /sw\.js$/.test(f));
const docDemosJs = js.filter((f) => /doc-demos-/.test(f));
const tourJs = js.filter((f) => /tour-/.test(f));
// 首屏主包 = 除「明确按需加载」之外的全部 JS：three / Worker / SW / 文档演示 / 引导课程。
// 按需 chunk 不计入首屏，但各自有独立上限、并计入「全部 JS 合计 gzip」。
const mainJs = js.filter(
  (f) => !/three-/.test(f) && !/batch\.worker-/.test(f) && !/sw\.js$/.test(f) &&
    !/doc-demos-/.test(f) && !/tour-/.test(f),
);
const metrics = [
  { name: "产物总量", value: total, limit: LIMITS.total, detail: `${(total / 1024).toFixed(0)} KB` },
  { name: "字体总量", value: fontBytes, limit: LIMITS.fonts, detail: `${(fontBytes / 1024).toFixed(0)} KB` },
  { name: "字体文件数", value: fonts.length, limit: LIMITS.fontFiles, detail: `共 ${fonts.length} 个`, count: true },
  {
    name: "index.html",
    value: sizeOf(html),
    limit: LIMITS.html,
    detail: `${(sizeOf(html) / 1024).toFixed(0)} KB（gzip ${(gzipSync(readFileSync(html[0]), { level: 9 }).length / 1024).toFixed(0)} KB）`,
  },
  {
    name: "index.html · 应用外壳（骨架/面板/弹窗）",
    value: split.shell,
    limit: LIMITS.htmlShell,
    detail: `${(split.shell / 1024).toFixed(0)} KB`,
  },
  {
    name: "index.html · 内联文档（15 页，可打印/可搜索）",
    value: split.docs,
    limit: LIMITS.htmlDocs,
    detail: `${(split.docs / 1024).toFixed(0)} KB（gzip ${(split.docsGzip / 1024).toFixed(0)} KB）`,
  },
  {
    name: "index.html（gzip 传输体积）",
    value: gzipSync(readFileSync(html[0]), { level: 9 }).length,
    limit: LIMITS.htmlGzip,
    detail: `${(gzipSync(readFileSync(html[0]), { level: 9 }).length / 1024).toFixed(0)} KB`,
  },
  {
    name: "主包 JS",
    value: sizeOf(mainJs),
    limit: LIMITS.mainJs,
    detail: mainJs.map((f) => `${(statSync(f).size / 1024).toFixed(0)}KB`).join(" + "),
  },
  {
    name: "文档页演示 JS（按需 chunk）",
    value: sizeOf(docDemosJs),
    limit: LIMITS.docDemosJs,
    detail: docDemosJs.length
      ? `${(sizeOf(docDemosJs) / 1024).toFixed(0)} KB（gzip ${(docDemosJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）`
      : "无",
  },  {
    name: "引导课程 JS（按需 chunk）",
    value: sizeOf(tourJs),
    limit: LIMITS.tourJs,
    detail: tourJs.length
      ? `${(sizeOf(tourJs) / 1024).toFixed(0)} KB（gzip ${(tourJs.reduce((sum, f) => sum + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）`
      : "无",
  },

  {
    name: "Service Worker JS（离线缓存，加载后注册）",
    value: sizeOf(swJs),
    limit: LIMITS.swJs,
    detail: swJs.length ? `${(sizeOf(swJs) / 1024).toFixed(0)} KB（gzip ${(swJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB）` : "无",
  },
  {
    name: "批量评测 Worker JS（懒加载）",
    value: sizeOf(workerJs),
    limit: LIMITS.workerJs,
    detail: workerJs.length ? workerJs.map((f) => `${(statSync(f).size / 1024).toFixed(0)}KB`).join(" + ") : "无",
  },
  {
    name: "全部 JS 合计（gzip，含按需 chunk/three/Worker/SW）",
    value: js.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0),
    limit: LIMITS.allJsGzip,
    detail: `${(js.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB / 共 ${js.length} 个 JS`,
  },
  {
    name: "主包 JS（gzip 传输体积）",
    value: mainJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0),
    limit: LIMITS.mainJsGzip,
    detail: `${(mainJs.reduce((s, f) => s + gzipSync(readFileSync(f), { level: 9 }).length, 0) / 1024).toFixed(0)} KB`,
  },
];
void css;

let failures = 0;
for (const m of metrics) {
  const ok = m.value <= m.limit;
  if (!ok) failures++;
  const pct = ((m.value / m.limit) * 100).toFixed(0);
  const limitText = m.count ? `${m.limit} 个` : `${(m.limit / 1024).toFixed(0)} KB`;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${m.name} — ${m.detail}（上限 ${limitText}，占用 ${pct}%）`);
}
console.log(failures === 0 ? "\n产物预算全部通过 ✅" : `\n${failures} 项超出预算 ❌`);
process.exit(failures === 0 ? 0 : 1);
