/**
 * 页面性能实测：墙钟 rAF、真实输入、事件循环基线/批量诊断、runner 停止与 post-await 分开。
 * 200 ms 是固定绝对目标，不根据基线/种子耗时放大。原始采样保留在 diagnostics。
 * 用法：node scripts/perf-report.mjs [--url=...] [--out=...]（需先 build + preview）。
 */
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as nodePerformance } from "node:perf_hooks";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { sourceDigest, worktreeState } from "./source-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const url = String(arg.url ?? process.env.SMOKE_URL ?? "http://127.0.0.1:4173/");
const outPath = resolve(root, String(arg.out ?? "docs/generated/perf-report.json"));
const executablePath = [process.env.CHROME_PATH, process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!executablePath) { console.error("[FAIL] 找不到 Chrome/Edge"); process.exit(2); }
const epochNow = () => nodePerformance.timeOrigin + nodePerformance.now();
const summary = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q) => sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
  return { samples, count: samples.length, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) ?? null, percentileMethod: "nearest rank" };
};
const withinTarget = (n) => Number.isFinite(n) && n >= 0 && n <= 200;
const diagnostics = { targetMs: 200, minimumSamples: 40, waitFailures: [], checks: [] };
const startedAt = new Date().toISOString();
const browser = await puppeteer.launch({ executablePath, headless: "new", protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const browserVersion = await browser.version();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
await page.evaluateOnNewDocument(() => {
  window.__perf = { longTasks: [], longTaskSupported: false, frames: [], marks: {}, input: null };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ entryTypes: ["longtask"] });
    window.__perf.longTaskSupported = true;
  } catch (e) { window.__perf.longTaskReason = String(e); }
  let last = null;
  const tick = (t) => { if (last !== null) window.__perf.frames.push({ at: t, ms: t - last }); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.addEventListener("DOMContentLoaded", () => { window.__perf.marks.domContentLoaded = performance.now(); });
});
const waitState = async (phase, predicate, timeout = 5000) => {
  try { await page.waitForFunction(predicate, { timeout, polling: 25 }); return true; }
  catch (e) { diagnostics.waitFailures.push({ phase, reason: String(e) }); return false; }
};
const snapshot = () => page.evaluate(() => ({
  at: performance.now(), timeOrigin: performance.timeOrigin,
  state: window.attitudeDemo.experiment.batchState(), status: document.getElementById("batch-status")?.textContent ?? "",
  frameTiming: window.attitudeDemo.performance?.() ?? null,
  visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
  activeElement: { id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName ?? "" },
  longTaskSupported: window.__perf.longTaskSupported, longTaskReason: window.__perf.longTaskReason ?? null,
  longTasks: window.__perf.longTasks.slice(),
}));
const timerSamples = (requireRunning) => page.evaluate(async (required) => {
  const samples = [], observations = [];
  const start = performance.now();
  for (let i = 0; i < 40; i++) {
    const before = window.attitudeDemo.experiment.batchState();
    if (required && !before.running) break;
    const requestedAt = performance.now();
    await new Promise((r) => setTimeout(r, 0));
    const observedAt = performance.now();
    const after = window.attitudeDemo.experiment.batchState();
    samples.push(observedAt - requestedAt);
    observations.push({ requestedAt, observedAt, runningBefore: before.running, runningAfter: after.running,
      generation: after.generation, slices: after.slices ?? null,
      status: document.getElementById("batch-status")?.textContent ?? "" });
    if (observedAt - start > 15000) break;
  }
  return { samples, observations, kind: "setTimeout(0) event-loop latency, not input",
    allDuringBatch: observations.length >= 40 && observations.every((s) => s.runningBefore && s.runningAfter) };
}, requireRunning);
const armInput = (selector) => page.evaluate((sel) => {
  const button = document.querySelector(sel);
  window.__perf.input = null;
  button.addEventListener("click", (event) => {
    const input = window.__perf.input = { handlerAt: performance.now(), eventTimeStamp: event.timeStamp,
      timeOrigin: performance.timeOrigin, trusted: event.isTrusted, hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState, activeElementId: document.activeElement?.id ?? "",
      stateBeforeHandler: window.attitudeDemo.experiment.batchState(), postHandlerAt: null };
    setTimeout(() => { input.postHandlerAt = performance.now(); }, 0);
  }, { capture: true, once: true });
}, selector);
const realClick = async (selector) => {
  const button = await page.$(selector);
  const box = await button?.boundingBox();
  if (!box) throw new Error(`真实输入目标不可见：${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const sentEpochMs = epochNow();
  await page.mouse.up(); // click 由真实 mouseup 触发，移动/按下的控制往返在计时区段外。
  return { kind: "click-producing mouseup dispatch", sentEpochMs, returnedEpochMs: epochNow(), x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 60000 });
const interactiveMs = Date.now() - t0;
await page.waitForFunction(() => {
  const canvas = document.querySelector("#viewport canvas");
  const gl = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
  return Boolean(gl) && parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) > 1;
}, { timeout: 60000 });
await page.evaluate(() => window.attitudeDemo.performance?.(true));
const frameStats = await page.evaluate(async () => {
  const start = performance.now(), before = window.__perf.frames.length;
  await new Promise((r) => setTimeout(r, 5000));
  const raw = window.__perf.frames.slice(before), sorted = raw.map((f) => f.ms).sort((a, b) => a - b);
  const p = (q) => sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
  const wallSeconds = (performance.now() - start) / 1000;
  return { wallSeconds, frames: raw.length, fpsWall: raw.length / wallSeconds,
    frameMsP50: p(0.5), frameMsP95: p(0.95), frameMsMax: sorted.at(-1) ?? null, raw,
    longTasks: window.__perf.longTasks.length,
    longTaskMaxMs: window.__perf.longTasks.reduce((a, t) => Math.max(a, t.duration), 0), marks: window.__perf.marks };
});
diagnostics.frameWindow = { ...await snapshot(), frames: frameStats.raw };

// 真鼠标 40 次：Node 发出输入→页面捕获 handler；postHandler timer 单独记录，绝不 dispatchEvent 冒充。
const rawInputs = diagnostics.realInputs = [];
const inputSelector = '#view-seg .seg-btn[data-view="attitude"]';
for (let i = 0; i < 40; i++) {
  await armInput(inputSelector);
  const node = await realClick(inputSelector);
  const handled = await waitState(`input ${i + 1} handler`, () => window.__perf.input?.trusted === true);
  if (!handled) { rawInputs.push({ node, input: null }); break; }
  const input = await page.evaluate(() => window.__perf.input);
  rawInputs.push({ node, input, nodeInputToHandlerMs: input.timeOrigin + input.handlerAt - node.sentEpochMs,
    eventToHandlerMs: input.handlerAt - input.eventTimeStamp,
    handlerToPostHandlerMs: input.postHandlerAt == null ? null : input.postHandlerAt - input.handlerAt });
}
const inputLatency = { ...summary(rawInputs.filter((r) => r.input).map((r) => r.nodeInputToHandlerMs)),
  kind: "real mouse: Node input dispatch to page capture handler", allTrusted: rawInputs.length >= 40 && rawInputs.every((r) => r.input?.trusted),
  postHandlerNote: "postHandlerAt is a timer observation, not runner stop or event arrival" };

// Worker 完整运行必须落定；超时/取消写入失败原因，不能把半张表当完成后继续。
await page.evaluate(() => {
  document.getElementById("sec-experiments").classList.remove("collapsed");
  const sel = document.getElementById("batch-runs"); sel.value = "10"; sel.dispatchEvent(new Event("change"));
  window.__perf.peakHeapMb = performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null;
  window.__perf.heapWatch = setInterval(() => {
    const h = performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null;
    if (h !== null) window.__perf.peakHeapMb = Math.max(window.__perf.peakHeapMb ?? h, h);
  }, 200);
});
const workerStartedAt = epochNow();
await page.click("#btn-batch");
const workerSettled = await waitState("worker batch completed", () => {
  const state = window.attitudeDemo.experiment.batchState();
  return !state.running && (document.getElementById("batch-status")?.textContent ?? "").startsWith("完成");
}, 90000);
const worker = diagnostics.worker = await page.evaluate(() => ({
  rows: document.querySelectorAll("#batch-body tr").length, mode: window.attitudeDemo.experiment.batchMode(),
  state: window.attitudeDemo.experiment.batchState(), result: window.attitudeDemo.experiment.batchResult(),
  status: document.getElementById("batch-status")?.textContent ?? "" }));
worker.elapsedMs = epochNow() - workerStartedAt;
worker.settled = workerSettled;
let mainCancelLatencyMs = null, partialSeeds = 0;
if (workerSettled) {
  await page.evaluate(() => {
    window.attitudeDemo.experiment.disableWorker();
    const sel = document.getElementById("batch-runs"); sel.value = "30x30"; sel.dispatchEvent(new Event("change"));
    window.attitudeDemo.performance?.(true);
  });
  const idle = await timerSamples(false);
  diagnostics.timerBaseline = { ...idle, ...summary(idle.samples), frame: await snapshot() };
  await page.evaluate(() => window.attitudeDemo.performance?.(true));
  await page.click("#btn-batch");
  const running = await timerSamples(true);
  diagnostics.timerDuringBatch = { ...running, ...summary(running.samples) };
  diagnostics.beforeCancellation = await snapshot();
  await armInput("#btn-batch");
  const node = diagnostics.cancelInput = await realClick("#btn-batch");
  const cancelledSeen = await waitState("main cancelled status", () => (document.getElementById("batch-status")?.textContent ?? "").startsWith("已取消"));
  const runnerSettled = await waitState("main runner/post-await settlement", () => {
    const s = window.attitudeDemo.experiment.batchState();
    return !s.running && s.partialSeeds >= 1 && s.cancelTiming?.postAwaitAt != null;
  });
  const after = diagnostics.afterCancellation = { ...await snapshot(), ...await page.evaluate(() => ({
    input: window.__perf.input, observedAt: performance.now(),
    result: window.attitudeDemo.experiment.batchResult(), body: document.getElementById("batch-body")?.innerHTML ?? "" })) };
  const timing = after.state.cancelTiming, input = after.input;
  mainCancelLatencyMs = timing?.requestedAt != null && timing?.runnerStoppedAt != null ? timing.runnerStoppedAt - timing.requestedAt : null;
  partialSeeds = after.state.partialSeeds;
  diagnostics.cancellation = {
    rawTiming: timing ?? null, cancelledSeen, runnerSettled,
    nodeInputToHandlerMs: input ? input.timeOrigin + input.handlerAt - node.sentEpochMs : null,
    eventToHandlerMs: input ? input.handlerAt - input.eventTimeStamp : null,
    handlerToRunnerStopMs: input && timing?.runnerStoppedAt != null ? timing.runnerStoppedAt - input.handlerAt : null,
    requestToRunnerStopMs: mainCancelLatencyMs,
    runnerStopToPostAwaitMs: timing?.runnerStoppedAt != null && timing?.postAwaitAt != null ? timing.postAwaitAt - timing.runnerStoppedAt : null,
    requestToPostAwaitMs: after.state.cancelLatencyMs,
    eventToRunnerStopMs: input && timing?.runnerStoppedAt != null ? timing.runnerStoppedAt - input.eventTimeStamp : null,
    nodeInputToRunnerStopMs: input && timing?.runnerStoppedAt != null ? input.timeOrigin + timing.runnerStoppedAt - node.sentEpochMs : null,
    observedAfterStopMs: timing?.runnerStoppedAt != null ? after.observedAt - timing.runnerStoppedAt : null,
    clockNote: "Node/browser epoch uses timeOrigin+performance.now; event/runner/await use page monotonic time",
  };
} else diagnostics.waitFailures.push({ phase: "main cancellation measurement", reason: "Worker 批量未完成，未假装启动新批量或吞掉挂起任务" });
const heap = await page.evaluate(() => {
  clearInterval(window.__perf.heapWatch);
  return { peakHeapMb: window.__perf.peakHeapMb,
    heapFinalMb: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null };
});
diagnostics.final = await snapshot();
await browser.close();

const batch = { workerMs: worker.elapsedMs, rows: worker.rows, workerMode: worker.mode,
  workerCompleted: workerSettled, mainCancelLatencyMs, mainCancelDefinition: "request to runner stop, not post-await",
  partialSeeds, ...heap };
const record = (name, pass, reason) => diagnostics.checks.push({ name, pass: Boolean(pass), reason });
record("console", consoleErrors.length === 0, `${consoleErrors.length} 个控制台错误`);
record("wall frames", frameStats.fpsWall > 1, `墙钟 ${frameStats.fpsWall.toFixed(1)} fps`);
record("real input", inputLatency.count >= 40 && inputLatency.allTrusted && withinTarget(inputLatency.p95), `真实输入 ${inputLatency.count} 样本，p95=${inputLatency.p95} ms，固定目标200`);
record("batch timer", diagnostics.timerBaseline?.count >= 40 && diagnostics.timerDuringBatch?.allDuringBatch && withinTarget(diagnostics.timerDuringBatch?.p95),
  `基线仅诊断，运行 ${diagnostics.timerDuringBatch?.count ?? 0} 样本，p95=${diagnostics.timerDuringBatch?.p95 ?? "缺失"} ms，固定目标200`);
record("main cancellation", diagnostics.beforeCancellation?.state.running && diagnostics.afterCancellation?.input?.trusted &&
  diagnostics.afterCancellation?.input?.stateBeforeHandler.running && diagnostics.cancellation?.runnerSettled &&
  diagnostics.cancellation?.cancelledSeen && withinTarget(mainCancelLatencyMs) && withinTarget(diagnostics.cancellation?.eventToRunnerStopMs) &&
  partialSeeds >= 1 && diagnostics.afterCancellation?.state.running === false && diagnostics.afterCancellation?.state.activeJob === 0 &&
  JSON.stringify(diagnostics.afterCancellation?.result) === JSON.stringify(worker.result) && diagnostics.afterCancellation?.body.trim() === "",
  `request→runner ${mainCancelLatencyMs ?? "缺失"} ms，input→runner ${diagnostics.cancellation?.eventToRunnerStopMs ?? "缺失"} ms，post-await单记；取消前「${diagnostics.beforeCancellation?.status ?? "未启动"}」`);
record("telemetry", diagnostics.beforeCancellation?.state.slices?.count > 0 && diagnostics.beforeCancellation?.frameTiming?.count > 0,
  "必须保留主线程 slice 与 api.performance 分项测量，不把缺失当0");
record("worker complete", workerSettled && worker.mode === "worker" && worker.rows === 5 && worker.result?.generation === worker.state.generation,
  `${worker.status}；模式 ${worker.mode}、表格 ${worker.rows} 行`);
record("bounded waits", diagnostics.waitFailures.length === 0, JSON.stringify(diagnostics.waitFailures));
const source = sourceDigest(root), provenance = readProvenance(join(root, "dist"));
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), startedAt, finishedAt: new Date().toISOString(), url,
  commit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
  sourceDigest: source.digest, worktree: worktreeState(root), buildId: provenance?.buildId ?? null,
  distHash: distHashOf(join(root, "dist")), browserVersion, viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, headless: true,
  note: "headless + swiftshader 软件渲染；200 ms为固定绝对目标，timer基线仅诊断。timer不是输入，runner停止不是await返回，不从观测推断根因。",
  timings: { interactiveMs, domContentLoadedMs: frameStats.marks.domContentLoaded ?? null, wallFrameWindowSec: frameStats.wallSeconds },
  frames: { fpsWall: frameStats.fpsWall, count: frameStats.frames, frameMsP50: frameStats.frameMsP50, frameMsP95: frameStats.frameMsP95, frameMsMax: frameStats.frameMsMax },
  longTasks: { supported: diagnostics.final.longTaskSupported, count: diagnostics.final.longTasks.length,
    maxMs: diagnostics.final.longTasks.reduce((a, t) => Math.max(a, t.duration), 0) },
  inputLatency, batch, consoleErrors, diagnostics, pass: diagnostics.checks.every((c) => c.pass),
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n[${report.pass ? "PASS" : "FAIL"}] 页面性能（${browserVersion}，headless + swiftshader）`);
for (const c of diagnostics.checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name} — ${c.reason}`);
console.log(`  可交互 ${interactiveMs} ms；runner→post-await ${diagnostics.cancellation?.runnerStopToPostAwaitMs ?? "缺失"} ms；堆峰值 ${batch.peakHeapMb?.toFixed(1)} MB`);
console.log(`  报告：${outPath}`);
process.exit(report.pass ? 0 : 1);
