/**
 * 浏览器冒烟测试（puppeteer-core + 本机 Edge/Chrome，headless）。
 *
 * 前置：`npm run build && npm run preview`（默认 http://127.0.0.1:4173）
 * 运行：`npm run smoke`（可用 SMOKE_URL / EDGE_PATH 覆盖）
 *
 * 覆盖：真实 rAF 下的仿真推进、评测表统计、实验库、磁校准、视图切换、
 * 文档对话框焦点、A/B 图例、深链恢复、3D canvas 与帧率、控制台错误。
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance as nodePerformance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readProvenance } from "./build-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 注意：应用地址常量不要命名为 `URL`——模块顶层的 `const URL` 会遮蔽全局 URL 构造函数，
// 在其声明之前调用 `new URL()` 会抛 "Cannot access 'URL' before initialization"。
const APP_URL = process.env.SMOKE_URL ?? "http://127.0.0.1:4173/";

/**
 * 冒烟分片（复核 P2-5「拆分冒烟 shard」）。
 *
 * 为什么分片：整条冒烟会开十几张 WebGL 页面（假串口 / 假 BLE / 协议端到端各一张）。
 * 一个浏览器连续创建这么多渲染上下文，在 CI 上偶发被回收（实测 `Navigating frame was detached`）。
 * 分片后每个进程只做自己那半：CI 上用矩阵并行，单进程的页面数与运行时间都降下来。
 *
 *   SMOKE_SHARD=all（默认，行为与历史完全一致）
 *   SMOKE_SHARD=app     只跑主页面用例（读数/曲线/文档/档案/导出/批量/trace/可访问性/长跑）
 *   SMOKE_SHARD=devices 只跑独立页面用例（假串口 / 假 BLE / 协议端到端 / 加计采面）
 *
 * 两片合起来恰好覆盖全部用例（CI 矩阵里两个 job 的 PASS 数之和必须等于 all 的 PASS 数）。
 */
/**
 * 超时额度（**统一**）：所有「等首帧 / 等导航 / 等进入真实模式」都用同一档宽松额度
 * （导航与首帧 60 s、状态等待 30 s）。它们等的都是"慢 runner 上迟早会到"的状态，
 * 与断言强度无关——2 vCPU 软件 WebGL 上首帧超过 15 s 是常态（Windows CI 实测 5/5 轮
 * 都死在 15 s/20 s 这类零散额度上，而同一提交在 Ubuntu CI 与本机 Windows 上 5/5 全绿）。
 *
 * 默认视口。可用 SMOKE_VIEWPORT=800x600 覆盖——只用于**容量很小的 runner**：
 * GitHub 的 windows-latest 只有 2 vCPU，软件 WebGL 下 1440×900 的填充率会把首帧拖到
 * 60 s 以上（实测 `Navigation timeout` / 首帧超时）。视口变小只影响「桌面布局用多大的窗口看」，
 * 用例本身的断言不变（窄屏用例仍自己设 390×844，设备用例仍自己设 1280×800）。
 */
/**
 * 超时额度（**统一**，可按环境整体放大）：
 *   · 默认：导航/首帧 60 s、状态等待 30 s、慢操作（长跑/批量）各自的既有额度；
 *   · `SMOKE_SLOW=1`（CI 的 2 vCPU runner + 软件 WebGL）：整体放大 3 倍。
 * 放大的是"等多久算卡死"，**不是断言强度**——真卡死仍会在放大后的额度内失败，
 * 而且超时信息里会带上当时的现场（见 `waitForState`）。
 */
const SLOW = process.env.SMOKE_SLOW === "1";
const SLOW_MS = (ms) => (SLOW ? ms * 3 : ms);
const BOOT_MS = SLOW ? 180000 : 60000;
const STATE_MS = SLOW ? 60000 : 30000;

const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.SMOKE_VIEWPORT ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1440, height: 900 };
})();

const SHARD = (process.env.SMOKE_SHARD ?? "all").toLowerCase();
if (!["all", "app", "devices"].includes(SHARD)) {
  console.error(`[FAIL] SMOKE_SHARD 只支持 all / app / devices（收到 ${JSON.stringify(SHARD)}）`);
  process.exit(2);
}
const runApp = SHARD !== "devices";
const runDevices = SHARD !== "app";

/** 换行符：app 段与 devices 段都要用（原来只在 app 段里声明，分片后必须提到顶层）。 */
const NL = String.fromCharCode(10);
// trace 比较器必须与 Node 契约测试共用同一份源码：注入页面后由浏览器侧再次执行。
const traceContractSource = readFileSync(new URL("./trace-contract.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  // Windows
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  // Linux（Ubuntu CI：GitHub 的 runner 预装 google-chrome）
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);
const candidates = CANDIDATES.filter((p) => existsSync(p));
if (candidates.length === 0) {
  console.error("找不到 Edge/Chrome，可用 CHROME_PATH / EDGE_PATH 指定可执行文件");
  process.exit(2);
}

const shots = join(process.cwd(), "screenshots");
if (!existsSync(shots)) mkdirSync(shots);
let failures = 0;
let passes = 0;
const errsEmpty = (errs) => errs.length === 0;
/**
 * 逐项结果（SW-07）：验收要比对的是**完整集合**，所以每个用例都要能报出"我叫什么、在哪个分片、
 * 什么状态"。同名用例会让集合比对失真（少跑一项、多跑一项都可能看不出来），因此同一次运行里
 * 出现重复用例名本身就是失败。
 */
const checkResults = [];
const checkNameCounts = new Map();
const skippedChecks = [];
const duplicateIds = [];
// 原始测量不能挤进会截断的 check.detail；即使等待失败也要随最终结果保留现场。
const diagnostics = { checkOutcomes: [] };
/**
 * 基础设施诊断：浏览器被系统回收时，「最后跑过哪个用例 + 当时的堆/DOM 有多大」是唯一能
 * 区分「容量到极限」与「别的原因」的证据。采样放进有界环形（最多 24 个），不逐用例堆积。
 */
const infraDiag = { lastCheck: "(未开始)", samples: [], disconnects: [] };
const samplePageMemory = async (pg) => {
  try {
    const m = await pg.metrics();
    infraDiag.samples.push({ at: Date.now(), nodes: m.Nodes, docs: m.Documents, heapMb: Math.round(m.JSHeapUsedSize / 1048576) });
    if (infraDiag.samples.length > 24) infraDiag.samples.shift();
  } catch { /* 页面可能已经随进程消失，采样失败本身不是用例失败 */ }
};
const check = (name, cond, detail) => {
  if (/^SW-10 主线程降级|^公式一键复制/.test(name)) {
    diagnostics.checkOutcomes.push({ name, pass: Boolean(cond), reason: String(detail ?? "") });
  }
  const seen = checkNameCounts.get(name) ?? 0;
  checkNameCounts.set(name, seen + 1);
  if (seen > 0) {
    duplicateIds.push(name);
    console.error(`[FAIL] 用例名重复：${name} — 同名用例必须改名（否则"完整集合"比对会失真）`);
    failures++;
    checkResults.push({ id: name, shard: SHARD, status: "duplicate", detail: "同名用例重复执行" });
    return;
  }
  checkResults.push({ id: name, shard: SHARD, status: cond ? "pass" : "fail", detail: String(detail ?? "").slice(0, 300) });
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name} — ${detail}`);
  cond ? passes++ : failures++;
  // 顺手记一个「最近跑过哪个用例」：浏览器被系统回收时，日志只能说明崩溃发生在两条 PASS 之间，
  // 结合这里的名字与下面的堆/DOM 采样才能回答「是不是内存耗到极限」。
  infraDiag.lastCheck = name;
  if (checkResults.length % 10 === 0) void samplePageMemory(page);
};
/** 明确的跳过登记口：跳过的用例必须留痕（"没跑"不许伪装成"通过"）。 */
const skip = (name, reason) => {
  skippedChecks.push({ id: name, reason: String(reason ?? "").slice(0, 200) });
  console.error(`[FAIL] 用例被跳过：${name} — ${reason ?? ""}`);
  failures++;
};

// 固定 user-data-dir：Windows 上 Puppeteer 的临时 profile 清理偶尔 EBUSY，
// 会让「测试全部通过」的进程以异常退出码结束。这里自己管目录并在收尾时容错删除。
// 目录名带 pid：上一次失败留下的 Edge/Chrome 进程会锁住同名 profile（crashpad
// "Settings version is not 1"），换一个新目录即可让下一次冒烟继续跑；可用 SMOKE_PROFILE 覆盖。
// 逐个尝试候选浏览器：某些 Windows 环境下 Edge 的 crashpad 会启动失败，直接换 Chrome 即可，
// 而不是让整条冒烟因为「第一个存在的可执行文件打不开」而红掉。
let browser = null;
/** 正常收尾期间不计入「进程被回收」：那是我们自己关的 */
let shuttingDown = false;
let profileDir = process.env.SMOKE_PROFILE ?? "";
const launchBrowser = async () => {
  for (const [i, exe] of candidates.entries()) {
    const dir = process.env.SMOKE_PROFILE ?? join(tmpdir(), `quat-demo-smoke-profile-${process.pid}-${i}-${Date.now()}`);
    try {
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: "new",
        // CI 冷启动（新建 profile、磁盘慢）可能超过 puppeteer 默认的 30 s WS 超时
        timeout: BOOT_MS,
        // CDP 协议超时：单次 evaluate / 新建标签页在慢 runner 上本身就会顶到几十秒到几分钟
        // （Windows CI 实测 `Network.enable timed out` / `Runtime.callFunctionOn timed out`）。
        // 这不是断言，是"等多久算通讯失联"，所以跟着容量倍率一起放大（默认 300 s，慢环境 900 s）。
        protocolTimeout: SLOW_MS(300000),
        userDataDir: dir,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--hide-scrollbars",
          // CI 的 headless Chrome 会把页面当成「后台标签页」→ rAF 被节流甚至停摆，
          // 仿真时钟不动，冒烟第一步（等待 t>2s）就会超时 15 秒。
          // 这三个标志是标准的抑制手段：关掉定时器节流、关掉窗口遮挡降级、关掉渲染进程降级。
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });
      profileDir = dir;
      // 进程消失（被系统回收/崩溃）时留现场：正常收尾关闭不算一次基础设施事件
      browser.on("disconnected", () => {
        if (shuttingDown) return;
        infraDiag.disconnects.push({
          at: Date.now(), lastCheck: infraDiag.lastCheck, lastSample: infraDiag.samples.at(-1) ?? null,
        });
      });
      console.log(`[INFO] 使用浏览器：${exe}`);
      // 版本要能被驱动脚本解析出来写进稳定性摘要（证据要能回答"用哪个浏览器跑的"）
      browserVersion = await browser.version();
      console.log(`[INFO] 浏览器版本：${browserVersion}`);
      return;
    } catch (err) {
            // 候选浏览器启动慢/被占用时换下一个是可预期的回退，不该算「门禁 warning」
      // （验收里的「零 warning」指的是**浏览器被回收/重启**这类不稳定）。用 [info] 记录。
      console.log(`[info] 启动失败，尝试下一个候选：${exe} — ${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)}`);
    }
  }
  console.error("所有候选浏览器都无法启动；可用 CHROME_PATH 指定一个能跑 headless 的可执行文件");
  process.exit(2);
};
/** 实际用的浏览器版本（结构化结果要能回答"用哪个浏览器跑的"）：必须在启动前就声明好 */
let browserVersion = null;
await launchBrowser();

/**
 * 开新页面，并在浏览器进程被回收时**重启一次再继续**。
 *
 * 为什么需要：整条冒烟会开十几次标签页（每页一个 WebGL 上下文，软件渲染下更吃内存），
 * 偶发 `Protocol error (Target.createTarget): Session with given id not found`——
 * 浏览器进程已经没了。旧实现直接抛异常，整条冒烟在第 68 项就中断，后面几十项一条没跑，
 * 却报「冒烟异常」而不是指出真实失败项。这里重启浏览器后重试，其余用例照常执行。
 */
const errors = [];
/** 共享页面的监听：浏览器重启后要重新挂（页面对象换了一个）。 */
const attachSharedListeners = (target) => {
  target.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  target.on("pageerror", (err) => errors.push(String(err)));
};
let page = null;
/**
 * 浏览器进程被回收的次数。
 *
 * 复核 P2-5：旧实现「重启后从中段继续」，成功轮也带着 warning，结果被当成全绿——
 * 而重启前后的用例其实跑在不同的浏览器进程/页面上。现在**只用于诊断续跑**，
 * 最终结论必须把「发生过重启」判为基础设施失败（见文件末尾），不允许伪装成通过。
 */
let browserRestarts = 0;
/** 运行是否被异常打断：`completed` 标记必须诚实（被打断的那次不能自称"跑完了"）。 */
let aborted = false;
let abortReason = "";

/**
 * 基础设施类故障的特征：渲染进程被回收（`Navigating frame was detached` / `Target closed`）。
 * 这类失败不是产品缺陷，但**必须显式记账**——重试只为让本轮继续收集诊断，最终结论仍判失败。
 */
const isInfraError = (err) =>
  /detached|Target closed|Session closed|Navigating frame|Protocol error|Connection closed/i.test(String(err));

/**
 * 导航到应用；遇到基础设施故障时在**同一页面**重试一次并计入 `browserRestarts`。
 * 为什么需要：WebGL 页面开得多时浏览器会回收渲染进程，`goto` 抛 `Navigating frame was detached`，
 * 整条冒烟在最后几项里中断（实测第 5 轮）。重试后本轮继续，但结论不会被当成全绿。
 */
const gotoSafe = async (pg, url = APP_URL) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_MS });
      return;
    } catch (err) {
      if (attempt >= 1 || !isInfraError(err)) throw err;
      browserRestarts++;
      console.warn("[warn] 导航时页面被回收（" + String(err).split(String.fromCharCode(10))[0] + "）——同一页面重试一次");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};
/**
 * 开新页面；浏览器进程被回收时**重启一次再继续**。
 *
 * 为什么需要：整条冒烟会开十几次标签页（每页一个 WebGL 上下文，软件渲染下更吃内存），
 * 偶发 `Protocol error (Target.createTarget): Session with given id not found`——
 * 浏览器进程已经没了。旧实现直接抛异常，整条冒烟在第 68 项就中断，后面几十项一条没跑，
 * 却只报「冒烟异常」，看不出真实失败项。
 *
 * 重启后**共享页面也必须一起重建**：它还挂在死掉的浏览器上，后面的用例一 `evaluate`
 * 就报 `Attempted to use detached Frame`（实测踩到）。这里重生一个同样的共享页面。
 */
const newPage = async () => {
  try {
    return await browser.newPage();
  } catch (err) {
    console.warn(`[warn] 新建标签页失败（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）——重启浏览器后重试`);
    browserRestarts++;
    try { await browser.close(); } catch { /* 已经死了 */ }
    browser = null;
    await launchBrowser();
    if (page) {
      try { await page.close(); } catch { /* 已随进程消失 */ }
      page = await browser.newPage();
      await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
      attachSharedListeners(page);
      // 重启后的共享页面必须**重新载入应用**：后面的用例直接读 DOM，
      // 空白页只会以「Cannot read properties of null」的形式误报成产品缺陷（实测踩到）。
      try {
        await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: BOOT_MS });
        await page.waitForFunction(
          () => document.getElementById("fps")?.textContent !== "-- fps",
          { timeout: BOOT_MS },
        );
      } catch { /* 让具体用例自己的 waitFor 报更准确的失败 */ }
    }
    return browser.newPage();
  }
};
/** 独立用例只运行被测页；临时冻结无关共享页，结束后恢复原现场。 */
const withIndependentPage = async (body) => {
  const session = await page.createCDPSession();
  let pg;
  try {
    await session.send("Page.setWebLifecycleState", { state: "frozen" });
    pg = await newPage();
    await pg.bringToFront();
    return await body(pg);
  } finally {
    try { if (pg && !pg.isClosed()) await pg.close(); }
    finally {
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await session.detach();
      await page.bringToFront();
    }
  }
};
page = await browser.newPage();
await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
attachSharedListeners(page);
/**
 * 产物身份（SW-06）：本地产物自报的 buildId vs 被测页面自报的 buildId。
 * `browser-smoke` 打的是本地 preview，两者不一致就说明"跑的不是刚构建的产物"。
 */
const identity = { available: false, reason: "", localBuildId: null, pageBuildId: null };
(() => {
  const provenance = readProvenance(join(root, "dist"));
  if (!provenance?.buildId) { identity.reason = "本地 dist 缺少构建溯源（先 npm run build）"; return; }
  identity.localBuildId = provenance.buildId;
  identity.available = true;
})();

try {
  // 共享页面的导航与「仿真真的在跑」的等待两片都要做：devices 片里有一组用例
  // （加计采面 beginAccelCalFace/tickAccelCalibration）驱动的正是这个页面。
  await gotoSafe(page);
  // 页面异步取回产物溯源（build-provenance.json）后才会有 buildId：给它一个有界等待，
  // 取不到就按"缺失"判定，而不是让断言在竞态里随机红/绿。
  try {
    await page.waitForFunction(() => Boolean(window.attitudeDemo?.build?.()?.buildId), { timeout: SLOW_MS(15000) });
  } catch { /* 下面按缺失判定并给出可执行的失败原因 */ }
  identity.pageBuildId = await page.evaluate(() => window.attitudeDemo?.build?.()?.buildId ?? null);
  // 等待真实仿真推进（rAF）——隐藏标签页会冻结，headless 新模式下正常运行
  await page.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 2,
    { timeout: BOOT_MS }, // 软件渲染（swiftshader）下 CI 的首帧可能很慢，给足余量
  );
  if (runApp) {
  const boot = await page.evaluate(() => {
    const canvas = document.querySelector("#viewport canvas");
    const gl = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
    return {
      clock: document.getElementById("clock")?.textContent,
      fps: document.getElementById("fps")?.textContent,
      canvas: canvas ? { w: canvas.width, h: canvas.height, gl: Boolean(gl) } : null,
      metrics: document.getElementById("metrics-body")?.innerText ?? "",
      meta: document.getElementById("metrics-meta")?.textContent ?? "",
    };
  });
  check("仿真在真实 rAF 下推进", parseFloat(boot.clock.replace("t = ", "")) > 2, boot.clock);
  // 被服务产物身份（SW-06）：页面自报的 buildId 必须等于本地 dist 的溯源。
  // 只比提交号做不到这件事——改了源码没提交、或重建了产物，两份不同的 dist 会顶同一个 commit。
  // 写成**单一调用点**：同一用例分叉成两处调用，会让"完整集合"比对与清单漂移检查同时失真。
  check(
    "被服务产物与本地构建一致（buildId）",
    identity.available && identity.pageBuildId === identity.localBuildId,
    identity.available ? `页面 ${identity.pageBuildId ?? "（缺失）"} / 本地 ${identity.localBuildId}` : identity.reason,
  );
  check("3D canvas 有 WebGL 上下文", Boolean(boot.canvas?.gl) && boot.canvas.w > 0, JSON.stringify(boot.canvas));
  check("帧率读数正常", /\d+\s*fps/.test(boot.fps), boot.fps);
  check("评测表已有统计", /[1-9]\d*\s*个样本/.test(boot.meta), boot.meta);
  check("评测行不再是占位符", !/—\s*—\s*—/.test(boot.metrics.split("\n")[0] ?? ""), boot.metrics.split("\n")[0]);
  await page.screenshot({ path: join(shots, "01-overview.png") });

  // IMU 面板展开 → 图例 6 条且数值已填充（旧版 #imu-legend 从未构建）
  await page.evaluate(() => document.querySelector("#block-imu .fold-btn").click());
  await new Promise((r) => setTimeout(r, 400));
  const imu = await page.evaluate(() => ({
    collapsed: document.getElementById("block-imu").classList.contains("collapsed"),
    chips: [...document.querySelectorAll("#imu-legend .legend-chip")].map((c) => c.textContent),
    canvasH: document.getElementById("imu-canvas").getBoundingClientRect().height,
  }));
  check(
    "IMU 面板展开且图例 6 条有读数",
    !imu.collapsed && imu.canvasH > 10 && imu.chips.length === 6 && imu.chips.every((t) => !t.endsWith("--")),
    `${imu.chips.join(" / ")}`,
  );

  // ---------- 曲线折叠：三种状态都不留空洞 ----------
  const foldStates = await page.evaluate(() => {
    const snap = () => ({
      count: document.getElementById("charts").dataset.openCount,
      blocks: [...document.querySelectorAll(".chart-block")].map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id, h: Math.round(r.height), w: Math.round(r.width), collapsed: b.classList.contains("collapsed") };
      }),
    });
    const chip = (k) => document.querySelector(`.cb-chip[data-chart="${k}"]`);
    const isOpen = (k) => !document.getElementById(`block-${k}`).classList.contains("collapsed");
    // 归一到「三块全开」作为起点（前面的测试可能已改过状态）
    for (const k of ["att", "err", "imu"]) if (!isOpen(k)) chip(k).click();
    const three = snap();
    chip("att").click();
    const two = snap();
    chip("err").click();
    const one = snap();
    // 恢复
    chip("att").click();
    chip("err").click();
    chip("imu").click();
    return { three, two, one };
  });
  // 无空洞判据：展开块都足够宽（不是被挤成窄条）、折叠块都压成细标题条
  const noHole = (s) =>
    s.blocks.filter((b) => !b.collapsed).every((b) => b.w > 400) &&
    s.blocks.filter((b) => b.collapsed).every((b) => b.h < 60) &&
    s.blocks.some((b) => !b.collapsed);
  check(
    "曲线折叠三态无空洞",
    noHole(foldStates.three) && noHole(foldStates.two) && noHole(foldStates.one) &&
      foldStates.three.count === "3" && foldStates.two.count === "2" && foldStates.one.count === "1",
    `3开:${foldStates.three.blocks.map((b) => `${b.id.replace("block-", "")}=${b.w}×${b.h}`).join(" ")}；` +
      `2开:${foldStates.two.blocks.map((b) => `${b.id.replace("block-", "")}=${b.w}×${b.h}`).join(" ")}；` +
      `1开:${foldStates.one.blocks.map((b) => `${b.id.replace("block-", "")}=${b.w}×${b.h}`).join(" ")}`,
  );

  // ---------- 右侧面板手风琴 ----------
  const acc = await page.evaluate(() => {
    const secs = [...document.querySelectorAll("#panel .panel-section")];
    const target = document.getElementById("sec-imu");
    const btn = target.querySelector(".panel-toggle");
    const collapsedBefore = target.classList.contains("collapsed");
    btn.click();
    const collapsedAfter = target.classList.contains("collapsed");
    const aria = btn.getAttribute("aria-expanded");
    document.getElementById("panel-collapse-all").click();
    const allCollapsed = secs.every((s) => s.classList.contains("collapsed"));
    const summaries = secs.map((s) => s.querySelector(".ph-summary")?.textContent ?? "");
    document.getElementById("panel-expand-all").click();
    const allOpen = secs.every((s) => !s.classList.contains("collapsed"));
    return { collapsedBefore, collapsedAfter, aria, allCollapsed, allOpen, summaries, count: secs.length };
  });
  check(
    "面板手风琴（单区切换 + 全展开/全收起 + 摘要）",
    acc.collapsedBefore && !acc.collapsedAfter && acc.aria === "true" && acc.allCollapsed && acc.allOpen &&
      acc.summaries.filter((t) => t.trim().length > 0).length >= acc.count - 1,
    `${acc.count} 个分区；全收起=${acc.allCollapsed} 全展开=${acc.allOpen}；摘要：${acc.summaries.slice(0, 4).join(" / ")}`,
  );

  // 实验库：应用零偏漂移（面板可能默认收起——先展开再点）
  const exp = await page.evaluate(() => {
    const sec = document.getElementById("sec-experiments");
    if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
    [...document.querySelectorAll("#experiment-list button")].find((b) => b.textContent.includes("零偏漂移"))?.click();
    return {
      bias: document.getElementById("imu-gyro-bias").value,
      source: document.getElementById("source-select").value,
      note: document.getElementById("experiment-note").textContent,
    };
  });
  check(
    "实验库应用参数",
    exp.bias === "3" && exp.source === "pure" && exp.note.includes("零偏漂移"),
    `bias=${exp.bias} source=${exp.source}`,
  );

  // 磁校准：设置硬铁后自动采集 + 拟合
  const mag = await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
    };
    set("imu-hard-iron", 0.6);
    set("imu-mag-disturb", 0.2);
    set("imu-gyro-bias", 1);
    document.getElementById("magcal-synthetic").click();
    return {
      status: document.getElementById("magcal-status").textContent,
      result: document.getElementById("magcal-result").textContent,
      checked: document.getElementById("magcal-apply").checked,
    };
  });
  check(
    "磁校准拟合并应用",
    mag.status.includes("已应用") && mag.result.includes("硬铁") && mag.checked,
    mag.status.trim(),
  );

  // 四元数视图 + 读数
  const quat = await page.evaluate(() => {
    [...document.querySelectorAll("#view-seg .seg-btn")].find((b) => b.dataset.view === "quat")?.click();
    return {
      view: document.body.dataset.view,
      readout: document.getElementById("quat-readout")?.textContent,
      readoutVisible: document.getElementById("quat-readout")?.getBoundingClientRect().height > 0,
      panelVisible: getComputedStyle(document.querySelector(".section-quat")).display !== "none",
      legend: getComputedStyle(document.getElementById("quat-legend")).display,
      legendChips: document.querySelectorAll("#quat-legend .lg-item").length,
    };
  });
  check(
    "四元数视图与分量读数/图例可见",
    quat.view === "quat" && quat.readoutVisible && /^\[/.test(quat.readout) && quat.panelVisible &&
      quat.legend !== "none" && quat.legendChips >= 3,
    `view=${quat.view} readout=${quat.readout?.slice(0, 24)} legend=${quat.legend}/${quat.legendChips}`,
  );
  await page.screenshot({ path: join(shots, "02-quat-view.png") });

  // 万向节视图
  const gimbal = await page.evaluate(() => {
    [...document.querySelectorAll("#view-seg .seg-btn")].find((b) => b.dataset.view === "gimbal")?.click();
    return {
      view: document.body.dataset.view,
      status: document.getElementById("gimbal-status")?.textContent,
      overlay: getComputedStyle(document.getElementById("gimbal-overlay")).display,
    };
  });
  check("万向节视图可用", gimbal.view === "gimbal" && gimbal.overlay === "flex" && gimbal.status.length > 0, gimbal.status);

  // 文档对话框：打开 → 焦点进入 → 切模块 → Esc 关闭 → 焦点恢复
  await page.click("#btn-docs");
  await page.waitForFunction(() => !document.getElementById("docs-overlay").hidden);
  const docOpen = await page.evaluate(() => ({
    hidden: document.getElementById("docs-overlay").hidden,
    focus: document.activeElement?.id,
    role: document.getElementById("docs-overlay").getAttribute("role"),
  }));
  await page.evaluate(() => {
    [...document.querySelectorAll(".module-link")].find((b) => b.dataset.doc === "math")?.click();
  });
  const docMath = await page.evaluate(() => ({
    page: document.querySelector(".doc-page:not([hidden])")?.dataset.docPage,
    toc: document.querySelector("#docs-chapter-toc a")?.textContent,
  }));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("docs-overlay").hidden);
  const docClosed = await page.evaluate(() => ({
    hidden: document.getElementById("docs-overlay").hidden,
    focus: document.activeElement?.id,
  }));
  check(
    "文档对话框焦点与分页：打开后焦点进入对话框，Esc 关闭并把焦点还给「文档」按钮",
    docOpen.role === "dialog" && docOpen.focus === "btn-docs-close" && docMath.page === "math" &&
      docClosed.hidden && docClosed.focus === "btn-docs",
    `role=${docOpen.role} focus=${docOpen.focus} page=${docMath.page} esc=${docClosed.hidden} 焦点归还=${docClosed.focus}`,
  );

  /**
   * SW-11：**只用键盘**能不能完成一次完整往返。
   * 打开（Enter）→ 焦点进入对话框 → Tab 循环不得跑出对话框 → Shift+Tab 从首个可聚焦元素回卷到最后一个
   * → Esc 关闭且焦点归还。这里用的是真实按键（page.keyboard），不是页面内派发事件。
   */
  const keyboardDocs = await (async () => {
    await page.evaluate(() => document.getElementById("btn-docs").focus());
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("docs-overlay").hidden);
    const entered = await page.evaluate(() => document.activeElement?.id ?? "");
    const inDialog = () => page.evaluate(() => document.getElementById("docs-overlay").contains(document.activeElement));
    let escaped = 0;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      if (!(await inDialog())) escaped++;
    }
    // Shift+Tab 从首个可聚焦元素应当回卷到对话框内最后一个可聚焦元素
    await page.evaluate(() => {
      const first = document.querySelector("#docs-overlay button:not([disabled]), #docs-overlay a[href]");
      first?.focus();
    });
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    const wrapped = await page.evaluate(() => {
      const overlay = document.getElementById("docs-overlay");
      const focusables = [...overlay.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')].filter((el) => el.getClientRects().length > 0);
      return { inside: overlay.contains(document.activeElement), isLast: document.activeElement === focusables[focusables.length - 1] };
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("docs-overlay").hidden);
    const back = await page.evaluate(() => document.activeElement?.id ?? "");
    return { entered, escaped, wrapped, back };
  })();
  /**
   * Ctrl/⌘+K 全文搜索（SW-12 补覆盖）：这是文档层被写进"三个便利"里的头号功能，此前没有任何用例。
   * 一次走完：快捷键唤起 → 焦点进输入框 → 输入出现结果（首项选中）→ 方向键移动 → Enter 跳转
   * → Esc 只清搜索框（不关文档）→ 注入标签被转义（查询串来自用户输入）。
   */
  const docSearch = await (async () => {
    await page.evaluate(() => document.getElementById("btn-docs").click());
    await page.waitForFunction(() => !document.getElementById("docs-overlay").hidden);
    await page.keyboard.down("Control");
    await page.keyboard.press("k");
    await page.keyboard.up("Control");
    try {
      await page.waitForFunction(() => document.activeElement?.id === "docs-search-input", { timeout: SLOW_MS(3000) });
    } catch { /* 下方按实际焦点判失败，不将等待超时包装成环境通过 */ }
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    await page.evaluate(() => {
      const input = document.getElementById("docs-search-input");
      input.value = "万向节";
      input.dispatchEvent(new Event("input"));
    });
    await new Promise((r) => setTimeout(r, 200));
    const typed = await page.evaluate(() => {
      const hits = [...document.querySelectorAll("#docs-search-hits .dsh-item")];
      return {
        count: hits.length,
        firstSelected: hits[0]?.getAttribute("aria-selected") === "true",
        firstTitle: hits[0]?.querySelector(".dsh-title")?.textContent ?? "",
        hasSnippet: (hits[0]?.querySelector(".dsh-snip")?.textContent ?? "").length > 0,
      };
    });
    await page.evaluate(() => document.getElementById("docs-search-input").focus());
    await page.keyboard.press("ArrowDown");
    const moved = await page.evaluate(() =>
      [...document.querySelectorAll("#docs-search-hits .dsh-item")].findIndex((el) => el.getAttribute("aria-selected") === "true"));
    // Enter 跳的是**当前选中项**那一页：先把它的页读出来，跳完对照（不能拿第一项去比）
    const selectedPage = await page.evaluate(() =>
      document.querySelector("#docs-search-hits .dsh-item[aria-selected='true']")?.dataset.page ?? "");
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 300));
    const jumped = await page.evaluate(() => ({
      page: document.querySelector(".doc-page:not([hidden])")?.dataset.docPage ?? "",
      hash: location.hash,
      inputFocused: document.activeElement?.id === "docs-search-input",
    }));
    // Esc：光标在搜索框里时，第一次只清搜索框（结果隐藏、文档仍开着）——
    // 注意 Enter 跳转会把焦点交还给正文，所以要先把焦点放回输入框再按（这才是真实用法的顺序）
    await page.evaluate(() => document.getElementById("docs-search-input").focus());
    await page.keyboard.press("Escape");
    const escaped = await page.evaluate(() => ({
      value: document.getElementById("docs-search-input").value,
      hidden: document.getElementById("docs-search-hits").classList.contains("hidden"),
      docsOpen: !document.getElementById("docs-overlay").hidden,
    }));
    // 注入反例：查询串会被插进结果容器，必须转义
    await page.evaluate(() => {
      const input = document.getElementById("docs-search-input");
      input.value = '<img src=x onerror="window.__xss=1">';
      input.dispatchEvent(new Event("input"));
    });
    await new Promise((r) => setTimeout(r, 200));
    const injected = await page.evaluate(() => ({
      tags: document.querySelectorAll("#docs-search-hits img, #docs-search-hits script").length,
      text: document.getElementById("docs-search-hits")?.textContent ?? "",
      flagged: Boolean(window.__xss),
    }));
    await page.evaluate(() => {
      const input = document.getElementById("docs-search-input");
      input.value = "";
      input.dispatchEvent(new Event("input"));
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("docs-overlay").hidden);
    return { focused, typed, moved, selectedPage, jumped, escaped, injected };
  })();
  check(
    "Ctrl/⌘+K 全文搜索：唤起即聚焦、结果与片段正确、方向键移动、Enter 跳转、Esc 只清搜索框",
    docSearch.focused === "docs-search-input" &&
      docSearch.typed.count > 0 && docSearch.typed.firstSelected && docSearch.typed.hasSnippet &&
      docSearch.typed.firstTitle.length > 0 &&
      docSearch.moved >= 0 &&
      docSearch.jumped.page === docSearch.selectedPage && docSearch.selectedPage.length > 0 &&
      docSearch.escaped.value === "" && docSearch.escaped.hidden && docSearch.escaped.docsOpen,
    `聚焦=${docSearch.focused}；结果 ${docSearch.typed.count} 条（首项选中=${docSearch.typed.firstSelected}、标题「${docSearch.typed.firstTitle}」）；` +
      `方向键后选中第 ${docSearch.moved} 项（所在页 ${docSearch.selectedPage}）；Enter 跳到 ${docSearch.jumped.page}；` +
      `Esc 后输入「${docSearch.escaped.value}」、结果隐藏=${docSearch.escaped.hidden}、文档仍开=${docSearch.escaped.docsOpen}`,
  );
  check(
    "Ctrl/⌘+K 搜索结果转义：查询串里的标签不得注入结果容器",
    docSearch.injected.tags === 0 && !docSearch.injected.flagged && docSearch.injected.text.includes("<img"),
    `注入的标签节点 ${docSearch.injected.tags} 个、脚本执行=${docSearch.injected.flagged}；结果文案「${docSearch.injected.text.slice(0, 60)}」`,
  );

  check(
    "SW-11 纯键盘往返：Enter 打开、Tab 被焦点陷阱留在对话框内、Shift+Tab 回卷、Esc 关闭并归还焦点",
    keyboardDocs.entered === "btn-docs-close" && keyboardDocs.escaped === 0 &&
      keyboardDocs.wrapped.inside && keyboardDocs.wrapped.isLast && keyboardDocs.back === "btn-docs",
    `打开后焦点=${keyboardDocs.entered}；Tab 30 次跑出对话框 ${keyboardDocs.escaped} 次；` +
      `Shift+Tab 回卷到最后一个可聚焦元素=${keyboardDocs.wrapped.isLast}；关闭后焦点=${keyboardDocs.back}`,
  );

  // 文档页小演示（ui/doc-demos.ts）：抽出为模块后必须仍然「看得见动静」。
  // 三个动画演示（互补 / 旋转顺序 / 校准舞蹈）的重绘点只有 docDemos.step(dt)，
  // 所以「图像指纹两次不同」本身就证明主循环 → 模块的步进链路是通的；
  // Allan 是惰性一次绘制，有图形即证明翻页钩子 docDemos.refresh 生效。
  //
  // 判「画过了」不能用「非白像素数 > X」：canvas 从未绘制时 getImageData 返回
  // 全零（透明黑），反而每个采样点都算「有内容」。六个文档演示都先铺白底，
  // 所以判据是「非白像素占比 < 一半」——未绘制=100%，绘制过≈5%。
  const canvasStat = (id) =>
    page.evaluate((cid) => {
      const c = document.getElementById(cid);
      if (!c || !c.width || !c.height) return { ink: 0, cells: 0, sig: 0 };
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      let cells = 0;
      let h = 0;
      const stride = 3;
      for (let y = 0; y < c.height; y += stride) {
        for (let x = 0; x < c.width; x += stride) {
          const i = (y * c.width + x) * 4;
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          cells++;
          if (v < 245) ink++;
          h = (h * 33 + Math.round(v)) % 4294967291;
        }
      }
      return { ink, cells, sig: h };
    }, id);
  const painted = (st) => st.ink > 0 && st.ink < st.cells * 0.5;
  // #btn-docs 只打开不关闭，已开时点击是 no-op，故可无条件调用
  const gotoDocPage = async (mod) => {
    await page.click("#btn-docs");
    await page.waitForFunction(() => !document.getElementById("docs-overlay").hidden);
    await page.evaluate((m) => {
      [...document.querySelectorAll(".module-link")].find((b) => b.dataset.doc === m)?.click();
    }, mod);
  };

  await gotoDocPage("filters");
  // 三次采样：第一次可能恰好在「还没画过第一帧」的窗口里（未绘制的 canvas 读出来是全黑，
  // 每个采样点都会被算成「有内容」——CI 慢机器上真的遇到过）。判据因此放在**后两次**上：
  // 「后两次都画过了、且它们的指纹不同」= 演示在动；真冻住了两次都是全黑、指纹相同 → 仍然会失败。
  await new Promise((r) => setTimeout(r, 700));
  const compA = await canvasStat("fig-comp-demo");
  await new Promise((r) => setTimeout(r, 2500));
  const compB = await canvasStat("fig-comp-demo");
  const bodeSt = await canvasStat("fig-bode-demo");
  await new Promise((r) => setTimeout(r, 2500));
  const compC = await canvasStat("fig-comp-demo");
  const visiblePage = await page.evaluate(() => document.querySelector(".doc-page:not([hidden])")?.dataset.docPage);
  check(
    "文档演示：互补滤波曲线在实时推进 + 频域图有图形",
    compB.sig !== compC.sig && painted(compB) && painted(compC) && painted(bodeSt),
    "当前文档页 " + visiblePage + "；曲线 " + compA.ink + " → " + compB.ink + " → " + compC.ink + "/" + compC.cells +
      "（后两次指纹变化=" + (compB.sig !== compC.sig) + "）；频域 " + bodeSt.ink + "/" + bodeSt.cells,
  );

  await gotoDocPage("math"); // 顺序 / 校准 / Allan / 一维卡尔曼四个演示都在这一页
  // 与上面的互补演示同一套判据：**丢弃第一帧**。第一次采样可能落在「还没画过第一帧」或
  // 「上一页面的内容还没被清掉」的窗口里（Ubuntu CI 第 5 轮实测 ordA 墨迹 19200 > 半屏，
  // 被 painted() 的上界判成「不像正常绘图」，而它其实只是一次瞬态）。判据放在后两次上：
  // 「后两次都画过了、且指纹不同」= 在实时重绘；真冻住时两帧相同 → 仍然失败。
  await new Promise((r) => setTimeout(r, 700));
  await canvasStat("fig-order-demo"); // 丢弃：等第一帧真正画出来
  await canvasStat("fig-calib-demo");
  await new Promise((r) => setTimeout(r, 2500)); // 摆角此刻转到约 35°
  const ordB = await canvasStat("fig-order-demo");
  const calB = await canvasStat("fig-calib-demo");
  await new Promise((r) => setTimeout(r, 2500));
  const ordC = await canvasStat("fig-order-demo");
  const calC = await canvasStat("fig-calib-demo");
  const allanSt = await canvasStat("fig-allan-demo");
  const kfSt = await canvasStat("fig-kf1d-demo");
  // 一维卡尔曼那张图是**静态**演示：重绘点只有「拖动它自己的滑杆」。抽出模块时
  // dockInput 与事件绑定也一起搬了家，所以这里必须验一次「拖滑杆 → 图会变」，
  // 否则「画过一次」的断言在绑定断掉时依然会通过。
  const kfMoved = await page.evaluate(async () => {
    const fig = document.getElementById("fig-kf1d-demo").closest("figure");
    const inp = fig.querySelector('input[data-dock="kf-s1"]');
    if (!inp) return { found: false };
    inp.value = String(Number(inp.max || 3)); // 挪到量程另一端
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const shown = fig.querySelector('[data-dockval="kf-s1"]')?.textContent ?? "";
    return { found: true, shown };
  });
  const kfAfter = await canvasStat("fig-kf1d-demo");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("docs-overlay").hidden);
  check(
    "文档演示：旋转顺序 / 校准舞蹈在实时重绘",
    ordB.sig !== ordC.sig && calB.sig !== calC.sig && painted(ordB) && painted(ordC) && painted(calB) && painted(calC),
    `顺序 ${ordB.ink} → ${ordC.ink}（变化=${ordB.sig !== ordC.sig}）；校准 ${calB.ink} → ${calC.ink}（变化=${calB.sig !== calC.sig}）`,
  );
  check(
    "文档演示：Allan 有图形（惰性一次绘制生效）+ 一维卡尔曼拖滑杆会重绘",
    painted(allanSt) && painted(kfSt) && painted(kfAfter) && kfMoved.found && kfAfter.sig !== kfSt.sig && kfMoved.shown.length > 0,
    `Allan=${allanSt.ink}/${allanSt.cells}；KF1D ${kfSt.ink} → ${kfAfter.ink}（拖滑杆后指纹变化=${kfAfter.sig !== kfSt.sig}，读数「${kfMoved.shown}」）`,
  );

  // A/B：开启后 B 组图例 4 个且默认可见
  const ab = await page.evaluate(() => {
    document.getElementById("ab-toggle").click();
    return {
      on: document.body.dataset.ab,
      chips: [...document.querySelectorAll("#err-legend-b .legend-chip")].length,
      pressed: [...document.querySelectorAll("#err-legend-b .legend-chip")].every(
        (c) => c.getAttribute("aria-pressed") === "true",
      ),
    };
  });
  check("A/B 快照与 B 组图例", ab.on === "on" && ab.chips === 4 && ab.pressed, `${ab.on} chips=${ab.chips}`);

  // A/B online-fork：B 复制 A 的运行期状态，分叉瞬间两组姿态必须一致；切回同起点则两组都回初值
  const abFork = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    const mode = document.getElementById("ab-mode");
    mode.value = "online-fork";
    mode.dispatchEvent(new Event("change"));
    await sleep(700);
    document.getElementById("btn-ab-snapshot").click();
    await sleep(60);
    const fork = window.attitudeDemo.ab();
    // B 配置冻结：改 A 的磁形态 / 门控 / 卡尔曼门控后，A 变而 frozen(B) 不变
    const setSel = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("change"));
    };
    setSel("mag-mode", "full");
    document.getElementById("gate-deg").value = "30";
    document.getElementById("gate-deg").dispatchEvent(new Event("input"));
    setSel("kalman-gate", "mahalanobis");
    await sleep(40);
    const aCfg = window.attitudeDemo.experiment.config(1).estimators;
    const freezeCheck = {
      aMagMode: aCfg.mahony.magMode,
      bMagMode: fork.frozen?.mahony?.magMode,
      aGate: aCfg.comp.gateDeg,
      bGate: fork.frozen?.comp?.gateDeg,
      aKalman: aCfg.kalman.kalmanGate,
      bKalman: fork.frozen?.kalman?.kalmanGate,
    };
    setSel("mag-mode", "yaw");
    document.getElementById("gate-deg").value = "20";
    document.getElementById("gate-deg").dispatchEvent(new Event("input"));
    setSel("kalman-gate", "angle");
    mode.value = "same-start";
    mode.dispatchEvent(new Event("change"));
    // 同起点会 resetSim；等一帧确认两组都从初值开始
    await sleep(60);
    const same = window.attitudeDemo.ab();
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    return { fork, same, freezeCheck };
  });
  const forkOk =
    abFork.fork.on &&
    abFork.fork.mode === "online-fork" &&
    abFork.fork.clones.length === 4 &&
    abFork.fork.clones.every((c) => c.angleToA < 1e-6);
  const sameOk =
    abFork.same.mode === "same-start" &&
    abFork.same.clones.every((c) => c.angleToA < 1e-6) &&
    Math.abs(abFork.same.clones[0].q.w) > 0.999;
  const freeze = abFork.freezeCheck;
  const freezeOk =
    freeze.aMagMode === "full" && freeze.bMagMode === "yaw" &&
    freeze.aGate === 30 && freeze.bGate === 20 &&
    freeze.aKalman === "mahalanobis" && freeze.bKalman === "angle";
  check(
    "A/B 在线分叉：复制运行期状态后与 A 一致；B 配置冻结不被 A 的修改带动",
    forkOk && sameOk && freezeOk,
    `fork 最大姿态差 ${Math.max(...abFork.fork.clones.map((c) => c.angleToA)).toExponential(1)}°；` +
      `A/B 磁形态 ${freeze.aMagMode}/${freeze.bMagMode}、门控 ${freeze.aGate}/${freeze.bGate}、卡尔曼门控 ${freeze.aKalman}/${freeze.bKalman}；` +
      `same-start 最大差 ${Math.max(...abFork.same.clones.map((c) => c.angleToA)).toExponential(1)}°、初始 q.w=${abFork.same.clones[0].q.w.toFixed(4)}`,
  );

  // 全帧记录：开启后按真实帧率增长，导出弹窗多出「全帧原始 IMU」档且列名可回放
  const rawCase = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    document.getElementById("sec-imu").classList.remove("collapsed");
    // 幂等开启：上一轮用例若已开着，直接再点会把它关掉（复核：首轮 50 帧/0 数据行的根因之一）
    if (!document.getElementById("raw-record-toggle").checked) document.getElementById("raw-record-toggle").click();
    // 状态等待而非固定 sleep：软件渲染下 rAF 可能明显偏慢，固定 1.6 s 只会偶发不足
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline && window.attitudeDemo.raw().rows < 160) await sleep(100);
    const before = window.attitudeDemo.raw();
    let text = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => {
      b.text().then((t) => (text = t));
      return "blob:raw";
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("btn-export").click();
    await sleep(120);
    document.querySelector('input[name="export-scope"][value="raw"]').checked = true;
    document.getElementById("export-confirm").click();
    // blob.text() 是异步的：慢机器上固定 250 ms 会读不完 → 轮询等文本落地
    for (let i = 0; i < 80 && !text; i++) await sleep(50);
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick;
    document.getElementById("raw-record-toggle").click();
    return { before, text };
  });
  const rawLines = rawCase.text ? rawCase.text.split(String.fromCharCode(10)) : [];
  const rawDataLines = rawLines.filter((l) => /^\d/.test(l)).length;
  check(
    "全帧原始 IMU：记录增长 + 导出列名可回放",
    rawCase.before.on && rawCase.before.rows > 150 &&
      Boolean(rawCase.text) &&
      rawCase.text.includes("gyro_x_dps") &&
      rawCase.text.includes("accel_z_ms2") &&
      rawDataLines > 120,
    `记录 ${rawCase.before.rows}/${rawCase.before.cap} 帧；导出 ${rawDataLines} 数据行、含 gyro_x_dps/accel_z_ms2`,
  );

  // 完整 3×3 椭球校准：模型下拉可切换，合成数据自动采集后拟合成功且残差有读数
  const magFull = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById("sec-magcal").classList.remove("collapsed");
    const sel = document.getElementById("magcal-model");
    sel.value = "full";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("magcal-synthetic").click();
    await sleep(300);
    return {
      status: document.getElementById("magcal-status")?.textContent ?? "",
      result: document.getElementById("magcal-result")?.textContent ?? "",
      applied: document.getElementById("magcal-apply")?.checked,
    };
  });
  check(
    "磁校准完整 3×3 椭球：模型切换 + 合成样本拟合并应用",
    magFull.status.includes("已应用") && magFull.result.includes("完整 3×3") && magFull.applied,
    `${magFull.status.slice(0, 40)}；${magFull.result.slice(0, 60)}`,
  );

  // 加速度计六面校准：注入已知 M/b 的六面样本 → 走真实拟合/应用路径
  const accelCal = await page.evaluate(() => {
    const g = 9.80665;
    const M = [1.02, 0.02, -0.01, -0.015, 0.98, 0.03, 0.02, -0.012, 1.01];
    const b = [0.05, -0.03, 0.08];
    const faces = [
      ["+x", [g, 0, 0]],
      ["-x", [-g, 0, 0]],
      ["+y", [0, g, 0]],
      ["-y", [0, -g, 0]],
      ["+z", [0, 0, g]],
      ["-z", [0, 0, -g]],
    ];
    const samples = faces.map(([face, t]) => {
      const raw = [0, 1, 2].map((i) => M[i * 3] * t[0] + M[i * 3 + 1] * t[1] + M[i * 3 + 2] * t[2] + b[i]);
      return { face, raw };
    });
    const r = window.attitudeDemo.accelcal.inject(samples);
    return {
      ...r,
      status: document.getElementById("accelcal-status")?.textContent ?? "",
      result: document.getElementById("accelcal-result")?.textContent ?? "",
    };
  });
  check(
    "加速度计六面校准：注入六面样本 → 拟合并应用、残差近零",
    accelCal.ok && accelCal.applied && accelCal.rmse < 1e-6 &&
      accelCal.status.includes("已拟合") && accelCal.result.includes("bias"),
    `残差 ${accelCal.rmse.toExponential(1)} m/s²；${accelCal.status.slice(0, 50)}`,
  );

  // 独立验证按钮：换一组新样本核对「标定前后」（拟合残差之外的第二道判据）
  const calVerify = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById("sec-magcal").classList.remove("collapsed");
    document.getElementById("magcal-verify").click();
    await sleep(150);
    document.getElementById("accelcal-verify").click();
    await sleep(150);
    return {
      mag: document.getElementById("magcal-result")?.textContent ?? "",
      accel: document.getElementById("accelcal-result")?.textContent ?? "",
    };
  });
  const magPart = calVerify.mag.slice(Math.max(0, calVerify.mag.indexOf("独立验证")));
  const accelPart = calVerify.accel.slice(Math.max(0, calVerify.accel.indexOf("独立验证")));
  check(
    "校准独立验证：磁航向误差与加计模长偏离都给出「标定前 → 标定后」",
    calVerify.mag.includes("独立验证") && calVerify.mag.includes("航向误差") &&
      calVerify.accel.includes("独立验证") && calVerify.accel.includes("模长偏离") &&
      /→/.test(magPart),
    `磁：${magPart.slice(0, 80)}｜加计：${accelPart.slice(0, 60)}`,
  );

  // 校准器件指纹：拟合后改器件参数，面板必须提示「标定基于旧模型」（否则用户以为残差仍有效）
  const calibStale = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
      el.dispatchEvent(new Event("change"));
    };
    document.getElementById("sec-magcal").classList.remove("collapsed");
    set("imu-cross-axis", 0);
    set("imu-accel-nonlin", 0);
    document.getElementById("magcal-synthetic").click(); // 重新拟合（记录当前指纹）
    await sleep(400);
    // 面板是 2 Hz 刷新的：用「等到出现/消失」代替固定 sleep（固定等待会偶发假失败）
    const waitText = async (pred, ms = 3000) => {
      const t0 = Date.now();
      for (;;) {
        const txt = document.getElementById("magcal-result")?.textContent ?? "";
        if (pred(txt)) return true;
        if (Date.now() - t0 > ms) return false;
        await sleep(80);
      }
    };
    const hasStale = (txt) => txt.includes("基于旧模型");
    const clean = hasStale(document.getElementById("magcal-result")?.textContent ?? "");
    set("imu-cross-axis", 1); // 改器件参数 → 标定应当被标记为过期
    const stale = await waitText(hasStale);
    set("imu-cross-axis", 0);
    const cleared = await waitText((txt) => !hasStale(txt));
    return { clean, stale, cleared };
  });
  // 语义：clean = 拟合后**没有**过期提示；stale = 改参数后**出现**提示；cleared = 改回后提示**消失**
  check(
    "校准器件指纹：拟合后改交叉轴 → 面板提示「标定基于旧模型」，改回后提示消失",
    calibStale.clean === false && calibStale.stale === true && calibStale.cleared === true,
    `拟合后无提示=${calibStale.clean === false}、改交叉轴后出现提示=${calibStale.stale}、改回后提示消失=${calibStale.cleared}`,
  );

  // 校准历史：两次拟合都留档、可恢复到上一版；后段留出读数出现在结果块里
  const calHistory = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitText = async (pred, ms = 3000) => {
      const t0 = Date.now();
      for (;;) {
        const txt = document.getElementById("magcal-result")?.textContent ?? "";
        if (pred(txt)) return true;
        if (Date.now() - t0 > ms) return false;
        await sleep(80);
      }
    };
    document.getElementById("sec-magcal").classList.remove("collapsed");
    document.getElementById("magcal-synthetic").click();
    await sleep(400);
    const firstOffset = window.attitudeDemo.calibration().magFittedWith ? "ok" : "none";
    const rowsAfterFirst = document.querySelectorAll("#magcal-result .cal-hist-row").length;
    // 第二次拟合：历史里应出现两条，且当前那条没有「恢复」按钮
    document.getElementById("magcal-synthetic").click();
    await sleep(400);
    const rowsAfterSecond = document.querySelectorAll("#magcal-result .cal-hist-row").length;
    const restoreButtons = document.querySelectorAll('#magcal-result [data-cal-restore]').length;
    const hasLate = (document.getElementById("magcal-result")?.textContent ?? "").includes("后段留出");
    // 恢复第一条
    const btn = document.querySelector('#magcal-result [data-cal-restore]');
    if (btn) btn.click();
    const restored = await waitText((t) => /（当前）/.test(t));
    const rowsAfterRestore = document.querySelectorAll("#magcal-result .cal-hist-row").length;
    return { firstOffset, rowsAfterFirst, rowsAfterSecond, restoreButtons, hasLate, restored, rowsAfterRestore };
  });
  // 前面的用例已经拟合过多次，历史不是空的：只断言**相对**行为与上限（≤5 条）
  check(
    "校准历史：每次拟合留档（上限 5）、当前项无恢复按钮、可恢复到上一版，且给出后段留出",
    calHistory.firstOffset === "ok" &&
      calHistory.rowsAfterSecond === Math.min(5, calHistory.rowsAfterFirst + 1) &&
      calHistory.rowsAfterSecond <= 5 &&
      calHistory.restoreButtons === calHistory.rowsAfterSecond - 1 &&
      calHistory.hasLate &&
      calHistory.restored &&
      calHistory.rowsAfterRestore === calHistory.rowsAfterSecond,
    `历史条数 ${calHistory.rowsAfterFirst} → ${calHistory.rowsAfterSecond}（上限 5，可恢复按钮 ${calHistory.restoreButtons}）；` +
      `后段留出读数=${calHistory.hasLate}；恢复后回到「当前」=${calHistory.restored}`,
  );

  // 器件参数变化时，除面板小字外还要**主动提示一次**（否则用户根本不会点开校准面板）
  const staleToast = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
      el.dispatchEvent(new Event("change"));
    };
    set("imu-cross-axis", 0);
    document.getElementById("magcal-synthetic").click(); // 以当前参数重新拟合 → 清掉旧提示
    await sleep(400);
    const toastsBefore = document.querySelectorAll("#toast-layer .toast, #toast-layer .ov-chip").length;
    set("imu-cross-axis", 1); // 改参数 → 应主动提示
    await sleep(400);
    const texts = [...document.querySelectorAll("#toast-layer *")].map((e) => e.textContent ?? "").join(" | ");
    return { toastsBefore, warned: texts.includes("基于旧模型") };
  });
  check(
    "器件参数变化时主动提示标定失效（不只面板小字）",
    staleToast.warned,
    `改动交叉轴后出现「基于旧模型」提示=${staleToast.warned}`,
  );

  // 加计独立验证必须使用**当前器件参数**，而不是硬编码另一套模型：
  // 只对交叉轴注入拟合、再让当前交叉轴参与验证，旧实现会拿无关矩阵伪装成"校准有效"。
  const accelCurrentDevice = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event("input"));
      el.dispatchEvent(new Event("change"));
    };
    set("imu-cross-axis", 0.5); // UI 显示百分比 → 实际 k=0.005
    set("imu-accel-nonlin", 0);
    set("imu-accel-noise", 0);
    const g = 9.80665;
    const faces = [
      ["+x", [g, 0, 0]], ["-x", [-g, 0, 0]],
      ["+y", [0, g, 0]], ["-y", [0, -g, 0]],
      ["+z", [0, 0, g]], ["-z", [0, 0, -g]],
    ];
    const fit = window.attitudeDemo.accelcal.inject(
      faces.map(([face, raw]) => ({
        face,
        raw: [0, 1, 2].map((axis) => {
          const other = [0, 1, 2].filter((i) => i !== axis);
          return raw[axis] + 0.005 * (raw[other[0]] + raw[other[1]]);
        }),
      })),
    );
    document.getElementById("accelcal-verify").click();
    await sleep(250);
    const text = document.getElementById("accelcal-result").textContent;
    const match = /模长偏离 g 平均 ([\d.]+) → ([\d.]+)/.exec(text);
    const debug = window.attitudeDemo.accelcal.verifyDebug();
    return {
      fit,
      before: match ? Number(match[1]) : NaN,
      after: match ? Number(match[2]) : NaN,
      text,
      debug,
    };
  });
  check(
    "加计独立验证按当前器件模型评分：当前参数有效、拟合与验证不同模型不能伪装",
    accelCurrentDevice.fit.ok &&
      Number.isFinite(accelCurrentDevice.before) && Number.isFinite(accelCurrentDevice.after) &&
      accelCurrentDevice.before > 0.0001 && accelCurrentDevice.after < accelCurrentDevice.before * 0.5,
    `模长偏离 ${accelCurrentDevice.before.toFixed(4)} → ${accelCurrentDevice.after.toFixed(4)} m/s²；` +
      `拟合=${JSON.stringify(accelCurrentDevice.fit)} 验证模型=${JSON.stringify(accelCurrentDevice.debug)}`,
  );

  // 配置档案：完整磁椭球 + 六面加计校准 → 导出 → 清空 → 导入 → 校准状态与模型必须还原；
  // 并验证**失败导入是原子的**（现场逐项不变）与 ratio=null 的合法档案可导入可渲染。
  const archiveRoundTrip = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pauseBtn = document.getElementById("btn-pause");
    const isPaused = () => pauseBtn.textContent === "继续";
    // ① 先制造「值得丢掉的现场」：跑一段让曲线/记录有数据、拟合一次让校准历史非空、打开 A/B
    if (isPaused()) pauseBtn.click();
    for (let i = 0; i < 40 && window.attitudeDemo.sizes().logRows < 4; i++) await sleep(50);
    document.getElementById("magcal-synthetic").click();
    await sleep(80);
    const ab = document.getElementById("ab-toggle");
    if (!ab.checked) { ab.checked = true; ab.dispatchEvent(new Event("change")); }
    // ② 冻结时钟：失败导入前后才能逐项比较（仿真自己推进会让 simTime/曲线一起变）
    if (!isPaused()) pauseBtn.click();
    for (let i = 0; i < 20 && !isPaused(); i++) await sleep(25);
    await sleep(150);
    const site = () => window.attitudeDemo.experiment.site();
    const before = window.attitudeDemo.calibration();
    const siteBefore = site();
    const cfgBefore = window.attitudeDemo.experiment.config(6);
    const archive = window.attitudeDemo.experiment.archive();
    // 负面对照：解析能过、但界面无法表达/会夹值的档案必须拒绝，而且不得改动当前**现场**
    const badSpeed = JSON.parse(JSON.stringify(archive));
    badSpeed.config.solveRateHz = 333;
    const badSpeedRes = window.attitudeDemo.experiment.importArchive(badSpeed);
    const afterBadSpeed = site();
    const badSlider = JSON.parse(JSON.stringify(archive));
    badSlider.config.imu.gyroBiasDps = 999999; // 滑块上限 5 → 会被静默夹值
    const badSliderRes = window.attitudeDemo.experiment.importArchive(badSlider);
    const afterBadSlider = site();
    const fixedAxis = JSON.parse(JSON.stringify(archive));
    fixedAxis.config.initialAttitude = { kind: "fixed-axis", axis: [0, 0, 1], angleDeg: 30 };
    const fixedAxisRes = window.attitudeDemo.experiment.importArchive(fixedAxis);
    const afterFixedAxis = site();
    // ③ 合法档案：先人为破坏状态（切回对角模型并清空两个校准）
    const sel = document.getElementById("magcal-model");
    sel.value = "diag";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("magcal-clear").click();
    document.getElementById("accelcal-clear").click();
    await sleep(60);
    const cleared = window.attitudeDemo.calibration();
    const res = window.attitudeDemo.experiment.importArchive(archive);
    await sleep(60);
    const after = window.attitudeDemo.calibration();
    const afterImportSite = site();
    const cfgAfter = window.attitudeDemo.experiment.config(6);
    // ④ 合法但 ratio=null 的档案（训练残差为 0 → NaN → JSON null）必须可导入且可渲染
    const nullRatio = JSON.parse(JSON.stringify(archive));
    const ncal = nullRatio.config.magCalibration;
    let nullRatioRes = { ok: false, error: "档案里没有带验证块的磁校准" };
    let nullRatioText = "";
    if (ncal && ncal.validation) {
      ncal.validation.ratio = null;
      if (ncal.validation.late) ncal.validation.late.ratio = null;
      nullRatioRes = window.attitudeDemo.experiment.importArchive(nullRatio);
      await sleep(80);
      nullRatioText = document.getElementById("magcal-result")?.textContent ?? "";
    }
    // ⑤ 界面**没有独立控件**的两个字段必须真的写进活状态（复核 P2-1：
    //    稳态窗口改 RMSE 口径、粗对准会重置姿态，不能当展示字段丢掉）
    const hidden = JSON.parse(JSON.stringify(archive));
    hidden.config.steadyFromSec = 4;
    hidden.config.autoCoarseAlign = false;
    const hiddenRes = window.attitudeDemo.experiment.importArchive(hidden);
    await sleep(60);
    const hiddenSite = site();
    // ⑥ 省略**可选字段**的档案也必须能导入：schema 允许缺 steadyFromSec / autoCoarseAlign /
    //    manualTargetDeg / ab / magTargetUts，缺失时按文档默认值恢复，不能因为「少写一个键」被拒。
    const optional = JSON.parse(JSON.stringify(archive));
    for (const k of ["steadyFromSec", "autoCoarseAlign", "manualTargetDeg", "ab", "magTargetUts"]) delete optional.config[k];
    const optionalRes = window.attitudeDemo.experiment.importArchive(optional);
    await sleep(60);
    const optionalCfg = window.attitudeDemo.experiment.config(6);
    // ⑦ 恢复原始档案，后面的用例按原假设运行
    const restoreRes = window.attitudeDemo.experiment.importArchive(archive);
    await sleep(80);
    if (isPaused()) pauseBtn.click(); // 恢复运行（后续用例依赖时钟继续推进）
    return {
      before, cleared, after, res, restoreRes,
      badSpeedRes, badSliderRes, fixedAxisRes,
      siteBefore, afterBadSpeed, afterBadSlider, afterFixedAxis, hiddenSite, hiddenRes,
      optionalRes, optionalCfg, afterImportSite,
      negSiteUnchanged:
        JSON.stringify(afterBadSpeed) === JSON.stringify(siteBefore) &&
        JSON.stringify(afterBadSlider) === JSON.stringify(siteBefore) &&
        JSON.stringify(afterFixedAxis) === JSON.stringify(siteBefore),
      modelOg: document.getElementById("magcal-model").value,
      magChecked: document.getElementById("magcal-apply").checked,
      accelChecked: document.getElementById("accelcal-apply").checked,
      nullRatioRes, nullRatioText,
      cfgBefore, cfgAfter,
    };
  });
  const sameOffset =
    JSON.stringify(archiveRoundTrip.cfgBefore.magCalibration?.offset) ===
    JSON.stringify(archiveRoundTrip.cfgAfter.magCalibration?.offset);
  // 完整配置往返：除「本次已跑时长」外，导入后必须逐字段一致（含 steadyFromSec/autoCoarseAlign）
  const stripCfg = (c) => {
    const { durationSec, ...rest } = c;
    return JSON.stringify(rest);
  };
  const sameConfig = stripCfg(archiveRoundTrip.cfgBefore) === stripCfg(archiveRoundTrip.cfgAfter);
  const site = archiveRoundTrip.siteBefore;
  check(
    "配置档案：失败导入现场逐项不变；完整配置往返一致；ratio=null 可导入可渲染；无控件/可选字段真恢复",
    archiveRoundTrip.before.magApplied && archiveRoundTrip.before.accelApplied &&
      !archiveRoundTrip.cleared.hasMag && !archiveRoundTrip.cleared.hasAccel &&
      archiveRoundTrip.res.ok && archiveRoundTrip.after.magApplied && archiveRoundTrip.after.accelApplied &&
      archiveRoundTrip.modelOg === "full" && archiveRoundTrip.magChecked && archiveRoundTrip.accelChecked &&
      sameOffset && sameConfig && archiveRoundTrip.negSiteUnchanged &&
      site.logRows > 0 && site.rawRows > 0 && site.magHistory > 0 && site.abOn &&
      archiveRoundTrip.badSpeedRes.ok === false && /solveRateHz/.test(archiveRoundTrip.badSpeedRes.error ?? "") &&
      archiveRoundTrip.badSliderRes.ok === false && /gyroBiasDps/.test(archiveRoundTrip.badSliderRes.error ?? "") &&
      archiveRoundTrip.fixedAxisRes.ok === false && /initialAttitude/.test(archiveRoundTrip.fixedAxisRes.error ?? "") &&
      archiveRoundTrip.nullRatioRes.ok === true &&
      archiveRoundTrip.nullRatioText.includes("不适用") && !/NaN/.test(archiveRoundTrip.nullRatioText) &&
      archiveRoundTrip.hiddenRes.ok === true &&
      archiveRoundTrip.hiddenSite.steadyFromSec === 4 &&
      archiveRoundTrip.hiddenSite.autoCoarseAlign === false &&
      archiveRoundTrip.optionalRes.ok === true &&
      archiveRoundTrip.optionalCfg.steadyFromSec === null &&
      archiveRoundTrip.optionalCfg.autoCoarseAlign === true &&
      archiveRoundTrip.optionalCfg.ab?.mode === "same-start" &&
      // 成功导入替换了 A 组参数：旧 B 组不可比，必须关闭并说明（与实验基线同一约定）
      archiveRoundTrip.afterImportSite.abOn === false &&
      (archiveRoundTrip.res.warnings ?? []).some((w) => w.includes("A/B")),
    `校准前=${JSON.stringify(archiveRoundTrip.before)}；清空后 hasMag=${archiveRoundTrip.cleared.hasMag}；` +
      `导入后=${JSON.stringify(archiveRoundTrip.after)}、model=${archiveRoundTrip.modelOg}、` +
      `checkbox=${archiveRoundTrip.magChecked}/${archiveRoundTrip.accelChecked}、offset 一致=${sameOffset}、` +
      `整份配置一致=${sameConfig}；现场=${JSON.stringify(site)}、失败导入后现场不变=${archiveRoundTrip.negSiteUnchanged}；` +
      `负例：333Hz=${JSON.stringify(archiveRoundTrip.badSpeedRes)}、越界滑块=${JSON.stringify(archiveRoundTrip.badSliderRes)}、` +
      `固定轴=${JSON.stringify(archiveRoundTrip.fixedAxisRes)}；ratio=null 导入=${JSON.stringify(archiveRoundTrip.nullRatioRes)}、` +
      `读数「${archiveRoundTrip.nullRatioText.replace(/\s+/g, " ").slice(0, 90)}」；` +
      `无控件字段导入=${JSON.stringify(archiveRoundTrip.hiddenRes)} → 现场 steadyFromSec=${archiveRoundTrip.hiddenSite.steadyFromSec}、` +
      `autoCoarseAlign=${archiveRoundTrip.hiddenSite.autoCoarseAlign}；` +
      `省略可选字段导入=${JSON.stringify(archiveRoundTrip.optionalRes)} → steadyFromSec=${archiveRoundTrip.optionalCfg.steadyFromSec}、` +
      `autoCoarseAlign=${archiveRoundTrip.optionalCfg.autoCoarseAlign}、ab=${archiveRoundTrip.optionalCfg.ab?.mode}；` +
      `成功后 A/B 关闭=${archiveRoundTrip.afterImportSite.abOn === false}（提示 ${JSON.stringify(archiveRoundTrip.res.warnings ?? [])}）`,
  );

  // 档案事务的**完整现场**零副作用（P0）：三类失败档案（越界 / 场景联动 / 渲染异常）
  // 导入前后必须逐项深等价——包括旧 site() 快照没覆盖的那些：
  //   loop 勾选与禁用、IMU 预设与说明文字、暂停态、提示计数、校准面板文字、曲线内容摘要、
  //   估计器内部状态、A/B 克隆与冻结参数、加计挂起/窗口、磁采集状态。
  // 为什么必须有这条：旧实现靠「真的把配置写进控件再读回」来探测可表达性，而写控件会触发
  //   事件副作用——场景切到运动学一致剧本时 syncLoopAvailability() 会把闭环开关取消勾选，
  //   回滚只把场景写回去，loop.checked 就此永久丢失（复核 P0 反例）。
  const archiveAtomic = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pauseBtn = document.getElementById("btn-pause");
    const isPaused = () => pauseBtn.textContent === "继续";
    const site = () => window.attitudeDemo.experiment.site();
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el.value !== value) { el.value = value; el.dispatchEvent(new Event("change")); }
    };
    if (isPaused()) pauseBtn.click();
    // ① 制造"值得丢掉的现场"。顺序注意：开 A/B（same-start 会复位本轮）与切场景都会
    //    重置现场，所以**先做会复位的动作，再等记录长出来**，否则会把清零后的空现场当成现场。
    const ab = document.getElementById("ab-toggle");
    if (!ab.checked) { ab.checked = true; ab.dispatchEvent(new Event("change")); }
    set("scenario-select", "hover");
    await sleep(40);
    let waits = 0;
    for (; waits < 80 && window.attitudeDemo.sizes().logRows < 4; waits++) await sleep(50);
    document.getElementById("magcal-synthetic").click();
    await sleep(80);
    const loop = document.getElementById("loop-toggle");
    if (!loop.checked) { loop.checked = true; loop.dispatchEvent(new Event("change")); }
    // ② 冻结时钟：失败导入前后才能逐项比较
    if (!isPaused()) pauseBtn.click();
    for (let i = 0; i < 20 && !isPaused(); i++) await sleep(25);
    await sleep(150);
    const before = site();
    const archive = window.attitudeDemo.experiment.archive();
    // ③ 越界 + 场景联动：切到运动学一致剧本（会禁用并清空闭环开关）+ 一个最终被拒的越界值
    const badRange = JSON.parse(JSON.stringify(archive));
    badRange.config.scenario = "coordinatedTurn";
    badRange.config.imu.gyroBiasDps = 999999;
    const badRangeRes = window.attitudeDemo.experiment.importArchive(badRange);
    const afterBadRange = site();
    // ④ 界面无法表达（全局开关广播）：数值本身合法、解析也过，但 comp/mahony 的磁开关分叉
    const badCast = JSON.parse(JSON.stringify(archive));
    badCast.config.estimators.mahony.magEnabled = !badCast.config.estimators.comp.magEnabled;
    const badCastRes = window.attitudeDemo.experiment.importArchive(badCast);
    const afterBadCast = site();
    // ⑤ 渲染异常：run 元数据坏了（旧实现会在配置**已经应用之后**才抛错——界面提示失败、状态却已变），
    //    必须整份拒绝，且提示文字里不得出现 NaN/undefined
    const badRun = JSON.parse(JSON.stringify(archive));
    badRun.run.metrics = [{ id: "mahony", n: 5, mean: null, rmse: null, max: null, convergedAt: null }];
    const badRunRes = window.attitudeDemo.experiment.importArchive(badRun);
    const afterBadRun = site();
    const errs = [badRangeRes, badCastRes, badRunRes].map((r) => r.error ?? "").join(" | ");
    // ⑥ 复原：场景与闭环回到测试前状态，时钟继续
    if (isPaused()) pauseBtn.click();
    return {
      before, afterBadRange, afterBadCast, afterBadRun,
      ok: [badRangeRes.ok, badCastRes.ok, badRunRes.ok],
      errs,
      same:
        JSON.stringify(afterBadRange) === JSON.stringify(before) &&
        JSON.stringify(afterBadCast) === JSON.stringify(before) &&
        JSON.stringify(afterBadRun) === JSON.stringify(before),
      rich: before.loopOn === true && before.loopDisabled === false && before.abOn === true &&
        before.magHistory > 0 && before.logRows > 0 && before.chartSizes[0].count > 0 && before.simTime > 0,
      diag: { waits, logRows: before.logRows, chart: before.chartSizes[0].count, simTime: before.simTime, resets: window.attitudeDemo.plumbing().simResets },
    };
  });
  check(
    "档案事务零副作用：越界/场景联动/渲染异常三类失败导入后**完整现场**深等价（含 loop/preset/提示/曲线/估计器/A-B）",
    archiveAtomic.same && archiveAtomic.rich &&
      archiveAtomic.ok.every((v) => v === false) &&
      /gyroBiasDps/.test(archiveAtomic.errs) &&
      /mahony\.magEnabled/.test(archiveAtomic.errs) &&
      /run\.metrics/.test(archiveAtomic.errs) &&
      !/NaN|undefined/.test(archiveAtomic.errs),
    `失败导入后现场不变=${archiveAtomic.same}（现场确有内容=${archiveAtomic.rich}：诊断=${JSON.stringify(archiveAtomic.diag)}、loop=${archiveAtomic.before.loopOn}/${archiveAtomic.before.loopDisabled}、` +
      `A/B=${archiveAtomic.before.abOn}、曲线点=${archiveAtomic.before.chartSizes?.[0]?.count}、校准历史=${archiveAtomic.before.magHistory}）；` +
      `三类都拒绝=${JSON.stringify(archiveAtomic.ok)}；提示=${archiveAtomic.errs.slice(0, 220)}`,
  );

  // 档案规范形（P1）：省略可选字段的合法档案与完整档案必须收敛到**同一份配置**，
  // 并且导出 → 导入 → 再导出逐字节一致（旧实现里「少写一个键」会解析成另一份配置）。
  const archiveCanonical = await page.evaluate(() => {
    const exp = window.attitudeDemo.experiment;
    const archive = exp.archive();
    const minimal = JSON.parse(JSON.stringify(archive));
    for (const k of ["magTargetUts", "autoCoarseAlign", "steadyFromSec", "manualTargetDeg", "ab"]) delete minimal.config[k];
    const strip = (c) => { const { durationSec, ...rest } = c; return JSON.stringify(rest); };
    const okMinimal = exp.importArchive(minimal);
    const cfgMinimal = strip(exp.config(6));
    const okFull = exp.importArchive(archive);
    const cfgFull = strip(exp.config(6));
    // 再导出必须与首次导出逐字节一致（规范形幂等；durationSec 是"本次已跑时长"，不参与）
    const reexported = JSON.stringify({ ...exp.archive().config, durationSec: archive.config.durationSec }) ===
      JSON.stringify(archive.config);
    return { okMinimal, okFull, same: cfgMinimal === cfgFull, reexported };
  });
  check(
    "档案规范形：省略可选字段导入后与完整档案逐字段一致，且导出→导入→再导出逐字节稳定",
    archiveCanonical.okMinimal.ok && archiveCanonical.okFull.ok && archiveCanonical.same && archiveCanonical.reexported,
    `省略可选字段导入=${JSON.stringify(archiveCanonical.okMinimal)}、完整导入=${JSON.stringify(archiveCanonical.okFull)}、` +
      `两份配置逐字段一致=${archiveCanonical.same}、再导出逐字节一致=${archiveCanonical.reexported}`,
  );

  // 档案事务的**异常安全**（SW-03）：真正会失败的渲染步骤必须发生在写状态之前。
  //   ① 把 Element.prototype.innerHTML 的 setter 换成抛异常：面板渲染计划在 prepare 阶段
  //      解析 HTML，于是导入必须整体失败，且现场（含闭环勾选）一个字节都没动。
  //   ② 自定义步距（把零偏滑块的步距改成 2，网格只剩 0/2/4）+ 运动学剧本联动：
  //      网格外的取值必须被离线预检拒绝，而不是"先写场景（会清掉闭环勾选）再失败回滚"。
  const archiveCommitSafety = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pauseBtn = document.getElementById("btn-pause");
    const isPaused = () => pauseBtn.textContent === "继续";
    const site = () => window.attitudeDemo.experiment.site();
    const set = (id, value) => { const el = document.getElementById(id); if (el.value !== value) { el.value = value; el.dispatchEvent(new Event("change")); } };
    if (isPaused()) pauseBtn.click();
    set("scenario-select", "hover");
    await sleep(40);
    for (let i = 0; i < 80 && window.attitudeDemo.sizes().logRows < 4; i++) await sleep(50);
    const loop = document.getElementById("loop-toggle");
    if (!loop.checked) { loop.checked = true; loop.dispatchEvent(new Event("change")); }
    if (!isPaused()) pauseBtn.click();
    for (let i = 0; i < 20 && !isPaused(); i++) await sleep(25);
    await sleep(120);
    const before = site();
    const archive = window.attitudeDemo.experiment.archive();

    // ① 渲染路径注入失败
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    let renderRes = { ok: true, error: "（未执行）" };
    try {
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        get() { return ""; },
        set() { throw new Error("injected render failure"); },
      });
      const r = window.attitudeDemo.experiment.importArchive(archive);
      renderRes = { ok: r.ok, error: r.error ?? "" };
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, "innerHTML", descriptor);
    }
    const afterRender = site();

    // ② 自定义步距 + 场景联动
    const stepBox = document.querySelector('[data-step="imu-gyro-bias"]');
    const biasSlider = document.getElementById("imu-gyro-bias");
    const origStep = biasSlider.step;
    if (stepBox) { stepBox.value = "2"; stepBox.dispatchEvent(new Event("change")); }
    const badStep = JSON.parse(JSON.stringify(archive));
    badStep.config.scenario = "coordinatedTurn";
    badStep.config.imu.gyroBiasDps = 5; // 0/2/4 网格之外
    const badRes = window.attitudeDemo.experiment.importArchive(badStep);
    const afterStep = site();
    if (stepBox) { stepBox.value = origStep; stepBox.dispatchEvent(new Event("change")); }
    if (isPaused()) pauseBtn.click();
    return {
      renderRes, badRes,
      sameAfterRender: JSON.stringify(afterRender) === JSON.stringify(before),
      sameAfterStep: JSON.stringify(afterStep) === JSON.stringify(before),
      loopKept: afterStep.loopOn === true,
      rich: before.loopOn === true && before.logRows > 0,
    };
  });
  check(
    "档案事务异常安全（SW-03）：渲染失败不写状态、网格外取值被预检拒绝，现场与闭环勾选不变",
    archiveCommitSafety.renderRes.ok === false &&
      /面板渲染失败/.test(archiveCommitSafety.renderRes.error) &&
      archiveCommitSafety.badRes.ok === false &&
      /gyroBiasDps/.test(archiveCommitSafety.badRes.error) &&
      archiveCommitSafety.sameAfterRender &&
      archiveCommitSafety.sameAfterStep &&
      archiveCommitSafety.loopKept &&
      archiveCommitSafety.rich,
    `注入渲染失败 → ok=${archiveCommitSafety.renderRes.ok}、提示「${archiveCommitSafety.renderRes.error.slice(0, 40)}」、现场不变=${archiveCommitSafety.sameAfterRender}；` +
      `自定义步距(2)+运动学剧本 → ok=${archiveCommitSafety.badRes.ok}、提示「${archiveCommitSafety.badRes.error.slice(0, 60)}」、` +
      `现场不变=${archiveCommitSafety.sameAfterStep}、闭环勾选保留=${archiveCommitSafety.loopKept}`,
  );

  // 导出 IMU 列语义：默认 raw 标注，勾选「校准后」写 calibrated（回放自动关闭校准）
  const imuMeta = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 前面的用例可能把仿真留在暂停态（单步/游标用例会暂停）——没有记录行时导出弹窗会直接早退，
    // 于是"导出没发生"会被误读成"导出功能坏了"。这里先确保在跑、且有记录行。
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    for (let i = 0; i < 60 && window.attitudeDemo.sizes().logRows < 3; i++) await sleep(50);
    const grab = async (calibrated) => {
      let text = "";
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        blob.text().then((t) => (text = t));
        return "blob:imu";
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById("btn-export").click();
      await sleep(120);
      document.querySelector('input[name="export-scope"][value="angles"]').checked = true;
      document.getElementById("export-imu").checked = true;
      document.getElementById("export-imu-calibrated").checked = calibrated;
      document.getElementById("export-confirm").click();
      // blob.text() 是异步的：轮询等它落地，别用固定 sleep 去赌（校准列会让导出更慢）
      for (let i = 0; i < 40 && !text; i++) await sleep(50);
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return text;
    };
    const raw = await grab(false);
    const cal = await grab(true);
    const rowOf = (t) => t.split("\n").find((l) => /^\d/.test(l))?.split(",") ?? [];
    const magCol = (t) => {
      const hdr = t.split("\n").find((l) => l.startsWith("t_s,"))?.split(",") ?? [];
      const i = hdr.indexOf("mag_x_ut");
      return i < 0 ? NaN : Number(rowOf(t)[i]);
    };
    // 复位导出选项，免得后面的列数断言被这两个勾选污染
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      void blob;
      return "blob:reset";
    };
    const origClick2 = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("btn-export").click();
    await sleep(100);
    document.querySelector('input[name="export-scope"][value="angles"]').checked = true;
    document.getElementById("export-imu").checked = false;
    document.getElementById("export-imu-calibrated").checked = false;
    document.getElementById("export-confirm").click();
    await sleep(120);
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick2;
    return {
      rawMarker: raw.includes("# imu=raw"),
      calMarker: cal.includes("# imu=calibrated"),
      magRaw: magCol(raw),
      magCal: magCol(cal),
      columnsDiffer: magCol(raw) !== magCol(cal),
      countText: document.getElementById("export-count").textContent,
    };
  });
  check(
    "导出 IMU 语义：默认标注 imu=raw，可选输出校准后列并标注 imu=calibrated",
    imuMeta.rawMarker && imuMeta.calMarker && imuMeta.columnsDiffer && Number.isFinite(imuMeta.magRaw),
    `raw 标注=${imuMeta.rawMarker}、calibrated 标注=${imuMeta.calMarker}；` +
      `mag_x 原始=${imuMeta.magRaw}、校准后=${imuMeta.magCal}；列数提示「${imuMeta.countText.slice(0, 28)}」`,
  );

  // 导出**不可变**：改过当前标定之后，同一批历史记录的导出必须逐字节不变（复核 P1-F）。
  // 旧实现按「导出时的当前标定」重算校准列，实测同一行磁值 30 → 25。
  const exportImmutable = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    for (let i = 0; i < 60 && window.attitudeDemo.sizes().logRows < 5; i++) await sleep(50);
    const grab = async () => {
      let text = "";
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        blob.text().then((t) => (text = t));
        return "blob:imm";
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById("btn-export").click();
      await sleep(120);
      document.querySelector('input[name="export-scope"][value="angles"]').checked = true;
      document.getElementById("export-imu").checked = true;
      document.getElementById("export-imu-calibrated").checked = true;
      document.getElementById("export-confirm").click();
      for (let i = 0; i < 40 && !text; i++) await sleep(50);
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return text;
    };
    const rowsOnly = (t) => t.split("\n").filter((l) => /^\d/.test(l));
    // 先确保处在「模拟 + 播放中」的干净状态：前面的用例可能留在暂停态或回放态
    if (!document.getElementById("btn-replay-stop").classList.contains("hidden")) {
      document.getElementById("btn-replay-stop").click();
      await sleep(300);
    }
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    // 铺一个已知的、非平凡的磁标定（offset=[5,0,0]，已应用），再让它重新记录：
    // 这样 before/after 的校准列本来就不同，才谈得上「改标定后必须不变」。
    // 注意必须构造**真正的对角模型**：带上 matrix 的 "diag" 会被解析器拒绝
    // （应用路径优先用 matrix，模型标签与实际不一致——那种档案本来就不该存在）。
    const arch = JSON.parse(JSON.stringify(window.attitudeDemo.experiment.archive()));
    arch.config = {
      ...arch.config,
      magModel: "diag",
      magCalibration: {
        offset: [5, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 120, kind: "diag",
      },
      // magTargetUts 在应用里由「当前标定的 field」派生，档案里两者必须自洽（否则读回比较会拒绝）。
      magTargetUts: 50,
      magCalibrationApplied: true,
    };
    const seedImp = window.attitudeDemo.experiment.importArchive(arch);
    await sleep(200);
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    for (let i = 0; i < 100 && window.attitudeDemo.sizes().logRows < 8; i++) await sleep(50);
    const logRowsBefore = window.attitudeDemo.sizes().logRows;
    // 冻结记录：暂停之后行数不会再变，两组导出才逐行可比
    if (document.getElementById("btn-pause").textContent === "暂停") document.getElementById("btn-pause").click();
    await sleep(150);
    const before = await grab();
    const rowsBefore = rowsOnly(before);
    // 改「当前标定」：摘掉已应用的磁标定（不重置仿真、不影响已有记录）
    const applyBox = document.getElementById("magcal-apply");
    applyBox.checked = false;
    applyBox.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);
    const calAfter = window.attitudeDemo.calibration();
    const after = await grab();
    const rowsAfter = rowsOnly(after);
    const common = Math.min(rowsBefore.length, rowsAfter.length);
    const sameBytes = common >= 5 && rowsBefore.slice(0, common).join("\n") === rowsAfter.slice(0, common).join("\n");
    // 复位导出选项
    const orig = URL.createObjectURL;
    URL.createObjectURL = () => "blob:reset2";
    const origClick2 = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("btn-export").click();
    await sleep(100);
    document.getElementById("export-imu").checked = false;
    document.getElementById("export-imu-calibrated").checked = false;
    document.getElementById("export-confirm").click();
    await sleep(120);
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick2;
    // 恢复运行：后面的用例（全帧源导出）需要真的有帧进来
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    return {
      beforeMarker: before.includes("# imu=calibrated"),
      sameBytes,
      rows: rowsBefore.length,
      common,
      offsetNow: calAfter.magOffset,
      hasMag: calAfter.hasMag,
      appliedNow: calAfter.magApplied,
      seedOk: seedImp.ok,
      importError: seedImp.error ?? "",
      logRowsBefore,
      logRowsAfter: window.attitudeDemo.sizes().logRows,
      beforeLen: before.length,
    };
  });
  check(
    "导出不可变：改过当前标定后，历史记录的校准列导出逐字节不变",
    exportImmutable.seedOk === true &&
      exportImmutable.hasMag === true &&
      exportImmutable.appliedNow === false && // 当前标定确实被摘掉了（否则测试是空转）
      exportImmutable.beforeMarker === true &&
      exportImmutable.sameBytes === true &&
      exportImmutable.common >= 5,
    `共同前缀 ${exportImmutable.common}/${exportImmutable.rows} 行；先铺标定=${exportImmutable.seedOk}` +
      `${exportImmutable.importError ? "（" + exportImmutable.importError + "）" : ""}；` +
      `现在 hasMag=${exportImmutable.hasMag} applied=${exportImmutable.appliedNow}（offset=${JSON.stringify(exportImmutable.offsetNow)}）；` +
      `改标定后导出逐字节相同=${exportImmutable.sameBytes}；标注 calibrated=${exportImmutable.beforeMarker}；` +
      `记录行 ${exportImmutable.logRowsBefore}→${exportImmutable.logRowsAfter}、CSV 长度 ${exportImmutable.beforeLen}`,
  );

  // 校准后日志的全帧源导出必须标 calibrated，而不是无条件写 raw（复核 P1-F 的第二半：
  // 旧实现强写 # imu=raw，回放时二次校准，实测磁值 25 → 20 → 20）。
  const rawMarker = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    const NL = String.fromCharCode(10);
    const head = "t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut";
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(`${(i * 0.01).toFixed(3)},1,0,0,0,0,9.80665,30,0,40`);
    const grabRaw = async () => {
      let text = "";
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        blob.text().then((t) => (text = t));
        return "blob:raw";
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById("btn-export").click();
      await sleep(120);
      document.querySelector('input[name="export-scope"][value="raw"]').checked = true;
      document.getElementById("export-confirm").click();
      for (let i = 0; i < 40 && !text; i++) await sleep(50);
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return text;
    };
    // 状态等待：等「本段记录的语义」真的切到目标值，而不是赌 600 ms 墙钟
    // （慢机器上 600 ms 可能一帧都没进来，于是读到的是上一段的语义 → 偶发误判）
    const waitSemantic = async (want) => {
      const deadline = performance.now() + 15000;
      for (;;) {
        const r = window.attitudeDemo.raw();
        if (r.rows > 0 && r.calibrated === want) return true;
        if (performance.now() > deadline) return false;
        await sleep(100);
      }
    };
    // ① 原始日志回放：读数是原始的 → 标 raw
    const box = document.getElementById("raw-record-toggle");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    window.attitudeDemo.replay.import([head, ...rows].join(NL), "rawsrc.csv");
    const rawReady = await waitSemantic(false);
    const rawCase = await grabRaw();
    window.attitudeDemo.replay.stop();
    await sleep(400);
    // ② 声明 calibrated 的日志回放：读数已是校准后的 → 必须标 calibrated
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    window.attitudeDemo.replay.import(["# imu=calibrated", head, ...rows].join(NL), "calsrc.csv");
    const calReady = await waitSemantic(true);
    const calCase = await grabRaw();
    window.attitudeDemo.replay.stop();
    await sleep(200);
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      rawReady, calReady,
      rawMarker: rawCase.includes("# imu=raw"),
      calMarker: calCase.includes("# imu=calibrated"),
      rawNotCal: !rawCase.includes("# imu=calibrated"),
      calNotRaw: !calCase.includes("# imu=raw"),
    };
  });
  check(
    "全帧源导出语义：原始来源标 raw、校准来源标 calibrated（不再无条件写 raw）",
    rawMarker.rawMarker && rawMarker.calMarker && rawMarker.rawNotCal && rawMarker.calNotRaw &&
      rawMarker.rawReady && rawMarker.calReady,
    `原始日志回放 → # imu=raw=${rawMarker.rawMarker}（语义就绪=${rawMarker.rawReady}）；` +
      `校准日志回放 → # imu=calibrated=${rawMarker.calMarker}（语义就绪=${rawMarker.calReady}）`,
  );

  // 回放语义：带 # imu=calibrated 的日志自动关闭校准输入；未声明则默认补校准
  const replayCal = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const NL = String.fromCharCode(10);
    const head = "t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut";
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(`${(i * 0.01).toFixed(3)},1,0,0,0,0,9.80665,30,0,40`);
    window.attitudeDemo.replay.import([head, ...rows].join(NL), "plain.csv");
    await sleep(200);
    const plain = window.attitudeDemo.replay.info;
    const boxPlain = document.getElementById("replay-apply-cal").checked;
    window.attitudeDemo.replay.stop();
    await sleep(80);
    window.attitudeDemo.replay.import(["# imu=calibrated", head, ...rows].join(NL), "cal.csv");
    await sleep(200);
    const cal = window.attitudeDemo.replay.info;
    const boxCal = document.getElementById("replay-apply-cal").checked;
    window.attitudeDemo.replay.stop();
    await sleep(80);
    return { plain: { ...plain }, boxPlain, cal: { ...cal }, boxCal };
  });
  check(
    "回放校准语义：未声明→默认补校准；声明 calibrated→自动关闭（禁止二次校准）",
    replayCal.plain.applyCalibration === true && replayCal.boxPlain === true &&
      replayCal.cal.imuCalibrated === true && replayCal.cal.applyCalibration === false && replayCal.boxCal === false &&
      replayCal.plain.imuCalibrated === null,
    `未声明：imuCalibrated=${replayCal.plain.imuCalibrated}、applyCalibration=${replayCal.plain.applyCalibration}（勾选框 ${replayCal.boxPlain}）；` +
      `声明 calibrated：imuCalibrated=${replayCal.cal.imuCalibrated}、applyCalibration=${replayCal.cal.applyCalibration}（勾选框 ${replayCal.boxCal}）`,
  );

  // 运动学一致剧本：协调转弯产生真实平动位置；闭环开关应被禁用并解释
  const kinematic = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
    const sel = document.getElementById("scenario-select");
    sel.value = "coordinatedTurn";
    sel.dispatchEvent(new Event("change"));
    // 状态等待：等真值位置真的超过阈值，而不是赌 1.8 s 的墙钟（软件渲染下会偶发 0.38 m）
    const t0 = performance.now();
    const deadline = t0 + 15000;
    let dist = 0;
    while (performance.now() < deadline) {
      const p = window.attitudeDemo.world.posNed;
      dist = Math.hypot(p[0], p[1]);
      if (dist > 1.2) break;
      await sleep(100);
    }
    const elapsed = (performance.now() - t0) / 1000;
    const loopDisabled = document.getElementById("loop-toggle").disabled;
    sel.value = "hover";
    sel.dispatchEvent(new Event("change"));
    await sleep(80);
    const loopEnabledAfter = !document.getElementById("loop-toggle").disabled;
    return { dist, elapsed, scenario: "coordinatedTurn", loopDisabled, loopEnabledAfter };
  });
  check(
    "运动学一致剧本：协调转弯产生真实平动轨迹；闭环开关被禁用并恢复",
    kinematic.dist > 1 && kinematic.loopDisabled && kinematic.loopEnabledAfter,
    `真值位置 ${kinematic.dist.toFixed(2)} m（等 ${kinematic.elapsed.toFixed(1)} s）；kinematic 下闭环禁用=${kinematic.loopDisabled}、切回悬停后恢复=${kinematic.loopEnabledAfter}`,
  );

  // 外部真值回放：truth_q* 日志应启用「真实姿态」来源，误差基准切到外部真值；
  // 同时验证**长间隔真值按子步插值**：10 s 空洞若提前用帧末真值，完美日志会算出几十度假误差。
  const truthReplay = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 关磁：只靠陀螺 + 加计，完美日志的误差应接近 0
    const mag = document.getElementById("mag-enable");
    if (mag.checked) { mag.checked = false; mag.dispatchEvent(new Event("change")); }
    const yawQ = (deg) => {
      const h = (deg * Math.PI) / 360;
      return [Math.cos(h), 0, 0, Math.sin(h)];
    };
    const lines = ["t_s,gx,gy,gz,ax,ay,az,truth_qw,truth_qx,truth_qy,truth_qz"];
    for (let i = 0; i < 19; i++) {
      const t = i * 0.01;
      lines.push(`${t.toFixed(2)},0,0,9,0,0,9.80665,${yawQ(9 * t).join(",")}`);
    }
    // 间隔 9.82 s 的末帧：真值 yaw=90°，与 9°/s 的陀螺完全一致
    lines.push(`10,0,0,9,0,0,9.80665,${yawQ(90).join(",")}`);
    const imported = window.attitudeDemo.replay.import(lines.join(String.fromCharCode(10)), "truth-gap.csv");
    const speed = document.getElementById("replay-speed");
    speed.value = "0";
    speed.dispatchEvent(new Event("change"));
    // 最快档：等回放真的消费完全部源帧（状态等待；固定 4 s 在慢渲染下会偶发未跑完）
    const replayDeadline = performance.now() + 25000;
    while (performance.now() < replayDeadline) {
      const ri = window.attitudeDemo.replay.info;
      if (ri.idx >= ri.frames) break;
      await sleep(50);
    }
    const truthOpt = document.querySelector('#source-select option[value="truth"]');
    const disabled = truthOpt.disabled;
    const src = document.getElementById("source-select");
    src.value = "truth";
    src.dispatchEvent(new Event("change"));
    // 等**统计表真的出现样本**，而不是固定 250 ms：浏览器刚被回收、页面重新编译着色器时，
    // 这 250 ms 可能一步都没推进，表格四列全是「—」——那是时序，不是产品缺陷。
    // 有界等待同时保留区分能力：若真的一直没有样本，这里会超时并把现场交回断言。
    const mahonyCells = () => {
      const row = [...document.querySelectorAll("#metrics-body tr")].find((tr) => tr.textContent.includes("Mahony"));
      const cells = row ? [...row.querySelectorAll("td")].map((td) => td.textContent.trim()) : [];
      return { cells, finite: cells.length > 2 && Number.isFinite(parseFloat(cells[2])) };
    };
    let st = mahonyCells();
    const metricsDeadline = performance.now() + 8000;
    while (!st.finite && performance.now() < metricsDeadline) { await sleep(50); st = mahonyCells(); }
    const chip = document.getElementById("readout-true")?.textContent ?? "";
    const legend0 = document.querySelector("#att-legend .legend-chip")?.textContent ?? "";
    const info = window.attitudeDemo.replay.info;
    const cells = st.cells;
    const mean = parseFloat(cells[2]);
    const playing = window.attitudeDemo.state.playing;
    const simTime = window.attitudeDemo.state.simTime;
    window.attitudeDemo.replay.stop();
    await sleep(120);
    return { disabled, chip, legend0, info, imported, mean, cells, playing, simTime };
  });
  check(
    "外部真值回放：基准切到外部真值，且长间隔按子步插值（完美日志平均误差接近 0）",
    !truthReplay.disabled && /外部真值/.test(truthReplay.chip + truthReplay.legend0) &&
      /^ok:/.test(truthReplay.imported) &&
      Number.isFinite(truthReplay.mean) && truthReplay.mean < 5,
    `truth 选项 disabled=${truthReplay.disabled}；读数「${truthReplay.chip.slice(0, 60)}」；` +
      `图例「${truthReplay.legend0.slice(0, 40)}」；导入=${truthReplay.imported}；` +
      `Mahony 当前/均值/峰值=${JSON.stringify(truthReplay.cells.slice(1, 5))}（均值应 < 5°）；` +
      `playing=${truthReplay.playing}、simTime=${truthReplay.simTime?.toFixed?.(2)}`,
  );
  await page.evaluate(() => {
    const sel = document.getElementById("scenario-select");
    sel.value = "hover";
    sel.dispatchEvent(new Event("change"));
  });

  // 回放时间口径唯一（P1）：日志末帧时间回退时，时长/进度/实际积分/导入提示/调试出口
  // 必须全部读同一条有效时间轴。旧实现按「末帧原始时刻 − 首帧原始时刻」算提示时长，
  // 回退段被夹成 0 之后提示比实际积分短（实测 0.18 s vs 0.22 s），进度条、状态条、提示各说各话。
  const replayClock = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const NL = String.fromCharCode(10);
    const head = "# imu=raw" + NL + "t_s,gx,gy,gz,ax,ay,az,mx,my,mz";
    // 0.00 → 0.46 s（每 20 ms 一帧，26 帧）后**回退**到 0.40 s 再收尾：
    // 原始跨度 0.40 s，有效（单调覆盖）跨度 0.46 s
    const times = [];
    for (let i = 0; i < 24; i++) times.push(Number((i * 0.02).toFixed(2)));
    times.push(0.40, 0.40);
    const rows = times.map((t, i) => `${t},${i + 1},0,0,0,0,9.8,30,0,40`);
    const imported = window.attitudeDemo.replay.import([head, ...rows].join(NL), "fallback.csv");
    const speed = document.getElementById("replay-speed");
    speed.value = "0";
    speed.dispatchEvent(new Event("change"));
    const deadline = performance.now() + 20000;
    let lastSim = -1, stable = 0;
    while (performance.now() < deadline) {
      const r = window.attitudeDemo.replay.info;
      const sim = window.attitudeDemo.sizes().simTime;
      if (r.idx >= r.frames && Math.abs(sim - lastSim) < 1e-9) stable++;
      else stable = 0;
      lastSim = sim;
      if (stable >= 3) break; // 源帧消费完 + 积分数不再变化 = 本段回放真的跑完了
      await sleep(60);
    }
    await sleep(200);
    const info = window.attitudeDemo.replay.info;
    const simTime = window.attitudeDemo.sizes().simTime;
    const statusText = document.getElementById("replay-status")?.textContent ?? "";
    const naive = (times[times.length - 1] - times[0]);
    const rawSpan = (times[23] - times[0]);
    window.attitudeDemo.replay.stop();
    await sleep(120);
    return { imported, info, simTime, statusText, naive, rawSpan };
  });
  const importedSec = Number(/\/\s*([\d.]+)\s*s$/.exec(replayClock.imported)?.[1] ?? NaN);
  check(
    "回放时间口径唯一：末帧时间回退时 duration/played/积分/提示/状态条完全一致",
    replayClock.info.durationSec > replayClock.naive + 1e-6 &&
      Math.abs(importedSec - replayClock.info.durationSec) < 0.01 &&
      Math.abs(replayClock.info.playedSec - replayClock.info.durationSec) < 1e-6 &&
      Math.abs(replayClock.simTime - replayClock.info.durationSec) < 0.02 &&
      replayClock.imported.startsWith("ok:") &&
      replayClock.statusText.includes(replayClock.info.durationSec.toFixed(1)) &&
      !/NaN/.test(replayClock.statusText),
    `导入=${replayClock.imported}、duration=${replayClock.info.durationSec}、played=${replayClock.info.playedSec}、` +
      `实际积分(simTime)=${replayClock.simTime}；末帧原始跨度=${replayClock.naive}（旧口径会报这个数）、本段有效跨度=${replayClock.rawSpan}；` +
      `状态条「${replayClock.statusText.replace(/\s+/g, " ").slice(0, 70)}」`,
  );

  // 可复现实验：同配置同 seed 的 runner digest 必须逐位一致；实验档案结构完整
  const det = await page.evaluate(() => {
    const a = window.attitudeDemo.experiment.run(1);
    const b = window.attitudeDemo.experiment.run(1);
    const archive = window.attitudeDemo.experiment.archive();
    return {
      same: a.digest === b.digest,
      metrics: a.metrics.map((m) => m.id),
      archive:
        archive.kind === "quaternion-attitude-demo/archive" &&
        archive.schema === 1 &&
        archive.restore === "config-only" &&
        typeof archive.config.seed === "number" &&
        typeof archive.run?.elapsedSec === "number",
      hasNees: a.metrics.find((m) => m.id === "kalman") && Number.isFinite(a.metrics.find((m) => m.id === "kalman").neesThetaMean),
    };
  });
  check(
    "确定性运行内核：同 seed digest 一致 + 配置档案语义 + 卡尔曼 NEES",
    det.same && det.metrics.length === 5 && det.archive && Boolean(det.hasNees),
    `digest 一致=${det.same}；算法=${det.metrics.join("/")}；restore=config-only=${det.archive}；NEES 有限=${Boolean(det.hasNees)}`,
  );

  // 批量评测：跑 10 个种子 × 10 s，输出 5 行 P50/P95 表
  const batchBefore = await page.evaluate(() => window.attitudeDemo.experiment.batchState());
  check(
    "批量评测开始前不在运行中（上一轮用例必须自己收尾干净）",
    batchBefore.running === false,
    `running=${batchBefore.running}、按钮「${batchBefore.button}」、世代 ${batchBefore.generation}`,
  );
  await page.evaluate(() => {
    document.getElementById("sec-experiments").classList.remove("collapsed");
    const sel = document.getElementById("batch-runs");
    sel.value = "10";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("btn-batch").click();
  });
  // 等"批量评测真的结束"（完成/已取消），并把**等待期间的现场**带进失败信息：
  // 慢 runner 上这条曾经只报 "Waiting failed: 240000ms exceeded"，看不出是没启动、还是跑得慢。
  const batchWaitDeadline = Date.now() + SLOW_MS(240000);
  const batchWaitSamples = [];
  for (;;) {
    const snap = await page.evaluate(() => ({
      status: document.getElementById("batch-status")?.textContent ?? "",
      state: window.attitudeDemo.experiment.batchState(),
      rows: document.querySelectorAll("#batch-body tr").length,
    }));
    batchWaitSamples.push(snap.status.slice(0, 40));
    if (snap.status.startsWith("完成") || snap.status.startsWith("已取消")) break;
    if (Date.now() > batchWaitDeadline) {
      throw new Error(
        `批量评测在 ${SLOW_MS(240000) / 1000} s 内没有结束——现场：状态「${snap.status}」、` +
          `running=${snap.state.running}、job=${snap.state.activeJob}、按钮「${snap.state.button}」、表格 ${snap.rows} 行；` +
          `状态文案轨迹：${batchWaitSamples.slice(0, 3).join(" → ")} … ${batchWaitSamples.slice(-3).join(" → ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const batch = await page.evaluate(() => ({
    rows: document.querySelectorAll("#batch-body tr").length,
    cols: document.querySelectorAll("#batch-body tr:first-child td").length,
    header: document.getElementById("batch-table")?.textContent ?? "",
    status: document.getElementById("batch-status")?.textContent ?? "",
    mode: window.attitudeDemo.experiment.batchMode(),
  }));
  check(
    "批量评测：多种子配对 + 全程/稳态 P95 表（Worker 路径）",
    batch.rows === 5 && batch.cols === 7 && batch.header.includes("稳态 P95") && batch.status.includes("稳态") &&
      batch.mode === "worker" && batch.status.includes("Web Worker"),
    `${batch.rows} 行 × ${batch.cols} 列；执行路径=${batch.mode}；${batch.status.slice(0, 96)}`,
  );

  // 复核反例回归：断线重连的过渡态必须**冻结**数据流（不得混入模拟 IMU、不得重置本轮时钟）
  const reconnectFreeze = await withIndependentPage(async (pg) => {
    await pg.setViewport({ width: 1280, height: 800 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      const enc = new TextEncoder();
      const line = (t) => enc.encode(t.toFixed(3) + ",1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7" + String.fromCharCode(10));
      let t = 0;
      let opens = 0;
      let myTimer = 0;
      const makeStream = (failAfter) => {
        let sent = 0;
        return new ReadableStream({
          start(c) {
            myTimer = setInterval(() => {
              t += 0.01;
              sent++;
              if (failAfter !== null && sent > failAfter) {
                clearInterval(myTimer);
                c.error(new Error("device disconnected"));
                return;
              }
              try {
                c.enqueue(line(t));
              } catch {
                clearInterval(myTimer);
              }
            }, 10);
          },
          cancel() {
            clearInterval(myTimer);
          },
        });
      };
      window.__rc = { opens: 0 };
      const port = {
        open: async () => {
          opens++;
          window.__rc.opens = opens;
          // 第一次只发 30 帧就断（进入重连等待），之后不再自动恢复 —— 用来看清过渡态
          stream = makeStream(opens === 1 ? 30 : 0);
        },
        close: async () => undefined,
        get readable() {
          return stream;
        },
      };
      let stream = makeStream(30);
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
    });
    await gotoSafe(pg);
    await pg.bringToFront();
    const bootDiagnostic = diagnostics.reconnectBoot = { samples: [], errors: errs, pages: [] };
    const bootDeadline = Date.now() + BOOT_MS;
    for (;;) {
      const sample = await pg.evaluate(() => ({
        fps: document.getElementById("fps")?.textContent ?? "",
        clock: document.getElementById("clock")?.textContent ?? "",
        ready: document.readyState, visible: document.visibilityState, focused: document.hasFocus(),
        hasApi: Boolean(window.attitudeDemo), frames: window.attitudeDemo?.performance?.()?.count ?? null,
        contextLost: window.attitudeDemo?.renderer?.getContext()?.isContextLost() ?? null,
      }));
      bootDiagnostic.samples.push({ at: Date.now(), ...sample });
      if (/^\d+\s+fps$/.test(sample.fps)) break;
      if (Date.now() >= bootDeadline) {
        bootDiagnostic.pages = (await browser.pages()).map(tab => ({ url: tab.url(), closed: tab.isClosed() }));
        await pg.screenshot({ path: join(shots, "reconnect-boot-failure.png") }).catch(() => undefined);
        throw new Error(`重连独立页未就绪（${BOOT_MS} ms）：${JSON.stringify(sample)}；错误 ${JSON.stringify(errs)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const sel = document.getElementById("serial-protocol");
      sel.value = "text";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("btn-serial").click();
    });
    await pg.waitForFunction(() => window.attitudeDemo.plumbing().frames > 10, { timeout: STATE_MS });
    // 等进入「重连等待」：此时数据源暂时没有数据，但本轮实验必须原封不动
    await pg.waitForFunction(
      () => {
        const t = document.getElementById("serial-status")?.textContent ?? "";
        return /自动重连|后自动重连|中断/.test(t);
      },
      { timeout: STATE_MS },
    );
    const before = await pg.evaluate(() => ({
      t: window.attitudeDemo.sizes().simTime,
      rows: window.attitudeDemo.sizes().logRows,
      lastImu: window.attitudeDemo.state.lastImu === null ? "null" : "sample",
    }));
    await new Promise((r) => setTimeout(r, 2500)); // 停留在过渡态里
    const during = await pg.evaluate(() => ({
      t: window.attitudeDemo.sizes().simTime,
      rows: window.attitudeDemo.sizes().logRows,
      real: document.body.dataset.imuMode,
      lastImu: window.attitudeDemo.state.lastImu === null ? "null" : "sample",
    }));
    await pg.close();
    return { before, during, errs };
  });
  check(
    "重连过渡态冻结数据流：时钟不重置、记录不新增、不混入模拟数据",
    Math.abs(reconnectFreeze.during.t - reconnectFreeze.before.t) < 1e-9 &&
      reconnectFreeze.during.rows === reconnectFreeze.before.rows &&
      reconnectFreeze.during.lastImu === "null" &&
      errsEmpty(reconnectFreeze.errs),
    `过渡态 2.5 s：时钟 ${reconnectFreeze.before.t.toFixed(3)} → ${reconnectFreeze.during.t.toFixed(3)} s、` +
      `记录行 ${reconnectFreeze.before.rows} → ${reconnectFreeze.during.rows}、` +
      `lastImu=${reconnectFreeze.during.lastImu}（应为 null）`,
  );

  // 复核反例回归：取消后**等过旧看门狗窗口**也不能有任何回写（旧实现会在 15 s 后复活旧批）
  const cancelStale = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitDone = () =>
      new Promise((resolve) => {
        const t = setInterval(() => {
          const txt = document.getElementById("batch-status")?.textContent ?? "";
          if (txt.startsWith("完成") || txt.startsWith("已取消")) {
            clearInterval(t);
            resolve(txt);
          }
        }, 100);
      });
    const sel = document.getElementById("batch-runs");
    sel.value = "30x30";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("btn-batch").click();
    await sleep(500);
    const genBefore = window.attitudeDemo.experiment.batchState().generation;
    document.getElementById("btn-batch").click(); // 取消
    const cancelledText = await waitDone();
    const genAfter = window.attitudeDemo.experiment.batchState().generation;
    const bodyAfterCancel = document.getElementById("batch-body")?.innerHTML ?? "";
    // 关键：等过旧实现的 15 s 看门狗窗口，期间表格/状态不得被旧任务改写
    await sleep(17000);
    const bodyLater = document.getElementById("batch-body")?.innerHTML ?? "";
    const stateLater = window.attitudeDemo.experiment.batchState();
    const statusLater = document.getElementById("batch-status")?.textContent ?? "";
    return {
      genBefore,
      genAfter,
      generationAdvanced: genAfter > genBefore,
      unchangedTable: bodyAfterCancel === bodyLater,
      stillCancelled: statusLater.startsWith("已取消"),
      notRunning: stateLater.running === false && stateLater.activeJob === 0,
      cancelledText,
    };
  });
  check(
    "取消后过旧看门狗窗口（17 s）也无回写：世代推进、表格不变、状态仍为已取消",
    cancelStale.generationAdvanced &&
      cancelStale.unchangedTable &&
      cancelStale.stillCancelled &&
      cancelStale.notRunning,
    `世代 ${cancelStale.genBefore} → ${cancelStale.genAfter}；取消后 17 s 表格不变=${cancelStale.unchangedTable}、` +
      `状态仍「${cancelStale.cancelledText.slice(0, 12)}…」；running/activeJob 归零=${cancelStale.notRunning}`,
  );

  /**
   * SW-10：30×30 多种子运行期间采样，然后真实 GUI 取消当前未完成的种子。
   * timer 是事件循环诊断，不冒充输入事件；200 ms 是固定目标，不随基线放大。
   * runner 停止和 await 返回必须有独立时点，不能用轮询到文案/半成品的时间冒充。
   */
  const mainCancel = await withIndependentPage(async (pg) => {
    const diagnostic = diagnostics.sw10 = { targetMs: 200, minimumSamples: 40, waitFailures: [], errors: [] };
    await pg.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    const errs = diagnostic.errors;
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      window.Worker = undefined;
      window.__sw10 = { longTasks: [], longTaskSupported: false, input: null };
      try {
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__sw10.longTasks.push({ start: e.startTime, duration: e.duration });
        });
        observer.observe({ entryTypes: ["longtask"] });
        window.__sw10.longTaskSupported = true;
      } catch (e) { window.__sw10.longTaskReason = String(e); }
    });
    await gotoSafe(pg);
    await pg.bringToFront();
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      document.getElementById("sec-experiments").classList.remove("collapsed");
      const sel = document.getElementById("batch-runs");
      sel.value = "30x30";
      sel.dispatchEvent(new Event("change"));
      window.attitudeDemo.experiment.disableWorker();
      window.attitudeDemo.performance?.(true);
    });
    const snapshot = () => pg.evaluate(() => ({
      state: window.attitudeDemo.experiment.batchState(),
      status: document.getElementById("batch-status")?.textContent ?? "",
      frameTiming: window.attitudeDemo.performance?.() ?? null,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeElement: { id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName ?? "" },
      longTaskSupported: window.__sw10.longTaskSupported,
      longTaskReason: window.__sw10.longTaskReason ?? null,
      longTasks: window.__sw10.longTasks.slice(),
    }));
    const measureLoopLatency = (runningRequired) => pg.evaluate(async (required) => {
      const samples = [], observations = [];
      const startedAt = performance.now();
      for (let i = 0; i < 40; i++) {
        const before = window.attitudeDemo.experiment.batchState();
        if (required && !before.running) break;
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, 0));
        const at = performance.now();
        const after = window.attitudeDemo.experiment.batchState();
        samples.push(at - t0);
        observations.push({ requestedAt: t0, observedAt: at, runningBefore: before.running,
          runningAfter: after.running, generation: after.generation, slices: after.slices ?? null,
          status: document.getElementById("batch-status")?.textContent ?? "" });
        if (at - startedAt > 15000) break;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (q) => sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
      return { kind: "setTimeout(0) event-loop latency, not input", samples, observations,
        count: samples.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null,
        percentileMethod: "nearest rank", startedAt, endedAt: performance.now(),
        allDuringBatch: observations.length >= 40 && observations.every((s) => s.runningBefore && s.runningAfter) };
    }, runningRequired);
    const idleLatency = diagnostic.timerBaseline = await measureLoopLatency(false);
    diagnostic.before = await snapshot();
    await pg.evaluate(() => window.attitudeDemo.performance?.(true));
    await pg.click("#btn-batch");
    const responsiveness = diagnostic.timerDuringBatch = await measureLoopLatency(true);
    // 确认采样后仍在批量中；不声称首种子，status 原文保留实际完成数。
    const during = diagnostic.beforeCancellation = await snapshot();
    await pg.evaluate(() => {
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) {
        document.addEventListener(type, event => {
          if (!event.target.closest?.("#btn-batch")) return;
          (window.__sw10.pointerEvents ??= []).push({ type, timestamp: event.timeStamp, handledAt: performance.now(), trusted: event.isTrusted });
        }, { capture: true });
      }
      document.addEventListener("click", (event) => {
        if (!event.target.closest?.("#btn-batch")) return;
        window.__sw10.input = {
          handlerAt: performance.now(), eventTimeStamp: event.timeStamp, trusted: event.isTrusted,
          timeOrigin: performance.timeOrigin, visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(), activeElementId: document.activeElement?.id ?? "",
          beforeHandlerState: window.attitudeDemo.experiment.batchState(),
        };
      }, { capture: true, once: true });
    });
    const button = await pg.$("#btn-batch");
    const box = await button?.boundingBox();
    if (!box) throw new Error("SW-10 取消按钮不可见；没有发出真实输入");
    await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pg.mouse.down();
    const nodeInputSentEpochMs = nodePerformance.timeOrigin + nodePerformance.now();
    await pg.mouse.up(); // 这一真实 mouseup 产生 click；移动/按下的 CDP 往返不混入点击排队时延。
    diagnostic.nodeInput = { viewport: pg.viewport(), kind: "click-producing mouseup dispatch", sentEpochMs: nodeInputSentEpochMs,
      clickReturnedEpochMs: nodePerformance.timeOrigin + nodePerformance.now(), position: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
    let cancelledSeen = false, runnerSettled = false;
    try {
      await pg.waitForFunction(() => (document.getElementById("batch-status")?.textContent ?? "").startsWith("已取消"), { timeout: SLOW_MS(5000) });
      cancelledSeen = true;
    } catch (e) { diagnostic.waitFailures.push({ phase: "cancelled status", reason: String(e) }); }
    try {
      await pg.waitForFunction(() => {
        const state = window.attitudeDemo.experiment.batchState();
        return !state.running && state.partialSeeds >= 1 && state.cancelTiming?.postAwaitAt != null;
      }, { timeout: SLOW_MS(5000) });
      runnerSettled = true;
    } catch (e) { diagnostic.waitFailures.push({ phase: "runner/post-await settlement", reason: String(e) }); }
    const after = await pg.evaluate(() => ({
      state: window.attitudeDemo.experiment.batchState(),
      input: window.__sw10.input,
      pointerEvents: window.__sw10.pointerEvents ?? [],
      observedAt: performance.now(),
      status: document.getElementById("batch-status")?.textContent ?? "",
      body: document.getElementById("batch-body")?.innerHTML ?? "",
      result: window.attitudeDemo.experiment.batchResult(),
      clock: parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) || 0,
    }));
    diagnostic.afterCancellation = { ...await snapshot(), ...after };
    const timing = after.state.cancelTiming;
    const input = after.input;
    /**
     * 「停下」时刻的两种合法来源：
     *  · 主线程 runner 已经开始分片（slices.count > 0）→ 必须有 runnerStoppedAt；
     *  · 取消落在**准备阶段**（一次分片都还没跑）→ 没有 runner 可停，等价口径是取消结算（postAwaitAt）。
     * 第二种不许被当成「缺失即通过」：它同样受 200 ms 硬约束，且单独记录来源，便于事后区分。
     */
    const runnerExisted = (diagnostic.beforeCancellation?.state?.slices?.count ?? 0) > 0;
    const stopAt = timing?.runnerStoppedAt ?? (runnerExisted ? null : timing?.postAwaitAt ?? null);
    const stopSource = timing?.runnerStoppedAt != null ? "runner-stop" : stopAt != null ? "prepare-time-settle" : null;
    diagnostic.cancellation = {
      nodeInputToHandlerMs: input ? input.timeOrigin + input.handlerAt - nodeInputSentEpochMs : null,
      eventToHandlerMs: input ? input.handlerAt - input.eventTimeStamp : null,
      stopSource,
      runnerExisted,
      handlerToRunnerStopMs: input && stopAt != null ? stopAt - input.handlerAt : null,
      requestToRunnerStopMs: timing?.requestedAt != null && stopAt != null ? stopAt - timing.requestedAt : null,
      runnerStopToPostAwaitMs: timing?.runnerStoppedAt != null && timing?.postAwaitAt != null ? timing.postAwaitAt - timing.runnerStoppedAt : null,
      requestToPostAwaitMs: after.state.cancelLatencyMs,
      eventToRunnerStopMs: input && stopAt != null ? stopAt - input.eventTimeStamp : null,
      nodeInputToRunnerStopMs: input && stopAt != null ? input.timeOrigin + stopAt - nodeInputSentEpochMs : null,
      observedAfterStopMs: stopAt != null ? after.observedAt - stopAt : null,
      rawTiming: timing ?? null,
      clockNote: "Node/browser epoch uses timeOrigin+performance.now; event/runner/await use page monotonic time",
      cancelledSeen, runnerSettled,
    };
    await new Promise((r) => setTimeout(r, 700));
    const settled = diagnostic.settled = await pg.evaluate(() => ({
      clock: parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) || 0,
      status: document.getElementById("batch-status")?.textContent ?? "",
      running: window.attitudeDemo.experiment.batchState().running,
    }));
    let restart;
    if (runnerSettled) {
    const restartStartedAt = Date.now();
    await pg.evaluate(() => {
      const sel = document.getElementById("batch-runs");
      sel.value = "10";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("btn-batch").click();
    });
    const restartDeadline = Date.now() + SLOW_MS(90000);
    let restartText = "";
    for (;;) {
      restartText = await pg.evaluate(() => document.getElementById("batch-status")?.textContent ?? "");
      if (restartText.startsWith("完成") || restartText.startsWith("已取消") || Date.now() > restartDeadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    restart = diagnostic.restart = await pg.evaluate((text) => ({
      text,
      rows: document.querySelectorAll("#batch-body tr").length,
      state: window.attitudeDemo.experiment.batchState(),
      result: window.attitudeDemo.experiment.batchResult(),
    }), restartText);
    restart.elapsedMs = Date.now() - restartStartedAt;
    } else {
      // 挂起的旧任务不能因新批次重置遥测而被吞掉；继续记录后续 check 为失败，不假装重启过。
      diagnostic.waitFailures.push({ phase: "restart", reason: "runner/post-await 尚未落定，未启动新世代" });
      restart = diagnostic.restart = { text: "未重启：旧 runner 未落定", rows: 0, state: after.state, result: null, elapsedMs: 0 };
    }
    diagnostic.final = await snapshot();
    await pg.close();
    return { during, idleLatency, responsiveness, after, settled, restart, cancelledSeen, runnerSettled, errs };
  });
  const cancelMetrics = diagnostics.sw10.cancellation;
  const withinTarget = (value) => Number.isFinite(value) && value >= 0 && value <= 200;
  const cancelName = "SW-10 主线程降级：真实 GUI 取消未完成种子，浏览器事件到 runner 停止 ≤200 ms（命令传输与 post-await 单记）";
  const responseName = "SW-10 主线程降级：运行期 timer 响应 ≥40 样本且 p95 ≤200 ms，取消后界面继续可用";
  diagnostics.sw10.checks = [cancelName, responseName, "SW-10 主线程降级：取消后再启动能跑完，且旧世代不回写"];
  check(
    "SW-10 主线程降级：真实 GUI 取消未完成种子，浏览器事件到 runner 停止 ≤200 ms（命令传输与 post-await 单记）",
    mainCancel.during.state.running && mainCancel.during.state.button.includes("取消") &&
      mainCancel.during.state.workerDisabled === true && mainCancel.after.input?.trusted === true &&
      mainCancel.after.input?.beforeHandlerState.running === true && mainCancel.cancelledSeen && mainCancel.runnerSettled &&
      withinTarget(cancelMetrics.eventToRunnerStopMs) && withinTarget(cancelMetrics.requestToRunnerStopMs) &&
      mainCancel.after.state.partialSeeds >= 1 && mainCancel.after.state.running === false &&
      mainCancel.after.state.activeJob === 0 && diagnostics.sw10.waitFailures.length === 0,
    `命令传输+输入等待→handler ${cancelMetrics.nodeInputToHandlerMs?.toFixed(1) ?? "缺失"} ms（仅诊断）；` +
      `浏览器事件→handler ${cancelMetrics.eventToHandlerMs?.toFixed(1) ?? "缺失"} ms；handler→runner ${cancelMetrics.handlerToRunnerStopMs?.toFixed(1) ?? "缺失"} ms；` +
      `runner→post-await ${cancelMetrics.runnerStopToPostAwaitMs?.toFixed(1) ?? "缺失"} ms；事件→runner ${cancelMetrics.eventToRunnerStopMs?.toFixed(1) ?? "缺失"} ms（固定200，来源 ${cancelMetrics.stopSource ?? "缺失"}）；` +
      `取消前「${mainCancel.during.status}」；丢弃 ${mainCancel.after.state.partialSeeds} 个；等待失败 ${diagnostics.sw10.waitFailures.length}`,
  );
  check(
    "SW-10 主线程降级：运行期 timer 响应 ≥40 样本且 p95 ≤200 ms，取消后界面继续可用",
    mainCancel.idleLatency.count >= 40 && mainCancel.responsiveness.allDuringBatch &&
      withinTarget(mainCancel.responsiveness.p95) &&
      mainCancel.during.state.slices?.count > 0 && mainCancel.during.frameTiming?.count > 0 &&
      mainCancel.after.body.trim() === "" && mainCancel.after.result === null &&
      mainCancel.settled.running === false && mainCancel.settled.status.startsWith("已取消") &&
      mainCancel.settled.clock > mainCancel.after.clock && errsEmpty(mainCancel.errs),
    `timer基线 p95=${mainCancel.idleLatency.p95?.toFixed(1)} ms（仅诊断）；运行 ${mainCancel.responsiveness.count} 样本、` +
      `p95=${mainCancel.responsiveness.p95?.toFixed(1)} ms（固定200）、均运行中=${mainCancel.responsiveness.allDuringBatch}；` +
      `slice最长 ${mainCancel.during.state.slices?.maxComputeMs?.toFixed(1) ?? "缺失"} ms；frame最长 ${mainCancel.during.frameTiming?.max?.frame?.toFixed(1) ?? "缺失"} ms；` +
      `取消后时钟 ${mainCancel.after.clock.toFixed(1)}→${mainCancel.settled.clock.toFixed(1)} s；原始数据见 diagnostics.sw10`,
  );
  check(
    "SW-10 主线程降级：取消后再启动能跑完，且旧世代不回写",
    mainCancel.restart.text.startsWith("完成") &&
      mainCancel.restart.rows === 5 &&
      mainCancel.restart.state.running === false &&
      mainCancel.restart.result?.generation === mainCancel.restart.state.generation,
    `${mainCancel.restart.text.slice(0, 24)}（耗时 ${mainCancel.restart.elapsedMs.toFixed(0)} ms）；表格 ${mainCancel.restart.rows} 行；` +
      `结果世代 ${mainCancel.restart.result?.generation} = 当前世代 ${mainCancel.restart.state.generation}`,
  );

  // Worker 的 jobId / 心跳 / 取消：30×30 档点第二次必须能取消，取消后还能再跑
  const batchCancel = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitDone = () =>
      new Promise((resolve) => {
        const t = setInterval(() => {
          const txt = document.getElementById("batch-status")?.textContent ?? "";
          if (txt.startsWith("完成") || txt.startsWith("已取消")) {
            clearInterval(t);
            resolve(txt);
          }
        }, 100);
      });
    const sel = document.getElementById("batch-runs");
    sel.value = "30x30";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("btn-batch").click();
    await sleep(600);
    const during = window.attitudeDemo.experiment.batchState();
    document.getElementById("btn-batch").click(); // 再点一次 = 取消
    const cancelledText = await waitDone();
    const after = window.attitudeDemo.experiment.batchState();
    // 取消后再跑一个小批次：状态必须完全恢复（按钮文案、jobId、表格都能用）
    sel.value = "10";
    sel.dispatchEvent(new Event("change"));
    document.getElementById("btn-batch").click();
    const doneText = await waitDone();
    const again = window.attitudeDemo.experiment.batchState();
    return {
      duringRunning: during.running,
      duringButton: during.button,
      cancels: after.cancels,
      cancelledText,
      againRunning: again.running,
      againButton: again.button,
      doneText,
      rows: document.querySelectorAll("#batch-body tr").length,
    };
  });
  check(
    "批量评测可取消（jobId + 心跳看门狗）：运行中按钮变「取消」，取消后状态完全恢复并能再跑",
    batchCancel.duringRunning &&
      batchCancel.duringButton.includes("取消") &&
      // 取消计数是累计值：这里的用例顺序会改变绝对值，只断言「至少发生过一次取消」
      batchCancel.cancels >= 1 &&
      batchCancel.cancelledText.includes("已取消") &&
      !batchCancel.againRunning &&
      batchCancel.againButton.includes("运行批量评测") &&
      batchCancel.doneText.startsWith("完成") &&
      batchCancel.rows === 5,
    `运行中：running=${batchCancel.duringRunning} 按钮「${batchCancel.duringButton}」；` +
      `取消后：${batchCancel.cancelledText.slice(0, 24)}、计数 ${batchCancel.cancels}；` +
      `再跑：${batchCancel.doneText.slice(0, 20)}…（${batchCancel.rows} 行）`,
  );

  // 主线程回退路径仍可用（同一口径的聚合入口），用于 Worker 不可用时的降级与自动化复算
  const mainPath = await page.evaluate(() => {
    const rows = window.attitudeDemo.experiment.batchOnMain(6, 2);
    const mahony = rows.find((r) => r.id === "mahony");
    return { rows: rows.length, rmseP50: mahony?.rmseP50 ?? null, steady: mahony?.steadyRmseP95 ?? null };
  });
  check(
    "批量评测主线程路径可用：同一聚合口径（Worker 降级时行为不变）",
    mainPath.rows === 5 && Number.isFinite(mainPath.rmseP50) && Number.isFinite(mainPath.steady),
    `聚合 ${mainPath.rows} 行；Mahony RMSE P50=${mainPath.rmseP50?.toFixed(3)}、稳态 P95=${mainPath.steady?.toFixed(3)}`,
  );

  // 界面路径 vs runner 路径的**逐帧 golden trace**：
  // 两条路径现在共用 core/solve-loop.ts 的调度，同 seed 下应当只差双精度舍入。
  // 这是「批量结论能代表界面」的可验证前提——第五轮复核时 runner 把粗对准放在解算之前，
  // 与界面差一帧遥测，靠肉眼看曲线永远发现不了。
  const frameParity = await page.evaluate(async (contractSource) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input"));
      el.dispatchEvent(new Event("change"));
    };
    // 逐帧可比的前提：关掉一切「实时路径特有」的东西
    set("imu-delay", 0);
    set("imu-bandwidth", 0);
    set("imu-delay-skew", 0);
    set("imu-sample-rate", 0);
    for (const id of ["loop-toggle", "ab-toggle"]) {
      const el = document.getElementById(id);
      if (el.checked) el.click();
    }
    document.getElementById("magcal-clear")?.click();
    document.getElementById("accelcal-clear")?.click();
    if (document.getElementById("btn-pause").textContent === "暂停") document.getElementById("btn-pause").click();
    await sleep(250);
    window.attitudeDemo.experiment.setSeed(4321); // 暂停后复位到同一起点
    await sleep(150);
    const STEPS = 2000; // 4.0 s @500 Hz
    const END = STEPS * (1 / 500);
    const uiFrames = window.attitudeDemo.experiment.traceFrames(STEPS);
    const runner = window.attitudeDemo.experiment.traceFramesRunner(STEPS);
    const runnerFrames = runner.steps;
    const R2D = 180 / Math.PI;
    const { compareTrace } = (0, eval)(`(() => {${contractSource}; return { compareTrace };})()`);
    const compare = (a, b, ids, end, count) => compareTrace(a, b, ids, end, count);
    const main = compareTrace(uiFrames, runnerFrames, runner.estimatorIds, END, STEPS, {
      leftEvents: window.attitudeDemo.experiment.traceEvents(), rightEvents: runner,
    });
    // 事件契约：界面侧标到 aligned 的步数必须等于 runner 的 alignTimes 条数
    const uiAligned = uiFrames.filter((f) => f.aligned).length;
    const alignConsistent = uiAligned === (runner.alignTimes?.length ?? 0);

    // 负面对照：下面每一种畸形输入**都必须**被判失败，否则比较器只是个"看起来在比"的摆设
    const clone = (fr) => fr.map((f) => ({ ...f, quats: f.quats.map((q) => ({ ...q })) }));
    const negatives = {};
    const mid = clone(uiFrames);
    const perturbed = clone(runnerFrames);
    // ① 中点偏 10°、终点不变：只比终点会漏掉
    const half = Math.floor(perturbed.length / 2);
    perturbed[half].quats = perturbed[half].quats.map((q, k) =>
      k === 0 ? { w: Math.cos(5 / R2D), x: Math.sin(5 / R2D), y: 0, z: 0 } : q,
    );
    negatives.midPerturbation = compare(mid, perturbed, runner.estimatorIds, END, STEPS).ok === false;
    // ② 截断（双方都少一帧）
    negatives.truncated = compare(uiFrames.slice(0, 1501), runnerFrames.slice(0, 1501), runner.estimatorIds, END, STEPS).ok === false;
    // ③ runner 多一个尾帧
    negatives.extraTail = compare(uiFrames, [...clone(runnerFrames), clone(runnerFrames)[0]], runner.estimatorIds, END, STEPS).ok === false;
    // ④ 每帧空 quats
    negatives.emptyQuats = compare(
      uiFrames.map((f) => ({ ...f, quats: [] })),
      runnerFrames,
      runner.estimatorIds,
      END,
      STEPS,
    ).ok === false;
    // ⑤ 中途 NaN
    const nanFrames = clone(runnerFrames);
    nanFrames[10].quats[0] = { w: NaN, x: 0, y: 0, z: 0 };
    negatives.midNaN = compare(uiFrames, nanFrames, runner.estimatorIds, END, STEPS).ok === false;
    // ⑥ 非单位四元数（w=2）
    const nonUnit = clone(runnerFrames);
    nonUnit[10].quats[0] = { w: 2, x: 0, y: 0, z: 0 };
    negatives.nonUnit = compare(uiFrames, nonUnit, runner.estimatorIds, END, STEPS).ok === false;
    // ⑦ 时间倒序
    const reversed = clone(runnerFrames);
    reversed[20] = { ...reversed[20], t: reversed[19].t - 1e-6 };
    negatives.timeOrder = compare(uiFrames, reversed, runner.estimatorIds, END, STEPS).ok === false;
    // ⑧ dt 不一致（两侧时间总和相同但步长不同）
    const dtMismatch = clone(runnerFrames);
    dtMismatch[1000] = { ...dtMismatch[1000], dt: dtMismatch[1000].dt * 2 };
    negatives.dtMismatch = compare(uiFrames, dtMismatch, runner.estimatorIds, END, STEPS).ok === false;
    // ⑨ 缺输入（删掉 raw/consumed）
    negatives.missingInput = compare(
      uiFrames.map((f, k) => (k === 500 ? { t: f.t, dt: f.dt, quats: f.quats, aligned: f.aligned } : f)),
      runnerFrames,
      runner.estimatorIds,
      END,
      STEPS,
    ).ok === false;
    // ⑩ 对齐标记不一致（界面把某一步标成 aligned、runner 没有）：必须失败
    //    （注意不能"双方都清掉"——本例没有对准事件时那是等价输入，不算坏输入）
    negatives.alignMismatch = compare(
      uiFrames.map((f, k) => (k === 1000 ? { ...f, aligned: true } : f)),
      runnerFrames,
      runner.estimatorIds,
      END,
      STEPS,
    ).ok === false;
    // ⑪ 帧数不足（期望 schedule 不匹配）
    negatives.shortSchedule = compare(uiFrames.slice(0, 1999), runnerFrames.slice(0, 1999), runner.estimatorIds, END, STEPS).ok === false;

    // 输入/事件契约：raw 与 consumed 必须都存在且不同（校准链真的在跑），事件计数不是空的
    const rawConsumedOk = uiFrames.every(
      (f) => f.raw && f.consumed && f.raw.accel.length === 3 && f.consumed.mag.length === 3,
    );
    const dtOk = uiFrames.every((f) => Number.isFinite(f.dt) && f.dt > 0);
    return {
      uiCount: uiFrames.length,
      runnerCount: runnerFrames.length,
      comparedSteps: main.compared,
      ok: main.ok,
      reason: main.reason,
      maxStepDiff: main.maxStepDiff,
      maxTimeDiff: main.maxTimeDiff,
      worstAt: main.worstAt,
      lastT: uiFrames.length ? uiFrames[uiFrames.length - 1].t : NaN,
      negatives,
      negativesAllFail: Object.values(negatives).every(Boolean),
      rawConsumedOk,
      dtOk,
      alignConsistent,
      uiAligned,
      eventCounts: runner.eventCounts,
      runnerIds: runner.estimatorIds,
    };
  }, traceContractSource);
  check(
    "界面与 runner **逐帧**一致：帧数/五算法/有限单位四元数/严格时序 + 11 种畸形输入必须失败",
    frameParity.ok === true &&
      frameParity.uiCount > 1500 &&
      frameParity.comparedSteps === frameParity.uiCount &&
      frameParity.runnerCount === frameParity.uiCount &&
      frameParity.maxStepDiff < 1e-3 &&
      frameParity.maxTimeDiff < 1e-12 &&
      frameParity.negativesAllFail === true &&
      frameParity.alignConsistent === true &&
      frameParity.rawConsumedOk === true &&
      frameParity.dtOk === true,
    `逐帧比较 ${frameParity.comparedSteps} 步（界面 ${frameParity.uiCount} / runner ${frameParity.runnerCount}，` +
      `算法 ${frameParity.runnerIds?.join("/")}）；最大单步姿态差 ${frameParity.maxStepDiff.toExponential(2)}°` +
      `（第 ${frameParity.worstAt} 步）、最大时间差 ${frameParity.maxTimeDiff.toExponential(1)} s；末帧 t=${frameParity.lastT.toFixed(4)}；` +
      `畸形输入全部判失败=${frameParity.negativesAllFail}（${JSON.stringify(frameParity.negatives)}）；` +
      `raw/consumed 齐备=${frameParity.rawConsumedOk}、dt 有效=${frameParity.dtOk}；` +
      `对齐步数与 runner alignTimes 一致=${frameParity.alignConsistent}（界面 ${frameParity.uiAligned} 步）`,
  );

  // 单步与共享时间游标
  const stepCursor = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 先确保暂停：运行中按钮显示「暂停」，点它进入暂停
    if (document.getElementById("btn-pause").textContent === "暂停") document.getElementById("btn-pause").click();
    await sleep(150);
    // 之前的视图用例可能停在万向节/四元数视图（那些视图会隐藏曲线区）；先切回四轴姿态
    document.querySelector('#view-seg .seg-btn[data-view="attitude"]')?.click();
    await sleep(150);
    // 曲线块可能被之前的折叠用例收起：游标依赖画布有尺寸，先确保三条都展开
    document.querySelectorAll("#charts .block-toggle").forEach((b) => {
      if (b.getAttribute("aria-expanded") === "false") b.click();
    });
    await sleep(200);
    // 单步只推进一个解算步（500 Hz 时 2 ms，clock 的 0.1 s 分辨率显示不出来）；
    // 用调试出口的精确仿真时间断言，而不是看四舍五入后的时钟文本。
    const t1 = window.attitudeDemo.sizes().simTime;
    document.getElementById("btn-step").click();
    await sleep(120);
    const t2 = window.attitudeDemo.sizes().simTime;
    const canvas = document.getElementById("att-canvas");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    await sleep(80);
    const chip = document.getElementById("chart-cursor");
    const text = chip.textContent ?? "";
    return {
      adv: t2 - t1,
      visible: !chip.classList.contains("hidden"),
      text,
      cw: canvas.clientWidth,
      ch: canvas.clientHeight,
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      evt: rect.width * rect.height > 0,
    };
  });
  check(
    "单步推进 + 三图共享时间游标",
    stepCursor.adv > 0 && stepCursor.adv <= 1 && stepCursor.visible && /^t = /.test(stepCursor.text),
    `单步推进 ${stepCursor.adv.toFixed(3)} s；游标可见=${stepCursor.visible}；画布 ${stepCursor.cw}×${stepCursor.ch} rect=${stepCursor.rect.join(",")}；${stepCursor.text.slice(0, 60)}`,
  );

  // 数学分页：math-topics 独立成页、旧锚点仍可达、Wahba/圆锥演示画布有图形
  const mathTopics = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById("btn-docs").click();
    await sleep(100);
    document.querySelector('.module-link[data-doc="math-topics"]').click();
    await sleep(200);
    const page = document.querySelector('.doc-page[data-doc-page="math-topics"]');
    const toc = document.getElementById("docs-chapter-toc")?.textContent ?? "";
    const ink = (id) => {
      const c = document.getElementById(id);
      const ctx = c.getContext("2d");
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
      return n;
    };
    return {
      visible: page && !page.hidden,
      hasWahba: Boolean(document.getElementById("m-wahba")),
      hasConing: Boolean(document.getElementById("m-coning")),
      tocHasWahba: toc.includes("Wahba") || toc.includes("单帧"),
      wahbaInk: ink("fig-wahba-demo"),
      coningInk: ink("fig-coning-demo"),
    };
  });
  check(
    "数学分页 math-topics：新页可见、旧锚点可达、演示画布有内容",
    mathTopics.visible && mathTopics.hasWahba && mathTopics.hasConing && mathTopics.tocHasWahba && mathTopics.wahbaInk > 500 && mathTopics.coningInk > 500,
    `可见=${mathTopics.visible} m-wahba=${mathTopics.hasWahba} m-coning=${mathTopics.hasConing} 目录含 Wahba=${mathTopics.tocHasWahba}；` +
      `Wahba 墨迹 ${mathTopics.wahbaInk}、圆锥 ${mathTopics.coningInk}`,
  );
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 100));
  await page.evaluate(() => {
    // 单步用例会把仿真暂停；这里恢复运行，否则后面的导出/回放用例会拿不到足够行数。
    if (document.getElementById("btn-pause").textContent === "继续") document.getElementById("btn-pause").click();
  });

  // CSV 导出：拦截 Blob，检查参数头与数据行
  // 拦截 blob 下载跑两遍：默认档（姿态角与误差）与「带四元数」档。
  // 导出前会弹选项对话框（这是用户要求的行为），所以要先点确认按钮。
  const runExport = async (scope) =>
    page.evaluate(async (scopeValue) => {
      let text = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => {
        b.text().then((t) => (text = t));
        return "blob:test";
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      const dlg = document.getElementById("export-dialog");
      // A/B 配对起跑会复位本轮记录（same-start 语义），刚点完 A/B 时可能还没有行；
      // 这里轮询到弹窗真正打开，而不是假设「点一下必然有数据」。
      for (let i = 0; i < 40 && !dlg.open; i++) {
        document.getElementById("btn-export").click();
        await new Promise((r) => setTimeout(r, 80));
        if (!dlg.open) await new Promise((r) => setTimeout(r, 300));
      }
      if (!dlg.open) throw new Error("导出弹窗没有打开（本轮记录始终为空）");
      const meta = document.getElementById("export-meta")?.textContent ?? "";
      // 导出可能被**产品规则**主动拒绝（例如同一批记录混了 raw/calibrated 两种源语义）。
      // 把提示条文本一起带回来：失败时能一眼看出是「没生成」还是「被规则拒绝」。
      const toastText = [...document.querySelectorAll("#toast-layer .ov-chip")].map((c) => c.textContent).join(" | ");
      // 打开时的默认档必须是「姿态角与误差」（单选组恰好一项选中；历史上会把全帧导出一起勾上）
      const checkedAtOpen = [...document.querySelectorAll('input[name="export-scope"]')]
        .filter((r) => r.checked).map((r) => r.value);
      document.querySelector(`input[name="export-scope"][value="${scopeValue}"]`).checked = true;
      document.getElementById("export-confirm").click();
      // 慢机器上 blob.text() 可能几百毫秒才落地：等它，而不是赌 250 ms
      for (let i = 0; i < 80 && !text; i++) await new Promise((r) => setTimeout(r, 50));
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return { text, meta, closed: !dlg.open, checkedAtOpen, toastText };
    }, scope);

  const base = await runExport("angles");
  const csv = base.text;
  const csvLines = csv ? csv.split(NL) : [];
  const cols = (csvLines.find((l) => l.startsWith("t_s")) ?? "").split(",").filter(Boolean);
  check(
    "CSV 导出：弹窗选档 + 默认档 24 列",
    Boolean(csv) &&
      csv.includes("algorithm_params") &&
      csv.includes("err_kalman_deg") &&
      !csv.includes("_qw") &&
      cols.length === 24 &&
      base.closed &&
      base.checkedAtOpen.length === 1 && base.checkedAtOpen[0] === "angles",
    csv
      ? `${csvLines.length} 行 / ${cols.length} 列；打开时选中档=${base.checkedAtOpen.join("/")}；弹窗提示「${base.meta.split("·")[0].trim()}」`
      : `未生成${base.toastText ? `（提示条：${base.toastText}）` : ""}`,
  );

  const withQ = await runExport("quat");
  const qCols = ((withQ.text ? withQ.text.split(NL) : []).find((l) => l.startsWith("t_s")) ?? "")
    .split(",")
    .filter(Boolean);
  const need = ["pure_qw", "mahony_qz", "kalman_qw", "truth_qw"];
  check(
    "CSV 导出：选「带四元数」后 48 列且列名齐全",
    qCols.length === 48 && need.every((c) => qCols.includes(c)),
    `${qCols.length} 列，含 ${need.filter((c) => qCols.includes(c)).join("/")}`,
  );

  // 闭环：导出「带原始 IMU」的 CSV → 用回放入口喂回装置 → 应进入回放模式并自行推进。
  // 这条用例把「导出」与「导入回放」两端锁在一起——任何一端改了列名就会当场失败。
  const roundTrip = await page.evaluate(async () => {
    const NL = String.fromCharCode(10);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // CI 上 rAF 被节流、而仿真 dt 有 50 ms 上限 → 仿真时钟比墙钟慢好几倍，
    // 「跑了几秒」不等于「记了足够多行」。这里先按弹窗里的真实行数等到够多，
    // 再导出，否则会拿到一份十几行的 CSV（解析器的 20 帧下限会合理地拒收它）。
    let rows = 0;
    for (let i = 0; i < 60; i++) {
      document.getElementById("btn-export").click();
      await sleep(80);
      const meta = document.getElementById("export-meta")?.textContent ?? "";
      const m = meta.match(/已记录 (\d+) 行/);
      rows = m ? Number(m[1]) : 0;
      document.getElementById("export-cancel").click();
      if (rows >= 40) break;
      await sleep(400);
    }
    let csv = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => {
      b.text().then((t) => (csv = t));
      return "blob:x";
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("btn-export").click();
    await new Promise((r) => setTimeout(r, 150));
    document.getElementById("export-imu").checked = true;
    document.getElementById("export-confirm").click();
    // 同 runExport：等 blob 文本真的读出来（慢机器上 400 ms 也会读不完）
    for (let i = 0; i < 80 && !csv; i++) await new Promise((r) => setTimeout(r, 50));
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick;
    if (!csv) {
      // 导出可能被产品规则拒绝（混源语义）——把提示条带回去，别只报"未产生"
      const toast = [...document.querySelectorAll("#toast-layer .ov-chip")].map((c) => c.textContent).join(" | ");
      return { err: `导出未产生 CSV${toast ? `（提示条：${toast}）` : ""}` };
    }
    const header = csv.split(NL).find((l) => l.startsWith("t_s")) ?? "";
    const imp = window.attitudeDemo.replay.import(csv, "roundtrip.csv");
    await new Promise((r) => setTimeout(r, 1200));
    const info = window.attitudeDemo.replay.info;
    const status = document.getElementById("replay-status").textContent;
    const mode = document.body.dataset.imuMode;
    const controlsOff = document.getElementById("scenario-select").disabled;
    // 离线回放走背压，**不允许**在解算入口丢帧（丢帧只可能是实时源的队列溢出）。
    const solveDropped = window.attitudeDemo.plumbing().solveDropped;
    window.attitudeDemo.replay.stop();
    await new Promise((r) => setTimeout(r, 300));
    const afterStop = window.attitudeDemo.replay.info;
    return { header, imp, info, status, mode, controlsOff, afterStop, rows, solveDropped };
  });
  check(
    "导出→导入闭环：原始 IMU 能回放且退出后回到模拟",
    Boolean(roundTrip.header?.includes("gyro_x_dps")) &&
      roundTrip.imp?.startsWith("ok:") &&
      roundTrip.info?.active === true &&
      roundTrip.info?.idx > 0 &&
      roundTrip.mode === "real" &&
      roundTrip.controlsOff === true &&
      roundTrip.solveDropped === 0 &&
      roundTrip.afterStop?.active === false,
    `导出前已记录 ${roundTrip.rows} 行；${roundTrip.imp}；回放中 ${roundTrip.info?.idx}/${roundTrip.info?.frames} 帧，` +
      `模式=${roundTrip.mode}，模拟控件停用=${roundTrip.controlsOff}，解算入口拒绝=${roundTrip.solveDropped} 帧，` +
      `退出后 active=${roundTrip.afterStop?.active}`,
  );

  } // app 段结束
  if (runDevices) {
  // ---------- BLE IMU：假 Web Bluetooth（含 20 字节分片的 28 字节帧） ----------
  // 真机无法在 CI 配对，但「应用侧」整条链路可以像假串口那样完整验证：
  // 假设备暴露一个 GATT 服务 + 一个 notify 特征，用 20 字节分片发 28 字节二进制帧，
  // 专门验证「BLE 通知天然分片、装置靠流式缓冲重组」这件事。
  const runBleCase = async (protocol) => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument((proto) => {
      window.__bleProto = proto;
      const crc8 = (d, from, to) => {
        let c = 0;
        for (let i = from; i < to; i++) {
          c ^= d[i];
          for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
        }
        return c;
      };
      const put = (d, off, v, scale) => {
        const x = Math.round(v * scale);
        const u = x < 0 ? x + 0x10000 : x;
        d[off] = u & 0xff;
        d[off + 1] = (u >> 8) & 0xff;
      };
      const makeFrame = (seq, tick) => {
        const d = new Uint8Array(28);
        d[0] = 0xaa; d[1] = 0x55; d[2] = 24;
        d[3] = seq & 0xff; d[4] = (seq >> 8) & 0xff;
        d[5] = tick & 0xff; d[6] = (tick >> 8) & 0xff; d[7] = (tick >> 16) & 0xff; d[8] = (tick >>> 24) & 0xff;
        put(d, 9, 1.5, 10); put(d, 11, 0, 10); put(d, 13, 0, 10);
        put(d, 15, 0, 100); put(d, 17, 0, 100); put(d, 19, 9.8, 100);
        put(d, 21, 32.8, 100); put(d, 23, 0, 100); put(d, 25, 37.7, 100);
        d[27] = crc8(d, 2, 27);
        return d;
      };
      // 假特征必须**忠实于 EventTarget**：累积监听、支持移除。
      // 早期版本只存最后一个回调（notifyCb = cb），于是「重复订阅会叠加监听器、
      // 同一帧被消费多次」这个真实缺陷被假设备掩盖了——比现实更宽容的 mock 会藏 bug。
      const listeners = [];
      const char = {
        uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
        properties: { notify: true },
        value: null,
        startNotifications: async () => char,
        stopNotifications: async () => char,
        addEventListener: (t, cb) => {
          if (t === "characteristicvaluechanged") listeners.push(cb);
        },
        removeEventListener: (t, cb) => {
          if (t !== "characteristicvaluechanged") return;
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
        __listenerCount: () => listeners.length,
      };
      window.__bleListenerCount = () => listeners.length;
      const device = {
        name: "FAKE-BLE-IMU",
        id: "fake-1",
        gatt: {
          connected: true,
          connect: async () => ({
            getPrimaryService: async () => ({ getCharacteristics: async () => [char] }),
          }),
          disconnect: () => {
            device.gatt.connected = false;
          },
        },
        addEventListener: () => undefined,
      };
      Object.defineProperty(navigator, "bluetooth", {
        configurable: true,
        value: { requestDevice: async () => device },
      });
      // 20 字节分片：BLE 默认 ATT MTU 只有 23 → 28 字节帧必然被拆成两条通知
      let seq = 0;
      let tick = 5000;
      window.__bleEmit = () => {
        const f = makeFrame(seq++, tick);
        tick += 5;
        if (window.__bleProto === "text") {
          // 文本模式：分片也不影响（按行切）
          const enc = new TextEncoder();
          const line = "3.5,1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7" + String.fromCharCode(10);
          const b = enc.encode(line);
          for (let i = 0; i < b.length; i += 20) {
            const part = b.slice(i, i + 20);
            char.value = new DataView(part.buffer, part.byteOffset, part.byteLength);
            for (const cb of [...listeners]) cb({ target: char });
          }
          return;
        }
        for (let i = 0; i < f.length; i += 20) {
          const part = f.slice(i, i + 20);
          char.value = new DataView(part.buffer, part.byteOffset, part.byteLength);
          for (const cb of [...listeners]) cb({ target: char });
        }
      };
    }, protocol);
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate((proto) => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const p = document.getElementById("serial-protocol");
      p.value = proto;
      p.dispatchEvent(new Event("change", { bubbles: true }));
      const m = document.getElementById("serial-mounting");
      m.value = "x-front-y-right";
      m.dispatchEvent(new Event("change", { bubbles: true }));
    }, protocol);
    await pg.click("#btn-ble");
    await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: STATE_MS });
    // 每 10 ms 发一帧（分片后是两条通知）
    await pg.evaluate(() => {
      window.__bleTimer = setInterval(() => window.__bleEmit(), 10);
    });
    // 等「真的在收帧」：状态行出现非零帧率，比等时钟可靠（连接时 resetSim 会清零时钟，
    // 而时钟也可能被别的路径推进）。这一条以前踩过：等到的是「连接前的时钟」。
    await pg.waitForFunction(
      () => /[1-9]\d* 帧\/s/.test(document.getElementById("serial-status")?.textContent ?? ""),
      { timeout: SLOW_MS(12000) },
    ).catch(() => undefined);
    const info = await pg.evaluate(() => {
      const imu = window.attitudeDemo.state.lastImu;
      return {
        mode: document.body.dataset.imuMode,
        status: document.getElementById("serial-status")?.textContent ?? "",
        bleStatus: document.getElementById("ble-status")?.textContent ?? "",
        charVisible: !document.getElementById("ble-char-row").classList.contains("hidden"),
        accel: imu ? imu.accel.map((v) => +v.toFixed(4)) : null,
        gyro: imu ? imu.gyro.map((v) => +(v * 57.29578).toFixed(3)) : null,
        mag: imu ? imu.mag.map((v) => +v.toFixed(2)) : null,
        btn: document.getElementById("btn-ble").textContent,
      };
    });
    await pg.evaluate(() => clearInterval(window.__bleTimer));
    await pg.close();
    return { info, errs };
  };

  const bleBin = await runBleCase("binary");
  check(
    "BLE IMU：分片通知重组 28 字节帧并进入真实模式",
    bleBin.info.mode === "real" &&
      bleBin.info.status.includes("BLE IMU") &&
      bleBin.info.charVisible &&
      bleBin.info.btn === "断开 BLE" &&
      bleBin.info.accel?.[2] > 9.7 &&
      bleBin.info.accel[2] < 9.9 &&
      Math.abs((bleBin.info.gyro?.[0] ?? 0) - 1.5) < 0.1 &&
      Math.abs((bleBin.info.mag?.[0] ?? 0) - 32.8) < 0.1 &&
      errsEmpty(bleBin.errs),
    `accel=${JSON.stringify(bleBin.info.accel)} gyro=${JSON.stringify(bleBin.info.gyro)}｜状态「${bleBin.info.status}」｜BLE「${bleBin.info.bleStatus}」｜按钮=${bleBin.info.btn}｜错误=${bleBin.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  const bleTxt = await runBleCase("text");
  check(
    "BLE IMU：文本协议走同一条通路",
    bleTxt.info.mode === "real" &&
      bleTxt.info.status.includes("BLE IMU") &&
      bleTxt.info.status.includes("文本行") &&
      bleTxt.info.accel?.[2] > 9.7 &&
      errsEmpty(bleTxt.errs),
    `accel=${JSON.stringify(bleTxt.info.accel)}｜${bleTxt.info.status}`,
  );

  // ---------- 连接所有权（复核 ROUND8 P1-A/B/C/D）----------
  // 假串口必须**忠实于 Web Serial 的真实约束**，否则测不出问题：
  //  · open() 会重建 readable；已打开的端口再 open 必须报 already open；
  //  · close() 之后端口才算释放（不 close 会一直占着设备，下次 open 直接失败）；
  //  · 系统级拔线由 navigator.serial 的 disconnect 事件表达（真实拔线不一定让 read 报错）。
  // 这些用例是复核里那些反例（旧 await 完成后仍提交状态 / 旧 reader 打死新连接 /
  // 耗尽后永久冻结）的永久化版本。
  const makeFakeSerialPage = async (opts = {}) => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      const NL = String.fromCharCode(10);
      const enc = new TextEncoder();
      const st = {
        opens: 0,
        closes: 0,
        /** 让接下来 N 次 close() 失败（模拟驱动/蓝牙栈暂时拒绝关闭），之后自行恢复 */
        failCloses: 0,
        opened: false,
        hangNextOpen: false,
        failNextOpen: false,
        failAlways: false,
        openResolvers: [],
        readers: [],
        emitTimer: 0,
      };
      window.__fs = st;
      const encodeLine = () => enc.encode(`0.02,1,0,0,0,0,9.8,32.8,0,37.7${NL}`);
      const makeReadable = () => {
        let pendingResolve = null;
        const rec = {
          /** hold = 这条 read 挂起后不再被 cancel/数据结束（用于模拟「旧 read 迟到」） */
          hold: false,
          /** heldLock = 模拟"读完但还没释放锁"的窗口：此时 close 必须失败（Web Serial 约束） */
          heldLock: false,
          pending: () => pendingResolve !== null,
          /** 忽略 hold 强制投一帧：模拟"旧 reader 在替代连接建立后才把数据送上来" */
          forceEmit: () => {
            if (!pendingResolve) return false;
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: encodeLine(), done: false });
            return true;
          },
          emit: () => {
            if (rec.hold || !pendingResolve) return false;
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: encodeLine(), done: false });
            return true;
          },
          finish: () => {
            if (!pendingResolve) return false;
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: undefined, done: true });
            return true;
          },
        };
        const reader = {
          read: () => new Promise((res) => { pendingResolve = res; }),
          cancel: () => {
            if (pendingResolve && !rec.hold) {
              const r = pendingResolve;
              pendingResolve = null;
              r({ value: undefined, done: true });
            }
            return Promise.resolve();
          },
          releaseLock: () => undefined,
        };
        st.readers.push(rec);
        return { getReader: () => reader };
      };
      const port = {
        readable: null,
        writable: null,
        open() {
          st.opens++;
          if (st.failAlways || st.failNextOpen) {
            st.failNextOpen = false;
            return Promise.reject(new Error("Failed to open serial port"));
          }
          if (st.opened) return Promise.reject(new Error("The port is already open"));
          st.opened = true;
          port.readable = makeReadable();
          if (st.hangNextOpen) {
            st.hangNextOpen = false;
            return new Promise((res) => st.openResolvers.push(res));
          }
          return Promise.resolve();
        },
        close() {
          st.closes++;
          // 关闭失败：**端口保持打开**（真实驱动被占用/读锁未释放时就是这样）
          if (st.failCloses > 0) {
            st.failCloses--;
            return Promise.reject(new Error("Failed to close serial port"));
          }
          st.opened = false;
          port.readable = null;
          return Promise.resolve();
        },
      };
      st.port = port; // 用例需要按严格语义包装 close/执行锁约束
      const serial = {
        __port: port,
        requestPort: async () => port,
        getPorts: async () => [port],
        addEventListener: (t, cb) => {
          if (t === "disconnect") serial.__disc = cb;
        },
        removeEventListener: () => undefined,
        /** 模拟系统级拔线 */
        __fireDisconnect: () => serial.__disc?.({ port }),
      };
      Object.defineProperty(navigator, "serial", { configurable: true, value: serial });
    });
    // 假 BLE 必须在**加载前**装好：应用的「非 Chromium 能力提示」在启动时按
    // `typeof navigator.bluetooth` 把 BLE 按钮永久置灰。Ubuntu 的 Chrome 默认不带 Web Bluetooth，
    // 于是运行时再装假设备也没用——按钮是 disabled 的，click() 什么都不做（CI 实测这一组 5 条全红）。
    if (opts.ble) {
      await pg.evaluateOnNewDocument(
        (wire, hangSubscribe, hangConnect) => { (0, eval)(wire)(hangSubscribe, hangConnect); },
        installFakeBle,
        opts.ble === "hang",
        opts.ble === "hang-connect",
      );
    }
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const p = document.getElementById("serial-protocol");
      p.value = "text";
      p.dispatchEvent(new Event("change", { bubbles: true }));
      window.__fs.emitTimer = setInterval(() => {
        for (const r of window.__fs.readers) r.emit();
      }, 10);
    });
    if (opts.connect !== false) {
      await pg.click("#btn-serial");
      await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: STATE_MS });
    }
    return { pg, errs, stop: () => pg.evaluate(() => clearInterval(window.__fs.emitTimer)) };
  };

  /** 在页面里装一个最小假 BLE（requestDevice/GATT/notify 三段走通即可） */
  const installFakeBle = `(hangSubscribe, hangConnect) => {
    const listeners = [];
    let releaseSubscribe = null;
    let releaseConnect = null;
    const char = {
      uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
      properties: { notify: true },
      value: null,
      startNotifications: () =>
        hangSubscribe ? new Promise((res) => (releaseSubscribe = () => res(char))) : Promise.resolve(char),
      stopNotifications: async () => char,
      addEventListener: (t, cb) => t === "characteristicvaluechanged" && listeners.push(cb),
      removeEventListener: (t, cb) => {
        if (t !== "characteristicvaluechanged") return;
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const server = { getPrimaryService: async () => ({ getCharacteristics: async () => [char] }) };
    const device = {
      name: "FAKE-BLE",
      id: "fake-ble",
      gatt: {
        // hangConnect：connect() 永不落定（驱动/蓝牙栈挂起），直到用例显式放行——
        // 用于验证"主动超时之后**迟到的** GATT 连接必须自己断开"（复核 SW-05）。
        connected: !hangConnect,
        connect: hangConnect
          ? () => new Promise((res) => { releaseConnect = () => { device.gatt.connected = true; res(server); }; })
          : async () => server,
        disconnect: () => (device.gatt.connected = false),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    // 设备掉线监听：模拟「走出范围 / 关机」，用于验证 BLE 待重连期间切源
    const deviceListeners = [];
    device.addEventListener = (t, cb) => { if (t === "gattserverdisconnected") deviceListeners.push(cb); };
    device.removeEventListener = (t, cb) => {
      if (t !== "gattserverdisconnected") return;
      const i = deviceListeners.indexOf(cb);
      if (i >= 0) deviceListeners.splice(i, 1);
    };
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: { requestDevice: async () => device },
    });
    window.__ble = {
      device, listeners, releaseSubscribe: () => releaseSubscribe?.(),
      releaseConnect: () => releaseConnect?.(),
      count: () => listeners.length,
      deviceListeners: () => deviceListeners.length,
      gattConnected: () => device.gatt.connected,
      drop: () => { for (const cb of [...deviceListeners]) cb(); },
    };
  }`;

  // A-1：串口 → BLE 切换必须一次成功（复核 P1-B：BLE 先捕获世代，随后内部 serialDisconnect
  //      又递增一次，把**本次 BLE 连接自己**作废——实测 serial=false/ble=false/通知数 0）。
  const serialToBle = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ ble: true });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("btn-ble").click();
      await sleep(1500);
      const p = window.attitudeDemo.plumbing();
      return {
        serial: p.serial,
        ble: p.ble,
        sourceKind: p.sourceKind,
        mode: document.body.dataset.imuMode,
        btn: document.getElementById("btn-ble").textContent,
        gattOn: window.__ble.device.gatt.connected === true,
        listeners: window.__ble.count(),
      };
    }, installFakeBle);
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：串口 → BLE 切换一次成功（不自我作废）",
    serialToBle.res.ble === true &&
      serialToBle.res.serial === false &&
      serialToBle.res.sourceKind === "ble" &&
      serialToBle.res.mode === "real" &&
      serialToBle.res.btn === "断开 BLE" &&
      serialToBle.res.gattOn === true &&
      serialToBle.res.listeners === 1 &&
      errsEmpty(serialToBle.errs),
    `ble=${serialToBle.res.ble} serial=${serialToBle.res.serial} 来源=${serialToBle.res.sourceKind} ` +
      `模式=${serialToBle.res.mode} 按钮=${serialToBle.res.btn} GATT 在用=${serialToBle.res.gattOn} ` +
      `订阅监听=${serialToBle.res.listeners}｜错误=${serialToBle.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2：旧 reader 的迟到收尾不得打死新连接（复核 P1-C）。让第一条连接的 read 挂起并
  //      「冻结」其结束，制造系统级断链 → 自动重连建立新连接，最后才让旧 read 结束。
  const readerOwnership = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage();
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const fs = window.__fs;
      fs.readers[0].hold = true; // 旧 read 既不因 cancel 结束，也不再收数据
      const before = window.attitudeDemo.plumbing();
      navigator.serial.__fireDisconnect(); // 系统级拔线 → 1 s 后退避重连
      await sleep(2800);
      const mid = window.attitudeDemo.plumbing();
      const after = window.attitudeDemo.plumbing();
      // 先停掉"正常数据源"（假串口的定时投帧），否则后面测不出迟到的旧帧是否被解析
      clearInterval(fs.emitTimer);
      await sleep(400); // 等队列排空
      const drained = window.attitudeDemo.plumbing();
      // ROUND11 P1：迟到的**数据**（不只是 done）也必须被丢弃——旧实现只在 await 前验令牌，
      // 于是旧 reader 迟到的一帧被解析进了新连接的队列。这里让旧 reader 真正收到一帧。
      const lateValue = fs.readers[0].forceEmit();
      await sleep(500);
      const after3 = window.attitudeDemo.plumbing();
      const finished = fs.readers[0].finish(); // 迟到的 done（同一令牌检查路径）
      await sleep(300);
      const after4 = window.attitudeDemo.plumbing();
      const f0 = drained.frames;
      return {
        beforeSerial: before.serial,
        midSerial: mid.serial,
        midReconnects: mid.reconnects,
        finished,
        afterSerial: after.serial,
        framesGrow: after3.frames - f0,
        openPorts: after4.openPorts,
        readers: fs.readers.length,
        lateValueAccepted: lateValue,
        drainedFrames: drained.frames,
        lateQueue: after3.queue,
        lateFramesGrow: after3.frames - drained.frames,
        afterDoneRunning: after4.serial,
        closeFailures: after4.portCloseFailures,
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：旧 reader 迟到结束/迟到数据都不打死也不污染新连接；端口按实际结果记账",
    readerOwnership.res.beforeSerial === true &&
      readerOwnership.res.midSerial === true &&
      readerOwnership.res.midReconnects >= 1 &&
      readerOwnership.res.afterSerial === true &&
      readerOwnership.res.framesGrow === 0 &&
      readerOwnership.res.drainedFrames > 0 &&
      readerOwnership.res.openPorts === 1 &&
      readerOwnership.res.readers >= 2 &&
      // 迟到数据必须被丢弃：stub 接受了它，但解析结果不得进队列/计帧
      readerOwnership.res.lateValueAccepted === true &&
      readerOwnership.res.lateFramesGrow === 0 &&
      readerOwnership.res.lateQueue === 0 &&
      readerOwnership.res.afterDoneRunning === true &&
      readerOwnership.res.closeFailures === 0 &&
      errsEmpty(readerOwnership.errs),
    `断开前 serial=${readerOwnership.res.beforeSerial}；重连后 serial=${readerOwnership.res.midSerial}` +
      `（重连次数 ${readerOwnership.res.midReconnects}）；停源前排空帧数 ${readerOwnership.res.drainedFrames} → ` +
      `serial=${readerOwnership.res.afterSerial}、迟到一帧后新增 ${readerOwnership.res.framesGrow} 帧（应为 0）、` +
      `旧 done 之后仍运行=${readerOwnership.res.afterDoneRunning}、` +
      `打开的端口=${readerOwnership.res.openPorts}、reader 数=${readerOwnership.res.readers}；` +
      `旧 reader 迟到一帧被接受=${readerOwnership.res.lateValueAccepted} 但随后新增帧=${readerOwnership.res.lateFramesGrow}（应为 0）、` +
      `close 失败=${readerOwnership.res.closeFailures}｜错误=${readerOwnership.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2b：严格锁语义——掉线收尾必须 cancel → 释放读锁 → close 才能成功重开
  //      （ROUND11 P1：旧实现先 close，严格夹具里报 "stream locked"，端口一直占着，
  //        重连连续撞 "already open"，而 openPorts 却已归零——记账与实际脱钩）。
  const strictLock = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage();
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const fs = window.__fs;
      // 让假端口**严格执行** Web Serial 的锁约束：readable 被锁时 close 必须失败
      const port = fs.port;
      const rawClose = port.close.bind(port);
      fs.closeErrors = 0;
      port.close = () => {
        if (fs.readers.some((r) => r.heldLock)) {
          fs.closeErrors++;
          return Promise.reject(new Error("stream locked"));
        }
        return rawClose();
      };
      // 所有 reader 在「读完但未释放锁」的窗口内标记为持锁
      window.__lockAll = (held) => {
        for (const r of fs.readers) r.heldLock = held;
      };
      window.__lockAll(true);
      navigator.serial.__fireDisconnect();
      // 状态等待：等到「锁着 close」真的被夹具拒绝过，而不是固定等 3 s（退避档位一过就对不上）
      const lockDeadline = performance.now() + 6000;
      while (performance.now() < lockDeadline && fs.closeErrors === 0) await sleep(100);
      const mid = window.attitudeDemo.plumbing();
      window.__lockAll(false); // 释放锁后重连应当成功
      // 状态等待：重连可能已退到 4 s 档，固定 1.5 s 会偶发「还没连上」
      const reopenDeadline = performance.now() + 20000;
      while (performance.now() < reopenDeadline && !window.attitudeDemo.plumbing().serial) await sleep(100);
      const after = window.attitudeDemo.plumbing();
      const f0 = after.frames;
      // 等帧计数真的增长（数据链路通不通要看数据，不看时钟）
      const frameDeadline = performance.now() + 8000;
      let f1 = f0;
      while (performance.now() < frameDeadline) {
        await sleep(100);
        f1 = window.attitudeDemo.plumbing().frames;
        if (f1 > f0) break;
      }
      const after2 = window.attitudeDemo.plumbing();
      return {
        closeErrors: fs.closeErrors,
        opens: fs.opens,
        midRunning: mid.serial,
        afterRunning: after.serial,
        reconnects: after2.reconnects,
        openPorts: after2.openPorts,
        closeFailures: after2.portCloseFailures,
        framesGrow: f1 - f0,
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：严格读锁下 close 失败被如实计数，释放锁后重连成功且端口不泄漏",
    strictLock.res.closeErrors > 0 && // 夹具确实制造过「锁着 close」的场景
      strictLock.res.afterRunning === true &&
      strictLock.res.reconnects >= 1 &&
      strictLock.res.openPorts === 1 &&
      strictLock.res.framesGrow > 0 &&
      errsEmpty(strictLock.errs),
    `夹具制造 close 失败 ${strictLock.res.closeErrors} 次；重连后 serial=${strictLock.res.afterRunning}` +
      `（重连 ${strictLock.res.reconnects} 次、open ${strictLock.res.opens} 次）、打开的端口=${strictLock.res.openPorts}、` +
      `close 失败计数=${strictLock.res.closeFailures}、随后 0.5 s 新增 ${strictLock.res.framesGrow} 帧｜` +
      `错误=${strictLock.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2e（复核 P1-5）：close 失败后**生产代码**必须保留引用并后台自动重试，直到真正关闭。
  //      旧实现清掉 session/port/lastPort 后忽略 dispose 的 false → 物理端口仍开着、
  //      代码再也找不到它（open=1、close=0、永远占着）。
  //      本用例**不**手工再调用 dispose：恢复只能由生产重试路径完成。
  const closeRetry = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage();
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const fs = window.__fs;
      // dispose 一次会尝试 close 两次；让前三次关闭都失败，之后驱动「恢复」
      fs.failCloses = 3;
      const before = window.attitudeDemo.plumbing();
      document.getElementById("btn-serial").click(); // 用户主动断开
      const failDeadline = performance.now() + 8000;
      let sawPending = false;
      while (performance.now() < failDeadline) {
        if (window.attitudeDemo.plumbing().pendingPortCleanup > 0) { sawPending = true; break; }
        await sleep(50);
      }
      const mid = window.attitudeDemo.plumbing();
      // 只等生产代码的后台退避重试：不再触碰旧引用
      const cleanDeadline = performance.now() + 25000;
      while (performance.now() < cleanDeadline) {
        const p = window.attitudeDemo.plumbing();
        if (p.pendingPortCleanup === 0 && p.openPorts === 0) break;
        await sleep(100);
      }
      const after = window.attitudeDemo.plumbing();
      return {
        beforeRunning: before.serial,
        sawPending,
        midPending: mid.pendingPortCleanup,
        midOpenPorts: mid.openPorts,
        afterPending: after.pendingPortCleanup,
        afterOpenPorts: after.openPorts,
        afterRunning: after.serial,
        closes: fs.closes,
        portOpened: fs.opened,
        failLeft: fs.failCloses,
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接释放：close 失败不丢引用，生产代码后台自动重试直到真正关闭（无需人工再 dispose）",
    closeRetry.res.beforeRunning === true && closeRetry.res.sawPending &&
      closeRetry.res.afterPending === 0 && closeRetry.res.afterOpenPorts === 0 &&
      closeRetry.res.portOpened === false && closeRetry.res.afterRunning === false &&
      errsEmpty(closeRetry.errs),
    `断开前 serial=${closeRetry.res.beforeRunning}；观测到待清理=${closeRetry.res.sawPending}` +
      `（待清理 ${closeRetry.res.midPending}、打开的端口 ${closeRetry.res.midOpenPorts}）；` +
      `自动重试后 待清理=${closeRetry.res.afterPending}、打开的端口=${closeRetry.res.afterOpenPorts}、` +
      `夹具端口 opened=${closeRetry.res.portOpened}、close 共调用 ${closeRetry.res.closes} 次（剩 ${closeRetry.res.failLeft} 次强制失败未用）｜` +
      `错误=${closeRetry.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2c-2：主动连接动作**本身**必须超时，且「open 还在挂起时切到回放」也必须最终收口。
  //      复核 P1：dispose 的有界等待只保护"释放"，不保护"连接"——`SerialPort.open()` /
  //      `gatt.connect()` / 服务发现可以永不落定，旧实现下按钮永远停在"正在连接"、
  //      句柄一直悬空；而切来源时 serialDisconnect 只在 running/port 为真时才跑，
  //      「正在 open、尚未 running」这一窗口没有任何人清槽位。
  const connectTimeout = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ connect: false });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const NL = String.fromCharCode(10);
      const fs = window.__fs;
      fs.hangNextOpen = true;
      document.getElementById("btn-serial").click(); // 连接：open 永不落定
      await sleep(400);
      const whileOpening = window.attitudeDemo.plumbing();
      const statusWhileOpening = document.getElementById("serial-status")?.textContent ?? "";
      // ① 正在 open、尚未 running 时切到回放
      const csv = ["# imu=raw", "t_s,gx,gy,gz,ax,ay,az,mx,my,mz"]
        .concat(Array.from({ length: 30 }, (_, i) => `${(i * 0.01).toFixed(2)},1,0,0,0,0,9.8,30,0,40`)).join(NL);
      window.attitudeDemo.replay.import(csv, "switch-open.csv");
      // ② 只等主动超时（不手工 dispose）：超时后必须判死（connecting=false）。
      //    **注意**：底层 open 仍挂起，所以此刻句柄**必须留在隔离队列**里（pendingPortCleanup>0）——
      //    这正是 SW-05 修掉的行为：旧实现把"外层等待结束"当成"已释放"，于是计数归零、句柄失控。
      const deadline = performance.now() + 25000;
      while (performance.now() < deadline) {
        if (window.attitudeDemo.plumbing().connecting === false) break;
        await sleep(150);
      }
      const duringQuarantine = window.attitudeDemo.plumbing();
      // ③ 迟到的 open 此刻才落定：必须自行 close，随后隔离队列收口到 0
      const closesBefore = fs.closes;
      fs.openResolvers.splice(0).forEach((r) => r());
      const cleanDeadline = performance.now() + 10000;
      let after = window.attitudeDemo.plumbing();
      while (performance.now() < cleanDeadline) {
        after = window.attitudeDemo.plumbing();
        if (after.pendingPortCleanup === 0 && after.openPorts === 0 && fs.closes > closesBefore) break;
        await sleep(150);
      }
      const statusAfter = document.getElementById("serial-status")?.textContent ?? "";
      window.attitudeDemo.replay.stop();
      return {
        whileOpening,
        statusWhileOpening,
        duringQuarantine,
        after,
        statusAfter,
        opens: fs.opens,
        closesLate: fs.closes - closesBefore,
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接动作主动超时：底层 open 未落定时句柄留在隔离队列，落定后自行关闭并收口到 0",
    connectTimeout.res.whileOpening.connecting === true &&
      connectTimeout.res.whileOpening.serial === false &&
      /正在打开端口/.test(connectTimeout.res.statusWhileOpening) &&
      connectTimeout.res.duringQuarantine.connecting === false &&
      connectTimeout.res.duringQuarantine.pendingPortCleanup >= 1 &&
      connectTimeout.res.duringQuarantine.openPorts === 0 &&
      connectTimeout.res.after.serial === false &&
      connectTimeout.res.after.replay === true &&
      connectTimeout.res.after.openPorts === 0 &&
      connectTimeout.res.after.pendingPortCleanup === 0 &&
      connectTimeout.res.after.pendingBleCleanup === 0 &&
      connectTimeout.res.opens === 1 &&
      connectTimeout.res.closesLate >= 1 &&
      /连接失败|超时/.test(connectTimeout.res.statusAfter) &&
      !/正在打开端口/.test(connectTimeout.res.statusAfter) &&
      errsEmpty(connectTimeout.errs),
    `挂起 open 期间：connecting=${connectTimeout.res.whileOpening.connecting}、serial=${connectTimeout.res.whileOpening.serial}、状态「${connectTimeout.res.statusWhileOpening.slice(0, 30)}」；` +
      `切回放后：serial=${connectTimeout.res.after.serial}、replay=${connectTimeout.res.after.replay}、打开的端口=${connectTimeout.res.after.openPorts}、` +
      `超时后待清理=${connectTimeout.res.duringQuarantine.pendingPortCleanup}（底层未落定必须留在隔离队列）、` +
      `迟到 open 落定后待清理=${connectTimeout.res.after.pendingPortCleanup}、BLE 待清理=${connectTimeout.res.after.pendingBleCleanup}；` +
      `夹具 open ${connectTimeout.res.opens} 次、迟到的 open 自行 close ${connectTimeout.res.closesLate} 次；` +
      `末态状态「${connectTimeout.res.statusAfter.slice(0, 40)}」｜错误=${connectTimeout.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2d：掉线重连**已排程**期间切换来源 → 旧定时器不得把旧链路接回来。
  //      复核反例：串口掉线 → 连 BLE，1 s 后串口自行接回，出现 serial=true/ble=true 双活；
  //      回放同理（replay=true + serial=true），端口被隐藏占用。
  //      两个场景共用一个页面：软件渲染下每个标签页都是一个 WebGL 上下文，
  //      少开一个页面就少一次「浏览器进程被回收」的机会（见 newPage 的自愈说明）。
  const pendingReconnectSwitch = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ ble: true });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // ① 串口待重连 → 切 BLE
      navigator.serial.__fireDisconnect();
      await sleep(120);
      const p = window.attitudeDemo.plumbing();
      const serialThenBle = { pending: { pending: p.reconnectPending, serial: p.serial } };
      document.getElementById("btn-ble").click();
      await sleep(2200); // 越过原定 1 s 重连时刻
      const a = window.attitudeDemo.plumbing();
      serialThenBle.after = { serial: a.serial, ble: a.ble, reconnectPending: a.reconnectPending, kind: a.sourceKind, openPorts: a.openPorts };
      // ② 回到串口，再制造一次「待重连 → 导入回放」
      document.getElementById("btn-ble").click(); // 主动断开 BLE
      await sleep(300);
      document.getElementById("btn-serial").click();
      for (let i = 0; i < 60 && !window.attitudeDemo.plumbing().serial; i++) await sleep(50);
      const reconnectedSerial = window.attitudeDemo.plumbing().serial;
      navigator.serial.__fireDisconnect();
      await sleep(120);
      const pending = window.attitudeDemo.plumbing().reconnectPending;
      const csv =
        "# imu=raw\nt_s,gx,gy,gz,ax,ay,az,mx,my,mz\n" +
        Array.from({ length: 30 }, (_, i) => `${(i * 0.01).toFixed(2)},0,0,0,0,0,9.8,30,0,40`).join("\n");
      const imported = window.attitudeDemo.replay.import(csv, "switch.csv");
      await sleep(1800);
      const b = window.attitudeDemo.plumbing();
      return {
        serialThenBle,
        serialThenReplay: {
          reconnectedSerial,
          pending,
          imported,
          after: { replay: b.replay, serial: b.serial, reconnectPending: b.reconnectPending, openPorts: b.openPorts, kind: b.sourceKind },
        },
      };
    }, installFakeBle);
    await stop();
    await pg.close();
    return { res, errs };
  })();
  const switchRes = pendingReconnectSwitch.res;
  check(
    "连接所有权：掉线重连已排程时切换来源，旧定时器不得复活（串口/BLE/回放互斥）",
    switchRes.serialThenBle.pending.pending === true &&
      switchRes.serialThenBle.pending.serial === false &&
      switchRes.serialThenBle.after.serial === false &&
      switchRes.serialThenBle.after.ble === true &&
      switchRes.serialThenBle.after.reconnectPending === false &&
      switchRes.serialThenBle.after.kind === "ble" &&
      switchRes.serialThenBle.after.openPorts === 0 &&
      switchRes.serialThenReplay.reconnectedSerial === true &&
      switchRes.serialThenReplay.pending === true &&
      /^ok:/.test(switchRes.serialThenReplay.imported) &&
      switchRes.serialThenReplay.after.replay === true &&
      switchRes.serialThenReplay.after.serial === false &&
      switchRes.serialThenReplay.after.reconnectPending === false &&
      switchRes.serialThenReplay.after.kind === "replay" &&
      switchRes.serialThenReplay.after.openPorts === 0 &&
      errsEmpty(pendingReconnectSwitch.errs),
    `串口待重连（${JSON.stringify(switchRes.serialThenBle.pending)}）→ 切 BLE 2.2 s 后：` +
      `${JSON.stringify(switchRes.serialThenBle.after)}；` +
      `再连回串口=${switchRes.serialThenReplay.reconnectedSerial} → 待重连（${switchRes.serialThenReplay.pending}）→ 导入回放 1.8 s 后：` +
      `导入=${switchRes.serialThenReplay.imported}、${JSON.stringify(switchRes.serialThenReplay.after)}｜` +
      `错误=${pendingReconnectSwitch.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2e：反方向同样要成立——BLE 掉线待重连期间连串口，BLE 定时器不得把 GATT 接回来。
  //      （与 A-2d 共用 `cancelPendingReconnects` + 来源归属校验，但走 BLE 的排程分支。）
  const blePendingThenSerial = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ connect: false, ble: true });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("btn-ble").click();
      for (let i = 0; i < 60 && !window.attitudeDemo.plumbing().ble; i++) await sleep(50);
      const connected = window.attitudeDemo.plumbing().ble;
      window.__ble.drop(); // 设备离开范围 → 1 s 后退避重连
      await sleep(150);
      const pending = window.attitudeDemo.plumbing().reconnectPending;
      document.getElementById("btn-serial").click(); // 切到串口
      for (let i = 0; i < 60 && !window.attitudeDemo.plumbing().serial; i++) await sleep(50);
      await sleep(2200); // 越过原定 BLE 重连时刻
      const a = window.attitudeDemo.plumbing();
      return {
        connected, pending,
        after: { serial: a.serial, ble: a.ble, reconnectPending: a.reconnectPending, kind: a.sourceKind, bleReconnects: a.bleReconnects },
        deviceListeners: window.__ble.deviceListeners(),
      };
    }, installFakeBle);
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：BLE 待重连时切到串口，GATT 不得自行接回（反向同样互斥）",
    blePendingThenSerial.res.connected === true &&
      blePendingThenSerial.res.pending === true &&
      blePendingThenSerial.res.after.serial === true &&
      blePendingThenSerial.res.after.ble === false &&
      blePendingThenSerial.res.after.kind === "serial" &&
      blePendingThenSerial.res.after.bleReconnects === 0 &&
      blePendingThenSerial.res.deviceListeners === 0 &&
      errsEmpty(blePendingThenSerial.errs),
    `BLE 已连=${blePendingThenSerial.res.connected} → 掉线待重连=${blePendingThenSerial.res.pending} → 连串口 2.2 s 后：` +
      `${JSON.stringify(blePendingThenSerial.res.after)}、残留掉线监听=${blePendingThenSerial.res.deviceListeners}｜` +
      `错误=${blePendingThenSerial.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-2c：BLE 初连失败（服务下没有 notify 特征）必须真正释放：GATT 断开 + 摘掉设备掉线监听
  //      （ROUND11 P1：旧实现状态 connected=false，物理上却仍连着，且留着 lost 回调干扰后续连接）
  const bleFailCleanup = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ ble: true });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 装一个"没有 notify 特征"的假 BLE 设备
      const listeners = new Set();
      const device = {
        name: "FAKE-NO-NOTIFY",
        id: "fake-empty",
        gatt: {
          connected: true,
          connect: async () => ({ getPrimaryService: async () => ({ getCharacteristics: async () => [] }) }),
          disconnect: () => (device.gatt.connected = false),
        },
        addEventListener: (t, cb) => t === "gattserverdisconnected" && listeners.add(cb),
        removeEventListener: (t, cb) => listeners.delete(cb),
      };
      Object.defineProperty(navigator, "bluetooth", {
        configurable: true,
        value: { requestDevice: async () => device },
      });
      document.getElementById("btn-ble").click();
      await sleep(1200);
      return {
        connectedInState: window.attitudeDemo.plumbing().ble,
        gattStillOn: device.gatt.connected === true,
        lostListeners: listeners.size,
        status: document.getElementById("ble-status").textContent,
      };
    }, installFakeBle);
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：BLE 初连因「无 notify 特征」失败时，GATT 被断开且掉线监听被摘掉",
    bleFailCleanup.res.connectedInState === false &&
      bleFailCleanup.res.gattStillOn === false &&
      bleFailCleanup.res.lostListeners === 0 &&
      bleFailCleanup.res.status.includes("没有支持通知") &&
      errsEmpty(bleFailCleanup.errs),
    `状态 connected=${bleFailCleanup.res.connectedInState}、物理 GATT 仍连=${bleFailCleanup.res.gattStillOn}、` +
      `残留 lost 监听=${bleFailCleanup.res.lostListeners}；状态「${bleFailCleanup.res.status.slice(0, 40)}」`,
  );

  // A-2d：加计采面必须要有**连续时间覆盖**（ROUND11 P1）。旧实现只看样本数/跨度，
  //      同一时刻连来 4000 帧也能"记录成功"（文案写"0.00 s 均值"）。
  //      这里直接驱动生产的 beginAccelCalFace/tickAccelCalibration（与界面按钮同一条路径）。
  const faceCapture = await page.evaluate(async () => {
    const A = window.attitudeDemo.accelcal;
    const gz = [0, 0, 9.80665];
    const status = () => document.getElementById("accelcal-status")?.textContent ?? "";
    // 每例先真正清空已采集的面（message 是"一次性"文案，渲染后立刻清空，所以读 DOM 文案）
    const run = (feed) => {
      document.getElementById("accelcal-clear").click();
      A.cancelFace();
      A.beginFace("+z");
      feed();
      return { faces: A.info().faces, message: status() };
    };
    // ① 正常：10 ms 递增、连续 0.6 s → 记录成功
    const okCase = run(() => {
      for (let i = 1; i <= 60; i++) A.feed(i * 0.01, gz);
    });
    // ② 恒定时间戳：0.5 s 内 100 帧同一时刻 → 必须拒绝
    const flatCase = run(() => {
      for (let i = 0; i < 100; i++) A.feed(1, gz);
    });
    // ③ 时间够长但中间断流（gap 0.4 s）→ 必须拒绝
    const gapCase = run(() => {
      for (let i = 1; i <= 30; i++) A.feed(i * 0.01, gz);
      A.feed(0.3 + 0.4, gz);
      A.feed(0.3 + 0.41, gz);
    });
    // ④ 样本达上限但时间只覆盖 0.02 s → 必须拒绝（容量不代替时长）
    const capCase = run(() => {
      for (let i = 1; i <= 4000; i++) A.feed(i * 0.000005, gz);
    });
    // ⑤ **时间加权密度**：样本挤在开头一小簇、后面只有零星几点——跨度够 0.5 s、
    //    也没有超过 150 ms 的间隙，但中间大片时间为空：等权均值其实由那一簇决定（ROUND12）
    const sparseCase = run(() => {
      for (let i = 1; i <= 40; i++) A.feed(i * 0.0005, gz); // 0.0005..0.02 的一簇
      A.feed(0.16, gz); // 之后间隔 0.14 s（低于 150 ms 门限，但中间大片时间为空）
      A.feed(0.3, gz);
      A.feed(0.44, gz);
      A.feed(0.5, gz);
      A.feed(0.54, gz); // 跨度 0.54 s → 窗口收满，此时检查密度
    });
    A.cancelFace();
    return { okCase, flatCase, gapCase, capCase, sparseCase };
  });
  check(
    "连接所有权：加计采面要求连续时间覆盖与密度（恒定时间戳/断流/仅堆量/稀疏簇都必须拒绝）",
    faceCapture.okCase.faces === 1 &&
      faceCapture.okCase.message.includes("已记录 +z") &&
      faceCapture.flatCase.faces === 0 &&
      faceCapture.flatCase.message.includes("时间戳未推进") &&
      faceCapture.gapCase.faces === 0 &&
      faceCapture.gapCase.message.includes("间隙") &&
      faceCapture.capCase.faces === 0 &&
      faceCapture.capCase.message.includes("上限") &&
      faceCapture.sparseCase.faces === 0 &&
      faceCapture.sparseCase.message.includes("段样本不足"),
    `递增时间戳：面数=${faceCapture.okCase.faces}（「${faceCapture.okCase.message.slice(0, 26)}」）；` +
      `恒定时间戳：面数=${faceCapture.flatCase.faces}（「${faceCapture.flatCase.message.slice(0, 26)}」）；` +
      `中间断流：面数=${faceCapture.gapCase.faces}（「${faceCapture.gapCase.message.slice(0, 26)}」）；` +
      `仅堆样本：面数=${faceCapture.capCase.faces}（「${faceCapture.capCase.message.slice(0, 26)}」）；` +
      `稀疏+末端补点：面数=${faceCapture.sparseCase.faces}（「${faceCapture.sparseCase.message.slice(0, 26)}」）`,
  );

  // A-3：重连耗尽必须回到「不再冻结」（复核 P1-C：1/3/7 s 连续失败后仍 reconnecting=true，
  //      主循环从此不动）。退避 1s/2s/4s 三次全失败后：过渡态结束、来源回模拟、端口全部回收。
  const reconnectExhausted = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage();
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__fs.failAlways = true;
      navigator.serial.__fireDisconnect();
      await sleep(900);
      const during = window.attitudeDemo.plumbing(); // 过渡态：冻结但保持来源身份
      await sleep(9500); // 1 + 2 + 4 s 退避 + 余量
      const after = window.attitudeDemo.plumbing();
      const t0 = window.attitudeDemo.state.simTime;
      await sleep(900);
      const t1 = window.attitudeDemo.state.simTime;
      return {
        duringPending: during.reconnectPending,
        duringKind: during.sourceKind,
        afterPending: after.reconnectPending,
        afterKind: after.sourceKind,
        openPorts: after.openPorts,
        clockGrow: +(t1 - t0).toFixed(3),
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：重连耗尽 → 结束过渡态、回收端口、时钟继续走（不永久冻结）",
    reconnectExhausted.res.duringPending === true &&
      reconnectExhausted.res.duringKind === "serial" &&
      reconnectExhausted.res.afterPending === false &&
      reconnectExhausted.res.afterKind === "simulation" &&
      reconnectExhausted.res.openPorts === 0 &&
      reconnectExhausted.res.clockGrow > 0.05 &&
      errsEmpty(reconnectExhausted.errs),
    `重连中：冻结=${reconnectExhausted.res.duringPending} 来源=${reconnectExhausted.res.duringKind}；` +
      `耗尽后：冻结=${reconnectExhausted.res.afterPending} 来源=${reconnectExhausted.res.afterKind}、` +
      `打开的端口=${reconnectExhausted.res.openPorts}、随后 0.9 s 时钟推进 ${reconnectExhausted.res.clockGrow} s｜` +
      `错误=${reconnectExhausted.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-4：自动重连的 open 挂起期间用户导入回放 —— 过期的那次重连必须自己收尾
  //      （关掉它 open 的端口）且不得碰新来源（复核 P1-A/C）。
  const staleReconnect = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage();
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const NL = String.fromCharCode(10);
      window.__fs.hangNextOpen = true;
      navigator.serial.__fireDisconnect();
      await sleep(1600); // 自动重连已进入挂起的 open()
      const hanging = window.attitudeDemo.plumbing();
      // 用户改主意：导入日志（= 换数据源，世代 +1）
      let csv = "t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut" + NL;
      for (let i = 0; i < 60; i++) {
        const t = (i * 0.02).toFixed(2);
        csv += `${t},1.5,0,0,0,0,9.8,32.8,0,37.7${NL}`;
      }
      const imp = window.attitudeDemo.replay.import(csv, "stale.csv");
      await sleep(300);
      const duringReplay = window.attitudeDemo.plumbing();
      // 放行那次过期的 open
      for (const r of window.__fs.openResolvers.splice(0)) r();
      await sleep(800);
      const after = window.attitudeDemo.plumbing();
      window.attitudeDemo.replay.stop();
      await sleep(300);
      return {
        hangingPending: hanging.reconnectPending,
        imp,
        duringReplay: { serial: duringReplay.serial, replay: duringReplay.replay, kind: duringReplay.sourceKind },
        after: { serial: after.serial, replay: after.replay, kind: after.sourceKind, openPorts: after.openPorts },
      };
    });
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：挂起的过期重连自己收尾、不碰新来源（导入回放后仍为回放）",
    staleReconnect.res.hangingPending === true &&
      String(staleReconnect.res.imp).startsWith("ok:") &&
      staleReconnect.res.duringReplay.replay === true &&
      staleReconnect.res.duringReplay.serial === false &&
      staleReconnect.res.duringReplay.kind === "replay" &&
      staleReconnect.res.after.replay === true &&
      staleReconnect.res.after.serial === false &&
      staleReconnect.res.after.openPorts === 0 &&
      errsEmpty(staleReconnect.errs),
    `挂起中冻结=${staleReconnect.res.hangingPending}；导入=${staleReconnect.res.imp}；` +
      `回放中 serial=${staleReconnect.res.duringReplay.serial} replay=${staleReconnect.res.duringReplay.replay} ` +
      `来源=${staleReconnect.res.duringReplay.kind}；放行过期 open 后 replay=${staleReconnect.res.after.replay} ` +
      `serial=${staleReconnect.res.after.serial} 来源=${staleReconnect.res.after.kind} ` +
      `打开的端口=${staleReconnect.res.after.openPorts}｜错误=${staleReconnect.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  // A-5：BLE 订阅 await 期间换数据源（导入回放）—— 过期的订阅不得提交，
  //      监听必须摘干净、GATT 必须断开（复核 P1-A：只在订阅前检查世代时，完成后仍会提交
  //      ble=true，于是回放与 BLE 同时活、旧设备的通知继续往新实验灌帧）。
  //      这里不用「点串口按钮」：连接期间另一个连接按钮本来就是置灰的（真实 UI 约束）。
  const subscribeSwitch = await (async () => {
    const { pg, errs, stop } = await makeFakeSerialPage({ ble: "hang" });
    const res = await pg.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const NL = String.fromCharCode(10);
      document.getElementById("btn-ble").click();
      await sleep(900);
      const during = window.attitudeDemo.plumbing();
      // 订阅 await 期间换来源：导入日志（世代 +1）
      let csv = "t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut" + NL;
      for (let i = 0; i < 40; i++) {
        csv += `${(i * 0.02).toFixed(2)},1.5,0,0,0,0,9.8,32.8,0,37.7${NL}`;
      }
      const imp = window.attitudeDemo.replay.import(csv, "sub-switch.csv");
      await sleep(300);
      const afterSwitch = window.attitudeDemo.plumbing();
      window.__ble.releaseSubscribe(); // 放行那次过期的订阅
      await sleep(800);
      const settled = window.attitudeDemo.plumbing();
      window.attitudeDemo.replay.stop();
      await sleep(300);
      const final = window.attitudeDemo.plumbing();
      return {
        duringBle: during.ble,
        duringSerial: during.serial,
        imp,
        afterReplay: afterSwitch.replay,
        settledReplay: settled.replay,
        settledBle: settled.ble,
        settledSerial: settled.serial,
        listeners: window.__ble.count(),
        gattOff: window.__ble.device.gatt.connected === false,
        finalKind: final.sourceKind,
      };
    }, installFakeBle);
    await stop();
    await pg.close();
    return { res, errs };
  })();
  check(
    "连接所有权：BLE 订阅 await 期间换来源 → 过期订阅不提交、监听摘净、GATT 断开",
    subscribeSwitch.res.duringBle === false &&
      subscribeSwitch.res.duringSerial === false &&
      String(subscribeSwitch.res.imp).startsWith("ok:") &&
      subscribeSwitch.res.afterReplay === true &&
      subscribeSwitch.res.settledReplay === true &&
      subscribeSwitch.res.settledBle === false &&
      subscribeSwitch.res.settledSerial === false &&
      subscribeSwitch.res.listeners === 0 &&
      subscribeSwitch.res.gattOff === true &&
      subscribeSwitch.res.finalKind === "simulation" &&
      errsEmpty(subscribeSwitch.errs),
    `订阅挂起时 ble=${subscribeSwitch.res.duringBle} serial=${subscribeSwitch.res.duringSerial}；` +
      `导入=${subscribeSwitch.res.imp}（回放中 replay=${subscribeSwitch.res.afterReplay}）；` +
      `放行过期订阅后 ble=${subscribeSwitch.res.settledBle} serial=${subscribeSwitch.res.settledSerial} ` +
      `replay=${subscribeSwitch.res.settledReplay}、残留监听=${subscribeSwitch.res.listeners}、` +
      `过期 GATT 已断=${subscribeSwitch.res.gattOff}；退出回放后来源=${subscribeSwitch.res.finalKind}｜` +
      `错误=${subscribeSwitch.errs.slice(0, 2).join(" / ") || "无"}`,
  );

  } // devices 段结束
  if (runApp) {
  // ---------- 本轮新增：惯性导航 / 整定挑战 / 公式复制 / 打印样式 ----------
  // 这几个都是「画出来的东西」或「结构性行为」，光靠 tsc/自检覆盖不到，所以在真浏览器里点名验收。
  const extras = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    // ① 惯性导航面板：画布要有内容（不是一张空图），读数表要有行
    const insSec = document.getElementById("sec-ins");
    if (insSec?.classList.contains("collapsed")) insSec.querySelector(".panel-toggle").click();
    document.getElementById("imu-gyro-bias").value = "2";
    document.getElementById("imu-gyro-bias").dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(2500);
    const insCanvas = document.getElementById("ins-canvas");
    const g = insCanvas.getContext("2d");
    const px = g.getImageData(0, 0, insCanvas.width, insCanvas.height).data;
    let painted = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 60) painted++;
    }
    out.insCanvas = { w: insCanvas.width, paintedPixels: painted };
    out.insReadoutRows = document.querySelectorAll("#ins-readout .ir-name").length;
    out.insSummary = document.getElementById("sum-ins").textContent ?? "";

    // ② 整定挑战：三题在位、装载会改参数、样本不足时结算应拒绝
    const chSec = document.getElementById("sec-challenge");
    if (chSec?.classList.contains("collapsed")) chSec.querySelector(".panel-toggle").click();
    await sleep(200);
    out.challengeItems = document.querySelectorAll("#challenge-list .ch-item").length;
    document.querySelector('#challenge-list button[data-act="start"][data-ch="vibration-tune"]').click();
    await sleep(300);
    out.challengeLoaded = {
      beta: document.getElementById("madg-beta").value,
      scenario: document.getElementById("scenario-select").value,
      source: document.getElementById("source-select").value,
    };
    // 等「已装载」那条 toast 自然消失（2.4s）再结算，否则读到的还是它的文案
    await sleep(2600);
    document.querySelector('#challenge-list button[data-act="settle"][data-ch="vibration-tune"]').click();
    await sleep(250);
    // 「样本不够」是 toast 提示（不是面板里的 note），所以读 toast 层
    out.settleTooEarly = document.getElementById("toast-layer")?.innerText ?? "";

    return out;
  });
  // ③ 明确打开数学页，前置页/可见按钮/真实输入都留痕；反馈不是复制载荷的替代品。
  const formulaCopy = diagnostics.formulaCopy = { waitFailures: [], targetPage: "math", before: {},
    after: { selectedText: "", clipboardText: null, label: "" } };
  const formulaPageSelector = '#docs-overlay .doc-page[data-doc-page="math"]';
  const formulaNavSelector = '#docs-overlay .docs-toc .module-link[data-doc="math"]';
  // #math 确为 article；visible:true 不校验折叠 details 或点击命中，不能只换 id/延长等待。
  const readFormulaDom = () => page.evaluate((pageSelector, navSelector) => {
    const describe = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { tag: el.tagName, id: el.id, docPage: el.dataset.docPage, role: el.getAttribute("role"),
        hidden: el.hidden, hiddenAttr: el.getAttribute("hidden"), display: s.display,
        visibility: s.visibility, opacity: s.opacity,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        rendered: el.getClientRects().length > 0 && r.width > 0 && r.height > 0 &&
          s.display !== "none" && s.visibility !== "hidden" && !el.closest("[hidden]"),
        hit: hit ? { tag: hit.tagName, id: hit.id, className: String(hit.className) } : null,
        hitInside: Boolean(hit && el.contains(hit)) };
    };
    const overlay = document.getElementById("docs-overlay");
    const targets = [...document.querySelectorAll(pageSelector)];
    const nav = document.querySelector(navSelector), details = nav?.closest("details");
    return { overlay: describe(overlay), targetPages: targets.map(describe),
      currentDoc: [...document.querySelectorAll("#docs-overlay .doc-page:not([hidden])")].map((el) => el.dataset.docPage),
      activeModule: document.querySelector("#docs-overlay .module-link.active")?.dataset.doc,
      nav: describe(nav), details: details ? { id: details.id, open: details.open } : null,
      button: describe(targets[0]?.querySelector(".formula .formula-copy")),
      navigationInput: window.__formulaNavInput ?? null,
      viewport: { width: innerWidth, height: innerHeight }, overlayScrollTop: overlay?.scrollTop,
      docScrollTop: document.querySelector("#docs-overlay .doc-pages")?.scrollTop,
      hasFocus: document.hasFocus(), visibilityState: document.visibilityState,
      activeElementId: document.activeElement?.id ?? "", secureContext: isSecureContext,
      clipboard: { readText: typeof navigator.clipboard?.readText, writeText: typeof navigator.clipboard?.writeText } };
  }, formulaPageSelector, formulaNavSelector);
  // Node 计时采样，不依赖页面 rAF；原有 STATE_MS/3000 ms 额度不变。
  const waitFormulaState = async (phase, read, predicate, timeout) => {
    const start = nodePerformance.now();
    let state;
    do {
      state = await read();
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (nodePerformance.now() - start < timeout);
    formulaCopy.waitFailures.push({ phase, timeout, elapsedMs: nodePerformance.now() - start, state });
    throw new Error(`formula ${phase} 未满足（${timeout} ms）`);
  };
  // 只给测试 browser context 读剪贴板权限，实际写入仍由用户激活的原生 API 完成；不替换 clipboard。
  try {
    await browser.defaultBrowserContext().overridePermissions(new URL(APP_URL).origin, ["clipboard-read", "clipboard-write"]);
    formulaCopy.clipboardReadPermission = "granted in test browser context";
  } catch (e) { formulaCopy.clipboardReadPermission = String(e); }
  let formulaButton = null;
  try {
  await page.bringToFront();
  formulaCopy.navigationBefore = await readFormulaDom();
  await page.click("#btn-docs");
  const opened = await waitFormulaState("文档对话框打开", readFormulaDom,
    (s) => s.overlay?.hidden === false && s.overlay.rendered && s.overlay.role === "dialog", STATE_MS);
  if (opened.details?.open === false) await page.click("#toc-disclosure > summary");
  const navButton = await page.$(formulaNavSelector);
  if (!navButton) throw new Error("数学模块导航缺失");
  await navButton.evaluate((button) => button.scrollIntoView({ block: "center" }));
  formulaCopy.navigationReady = await waitFormulaState("数学模块导航可命中", readFormulaDom,
    (s) => s.nav?.rendered && s.nav.hitInside && s.details?.open !== false, STATE_MS);
  await navButton.evaluate((button) => {
    window.__formulaNavInput = null;
    button.addEventListener("click", (event) => { window.__formulaNavInput = { trusted: event.isTrusted,
      x: event.clientX, y: event.clientY, targetTag: event.target.tagName,
      targetDoc: event.target.closest(".module-link")?.dataset.doc, handlerAt: performance.now() }; },
    { capture: true, once: true });
  });
  await navButton.click();
  await navButton.dispose();
  formulaCopy.navigationAfter = await waitFormulaState("唯一当前数学页及公式按钮", readFormulaDom,
    (s) => s.navigationInput?.trusted === true && s.navigationInput.targetDoc === "math" &&
      s.currentDoc.length === 1 && s.currentDoc[0] === "math" && s.activeModule === "math" &&
      s.targetPages.length === 1 && s.targetPages[0].hidden === false && s.targetPages[0].rendered && s.button?.rendered, STATE_MS);
  formulaButton = await page.$(`${formulaPageSelector}:not([hidden]) .formula .formula-copy`);
  if (!formulaButton) throw new Error("当前数学页公式按钮缺失");
  await formulaButton.evaluate((button) => button.scrollIntoView({ block: "center" }));
  await formulaButton.hover();
  formulaCopy.buttonReady = await waitFormulaState("公式按钮悬停可见且可命中", readFormulaDom,
    (s) => s.currentDoc.length === 1 && s.currentDoc[0] === "math" &&
      s.button?.rendered && Number(s.button.opacity) > 0 && s.button.hitInside, 3000);
  formulaCopy.before = await formulaButton.evaluate((button) => {
    const blocks = [...document.querySelectorAll(".doc-page .formula")];
    const body = button?.parentElement.querySelector(".formula-body");
    const rect = button?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    return {
      formulaCount: blocks.length, buttonCount: document.querySelectorAll(".doc-page .formula-copy").length,
      oneButtonPerFormula: blocks.every((block) => block.querySelectorAll(".formula-copy").length === 1),
      bodiesExcludeButtons: blocks.every((block) => block.querySelector(".formula-body") && !block.querySelector(".formula-body .formula-copy")),
      expectedText: (body?.innerText || body?.textContent || "").replace(/\n{3,}/g, "\n\n").trim(),
      state: button?.dataset.copyState, label: button?.textContent ?? "",
      visible: Boolean(rect?.width && rect?.height && style?.visibility !== "hidden" && Number(style?.opacity) > 0),
      bodyContainsButton: Boolean(body?.querySelector("button")),
      mathHidden: button.closest('.doc-page[data-doc-page="math"]')?.hidden,
      visibilityState: document.visibilityState, hasFocus: document.hasFocus(), activeElementId: document.activeElement?.id ?? "",
    };
  });
  await formulaButton.evaluate((button) => {
    window.__formulaCopyInput = null;
    button.addEventListener("click", (event) => { window.__formulaCopyInput = { trusted: event.isTrusted,
      x: event.clientX, y: event.clientY,
      handlerAt: performance.now(), eventTimeStamp: event.timeStamp, hasFocus: document.hasFocus() }; }, { capture: true, once: true });
  });
  await formulaButton.click();
  try {
    await waitFormulaState("copy terminal state", () => formulaButton.evaluate((button) => ({
      state: button.dataset.copyState, label: button.textContent, input: window.__formulaCopyInput })),
    (s) => ["copied", "selected", "manual"].includes(s.state), 3000);
  } catch (e) { formulaCopy.terminalWaitError = String(e); }
  formulaCopy.after = await formulaButton.evaluate(async (button) => {
    const body = button?.parentElement.querySelector(".formula-body");
    const state = button?.dataset.copyState;
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    const selectionInsideBody = Boolean(selection?.rangeCount && body &&
      body.contains(selection.getRangeAt(0).startContainer) && body.contains(selection.getRangeAt(0).endContainer));
    let clipboardText = null, clipboardReason = null;
    if (state === "copied") {
      try {
        clipboardText = await Promise.race([navigator.clipboard.readText(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard read exceeded 1000 ms")), 1000))]);
      } catch (e) { clipboardReason = String(e); }
    }
    return { state, label: button?.textContent ?? "", selectedText, selectionInsideBody, clipboardText, clipboardReason,
      input: window.__formulaCopyInput, hasFocus: document.hasFocus(), visibilityState: document.visibilityState,
      bodyContainsButton: Boolean(body?.querySelector("button")),
      style: { opacity: button ? getComputedStyle(button).opacity : null, ariaLive: button?.getAttribute("aria-live") } };
  });
  } catch (e) {
    formulaCopy.error = String(e);
    formulaCopy.waitFailures.push({ phase: "navigation/copy", reason: String(e) });
    try { formulaCopy.failureDom = await readFormulaDom(); }
    catch (snapshotError) { formulaCopy.failureDomError = String(snapshotError); }
  } finally {
    await formulaButton?.dispose();
    try { await page.screenshot({ path: join(shots, "formula-copy-feedback.png") }); }
    catch (e) { formulaCopy.screenshotError = String(e); }
    // 导航失败仍报原公式断言并继续套件；Esc 不依赖滚动后关闭按钮的坐标。
    if (await page.evaluate(() => document.getElementById("docs-overlay")?.hidden === false)) await page.keyboard.press("Escape");
    await browser.defaultBrowserContext().clearPermissionOverrides();
  }
  check(
    "惯性导航面板：画布有内容 + 读数表 + 摘要",
    extras.insCanvas.paintedPixels > 200 &&
      extras.insCanvas.w > 100 &&
      extras.insReadoutRows === 5 &&
      /漂移/.test(extras.insSummary),
    `画布 ${extras.insCanvas.w}px 宽、${extras.insCanvas.paintedPixels} 个非背景像素；读数 ${extras.insReadoutRows} 行；摘要「${extras.insSummary}」`,
  );
  check(
    "参数整定挑战：三题在位 + 装载生效 + 样本不足拒绝结算",
    extras.challengeItems === 3 &&
      extras.challengeLoaded.beta === "0.1" &&
      extras.challengeLoaded.scenario === "hover" &&
      extras.challengeLoaded.source === "madg" &&
      extras.settleTooEarly.includes("样本不够"),
    `${extras.challengeItems} 题；装载后 β=${extras.challengeLoaded.beta} / 剧本=${extras.challengeLoaded.scenario} / 来源=${extras.challengeLoaded.source}；` +
      `样本不足时结算提示「${extras.settleTooEarly.trim().slice(0, 16)}…」`,
  );
  const copyState = formulaCopy.after.state;
  const copyPayloadCorrect = copyState === "copied"
    ? formulaCopy.after.label === "已复制" && formulaCopy.after.clipboardText === formulaCopy.before.expectedText
    : copyState === "selected"
      ? formulaCopy.after.label === "已选中，请按 Ctrl+C" && formulaCopy.after.selectionInsideBody &&
        formulaCopy.after.selectedText.replace(/\n{3,}/g, "\n\n").trim() === formulaCopy.before.expectedText
      : copyState === "manual" && formulaCopy.after.label === "请手动选中并按 Ctrl+C" &&
        formulaCopy.after.selectedText === "";
  formulaCopy.payloadCorrect = copyPayloadCorrect;
  formulaCopy.reason = formulaCopy.error ?? (copyState === "manual" ? "自动复制/选中不可用，明确提示手动操作，未声称复制成功"
    : copyPayloadCorrect ? "真实载荷与公式正文一致" : formulaCopy.after.clipboardReason ?? "终态标签或真实 selection/clipboard 与正文不一致");
  formulaCopy.checkName = "公式一键复制：数学页可见按钮真实点击，状态与真实载荷一致且正文无按钮污染";
  check(
    "公式一键复制：数学页可见按钮真实点击，状态与真实载荷一致且正文无按钮污染",
    formulaCopy.before.formulaCount > 20 && formulaCopy.before.oneButtonPerFormula &&
      formulaCopy.before.bodiesExcludeButtons && formulaCopy.before.buttonCount === formulaCopy.before.formulaCount &&
      formulaCopy.before.visible && formulaCopy.before.mathHidden === false &&
      (formulaCopy.before.expectedText?.length ?? 0) > 0 && !formulaCopy.after.bodyContainsButton &&
      formulaCopy.after.input?.trusted === true && formulaCopy.waitFailures.length === 0 && copyPayloadCorrect,
    `${formulaCopy.before.formulaCount} 个公式均一个按钮；状态 ${copyState ?? "缺失"} /「${formulaCopy.after.label}」；` +
      `真实selection ${formulaCopy.after.selectedText.length} 字、clipboard ${formulaCopy.after.clipboardText?.length ?? "不可读"} 字；${formulaCopy.reason}`,
  );

  // A/B + 挑战的组合语义：基线会关掉 A/B，但必须明说（否则「参数对比中」的实验语义含混）
  const abChallenge = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const abToggle = document.getElementById("ab-toggle");
    if (!abToggle.checked) {
      abToggle.checked = true;
      abToggle.dispatchEvent(new Event("change"));
      await sleep(120);
    }
    const onBefore = window.attitudeDemo.ab().on;
    document.getElementById("sec-challenge").classList.remove("collapsed");
    const btn = document.querySelector("#challenge-list button[data-ch]");
    btn.click();
    await sleep(250);
    const noteText = document.getElementById("challenge-note")?.textContent ?? "";
    return { onBefore, onAfter: window.attitudeDemo.ab().on, noteText, frozen: window.attitudeDemo.ab().frozen };
  });
  check(
    "挑战 + A/B 组合：基线关闭 A/B 并在提示里说明（不留含混语义）",
    abChallenge.onBefore && !abChallenge.onAfter && abChallenge.noteText.includes("关闭了 A/B"),
    `装载前 A/B=${abChallenge.onBefore}、装载后=${abChallenge.onAfter}；提示含说明=${abChallenge.noteText.includes("关闭了 A/B")}`,
  );

  // ④ 打印媒体：应用外壳必须消失、只剩文档正文（这是「存 PDF 发讲义」的前提）
  const printCase = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 900, height: 1200 });
    await gotoSafe(pg);
    await pg.click("#btn-docs");
    await new Promise((r) => setTimeout(r, 500));
    await pg.evaluate(() => document.querySelector('.docs-toc .module-link[data-doc="trouble"]').click());
    await new Promise((r) => setTimeout(r, 400));
    await pg.emulateMediaType("print");
    await new Promise((r) => setTimeout(r, 200));
    const res = await pg.evaluate(() => {
      const size = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      };
      return {
        panel: size("#panel"),
        viewport: size("#viewport"),
        charts: size("#charts"),
        docShell: size(".docs-shell"),
        visiblePages: [...document.querySelectorAll(".doc-page")].filter((p) => getComputedStyle(p).display !== "none").length,
        bodyOverflow: getComputedStyle(document.body).overflow,
      };
    });
    await pg.close();
    return res;
  })();
  check(
    "打印样式：应用外壳隐藏、只剩当前文档页",
    printCase.panel?.[0] === 0 &&
      printCase.viewport?.[0] === 0 &&
      printCase.charts?.[0] === 0 &&
      (printCase.docShell?.[1] ?? 0) > 500 &&
      printCase.visiblePages === 1 &&
      printCase.bodyOverflow === "visible",
    `面板 ${printCase.panel} / 视口 ${printCase.viewport} / 曲线 ${printCase.charts}（应全为 0）；` +
      `文档正文 ${printCase.docShell}；可见分页 ${printCase.visiblePages}；body overflow=${printCase.bodyOverflow}`,
  );

  // ⑤ 能力提示：Firefox / Safari 没有 Web Serial 与 Web Bluetooth。
  //    本机浏览器是 Chromium，两个 API 天然存在，所以这里在文档创建阶段
  //    把 navigator 上的它们删掉，模拟非 Chromium 环境，再断言提示与置灰。
  const capCase = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 900 });
    await pg.evaluateOnNewDocument(() => {
      // 属性定义在 Navigator.prototype 上，delete navigator.serial 没用
      for (const k of ["serial", "bluetooth"]) {
        try {
          delete Navigator.prototype[k];
        } catch {
          /* 不可配置就退化为定义成 undefined 属性 */
        }
        if (k in navigator) Object.defineProperty(navigator, k, { value: undefined, configurable: true });
      }
    });
    await gotoSafe(pg);
    await new Promise((r) => setTimeout(r, 600));
    const res = await pg.evaluate(() => {
      document.getElementById("sec-imu")?.classList.remove("collapsed"); // 面板默认折叠，展开后才能量到 display
      const box = document.getElementById("cap-notice");
      return {
        visible: !box.classList.contains("hidden") && getComputedStyle(box).display !== "none",
        title: document.getElementById("cap-notice-title").textContent,
        body: document.getElementById("cap-notice-body").textContent,
        serialOff: document.getElementById("btn-serial").disabled,
        bleOff: document.getElementById("btn-ble").disabled,
        serialTitle: document.getElementById("btn-serial").title,
        simOk: !document.getElementById("scenario-select").disabled,
      };
    });
    await pg.close();
    return res;
  })();
  check(
    "非 Chromium 能力提示：面板说明 + 连接按钮置灰（模拟功能不受影响）",
    capCase.visible &&
      capCase.serialOff &&
      capCase.bleOff &&
      capCase.title.includes("Web Serial") &&
      capCase.title.includes("Web Bluetooth") &&
      capCase.simOk,
    `可见=${capCase.visible} 串口置灰=${capCase.serialOff} BLE 置灰=${capCase.bleOff}；标题「${capCase.title}」；${capCase.body}`,
  );

  // ⑤ 引导课程：走完全部 13 步（用界面上的真实按钮，不走调试接口）。
  //    每一步都会装载实验 / 切视图 / 展开面板，所以这条用例同时覆盖了
  //    「实验库的 id 在课程里没写错」「视图确实切过去了」「走完能正常收尾」。
  const tourCase = diagnostics.tourCase = { steps: [], waits: [], waitFailures: [], done: false,
    restored: false, restarted: "", closed: false };
  // 宿主 applyExperiment(id): void → applyExperiment(spec): void、applyView 及 render 都是同步的。
  // 真正异步的是首次 ensureTour()；静态 HTML 的 counter 已写「第 1 / 13 步」，但标题/正文为空。
  // 旧用例冷加载等待耗尽仍 push 空快照、点未绑定的 next，13 个 unique 可包含空标题，整列错位一格。
  const tourTargets = [
    { view: "attitude", panel: "scenario" },
    { view: "attitude", source: "pure", scenario: "hover", exp: "drift" },
    { view: "attitude", source: "pure", scenario: "hover", exp: "drift" },
    { view: "attitude", source: "mahony", scenario: "violent", exp: "gate", panel: "algo", gate: true },
    { view: "attitude", source: "mahony", scenario: "composite", exp: "magnetic", mag: true },
    { view: "attitude", source: "mahony", scenario: "composite", exp: "margFull", mag: true, magMode: "full" },
    { view: "attitude", source: "kalman", scenario: "hover", exp: "kalman-tuning", panel: "telemetry" },
    { view: "gimbal", source: "kalman", scenario: "hover", exp: "gimbal" },
    { view: "attitude", source: "comp", scenario: "pitchHold", exp: "lockAlgo" },
    { view: "quat", source: "comp", scenario: "hover", exp: "slerp", quatMode: "interp", pair: "combo" },
    { view: "quat", source: "comp", scenario: "hover", exp: "proj", quatMode: "proj" },
    { view: "quat", source: "comp", scenario: "hover", exp: "proj", quatMode: "proj", panel: "ins" },
    { view: "quat", source: "comp", scenario: "hover", exp: "proj", quatMode: "proj", panel: "challenge" },
  ];
  const readTourDom = () => page.evaluate(() => ({
    counter: document.getElementById("tour-counter").textContent,
    title: document.getElementById("tour-title").textContent,
    body: document.getElementById("tour-body").textContent.length,
    view: document.body.dataset.view,
    activeView: document.querySelector("#view-seg .seg-btn.active")?.dataset.view,
    source: document.getElementById("source-select").value,
    scenario: document.getElementById("scenario-select").value,
    imuMode: document.body.dataset.imuMode,
    scenarioDisabled: document.getElementById("scenario-select").disabled,
    exp: document.querySelector("#experiment-list button.active")?.dataset.exp,
    gate: document.getElementById("gate-toggle").checked,
    mag: document.getElementById("mag-enable").checked,
    magMode: document.getElementById("mag-mode").value,
    quatMode: document.getElementById("quat-mode").value,
    pair: document.getElementById("quat-pair-select").value,
    panels: Object.fromEntries([...document.querySelectorAll("#panel .panel-section")].map((sec) =>
      [sec.dataset.section, !sec.classList.contains("collapsed") &&
        sec.querySelector(".panel-toggle")?.getAttribute("aria-expanded") === "true"])),
    cardVisible: !document.getElementById("tour-card").classList.contains("hidden"),
    introHidden: document.getElementById("tour-intro").classList.contains("hidden"),
    startRowHidden: document.getElementById("tour-start-row").classList.contains("hidden"),
    next: document.getElementById("tour-next").textContent,
    prevDisabled: document.getElementById("tour-prev").disabled,
    controller: window.attitudeDemo?.tour?.info,
    visibilityState: document.visibilityState,
  }));
  // 页面状态使用3秒预算，命令传输采用既有STATE_MS，并分别记录。
  const boundTour = async (phase, operation, timeout = STATE_MS) => {
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`tour ${phase} 超过 ${timeout} ms`)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const waitTourState = async (phase, predicate) => {
    const start = nodePerformance.now(), timeout = 3000;
    let state;
    try {
      while (nodePerformance.now() - start < timeout) {
        const readingAt = nodePerformance.now();
        state = await boundTour(phase, readTourDom);
        const receivedAt = nodePerformance.now();
        tourCase.waits.push({ phase: `${phase} CDP读取`, elapsedMs: receivedAt - readingAt, state });
        if (predicate(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, timeout - (nodePerformance.now() - start)))));
      }
      throw new Error(`tour ${phase} 未满足（${timeout} ms）`);
    } catch (e) {
      tourCase.waitFailures.push({ phase, timeout, elapsedMs: nodePerformance.now() - start, state, error: String(e) });
      throw e;
    }
  };
  const matchesTourStep = (s, k) => {
    const match = /^第 (\d+) \/ 13 步 · 约 \d+ s$/.exec(s.counter);
    const target = tourTargets[k];
    return Number(match?.[1]) === k + 1 && s.title.trim().length > 0 && s.body > 80 &&
      s.cardVisible && s.introHidden && s.startRowHidden && s.imuMode === "sim" && !s.scenarioDisabled &&
      s.activeView === target.view && s.next === (k === 12 ? "完成" : "下一步") && s.prevDisabled === (k === 0) &&
      Object.entries(target).every(([key, value]) => key === "panel" ? s.panels[value] === true : s[key] === value);
  };
  const clickTour = (id) => boundTour(`点击 ${id}`, () => page.evaluate((buttonId) => {
    document.getElementById(buttonId).click();
  }, id));
  const tourExited = (s) => !s.cardVisible && !s.introHidden && !s.startRowHidden;
  try {
    tourCase.before = await boundTour("起始现场", readTourDom);
    await boundTour("展开课程面板", () => page.evaluate(() => {
      const sec = document.getElementById("sec-tour");
      if (sec.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
    }));
    await clickTour("tour-start");
    for (let k = 0; k < 13; k++) {
      // 只有精确第 k+1 步与该步目标现场同时成立才计入；不因超时补点或沿用旧快照。
      tourCase.steps.push(await waitTourState(`第 ${k + 1}/13 步现场`, (s) => matchesTourStep(s, k)));
      if (k < 12) await clickTour("tour-next");
    }
    // 最后一次点的是「完成」：exit 不改 counter，不能再等 counter 变化。
    await clickTour("tour-next");
    tourCase.finished = await waitTourState("完成后收起与入口恢复", tourExited);
    tourCase.done = !tourCase.finished.cardVisible;
    tourCase.restored = !tourCase.finished.introHidden && !tourCase.finished.startRowHidden;
    await clickTour("tour-start");
    tourCase.restartState = await waitTourState("重开精确第 1 步", (s) => matchesTourStep(s, 0));
    tourCase.restarted = tourCase.restartState.counter;
    await clickTour("tour-close");
    tourCase.closeState = await waitTourState("关闭后收起与入口恢复", tourExited);
    tourCase.closed = !tourCase.closeState.cardVisible;
  } catch (e) {
    // 原断言必须 FAIL，完整现场留 diagnostics；清理不能补成 done/restored/closed=true。
    tourCase.error = String(e);
    try { await clickTour("tour-close"); }
    catch (cleanupError) { tourCase.cleanupError = String(cleanupError); }
  }
  const walked = tourCase.steps;
  check(
    "引导课程：13 步逐条装载现场（实验/视图/面板）并正常收尾",
    !tourCase.error && tourCase.waitFailures.length === 0 &&
      walked.length === 13 &&
      new Set(walked.map((s) => s.title)).size === 13 &&
      walked.every(matchesTourStep) &&
      tourCase.done && tourCase.restored &&
      tourCase.restarted.startsWith("第 1 / 13 步") && tourCase.closed,
    `${walked.length} 步；标题去重 ${new Set(walked.map((s) => s.title)).size}；` +
      `第 2 步来源=${walked[1]?.source}（应 pure）；第 8/11 步视图=${walked[7]?.view}/${walked[10]?.view}（应 gimbal/quat）；` +
      `走完自动收起=${tourCase.done}、开始入口恢复=${tourCase.restored}；✕ 可退出=${tourCase.closed}；` +
      `等待失败=${tourCase.waitFailures.length}${tourCase.error ? `；${tourCase.error}` : ""}`,
  );

  // ⑥ 应用界面里的「见文档·…」链接（a[data-doc-open]）：从面板直接跳进文档对应页。
  //    这条路径曾经是坏的——文档内的锚点跳转委托在 docPagesEl / chapterToc 上，
  //    而面板里的链接不在那个容器里，事件不会冒泡过去，点了完全没反应（改字体时实测抓到）。
  const docJump = await page.evaluate(async () => {
    document.getElementById("sec-imu").classList.remove("collapsed");
    const a = document.querySelector("a[data-doc-open]");
    if (!a) return { found: false };
    const wanted = a.dataset.docOpen;
    a.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      found: true,
      wanted,
      docsOpen: !document.getElementById("docs-overlay").hidden,
      visiblePage: document.querySelector(".doc-page:not([hidden])")?.dataset.docPage,
      activeModule: document.querySelector(".module-link.active")?.dataset.doc,
    };
  });
  check(
    "面板里的「见文档」链接能打开文档层并切到目标页",
    docJump.found && docJump.docsOpen && docJump.visiblePage === docJump.wanted && docJump.activeModule === "guide",
    `链接→${docJump.wanted}；文档层打开=${docJump.docsOpen}；当前页=${docJump.visiblePage}；左栏高亮=${docJump.activeModule}`,
  );
  await page.evaluate(() => document.getElementById("btn-docs-close").click());

  // ---------- 装配层健壮性：数值框接线 / 连接防重入 / 监听器不叠加 / 通路互斥 ----------
  // 这一组用例来自一次专门找「测试盲区」的审计。下面每一类缺陷的共同点是
  // **原有断言全部通过**——因为原有断言只验证「正常路径下功能可用」，
  // 而这四类都发生在正常路径之外，或者被「比现实更宽容的 mock」掩盖了。

  // ① 每个滑杆的数值框都必须真的可键入。
  //    「方向阈值 / 幅度阈值」那两个框原先没有任何监听、且永远是空的（只有滑杆生效）；
  //    而 htmlcheck 的「滑块三件套完整」只查 data-num / data-step 是否存在，查不出没接线。
  const numBoxes = await page.evaluate(async () => {
    const bad = [];
    const rows = [...document.querySelectorAll(".slider-row")].filter((r) => r.querySelector("input[data-num]"));
    for (const row of rows) {
      const range = row.querySelector('input[type="range"]');
      const num = row.querySelector("input[data-num]");
      const label = (row.querySelector("label")?.textContent ?? "?").trim();
      if (!range || !num) continue;
      const before = range.value;
      const wasEmpty = num.value.trim() === "";
      if (wasEmpty) bad.push(label + "(初始为空)");
      const min = parseFloat(range.min);
      const max = parseFloat(range.max);
      // 目标值取量程另一端（远离当前值，确保能观察到变化）
      const target = Math.abs(parseFloat(range.value) - min) > Math.abs(parseFloat(range.value) - max) ? min : max;
      num.value = String(target);
      num.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      if (Math.abs(parseFloat(range.value) - target) > 1e-6) bad.push(label + "→滑杆没跟随");
      // 还原，避免影响后续用例
      num.value = before;
      num.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    }
    return { total: rows.length, bad };
  });
  check(
    "每个滑杆的数值框都已接线（键入即生效、初始就有读数）",
    numBoxes.total >= 25 && numBoxes.bad.length === 0,
    numBoxes.total + " 个滑杆数值框" + (numBoxes.bad.length ? "，异常：" + numBoxes.bad.join("、") : "全部可键入"),
  );

  // ② 串口连接防重入：连点两次不能让「状态标志」与「真实端口」脱钩。
  //    假端口让 open() 延迟 250 ms —— 正是第二次点击能落进去的窗口。
  const reentryCase = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1100, height: 800 });
    const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      const stream = new ReadableStream({
        start(c) {
          let seq = 0;
          setInterval(() => {
            const d = new Uint8Array(28);
            d[0] = 0xaa; d[1] = 0x55; d[2] = 24;
            d[3] = seq & 0xff; d[5] = (seq * 5) & 0xff;
            d[9] = 15; d[19] = 0xe4; d[21] = 0x0d; d[25] = 0x14;
            let crc = 0;
            for (let i = 2; i < 27; i++) crc ^= d[i];
            d[27] = crc;
            seq++;
            c.enqueue(d);
          }, 5);
        },
      });
      const port = {
        open: async () => new Promise((r) => setTimeout(r, 250)),
        close: async () => undefined,
        get readable() { return stream; },
      };
      window.__requestPortCalls = 0;
      Object.defineProperty(navigator, "serial", {
        configurable: true,
        value: { requestPort: async () => { window.__requestPortCalls++; return port; } },
      });
    });
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const btn = document.getElementById("btn-serial");
      btn.click();
      btn.click(); // 第二次落在 open() 的 await 窗口里
    });
    await new Promise((r) => setTimeout(r, 1500));
    const res = await pg.evaluate(() => ({
      calls: window.__requestPortCalls,
      status: document.getElementById("serial-status")?.textContent ?? "",
      plumbing: window.attitudeDemo.plumbing(),
    }));
    await pg.close();
    return { ...res, errs };
  })();
  check(
    "串口连接防重入：连点两次只发起一次连接，状态不与真实端口脱钩",
    reentryCase.calls === 1 &&
      reentryCase.plumbing.serial === true &&
      reentryCase.plumbing.connecting === false &&
      !/失败|中断/.test(reentryCase.status) &&
      errsEmpty(reentryCase.errs),
    "requestPort 调用 " + reentryCase.calls + " 次（应 1）；running=" + reentryCase.plumbing.serial +
      " connecting=" + reentryCase.plumbing.connecting + "；状态「" + reentryCase.status + "」",
  );

  // ③ BLE 重复订阅不叠加监听：反复重订阅后，一条通知只能产生一帧。
  //    假特征现在是**忠实的 EventTarget**（累积监听 + 支持移除），所以在缺少
  //    removeEventListener 的实现上，这里会看到帧数 +N 而断言失败——那正是实测过的
  //    「切换特征来回一次、帧率翻倍」。
  const makeFakeBlePage = async (extraWire) => {
    const pg = await newPage();
    await pg.setViewport({ width: 1100, height: 800 });
    const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(
      (extra) => {
        const listeners = [];
        const char = {
          uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
          properties: { notify: true },
          value: null,
          startNotifications: async () => char,
          stopNotifications: async () => char,
          addEventListener: (t, cb) => { if (t === "characteristicvaluechanged") listeners.push(cb); },
          removeEventListener: (t, cb) => {
            if (t !== "characteristicvaluechanged") return;
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
        const device = {
          name: "FAKE-BLE", id: "fake-1",
          gatt: {
            connected: true,
            connect: async () => ({ getPrimaryService: async () => ({ getCharacteristics: async () => [char] }) }),
            disconnect: () => undefined,
          },
          addEventListener: () => undefined,
        };
        Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
        window.__listeners = listeners;
        window.__emit = (text) => {
          const b = new TextEncoder().encode(text);
          char.value = new DataView(b.buffer, b.byteOffset, b.byteLength);
          for (const cb of [...listeners]) cb({ target: char });
        };
        if (extra) new Function(extra)();
      },
      extraWire ?? "",
    );
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const sel = document.getElementById("serial-protocol");
      sel.value = "text";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("btn-ble").click();
    });
    await pg.waitForFunction(() => window.attitudeDemo.plumbing().ble === true, { timeout: STATE_MS });
    return { pg, errs };
  };

  const bleDouble = await (async () => {
    const { pg, errs } = await makeFakeBlePage();
    const res = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sel = document.getElementById("ble-char");
      // 「重选同一个特征」三次：每次都走一遍 bleSubscribe
      for (let i = 0; i < 3; i++) sel.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(300);
      const listeners = window.__listeners.length;
      const f0 = window.attitudeDemo.plumbing().frames;
      // 文本协议认 6/9/10 列，7 列会被判成坏行——这里用 10 列（t + 陀螺 3 + 加计 3 + 磁 3）
      window.__emit("7,1,2,3,4,5,6,7,8,9" + String.fromCharCode(10));
      await wait(150);
      return { listeners, delta: window.attitudeDemo.plumbing().frames - f0, badLines: window.attitudeDemo.plumbing().badLines };
    });
    await pg.close();
    return { res, errs };
  })();
  check(
    "BLE 重复订阅不叠加监听：3 次重订阅后一条通知只产生 1 帧",
    bleDouble.res.listeners === 1 && bleDouble.res.delta === 1 && errsEmpty(bleDouble.errs),
    "监听器数 " + bleDouble.res.listeners + "（应恒为 1）；一条通知带来的帧数增量 " + bleDouble.res.delta + "（应 1）",
  );

  // ③a BLE 连接主动超时后，**迟到的** GATT 连接必须由本次尝试自己断开（SW-05）。
  //     复核反例：旧的 setup 闭包在 stale 时只 `return`，物理上留下一条无人管理的 GATT 连接，
  //     而应用认为"已断开"。这里让 gatt.connect() 永不落定，等主动超时后再放行，验证自清理。
  const bleLateConnect = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1100, height: 800 });
    const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      let releaseConnect = null;
      const char = {
        uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
        properties: { notify: true },
        value: null,
        startNotifications: async () => char,
        stopNotifications: async () => char,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      const server = { getPrimaryService: async () => ({ getCharacteristics: async () => [char] }) };
      const device = {
        name: "FAKE-BLE", id: "fake-hang",
        gatt: {
          connected: false,
          connect: () => new Promise((res) => { releaseConnect = () => { device.gatt.connected = true; res(server); }; }),
          disconnect: () => { device.gatt.connected = false; },
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
      window.__late = { gattConnected: () => device.gatt.connected, releaseConnect: () => releaseConnect?.() };
    });
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    const res = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sec = document.getElementById("sec-imu");
      if (sec.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      document.getElementById("btn-ble").click();
      const deadline = performance.now() + 25000;
      let timedOut = false;
      while (performance.now() < deadline) {
        if (/超时/.test(document.getElementById("ble-status")?.textContent ?? "")) { timedOut = true; break; }
        await wait(200);
      }
      const during = { status: document.getElementById("ble-status")?.textContent ?? "", ...window.attitudeDemo.plumbing() };
      // 迟到的 GATT 连接现在才落定
      window.__late.releaseConnect();
      const cleanDeadline = performance.now() + 8000;
      let after = window.attitudeDemo.plumbing();
      while (performance.now() < cleanDeadline) {
        after = window.attitudeDemo.plumbing();
        if (after.pendingBleCleanup === 0 && !window.__late.gattConnected()) break;
        await wait(200);
      }
      return { timedOut, during, after, gattConnected: window.__late.gattConnected() };
    });
    await pg.close();
    return { res, errs };
  })();
  check(
    "BLE 连接超时：迟到的 GATT 连接必须自己断开（不留无人管理的连接）",
    bleLateConnect.res.timedOut &&
      bleLateConnect.res.during.connecting === false &&
      bleLateConnect.res.after.ble === false &&
      bleLateConnect.res.after.pendingBleCleanup === 0 &&
      bleLateConnect.res.gattConnected === false &&
      errsEmpty(bleLateConnect.errs),
    `观测到主动超时=${bleLateConnect.res.timedOut}（状态「${bleLateConnect.res.during.status.slice(0, 40)}」）；` +
      `超时后 connecting=${bleLateConnect.res.during.connecting}、ble=${bleLateConnect.res.during.ble}；` +
      `迟到 connect 落定后 gatt.connected=${bleLateConnect.res.gattConnected}（应 false）、ble=${bleLateConnect.res.after.ble}、待清理=${bleLateConnect.res.after.pendingBleCleanup || 0}`,
  );

  // ②b BLE 断线自动重连：GATT 掉线 → 退避重连并订回**同一个**服务/特征；主动断开不重连
  const bleReconnect = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 800 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      const listeners = [];
      const char = {
        uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
        properties: { notify: true },
        value: null,
        startNotifications: async () => char,
        stopNotifications: async () => char,
        addEventListener: (t, cb) => { if (t === "characteristicvaluechanged") listeners.push(cb); },
        removeEventListener: (t, cb) => {
          if (t !== "characteristicvaluechanged") return;
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
      const services = { "0000ffe0-0000-1000-8000-00805f9b34fb": char };
      window.__ble = { connects: 0, serviceReqs: [], deviceListeners: [] };
      const device = {
        name: "FAKE-BLE", id: "fake-reconnect",
        gatt: {
          connect: async () => {
            window.__ble.connects++;
            return {
              getPrimaryService: async (uuid) => {
                window.__ble.serviceReqs.push(uuid);
                const c = services[uuid];
                if (!c) throw new Error("找不到服务 " + uuid);
                return { getCharacteristics: async () => [c] };
              },
            };
          },
          disconnect: () => undefined,
        },
        addEventListener: (t, cb) => { if (t === "gattserverdisconnected") window.__ble.deviceListeners.push(cb); },
        removeEventListener: (t, cb) => {
          if (t !== "gattserverdisconnected") return;
          const i = window.__ble.deviceListeners.indexOf(cb);
          if (i >= 0) window.__ble.deviceListeners.splice(i, 1);
        },
      };
      Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
      // 模拟「设备离开范围 / 关机」：GATT 掉线事件
      window.__bleDrop = () => { for (const cb of [...window.__ble.deviceListeners]) cb(); };
    });
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const sel = document.getElementById("serial-protocol");
      sel.value = "text";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("btn-ble").click();
    });
    await pg.waitForFunction(() => window.attitudeDemo.plumbing().ble === true, { timeout: STATE_MS });
    const first = await pg.evaluate(() => ({
      connects: window.__ble.connects,
      charRow: !document.getElementById("ble-char-row")?.classList.contains("hidden"),
      status: document.getElementById("ble-status")?.textContent ?? "",
    }));
    // 掉线 → 等自动重连成功
    await pg.evaluate(() => window.__bleDrop());
    await pg.waitForFunction(() => window.attitudeDemo.plumbing().bleReconnects >= 1, { timeout: SLOW_MS(12000) });
    const afterDrop = await pg.evaluate(() => ({
      connects: window.__ble.connects,
      services: window.__ble.serviceReqs,
      reconnects: window.attitudeDemo.plumbing().bleReconnects,
      ble: window.attitudeDemo.plumbing().ble,
      status: document.getElementById("ble-status")?.textContent ?? "",
    }));
    // 主动断开：不得再触发重连
    await pg.evaluate(() => document.getElementById("btn-ble").click());
    await new Promise((r) => setTimeout(r, 2600));
    const afterManual = await pg.evaluate(() => ({
      connects: window.__ble.connects,
      reconnects: window.attitudeDemo.plumbing().bleReconnects,
      ble: window.attitudeDemo.plumbing().ble,
      button: document.getElementById("btn-ble")?.textContent ?? "",
    }));
    await pg.close();
    return { first, afterDrop, afterManual, errs };
  })();
  const sameService =
    bleReconnect.afterDrop.services.length >= 2 &&
    bleReconnect.afterDrop.services.every((u) => u === bleReconnect.afterDrop.services[0]);
  check(
    "BLE 断线自动重连：GATT 掉线后退避重连、订回同一服务/特征；主动断开不重连",
    bleReconnect.first.connects === 1 && bleReconnect.first.charRow &&
      bleReconnect.afterDrop.reconnects >= 1 && bleReconnect.afterDrop.ble === true &&
      bleReconnect.afterDrop.connects >= 2 && sameService &&
      bleReconnect.afterManual.connects === bleReconnect.afterDrop.connects &&
      bleReconnect.afterManual.ble === false &&
      !bleReconnect.afterManual.button.includes("断开") &&
      errsEmpty(bleReconnect.errs),
    `连接 ${bleReconnect.first.connects} 次 → 掉线后重连 ${bleReconnect.afterDrop.reconnects} 次（connect 共 ${bleReconnect.afterDrop.connects}、` +
      `服务请求 ${JSON.stringify(bleReconnect.afterDrop.services)}）；主动断开后 connect=${bleReconnect.afterManual.connects}、` +
      `ble=${bleReconnect.afterManual.ble}、按钮「${bleReconnect.afterManual.button}」`,
  );

  // ④ 三条数据通路互斥 + 缓冲清理：导入回放必须断开 BLE；切换安装方向必须清空文本缓冲。
  const plumbingCase = await (async () => {
    const { pg, errs } = await makeFakeBlePage();
    const res = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__emit("1,0,0"); // 半行（无换行）→ 应停留在文本缓冲里
      await wait(150);
      const withPartial = window.attitudeDemo.plumbing();
      const mnt = document.getElementById("serial-mounting");
      mnt.value = "y-front-x-left";
      mnt.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(80);
      const afterMount = window.attitudeDemo.plumbing();
      const csv = ["t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2"];
      for (let k = 0; k < 60; k++) csv.push((k / 100).toFixed(3) + ",0,0,0,0,0,9.80665");
      window.attitudeDemo.replay.import(csv.join(String.fromCharCode(10)), "plumbing.csv");
      await wait(250);
      const afterReplay = window.attitudeDemo.plumbing();
      window.attitudeDemo.replay.stop();
      await wait(150);
      return { withPartial, afterMount, afterReplay, final: window.attitudeDemo.plumbing() };
    });
    await pg.close();
    return { res, errs };
  })();
  check(
    "三条数据通路互斥 + 切换安装方向清空文本缓冲",
    plumbingCase.res.withPartial.text > 0 &&
      plumbingCase.res.afterMount.text === 0 &&
      plumbingCase.res.afterReplay.ble === false &&
      plumbingCase.res.afterReplay.replay === true &&
      plumbingCase.res.final.replay === false &&
      errsEmpty(plumbingCase.errs),
    "半行缓冲 " + plumbingCase.res.withPartial.text + " → 切换安装方向后 " + plumbingCase.res.afterMount.text + "（应 0）；" +
      "导入回放后 ble=" + plumbingCase.res.afterReplay.ble + "（应 false）replay=" + plumbingCase.res.afterReplay.replay,
  );

  // ---------- 枚举与预设：每个选项都得真的能用 ----------
  // htmlcheck 守的是「HTML 选项与代码权威列表一致」这个静态契约；这里守运行期：
  // 每个器件预设都要真的写入参数（有 4 个预设、其中 2 个只改噪声/零偏），
  // 运行期填充的下拉必须真的填上了，解算频率的每个档位都能被接受。
  const enumsCase = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const secImu = document.getElementById("sec-imu");
    if (secImu.classList.contains("collapsed")) secImu.querySelector(".panel-toggle").click();
    const preset = document.getElementById("imu-preset");
    const note = document.getElementById("imu-preset-note");
    const probe = () => [
      document.getElementById("imu-gyro-bias").value,
      document.getElementById("imu-gyro-noise").value,
      document.getElementById("imu-accel-noise").value,
      document.getElementById("imu-mag-quant").value,
    ].join("|");
    const rows = [];
    for (const opt of [...preset.options]) {
      preset.value = opt.value;
      preset.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(60);
      rows.push({ id: opt.value, values: probe(), note: (note?.textContent ?? "").length, selected: preset.value });
    }
    // 姿态对下拉：运行期填充
    const pair = document.getElementById("quat-pair-select");
    const pairs = [...pair.options].map((o) => o.value);
    // 解算频率档位：逐个切换都要被接受（且不会把 hz 变成 0）
    const rate = document.getElementById("solve-rate");
    const rates = [...rate.options].map((o) => o.value);
    const bad = [];
    for (const v of rates) {
      rate.value = v;
      rate.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(40);
    }
    rate.value = "500";
    rate.dispatchEvent(new Event("change", { bubbles: true }));
    return { rows, pairs, rates, bad };
  });
  const distinct = new Set(enumsCase.rows.map((r) => r.values)).size;
  check(
    "器件预设与枚举：4 个预设都能写入、姿态对下拉运行期填充、解算频率各档可用",
    enumsCase.rows.length === 4 &&
      enumsCase.rows.every((r) => r.note > 10 && r.selected === r.id) &&
      distinct >= 3 && // mpu9250 / icm42688 / bno055 至少三种不同的参数组合
      enumsCase.pairs.length === 4 &&
      enumsCase.pairs.includes("combo") &&
      enumsCase.rates.length === 5,
    "预设 " + enumsCase.rows.map((r) => r.id + "→" + r.values).join("｜") + "；不同组合 " + distinct +
      " 种；姿态对 " + enumsCase.pairs.join("/") + "；解算频率档 " + enumsCase.rates.join("/"),
  );

  // ---------- 深链覆盖度 + 真实往返 ----------
  // 「分享」把界面状态编码进 URL：漏掉一个控件 = 同学打开看到的现场和你不一样。
  // 这类覆盖度会**随控件增加而悄悄失效**（原先靠一次性人工审计，所以漏了协议、取反、
  // q/−q、万向节三个角）。现在改成每次都跑的差集 + 真实往返：
  //   ① 把所有 range/checkbox/select 与 deepLink 三个清单做差集，只允许存在**明确不分享**的例外；
  //   ② 在每个控件上设一个有代表性的值 → 取 hash → 新页面按 hash 打开 → 逐一比对。
  const DEEP_EXEMPT = {
    // 键 = 控件 id，值 = 为什么不进深链（写清理由，免得后人以为漏了）
    "replay-speed": "回放倍速：只在本次回放里有效，回放本身不随链接分享",
    "replay-apply-cal": "回放是否补校准：由日志元数据（# imu=raw/calibrated）在导入时决定，分享过去的开关对别人的日志没有意义",
    "ble-service": "BLE 服务 UUID：取决于对方手里是哪个模块，分享过去只会连不上",
    "ble-char": "BLE 通知特征：连接后才被发现，链接里带不了",
    "magcal-apply": "「应用校准」：标定数据不在链接里，单独带这个开关只会出现「已应用但无标定」",
    "accelcal-apply": "「应用六面校准」：六面样本与拟合结果不在链接里，开关依赖运行时状态",
  };

  const deepCoverage = await page.evaluate((exemptIds) => {
    const dl = window.attitudeDemo.deepLink();
    const known = new Set([...dl.keys, ...dl.checks, ...dl.sels]);
    const missing = [];
    for (const el of document.querySelectorAll("input[type=range], input[type=checkbox], select")) {
      if (!el.id) continue;
      if (el.closest("#docs-overlay") || el.closest("dialog") || el.closest(".docs-shell")) continue;
      if (exemptIds.includes(el.id)) continue;
      if (!known.has(el.id)) missing.push(el.id);
    }
    return { missing, total: dl.keys.length + dl.checks.length + dl.sels.length };
  }, Object.keys(DEEP_EXEMPT));
  check(
    "深链覆盖度：所有界面控件都在分享范围内（例外只有 6 个明确不分享的）",
    deepCoverage.missing.length === 0,
    deepCoverage.total + " 个键" + (deepCoverage.missing.length ? "；未覆盖：" + deepCoverage.missing.join("、") : "，界面控件全部覆盖"),
  );

  const deepRoundTrip = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 900 });
    const srcWarn = [];
    pg.on("console", (m) => m.type() === "warning" && srcWarn.push(m.text().slice(0, 80)));
    pg.on("pageerror", (e) => srcWarn.push("pageerror: " + String(e).slice(0, 80)));
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    // 在每个控件上设一个「与默认明显不同」的值（滑杆取量程端、开关取反、下拉取非首项）
    const source = await pg.evaluate(() => {
      const dl = window.attitudeDemo.deepLink();
      const setRange = (el) => {
        const min = parseFloat(el.min);
        const max = parseFloat(el.max);
        const v = Math.abs(parseFloat(el.value) - min) > Math.abs(parseFloat(el.value) - max) ? min : max;
        el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const setSel = (el) => {
        const opts = [...el.options].filter((o) => o.value !== "");
        const cur = opts.findIndex((o) => o.value === el.value);
        const next = opts[(cur + 1) % opts.length];
        if (!next) return;
        el.value = next.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      for (const k of dl.keys) {
        const el = document.getElementById(k);
        if (el && el.type === "range") setRange(el);
      }
      for (const k of dl.checks) {
        const el = document.getElementById(k);
        if (el) {
          el.checked = !el.checked;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      for (const k of dl.sels) {
        const el = document.getElementById(k);
        if (el && el.tagName === "SELECT") setSel(el);
      }
      // 最后把那几个「会重置别的控件」的下拉放回已知值，保证源状态自洽
      const mnt = document.getElementById("serial-mounting");
      mnt.value = "y-front-x-left";
      mnt.dispatchEvent(new Event("change", { bubbles: true }));
      const read = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        return el.type === "checkbox" ? (el.checked ? "1" : "0") : String(el.value);
      };
      return { keys: dl.keys, checks: dl.checks, sels: dl.sels, values: {} };
    });
    // 用应用自己的编码器立刻取 hash：location.hash 是帧循环 10 Hz 顺手写的，
    // 时序上可能落后于刚设的值（CI 慢机器上就这么假失败过一次——错的是测试，不是功能）
    await new Promise((r) => setTimeout(r, 300));
    const hash = await pg.evaluate(() => window.attitudeDemo.encodeDeepLink());
    const srcValues = await pg.evaluate((lists) => {
      const read = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        return el.type === "checkbox" ? (el.checked ? "1" : "0") : String(el.value);
      };
      const out = {};
      for (const id of [...lists.keys, ...lists.checks, ...lists.sels]) out[id] = read(id);
      out.view = document.body.dataset.view;
      return out;
    }, { keys: source.keys, checks: source.checks, sels: source.sels });
    await pg.close();
    if (!/^#s=.+/.test(hash)) return { hash, bad: ["未生成 hash"] };

    // 新页面按 hash 打开，逐一比对
    const pg2 = await newPage();
    await pg2.setViewport({ width: 1280, height: 900 });
    const dstWarn = [];
    pg2.on("console", (m) => m.type() === "warning" && dstWarn.push(m.text().slice(0, 80)));
    pg2.on("pageerror", (e) => dstWarn.push("pageerror: " + String(e).slice(0, 80)));
    await gotoSafe(pg2, APP_URL + hash);
    await pg2.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await new Promise((r) => setTimeout(r, 500));
    const dstValues = await pg2.evaluate((lists) => {
      const read = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        return el.type === "checkbox" ? (el.checked ? "1" : "0") : String(el.value);
      };
      const out = {};
      for (const id of [...lists.keys, ...lists.checks, ...lists.sels]) out[id] = read(id);
      out.view = document.body.dataset.view;
      return out;
    }, { keys: source.keys, checks: source.checks, sels: source.sels });
    await pg2.close();
    const bad = [];
    for (const k of Object.keys(srcValues)) {
      if (srcValues[k] === null && dstValues[k] === null) continue;
      if (String(srcValues[k]) !== String(dstValues[k])) bad.push(k + ": " + srcValues[k] + "→" + dstValues[k]);
    }
    return {
      hash: hash.slice(0, 24) + "…",
      checked: Object.keys(srcValues).length,
      bad,
      warns: [...srcWarn, ...dstWarn].slice(0, 4),
    };
  })();
  check(
    "深链真实往返：全部控件的值都能被链接带过去并还原",
    deepRoundTrip.bad.length === 0,
    deepRoundTrip.checked + " 个控件往返" +
      (deepRoundTrip.bad.length
        ? "，不一致：" + deepRoundTrip.bad.slice(0, 6).join("｜") + (deepRoundTrip.warns.length ? "；跳过项警告：" + deepRoundTrip.warns.join(" / ") : "")
        : "全部一致") +
      "（hash " + deepRoundTrip.hash + "）",
  );

  } // app 段结束
  if (runDevices) {
  // ---------- 文本行协议 / MAVLink 协议：各自的假串口端到端 ----------
  // 这两种协议是本轮新增的「硬件接入入口」，必须在真浏览器里跑一遍：
  // 假端口按各自格式发流，断言解析后的读数与值班（unit/mounting）都正确。
  /** 慢 runner 上"状态文案晚到"的协议用例（不判失败，但必须留痕） */
  const protocolStatusTimeouts = [];
  const runProtocolCase = async (protocol, makeWire) => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(makeWire, protocol);
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const sel = document.getElementById("serial-protocol");
      sel.value = window.__protoForTest;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      // 安装方向取恒等映射，读数可与发送端直接对照（默认档 x-front-y-left 会翻 y 符号）
      const mnt = document.getElementById("serial-mounting");
      mnt.value = "x-front-y-right";
      mnt.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pg.click("#btn-serial");
    await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: STATE_MS });
    await pg.waitForFunction(
      () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 0.8,
      { timeout: SLOW_MS(10000) },
    );
    // 状态条的第一段文字是「已连接——等待数据帧…」，要等 10 Hz 的 UI 刷新把它换成带帧率的那段。
    // 直接读会在窗口内抓到旧文案（时序竞态，实测在改动前后各命中过一次）——等它出现协议名更稳。
    // 慢 runner 上这个刷新可能晚于额度：超时**不判失败**，但把当时的状态文案带进诊断里。
    try {
      await pg.waitForFunction(
        () => {
          const t = document.getElementById("serial-status")?.textContent ?? "";
          return /文本行|MAVLink|帧\/s/.test(t);
        },
        { timeout: SLOW_MS(8000) },
      );
    } catch {
      protocolStatusTimeouts.push(protocol);
    }
    const info = await pg.evaluate(() => {
      const imu = window.attitudeDemo.state.lastImu;
      return {
        mode: document.body.dataset.imuMode,
        status: document.getElementById("serial-status")?.textContent ?? "",
        accel: imu ? imu.accel.map((v) => +v.toFixed(4)) : null,
        gyro: imu ? imu.gyro.map((v) => +(v * 57.29578).toFixed(3)) : null,
        mag: imu ? imu.mag.map((v) => +v.toFixed(2)) : null,
        proto: document.getElementById("serial-protocol").value,
        invertVisible: !document.getElementById("serial-invert-row").classList.contains("hidden"),
      };
    });
    await pg.close();
    return { info, errs };
  };

  // 文本行：100 Hz 发 `t,0,0,0,0.1,0.2,9.8,32.8,0,37.7`（10 列，带时间戳）
  const textCase = await runProtocolCase(
    "text",
    (proto) => {
      window.__protoForTest = proto;
      const enc = new TextEncoder();
      let timer = 0;
      let t = 0;
      const stream = new ReadableStream({
        start(c) {
          timer = setInterval(() => {
            t += 0.01;
            c.enqueue(enc.encode(t.toFixed(3) + ",1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7" + String.fromCharCode(10)));
          }, 10);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      const port = {
        open: async () => undefined,
        close: async () => clearInterval(timer),
        get readable() {
          return stream;
        },
      };
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
    },
  );
  check(
    "串口文本行协议：端到端读数与单位正确",
    textCase.info.mode === "real" &&
      textCase.info.proto === "text" &&
      textCase.info.status.includes("文本行") &&
      textCase.info.accel?.[2] > 9.7 &&
      textCase.info.accel[2] < 9.9 &&
      Math.abs((textCase.info.gyro?.[0] ?? 0) - 1.5) < 0.2 &&
      Math.abs((textCase.info.mag?.[0] ?? 0) - 32.8) < 0.1 &&
      errsEmpty(textCase.errs),
    `accel=${JSON.stringify(textCase.info.accel)} gyro=${JSON.stringify(textCase.info.gyro)} mag=${JSON.stringify(textCase.info.mag)}｜${textCase.info.status}`,
  );

  // 断线自动重连：假端口在 N 帧后抛错（模拟拔线）→ 应进入自动重连并恢复数据
  const reconnectCase = await (async () => {
    const pg = await newPage();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(() => {
      const enc = new TextEncoder();
      const line = (t) => enc.encode(t.toFixed(3) + ",1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7" + String.fromCharCode(10));
      let t = 0;
      let opens = 0;
      /** 每条流自己的定时器与计数：共用一个变量会在重连后漏掉旧定时器（往已 error 的流 enqueue） */
      const makeStream = (failAfter) => {
        let sent = 0;
        let myTimer = 0;
        return new ReadableStream({
          start(c) {
            myTimer = setInterval(() => {
              t += 0.01;
              sent++;
              if (failAfter !== null && sent > failAfter) {
                // 模拟拔线：让 read() 直接抛错（真实 Web Serial 也是这样报错的）
                clearInterval(myTimer);
                c.error(new Error("device disconnected"));
                return;
              }
              try {
                c.enqueue(line(t));
              } catch {
                clearInterval(myTimer);
              }
            }, 10);
          },
          cancel() {
            clearInterval(myTimer);
          },
        });
      };
      window.__reconnect = { opens: 0, gets: 0 };
      const port = {
        open: async () => {
          opens++;
          window.__reconnect.opens = opens;
          // 第一次连接 30 帧后断，第二次起正常
          stream = makeStream(opens === 1 ? 30 : null);
        },
        // 显式 close 时旧流的定时器由它自己的 cancel() 清理（reader.cancel 会触发）
        close: async () => undefined,
        get readable() {
          window.__reconnect.gets = (window.__reconnect.gets ?? 0) + 1;
          return stream;
        },
      };
      let stream = makeStream(30);
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
    });
    await gotoSafe(pg);
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await pg.evaluate(() => {
      const sec = document.getElementById("sec-imu");
      if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
      const sel = document.getElementById("serial-protocol");
      sel.value = "text";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pg.click("#btn-serial");
    await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: STATE_MS });
    // 断线前先攒一点本轮实验记录（用来验证「重连不会清空本轮结果」）
    await new Promise((r) => setTimeout(r, 800));
    const beforeDrop = await pg.evaluate(() => ({
      t: window.attitudeDemo.sizes().simTime,
      logRows: window.attitudeDemo.sizes().logRows,
    }));
    // 等**重连成功计数**，不要等状态条：计数只增不减，而状态条会被下一段帧率刷新覆盖。
    await pg.waitForFunction(() => window.attitudeDemo.plumbing().reconnects >= 1, { timeout: SLOW_MS(12000) });
    const framesAfterReconnect = await pg.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const f0 = window.attitudeDemo.plumbing().frames;
      // **状态等待**而不是固定窗口：机器忙时（软件 WebGL + 后台任务抢 CPU）600 ms 里可能只到 3 帧，
      // 但"重连后数据流已经恢复"这件事本身是确定的——等到真的超过 5 帧，最多 8 s。
      // 固定窗口会把"这台机器慢"误报成"重连没恢复"（复核：稳定性轮里 5 轮中就出现过 1 次）。
      const deadline = performance.now() + 8000;
      let delta = 0;
      while (performance.now() < deadline) {
        delta = window.attitudeDemo.plumbing().frames - f0;
        if (delta > 5) break;
        await wait(50);
      }
      return {
        delta: window.attitudeDemo.plumbing().frames - f0,
        status: document.getElementById("serial-status")?.textContent ?? "",
        imuMode: document.body.dataset.imuMode,
        opens: window.__reconnect.opens,
        reconnects: window.attitudeDemo.plumbing().reconnects,
        // 断线重连**不能**把本轮实验清零（这是自动重连的意义所在）
        t: window.attitudeDemo.sizes().simTime,
        logRows: window.attitudeDemo.sizes().logRows,
      };
    });
    await pg.close();
    return { framesAfterReconnect, beforeDrop, errs };
  })();
  check(
    "串口断线自动重连：拔线后按退避重连并恢复数据流",
    reconnectCase.framesAfterReconnect.reconnects >= 1 &&
      reconnectCase.framesAfterReconnect.opens >= 2 &&
      reconnectCase.framesAfterReconnect.delta > 5 &&
      reconnectCase.framesAfterReconnect.imuMode === "real" &&
      // 重连不得清空本轮实验：时钟继续、记录行不清零
      reconnectCase.framesAfterReconnect.t >= reconnectCase.beforeDrop.t &&
      reconnectCase.framesAfterReconnect.logRows > 0 &&
      errsEmpty(reconnectCase.errs),
    `自动重连成功 ${reconnectCase.framesAfterReconnect.reconnects} 次（端口 open ${reconnectCase.framesAfterReconnect.opens} 次）、` +
      `重连后新增 ${reconnectCase.framesAfterReconnect.delta} 帧（状态等待，最多 8 s）、` +
      `时钟 ${reconnectCase.beforeDrop.t.toFixed(2)} → ${reconnectCase.framesAfterReconnect.t.toFixed(2)} s、` +
      `记录行 ${reconnectCase.beforeDrop.logRows} → ${reconnectCase.framesAfterReconnect.logRows}；` +
      `状态「${reconnectCase.framesAfterReconnect.status.slice(0, 40)}」${protocolStatusTimeouts.length ? `；状态文案晚到：${protocolStatusTimeouts.join("、")}` : ""}`,
  );

  // MAVLink：RAW_IMU + 一条未知 id 的干扰帧交替发，验证「跳过其它消息」路径
  const mavCase = await runProtocolCase(
    "mavlink",
    (proto) => {
      window.__protoForTest = proto;
      const crc16 = (d, from, to) => {
        let crc = 0xffff;
        for (let i = from; i < to; i++) {
          let t = d[i] ^ (crc & 0xff);
          t = (t ^ (t << 4)) & 0xff;
          crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
        }
        return crc;
      };
      const fold = (crc, extra) => {
        let t = extra ^ (crc & 0xff);
        t = (t ^ (t << 4)) & 0xff;
        return ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
      };
      const CRC_EXTRA_RAW_IMU = 144; // 与 src/core/serial.ts 一致（那边由算法推导并自检锁定）
      const rawImu = (seq, timeUs, accelZmg, gyroXmrad) => {
        const payload = new Uint8Array(26);
        const dv = new DataView(payload.buffer);
        dv.setBigUint64(0, BigInt(timeUs), true);
        dv.setInt16(8, 0, true);
        dv.setInt16(10, 0, true);
        dv.setInt16(12, accelZmg, true);
        dv.setInt16(14, gyroXmrad, true);
        dv.setInt16(16, 0, true);
        dv.setInt16(18, 0, true);
        dv.setInt16(20, 328, true);
        dv.setInt16(22, 0, true);
        dv.setInt16(24, 377, true);
        const d = new Uint8Array(38);
        d[0] = 0xfd;
        d[1] = 26;
        d[4] = seq & 0xff;
        d[5] = 1;
        d[6] = 1;
        d[7] = 27; // RAW_IMU
        d.set(payload, 10);
        const crc = fold(crc16(d, 1, 36), CRC_EXTRA_RAW_IMU);
        d[36] = crc & 0xff;
        d[37] = (crc >> 8) & 0xff;
        return d;
      };
      const otherMsg = (seq, id) => {
        const d = new Uint8Array(12 + 4);
        d[0] = 0xfd;
        d[1] = 4;
        d[4] = seq & 0xff;
        d[7] = id & 0xff;
        return d; // 内容无所谓：解析器按 id 先跳过
      };
      let timer = 0;
      let seq = 0;
      let tUs = 1000000;
      let flip = false;
      const stream = new ReadableStream({
        start(c) {
          timer = setInterval(() => {
            flip = !flip;
            if (flip) c.enqueue(otherMsg(seq++, 77)); // 干扰：未知消息
            c.enqueue(rawImu(seq++, tUs, 1000, 26));
            tUs += 10000; // 100 Hz
          }, 10);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      const port = {
        open: async () => undefined,
        close: async () => clearInterval(timer),
        get readable() {
          return stream;
        },
      };
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
    },
  );
  check(
    "串口 MAVLink RAW_IMU：端到端读数 + 跳过其它消息",
    mavCase.info.mode === "real" &&
      mavCase.info.proto === "mavlink" &&
      mavCase.info.status.includes("MAVLink") &&
      mavCase.info.status.includes("跳过其它消息") &&
      mavCase.info.invertVisible &&
      mavCase.info.accel?.[2] > 9.79 &&
      mavCase.info.accel[2] < 9.82 &&
      Math.abs((mavCase.info.gyro?.[0] ?? 0) - 1.49) < 0.06 &&
      errsEmpty(mavCase.errs),
    `accel=${JSON.stringify(mavCase.info.accel)} gyro=${JSON.stringify(mavCase.info.gyro)} 取反开关可见=${mavCase.info.invertVisible}｜${mavCase.info.status}`,
  );

  } // devices 段结束
  if (runApp) {
  // 深链：当前 hash 重载后参数应保持
  const deep = await page.evaluate(() => ({
    hash: location.hash,
    bias: document.getElementById("imu-gyro-bias").value,
    view: document.body.dataset.view,
  }));
  await gotoSafe(page, APP_URL.split("#")[0] + deep.hash);
  await page.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 0.5,
    { timeout: STATE_MS },
  );
  const deep2 = await page.evaluate(() => ({
    bias: document.getElementById("imu-gyro-bias").value,
    view: document.body.dataset.view,
  }));
  check(
    "深链恢复参数与视图",
    deep2.bias === deep.bias && deep2.view === deep.view,
    `bias ${deep.bias}→${deep2.bias}；view ${deep.view}→${deep2.view}`,
  );

  // 快捷键：? 提示（toast 出现）
  const toast = await page.evaluate(() => {
    document.body.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    return [...document.querySelectorAll("#toast-layer .ov-chip")]
      .map((e) => e.textContent)
      .find((t) => t.includes("快捷键"));
  });
  check("快捷键提示可触发", Boolean(toast), toast ?? "未出现");

  // ---------- 四元数视图：弧线读数与几何重建 ----------
  const quatArc = await page.evaluate(async () => {
    [...document.querySelectorAll("#view-seg .seg-btn")].find((b) => b.dataset.view === "quat").click();
    await new Promise((r) => setTimeout(r, 250));
    const t = document.getElementById("quat-t");
    t.value = "0.5";
    t.dispatchEvent(new Event("input"));
    const combo = document.getElementById("quat-arcinfo").textContent;
    const sel = document.getElementById("quat-pair-select");
    sel.value = "roll";
    sel.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 200));
    const roll = document.getElementById("quat-arcinfo").textContent;
    return { combo, roll };
  });
  const dev = (txt) => parseFloat((txt.match(/中点分叉\s*([\d.]+)/) ?? [])[1] ?? "NaN");
  check(
    "四元数弧线读数随姿态对变化",
    dev(quatArc.combo) > 20 && dev(quatArc.roll) < 5,
    `多轴预设分叉 ${dev(quatArc.combo)}°（应 >20），纯横滚 ${dev(quatArc.roll)}°（应 <5）`,
  );

  // ---------- 万向节：阻尼跟随 + 死锁可视化 ----------
  const gim = await page.evaluate(async () => {
    [...document.querySelectorAll("#view-seg .seg-btn")].find((b) => b.dataset.view === "gimbal").click();
    await new Promise((r) => setTimeout(r, 200));
    const g = window.attitudeDemo.sceneHandles.gimbal;
    const el = document.getElementById("gim-pitch");
    el.value = "90";
    el.dispatchEvent(new Event("input"));
    // 同步读取：目标已变、显示值还没跟上 —— 阻尼的直接证据（不受帧率影响）
    const instant = (g.currentAngles().pitch * 180) / Math.PI;
    // 等待「真正收敛」而不是固定睡 0.9 s：headless 下 rAF 可能被节流，固定睡眠不可靠
    const deadline = performance.now() + 8000;
    let settled = instant;
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      settled = (g.currentAngles().pitch * 180) / Math.PI;
      if (settled > 89.5) break;
    }
    const late = document.getElementById("gimbal-readout").textContent;
    const findHalo = () =>
      g.group.children.find(
        (c) => c.type === "Mesh" && c.geometry.type === "TorusGeometry" &&
          c.material.color.getHexString() === "f85149",
      );
    // 脉冲环由 setLockVisual 在每 0.1 s 的 UI 块里驱动：**等它真的亮起来**，
    // 而不是固定睡 300 ms——2 vCPU 的 CI runner 上 UI 块可能晚于 300 ms（Windows CI 实测
    // 出现过「其余全对、只有脉冲环=false」的假失败）。
    let halo = findHalo();
    const haloDeadline = performance.now() + 8000;
    while (performance.now() < haloDeadline && !(halo && halo.visible)) {
      await new Promise((r) => setTimeout(r, 100));
      halo = findHalo();
    }
    return {
      instant,
      settled,
      late,
      locked: g.isLocked(),
      align: g.axisAlign(),
      halo: halo ? halo.visible : null,
    };
  });
  check(
    "万向节阻尼跟随 + 死锁可视化",
    gim.instant < 5 && gim.settled > 89 && /θ \+90/.test(gim.late) && gim.locked && gim.align > 0.999 && gim.halo === true,
    `下发瞬间 ${gim.instant.toFixed(1)}° → 收敛到 ${gim.settled.toFixed(1)}°（阻尼跟随）；读数 θ+90；锁定=${gim.locked} 对齐=${gim.align.toFixed(3)} 脉冲环=${gim.halo}`,
  );

  // 窄屏布局：无横向溢出，面板/画布贴合视口
  const mobilePage = await newPage();
  // 窄屏页面同样要收控制台错误（ROUND11：此前只有主页面收集，窄屏页报错无人发现）
  const mobileErrors = [];
  mobilePage.on("console", (m) => m.type() === "error" && mobileErrors.push(m.text()));
  mobilePage.on("pageerror", (e) => mobileErrors.push(String(e)));
  await mobilePage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await gotoSafe(mobilePage);
  await mobilePage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
  const mobile = await mobilePage.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    panelW: document.getElementById("panel").getBoundingClientRect().width,
    canvasW: document.querySelector("#viewport canvas").getBoundingClientRect().width,
  }));
  check(
    "窄屏布局无横向溢出",
    mobile.scrollW === mobile.innerW && mobile.panelW === mobile.innerW && Math.abs(mobile.canvasW - mobile.innerW) < 1,
    `scroll=${mobile.scrollW}/${mobile.innerW} panel=${mobile.panelW} canvas=${mobile.canvasW}`,
  );

  // 200% 文字缩放：CSS 视口 = 1440×900 的一半（720×450 @DPR2），与浏览器"文字缩放 200%"等效。
  // 复核反例（视觉证据 zoom200 实测）：左侧读数条按 CSS 像素堆下来会压住右下角的
  // 「拖拽旋转视角」提示——陀螺仪/加速度计两行读数被盖住。提示是非关键说明，矮视口下隐藏。
  await mobilePage.setViewport({ width: 720, height: 450, deviceScaleFactor: 2 });
  await gotoSafe(mobilePage);
  await mobilePage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
  await new Promise((r) => setTimeout(r, 800));
  const zoomed = await mobilePage.evaluate(() => {
    const hint = document.getElementById("viewport-hint");
    const hintVisible = Boolean(hint) && getComputedStyle(hint).display !== "none";
    const a = hintVisible ? hint.getBoundingClientRect() : null;
    const hits = a
      ? [...document.querySelectorAll("#readout-overlay .ov-chip")]
          .map((c) => c.getBoundingClientRect())
          .filter((r) => !(r.right < a.left || r.left > a.right || r.bottom < a.top || r.top > a.bottom))
          .map((r) => `${Math.round(r.width)}×${Math.round(r.height)}`)
      : [];
    return {
      hintVisible,
      hits,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      readouts: document.querySelectorAll("#readout-overlay .ov-chip").length,
    };
  });
  check(
    "200% 文字缩放（CSS 视口 720×450）：提示条不遮挡读数（或已隐藏）且无横向溢出",
    (!zoomed.hintVisible || zoomed.hits.length === 0) && zoomed.scrollW === zoomed.innerW && zoomed.readouts > 0,
    `提示可见=${zoomed.hintVisible}、被遮挡的读数条=${JSON.stringify(zoomed.hits)}、` +
      `读数条共 ${zoomed.readouts} 条、横向溢出=${zoomed.scrollW > zoomed.innerW}（${zoomed.scrollW}/${zoomed.innerW}）`,
  );
  /**
   * SW-11：**纯文字放大**（不改视口、不改 DPR）与**页面缩放**是两条不同的路径。
   *
   * 机制说明（不许把 DPR 当字号变化）：headless 无法驱动浏览器"字体大小"设置，这里改**根字号**
   * （`html { font-size: 200% }`）来观察版式反应。实测结论：本装置版式以 **px** 计量，
   * 因此浏览器"字体大小"设置**不会**改变排版；用户可用的放大路径是**页面缩放**——那条路径
   * 由上面的「页面缩放 200%（720×450 @DPR2）」用例覆盖，并保证不遮挡、不溢出。
   * 这条用例断言的是"实测事实 + 放大后布局不破"，不是"纯文字放大已验证可用"；
   * 真实浏览器字体设置与读屏抽查**未测**，已记入验收记录（docs/ACCESSIBILITY-ACCEPTANCE.md）。
   */
  const textZoom = await mobilePage.evaluate(async () => {
    const root = document.documentElement;
    const chip = document.querySelector("#readout-overlay .ov-chip.mono") ?? document.querySelector("#readout-overlay .ov-chip");
    const read = () => {
      const rect = chip?.getBoundingClientRect();
      return {
        fontSize: chip ? parseFloat(getComputedStyle(chip).fontSize) : null,
        rect: rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : null,
        scrollW: root.scrollWidth,
        innerW: window.innerWidth,
        clipped: chip ? chip.scrollWidth > chip.clientWidth + 1 : false,
      };
    };
    const before = read();
    root.style.fontSize = "200%";
    await new Promise((r) => setTimeout(r, 400));
    const after = read();
    root.style.fontSize = "";
    return { before, after };
  });
  const textZoomScales = textZoom.after.fontSize > textZoom.before.fontSize * 1.5;
  check(
    "SW-11 纯文字放大（根字号 200%）：实测 px 计量下排版不随字体设置变化（页面缩放才是覆盖路径），且放大后不溢出/不截断",
    textZoom.after.scrollW <= textZoom.after.innerW && !textZoom.after.clipped,
    `读数条字号 ${textZoom.before.fontSize}→${textZoom.after.fontSize} px（随字体设置变化=${textZoomScales}）；` +
      `横向 ${textZoom.after.scrollW}/${textZoom.after.innerW}；文字被截断=${textZoom.after.clipped}；` +
      `机制：浏览器页面缩放 200% 已由「720×450 @DPR2」用例覆盖；字体大小设置/读屏未测`,
  );

  /**
   * SW-11 第 1 条：窄屏下文档目录**不再长期占满首屏**。
   * 判据是"正文出现在首屏内"，而不是"没有横向滚动条"——后者不能说明首屏有没有内容。
   */
  const narrowDocs = await (async () => {
    const saved = mobilePage.viewport();
    await mobilePage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await gotoSafe(mobilePage);
    await mobilePage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
    await mobilePage.evaluate(() => document.getElementById("btn-docs").click());
    await mobilePage.waitForFunction(() => !document.getElementById("docs-overlay").hidden);
    /**
     * 判"目录是不是真的画出来了"必须用 `checkVisibility()`：
     * 收起的 <details> 里子元素仍保留布局盒（`getClientRects()` 照样非空），只看矩形会被假象骗过。
     */
    const probe = () => mobilePage.evaluate(() => {
      const details = document.getElementById("toc-disclosure");
      const article = document.querySelector(".doc-page:not([hidden])");
      const links = [...document.querySelectorAll(".module-link")];
      const visible = (el) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0);
      return {
        open: details?.open ?? null,
        current: document.getElementById("toc-current")?.textContent?.trim() ?? "",
        activeLabel: links.find((b) => b.classList.contains("active"))?.querySelector(".mod-name")?.textContent?.trim() ?? "",
        articleTop: Math.round(article?.getBoundingClientRect().top ?? -1),
        viewportH: window.innerHeight,
        listRendered: links.some(visible),
        listH: Math.round(document.querySelector(".toc-list")?.getBoundingClientRect().height ?? -1),
        navH: Math.round(document.querySelector(".docs-toc")?.getBoundingClientRect().height ?? -1),
      };
    });
    const collapsed = await probe();
    // 键盘开合（<summary> 原生支持 Enter/Space）→ 目录出现且有高度上限；再选一个模块自动收起
    await mobilePage.evaluate(() => document.querySelector("#toc-disclosure > summary")?.focus());
    await mobilePage.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 300));
    // 先量"展开后的列表"，再点模块（点击会触发自动收起，两个状态不能混在同一个读取里）
    const expanded = await probe();
    await mobilePage.evaluate(() => document.querySelector('.module-link[data-doc="glossary"]')?.click());
    await new Promise((r) => setTimeout(r, 300));
    const afterPick = await probe();
    await mobilePage.evaluate(() => document.getElementById("btn-docs").click());
    await mobilePage.setViewport(saved);
    return { collapsed, expanded, afterPick };
  })();
  check(
    "SW-11 窄屏（390）：文档目录默认收起、首屏即见正文、可键盘展开；选中模块后自动收起",
    narrowDocs.collapsed.open === false &&
      narrowDocs.collapsed.listRendered === false &&
      narrowDocs.collapsed.articleTop < narrowDocs.collapsed.viewportH &&
      narrowDocs.collapsed.current.length > 0 && narrowDocs.collapsed.current === narrowDocs.collapsed.activeLabel &&
      narrowDocs.expanded.open === true && narrowDocs.expanded.listRendered === true &&
      narrowDocs.expanded.listH <= narrowDocs.expanded.viewportH * 0.5 &&
      narrowDocs.afterPick.open === false &&
      narrowDocs.afterPick.current === narrowDocs.afterPick.activeLabel &&
      narrowDocs.afterPick.articleTop < narrowDocs.afterPick.viewportH,
    `收起时：目录 open=${narrowDocs.collapsed.open}、目录条目已渲染=${narrowDocs.collapsed.listRendered}、` +
      `正文 top=${narrowDocs.collapsed.articleTop}/${narrowDocs.collapsed.viewportH} px、` +
      `当前模块「${narrowDocs.collapsed.current}」= 高亮项「${narrowDocs.collapsed.activeLabel}」、导航高 ${narrowDocs.collapsed.navH} px；` +
      `键盘展开后：渲染=${narrowDocs.expanded.listRendered}、列表高 ${narrowDocs.expanded.listH}/${narrowDocs.expanded.viewportH} px；` +
      `选中后：open=${narrowDocs.afterPick.open}、标签「${narrowDocs.afterPick.current}」、正文 top=${narrowDocs.afterPick.articleTop}`,
  );
  await mobilePage.close();

  check(
    "控制台零错误（含窄屏页面）",
    errors.length === 0 && mobileErrors.length === 0,
    [...errors, ...mobileErrors].slice(0, 3).join(" | ") || "无",
  );

  // ---------- 可访问性审计（对比度 + 可访问名 + 键盘）----------
  // 背景：装置有两套主题——暗色仪表盘与浅色文档。暗色那套的注释里写着「三档文字色
  // 均满足 WCAG AA」，浅色那套一直没人量过；一量就发现文档主题里 5 处不达标
  // （accent 用在浅底上只有 4.0、导航当前项 3.7、表格表头 4.05……）。
  // 这条用例把这个「没人量过」变成每次提交都会量一遍：
  //   · 对比度：小于 4.5:1（大字 3:1）即失败。背景色按祖先链做 alpha 合成，
  //     而不是只看元素自己的 background-color——绝大多数文字的背景来自祖先。
  //   · 禁用控件按 WCAG 豁免（inactive UI components）。
  //   · 可访问名：按钮/链接/输入框必须能从 aria-label / aria-labelledby /
  //     <label> / 文本内容 / title 里得到一个名字，否则读屏用户只会听到「按钮」。
  const a11y = await page.evaluate(async () => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(",").map((v) => parseFloat(v));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lin = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const effBg = (el) => {
      const chain = [];
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) chain.push(c);
        if (c && c.a >= 1) break;
      }
      let out = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i--) out = over(chain[i], out);
      return out;
    };
    const ownText = (el) => {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
      return false;
    };
    const shown = (el) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) < 0.5) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const desc = (el) =>
      (el.tagName.toLowerCase() +
        (el.id ? "#" + el.id : "") +
        (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "")).slice(0, 64);

    const lowContrast = [];
    const noName = [];
    const scan = (root) => {
      // 根元素本身也要看：负对照是直接插一个探针元素当 root 传进来的
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (el.closest("[disabled]") || el.disabled) continue; // WCAG：非活动控件豁免
        if (!shown(el)) continue;
        if (ownText(el)) {
          const st = getComputedStyle(el);
          const fs = parseFloat(st.fontSize);
          const fw = parseInt(st.fontWeight, 10) || 400;
          const fg = parse(st.color);
          if (fg && fg.a > 0.05) {
            const bg = effBg(el);
            const l1 = lum(over(fg, bg));
            const l2 = lum(bg);
            const r = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const need = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;
            if (r < need - 0.02) {
              lowContrast.push({
                el: desc(el),
                text: el.textContent.trim().slice(0, 20),
                r: Math.round(r * 100) / 100,
                need,
                fs: Math.round(fs * 10) / 10,
                fg: `rgb(${[fg.r, fg.g, fg.b].map((v) => Math.round(v)).join(",")})`,
                bg: `rgb(${[bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(",")})`,
              });
            }
          }
        }
        if (el.matches("button, a[href], select, textarea, input:not([type=hidden]), [tabindex]")) {
          const name = (
            el.getAttribute("aria-label") ||
            (el.getAttribute("aria-labelledby")
              ? (el.getAttribute("aria-labelledby").split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ")).trim()
              : "") ||
            (el.labels ? [...el.labels].map((l) => l.textContent).join(" ") : "") ||
            el.textContent ||
            el.getAttribute("title") ||
            el.getAttribute("placeholder") ||
            (el.tagName === "INPUT" ? el.value : "")
          ).trim();
          if (name.length === 0) noName.push(desc(el));
        }
      }
    };
    // 覆盖面积：右侧全部分区展开 + 三条曲线全部展开 + 三个视图各切一遍 + 文档两页
    document.getElementById("panel-expand-all").click();
    await new Promise((r) => setTimeout(r, 200));
    scan(document.getElementById("panel"));
    scan(document.getElementById("charts"));
    scan(document.getElementById("app-header"));
    for (const v of ["gimbal", "quat", "attitude"]) {
      document.querySelector(`#view-seg .seg-btn[data-view="${v}"]`).click();
      await new Promise((r) => setTimeout(r, 120));
      scan(document.getElementById("viewport"));
    }
    document.getElementById("btn-docs").click();
    // 文档页全部扫一遍（每页切换后等 150 ms 让布局稳定）。
    // **复核教训**：此前只用 `.module-link[data-doc=…]` 切页，但有 5 页（四个算法的详情页与磁校准页）
    // 在左栏没有对应按钮——循环只是重复扫描上一页，「全部 15 页达 AA」因此是假的。
    // 现在：优先用 module-link，找不到就直接按页 id 激活（main.ts 的 showDocPage 入口），
    // 并**记录实际扫到的页 id 集合**，最后断言集合等于全部页。
    const pages = [...document.querySelectorAll(".doc-page")].map((p) => p.dataset.docPage);
    const scannedPages = [];
    for (const p of pages) {
      const links = document.querySelectorAll(`.module-link[data-doc="${p}"]`);
      if (links.length) links.forEach((b) => b.click());
      else if (typeof window.attitudeDemo.openDocPage === "function") window.attitudeDemo.openDocPage(p);
      else continue;
      await new Promise((r) => setTimeout(r, 150));
      // 只有目标页真的可见才算扫到（隐藏页扫描等于没扫）
      const target = document.querySelector(`.doc-page[data-doc-page="${p}"]`);
      if (target && getComputedStyle(target).display !== "none") scannedPages.push(p);
      scan(document.getElementById("docs-overlay"));
    }
    document.getElementById("btn-docs-close").click();
    // **负对照**：扫描器必须真的能"抓到"低对比度文字，否则"全站达 AA"只是没在扫。
    // 往面板里插一段前景/背景几乎同色的文字，扫描它、再移除——必须被判不达标。
    const probe = document.createElement("div");
    probe.id = "__contrast_probe";
    probe.style.cssText = "color:#8a8f98;background:#7e858f;font-size:14px;padding:4px";
    probe.textContent = "对比度负对照";
    document.getElementById("panel").appendChild(probe);
    const beforeProbe = lowContrast.length;
    scan(probe);
    // 取出并移除探针的判定结果：不能污染"全站 0 处不达标"的结论
    const probeHits = lowContrast.splice(beforeProbe);
    const probeFound = probeHits.length === 1 && probeHits[0].r < 4.5;
    probe.remove();
    document.getElementById("panel-collapse-all").click();
    const positiveTab = [...document.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0).length;
    return { lowContrast, noName, positiveTab, scanned: true, allPages: pages, scannedPages, probeFound };
  });
  const worst = a11y.lowContrast
    .slice(0, 6)
    .map((x) => `${x.r}<${x.need} ${x.fs}px ${x.el}「${x.text}」${x.fg} on ${x.bg}`);
  const allPagesScanned =
    a11y.scannedPages.length === a11y.allPages.length &&
    a11y.allPages.every((p) => a11y.scannedPages.includes(p));
  check(
    "可访问性：全站文字对比度达 WCAG AA（含低对比度负对照必须被抓到），逐页确认扫到全部文档页",
    a11y.lowContrast.length === 0 && allPagesScanned && a11y.probeFound === true,
    a11y.lowContrast.length
      ? `${a11y.lowContrast.length} 处不达标：${worst.join("；")}`
      : `扫描 ${a11y.scannedPages.length}/${a11y.allPages.length} 页（${a11y.scannedPages.join("、")}），未发现低于 (4.5:1 / 大字 3:1) 的文字；` +
        `注入的低对比度负对照被抓到=${a11y.probeFound}`,
  );
  check(
    "可访问性：交互控件都有可访问名，且无正向 tabindex（不破坏 Tab 顺序）",
    a11y.noName.length === 0 && a11y.positiveTab === 0,
    a11y.noName.length ? `${a11y.noName.length} 个控件没有名字：${a11y.noName.slice(0, 5).join("、")}` : `全部有名字；正向 tabindex ${a11y.positiveTab} 个`,
  );

  // ---------- 长跑稳定性（滚动容器封顶 / 堆增长 / 帧率）----------
  // 装置是「开着不动也会一直跑」的常驻页面（演示用，一开就是几十分钟），
  // 真正要守的不是首屏多快，而是「跑久了会不会越跑越卡」。
  // 四个会被不断 push 的容器都必须封顶：记录行、INS 轨迹、串口队列、提示条；
  // 曲线用的是定长 Float64Array 环形缓冲（设计上不增长，这里一并守）。
  //
  // 两处踩过的坑，都写在这里免得下次再犯：
  //  ① 判据不能要求「仿真时钟推进 8 秒」：仿真步长被 dt ≤ 50 ms 夹住，所以时钟最快也就是
  //     「每帧 50 ms」，一帧都慢的机器上 12 秒墙钟只换到 2 秒仿真时间（CI 实测）。
  //     校验「循环还活着」用 +1.5 s 就够，别把它当成性能指标。
  //  ② 界面上的 fps 读数**不能**当性能指标：它用被夹过的 dt 累加，rawDt > 50 ms 时恒等于 ~20，
  //     4 fps 的机器上也显示 20 fps。要真实帧率就自己数 rAF。
  const measureRaf = (ms) =>
    page.evaluate(
      (window_ms) =>
        new Promise((res) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 < window_ms) requestAnimationFrame(tick);
            else res(Math.round((n / (performance.now() - t0)) * 1000));
          };
          requestAnimationFrame(tick);
        }),
      ms,
    );
  const soakRead = () =>
    page.evaluate(() => ({
      sizes: window.attitudeDemo.sizes(),
      clock: parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) || 0,
      fpsReadout: parseInt((document.getElementById("fps")?.textContent ?? "0").replace(/[^\d]/g, ""), 10) || 0,
      heap: performance.memory ? performance.memory.usedJSHeapSize : -1,
      toasts: document.getElementById("toast-layer")?.childElementCount ?? -1,
    }));
  // 满负荷：全部分区展开、三条曲线全展开、玻璃盒 + INS 都开着
  await page.evaluate(() => {
    document.getElementById("panel-expand-all").click();
    document.querySelectorAll("#charts .block-toggle").forEach((b) => {
      if (b.getAttribute("aria-expanded") === "false") b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 3000)); // 先跑热（JIT / 首个记录窗口填满）
  const soak0 = await soakRead();
  // 状态等待而不是赌 12 s 墙钟：CI 的软件渲染只有 2–4 fps，仿真步长封顶 50 ms，
  // 固定 12 s 只能推进约 1.5 s 仿真时间（实测偶发 1.3 s 而把「时钟在走」判失败）。
  // 这里改成「等时钟真的推进 2 s」，上限 45 s 墙钟；慢机器只会让这条变慢，不会变红。
  const advanceDeadline = Date.now() + 45000;
  let soak1 = await soakRead();
  while (Date.now() < advanceDeadline && soak1.clock <= soak0.clock + 2) {
    await new Promise((r) => setTimeout(r, 500));
    soak1 = await soakRead();
  }
  const realFps = await measureRaf(2000);
  const heapMb = (soak1.heap - soak0.heap) / 1048576;
  const sz = soak1.sizes;
  check(
    "长跑 15 s：滚动容器全部封顶、时钟仍在推进、堆增长受控",
    sz.logRows <= sz.logRowsCap &&
      sz.insTrailMax <= sz.insTrailCap &&
      sz.serialQueue <= sz.serialQueueCap &&
      sz.charts.every((c) => c.count <= c.cap) &&
      soak1.toasts === 0 &&
      soak1.clock > soak0.clock + 1.5 &&
      (soak1.heap < 0 || heapMb < 24),
    `记录行 ${sz.logRows}/${sz.logRowsCap}，INS 轨迹 ${sz.insTrailMax}/${sz.insTrailCap}，` +
      `串口队列 ${sz.serialQueue}/${sz.serialQueueCap}，曲线 ${sz.charts.map((c) => `${c.count}/${c.cap}`).join(" ")}；` +
      `t ${soak0.clock.toFixed(1)}→${soak1.clock.toFixed(1)} s（仿真步长封顶 50 ms，慢机器上这段本来就走得少）；` +
      `真实帧率 ${realFps} fps（界面读数 ${soak1.fpsReadout}——它用夹过的 dt 算，rawDt>50ms 时恒约 20，不可当性能指标）；` +
      `提示条残留 ${soak1.toasts}；堆 ${soak0.heap < 0 ? "不可用" : `${(soak0.heap / 1048576).toFixed(1)}→${(soak1.heap / 1048576).toFixed(1)} MB（Δ${heapMb.toFixed(1)}）`}`,
  );
  // 上面那 12 s 只证明「结构量在量级上正常」；真正要证明的是**裁剪真的会触发**。
  // 记录缓冲的裁剪条件是「超过 850 行就丢掉最早的 100 行」，靠自然跑要 34 s 才够
  // （而且慢机器上更慢）。这里用离线回放的「最快」档（speed=0，单帧最多消费 4000 个样本）
  // 把 40 s 仿真时间一口气喂进去：于是「仿真时间推进了 40 s」与「记录行数仍然 ≤ 850」
  // 同时成立，才真正证明裁剪在工作——少了 splice 的版本会在这里留下 ~1000 行。
  const trim = await page.evaluate(async () => {
    const HZ = 100;
    // 表头用装置自己导出的那套列名（replay.ts 认的就是这个写法，gx_dps 这类缩写不在其列）
    const rows = ["t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2"];
    for (let k = 0; k < 40 * HZ; k++) rows.push(`${(k / HZ).toFixed(3)},1.5,0,0,0,0,9.80665`);
    const r = window.attitudeDemo.replay.import(rows.join(String.fromCharCode(10)), "soak.csv");
    document.getElementById("replay-speed").value = "0";
    document.getElementById("replay-speed").dispatchEvent(new Event("change"));
    // 状态等待：最快档仍受 rAF 频率与单拍预算限制。固定 3 s 在慢 runner 上只喂进 30 s
    // （Ubuntu CI 第 4 轮实测 simTime=30.0，而判据要 >35），这里等它真的喂到 39 s。
    const consumeDeadline = performance.now() + 60000;
    while (performance.now() < consumeDeadline) {
      const sz = window.attitudeDemo.sizes();
      const ri = window.attitudeDemo.replay.info;
      if (sz.simTime >= 39 || ri.idx >= ri.frames) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    const after = window.attitudeDemo.sizes();
    const info = window.attitudeDemo.replay.info;
    window.attitudeDemo.replay.stop();
    return { imported: r, ...after, replayIdx: info.idx };
  });
  check(
    "长跑：40 s 仿真时间喂进去后记录缓冲仍然封顶（裁剪逻辑真的在跑）",
    trim.simTime > 35 && trim.logRows <= trim.logRowsCap && trim.logRows >= 500 && trim.insTrailMax <= trim.insTrailCap,
    `${trim.imported}；仿真时间 ${trim.simTime.toFixed(1)} s（>35 才说明确实灌满过）；` +
      `记录行 ${trim.logRows}/${trim.logRowsCap}，INS 轨迹 ${trim.insTrailMax}/${trim.insTrailCap}（未裁剪的话会各超一倍）`,
  );
  await page.evaluate(() => document.getElementById("panel-collapse-all").click());

  } // app 段结束
  if (runDevices) {
  // ---------- 真实串口模式：用假 Web Serial 端口端到端验证 ----------
  const serialPage = await newPage();
  await serialPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const serialErrors = [];
  serialPage.on("console", (m) => m.type() === "error" && serialErrors.push(m.text()));
  serialPage.on("pageerror", (e) => serialErrors.push(String(e)));
  await serialPage.evaluateOnNewDocument(() => {
    // 帧协议与 firmware/gy87.h 一致：0xAA55 | len=24 | seq | tick | gyro | accel | mag | crc8
    const crc8 = (d, from, to) => {
      let c = 0;
      for (let i = from; i < to; i++) {
        c ^= d[i];
        for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      }
      return c;
    };
    const put = (d, off, v, scale) => {
      const x = Math.round(v * scale);
      const u = x < 0 ? x + 0x10000 : x;
      d[off] = u & 0xff;
      d[off + 1] = (u >> 8) & 0xff;
    };
    const frame = (seq, tick) => {
      const d = new Uint8Array(28);
      d[0] = 0xaa; d[1] = 0x55; d[2] = 24;
      d[3] = seq & 0xff; d[4] = seq >> 8;
      d[5] = tick & 0xff; d[6] = (tick >> 8) & 0xff; d[7] = (tick >> 16) & 0xff; d[8] = (tick >>> 24) & 0xff;
      // 静止水平：accel z=+9.8，mag 沿 NED 地磁（dip≈49°），gyro=0
      put(d, 9, 0, 10); put(d, 11, 0, 10); put(d, 13, 0, 10);
      put(d, 15, 0, 100); put(d, 17, 0, 100); put(d, 19, 9.8, 100);
      put(d, 21, 32.8, 100); put(d, 23, 0, 100); put(d, 25, 37.7, 100);
      d[27] = crc8(d, 2, 27);
      return d;
    };
    let timer = 0;
    const stream = new ReadableStream({
      start(c) {
        let seq = 0;
        let tick = 1000;
        timer = setInterval(() => {
          c.enqueue(frame(seq++, tick));
          tick += 5;
        }, 5);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const port = {
      open: async () => undefined,
      close: async () => clearInterval(timer),
      get readable() {
        return stream;
      },
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: async () => port },
    });
  });
  await gotoSafe(serialPage);
  await serialPage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: BOOT_MS });
  await serialPage.evaluate(() => {
    const sec = document.getElementById("sec-imu");
    if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
  });
  await serialPage.click("#btn-serial");
  await serialPage.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: STATE_MS });
  await serialPage.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 1,
    { timeout: STATE_MS },
  );
  // 等**目标状态**（帧率读数出现 = 假串口的数据真的在流），而不是等一个固定时刻就断言。
  // 实测第 2 轮出现过「时钟已过 1 s 但状态还停在『等待数据帧…』」——那是数据流启动稍慢，
  // 不是产品缺陷；瞄准状态等待既能容忍慢，也能在真卡死时（15 s 内一直没有帧）如实判失败。
  try {
    await serialPage.waitForFunction(() => /帧\/s/.test(document.getElementById("serial-status")?.textContent ?? ""), { timeout: SLOW_MS(15000) });
  } catch { /* 下面按实际读数判定并给出可读原因 */ }
  const serial = await serialPage.evaluate(() => ({
    mode: document.body.dataset.imuMode,
    clock: document.getElementById("clock")?.textContent,
    status: document.getElementById("serial-status")?.textContent,
    scenarioDisabled: document.getElementById("scenario-select").disabled,
    ghostDisabled: document.getElementById("ghost-toggle").disabled,
    noteVisible: !document.getElementById("real-mode-note").classList.contains("hidden"),
    errTitle: document.getElementById("err-title")?.textContent,
    attValue: document.querySelector("#att-legend .legend-chip .val")?.textContent,
  }));
  check(
    "真实串口模式：时钟按帧推进 + 控件停用",
    serial.mode === "real" &&
      parseFloat(serial.clock.replace("t = ", "")) > 1 &&
      serial.scenarioDisabled &&
      serial.ghostDisabled &&
      serial.noteVisible &&
      serial.errTitle.includes("Mahony") &&
      /帧\/s/.test(serial.status) &&
      serial.attValue !== "--",
    `${serial.clock} · ${serial.status}`,
  );
  await serialPage.screenshot({ path: join(shots, "09-real-serial.png") });
  await serialPage.evaluate(() => {
    const sec = document.getElementById("sec-imu");
    if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
  });
  await serialPage.click("#btn-serial");
  await serialPage.waitForFunction(() => document.body.dataset.imuMode === "sim", { timeout: SLOW_MS(5000) });
  const restored = await serialPage.evaluate(() => ({
    mode: document.body.dataset.imuMode,
    scenarioDisabled: document.getElementById("scenario-select").disabled,
  }));
  check("断开后恢复模拟模式与控件", restored.mode === "sim" && !restored.scenarioDisabled, restored.mode);
  check("真实模式控制台零错误", serialErrors.length === 0, serialErrors.slice(0, 3).join(" | ") || "无");
  await serialPage.close();
  } // devices 段结束
} catch (err) {
  failures++;
  aborted = true;
  abortReason = err instanceof Error ? err.message : String(err);
  if (isInfraError(err)) {
    // 别把「浏览器把页面回收了」说成产品缺陷，也别让它看起来像普通失败项
    browserRestarts++;
    console.error(`[FAIL] 基础设施失败（页面/浏览器被回收）— ${err instanceof Error ? err.message : String(err)}；本轮不判通过，请重跑`);
  } else {
    console.error("[FAIL] 冒烟测试异常 —", err instanceof Error ? err.message : String(err));
  }
  try {
    await page.screenshot({ path: join(shots, "99-failure.png") });
  } catch {
    /* ignore */
  }
} finally {
  shuttingDown = true; // 收尾关闭不是「基础设施事件」
  try {
    await browser.close();
  } catch {
    /* 关闭失败不影响结论 */
  }
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* Windows 上 crashpad 文件可能仍被占用：留给系统临时目录清理 */
  }
}

// 基础设施失败不能被「续跑后全绿」掩盖：浏览器进程被回收过，就说明本轮结果不可信。
if (browserRestarts > 0) {
  failures++;
  console.error(`[FAIL] 浏览器进程被回收 ${browserRestarts} 次 — 基础设施失败，本轮不能判通过（请重跑）`);
  // 把现场一起打出来：不是「机器慢」四个字，而是最后用例、断开时刻与当时的堆/DOM
  console.error(`[FAIL]   现场：最后一次用例「${infraDiag.lastCheck}」；断开记录 ${JSON.stringify(infraDiag.disconnects)}；` +
    `堆采样最近 ${infraDiag.samples.length} 个：${JSON.stringify(infraDiag.samples.slice(-4))}`);
}
console.log(failures === 0 ? `\n浏览器冒烟通过 ✅（${passes} 项）` : `\n${failures} 项失败 ❌`);
if (SHARD !== "all") console.log(`（分片 SMOKE_SHARD=${SHARD}）`);
/**
 * 结构化结果（SW-07）：驱动器拿它比对**完整集合**——逐项状态、跳过项、重复项，
 * 以及"这次到底跑完了没有"。数 `[PASS]` 行做不到这一点：少跑几项时行数照样"看着不少"，
 * 而一个被异常打断的进程也能攒出几十行 PASS。
 */
const structured = {
  schemaVersion: 1,
  shard: SHARD,
  url: APP_URL,
  browserVersion,
  viewport: VIEWPORT,
  viewportEnv: process.env.SMOKE_VIEWPORT ?? null,
  completed: !aborted && browserRestarts === 0,
  aborted,
  abortReason: abortReason || null,
  infraRestarts: browserRestarts,
  infraDiag,
  executed: checkResults.length,
  passed: passes,
  failed: failures,
  skipped: skippedChecks,
  duplicateIds,
  identity: { localBuildId: identity.localBuildId, pageBuildId: identity.pageBuildId, available: identity.available, reason: identity.reason },
  results: checkResults,
  diagnostics,
};
const resultPath = process.env.SMOKE_RESULT ? resolve(process.env.SMOKE_RESULT) : null;
if (resultPath) {
  try { writeFileSync(resultPath, `${JSON.stringify(structured, null, 2)}\n`, "utf8"); }
  catch (err) {
    console.error(`[FAIL] 结构化结果写盘失败（${resultPath}）：${err instanceof Error ? err.message : String(err)}`);
    failures++;
    structured.failed = failures;
  }
}
// 单行标记：驱动器没拿到结果文件时，也能从日志里取到同一份事实（不靠解析 PASS 行数）
console.log(`[SMOKE-RESULT] ${JSON.stringify({ shard: SHARD, completed: structured.completed, executed: structured.executed, passed: passes, failed: failures, skipped: skippedChecks.length, duplicates: duplicateIds.length, result: resultPath })}`);
process.exit(failures === 0 ? 0 : 1);
