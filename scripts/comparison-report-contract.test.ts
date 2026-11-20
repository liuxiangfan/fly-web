/**
 * 单变量对照报告契约（独立计数，不改变历史 selftest 门禁）。
 *
 * 钉住四类最容易退化的语义：
 *  1. 指标差值统一 B−A；交换 A/B 后符号反转，值身份不串。
 *  2. 未收敛、无样本、非有限值、缺指标都不得被算成 0 或产生假差值。
 *  3. 报告 schema/kind/restore 独立于配置档案；导出 JSON 安全且无活动引用。
 *  4. 视图片段只输出受控标记，变量标签与字段路径必须转义。
 */
import assert from "node:assert/strict";
import {
  COMPARISON_REPORT_KIND,
  COMPARISON_REPORT_RESTORE,
  buildComparisonReport,
  comparisonCoverageNotes,
  comparisonStatusText,
  serializeComparisonReport,
  type ComparisonReport,
  type ComparisonSide,
} from "../src/core/comparison-report";
import { validateComparisonReport } from "../src/core/comparison-report-validation";
import { comparisonMetricsRows } from "../src/core/comparison-metrics";
import { SERIES_CAP, type EstimatorRunMetrics } from "../src/core/runner";
import { cloneExperimentConfig, defaultExperimentConfig, type EstimatorId } from "../src/core/experiment-config";
import { ARCHIVE_KIND } from "../src/core/experiment-archive";
import {
  comparisonCoverageNotesHtml,
  comparisonDiffHtml,
  comparisonLegendText,
  comparisonRowsHtml,
  comparisonTableHeadHtml,
  comparisonVariableOptionsHtml,
} from "../src/ui/comparison-view";

let passed = 0, failed = 0;
function test(name: string, body: () => void): void {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

const BASE_CONFIG = defaultExperimentConfig();
const VARIABLE = { id: "solve-rate", label: "解算频率", a: 500, b: 50, affectedPaths: ["solveRateHz"] };
const BUILD = { commit: "abcdef123456", builtAt: "2026-11-15T00:00:00.000Z", buildId: "abcdef123456-deadbeef" };
const LABELS: Record<EstimatorId, string> = {
  pure: "纯积分",
  comp: "互补滤波",
  mahony: "Mahony",
  madg: "Madgwick",
  kalman: "卡尔曼",
};
const IDS: EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];

function metric(id: EstimatorId, over: Partial<EstimatorRunMetrics> = {}): EstimatorRunMetrics {
  return {
    id,
    label: LABELS[id],
    n: 1000,
    mean: 1.2,
    rmse: 2,
    max: 4,
    p50: 1,
    p95: 3.5,
    steadyRmse: 1.5,
    steadyFromSec: 18,
    percentileApprox: false,
    steadyMode: "exact",
    tiltRmse: 1,
    yawRmse: 1.2,
    tiltSo3Rmse: 0.8,
    yawSo3Rmse: 0.9,
    convergedAt: 2,
    gateRejects: 0,
    ...over,
  };
}

function metricsAll(over: (id: EstimatorId) => Partial<EstimatorRunMetrics> = () => ({})): EstimatorRunMetrics[] {
  return IDS.map((id) => metric(id, over(id)));
}

function side(overrides: Partial<ComparisonSide> = {}): ComparisonSide {
  return {
    config: cloneExperimentConfig(BASE_CONFIG),
    metrics: metricsAll(),
    series: [{ id: "mahony", label: "Mahony", t: [0, 1], errDeg: [2, 1] }],
    events: [],
    finalQuats: {
      pure: { x: 0, y: 0, z: 0, w: 1 },
      comp: { x: 0, y: 0, z: 0, w: 1 },
      mahony: { x: 0, y: 0, z: 0, w: 1 },
      madg: { x: 0, y: 0, z: 0, w: 1 },
      kalman: { x: 0, y: 0, z: 0, w: 1 },
    },
    termination: { reason: "completed", requestedEndSec: 30, endSec: 30, lastSolveSec: 30, pendingTailSec: 0 },
    seed: 0x5eed,
    ...overrides,
  };
}

function makeReport(a: ComparisonSide = side(), b: ComparisonSide = side()): ComparisonReport {
  return buildComparisonReport(BASE_CONFIG, VARIABLE, a, b, BUILD);
}

function rowByKey(report: ComparisonReport, id: EstimatorId, key: string) {
  const row = comparisonMetricsRows(report, id).find((r) => r.key === key);
  assert.ok(row, `缺少指标行 ${key}`);
  return row!;
}

test("报告 schema/kind/restore：只读结果，不是配置档案", () => {
  const report = makeReport();
  assert.equal(report.schema, 1);
  assert.equal(report.kind, COMPARISON_REPORT_KIND);
  assert.equal(report.kind, "quaternion-attitude-demo/comparison");
  assert.equal(report.restore, COMPARISON_REPORT_RESTORE);
  assert.equal(report.restore, "results-read-only");
  assert.notEqual(report.kind, ARCHIVE_KIND);
  assert.notEqual(report.restore, "config-only");
  assert.ok(Number.isFinite(Date.parse(report.createdAtIso)), `createdAtIso 非法：${report.createdAtIso}`);
  assert.deepEqual(report.build, BUILD);
  assert.deepEqual(report.baseConfig, BASE_CONFIG);
  assert.deepEqual(report.variable.affectedPaths, ["solveRateHz"]);
  assert.deepEqual(Object.keys(report.a).sort(), ["config", "metrics", "seed", "termination"]);
  assert.deepEqual(Object.keys(report.a).sort(), Object.keys(report.b).sort());
  assert.equal("series" in report.a, false, "逐点曲线不进入默认导出");
  assert.equal("events" in report.a, false);
  assert.equal("finalQuats" in report.a, false);
  assert.equal(report.coverage.seriesRetained, true);
});

test("指标差值统一 B−A，交换 A/B 后符号反转且值身份不串", () => {
  const a = side({ metrics: [metric("mahony", {
    rmse: 2, steadyRmse: 1.5, max: 4, convergedAt: 2, n: 1000,
    tiltSo3Rmse: 1, yawSo3Rmse: 1.2,
  })] });
  const b = side({ metrics: [metric("mahony", {
    rmse: 1.5, steadyRmse: 1, max: 3.5, convergedAt: 1.5, n: 1200,
    tiltSo3Rmse: 0.8, yawSo3Rmse: 0.9,
  })] });
  const forward = makeReport(a, b);
  const rmse = rowByKey(forward, "mahony", "rmse");
  assert.equal(rmse.a, 2);
  assert.equal(rmse.b, 1.5);
  assert.equal(rmse.delta, -0.5);
  assert.equal(rmse.reason, null);
  assert.equal(rowByKey(forward, "mahony", "steadyRmse").delta, -0.5);
  assert.equal(rowByKey(forward, "mahony", "max").delta, -0.5);
  assert.equal(rowByKey(forward, "mahony", "convergedAt").delta, -0.5);
  assert.equal(rowByKey(forward, "mahony", "n").delta, 200);
  assert.ok(Math.abs(rowByKey(forward, "mahony", "tiltSo3Rmse").delta! + 0.2) < 1e-9);
  assert.ok(Math.abs(rowByKey(forward, "mahony", "yawSo3Rmse").delta! + 0.3) < 1e-9);

  const swapped = makeReport(b, a);
  const swappedRmse = rowByKey(swapped, "mahony", "rmse");
  assert.equal(swappedRmse.a, 1.5);
  assert.equal(swappedRmse.b, 2);
  assert.equal(swappedRmse.delta, 0.5, "交换后差值必须反号");
  assert.equal(rowByKey(swapped, "mahony", "n").delta, -200);
  assert.ok(Math.abs(rowByKey(swapped, "mahony", "tiltSo3Rmse").delta! - 0.2) < 1e-9);
  assert.deepEqual(
    comparisonMetricsRows(forward, "mahony").map((r) => r.key),
    ["rmse", "steadyRmse", "max", "convergedAt", "n", "tiltSo3Rmse", "yawSo3Rmse", "accelAcceptPct"],
  );
  assert.deepEqual(
    comparisonMetricsRows(forward, "mahony").map((r) => r.unit),
    ["°", "°", "°", "s", "个", "°", "°", "%"],
  );
});

test("未收敛：convergedAt=null 显示不可比较，不当作 0 s", () => {
  const report = makeReport(
    side({ metrics: [metric("mahony", { rmse: 2, convergedAt: 2 })] }),
    side({ metrics: [metric("mahony", { rmse: 2, convergedAt: null })] }),
  );
  const conv = rowByKey(report, "mahony", "convergedAt");
  assert.equal(conv.a, 2);
  assert.equal(conv.b, null);
  assert.equal(conv.delta, null);
  assert.equal(conv.reason, "unconverged");
  assert.equal(rowByKey(report, "mahony", "rmse").delta, 0, "其他指标仍可比较");
});

test("无样本：统计量为 null，n 行可见 0 但不产生差值", () => {
  const report = makeReport(
    side({
      metrics: [metric("mahony", {
        n: 0, mean: NaN, rmse: NaN, max: NaN, p50: NaN, p95: NaN,
        steadyRmse: NaN, tiltRmse: NaN, yawRmse: NaN, convergedAt: null,
      })],
    }),
    side({ metrics: [metric("mahony", { rmse: 2, steadyRmse: 1.5, max: 4, convergedAt: 2, n: 1000 })] }),
  );
  const rmse = rowByKey(report, "mahony", "rmse");
  assert.equal(rmse.a, null);
  assert.equal(rmse.b, 2);
  assert.equal(rmse.delta, null);
  assert.equal(rmse.reason, "no-sample");
  const n = rowByKey(report, "mahony", "n");
  assert.equal(n.a, 0);
  assert.equal(n.b, 1000);
  assert.equal(n.delta, null);
  assert.equal(n.reason, "no-sample");
  const conv = rowByKey(report, "mahony", "convergedAt");
  assert.equal(conv.delta, null);
  assert.equal(conv.reason, "no-sample", "没有样本时优先说明无样本，而不是未收敛");
});

test("非有限值：该指标不可比较并给出 non-finite", () => {
  const report = makeReport(
    side({ metrics: [metric("mahony", { rmse: 2, steadyRmse: 1.5 })] }),
    side({ metrics: [metric("mahony", { rmse: Infinity, steadyRmse: NaN })] }),
  );
  const rmse = rowByKey(report, "mahony", "rmse");
  assert.equal(rmse.a, 2);
  assert.equal(rmse.b, null);
  assert.equal(rmse.delta, null);
  assert.equal(rmse.reason, "non-finite");
  assert.equal(rowByKey(report, "mahony", "steadyRmse").reason, "non-finite");
});

test("缺少算法指标：八行为 unavailable，不补 0", () => {
  const report = makeReport(
    side({ metrics: [metric("mahony")] }),
    side({ metrics: [metric("mahony")] }),
  );
  const rows = comparisonMetricsRows(report, "kalman");
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.a, null);
    assert.equal(row.b, null);
    assert.equal(row.delta, null);
    assert.equal(row.reason, "unavailable");
  }
});

test("无真值：SO(3) 分轴指标为 null + no-truth，不补 0", () => {
  const noTruth = { tiltSo3Rmse: undefined, yawSo3Rmse: undefined };
  const report = makeReport(
    side({ metrics: [metric("mahony", noTruth)] }),
    side({ metrics: [metric("mahony", noTruth)] }),
  );
  for (const key of ["tiltSo3Rmse", "yawSo3Rmse"] as const) {
    const row = rowByKey(report, "mahony", key);
    assert.equal(row.a, null, `${key} 无真值时不得补 0`);
    assert.equal(row.b, null, `${key} 无真值时不得补 0`);
    assert.equal(row.delta, null);
    assert.equal(row.reason, "no-truth");
  }
  const html = comparisonRowsHtml(report, "mahony");
  assert.ok(html.includes("无真值"), "无真值列必须显示不可用（无真值）");
});

test("重力接受率：只有卡尔曼适用，固定增益缺字段显示 unavailable 不伪造 0%", () => {
  const report = makeReport(
    side({ metrics: [metric("comp")] }),
    side({ metrics: [metric("comp")] }),
  );
  const comp = rowByKey(report, "comp", "accelAcceptPct");
  assert.equal(comp.a, null);
  assert.equal(comp.b, null);
  assert.equal(comp.delta, null);
  assert.equal(comp.reason, "unavailable");

  // 即使上游误填 0，非卡尔曼算法也不得显示成「0% 接受率」。
  const placeholder = makeReport(
    side({ metrics: [metric("comp", { accelAcceptPct: 0 })] }),
    side({ metrics: [metric("comp", { accelAcceptPct: 0 })] }),
  );
  const zeroRow = rowByKey(placeholder, "comp", "accelAcceptPct");
  assert.equal(zeroRow.a, null);
  assert.equal(zeroRow.b, null);
  assert.equal(zeroRow.reason, "unavailable");

  const kalmanReport = makeReport(
    side({ metrics: [metric("kalman", { accelAcceptPct: 97.5 })] }),
    side({ metrics: [metric("kalman", { accelAcceptPct: 92 })] }),
  );
  const kalman = rowByKey(kalmanReport, "kalman", "accelAcceptPct");
  assert.equal(kalman.a, 97.5);
  assert.equal(kalman.b, 92);
  assert.equal(kalman.delta, -5.5);
  assert.equal(kalman.reason, null);
});

test("序列化：非有限转 null、路径原因保留、JSON 往返稳定且无活动引用", () => {
  const raw = makeReport(
    side({ metrics: [metric("mahony", { rmse: NaN, steadyRmse: Infinity })] }),
    side({ metrics: [metric("mahony", { rmse: 1.5, steadyRmse: 1 })] }),
  );
  const serialized = serializeComparisonReport(raw);
  assert.equal(serialized.a.metrics[0].rmse, null);
  assert.equal(serialized.a.metrics[0].steadyRmse, null);
  assert.ok(
    serialized.coverage.notes.some((n) => n.includes("a.metrics[0].rmse") && n.includes("null")),
    `缺少 rmse 消毒原因：${serialized.coverage.notes.join(" | ")}`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized, "序列化结果必须能无损 JSON 往返");
  assert.notEqual(serialized, raw);
  assert.notEqual(serialized.a, raw.a);
  assert.notEqual(serialized.a.config, raw.a.config);
  assert.notEqual(serialized.a.metrics[0], raw.a.metrics[0]);
  assert.notEqual(serialized.coverage.notes, raw.coverage.notes);
  serialized.a.config.seed = 123;
  serialized.a.metrics[0].rmse = 9;
  serialized.variable.label = "改过";
  assert.equal(raw.a.config.seed, BASE_CONFIG.seed);
  assert.ok(Number.isNaN(raw.a.metrics[0].rmse as number), "原报告的 NaN 不能被序列化过程改写");
  assert.equal(raw.variable.label, VARIABLE.label);
  const validated = validateComparisonReport(JSON.parse(JSON.stringify(serialized)));
  assert.equal(validated.ok, true, validated.ok ? "" : validated.error);
});

test("校验：错误 schema/kind/restore/构建信息/路径都拒绝且不改输入", () => {
  const base = JSON.parse(JSON.stringify(serializeComparisonReport(makeReport()))) as Record<string, any>;
  assert.equal(validateComparisonReport(base).ok, true);
  const reject = (edit: (r: Record<string, any>) => void, path: string): void => {
    const raw = JSON.parse(JSON.stringify(base));
    edit(raw);
    const before = JSON.stringify(raw);
    const result = validateComparisonReport(raw);
    assert.equal(result.ok, false, `应拒绝 ${path}`);
    if (!result.ok) {
      assert.ok(
        result.path === path || result.path.endsWith(path) || result.error.includes(path),
        `错误路径应包含 ${path}，实际 path=${result.path} error=${result.error}`,
      );
    }
    assert.equal(JSON.stringify(raw), before, "校验不能修改输入");
  };
  reject((r) => { r.schema = 2; }, "schema");
  reject((r) => { r.kind = "quaternion-attitude-demo/archive"; }, "kind");
  reject((r) => { r.restore = "config-only"; }, "restore");
  reject((r) => { r.createdAtIso = "not-a-date"; }, "createdAtIso");
  reject((r) => { r.build.commit = ""; }, "build.commit");
  reject((r) => { r.build.builtAt = "yesterday"; }, "build.builtAt");
  reject((r) => { r.baseConfig.seed = -1; }, "baseConfig.seed");
  reject((r) => { r.variable.affectedPaths = []; }, "variable.affectedPaths");
  reject((r) => { r.a.metrics = []; }, "a.metrics");
  reject((r) => { r.a.seed = -1; }, "a.seed");
  reject((r) => { r.a.metrics[0].rmse = "2"; }, "a.metrics[0].rmse");
  reject((r) => { r.a.termination.reason = "running"; }, "a.termination.reason");
  reject((r) => { r.coverage.seriesRetained = "yes"; }, "coverage.seriesRetained");
  for (const bad of [null, [], {}, "report", 1]) {
    assert.equal(validateComparisonReport(bad).ok, false);
  }
});

test("校验：原始报告的非有限值必须先序列化，消毒后才能通过", () => {
  const raw = makeReport(side({ metrics: [metric("mahony", { rmse: NaN })] }), side());
  const rejected = validateComparisonReport(raw);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.ok(rejected.error.includes("a.metrics[0].rmse"), rejected.error);
  const accepted = validateComparisonReport(serializeComparisonReport(raw));
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);
});

test("状态文案：done 只有在两侧完成时才输出完成词", () => {
  assert.match(comparisonStatusText("empty"), /未创建|冻结/);
  assert.match(comparisonStatusText("configured"), /A 为基线|配置差异/);
  assert.match(comparisonStatusText("running-a"), /A 侧.*运行|正在运行 A/);
  assert.match(comparisonStatusText("running-b"), /B 侧|两侧都完成前/);
  const done = comparisonStatusText("done", { completedSides: 2 });
  assert.match(done, /完成/);
  assert.match(done, /两侧/);
  for (const n of [0, 1]) {
    const text = comparisonStatusText("done", { completedSides: n });
    assert.match(text, /未完成/);
    assert.doesNotMatch(text, /^完成：/);
  }
  assert.match(comparisonStatusText("cancelled", { completedSides: 1 }), /已取消/);
  assert.match(comparisonStatusText("cancelled", { completedSides: 1 }), /1 侧/);
  const error = comparisonStatusText("error", { side: "b", message: "worker 启动失败" });
  assert.match(error, /B 侧/);
  assert.match(error, /worker 启动失败/);
  assert.match(comparisonStatusText("stale"), /过期/);
});

test("覆盖说明：截断、分位数近似、early-stop、取消侧与自定义备注", () => {
  const a = side({
    metrics: [metric("mahony", {
      n: SERIES_CAP + 1,
      percentileApprox: true,
      steadyMode: "early-stop",
    })],
  });
  const b = side({
    termination: {
      reason: "cancelled",
      requestedEndSec: 30,
      endSec: 12,
      lastSolveSec: 11.98,
      pendingTailSec: 0.02,
      cancelledAtSec: 12,
    },
  });
  const report = buildComparisonReport(BASE_CONFIG, VARIABLE, a, b, BUILD, { notes: ["自定义覆盖说明"] });
  const notes = comparisonCoverageNotes(report);
  assert.ok(notes.some((n) => n.includes(String(SERIES_CAP)) && n.includes("截断")), notes.join(" | "));
  assert.ok(notes.some((n) => n.includes("蓄水池") || n.includes("近似")), notes.join(" | "));
  assert.ok(notes.some((n) => n.includes("early-stop")), notes.join(" | "));
  assert.ok(notes.some((n) => n.includes("B 侧") && n.includes("未完成") && n.includes("取消")), notes.join(" | "));
  assert.ok(notes.includes("自定义覆盖说明"));
  const noSeries = buildComparisonReport(BASE_CONFIG, VARIABLE, side({ series: [] }), side(), BUILD);
  assert.equal(noSeries.coverage.seriesRetained, false);
  assert.ok(comparisonCoverageNotes(noSeries).some((n) => n.includes("未保留逐点误差曲线")));
});

test("覆盖说明渲染：折叠区包含截断/近似/early-stop/未完成备注且文本转义", () => {
  const a = side({
    metrics: [metric("mahony", {
      n: SERIES_CAP + 1,
      percentileApprox: true,
      steadyMode: "early-stop",
    })],
  });
  const b = side({
    termination: {
      reason: "cancelled",
      requestedEndSec: 30,
      endSec: 12,
      lastSolveSec: 11.98,
      pendingTailSec: 0.02,
      cancelledAtSec: 12,
    },
  });
  const report = buildComparisonReport(BASE_CONFIG, VARIABLE, a, b, BUILD, {
    notes: ["自定义覆盖说明 <b>不应注入</b>"],
  });
  const notes = comparisonCoverageNotes(report);
  const html = comparisonCoverageNotesHtml(notes);
  assert.match(html, /<details class="cmp-alt cmp-coverage">/);
  assert.match(html, /<summary>覆盖与口径说明<\/summary>/);
  assert.ok(html.includes(String(SERIES_CAP)) && html.includes("截断"), "缺少截断说明");
  assert.ok(html.includes("蓄水池") || html.includes("近似"), "缺少分位数近似说明");
  assert.ok(html.includes("early-stop"), "缺少 early-stop 说明");
  assert.ok(html.includes("B 侧") && html.includes("未完成"), "缺少未完成侧说明");
  assert.ok(html.includes("自定义覆盖说明") && html.includes("&lt;b&gt;"), "自定义备注必须转义");
  assert.ok(!html.includes("<b>不应注入</b>"), "不得把备注当标记输出");
  assert.equal(comparisonCoverageNotesHtml([]), "", "没有备注时返回空串");
});

test("构建复制：后续改输入不会污染已建报告", () => {
  const aSide = side();
  const variable = { id: "delay", label: "传感器延迟", a: { ms: 0 }, b: { ms: 25 }, affectedPaths: ["imu.sensorDelayMs"] };
  const report = buildComparisonReport(BASE_CONFIG, variable, aSide, side(), BUILD);
  aSide.config.seed = 999;
  aSide.metrics[0].rmse = 99;
  aSide.termination.endSec = 1;
  variable.a.ms = 999;
  assert.equal(report.a.config.seed, BASE_CONFIG.seed);
  assert.equal(report.a.metrics[0].rmse, 2);
  assert.equal(report.a.termination.endSec, 30);
  assert.equal((report.variable.a as { ms: number }).ms, 0);
});

test("HTML 行：单位、A/B/Δ 与缺失态齐全，无 NaN/Infinity 文本", () => {
  const report = makeReport(
    side({ metrics: [metric("mahony", { rmse: 2, steadyRmse: 1.5, max: 4, convergedAt: 2, n: 1000 })] }),
    side({ metrics: [metric("mahony", { rmse: 1.5, steadyRmse: 1, max: 3.5, convergedAt: null, n: 1200 })] }),
  );
  const html = comparisonRowsHtml(report, "mahony");
  const head = comparisonTableHeadHtml();
  assert.equal((html.match(/<tr /g) ?? []).length, 8);
  assert.ok(head.includes("单位"));
  assert.ok(head.includes("A（基线）"));
  assert.ok(head.includes("B（变量）"));
  assert.ok(head.includes("Δ = B − A"));
  assert.ok(html.includes('data-estimator="mahony"'));
  assert.ok(html.includes("全程 RMSE"));
  assert.ok(html.includes("SO(3) 倾角 RMS"));
  assert.ok(html.includes("SO(3) 偏航 RMS"));
  assert.ok(html.includes("重力接受率"));
  for (const unit of ["°", "s", "个", "%"]) assert.ok(html.includes(`>${unit}<`), `缺少单位 ${unit}`);
  assert.ok(html.includes(">2.00<"));
  assert.ok(html.includes(">1.50<"));
  assert.ok(html.includes(">-0.50<"));
  assert.ok(html.includes("未收敛"));
  assert.doesNotMatch(html, /NaN|Infinity/);

  const noSample = makeReport(
    side({ metrics: [metric("mahony", { n: 0, rmse: NaN, steadyRmse: NaN, max: NaN, convergedAt: null })] }),
    side({ metrics: [metric("mahony")] }),
  );
  assert.ok(comparisonRowsHtml(noSample, "mahony").includes("无样本"));
  const nonFinite = makeReport(
    side({ metrics: [metric("mahony", { rmse: Infinity })] }),
    side({ metrics: [metric("mahony")] }),
  );
  assert.ok(comparisonRowsHtml(nonFinite, "mahony").includes("不可用"));
});

test("HTML 转义：恶意变量标签、路径与选项值不得注入标记", () => {
  const evilLabel = `"><script>alert(1)</script>`;
  const evilPath = `<img src=x onerror=alert(1)>`;
  const options = comparisonVariableOptionsHtml(
    [
      { id: "safe", label: evilLabel },
      { id: `x" onmouseover="alert(1)`, label: "<b>B</b>" },
    ],
    "safe",
  );
  assert.doesNotMatch(options, /<script/i);
  assert.doesNotMatch(options, /<img/i);
  assert.doesNotMatch(options, /<b>/i);
  assert.ok(options.includes("&lt;script&gt;"));
  assert.ok(options.includes("&lt;b&gt;B&lt;/b&gt;"));
  assert.ok(options.includes('value="safe" selected'));
  assert.ok(options.includes("value=\"x&quot; onmouseover=&quot;alert(1)\""));
  assert.equal((options.match(/ selected/g) ?? []).length, 1, "只能有一个选中项");

  const diff = comparisonDiffHtml([evilPath], evilLabel);
  assert.doesNotMatch(diff, /<img/i);
  assert.doesNotMatch(diff, /<script/i);
  assert.ok(diff.includes("&lt;img"));
  assert.ok(diff.includes("&lt;script&gt;"));
  assert.ok(diff.includes("禁止开始"));

  const empty = comparisonDiffHtml([], "<b>变量</b>");
  assert.ok(empty.includes("配置差异仅包含变量"));
  assert.ok(empty.includes("&lt;b&gt;变量&lt;/b&gt;"));
  assert.doesNotMatch(empty, /<b>/);

  const withValues = comparisonDiffHtml([{ path: "imu.sensorDelayMs", a: 0, b: 25 }], "传感器延迟");
  assert.ok(withValues.includes("imu.sensorDelayMs"));
  assert.ok(withValues.includes("0 → 25"));
});

test("等价文本：固定条件、唯一变量与 Δ=B−A 口径", () => {
  const legend = comparisonLegendText(makeReport());
  assert.match(legend, /固定条件/);
  assert.match(legend, /解算频率/);
  assert.match(legend, /唯一变量「解算频率」/);
  assert.match(legend, /Δ = B − A/);
  assert.match(legend, /单位为 °/);
  assert.match(legend, /收敛时间单位为 s/);
});

console.log(`comparison-report-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
