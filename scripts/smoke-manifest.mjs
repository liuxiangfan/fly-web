/**
 * 冒烟用例清单（SW-07）：**完整集合**才是验收单位，不是"PASS 行数"。
 *
 * 为什么要它：驱动器只数 `[PASS]` 行、或只看退出码时，"某一片少跑 3 项"与"全跑绿了"
 * 长得一模一样（旧实现连 skipped 步骤都能登记成稳定性 PASS）。这里把用例清单做成一份
 * 可核对的**单一事实来源**：
 *   · `scripts/smoke-manifest.json` 是清单本身（用例名 + 分片归属）；
 *   · `parseDeclaredChecks()` 直接从 `browser-smoke.mjs` 源码解析清单——
 *     契约测试比较两者，于是"删掉一个用例而不改清单"会当场报警；
 *   · `runProblems()` 拿清单核对一次真实运行：缺项、重复、多出、跑错分片都要点名。
 */
import { readFileSync } from "node:fs";

const EOL = /\r?\n/;

/** 解析 `browser-smoke.mjs` 的 `check("名字", …)` 声明及其分片段落（名字可另起一行）。 */
export function parseDeclaredChecks(source) {
  const declared = [];
  const lines = source.split(EOL);
  const lineOf = (idx) => source.slice(0, idx).split(EOL).length;
  // 分片段落：`if (runApp) {` / `if (runDevices) {` 按行号开段，声明按最近一段归属。
  const marks = [];
  lines.forEach((text, i) => {
    if (/^\s*if \(runApp\) \{/.test(text)) marks.push({ line: i + 1, shard: "app" });
    else if (/^\s*if \(runDevices\) \{/.test(text)) marks.push({ line: i + 1, shard: "devices" });
  });
  const shardAt = (line) => {
    let current = null;
    for (const m of marks) if (m.line <= line) current = m.shard;
    return current;
  };
  const re = /(?<![\w.])check\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(source))) {
    const line = lineOf(m.index);
    declared.push({ name: m[1], line, shard: shardAt(line) });
  }
  return declared;
}

export function loadManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 清单结构问题（清单自己是否自洽）。 */
export function manifestShapeProblems(manifest) {
  const problems = [];
  const shards = manifest?.shards;
  if (!shards || typeof shards !== "object") return ["清单缺少 shards"];
  const all = [];
  for (const [shard, list] of Object.entries(shards)) {
    if (!Array.isArray(list) || !list.length) { problems.push(`分片 ${shard} 没有用例`); continue; }
    for (const id of list) if (typeof id !== "string" || !id) problems.push(`分片 ${shard} 里有非法用例名：${JSON.stringify(id)}`);
    all.push(...list);
  }
  if (!("app" in shards) || !("devices" in shards)) problems.push("清单必须同时声明 app 与 devices 两个分片");
  const seen = new Set();
  for (const id of all) {
    if (seen.has(id)) problems.push(`用例名在两个分片里重复：${id}`);
    seen.add(id);
  }
  if (typeof manifest.total !== "number" || manifest.total !== all.length) {
    problems.push(`清单 total=${manifest.total} 与用例总数 ${all.length} 不一致`);
  }
  return problems;
}

/** 清单与源码声明是否一致（逐项：名字集合 + 分片归属）。 */
export function manifestDriftProblems(manifest, declared) {
  const problems = [];
  for (const shard of ["app", "devices"]) {
    const inSource = declared.filter((d) => d.shard === shard).map((d) => d.name);
    const inManifest = manifest?.shards?.[shard] ?? [];
    const missing = inSource.filter((n) => !inManifest.includes(n));
    const extra = inManifest.filter((n) => !inSource.includes(n));
    if (missing.length) problems.push(`${shard}：源码里有 ${missing.length} 项不在清单里（${missing.slice(0, 3).join("；")}）——请重跑 make-smoke-manifest`);
    if (extra.length) problems.push(`${shard}：清单里有 ${extra.length} 项源码已不存在（${extra.slice(0, 3).join("；")}）`);
  }
  const unassigned = declared.filter((d) => !d.shard).map((d) => d.name);
  if (unassigned.length) problems.push(`有 ${unassigned.length} 项不在任何分片段落里（分片标记可能被改动）：${unassigned.slice(0, 3).join("；")}`);
  return problems;
}

/**
 * 用清单核对一次真实运行：返回问题清单（空 = 这次运行真的是"完整集合且全绿"）。
 * `ids` 是本次运行实际执行并逐项报出的用例名；`shard` 是本次分片（all/app/devices）。
 */
export function runProblems(manifest, { shard, ids, skipped = [], duplicateIds = [] }) {
  const problems = [];
  const expected = shard === "all" ? [...manifest.shards.app, ...manifest.shards.devices] : manifest.shards[shard] ?? [];
  const got = new Set(ids);
  const missing = expected.filter((id) => !got.has(id));
  const extra = ids.filter((id) => !expected.includes(id));
  if (missing.length) problems.push(`少跑了 ${missing.length} 项：${missing.slice(0, 5).join("；")}${missing.length > 5 ? " …" : ""}`);
  if (extra.length) problems.push(`跑了清单外的 ${extra.length} 项：${extra.slice(0, 5).join("；")}${extra.length > 5 ? " …" : ""}`);
  if (skipped.length) problems.push(`有 ${skipped.length} 项被跳过：${skipped.slice(0, 5).join("；")}`);
  if (duplicateIds.length) problems.push(`有 ${duplicateIds.length} 个用例名重复执行：${duplicateIds.slice(0, 5).join("；")}`);
  return problems;
}

/** 两片合起来必须恰好覆盖清单（app ∩ devices = ∅）。 */
export function coverageProblems(manifest, perShardIds) {
  const problems = [];
  const app = new Set(perShardIds.app ?? []);
  const devices = new Set(perShardIds.devices ?? []);
  for (const id of app) if (devices.has(id)) problems.push(`用例同时出现在两个分片：${id}`);
  const union = new Set([...app, ...devices]);
  const expected = new Set([...manifest.shards.app, ...manifest.shards.devices]);
  const missing = [...expected].filter((id) => !union.has(id));
  const extra = [...union].filter((id) => !expected.has(id));
  if (missing.length) problems.push(`两片合起来仍缺 ${missing.length} 项：${missing.slice(0, 5).join("；")}`);
  if (extra.length) problems.push(`两片合起来多出 ${extra.length} 项：${extra.slice(0, 5).join("；")}`);
  return problems;
}
