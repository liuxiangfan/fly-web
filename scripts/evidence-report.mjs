/**
 * 证据报告的**按类型解析器**（SW-06）：把"索引怎么写的"与"报告里到底写了什么"对齐。
 *
 * 旧校验只核文件哈希——于是"报告正文其实是 FAIL、索引写 PASS"、
 * "报告的浏览器/平台/源码/产物摘要与索引不符"都能通过。这里为每种证据定义：
 *   · 归一化字段（pass / sourceCommit / sourceDigest / distHash / buildId / browserVersion / runnerOs / runs）；
 *   · 该类型**必须自己证明**的完整性要求（跑满时长、两个分片、每轮干净、截图齐全……）。
 *
 * 解析失败返回 `{ ok:false, error }`，调用方据此报明确失败；未登记类型返回 `recognized:false`
 * （例如复算基准由 doccheck 负责，不在这里重复判）。
 */
import { readFileSync } from "node:fs";
import { replaySwitchProblems } from "./teaching-load.mjs";

const SOAK_KINDS = new Set(["software-soak-batch", "software-soak-reconnect", "software-soak-teaching"]);
const RECOGNIZED = new Set([
  ...SOAK_KINDS,
  "software-smoke-stability",
  "visual-screenshot",
  "postdeploy-smoke",
  "performance-report",
  "size-report",
]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);

/** 长稳报告（soak.mjs）：必须跑满 600 s、批量/重连各自判据通过、堆判据通过、构建溯源无问题。 */
function parseSoak(raw) {
  const v = isObj(raw.verdict) ? raw.verdict : null;
  const pass = v && typeof v.pass === "boolean" ? v.pass : undefined;
  const completeness = [];
  if (!v) completeness.push("缺少 verdict 对象");
  if (typeof raw.seconds !== "number" || !(raw.seconds >= 600)) completeness.push(`时长 ${raw.seconds} s 不足 600 s`);
  if (raw.withBatch === true && v?.batchOk !== true) completeness.push("批量判据未通过");
  if (raw.withReconnect === true && v?.reconnectOk !== true) completeness.push("重连判据未通过");
  if (raw.withTeaching === true) {
    if (v?.teachingOk !== true) completeness.push("教学负载判据未通过");
    if (v?.coverageOk !== true) completeness.push("教学负载采样覆盖不足");
    if (v?.clockAdvanced !== true) completeness.push("教学负载时钟未推进");
    if (typeof v?.actionErrors === "number" && v.actionErrors > 0) completeness.push("教学负载存在动作失败");
    if (v?.stopQuiesced !== true) completeness.push("停采后回看/事件仍在新增");
    if (typeof v?.sourceSwitches !== "number" || v.sourceSwitches < 1) completeness.push("教学负载未覆盖换源");
    if (raw.loadSchema !== "teaching-load/v2") completeness.push("旧教学量具未证明真实 replay 换源，不能用于当前验收");
    const transitions = Array.isArray(raw.sourceTransitions) ? raw.sourceTransitions : [];
    if (!transitions.length) completeness.push("缺少真实换源三阶段记录");
    const transitionProblems = transitions.flatMap(replaySwitchProblems);
    if (transitionProblems.length) completeness.push(`真实换源失败：${transitionProblems.join("；")}`);
    const verifiedSwitches = transitions.filter((evidence) => replaySwitchProblems(evidence).length === 0).length;
    if (v?.sourceSwitches !== verifiedSwitches) completeness.push("换源汇总与三阶段记录不一致");
    if (!Number.isSafeInteger(v?.actionErrors) || v.actionErrors !== 0) completeness.push("教学动作没有全部成功");
    const samples = Array.isArray(raw.samples) ? raw.samples : [];
    if (samples.length < 2 || samples.at(-1).at - samples[0].at < raw.seconds * 1000 * 0.95) completeness.push("教学负载真实墙钟覆盖不足");
  }
  if (v && v.heapGateOk !== true) completeness.push("堆判据未通过");
  if (v && v.errorsOk === false) completeness.push("控制台有错误");
  // SW-08：堆的四个判据（水位/峰值/趋势/末段）与采样覆盖都要能自证
  if (v) {
    if (v.coverageOk !== true) {
      completeness.push(v.coverageOk === undefined
        ? "日志里没有采样覆盖判定（采集脚本版本过旧）"
        : `采样覆盖未通过：${(v.coverageProblems ?? []).join("；") || "（未记录原因）"}`);
    }
    const tail = String(v.tailStatus ?? "");
    if (!["PASS", "SUSPECT_RESOLVED"].includes(tail)) {
      completeness.push(v.tailStatus === undefined
        ? "日志里没有末段判据（采集脚本版本过旧）"
        : `末段判据是 ${tail}（应为 PASS 或 SUSPECT_RESOLVED）`);
    }
    // 末段可疑时必须真的做过"停载后的回落观察"，并且观察到回落——「追加观察」不能只是一句话
    if (v.tailSuspect === true && raw.tailPhase?.ran !== true) completeness.push("末段可疑但没有做停载后的回落观察");
    if (raw.tailPhase?.ran === true && raw.tailPhase.fellBack !== true) completeness.push("停载后仍未回落到水位附近（按泄漏处理）");
  }
  const provProblems = Array.isArray(raw.provenanceProblems) ? raw.provenanceProblems : [];
  if (provProblems.length) completeness.push(`采集时构建溯源就有问题：${provProblems.join("；")}`);
  const servedProblems = Array.isArray(raw.servedProblems) ? raw.servedProblems : [];
  if (servedProblems.length) completeness.push(`采集时被测产物身份核对就没过：${servedProblems.join("；")}`);
  const driftProblems = Array.isArray(raw.driftProblems) ? raw.driftProblems : [];
  if (driftProblems.length) completeness.push(`采集期间身份发生变化：${driftProblems.join("；")}`);
  return {
    recognized: true,
    ok: true,
    completeness,
    report: {
      pass,
      sourceCommit: str(raw.commit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: str(raw.browserVersion),
      runnerOs: null,
      runs: null,
    },
  };
}

/**
 * 稳定性摘要（ci-run-smoke.mjs）：必须是 `--shard=both`、轮次与结果条数一致、
 * **每一轮**都零失败零 warning，且汇总判定为 pass。
 *
 * 判定**不靠报告自觉**：这里从逐轮原始数字独立复算一遍 pass，再要求报告自己声明的
 * 汇总判定与复算结果一致（旧实现里"5 轮全挂但写了 PASS"能过，因为没人读正文）。
 */
function parseStability(raw) {
  const results = Array.isArray(raw.results) ? raw.results : null;
  const problems = [];
  const runs = typeof raw.runs === "number" ? raw.runs : null;
  if (!results || !results.length) problems.push("缺少 results 数组（没有逐轮结果就不算验收）");
  else {
    if (raw.shard !== "both") problems.push(`必须两个分片都跑（shard=${raw.shard}）`);
    if (runs === null) problems.push("缺少 runs");
    else if (results.length !== runs) problems.push(`结果条数 ${results.length} ≠ 轮次 ${runs}`);
    if (runs !== null && runs < 5) problems.push(`只跑了 ${runs} 轮（稳定性验收要求 ≥5 轮）`);
    for (const r of results) {
      if (!isObj(r) || r.code !== 0 || r.fails !== 0 || r.warns !== 0) problems.push(`第 ${r?.index} 轮不干净：${JSON.stringify(r)}`);
    }
  }
  // 独立复算：每轮干净 + 轮次齐 + 两个分片，才算这份摘要"证明"了稳定性
  const derived = problems.length === 0;
  const declared = raw.verdict === "pass" || (isObj(raw.verdict) && raw.verdict.pass === true)
    ? true
    : raw.verdict === undefined || raw.verdict === null ? undefined : false;
  if (declared === undefined) problems.push("报告没有汇总判定（verdict）——采集脚本必须自己下结论");
  else if (declared !== derived) {
    problems.push(`报告自己写的是 ${declared ? "PASS" : "FAIL"}，但逐轮原始数据复算是 ${derived ? "PASS" : "FAIL"}（判定不可自证）`);
  }
  return {
    recognized: true,
    ok: true,
    completeness: problems,
    report: {
      pass: derived && declared !== false,
      sourceCommit: str(raw.commit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: str(raw.browserVersion),
      runnerOs: str(raw.runnerOs),
      runs,
    },
  };
}

/** 视觉证据（visual-evidence.mjs）：pass 为真、至少一张图、每张都有视口与哈希、控制台零错误。 */
function parseVisual(raw) {
  const shots = Array.isArray(raw.shots) ? raw.shots : null;
  const completeness = [];
  if (!shots || !shots.length) completeness.push("没有任何截图");
  else {
    for (const s of shots) {
      if (!isObj(s) || !str(s.name) || !str(s.file) || !/^[0-9a-f]{64}$/.test(s.sha256 ?? "")) { completeness.push(`截图条目不完整：${JSON.stringify(s)?.slice(0, 60)}`); continue; }
      if (!isObj(s.viewport)) completeness.push(`截图 ${s.name} 缺视口信息`);
      if (s.metrics?.scrollW > s.metrics?.innerW) completeness.push(`截图 ${s.name} 有横向溢出`);
    }
  }
  const consoleErrors = Array.isArray(raw.consoleErrors) ? raw.consoleErrors : [];
  if (consoleErrors.length) completeness.push(`采集时有 ${consoleErrors.length} 条控制台错误`);
  for (const field of ["servedProblems", "driftProblems"]) {
    if (Array.isArray(raw[field]) && raw[field].length) completeness.push(`${field}：${raw[field].join("；")}`);
  }
  if (raw.captureId !== undefined) {
    if (!/^[0-9a-f-]{36}$/.test(raw.captureId)) completeness.push("captureId 不是采集唯一 id");
    if (raw.localOnly !== true) completeness.push("本地视觉采集必须声明 localOnly: true");
    if (!str(raw.sourceDigest) || !str(raw.buildId)) completeness.push("版本化截图目录缺少 sourceDigest/buildId");
    const prefix = `screenshots/visual-${raw.sourceDigest}/${raw.buildId}/${raw.captureId}/`;
    if (!shots?.every((s) => str(s?.file)?.startsWith(prefix))) completeness.push("截图不在 sourceDigest/buildId/captureId 独立目录");
  }
  return {
    recognized: true,
    ok: true,
    completeness,
    report: {
      pass: raw.pass === true && completeness.length === 0,
      sourceCommit: str(raw.sourceCommit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: str(raw.browserVersion),
      runnerOs: null,
      runs: null,
      localOnly: typeof raw.localOnly === "boolean" ? raw.localOnly : null,
      captureId: str(raw.captureId),
      startedAt: str(raw.startedAt),
      finishedAt: str(raw.finishedAt),
    },
    pixels: (shots ?? []).filter((s) => isObj(s) && str(s.file) && str(s.sha256)).map((s) => ({ name: s.name, file: s.file, sha256: s.sha256 })),
  };
}

/** 部署后 smoke（postdeploy-smoke.mjs）：HTTP 200、通过判定为真、核心检查全绿、控制台零错误。 */
function parsePostdeploy(raw) {
  const checks = isObj(raw.checks) ? raw.checks : null;
  const completeness = [];
  if (!checks) completeness.push("缺少 checks 对象");
  else for (const [k, v] of Object.entries(checks)) if (v !== true) completeness.push(`检查 ${k} 未通过`);
  if (raw.httpStatus !== 200) completeness.push(`HTTP ${raw.httpStatus}`);
  const consoleErrors = Array.isArray(raw.consoleErrors) ? raw.consoleErrors : [];
  if (consoleErrors.length) completeness.push(`采集时有 ${consoleErrors.length} 条控制台错误`);
  return {
    recognized: true,
    ok: true,
    completeness,
    report: {
      pass: raw.pass === true && completeness.length === 0,
      sourceCommit: str(raw.observed?.commit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: str(raw.browserVersion),
      runnerOs: str(raw.runnerOs),
      runs: null,
    },
  };
}

/**
 * 页面性能报告（scripts/perf-report.mjs）：真实墙钟指标必须过门槛，且必须自带口径说明。
 * 关键点：这里的 fps 来自 rAF 墙钟间隔，**不是**界面读数里被 50 ms 夹过的仿真 dt。
 */
function parsePerf(raw) {
  const completeness = [];
  if (raw.pass !== true) completeness.push("性能报告结论不是通过");
  const errors = Array.isArray(raw.consoleErrors) ? raw.consoleErrors : [];
  if (errors.length) completeness.push(`采集时有 ${errors.length} 条控制台错误`);
  const fps = raw.frames?.fpsWall;
  if (typeof fps !== "number" || !(fps > 1)) completeness.push(`墙钟帧率不可用：${String(fps)}`);
  const inputP95 = raw.inputLatency?.p95;
  if (typeof inputP95 !== "number" || !(inputP95 <= 200)) completeness.push(`输入延迟 p95 ${String(inputP95)} ms 超过 200 ms`);
  const cancelMs = raw.batch?.mainCancelLatencyMs;
  if (typeof cancelMs !== "number" || !(cancelMs > 0 && cancelMs <= 200)) completeness.push(`主线程降级取消延迟 ${String(cancelMs)} ms 不在 (0, 200] 内`);
  if (raw.batch?.workerMode !== "worker") completeness.push(`批量评测没有走 Worker 路径（mode=${String(raw.batch?.workerMode)}）`);
  if (!/口径|墙钟|headless/.test(String(raw.note ?? ""))) completeness.push("报告缺少口径说明（fps 用的是哪种口径、环境是什么）");
  return {
    recognized: true,
    ok: true,
    completeness,
    report: {
      pass: raw.pass === true && completeness.length === 0,
      sourceCommit: str(raw.commit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: str(raw.browserVersion),
      runnerOs: null,
      runs: null,
    },
  };
}

/** 体积归因报告（scripts/size-report.mjs）：chunk 级数字与按职责归因都必须非空。 */
function parseSize(raw) {
  const completeness = [];
  const chunks = Array.isArray(raw.chunks) ? raw.chunks : null;
  if (!chunks || !chunks.length) completeness.push("没有任何 chunk 记录");
  else {
    for (const c of chunks) {
      if (!isObj(c) || typeof c.raw !== "number" || typeof c.gzip !== "number" || !str(c.kind)) {
        completeness.push(`chunk 条目不完整：${JSON.stringify(c)?.slice(0, 60)}`);
      }
    }
    if (!chunks.some((c) => c.kind === "main")) completeness.push("缺少主包 chunk 记录");
    if (!chunks.some((c) => c.kind === "vendor-three")) completeness.push("缺少 three（vendor）chunk 记录");
  }
  const groups = raw.mainAttribution?.groups;
  if (!Array.isArray(groups) || !groups.length) completeness.push("缺少主包按职责归因（无法回答体积长在哪儿）");
  if (!str(raw.distHash)) completeness.push("缺少被测产物的 distHash（归因必须指向某一份产物）");
  if (Array.isArray(raw.driftProblems) && raw.driftProblems.length) completeness.push(`体积采集身份漂移：${raw.driftProblems.join("；")}`);
  if (raw.totals && chunks) {
    if (raw.totals.gzipSum !== chunks.reduce((sum, c) => sum + c.gzip, 0) || raw.totals.rawSum !== chunks.reduce((sum, c) => sum + c.raw, 0) || raw.totals.files !== chunks.length) {
      completeness.push("体积分项与 totals 对账失败");
    }
  }
  return {
    recognized: true,
    ok: true,
    completeness,
    report: {
      pass: completeness.length === 0,
      sourceCommit: str(raw.sourceCommit),
      sourceDigest: str(raw.sourceDigest),
      distHash: str(raw.distHash),
      buildId: str(raw.buildId),
      browserVersion: null,
      runnerOs: null,
      runs: null,
    },
  };
}

export function parseEvidenceReport(kind, absPath) {
  if (!RECOGNIZED.has(kind)) return { recognized: false };
  // 只有 .json **报告**有"正文结论"可核；`.png` 这类二进制产物本身没有可读结论，
  // 它由自身 sha256 与所属报告里的像素哈希清单共同担保（别把 PNG 当 JSON 读）。
  if (!/\.json$/i.test(absPath)) return { recognized: false };
  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    return { recognized: true, ok: false, error: `不是合法 JSON：${err.message}` };
  }
  if (!isObj(raw)) return { recognized: true, ok: false, error: "报告顶层不是对象" };
  if (SOAK_KINDS.has(kind)) return parseSoak(raw);
  if (kind === "software-smoke-stability") return parseStability(raw);
  if (kind === "visual-screenshot") return parseVisual(raw);
  if (kind === "postdeploy-smoke") return parsePostdeploy(raw);
  if (kind === "performance-report") return parsePerf(raw);
  if (kind === "size-report") return parseSize(raw);
  return { recognized: false };
}
