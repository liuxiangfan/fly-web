/**
 * 教学专属持续负载。v2 使用真实 replay.import/stop 和诊断 runId 验证换源，
 * 采样间隔单位是 ms；保留全部换源观察，不按动作名计数、不截掉后半段证据。
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSoakArgs, heapVerdict } from "./soak-contract.mjs";
import { exerciseReplaySwitch, replaySwitchProblems } from "./teaching-load.mjs";
import { testArtifactRoot, cleanupArtifactDir } from "./test-artifacts.mjs";
import { sourceDigest, worktreeState } from "./source-digest.mjs";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { captureIdentity, captureDriftProblems, fetchServedProvenance, identityProblems } from "./served-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseSoakArgs(process.argv.slice(2));
if (!args.teaching) throw new Error("本脚本只接受 --teaching 模式");
const output = resolve(root, args.output);
const url = args.url ?? process.env.SHOT_URL ?? "http://127.0.0.1:4173/";
const candidates = [process.env.CHROME_PATH, process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).filter(existsSync);
if (!candidates.length) throw new Error("找不到 Chrome/Edge");
const tempRoot = resolve(args.profileRoot ?? testArtifactRoot("soak"));
if (process.platform === "win32" && !/^[dD]:[\\/]/.test(tempRoot)) throw new Error("profileRoot 必须在 D 盘");
mkdirSync(tempRoot, { recursive: true });
const profile = mkdtempSync(join(tempRoot, "teaching-"));
const source = sourceDigest(root);
const provenance = readProvenance(join(root, "dist"));
const identityBefore = captureIdentity(root);
const startedAt = new Date().toISOString();
const samples = [], actions = [], sourceTransitions = [], cancellations = [], consoleErrors = [];
let browser = null, failure = null;

async function launchAny() {
  let lastError;
  for (const [index, executablePath] of candidates.entries()) {
    try {
      return await puppeteer.launch({ executablePath, userDataDir: join(profile, `browser-${index}`),
        headless: "new", protocolTimeout: 120000,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
          "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding", "--disable-gpu-watchdog"] });
    } catch (error) { lastError = error; console.warn(`[warn] 浏览器候选启动失败：${executablePath}`); }
  }
  throw lastError;
}

try {
  browser = await launchAny();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.attitudeDemo?.build?.().buildId, { timeout: 30000 });
  const servedProblems = identityProblems({ localProvenance: provenance, served: await fetchServedProvenance(url),
    distDir: join(root, "dist"), pageBuild: await page.evaluate(() => window.attitudeDemo.build()) });
  if (provenance?.sourceDigest !== source.digest) servedProblems.push("dist 与当前源码不一致");
  if (servedProblems.length) throw new Error(servedProblems.join("；"));
  await page.evaluate(async () => {
    const set = (id, value) => {
      const control = document.getElementById(id);
      control.value = String(value);
      control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    };
    set("scenario-select", "violent"); set("imu-lin-accel", 4); set("imu-vibration", 0.4);
    set("source-select", "mahony");
    const gate = document.getElementById("gate-toggle"); if (!gate.checked) gate.click();
    const pause = document.getElementById("btn-pause"); if (pause.textContent === "继续") pause.click();
    await window.attitudeDemo.diagnostics.open(); await window.attitudeDemo.task.open();
    window.attitudeDemo.diagnostics.setReviewCapture(true);
    window.attitudeDemo.diagnostics.setEskfEnabled(true);
  });
  const sample = () => page.evaluate(() => {
    const api = window.attitudeDemo, sizes = api.sizes(), diagnostics = api.diagnostics.state();
    const heap = performance.memory?.usedJSHeapSize;
    return { at: Date.now(), t: sizes.simTime, runId: diagnostics.runId,
      sourceKind: api.plumbing().sourceKind, replayActive: api.replay.info.active,
      heapMb: typeof heap === "number" ? heap / 1024 / 1024 : null,
      ...diagnostics, learningStatus: api.learning.state()?.status ?? null,
      comparison: api.comparison.state(), batchRunning: api.experiment.batchState().running };
  });
  const act = (phase) => page.evaluate(async (phase) => {
    const api = window.attitudeDemo, d = api.diagnostics;
    const button = (action) => document.querySelector(`.review-panel button[data-review-action="${action}"]`);
    const result = { phase, ok: true, kind: "review" };
    try {
      if (d.state().reviewActive) button(phase % 5 === 0 ? "exit" : phase % 2 === 0 ? "prev" : "next")?.click();
      else button("toggle")?.click();
      // 退出回看会停录制；测试显式恢复录制，保持持续缓冲负载而不是只循环空面板。
      d.setReviewCapture(true);
      if (phase % 12 === 0) d.setEskfEnabled(!d.state().eskfEnabled);
      if (phase % 20 === 0) {
        result.kind = "learning";
        await api.learning.open(); await api.learning.setActivity("drift-linear-10s");
        await api.learning.reset();
        const submitted = await api.learning.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
        if (!submitted.ok) throw new Error(submitted.error);
        const run = await api.learning.run();
        if (!run.ok || api.learning.state().verdict !== "consistent") throw new Error(run.error ?? "学习证据不一致");
      }
    } catch (error) { result.ok = false; result.error = String(error); }
    return result;
  }, phase);
  const t0 = Date.now();
  samples.push(await sample());
  let phase = 0;
  while (Date.now() - t0 < args.seconds * 1000) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(args.interval, Math.max(1, args.seconds * 1000 - (Date.now() - t0)))));
    const action = { ...(await act(++phase)), at: Date.now() };
    actions.push(action);
    if (phase % 12 === 0) {
      // 先给缓冲足够时间达到容量，再验证真实换源清空旧轮数据。
      // 3 s 的明确秒表头，观察到帧实际消费后主动 stop，避免短日志自然结束掩盖退出动作。
      const csv = ["t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2",
        ...Array.from({ length: 151 }, (_, i) => `${(i * 0.02).toFixed(3)},0,0,0,0,0,9.80665`)].join("\n");
      const transition = await page.evaluate(exerciseReplaySwitch, csv);
      const problems = replaySwitchProblems(transition);
      sourceTransitions.push({ ...transition, problems });
      if (problems.length) { action.ok = false; action.error = problems.join("；"); }
    }
    if (phase % 10 === 0) {
      const cancelled = await page.evaluate(async () => {
        const api = window.attitudeDemo;
        await api.comparison.open(); await api.comparison.freeze(); await api.comparison.selectVariable("solve-rate");
        const pending = api.comparison.run();
        const deadline = Date.now() + 5000;
        while (!["running-a", "running-b", "done", "error"].includes(api.comparison.state().state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const before = api.comparison.state();
        const requestedAt = performance.now();
        await api.comparison.cancel(); await pending;
        const after = api.comparison.state(), settledMs = performance.now() - requestedAt;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { before, after, settledMs, later: api.comparison.state() };
      });
      cancellations.push(cancelled);
      if (!["running-a", "running-b"].includes(cancelled.before.state) || cancelled.after.state !== "cancelled" ||
        cancelled.later.state !== "cancelled" || cancelled.later.jobId !== cancelled.after.jobId) {
        action.ok = false; action.error = "对照取消未落定或旧任务回写";
      }
    }
    const value = await sample(); samples.push(value);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] t=${value.t.toFixed(1)} run=${value.runId} source=${value.sourceKind} review=${value.reviewFrames} events=${value.eventCount}`);
  }
  const clockGrowth = samples.slice(1).reduce((sum, value, i) => sum + (value.runId === samples[i].runId ? Math.max(0, value.t - samples[i].t) : 0), 0);
  await page.evaluate(async () => {
    const api = window.attitudeDemo;
    if (api.diagnostics.state().reviewActive) document.querySelector('.review-panel button[data-review-action="exit"]')?.click();
    api.diagnostics.setReviewCapture(false); api.diagnostics.setEskfEnabled(false);
    await api.comparison.cancel(); await api.task.clear();
    // 事件记录没有停载开关：暂停生产解算后观察静默，报告明确保留该边界。
    const pause = document.getElementById("btn-pause"); if (pause.textContent === "暂停") pause.click();
  });
  const stoppedBefore = await sample();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const stoppedAfter = await sample();
  const stopQuiesced = stoppedBefore.reviewFrames === stoppedAfter.reviewFrames && stoppedBefore.eventCount === stoppedAfter.eventCount &&
    stoppedAfter.reviewCapture === false && stoppedAfter.eskfEnabled === false && stoppedAfter.reviewActive === false;
  const driftProblems = captureDriftProblems(root, identityBefore);
  const heap = heapVerdict(samples.map((value) => value.heapMb), args.heapLimitMb, args.allowNoHeap);
  const sourceProblems = sourceTransitions.flatMap(replaySwitchProblems);
  const sourceSwitches = sourceTransitions.filter((value) => !replaySwitchProblems(value).length).length;
  const elapsedMs = samples.at(-1).at - samples[0].at;
  const maxGapMs = Math.max(0, ...samples.slice(1).map((value, i) => value.at - samples[i].at));
  const coverageOk = elapsedMs >= args.seconds * 1000 * 0.95 && maxGapMs <= Math.max(args.interval * 4, 5000) &&
    samples.length >= Math.floor(args.seconds * 1000 / args.interval * 0.8);
  const actionErrors = actions.filter((action) => !action.ok);
  const teachingOk = coverageOk && clockGrowth > 0 && stopQuiesced && !sourceProblems.length && sourceSwitches > 0 &&
    !consoleErrors.length && !driftProblems.length && !actionErrors.length && samples.every((value) => value.reviewFrames <= 750 && value.eventCount <= 512);
  const verdict = { ...heap, teachingOk, coverageOk, elapsedMs, maxGapMs, clockAdvanced: clockGrowth > 0,
    clockGrowthSec: clockGrowth, stopQuiesced, sourceSwitches, sourceProblems,
    errorsOk: !consoleErrors.length, identityOk: !driftProblems.length,
    actionCount: actions.length, actionErrors: actionErrors.length,
    reviewMax: Math.max(...samples.map((value) => value.reviewFrames)), eventMax: Math.max(...samples.map((value) => value.eventCount)),
    problems: [...sourceProblems, ...actionErrors.map((action) => action.error)], pass: teachingOk && heap.heapGateOk === true };
  const report = { loadSchema: "teaching-load/v2", generatedAt: new Date().toISOString(),
    commit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
    sourceDigest: source.digest, sourceFiles: source.files, worktree: worktreeState(root),
    buildId: provenance.buildId, distHash: distHashOf(join(root, "dist")),
    browserVersion: await browser.version(), startedAt, finishedAt: new Date().toISOString(),
    url, seconds: args.seconds, intervalMs: args.interval, withTeaching: true,
    heapLimitMb: args.heapLimitMb, allowNoHeap: args.allowNoHeap, servedProblems, driftProblems, consoleErrors,
    profile, samples, actions, sourceTransitions, cancellations, stoppedBefore, stoppedAfter,
    stopBoundary: "停止回看/ESKF采集并暂停生产解算；事件记录器没有独立停止开关",
    resourcesNotMeasured: ["浏览器内部 Worker/timer/listener 数量"], verdict };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[${verdict.pass ? "PASS" : "FAIL"}] 教学负载：${actions.length} 动作、${sourceSwitches} 次真实换源、停载静默=${stopQuiesced}`);
  if (!verdict.pass) process.exitCode = 1;
} catch (error) {
  failure = String(error);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ loadSchema: "teaching-load/v2", generatedAt: new Date().toISOString(),
    sourceDigest: source.digest, sourceFiles: source.files, buildId: provenance?.buildId ?? null,
    distHash: provenance?.distHash ?? null, seconds: args.seconds, intervalMs: args.interval,
    withTeaching: true, startedAt, finishedAt: new Date().toISOString(),
    samples, actions, sourceTransitions, cancellations, consoleErrors, failure,
    verdict: { pass: false, teachingOk: false, problems: [failure] } }, null, 2)}\n`);
  console.error(`[FAIL] ${failure}`); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  cleanupArtifactDir(profile);
}
