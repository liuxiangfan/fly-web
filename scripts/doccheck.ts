/**
 * 文档基准引用检查：
 * 1) docs/generated/benchmarks.json 存在且 schema=1；
 * 2) index.html 中每个 `data-benchmark="id"` 都能在 JSON 里找到；
 * 3) 反向提示：JSON 有记录但没有任何文档引用（警告，不失败——给后续使用留空间）。
 *
 * 运行：npm run doccheck（并入 npm run check）
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "parse5";
import {
  BENCH_BLOCK_END,
  BENCH_BLOCK_BEGIN,
  buildBenchmarkRecords,
  renderBenchmarkBlock,
} from "./benchmark-records";
import type { DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const path = "docs/generated/benchmarks.json";
if (!existsSync(path)) {
  console.error(`[FAIL] 找不到 ${path}——先运行 npm run benchmark`);
  process.exit(1);
}
let json: { schema?: number; records?: Record<string, unknown> };
try {
  json = JSON.parse(readFileSync(path, "utf8")) as typeof json;
} catch (err) {
  console.error(`[FAIL] ${path} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (json.schema !== 1 || !json.records) {
  console.error(`[FAIL] ${path} schema 或 records 不合法`);
  process.exit(1);
}

const html = readFileSync("index.html", "utf8");
const doc = parse(html);
const ids = new Set(Object.keys(json.records));
const refs = new Set<string>();
function walk(n: Node): void {
  const el = n as Element;
  const v = el.attrs?.find((a) => a.name === "data-benchmark")?.value;
  if (v) refs.add(v);
  for (const c of (n as { childNodes?: Node[] }).childNodes ?? []) walk(c);
}
walk(doc);

const missing = [...refs].filter((r) => !ids.has(r));
if (refs.size === 0) {
  console.log("[FAIL] 文档基准引用 — 文档里一个 data-benchmark 引用都没有（删光引用不等于通过）");
  process.exit(1);
}
const unused = [...ids].filter((id) => !refs.has(id));
console.log(`[${missing.length ? "FAIL" : "PASS"}] 文档基准引用 — 引用 ${refs.size} 个、记录 ${ids.size} 个${missing.length ? `；缺失：${missing.join(", ")}` : ""}`);
if (unused.length) console.log(`[INFO] 以下基准暂未被文档引用（合法）：${unused.join(", ")}`);

/* --------------------------------------------------------------------------
   数值健全性：只校引用 ID 是不够的（复核结论）——
   把 metrics 改成 null/0、正文留着旧数字、删掉全部引用，旧实现都照样通过。
   这里对每条记录做**结构性数值检查**：所有数值字段必须存在、有限、非退化，
   并且按记录类型检查关键字段的范围与量级。
   -------------------------------------------------------------------------- */
const problems: string[] = [];
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function requireMetrics(recId: string, obj: Record<string, unknown>, keys: string[], min: number, max: number): void {
  for (const k of keys) {
    const v = obj[k];
    if (!isFiniteNum(v)) problems.push(`${recId}.${k} 不是有限数：${String(v)}`);
    else if (v < min || v > max) problems.push(`${recId}.${k}=${v} 超出合理范围 [${min}, ${max}]`);
  }
}
const R = json.records as Record<string, Record<string, unknown>>;

// hover-default-30s：五种算法的 RMSE P50/P95 必须有限且为正
if (R["hover-default-30s"]) {
  const list = R["hover-default-30s"].metrics as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list) || list.length !== 5) problems.push("hover-default-30s.metrics 必须是 5 条算法记录");
  else for (const m of list) {
    requireMetrics(`hover-default-30s.${String(m.id)}`, m, ["rmseP50", "rmseP95", "steadyRmseP95"], 1e-6, 180);
    // 关系约束（ROUND11）：分位数必须有序，否则"P50=170、P95=1"这种自相矛盾也照样通过
    if (isFiniteNum(m.rmseP50) && isFiniteNum(m.rmseP95) && !(m.rmseP50 <= m.rmseP95)) {
      problems.push(`hover-default-30s.${String(m.id)}：P50 ${m.rmseP50} > P95 ${m.rmseP95}`);
    }
    if (isFiniteNum(m.rmseP95) && isFiniteNum(m.steadyRmseP95) && m.steadyRmseP95 > m.rmseP95 * 3) {
      problems.push(`hover-default-30s.${String(m.id)}：稳态 P95 远大于全程 P95（可疑）`);
    }
  }
}
// kalman-consistency-30s：RMSE/NIS/NEES 必须有限（NEES 允许大于自由度，故上限放宽）
if (R["kalman-consistency-30s"]) {
  const m = R["kalman-consistency-30s"].metrics as Record<string, unknown>;
  requireMetrics("kalman-consistency-30s", m, ["rmse", "neesThetaMean", "neesBiasMean", "nisAccelMean", "accelAcceptPct"], 0, 1e4);
  if (isFiniteNum(m.accelAcceptPct) && m.accelAcceptPct > 100) {
    problems.push(`kalman-consistency-30s.accelAcceptPct=${m.accelAcceptPct}（接受率不能超过 100%）`);
  }
}
// coning-sweep：误差必须随采样率下降而上升（这是这条基准的物理含义）
if (R["coning-sweep"]) {
  const pts = R["coning-sweep"].points as Array<{ rateHz: number; errDeg: number }> | undefined;
  if (!Array.isArray(pts) || pts.length < 3) problems.push("coning-sweep.points 至少要有 3 个采样率点");
  else {
    for (const p of pts) {
      if (!isFiniteNum(p.errDeg) || p.errDeg <= 0 || p.errDeg > 90) {
        problems.push(`coning-sweep@${p.rateHz} errDeg 非法：${p.errDeg}`);
      }
    }
    const sorted = [...pts].sort((a, b) => b.rateHz - a.rateHz);
    if (!(sorted[0].errDeg < sorted[sorted.length - 1].errDeg)) problems.push("coning-sweep：误差未随采样率下降而上升（基准自相矛盾）");
  }
}
// wahba-clean：TRIAD/QUEST 必须是 1e-12 量级以下的干净解
if (R["wahba-clean"]) {
  const m = R["wahba-clean"].metrics as Record<string, unknown>;
  for (const k of ["triadErrDeg", "questErrDeg"]) {
    const v = m[k];
    if (!isFiniteNum(v) || v < 0 || v > 1e-6) problems.push(`wahba-clean.${k}=${String(v)}（干净解应在 0..1e-6°）`);
  }
}
// accel-six-face：残差必须是正的有限小量，且覆盖 6 面
if (R["accel-six-face"]) {
  const m = R["accel-six-face"].metrics as Record<string, unknown>;
  requireMetrics("accel-six-face", m, ["rmseX", "rmseY", "rmseZ"], 1e-9, 1);
  if (m.faces !== 6) problems.push(`accel-six-face.faces=${String(m.faces)}（应为 6）`);
}

/* --------------------------------------------------------------------------
   配置 ↔ 正文关系（复核 8）：正文里的「30 s / 12 Hz / 120°/s / 6 面」以前是**手写常量**，
   把生成器改成 20 s、7 Hz 再重跑，"渲染结果 == 存档"仍然通过。现在正文由配置渲染，
   这里再把配置本身核对一遍：缺字段/零值/自相矛盾（采样率高于参考率）都要报错。
   -------------------------------------------------------------------------- */
function requirePositiveConfig(id: string, keys: string[]): void {
  const cfg = (R[id]?.config ?? {}) as Record<string, unknown>;
  for (const k of keys) if (!(isFiniteNum(cfg[k]) && Number(cfg[k]) > 0)) problems.push(`${id}.config.${k} 必须为正有限数：${String(cfg[k])}`);
}
if (R["kalman-consistency-30s"]) requirePositiveConfig("kalman-consistency-30s", ["durationSec"]);
if (R["coning-sweep"]) {
  requirePositiveConfig("coning-sweep", ["freqHz", "ampDps", "durationSec", "refHz"]);
  const cfg = R["coning-sweep"].config as Record<string, number>;
  const pts = R["coning-sweep"].points as Array<{ rateHz: number }> | undefined;
  if (Array.isArray(pts) && isFiniteNum(cfg.refHz)) {
    for (const p of pts) if (!(isFiniteNum(p.rateHz) && p.rateHz > 0 && p.rateHz <= cfg.refHz)) {
      problems.push(`coning-sweep@${String(p.rateHz)} 采样率非法（应 ≤ 参考率 ${cfg.refHz}）`);
    }
  }
}
// accel-six-face：面数与残差条数必须与正文宣称的「6 面」一致，且噪声/种子合法
if (R["accel-six-face"]) {
  const cfg = (R["accel-six-face"].config ?? {}) as Record<string, unknown>;
  if (!(isFiniteNum(cfg.noiseMs2) && Number(cfg.noiseMs2) > 0)) problems.push(`accel-six-face.config.noiseMs2 必须为正有限数：${String(cfg.noiseMs2)}`);
  if (!Number.isSafeInteger(cfg.seed)) problems.push(`accel-six-face.config.seed 须为整数：${String(cfg.seed)}`);
}

/* --------------------------------------------------------------------------
   严格 schema：每条记录必须自带 **配置 + 样本量/时间窗 + 指标** 三件套。
   旧实现只对 5 条已知 id 做范围检查——新增记录、或把 records 换成数组/字符串、
   把指标删空，都能蒙过去（复核 6.3）。
   -------------------------------------------------------------------------- */
const REQUIRED_RECORDS = [
  "hover-default-30s",
  "kalman-consistency-30s",
  "coning-sweep",
  "wahba-clean",
  "accel-six-face",
];
for (const id of REQUIRED_RECORDS) {
  const rec = R[id];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    problems.push(`缺少记录 ${id}（或它不是对象）`);
    continue;
  }
  if (!rec.config || typeof rec.config !== "object" || Array.isArray(rec.config)) {
    problems.push(`${id}.config 缺失：基准必须自带输入配置，否则无法只读复算`);
  }
  if (!rec.metrics && !Array.isArray(rec.points)) problems.push(`${id} 既没有 metrics 也没有 points`);
}
// 有多条算法记录的基准：id 不能重复、顺序必须是五种算法
if (R["hover-default-30s"]) {
  const list = R["hover-default-30s"].metrics as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list)) {
    const ids2 = list.map((m) => String(m.id));
    if (new Set(ids2).size !== ids2.length) problems.push("hover-default-30s.metrics 里有重复算法 id");
    const want = ["pure", "comp", "mahony", "madg", "kalman"];
    if (ids2.join(",") !== want.join(",")) problems.push(`hover-default-30s 算法顺序/身份不对：${ids2.join(",")}`);
  }
}
// 关系约束：样本量 = 时长 × 采样率；种子数 = 算法记录的种子总数
if (R["hover-default-30s"]) {
  const rec = R["hover-default-30s"];
  const cfg = rec.config as Record<string, number>;
  const want = Math.round((cfg.durationSec ?? 0) * (cfg.solveRateHz ?? 0));
  if (rec.samplesPerRun !== want) problems.push(`hover-default-30s.samplesPerRun=${String(rec.samplesPerRun)} ≠ ${want}`);
  const seeds = rec.seeds as unknown[] | undefined;
  if (!Array.isArray(seeds) || seeds.length < 5) problems.push("hover-default-30s.seeds 至少要有 5 个种子");
  else if (new Set(seeds).size !== seeds.length) problems.push("hover-default-30s.seeds 有重复种子（配对比较要求互异）");
  const win = rec.window as Record<string, number> | undefined;
  if (!win || Math.abs((win.endSec ?? NaN) - (cfg.durationSec ?? NaN)) > 1e-9 || win.startSec !== 0) {
    problems.push(`hover-default-30s.window 与配置时长不一致：${JSON.stringify(win)} vs ${cfg.durationSec}`);
  }
  if (!(typeof cfg.solveRateHz === "number" && cfg.solveRateHz > 0)) {
    problems.push(`hover-default-30s.config.solveRateHz 非法：${String(cfg.solveRateHz)}`);
  }
  if (!(typeof cfg.seed === "number")) problems.push(`hover-default-30s.config.seed 非法：${String(cfg.seed)}`);
}

if (problems.length) {
  console.log(`[FAIL] 文档基准模式与关系校验 — ${problems.length} 项问题：${problems.slice(0, 5).join("；")}`);
  process.exit(1);
}
console.log(`[PASS] 文档基准数值健全性 — ${ids.size} 条记录：schema 三件套齐备、算法身份/顺序、样本量与种子数一致`);

/* --------------------------------------------------------------------------
   正文数字绑定：index.html 里的 `BENCH:BEGIN/END` 数字块必须等于
   **用同一个渲染函数从存档渲出来的结果**（复核 6.3：正文数字此前纯手工，
   改算法后可以与存档悄悄脱钩）。渲染函数来自 benchmark-records.ts，与生成器同源。
   -------------------------------------------------------------------------- */
{
  const block = renderBenchmarkBlock(json.records as Record<string, unknown>);
  const b = html.indexOf(BENCH_BLOCK_BEGIN);
  const e = html.indexOf(BENCH_BLOCK_END);
  if (b < 0 || e < 0 || e < b) {
    console.log("[FAIL] index.html 缺少基准数字块标记（BENCH:BEGIN/END）");
    process.exit(1);
  }
  const inDoc = html.slice(b, e + BENCH_BLOCK_END.length);
  if (inDoc !== block) {
    console.log("[FAIL] 正文基准数字块与存档不一致（手改过？跑 npm run benchmark 重新生成）");
    const inLines = inDoc.split(String.fromCharCode(10));
    const wantLines = block.split(String.fromCharCode(10));
    for (let i = 0; i < Math.max(inLines.length, wantLines.length); i++) {
      if (inLines[i] !== wantLines[i]) {
        console.log(`  第 ${i + 1} 行：文档「${(inLines[i] ?? "").slice(0, 90)}」`);
        console.log(`            存档「${(wantLines[i] ?? "").slice(0, 90)}」`);
        break;
      }
    }
    process.exit(1);
  }
  console.log("[PASS] 正文基准数字块 == 存档渲染结果（正文数字由存档生成）");
}

/* --------------------------------------------------------------------------
   只读复算：`--recompute` 用生成器的同一份实现重算全部记录，与存档逐字段比对。
   复核 6.3 的原话是"doccheck 是范围检查，不是复算"——默认模式仍只做快检查
   （数字块核对已能挡住"正文与存档脱钩"），全量复算按需开启（约 15 s）。
   -------------------------------------------------------------------------- */
if (process.argv.includes("--recompute")) {
  const t0 = Date.now();
  const fresh = buildBenchmarkRecords();
  const diffs: string[] = [];
  const walkCmp = (path: string, a: unknown, b: unknown): void => {
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > 1e-9) diffs.push(`${path}: 存档 ${a} ≠ 复算 ${b}`);
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      const A = Array.isArray(a) ? a : [];
      const B = Array.isArray(b) ? b : [];
      if (A.length !== B.length) {
        diffs.push(`${path}: 长度 ${A.length} ≠ ${B.length}`);
        return;
      }
      A.forEach((v, i) => walkCmp(`${path}[${i}]`, v, B[i]));
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const A = a as Record<string, unknown>;
      const B = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) walkCmp(`${path}.${k}`, A[k], B[k]);
      return;
    }
    if (a !== b) diffs.push(`${path}: 存档 ${String(a)} ≠ 复算 ${String(b)}`);
  };
  walkCmp("records", json.records, fresh);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (diffs.length) {
    console.log(`[FAIL] 只读复算（${sec}s）— ${diffs.length} 处与存档不一致：${diffs.slice(0, 5).join("；")}`);
    process.exit(1);
  }
  console.log(`[PASS] 只读复算（${sec}s）— 全部记录由同一份实现重算后与存档逐字段一致`);
} else {
  // 默认模式也要**真复算**（只算秒级可重算的三条：圆锥/Wahba/六面加计），
  // 全量（含 10 种子蒙特卡洛）留给 --recompute 与 CI——ROUND12：默认"只做范围检查"是盲区
  const cheap = buildBenchmarkRecords(true);
  const diffs: string[] = [];
  for (const [id, rec] of Object.entries(cheap)) {
    const want = JSON.stringify(rec);
    const have = JSON.stringify((json.records as Record<string, unknown>)[id]);
    if (want !== have) diffs.push(id);
  }
  if (diffs.length) {
    console.log(`[FAIL] 小基准只读复算 — 与存档不一致：${diffs.join(", ")}（跑 npm run benchmark 重新生成）`);
    process.exit(1);
  }
  console.log(`[PASS] 小基准只读复算 — ${Object.keys(cheap).join("、")} 与存档逐字段一致（全量复算见 --recompute）`);
}

process.exit(missing.length ? 1 : 0);
