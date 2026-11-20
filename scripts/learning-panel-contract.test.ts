/**
 * F-02 学习面板独立契约测试（Node，无 DOM）。
 *
 * 覆盖：
 *  1. 静态边界：面板不 import 数据模块、只 fetch activities.json；导入时不访问 DOM 全局；
 *  2. public/data/activities.json 与 TS 真源逐项相等；
 *  3. 预测格式校验、提交锁定、状态机推进、重新挑战保留历史；
 *  4. 运行成功绑定、失败/取消不泄露答案、旧运行结果不污染新尝试；
 *  5. 缺失/错配指标显示不可用（不是 0）；固定 5 s 配置不修改现场；
 *  6. 所有动态文本走 textContent，escapeHtml 覆盖恶意字符串；
 *  7. 无 localStorage / sessionStorage / 设备信息。
 *
 * 运行：npx tsx scripts/learning-panel-contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultExperimentConfig, type EstimatorId } from "../src/core/experiment-config";
import type { EstimatorRunMetrics, RunTermination } from "../src/core/runner";
import { LEARNING_ACTIVITIES } from "../src/ui/learning-activity-data";
import type { LearningActivity } from "../src/ui/learning-activities";
import {
  EVIDENCE_DURATION_SEC,
  ACTIVITIES_DATA_PATH,
  activitiesDataUrl,
  configDigest,
  createLearningPanel,
  escapeHtml,
  evaluateEvidencePredicates,
  evidenceConfig,
  evidenceFromRun,
  evidenceFromRuns,
  evidenceRunConfigs,
  teachingBaseConfig,
  metricDisplayName,
  selectEstimatorMetric,
  type LearningPanelDeps,
} from "../src/ui/learning-panel";

let pass = 0;
let fail = 0;
function test(name: string, body: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await body();
      pass++;
      console.log(`PASS ${name}`);
    } catch (err) {
      fail++;
      console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    }
  };
  // 保持 PASS/FAIL 输出顺序：顶层 await 不可用的 tsx 目标下用立即调用链。
  pending = pending.then(run);
}
let pending: Promise<void> = Promise.resolve();

const panelSource = readFileSync(
  new URL("../src/ui/learning-panel.ts", import.meta.url),
  "utf8",
);
const activityJsonText = readFileSync(
  new URL("../public/data/activities.json", import.meta.url),
  "utf8",
);

function metric(id: EstimatorId, overrides: Partial<EstimatorRunMetrics> = {}): EstimatorRunMetrics {
  return {
    id,
    label: id,
    n: 100,
    mean: 1,
    rmse: 1,
    max: 20,
    p50: 1,
    p95: 1,
    steadyRmse: 1,
    tiltRmse: 1,
    yawRmse: 1,
    convergedAt: null,
    gateRejects: 0,
    ...overrides,
  };
}

function completed(durationSec = EVIDENCE_DURATION_SEC): RunTermination {
  return {
    reason: "completed",
    requestedEndSec: durationSec,
    endSec: durationSec,
    lastSolveSec: durationSec,
    pendingTailSec: 0,
  };
}

function cancelled(durationSec = EVIDENCE_DURATION_SEC): RunTermination {
  return {
    reason: "cancelled",
    requestedEndSec: durationSec,
    endSec: 1,
    lastSolveSec: 1,
    pendingTailSec: 0,
    cancelledAtSec: 1,
  };
}

/** 与活动 id 匹配的假运行结果；只为测试面板的谓词/绑定逻辑，不冒充真实数值。 */
function fakeMetrics(
  activity: LearningActivity,
  config: ReturnType<typeof defaultExperimentConfig>,
): EstimatorRunMetrics[] {
  if (activity.id === "accel-yaw-unobservable") {
    const axis = config.initialAttitude.axis ?? [];
    const kp = Number(config.estimators.mahony.params.kp ?? 1);
    if (axis[0] === 1) {
      return [metric("mahony", kp > 0 ? { tiltRmse: 2.8, yawRmse: 0.1 } : { tiltRmse: 30, yawRmse: 0 })];
    }
    return [metric("mahony", { tiltRmse: 0.01, yawRmse: 30 })];
  }
  if (activity.id === "mahony-ki-bias") {
    const ki = config.estimators.mahony.params.ki;
    return [metric("mahony", { steadyRmse: ki === 0 ? 2.63 : 1.38 })];
  }
  if (activity.id === "sensor-delay-omega-tau") {
    return [metric("pure", { max: 6 })];
  }
  return [metric("pure", { max: 20 })];
}

interface DepsCalls {
  runs: Array<{
    config: ReturnType<typeof defaultExperimentConfig>;
    activityId: string;
    shouldCancel?: () => boolean;
  }>;
  docs: Array<[string, string | undefined]>;
  toasts: Array<{ msg: string; color?: string }>;
}

function makeDeps(overrides: Partial<LearningPanelDeps> = {}): {
  deps: LearningPanelDeps;
  calls: DepsCalls;
  base: ReturnType<typeof defaultExperimentConfig>;
} {
  const base = defaultExperimentConfig();
  const calls: DepsCalls = { runs: [], docs: [], toasts: [] };
  const deps: LearningPanelDeps = {
    async runEvidence(config, activity, shouldCancel) {
      calls.runs.push({ config, activityId: activity.id, shouldCancel });
      return {
        metrics: fakeMetrics(activity, config),
        termination: completed(config.durationSec),
      };
    },
    openDocs(page, anchor) {
      calls.docs.push([page, anchor]);
    },
    toast(msg, color) {
      calls.toasts.push({ msg, color });
    },
    ...overrides,
  };
  return { deps, calls, base };
}

function panelWith(deps: LearningPanelDeps) {
  return createLearningPanel(deps, LEARNING_ACTIVITIES);
}

test("静态边界：面板不 import 数据模块，只 fetch activities.json", () => {
  assert.equal(ACTIVITIES_DATA_PATH, "data/activities.json");
  assert.equal(
    activitiesDataUrl("https://example.test/app/"),
    "https://example.test/app/data/activities.json",
  );
  assert.ok(panelSource.includes("data/activities.json"), "面板必须声明 fetch 路径");
  assert.ok(panelSource.includes('cache: "no-cache"'), "fetch 应使用 no-cache");
  assert.ok(
    !/from\s+["']\.\/learning-activity-data["']/.test(panelSource),
    "面板不得静态 import 数据模块",
  );
  assert.ok(
    !/import\s*\(\s*["']\.\/learning-activity-data["']/.test(panelSource),
    "面板不得动态 import 数据模块",
  );
  assert.ok(
    !/\b(?:local|session)Storage\s*[.[]/.test(panelSource),
    "面板不得持久化进度",
  );
  assert.ok(!/navigator\.|userAgent/.test(panelSource), "面板不得采集设备信息");
  assert.ok(
    !/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/.test(panelSource),
    "动态文本不得拼 HTML",
  );
  assert.ok(panelSource.includes("textContent"), "面板应使用 textContent 写入文本");
  assert.ok(
    !panelSource.includes("applyExperiment"),
    "面板不得再依赖实验装载（证据配置来自 evidencePatch）",
  );
  assert.ok(
    !panelSource.includes("correctChoiceIds"),
    "选项判定必须走实测谓词，不得直接读 correctChoiceIds",
  );
  assert.ok(panelSource.includes("shouldCancel"), "FIX-09：运行必须传入 shouldCancel");
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
});

test("activities.json 与 TS 真源逐项相等（含 5 道题）", () => {
  const parsed = JSON.parse(activityJsonText) as unknown;
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 5);
  assert.deepStrictEqual(parsed, LEARNING_ACTIVITIES);
});

test("证据配置：默认 5 s；patch 覆盖题面条件且不修改现场", () => {
  const base = teachingBaseConfig();
  const originalDuration = base.durationSec;
  const originalAb = base.ab;
  const originalBias = base.imu.gyroBiasDps;
  const config = evidenceConfig(base);
  assert.equal(config.durationSec, EVIDENCE_DURATION_SEC);
  assert.equal(EVIDENCE_DURATION_SEC, 5);
  assert.notEqual(config, base);
  assert.equal(base.durationSec, originalDuration, "不得修改调用方配置");
  assert.equal(base.ab, originalAb);
  assert.equal("ab" in config, false, "证据运行不携带界面 A/B 模式");

  const drift = LEARNING_ACTIVITIES.find((item) => item.id === "drift-linear-10s")!;
  const patched = evidenceConfig(base, drift.evidencePatch);
  assert.equal(patched.durationSec, 10);
  assert.equal(patched.imu.gyroBiasDps, 2);
  assert.equal(patched.imu.gyroNoiseDps, 0);
  assert.equal(patched.imu.linAccel, 0);
  assert.equal(patched.imu.vibration, 0);
  assert.equal(patched.scenario, "hover");
  assert.equal(patched.initialAttitude.kind, "level", "漂移题必须钉住水平初始姿态");
  assert.equal(patched.estimators.pure.enabled, true);
  assert.equal(base.imu.gyroBiasDps, originalBias, "patch 只能写副本");
  assert.equal(base.durationSec, originalDuration);

  const delay = LEARNING_ACTIVITIES.find((item) => item.id === "sensor-delay-omega-tau")!;
  const delayConfig = evidenceConfig(base, delay.evidencePatch);
  assert.equal(delayConfig.durationSec, 5);
  assert.equal(delayConfig.imu.sensorDelayMs, 25);
  assert.equal(delayConfig.imu.gyroBiasDps, 0);
  assert.equal(delayConfig.scenario, "violent");
  assert.equal(delayConfig.initialAttitude.kind, "level", "延迟题必须钉住水平初始姿态");

  const yaw = LEARNING_ACTIVITIES.find((item) => item.id === "accel-yaw-unobservable")!;
  const yawConfig = evidenceConfig(base, yaw.evidencePatch);
  assert.equal(yawConfig.durationSec, 10);
  assert.equal(yawConfig.initialAttitude.kind, "fixed-axis");
  assert.deepEqual(yawConfig.initialAttitude.axis, [1, 0, 0]);
  assert.equal(yawConfig.initialAttitude.angleDeg, 30);
  assert.equal(yawConfig.autoCoarseAlign, false);
  assert.equal(yawConfig.estimators.mahony.accelGate, false);
  assert.deepEqual(yawConfig.estimators.mahony.params, { kp: 1, ki: 0.05 });
  for (const id of ["pure", "comp", "mahony", "madg", "kalman"] as const) {
    assert.equal(yawConfig.estimators[id].magEnabled, false, `${id} 磁修正必须关闭`);
  }
});

test("配置摘要：patch 决定摘要，不随被覆盖的现场值变化", () => {
  const drift = LEARNING_ACTIVITIES.find((item) => item.id === "drift-linear-10s")!;
  const delay = LEARNING_ACTIVITIES.find((item) => item.id === "sensor-delay-omega-tau")!;
  const baseA = defaultExperimentConfig();
  const baseB = defaultExperimentConfig();
  baseB.imu.gyroBiasDps = 7;
  baseB.imu.gyroNoiseDps = 0.9;
  baseB.imu.linAccel = 3;
  baseB.imu.vibration = 1;
  baseB.scenario = "violent";
  baseB.durationSec = 42;

  const [a] = evidenceRunConfigs(baseA, drift);
  const [b] = evidenceRunConfigs(baseB, drift);
  assert.equal(a.digest, b.digest, "题面条件相同的两次运行必须得到同一摘要");
  assert.match(a.digest, /^[0-9a-f]{16}$/);
  assert.notEqual(a.digest, configDigest(evidenceConfig(baseA)), "摘要必须包含 patch");

  const [delayConfig] = evidenceRunConfigs(baseA, delay);
  assert.notEqual(a.digest, delayConfig.digest, "不同题面条件必须得到不同摘要");
});

test("多运行：Ki 题构建 A=Ki0 / B=Ki0.05，B 只覆盖积分增益", () => {
  const kiActivity = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const configs = evidenceRunConfigs(defaultExperimentConfig(), kiActivity);
  assert.deepEqual(configs.map((item) => item.id), ["A", "B"]);
  assert.equal(configs[0].config.durationSec, 20);
  assert.equal(configs[0].config.imu.gyroBiasDps, 2);
  assert.equal(configs[0].config.estimators.mahony.params.ki, 0);
  assert.equal(configs[1].config.estimators.mahony.params.ki, 0.05);
  assert.equal(configs[1].config.durationSec, 20);
  assert.equal(configs[1].config.imu.gyroBiasDps, 2);
  assert.equal(configs[1].config.scenario, "hover");
  assert.notEqual(configs[0].digest, configs[1].digest);
});

test("预测校验：NaN/空范围/错误单位/空选项被拒，成功后锁定", () => {
  const { deps, calls } = makeDeps();
  const panel = panelWith(deps);
  assert.equal(panel.state().loaded, true);
  assert.equal(panel.state().activityCount, 5);
  assert.equal(panel.state().activityId, null);
  assert.equal(panel.state().status, "idle");

  panel.setActivity("drift-linear-10s");
  assert.equal(panel.state().status, "answering");
  assert.equal(panel.state().canRun, false);
  assert.equal(panel.state().canReveal, false);

  const bad = panel.submitPrediction({
    kind: "range",
    min: Number.NaN,
    max: null,
    unit: "°",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.error && bad.error.includes("有限"), String(bad.error));
  assert.equal(panel.state().status, "answering", "非法预测不得推进状态");

  assert.equal(
    panel.submitPrediction({ kind: "range", min: null, max: null, unit: "°" }).ok,
    false,
  );
  assert.equal(
    panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "rad" }).ok,
    false,
  );

  const ok = panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  assert.equal(ok.ok, true);
  assert.equal(panel.state().status, "predicted");
  assert.equal(panel.state().canRun, true);
  assert.equal(panel.state().canReveal, false);
  assert.ok(panel.state().predictionText.includes("15"));
  assert.ok(panel.state().predictionText.includes("25"));

  const second = panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  assert.equal(second.ok, false);
  assert.ok(second.error && second.error.includes("锁定"), String(second.error));
  assert.equal(panel.state().status, "predicted");
  assert.equal(calls.runs.length, 0, "仅提交预测不应启动证据运行");
});

test("多选按整题口径：空选拒绝、部分命中不包装为全对（实测谓词）", () => {
  const { deps } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("accel-yaw-unobservable");
  assert.equal(panel.submitPrediction({ kind: "multiple", choiceIds: [] }).ok, false);
  assert.equal(
    panel.submitPrediction({
      kind: "multiple",
      choiceIds: ["tilt-fixable", "gravity-axis"],
    }).ok,
    true,
  );
  assert.equal(panel.state().status, "predicted");
  const activity = LEARNING_ACTIVITIES.find((item) => item.id === "accel-yaw-unobservable")!;
  const runs = [
    { id: "A", metrics: [metric("mahony", { tiltRmse: 2.8, yawRmse: 0.1 })] },
    { id: "B", metrics: [metric("mahony", { tiltRmse: 30, yawRmse: 0 })] },
    { id: "C", metrics: [metric("mahony", { tiltRmse: 0.01, yawRmse: 30 })] },
  ];
  const evaluated = evaluateEvidencePredicates(activity, runs);
  assert.equal(evaluated.ok, true);
  if (evaluated.ok) {
    assert.equal(evaluated.truth.get("tilt-fixable"), true);
    assert.equal(evaluated.truth.get("yaw-fixable"), false);
    assert.equal(evaluated.truth.get("gravity-axis"), true);
    assert.equal(evaluated.truth.get("gain-fix"), false);
    assert.equal(evaluated.truth.get("external-heading"), true);
  }
  const partial = {
    kind: "multiple" as const,
    choiceIds: ["tilt-fixable", "gravity-axis"],
  };
  const partialBuilt = evidenceFromRuns(activity, partial, runs);
  assert.equal(partialBuilt.ok, true);
  if (partialBuilt.ok) assert.equal(partialBuilt.evidence.passed, false, "部分命中不得判为全对");
  const full = {
    kind: "multiple" as const,
    choiceIds: ["tilt-fixable", "gravity-axis", "external-heading"],
  };
  const fullBuilt = evidenceFromRuns(activity, full, runs);
  assert.equal(fullBuilt.ok, true);
  if (fullBuilt.ok) assert.equal(fullBuilt.evidence.passed, true);
  const wrongExtra = {
    kind: "multiple" as const,
    choiceIds: ["tilt-fixable", "gravity-axis", "external-heading", "yaw-fixable"],
  };
  const wrongBuilt = evidenceFromRuns(activity, wrongExtra, runs);
  assert.equal(wrongBuilt.ok, true);
  if (wrongBuilt.ok) assert.equal(wrongBuilt.evidence.passed, false, "选错项不得判对");
});

test("运行成功：按 patch 的 10 s / 2°/s / 噪声 0 离线复算并绑定当前 attempt", async () => {
  const { deps, calls, base } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("drift-linear-10s");
  panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  const result = await panel.run();
  assert.equal(result.ok, true, String(result.error));
  assert.equal(calls.runs.length, 1, "单运行题只跑一次");
  const run = calls.runs[0];
  assert.equal(run.activityId, "drift-linear-10s");
  assert.equal(run.config.durationSec, 10, "证据时长来自 evidencePatch，不是固定 5 s");
  assert.equal(run.config.imu.gyroBiasDps, 2, "证据零偏来自题面");
  assert.equal(run.config.imu.gyroNoiseDps, 0);
  assert.equal(run.config.imu.linAccel, 0);
  assert.equal(run.config.imu.vibration, 0);
  assert.equal(run.config.scenario, "hover");
  assert.equal(run.config.estimators.pure.enabled, true);
  assert.equal("ab" in run.config, false);
  assert.equal(typeof run.shouldCancel, "function", "FIX-09：必须把取消闭包传给 runner");
  assert.equal(base.durationSec, defaultExperimentConfig().durationSec, "现场配置不得被改写");
  assert.equal(base.imu.gyroBiasDps, defaultExperimentConfig().imu.gyroBiasDps);

  const state = panel.state();
  assert.equal(state.status, "ready");
  assert.equal(state.canReveal, true);
  assert.equal(state.verdict, "consistent");
  assert.equal(state.attempts, 1);
  assert.equal(state.evidence?.numeric, 20);
  assert.equal(state.evidence?.attemptId, state.attemptId);
  assert.ok(state.evidence?.text.includes("峰值误差"), state.evidence?.text);
  const expectedDigest = evidenceRunConfigs(teachingBaseConfig(), LEARNING_ACTIVITIES[0])[0].digest;
  assert.equal(state.configDigest, expectedDigest, "attempt 必须绑定规范配置摘要");
  assert.equal(state.evidence?.configDigest, expectedDigest);
  assert.ok(calls.toasts.some((toast) => toast.msg.includes("离线复算")));
});

test("重新挑战：历史保留、开始新 attempt、不沿用上一题答案", async () => {
  const { deps } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("drift-linear-10s");
  panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  await panel.run();
  assert.equal(panel.state().status, "ready");

  panel.reset();
  const afterReset = panel.state();
  assert.equal(afterReset.status, "answering");
  assert.equal(afterReset.attemptId, 2);
  assert.equal(afterReset.attempts, 2, "旧 attempt 进入历史");
  assert.equal(afterReset.predictionText, "");
  assert.equal(afterReset.canReveal, false);
  const runBeforePrediction = await panel.run();
  assert.equal(runBeforePrediction.ok, false);
  assert.ok(runBeforePrediction.error?.includes("先提交"), String(runBeforePrediction.error));

  panel.setActivity("mahony-ki-bias");
  assert.equal(panel.state().activityId, "mahony-ki-bias");
  assert.equal(panel.state().status, "answering");
  assert.equal(panel.state().predictionText, "", "切题不得串用上一题预测");
  panel.setActivity("drift-linear-10s");
  assert.equal(panel.state().status, "answering", "切回仍保留该题自己的新 attempt");
  assert.equal(panel.state().attempts, 2);
});

test("运行中 reset：shouldCancel 变真，旧结果不得绑定新 attempt", async () => {
  let release!: (value: { metrics: EstimatorRunMetrics[]; termination: RunTermination }) => void;
  let started!: () => void;
  const evidenceStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const deferred = new Promise<{ metrics: EstimatorRunMetrics[]; termination: RunTermination }>(
    (resolve) => {
      release = resolve;
    },
  );
  let shouldCancel: (() => boolean) | undefined;
  const { deps } = makeDeps({
    async runEvidence(_config, _activity, cancel) {
      shouldCancel = cancel;
      started();
      return deferred;
    },
  });
  const panel = panelWith(deps);
  panel.setActivity("drift-linear-10s");
  panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  const running = panel.run();
  await evidenceStarted;
  assert.equal(panel.state().status, "running");
  assert.equal(typeof shouldCancel, "function");
  assert.equal(shouldCancel!(), false, "运行中不应要求取消");

  panel.reset();
  assert.equal(shouldCancel!(), true, "FIX-09：旧运行的 shouldCancel 必须立即变真");
  assert.equal(panel.state().status, "answering");
  assert.equal(panel.state().attemptId, 2, "重置会取消并新建 attempt");
  assert.equal(panel.state().attempts, 2);
  assert.equal(panel.state().canReveal, false);

  release({ metrics: [metric("pure", { max: 20 })], termination: completed(10) });
  const result = await running;
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("取消"), String(result.error));
  const state = panel.state();
  assert.equal(state.status, "answering", "旧运行结果不得推进新 attempt");
  assert.equal(state.canReveal, false, "旧结果不得泄露答案");
});

test("运行失败/取消：预测仍锁定、canReveal=false、可重新挑战", async () => {
  const { deps } = makeDeps({
    async runEvidence() {
      throw new Error("worker boom");
    },
  });
  const panel = panelWith(deps);
  panel.setActivity("drift-linear-10s");
  panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  const failed = await panel.run();
  assert.equal(failed.ok, false);
  assert.ok(failed.error?.includes("运行失败"), String(failed.error));
  let state = panel.state();
  assert.equal(state.status, "failed");
  assert.equal(state.canReveal, false);
  assert.equal(state.verdict, null);
  assert.equal(state.predictionText.includes("15"), true, "原预测仍保留");
  assert.equal((await panel.run()).ok, false, "失败后不能再次运行同一 attempt");
  assert.equal(panel.state().canReveal, false);

  panel.reset();
  assert.equal(panel.state().status, "answering");
  assert.equal(panel.state().attempts, 2);
  panel.setActivity("mahony-ki-bias");

  const cancelDeps = makeDeps({
    async runEvidence() {
      return { metrics: [metric("mahony", { steadyRmse: 1 })], termination: cancelled() };
    },
  });
  const cancelPanel = panelWith(cancelDeps.deps);
  cancelPanel.setActivity("mahony-ki-bias");
  cancelPanel.submitPrediction({ kind: "single", choiceId: "integral-removes-step" });
  const cancelledResult = await cancelPanel.run();
  assert.equal(cancelledResult.ok, false);
  assert.ok(cancelledResult.error?.includes("取消"), String(cancelledResult.error));
  state = cancelPanel.state();
  assert.equal(state.status, "cancelled");
  assert.equal(state.canReveal, false);
  assert.ok(state.predictionText.length > 0, "取消也保留原预测");
});

test("指标缺失/错配：返回不可用错误，不用 0 冒充", () => {
  const activity = LEARNING_ACTIVITIES.find((item) => item.id === "drift-linear-10s")!;
  const prediction = { kind: "range", min: 15, max: 25, unit: "°" } as const;

  const missingEstimator = evidenceFromRun(activity, prediction, [metric("mahony")]);
  assert.equal(missingEstimator.ok, false);
  if (!missingEstimator.ok) {
    assert.ok(missingEstimator.error.includes("缺少估计器"), missingEstimator.error);
    assert.ok(missingEstimator.error.includes("不可用"), missingEstimator.error);
  }

  const missingMetric = evidenceFromRun(activity, prediction, [
    metric("pure", { max: Number.NaN }),
  ]);
  assert.equal(missingMetric.ok, false);
  if (!missingMetric.ok) assert.ok(missingMetric.error.includes("没有返回有限数值"));

  const missingField = evidenceFromRun(activity, prediction, [
    { ...metric("pure"), max: undefined } as unknown as EstimatorRunMetrics,
  ]);
  assert.equal(missingField.ok, false);

  const noSamples = evidenceFromRun(activity, prediction, [
    metric("pure", { n: 0, max: 0 }),
  ]);
  assert.equal(noSamples.ok, false, "n=0 时 0 不得冒充证据");
  if (!noSamples.ok) assert.ok(noSamples.error.includes("没有参与统计的样本"));

  const selected = selectEstimatorMetric([metric("pure", { max: 0 })], "pure", "max");
  assert.equal(selected.ok, true);
  if (selected.ok) assert.equal(selected.value, 0, "真实 0 是合法证据，不能一律当缺失");

  const ok = evidenceFromRun(activity, prediction, [metric("pure", { max: 20 })]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.evidence.numeric, 20);
    assert.equal(ok.evidence.passed, null);
    assert.equal(metricDisplayName(activity.evidence.metric), "峰值误差");
  }

  const choice = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const onlyA = evidenceFromRun(
    choice,
    { kind: "single", choiceId: "larger-always-better" },
    [metric("mahony", { steadyRmse: 3 })],
  );
  assert.equal(onlyA.ok, false, "Ki 题缺 B 运行必须显式不可用");
  if (!onlyA.ok) assert.ok(onlyA.error.includes("缺少运行"), onlyA.error);

  const kiRuns = [
    { id: "A", metrics: [metric("mahony", { steadyRmse: 3 })] },
    { id: "B", metrics: [metric("mahony", { steadyRmse: 1 })] },
  ];
  const wrong = evidenceFromRuns(
    choice,
    { kind: "single", choiceId: "larger-always-better" },
    kiRuns,
  );
  assert.equal(wrong.ok, true);
  if (wrong.ok) assert.equal(wrong.evidence.passed, false);
  const correct = evidenceFromRuns(
    choice,
    { kind: "single", choiceId: "integral-removes-step" },
    kiRuns,
  );
  assert.equal(correct.ok, true);
  if (correct.ok) {
    assert.equal(correct.evidence.passed, true);
    assert.equal(correct.evidence.numeric, 1, "Ki 题展示 B 运行的稳态 RMSE");
  }

  const yaw = LEARNING_ACTIVITIES.find((item) => item.id === "accel-yaw-unobservable")!;
  const missingTilt = evaluateEvidencePredicates(yaw, [
    { id: "A", metrics: [metric("mahony", { yawRmse: 13, tiltRmse: Number.NaN })] },
  ]);
  assert.equal(missingTilt.ok, false, "缺失倾角指标不得当作 false");
  if (!missingTilt.ok) assert.ok(missingTilt.error.includes("不可用"), missingTilt.error);
});

test("TR-01 文案：Ki 题只承诺窗口内下降，长期与振荡标为未实测", () => {
  const ki = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const text = [ki.prompt, ki.conditionsText, ki.explanation, ...(ki.choices ?? []).map((c) => c.text)].join(" ");
  assert.ok(/20 s 窗口/.test(text), "题目必须把结论限定在 20 s 窗口");
  assert.ok(/未实测|理论补充/.test(ki.explanation), "长期归零与振荡必须显式标为理论/未实测");
  assert.ok(!/台阶最终归零/.test(ki.explanation), "不得把渐近结论写成已在本窗口发生");
  const correct = ki.choices!.find((c) => c.id === "integral-removes-step")!;
  assert.ok(/窗口内/.test(correct.text), "正确项必须限定在窗口内");
  const wrongBoth = ki.choices!.find((c) => c.id === "both-remove-step")!;
  assert.ok(/窗口内/.test(wrongBoth.text), "错误项也必须用同一窗口口径，避免歧义");
});

test("TR-04 Ki 普适错误项：静态判假不得冒充窗口内振荡证据", () => {
  const ki = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const wrong = ki.choices!.find((choice) => choice.id === "larger-always-better")!;
  assert.match(wrong.text, /无论|任何条件/);
  assert.match(ki.explanation, /局部线性化/);
  assert.match(ki.explanation, /阻尼/);
  assert.match(ki.explanation, /可观测/);
  assert.match(ki.explanation, /未.*实测.*振荡|振荡.*未实测/, "不能让 A/B 的低 RMSE 冒充振荡实测");
  assert.deepEqual(ki.evidencePredicates![wrong.id], { kind: "always-false" });
});

test("Ki 题：面板两次运行 A/B，passed 由 B<A 谓词产生", async () => {
  const { deps, calls } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("mahony-ki-bias");
  panel.submitPrediction({ kind: "single", choiceId: "integral-removes-step" });
  const result = await panel.run();
  assert.equal(result.ok, true, String(result.error));
  assert.equal(calls.runs.length, 2, "Ki 题必须运行两次");
  assert.equal(calls.runs[0].config.estimators.mahony.params.ki, 0);
  assert.equal(calls.runs[1].config.estimators.mahony.params.ki, 0.05);
  assert.equal(calls.runs[0].config.durationSec, 20);
  assert.equal(calls.runs[1].config.durationSec, 20);
  const state = panel.state();
  assert.equal(state.verdict, "consistent");
  assert.equal(state.evidence?.numeric, 1.38, "展示 B 运行（Ki=0.05）的稳态 RMSE");
  assert.ok(state.evidence?.text.includes("B="), state.evidence?.text);
  assert.ok(state.evidence?.text.includes("A="), state.evidence?.text);

  const wrongPanel = panelWith(makeDeps().deps);
  wrongPanel.setActivity("mahony-ki-bias");
  wrongPanel.submitPrediction({ kind: "single", choiceId: "larger-always-better" });
  assert.equal((await wrongPanel.run()).ok, true);
  assert.equal(wrongPanel.state().verdict, "inconsistent");
});

test("偏航题：多选由实测 tiltRmse / yawRmse 谓词判定", async () => {
  const { deps } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("accel-yaw-unobservable");
  panel.submitPrediction({
    kind: "multiple",
    choiceIds: ["tilt-fixable", "gravity-axis", "external-heading"],
  });
  const result = await panel.run();
  assert.equal(result.ok, true, String(result.error));
  const state = panel.state();
  assert.equal(state.verdict, "consistent");
  assert.equal(state.evidence?.numeric, 2.8);
  assert.ok(state.evidence?.text.includes("倾角"), state.evidence?.text);
  assert.ok(state.evidence?.text.includes("偏航"), state.evidence?.text);

  const wrongPanel = panelWith(makeDeps().deps);
  wrongPanel.setActivity("accel-yaw-unobservable");
  wrongPanel.submitPrediction({
    kind: "multiple",
    choiceIds: ["tilt-fixable", "gravity-axis", "yaw-fixable"],
  });
  assert.equal((await wrongPanel.run()).ok, true);
  assert.equal(wrongPanel.state().verdict, "inconsistent");
});

test("几何题：完全不调用 runner，same-pose 由 always-true 判定", async () => {
  let runnerCalls = 0;
  const { deps } = makeDeps({
    async runEvidence() {
      runnerCalls++;
      throw new Error("几何题不应启动 runner");
    },
  });
  const panel = panelWith(deps);
  panel.setActivity("gimbal-lock-two-controls");
  panel.submitPrediction({ kind: "single", choiceId: "same-pose" });
  const result = await panel.run();
  assert.equal(result.ok, true, String(result.error));
  assert.equal(runnerCalls, 0, "几何题不得调用 runEvidence");
  let state = panel.state();
  assert.equal(state.verdict, "consistent");
  assert.equal(state.evidence?.numeric, null, "没有数值时留 null，不用 0 冒充");
  assert.ok(state.evidence?.text.includes("几何"), state.evidence?.text);

  panel.reset();
  panel.submitPrediction({ kind: "single", choiceId: "different-120" });
  assert.equal((await panel.run()).ok, true);
  state = panel.state();
  assert.equal(state.verdict, "inconsistent");
  assert.equal(runnerCalls, 0);
});

test("实测指标缺失：运行失败并显式声明不可用，不产生 verdict", async () => {
  const { deps } = makeDeps({
    async runEvidence(_config, activity) {
      return {
        metrics: [metric("mahony", { tiltRmse: Number.NaN, yawRmse: Number.NaN })],
        termination: completed(activity.id === "accel-yaw-unobservable" ? 10 : 5),
      };
    },
  });
  const panel = panelWith(deps);
  panel.setActivity("accel-yaw-unobservable");
  panel.submitPrediction({
    kind: "multiple",
    choiceIds: ["tilt-fixable", "gravity-axis", "external-heading"],
  });
  const result = await panel.run();
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("证据不可用"), String(result.error));
  assert.ok(result.error?.includes("不可用"), String(result.error));
  const state = panel.state();
  assert.equal(state.status, "failed");
  assert.equal(state.verdict, null);
  assert.equal(state.canReveal, false);
});

test("HTML 转义：恶意反思/题目文本不会变成标记", () => {
  const escaped = escapeHtml('<script>alert("x")</script>&');
  assert.equal(
    escaped,
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;",
  );
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml(42), "42");
  assert.ok(!escaped.includes("<"));
  assert.ok(!escaped.includes(">"));
  assert.ok(panelSource.includes("reflection.value = current.reflection"), "反思按 textarea.value 纯文本回填");
  assert.ok(panelSource.includes("doc.createTextNode"), "选项文本按文本节点插入");
});

test("TQ-01 固定教学基线：题目不继承现场、校准或 A/B", async () => {
  const base = teachingBaseConfig();
  assert.equal(base.seed, 0x5eed);
  assert.equal(base.initialAttitude.kind, "level");
  assert.equal(base.magCalibration, null);
  assert.equal(base.accelCalibration, null);
  assert.equal(base.magCalibrationApplied, false);
  assert.equal(base.accelCalibrationApplied, false);
  assert.equal(base.steadyFromSec, null);
  for (const value of Object.values(base.imu)) assert.equal(value, 0, "固定基线必须把全部 IMU 参数归零");
  for (const id of Object.keys(base.estimators) as EstimatorId[]) {
    assert.equal(base.estimators[id].enabled, false, `${id} 默认关闭，由题目显式打开`);
  }
  const drift = LEARNING_ACTIVITIES.find((item) => item.id === "drift-linear-10s")!;
  const expected = evidenceRunConfigs(teachingBaseConfig(), drift)[0];
  assert.equal(expected.config.imu.gyroBiasDps, 2);
  assert.equal(expected.config.initialAttitude.kind, "level");
  assert.equal(expected.config.magCalibration, null);

  const { deps, calls } = makeDeps();
  const panel = panelWith(deps);
  panel.setActivity("drift-linear-10s");
  panel.submitPrediction({ kind: "range", min: 15, max: 25, unit: "°" });
  assert.equal((await panel.run()).ok, true);
  assert.equal(calls.runs.length, 1);
  assert.equal(calls.runs[0].config.durationSec, 10);
  assert.equal(calls.runs[0].config.imu.gyroBiasDps, 2);
  assert.equal(calls.runs[0].config.magCalibration, null);
  assert.equal(panel.state().configDigest, expected.digest);
});

test("TQ-02/03 负例：无修正与微小下降不能伪装成结论", () => {
  const yaw = LEARNING_ACTIVITIES.find((item) => item.id === "accel-yaw-unobservable")!;
  const yawRuns = [
    { id: "A", metrics: [metric("mahony", { tiltRmse: 30, yawRmse: 0 })] },
    { id: "B", metrics: [metric("mahony", { tiltRmse: 30, yawRmse: 0 })] },
    { id: "C", metrics: [metric("mahony", { tiltRmse: 0, yawRmse: 30 })] },
  ];
  const yawEval = evaluateEvidencePredicates(yaw, yawRuns);
  assert.equal(yawEval.ok, true);
  if (yawEval.ok) assert.equal(yawEval.truth.get("tilt-fixable"), false, "无修正对照不得判为倾角可修");

  const ki = LEARNING_ACTIVITIES.find((item) => item.id === "mahony-ki-bias")!;
  const kiEval = evaluateEvidencePredicates(ki, [
    { id: "A", metrics: [metric("mahony", { steadyRmse: 12.29 })] },
    { id: "B", metrics: [metric("mahony", { steadyRmse: 12.25 })] },
  ]);
  assert.equal(kiEval.ok, true);
  if (kiEval.ok) assert.equal(kiEval.truth.get("integral-removes-step"), false, "微小下降不得判为 Ki 有效");
});

await pending;
console.log(`learning-panel-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
