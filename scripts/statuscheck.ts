/**
 * 动态计数校验：把文档里写死的「计数」与实际代码对上。
 *
 * 为什么需要：这类数字（实验库多少组、文档演示多少个、自检多少项、冒烟多少项）
 * 每加一个功能就会悄悄过期，而**读者无法分辨**「过期数字」与「真实数字」——
 * 第四轮复核就是这样发现 PROJECT-STATE 写着 17 个实验（实际 19 个）。
 * 与其要求人手同步，不如让脚本从源码里数出来，再和文档里的声明比对：
 * 声明与实测不一致 → 直接失败，并在输出里给出两边的数字。
 *
 * 检查范围（都从源码/脚本里数，不看人写的清单）：
 *   1. 实验库组数：src/ui/experiments.ts 的 EXPERIMENTS 条目数
 *   2. 文档交互演示画布数：index.html 里 `<canvas id="fig-…">` 的个数
 *   3. 数值自检项数：scripts/selftest.ts 顶层 `check(` 调用数
 *   4. 浏览器冒烟项数：scripts/browser-smoke.mjs 顶层 `check(` 调用数
 *   5. 文档分页数：index.html 里 `<article … data-doc-page>`（或 .doc-page）个数
 * 声明位置：docs/PROJECT-STATE.md 里的一行「计数声明」注释块（见下），
 * 格式固定为 `<!-- counts: experiments=19 demos=8 selftest=77 smoke=68 docpages=15 -->`。
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (p: string): string => readFileSync(p, "utf8");

/**
 * 数用例个数：行首（任意缩进）的 `check(` 调用。
 * 交叉核验过：这个计数与脚本实际打印的 `[PASS]` 行数相等（selftest / browser-smoke 都是），
 * 所以它就是「用例项数」的可靠代理，不必真跑一遍脚本。
 */
function countChecks(src: string): number {
  return src.split(/\r?\n/).filter((l) => /^\s+check\(/.test(l)).length;
}

const experiments = (read("src/ui/experiments.ts").match(/id:\s*"[a-zA-Z0-9_-]+"/g) ?? []).length;
const demos = (read("index.html").match(/<canvas id="fig-[a-z0-9-]+"/g) ?? []).length;
const selftest = countChecks(read("scripts/selftest.ts"));
const smoke = countChecks(read("scripts/browser-smoke.mjs"));
const docpages = (read("index.html").match(/<article[^>]*data-doc-page/g) ?? []).length;

const actual = { experiments, demos, selftest, smoke, docpages };

const projectStatePath = "docs/PROJECT-STATE.md";
if (!existsSync(projectStatePath)) {
  console.error("找不到 docs/PROJECT-STATE.md");
  process.exit(2);
}
const ps = read(projectStatePath);
const m = /<!--\s*counts:\s*([^>]+?)\s*-->/.exec(ps);
if (!m) {
  console.error("docs/PROJECT-STATE.md 里缺少计数声明注释，应形如：");
  console.error("<!-- counts: experiments=19 demos=8 selftest=77 smoke=68 docpages=15 -->");
  process.exit(1);
}
const declared: Record<string, number> = {};
for (const kv of m[1].split(/\s+/)) {
  const [k, v] = kv.split("=");
  if (k && v !== undefined) declared[k] = Number(v);
}

let failures = 0;
for (const [key, value] of Object.entries(actual)) {
  const want = declared[key];
  const ok = want === value;
  if (!ok) failures++;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${key} — 实测 ${value}${want === undefined ? "（文档未声明）" : `、声明 ${want}`}`,
  );
}

/**
 * 顺带校验 PROJECT-STATE 的「验证口径」一行。
 * **四项都要核**（复核结论：旧实现只比数值/几何两项，HTML 与文档基准改了也不报）。
 */
const line = /数值自检\s*(\d+)\s*\+\s*场景几何\s*(\d+)\s*\+\s*HTML 契约\s*(\d+)\s*\+\s*文档基准\s*(\d+)/.exec(ps);
const scene = countChecks(read("scripts/scenecheck.ts"));
/**
 * HTML 契约与文档基准的项数**也从源码数**，不再硬编码常量：
 * 硬编码等于「改脚本不报错」——复核 6.5 正是这么发现"部分项数硬编码"的。
 * 两个脚本的用例是**循环生成**的，静态计数数不准，所以这里直接跑一遍读它们自己打印的项数。
 * 这两个脚本只读文本、跑一次几百毫秒，重复执行的开销可以忽略。
 */
const printedItems = (script: string): number | null => {
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 项数 = 实际打印出来的 [PASS] 行数（与"真跑一遍"同源，比静态计数可靠）。
    // 若脚本还给出了汇总行（htmlcheck 会），两者必须一致——不一致说明脚本自己在少报/多报。
    const passes = out.split(/\r?\n/).filter((l) => l.startsWith("[PASS]")).length;
    const m = /校验通过 ✅（(\d+) 项）/.exec(out.replace(/\n/g, " "));
    if (m && Number(m[1]) !== passes) return null;
    return passes;
  } catch {
    return null;
  }
};
const htmlItems = printedItems("scripts/htmlcheck.ts");
const docItems = printedItems("scripts/doccheck.ts");
if (htmlItems === null || docItems === null) {
  failures++;
  console.log(`[FAIL] 无法从 htmlcheck/doccheck 读到项数（html=${htmlItems ?? "?"}、doc=${docItems ?? "?"}）`);
} else {
  console.log(`[PASS] 子检查项数取自脚本实际输出 — htmlcheck ${htmlItems} 项、doccheck ${docItems} 项`);
}
const declaredSum = selftest + scene + (htmlItems ?? 0) + (docItems ?? 0);
if (!line) {
  failures++;
  console.log("[FAIL] PROJECT-STATE 缺少「数值自检 N + 场景几何 N + HTML 契约 N + 文档基准 N」口径行");
} else {
  const ok =
    Number(line[1]) === selftest &&
    Number(line[2]) === scene &&
    Number(line[3]) === htmlItems &&
    Number(line[4]) === docItems;
  if (!ok) failures++;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] 验证口径行 — 声明 数值 ${line[1]}/几何 ${line[2]}/HTML ${line[3]}/文档 ${line[4]}，` +
      `实测 数值 ${selftest}/几何 ${scene}/HTML ${htmlItems}/文档 ${docItems}`,
  );
}

/**
 * 正文里的「合计项数」也必须等于四项之和（复核 6.5：只验首行时，把后文总数改成 999 也照样通过）。
 * 只扫**当前口径那一行**（含 `npm run check` 的行）：文件后半部分是按日期的历史记录，
 * 那里的旧数字是史料，不该用今天的口径去要求它。
 */
/**
 * **当前口径 vs 历史**（ROUND12）：用文档里的显式标记 `<!-- current:end -->` 划界，
 * 而不是靠"第一个日期行"猜——顶部状态块里本身就有日期，猜法会把当前段自己截断。
 * 标记缺失即失败（机器可读清单必须存在）。
 */
const HB = "<!-- history:begin";
const HE = "<!-- history:end -->";
const hb = ps.indexOf(HB);
const he = ps.indexOf(HE);
if (hb < 0 || he < 0 || he < hb) {
  failures++;
  console.log("[FAIL] docs/PROJECT-STATE.md 缺少 `<!-- history:begin -->`/`<!-- history:end -->` 标记：当前口径与历史里程碑必须有机器可读边界");
}
/** 当前口径文本 = 去掉历史区间的文档（历史里的旧数字是史料，不该被当前口径要求） */
const currentPs = hb >= 0 && he > hb ? ps.slice(0, hb) + ps.slice(he + HE.length) : ps;
const checkLines = currentPs.split(/\r?\n/).filter((l) => /^\s*-\s*`npm run check`/.test(l));
const sumLines = checkLines.flatMap((l) => [...l.matchAll(/共\s*\**\s*(\d+)\s*项\**/g)].map((m) => Number(m[1])));
const sumBad = sumLines.filter((n) => n !== declaredSum);
// 当前段的「**N 项 = M 数值 + ...」标题声明也必须等于四项之和（ROUND12：旧实现只扫清单行，
// 于是"改标题里的总数"不报错、"改历史里的旧数字"反而误报）
const headerBad = currentPs
  .split(/\r?\n/)
  .flatMap((l) => [...l.matchAll(/\*\*(\d+)\s*项\s*=/g)].map((m) => Number(m[1])))
  .filter((n) => n !== declaredSum);
if (sumLines.length === 0) {
  failures++;
  console.log("[FAIL] `npm run check` 那一行缺少「共 N 项」的合计声明");
} else if (sumBad.length) {
  failures++;
  console.log(
    `[FAIL] 检查合计声明不一致 — 实测四项之和 ${declaredSum}，但该行写着 ${sumBad.join("/")}`,
  );
} else if (headerBad.length) {
  failures++;
  console.log(`[FAIL] 当前段「**N 项 = ...」声明不一致 — 实测 ${declaredSum}，声明 ${headerBad.join("/")}`);
} else {
  console.log(`[PASS] 检查合计声明 — 「共 ${declaredSum} 项」，当前段标题声明一致`);
}

/**
 * 预算项数也必须与 distbudget 的实际 metrics 数一致（复核：README/文档写 7/8/9 项，实际 10 项）。
 */
const budgetSrc = read("scripts/distbudget.mjs");
// 单行与多行写法的条目都要数：直接数 `name: "…"` 出现次数（更稳，不受缩进/换行影响）
const metricsCount = (budgetSrc.match(/name:\s*"/g) ?? []).length;
// 当前口径那几行（提到 `npm run budget`）里写的项数必须等于实际项数
// （此前硬编码"七项上限"，实际 10 项——复核 6.5）
const budgetLines = ps.split(/\r?\n/).filter((l) => /^\s*-\s*`npm run budget`/.test(l));
const budgetClaims = budgetLines.flatMap((l) => [...l.matchAll(/(\d+)\s*项/g)].map((m) => Number(m[1])));
// 文档里写的项数必须等于 distbudget **实际**的预算条目数（从 metrics 数组的 name: 数出来）
const budgetBad = budgetClaims.filter((n) => n !== metricsCount);
if (budgetBad.length) {
  failures++;
  console.log(`[FAIL] 产物预算项数 — distbudget 实际 ${metricsCount} 项，文档却写 ${budgetBad.join("/")} 项`);
} else {
  console.log(`[PASS] 产物预算项数 — distbudget ${metricsCount} 项，文档 ${budgetClaims.length} 处声明一致`);
}

console.log(failures === 0 ? "\n动态计数校验通过 ✅" : `\n${failures} 项不一致 ❌`);
process.exit(failures === 0 ? 0 : 1);
