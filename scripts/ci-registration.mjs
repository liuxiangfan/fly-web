/**
 * CI 稳定性运行的**登记判定**（SW-07，纯函数，便于用真实/构造的运行数据做契约测试）。
 *
 * 为什么单独一个模块：登记是"把一次 CI 运行写成验收证据"的动作，最容易写成"看 job 是绿的
 * 就登记 PASS"。旧实现就有两个真实漏洞——普通 `gate` job 成功、或**名为稳定性的 job 里
 * 冒烟步骤被 `if:` 跳过**，都会被登记成稳定性 PASS。
 *
 * 这里把判定拆成四问，缺一不可：
 *   ① 这是不是我们要的那个 workflow/job/attempt？（名字只是最低门槛）
 *   ② 冒烟步骤真的**跑过**了吗？（conclusion=success，不是 skipped）
 *   ③ 产物里有没有五轮**完整集合**的证据？（summary + 逐轮结构化结果 + 清单比对）
 *   ④ 这份摘要绑定的提交/产物，和这次 run 的 head_sha 是不是同一个？
 * 失败时还要**保守归因**：只有拿到容量证据才写"容量"，否则写"根因未知"。
 */

const RAN = new Set(["success", "failure", "cancelled", "timed_out"]);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 从 jobs 里挑出"真的跑过的稳定性 job"。 */
export function pickStabilityJobs({ jobs, jobRe = /^smoke-stability/, attempts = null }) {
  const problems = [];
  const picked = [];
  for (const job of jobs ?? []) {
    if (!isObj(job)) { problems.push("jobs 里有非法条目"); continue; }
    if (jobRe && !jobRe.test(String(job.name ?? ""))) continue;
    if (!RAN.has(String(job.conclusion))) continue; // skipped / null 都不是证据
    if (attempts !== null && Number(job.run_attempt ?? 1) !== Number(attempts)) continue;
    picked.push(job);
  }
  if (!picked.length) {
    problems.push(`没有匹配「真的跑过」的稳定性 job（--job-re=${jobRe ?? "未指定"}）；现有：${(jobs ?? []).map((j) => `${j.name}=${j.conclusion}`).join(" / ") || "（空）"}`);
  }
  return { picked, problems };
}

/** 冒烟步骤是否真的执行过（`if:` 跳过会让 job 依然 success——这正是旧实现漏掉的那一条）。 */
export function smokeStepProblems(job, stepRe = /smoke|冒烟|×/i) {
  const problems = [];
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (!steps.length) return [`job「${job?.name}」没有 steps（无法证明冒烟步骤真的执行过）`];
  const smokeSteps = steps.filter((s) => stepRe.test(String(s?.name ?? "")));
  if (!smokeSteps.length) return [`job「${job?.name}」里找不到冒烟步骤（步骤名都不匹配 ${stepRe}）`];
  for (const s of smokeSteps) {
    if (s.conclusion === "skipped") problems.push(`冒烟步骤「${s.name}」被跳过（skipped）——被跳过的步骤不能算证据`);
    else if (s.conclusion !== "success") problems.push(`冒烟步骤「${s.name}」的结论是 ${s.conclusion}`);
    else if (!s.number && s.number !== 0) problems.push(`冒烟步骤「${s.name}」没有步骤序号（无法证明它真的执行过）`);
  }
  return problems;
}

/** 摘要（ci-run-smoke 写的 summary-<shard>.json）是否自证"完整集合全绿"。 */
export function summaryProblems(summary, { expectedRuns = 5, shard = "both", headSha = null } = {}) {
  const problems = [];
  if (!isObj(summary)) return ["缺少 summary JSON（没有它就无法核对轮次与完整集合）"];
  const verdict = summary.verdict;
  const declaredPass = verdict === "pass" || (isObj(verdict) && verdict.pass === true);
  if (verdict === undefined || verdict === null) problems.push("summary 没有 verdict");
  else if (!declaredPass) problems.push(`summary 的判定是 ${isObj(verdict) ? verdict.kind ?? "失败" : String(verdict)}（不是通过）`);
  if (shard === "both" && summary.shard !== "both") problems.push(`summary 的分片是 ${summary.shard}，稳定性验收要求 both`);
  if (summary.runs !== expectedRuns) problems.push(`summary 的 runs=${summary.runs}，期望 ${expectedRuns}`);
  if (!Array.isArray(summary.results) || summary.results.length !== expectedRuns) {
    problems.push(`summary 的逐轮结果有 ${Array.isArray(summary.results) ? summary.results.length : "0"} 条，期望 ${expectedRuns}`);
  } else {
    summary.results.forEach((r, i) => {
      const n = r?.index ?? i + 1;
      if (r?.fails !== 0) problems.push(`第 ${n} 轮 fails=${r?.fails}`);
      if (r?.warns !== 0) problems.push(`第 ${n} 轮 warns=${r?.warns}`);
      if (r?.kind !== "pass") problems.push(`第 ${n} 轮的判定是 ${r?.kind}`);
    });
  }
  if (summary.warns !== undefined && summary.warns !== 0) problems.push(`summary 记了 ${summary.warns} 条 warning`);
  for (const field of ["sourceDigest", "distHash", "buildId"]) {
    if (!summary[field]) problems.push(`summary 缺 ${field}（无法绑定源码与产物）`);
  }
  if (headSha) {
    const a = String(summary.commit ?? "").toLowerCase();
    const b = String(headSha).toLowerCase();
    if (!a || !(b.startsWith(a) || a.startsWith(b))) {
      problems.push(`summary 记的提交 ${a || "（缺失）"} 与 run 的 head_sha ${b.slice(0, 12)} 不一致——摘要不是这次运行的产物`);
    }
  }
  return problems;
}

/** 逐轮结构化结果是否齐、是否完整（缺项/跳过/重复都要点名）。 */
export function roundResultProblems(rounds, manifest, { expectedRuns = 5, shard = "both" } = {}) {
  const problems = [];
  const shards = shard === "both" ? ["app", "devices"] : [shard];
  if (!isObj(rounds)) return ["没有读到逐轮结构化结果"];
  for (let i = 1; i <= expectedRuns; i++) {
    for (const s of shards) {
      const r = rounds[`${s}-run${i}`];
      if (!r) { problems.push(`第 ${i} 轮的 ${s} 片没有结构化结果（缺项不许当通过）`); continue; }
      if (r.completed !== true) problems.push(`第 ${i} 轮 ${s} 片自称未完成${r.abortReason ? `（${String(r.abortReason).slice(0, 100)}）` : ""}`);
      if (r.shard !== s) problems.push(`第 ${i} 轮 ${s} 片的结果里写的分片是 ${r.shard}`);
      if ((r.skipped ?? []).length) problems.push(`第 ${i} 轮 ${s} 片跳过了 ${r.skipped.length} 项`);
      if ((r.duplicateIds ?? []).length) problems.push(`第 ${i} 轮 ${s} 片有重复用例名`);
      if (r.failed > 0) problems.push(`第 ${i} 轮 ${s} 片有 ${r.failed} 项失败`);
      if (manifest) {
        const ids = (r.results ?? []).map((x) => x?.id).filter(Boolean);
        const expected = shard === "all" ? [...manifest.shards.app, ...manifest.shards.devices] : manifest.shards[s] ?? [];
        const missing = expected.filter((id) => !ids.includes(id));
        const extra = ids.filter((id) => !expected.includes(id));
        if (missing.length) problems.push(`第 ${i} 轮 ${s} 片少跑 ${missing.length} 项：${missing.slice(0, 3).join("；")}`);
        if (extra.length) problems.push(`第 ${i} 轮 ${s} 片多出 ${extra.length} 项：${extra.slice(0, 3).join("；")}`);
      }
    }
  }
  return problems;
}

/**
 * 保守归因：只解释"为什么红"，不改结论。
 * 只有拿到容量证据（summary 自己标了 capacity，或摘要里带明确的资源/页面就绪证据）才写"容量"，
 * 否则一律"根因未知"——不能因为"CI 机器慢"就把红灯解释成非产品问题。
 */
export function attributionOf({ job, summary }) {
  const evidence = [];
  const kind = isObj(summary?.verdict) ? summary.verdict.kind : null;
  if (isObj(summary?.verdict) && summary.verdict.capacity === true) {
    evidence.push("summary 标注了容量证据（页面/浏览器/预览启动类签名）");
    for (const r of summary.verdict.reasons ?? []) if (/容量|timeout|超时|回收|就绪/.test(String(r))) evidence.push(String(r).slice(0, 160));
  }
  if (kind === "assert") return { kind: "assert", capacity: false, evidence: (summary?.verdict?.reasons ?? []).map((r) => String(r).slice(0, 160)) };
  if (kind === "incomplete") return { kind: "incomplete", capacity: false, evidence: (summary?.verdict?.reasons ?? []).map((r) => String(r).slice(0, 160)) };
  if (kind === "env" && evidence.length) return { kind: "env", capacity: true, evidence };
  if (job?.conclusion === "cancelled") return { kind: "env", capacity: false, evidence: ["job 被取消（cancelled）"] };
  if (job?.conclusion === "timed_out") return { kind: "env", capacity: false, evidence: ["job 超时（timed_out）"] };
  if (job?.conclusion !== "success") return { kind: "unknown", capacity: false, evidence: ["没有可归因的证据——按根因未知处理，先看日志与产物"] };
  return { kind: "pass", capacity: false, evidence };
}

/** 组装要写进证据索引的条目（字段口径与索引校验器一致）。 */
export function entryFor({ run, job, summary, attempt, legacyReason = null, current = false, baseline = null }) {
  const os = job?.labels?.find((l) => /ubuntu|windows|macos/.test(l)) ?? job?.runner_name ?? "unknown";
  const workload = os === "windows-latest" ? "win" : os === "ubuntu-latest" ? "ubuntu" : String(os).replace(/[^a-z0-9]+/gi, "-");
  const id = `ci-stability-${workload}-${String(run.head_sha).slice(0, 7)}`;
  const attribution = attributionOf({ job, summary });
  const pass = job?.conclusion === "success" && attribution.kind === "pass" && !legacyReason;
  const notes = [
    `GitHub Actions run ${run.id}（workflow「${run.name}」，attempt ${attempt}）的 job「${job?.name}」（${os}）`,
    legacyReason ? `按 --legacy-reason 登记为历史观测：${legacyReason}` : `判定 ${pass ? "PASS" : "FAIL"}；归因 ${attribution.kind}${attribution.capacity ? "（有容量证据）" : ""}`,
    current ? "标记 current：head_sha 与审查基线一致。" : `**未标 current**：head_sha ${String(run.head_sha).slice(0, 12)} 与审查基线 ${baseline ?? "未声明"} 不同，只作历史观测。`,
  ];
  return {
    id,
    kind: "github-actions-smoke-stability",
    path: job?.html_url ?? run.html_url,
    sha256: null,
    sourceCommit: run.head_sha,
    sourceDigest: legacyReason ? null : summary?.sourceDigest ?? null,
    distHash: legacyReason ? null : summary?.distHash ?? null,
    buildId: legacyReason ? null : summary?.buildId ?? null,
    browserVersion: legacyReason ? null : summary?.browserVersion ?? null,
    runnerOs: os,
    externalRunId: String(run.id),
    jobId: String(job?.id ?? ""),
    attempt: Number(attempt),
    workflow: String(run.name ?? ""),
    runs: legacyReason ? null : summary?.runs ?? null,
    result: pass ? "PASS" : "FAIL",
    provenanceComplete: !legacyReason,
    localOnly: false,
    current,
    supersedes: [],
    notes: `${notes.join("；")}。${attribution.evidence.length ? `证据：${attribution.evidence.slice(0, 2).join(" / ")}。` : ""}`,
  };
}
