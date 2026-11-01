/**
 * 长稳与并发压力验收（真机演示前的自检；不进 `npm run check`，因为要跑分钟级）。
 *
 * 为什么需要（第五轮复核的 P1/P2）：
 * 冒烟用例都是秒级的——它们证明「功能对」，但证明不了**连续演示几十分钟**不出事：
 * 内存是否持续增长、四个滚动容器是否一直封顶、曲线是否会因为数据源切换而错位、
 * 批量评测搬进 Worker 后主线程是否仍然可交互。这些只有真跑一段时间才看得出来。
 *
 * 用法：
 *   npm run build && npm run preview      # 另开一个终端
 *   npm run soak                          # 默认 120 s
 *   npm run soak -- --seconds=600 --batch # 10 分钟 + 周期性跑批量评测
 *
 * 判定（任一不满足即退出码 1，并写进 docs/generated/soak.json）：
 *   1. 控制台零错误（含未捕获异常）；
 *   2. 滚动容器始终封顶（logRows ≤ 容量、rawRecord ≤ 容量、曲线 ≤ 容量）；
 *   3. 堆增长受控：末值 − 第 2 次采样 ≤ 阈值（默认 24 MB；GC 抖动留足余量）；
 *   4. 仿真时钟在推进（末尾 simTime 明显大于开头）。
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `--drop-every=3` 与 `--dropEvery=3` 都要能生效（ROUND11：此前只认 camelCase，
 *  于是文档/命令里的 `--drop-every=3` 被忽略、实际仍按默认 8 s 注入，判据与命令不符）。 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    const key = m ? m[1].replace(/-([a-z])/g, (_, c) => String(c).toUpperCase()) : a;
    return m ? [key, m[2] ?? "true"] : [a, "true"];
  }),
);

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Users/32988/AppData/Local/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("找不到 Chrome/Edge，可用 CHROME_PATH 指定");
  process.exit(2);
}

const url = args.url ?? process.env.SHOT_URL ?? "http://127.0.0.1:4173/";
const seconds = Number(args.seconds ?? 120);
const intervalMs = Number(args.interval ?? 5000);
const heapLimitMb = Number(args.heapLimitMb ?? 24);
/** 显式允许"堆未测量"（默认不允许：缺测应当失败，而不是静默通过） */
const allowNoHeap = Boolean(args.allowNoHeap);
/** 批量评测期望的种子数（状态文案必须出现"N 个种子"） */
const expectedSeeds = Number(args.seeds ?? 10);
const withBatch = Boolean(args.batch);
/**
 * `--reconnect`：注入假串口并在运行期间反复「拔线」，
 * 用来验证断线自动重连在长时间、多次断链下仍然稳定（真机验收前的最低门槛）。
 * 真机验收仍需现场，但这个模式能在 CI 里跑出「重连 N 次、零错误、帧数持续增长」的判据。
 */
const withReconnect = Boolean(args.reconnect);
const dropEverySec = Number(args.dropEvery ?? 8);

const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

if (withReconnect) {
  await page.evaluateOnNewDocument((dropEveryMs) => {
    const enc = new TextEncoder();
    const line = (t) => enc.encode(t.toFixed(3) + ",1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7" + String.fromCharCode(10));
    let t = 0;
    let opens = 0;
    /** 每条流自己的定时器：共用一个变量会在重连后把旧定时器漏掉，往已 error 的流 enqueue → pageerror */
    let activeTimer = 0;
    window.__soak = { opens: 0, drops: 0, streams: 0, cur: 0 };
    // 丢弃节奏由 --drop-every 真实控制（此前固定 60 帧，于是"预期丢弃次数"改了、
    // 真实丢弃没变，判据在拿两个不相干的数量比大小——复核 6.4）。
    const dropAfterFrames = Math.max(2, Math.round(dropEveryMs / 10));
    const makeStream = () => {
      let sentSinceOpen = 0;
      let myTimer = 0;
      // 只有"当前那条连接"的报错才算一次断链：被替换掉的旧流即使定时器还在跑，
      // 它的报错也不代表当前连接断了（否则会数出幽灵断链，让"断链次数"与"重连次数"对不上）
      const myId = ++window.__soak.streams;
      window.__soak.cur = myId;
      const stream = new ReadableStream({
        start(c) {
          myTimer = setInterval(() => {
            if (window.__soak.cur !== myId) {
              clearInterval(myTimer);
              return;
            }
            t += 0.01;
            sentSinceOpen++;
            if (sentSinceOpen > dropAfterFrames) {
              clearInterval(myTimer);
              if (activeTimer === myTimer) activeTimer = 0;
              window.__soak.drops++;
              c.error(new Error("device disconnected"));
              return;
            }
            try {
              c.enqueue(line(t));
            } catch {
              clearInterval(myTimer);
            }
          }, 10);
          activeTimer = myTimer;
        },
        cancel() {
          clearInterval(myTimer);
        },
      });
      return stream;
    };
    const port = {
      open: async () => {
        opens++;
        window.__soak.opens = opens;
        stream = makeStream();
      },
      close: async () => {
        clearInterval(activeTimer);
        activeTimer = 0;
      },
      get readable() {
        return stream;
      },
    };
    let stream = makeStream();
    Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
  }, dropEverySec * 1000);
}

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 20000 });

// 压力现场：全帧记录 + 高频解算 + 延迟/带宽/降采样 + 三路延迟差（最容易出问题的一组）
await page.evaluate((wantReconnect) => {
  const withReconnect = wantReconnect;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") {
      if (el.checked !== v) el.click();
      return;
    }
    el.value = String(v);
    el.dispatchEvent(new Event("input"));
    el.dispatchEvent(new Event("change"));
  };
  set("raw-record-toggle", true);
  set("solve-rate", 500);
  set("imu-delay", 8);
  set("imu-delay-skew", 6);
  set("imu-bandwidth", 40);
  set("imu-sample-rate", 100);
  document.getElementById("sec-imu")?.classList.remove("collapsed");
  if (withReconnect) {
    const proto = document.getElementById("serial-protocol");
    if (proto) {
      proto.value = "text";
      proto.dispatchEvent(new Event("change", { bubbles: true }));
    }
    document.getElementById("btn-serial").click();
  }
}, withReconnect);

const samples = [];
const t0 = Date.now();
let batchRuns = 0;
/** 每一批的记录（启动/完成/失败）：报告里必须能看出「跑了几批、成功几批、有没有超时」 */
const batchLog = [];
while ((Date.now() - t0) / 1000 < seconds) {
  await new Promise((r) => setTimeout(r, intervalMs));
  if (withBatch && !withReconnect && (Date.now() - t0) / 1000 > 10 && batchRuns < 3) {
    batchRuns++;
    const startedAt = Date.now();
    // 世代必须在**点击之前**读：点下去那一刻世代就已经 +1 了
    const genBefore = await page.evaluate(() => window.attitudeDemo.experiment.batchState().generation);
    await page.evaluate(() => {
      const sel = document.getElementById("batch-runs");
      sel.value = "10";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("btn-batch").click();
    });
    // 先确认它**真的启动**：真实/回放模式下批量评测会被拒绝（没有真值），
    // 只等「完成」会把上一批的旧文案当成成功（第一次跑就踩到了这个假通过）。
    let started = false;
    try {
      await page.waitForFunction(
        () => {
          const s = window.attitudeDemo.experiment.batchState();
          return s.running === true || s.activeJob > 0;
        },
        { timeout: 5000 },
      );
      started = true;
    } catch {
      started = false;
    }
    let outcome = started ? "timeout" : "not-started";
    let rows = 0;
    let genAfter = genBefore;
    let seedsDeclared = false;
    if (started) {
      try {
        await page.waitForFunction(() => (document.getElementById("batch-status")?.textContent ?? "").startsWith("完成"), {
          timeout: 120000,
        });
        outcome = "completed";
      } catch {
        outcome = "timeout";
      }
      const after = await page.evaluate(() => ({
        gen: window.attitudeDemo.experiment.batchState().generation,
        rows: document.querySelectorAll("#batch-table tbody tr").length,
        status: document.getElementById("batch-status")?.textContent ?? "",
      }));
      rows = after.rows;
      genAfter = after.gen;
      // 结果完整性：状态文案必须声明**期望的种子数**（ROUND12：只验"完成"文案会放过 1 批 1 行）
      seedsDeclared = after.status.includes(`${expectedSeeds} 个种子`);
    }
    // 记录世代与行数：只看「完成」文案无法区分"这一批的结果"与"上一批的残留"（复核 6.4）
    batchLog.push({
      index: batchRuns,
      outcome,
      elapsedMs: Date.now() - startedAt,
      genBefore,
      genAfter,
      generationAdvanced: genAfter !== genBefore,
      rows,
      seedsDeclared,
    });
  }
  const s = await page.evaluate(() => {
    const sizes = window.attitudeDemo.sizes();
    const heap = performance.memory?.usedJSHeapSize ?? null;
    return {
      t: sizes.simTime,
      logRows: sizes.logRows,
      logRowsCap: sizes.logRowsCap,
      rawRows: sizes.rawRows,
      rawRowsCap: sizes.rawRowsCap,
      // sizes().charts 是 [{count, cap}, …]（不是数字数组）——按结构读，别猜
      charts: sizes.charts.map((c) => c.count),
      chartCaps: sizes.charts.map((c) => c.cap),
      insTrail: sizes.insTrailMax,
      insTrailCap: sizes.insTrailCap,
      serialQueue: sizes.serialQueue,
      heapMb: heap === null ? null : heap / 1024 / 1024,
      fps: document.getElementById("fps")?.textContent ?? "",
      serialFrames: window.attitudeDemo.plumbing().frames,
      reconnects: window.attitudeDemo.plumbing().reconnects,
      serialRunning: window.attitudeDemo.plumbing().serial,
      /** 采样墙钟（毫秒）：逐段增长判据要按真实间隔比较，不能把"同一瞬间的两次读数"算成停流 */
      at: Date.now(),
      /** 假串口**实际**发生的断链次数（与"预期"分开记录，判据用它而不是用期望值） */
      drops: window.__soak?.drops ?? 0,
      opens: window.__soak?.opens ?? 0,
      /** 批次世代：用来确认"表格里的结果"确实来自本次启动的那一批 */
      batchGeneration: window.attitudeDemo.experiment.batchState().generation,
      reconnectPending: window.attitudeDemo.plumbing().reconnectPending,
      sourceKind: window.attitudeDemo.plumbing().sourceKind,
    };
  });
  samples.push(s);
  const heapText = s.heapMb === null ? "n/a" : `${s.heapMb.toFixed(1)}MB`;
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] t=${s.t.toFixed(1)}s log=${s.logRows}/${s.logRowsCap} ` +
      `raw=${s.rawRows}/${s.rawRowsCap} charts=${s.charts.join("/")}（上限 ${s.chartCaps.join("/")}） ` +
      `ins=${s.insTrail}/${s.insTrailCap} heap=${heapText} fps=${s.fps}` +
      (withReconnect
        ? ` | drops=${s.drops} opens=${s.opens} reconn=${s.reconnects} run=${s.serialRunning} pend=${s.reconnectPending} kind=${s.sourceKind}`
        : ""),
  );
}

/**
 * 收尾等待：最后一次断链可能正好落在计时结束前，1 s 退避还没走完就被判"没恢复"。
 * 这里给最多 10 s 让在途的断链完成一次重连，之后再做判定——比"允许少一次"更诚实。
 */
if (withReconnect) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      drops: window.__soak?.drops ?? 0,
      opens: window.__soak?.opens ?? 0,
      reconnects: window.attitudeDemo.plumbing().reconnects,
      frames: window.attitudeDemo.plumbing().frames,
      running: window.attitudeDemo.plumbing().serial,
      reconnectPending: window.attitudeDemo.plumbing().reconnectPending,
      sourceKind: window.attitudeDemo.plumbing().sourceKind,
      t: window.attitudeDemo.sizes().simTime,
    }));
    samples.push({
      ...samples[samples.length - 1],
      ...st,
      at: Date.now(),
      serialFrames: st.frames,
      serialRunning: st.running,
      t: st.t,
      drops: st.drops,
      reconnects: st.reconnects,
    });
    console.log(`[settle] drops=${st.drops} reconn=${st.reconnects} run=${st.running} pend=${st.reconnectPending} kind=${st.sourceKind} frames=${st.frames}`);
    if (st.drops === 0 || st.reconnects >= st.drops) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const last = samples[samples.length - 1];
const heapSeries = samples.map((s) => s.heapMb).filter((v) => v !== null);
const heapBase = heapSeries.length > 1 ? heapSeries[1] : heapSeries[0] ?? 0;
const heapGrow = (heapSeries[heapSeries.length - 1] ?? 0) - heapBase;
const capped = samples.every(
  (s) =>
    s.logRows <= s.logRowsCap &&
    s.rawRows <= s.rawRowsCap &&
    s.charts.every((v, i) => v <= s.chartCaps[i]) &&
    s.insTrail <= s.insTrailCap,
);
/**
 * 时钟判据分两种模式（这不是放水，而是断言了不同的性质）：
 *  - 常规长稳：仿真时钟应按墙钟的 ≥30% 推进（慢机器/软件渲染下留足余量）。
 *  - 重连压力：数据通路被**故意**反复打断（每 0.6 s 一次），总推进量必然远小于墙钟；
 *    此时断言的是「凡是数据通路存活的那段时间，时钟都严格推进」——这才能区分
 *    「冻结生效」与「时钟被重置/卡死」。
 */
const liveSamples = samples.filter((s) => s.serialRunning !== false);
const clockStrictlyAdvancesWhenLive = liveSamples.every((s, i) => i === 0 || s.t >= liveSamples[i - 1].t);
const clockAdvanced = withReconnect
  ? clockStrictlyAdvancesWhenLive && last.t > samples[0].t
  : samples.length > 1 && last.t - samples[0].t > seconds * 0.3;
const errorsOk = consoleErrors.length === 0;
const lastReconnects = last.reconnects;
const expectedDrops = Math.floor(seconds / dropEverySec);
/**
 * 重连判据：用**只增不减的重连成功计数** + 帧计数，而不是「某个采样点的 serialRunning」。
 * 采样间隔 20 s 时，恰好落在「已连上」那 0.6 s 窗口内的概率很低（第一次跑就出现了假失败）；
 * 计数与帧数则是累积证据：重连 69 次本身就说明连接成功过 69 次。
 */
/**
 * 重连判据改用**实际发生的断链次数**（window.__soak.drops）与重连成功计数比较，
 * 而不是「按秒数除出来的期望次数」——后者与实际注入无关（复核 6.4）。
 */
const actualDrops = last.drops ?? 0;
// 实际断链几次就必须成功重连几次（收尾等待已让在途的断链走完）
const reconnectOk =
  !withReconnect ||
  (lastReconnects >= Math.max(1, actualDrops) &&
    // 每次断链都必须真的重新 open 过端口（只比"重连计数"会漏掉"计数被别处抬高"的情况）
    (last.opens ?? 0) >= actualDrops &&
    last.serialFrames > 0);
const framesGrew = !withReconnect || (last.serialFrames > 0 && samples[samples.length - 1].serialFrames > samples[0].serialFrames);
/**
 * 逐段持续恢复：把「通路存活」的相邻采样点两两比较——
 * 只要两次都在跑、且期间没有发生重连，帧计数就必须**严格增长**。
 * 旧判据 `frames >= prev || running === false` 会放过「中间停流但恰好落在重连窗口外」的假恢复
 * （复核 6.4：序列 (1,1)→(1,1)→(2,2) 中间停流仍 PASS）。
 */
let stallPairs = 0;
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  // 只在**足够长的存活窗口**里要求增长：同一瞬间的两次读数（收尾阶段 500 ms 轮询的第一次）
  // 帧数天然相同，那是采样伪影，不是停流。
  if (b.at - a.at < 300) continue;
  if (a.serialRunning && b.serialRunning && b.reconnects === a.reconnects && b.serialFrames <= a.serialFrames) stallPairs++;
}
const reconnectRecoveryOk =
  !withReconnect || (stallPairs === 0 && last.serialFrames > samples[0].serialFrames);
/**
 * 批量：发起了就必须全部完成，且**世代必须推进、表格必须有行**——
 * "完成"文案可能是上一批留下的（复核 6.4：冒烟里踩过一次假通过）。
 */
const batchOk =
  !withBatch ||
  (batchLog.length > 0 &&
    batchLog.every(
      (b) =>
        b.outcome === "completed" &&
        b.generationAdvanced === true &&
        b.rows > 0 &&
        b.seedsDeclared === true, // 文案必须声明期望种子数，证明这一批的规模与预期一致
    ));
/**
 * 堆必须**真的测过**（ROUND12）：旧实现把"没有堆样本"当成通过——缺测不能算通过。
 * 只有显式加 --allowNoHeap（或非 Chromium 环境）时才降级为 NOT_MEASURED。
 */
const heapMeasured = heapSeries.length >= 2 && allowNoHeap !== true;
const heapOk = heapMeasured ? heapGrow <= heapLimitMb : false;

/**
 * **逐段恢复**（ROUND12）：每一次断链（reconnects 增加）之后，串口累计帧必须比断链前更多——
 * 只比"末值 > 首值"会漏掉"某一次重连后再也不供帧、靠后面某次凑数"这种假恢复。
 */
let reconnectWithoutRecovery = 0;
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  if (b.reconnects > a.reconnects && b.serialFrames <= a.serialFrames) reconnectWithoutRecovery++;
}
if (withReconnect && reconnectWithoutRecovery > 0) {
  console.log(`[FAIL] 有 ${reconnectWithoutRecovery} 次重连之后累计帧没有增长（假恢复）`);
}

const report = {
  generatedAt: new Date().toISOString(),
  url,
  seconds,
  intervalMs,
  withBatch,
  withReconnect,
  samples,
  batchLog,
  verdict: {
    errorsOk,
    capped,
    heapOk,
    clockAdvanced,
    clockGrowthSec: last.t - (samples[0]?.t ?? 0),
    reconnectOk,
    heapMeasured,
    reconnectWithoutRecovery,
    actualDrops,
    expectedDrops,
    opens: last.opens ?? 0,
    stallPairs,
    framesGrew,
    reconnectRecoveryOk,
    batchOk,
    heapGrowMb: heapGrow,
    heapLimitMb,
    consoleErrors: consoleErrors.slice(0, 20),
    /** 总体结论：任何一项不过都为 false（报告里直接可见，不必自己推断） */
    pass:
      errorsOk && capped && heapOk && heapMeasured && clockAdvanced && reconnectOk && framesGrew &&
      reconnectRecoveryOk && reconnectWithoutRecovery === 0 && batchOk,
  },
};
mkdirSync(join("docs", "generated"), { recursive: true });
writeFileSync(join("docs", "generated", "soak.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log("");
console.log(`[${errorsOk ? "PASS" : "FAIL"}] 控制台零错误（${consoleErrors.length} 条）`);
console.log(`[${capped ? "PASS" : "FAIL"}] 滚动容器始终封顶`);
console.log(
  heapMeasured
    ? `[${heapOk ? "PASS" : "FAIL"}] 堆增长受控：${heapGrow.toFixed(1)} MB（上限 ${heapLimitMb} MB）`
    : `[FAIL] 堆未测量（NOT_MEASURED）——缺测不算通过；如确需跳过请显式 --allowNoHeap`,
);
console.log(
  `[${clockAdvanced ? "PASS" : "FAIL"}] 仿真时钟在推进：${samples[0]?.t.toFixed(1)} → ${last?.t.toFixed(1)} s` +
    (withReconnect ? "（重连压力：断言「通路存活期间不倒退」）" : `（要求 ≥${(seconds * 0.3).toFixed(0)} s）`),
);
if (withReconnect) {
  console.log(
    `[${reconnectOk ? "PASS" : "FAIL"}] 断线重连压力：实际断链 ${actualDrops} 次、重连成功 ${lastReconnects} 次` +
      `（要求 ≥max(1, 实际断链数)=${Math.max(1, actualDrops)}）、累计帧 ${last.serialFrames}`,
  );
  console.log(`[${framesGrew ? "PASS" : "FAIL"}] 重连后数据流恢复：串口累计帧 ${samples[0]?.serialFrames} → ${last.serialFrames}`);
  console.log(`[${reconnectRecoveryOk ? "PASS" : "FAIL"}] 通路存活期间帧计数严格增长（停流对 ${stallPairs}）`);
}
if (withBatch) {
  console.log(
    `[${batchOk ? "PASS" : "FAIL"}] 批量评测：${batchLog.length} 批，` +
      batchLog
        .map((b) => `#${b.index} ${b.outcome}(${(b.elapsedMs / 1000).toFixed(1)}s, ${b.rows} 行, gen ${b.genBefore}→${b.genAfter})`)
        .join(" "),
  );
}
console.log(`报告：docs/generated/soak.json`);

await browser.close();
process.exit(
  errorsOk && capped && heapOk && heapMeasured && clockAdvanced && reconnectOk && framesGrew &&
    reconnectRecoveryOk && reconnectWithoutRecovery === 0 && batchOk
    ? 0
    : 1,
);
