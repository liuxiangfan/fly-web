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
const errsEmpty = (errs) => errs.length === 0;
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
  await new Promise((r) => setTimeout(r, 700)); // 先确保至少画过一帧
  const compA = await canvasStat("fig-comp-demo");
  const bodeSt = await canvasStat("fig-bode-demo");
  await new Promise((r) => setTimeout(r, 3000));
  const compB = await canvasStat("fig-comp-demo");
  check(
    "文档演示：互补滤波曲线在实时推进 + 频域图有图形",
    compA.sig !== compB.sig && painted(compA) && painted(compB) && painted(bodeSt),
    `曲线 ${compA.ink}/${compA.cells} → ${compB.ink}/${compB.cells}（指纹变化=${compA.sig !== compB.sig}）；频域 ${bodeSt.ink}/${bodeSt.cells}`,
  );

  await gotoDocPage("math"); // 顺序 / 校准 / Allan / 一维卡尔曼四个演示都在这一页
  await new Promise((r) => setTimeout(r, 700));
  const ordA = await canvasStat("fig-order-demo");
  const calA = await canvasStat("fig-calib-demo");
  await new Promise((r) => setTimeout(r, 2500)); // 摆角此刻转到约 35°
  const ordB = await canvasStat("fig-order-demo");
  const calB = await canvasStat("fig-calib-demo");
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
    ordA.sig !== ordB.sig && calA.sig !== calB.sig && painted(ordA) && painted(ordB) && painted(calA) && painted(calB),
    `顺序 ${ordA.ink} → ${ordB.ink}（变化=${ordA.sig !== ordB.sig}）；校准 ${calA.ink} → ${calB.ink}（变化=${calA.sig !== calB.sig}）`,
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
    return { header, imp, info, status, mode, controlsOff, afterStop, rows };
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
    `导出前已记录 ${roundTrip.rows} 行；${roundTrip.imp}；回放中 ${roundTrip.info?.idx}/${roundTrip.info?.frames} 帧，` +
      `模式=${roundTrip.mode}，模拟控件停用=${roundTrip.controlsOff}，退出后 active=${roundTrip.afterStop?.active}`,
  );

  // ---------- BLE IMU：假 Web Bluetooth（含 20 字节分片的 28 字节帧） ----------
  // 真机无法在 CI 配对，但「应用侧」整条链路可以像假串口那样完整验证：
  // 假设备暴露一个 GATT 服务 + 一个 notify 特征，用 20 字节分片发 28 字节二进制帧，
  // 专门验证「BLE 通知天然分片、装置靠流式缓冲重组」这件事。
  const runBleCase = async (protocol) => {
    const pg = await browser.newPage();
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
      let notifyCb = null;
      const char = {
        uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
        properties: { notify: true },
        value: null,
        startNotifications: async () => char,
        stopNotifications: async () => char,
        addEventListener: (t, cb) => {
          if (t === "characteristicvaluechanged") notifyCb = cb;
        },
      };
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
            if (notifyCb) notifyCb({ target: char });
          }
          return;
        }
        for (let i = 0; i < f.length; i += 20) {
          const part = f.slice(i, i + 20);
          char.value = new DataView(part.buffer, part.byteOffset, part.byteLength);
          if (notifyCb) notifyCb({ target: char });
        }
      };
    }, protocol);
    await pg.goto(URL, { waitUntil: "domcontentloaded" });
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 15000 });
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
    await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: 6000 });
    // 每 10 ms 发一帧（分片后是两条通知）
    await pg.evaluate(() => {
      window.__bleTimer = setInterval(() => window.__bleEmit(), 10);
    });
    // 等「真的在收帧」：状态行出现非零帧率，比等时钟可靠（连接时 resetSim 会清零时钟，
    // 而时钟也可能被别的路径推进）。这一条以前踩过：等到的是「连接前的时钟」。
    await pg.waitForFunction(
      () => /[1-9]\d* 帧\/s/.test(document.getElementById("serial-status")?.textContent ?? ""),
      { timeout: 12000 },
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

    // ③ 公式复制：每块公式都有按钮，且点击后有反馈（剪贴板可能被拒，允许「已选中」）
    out.formulaCopyButtons = document.querySelectorAll(".formula-copy").length;
    const btn = document.querySelector(".doc-page .formula .formula-copy");
    document.getElementById("btn-docs").click();
    await sleep(400);
    btn.click();
    await sleep(300);
    out.formulaCopyFeedback = btn.textContent;
    document.getElementById("btn-docs-close").click();
    await sleep(300);
    return out;
  });
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
  check(
    "公式一键复制：按钮齐备且点击有反馈",
    extras.formulaCopyButtons > 20 &&
      (extras.formulaCopyFeedback === "已复制" || extras.formulaCopyFeedback === "已选中"),
    `${extras.formulaCopyButtons} 个公式块都有复制按钮；点击后按钮显示「${extras.formulaCopyFeedback}」`,
  );

  // ④ 打印媒体：应用外壳必须消失、只剩文档正文（这是「存 PDF 发讲义」的前提）
  const printCase = await (async () => {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 900, height: 1200 });
    await pg.goto(URL, { waitUntil: "domcontentloaded" });
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
    const pg = await browser.newPage();
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
    await pg.goto(URL, { waitUntil: "domcontentloaded" });
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
  const tourCase = await page.evaluate(async () => {
    const sec = document.getElementById("sec-tour");
    if (sec.classList.contains("collapsed")) sec.querySelector(".panel-toggle").click();
    document.getElementById("tour-start").click();
    const steps = [];
    const snap = () => ({
      counter: document.getElementById("tour-counter").textContent,
      title: document.getElementById("tour-title").textContent,
      body: document.getElementById("tour-body").textContent.length,
      view: document.body.dataset.view,
      source: document.getElementById("source-select").value,
      scenario: document.getElementById("scenario-select").value,
      cardVisible: !document.getElementById("tour-card").classList.contains("hidden"),
      introHidden: document.getElementById("tour-intro").classList.contains("hidden"),
      next: document.getElementById("tour-next").textContent,
    });
    steps.push(snap());
    for (let k = 0; k < 13; k++) {
      document.getElementById("tour-next").click();
      steps.push(snap());
    }
    const done = document.getElementById("tour-card").classList.contains("hidden");
    const restored = !document.getElementById("tour-intro").classList.contains("hidden");
    // 再按一次「开始」应能重新开课（上次走到底已经退出）
    document.getElementById("tour-start").click();
    const restarted = document.getElementById("tour-counter").textContent;
    document.getElementById("tour-close").click();
    const closed = document.getElementById("tour-card").classList.contains("hidden");
    return { steps, done, restored, restarted, closed };
  });
  const walked = tourCase.steps.slice(0, 13);
  check(
    "引导课程：13 步逐条装载现场（实验/视图/面板）并正常收尾",
    walked.length === 13 &&
      new Set(walked.map((s) => s.title)).size === 13 &&
      walked.every((s) => s.cardVisible && s.body > 80) &&
      walked.every((s, k) => s.counter.startsWith(`第 ${k + 1} / 13 步`)) &&
      walked[0].introHidden &&
      walked[7].view === "gimbal" && // 第 8 步：万向节锁几何
      walked[10].view === "quat" && // 第 11 步：4D 投影
      walked[1].source === "pure" && // 第 2 步：零偏漂移实验把来源切到纯积分
      tourCase.done &&
      tourCase.restored &&
      tourCase.restarted.startsWith("第 1 / 13 步") &&
      tourCase.closed,
    `${walked.length} 步；标题去重 ${new Set(walked.map((s) => s.title)).size}；` +
      `第 2 步来源=${walked[1].source}（应 pure）；第 8/11 步视图=${walked[7].view}/${walked[10].view}（应 gimbal/quat）；` +
      `走完自动收起=${tourCase.done}、开始入口恢复=${tourCase.restored}；✕ 可退出=${tourCase.closed}`,
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

  // ---------- 文本行协议 / MAVLink 协议：各自的假串口端到端 ----------
  // 这两种协议是本轮新增的「硬件接入入口」，必须在真浏览器里跑一遍：
  // 假端口按各自格式发流，断言解析后的读数与值班（unit/mounting）都正确。
  const runProtocolCase = async (protocol, makeWire) => {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const errs = [];
    pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.evaluateOnNewDocument(makeWire, protocol);
    await pg.goto(URL, { waitUntil: "domcontentloaded" });
    await pg.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 15000 });
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
    await pg.waitForFunction(() => document.body.dataset.imuMode === "real", { timeout: 6000 });
    await pg.waitForFunction(
      () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 0.8,
      { timeout: 10000 },
    );
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
      for (const el of root.querySelectorAll("*")) {
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
    // 文档有 14 个分页，全部扫一遍（每页切换后等 150 ms 让布局稳定）。
    // 只扫一两页是不够的：新增页面（磁力计校准页的 .code 代码块）与只出现在某页的
    // 记号都会漏掉——「全站达 AA」这句话必须真的覆盖全站。
    const pages = [...document.querySelectorAll(".doc-page")].map((p) => p.dataset.docPage);
    for (const p of pages) {
      document.querySelectorAll(`.module-link[data-doc="${p}"]`).forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 150));
      scan(document.getElementById("docs-overlay"));
    }
    document.getElementById("btn-docs-close").click();
    document.getElementById("panel-collapse-all").click();
    const positiveTab = [...document.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0).length;
    return { lowContrast, noName, positiveTab, scanned: true };
  });
  const worst = a11y.lowContrast
    .slice(0, 6)
    .map((x) => `${x.r}<${x.need} ${x.fs}px ${x.el}「${x.text}」${x.fg} on ${x.bg}`);
  check(
    "可访问性：全站文字对比度达 WCAG AA（暗色 + 浅色文档两套主题）",
    a11y.lowContrast.length === 0,
    a11y.lowContrast.length ? `${a11y.lowContrast.length} 处不达标：${worst.join("；")}` : `扫描完成，未发现低于 (4.5:1 / 大字 3:1) 的文字`,
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
  await new Promise((r) => setTimeout(r, 12000));
  const soak1 = await soakRead();
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
    await new Promise((res) => setTimeout(res, 3000)); // 让主循环把 4000 帧消费掉
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
