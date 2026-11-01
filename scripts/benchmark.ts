/**
 * 文档基准生成器：把「会漂移的手写数字」变成可复算的 JSON。
 *
 * 运行：`npm run benchmark`
 * 产物：`docs/generated/benchmarks.json`（提交进仓库）
 *
 * 记录构造在 `scripts/benchmark-records.ts`（纯函数、确定性）。抽出来的原因：
 * `scripts/doccheck.ts` 会用**同一份实现**只读复算，再与存档逐字段比对——
 * 复核 6.3 的结论是「doccheck 只做了范围检查，不是复算」，正文数字因此可以
 * 与存档悄悄脱钩。现在存档由生成器复算、复算由检查脚本复刻，两边只能同时改。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedSequence } from "../src/core/runner";
import {
  BENCH_BLOCK_BEGIN,
  BENCH_BLOCK_END,
  buildBenchmarkRecords,
  renderBenchmarkBlock,
} from "./benchmark-records";

const records = buildBenchmarkRecords();

const out = {
  schema: 1,
  generator: "scripts/benchmark.ts",
  notes:
    "所有数字由 npm run benchmark 复算生成；配置/窗口/种子都随记录保存。种子序列由 splitmix32 从 seed 派生，保证配对比较。",
  seedSequenceExample: seedSequence(0x5eed, 3),
  records,
};

const path = join("docs", "generated", "benchmarks.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(out, null, 2)}
`, "utf8");
console.log(`已写入 ${path}`);
console.log(`记录：${Object.keys(records).join(", ")}`);

/* --------------------------------------------------------------------------
   正文数字绑定：把渲染好的数字块**写进 index.html 的标记区**
   （复核 6.3：正文里的数字此前纯手工，改算法后可以悄悄与存档脱钩）。
   doccheck 会用同一个渲染函数核对，所以这里只负责"生成"，不负责"判断"。
   -------------------------------------------------------------------------- */
const htmlPath = "index.html";
const html = readFileSync(htmlPath, "utf8");
const block = renderBenchmarkBlock(records);
const begin = html.indexOf(BENCH_BLOCK_BEGIN);
const end = html.indexOf(BENCH_BLOCK_END);
if (begin < 0 || end < 0 || end < begin) {
  console.error(`[FAIL] index.html 里找不到基准数字块标记（${BENCH_BLOCK_BEGIN} / ${BENCH_BLOCK_END}）`);
  process.exit(1);
}
const next = `${html.slice(0, begin)}${block}${html.slice(end + BENCH_BLOCK_END.length)}`;
if (next === html) {
  console.log(`基准数字块无变化（index.html）`);
} else {
  writeFileSync(htmlPath, next, "utf8");
  console.log(`已更新 index.html 里的基准数字块`);
}
