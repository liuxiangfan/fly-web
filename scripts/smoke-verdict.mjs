/**
 * 冒烟失败的**归因**（纯函数，可在 Node 里用真实日志做契约测试）。
 *
 * 为什么要单独一个模块（复核 P2「区分产品失败与 runner 容量失败」）：
 * Windows 的 `windows-latest` 只有 2 vCPU + 软件 WebGL，跑完整套件时会随机死在
 * 基础设施超时上（`Navigation timeout`、首帧 >60 s、`Target.createTarget timed out`……），
 * 而同一提交在本机 Windows 与 Ubuntu CI 上 5/5 全绿。如果摘要只说"红了"，看的人无法区分
 * 「产品坏了」和「这台 runner 跑不动」——CI 就会长期挂在"没人知道该不该修"的红灯上。
 *
 * 判据**故意保守**，只看日志事实，而且**不改结论**（退出码仍然是失败）：
 *  · `pass`     exit 0 且没有任何 `[FAIL]`；
 *  · `product`  出现**具体用例**的 `[FAIL] <用例名>`——产品缺陷，必须修（优先级高于容量判定）；
 *  · `capacity` 没有用例级 FAIL，但外层报了基础设施超时，且命中已知容量签名。
 *
 * 最后一条是关键防线：只要有一条用例级 FAIL，就永远判 `product`——不能让"这台机器慢"
 * 变成"红灯就说是容量问题"的万能借口。
 */
export const CAPACITY_SIGNATURES = [
  /Navigation timeout of/,
  /Waiting failed:/,
  /Target\.createTarget timed out/,
  /Session with given id not found/,
  /Execution context was destroyed/,
  /Protocol error/,
  /Screenshot timed out/,
  /Page crashed/,
  /preview 在 90 s 内没有就绪/,
  /浏览器进程被回收/,
];

/** 外层那两条「不是用例失败」的 FAIL 文案（基础设施判定用）。 */
const INFRA_FAIL_LINE = /^\[FAIL\] (冒烟测试异常|浏览器进程被回收)/;

export function classifyRun(code, out) {
  const linesOf = (text) => String(text).split(String.fromCharCode(10));
  if (code === 0 && !linesOf(out).some((l) => l.startsWith("[FAIL]"))) return "pass";
  const productFailures = linesOf(out).filter((l) => l.startsWith("[FAIL]") && !INFRA_FAIL_LINE.test(l));
  if (productFailures.length) return "product";
  return CAPACITY_SIGNATURES.some((re) => re.test(out)) ? "capacity" : "product";
}

/**
 * 统一判定（SW-07）：一轮是否算通过，以及**为什么不算**，只由这里定义。
 *
 * 旧实现只看退出码与 PASS 行数，于是三类"看起来绿"的失败都能溜过去：
 *   · 稳定性 job 里的冒烟步骤被 `if:` 跳过后 job 仍然 success；
 *   · 某一片少跑几项（清单缺项）却每项都 PASS；
 *   · 进程被异常打断，攒了一堆 PASS 后带着非零码结束——行数统计看不出"没跑完"。
 * 现在：断言失败、执行未完成、环境启动失败、根因未知四类分开，且**只有**四类都不成立才是 pass。
 * 归因不改变结论：`kind !== "pass"` 就是失败。
 *
 *  `kind`：
 *    assert     —— 出现具体用例的 FAIL（产品缺陷，优先于一切基础设施解释）；
 *    incomplete —— 执行没跑完/清单缺项/有用例跳过/重复用例/结果文件缺失或自称未完成；
 *    env        —— 没有用例级失败，但有页面/浏览器/预览启动类证据（含容量签名）；
 *    unknown    —— 上面的证据都不足，保留为"根因未知"（不轻判成容量）。
 *  `capacity` 单独一个布尔：只有命中已知容量签名（2 vCPU 软件 WebGL 那类）才为真。
 */
export function roundVerdict({ code, out = "", report = null, shard = "all", manifestProblems = [] }) {
  const reasons = [];
  const capacityEvidence = CAPACITY_SIGNATURES.filter((re) => re.test(out)).map(String);
  const logKind = classifyRun(code, out);
  /**
   * `assert` 的判据必须**只看用例级失败**：逐项结果里 status="fail" 的条目，
   * 或日志里 `[FAIL] <用例名> — …`（不含"冒烟测试异常/浏览器进程被回收"这两条外层文案）。
   * 否则"被异常打断、一条断言都没失败"的运行会被误判成产品缺陷——那是把容量问题说成产品问题。
   */
  const checkFailures = (Array.isArray(report?.results) ? report.results : []).filter((r) => r?.status === "fail");
  const lines = String(out).split(String.fromCharCode(10));
  const logFailures = lines.filter((l) => l.startsWith("[FAIL]") && !INFRA_FAIL_LINE.test(l));
  if (checkFailures.length) {
    reasons.push(`用例级断言失败 ${checkFailures.length} 项：${checkFailures.map((r) => r.id).slice(0, 2).join("；")}`);
  } else if (logFailures.length) {
    reasons.push(`用例级断言失败 ${logFailures.length} 项（仅日志可见，结构化结果缺失或不完整）：${logFailures[0].slice(0, 120)}`);
  }
  const assertionFailed = checkFailures.length > 0 || logFailures.length > 0;
  if (!report) {
    reasons.push("缺少结构化结果文件（无法核对「完整集合」，只有日志不足以判通过）");
  } else {
    if (report.completed !== true) reasons.push(`结构化结果自称未完成（completed=${report.completed}${report.abortReason ? `，原因 ${String(report.abortReason).slice(0, 120)}` : ""}）`);
    if (report.shard !== shard) reasons.push(`结构化结果的分片是 ${report.shard}，期望 ${shard}`);
    if (Array.isArray(report.skipped) && report.skipped.length) reasons.push(`有 ${report.skipped.length} 项被跳过：${report.skipped.map((s) => s.id).slice(0, 3).join("；")}`);
    if (Array.isArray(report.duplicateIds) && report.duplicateIds.length) reasons.push(`有重复用例名：${report.duplicateIds.slice(0, 3).join("；")}`);
    for (const p of manifestProblems) reasons.push(`完整集合比对：${p}`);
  }
  if (!reasons.length) return { kind: "pass", pass: true, reasons: [], capacity: false, capacityEvidence: [] };
  let kind;
  if (assertionFailed) kind = "assert";
  else if (logKind === "capacity" || capacityEvidence.length) kind = "env";
  else if (reasons.some((r) => r.includes("未完成") || r.includes("跳过") || r.includes("重复") || r.includes("完整集合") || r.includes("缺少结构化结果"))) kind = "incomplete";
  else kind = "unknown";
  return { kind, pass: false, reasons, capacity: capacityEvidence.length > 0, capacityEvidence };
}

/**
 * 一次"稳定性验收"（多轮）的整体判定：任何一轮不是 pass，整体就不是 pass。
 * `perShardIds` 用于核对两片合起来是否恰好覆盖清单（app ∩ devices = ∅ 且并集 = 清单）。
 */
export function setVerdict({ rounds, manifestProblems = [], coverage = [] }) {
  const reasons = [];
  for (const r of rounds) {
    if (!r || r.kind === "pass") continue;
    reasons.push(`第 ${r.index} 轮（${r.shard ?? "both"}）判为 ${r.kind}：${(r.reasons ?? []).slice(0, 2).join("；")}`);
  }
  for (const p of manifestProblems) reasons.push(`完整集合比对：${p}`);
  for (const p of coverage) reasons.push(`分片覆盖：${p}`);
  if (!reasons.length) return { kind: "pass", pass: true, reasons: [] };
  const kinds = new Set(rounds.map((r) => r?.kind).filter((k) => k && k !== "pass"));
  const kind = kinds.has("assert") ? "assert" : kinds.has("incomplete") ? "incomplete" : kinds.has("env") ? "env" : "unknown";
  return { kind, pass: false, reasons };
}
