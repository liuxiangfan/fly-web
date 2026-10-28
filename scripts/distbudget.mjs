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
  // index.html 把全部文档内联（这是产品的核心价值，不是失误），所以上限放得宽；
  // 但**真正影响首次加载的是 gzip 后的大小**，所以两者都查。
  // 历史：开工时 271 KB → 文档扩容到 365 KB → 本轮再加协议/BLE/挑战等章节到 420 KB，
  // 每轮扩容都有对应的新内容，故此处的上限是「跟着内容走」而不是「跟着报错走」。
  html: 460 * 1024,           // index.html 原始体积
  htmlGzip: 165 * 1024,       // index.html 传输体积（这才是用户真正下载的）
  // 主包 JS（three 单独成 chunk，不计入）。历史：开工时 111 KB，
  // 本轮前后加了 INS/协议/挑战/BLE 等一大批功能后到 172 KB——都是真代码，没有明显的可删项。
  // 上限按实测放宽，但仍同时盯 gzip（用户真正下载的量）。
  mainJs: 210 * 1024,
  // 实测 66 KB（gzip）——上限留约 14% 余量给下一轮功能，超了就说明又该审视体积了
  mainJsGzip: 75 * 1024,
};

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
