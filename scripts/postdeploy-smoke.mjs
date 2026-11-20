/**
 * 部署后 smoke（任务书 6.7）：线上页面必须能回答「你部署的是哪个提交」，并且核心功能真的活着。
 *
 * 为什么单独一个脚本：部署到 Cloudflare 之后，`npm run smoke` 打的是本地 preview；
 * 「线上到底跑的是不是这次提交」只能靠页面自己报出来的构建标识（vite define 注入的 `__BUILD_COMMIT__`，
 * 显示在「关于本装置」页脚，也通过 `attitudeDemo.build()` 暴露）。
 *
 * 用法：
 *   node scripts/postdeploy-smoke.mjs --url=https://fly_web.070616.xyz/ --expect=<commit>
 *   （不传 --expect 时只验证「构建标识存在 + 核心功能在跑」，exit 0）
 *
 * 退出码：0 通过；1 验收失败；2 环境/参数问题。
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fetchServedProvenance, sameCommit } from "./served-build.mjs";
import { testArtifactTempDir, cleanupArtifactDir } from "./test-artifacts.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const url = String(arg.url ?? process.env.DEPLOY_URL ?? "");
const expect = String(arg.expect ?? "").trim().toLowerCase();
const timeoutMs = Number(arg.timeout ?? 45000);
const outPath = resolve(root, arg.out ?? `docs/generated/postdeploy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
if (!/^https?:\/\//.test(url)) { console.error("[FAIL] --url 必须是 http(s) 地址"); process.exit(2); }
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { console.error("[FAIL] --timeout 必须是正数"); process.exit(2); }

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) { console.error("[FAIL] 找不到 Chrome/Edge"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(dirname(outPath), { recursive: true });
const consoleErrors = [];
let browser = null;
const profileDir = testArtifactTempDir("postdeploy", "postdeploy-");
process.on("exit", () => cleanupArtifactDir(profileDir));
const startedAt = new Date().toISOString();

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    userDataDir: profileDir,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const status = resp?.status() ?? 0;
  await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: timeoutMs });
  // 页面通过 SW 的 network-first 取回构建身份；未取到时让 provenanceMatch 明确失败。
  try {
    await page.waitForFunction(() => Boolean(window.attitudeDemo?.build?.()?.buildId), { timeout: timeoutMs });
  } catch { /* 报告会写明页面缺失 buildId */ }
  const served = await fetchServedProvenance(url, timeoutMs);

  const browserVersion = await browser.version();
  const before = await page.evaluate(() => ({
    build: window.attitudeDemo?.build?.() ?? null,
    clock: parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) || 0,
    rows: document.querySelectorAll("#metrics-body tr").length,
    fps: document.getElementById("fps")?.textContent ?? "",
    stamp: document.getElementById("build-stamp-value")?.textContent ?? "",
    hasCanvas: Boolean(document.querySelector("#viewport canvas")),
  }));
  // 等时钟真的推进（不是只看到静态页面）
  const deadline = Date.now() + 20000;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(500);
    after = await page.evaluate(() => ({
      build: window.attitudeDemo?.build?.() ?? null,
      clock: parseFloat((document.getElementById("clock")?.textContent ?? "0").replace(/[^\d.]/g, "")) || 0,
      rows: document.querySelectorAll("#metrics-body tr").length,
      fps: document.getElementById("fps")?.textContent ?? "",
      stamp: document.getElementById("build-stamp-value")?.textContent ?? "",
      hasCanvas: Boolean(document.querySelector("#viewport canvas")),
    }));
    if (after.clock > before.clock + 1) break;
  }

  const commit = String(before.build?.commit ?? "").toLowerCase();
  const commitOk = commit.length > 0 && commit !== "unknown";
  // 页脚只有 12 位、--expect 是完整 40 位：必须双向前缀比较（旧实现因此每次部署都误判失败）
  const expectOk = expect ? sameCommit(commit, expect) : true;
  const clockOk = after.clock > before.clock + 1;
  const rowsOk = after.rows >= 5;
  const stampOk = /[0-9a-f]{7,}/i.test(before.stamp);
  const provenanceOk = served.ok && before.build?.buildId === served.provenance.buildId;
  const pass = status === 200 && commitOk && expectOk && clockOk && rowsOk && stampOk && provenanceOk && after.hasCanvas && consoleErrors.length === 0;

  const report = {
    generatedAt: new Date().toISOString(), startedAt, finishedAt: new Date().toISOString(),
    url, httpStatus: status, expectedCommit: expect || null,
    // 溯源：报告必须能回答「用哪个浏览器、看的是哪个提交的线上产物」（复核 P2 证据治理）
    browserVersion,
    servedProvenance: served.ok ? { href: served.href, buildId: served.provenance.buildId } : { error: served.error },
    observed: { commit: before.build?.commit ?? null, builtAt: before.build?.builtAt ?? null, buildId: before.build?.buildId ?? null, stamp: before.stamp, clockFrom: before.clock, clockTo: after.clock, metricRows: after.rows, fps: after.fps, canvas: after.hasCanvas },
    checks: { statusOk: status === 200, commitOk, expectOk, clockAdvanced: clockOk, fiveEstimatorRows: rowsOk, stampRendered: stampOk, provenanceMatch: provenanceOk, canvas: after.hasCanvas, consoleClean: consoleErrors.length === 0 },
    consoleErrors, pass,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[${pass ? "PASS" : "FAIL"}] 部署后 smoke：${url}`);
  console.log(`  构建标识 ${before.build?.commit ?? "（缺失）"}${expect ? `（期望 ${expect}）` : ""}；页脚「${before.stamp}」`);
  console.log(`  溯源一致：${provenanceOk ? "是" : `否（HTTP ${served.ok ? served.provenance.buildId : served.error} / 页面 ${before.build?.buildId ?? "缺失"}）`}`);
  console.log(`  时钟 ${before.clock.toFixed(1)}→${after.clock.toFixed(1)} s；评测表 ${after.rows} 行；canvas=${after.hasCanvas}；控制台错误 ${consoleErrors.length}`);
  console.log(`  报告：${outPath}`);
  process.exitCode = pass ? 0 : 1;
} catch (err) {
  const failure = err instanceof Error ? err.message : String(err);
  writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), startedAt, url, expectedCommit: expect || null, failure, consoleErrors, pass: false }, null, 2)}\n`, "utf8");
  console.error(`[FAIL] 部署后 smoke 异常：${failure}`);
  console.error(`报告：${outPath}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* 已退出 */ }
}
