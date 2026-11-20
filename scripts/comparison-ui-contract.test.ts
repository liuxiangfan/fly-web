/**
 * F-01 单变量对照台的静态契约（Node 端，不启动浏览器）。
 *
 * 覆盖：
 *  1. index.html 的面板语义、容器 id、表头与按钮可见文案；
 *  2. 对照区没有新增 range/select/checkbox（避免深链注册表被动扩张）；
 *  3. 面板模块不静态 import core/runner（runner 只能由降级路径动态加载）；
 *  4. view 模块的纯输出与静态表头/空差异文案一致，且外部文本被转义。
 *
 * 运行：npx tsx scripts/comparison-ui-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import {
  comparisonDiffHtml,
  comparisonTableHeadHtml,
} from "../src/ui/comparison-view";
import { comparisonStatusText } from "../src/core/comparison-report";
import { defaultExperimentConfig } from "../src/core/experiment-config";

// 面板的 Worker URL 是 Vite 虚拟模块；Node 契约测试用空 URL 桩替代，
// 只为加载面板模块（本测试强制走主线程降级路径，不创建 Worker）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "virtual:worker-url/comparison") {
      return { url: "data:text/javascript,export default 'stub';", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { mountComparisonPanel } = await import("../src/ui/comparison-panel");


let pass = 0;
let fail = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function testAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/ui/comparison-panel.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

const panelStart = html.indexOf('id="sec-compare"');
const experimentsStart = html.indexOf('id="sec-experiments"');
const imuStart = html.indexOf('id="sec-imu"');
assert.ok(panelStart >= 0, "index.html 缺少 #sec-compare");
assert.ok(experimentsStart >= 0 && experimentsStart < panelStart, "#sec-compare 必须在 #sec-experiments 之后");
assert.ok(imuStart > panelStart, "#sec-compare 必须在 #sec-imu 之前");
const sectionStart = html.lastIndexOf("<section", panelStart);
const section = html.slice(sectionStart, imuStart);
const sectionTag = /<section[^>]*\bid="sec-compare"[^>]*>/.exec(html)?.[0] ?? "";

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const PANEL_IDS = [
  "sec-compare",
  "sum-compare",
  "body-compare",
  "cmp-card",
  "cmp-baseline",
  "cmp-vars",
  "cmp-estimators",
  "cmp-diff",
  "cmp-status",
  "cmp-error",
  "cmp-table-wrap",
  "cmp-table",
  "cmp-body",
  "cmp-chart-wrap",
  "cmp-canvas",
  "cmp-legend",
  "cmp-alt",
  "cmp-alt-table",
  "cmp-alt-body",
  "btn-cmp-freeze",
  "btn-cmp-run",
  "btn-cmp-cancel",
  "btn-cmp-swap",
  "btn-cmp-apply",
  "btn-cmp-export",
  "btn-cmp-reset",
];

const ACTION_BUTTONS = [
  "btn-cmp-freeze",
  "btn-cmp-run",
  "btn-cmp-cancel",
  "btn-cmp-swap",
  "btn-cmp-apply",
  "btn-cmp-export",
  "btn-cmp-reset",
] as const;

const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

test("面板 id 唯一，必需容器全部存在", () => {
  assert.equal(new Set(allIds).size, allIds.length, `index.html 有重复 id：${allIds.filter((id, i) => allIds.indexOf(id) !== i).join(", ")}`);
  for (const id of PANEL_IDS) {
    assert.ok(section.includes(`id="${id}"`), `对照区缺少 #${id}`);
  }
});

test("面板节语义：二级折叠节、位置与抬头", () => {
  const classes = (attr(sectionTag, "class") ?? "").split(/\s+/).filter(Boolean);
  for (const cls of ["panel-section", "section-secondary", "section-compare", "collapsed"]) {
    assert.ok(classes.includes(cls), `section 缺少 class ${cls}`);
  }
  assert.equal(attr(sectionTag, "data-section"), "compare");
  assert.match(
    section,
    /<h2 class="panel-head"><button type="button" class="panel-toggle" aria-expanded="false" aria-controls="body-compare">/,
    "panel-head/toggle/aria-controls 结构不符合现有面板惯例",
  );
  assert.ok(
    section.includes('<span class="ph-summary" id="sum-compare">单变量对照 · 未创建</span>'),
    "ph-summary 默认文案必须是「单变量对照 · 未创建」",
  );
  assert.ok(section.includes('<span class="ph-chev" aria-hidden="true"></span>'), "缺少装饰性折叠箭头");
  assert.ok(section.includes('<div class="panel-body" id="body-compare">'), "缺少 #body-compare");
});

test("空/进行/失败状态的静态语义", () => {
  const card = /<div[^>]*\bid="cmp-card"[^>]*>/.exec(section)?.[0] ?? "";
  assert.equal(attr(card, "data-state"), "empty", "#cmp-card 初始 data-state 必须为 empty");

  const vars = /<div[^>]*\bid="cmp-vars"[^>]*>/.exec(section)?.[0] ?? "";
  assert.equal(attr(vars, "role"), "group");
  assert.equal(attr(vars, "aria-label"), "选择对照变量");

  const status = /<p[^>]*\bid="cmp-status"[^>]*>/.exec(section)?.[0] ?? "";
  assert.equal(attr(status, "role"), "status");
  assert.equal(attr(status, "aria-live"), "polite");
  assert.ok(
    section.includes(`>${comparisonStatusText("empty")}</p>`),
    "初始状态文案必须与 core/comparison-report 的 empty 文案一致",
  );

  const error = /<div[^>]*\bid="cmp-error"[^>]*>/.exec(section)?.[0] ?? "";
  assert.equal(attr(error, "role"), "alert");
  assert.ok(error.includes("hidden"), "#cmp-error 初始必须 hidden");

  const canvas = /<canvas[^>]*\bid="cmp-canvas"[^>]*>/.exec(section)?.[0] ?? "";
  assert.ok((attr(canvas, "aria-label") ?? "").length > 0, "#cmp-canvas 必须有初始 aria-label");
  assert.ok(section.includes('id="cmp-legend"'), "缺少 #cmp-legend");
});

test("表头与 comparisonTableHeadHtml 单一来源一致", () => {
  assert.ok(section.includes(comparisonTableHeadHtml()), "静态表头与 view helper 输出不一致");
  assert.match(
    section,
    /<div class="tscroll cmp-table-wrap" id="cmp-table-wrap" hidden>[\s\S]*<table class="metrics-table" id="cmp-table">/,
    "指标表必须在可横向滚动的 #cmp-table-wrap 内",
  );
  const alt = /<details[^>]*\bid="cmp-alt"[^>]*>/.exec(section)?.[0] ?? "";
  assert.ok(alt.includes("hidden"), "#cmp-alt 初始必须 hidden");
});

test("七个动作按钮都有可见标签且为 type=button", () => {
  for (const id of ACTION_BUTTONS) {
    const match = new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/button>`).exec(section);
    assert.ok(match, `缺少按钮 #${id}`);
    assert.match(match[0], /\btype="button"/, `#${id} 必须声明 type="button"`);
    const label = match[1].replace(/<[^>]+>/g, "").trim();
    assert.ok(label.length > 0, `#${id} 必须有可见标签`);
  }
});

test("对照区不新增表单控件（range/select/checkbox）", () => {
  assert.ok(!/<(input|select|option|textarea)\b/i.test(section), "对照区不应出现 input/select/option/textarea");
});

test("对照区不新增 chart-block / figure / fig- 结构", () => {
  assert.ok(!/chart-block|<figure\b|class="[^"]*\bfig-/i.test(section), "对照区应使用 cmp-chart-wrap，而不是旧图表结构");
  assert.ok(!/chart-block|<figure\b|class="[^"]*\bfig-/i.test(source), "面板源码不应创建旧图表结构");
});

test("面板只引用真实存在的 id", () => {
  const ids = new Set(allIds);
  const refs = new Set([...source.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...refs].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `这些 $() 引用在 index.html 中不存在：${missing.join(", ")}`);
  for (const id of ACTION_BUTTONS) assert.ok(refs.has(id), `面板未绑定 #${id}`);
});

test("runner 只能动态加载；Worker URL 走虚拟模块", () => {
  const staticSpecifiers = [...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["'];/gm)].map((m) => m[1]);
  assert.ok(
    !staticSpecifiers.some((spec) => spec.includes("core/runner")),
    "面板不得静态 import core/runner（会把数值内核拖回首屏）",
  );
  assert.ok(!/^import\s+["'][^"']*core\/runner["'];/m.test(source), "面板不得用副作用 import 加载 runner");
  assert.match(source, /import\s*\(\s*["']\.\.\/core\/runner(?:-ui)?["']\s*\)/, "主线程降级必须动态 import runner 或其具名 UI 入口");
  assert.match(source, /import\s*\(\s*["']\.\/comparison-view["']\s*\)/, "comparison-view 应按需加载");
  assert.match(source, /import\s*\(\s*["']\.\.\/core\/comparison-report["']\s*\)/, "comparison-report 应按需加载");
  assert.ok(staticSpecifiers.includes("virtual:worker-url/comparison"), "缺少 comparison worker 的虚拟 URL import");
  assert.match(
    source,
    /new Worker\(\s*comparisonWorkerUrl\s*,\s*\{\s*type:\s*"module"\s*\}\s*\)/,
    "必须用 comparisonWorkerUrl 创建 module worker",
  );
});

test("降级路径使用异步详细 runner 与正确分片预算", () => {
  assert.match(source, /\brunExperimentDetailedAsync\s*\(/, "降级路径必须调用异步详细 runner");
  assert.ok(!/\brunExperiment\s*\(/.test(source), "不得静默退回同步 runExperiment");
  assert.match(source, /stepsPerSlice:\s*128/, "降级分片应为 128 步");
  assert.match(source, /maxSliceMs:\s*4/, "降级分片墙钟预算应为 4 ms");
  assert.match(source, /type:\s*"cancel"/, "取消必须向 Worker 发送 cancel 消息");
});

test("五个变量标签、按钮式选择与按需视图调用齐全", () => {
  const labels = [
    "方向门控（关→开）",
    "磁修正（关→开）",
    "解算频率→50Hz",
    "延迟→25ms",
    "观测噪声→0.2",
  ];
  for (const label of labels) assert.ok(source.includes(label), `缺少变量标签：${label}`);
  assert.match(source, /dataset\.cmpVar|data-cmp-var/, "变量选择必须用 data-cmp-var 按钮");
  assert.match(source, /aria-pressed/, "变量按钮必须维护 aria-pressed");
  assert.match(source, /comparisonRowsHtml\s*\(/, "指标表必须使用 comparisonRowsHtml");
  assert.match(source, /comparisonDiffHtml\s*\(/, "配置差异必须使用 comparisonDiffHtml");
  assert.match(source, /buildComparisonReport\s*\(/, "完成时必须构造 comparison report");
});

test("样式：表格内滚、画布约 180px、窄屏动作栏单列", () => {
  assert.match(css, /\.cmp-table-wrap\s*\{[\s\S]*?overflow:\s*auto/, "指标表必须在自身容器内滚动");
  assert.match(css, /#cmp-canvas\s*\{[^}]*height:\s*180px/, "画布高度应为 180px");
  assert.match(css, /@media \(max-width: 420px\)\s*\{[\s\S]*?\.cmp-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, "窄屏动作按钮应改单列");
});

test("comparisonDiffHtml：外部文本转义，空差异不误报", () => {
  const empty = comparisonDiffHtml([], "解算频率");
  assert.match(empty, /配置差异仅包含变量/);
  assert.ok(!/禁止开始/.test(empty), "无额外差异时不得说禁止开始");

  const warn = comparisonDiffHtml(["solveRateHz", "a<b"], "x<y");
  assert.match(warn, /禁止开始/);
  assert.ok(warn.includes("solveRateHz"));
  assert.ok(warn.includes("a&lt;b"), "字段路径必须转义");
  assert.ok(warn.includes("x&lt;y"), "变量标签必须转义");
  assert.ok(!warn.includes("a<b"), "不得输出未转义的字段路径");
});

// ---------------------------------------------------------------------------
// 最小假 DOM：只实现对照面板实际使用的 API；不引入新依赖。
// ---------------------------------------------------------------------------
class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();
  readonly body = new FakeElement("body", this);

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  register(id: string, tag = "div"): FakeElement {
    const el = new FakeElement(tag, this);
    el.id = id;
    this.byId.set(id, el);
    return el;
  }
}

function fakeContext(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop in obj) return obj[prop as string];
      return () => undefined;
    },
    set(obj, prop, value) {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  dataset: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private ownText = "";
  private html = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = String(value);
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = "";
    this.html = String(value);
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = "";
    this.html = "";
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  getContext(): CanvasRenderingContext2D {
    return fakeContext();
  }

  querySelectorAll(selector: string): FakeElement[] {
    const all: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        all.push(child);
        walk(child);
      }
    };
    walk(this);
    if (selector === "button[data-cmp-var]") {
      return all.filter((el) => el.tagName === "button" && el.dataset.cmpVar !== undefined);
    }
    if (selector === "button[data-cmp-estimator]") {
      return all.filter((el) => el.tagName === "button" && el.dataset.cmpEstimator !== undefined);
    }
    return [];
  }
}

const PANEL_IDS_FOR_DOM = [
  "cmp-card",
  "cmp-baseline",
  "cmp-vars",
  "cmp-estimators",
  "cmp-diff",
  "cmp-status",
  "cmp-error",
  "cmp-table-wrap",
  "cmp-body",
  "cmp-chart-wrap",
  "cmp-canvas",
  "cmp-legend",
  "cmp-alt",
  "cmp-alt-body",
  "sum-compare",
  "btn-cmp-freeze",
  "btn-cmp-run",
  "btn-cmp-cancel",
  "btn-cmp-swap",
  "btn-cmp-apply",
  "btn-cmp-export",
  "btn-cmp-reset",
];

function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  for (const id of PANEL_IDS_FOR_DOM) {
    const isButton = id.startsWith("btn-");
    const isCanvas = id === "cmp-canvas";
    doc.register(id, isCanvas ? "canvas" : isButton ? "button" : "div");
  }
  (globalThis as unknown as { document: FakeDocument }).document = doc;
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    devicePixelRatio: 1,
    addEventListener: () => undefined,
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  return doc;
}

test("FIX-05：面板编排 configRevision 并暴露 markStaleIfChanged API", () => {
  assert.match(source, /getConfigRevision\(\):\s*number/, "deps 必须声明 getConfigRevision(): number");
  assert.match(source, /markStaleIfChanged\s*\(/, "API 必须暴露 markStaleIfChanged");
  assert.match(source, /reportRevision\s*=\s*frozenRevision/, "完成时必须记录冻结版本");
  assert.match(source, /currentState\s*===\s*"stale"[^\n]*btnApply|btnApply[\s\S]{0,80}currentState\s*===\s*"stale"/, "stale 必须禁用应用 B");
});

test("FIX-11：面板在报告视图后追加覆盖说明", () => {
  assert.match(source, /comparisonCoverageNotes\s*\(/, "面板必须调用 comparisonCoverageNotes(report)");
  assert.match(source, /comparisonCoverageNotesHtml\s*\(/, "面板必须渲染覆盖说明 HTML");
  assert.match(source, /coverageEl\.hidden\s*=/, "无备注时必须隐藏覆盖说明容器");
});

await testAsync("FIX-05：完成→配置版本变化→stale，未变化保持 done，stale 禁用应用 B", async () => {
  const doc = installFakeDom();
  let revision = 0;
  const config = { ...defaultExperimentConfig(), durationSec: 0.2 };
  const panel = mountComparisonPanel({
    baseConfig: () => config,
    applyConfig: () => ({ ok: true }),
    toast: () => undefined,
    buildInfo: { commit: "abcdef123456", builtAt: "2026-11-16T00:00:00.000Z", buildId: "abcdef123456-test" },
    getConfigRevision: () => revision,
  });
  panel.disableWorker();
  panel.freeze();
  panel.selectVariable("solve-rate");
  assert.equal(panel.state().state, "configured");

  await panel.run();
  assert.equal(panel.state().state, "done", "配置未变化时完成必须保持 done");
  panel.markStaleIfChanged();
  assert.equal(panel.state().state, "done", "版本未变化不得误标 stale");

  revision++;
  panel.markStaleIfChanged();
  assert.equal(panel.state().state, "stale", "配置版本变化后旧报告必须标 stale");
  assert.equal(doc.getElementById("cmp-status")?.textContent, "现场配置已变化，旧对照结果不再代表当前配置。可重新冻结基线并运行。");
  assert.equal(doc.getElementById("btn-cmp-apply")?.disabled, true, "stale 状态下应用 B 必须禁用");

  // 重新冻结 + 运行后恢复 done（新报告记录新版本）。
  panel.freeze();
  assert.equal(panel.state().state, "configured");
  panel.selectVariable("solve-rate");
  await panel.run();
  assert.equal(panel.state().state, "done", "重新冻结并运行后必须恢复 done");
  panel.markStaleIfChanged();
  assert.equal(panel.state().state, "done", "与冻结版本一致时不得误标 stale");
});

console.log(`comparison-ui-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
