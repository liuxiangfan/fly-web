/** 对照 Worker 契约：真实 worker_threads + tsx bootstrap，不伪造同步 self mock。 */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  buildComparisonPair,
  comparisonDiff,
  type ComparisonVariable,
} from "../src/core/comparison-config";
import {
  defaultExperimentConfig,
  type ExperimentConfig,
} from "../src/core/experiment-config";
import { runExperimentDetailed, SERIES_CAP } from "../src/core/runner";
import type {
  ComparisonRequest,
  ComparisonResponse,
  ComparisonSide,
} from "../src/core/comparison-protocol";

let passed = 0, failed = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

type WaitFor = (predicate: (m: ComparisonResponse) => boolean) => Promise<ComparisonResponse>;

async function withWorker(
  body: (worker: Worker, messages: ComparisonResponse[], waitFor: WaitFor) => Promise<void>,
): Promise<void> {
  const worker = new Worker(new URL("./fixtures/comparison-worker-bootstrap.mjs", import.meta.url), { execArgv: [] });
  const messages: ComparisonResponse[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", message => message?.type === "fixture-ready" ? resolve() : reject(new Error("缺少ready握手")));
  });
  worker.on("message", message => {
    if (message?.type !== "fixture-ready") messages.push(message as ComparisonResponse);
  });
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker退出码${code}`)));
  });
  const waitFor: WaitFor = (predicate) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => { worker.off("message", onMessage); reject(new Error("Worker响应超过15s")); }, 15000);
    const onMessage = (message: ComparisonResponse): void => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(message);
    };
    worker.on("message", onMessage);
  });
  try {
    await ready;
    await body(worker, messages, waitFor);
  } finally {
    // 正常路径先让 Worker 自行退出；失败/挂起时兜底 terminate，避免测试进程被长跑拖住。
    worker.postMessage({ type: "fixture-close" });
    const closed = await Promise.race([
      exited.then(() => true, () => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!closed) await worker.terminate();
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const isTerminal = (jobId: number) => (m: ComparisonResponse): boolean =>
  m.jobId === jobId && (m.type === "done" || m.type === "cancelled" || m.type === "error");

function shortConfig(durationSec: number, seed: number): ExperimentConfig {
  return { ...defaultExperimentConfig(), scenario: "violent", durationSec, seed };
}

function solveRateVariable(a: number, b: number): ComparisonVariable {
  return { id: "solve-rate", label: "解算频率", a, b, affectedPaths: ["solveRateHz"] };
}
function sensorDelayVariable(a: number, b: number): ComparisonVariable {
  return { id: "sensor-delay", label: "传感器群延迟", a, b, affectedPaths: ["imu.sensorDelayMs"] };
}
function accelGateVariable(a: boolean, b: boolean): ComparisonVariable {
  return {
    id: "accel-gate", label: "方向门控", a, b,
    affectedPaths: [
      "estimators.comp.accelGate",
      "estimators.madg.accelGate",
      "estimators.mahony.accelGate",
    ],
  };
}
function observationNoiseVariable(a: number, b: number): ComparisonVariable {
  return {
    id: "observation-noise", label: "观测噪声", a, b,
    affectedPaths: ["estimators.kalman.params.obsNoise"],
  };
}

function mustPair(base: ExperimentConfig, variable: ComparisonVariable) {
  const pair = buildComparisonPair(base, variable);
  if (!pair.ok) throw new Error(`建组失败：${pair.error}`);
  return pair;
}

/** 递归检查载荷里没有 NaN/Infinity；null 表示未收敛/缺失，是显式合法值。 */
function assertFiniteNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} 为非有限数值：${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertFiniteNumbers(child, `${path}.${key}`);
  }
}

function messageLabel(m: ComparisonResponse): string {
  switch (m.type) {
    case "phase": return `phase:${m.side}:${m.phase}`;
    case "progress": return `progress:${m.side}`;
    case "side-complete": return `side-complete:${m.side}`;
    case "done": return "done";
    case "cancelled": return "cancelled";
    case "error": return "error";
  }
}

await test("实际Worker：A→B顺序完成，done差异恰为声明变量", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const base = shortConfig(0.9, 0x1001);
    const variable = sensorDelayVariable(0, 25);
    const pair = mustPair(base, variable);
    worker.postMessage({ type: "start", jobId: 1, base, variable } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(1));
    assert.equal(response.type, "done");
    if (response.type !== "done") return;

    assert.deepEqual(comparisonDiff(response.a.config, response.b.config), [...variable.affectedPaths].sort());
    assert.deepEqual(response.a.config, pair.a);
    assert.deepEqual(response.b.config, pair.b);
    assert.equal(response.a.seed, pair.a.seed);
    assert.equal(response.b.seed, pair.b.seed);
    assert.equal(response.a.termination.reason, "completed");
    assert.equal(response.b.termination.reason, "completed");

    const job = messages.filter(m => m.jobId === 1);
    const sideAIndex = job.findIndex(m => m.type === "side-complete" && m.side === "a");
    const sideBIndex = job.findIndex(m => m.type === "side-complete" && m.side === "b");
    const phaseAIndex = job.findIndex(m => m.type === "phase" && m.side === "a" && m.phase === "running");
    const phaseBIndex = job.findIndex(m => m.type === "phase" && m.side === "b" && m.phase === "running");
    const doneIndex = job.findIndex(m => m.type === "done");
    assert.ok(phaseAIndex >= 0 && phaseAIndex < sideAIndex, "A 必须先从 running 开始再完成");
    assert.ok(sideAIndex < phaseBIndex && phaseBIndex < sideBIndex, "B 必须在 A 完成后才开始");
    assert.ok(sideBIndex < doneIndex, "done 必须在两侧完成之后");
    assert.equal(job.filter(m => m.type === "side-complete" && m.side === "a").length, 1);
    assert.equal(job.filter(m => m.type === "side-complete" && m.side === "b").length, 1);
    assert.equal(job.filter(m => m.type === "done").length, 1);
    assert.equal(job.filter(m => m.type === "error" || m.type === "cancelled").length, 0);

    const sideAMessage = job[sideAIndex];
    const sideBMessage = job[sideBIndex];
    assert.equal(sideAMessage.type, "side-complete");
    assert.equal(sideBMessage.type, "side-complete");
    if (sideAMessage.type === "side-complete") assert.deepEqual(response.a, sideAMessage.result);
    if (sideBMessage.type === "side-complete") assert.deepEqual(response.b, sideBMessage.result);
    console.log(`  ${job.map(messageLabel).join(" → ")}`);
  });
});

await test("实际Worker：A/B载荷与直接runExperimentDetailed逐位一致", async () => {
  await withWorker(async (worker, _messages, waitFor) => {
    const base = shortConfig(1.0, 0x2002);
    const variable = accelGateVariable(true, false);
    const pair = mustPair(base, variable);
    worker.postMessage({ type: "start", jobId: 2, base, variable } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(2));
    assert.equal(response.type, "done");
    if (response.type !== "done") return;

    for (const side of ["a", "b"] as const) {
      const config = side === "a" ? pair.a : pair.b;
      const direct = runExperimentDetailed(config);
      const actual: ComparisonSide = response[side];
      assert.deepEqual(actual.config, direct.config);
      assert.deepEqual(actual.metrics, direct.metrics);
      assert.deepEqual(actual.series, direct.series);
      assert.deepEqual(actual.events, direct.events);
      assert.deepEqual(actual.finalQuats, direct.finalQuats);
      assert.deepEqual(actual.termination, direct.termination);
      assert.equal(actual.seed, config.seed, "seed必须显式回传");
      assert.equal(actual.termination.reason, "completed");
      console.log(`  ${side.toUpperCase()} 侧 ${actual.metrics.map(m => `${m.id}:${m.n}`).join(" ")}`);
    }
  });
});

await test("实际Worker：A运行中取消→completedSides=0，无side-complete/done且取消后静默", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    worker.postMessage({
      type: "start", jobId: 3, base: shortConfig(5, 0x3003), variable: solveRateVariable(500, 50),
    } satisfies ComparisonRequest);
    worker.postMessage({ type: "cancel", jobId: 3 } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(3));
    assert.equal(response.type, "cancelled");
    if (response.type !== "cancelled") return;
    assert.equal(response.completedSides, 0);

    const cancelledAt = messages.indexOf(response);
    await sleep(100);
    assert.ok(!messages.slice(cancelledAt + 1).some(m => m.jobId === 3), "取消后旧continuation必须沉默");
    assert.ok(!messages.some(m => m.jobId === 3 && m.type === "done"));
    assert.ok(!messages.some(m => m.jobId === 3 && m.type === "side-complete"));
    console.log(`  取消前消息：${messages.slice(0, cancelledAt + 1).map(messageLabel).join(" → ")}`);
  });
});

await test("实际Worker：A完成后B运行中取消→completedSides=1，无done", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    // A=50 Hz 先完成；B=500 Hz 留出足够的取消窗口。
    const base = shortConfig(1.0, 0x4004);
    const variable = solveRateVariable(50, 500);
    worker.postMessage({ type: "start", jobId: 4, base, variable } satisfies ComparisonRequest);
    const sideA = await waitFor(m => m.jobId === 4 && m.type === "side-complete" && m.side === "a");
    assert.equal(sideA.type, "side-complete");
    if (sideA.type !== "side-complete") return;
    assert.equal(sideA.result.termination.reason, "completed");

    worker.postMessage({ type: "cancel", jobId: 4 } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(4));
    assert.equal(response.type, "cancelled");
    if (response.type !== "cancelled") return;
    assert.equal(response.completedSides, 1);

    const cancelledAt = messages.indexOf(response);
    await sleep(150);
    assert.ok(!messages.slice(cancelledAt + 1).some(m => m.jobId === 4), "取消后不得再有progress/side-complete/done");
    assert.ok(!messages.some(m => m.jobId === 4 && m.type === "done"));
    assert.ok(!messages.some(m => m.jobId === 4 && m.type === "side-complete" && m.side === "b"));
    console.log(`  取消前消息：${messages.slice(0, cancelledAt + 1).map(messageLabel).join(" → ")}`);
  });
});

await test("实际Worker：新job有序替代，迟到cancel/stale start与旧续体不能污染", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const oldBase = shortConfig(10, 0x5005);
    const oldVariable = solveRateVariable(500, 50);
    worker.postMessage({ type: "start", jobId: 10, base: oldBase, variable: oldVariable } satisfies ComparisonRequest);
    await waitFor(m => m.jobId === 10 && (m.type === "phase" || m.type === "progress"));

    const newBase = shortConfig(0.8, 0x5006);
    const newVariable = sensorDelayVariable(0, 25);
    const pair = mustPair(newBase, newVariable);
    worker.postMessage({ type: "start", jobId: 11, base: newBase, variable: newVariable } satisfies ComparisonRequest);
    worker.postMessage({ type: "cancel", jobId: 10 } satisfies ComparisonRequest);
    worker.postMessage({ type: "start", jobId: 9, base: oldBase, variable: oldVariable } satisfies ComparisonRequest);

    const response = await waitFor(isTerminal(11));
    assert.equal(response.type, "done");
    if (response.type !== "done") return;
    assert.deepEqual(response.a.config, pair.a);
    assert.deepEqual(response.b.config, pair.b);

    const cancelled10 = messages.filter(m => m.jobId === 10 && m.type === "cancelled");
    assert.equal(cancelled10.length, 1, "被替代的job只发一条cancelled");
    const cancelledAt = messages.indexOf(cancelled10[0]);
    await sleep(150);
    assert.ok(!messages.slice(cancelledAt + 1).some(m => m.jobId === 10), "旧job的迟到消息必须被拦截");
    assert.ok(!messages.some(m => m.jobId === 9), "stale start不得复活旧任务");
    assert.equal(messages.filter(m => m.jobId === 11 && m.type === "done").length, 1);
    assert.equal(messages.filter(m => m.jobId === 11 && (m.type === "cancelled" || m.type === "error")).length, 0);
    console.log(`  消息顺序 ${messages.map(m => `${m.jobId}:${messageLabel(m)}`).join(" → ")}`);
  });
});

await test("实际Worker：非法变量/基线返回side=null错误，后续job仍可正常完成", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const base = shortConfig(0.6, 0x6007);
    const badVariable = {
      id: "not-a-variable", label: "非法变量", a: 1, b: 2, affectedPaths: ["x"],
    } as unknown as ComparisonVariable;
    worker.postMessage({ type: "start", jobId: 21, base, variable: badVariable } satisfies ComparisonRequest);
    const error1 = await waitFor(isTerminal(21));
    assert.equal(error1.type, "error");
    if (error1.type === "error") {
      assert.equal(error1.side, null);
      assert.ok(error1.message.includes("未知对照变量"), error1.message);
    }
    assert.ok(!messages.some(m => m.jobId === 21 && (m.type === "done" || m.type === "side-complete")));

    worker.postMessage({
      type: "start", jobId: 22, base: { ...base, durationSec: -1 }, variable: sensorDelayVariable(0, 25),
    } satisfies ComparisonRequest);
    const error2 = await waitFor(isTerminal(22));
    assert.equal(error2.type, "error");
    if (error2.type === "error") {
      assert.equal(error2.side, null);
      assert.ok(error2.message.includes("基线配置无效"), error2.message);
    }
    assert.ok(!messages.some(m => m.jobId === 22 && (m.type === "done" || m.type === "side-complete")));

    const variable = sensorDelayVariable(0, 25);
    const pair = mustPair(base, variable);
    worker.postMessage({ type: "start", jobId: 23, base, variable } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(23));
    assert.equal(response.type, "done");
    if (response.type === "done") {
      assert.deepEqual(response.a.config, pair.a);
      assert.deepEqual(response.b.config, pair.b);
    }
    assert.equal(messages.filter(m => m.type === "done").length, 1);
    assert.equal(messages.filter(m => m.type === "error").length, 2);
    console.log(`  错误消息：${messages.filter(m => m.type === "error").map(m => m.type === "error" ? m.message : "").join(" | ")}`);
  });
});

await test("实际Worker：完整载荷数值有限，五条ErrorSeries不超过SERIES_CAP", async () => {
  await withWorker(async (worker, _messages, waitFor) => {
    const base = shortConfig(0.8, 0x7008);
    const variable = observationNoiseVariable(0.05, 0.2);
    worker.postMessage({ type: "start", jobId: 31, base, variable } satisfies ComparisonRequest);
    const response = await waitFor(isTerminal(31));
    assert.equal(response.type, "done");
    if (response.type !== "done") return;

    const expectedIds = ["pure", "comp", "mahony", "madg", "kalman"];
    for (const side of ["a", "b"] as const) {
      const payload: ComparisonSide = response[side];
      assertFiniteNumbers(payload, side);
      assert.equal(payload.series.length, 5, "必须保留五算法的完整ErrorSeries");
      assert.deepEqual(payload.series.map(s => s.id), expectedIds);
      for (const series of payload.series) {
        assert.ok(series.t.length > 0, `${side}.${series.id} 无样本`);
        assert.ok(series.t.length <= SERIES_CAP, `${side}.${series.id} 超过SERIES_CAP`);
        assert.equal(series.errDeg.length, series.t.length, `${side}.${series.id} t/err长度不一致`);
        assert.ok(series.t.every(Number.isFinite));
        assert.ok(series.errDeg.every(Number.isFinite));
      }
      for (const metric of payload.metrics) {
        const required = [
          "n", "mean", "rmse", "max", "p50", "p95", "steadyRmse", "tiltRmse", "yawRmse", "gateRejects",
        ] as const;
        for (const key of required) {
          assert.ok(Number.isFinite(metric[key]), `${side}.${metric.id}.${key} 非有限`);
        }
        assert.ok(metric.convergedAt === null || Number.isFinite(metric.convergedAt));
        console.log(`  ${side}.${metric.id}: n=${metric.n}, rmse=${metric.rmse.toFixed(3)}°, series=${payload.series.find(s => s.id === metric.id)?.t.length ?? 0}`);
      }
    }
  });
});

console.log(`comparison-worker-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
