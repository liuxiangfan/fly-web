/**
 * F-02 学习活动的独立契约测试。
 *
 * 不启动浏览器、不依赖 main.ts：
 *  1. 5 道活动的数据完整性、证据指向现有实验、文档锚点真实存在；
 *  2. 三种预测类型的格式与范围校验；
 *  3. 预测—证据对照：一致 / 相反 / 无法判断，且不从文字反推对错；
 *  4. 状态机、预测锁定、运行绑定、旧 runRef 隔离、失败/取消不泄露答案；
 *  5. 反思原样保留、重新挑战保留历史、导出 JSON 安全、无 DOM/持久化。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cloneExperimentConfig, defaultExperimentConfig } from "../src/core/experiment-config";
import { DEG, RAD, qAngleBetween, qFromEuler } from "../src/core/quat";
import { runExperimentDetailed } from "../src/core/runner";
import { buildComparisonPair, COMPARISON_AFFECTED_PATHS, comparisonDiff } from "../src/core/comparison-config";
import { LEARNING_CLAIMS } from "../src/ui/learning-claims";
import { EXPERIMENTS } from "../src/ui/experiments";
import { LEARNING_ACTIVITIES, findLearningActivity } from "../src/ui/learning-activity-data";
import {
  PREDICTION_CAVEAT,
  comparePrediction,
  judgePrediction,
  parseLearningActivities,
  predictionLabel,
  type EvidencePredicate,
  type LearningActivity,
  type PredictionAnswer,
} from "../src/ui/learning-activities";
import {
  ATTEMPT_STATUSES,
  addReflection,
  bindRun,
  canReveal,
  cancelRun,
  completeRun as completeRunState,
  createActivityState,
  exportActivityRecord,
  failRun,
  restart as restartState,
  startAttempt as startAttemptState,
  submitPrediction as submitPredictionState,
  type ActivityState,
  type ActivityStateResult,
  type RunRef,
} from "../src/ui/activity-state";
import { configDigest, evidenceRunConfigs, teachingBaseConfig } from "../src/ui/learning-panel";

let pass = 0;
let fail = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const activitySource = readFileSync(
  new URL("../src/ui/learning-activities.ts", import.meta.url),
  "utf8",
);
const dataSource = readFileSync(
  new URL("../src/ui/learning-activity-data.ts", import.meta.url),
  "utf8",
);
const stateSource = readFileSync(new URL("../src/ui/activity-state.ts", import.meta.url), "utf8");

/**
 * 状态机现在只接受注入的查找函数，不再静态 import 数据模块。
 * 测试保留旧调用形状：把 data 模块的 findLearningActivity 作为最后一个参数传入。
 */
const startAttempt = (
  state: ActivityState,
  activityId: string,
  activityVersion: number,
): ActivityStateResult => startAttemptState(state, activityId, activityVersion, findLearningActivity);
const submitPrediction = (
  state: ActivityState,
  prediction: PredictionAnswer,
): ActivityStateResult => submitPredictionState(state, prediction, findLearningActivity);
const completeRun = (
  state: ActivityState,
  evidence: Parameters<typeof completeRunState>[1],
): ActivityStateResult => completeRunState(state, evidence, findLearningActivity);
const restart = (state: ActivityState): ActivityStateResult =>
  restartState(state, findLearningActivity);

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const docPages = new Set([...html.matchAll(/data-doc-page="([^"]+)"/g)].map((m) => m[1]));
const experimentIds = new Set(EXPERIMENTS.map((experiment) => experiment.id));

const EXPECTED_ACTIVITY_IDS = [
  "drift-linear-10s",
  "accel-yaw-unobservable",
  "mahony-ki-bias",
  "gimbal-lock-two-controls",
  "sensor-delay-omega-tau",
] as const;
const MAIN_ACTIVITY = "drift-linear-10s";
const MULTI_ACTIVITY = "accel-yaw-unobservable";
const CHOICE_ACTIVITY = "mahony-ki-bias";
const DELAY_ACTIVITY = "sensor-delay-omega-tau";
const VALID_ESTIMATORS = new Set(["pure", "comp", "mahony", "madg", "kalman"]);
const VALID_METRICS = new Set([
  "n",
  "mean",
  "rmse",
  "max",
  "p50",
  "p95",
  "steadyRmse",
  "tiltRmse",
  "yawRmse",
  "convergedAt",
  "gateRejects",
]);

function activity(id: string): LearningActivity {
  const found = findLearningActivity(id);
  assert.ok(found, `缺少活动：${id}`);
  return found;
}

function validAnswerFor(item: LearningActivity): PredictionAnswer {
  if (item.answerKind === "single") {
    assert.ok(item.choices && item.choices.length > 0, `${item.id} 缺选项`);
    return { kind: "single", choiceId: item.choices[0].id };
  }
  if (item.answerKind === "multiple") {
    assert.ok(item.choices && item.choices.length > 0, `${item.id} 缺选项`);
    return { kind: "multiple", choiceIds: item.choices.map((choice) => choice.id) };
  }
  return { kind: "range", min: 1, max: 10, unit: "°" };
}

function expectOk(result: ActivityStateResult): ActivityState {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  assert.ok(result.state.current, "成功结果必须带当前 attempt");
  return result.state;
}

function expectFail(result: ActivityStateResult, code?: string, message?: string): void {
  assert.equal(result.ok, false, message ?? "预期操作失败，但返回成功");
  if (result.ok) return;
  if (code) assert.equal(result.code, code, `错误码应为 ${code}，实际 ${result.code}`);
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

function cloneState(state: ActivityState): ActivityState {
  return JSON.parse(JSON.stringify(state)) as ActivityState;
}

function cloneActivity(item: LearningActivity): LearningActivity {
  return JSON.parse(JSON.stringify(item)) as LearningActivity;
}

test("活动数据完整性：恰好 5 道，ID 唯一，字段与证据齐全", () => {
  assert.equal(LEARNING_ACTIVITIES.length, 5, "首批必须恰好 5 道题");
  assert.deepEqual(
    [...LEARNING_ACTIVITIES.map((item) => item.id)].sort(),
    [...EXPECTED_ACTIVITY_IDS].sort(),
    "活动 id 与首批题目清单不一致",
  );

  const kinds = new Set(["single", "multiple", "range"]);
  const ids = new Set<string>();
  for (const item of LEARNING_ACTIVITIES) {
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${item.id} 不是稳定 slug`);
    assert.equal(ids.has(item.id), false, `活动 id 重复：${item.id}`);
    ids.add(item.id);
    assert.ok(Number.isInteger(item.version) && item.version >= 1, `${item.id} version 非法`);

    for (const field of ["title", "prompt", "conditionsText", "explanation"] as const) {
      assert.ok(item[field].trim().length > 0, `${item.id} 缺 ${field}`);
    }
    assert.ok(kinds.has(item.answerKind), `${item.id} answerKind 非法`);
    assert.ok(item.doc.page.trim().length > 0, `${item.id} 缺文档页`);
    assert.ok(item.evidence.metric.trim().length > 0, `${item.id} 缺 metric`);
    assert.ok(
      VALID_ESTIMATORS.has(item.evidence.estimatorId),
      `${item.id} estimatorId 非法：${item.evidence.estimatorId}`,
    );
    assert.ok(
      VALID_METRICS.has(item.evidence.metric),
      `${item.id} metric 未登记：${item.evidence.metric}`,
    );
    if (item.predictionHint !== undefined) {
      assert.ok(item.predictionHint.trim().length > 0, `${item.id} predictionHint 为空`);
    }

    if (item.answerKind === "range") {
      assert.equal(item.choices, undefined, `${item.id} 数值范围题不应带选项`);
      assert.ok(item.expectedRange, `${item.id} 数值题必须声明合理证据区间`);
    } else {
      assert.ok(
        Array.isArray(item.choices) && item.choices.length >= 2,
        `${item.id} 选项不足`,
      );
      const choiceIds = new Set<string>();
      for (const choice of item.choices) {
        assert.ok(choice.id.trim().length > 0, `${item.id} 选项 id 为空`);
        assert.ok(choice.text.trim().length > 0, `${item.id} 选项文本为空`);
        assert.equal(choiceIds.has(choice.id), false, `${item.id} 选项 id 重复：${choice.id}`);
        choiceIds.add(choice.id);
      }
      assert.ok(
        Array.isArray(item.correctChoiceIds) && item.correctChoiceIds.length > 0,
        `${item.id} 缺 correctChoiceIds`,
      );
      for (const choiceId of item.correctChoiceIds!) {
        assert.ok(choiceIds.has(choiceId), `${item.id} correctChoiceIds 引用未知选项：${choiceId}`);
      }
      if (item.answerKind === "single") {
        assert.equal(item.correctChoiceIds!.length, 1, `${item.id} 单选题必须恰好一个正确项`);
      }
    }

    if (item.expectedRange) {
      const expected = item.expectedRange;
      assert.ok(
        Number.isFinite(expected.min) &&
          Number.isFinite(expected.max) &&
          expected.min < expected.max,
        `${item.id} expectedRange 边界非法`,
      );
      assert.ok(expected.unit.trim().length > 0, `${item.id} expectedRange 缺单位`);
    }

    if (item.evidence.kind === "live") {
      assert.ok(item.evidence.experimentId, `${item.id} live 证据缺 experimentId`);
      assert.ok(
        experimentIds.has(item.evidence.experimentId!),
        `${item.id} 引用了不存在的实验：${item.evidence.experimentId}`,
      );
    } else {
      assert.ok(
        item.evidence.comparisonVariableId,
        `${item.id} comparison 证据缺 comparisonVariableId`,
      );
    }
  }

  assert.deepEqual(activity(MAIN_ACTIVITY).expectedRange, { min: 15, max: 25, unit: "°" });
  assert.deepEqual(activity(DELAY_ACTIVITY).expectedRange, { min: 4, max: 8, unit: "°" });
});

test("FIX-01 证据模型：五题的 evidencePatch / evidencePredicates 与方案一致", () => {
  const drift = activity(MAIN_ACTIVITY);
  assert.deepEqual(drift.evidencePatch, {
    durationSec: 10,
    scenario: "hover",
    initialAttitude: { kind: "level" },
    imu: { gyroBiasDps: 2, gyroNoiseDps: 0, linAccel: 0, vibration: 0 },
    estimators: { pure: { enabled: true } },
  });
  assert.equal(drift.evidencePredicates, undefined, "数值题用 comparePrediction，不用选项谓词");

  const yaw = activity(MULTI_ACTIVITY);
  assert.deepEqual(yaw.evidencePatch, {
    durationSec: 10,
    scenario: "hover",
    magEnabled: false,
    autoCoarseAlign: false,
    initialAttitude: { kind: "fixed-axis", axis: [1, 0, 0], angleDeg: 30 },
    estimators: {
      mahony: { enabled: true, magEnabled: false, accelGate: false, params: { kp: 1, ki: 0.05 } },
    },
  });
  assert.deepEqual(yaw.evidenceRuns, [
    { id: "B", patch: { estimators: { mahony: { params: { kp: 0, ki: 0 } } } } },
    {
      id: "C",
      patch: {
        initialAttitude: { kind: "fixed-axis", axis: [0, 0, 1], angleDeg: 30 },
        estimators: { mahony: { params: { kp: 1, ki: 0.05 } } },
      },
    },
  ]);
  assert.deepEqual(yaw.evidencePredicates, {
    "tilt-fixable": {
      kind: "metric-compare-runs",
      estimator: "mahony",
      metric: "tiltRmse",
      op: "lt",
      run: "A",
      otherRun: "B",
      minDelta: 20,
    },
    "yaw-fixable": { kind: "always-false" },
    "gravity-axis": { kind: "always-true" },
    "gain-fix": { kind: "always-false" },
    "external-heading": {
      kind: "metric-range",
      estimator: "mahony",
      metric: "yawRmse",
      run: "C",
      min: 10,
    },
  });

  const ki = activity(CHOICE_ACTIVITY);
  assert.equal(ki.evidence.run, "B");
  assert.deepEqual(ki.evidencePatch, {
    durationSec: 20,
    scenario: "hover",
    magEnabled: true,
    initialAttitude: { kind: "level" },
    imu: { gyroBiasDps: 2 },
    estimators: { mahony: { enabled: true, magEnabled: true, params: { ki: 0 } } },
  });
  assert.deepEqual(ki.evidenceRuns, [
    { id: "B", patch: { estimators: { mahony: { params: { ki: 0.05 } } } } },
  ]);
  assert.deepEqual(ki.evidencePredicates, {
    "integral-removes-step": {
      kind: "metric-compare-runs",
      estimator: "mahony",
      metric: "steadyRmse",
      op: "lt",
      run: "B",
      otherRun: "A",
      minDelta: 0.5,
    },
    "both-remove-step": { kind: "always-false" },
    "larger-always-better": { kind: "always-false" },
    "startup-only": { kind: "always-false" },
  });

  const gimbal = activity("gimbal-lock-two-controls");
  assert.equal(gimbal.evidencePatch, undefined, "几何题不需要 runner");
  assert.deepEqual(gimbal.evidencePredicates, {
    "same-pose": { kind: "always-true" },
    "different-120": { kind: "always-false" },
    "different-same-accel": { kind: "always-false" },
    "undefined": { kind: "always-false" },
  });

  const delay = activity(DELAY_ACTIVITY);
  assert.deepEqual(delay.evidencePatch, {
    durationSec: 5,
    scenario: "violent",
    initialAttitude: { kind: "level" },
    imu: { sensorDelayMs: 25, gyroBiasDps: 0, gyroNoiseDps: 0 },
    estimators: { pure: { enabled: true } },
  });

  for (const item of LEARNING_ACTIVITIES) {
    if (item.answerKind === "range") continue;
    assert.ok(item.evidencePredicates, `${item.id} 选项题必须提供谓词`);
    const keys = Object.keys(item.evidencePredicates!).sort();
    const choiceIds = item.choices!.map((choice) => choice.id).sort();
    assert.deepEqual(keys, choiceIds, `${item.id} 谓词必须覆盖全部选项`);
    for (const id of item.correctChoiceIds ?? []) {
      const predicate: EvidencePredicate | undefined = item.evidencePredicates![id];
      assert.ok(
        predicate && predicate.kind !== "always-false",
        `${item.id} 正确项 ${id} 不能是 always-false`,
      );
    }
    for (const choice of item.choices ?? []) {
      if ((item.correctChoiceIds ?? []).includes(choice.id)) continue;
      assert.equal(
        item.evidencePredicates![choice.id].kind,
        "always-false",
        `${item.id} 错误项 ${choice.id} 必须是 always-false`,
      );
    }
  }
});

test("FIX-01 目录解析：非法 patch / 谓词 / 运行引用被拒绝", () => {
  const drift = activity(MAIN_ACTIVITY);
  const zeroDuration = cloneActivity(drift);
  zeroDuration.evidencePatch!.durationSec = 0;
  assert.ok(
    parseLearningActivities([zeroDuration]).errors.some((error) =>
      error.includes("durationSec"),
    ),
  );

  const unknownEstimator = cloneActivity(drift);
  unknownEstimator.evidencePatch!.estimators = {
    bogus: { enabled: true },
  } as never;
  assert.ok(
    parseLearningActivities([unknownEstimator]).errors.some((error) =>
      error.includes("未知算法"),
    ),
  );

  const unknownParam = cloneActivity(drift);
  unknownParam.evidencePatch!.estimators = { pure: { params: { mystery: 1 } } };
  assert.ok(
    parseLearningActivities([unknownParam]).errors.some((error) =>
      error.includes("未知参数键"),
    ),
  );

  const badInitial = cloneActivity(drift);
  badInitial.evidencePatch!.initialAttitude = { kind: "bogus" } as never;
  assert.ok(
    parseLearningActivities([badInitial]).errors.some((error) =>
      error.includes("initialAttitude.kind"),
    ),
  );

  const yaw = activity(MULTI_ACTIVITY);
  const badMetric = cloneActivity(yaw);
  badMetric.evidencePredicates!["tilt-fixable"] = {
    kind: "metric-range",
    estimator: "mahony",
    metric: "mystery",
    max: 5,
  };
  assert.ok(
    parseLearningActivities([badMetric]).errors.some((error) => error.includes("metric 未登记")),
  );

  const missingPredicate = cloneActivity(yaw);
  delete missingPredicate.evidencePredicates!["gain-fix"];
  assert.ok(
    parseLearningActivities([missingPredicate]).errors.some((error) =>
      error.includes("缺少 evidencePredicate"),
    ),
  );

  const badOp = cloneActivity(yaw);
  badOp.evidencePredicates!["tilt-fixable"] = {
    kind: "metric-compare",
    estimator: "mahony",
    metric: "tiltRmse",
    op: "between",
    value: 1,
  } as never;
  assert.ok(
    parseLearningActivities([badOp]).errors.some((error) => error.includes(".op")),
  );

  const ki = activity(CHOICE_ACTIVITY);
  const badRun = cloneActivity(ki);
  badRun.evidencePredicates!["integral-removes-step"] = {
    kind: "metric-compare-runs",
    estimator: "mahony",
    metric: "steadyRmse",
    op: "lt",
    run: "C",
    otherRun: "A",
  };
  assert.ok(
    parseLearningActivities([badRun]).errors.some((error) =>
      error.includes("已存在的运行"),
    ),
  );

  const runsWithoutPatch = cloneActivity(ki);
  delete runsWithoutPatch.evidencePatch;
  assert.ok(
    parseLearningActivities([runsWithoutPatch]).errors.some((error) =>
      error.includes("evidencePatch 作为基线"),
    ),
  );

  const rangeWithPredicates = cloneActivity(drift);
  rangeWithPredicates.evidencePredicates = {
    x: { kind: "always-true" },
  };
  assert.ok(
    parseLearningActivities([rangeWithPredicates]).errors.some((error) =>
      error.includes("数值范围题不应带 evidencePredicates"),
    ),
  );

  const metricsWithoutPatch = cloneActivity(yaw);
  delete metricsWithoutPatch.evidencePatch;
  assert.ok(
    parseLearningActivities([metricsWithoutPatch]).errors.some((error) =>
      error.includes("必须提供 evidencePatch"),
    ),
  );

  assert.deepEqual(parseLearningActivities(LEARNING_ACTIVITIES).errors, []);
});

test("FIX-01 实测反例：patch 真跑后落在题面区间/谓词成立", () => {
  const drift = activity(MAIN_ACTIVITY);
  const driftRuns = evidenceRunConfigs(teachingBaseConfig(), drift);
  assert.equal(driftRuns.length, 1);
  const driftResult = runExperimentDetailed(driftRuns[0].config);
  const driftPure = driftResult.metrics.find((item) => item.id === "pure")!;
  assert.equal(driftResult.termination.reason, "completed");
  assert.ok(
    driftPure.max >= 15 && driftPure.max <= 25,
    `pure.max=${driftPure.max} 不在 15–25°`,
  );

  const yaw = activity(MULTI_ACTIVITY);
  const yawConfigs = evidenceRunConfigs(teachingBaseConfig(), yaw);
  assert.deepEqual(yawConfigs.map((item) => item.id), ["A", "B", "C"]);
  const yawMetrics = yawConfigs.map((item) => {
    const result = runExperimentDetailed(item.config);
    assert.equal(result.termination.reason, "completed");
    return result.metrics.find((metric) => metric.id === "mahony")!;
  });
  assert.ok(
    yawMetrics[0].tiltRmse < yawMetrics[1].tiltRmse - 20,
    `修正组 tilt=${yawMetrics[0].tiltRmse} 应比无修正组 ${yawMetrics[1].tiltRmse} 低至少 20°`,
  );
  assert.ok(yawMetrics[2].yawRmse > 10, `纯偏航组 yaw=${yawMetrics[2].yawRmse} 应 > 10°`);
  assert.ok(yawMetrics[2].tiltRmse < 5, `纯偏航组 tilt=${yawMetrics[2].tiltRmse} 应 < 5°`);

  const ki = activity(CHOICE_ACTIVITY);
  const kiConfigs = evidenceRunConfigs(teachingBaseConfig(), ki);
  assert.deepEqual(kiConfigs.map((item) => item.id), ["A", "B"]);
  const steady = kiConfigs.map((item) => {
    const result = runExperimentDetailed(item.config);
    assert.equal(result.termination.reason, "completed");
    return result.metrics.find((metric) => metric.id === "mahony")!.steadyRmse;
  });
  assert.ok(steady[1] < steady[0], `B.steady=${steady[1]} 应小于 A.steady=${steady[0]}`);

  const delay = activity(DELAY_ACTIVITY);
  const delayResult = runExperimentDetailed(
    evidenceRunConfigs(teachingBaseConfig(), delay)[0].config,
  );
  const delayPure = delayResult.metrics.find((item) => item.id === "pure")!;
  assert.ok(
    delayPure.max >= 4 && delayPure.max <= 8,
    `delay pure.max=${delayPure.max} 不在 4–8°`,
  );

  // 几何题：俯仰 90° 时横滚 +60° 与偏航 −60° 是同一姿态（与演示同一公式）。
  const rollAtLock = qFromEuler(60 * RAD, 90 * RAD, 0);
  const yawAtLock = qFromEuler(0, 90 * RAD, -60 * RAD);
  assert.ok(
    qAngleBetween(rollAtLock, yawAtLock) * DEG < 1e-9,
    "锁点上横滚/偏航应得到同一姿态",
  );
});

test("TR-04 Ki 永久反例：0.5 在当前窗口更低，错误项只能是否定普适保证", () => {
  const ki = activity(CHOICE_ACTIVITY);
  const configs = evidenceRunConfigs(teachingBaseConfig(), ki);
  const high = cloneExperimentConfig(configs[1].config);
  high.estimators.mahony.params.ki = 0.5;
  const steady = [...configs.map((run) => run.config), high].map((config) => {
    const result = runExperimentDetailed(config);
    assert.equal(result.termination.reason, "completed");
    const metric = result.metrics.find((item) => item.id === "mahony")!;
    assert.equal(metric.n, 10000);
    assert.equal(metric.steadyMode, "exact");
    return metric.steadyRmse;
  });
  console.log(`Ki 20 s steadyRmse：0=${steady[0]}，0.05=${steady[1]}，0.5=${steady[2]}，A−B=${steady[0] - steady[1]}°`);
  assert.ok(steady[2] < steady[1], "固定窗口内 Ki=0.5 确实更低，不能把这一事实判假");
  assert.deepEqual(ki.choices!.map((choice) => choice.id), [
    "integral-removes-step", "both-remove-step", "larger-always-better", "startup-only",
  ], "必须保留四个选项及稳定 id");
  const wrong = ki.choices!.find((choice) => choice.id === "larger-always-better")!;
  assert.match(wrong.text, /无论|任何条件/, "静态 false 只能绑定错误的普适命题");
  assert.match(wrong.text, /绝不.*(?:超调|振荡)/, "错误项应声称无条件无超调/振荡");
  assert.doesNotMatch(wrong.text, /本题窗口内|Ki=0\.5.*低于/, "不得把本窗口成立的比较当反例");
  assert.match(ki.explanation, /Ki=0\.5.*更低/, "解释必须承认本窗口 0.5 更低");
});

test("FIX-01 证据配置与摘要：patch 覆盖现场，摘要随条件变化", () => {
  const drift = activity(MAIN_ACTIVITY);
  const baseA = defaultExperimentConfig();
  const baseB = defaultExperimentConfig();
  baseB.durationSec = 42;
  baseB.imu.gyroBiasDps = 7;
  baseB.imu.gyroNoiseDps = 0.9;
  baseB.imu.linAccel = 3;
  baseB.imu.vibration = 1;
  baseB.scenario = "violent";
  baseB.estimators.pure.enabled = false;

  const runA = evidenceRunConfigs(baseA, drift)[0];
  const runB = evidenceRunConfigs(baseB, drift)[0];
  assert.equal(runA.config.durationSec, 10);
  assert.equal(runB.config.durationSec, 10);
  assert.equal(runA.config.imu.gyroBiasDps, 2);
  assert.equal(runB.config.imu.gyroBiasDps, 2);
  assert.equal(runA.config.scenario, "hover");
  assert.equal(runB.config.scenario, "hover");
  assert.equal(runA.config.estimators.pure.enabled, true);
  assert.equal(runB.config.estimators.pure.enabled, true);
  assert.equal(runA.digest, runB.digest, "被 patch 覆盖的现场值不得改变摘要");
  assert.equal(configDigest(runA.config), runA.digest);
  assert.match(runA.digest, /^[0-9a-f]{16}$/);

  const delay = activity(DELAY_ACTIVITY);
  const delayRun = evidenceRunConfigs(baseA, delay)[0];
  assert.notEqual(delayRun.digest, runA.digest);
});

test("活动目录解析：合法目录原样通过，重复 id / 未知指标 / 缺正确项被拒绝", () => {
  const parsed = parseLearningActivities(LEARNING_ACTIVITIES);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.activities, LEARNING_ACTIVITIES);

  const duplicate = [LEARNING_ACTIVITIES[0], { ...LEARNING_ACTIVITIES[0] }];
  const duplicateParsed = parseLearningActivities(duplicate);
  assert.ok(duplicateParsed.errors.some((error) => error.includes("id 重复")), duplicateParsed.errors.join("；"));
  assert.deepEqual(duplicateParsed.activities, [], "有错误时整份目录拒绝加载");

  const badMetric = [{ ...LEARNING_ACTIVITIES[0], evidence: { ...LEARNING_ACTIVITIES[0].evidence, metric: "mystery" } }];
  assert.ok(
    parseLearningActivities(badMetric).errors.some((error) => error.includes("metric 未登记")),
    "未知指标必须被拒绝",
  );

  const choice = activity(MULTI_ACTIVITY);
  const missingCorrect = [{ ...choice, correctChoiceIds: undefined }];
  assert.ok(
    parseLearningActivities(missingCorrect).errors.some((error) => error.includes("correctChoiceIds")),
    "选项题缺少正确项必须被拒绝",
  );

  const badCorrect = [{ ...choice, correctChoiceIds: ["not-a-choice"] }];
  assert.ok(
    parseLearningActivities(badCorrect).errors.some((error) => error.includes("不存在的选项")),
    "正确项引用未知选项必须被拒绝",
  );

  assert.deepEqual(parseLearningActivities(null).activities, []);
  assert.ok(parseLearningActivities([]).errors.length > 0);
});

test("文档页与锚点真实存在，且 5 道题都指回 labs#l-exercise", () => {
  for (const item of LEARNING_ACTIVITIES) {
    assert.ok(docPages.has(item.doc.page), `${item.id} 文档页不存在：${item.doc.page}`);
    if (item.doc.anchor) {
      assert.ok(htmlIds.has(item.doc.anchor), `${item.id} 文档锚点不存在：${item.doc.anchor}`);
    }
    assert.equal(item.doc.page, "labs", `${item.id} 应指向实验与练习页`);
    assert.equal(item.doc.anchor, "l-exercise", `${item.id} 应指向 12 道练习小节`);
  }
});

test("预测格式校验：三种类型、范围边界与非法输入", () => {
  for (const item of LEARNING_ACTIVITIES) {
    const valid = validAnswerFor(item);
    const before = snapshot({ item, valid });
    const judged = judgePrediction(item, valid);
    assert.equal(judged.validated, true, `${item.id}: ${judged.errors.join("；")}`);
    assert.deepEqual(judged.errors, []);
    assert.equal(snapshot({ item, valid }), before, "judgePrediction 不得修改输入");
    assert.ok(predictionLabel(item, valid).length > 0, `${item.id} 预测文本为空`);
  }

  const drift = activity(MAIN_ACTIVITY);
  assert.equal(judgePrediction(drift, { kind: "range", min: 15, max: 25, unit: "°" }).validated, true);
  assert.equal(
    judgePrediction(drift, { kind: "range", min: null, max: 25, unit: "°" }).validated,
    true,
  );
  assert.equal(
    judgePrediction(drift, { kind: "range", min: 15, max: null, unit: "°" }).validated,
    true,
  );
  const wrongUnit = judgePrediction(drift, { kind: "range", min: 15, max: 25, unit: "rad" });
  assert.equal(wrongUnit.validated, false, "单位必须与题面一致");
  assert.ok(wrongUnit.errors.some((error) => error.includes("单位")), wrongUnit.errors.join("；"));
  const badRanges = [
    { kind: "range", min: null, max: null, unit: "°" },
    { kind: "range", min: Number.NaN, max: 25, unit: "°" },
    { kind: "range", min: 0, max: Number.POSITIVE_INFINITY, unit: "°" },
    { kind: "range", min: 30, max: 10, unit: "°" },
    { kind: "range", min: 1, max: 2, unit: "   " },
  ] as PredictionAnswer[];
  for (const bad of badRanges) {
    assert.equal(judgePrediction(drift, bad).validated, false, `应拒绝 ${String(bad)}`);
  }
  assert.equal(judgePrediction(drift, { kind: "single", choiceId: "x" }).validated, false);
  assert.equal(judgePrediction(drift, null as unknown as PredictionAnswer).validated, false);
  assert.equal(
    judgePrediction(null as unknown as LearningActivity, validAnswerFor(drift)).validated,
    false,
  );

  const single = activity(CHOICE_ACTIVITY);
  assert.equal(
    judgePrediction(single, { kind: "single", choiceId: single.choices![0].id }).validated,
    true,
  );
  assert.equal(
    judgePrediction(single, { kind: "single", choiceId: "not-a-choice" }).validated,
    false,
  );
  assert.equal(judgePrediction(single, { kind: "single", choiceId: "" }).validated, false);
  assert.equal(
    judgePrediction(single, { kind: "multiple", choiceIds: [single.choices![0].id] }).validated,
    false,
  );

  const multi = activity(MULTI_ACTIVITY);
  const allIds = multi.choices!.map((choice) => choice.id);
  assert.equal(judgePrediction(multi, { kind: "multiple", choiceIds: allIds }).validated, true);
  assert.equal(judgePrediction(multi, { kind: "multiple", choiceIds: [] }).validated, false);
  assert.equal(
    judgePrediction(multi, { kind: "multiple", choiceIds: [allIds[0], allIds[0]] }).validated,
    false,
  );
  assert.equal(
    judgePrediction(multi, { kind: "multiple", choiceIds: [allIds[0], "not-a-choice"] }).validated,
    false,
  );
  assert.equal(
    judgePrediction(multi, {
      kind: "multiple",
      choiceIds: [42 as unknown as string],
    }).validated,
    false,
  );

  const rangeLabel = predictionLabel(drift, { kind: "range", min: 15, max: 25, unit: "°" });
  assert.ok(rangeLabel.includes("15") && rangeLabel.includes("25") && rangeLabel.includes("°"));
  const multiLabel = predictionLabel(multi, { kind: "multiple", choiceIds: allIds });
  assert.ok(multiLabel.includes(multi.choices![0].text), "多选文本应包含选项原文");
});

test("预测对照：范围内外、错误直觉、文字证据不越权", () => {
  const drift = activity(MAIN_ACTIVITY);
  const prediction = { kind: "range", min: 15, max: 25, unit: "°" } as const;

  const hit = comparePrediction(drift, prediction, { numeric: 20, text: "10 s 实测约 20°" });
  assert.equal(hit.verdict, "consistent");
  assert.ok(hit.explanation.includes("20"), hit.explanation);
  assert.ok(hit.explanation.includes("范围"), hit.explanation);
  assert.ok(hit.explanation.includes(PREDICTION_CAVEAT), "必须附带不推断学习效果的提醒");

  const miss = comparePrediction(
    drift,
    { kind: "range", min: 0, max: 10, unit: "°" },
    { numeric: 20 },
  );
  assert.equal(miss.verdict, "inconsistent");
  assert.ok(miss.explanation.includes("范围之外"), miss.explanation);

  const outOfConditions = comparePrediction(drift, prediction, { numeric: 30 });
  assert.equal(
    outOfConditions.verdict,
    "undetermined",
    "实测值超出题面合理区间时应先怀疑运行条件",
  );
  assert.ok(outOfConditions.explanation.includes("合理区间"), outOfConditions.explanation);

  const unitMismatch = comparePrediction(
    drift,
    { kind: "range", min: 15, max: 25, unit: "rad" },
    { numeric: 20 },
  );
  assert.equal(unitMismatch.verdict, "undetermined", "单位不一致不得直接比较数值");

  assert.equal(
    comparePrediction(drift, { kind: "range", min: null, max: 10, unit: "°" }, { numeric: 20 })
      .verdict,
    "inconsistent",
  );
  assert.equal(
    comparePrediction(drift, { kind: "range", min: 15, max: null, unit: "°" }, { numeric: 20 })
      .verdict,
    "consistent",
  );
  assert.equal(comparePrediction(drift, prediction, { numeric: 15 }).verdict, "consistent");
  assert.equal(comparePrediction(drift, prediction, { numeric: 25 }).verdict, "consistent");
  assert.equal(
    comparePrediction(drift, prediction, { numeric: Number.NaN }).verdict,
    "undetermined",
  );
  assert.equal(
    comparePrediction(drift, prediction, { text: "实测约 20°" }).verdict,
    "undetermined",
    "只有文字证据时不得猜测数值范围",
  );
  assert.equal(comparePrediction(drift, prediction, null).verdict, "undetermined");
  assert.equal(
    comparePrediction(drift, prediction, {
      numeric: 20,
      passed: "yes" as unknown as boolean,
    }).verdict,
    "undetermined",
  );
  assert.equal(
    comparePrediction(drift, prediction, {
      numeric: 20,
      text: 42 as unknown as string,
    }).verdict,
    "undetermined",
  );
  assert.equal(
    comparePrediction(drift, null as unknown as PredictionAnswer, { numeric: 20 }).verdict,
    "undetermined",
  );

  const single = activity(CHOICE_ACTIVITY);
  const correct = { kind: "single", choiceId: "integral-removes-step" } as const;
  const wrong = { kind: "single", choiceId: "larger-always-better" } as const;
  const supported = comparePrediction(single, correct, { passed: true });
  assert.equal(supported.verdict, "consistent");
  assert.ok(supported.explanation.includes(PREDICTION_CAVEAT));

  const refuted = comparePrediction(single, wrong, {
    passed: false,
    text: "理论上增大 Ki 会降低可观测轴局部模型的阻尼；本窗口未实测振荡",
  });
  assert.equal(refuted.verdict, "inconsistent", "错误直觉必须被判为与证据相反");
  assert.ok(refuted.explanation.includes("相反"), refuted.explanation);
  assert.ok(!refuted.explanation.includes("你已经掌握"), "不得把一次结果包装成学习结论");

  assert.equal(
    comparePrediction(single, correct, { numeric: 2 }).verdict,
    "undetermined",
    "选项题不能只凭数值判定",
  );
  assert.equal(comparePrediction(single, correct, {}).verdict, "undetermined");

  const multi = activity(MULTI_ACTIVITY);
  const all = {
    kind: "multiple",
    choiceIds: multi.choices!.map((choice) => choice.id),
  } as const;
  const partial: PredictionAnswer = { kind: "multiple", choiceIds: ["tilt-fixable", "gravity-axis"] };
  assert.equal(comparePrediction(multi, all, { passed: true }).verdict, "consistent");
  assert.equal(comparePrediction(multi, partial, { passed: false }).verdict, "inconsistent");
  assert.ok(
    comparePrediction(multi, partial, { passed: false }).explanation.includes("整题口径"),
    "多选必须声明整题口径",
  );
  assert.equal(
    comparePrediction(multi, all, { text: "倾角收敛、偏航不收敛" }).verdict,
    "undetermined",
  );
});

test("状态机：answering→predicted→running→ready→reviewing", () => {
  const item = activity(MAIN_ACTIVITY);
  let state = createActivityState();
  assert.equal(state.current, null, "idle 由 current=null 表示");
  assert.equal(canReveal(state), false);

  state = expectOk(startAttempt(state, item.id, item.version));
  assert.equal(state.current!.status, "answering");
  assert.equal(state.current!.attemptId, 1);
  assert.equal(state.current!.prediction, null);
  assert.equal(canReveal(state), false);

  expectFail(startAttempt(state, item.id, item.version), "wrong-status");
  assert.equal(state.current!.status, "answering", "失败的 startAttempt 不得改状态");

  const prediction = { kind: "range", min: 15, max: 25, unit: "°" } as const;
  const submitted = expectOk(submitPrediction(state, prediction));
  assert.equal(submitted.current!.status, "predicted");
  assert.ok(submitted.current!.predictionText.includes("15"));
  assert.ok(submitted.current!.predictionText.includes("25"));
  assert.equal(canReveal(submitted), false);

  (prediction as { max: number }).max = 99;
  assert.equal(
    (submitted.current!.prediction as { max: number }).max,
    25,
    "预测必须锁定为提交时的副本",
  );

  const beforeDuplicate = snapshot(submitted);
  expectFail(
    submitPrediction(submitted, { kind: "range", min: 15, max: 25, unit: "°" }),
    "prediction-locked",
  );
  assert.equal(snapshot(submitted), beforeDuplicate, "重复提交不得改写状态");

  const runRef: RunRef = { kind: "live", id: 7 };
  const running = expectOk(bindRun(submitted, runRef));
  assert.equal(running.current!.status, "running");
  assert.deepEqual(running.current!.runRef, runRef);
  expectFail(bindRun(running, { kind: "live", id: 8 }), "run-already-bound");
  expectFail(
    completeRun(running, { attemptId: 1, runRef: { kind: "live", id: 8 }, numeric: 20 }),
    "stale-run",
  );
  expectFail(completeRun(running, { attemptId: 2, runRef, numeric: 20 }), "stale-run");
  expectFail(
    completeRun(running, { attemptId: 1, runRef, numeric: Number.NaN }),
    "invalid-evidence",
  );

  const ready = expectOk(
    completeRun(running, {
      attemptId: 1,
      runRef,
      numeric: 20,
      text: "10 s 实测约 20°",
    }),
  );
  assert.equal(ready.current!.status, "ready");
  assert.equal(ready.current!.evidence!.attemptId, 1);
  assert.deepEqual(ready.current!.evidence!.runRef, runRef);
  assert.equal(ready.current!.comparison!.verdict, "consistent");
  assert.equal(canReveal(ready), true);
  expectFail(completeRun(ready, { attemptId: 1, runRef, numeric: 20 }), "wrong-status");

  const reflection = '<script>alert("x")</script> 我修正后的理解';
  const reviewing = expectOk(addReflection(ready, reflection));
  assert.equal(reviewing.current!.status, "reviewing");
  assert.equal(reviewing.current!.reflection, reflection, "反思必须原样保留");
  assert.ok(!reviewing.current!.reflection.includes("&lt;"), "状态层不得转义反思");
  assert.equal(canReveal(reviewing), true);

  const record = exportActivityRecord(reviewing);
  assert.equal(record.schema, "learning-activity-record/v1");
  assert.equal(record.activityId, item.id);
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].reflection, reflection);
  assert.equal(record.attempts[0].comparison!.verdict, "consistent");
  assert.doesNotThrow(() => JSON.stringify(record));
});

test("重新挑战：历史保留，旧 runRef 不能完成新尝试", () => {
  const item = activity(MAIN_ACTIVITY);
  let state = createActivityState();
  state = expectOk(startAttempt(state, item.id, item.version));
  state = expectOk(
    submitPrediction(state, { kind: "range", min: 15, max: 25, unit: "°" }),
  );
  state = expectOk(bindRun(state, { kind: "live", id: 10 }));
  state = expectOk(
    completeRun(state, { attemptId: 1, runRef: { kind: "live", id: 10 }, numeric: 20 }),
  );
  state = expectOk(addReflection(state, "第一轮反思"));

  const beforeRestart = snapshot(state);
  const second = expectOk(restart(state));
  assert.equal(second.current!.status, "answering");
  assert.equal(second.current!.attemptId, 2);
  assert.equal(second.history.length, 1, "旧 attempt 必须进入历史");
  assert.equal(second.history[0].attemptId, 1);
  assert.equal(second.history[0].status, "reviewing");
  assert.equal(second.history[0].reflection, "第一轮反思");
  assert.equal(second.history[0].comparison!.verdict, "consistent");
  assert.equal(canReveal(second), false);
  assert.equal(snapshot(state), beforeRestart, "restart 不得修改旧 state");

  let next = expectOk(
    submitPrediction(second, { kind: "range", min: 15, max: 25, unit: "°" }),
  );
  next = expectOk(bindRun(next, { kind: "live", id: 11 }));
  const beforeStale = snapshot(next);
  expectFail(
    completeRun(next, { attemptId: 1, runRef: { kind: "live", id: 10 }, numeric: 20 }),
    "stale-run",
  );
  expectFail(
    completeRun(next, { attemptId: 2, runRef: { kind: "live", id: 10 }, numeric: 20 }),
    "stale-run",
    "旧 runRef 不能完成新 attempt",
  );
  expectFail(
    completeRun(next, { attemptId: 1, runRef: { kind: "live", id: 11 }, numeric: 20 }),
    "stale-run",
  );
  assert.equal(snapshot(next), beforeStale, "stale 结果不得改写状态");

  const ready = expectOk(
    completeRun(next, { attemptId: 2, runRef: { kind: "live", id: 11 }, numeric: 20 }),
  );
  assert.equal(ready.current!.status, "ready");
  const record = exportActivityRecord(ready);
  assert.equal(record.attempts.length, 2);
  assert.deepEqual(record.attempts.map((attempt) => attempt.attemptId), [1, 2]);
});

test("失败/取消不泄露答案：无证据、canReveal=false、不能写反思", () => {
  const item = activity(MAIN_ACTIVITY);
  const setup = (): ActivityState => {
    let state = createActivityState();
    state = expectOk(startAttempt(state, item.id, item.version));
    state = expectOk(
      submitPrediction(state, { kind: "range", min: 15, max: 25, unit: "°" }),
    );
    return expectOk(bindRun(state, { kind: "live", id: 20 }));
  };

  const runningA = setup();
  expectFail(failRun(runningA, { kind: "live", id: 21 }), "stale-run");
  assert.equal(runningA.current!.status, "running");
  const failed = expectOk(failRun(runningA, { kind: "live", id: 20 }));
  assert.equal(failed.current!.status, "failed");
  assert.equal(failed.current!.evidence, null);
  assert.equal(failed.current!.comparison, null);
  assert.equal(failed.current!.prediction!.kind, "range", "原预测仍保留");
  assert.equal(canReveal(failed), false);
  expectFail(
    completeRun(failed, { attemptId: 1, runRef: { kind: "live", id: 20 }, numeric: 20 }),
    "wrong-status",
  );
  expectFail(addReflection(failed, "不应写入"), "wrong-status");
  assert.equal(failed.current!.reflection, "");

  const runningB = setup();
  expectFail(cancelRun(runningB, { kind: "live", id: 21 }), "stale-run");
  const cancelled = expectOk(cancelRun(runningB, { kind: "live", id: 20 }));
  assert.equal(cancelled.current!.status, "cancelled");
  assert.equal(cancelled.current!.evidence, null);
  assert.equal(canReveal(cancelled), false);
  expectFail(
    completeRun(cancelled, { attemptId: 1, runRef: { kind: "live", id: 20 }, numeric: 20 }),
    "wrong-status",
  );
  expectFail(addReflection(cancelled, "不应写入"), "wrong-status");

  const restarted = expectOk(restart(cancelled));
  assert.equal(restarted.history.length, 1);
  assert.equal(restarted.history[0].status, "cancelled");

  const runningC = setup();
  expectFail(restart(runningC), "wrong-status");
  const cancelledWithoutRef = expectOk(cancelRun(runningC));
  assert.equal(cancelledWithoutRef.current!.status, "cancelled");
  assert.equal(canReveal(cancelledWithoutRef), false);
});

test("重复提交/畸形输入安全：不抛异常、状态不变", () => {
  const item = activity(MAIN_ACTIVITY);
  let state = createActivityState();
  assert.equal(canReveal(null), false);
  assert.equal(canReveal({} as ActivityState), false);
  expectFail(startAttempt(null as unknown as ActivityState, item.id, item.version), "invalid-state");
  expectFail(startAttempt(state, "", 1), "invalid-activity");
  expectFail(startAttempt(state, "not-an-activity", 1), "invalid-activity");
  expectFail(startAttempt(state, item.id, 0), "invalid-activity");
  expectFail(startAttempt(state, item.id, 99), "invalid-activity");

  state = expectOk(startAttempt(state, item.id, item.version));
  expectFail(
    submitPrediction(state, null as unknown as PredictionAnswer),
    "invalid-prediction",
  );
  expectFail(submitPrediction(state, { kind: "single", choiceId: "x" }), "invalid-prediction");
  expectFail(completeRun(null as unknown as ActivityState, {} as never), "invalid-state");
  expectFail(failRun(null as unknown as ActivityState, { kind: "live", id: 1 }), "invalid-state");
  expectFail(cancelRun(null as unknown as ActivityState), "invalid-state");
  expectFail(addReflection(null as unknown as ActivityState, "x"), "invalid-state");
  expectFail(restart(null as unknown as ActivityState), "invalid-state");

  expectFail(bindRun(state, { kind: "live", id: 1 }), "wrong-status");
  state = expectOk(
    submitPrediction(state, { kind: "range", min: 15, max: 25, unit: "°" }),
  );
  expectFail(bindRun(state, { kind: "bogus", id: 1 } as unknown as RunRef), "invalid-run-ref");
  expectFail(bindRun(state, { kind: "live", id: 0 }), "invalid-run-ref");
  expectFail(bindRun(state, { kind: "live", id: Number.NaN }), "invalid-run-ref");
  state = expectOk(bindRun(state, { kind: "live", id: 1 }));
  expectFail(
    completeRun(state, { attemptId: 1, runRef: { kind: "live", id: 1 } } as never),
    "invalid-evidence",
  );
  expectFail(
    completeRun(state, {
      attemptId: 1,
      runRef: { kind: "live", id: 1 },
      numeric: Number.POSITIVE_INFINITY,
    }),
    "invalid-evidence",
  );
  expectFail(
    completeRun(state, {
      attemptId: 1,
      runRef: { kind: "live", id: 1 },
      text: 42 as unknown as string,
    }),
    "invalid-evidence",
  );
  expectFail(
    completeRun(state, {
      attemptId: 1,
      runRef: { kind: "live", id: 1 },
      passed: "yes" as unknown as boolean,
    }),
    "invalid-evidence",
  );
  expectFail(
    completeRun(state, {
      attemptId: 1,
      runRef: { kind: "live", id: 1 },
      text: "   ",
    }),
    "invalid-evidence",
  );
  expectFail(addReflection(state, "未就绪"), "wrong-status");

  const bad = {
    current: { attemptId: Number.NaN, activityId: 7, activityVersion: -1, status: "???" },
    history: [null],
    nextAttemptId: 0,
  } as unknown as ActivityState;
  expectFail(startAttempt(bad, item.id, item.version), "invalid-state");
  const badHistory = cloneState(state);
  badHistory.history = [null as never];
  expectFail(bindRun(badHistory, { kind: "live", id: 2 }), "invalid-state");
  const badPrediction = cloneState(state);
  badPrediction.current!.prediction = { kind: "bogus" } as never;
  expectFail(bindRun(badPrediction, { kind: "live", id: 3 }), "invalid-state");
  const record = exportActivityRecord(bad);
  assert.deepEqual(record.attempts, []);
  assert.doesNotThrow(() => JSON.stringify(record));
  assert.equal(JSON.stringify(record).includes("undefined"), false);
});

test("导出记录 JSON 安全：数值有限化、无设备字段、深拷贝", () => {
  const item = activity(DELAY_ACTIVITY);
  let state = createActivityState();
  state = expectOk(startAttempt(state, item.id, item.version));
  state = expectOk(
    submitPrediction(state, { kind: "range", min: 4, max: 8, unit: "°" }),
  );
  state = expectOk(bindRun(state, { kind: "live", id: 30 }));
  state = expectOk(
    completeRun(state, { attemptId: 1, runRef: { kind: "live", id: 30 }, numeric: 6 }),
  );
  state = expectOk(addReflection(state, "<b>纯文本</b>"));

  const record = exportActivityRecord(state);
  const json = JSON.stringify(record);
  assert.ok(json.includes('"schema":"learning-activity-record/v1"'));
  assert.equal(/device|userAgent|localStorage|timestamp/i.test(json), false);
  assert.ok(json.includes("<b>纯文本</b>"), "反思必须原样导出");
  assert.ok(!json.includes("&lt;"), "导出层不得转义");

  record.attempts[0].reflection = "被改坏";
  record.attempts[0].evidence!.numeric = 999;
  assert.equal(state.current!.reflection, "<b>纯文本</b>", "导出必须是深拷贝");
  assert.equal(state.current!.evidence!.numeric, 6, "导出必须是深拷贝");

  const mutated = cloneState(state);
  mutated.current!.evidence!.numeric = Number.NaN;
  const sanitized = exportActivityRecord(mutated);
  assert.equal(sanitized.attempts[0].evidence!.numeric, null);
  assert.doesNotThrow(() => JSON.stringify(sanitized));
});

test("纯函数：不修改入参，历史与新状态互不共享", () => {
  const item = activity(MAIN_ACTIVITY);
  let state = createActivityState();
  const empty = snapshot(state);
  state = expectOk(startAttempt(state, item.id, item.version));
  const beforeSubmit = snapshot(state);
  const submitted = expectOk(
    submitPrediction(state, { kind: "range", min: 15, max: 25, unit: "°" }),
  );
  assert.equal(snapshot(state), beforeSubmit, "submitPrediction 不得修改旧 state");
  assert.equal(snapshot(createActivityState()), empty);
  assert.notEqual(submitted, state);
  assert.notEqual(submitted.history, state.history);

  const running = expectOk(bindRun(submitted, { kind: "live", id: 40 }));
  const ready = expectOk(
    completeRun(running, { attemptId: 1, runRef: { kind: "live", id: 40 }, numeric: 20 }),
  );
  const reviewed = expectOk(addReflection(ready, "反思一"));
  const beforeRestart = snapshot(reviewed);
  const restarted = expectOk(restart(reviewed));
  assert.equal(snapshot(reviewed), beforeRestart, "restart 不得修改旧 state");

  restarted.history[0].reflection = "外部改坏";
  restarted.history[0].prediction = null;
  assert.equal(reviewed.current!.reflection, "反思一", "history 必须深拷贝");
  assert.ok(reviewed.current!.prediction, "history 修改不得影响旧 state");
});

test("状态集合覆盖 idle→answering→predicted→running→ready→reviewing 与失败/取消", () => {
  for (const status of [
    "idle",
    "answering",
    "predicted",
    "running",
    "ready",
    "reviewing",
    "failed",
    "cancelled",
  ]) {
    assert.ok(
      (ATTEMPT_STATUSES as readonly string[]).includes(status),
      `状态集合缺 ${status}`,
    );
  }
});

test("模块边界：无 DOM、无持久化、无时间/随机源", () => {
  for (const [name, source] of [
    ["learning-activities.ts", activitySource],
    ["learning-activity-data.ts", dataSource],
    ["activity-state.ts", stateSource],
  ] as const) {
    assert.ok(!/\bdocument\b/.test(source), `${name} 不得引用 document`);
    assert.ok(!/\bwindow\b/.test(source), `${name} 不得引用 window`);
    assert.ok(
      !/querySelector|HTMLElement|innerHTML|localStorage|sessionStorage|indexedDB/.test(source),
      `${name} 不得依赖 DOM/持久化`,
    );
    assert.ok(
      !/\bnavigator\b|\bfetch\s*\(|XMLHttpRequest/.test(source),
      `${name} 不得访问网络/设备`,
    );
    assert.ok(!/\.html["']/.test(source), `${name} 不得引用 HTML 文件`);
    assert.ok(
      !/Date\.now|new Date|Math\.random|crypto\./.test(source),
      `${name} 不得引入时间/随机源`,
    );
  }
  assert.ok(!activitySource.includes("activity-state"), "learning-activities 不得反向依赖状态机");
  assert.ok(!activitySource.includes("main.ts"), "learning-activities 不得依赖主入口");
  assert.ok(
    !/from\s+["']\.\/learning-activity-data["']/.test(activitySource),
    "learning-activities 不得静态 import 数据模块",
  );
  assert.ok(
    !/from\s+["']\.\/learning-activity-data["']/.test(stateSource),
    "activity-state 只能通过注入的 lookup 读取活动，不得静态 import 数据",
  );
  assert.ok(
    dataSource.includes('from "./learning-activities"'),
    "数据模块只能依赖类型/纯函数模块",
  );
});

test("TQ-06 双运行证据：计划/结果整体绑定，错侧与缺结果都拒绝", () => {
  const activity = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const configs = evidenceRunConfigs(teachingBaseConfig(), activity);
  const plan = configs.map((item) => ({ runId: item.id, configDigest: item.digest }));
  const metric = (id: string, steadyRmse: number) => ({
    id, n: 100, max: steadyRmse + 1, rmse: steadyRmse, steadyRmse,
    tiltRmse: 1, yawRmse: 1,
  });
  const results = [
    { runId: "A", termination: "completed", metrics: [metric("mahony", 2.63)] },
    { runId: "B", termination: "completed", metrics: [metric("mahony", 1.38)] },
  ];
  let state = createActivityState();
  let r = startAttempt(state, activity.id, activity.version);
  assert.equal(r.ok, true);
  state = (r as any).state;
  state = (submitPrediction(state, { kind: "single", choiceId: "integral-removes-step" }) as any).state;
  const runRef: RunRef = { kind: "live", id: 1 };
  const bound = bindRun(state, runRef, configs[0].digest, plan);
  assert.equal(bound.ok, true, (bound as any).error);
  state = (bound as any).state;
  const completed = completeRun(state, {
    attemptId: state.current!.attemptId,
    runRef,
    configDigest: configs[0].digest,
    evidencePlan: plan,
    runResults: results,
    numeric: 1.38,
    text: "B 稳态 1.38 vs A 2.63",
    passed: true,
  });
  assert.equal(completed.ok, true, (completed as any).error);
  state = (completed as any).state;
  const record = exportActivityRecord(state);
  assert.deepEqual(record.attempts[0].evidencePlan, plan);
  assert.equal(record.attempts[0].runResults?.length, 2);
  assert.equal(record.attempts[0].runResults?.[1].metrics[0].steadyRmse, 1.38);

  // 改变 B 的摘要：旧计划不能复用到新侧。
  let bad = createActivityState();
  bad = (startAttempt(bad, activity.id, activity.version) as any).state;
  bad = (submitPrediction(bad, { kind: "single", choiceId: "integral-removes-step" }) as any).state;
  const wrongPlan = [plan[0], { runId: "B", configDigest: "ffffffffffffffff" }];
  const badBound = bindRun(bad, runRef, configs[0].digest, wrongPlan);
  assert.equal(badBound.ok, true);
  bad = (badBound as any).state;
  const stale = completeRun(bad, {
    attemptId: bad.current!.attemptId, runRef, configDigest: configs[0].digest,
    evidencePlan: plan, runResults: results, numeric: 1.38, text: "x", passed: true,
  });
  assert.equal(stale.ok, false, "计划不一致必须拒绝");

  // 有计划但缺各侧结果：不能只凭总摘要完成。
  let missing = createActivityState();
  missing = (startAttempt(missing, activity.id, activity.version) as any).state;
  missing = (submitPrediction(missing, { kind: "single", choiceId: "integral-removes-step" }) as any).state;
  missing = (bindRun(missing, runRef, configs[0].digest, plan) as any).state;
  const noResults = completeRun(missing, {
    attemptId: missing.current!.attemptId, runRef, configDigest: configs[0].digest,
    evidencePlan: plan, numeric: 1.38, text: "x", passed: true,
  });
  assert.equal(noResults.ok, false, "缺各侧结构化结果必须拒绝");
});

test("TR-02 教材门控数字与 runner 实测一致（20 s 窗口）", () => {
  const claim = LEARNING_CLAIMS.find((item) => item.id === "claim-gate-rescue")!;
  assert.deepEqual(claim.expectation, {
    durationSec: 20, estimatorId: "mahony", metric: "rmse",
    minGain: 2, minEvents: 100, eventMetric: "gateRejects",
  }, "保留生产 claim 的窗口、指标与验收阈值");
  const host = html.match(/<div\s+data-claim="claim-gate-rescue"[^>]*>/)?.[0];
  assert.ok(host);
  assert.ok(host.includes(`data-claim-baseline="${claim.baselineExperimentId}"`));
  assert.ok(host.includes(`data-claim-target="${claim.targetId}"`));
  assert.ok(host.includes(`data-claim-window="${claim.expectation.durationSec}"`));
  const gate = EXPERIMENTS.find((item) => item.id === claim.baselineExperimentId)!;
  assert.deepEqual(gate.sliders, {
    "imu-lin-accel": 4, "imu-vibration": 0.1, "imu-gyro-bias": 1, "imu-mag-noise": 0.8,
  }, "不挑参数制造通过，保留生产实验参数");
  assert.deepEqual(gate.checks, { "gate-toggle": true, "telemetry-toggle": true });
  assert.deepEqual(gate.selects, { "scenario-select": "violent", "source-select": "mahony" });

  // 生产动作 resetExperimentBaseline → gate 覆盖 → 门控关 → 冻结 → accel-gate 配对。
  // 用实验库默认配置，不得借用全部 IMU 归零/关闭 ramp 的预测题 teachingBaseConfig。
  const base = defaultExperimentConfig();
  base.durationSec = claim.expectation.durationSec!;
  base.scenario = gate.selects!["scenario-select"];
  const sliderFields = {
    "imu-lin-accel": "linAccel", "imu-vibration": "vibration",
    "imu-gyro-bias": "gyroBiasDps", "imu-mag-noise": "magNoise",
  } as const;
  for (const id of Object.keys(sliderFields) as (keyof typeof sliderFields)[]) {
    base.imu[sliderFields[id]] = gate.sliders![id];
  }
  for (const id of ["comp", "mahony", "madg"] as const) base.estimators[id].accelGate = false;

  assert.equal(base.imu.gyroNoiseDps, 0.2, "生产 claim 保留实验库默认陀螺噪声，不得换成教学零噪声基线");
  assert.equal(base.imu.accelNoise, 0.1, "生产 claim 保留加计噪声");
  assert.equal(base.estimators.mahony.rampEnabled, true, "生产 claim 保留启动 ramp");
  for (const tuning of Object.values(base.estimators)) {
    assert.equal(tuning.enabled, true, "生产 claim 保留五算法，source-select 只选展示姿态");
  }
  // HTML 默认值也是实验库复位的来源，必须与数值内核默认值相同。
  for (const [id, value] of [
    ["experiment-seed", base.seed], ["imu-gyro-noise", base.imu.gyroNoiseDps],
    ["imu-accel-noise", base.imu.accelNoise], ["gate-deg", base.estimators.mahony.gateDeg],
    ["gate-mag", base.estimators.mahony.gateMagPct * 100],
    ["mahony-kp", base.estimators.mahony.params.kp], ["mahony-ki", base.estimators.mahony.params.ki],
  ] as const) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.equal(Number(input?.match(/\bvalue="([^"]+)"/)?.[1]), value, `${id} 默认值漂移`);
  }
  assert.match(html, /<input[^>]*id="mag-enable"[^>]*\bchecked\b/);
  assert.doesNotMatch(html.match(/<input[^>]*id="init-offset-toggle"[^>]*>/)![0], /\bchecked\b/);
  assert.doesNotMatch(html.match(/<input[^>]*id="gate-recovery"[^>]*>/)![0], /\bchecked\b/);

  const pair = buildComparisonPair(base, {
    id: "accel-gate", label: "方向门控（关→开）", a: false, b: true,
    affectedPaths: COMPARISON_AFFECTED_PATHS["accel-gate"],
  });
  assert.ok(pair.ok, pair.ok ? "" : pair.error);
  assert.deepEqual(comparisonDiff(pair.a, pair.b), [...COMPARISON_AFFECTED_PATHS["accel-gate"]]);
  const results = [pair.a, pair.b].map((config) => runExperimentDetailed(config));
  for (const result of results) {
    assert.equal(result.termination.reason, "completed");
    assert.equal(result.termination.requestedEndSec, claim.expectation.durationSec);
    assert.equal(result.metrics.length, 5);
  }
  const [off, on] = results.map((result) => result.metrics.find((metric) => metric.id === claim.expectation!.estimatorId)!);
  const gain = off.rmse - on.rmse;
  console.log(`门控 20 s：A.rmse=${off.rmse}°，B.rmse=${on.rmse}°，gain=${gain}°，rejects=${off.gateRejects}/${on.gateRejects}，max=${off.max}/${on.max}°，n=${off.n}/${on.n}`);
  assert.ok(gain >= 2, `门控改善必须 ≥2°（实测 ${gain.toFixed(2)}°）`);
  assert.ok(on.gateRejects >= 100, `门控侧必须有真实拒绝（实测 ${on.gateRejects}）`);
  assert.equal(off.gateRejects, 0, "关闭侧不得有拒绝");
  assert.equal(on.max, off.max, "生产窗口的启动峰值并未被门控消除");
  const paragraph = html.match(/<p><span class="k k3">改了会怎样<\/span>用「方向门控救场」实验：[\s\S]*?<\/p>/)![0];
  const row = html.match(/<tr><td>方向门控救场<\/td>[\s\S]*?<\/tr>/)![0];
  for (const text of [paragraph, row, gate.observe]) {
    assert.ok(text.includes(`${off.rmse.toFixed(1)}°`), "必须写出门控关的同条件实测 RMSE");
    assert.ok(text.includes(`${on.rmse.toFixed(1)}°`), "必须写出门控开的同条件实测 RMSE");
    assert.ok(text.includes(String(on.gateRejects)), "拒绝次数必须来自同一次窗口");
    assert.ok(text.includes(`${on.max.toFixed(1)}°`), "有限窗口不能掩盖共同峰值");
    assert.doesNotMatch(text, /贴地/);
  }

  // 短窗口只改 duration，不能用另一组参数解释约 0.6° 的较小降幅。
  const short = [pair.a, pair.b].map((config) => {
    const copy = cloneExperimentConfig(config);
    copy.durationSec = 10;
    const result = runExperimentDetailed(copy);
    assert.equal(result.termination.reason, "completed");
    return result.metrics.find((metric) => metric.id === "mahony")!;
  });
  const shortGain = short[0].rmse - short[1].rmse;
  console.log(`门控 10 s：A.rmse=${short[0].rmse}°，B.rmse=${short[1].rmse}°，gain=${shortGain}°，rejects=${short[0].gateRejects}/${short[1].gateRejects}`);
  assert.ok(paragraph.includes(`10 s 窗口降幅约 ${shortGain.toFixed(1)}°`));
});

console.log(`learning-activity-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
