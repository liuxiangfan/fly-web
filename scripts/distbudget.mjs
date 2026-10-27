/**
 * 构建产物预算检查（CI 用，也可本地跑）：
 *
 * 存在的理由：一次不经意的 `import "katex/dist/katex.min.css"` 就让产物多背了
 * 59 个字体文件（约 1.17 MB）而没人发现——**产物体积不会自己报警**。
 * 这里对几项容易失控的指标设上限；超限即失败，并在信息里给出当前值与上限。
 *
 * 前置：npm run build
 */
import { readdirSync, statSync, existsSync } from "node:fs";
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
  html: 420 * 1024,           // index.html（7 页文档全部内联，故上限放得较宽）
  mainJs: 180 * 1024,         // 主包 JS（three 单独成 chunk，不计入）
};

const mainJs = js.filter((f) => !/three-/.test(f));
const metrics = [
  { name: "产物总量", value: total, limit: LIMITS.total, detail: `${(total / 1024).toFixed(0)} KB` },
  { name: "字体总量", value: fontBytes, limit: LIMITS.fonts, detail: `${(fontBytes / 1024).toFixed(0)} KB` },
  { name: "字体文件数", value: fonts.length, limit: LIMITS.fontFiles, detail: `共 ${fonts.length} 个`, count: true },
  { name: "index.html", value: sizeOf(html), limit: LIMITS.html, detail: `${(sizeOf(html) / 1024).toFixed(0)} KB` },
  {
    name: "主包 JS",
    value: sizeOf(mainJs),
    limit: LIMITS.mainJs,
    detail: mainJs.map((f) => `${(statSync(f).size / 1024).toFixed(0)}KB`).join(" + "),
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
