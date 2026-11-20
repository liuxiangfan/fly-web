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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProvenance } from "./build-provenance.mjs";
import { testArtifactTempDir, cleanupArtifactDir } from "./test-artifacts.mjs";
import { captureIdentity, captureDriftProblems } from "./served-build.mjs";

export function sizeIdentity(root, distRoot = join(root, "dist")) {
  const identity = captureIdentity(root, distRoot);
  const provenance = readProvenance(distRoot);
  if (!provenance?.buildId || provenance.sourceDigest !== identity.sourceDigest || provenance.distHash !== identity.distHash) {
    throw new Error("体积归因源码/产物/溯源不一致，先冻结源码并重新 build");
  }
  return { ...identity, buildId: provenance.buildId };
}

export function sizeDriftProblems(root, before, distRoot = join(root, "dist")) {
  const problems = captureDriftProblems(root, before, distRoot);
  if (readProvenance(distRoot)?.buildId !== before.buildId) problems.push("体积采集期间 buildId 发生变化");
  return problems;
}

export function mappedCodeMatches(distFile, mappedFile) {
  // 只允许末尾 sourceMappingURL 差异，正文哪怕改一字节都不是这份产物的归因。
  const text = readFileSync(mappedFile, "utf8");
  const code = text.replace(/\/\/# sourceMappingURL=[^\r\n]+\r?\n?$/, "");
  const dist = readFileSync(distFile);
  return Buffer.from(code).equals(dist) || (code !== text && Buffer.from(code.replace(/\r?\n$/, "")).equals(dist));
}

export const chunkKind = (name) => {
  if (name === "sw.js") return "service-worker";
  if (/^three-/.test(name)) return "vendor-three";
  if (/^runner-|^trace-events-/.test(name)) return "shared-runner";
  if (/\.worker-/.test(name)) return "worker-entry";
  if (/^doc-demos-/.test(name)) return "lazy-doc-demos";
  if (/^tour-/.test(name)) return "lazy-tour";
  if (/^teaching-ui-/.test(name)) return "lazy-teaching-ui";
  if (/^comparison-ui-/.test(name)) return "lazy-comparison-ui";
  if (/^diagnostics-ui-/.test(name)) return "lazy-diagnostics-ui";
  if (/^tools-ui-/.test(name)) return "lazy-tools-ui";
  if (/^experiments-|^challenges-/.test(name)) return "lazy-catalog";
  if (/^comparison-(panel|view|report|config)-|^task-strip-|^learning-panel-/.test(name)) return "lazy-comparison-ui";
  if (/^app-shared-/.test(name)) return "shared-app";
  if (/\.js$/.test(name)) return "main";
  return "other";
};

export function collectChunks(distRoot) {
const chunks = [];
const collect = (dir, base) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { collect(path, base); continue; }
    if (!/\.js$/.test(name)) continue;
    const buf = readFileSync(path);
    chunks.push({ name, file: path.slice(base.length + 1).split("\\").join("/"), kind: chunkKind(name), raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });
  }
};
collect(distRoot, distRoot);
return chunks.sort((a, b) => b.gzip - a.gzip);
}

export function generateSizeReport({ root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), distRoot = join(root, "dist"), reportPath = join(root, "docs/generated/size-report.json") } = {}) {
const before = sizeIdentity(root, distRoot);
const tmpOut = testArtifactTempDir("build-probes", "dist-size-");
try {

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
  console.error("[FAIL] 找不到 vite（先 npm ci）");
  process.exit(2);
}
console.log(`[size] 带 sourcemap 重建到临时目录 ${tmpOut}（不动 dist/）…`);
// 任何退出路径都清掉临时产物（构建抛错时也不例外）。
process.on("exit", () => cleanupArtifactDir(tmpOut));
execFileSync(process.execPath, [viteBin, "build", "--sourcemap", "--outDir", tmpOut, "--emptyOutDir"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

const assets = join(tmpOut, "assets");
const files = readdirSync(assets);
/**
 * 与 `distbudget.mjs` **同一分类口径**。此前这里只把 assets/ 下的非特例归成 main：
 * 既漏了 dist/sw.js（总和偏小），又把 teaching/comparison/diagnostics 三个 lazy chunk
 * 算进主包，于是「全部 JS gzip」与分项之和对不上，归因也失真。新增 chunk 时两处必须同步。
 */
const chunks = collectChunks(distRoot);
const rebuiltChunks = collectChunks(tmpOut);
if (chunks.length !== rebuiltChunks.length || rebuiltChunks.some((chunk) => !chunks.some((current) => current.file === chunk.file))) {
  throw new Error("sourcemap 重建的 JS 清单与被测 dist 不一致");
}
for (const chunk of chunks) {
  const mappedFile = join(tmpOut, chunk.file);
  if (!existsSync(mappedFile) || !mappedCodeMatches(join(distRoot, chunk.file), mappedFile)) {
    throw new Error(`sourcemap 重建与被测产物不一致：${chunk.file}，拒绝给旧 dist 贴新归因`);
  }
}

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
const mainChunk = chunks.find((chunk) => /^index-.*\.js$/.test(chunk.name));
const mainMapName = mainChunk ? `${mainChunk.name}.map` : null;
let attribution = [];
if (mainMapName && files.includes(mainMapName)) {
  const map = JSON.parse(readFileSync(join(assets, mainMapName), "utf8"));
  // 行尾归一：同一份源码在 Windows 检出（CRLF）与打包输入（LF）下字节数不同，
  // 归因报告不该因为换行符而漂移；归一后再量源码体积。
  const normalize = (text) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const perModule = map.sources
    .map((src, i) => ({ module: (src.split("src/")[1] ?? src), group: GROUP_OF(src), bytes: Buffer.byteLength(normalize(map.sourcesContent?.[i] ?? ""), "utf8") }))
    .filter((r) => r.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const byGroup = new Map();
  for (const r of perModule) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + r.bytes);
  attribution = [...byGroup.entries()].map(([group, bytes]) => ({ group, sourceBytes: bytes })).sort((a, b) => b.sourceBytes - a.sourceBytes);
  var topModules = perModule.slice(0, 15);
} else {
  throw new Error("没找到被测主包 sourcemap，拒绝发布缺归因的体积报告");
}

  const problems = sizeDriftProblems(root, before, distRoot);
  if (problems.length) throw new Error(problems.join("；"));
  const source = { digest: before.sourceDigest };
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } })(),
  sourceDigest: source.digest,
  /** 被测产物（dist/）的摘要：本报告是"对这份产物的解释"，两者必须能对上 */
  distHash: before.distHash,
  /** 被测产物的构建标识：体积归因必须指向某一次具体构建，才能和长稳/稳定性/性能对上 */
  buildId: before.buildId,
  driftProblems: problems,
  note: "体积归因用的是一次**带 sourcemap 的独立重建**（临时目录，测完即删），不修改 dist/；chunk 级 raw/gzip 与 dist/ 同源同配置。",
  chunks,
  /** 对账：所有 chunk 的 gzip 之和必须等于 distbudget 的「全部 JS gzip」。 */
  totals: {
    gzipSum: chunks.reduce((sum, chunk) => sum + chunk.gzip, 0),
    rawSum: chunks.reduce((sum, chunk) => sum + chunk.raw, 0),
    files: chunks.length,
  },
  mainAttribution: { groups: attribution, topModules: typeof topModules === "undefined" ? [] : topModules },
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

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
console.log(`\n报告：${reportPath}（dist/ 未被改动：${report.distHash}）`);
return report;
} finally { cleanupArtifactDir(tmpOut); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportArg = process.argv.slice(2).find((arg) => arg.startsWith("--report="));
  generateSizeReport({ ...(reportArg ? { reportPath: resolve(reportArg.slice("--report=".length)) } : {}) });
}
