/**
 * SW-07 的永久反例：**登记判定**与**完整集合比对**必须抓得住"看起来绿"的假证据。
 *
 * 这些用例都是从真实事故里长出来的：
 *   · 普通 `gate` job 成功 → 旧实现能登记成稳定性 PASS；
 *   · 名为稳定性的 job 里冒烟步骤被 `if:` 跳过 → job 仍然 success；
 *   · 某一片少跑几项 / 重复用例名 / 结果文件缺失 → 只数 PASS 行数看不出来；
 *   · 摘要绑的是另一个提交的产物 → 给旧产物贴了新的提交号。
 * 夹具用的是 job/summary/逐轮结果的真实结构（字段名与 GitHub API、ci-run-smoke 一致）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attributionOf, entryFor, pickStabilityJobs, roundResultProblems, smokeStepProblems, summaryProblems } from "./ci-registration.mjs";
import { coverageProblems, manifestDriftProblems, manifestShapeProblems, parseDeclaredChecks, runProblems } from "./smoke-manifest.mjs";

const SHA = "a".repeat(40);
const manifest = {
  schemaVersion: 1,
  shards: { app: ["A1", "A2", "A3"], devices: ["D1", "D2"] },
  total: 5,
};

const job = (over = {}) => ({
  id: 111, name: "smoke-stability (ubuntu-latest)", conclusion: "success", run_attempt: 1, labels: ["ubuntu-latest"],
  html_url: "https://github.com/o/r/actions/runs/1/job/111",
  steps: [
    { number: 1, name: "Build", conclusion: "success" },
    { number: 2, name: "Smoke × 5 (ubuntu-latest)", conclusion: "success" },
  ],
  ...over,
});

/** 一份"看起来合格"的稳定性摘要（与 ci-run-smoke 写的结构一致）。 */
const summary = (over = {}) => ({
  shard: "both", runs: 5, commit: SHA, sourceDigest: "d".repeat(32), distHash: "h".repeat(16), buildId: "d".repeat(12) + "-" + "h".repeat(16),
  verdict: { pass: true, kind: "pass", capacity: false, reasons: [] },
  results: [1, 2, 3, 4, 5].map((index) => ({ index, code: 0, passes: 99, fails: 0, warns: 0, kind: "pass" })),
  ...over,
});

/** 逐轮结构化结果：五轮 × 两片，覆盖清单里的全部用例。 */
const rounds = (mutate = () => {}) => {
  const out = {};
  for (let i = 1; i <= 5; i++) {
    for (const [shard, ids] of Object.entries(manifest.shards)) {
      out[`${shard}-run${i}`] = {
        shard, completed: true, failed: 0, skipped: [], duplicateIds: [],
        results: ids.map((id) => ({ id, shard, status: "pass", detail: "ok" })),
      };
    }
  }
  mutate(out);
  return out;
};

test("非稳定性 job 不能登记：gate 成功、或冒烟步骤被跳过都必须是明确失败", () => {
  // ① 普通 gate job 成功：名字不匹配 → 一个都挑不出来
  const gate = pickStabilityJobs({ jobs: [{ name: "gate", conclusion: "success", steps: [] }, { name: "smoke-shards (app)", conclusion: "success", steps: [] }], jobRe: /^smoke-stability/ });
  assert.equal(gate.picked.length, 0);

  // ② 名字对得上但整条腿被 matrix `if:` 跳过：conclusion=skipped → 不是证据
  const skipped = pickStabilityJobs({ jobs: [job({ conclusion: "skipped" })], jobRe: /^smoke-stability/ });
  assert.equal(skipped.picked.length, 0, "skipped 的 job 不能当证据");

  // ③ 名字对得上、job 也 success，但**冒烟步骤**被跳过（旧实现就在这里把失败登记成 PASS）
  const hollow = job({ steps: [{ number: 1, name: "Build", conclusion: "success" }, { number: 2, name: "Smoke × 5 (ubuntu-latest)", conclusion: "skipped" }] });
  const problems = smokeStepProblems(hollow);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /被跳过/);

  // ④ 真正的成功步骤必须放行
  assert.deepEqual(smokeStepProblems(job()), []);
  // ⑤ 找不到冒烟步骤 / 步骤缺序号也不能算通过
  assert.equal(smokeStepProblems(job({ steps: [{ number: 1, name: "Build", conclusion: "success" }] })).length, 1);
  assert.equal(smokeStepProblems(job({ steps: [{ name: "Smoke × 5", conclusion: "success" }] })).length, 1);
});

test("摘要必须自证：轮次、零 warning、判定、提交绑定逐项都要对", () => {
  assert.deepEqual(summaryProblems(summary(), { expectedRuns: 5, headSha: SHA }), []);
  // 只跑 3 轮却自称 PASS
  assert.ok(summaryProblems(summary({ runs: 3, results: summary().results.slice(0, 3) }), { expectedRuns: 5, headSha: SHA }).some((p) => p.includes("runs=3")));
  // 某一轮有 warning（旧实现只数 "零 warning" 文案，不看数据）
  const warned = summary();
  warned.results[3].warns = 1;
  assert.ok(summaryProblems(warned, { expectedRuns: 5, headSha: SHA }).some((p) => p.includes("warns=1")));
  // 判定是失败却想登记
  assert.ok(summaryProblems(summary({ verdict: { pass: false, kind: "assert", reasons: ["x"] } }), { expectedRuns: 5 }).some((p) => p.includes("不是通过")));
  // 摘要没有绑定产物
  assert.ok(summaryProblems(summary({ buildId: null }), { expectedRuns: 5 }).some((p) => p.includes("buildId")));
  // 摘要绑的是**另一个提交**的产物：给旧产物贴新提交号必须被抓住
  assert.ok(summaryProblems(summary({ commit: "b".repeat(40) }), { expectedRuns: 5, headSha: SHA }).some((p) => p.includes("head_sha")));
  // 分片不是 both（稳定性验收要求两片）
  assert.ok(summaryProblems(summary({ shard: "app" }), { expectedRuns: 5, shard: "both" }).some((p) => p.includes("分片")));
});

test("逐轮结构化结果：缺项、跳过、重复、未完成都不能算完整集合", () => {
  assert.deepEqual(roundResultProblems(rounds(), manifest, { expectedRuns: 5 }), []);
  assert.ok(roundResultProblems(rounds((r) => { delete r["app-run3"]; }), manifest, { expectedRuns: 5 }).some((p) => p.includes("第 3 轮") && p.includes("没有结构化结果")));
  assert.ok(roundResultProblems(rounds((r) => { r["devices-run2"].completed = false; }), manifest, { expectedRuns: 5 }).some((p) => p.includes("未完成")));
  assert.ok(roundResultProblems(rounds((r) => { r["app-run1"].skipped = [{ id: "A1", reason: "x" }]; }), manifest, { expectedRuns: 5 }).some((p) => p.includes("跳过")));
  assert.ok(roundResultProblems(rounds((r) => { r["app-run4"].results = r["app-run4"].results.slice(0, 2); }), manifest, { expectedRuns: 5 }).some((p) => p.includes("少跑")));
  assert.ok(roundResultProblems(rounds((r) => { r["devices-run5"].results.push({ id: "幽灵用例", status: "pass" }); }), manifest, { expectedRuns: 5 }).some((p) => p.includes("多出")));
});

test("归因保守：只有拿到容量证据才写容量，否则根因未知；断言失败优先于一切解释", () => {
  // job 绿、摘要绿 → 通过
  assert.equal(attributionOf({ job: job(), summary: summary() }).kind, "pass");
  // 断言失败（即使日志里也带超时噪声）
  assert.equal(attributionOf({ job: job({ conclusion: "failure" }), summary: summary({ verdict: { pass: false, kind: "assert", capacity: true, reasons: ["用例级断言失败 2 项"] } }) }).kind, "assert");
  // 执行未完成
  assert.equal(attributionOf({ job: job({ conclusion: "failure" }), summary: summary({ verdict: { pass: false, kind: "incomplete", reasons: ["缺少结构化结果"] } }) }).kind, "incomplete");
  // 环境失败且**有**容量证据
  const env = attributionOf({ job: job({ conclusion: "failure" }), summary: summary({ verdict: { pass: false, kind: "env", capacity: true, reasons: ["Navigation timeout of 60000 ms exceeded"] } }) });
  assert.equal(env.kind, "env");
  assert.equal(env.capacity, true);
  assert.ok(env.evidence.length > 0, "写'容量'必须带上证据");
  // 环境失败但**没有**证据 → 根因未知（不许因为"CI 机器慢"就轻判）
  const unknown = attributionOf({ job: job({ conclusion: "failure" }), summary: summary({ verdict: { pass: false, kind: "env", capacity: false, reasons: [] } }) });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.capacity, false);
  // 连摘要都没有 → 根因未知
  assert.equal(attributionOf({ job: job({ conclusion: "failure" }), summary: null }).kind, "unknown");
});

test("登记条目：current 与内容校验绑定；legacy 登记必须显式降级 provenanceComplete", () => {
  const ok = entryFor({ run: { id: 41530523646, name: "CI", head_sha: SHA, html_url: "u" }, job: job(), summary: summary(), attempt: 1, current: true, baseline: SHA.slice(0, 12) });
  assert.equal(ok.result, "PASS");
  assert.equal(ok.runs, 5);
  assert.equal(ok.current, true);
  assert.equal(ok.provenanceComplete, true);
  assert.equal(ok.runnerOs, "ubuntu-latest");
  assert.ok(ok.notes.includes("标记 current"));

  const failedRun = entryFor({ run: { id: 1, name: "CI", head_sha: SHA }, job: job({ conclusion: "failure" }), summary: summary({ verdict: { pass: false, kind: "env", capacity: true, reasons: ["preview 在 90 s 内没有就绪"] } }), attempt: 2, current: false, baseline: "b".repeat(12) });
  assert.equal(failedRun.result, "FAIL");
  assert.ok(failedRun.notes.includes("未标 current"));
  assert.ok(failedRun.notes.includes("容量"));

  const legacy = entryFor({ run: { id: 41530523646, name: "CI", head_sha: SHA }, job: job({ conclusion: "success" }), summary: null, attempt: 1, legacyReason: "早于结构化产物", current: false, baseline: null });
  assert.equal(legacy.provenanceComplete, false, "拿不到产物的旧 run 不许声称溯源完整");
  assert.equal(legacy.result, "FAIL", "内容校验不过就只能是失败观测");
  assert.equal(legacy.buildId, null);
});

test("清单比对：缺项、多出、跳过、重复都要点名；两片合起来必须恰好覆盖清单", () => {
  const ids = [...manifest.shards.app];
  assert.deepEqual(runProblems(manifest, { shard: "app", ids }), []);
  assert.ok(runProblems(manifest, { shard: "app", ids: ids.slice(0, 2) }).some((p) => p.includes("少跑了")));
  assert.ok(runProblems(manifest, { shard: "app", ids: [...ids, "编外"] }).some((p) => p.includes("清单外")));
  assert.ok(runProblems(manifest, { shard: "app", ids, skipped: [{ id: "A1", reason: "x" }] }).some((p) => p.includes("跳过")));
  assert.ok(runProblems(manifest, { shard: "app", ids, duplicateIds: ["A2"] }).some((p) => p.includes("重复")));
  assert.deepEqual(coverageProblems(manifest, { app: manifest.shards.app, devices: manifest.shards.devices }), []);
  assert.ok(coverageProblems(manifest, { app: manifest.shards.app, devices: ["A1", "D2"] }).some((p) => p.includes("同时出现在两个分片")));
  assert.ok(coverageProblems(manifest, { app: manifest.shards.app, devices: ["D2"] }).some((p) => p.includes("仍缺")));
  assert.ok(coverageProblems(manifest, { app: manifest.shards.app, devices: [...manifest.shards.devices, "编外"] }).some((p) => p.includes("多出")));
});

test("清单自身：缺分片、两片重复、total 不符都要报错", () => {
  assert.deepEqual(manifestShapeProblems(manifest), []);
  assert.ok(manifestShapeProblems({ shards: { app: ["A"] }, total: 1 }).some((p) => p.includes("devices")));
  assert.ok(manifestShapeProblems({ shards: { app: ["A"], devices: ["A"] }, total: 2 }).some((p) => p.includes("重复")));
  assert.ok(manifestShapeProblems({ shards: { app: ["A"], devices: ["B"] }, total: 5 }).some((p) => p.includes("total")));
  assert.ok(manifestShapeProblems({ shards: { app: [], devices: ["B"] }, total: 1 }).some((p) => p.includes("没有用例")));
});

test("提交在库的清单必须与 browser-smoke.mjs 的声明一致（删用例不改清单会当场报警）", () => {
  const manifestOnDisk = JSON.parse(readFileSync(new URL("./smoke-manifest.json", import.meta.url), "utf8"));
  const declared = parseDeclaredChecks(readFileSync(new URL("./browser-smoke.mjs", import.meta.url), "utf8"));
  assert.deepEqual(manifestShapeProblems(manifestOnDisk), []);
  assert.deepEqual(manifestDriftProblems(manifestOnDisk, declared), []);
  assert.equal(manifestOnDisk.total, declared.length, "清单必须覆盖全部 check 声明");
  assert.ok(manifestOnDisk.total >= 90, `用例数只有 ${manifestOnDisk.total}，疑似被大面积删掉`);
  // 分片归属也要对上（清单说 A 片，源码就必须在 A 片段落里）
  for (const d of declared) assert.ok(manifestOnDisk.shards[d.shard]?.includes(d.name), `${d.name} 的分片归属与清单不一致（源码在 ${d.shard}）`);
});
