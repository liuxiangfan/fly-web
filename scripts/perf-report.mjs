/**
 * 页面性能实测（SW-09 第 5 条）：**不能用"被 50 ms 夹过的仿真 dt"算出来的 fps 当性能指标**。
 * 这里测的是真实墙钟：
 *   · 首次可交互（DOMContentLoaded / 首帧 canvas 出图 / FCP）；
 *   · 真实 rAF 帧间隔（墙钟帧率）与最长帧；
 *   · 长任务（PerformanceObserver `longtask`）与输入延迟（点击 → 主线程处理完的往返）；
 *   · 批量评测取消延迟（SW-10 的协作取消）；
 *   · 堆峰值。
 *
 * 输出 `docs/generated/perf-report.json`（随仓库版本化；含源码/产物摘要，便于与证据对齐）。
 * 用法：`node scripts/perf-report.mjs [--url=...] [--out=...]`（需先 build + preview）。
 */
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { sourceDigest, worktreeState } from "./source-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const url = String(arg.url ?? process.env.SMOKE_URL ?? "http://127.0.0.1:4173/");
const outPath = resolve(root, String(arg.out ?? "docs/generated/perf-report.json"));
const CANDIDATES = [
  process.env.CHROME_PATH, process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) { console.error("[FAIL] 找不到 Chrome/Edge"); process.exit(2); }

const startedAt = new Date().toISOString();
const browser = await puppeteer.launch({
  executablePath, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const browserVersion = await browser.version();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));

// 长任务观察器必须在页面脚本之前装好，否则首屏那一段量不到
await page.evaluateOnNewDocument(() => {
  window.__perf = { longTasks: [], frames: [], marks: {} };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* 浏览器不支持 longtask：报告里标 null */ }
  const raf = window.requestAnimationFrame.bind(window);
  let last = null;
  const tick = (t) => { if (last !== null) window.__perf.frames.push(t - last); last = t; raf(tick); };
  raf(tick);
  document.addEventListener("DOMContentLoaded", () => { window.__perf.marks.domContentLoaded = performance.now(); });
});

const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 60000 });
const interactiveMs = Date.now() - t0;
// 等首帧真的画出来（canvas 有 WebGL 上下文 + 时钟推进）
await page.waitForFunction(() => {
  const canvas = document.querySelector("#viewport canvas");
  const gl = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
  return Boolean(gl) && parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) > 1;
}, { timeout: 60000 });

/** 真实墙钟帧率：采 5 s 的 rAF 间隔（不是界面读数里被夹过的 dt）。 */
const frameStats = await page.evaluate(async () => {
  const start = performance.now();
  const before = window.__perf.frames.length;
  await new Promise((r) => setTimeout(r, 5000));
  const frames = window.__perf.frames.slice(before);
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : null);
  return {
    wallSeconds: (performance.now() - start) / 1000,
    frames: frames.length,
    fpsWall: frames.length / ((performance.now() - start) / 1000),
    frameMsP50: p(0.5), frameMsP95: p(0.95), frameMsMax: sorted.at(-1) ?? null,
    longTasks: window.__perf.longTasks.length,
    longTaskMaxMs: window.__perf.longTasks.reduce((a, t) => Math.max(a, t.duration), 0),
    marks: window.__perf.marks,
  };
});

/** 输入延迟：真实点击 → 主线程处理完（事件循环排队 + 处理）的往返。 */
const inputLatency = await page.evaluate(async () => {
  const btn = document.getElementById("view-seg");
  const target = btn?.querySelector(".seg-btn") ?? document.getElementById("btn-docs");
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    samples.push(performance.now() - t);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] };
});

/** 批量评测（Worker 路径）端到端耗时 + 堆峰值；再测一次**主线程降级**的取消延迟。 */
const batch = await page.evaluate(async () => {
  const peakHeap = () => (performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null);
  let peak = peakHeap();
  const watch = setInterval(() => { const h = peakHeap(); if (h !== null && (peak === null || h > peak)) peak = h; }, 200);
  const sel = document.getElementById("batch-runs");
  sel.value = "10";
  sel.dispatchEvent(new Event("change"));
  const started = performance.now();
  document.getElementById("btn-batch").click();
  const deadline = Date.now() + 60000;
  for (;;) {
    const text = document.getElementById("batch-status")?.textContent ?? "";
    if (text.startsWith("完成") || text.startsWith("已取消")) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const workerMs = performance.now() - started;
  const rows = document.querySelectorAll("#batch-body tr").length;
  const workerMode = window.attitudeDemo.experiment.batchMode();

  // 主线程降级：取消延迟（SW-10 的验收目标：下一计算片即停）
  window.attitudeDemo.experiment.disableWorker();
  sel.value = "30x30";
  sel.dispatchEvent(new Event("change"));
  document.getElementById("btn-batch").click();
  await new Promise((r) => setTimeout(r, 250));
  document.getElementById("btn-batch").click();
  const cancelDeadline = Date.now() + 3000;
  while (Date.now() < cancelDeadline && window.attitudeDemo.experiment.batchState().partialSeeds < 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const state = window.attitudeDemo.experiment.batchState();
  clearInterval(watch);
  return { workerMs, rows, workerMode, mainCancelLatencyMs: state.cancelLatencyMs, partialSeeds: state.partialSeeds, peakHeapMb: peak };
});

const heapFinalMb = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null));
await browser.close();

const source = sourceDigest(root);
const provenance = readProvenance(join(root, "dist"));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  startedAt,
  finishedAt: new Date().toISOString(),
  url,
  commit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
  sourceDigest: source.digest,
  worktree: worktreeState(root),
  buildId: provenance?.buildId ?? null,
  distHash: distHashOf(join(root, "dist")),
  browserVersion,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  headless: true,
  /**
   * 口径声明（复核 SW-09 第 5 条）：这里的 fps 来自真实 rAF 墙钟间隔；
   * 界面读数里的 fps 用的是被夹到 50 ms 的仿真 dt，**不能**当性能指标。
   */
  note: "headless + swiftshader 软件渲染：数值是下限参照，不代表真实 GPU 环境；同一环境前后对比才有意义。",
  timings: { interactiveMs, domContentLoadedMs: frameStats.marks.domContentLoaded ?? null, wallFrameWindowSec: frameStats.wallSeconds },
  frames: { fpsWall: frameStats.fpsWall, count: frameStats.frames, frameMsP50: frameStats.frameMsP50, frameMsP95: frameStats.frameMsP95, frameMsMax: frameStats.frameMsMax },
  longTasks: { count: frameStats.longTasks, maxMs: frameStats.longTaskMaxMs },
  inputLatency,
  batch: { ...batch, heapFinalMb },
  consoleErrors,
  pass:
    consoleErrors.length === 0 &&
    frameStats.fpsWall > 1 &&
    (inputLatency.p95 ?? 0) <= 200 &&
    (batch.mainCancelLatencyMs ?? 0) > 0 && batch.mainCancelLatencyMs <= 200 &&
    batch.workerMode === "worker" && batch.rows === 5,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n[${report.pass ? "PASS" : "FAIL"}] 页面性能（${browserVersion}，headless + swiftshader）`);
console.log(`  可交互 ${interactiveMs} ms（DOMContentLoaded ${Math.round(frameStats.marks.domContentLoaded ?? 0)} ms）`);
console.log(`  墙钟帧率 ${frameStats.fpsWall.toFixed(1)} fps（帧间隔 p50 ${frameStats.frameMsP50?.toFixed(1)} / p95 ${frameStats.frameMsP95?.toFixed(1)} / 最长 ${frameStats.frameMsMax?.toFixed(1)} ms）`);
console.log(`  长任务 ${frameStats.longTasks} 个（最长 ${frameStats.longTaskMaxMs.toFixed(0)} ms）；输入延迟 p50 ${inputLatency.p50.toFixed(1)} / p95 ${inputLatency.p95.toFixed(1)} ms`);
console.log(`  批量（Worker）${batch.workerMs.toFixed(0)} ms、表格 ${batch.rows} 行；主线程降级取消 ${batch.mainCancelLatencyMs?.toFixed(0)} ms（半成品 ${batch.partialSeeds} 个）；堆峰值 ${batch.peakHeapMb?.toFixed(1)} MB`);
console.log(`  报告：${outPath.slice(root.length + 1)}`);
process.exit(report.pass ? 0 : 1);
