/**
 * 只读实验报告 UI 契约（独立计数，不改变历史 selftest 门禁）。
 *
 * 钉住四件事：
 *  1. 视图模型口径：指标格式化、null→「—」、events null/[]/超上限的不同文案。
 *  2. 导入横幅必须声明「只读 / 不应用配置 / 不改变当前运行」。
 *  3. index.html / style.css 接线不漂移：按钮、文件输入、打印根与打印态规则。
 *  4. 只读是结构性保证：面板源码不得出现任何应用配置/重跑的入口。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExperimentReport, type ExperimentReport, type ExperimentReportInput } from "../src/core/experiment-report";
import { buildArchive } from "../src/core/experiment-archive";
import { defaultExperimentConfig, cloneExperimentConfig, type EstimatorId } from "../src/core/experiment-config";
import { buildComparisonReport, serializeComparisonReport, type ComparisonSide } from "../src/core/comparison-report";
import type { EstimatorRunMetrics } from "../src/core/runner";
import type { LearningEvent } from "../src/core/event-timeline";
import { reportViewModel, REPORT_EVENT_RENDER_CAP } from "../src/ui/report-panel";

let passed = 0;
let failed = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    passed++;
    console.log(`report-ui-contract: ${passed} PASS / 0 FAIL (${name})`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const CREATED_AT = "2026-11-20T00:00:00.000Z";
function makeArchive(metrics?: { id: string; n: number; mean: number | null; rmse: number | null; max: number | null; convergedAt: number | null }[]) {
  return buildArchive(defaultExperimentConfig(), {
    elapsedSec: 12.5,
    dataSource: "模拟",
    reference: "groundTruth",
    finishedAtIso: CREATED_AT,
    metrics: metrics ?? [{ id: "mahony", n: 100, mean: 1, rmse: 2, max: 3, convergedAt: 2 }],
  });
}
function makeEvent(t: number): LearningEvent {
  return { runId: 1, seq: Math.round(t * 10), t, kind: "param-change", estimator: null, phase: "instant", summary: `事件 ${t}`, source: "user-action" };
}
function makeInput(overrides: Partial<ExperimentReportInput> = {}): ExperimentReportInput {
  return {
    createdAtIso: CREATED_AT,
    build: { buildId: "build-1", sourceDigest: "sha256:deadbeef" },
    archive: makeArchive(),
    events: null,
    comparison: null,
    ...overrides,
  };
}

test("生成横幅与构建信息；指标按 4 位小数格式化", () => {
  const vm = reportViewModel(buildExperimentReport(makeInput()), { kind: "generated" });
  assert.match(vm.banner, /只读快照/);
  assert.ok(vm.meta.some((l) => l.includes("build-1") && l.includes("sha256:deadbeef")));
  assert.deepEqual(vm.metricsRows[0], ["mahony", "100", "1.0000°", "2.0000°", "3.0000°", "2.00 s"]);
  assert.match(vm.runInfo[0], /模拟/);
  assert.match(vm.runInfo[0], /12\.5 s/);
});

test("n=0 的无样本统计量显示为「—」，不得伪造 0", () => {
  const vm = reportViewModel(buildExperimentReport(makeInput({
    archive: makeArchive([{ id: "pure", n: 0, mean: null, rmse: null, max: null, convergedAt: null }]),
  })), { kind: "generated" });
  assert.deepEqual(vm.metricsRows[0], ["pure", "0", "—", "—", "—", "—"]);
});

test("events=null / [] / 超上限：三种文案与截断行数", () => {
  const nullVm = reportViewModel(buildExperimentReport(makeInput()), { kind: "generated" });
  assert.match(nullVm.eventsSummary, /未开启诊断事件采集/);
  assert.match(nullVm.eventsSummary, /不等于/);
  const emptyVm = reportViewModel(buildExperimentReport(makeInput({ events: [] })), { kind: "generated" });
  assert.match(emptyVm.eventsSummary, /已开启事件采集，窗口内没有事件/);
  const many = Array.from({ length: REPORT_EVENT_RENDER_CAP + 20 }, (_, i) => makeEvent(i * 0.1));
  const manyVm = reportViewModel(buildExperimentReport(makeInput({ events: many })), { kind: "generated" });
  assert.equal(manyVm.eventsRows.length, REPORT_EVENT_RENDER_CAP);
  assert.match(manyVm.eventsSummary, new RegExp(`已采集 ${REPORT_EVENT_RENDER_CAP + 20} 条`));
  assert.match(manyVm.eventsSummary, /完整内容以导出 JSON 为准/);
});

test("导入横幅：只读、文件名、不应用配置、不改变当前运行", () => {
  const vm = reportViewModel(buildExperimentReport(makeInput()), { kind: "imported", fileName: "r.json" });
  assert.match(vm.banner, /只读查看导入文件：r\.json/);
  assert.match(vm.banner, /不应用配置/);
  assert.match(vm.banner, /不改变当前运行/);
});

test("build=null 与 run=null 都有明确文案；comparison=null 不伪造对照", () => {
  const report = buildExperimentReport(makeInput({ build: null }));
  // 档案类型上 run 非空，但 parseArchive 实际容忍 run:null——视图模型必须兜底（不可信导入同理）。
  const noRun = { ...report, archive: { ...report.archive, run: null } } as unknown as ExperimentReport;
  const vm = reportViewModel(noRun, { kind: "generated" });
  assert.ok(vm.meta.some((l) => l.includes("无构建信息")));
  assert.deepEqual(vm.runInfo, ["档案未携带运行信息（run 为空）"]);
  assert.deepEqual(vm.metricsRows, []);
  assert.match(vm.comparisonSummary, /未创建单变量对照/);
  assert.equal(vm.comparisonJson, null);
});

test("内嵌真实对照：摘要含变量名，完整 JSON 保留", () => {
  const ids: EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];
  const side = (): ComparisonSide => ({
    config: cloneExperimentConfig(defaultExperimentConfig()),
    metrics: ids.map((id): EstimatorRunMetrics => ({
      id, label: id, n: 100, mean: 1, rmse: 2, max: 3, p50: 1, p95: 2.5,
      steadyRmse: 1.5, steadyFromSec: 1, percentileApprox: false, steadyMode: "exact",
      tiltRmse: 1, yawRmse: 1.2, tiltSo3Rmse: 0.8, yawSo3Rmse: 0.9, convergedAt: 2, gateRejects: 0,
    })),
    series: [],
    events: [],
    finalQuats: Object.fromEntries(ids.map((id) => [id, { x: 0, y: 0, z: 0, w: 1 }])) as ComparisonSide["finalQuats"],
    termination: { reason: "completed", requestedEndSec: 30, endSec: 30, lastSolveSec: 30, pendingTailSec: 0 },
    seed: 0x5eed,
  });
  const comparison = serializeComparisonReport(buildComparisonReport(
    defaultExperimentConfig(),
    { id: "solve-rate", label: "解算频率", a: 500, b: 50, affectedPaths: ["solveRateHz"] },
    side(), side(),
    { commit: "abcdef123456", builtAt: CREATED_AT, buildId: "abcdef123456-deadbeef" },
  ));
  const vm = reportViewModel(buildExperimentReport(makeInput({ comparison })), { kind: "generated" });
  assert.match(vm.comparisonSummary, /解算频率/);
  assert.ok(vm.comparisonJson?.includes("quaternion-attitude-demo/comparison"));
});

test("index.html 接线：报告按钮、JSON 文件输入与宿主真实存在", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<button type="button" class="btn" id="btn-diag-report">实验报告<\/button>/);
  assert.match(html, /<button type="button" class="btn" id="btn-diag-report-import">导入报告<\/button>/);
  assert.match(html, /<input type="file" id="report-file" accept="\.json,application\/json" class="hidden" \/>/);
  assert.ok(html.includes('<div id="diag-report-host"></div>'));
  // 打印根必须在静态 HTML 里存在（htmlcheck 会核 JS 引用的每个 id），屏幕隐藏、打印时填充。
  assert.ok(html.includes('<div id="report-print-root" hidden></div>'));
});

test("打印规则：报告打印根默认隐藏，覆盖规则只作用于 data-print=report，文档打印不受影响", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /#report-print-root \{ display: none; \}/);
  assert.ok(css.includes('body[data-print="report"] #docs-overlay { display: none !important; }'));
  assert.ok(css.includes('body[data-print="report"] #report-print-root { display: block !important;'));
  // 既有文档打印：无 data-print 时仍然强制显示文档层（旧 smoke 用例的语义不被覆盖）。
  assert.match(css, /@media print \{[\s\S]*?#docs-overlay \{\n    position: static !important;\n    display: block !important;/);
});

test("只读结构性保证：面板源码没有任何应用配置/重跑入口", () => {
  const src = readFileSync(new URL("../src/ui/report-panel.ts", import.meta.url), "utf8");
  assert.ok(!/applyArchive|applyConfig|applyExperiment|importArchive|resetExperiment|startRun/.test(src));
});

console.log(`report-ui-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
