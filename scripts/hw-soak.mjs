/**
 * 真机长稳验收（串口 / BLE），给「30 min + 拔插/离开范围/休眠/复位」这条验收用。
 *
 * 为什么需要人工介入一次：Web Serial 与 Web Bluetooth 的**设备选择器是浏览器原生对话框**，
 * 自动化（puppeteer / CDP）点不了它。所以本脚本用**有头** Chrome + 固定 profile 启动，
 * 由人点一次设备；之后 30 min 的采样、断链与恢复判定全部自动完成，并落一份可复核的 JSON 报告。
 *
 * 用法：
 *   npm run build && npm run hw:soak -- --kind=ble --minutes=30
 *   npm run hw:soak -- --kind=serial --minutes=30 --protocol=text --baud=921600
 *
 * 断电/离开范围怎么模拟（脚本会按时间自动做）：
 *   · BLE：用 `pnputil /disable-device <蓝牙无线电实例>` 关掉本机蓝牙无线电 ≈ 设备离开范围；
 *     8 s 后重新启用 ≈ 回到范围。**这是软件代理**，报告里会标 `simulated: "radio-off"`。
 *   · 串口：软件无法拔 USB。脚本只在报告里标记「需要人工拔插」的时间点，不伪造事件。
 *
 * 报告字段：commit / distHash / 浏览器版本 / 起止时间 / 每个采样点 / 每次扰动与恢复 / 结论。
 * 退出码：0 = 通过；1 = 验收失败；2 = 环境/参数问题（含「人没点设备」）。
 */
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { testArtifactRoot } from "./test-artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const kind = String(arg.kind ?? "ble").toLowerCase();
const minutes = Number(arg.minutes ?? 30);
const port = Number(arg.port ?? 4173);
const protocol = String(arg.protocol ?? "text");
const baud = String(arg.baud ?? "921600");
const outPath = resolve(root, arg.out ?? `docs/generated/hw-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
if (!["ble", "serial"].includes(kind)) { console.error("[FAIL] --kind 只支持 ble / serial"); process.exit(2); }
if (!Number.isFinite(minutes) || minutes <= 0) { console.error("[FAIL] --minutes 必须是正数"); process.exit(2); }
if (!existsSync(join(root, "dist", "index.html"))) { console.error("[FAIL] 先 npm run build"); process.exit(2); }

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
const git = (args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } };
const commit = git(["rev-parse", "HEAD"]);
const distHash = (() => {
  try {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const h = createHash("sha256");
    for (const f of walk(join(root, "dist"))) h.update(f.slice(root.length)).update(readFileSync(f));
    return h.digest("hex").slice(0, 16);
  } catch { return null; }
})();

/** 起 preview（同 ci-run-smoke 的做法：node 直跑 vite bin，避免 shell 差异）。 */
function startPreview() {
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  child.stdout.on("data", (b) => process.stdout.write(`[preview] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[preview] ${b}`));
  return child;
}
async function waitPreview(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

/** BLE「离开范围」代理：关/开本机蓝牙无线电。找不到无线电时返回 null（报告里如实记）。 */
function bluetoothRadioInstance() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName -match 'Bluetooth|蓝牙' -and $_.InstanceId -like 'USB\\*' } | Select-Object -First 1 -ExpandProperty InstanceId",
    ], { encoding: "utf8" }).trim();
    return out || null;
  } catch { return null; }
}
function setRadio(instanceId, enable) {
  try {
    execFileSync("pnputil", [enable ? "/enable-device" : "/disable-device", instanceId], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

const url = `http://127.0.0.1:${port}/`;
// 真机长稳的 profile 必须保留（原生设备选择器的授权记在这里），但仍放在 D 盘测试现场。
const profileDir = join(testArtifactRoot("hw-soak"), `hw-profile-${kind}`);
mkdirSync(profileDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });

const preview = startPreview();
let browser = null;
const samples = [];
const events = [];
const consoleErrors = [];
const startedAt = new Date().toISOString();
let failure = null;

try {
  if (!(await waitPreview(url))) throw new Error("preview 没起来");
  browser = await puppeteer.launch({
    executablePath,
    headless: false, // 必须是有头：设备选择器是原生对话框，人要点一次
    userDataDir: profileDir,
    defaultViewport: { width: 1280, height: 860 },
    args: ["--no-first-run", "--no-default-browser-check"],
    protocolTimeout: 300000,
  });
  const browserVersion = await browser.version();
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("fps")?.textContent !== "-- fps", { timeout: 60000 });

  if (kind === "serial") {
    await page.evaluate((p, b) => {
      const sel = document.getElementById("serial-protocol");
      sel.value = p; sel.dispatchEvent(new Event("change"));
      const baudSel = document.getElementById("serial-baud");
      if ([...baudSel.options].some((o) => o.value === b)) { baudSel.value = b; baudSel.dispatchEvent(new Event("change")); }
      document.getElementById("sec-imu")?.classList.remove("collapsed");
    }, protocol, baud);
  } else {
    await page.evaluate(() => document.getElementById("sec-imu")?.classList.remove("collapsed"));
  }

  console.log("──────────────────────────────────────────────────────────────");
  console.log(kind === "ble"
    ? "Chrome 已打开并自动点了【连接 BLE IMU】：请在**系统弹出的设备对话框**里选 HM-10/HMSoft（这一次必须人工）"
    : `Chrome 已打开并自动点了【连接真实 IMU】：请在**系统弹出的串口对话框**里选 ${process.env.HW_PORT ?? "对应串口"}（这一次必须人工）`);
  console.log(`连接后本脚本会自动跑 ${minutes} 分钟并记录；Ctrl+C 可提前结束。`);
  console.log("──────────────────────────────────────────────────────────────");

  await page.bringToFront().catch(() => undefined);
  // 自动点一下连接按钮（Puppeteer 的 click 是受信任输入 → 满足 requestDevice 的用户手势要求），
  // 让系统设备对话框立刻弹出来，人只需要选设备。
  const connectBtn = kind === "ble" ? "#btn-ble" : "#btn-serial";
  await page.click(connectBtn).catch((e) => console.warn(`[warn] 自动点击 ${connectBtn} 失败：${e.message}`));
  // 等人工完成连接（串口/BLE 任一）
  const connectDeadline = Date.now() + 300000;
  let connected = false;
  while (Date.now() < connectDeadline) {
    const p = await page.evaluate(() => window.attitudeDemo.plumbing());
    if (p.serial || p.ble) { connected = true; break; }
    await sleep(1000);
  }
  if (!connected) {
    throw new Error("300 s 内没有建立连接（设备选择器需要人工点击；或设备未上电/未配对）");
  }
  events.push({ at: Date.now(), type: "connected", kind, simulated: null });
  console.log(`[hw] 已连接（${kind}），开始 ${minutes} min 采样`);

  const radio = kind === "ble" ? bluetoothRadioInstance() : null;
  if (kind === "ble") {
    events.push({ at: Date.now(), type: "radio-probe", simulated: null, instanceId: radio ?? "未找到蓝牙无线电（离开范围需人工）" });
  }
  // 扰动计划：25% / 55% 关无线电 8 s；75% 关 20 s（≈休眠/唤醒的长断链）
  const plan = kind === "ble" && radio
    ? [{ at: 0.25, offSec: 8 }, { at: 0.55, offSec: 8 }, { at: 0.75, offSec: 20 }]
    : [];
  const t0 = Date.now();
  const totalMs = minutes * 60000;
  const fired = new Set();
  let lastReconnects = null;

  while (Date.now() - t0 < totalMs) {
    const elapsed = (Date.now() - t0) / totalMs;
    for (const [i, ev] of plan.entries()) {
      if (!fired.has(i) && elapsed >= ev.at) {
        fired.add(i);
        console.log(`[hw] 模拟离开范围：关闭蓝牙无线电 ${ev.offSec} s（${i + 1}/${plan.length}）`);
        const off = setRadio(radio, false);
        if (!off) {
          // 没有管理员权限时 pnputil 会失败：**如实记为跳过**，不计入「期望恢复次数」——
          // 否则「没做成扰动」会被算成「没能恢复」，把环境问题伪装成产品缺陷。
          events.push({ at: Date.now(), type: "radio-off-skipped", simulated: "radio-off", ok: false, reason: "pnputil 失败（多半需要管理员权限）", instanceId: radio });
          console.log("[hw] 关闭无线电失败（多半需要管理员权限）——本次扰动跳过，不计入期望恢复次数");
          continue;
        }
        events.push({ at: Date.now(), type: "radio-off", simulated: "radio-off", ok: true, seconds: ev.offSec, instanceId: radio });
        await sleep(ev.offSec * 1000);
        const on = setRadio(radio, true);
        events.push({ at: Date.now(), type: "radio-on", simulated: "radio-off", ok: on, instanceId: radio });
        console.log(`[hw] 无线电已恢复（disable=${off} enable=${on}）`);
      }
    }
    const s = await page.evaluate(() => {
      const p = window.attitudeDemo.plumbing();
      return {
        at: Date.now(),
        frames: p.frames, bytes: p.bytes, text: p.text,
        serial: p.serial, ble: p.ble, connecting: p.connecting,
        reconnects: p.reconnects, bleReconnects: p.bleReconnects,
        openPorts: p.openPorts, closeFailures: p.portCloseFailures,
        pendingCleanup: p.pendingPortCleanup, drops: p.solveDropped,
        sourceKind: p.sourceKind,
        status: document.getElementById("serial-status")?.textContent ?? "",
      };
    });
    samples.push(s);
    if (lastReconnects !== null && s.reconnects !== lastReconnects) {
      events.push({ at: Date.now(), type: "reconnect", simulated: null, reconnects: s.reconnects });
    }
    lastReconnects = s.reconnects;
    await sleep(2000);
  }

  // 收尾：断开 → 端口/清理归零
  await page.evaluate((k) => {
    const btn = document.getElementById(k === "ble" ? "btn-ble" : "btn-serial");
    if (btn && !btn.disabled) btn.click();
  }, kind);
  await sleep(4000);
  const final = await page.evaluate(() => window.attitudeDemo.plumbing());

  const framesGrew = samples.length > 1 && samples.at(-1).frames > samples[0].frames;
  const reconnects = final.reconnects + final.bleReconnects;
  const expectedRecoveries = events.filter((e) => e.type === "radio-off" && e.ok === true).length;
  const verdict = {
    connected,
    framesGrew,
    framesStart: samples[0]?.frames ?? 0,
    framesEnd: samples.at(-1)?.frames ?? 0,
    reconnects,
    expectedRecoveries,
    recoveredAll: expectedRecoveries > 0 ? reconnects >= expectedRecoveries : null,
    cleanShutdown: final.openPorts === 0 && final.pendingPortCleanup === 0,
    consoleErrors,
  };
  const pass = Boolean(verdict.connected && verdict.framesGrew && verdict.cleanShutdown &&
    consoleErrors.length === 0 &&
    (verdict.recoveredAll === null || verdict.recoveredAll));
  const report = {
    generatedAt: new Date().toISOString(),
    commit, distHash, browserVersion, url, kind, minutes,
    startedAt, finishedAt: new Date().toISOString(),
    simulatedNotes: kind === "ble"
      ? (radio ? "离开范围用「关闭本机蓝牙无线电」模拟（软件代理，非物理搬离）" : "未找到蓝牙无线电：离开范围/休眠需人工操作")
      : "串口拔插/休眠/复位必须人工操作；本次报告不包含这些事件",
    samples, events, verdict, pass,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[${pass ? "PASS" : "FAIL"}] 真机长稳：帧 ${verdict.framesStart}→${verdict.framesEnd}、重连 ${reconnects}（期望 ${expectedRecoveries}）、` +
    `收尾干净=${verdict.cleanShutdown}、控制台错误 ${consoleErrors.length}`);
  console.log(`报告：${outPath}`);
  process.exitCode = pass ? 0 : 1;
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
  console.error(`[FAIL] ${failure}`);
  const report = { generatedAt: new Date().toISOString(), commit, distHash, url, kind, minutes, startedAt, failure, samples, events, consoleErrors, pass: false };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`报告（失败现场）：${outPath}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* 已退出 */ }
  try { preview.kill(); } catch { /* 已退出 */ }
}
