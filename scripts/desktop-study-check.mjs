// Windows 桌面定向检查。先准备好本地 preview，再运行 node scripts/desktop-study-check.mjs。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { readProvenance } from "./build-provenance.mjs";
import { fetchServedProvenance, identityProblems } from "./served-build.mjs";
import { cleanupArtifactDir, testArtifactTempDir } from "./test-artifacts.mjs";

const url = "http://127.0.0.1:4173/";
const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const served = await fetchServedProvenance(url);
assert.deepEqual(identityProblems({ localProvenance: readProvenance(distDir), served, distDir }), []);
console.log(`[build] ${url} ${served.provenance.buildId}`);

async function launch(userDataDir) {
  const candidates = [process.env.CHROME_PATH, process.env.EDGE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  for (const executablePath of new Set(candidates.filter(p => p && existsSync(p)))) {
    try {
      return await puppeteer.launch({ executablePath, userDataDir, headless: true, defaultViewport: { width: 1440, height: 900 },
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    } catch (e) { console.warn(`[launch] ${executablePath}: ${e.message}`); }
  }
  throw new Error("找不到可启动的 Chrome/Edge，可设置 CHROME_PATH 或 EDGE_PATH");
}

const profile = testArtifactTempDir("smoke", "desktop-study-");
const errors = [];
let browser;
try {
  browser = await launch(profile);
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", e => errors.push(`pageerror: ${e}`));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // 等真实姿态读数更新，不依赖 fps 文案或后台定时写 URL。
  await page.waitForFunction(() => /^[+-]\d+\.\d$/.test(document.querySelector("#readout-euler td")?.textContent), { timeout: 15_000 });
  const click = s => page.locator(s).click();
  const text = s => page.$eval(s, el => el.innerText.trim());
  const state = () => page.evaluate(() => {
    const label = s => document.querySelector(s).innerText.trim();
    return { play: label("#btn-pause"), clock: label("#clock"), view: label('#view-seg [aria-pressed="true"]'),
      source: label("#readout-source"), q: label("#readout-quat"),
      angles: [...document.querySelectorAll(".angle-pair tr")].map(row => [...row.cells].map(c => c.innerText)),
      replayOpen: document.querySelector("#replay-options").open, url: location.href };
  });

  assert.equal(await text("#btn-pause"), "暂停");
  await page.waitForSelector("#viewport canvas", { visible: true });
  await click("#btn-pause");
  if (process.argv[2]) {
    assert.ok(!existsSync(process.argv[2]), "截图已存在，不覆盖");
    await page.screenshot({ path: process.argv[2] });
  }
  for (const [fold, title, content] of [["#replay-options", "回放选项", "#replay-speed"],
    ["#replay-options + details", "支持的日志格式", "p"]]) {
    const summary = `${fold}:not([open]) > summary`;
    assert.equal(await text(summary), title);
    await click(summary);
    await page.waitForSelector(`${fold}[open] ${content}`, { visible: true });
  }
  for (const s of [".angle-pair", "#readout-source", "#readout-quat"]) await page.waitForSelector(s, { visible: true });
  if (!new URL(page.url()).hash.startsWith("#s=")) await click("#btn-share");
  const before = await state();
  assert.match(new URL(before.url).hash, /^#s=[\w-]+$/, "缺少仿真分享深链");
  assert.equal(before.play, "继续");
  assert.equal(before.view, "四轴姿态");
  assert.equal(before.source, "模型显示：Mahony · 数据源：模拟");
  assert.match(before.q, /^模型 q = \[-?\d+\.\d{4}(?:, -?\d+\.\d{4}){3}\]$/);
  assert.deepEqual(before.angles.map(row => row[0]), ["姿态角 °", "估计", "模拟真值"]);
  assert.deepEqual(before.angles[0].slice(1), ["横滚 φ", "俯仰 θ", "偏航 ψ"]);
  for (const row of before.angles.slice(1)) {
    assert.equal(row.length, 4);
    for (const value of row.slice(1)) assert.match(value, /^[+-]\d+\.\d$/);
  }

  // 只观察正文栏，不能让测试工具自动滚到待验收的目标，掩盖应用没跳转的问题。
  async function inReader(selector) {
    await page.waitForFunction(async s => {
      const el = document.querySelector(s), r = el?.getBoundingClientRect();
      const pane = document.querySelector(".doc-pages").getBoundingClientRect();
      if (!r?.height || r.top < pane.top - 1 || r.bottom > pane.bottom + 1) return false;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Math.abs(el.getBoundingClientRect().top - r.top) < 0.5;
    }, {}, selector).catch(e => { throw new Error(`未到达阅读位置 ${selector}`, { cause: e }); });
    assert.equal(page.url(), before.url, "文档导航改写了仿真深链");
  }
  async function termRoundTrip(chapter, body, term) {
    await inReader(chapter);
    const link = `${chapter} ~ ${body} a[href="${term}"]`;
    await page.hover(link);
    // 从非居中的实际阅读位置出发，区别「恢复原处」和仅仅重新定位章节/链接。
    const linkY = () => page.$eval(link, el => el.getBoundingClientRect().top);
    const initial = await linkY();
    await page.mouse.wheel({ deltaY: initial < 450 ? -120 : 120 });
    await page.waitForFunction((s, y) => Math.abs(document.querySelector(s).getBoundingClientRect().top - y) > 60, {}, link, initial);
    await inReader(link);
    const y = await linkY();
    await click(link);
    await inReader(`#glossary:not([hidden]) ${term}:focus-within`);
    await click("button#btn-docs-back:not([hidden])");
    await inReader(`${link}:focus`);
    const restored = await linkY();
    assert.ok(Math.abs(restored - y) <= 2, `${term} 阅读位置未还原：${y} → ${restored}`);
  }

  const opener = 'a[data-doc-open="math"][href="#quat-matrix-worked"]';
  assert.equal(await text(opener), "旋转矩阵怎么算？");
  await click(opener);
  await termRoundTrip("#quat-matrix-worked", "p", "#term-dcm");
  await click('#m-kalman-intuition a[href="#eskf-frame-worked"]');
  await termRoundTrip("#eskf-frame-worked", "ol", "#term-observability");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#docs-overlay[hidden]");
  assert.deepEqual(await state(), before, "关闭文档后仿真状态或深链改变");
} finally {
  try { await browser?.close(); } finally { cleanupArtifactDir(profile); }
  if (errors.length) console.error(errors.join("\n"));
}
assert.equal(errors.length, 0, "页面有 console error 或 pageerror");
console.log("[PASS] 四轴读数、回放折叠、两次术语往返及暂停现场/深链保持；页面错误 0");
