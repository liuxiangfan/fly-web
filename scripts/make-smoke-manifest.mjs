/**
 * 从 `browser-smoke.mjs` 源码重新生成 `scripts/smoke-manifest.json`（SW-07 的维护工具）。
 *
 * 只在**故意增删用例**后运行它；平时由 `smoke-manifest-contract.test.mjs` 守着两者一致：
 * 清单是"验收要比对的完整集合"，它必须能在 diff 里被看见，而不是随代码悄悄漂移。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestShapeProblems, parseDeclaredChecks } from "./smoke-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokePath = join(root, "scripts/browser-smoke.mjs");
const outPath = join(root, "scripts/smoke-manifest.json");
const declared = parseDeclaredChecks(readFileSync(smokePath, "utf8"));
const manifest = {
  schemaVersion: 1,
  note: "冒烟用例的完整清单：验收比对的是这个集合，不是 PASS 行数。改动用例后重跑 node scripts/make-smoke-manifest.mjs。",
  shards: {
    app: declared.filter((d) => d.shard === "app").map((d) => d.name),
    devices: declared.filter((d) => d.shard === "devices").map((d) => d.name),
  },
  total: declared.length,
};
const problems = manifestShapeProblems(manifest);
if (problems.length) {
  console.error("[FAIL] 生成的清单自身不自洽：");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[ok] 已写出 ${outPath}：app ${manifest.shards.app.length} 项 + devices ${manifest.shards.devices.length} 项 = ${manifest.total} 项`);
