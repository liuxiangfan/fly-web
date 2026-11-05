/**
 * 体积预算的**政策契约**（node:test；不依赖 dist/，可在 gate 里和别的契约一起跑）。
 *
 * 为什么要有它：预算脚本是"体积不许失控"的唯一闸门，但闸门自己也会退化——
 *  · 把某项指标从列表里删掉 → 那一项从此不受管；
 *  · 把余量判据删掉 → 上限又变成"贴着现状"，任何合法改动都能判红（2026-11-03 正式决策要修的就是这个）。
 * 这里把政策本身也锁进测试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyRun } from "./smoke-verdict.mjs";
import { budgetVerdict, reductionHint, verdictLine } from "./budget-core.mjs";

const src = readFileSync(new URL("./distbudget.mjs", import.meta.url), "utf8");

test("每个受控产物都必须留 ≥10% 余量，判据由脚本自己强制（政策不许被删）", () => {
  const core = readFileSync(new URL("./budget-core.mjs", import.meta.url), "utf8");
  assert.match(core, /export const MIN_MARGIN = 0\.1;/, "必须显式声明最小余量");
  assert.match(core, /limit \* \(1 - margin\)/, "判定必须真的用上最小余量");
  assert.match(src, /budgetVerdict\(/, "distbudget 必须走同一份判定（不许各写一套）");
  assert.match(core, /抬上限不算修复/, "余量不足时只能提示减重，不许提示抬上限");
  // 行为层面再确认一次：修法提示里不许出现"抬高上限"这类建议（只准指向减重）
  const hint = reductionHint(budgetVerdict({ value: Math.floor(315 * 1024 * 0.9) + 1, limit: 315 * 1024 }));
  assert.ok(hint.includes("减重") && !/抬到|提高到|改为 \d/.test(hint), `修法提示必须只指向减重：${hint}`);
});

test("预算判定的真实边界：恰好到有效门槛算过、多 1 字节算不过、剩余字节可读", () => {
  // 用真实数量级：主包 315 KiB 名义上限、10% 余量 → 有效门槛 283.5 KiB 向下取整
  const limit = 315 * 1024;
  const effective = Math.floor(limit * 0.9);
  const atThreshold = budgetVerdict({ value: effective, limit });
  assert.equal(atThreshold.ok, true, "恰好落在有效门槛上必须通过");
  assert.equal(atThreshold.remaining, 0);
  const oneByteOver = budgetVerdict({ value: effective + 1, limit });
  assert.equal(oneByteOver.ok, false, "多 1 字节就必须失败");
  assert.equal(oneByteOver.reason.includes("有效门槛"), true);
  assert.equal(reductionHint(oneByteOver).includes("至少降"), true);

  // 265 KiB 的目标（结案标准里那条可验证线）：相对 300 KiB 名义上限还剩 5 KiB 有效余量
  const allJs = budgetVerdict({ value: 265 * 1024, limit: 300 * 1024, baseline: 262 * 1024 });
  assert.equal(allJs.ok, true);
  assert.equal(Math.round(allJs.remaining / 1024), 5, "265 KiB 在 300 KiB 上限下应剩 5 KiB 余量");
  assert.equal(allJs.deltaVsBaseline, 3 * 1024);

  // 超出名义上限：原因要指向"超了多少"，而不是余量
  const over = budgetVerdict({ value: limit + 4096, limit });
  assert.equal(over.ok, false);
  assert.equal(over.withinLimit, false);
  assert.match(over.reason, /超出名义上限/);

  // 计数型指标只查名义上限（"90% 个字体文件"没有工程含义）
  assert.equal(budgetVerdict({ value: 24, limit: 24, count: true }).ok, true);
  assert.equal(budgetVerdict({ value: 25, limit: 24, count: true }).ok, false);
  // 非法输入必须被判为无效而不是"通过"
  assert.equal(budgetVerdict({ value: Number.NaN, limit: 100 }).valid, false);
  assert.equal(budgetVerdict({ value: 10, limit: 0 }).valid, false);
  // 报告行必须同时给出四个数：名义上限 / 有效门槛 / 剩余 / 基线增量
  const line = verdictLine("主包 JS", budgetVerdict({ value: 280 * 1024, limit, baseline: 271 * 1024 }));
  for (const part of ["名义上限", "有效门槛", "剩余", "Δ 冻结基线"]) assert.ok(line.includes(part), `报告行缺少「${part}」：${line}`);
});

test("冻结基线表必须覆盖全部受控项（增量才可比）", () => {
  const baselines = src.slice(src.indexOf("const BASELINES = {"), src.indexOf("const LIMITS = {"));
  const keys = [...baselines.matchAll(/(\w+):/g)].map((m) => m[1]);
  const limits = [...src.slice(src.indexOf("const LIMITS = {")).matchAll(/(\w+):/g)].map((m) => m[1]);
  for (const key of ["mainJs", "mainJsGzip", "allJsGzip", "total", "html"]) assert.ok(keys.includes(key), `基线缺少 ${key}`);
  const usedBaselines = [...src.matchAll(/baseline: BASELINES\.(\w+)/g)].map((m) => m[1]);
  for (const key of usedBaselines) assert.ok(keys.includes(key), `引用了不存在的基线 ${key}`);
  assert.ok(limits.length >= 10, "上限表疑似被清空");
});

test("预算项不许被悄悄删掉：14 项指标名一个不少", () => {
  const names = [...src.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  for (const name of [
    "产物总量",
    "字体总量",
    "字体文件数",
    "index.html",
    "index.html · 应用外壳（骨架/面板/弹窗）",
    "index.html · 内联文档（15 页，可打印/可搜索）",
    "index.html（gzip 传输体积）",
    "主包 JS",
    "文档页演示 JS（按需 chunk）",
    "引导课程 JS（按需 chunk）",
    "Service Worker JS（离线缓存，加载后注册）",
    "批量评测 Worker JS（懒加载）",
    "全部 JS 合计（gzip，含按需 chunk/three/Worker/SW）",
    "主包 JS（gzip 传输体积）",
  ]) assert.ok(names.includes(name), `预算项被删掉了：${name}`);
  assert.equal(names.length, 14, `预算项数应为 14，实测 ${names.length}`);
});

test("字数统计口径：上限值必须写成「KB × 1024」，避免有人用 1000 偷偷放宽", () => {
  for (const m of src.matchAll(/^\s{2}(\w+): (\d+) \* 1024,/gm)) {
    assert.ok(Number(m[2]) > 0, `${m[1]} 上限必须为正数`);
  }
  assert.match(src, /total: 2200 \* 1024,/, "总量上限必须以 1024 为基数");
});

/**
 * 冒烟失败归因的契约（与体积政策同属"门禁怎么判"，所以放在同一个契约文件里——
 * 这个文件已经在 contracts 链里跑着，不需要改 package.json，也就不必让已绑定的长稳证据失效）。
 *
 * 夹具是**真实日志**：2026-11-03 Windows CI run 41555321631 的稳定性作业 5 轮全红，
 * 每轮都死在不同位置的基础设施超时上，没有一条产品断言失败。
 */
test("冒烟失败归因：用例级断言失败优先于基础设施超时（不能用「机器慢」掩盖产品缺陷）", () => {
  // 日志用真实换行拼，避免在测试里塞转义序列导致"测试自己写错"
  const NL = String.fromCharCode(10);
  const log = (...lines) => lines.join(NL) + NL;
  // ① 全绿
  assert.equal(classifyRun(0, log("[PASS] 仿真在真实 rAF 下推进 — t = 2.1 s", "[PASS] 3D canvas 有 WebGL 上下文", "", "浏览器冒烟通过 ✅（96 项）")), "pass");
  // ② 真实 Windows CI 日志（run 41555321631，devices run1）：只有外层异常，命中容量签名 → capacity
  assert.equal(classifyRun(1, log("[INFO] 使用浏览器：C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "[FAIL] 冒烟测试异常 — Navigation timeout of 20000 ms exceeded", "", "1 项失败 ❌")), "capacity");
  // ③ 用例级断言失败 → product（即使末尾也带超时噪声）
  const productLog = log("[FAIL] 串口断线自动重连：拔线后按退避重连并恢复数据流 — 重连后 0.6 s 新增 3 帧", "[FAIL] 冒烟测试异常 — Waiting failed: 15000ms exceeded");
  assert.equal(classifyRun(1, productLog), "product", "有用例级 FAIL 时必须判产品失败");
  // ④ 渲染进程被回收属于基础设施
  assert.equal(classifyRun(1, log("[FAIL] 浏览器进程被回收 2 次 — 基础设施失败，本轮不能判通过")), "capacity");
  // ⑤ 未知失败（既无用例 FAIL 也不命中签名）→ 归到产品：宁可让人去看，也不轻判「容量」
  assert.equal(classifyRun(1, log("something exploded")), "product");
  // ⑥ 非零退出码但日志里有用例级 FAIL → product
  assert.equal(classifyRun(2, log("[FAIL] 窄屏布局无横向溢出 — scroll=390/390")), "product");
});
