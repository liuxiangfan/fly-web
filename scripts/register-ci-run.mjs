/**
 * 把一次真实的 GitHub Actions 运行登记进证据索引。
 *
 * 为什么要它：`--require-source` 会把「当前 SHA 的稳定性」钉在这份源码上，而跨平台稳定性
 * 只能由 CI 产生。手工往 manifest 里贴 run id / sha / 结论容易写错，也容易"写成想看到的"。
 * 这个脚本只从 GitHub API 与**运行产物**里读事实，四项校验缺一不可（详见 `ci-registration.mjs`）：
 *   ① workflow / job / attempt 是不是指定的那一个；
 *   ② 冒烟步骤真的执行过（不是被 `if:` 跳过的）；
 *   ③ 产物里有五轮**完整集合**的证据（summary + 逐轮结构化结果 + 用例清单比对）；
 *   ④ 摘要绑定的提交与这次 run 的 head_sha 一致。
 *
 * 用法：
 *   node scripts/register-ci-run.mjs --run=<id> [--job-re=^smoke-stability] [--runs=5] [--workflow=CI]
 *   node scripts/register-ci-run.mjs --run=<id> --legacy-reason="该 run 早于结构化产物（SW-07）"
 *
 * 约定：
 *   · 只有 head_sha 与审查基线一致才标 current；`--current=true` **不能**用来把旧 run 伪装成当前
 *     （旧 run 请按历史登记：不标 current，并在 note 里写清它是祖先）。
 *   · `--legacy-reason` 用于登记**早于本工单**的旧 run：结构化产物不存在，于是显式记成
 *     `provenanceComplete: false` 的历史条目——不冒充完整溯源。
 * 前置：`gh auth status` 已登录（只读 API + 下载运行产物）。脚本不会触发任何 workflow。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryFor, pickStabilityJobs, roundResultProblems, smokeStepProblems, summaryProblems } from "./ci-registration.mjs";
import { loadManifest } from "./smoke-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const runId = String(arg.run ?? "").trim();
if (!/^\d+$/.test(runId)) {
  console.error("[FAIL] 用法：node scripts/register-ci-run.mjs --run=<run id> [--job-re=^smoke-stability] [--runs=5] [--workflow=CI]");
  process.exit(2);
}
const jobRe = arg["job-re"] ? new RegExp(String(arg["job-re"])) : /^smoke-stability/;
const expectedRuns = Number(arg.runs ?? 5);
if (!Number.isSafeInteger(expectedRuns) || expectedRuns < 1) { console.error("[FAIL] --runs 必须是正整数"); process.exit(2); }
const expectedWorkflow = String(arg.workflow ?? "CI");
const wantedAttempt = arg.attempt === undefined ? null : Number(arg.attempt);
const legacyReason = arg["legacy-reason"] ? String(arg["legacy-reason"]) : null;

const ghJson = (path) => JSON.parse(execFileSync("gh", ["api", path], { cwd: root, encoding: "utf8" }));
const die = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(2); };

let run;
try {
  run = ghJson(`repos/{owner}/{repo}/actions/runs/${runId}`);
} catch (err) {
  die(`读不到 run ${runId}（gh 未登录 / 权限不足 / id 不存在）：${err instanceof Error ? err.message.split("\n")[0] : err}`);
}
const sha = run.head_sha;
if (!/^[0-9a-f]{40}$/.test(String(sha))) die(`run ${runId} 没有 head_sha，无法绑定提交`);
// ① workflow 名称：同一次运行里 gate / smoke-shards / smoke-stability 都可能存在，名字对不上就不是我们要的
if (String(run.name ?? "") !== expectedWorkflow) {
  die(`run ${runId} 的 workflow 是「${run.name}」，期望「${expectedWorkflow}」（--workflow= 可覆盖）`);
}
const attempt = wantedAttempt ?? Number(run.run_attempt ?? 1);
if (!Number.isSafeInteger(attempt) || attempt < 1) die(`attempt 非法：${run.run_attempt}`);
const jobs = ghJson(`repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`).jobs ?? [];
const { picked, problems: pickProblems } = pickStabilityJobs({ jobs, jobRe, attempts: attempt });
if (!picked.length) die(`${pickProblems.join("；")}（attempt=${attempt}）`);

const baseline = (() => {
  try {
    const m = /<!--\s*baseline:\s*([0-9a-f]{7,40})\s*-->/.exec(readFileSync(join(root, "docs/PROJECT-STATE.md"), "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
})();
const headMatchesBaseline = baseline !== null && String(sha).startsWith(baseline);
if (arg.current === "true" && !headMatchesBaseline) {
  die(`--current=true 不能把旧 run 伪装成当前：head_sha ${String(sha).slice(0, 12)} ≠ 审查基线 ${baseline ?? "未声明"}。请按历史登记（不加 --current）。`);
}
const asCurrent = headMatchesBaseline;

/** 下载运行产物并解包（gh 会按 artifact 名建子目录）；失败返回 null。 */
function downloadArtifacts() {
  const dir = mkdtempSync(join(tmpdir(), `ci-reg-${runId}-`));
  try {
    execFileSync("gh", ["run", "download", String(runId), "--dir", dir], { cwd: root, stdio: "ignore" });
    return dir;
  } catch {
    return null;
  }
}
function findFiles(dir, pattern) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (pattern.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const manifest = loadManifest(join(root, "scripts/smoke-manifest.json"));
const manifestPath = join(root, "docs/generated/evidence-manifest.json");
const manifestFile = JSON.parse(readFileSync(manifestPath, "utf8"));

// 产物只下载一次：内容校验与归因都用它
let artifactDir = null;
let summaries = [];
let rounds = {};
if (!legacyReason) {
  artifactDir = downloadArtifacts();
  if (artifactDir) {
    summaries = findFiles(artifactDir, /^summary-.*\.json$/).map(readJson).filter(Boolean);
    for (const f of findFiles(artifactDir, /^smoke-(app|devices)-run\d+\.json$/)) {
      const m = /smoke-(app|devices)-run(\d+)\.json$/.exec(f);
      const parsed = readJson(f);
      if (m && parsed) rounds[`${m[1]}-run${m[2]}`] = parsed;
    }
  }
}
const summary = summaries.find((s) => s.shard === "both") ?? summaries[0] ?? null;

const added = [];
const failed = [];
for (const job of picked) {
  const contentProblems = [];
  if (legacyReason) {
    contentProblems.push(`显式按历史登记：${legacyReason}`);
  } else {
    contentProblems.push(...smokeStepProblems(job));
    if (!artifactDir) contentProblems.push("下载不到运行产物（gh run download 失败）——没有产物就无法核对五轮完整集合");
    else {
      if (!summaries.length) contentProblems.push("产物里没有 summary-*.json（ci-run-smoke 写的摘要）");
      else contentProblems.push(...summaryProblems(summary, { expectedRuns, shard: "both", headSha: sha }));
      contentProblems.push(...roundResultProblems(rounds, manifest, { expectedRuns, shard: "both" }));
    }
  }
  const contentOk = !legacyReason && contentProblems.length === 0;
  const entry = entryFor({ run, job, summary, attempt, legacyReason, current: asCurrent, baseline });
  // 内容校验不过：结论只能是 FAIL（有产物问题就是"证据不齐"，不许登记成 PASS）
  if (!contentOk && !legacyReason) entry.result = "FAIL";
  if (asCurrent && entry.result !== "PASS") {
    failed.push(`job「${job.name}」不能登记为 current：${contentProblems.slice(0, 4).join("；")}`);
    continue;
  }
  if (asCurrent) {
    for (const e of manifestFile.entries) {
      if (e.kind === "github-actions-smoke-stability" && e.current === true && e.runnerOs === entry.runnerOs && e.id !== entry.id) {
        e.current = false;
        e.supersededBy = entry.id;
      }
    }
  }
  const i = manifestFile.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) manifestFile.entries[i] = entry; else manifestFile.entries.push(entry);
  added.push(`${entry.id} = ${entry.result}（${entry.runnerOs}，attempt ${attempt}）${contentOk || legacyReason ? "" : " · 内容校验未通过，仅作失败观测"}`);
  if (!contentOk && !legacyReason) for (const p of contentProblems.slice(0, 6)) console.error(`      · ${p}`);
}

if (failed.length) {
  for (const f of failed) console.error(`[FAIL] ${f}`);
  if (!added.length) process.exit(1);
  process.exitCode = 1;
}
if (!added.length) { console.error("[FAIL] 没有可登记的条目"); process.exit(1); }
manifestFile.generatedAt = new Date().toISOString();
writeFileSync(manifestPath, `${JSON.stringify(manifestFile, null, 2)}\n`, "utf8");
console.log(`[ok] 已登记 run ${runId}（head_sha ${sha.slice(0, 12)}，attempt ${attempt}）：`);
for (const a of added) console.log(`  · ${a}`);
console.log(`\n下一步：node scripts/evidencecheck.mjs --require-source${asCurrent ? " --require-build" : ""}`);
