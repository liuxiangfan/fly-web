/**
 * 把**本机采集**的证据报告登记进证据索引（与 `register-ci-run.mjs` 对应，那个管 CI）。
 *
 * 为什么单独一个脚本：手工往 manifest 里贴 sha256 / sourceDigest / distHash / buildId
 * 既容易写错，也容易"写成想看到的"（复核 SW-06 的原话）。这里只从报告里读事实：
 *   ① 用 `parseEvidenceReport` 按类型解析报告**正文**，完整性不过就拒绝登记；
 *   ② 源码摘要 / 产物摘要 / 构建标识 / 浏览器 / 平台 / 轮次全部取自报告；
 *   ③ 同类型同平台的旧 current 自动让位（标成历史，不删除）。
 *
 * 用法：
 *   node scripts/register-local-evidence.mjs \
 *     --soak-batch=docs/generated/soak-batch-600-xxxx.json \
 *     --soak-reconnect=docs/generated/soak-reconnect-600-xxxx.json \
 *     --stability=docs/generated/stability-local-windows-xxxx.json \
 *     --visual=docs/generated/visual-evidence.json \
 *     --perf=docs/generated/perf-report.json \
 *     --size=docs/generated/size-report.json
 * （也可以只给其中几项；未给的不会被改动。）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvidenceReport } from "./evidence-report.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);

const KIND_OF = {
  "soak-batch": { kind: "software-soak-batch", id: (d) => `soak-batch-600-${d}` },
  "soak-reconnect": { kind: "software-soak-reconnect", id: (d) => `soak-reconnect-600-${d}` },
  stability: { kind: "software-smoke-stability", id: (d) => `stability-local-windows-${d}` },
  "soak-teaching": { kind: "software-soak-teaching", id: (d) => `soak-teaching-600-${d}` },
  visual: { kind: "visual-screenshot", id: (d) => `visual-current-${d}` },
  perf: { kind: "performance-report", id: () => "perf-current" },
  size: { kind: "size-report", id: () => "size-current" },
};

const root = arg.root ? resolve(arg.root) : scriptRoot; // 隔离契约现场，不改真索引。
const manifestPath = join(root, "docs/generated/evidence-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const added = [];
const refused = [];
for (const [flag, spec] of Object.entries(KIND_OF)) {
  const rel = arg[flag];
  if (!rel) continue;
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    refused.push(`${flag}: 报告不存在（${rel}）`);
    continue;
  }
  const parsed = parseEvidenceReport(spec.kind, abs);
  if (!parsed.recognized) {
    refused.push(`${flag}: ${spec.kind} 不是可解析的报告类型`);
    continue;
  }
  if (!parsed.ok) {
    refused.push(`${flag}: 报告无法解析（${parsed.error}）`);
    continue;
  }
  if ((parsed.completeness ?? []).length) {
    refused.push(`${flag}: 报告不满足该类型的完整性要求 —— ${parsed.completeness.slice(0, 4).join("；")}`);
    continue;
  }
  const r = parsed.report;
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const digest8 = String(r.sourceDigest ?? raw.sourceDigest ?? "").slice(0, 8);
  const reportSha = sha256(abs);
  // 同 digest 复采也必须保留旧 id/报告身份；报告 hash 区分旧版无 captureId 的采集。
  const id = spec.kind === "visual-screenshot" ? `${spec.id(digest8)}-${r.captureId ?? reportSha.slice(0, 16)}` : spec.id(digest8);
  if (spec.kind === "visual-screenshot") {
    const pixelProblems = (parsed.pixels ?? []).flatMap((shot) => {
      const file = resolve(root, shot.file);
      return !existsSync(file) || !statSync(file).isFile() ? [`截图不存在：${shot.file}`]
        : sha256(file) !== shot.sha256 ? [`像素哈希与报告不符：${shot.file}`] : [];
    });
    if (pixelProblems.length) { refused.push(`${flag}: ${pixelProblems.join("；")}`); continue; }
    const collision = manifest.entries.find((e) => e.kind === spec.kind && e.id !== id && resolve(root, e.path) === abs);
    if (collision) { refused.push(`${flag}: 报告路径已属于 ${collision.id}，不得覆盖旧采集，请使用新报告路径`); continue; }
  }
  const previous = manifest.entries.find((e) => e.id === id);
  if (spec.kind === "visual-screenshot" && previous && (previous.sha256 !== reportSha || previous.path !== rel)) {
    refused.push(`${flag}: ${id} 的旧报告身份不可覆盖`);
    continue;
  }
  if (spec.kind === "visual-screenshot" && previous) { added.push(`${id} 已登记（原条目与覆盖历史保持不变）`); continue; }
  const entry = {
    id,
    kind: spec.kind,
    path: rel,
    sha256: reportSha,
    sourceCommit: r.sourceCommit,
    sourceDigest: r.sourceDigest,
    distHash: r.distHash,
    buildId: r.buildId,
    browserVersion: r.browserVersion,
    runnerOs: r.runnerOs ?? `${process.platform} ${process.arch}`,
    result: r.pass === false ? "FAIL" : "PASS",
    provenanceComplete: true,
    localOnly: spec.kind === "visual-screenshot",
    ...(spec.kind === "visual-screenshot" ? { captureId: r.captureId, startedAt: r.startedAt, finishedAt: r.finishedAt } : {}),
    current: true,
    supersedes: [],
    runs: r.runs ?? null,
    notes: `本机采集（${new Date().toISOString().slice(0, 10)}）：由 scripts/register-local-evidence.mjs 从报告正文读取事实后登记；` +
      `同类型同平台的旧 current 已自动让位为历史观测。完整集合/判据由 ${spec.kind} 的解析器复核。`,
  };
  // 让位：同类型同平台的上一条 current
  for (const e of manifest.entries) {
    if (e.kind === spec.kind && e.current === true && e.runnerOs === entry.runnerOs && e.id !== id) {
      e.current = false;
      e.supersededBy = id;
      e.notes = `${e.notes}${e.notes.endsWith("。") ? "" : "。"}已由 ${id} 取代（同一平台的新采集）。`;
    }
  }
  const i = manifest.entries.findIndex((e) => e.id === id);
  if (i >= 0) manifest.entries[i] = entry; else manifest.entries.push(entry);
  added.push(`${id} ← ${rel}（${entry.result}，dist ${String(entry.distHash).slice(0, 8)}，build ${String(entry.buildId ?? "—").slice(0, 20)}）`);
}

if (refused.length) {
  console.error("[FAIL] 以下证据**拒绝登记**（不许把不合格的报告写进索引）：");
  for (const r of refused) console.error(`  · ${r}`);
}
if (!added.length) {
  console.error("[FAIL] 没有可登记的条目");
  process.exit(1);
}
manifest.generatedAt = new Date().toISOString();
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[ok] 已登记 ${added.length} 条：`);
for (const a of added) console.log(`  · ${a}`);
if (refused.length) process.exitCode = 1;
console.log("\n下一步：node scripts/evidencecheck.mjs --require-source --require-build");
