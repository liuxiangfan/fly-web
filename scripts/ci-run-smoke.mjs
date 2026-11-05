/**
 * CI 用的冒烟驱动器：起 preview → 等它就绪 → 连跑 N 次冒烟 → 收尾。
 *
 * 为什么要有这个文件（而不是在 workflow 里写 shell）：
 *  · Windows 与 Ubuntu 的 shell 语法不同（`&` / `Start-Process` / curl 有无），
 *    CI 里最不该出现的就是「同一段验证在两个 runner 上行为不同」；
 *  · 「连续 N 次全绿、零 warning、零重启」这条验收要求**逐次**留证：每次的输出单独落盘，
 *    并在结尾汇总，任何一次失败都让整步失败（不能只看最后一次）。
 *
 * 用法：
 *   node scripts/ci-run-smoke.mjs --runs=5 [--shard=app|devices|all] [--out=dir] [--port=4173]
 *
 * 退出码：0 = N 次全绿；1 = 有失败；2 = 参数/环境错误（起不来 preview 等）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { sourceDigest, worktreeState } from "./source-digest.mjs";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { roundVerdict, setVerdict } from "./smoke-verdict.mjs";
import { coverageProblems, loadManifest, runProblems } from "./smoke-manifest.mjs";
import { captureIdentity, captureDriftProblems, fetchServedProvenance, identityProblems } from "./served-build.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const runs = Number(arg.runs ?? 1);
const shard = String(arg.shard ?? "all").toLowerCase();
const port = Number(arg.port ?? 4173);
const outDir = resolve(root, arg.out ?? ".audit-smoke/ci");
if (!Number.isSafeInteger(runs) || runs < 1) { console.error("[FAIL] --runs 必须是正整数"); process.exit(2); }
if (!["all", "app", "devices", "both"].includes(shard)) {
  console.error("[FAIL] --shard 只支持 all / app / devices / both（both = 每轮先 app 再 devices，各自独立浏览器）");
  process.exit(2);
}
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("[FAIL] 找不到 dist/index.html——先 npm run build 再跑本脚本");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
/**
 * 冒烟用例清单（SW-07）：验收比对的是**完整集合**。清单来自 `scripts/smoke-manifest.json`，
 * 它与 `browser-smoke.mjs` 的声明由契约测试守着（删用例不改清单会报警）。
 */
const manifestPath = join(root, "scripts", "smoke-manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[FAIL] 缺少 scripts/smoke-manifest.json——先 node scripts/make-smoke-manifest.mjs");
  process.exit(2);
}
const manifest = loadManifest(manifestPath);

const url = `http://127.0.0.1:${port}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 起 preview。直接用 node 跑 vite 的 bin（不经 shell）：
 *  · Windows 上 `spawn("npx", …, {shell:true})` 会触发 DEP0190（参数未转义），
 *    而显式走 node + bin 路径在两个系统上完全一致；
 *  · `--host 127.0.0.1` 是必须的：vite preview 默认绑 `localhost`，
 *    在部分环境里只绑到 ::1，于是 `http://127.0.0.1:<port>` 探活会一直失败（实测踩到）。
 */
function startPreview() {
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.on("data", (b) => process.stdout.write(`[preview] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[preview] ${b}`));
  return child;
}

/** 等 preview 真的能返回 200（不是「进程起来了」）。 */
async function waitForPreview(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await wait(500);
  }
  return false;
}

/** 跑一次冒烟，输出与**结构化结果**都落盘，返回判定所需的一切。 */
async function runShard(which, index) {
  const logPath = join(outDir, `smoke-${which}-run${index}.log`);
  const resultPath = join(outDir, `smoke-${which}-run${index}.json`);
  const child = spawn(process.execPath, [join(root, "scripts", "browser-smoke.mjs")], {
    cwd: root,
    env: { ...process.env, SMOKE_URL: url, SMOKE_SHARD: which, SMOKE_RESULT: resultPath },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let out = "";
  child.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
  child.stderr.on("data", (b) => { out += b; process.stderr.write(b); });
  const code = await new Promise((r) => child.on("close", r));
  writeFileSync(logPath, out, "utf8");
  // 结构化结果优先；缺失时不"猜"，由 roundVerdict 判成"执行未完成"
  let report = null;
  if (existsSync(resultPath)) {
    try { report = JSON.parse(readFileSync(resultPath, "utf8")); }
    catch (err) { console.error(`[ci] 结构化结果不是合法 JSON：${err.message}`); }
  }
  const browser = /\[INFO\] 浏览器版本：(.+)/.exec(out)?.[1]?.trim() ?? null;
  const ids = Array.isArray(report?.results) ? report.results.map((r) => r.id) : [];
  const manifestProblems = report ? runProblems(manifest, { shard: which, ids, skipped: report.skipped ?? [], duplicateIds: report.duplicateIds ?? [] }) : [];
  const verdict = roundVerdict({ code, out, report, shard: which, manifestProblems });
  const lines = out.split(/\r?\n/);
  const passes = report?.passed ?? lines.filter((l) => l.startsWith("[PASS]")).length;
  const fails = report?.failed ?? lines.filter((l) => l.startsWith("[FAIL]")).length;
  const warns = lines.filter((l) => l.includes("[warn]")).length;
  console.log(`[ci] run ${index} (${which}): exit=${code} · ${passes} PASS / ${fails} FAIL / ${warns} warn · 判定 ${verdict.kind}${verdict.capacity ? "（容量证据命中）" : ""} → ${logPath}`);
  for (const r of verdict.reasons.slice(0, 3)) console.log(`      · ${r}`);
  return { index, shard: which, code, passes, fails, warns, logPath, resultPath, browser, verdict, ids, manifestProblems };
}

/**
 * 跑一轮冒烟。`--shard=both`：每轮**先 app 再 devices**，两个独立浏览器进程；两者都过才算这轮过。
 * 为什么要它：Windows 的 2 vCPU runner 上「一个浏览器跑完全套」会被回收/超时（任务书 9.17），
 * 分片正是复核要求的缓解手段——按片各起一个进程，单进程的 WebGL 页面数与时长都降下来。
 */
async function runSmokeOnce(index) {
  if (shard !== "both") {
    const one = await runShard(shard, index);
    return { ...one, verdict: { ...one.verdict } };
  }
  const app = await runShard("app", index);
  const devices = await runShard("devices", index);
  const code = app.code === 0 && devices.code === 0 ? 0 : 1;
  const passes = app.passes + devices.passes;
  const fails = app.fails + devices.fails;
  const warns = app.warns + devices.warns;
  const verdict = setVerdict({ rounds: [{ index, shard: "app", ...app.verdict }, { index, shard: "devices", ...devices.verdict }] });
  const label = { pass: "全绿", assert: "产品断言失败", incomplete: "执行未完成/集合不齐", env: "环境/基础设施失败", unknown: "根因未知" }[verdict.kind];
  console.log(`[ci] 轮 ${index} 合计：${passes} PASS / ${fails} FAIL / ${warns} warn（app ${app.passes} + devices ${devices.passes}）· 判定：${label}`);
  return { index, shard: "both", code, passes, fails, warns, logPath: `${app.logPath} + ${devices.logPath}`, resultPath: `${app.resultPath} + ${devices.resultPath}`, browser: app.browser ?? devices.browser, verdict, ids: { app: app.ids, devices: devices.ids }, manifestProblems: [...app.manifestProblems, ...devices.manifestProblems] };
}

/**
 * 实际提交 SHA：优先用 git 解析（HEAD 可能是符号引用），退化到环境变量，再退化到 null。
 * 摘要里写的是"这次跑的是哪个提交"，不能写 ref 文本。
 */
function actualCommit() {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(out)) return out;
  } catch { /* 无 git */ }
  for (const k of ["GITHUB_SHA", "CI_COMMIT_SHA"]) {
    const v = process.env[k];
    if (v && /^[0-9a-f]{7,40}$/i.test(v)) return v;
  }
  return null;
}

const preview = startPreview();
try {
  if (!(await waitForPreview())) {
    console.error(`[FAIL] preview 在 90 s 内没有就绪（${url}）`);
    process.exit(2);
  }
  console.log(`[ci] preview 就绪：${url}；分片 SMOKE_SHARD=${shard}；计划连跑 ${runs} 次`);
  /**
   * 采集起点的身份快照 + 被测产物身份（SW-06）：先确认"要跑的就是这份源码、这份产物"，
   * 跑完再确认两者都没变。中途有人重建 dist / 改源码，这次验收就整次作废——
   * 而不是给旧结果贴上新的摘要。
   */
  const identityBefore = captureIdentity(root);
  const localProvenance = readProvenance(join(root, "dist"));
  const servedProblems = [];
  {
    const served = await fetchServedProvenance(url);
    servedProblems.push(...identityProblems({ localProvenance, served, distDir: join(root, "dist") }));
    if (servedProblems.length) console.warn(`[warn] 被测产物身份核对：${servedProblems.join("；")}`);
  }
  const results = [];
  for (let i = 1; i <= runs; i++) results.push(await runSmokeOnce(i));
  const driftProblems = captureDriftProblems(root, identityBefore);
  if (driftProblems.length) console.warn(`[warn] 采集期间身份发生变化：${driftProblems.join("；")}`);

  const bad = results.filter((r) => r.verdict.kind !== "pass" || r.warns > 0);
  /**
   * 摘要即证据：必须能回答「哪份源码、哪份产物、哪个浏览器、哪台系统、跑了几轮、跑了哪些用例」。
   * commit 单独一项是不够的——改了没提交时它指向上一版代码（复核 P1），所以同时记 sourceDigest 与 worktree。
   */
  const source = sourceDigest(root);
  // 两片合起来必须恰好覆盖清单（app ∩ devices = ∅），否则"看起来全绿"其实漏了用例
  const coverage = shard === "both" && results.length
    ? coverageProblems(manifest, { app: results[0].ids.app ?? [], devices: results[0].ids.devices ?? [] })
    : [];
  const perRound = results.map((r) => ({ index: r.index, kind: r.verdict.kind, reasons: r.verdict.reasons, capacity: r.verdict.capacity }));
  const overall = setVerdict({ rounds: perRound, coverage });
  const identityOk = servedProblems.length === 0 && driftProblems.length === 0;
  const summary = {
    generatedAt: new Date().toISOString(),
    shard, runs, url,
    // 实际 SHA，而不是 `.git/HEAD` 的 ref 文本（head 里可能是 "ref: refs/heads/master"）。
    commit: actualCommit(),
    sourceDigest: source.digest,
    sourceFiles: source.files,
    worktree: worktreeState(root),
    // 构建溯源（SW-06）：产物为自己声明 buildId，报告据此绑定"源码 → 产物"
    buildId: localProvenance?.buildId ?? null,
    distHash: distHashOf(join(root, "dist")),
    browserVersion: results.map((r) => r.browser).find(Boolean) ?? null,
    runnerOs: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    // 完整集合：本轮跑的用例数与清单里的声明数（验收比对的是集合，不是 PASS 行数）
    manifest: { total: manifest.total, app: manifest.shards.app.length, devices: manifest.shards.devices.length },
    ids: shard === "both" && results.length ? { app: results[0].ids.app ?? [], devices: results[0].ids.devices ?? [] } : { [shard]: results[0]?.ids ?? [] },
    servedProblems,
    driftProblems,
    /**
     * 判定（SW-07）：`verdict.pass` 是唯一的通过含义；`kind` 说明为什么没通过
     * （assert/incomplete/env/unknown）。capacity 只是"有容量证据"的标注，不是通过、也不减责。
     */
    verdict: { pass: overall.pass && identityOk, kind: overall.pass ? (identityOk ? "pass" : "unknown") : overall.kind, capacity: perRound.some((r) => r.capacity), reasons: [...overall.reasons, ...servedProblems, ...driftProblems] },
    results: results.map((r) => ({ index: r.index, code: r.code, passes: r.passes, fails: r.fails, warns: r.warns, kind: r.verdict.kind, reasons: r.verdict.reasons, capacity: r.verdict.capacity })),
  };
  writeFileSync(join(outDir, `summary-${shard}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[ci] 汇总：${results.map((r) => `${r.passes}P/${r.fails}F/${r.warns}W`).join(" · ")}`);
  if (!summary.verdict.pass) {
    const why = {
      assert: "出现**用例级** FAIL——那是产品缺陷，必须修",
      incomplete: "执行没有跑完完整集合（缺项/跳过/重复/无完成标记）——本次不能算通过",
      env: "没有用例级 FAIL，但命中页面/浏览器/预览启动类证据（可按 runner 容量归因，仍判失败）",
      unknown: "归因证据不足（根因未知）——不轻判成容量，请先看日志与产物身份",
    }[summary.verdict.kind];
    console.error(`[FAIL] ${bad.length}/${runs} 次没有达到「完整集合全绿且零 warning」：run ${bad.map((b) => b.index).join(", ") || "—"}；${why}`);
    for (const r of summary.verdict.reasons.slice(0, 5)) console.error(`      · ${r}`);
    process.exit(1);
  }
  console.log(`[PASS] 连续 ${runs} 次冒烟全绿（分片 ${shard}，完整集合 ${manifest.total} 项，零 warning、零重启）`);
} finally {
  try { preview.kill(); } catch { /* 已退出 */ }
  await wait(500);
}
