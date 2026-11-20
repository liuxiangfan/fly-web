/**
 * 只读实验报告契约（独立计数，不改变历史 selftest 门禁）。
 *
 * 钉住最容易退化的语义：
 *  1. build → serialize → JSON.parse → validate 往返等值。
 *  2. events=null（未采集）与 events=[]（已采集但无事件）语义不丢。
 *  3. comparison=null 与真实对照报告都合法。
 *  4. 错误 schema/kind/restore、NaN/Infinity、循环引用一律拒绝。
 *  5. build=null（无构建信息）合法；构建后输入与报告不共享引用。
 */
import assert from "node:assert/strict";
import {
  REPORT_KIND,
  REPORT_RESTORE,
  REPORT_SCHEMA,
  buildExperimentReport,
  serializeExperimentReport,
  validateExperimentReport,
  type ExperimentReport,
  type ExperimentReportInput,
} from "../src/core/experiment-report";
import { buildArchive } from "../src/core/experiment-archive";
import { defaultExperimentConfig, cloneExperimentConfig, type EstimatorId } from "../src/core/experiment-config";
import {
  buildComparisonReport,
  serializeComparisonReport,
  type ComparisonReport,
  type ComparisonSide,
} from "../src/core/comparison-report";
import type { EstimatorRunMetrics } from "../src/core/runner";
import type { LearningEvent } from "../src/core/event-timeline";

let passed = 0;
let failed = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    passed++;
    console.log(`experiment-report-contract: ${passed} PASS / 0 FAIL (${name})`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const CREATED_AT = "2026-11-20T00:00:00.000Z";
const BUILD_INFO = { buildId: "build-1", sourceDigest: "sha256:deadbeef" };

function makeArchive() {
  return buildArchive(defaultExperimentConfig(), {
    elapsedSec: 12.5,
    dataSource: "模拟",
    reference: "groundTruth",
    finishedAtIso: CREATED_AT,
    metrics: [{ id: "mahony", n: 100, mean: 1, rmse: 2, max: 3, convergedAt: 2 }],
  });
}

function makeEvent(): LearningEvent {
  return {
    runId: 1,
    seq: 1,
    t: 0.5,
    kind: "param-change",
    estimator: null,
    phase: "instant",
    summary: "参数变更",
    source: "user-action",
    before: { gain: 1 },
    after: { gain: 2 },
  };
}

const LABELS: Record<EstimatorId, string> = {
  pure: "纯积分",
  comp: "互补滤波",
  mahony: "Mahony",
  madg: "Madgwick",
  kalman: "卡尔曼",
};
const IDS: EstimatorId[] = ["pure", "comp", "mahony", "madg", "kalman"];

function side(): ComparisonSide {
  return {
    config: cloneExperimentConfig(defaultExperimentConfig()),
    metrics: IDS.map((id): EstimatorRunMetrics => ({
      id,
      label: LABELS[id],
      n: 100,
      mean: 1,
      rmse: 2,
      max: 3,
      p50: 1,
      p95: 2.5,
      steadyRmse: 1.5,
      steadyFromSec: 1,
      percentileApprox: false,
      steadyMode: "exact",
      tiltRmse: 1,
      yawRmse: 1.2,
      tiltSo3Rmse: 0.8,
      yawSo3Rmse: 0.9,
      convergedAt: 2,
      gateRejects: 0,
    })),
    series: [],
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
  };
}

function makeComparison(): ComparisonReport {
  const raw = buildComparisonReport(
    defaultExperimentConfig(),
    { id: "solve-rate", label: "解算频率", a: 500, b: 50, affectedPaths: ["solveRateHz"] },
    side(),
    side(),
    { commit: "abcdef123456", builtAt: CREATED_AT, buildId: "abcdef123456-deadbeef" },
  );
  return serializeComparisonReport(raw);
}

function makeInput(overrides: Partial<ExperimentReportInput> = {}): ExperimentReportInput {
  return {
    createdAtIso: CREATED_AT,
    build: BUILD_INFO,
    archive: makeArchive(),
    events: null,
    comparison: null,
    ...overrides,
  };
}

function roundTrip(report: ExperimentReport): ExperimentReport {
  return JSON.parse(serializeExperimentReport(report)) as ExperimentReport;
}

test("最小合法报告：build → serialize → JSON.parse → validate 往返等值", () => {
  const report = buildExperimentReport(makeInput());
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.kind, REPORT_KIND);
  assert.equal(report.restore, REPORT_RESTORE);
  assert.ok(report.notes.some((n) => n.includes("快照")));
  assert.ok(report.notes.some((n) => n.includes("滚动统计")));
  const restored = validateExperimentReport(roundTrip(report));
  assert.deepEqual(restored, report);
});

test("events=null 与 events=[] 往返后语义不丢", () => {
  const withNull = roundTrip(buildExperimentReport(makeInput({ events: null })));
  assert.equal(validateExperimentReport(withNull).events, null);
  const withEmpty = roundTrip(buildExperimentReport(makeInput({ events: [] })));
  const restoredEmpty = validateExperimentReport(withEmpty);
  assert.ok(Array.isArray(restoredEmpty.events), "已采集但无事件必须是 []，不能变成 null");
  assert.equal(restoredEmpty.events!.length, 0);
  const withEvent = roundTrip(buildExperimentReport(makeInput({ events: [makeEvent()] })));
  assert.deepEqual(validateExperimentReport(withEvent).events, [makeEvent()]);
});

test("comparison=null 合法；真实对照报告内嵌也合法", () => {
  assert.doesNotThrow(() => validateExperimentReport(roundTrip(buildExperimentReport(makeInput()))));
  const comparison = makeComparison();
  const report = buildExperimentReport(makeInput({ comparison }));
  const restored = validateExperimentReport(roundTrip(report));
  assert.deepEqual(restored.comparison, comparison);
  assert.notEqual(report.comparison, comparison, "内嵌对照必须是副本");
});

test("拒绝错误 schema / kind / restore", () => {
  const base = roundTrip(buildExperimentReport(makeInput())) as unknown as Record<string, unknown>;
  for (const [key, bad] of [
    ["schema", 2],
    ["kind", "quaternion-attitude-demo/archive"],
    ["restore", "config-only"],
  ] as const) {
    const raw = { ...base, [key]: bad };
    assert.throws(() => validateExperimentReport(raw), new RegExp(key), `应拒绝错误 ${key}`);
  }
});

test("拒绝 NaN / Infinity 且错误消息含路径", () => {
  const base = roundTrip(buildExperimentReport(makeInput())) as any;
  base.archive.run.elapsedSec = NaN;
  assert.throws(() => validateExperimentReport(base), /archive\.run\.elapsedSec.*非有限/);
  const base2 = roundTrip(buildExperimentReport(makeInput())) as any;
  base2.archive.run.metrics[0].mean = Infinity;
  assert.throws(() => validateExperimentReport(base2), /archive\.run\.metrics\[0\]\.mean.*非有限/);
  const badArchive = makeArchive();
  badArchive.run.elapsedSec = NaN;
  assert.throws(() => buildExperimentReport(makeInput({ archive: badArchive })), /档案/);
});

test("拒绝循环引用对象（不栈崩溃）", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const event = makeEvent();
  event.before = cyclic;
  assert.throws(() => buildExperimentReport(makeInput({ events: [event] })), /循环引用/);
  const raw = roundTrip(buildExperimentReport(makeInput())) as any;
  raw.events = raw;
  assert.throws(() => validateExperimentReport(raw), /循环引用/);
});

test("build=null（无构建信息）合法", () => {
  const report = buildExperimentReport(makeInput({ build: null }));
  assert.equal(report.build, null);
  const restored = validateExperimentReport(roundTrip(report));
  assert.equal(restored.build, null);
});

test("深拷贝：build 后修改输入不影响已生成报告", () => {
  const archive = makeArchive();
  const events = [makeEvent()];
  const report = buildExperimentReport(makeInput({ archive, events }));
  archive.run.elapsedSec = 999;
  archive.config.seed = 12345;
  archive.run.metrics[0].rmse = 99;
  events[0].summary = "改过";
  assert.equal(report.archive.run.elapsedSec, 12.5);
  assert.equal(report.archive.config.seed, defaultExperimentConfig().seed);
  assert.equal(report.archive.run.metrics[0].rmse, 2);
  assert.equal(report.events![0].summary, "参数变更");
});

test("内嵌对照浅校验：错误 kind/restore 拒绝，合法形状接受", () => {
  const good = makeComparison();
  const badKind = { ...good, kind: "quaternion-attitude-demo/archive" } as unknown as ComparisonReport;
  assert.throws(() => buildExperimentReport(makeInput({ comparison: badKind })), /comparison\.kind/);
  const badRestore = { ...good, restore: "config-only" } as unknown as ComparisonReport;
  const raw = roundTrip(buildExperimentReport(makeInput())) as unknown as Record<string, unknown>;
  assert.throws(() => validateExperimentReport({ ...raw, comparison: badRestore }), /comparison\.restore/);
  assert.doesNotThrow(() => validateExperimentReport({ ...raw, comparison: good }));
});

console.log(`experiment-report-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
