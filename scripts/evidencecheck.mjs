/**
 * 证据索引（docs/generated/evidence-manifest.json）的机器校验：**索引必须与报告正文一致**。
 *
 * 为什么要有"读报告"这一步（复核 SW-06）：旧实现只核文件哈希与索引自声明，于是
 * "报告正文其实是 FAIL、索引写 PASS"、"报告的浏览器/平台/源码/产物摘要与索引不符"
 * 都能通过检查，构建溯源也从未与产物交叉核对。索引不是独立证据——它是对报告的**声明**，
 * 声明必须可核。
 *
 * 分层：A 结构（schema/唯一 id/supersedes/每类每环境唯一 current）→ B 文件（路径与 sha256）
 * → C **正文**（按 kind 解析报告，核对结果、源码摘要、产物摘要、浏览器、平台、轮次、截图哈希）
 * → D 构建（`--require-build`：current 证据的 buildId 必须等于当前 dist 的溯源）
 * → E 源码（`--require-source`：current 长稳/稳定性/视觉证据的 sourceDigest 必须等于当前源码）。
 *
 * 任何一层都不允许"读不动就跳过"：畸形输入返回明确失败，而不是抛异常退出。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigest } from "./source-digest.mjs";
import { distHashOf, readProvenance } from "./build-provenance.mjs";
import { parseEvidenceReport } from "./evidence-report.mjs";

const argv = process.argv.slice(2);
const requireSource = argv.includes("--require-source");
const requireBuild = argv.includes("--require-build");
// `--root=` 只给契约测试用：把同一套校验跑在临时现场（夹具）上，避免为了测"坏索引会被拒"
// 而往真仓库里塞坏数据。默认永远是真仓库根。
const rootArg = argv.find((a) => a.startsWith("--root="));
const root = rootArg ? resolve(rootArg.slice("--root=".length)) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "docs/generated/evidence-manifest.json");
const projectStatePath = join(root, "docs/PROJECT-STATE.md");

/** 每类证据**真正应该有**的溯源字段（按 kind 列表，不搞一刀切）。 */
const PROVENANCE_BY_KIND = {
  "software-soak-batch": ["sourceCommit", "distHash", "browserVersion"],
  "software-soak-reconnect": ["sourceCommit", "distHash", "browserVersion"],
  "software-soak-teaching": ["sourceCommit", "distHash", "browserVersion"],
  "software-soak-legacy": [],
  "software-smoke-stability": ["sourceCommit", "distHash", "browserVersion", "runnerOs", "runs"],
  "postdeploy-smoke": ["sourceCommit", "externalRunId", "browserVersion"],
  "visual-screenshot": ["sourceCommit"],
  "github-actions-deploy": ["sourceCommit", "externalRunId", "runnerOs"],
  "github-actions-smoke-stability": ["sourceCommit", "externalRunId", "runnerOs"],
  "hardware-readiness": ["sourceCommit", "runnerOs"],
  "deterministic-benchmark": [],
  // 性能与体积报告（SW-09）：必须绑定源码与产物，否则"优化了多少"无从比较
  "performance-report": ["sourceCommit", "distHash", "buildId", "browserVersion"],
  "size-report": ["sourceCommit", "distHash", "buildId"],
};
const RESULTS = new Set(["PASS", "FAIL", "OBSERVED", "NOT_READY", "BLOCKED"]);
const CURRENT_NEEDS_PROVENANCE = /^(software-soak|software-smoke-stability|hardware-|performance-report)/;
// 性能报告也是"对某份源码的测量结论"：源码一变，旧的性能数字就不能再当当前证据
const SOURCE_BOUND = /^(software-soak|software-smoke-stability|visual-|performance-report|size-report)/;

const problems = [];
const fail = (msg) => problems.push(msg);
/** id → { abs, parsed }（B 段落填充） */
const reportCache = new Map();
/** 不影响结论、但要让人看见的说明（历史条目的完整性缺口等） */
const notes = [];

if (!existsSync(manifestPath)) {
  console.error("[FAIL] 找不到 docs/generated/evidence-manifest.json");
  process.exit(2);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`[FAIL] 证据索引不是合法 JSON：${err.message}`);
  process.exit(2);
}

const REQUIRED = ["id", "kind", "path", "sha256", "result", "provenanceComplete", "localOnly", "current", "supersedes", "notes"];
const entries = Array.isArray(manifest.entries) ? manifest.entries : null;
// 空 entries 也是失败：没有条目的索引等于"什么都没证明"，不能算通过
if (!entries || !entries.length) {
  console.error(`[FAIL] 证据索引缺少 entries 数组或数组为空（共 ${entries?.length ?? 0} 条）`);
  process.exit(1);
}

const ids = new Set();
for (const [i, e] of entries.entries()) {
  const at = `entries[${i}]`;
  for (const k of REQUIRED) if (!(k in e)) fail(`${at} 缺少字段 ${k}`);
  if (typeof e.id !== "string" || !e.id) fail(`${at}.id 必须是非空字符串`);
  else if (ids.has(e.id)) fail(`${at}.id 重复：${e.id}`);
  else ids.add(e.id);
  if (typeof e.path !== "string" || !e.path) fail(`${at}.path 必须是非空字符串`);
  if (!RESULTS.has(e.result)) fail(`${at}.result 必须是 ${[...RESULTS].join("/")}`);
  if (typeof e.provenanceComplete !== "boolean") fail(`${at}.provenanceComplete 必须是布尔`);
  if (typeof e.localOnly !== "boolean") fail(`${at}.localOnly 必须是布尔`);
  if (typeof e.current !== "boolean") fail(`${at}.current 必须是布尔`);
  if (!Array.isArray(e.supersedes)) fail(`${at}.supersedes 必须是数组`);
  if (typeof e.notes !== "string" || !e.notes.trim()) fail(`${at}.notes 必须写清能证明什么/不能证明什么`);
  if (e.kind === "visual-screenshot" && e.current === true && !/\.json$/i.test(e.path ?? "")) {
    fail(`${at}.path 当前视觉证据必须指向可解析的 JSON 报告，不能用 PNG/目录代替正文`);
  }
  if (e.kind === "visual-screenshot" && !/^[0-9a-f]{64}$/.test(e.sha256 ?? "") &&
      !(e.reportUnavailable === true && e.recoveryStatus === "unrecoverable" && e.current === false && e.result === "OBSERVED" && e.sha256 === null)) {
    fail(`${at}.sha256 必须保留原报告/PNG 的完整 SHA-256，空 sha 不能代替丢失证据`);
  }
  if (e.pixelsOverwritten !== undefined || e.pixelsOverwrittenBy !== undefined || e.pixelsOverwrittenAt !== undefined) {
    if (e.kind !== "visual-screenshot" || e.current !== false || e.localOnly !== true || e.pixelsOverwritten !== true) {
      fail(`${at}.pixelsOverwritten 只能用于显式标记的历史 localOnly 视觉条目`);
    }
    if (typeof e.pixelsOverwrittenBy !== "string" || !e.pixelsOverwrittenBy || e.pixelsOverwrittenBy === e.id) {
      fail(`${at}.pixelsOverwrittenBy 必须指向另一个视觉证据 id`);
    } else if (!entries.some((item) => item?.id === e.pixelsOverwrittenBy && item.kind === "visual-screenshot")) {
      fail(`${at}.pixelsOverwrittenBy 指向不存在的视觉证据：${e.pixelsOverwrittenBy}`);
    }
    if (typeof e.pixelsOverwrittenAt !== "string" || !Number.isFinite(Date.parse(e.pixelsOverwrittenAt))) {
      fail(`${at}.pixelsOverwrittenAt 必须保留覆盖采集时间`);
    }
  }
  if (!(e.kind in PROVENANCE_BY_KIND)) {
    fail(`${at}.kind 未登记：${e.kind}（新证据类型必须同时登记它该有的溯源字段）`);
  } else if (e.provenanceComplete === true) {
    for (const k of PROVENANCE_BY_KIND[e.kind]) {
      if (e[k] === undefined || e[k] === null || e[k] === "") fail(`${at} 声明 provenanceComplete，但 ${e.kind} 必须带 ${k}`);
    }
  }
}

// ② 文件与哈希
// localOnly 只是"这份证据不进版本库"，**不是**"不许核"：本机有文件就照样核哈希与正文，
// 没有才放过（否则删掉报告文件反而能让索引永远通过）。
for (const e of entries) {
  if (/^https?:\/\//.test(String(e.path))) {
    if (e.externalRunId === undefined || e.externalRunId === null || e.externalRunId === "") {
      fail(`${e.id} 是外部证据（URL），必须带 externalRunId`);
    }
    continue;
  }
  const abs = join(root, e.path);
  if (e.reportUnavailable === true) {
    // 原路径/原 hash 不换成目录或新报告身份；不可复核不等于历史 PASS。
    if (e.kind !== "visual-screenshot" || e.current !== false || e.localOnly !== true || e.result !== "OBSERVED" || e.provenanceComplete !== false || !/\.json$/i.test(e.path)) {
      fail(`${e.id} 丢失报告只能保留原 JSON 路径/hash，标历史 localOnly OBSERVED、provenanceComplete: false`);
    }
    const successor = entries.find((item) => item?.id === e.reportOverwrittenBy && item.kind === "visual-screenshot" && item.id !== e.id);
    const unknownCoverage = e.recoveryStatus === "unrecoverable" && e.reportOverwrittenBy === null && e.reportOverwrittenAt === null;
    if (!unknownCoverage && (!successor || !Number.isFinite(Date.parse(e.reportOverwrittenAt)) ||
        (e.recoveryStatus !== "unrecoverable" && (!Number.isFinite(Date.parse(e.startedAt)) || !Number.isFinite(Date.parse(e.finishedAt)))))) {
      fail(`${e.id} 丢失报告缺少覆盖者、覆盖时间或原采集时间`);
    }
    notes.push(`${e.id}：原报告 ${e.path}（sha256 ${e.sha256}）不可复核，仅保留历史观察，不能计作 PASS`);
    continue;
  }
  if (!existsSync(abs)) {
    if (e.localOnly !== true || (e.kind === "visual-screenshot" && /\.json$/i.test(e.path))) {
      fail(`${e.id} 的 path 不存在：${e.path}（报告丢失不能用 localOnly 绕过，应显式保留不可复核历史观察）`);
    }
    continue;
  }
  if (!statSync(abs).isFile()) {
    fail(`${e.id} 的 path 不是文件：${e.path}（目录不能代替原报告）`);
    continue;
  }
  try {
    if (e.localOnly !== true || (typeof e.sha256 === "string" && e.sha256)) {
      const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
      if (e.sha256 !== sha) fail(`${e.id} 的 sha256 与文件不一致（索引 ${String(e.sha256).slice(0, 12)}… / 实际 ${sha.slice(0, 12)}…）`);
    }
    reportCache.set(e.id, { abs, parsed: parseEvidenceReport(e.kind, abs) });
  } catch (err) { fail(`${e.id} 文件无法读取：${err.message}`); }
}
// 报告解析结果缓存：C 段落据此核对"索引说的"与"报告写的"
function reportOf(id) { return reportCache.get(id); }
const shaOf = (abs) => createHash("sha256").update(readFileSync(abs)).digest("hex");
const sameTime = (declared, actual) => typeof declared === "string" && typeof actual === "string" &&
  (declared.length === 10 ? declared === actual.slice(0, 10) : Date.parse(declared) === Date.parse(actual));
const verifiedVisual = (e) => {
  const cached = reportOf(e?.id);
  try {
    return e?.kind === "visual-screenshot" && cached?.parsed?.ok === true && shaOf(cached.abs) === e.sha256 ? cached.parsed : null;
  } catch { return null; }
};
// 覆盖必须有逐跳证据：原报告 hash、同一像素路径、覆盖者报告 hash、采集时间。
// 允许旧覆盖者又被覆盖，但整条链必须可核，不能凭一个布尔放过任意像素。
function overwrittenPixel(e, shot, seen = new Set()) {
  if (seen.has(e.id)) return false;
  seen.add(e.id);
  if (e.current !== false || e.localOnly !== true || e.pixelsOverwritten !== true) return false;
  const original = verifiedVisual(e);
  const successor = entries.find((item) => item?.id === e.pixelsOverwrittenBy);
  const next = verifiedVisual(successor);
  if (!original || !next || !sameTime(e.pixelsOverwrittenAt, next.report.startedAt) ||
      !(Date.parse(next.report.startedAt) >= Date.parse(original.report.finishedAt)) ||
      !(Date.parse(next.report.finishedAt) >= Date.parse(next.report.startedAt))) return false;
  const replacement = next.pixels?.find((item) => item.file === shot.file);
  if (!replacement) return false;
  const abs = join(root, shot.file);
  if (!existsSync(abs)) return true; // clone 不带本地像素；覆盖关联仍从两份原报告核验。
  if (!statSync(abs).isFile()) return false;
  return shaOf(abs) === replacement.sha256 || overwrittenPixel(successor, replacement, seen);
}
for (const e of entries) {
  if (e.reportUnavailable !== true) continue;
  if (e.recoveryStatus === "unrecoverable" && e.reportOverwrittenBy === null && e.reportOverwrittenAt === null) {
    notes.push(`${e.id}：覆盖者与覆盖采集时间未知，不能核覆盖关联；仅保留不可恢复历史 OBSERVED，不构成 PASS 证据`);
    const abs = join(root, e.path);
    if (existsSync(abs)) fail(`${e.id} 原路径仍有内容，不能以未知覆盖关联绕过报告 hash mismatch`);
    continue;
  }
  const successor = entries.find((item) => item?.id === e.reportOverwrittenBy);
  const next = verifiedVisual(successor);
  if (!next || (successor.path !== e.path && successor.originalReportPath !== e.path) ||
      !sameTime(e.reportOverwrittenAt, next.report.startedAt) ||
      !(Date.parse(next?.report?.finishedAt) >= Date.parse(next?.report?.startedAt)) ||
      ((e.startedAt !== null || e.finishedAt !== null || e.recoveryStatus !== "unrecoverable") &&
      (!(Date.parse(e.finishedAt) >= Date.parse(e.startedAt)) || !(Date.parse(next.report.startedAt) >= Date.parse(e.finishedAt))))) {
    fail(`${e.id} 丢失报告的覆盖关联不可核：须核原路径、覆盖者报告 hash 与双方采集时间`);
  }
  const abs = join(root, e.path);
  if (existsSync(abs) && (!statSync(abs).isFile() || !next || shaOf(abs) !== successor.sha256 || successor.path !== e.path)) {
    fail(`${e.id} 原报告路径现有内容不能由覆盖者报告 hash 解释，拒绝绕过 hash mismatch`);
  }
}
for (const e of entries) {
  if (e.pixelsOverwritten !== true || e.reportUnavailable === true) continue;
  const parsed = verifiedVisual(e);
  if (!parsed?.pixels?.length || !parsed.pixels.every((shot) => overwrittenPixel(e, shot))) {
    fail(`${e.id} 像素覆盖关联不可核：须核原路径、原报告/覆盖者报告 hash、覆盖者与采集时间`);
  }
}

// ③ 每类**每个运行环境**最多一条 current。
// 为什么带上 runnerOs：同一类证据会按平台各存一份（"Ubuntu 上 5× 全绿" 与
// "本机 Windows 上 5× 全绿" 是两条互不替代的声明，各自都得能标 current）。
// 没有 runnerOs 的证据类型仍按 kind 唯一。
const currentByKind = new Map();
for (const e of entries) {
  if (e.current !== true) continue;
  const key = e.runnerOs ? `${e.kind}@${e.runnerOs}` : e.kind;
  const list = currentByKind.get(key) ?? [];
  list.push(e);
  currentByKind.set(key, list);
}
for (const [key, list] of currentByKind) {
  if (list.length > 1) fail(`${key} 有 ${list.length} 条 current：${list.map((e) => e.id).join(" / ")}`);
}

// ⑤ supersedes：索引内 id，或 git:<path>@<sha>（并真的去核对那个提交里有没有这个文件）
const gitRef = /^git:(.+)@([0-9a-f]{7,40})$/;
for (const e of entries) {
  for (const ref of e.supersedes ?? []) {
    if (typeof ref !== "string" || !ref) {
      fail(`${e.id} 的 supersedes 只能是非空字符串`);
      continue;
    }
    if (ref === e.id) {
      fail(`${e.id} 的 supersedes 指向自己`);
      continue;
    }
    const git = gitRef.exec(ref);
    if (git) {
      // 先分清楚是"本地没有这个提交对象"还是"该提交里没有这个文件"：
      // 浅克隆（CI 的 checkout 默认 depth=1）会缺历史对象，那是环境问题，不该被当成"引用造假"，
      // 也不能悄悄跳过——给出一条能直接照做的修复指令。
      const hasCommit = (() => {
        try {
          execFileSync("git", ["cat-file", "-e", `${git[2]}^{commit}`], { cwd: root, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      if (!hasCommit) {
        fail(`${e.id} 的 supersedes ${ref} 无法核对：本地仓库里没有提交 ${git[2].slice(0, 12)}（多为浅克隆；把 checkout 的 fetch-depth 设为 0，或改用完整克隆后再跑）`);
        continue;
      }
      try {
        execFileSync("git", ["cat-file", "-e", `${git[2]}:${git[1]}`], { cwd: root, stdio: "ignore" });
      } catch {
        fail(`${e.id} 的 supersedes ${ref} 在该提交里找不到（历史引用必须真实存在）`);
      }
      continue;
    }
    if (!ids.has(ref)) fail(`${e.id} 的 supersedes 引用了不存在的 id：${ref}（历史文件请写 git:<path>@<sha>）`);
  }
}

// ⑥ current 的长稳/真机证据必须绑定审查基线
const baselineMatch = /<!--\s*baseline:\s*([0-9a-f]{7,40})\s*-->/.exec(readFileSync(projectStatePath, "utf8"));
if (!baselineMatch) {
  fail("docs/PROJECT-STATE.md 缺少 `<!-- baseline: <sha> -->` 标记——「当前」证据没有可比对的基线");
} else {
  const baseline = baselineMatch[1];
  const commits = new Set();
  for (const e of entries) {
    if (e.current !== true) continue;
    if (!CURRENT_NEEDS_PROVENANCE.test(String(e.kind))) continue;
    if (e.provenanceComplete !== true) fail(`${e.id} 作为 current 的长稳/真机证据必须 provenanceComplete: true`);
    // 基线判据的**真正目的**是"这份证据对应当前代码"，而精确回答它的是 `sourceDigest`（由 --require-source 强制）。
    // 提交号只作参考：只改文档/工作流的提交也会让 SHA 变，而产品源码摘要不变——拿 SHA 相等当门槛
    // 会把"证据仍然有效"误判成"必须重跑二十分钟长稳"。这里只检查格式并在总结里列出所有提交。
    if (e.sourceCommit !== undefined && e.sourceCommit !== null && !/^[0-9a-f]{7,40}$/i.test(String(e.sourceCommit))) {
      fail(`${e.id} 的 sourceCommit 不是合法 SHA：${String(e.sourceCommit).slice(0, 40)}`);
    }
    commits.add(`${String(e.sourceCommit ?? "null").slice(0, 12)}${e.sourceCommit === baseline ? "(基线)" : ""}`);
  }
  if (commits.size > 1) {
    console.log(`[info] current 证据的采集提交：${[...commits].join(" / ")}（产品源码摘要由 --require-source 统一约束）`);
  }
  // 最近一次 FAIL 允许存在（它就是最新观测），但必须显式提示：不许把它渲染成"当前验收通过"
  for (const e of entries) {
    if (e.current === true && e.result === "FAIL") notes.push(`${e.id} 是当前观测的失败——文档与结论里不得写成"当前验收通过"`);
  }
  let head = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* 无 git */ }
  console.log(`[info] 审查基线 ${baseline.slice(0, 12)} · HEAD ${head ? head.slice(0, 12) : "未知"} · ${head && head.startsWith(baseline) ? "一致" : "不一致"}`);
}

// ⑥ 正文交叉核对（C）：索引是**对报告的声明**，必须与报告逐项一致
for (const e of entries) {
  const cached = reportOf(e?.id);
  if (!cached) continue;
  const parsed = cached.parsed;
  if (!parsed.recognized) continue; // 复算基准等由 doccheck 负责
  if (!parsed.ok) { fail(`${e.id} 的报告无法解析：${parsed.error}`); continue; }
  const r = parsed.report;
  if (e.kind === "visual-screenshot") {
    if (r.localOnly !== null && r.localOnly !== undefined && e.localOnly !== r.localOnly) fail(`${e.id} 的 localOnly 与视觉报告不一致`);
    if ((parsed.pixels ?? []).some((shot) => /^screenshots\//.test(shot.file)) && e.localOnly !== true) {
      fail(`${e.id} PNG 在未分发的 screenshots/，必须 localOnly: true；本机有图不等于 clone 可复核`);
    }
  }
  if (r.pass !== undefined && (e.result === "PASS") !== r.pass) {
    fail(`${e.id} 报告正文结论是 ${r.pass ? "PASS" : "FAIL"}，索引却写 ${e.result}`);
  }
  for (const field of ["sourceCommit", "sourceDigest", "distHash", "buildId", "browserVersion", "runnerOs", "runs"]) {
    const inReport = r[field];
    if (inReport === undefined || inReport === null) continue;
    const inEntry = e[field];
    if (inEntry === undefined || inEntry === null || inEntry === "") {
      if (e.provenanceComplete === true) {
        fail(`${e.id} 报告里有 ${field}=${String(inReport).slice(0, 24)}，索引却没写（请补齐，或把 provenanceComplete 改为 false）`);
      }
      continue;
    }
    if (field === "sourceCommit") {
      const a = String(inEntry).slice(0, 12).toLowerCase();
      const b = String(inReport).slice(0, 12).toLowerCase();
      if (!(b.startsWith(a) || a.startsWith(b))) fail(`${e.id} 的 sourceCommit 与报告不一致（索引 ${a} / 报告 ${b}）`);
    } else if (String(inEntry) !== String(inReport)) {
      fail(`${e.id} 的 ${field} 与报告不一致（索引 ${String(inEntry).slice(0, 24)} / 报告 ${String(inReport).slice(0, 24)}）`);
    }
  }
  // 完整性要求是"这份报告能不能当验收证据用"：只有 current 条目必须满足；
  // 历史条目（含被取代的旧报告）保留哈希与结论一致性即可，否则历史档案会永远判红。
  for (const issue of parsed.completeness ?? []) {
    if (e.current === true) fail(`${e.id} 报告不满足该类型的完整性要求：${issue}`);
    else notes.push(`${e.id}（历史）：${issue}`);
  }
  for (const shot of parsed.pixels ?? []) {
    const abs = join(root, shot.file);
    if (!existsSync(abs)) {
      // 截图目录被 gitignore：**本机没有这张图时，只说得出"报告声明了什么"**。
      // 因此判据按证据自己的声明分档：
      //   · localOnly 或历史条目：图本来就不随仓库走（或早已清理）→ 记 note（不许静默通过，也不许在别人机器上判红）；
      //   · 当前 + 非 localOnly：它声称"这就是可分发的当前视觉证据"却缺图 → 明确失败
      //     （"只检查 JSON 就说视觉已验收"必须被拦住）。
      if (e.localOnly === true || e.current !== true) {
        notes.push(`${e.id}（${e.localOnly === true ? "localOnly" : "历史"}）：截图 ${shot.file} 不在本机，仅核了条目与哈希声明（像素哈希需在采集机复核）`);
      } else {
        fail(`${e.id} 报告里的截图 ${shot.name} 不存在：${shot.file}（声明为当前、可分发的视觉证据必须带图，或改标 localOnly: true）`);
      }
      continue;
    }
    if (!statSync(abs).isFile()) {
      fail(`${e.id} 的截图 ${shot.name} 不是文件：${shot.file}`);
      continue;
    }
    const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (sha !== shot.sha256) {
      if (overwrittenPixel(e, shot)) {
        notes.push(`${e.id}（历史）：截图 ${shot.name} 已由 ${e.pixelsOverwrittenBy} 于 ${e.pixelsOverwrittenAt} 覆盖；原报告/覆盖链已核，旧像素不可复核`);
      } else {
        fail(`${e.id} 的截图 ${shot.name} 像素哈希与报告不符（报告 ${String(shot.sha256).slice(0, 12)}… / 实际 ${sha.slice(0, 12)}…）`);
      }
    }
  }
}

// ⑦ 源码硬绑定（验收模式）
if (requireSource) {
  const now = sourceDigest(root);
  let bound = 0;
  for (const e of entries) {
    if (e.current !== true || !SOURCE_BOUND.test(String(e.kind))) continue;
    if (!e.sourceDigest) {
      fail(`${e.id} 声明 current 但缺少 sourceDigest——无法证明它对应这套源码（重跑长稳以生成）`);
      continue;
    }
    if (e.sourceDigest !== now.digest) {
      fail(`${e.id} 的 sourceDigest ${String(e.sourceDigest).slice(0, 12)}… ≠ 当前源码 ${now.digest.slice(0, 12)}…（源码已变，必须重跑）`);
      continue;
    }
    bound++;
  }
  console.log(`[info] --require-source：${bound} 条 current 源码绑定证据（长稳/稳定性/视觉）与当前源码摘要一致（${now.digest}，${now.files} 个文件）`);
}

// ⑧ 构建硬绑定（验收模式）：current 证据必须测的就是当前这份产物
if (requireBuild) {
  const distDir = join(root, "dist");
  const provenance = readProvenance(distDir);
  const distHash = distHashOf(distDir);
  if (!provenance) fail("缺少 dist/build-provenance.json——先 npm run build（当前产物无法证明来源）");
  else if (provenance.distHash !== distHash) {
    fail(`dist 已被重建：溯源 distHash ${provenance.distHash} ≠ 实测 ${distHash}（请重新构建后再采集证据）`);
  }
  let bound = 0;
  for (const e of entries) {
    if (e?.current !== true || !SOURCE_BOUND.test(String(e.kind))) continue;
    if (e.buildId === undefined || e.buildId === null) {
      fail(`${e.id} 声明 current 但缺少 buildId——无法证明它测的是当前这份产物（用带 buildId 的采集脚本重跑）`);
      continue;
    }
    if (provenance && e.buildId !== provenance.buildId) {
      fail(`${e.id} 的 buildId ${String(e.buildId).slice(0, 18)}… ≠ 当前产物 ${provenance.buildId}（产物已变，必须重跑）`);
      continue;
    }
    bound++;
  }
  if (provenance) console.log(`[info] --require-build：${bound} 条 current 证据与当前构建一致（buildId ${provenance.buildId}）`);
}

if (problems.length) {
  for (const p of problems) console.log(`[FAIL] ${p}`);
  console.log(`
证据索引校验失败：${problems.length} 项 ❌`);
  process.exit(1);
}
const currentCount = [...currentByKind.values()].reduce((n, l) => n + l.length, 0);
console.log(`[PASS] 证据索引结构完整、可读取文件的哈希逐字节匹配（共 ${entries.length} 条、current ${currentCount} 条；缺失/不可复核范围见 note）`);
console.log("[PASS] 可读取报告与索引交叉一致（结果/源码摘要/产物摘要/构建/浏览器/平台/轮次/截图声明；本机像素另核）");
for (const n of notes) console.log(`[note] ${n}`);
console.log(`
证据索引校验通过 ✅${requireSource ? "（含当前源码硬绑定）" : ""}${requireBuild ? "（含当前构建硬绑定）" : ""}`);
