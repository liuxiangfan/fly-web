/**
 * SW 离线/更新韧性契约：检查代码中的缓存策略、更新协议与懒加载语义。
 * 不包含远端请求，只验证静态接线；浏览器行为由 app smoke 的真实页面用例覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const sw = read("public/sw.js");
const main = read("src/main.ts");
const html = read("index.html");
let passed = 0;
let failed = 0;

function test(name, body) {
  try {
    body();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const install = sw.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/)?.[0] ?? "";
const activate = sw.match(/self\.addEventListener\("activate"[\s\S]*?\n\}\);/)?.[0] ?? "";
const fetch = sw.match(/self\.addEventListener\("fetch"[\s\S]*?\n\}\);/)?.[0] ?? "";
const message = sw.match(/self\.addEventListener\("message"[\s\S]*?\n\}\);/)?.[0] ?? "";
const swRegistration = main.match(/PWA：生产环境注册[\s\S]*?location\.reload\(\)[\s\S]*?\n\}\);/)?.[0] ?? "";

// 安装失败与更新确认
// -------------------
test("SW install 不再自动 skipWaiting", () => {
  assert.ok(install);
  assert.doesNotMatch(install, /skipWaiting/);
});
test("SKIP_WAITING 只由消息分支处理", () => {
  assert.match(message, /event\.data === "SKIP_WAITING"[\s\S]*self\.skipWaiting\(\)/);
  assert.equal(sw.split("self.skipWaiting()").length - 1, 1);
  assert.doesNotMatch(sw.replace(message, ""), /self\.skipWaiting\(\)/);
});
test("CORE addAll 失败不被空 catch 吞掉", () => {
  assert.match(install, /cache\.addAll\(CORE\)/);
  assert.doesNotMatch(install, /\.catch\s*\(\s*\(\)\s*=>\s*(?:undefined|\{\s*\})\s*\)/);
  assert.doesNotMatch(install, /catch\s*\(\)\s*\{\s*\}/);
});
test("activate 只清 quat-demo- 前缀旧缓存", () => {
  assert.match(activate, /k !== CACHE && k\.startsWith\("quat-demo-"\)/);
  assert.doesNotMatch(activate, /filter\(\(k\) => k !== CACHE\)/);
});
test("build-provenance 单独 network-first，不做旧壳兜底", () => {
  assert.match(fetch, /url\.pathname === "\/build-provenance\.json"[\s\S]*networkFirst\(req, cache, false\)/);
  assert.doesNotMatch(fetch, /url\.pathname === "\/build-provenance\.json"\)[^\n]*staleWhileRevalidate/);
  assert.match(sw, /allowShellFallback = true/);
});
test("导航 network-first 与 /assets cache-first 规则仍在", () => {
  assert.match(fetch, /req\.mode === "navigate"[\s\S]*networkFirst\(req, cache\)/);
  assert.match(fetch, /url\.pathname\.startsWith\("\/assets\/"\)[\s\S]*cacheFirst\(req, cache\)/);
});

// 更新横幅、一次性刷新与离线预热
// ----------------------------------
test("index.html 有默认隐藏的持久更新横幅与按钮", () => {
  const banner = html.match(/<div id="sw-banner"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(banner);
  assert.match(banner, /\bhidden\b/);
  assert.match(banner, /role="status"/);
  assert.match(banner, /id="sw-update"[^>]*>重新加载以更新</);
  assert.doesNotMatch(banner, /setTimeout/);
});
test("页面有 updatefound/controllerchange 接线与一次性 reload 守卫", () => {
  assert.match(swRegistration, /registration\.addEventListener\("updatefound"/);
  assert.match(swRegistration, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
  assert.match(swRegistration, /let awaitUpdate = false/);
  assert.match(swRegistration, /awaitUpdate = true/);
  assert.match(swRegistration, /if \(!awaitUpdate\) return;[\s\S]*awaitUpdate = false;[\s\S]*location\.reload\(\)/);
  assert.equal(swRegistration.split("location.reload()").length - 1, 1);
});
test("横幅严格绑定 waiting worker，点击发 SKIP_WAITING；无 waiting 时点击改为重新检查", () => {
  // 不变量：只有 registration.waiting 真实存在且有 controller 才显示横幅——
  // updatefound 在安装失败（→ redundant）时同样触发，旧写法会留下消不掉的僵尸横幅（2026-11-20 线上踩中）。
  assert.match(swRegistration, /banner\.hidden = !\(registration\.waiting && navigator\.serviceWorker\.controller\)/);
  assert.match(swRegistration, /registration\.waiting\.postMessage\("SKIP_WAITING"\)/);
  assert.match(swRegistration, /if \(!registration\.waiting\)[\s\S]*registration\.update\(\)/);
});
test("首次联网后在空闲时预热诊断与导出懒模块", () => {
  assert.match(swRegistration, /idlePrefetch[\s\S]*Promise\.allSettled\(\[/);
  assert.match(swRegistration, /import\("\.\/ui\/telemetry-diagnostics-ui"\)/);
  assert.match(swRegistration, /import\("\.\/ui\/export-dialog"\)/);
  assert.match(swRegistration, /navigator\.serviceWorker\.ready\.then\(preheat\)/);
});
test("懒加载失败提示包含离线与缓存说明", () => {
  assert.match(main, /若当前离线且该模块尚未缓存，请联网后重试/);
  for (const label of ["导出模块加载失败", "教学诊断面板加载失败", "实验报告加载失败"]) {
    assert.ok(main.includes(label));
  }
});

console.log(`[sw-resilience-contract] ${passed} PASS / ${failed} FAIL（共 ${passed + failed} 项）`);
if (failed) process.exitCode = 1;
