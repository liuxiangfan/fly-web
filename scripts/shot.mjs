/**
 * 开发用截图工具（puppeteer-core + 本机 Edge/Chrome）。
 *
 * 前置：`npm run build && npm run preview`（默认 http://127.0.0.1:4173）
 * 用法：
 *   node scripts/shot.mjs --name=overview --width=2560 --height=1440
 *   node scripts/shot.mjs --name=proj --do="document.querySelector('[data-viewset=quat]').click()"
 *
 * 参数：
 *   --name   输出文件名（不含扩展名，落到 screenshots/）
 *   --width  视口宽（默认 1440）
 *   --height 视口高（默认 900）
 *   --dpr    设备像素比（默认 1）
 *   --url    页面地址（默认 $SHOT_URL 或 http://127.0.0.1:4173/）
 *   --do     在截图前于页面内求值的 JS 表达式（可为 async 函数体，可用 await）
 *   --wait   截图前额外等待毫秒数（默认 600）
 *   --full   截整页（默认只截视口）
 *   --el     只截某个选择器命中的元素
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);

const CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("找不到 Edge/Chrome，可用 EDGE_PATH 指定");
  process.exit(2);
}

const url = args.url ?? process.env.SHOT_URL ?? "http://127.0.0.1:4173/";
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const dpr = Number(args.dpr ?? 1);
const name = args.name ?? `shot-${width}x${height}`;
const shots = join(process.cwd(), "screenshots");
if (!existsSync(shots)) mkdirSync(shots);

const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: dpr });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForFunction(
  () => parseFloat((document.getElementById("clock")?.textContent ?? "").replace("t = ", "")) > 1.5,
  { timeout: 15000 },
).catch(() => console.warn("警告：仿真时钟未推进（可能 rAF 停摆）"));

if (args.do || args.dofile) {
  const src = args.dofile ? readFileSync(args.dofile, "utf8") : String(args.do);
  try {
    // 以「参数」而非「函数体」的形式传入：Puppeteer 对字符串做函数嗅探，
    // 多行片段容易被误判。这里统一交给页面内的 Function 求值。
    const result = await page.evaluate((s) => new Function(`return (${s})`)(), src);
    if (result !== undefined && result !== null) {
      console.log("--do 返回：", JSON.stringify(result));
      if (args.json) writeFileSync(join(shots, `${name}.json`), JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error("--do 求值失败：", err.message);
  }
}
await new Promise((r) => setTimeout(r, Number(args.wait ?? 600)));

const path = join(shots, `${name}.png`);
if (args.el) {
  const el = await page.$(args.el);
  if (!el) throw new Error(`找不到元素 ${args.el}`);
  await el.screenshot({ path });
} else {
  await page.screenshot({ path, fullPage: Boolean(args.full) });
}
console.log(`已保存 screenshots/${name}.png （${width}×${height}${args.el ? ` 元素 ${args.el}` : ""}）`);
if (errors.length) console.log(`控制台错误 ${errors.length} 条：\n  ${errors.slice(0, 5).join("\n  ")}`);
await browser.close();
