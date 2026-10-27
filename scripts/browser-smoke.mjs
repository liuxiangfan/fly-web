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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const URL = process.env.SMOKE_URL ?? "http://127.0.0.1:4173/";
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("找不到 Edge/Chrome，可用 CHROME_PATH / EDGE_PATH 指定可执行文件");
  process.exit(2);
}

const shots = join(process.cwd(), "screenshots");
if (!existsSync(shots)) mkdirSync(shots);
let failures = 0;
let passes = 0;
const check = (name, cond, detail) => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name} — ${detail}`);
  cond ? passes++ : failures++;
};

// 固定 user-data-dir：Windows 上 Puppeteer 的临时 profile 清理偶尔 EBUSY，
// 会让「测试全部通过」的进程以异常退出码结束。这里自己管目录并在收尾时容错删除。
const profileDir = join(tmpdir(), "quat-demo-smoke-profile");
const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  userDataDir: profileDir,
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
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  // 等待真实仿真推进（rAF）——隐藏标签页会冻结，headless 新模式下正常运行
  await page.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 2,
    { timeout: 30000 }, // 软件渲染（swiftshader）下 CI 的首帧可能很慢，给足余量
  );
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
    "文档对话框焦点与分页",
    docOpen.role === "dialog" && docOpen.focus === "btn-docs-close" && docMath.page === "math" && docClosed.hidden,
    `role=${docOpen.role} focus=${docOpen.focus} page=${docMath.page} esc=${docClosed.hidden} restore=${docClosed.focus}`,
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

  // CSV 导出：拦截 Blob，检查参数头与数据行
  // 拦截 blob 下载跑两遍：默认档（姿态角与误差）与「带四元数」档。
  // 导出前会弹选项对话框（这是用户要求的行为），所以要先点确认按钮。
  const NL = String.fromCharCode(10);
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
      document.getElementById("btn-export").click();
      await new Promise((r) => setTimeout(r, 120));
      const dlg = document.getElementById("export-dialog");
      if (!dlg.open) throw new Error("导出弹窗没有打开");
      const meta = document.getElementById("export-meta")?.textContent ?? "";
      document.querySelector(`input[name="export-scope"][value="${scopeValue}"]`).checked = true;
      document.getElementById("export-confirm").click();
      await new Promise((r) => setTimeout(r, 250));
      URL.createObjectURL = orig;
      HTMLAnchorElement.prototype.click = origClick;
      return { text, meta, closed: !dlg.open };
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
      base.closed,
    csv ? `${csvLines.length} 行 / ${cols.length} 列；弹窗提示「${base.meta.split("·")[0].trim()}」` : "未生成",
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
    await new Promise((r) => setTimeout(r, 400));
    URL.createObjectURL = orig;
    HTMLAnchorElement.prototype.click = origClick;
    if (!csv) return { err: "导出未产生 CSV" };
    const header = csv.split(NL).find((l) => l.startsWith("t_s")) ?? "";
    const imp = window.attitudeDemo.replay.import(csv, "roundtrip.csv");
    await new Promise((r) => setTimeout(r, 1200));
    const info = window.attitudeDemo.replay.info;
    const status = document.getElementById("replay-status").textContent;
    const mode = document.body.dataset.imuMode;
    const controlsOff = document.getElementById("scenario-select").disabled;
    window.attitudeDemo.replay.stop();
    await new Promise((r) => setTimeout(r, 300));
    const afterStop = window.attitudeDemo.replay.info;
    return { header, imp, info, status, mode, controlsOff, afterStop };
  });
  check(
    "导出→导入闭环：原始 IMU 能回放且退出后回到模拟",
    Boolean(roundTrip.header?.includes("gyro_x_dps")) &&
      roundTrip.imp?.startsWith("ok:") &&
      roundTrip.info?.active === true &&
      roundTrip.info?.idx > 0 &&
      roundTrip.mode === "real" &&
      roundTrip.controlsOff === true &&
      roundTrip.afterStop?.active === false,
    `${roundTrip.imp}；回放中 ${roundTrip.info?.idx}/${roundTrip.info?.frames} 帧，模式=${roundTrip.mode}，模拟控件停用=${roundTrip.controlsOff}，退出后 active=${roundTrip.afterStop?.active}`,
  );

  // 深链：当前 hash 重载后参数应保持
  const deep = await page.evaluate(() => ({
    hash: location.hash,
    bias: document.getElementById("imu-gyro-bias").value,
    view: document.body.dataset.view,
  }));
  await page.goto(URL.split("#")[0] + deep.hash, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 0.5,
    { timeout: 30000 },
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
    const halo = g.group.children.find(
      (c) => c.type === "Mesh" && c.geometry.type === "TorusGeometry" &&
        c.material.color.getHexString() === "f85149",
    );
    // 脉冲环由 setLockVisual 在每 0.1 s 的 UI 块里驱动：再等一拍让它跟上
    await new Promise((r) => setTimeout(r, 300));
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
  const mobilePage = await browser.newPage();
  await mobilePage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await mobilePage.goto(URL, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 15000 });
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
  await mobilePage.close();

  check("控制台零错误", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "无");

  // ---------- 真实串口模式：用假 Web Serial 端口端到端验证 ----------
  const serialPage = await browser.newPage();
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
  await serialPage.goto(URL, { waitUntil: "domcontentloaded" });
  await serialPage.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 15000 });
  await serialPage.evaluate(() => {
    const sec = document.getElementById("sec-imu");
    if (sec?.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
  });
  await serialPage.click("#btn-serial");
  await serialPage.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: 5000 });
  await serialPage.waitForFunction(
    () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 1,
    { timeout: 8000 },
  );
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
  await serialPage.waitForFunction(() => document.body.dataset.imuMode === "sim", { timeout: 5000 });
  const restored = await serialPage.evaluate(() => ({
    mode: document.body.dataset.imuMode,
    scenarioDisabled: document.getElementById("scenario-select").disabled,
  }));
  check("断开后恢复模拟模式与控件", restored.mode === "sim" && !restored.scenarioDisabled, restored.mode);
  check("真实模式控制台零错误", serialErrors.length === 0, serialErrors.slice(0, 3).join(" | ") || "无");
  await serialPage.close();
} catch (err) {
  failures++;
  console.error("[FAIL] 冒烟测试异常 —", err instanceof Error ? err.message : String(err));
  try {
    await page.screenshot({ path: join(shots, "99-failure.png") });
  } catch {
    /* ignore */
  }
} finally {
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

console.log(failures === 0 ? `\n浏览器冒烟通过 ✅（${passes} 项）` : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
