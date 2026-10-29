/**
 * HTML ↔ TS 契约自检（Node 端，parse5 解析）：
 *
 * 1. id 唯一；JS 里 $("id") / getElementById("id") 引用的元素必须存在
 * 2. 每个滑块三件套完整（range + data-num + data-step，步距框有标题）
 * 3. 每个 canvas 有 role/aria-label；每个 range 有可读标签（aria-label 由 JS 注入，
 *    这里检查它至少处在带 label 的 .slider-row 里）
 * 4. 文档内部锚点 href="#id" 都能落到真实元素
 * 5. 折叠按钮 data-fold 指向存在的面板
 *
 * 运行：npm run htmlcheck（已并入 npm run check）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { EXPERIMENTS } from "../src/ui/experiments";
import { scenarios } from "../src/core/scenarios";
import { QUAT_POSE_PAIRS } from "../src/scene/quatview";
import { ACCEL_GATE_DEG, ACCEL_GATE_MAG_PCT } from "../src/estimators";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail: string): void {
  const tag = cond ? "PASS" : "FAIL";
  if (cond) passes++;
  else failures++;
  console.log(`[${tag}] ${name} — ${detail}`);
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs?.find((a) => a.name === name)?.value;
}
function* walk(node: Node): Generator<Node> {
  yield node;
  const children = (node as { childNodes?: Node[] }).childNodes ?? [];
  for (const c of children) yield* walk(c);
}
function elements(root: Node): Element[] {
  const out: Element[] = [];
  for (const n of walk(root)) if ((n as Element).tagName) out.push(n as Element);
  return out;
}
function textOf(node: Node): string {
  let s = "";
  for (const n of walk(node)) {
    if ((n as unknown as { nodeName: string }).nodeName === "#text") {
      s += (n as unknown as { value: string }).value;
    }
  }
  return s.trim();
}
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const html = readFileSync("index.html", "utf8");
const doc = parse(html);
const els = elements(doc);
const ids = new Map<string, Element[]>();
for (const el of els) {
  const id = attr(el, "id");
  if (!id) continue;
  const list = ids.get(id) ?? [];
  list.push(el);
  ids.set(id, list);
}

// ---------- 1. id 唯一 ----------
const dupes = [...ids.entries()].filter(([, list]) => list.length > 1).map(([id]) => id);
check("id 唯一", dupes.length === 0, dupes.length === 0 ? `${ids.size} 个 id 无重复` : `重复：${dupes.join(", ")}`);

// ---------- 2. JS 引用存在 ----------
const ts = tsFiles("src").map((f) => readFileSync(f, "utf8")).join("\n");
const refs = new Set<string>();
for (const m of ts.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) refs.add(m[1]);
for (const m of ts.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) refs.add(m[1]);
const missing = [...refs].filter((id) => !ids.has(id));
check(
  "JS 引用的元素都存在",
  missing.length === 0,
  missing.length === 0 ? `${refs.size} 个 $()/getElementById 引用全部命中` : `缺失：${missing.join(", ")}`,
);

// ---------- 3. 滑块三件套 ----------
const ranges = els.filter((el) => el.tagName === "input" && attr(el, "type") === "range");
const rangeIds = ranges.map((el) => attr(el, "id")).filter((v): v is string => Boolean(v));
const numTargets = els
  .filter((el) => el.tagName === "input" && attr(el, "class")?.includes("num-input"))
  .map((el) => attr(el, "data-num"))
  .filter((v): v is string => Boolean(v));
const stepTargets = els
  .filter((el) => el.tagName === "input" && attr(el, "class")?.includes("step-input"))
  .map((el) => attr(el, "data-step"))
  .filter((v): v is string => Boolean(v));
const rangesWithoutNum = rangeIds.filter((id) => !numTargets.includes(id));
const rangesWithoutStep = rangeIds.filter((id) => !stepTargets.includes(id));
const orphanNums = numTargets.filter((id) => !rangeIds.includes(id));
check(
  "滑块三件套完整",
  rangesWithoutNum.length === 0 && rangesWithoutStep.length === 0 && orphanNums.length === 0,
  `${rangeIds.length} 个 range：缺数值框 ${rangesWithoutNum.join(",") || "无"}；` +
    `缺步距框 ${rangesWithoutStep.join(",") || "无"}；孤儿 data-num ${orphanNums.join(",") || "无"}`,
);

// 每个 range 必须处在带 <label> 的 .slider-row（JS 会据此注入 aria-label）
const rangesWithoutLabel = ranges.filter((el) => {
  if (attr(el, "aria-label")) return false;
  let p: Node | undefined = el;
  while (p && (p as Element).tagName !== "div") p = (p as { parentNode?: Node }).parentNode;
  if (!p || !attr(p as Element, "class")?.includes("slider-row")) return true;
  return !elements(p).some((e) => e.tagName === "label");
});
check(
  "滑块均有可读标签",
  rangesWithoutLabel.length === 0,
  rangesWithoutLabel.length === 0
    ? "全部 slider-row 内含 <label>（运行时还会写入 aria-label）"
    : `${rangesWithoutLabel.length} 个滑块缺少标签容器`,
);

// ---------- 3b. 手册条目只能在文档页里 ----------
// `.ctl` 是「控制项手册」的专用排版（.k1/.k2/.k3 三段式 + .ctl-name/.ctl-range）。
// 它若被误插进右侧面板，页面上会出现一段风格不对但语法合法的正文——现有检查全都抓不到。
// 这条契约专治那类「插错位置」的编辑事故（本轮真踩过：一条手册条目插进了面板的 sub-group 前）。
const ctlDivs = els.filter((el) => el.tagName === "div" && (attr(el, "class") ?? "").split(/\s+/).includes("ctl"));
const ctlOutsideDocs = ctlDivs.filter((el) => {
  let p = (el as { parentNode?: Node }).parentNode;
  while (p) {
    const cls = attr(p as Element, "class") ?? "";
    if (cls.split(/\s+/).includes("doc-page")) return false; // 在某个文档分页里 ✓
    p = (p as { parentNode?: Node }).parentNode;
  }
  return true;
});
check(
  "手册条目（.ctl）只在文档页内",
  ctlOutsideDocs.length === 0,
  ctlOutsideDocs.length === 0
    ? `全部 ${ctlDivs.length} 条手册条目都在 .doc-page 里`
    : `有 ${ctlOutsideDocs.length} 条跑到了文档页外（前几条：${ctlOutsideDocs
        .slice(0, 3)
        .map((e) => (e as { sourceCodeLocation?: { startLine?: number } }).sourceCodeLocation?.startLine ?? "?")
        .join(", ")} 行）`,
);

// ---------- 3c. 文档容器的直接子元素只能是文档分页 ----------
// 往文档里插内容时最容易犯的错：插到了某个 </article> 之后（成了游离的兄弟元素）。
// HTML 解析器会宽容地接受它，页面看起来「有那段文字」，但它不属于任何分页——
// 切页时不显示、本页目录也不收录。这里把「.doc-pages 的直接孩子必须是 .doc-page」定成契约。
const docPagesEl = els.find(
  (el) => el.tagName === "div" && (attr(el, "class") ?? "").split(/\s+/).includes("doc-pages"),
);
/** 只看直接子元素（elements() 是递归的，用它会把所有后代都算进来） */
const childEls = (node: Element | undefined): Element[] =>
  !node ? [] : (node.childNodes as Node[]).filter((n): n is Element => Boolean((n as Element).tagName));
const docPageKids = childEls(docPagesEl);
const strayChildren = docPageKids.filter(
  (el) => !(attr(el, "class") ?? "").split(/\s+/).includes("doc-page"),
);
check(
  "文档容器只包含文档分页（无游离元素）",
  Boolean(docPagesEl) && strayChildren.length === 0,
  docPagesEl
    ? strayChildren.length === 0
      ? `.doc-pages 下 ${docPageKids.length} 个直接子元素全是 .doc-page`
      : `发现 ${strayChildren.length} 个游离元素：${strayChildren
          .slice(0, 3)
          .map((e) => `${e.tagName}${attr(e, "id") ? "#" + attr(e, "id") : ""}`)
          .join(", ")}`
    : "找不到 .doc-pages 容器",
);

// ---------- 4. canvas 可访问性 ----------
const canvases = els.filter((el) => el.tagName === "canvas");
const badCanvas = canvases.filter((el) => !attr(el, "aria-label"));
check(
  "canvas 均有 aria-label",
  badCanvas.length === 0,
  badCanvas.length === 0
    ? `${canvases.length} 个 canvas 全部有描述`
    : `缺描述：${badCanvas.map((c) => attr(c, "id") ?? "?").join(", ")}`,
);

// ---------- 5. 文档内锚点 ----------
const anchors = els
  .filter((el) => el.tagName === "a")
  .map((el) => attr(el, "href"))
  .filter((v): v is string => Boolean(v) && v!.startsWith("#") && v!.length > 1);
const brokenAnchors = anchors.filter((h) => !ids.has(h.slice(1)));
check(
  "文档锚点可达",
  brokenAnchors.length === 0,
  brokenAnchors.length === 0 ? `${anchors.length} 个页内锚点全部命中` : `断链：${brokenAnchors.join(", ")}`,
);

// ---------- 6. 折叠面板 ----------
const folds = els.map((el) => attr(el, "data-fold")).filter((v): v is string => Boolean(v));
const badFolds = folds.filter((id) => !ids.has(`block-${id}`));
check(
  "折叠按钮指向存在的面板",
  badFolds.length === 0,
  badFolds.length === 0 ? `${folds.length} 个折叠按钮全部命中 block-*` : `悬空：${badFolds.join(", ")}`,
);

// ---------- 7. 基本 SEO/结构 ----------
const htmlEl = els.find((el) => el.tagName === "html");
const title = els.find((el) => el.tagName === "title");
const desc = els.find((el) => el.tagName === "meta" && attr(el, "name") === "description");
const h1 = els.filter((el) => el.tagName === "h1");
check(
  "文档基础结构",
  attr(htmlEl!, "lang") === "zh-CN" && Boolean(textOf(title!)) && Boolean(attr(desc!, "content")) && h1.length >= 1,
  `lang=${attr(htmlEl!, "lang")}；title=${textOf(title!)}；description=${(attr(desc!, "content") ?? "").slice(0, 24)}…；h1 ${h1.length} 个`,
);

// ---------- 8. 静态资源存在（manifest / PWA 图标 / 自托管字体） ----------
{
  const hrefOf = (rel: string): string | undefined => {
    const el = els.find((e) => e.tagName === "link" && attr(e, "rel") === rel);
    return el ? attr(el, "href") : undefined;
  };
  const assets = [
    hrefOf("manifest"),
    hrefOf("icon"),
    hrefOf("apple-touch-icon"),
    "/icon-192.png",
    "/icon-512.png",
  ].filter((v): v is string => Boolean(v));
  const missing = assets.filter((h) => !existsSync("public" + h));
  const fontRefs = [...readFileSync("src/fonts.css", "utf8").matchAll(/url\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith("/fonts/"));
  const missingFonts = fontRefs.filter((u) => !existsSync("public" + u));
  check(
    "静态资源（manifest/图标/字体）齐全",
    missing.length === 0 && missingFonts.length === 0 && fontRefs.length > 0,
    `manifest/图标缺 ${missing.join(",") || "无"}；字体 ${fontRefs.length} 个，缺 ${missingFonts.join(",") || "无"}`,
  );
}

// ---------- 8. PWA 清单 JSON 与 SW 语法 ----------
{
  let manifestOk = false;
  let swOk = false;
  let iconCount = 0;
  try {
    const m = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as { icons?: unknown[] };
    iconCount = m.icons?.length ?? 0;
    manifestOk = iconCount >= 3 && m.icons!.every((i) => existsSync("public/" + (i as { src: string }).src));
  } catch {
    manifestOk = false;
  }
  try {
    execFileSync(process.execPath, ["--check", "public/sw.js"], { stdio: "ignore" });
    swOk = true;
  } catch {
    swOk = false;
  }
  check("PWA 清单与 Service Worker 合法", manifestOk && swOk, `manifest 图标 ${iconCount} 个；sw 语法=${swOk}`);
}

// ---------- 7c. 常量一致性：HTML 选项必须与代码里的权威列表一致 ----------
// 这一组防的是「同一个列表存在三份、改一处忘两处」——文档说「10 个分区」而实际 13 个就是这么来的。
// 能用真实模块的绝不抄字面量：下面 scenarios / 估计器 / 姿态对都是从源码导入的。
{
  const optionValues = (id: string): string[] => {
    const sel = els.find((el) => el.tagName === "select" && attr(el, "id") === id);
    if (!sel) return [];
    return elements(sel)
      .filter((e) => e.tagName === "option")
      .map((o) => attr(o, "value") ?? "")
      .filter((v) => v !== "");
  };
  const sameSet = (a: string[], b: string[]): boolean =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

  const scenarioIds = Object.keys(scenarios);
  const estIds = ["pure", "comp", "mahony", "madg", "kalman"];
  const pairIds = QUAT_POSE_PAIRS.map((p) => p.id);

  const problems: string[] = [];
  if (!sameSet(optionValues("scenario-select"), scenarioIds)) {
    problems.push("scenario-select ≠ scenarios（" + optionValues("scenario-select").join("/") + "）");
  }
  // source-select = 真值 + 五个算法
  if (!sameSet(optionValues("source-select"), ["truth", ...estIds])) {
    problems.push("source-select ≠ truth+五个算法（" + optionValues("source-select").join("/") + "）");
  }
  // 姿态对下拉是**运行期**由 QUAT_POSE_PAIRS 填充的（单一事实来源在 TS 里），
  // 所以 HTML 里必须留空——留一份静态拷贝反而会与代码漂开。运行期选项数在冒烟里校验。
  const pairOpts = optionValues("quat-pair-select");
  if (pairOpts.length !== 0) {
    problems.push("quat-pair-select 不该在 HTML 里写选项（应由 QUAT_POSE_PAIRS 运行期填充，实际有 " + pairOpts.length + " 个）");
  }
  if (pairIds.length < 4) problems.push("QUAT_POSE_PAIRS 少于 4 组？" + pairIds.join("/"));
  // 下面几个的权威定义在 main.ts（不可导入），在检查里写成字面量并注明改哪里：
  //   改了 main.ts 的 MagMode 联合类型 / solve-rate 处理 / 波特率下拉，必须同步这里与文档
  if (!sameSet(optionValues("mag-mode"), ["yaw", "full"])) problems.push("mag-mode ≠ yaw|full");
  const solveRates = optionValues("solve-rate");
  if (!sameSet(solveRates, ["500", "250", "125", "100", "50"])) {
    problems.push("solve-rate ≠ 500/250/125/100/50（" + solveRates.join("/") + "）");
  }
  const bauds = optionValues("serial-baud");
  for (const need of ["9600", "115200", "921600", "2000000"]) {
    if (!bauds.includes(need)) problems.push("波特率下拉缺 " + need);
  }
  // 固件与文档都把 921600 当默认（firmware/README.md）：下拉里必须有，且默认项就是它
  const baudSel = els.find((el) => el.tagName === "select" && attr(el, "id") === "serial-baud");
  const defOpt = baudSel
    ? elements(baudSel).find((o) => o.tagName === "option" && attr(o, "selected") !== undefined)
    : undefined;
  if (defOpt && (attr(defOpt, "value") ?? "") !== "921600") {
    problems.push("波特率默认值不是 921600（实际 " + (attr(defOpt, "value") ?? "") + "）");
  }
  // 门控阈值滑杆的默认值必须与估计器的常量一致（改了 ACCEL_GATE_* 就要改 HTML / 文档三处）
  const gateDeg = els.find((el) => attr(el, "id") === "gate-deg");
  const gateMag = els.find((el) => attr(el, "id") === "gate-mag");
  const gateDegDefault = gateDeg ? Number(attr(gateDeg, "value")) : NaN;
  const gateMagDefault = gateMag ? Number(attr(gateMag, "value")) : NaN;
  if (gateDegDefault !== ACCEL_GATE_DEG) {
    problems.push("gate-deg 默认 " + gateDegDefault + " ≠ ACCEL_GATE_DEG " + ACCEL_GATE_DEG);
  }
  if (Math.abs(gateMagDefault - ACCEL_GATE_MAG_PCT * 100) > 1e-9) {
    problems.push("gate-mag 默认 " + gateMagDefault + " ≠ ACCEL_GATE_MAG_PCT×100 " + ACCEL_GATE_MAG_PCT * 100);
  }
  check(
    "常量一致性：HTML 选项与代码权威列表一致",
    problems.length === 0,
    problems.length ? problems.slice(0, 4).join("；") : "机动剧本 / 数据来源 / 姿态对 / 磁形态 / 解算频率 / 波特率·默认值 / 门控阈值全部一致",
  );
}

// ---------- 8. 实验库引用的控件都存在 ----------
{
  const selectValues = new Map<string, Set<string>>();
  for (const el of els.filter((e) => e.tagName === "select")) {
    const id = attr(el, "id");
    if (!id) continue;
    selectValues.set(
      id,
      new Set(
        elements(el)
          .filter((o) => o.tagName === "option")
          .map((o) => attr(o, "value") ?? ""),
      ),
    );
  }
  const bad: string[] = [];
  for (const exp of EXPERIMENTS) {
    for (const id of Object.keys(exp.sliders ?? {})) if (!ids.has(id)) bad.push(`${exp.id}:slider:${id}`);
    for (const id of Object.keys(exp.checks ?? {})) if (!ids.has(id)) bad.push(`${exp.id}:check:${id}`);
    for (const [id, v] of Object.entries(exp.selects ?? {})) {
      if (!ids.has(id)) bad.push(`${exp.id}:select:${id}`);
      // quat-pair-select 的 option 由 JS 按 QUAT_POSE_PAIRS 动态填充，静态 HTML 看不到
      else if (id !== "quat-pair-select" && !selectValues.get(id)?.has(v)) bad.push(`${exp.id}:option:${id}=${v}`);
    }
  }
  check(
    "实验库引用的控件都存在",
    bad.length === 0,
    bad.length === 0 ? `${EXPERIMENTS.length} 个实验的滑块/开关/选项全部命中` : `悬空：${bad.join(", ")}`,
  );
}

// ---------- 8. 图例/图表钩子 ----------
const legends = ids.get("att-legend")?.length && ids.get("err-legend")?.length && ids.get("imu-legend")?.length;
check("三张图表的图例容器齐全", Boolean(legends), `att/err/imu legend = ${Boolean(legends)}`);

console.log(failures === 0 ? `\nHTML 契约校验通过 ✅（${passes} 项）` : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
