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
  // 引导课程那 18 KB 源码是**教学内容正文**（13 步的讲稿），与文档正文同性质：
  // 不是可删的冗余，删掉就是删功能。上限按实测放宽，但仍同时盯 gzip。
  mainJs: 215 * 1024,
  // 实测 72 KB（gzip）——上限留约 11% 余量给下一轮功能，超了就说明又该审视体积了
  mainJsGzip: 80 * 1024,
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

const mainJs = js.filter((f) => !/three-/.test(f));
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
    name: "index.html · 内联文档（16 页，可打印/可搜索）",
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
