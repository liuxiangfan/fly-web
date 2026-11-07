/**
 * 帧成本与主线程阻塞探针（WP-01/WP-03 诊断工具，**不是验收门禁**）。
 *
 * 为什么需要它：CI 上「浏览器事件→handler」302 ms、运行期 timer p95 326 ms、
 * 单帧最长 172.7 ms 同时出现，说明点击还没进 handler 时主线程已被整段占住；
 * 而本机同配置（SwiftShader、800×600）帧只有 50–80 ms。要判断这 300 ms 里
 * 多少来自软件光栅化（阴影/IBL/抗锯齿/像素数）、多少来自 JS 计算，必须在同一
 * 页面上做单变量对照，而不是看到 CI 红就加阈值或猜「2 vCPU 不够」。
 *
 * 做法：同一页面、同一批量负载（主线程降级 30×30），依次切换一个渲染变量，
 * 每个变体都采集同一组四个指标：帧间隔、运行期 setTimeout 延迟、真实鼠标
 * event→handler、event→runner 停止。变体只在**诊断**里存在，产品默认配置
 * 仍是基线；任何「关掉渲染才变绿」的结论都不能当验收。
 *
 * 用法（先 build + 启动 preview）：
 *   node scripts/perf-probe.mjs --url=http://127.0.0.1:4173/ --viewport=800x600 --out=.audit-current/perf-probe.json
 * 可选：--variants=baseline,noShadow,noEnv,halfRes,noRender,halfRes+noShadow+noEnv
 */
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { sourceDigest, worktreeState } from "./source-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const url = String(arg.url ?? "http://127.0.0.1:4173/");
const outPath = resolve(root, String(arg.out ?? ".audit-current/perf-probe.json"));
const [vw, vh] = String(arg.viewport ?? "800x600").split("x").map((n) => Math.max(320, Number(n) || 0));
const sampleMs = Math.max(800, Number(arg.sampleMs ?? 2500));
const variants = String(arg.variants ?? "baseline,noShadow,noEnv,halfRes,noRender").split(",").filter(Boolean);
const profileTop = Math.max(0, Number(arg.profile ?? 0));
const cpuThrottle = Math.max(1, Number(arg.cpu ?? 1));

const executablePath = [process.env.CHROME_PATH, process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!executablePath) { console.error("[FAIL] 找不到 Chrome/Edge"); process.exit(2); }

const summary = (samples) => {
  const sorted = [...samples].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : null);
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) ?? null, percentileMethod: "nearest rank" };
};
const check = (name, pass, reason) => ({ name, pass, reason });
const checks = [];
const record = (name, pass, reason) => { checks.push(check(name, pass, reason)); console.log(`  [${pass ? "PASS" : "FAIL"}] ${name} — ${reason}`); };

const browser = await puppeteer.launch({
  executablePath, headless: "new", protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const browserVersion = await browser.version();
const page = await browser.newPage();
await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
if (cpuThrottle > 1) await page.emulateCPUThrottling(cpuThrottle);
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
await page.evaluateOnNewDocument(() => {
  window.__probe = { frames: [], renderMs: [] };
  let last = null;
  const tick = (t) => { if (last !== null) window.__probe.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
await page.waitForFunction(() => {
  const canvas = document.querySelector("#viewport canvas");
  const gl = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
  return Boolean(gl) && parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) > 1;
}, { timeout: 60000 });
const rendererInfo = await page.evaluate(() => {
  const gl = document.querySelector("#viewport canvas")?.getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  const dbg = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  const r = window.attitudeDemo.renderer;
  return {
    unmaskedRenderer: dbg, vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
    pixelRatio: r?.getPixelRatio?.() ?? null,
    canvasCss: (() => { const c = document.querySelector("#viewport canvas"); return c ? { w: c.clientWidth, h: c.clientHeight, bw: c.width, bh: c.height } : null; })(),
  };
});

/** 变体 → 在页面里单变量切换渲染配置；每次先回到基线，只动一个变量。 */
const applyVariant = (name) => page.evaluate((variantName) => {
  const r = window.attitudeDemo.renderer;
  const scene = window.attitudeDemo.scene;
  if (!r || !scene) return { applied: false };
  const P = window.__probe;
  P.base ??= { shadow: r.shadowMap.enabled, env: scene.environment, pr: r.getPixelRatio() };
  // 量 render() 的**同步**耗时：SwiftShader 下光栅化就在 render() 里阻塞主线程，
  // 这是「一帧占住主线程多久」的直接证据，比 rAF 间隔（被 vsync 量化）更准。
  if (!P.wrapped) {
    P.wrapped = true;
    P.origRender = r.render.bind(r);
    r.render = (s, c) => {
      const t = performance.now();
      if (!P.skipRender) P.origRender(s, c);
      const ms = performance.now() - t;
      if (P.renderMs.length < 4000) P.renderMs.push(ms);
    };
  }
  P.skipRender = false;
  P.renderMs = [];
  r.shadowMap.enabled = P.base.shadow;
  scene.environment = P.base.env;
  r.setPixelRatio(P.base.pr);
  for (const part of String(variantName).split("+")) {
    if (part === "noShadow") r.shadowMap.enabled = false;
    else if (part === "noEnv") scene.environment = null;
    else if (part === "halfRes") r.setPixelRatio(P.base.pr * 0.5);
    else if (part === "noRender") P.skipRender = true;
  }
  return { applied: true, variant: variantName, pixelRatio: r.getPixelRatio(), shadow: r.shadowMap.enabled, env: Boolean(scene.environment) };
}, name);

const framesSince = (since) => page.evaluate((from) => window.__probe.frames.slice(from), since);
const frameCount = () => page.evaluate(() => window.__probe.frames.length);
const armClick = (selector) => page.evaluate((sel) => {
  const button = document.querySelector(sel);
  window.__probe.input = null;
  button.addEventListener("click", (event) => {
    window.__probe.input = { handlerAt: performance.now(), eventTimeStamp: event.timeStamp, trusted: event.isTrusted };
  }, { capture: true, once: true });
}, selector);
const realClick = async (selector) => {
  // 窄屏下按钮可能在折叠区/视口外：先滚动到中间，再用真实鼠标点它
  await page.$eval(selector, (el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  const box = await (await page.$(selector))?.boundingBox();
  if (!box) throw new Error(`target not visible: ${selector}`);
  const vp = page.viewport();
  if (box.y < 0 || box.y + box.height > vp.height || box.x < 0 || box.x + box.width > vp.width) {
    throw new Error(`target outside viewport: ${selector} box=${JSON.stringify(box)} vp=${JSON.stringify(vp)}`);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const waitState = (predicate, timeout = 60000) => page.waitForFunction(predicate, { timeout, polling: 50 }).then(() => true).catch(() => false);

/**
 * CDP 采样分析器：按**函数自耗时**聚合（不是只看总时长）。
 * SwiftShader 的光栅化在工作线程里，主线程的 JS 热点只有采样分析能分开统计，
 * 单看 frame() 的四个阶段仍会把「图表重绘」和「表格重建」混在同一段里。
 */
const profileOnce = async (ms) => {
  const client = await page.target().createCDPSession();
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval", { interval: 100 });
  await client.send("Profiler.start");
  await new Promise((r) => setTimeout(r, ms));
  const { profile } = await client.send("Profiler.stop");
  await client.detach().catch(() => {});
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let k = 0; k < profile.samples.length; k++) {
    const node = byId.get(profile.samples[k]);
    const dt = profile.timeDeltas[k] ?? 0;
    total += dt;
    if (!node) continue;
    const cf = node.callFrame;
    const file = (cf.url || "").split("/").pop() || "(native)";
    const key = `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  return [...self.entries()]
    .map(([fn, us]) => ({ fn, ms: Math.round(us / 100) / 10, pct: total ? Math.round((100 * us) / total * 10) / 10 : 0 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, profileTop || 15);
};

/** 在运行期采 setTimeout(0) 延迟；每样本前后都确认批量仍在跑（否则样本无效）。 */
const timerSamples = (n) => page.evaluate(async (count) => {
  window.__probe.timers = [];
  for (let i = 0; i < count; i++) {
    const before = window.attitudeDemo.experiment.batchState();
    if (!before.running) break;
    const t = performance.now();
    await new Promise((res) => setTimeout(res, 0));
    const after = window.attitudeDemo.experiment.batchState();
    window.__probe.timers.push({ ms: performance.now() - t, runningBefore: before.running, runningAfter: after.running });
  }
  return window.__probe.timers.map((s) => s.ms);
}, n);

const results = [];
for (const variant of variants) {
  const applied = await applyVariant(variant);
  if (!applied.applied) { console.error("[FAIL] 页面没有暴露 renderer/scene，无法对照"); process.exit(2); }
  // 材质重编译/尺寸变化后先稳定一段时间，再采基线帧；同时清空分阶段最大值
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => window.attitudeDemo.performance?.(true));
  const from = await frameCount();
  await new Promise((r) => setTimeout(r, sampleMs));
  const frames = await page.evaluate((n) => window.__probe.frames.slice(n), from);
  const renderMs = await page.evaluate(() => window.__probe.renderMs.slice());

  // 主线程降级批量：与 SW-10 同一负载形态（30 种子 × 30 s），采完 timer 就取消
  await page.evaluate(() => {
    const ex = window.attitudeDemo.experiment;
    ex.disableWorker();
    // 窄屏下实验面板默认折叠，按钮不可见；测试要的是真实可见可点的按钮
    document.getElementById("sec-experiments")?.classList.remove("collapsed");
    const sel = document.getElementById("batch-runs");
    sel.value = "30x30";
    sel.dispatchEvent(new Event("change"));
  });
  const running = await page.evaluate(() => {
    document.getElementById("btn-batch").click();
    return window.attitudeDemo.experiment.batchState();
  }).then(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return page.evaluate(() => window.attitudeDemo.experiment.batchState());
  });
  const timers = running.running ? await timerSamples(25) : [];
  const profile = profileTop > 0 && variant === "baseline" && running.running ? await profileOnce(3000) : null;  const before = await page.evaluate(() => ({
    state: window.attitudeDemo.experiment.batchState(),
    perf: window.attitudeDemo.performance?.() ?? null,
  }));
  await armClick("#btn-batch");
  await realClick("#btn-batch");
  const sawHandler = await waitState(() => window.__probe.input?.trusted === true, 20000);
  const input = sawHandler ? await page.evaluate(() => window.__probe.input) : null;
  await waitState(() => {
    const s = window.attitudeDemo.experiment.batchState();
    return !s.running && s.cancelTiming?.postAwaitAt != null;
  }, 60000);
  const after = await page.evaluate(() => ({
    state: window.attitudeDemo.experiment.batchState(),
    perf: window.attitudeDemo.performance?.() ?? null,
  }));
  const timing = after.state.cancelTiming ?? {};
  const row = {
    variant, applied,
    frames: summary(frames),
    renderMs: summary(renderMs),
    timers: summary(timers),
    runningConfirmed: running.running,
    batchSlices: after.state.slices ?? null,
    phases: before.perf?.max ?? null,
    profile,
    eventToHandlerMs: input ? input.handlerAt - input.eventTimeStamp : null,
    handlerToRunnerStopMs: input && timing.runnerStoppedAt != null ? timing.runnerStoppedAt - input.handlerAt : null,
    requestToRunnerStopMs: timing.requestedAt != null && timing.runnerStoppedAt != null ? timing.runnerStoppedAt - timing.requestedAt : null,
    eventToRunnerStopMs: input && timing.runnerStoppedAt != null ? timing.runnerStoppedAt - input.eventTimeStamp : null,
    inputTrusted: input?.trusted ?? false,
    partialSeeds: after.state.partialSeeds,
  };
  results.push(row);
  console.log(`  [${variant}] frame p50=${row.frames.p50?.toFixed(1)} p95=${row.frames.p95?.toFixed(1)} max=${row.frames.max?.toFixed(1)}`
    + ` | render p50=${row.renderMs.p50?.toFixed(1) ?? "—"} max=${row.renderMs.max?.toFixed(1) ?? "—"}`
    + ` | timer p95=${row.timers.p95?.toFixed(1) ?? "—"}`
    + ` | ev->handler ${row.eventToHandlerMs?.toFixed(1) ?? "—"} ev->stop ${row.eventToRunnerStopMs?.toFixed(1) ?? "—"}`
    + ` | slice max ${row.batchSlices?.maxComputeMs?.toFixed(1) ?? "—"}`
    + ` | sim ${row.phases?.simulation?.toFixed(1) ?? "—"} scene ${row.phases?.scene?.toFixed(1) ?? "—"}`
    + ` ui ${row.phases?.ui?.toFixed(1) ?? "—"} metrics ${row.phases?.metrics?.toFixed(1) ?? "—"} frame ${row.phases?.frame?.toFixed(1) ?? "—"}`);
}

const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), kind: "diagnostic-probe-not-a-gate",
  url, viewport: { width: vw, height: vh, deviceScaleFactor: 1 }, cpuThrottle,
  browserVersion, rendererInfo,
  commit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
  sourceDigest: sourceDigest(root).digest, worktree: worktreeState(root),
  buildId: readProvenance(join(root, "dist"))?.buildId ?? null, distHash: distHashOf(join(root, "dist")),
  consoleErrors, results, checks,
  note: "单变量诊断对照；baseline 才是产品配置。noRender/noShadow 等变体只用于定位热点，不能当验收通过。",
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const base = results.find((r) => r.variant === "baseline");
record("baseline frames sampled", (base?.frames.count ?? 0) >= 20, `基线帧 ${base?.frames.count ?? 0} 个`);
record("console clean", consoleErrors.length === 0, `${consoleErrors.length} 个控制台错误`);
  record("cancel observed", results.every((r) => r.partialSeeds >= 0 && r.inputTrusted), "每个变体都真实取消并收到 trusted 点击");
  for (const row of results.filter((r) => r.profile)) {
    console.log(`\n  JS 自耗时 top（${row.variant}，批量运行期）：`);
    for (const f of row.profile) console.log(`    ${String(f.ms).padStart(8)} ms ${String(f.pct).padStart(5)}%  ${f.fn}`);
  }
console.log(`\n报告：${outPath}`);
await browser.close();
