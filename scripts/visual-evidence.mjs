/**
 * 视觉验收证据（**版本化**）：
 *
 *   · 视口：320×568 / 390×844 / 768×1024 / 1440×900
 *   · 200% 文字缩放（用 deviceScaleFactor=2 + 半尺寸 CSS 视口精确模拟，而不是改 fontSize）
 *   · 文档页（数学排版）、打印媒体（A4 与桌面两张）、三种 3D 视图（姿态 / 万向节 / 四元数）
 *
 * 为什么要有这个脚本（复核 P2「证据治理」）：旧视觉证据只留在被 gitignore 的
 * `screenshots/visual-e67f551/` 里，既不能证明它对应哪个提交，也没法被复核者复现。
 * 这里把**可版本化的事实**（视口、尺寸、sha256、源码摘要、commit、时间窗）写进
 * `docs/generated/visual-evidence.json`（随仓库走），PNG 仍然放本地目录但可被哈希定位。
 *
 * 前置：`npm run build && npm run preview`（默认 http://127.0.0.1:4173）
 * 用法：node scripts/visual-evidence.mjs [--report=<尚不存在的新报告路径>] [--url=...]
 * PNG 固定按 sourceDigest/buildId/captureId（UUID）分目录；同 digest 复采也绝不复用。
 */
import puppeteer from "puppeteer-core";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigest, worktreeState } from "./source-digest.mjs";
import { readProvenance } from "./build-provenance.mjs";
import { captureIdentity, captureDriftProblems, fetchServedProvenance, identityProblems } from "./served-build.mjs";
import { testArtifactTempDir, cleanupArtifactDir } from "./test-artifacts.mjs";

export function reserveVisualCapture(root, source, provenance, { captureId = randomUUID(), out, report } = {}) {
  if (!/^[0-9a-f]{32}$/.test(source.digest) || !/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(provenance?.buildId ?? "") || !/^[0-9a-f-]{36}$/.test(captureId)) {
    throw new Error("视觉采集缺少合法 sourceDigest/buildId/captureId");
  }
  const outDir = resolve(root, `screenshots/visual-${source.digest}/${provenance.buildId}/${captureId}`);
  const reportPath = resolve(root, report ?? `docs/generated/visual-evidence-${source.digest}-${provenance.buildId}-${captureId}.json`);
  if (out && resolve(root, out) !== outDir) throw new Error(`--out 必须使用本次独立目录 ${outDir}`);
  if (existsSync(outDir) || existsSync(reportPath)) throw new Error("采集目录/报告已存在，拒绝覆盖旧证据");
  mkdirSync(dirname(outDir), { recursive: true });
  mkdirSync(outDir); // 不用 recursive：同一次采集 id 重入必须失败。
  return { captureId, outDir, reportPath };
}

async function main() {
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = args.url ?? process.env.SHOT_URL ?? "http://localhost:4173/";
const sha = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const source = sourceDigest(root);
const identityBefore = captureIdentity(root);
const localProvenance = readProvenance(join(root, "dist"));
if (!localProvenance || localProvenance.sourceDigest !== source.digest || localProvenance.distHash !== identityBefore.distHash) {
  throw new Error("源码/本地产物/溯源不一致，先冻结源码并 build 后再采集");
}
const { captureId, outDir, reportPath } = reserveVisualCapture(root, source, localProvenance, args);

const CANDIDATES = [
  process.env.CHROME_PATH, process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean).filter((p) => existsSync(p));
if (CANDIDATES.length === 0) { console.error("[FAIL] 找不到 Chrome/Edge，可用 CHROME_PATH 指定"); process.exit(2); }
/**
 * 逐个尝试候选浏览器：某些 Windows 环境下 Edge 的 crashpad 启动即失败，
 * 换 Chrome 即可；不能因为"第一个存在的可执行文件打不开"就让整次采集判失败。
 */
async function launchAny(options) {
  let lastError = null;
  for (const exe of CANDIDATES) {
    try { return await puppeteer.launch({ ...options, executablePath: exe }); }
    catch (error) { lastError = error; console.warn(`[warn] 浏览器候选启动失败：${exe}`); }
  }
  throw lastError ?? new Error("没有可用的浏览器候选");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
const profileDir = testArtifactTempDir("visual", "visual-");
process.on("exit", () => cleanupArtifactDir(profileDir));
const browser = await launchAny({ headless: "new", userDataDir: profileDir, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const browserVersion = await browser.version();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));

/** 每个视口一张：等首帧 → 等一会儿让曲线长出来 → 截图。 */
const shots = [];
async function capture(name, { width, height, dpr = 1, print = false, before = null, waitMs = 1500, note = "", expectView = null, expectDoc = null }) {
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 60000 });
  if (before) await page.evaluate(before);
  if (print) await page.emulateMediaType("print");
  await sleep(waitMs);
  const file = join(outDir, `${name}.png`);
  // 用页面的实际滚动高度裁切，避免把空白当"布局正常"的证据
  await page.screenshot({ path: file, fullPage: false });
  const buf = readFileSync(file);
  const metrics = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    docH: document.documentElement.scrollHeight,
    view: document.body.dataset.view ?? null,
    docPage: document.querySelector("article[data-doc-page]:not([hidden])")?.dataset.docPage ?? null,
    docsOpen: !document.getElementById("docs-overlay")?.hidden,
  }));
  // 截图工具最容易犯的错是"点了但没生效"，然后把同一张图当成两张证据——当场判失败而不是留下假证据。
  if (expectView && metrics.view !== expectView) throw new Error(`${name}: 期望视图 ${expectView}，实际 ${metrics.view}`);
  if (expectDoc && metrics.docPage !== expectDoc) throw new Error(`${name}: 期望文档页 ${expectDoc}，实际 ${metrics.docPage}`);
  shots.push({
    name, file: relative(root, file).split("\\").join("/"), note,
    viewport: { width, height, deviceScaleFactor: dpr, printMedia: print },
    bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"),
    metrics,
  });
  console.log(`[shot] ${name} — ${width}×${height}@${dpr}${print ? "（打印媒体）" : ""} → ${buf.length} B，横向溢出=${metrics.scrollW > metrics.innerW}`);
  if (print) await page.emulateMediaType("screen");
}

const viewButton = (v) => `(() => { document.querySelector('#view-seg .seg-btn[data-view="${v}"]')?.click(); })()`;
const openDocs = (page) => `(async () => { document.getElementById("btn-docs").click(); await new Promise((r) => setTimeout(r, 250)); window.attitudeDemo.openDocPage("${page}"); })()`;

/**
 * 被测产物身份（SW-06）：视觉证据必须能回答「拍的是哪份产物」。
 * 开拍前先核对服务端自报的 buildId，拍完再重算源码与产物摘要：
 * 中途有人重建 dist 或改源码，这组截图就不能代表当前产物。
 */
const servedProblems = [];
{
  const served = await fetchServedProvenance(url);
  servedProblems.push(...identityProblems({ localProvenance, served, distDir: join(root, "dist") }));
  if (servedProblems.length) console.warn(`[warn] 被测产物身份核对：${servedProblems.join("；")}`);
}

// ① 四档视口（含最窄 320：iPhone SE 级别）
await capture("desktop-1440x900", { width: 1440, height: 900, note: "桌面主视图（姿态 3D + 曲线 + 评测表）" });
await capture("tablet-768x1024", { width: 768, height: 1024, note: "平板竖屏：面板折行后仍无横向溢出" });
await capture("narrow-390x844", { width: 390, height: 844, note: "手机竖屏（390）：面板与画布等宽" });
await capture("tiny-320x568", { width: 320, height: 568, note: "最窄 320：iPhone SE 级宽度，仍无横向滚动" });
// ② 200% 文字缩放：CSS 视口减半 + DPR=2 —— 与浏览器"文字缩放 200%"等效
await capture("zoom200-1440x900", { width: 720, height: 450, dpr: 2, note: "200% 文字缩放（CSS 视口 720×450 @DPR2 = 1440×900 设备像素）" });
// ③ 三种 3D 视图
await capture("view-attitude", { width: 1440, height: 900, before: viewButton("attitude"), expectView: "attitude", note: "3D 视图：姿态（机体 + 幻影）" });
await capture("view-gimbal", { width: 1440, height: 900, before: viewButton("gimbal"), expectView: "gimbal", note: "3D 视图：万向节（三轴正交与死锁可视化）" });
await capture("view-quat", { width: 1440, height: 900, before: viewButton("quat"), expectView: "quat", note: "3D 视图：四元数（分量弧线 + 单位球）" });
// ④ 文档页（数学排版）与打印
await capture("docs-math", { width: 1440, height: 900, before: openDocs("math"), waitMs: 1800, expectDoc: "math", note: "应用内文档：数学分页（KaTeX 排版）" });
await capture("print-docs-794x1123", { width: 794, height: 1123, print: true, before: openDocs("refs"), waitMs: 1200, expectDoc: "refs", note: "打印媒体 A4（794×1123）：只剩当前文档页" });
await capture("print-desktop-1440x900", { width: 1440, height: 900, print: true, before: openDocs("glossary"), waitMs: 1200, expectDoc: "glossary", note: "打印媒体（桌面尺寸）：外壳隐藏、正文可读" });

await browser.close();
const finishedAt = new Date().toISOString();
const driftProblems = captureDriftProblems(root, identityBefore);
if (driftProblems.length) console.warn(`[warn] 采集期间身份发生变化：${driftProblems.join("；")}`);
const report = {
  schemaVersion: 1,
  captureId,
  localOnly: true,
  generatedAt: finishedAt,
  sourceCommit: sha,
  sourceDigest: source.digest,
  sourceFiles: source.files,
  worktree: worktreeState(root),
  // 与长稳/稳定性共用同一个产物摘要算法（SW-06：同一个字段名必须只有一个含义）
  buildId: localProvenance?.buildId ?? null,
  distHash: identityBefore.distHash,
  url, browserVersion, startedAt, finishedAt,
  consoleErrors,
  servedProblems,
  driftProblems,
  shots,
  pass:
    consoleErrors.length === 0 &&
    servedProblems.length === 0 &&
    driftProblems.length === 0 &&
    shots.length === 11 &&
    shots.every((s) => !(s.metrics.scrollW > s.metrics.innerW)),
  note: "PNG 落在被 gitignore 的 screenshots/ 目录（localOnly），本 JSON 随仓库版本化：视口、字节数、sha256 与源码摘要都可用于复核。",
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`\n[${report.pass ? "PASS" : "FAIL"}] 视觉证据 ${shots.length} 张（控制台错误 ${consoleErrors.length}）`);
console.log(`  源码摘要 ${source.digest}（工作树 ${report.worktree}）、commit ${sha.slice(0, 12)}、浏览器 ${browserVersion}`);
console.log(`  报告（随仓库）：${reportPath.slice(root.length + 1)}；PNG：${outDir.slice(root.length + 1)}/`);
process.exitCode = report.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
