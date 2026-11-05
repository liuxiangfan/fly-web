/**
 * 体积构成报告（SW-09 第 3 条）：用 sourcemap **定量归因**，而不是凭感觉说"某某很大"。
 *
 * 为什么单独一个脚本：sourcemap 只在需要测量时才生成（`dist/` 里平时没有 .map，
 * 免得把几 MB 的 map 混进产物与 distHash）。这里在**另一个目录**里带 sourcemap 重建，
 * 测完即删——`dist/`（也就是证据引用的那份产物）一个字节都不动。
 *
 * 输出：`docs/generated/size-report.json`（随仓库版本化）+ 控制台表格。
 * 分组口径：vendor(three) / 主包 / 数值内核 / 场景渲染 / 界面 / 装配层 / 懒加载 chunk。
 *
 * 用法：node scripts/size-report.mjs   （需要先 npm run build 过；本脚本会自己再构建一次）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { sourceDigest } from "./source-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpOut = join(root, "dist-size");
const reportPath = join(root, "docs/generated/size-report.json");

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
  console.error("[FAIL] 找不到 vite（先 npm ci）");
  process.exit(2);
}
console.log("[size] 带 sourcemap 重建到 dist-size/（不动 dist/）…");
execFileSync(process.execPath, [viteBin, "build", "--sourcemap", "--outDir", "dist-size", "--emptyOutDir"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

const assets = join(tmpOut, "assets");
const files = readdirSync(assets);
const chunkKind = (name) => {
  if (/^three-/.test(name)) return "vendor-three";
  if (/^batch\.worker-/.test(name)) return "worker-batch";
  if (/^doc-demos-/.test(name)) return "lazy-doc-demos";
  if (/^tour-/.test(name)) return "lazy-tour";
  if (/^sw\.js$/.test(name)) return "service-worker";
  if (/\.js$/.test(name)) return "main";
  return "other";
};
const chunks = [];
for (const name of files.filter((f) => /\.js$/.test(f))) {
  const path = join(assets, name);
  const raw = statSync(path).size;
  const gzip = gzipSync(readFileSync(path), { level: 9 }).length;
  chunks.push({ name, file: name, kind: chunkKind(name), raw, gzip });
}
chunks.sort((a, b) => b.gzip - a.gzip);

/** 主包按源模块归因（sourcemap 的 sourcesContent 长度 ≈ 该模块的源码体积）。 */
const GROUP_OF = (src) => {
  const rel = src.split("src/")[1] ?? src;
  if (/^estimators\//.test(rel) || /^core\/(quat|imu|world|solve-loop|runner|stats|rng|gimbal|truth-track|sensor-pipeline|ins|reconnect|scenarios|serial|trace-events|serial-queue)\.ts$/.test(rel)) return "数值内核";
  if (/^scene\//.test(rel)) return "场景渲染";
  if (/^ui\//.test(rel)) return "界面";
  if (/^main\.ts$/.test(rel)) return "装配层(main.ts)";
  if (/^core\//.test(rel)) return "数据通路/存档";
  return "其他";
};
const mainMapName = files.find((f) => /^index-.*\.js\.map$/.test(f));
let attribution = [];
if (mainMapName) {
  const map = JSON.parse(readFileSync(join(assets, mainMapName), "utf8"));
  const perModule = map.sources
    .map((src, i) => ({ module: (src.split("src/")[1] ?? src), group: GROUP_OF(src), bytes: Buffer.byteLength(map.sourcesContent?.[i] ?? "", "utf8") }))
    .filter((r) => r.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const byGroup = new Map();
  for (const r of perModule) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + r.bytes);
  attribution = [...byGroup.entries()].map(([group, bytes]) => ({ group, sourceBytes: bytes })).sort((a, b) => b.sourceBytes - a.sourceBytes);
  var topModules = perModule.slice(0, 15);
} else {
  console.warn("[size] 没找到主包 sourcemap：只报 chunk 级数字");
}

const source = sourceDigest(root);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
  sourceDigest: source.digest,
  /** 被测产物（dist/）的摘要：本报告是"对这份产物的解释"，两者必须能对上 */
  distHash: distHashOf(join(root, "dist")),
  /** 被测产物的构建标识：体积归因必须指向某一次具体构建，才能和长稳/稳定性/性能对上 */
  buildId: readProvenance(join(root, "dist"))?.buildId ?? null,
  note: "体积归因用的是一次**带 sourcemap 的独立重建**（dist-size/），不修改 dist/；chunk 级 raw/gzip 与 dist/ 同源同配置。",
  chunks,
  mainAttribution: { groups: attribution, topModules: typeof topModules === "undefined" ? [] : topModules },
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
rmSync(tmpOut, { recursive: true, force: true });

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("\nchunk 级（raw / gzip）：");
for (const c of chunks) console.log(`  ${c.name.padEnd(28)} ${KB(c.raw).padStart(10)} / ${KB(c.gzip).padStart(10)}  [${c.kind}]`);
console.log(`  合计 gzip ${KB(chunks.reduce((s, c) => s + c.gzip, 0))}`);
if (attribution.length) {
  console.log("\n主包按职责归因（源码体积，未压缩）：");
  for (const g of attribution) console.log(`  ${g.group.padEnd(16)} ${KB(g.sourceBytes)}`);
  console.log("\n主包最大的 10 个模块：");
  for (const m of topModules.slice(0, 10)) console.log(`  ${m.module.padEnd(34)} ${KB(m.bytes)}`);
}
console.log(`\n报告：${reportPath.slice(root.length + 1)}（dist/ 未被改动：${report.distHash}）`);
