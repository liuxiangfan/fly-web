/** Worker/runner 契约：真实 worker_threads + tsx bootstrap，不用伪造同步 self mock。 */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { defaultExperimentConfig, type ExperimentConfig } from "../src/core/experiment-config";
import { MetricAccumulator, percentileTask, runExperiment, runExperimentAsync, runExperimentDetailed, runExperimentDetailedAsync, runTrace, RUN_H } from "../src/core/runner";
import { percentile } from "../src/core/stats";
import type { BatchRequest, BatchResponse } from "../src/core/batch-protocol";

let passed = 0, failed = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

async function withWorker(body: (worker: Worker, messages: BatchResponse[], waitFor: (predicate: (m: BatchResponse) => boolean) => Promise<BatchResponse>) => Promise<void>): Promise<void> {
  const worker = new Worker(new URL("./fixtures/batch-worker-bootstrap.mjs", import.meta.url), { execArgv: [] });
  const messages: BatchResponse[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", message => message.type === "fixture-ready" ? resolve() : reject(new Error("缺少ready握手")));
  });
  worker.on("message", message => { if (message.type !== "fixture-ready") messages.push(message as BatchResponse); });
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker退出码${code}`)));
  });
  const waitFor = (predicate: (m: BatchResponse) => boolean): Promise<BatchResponse> => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => { worker.off("message", onMessage); reject(new Error("Worker响应超过15s")); }, 15000);
    const onMessage = (message: BatchResponse): void => {
      if (!predicate(message)) return;
      clearTimeout(timer); worker.off("message", onMessage); resolve(message);
    };
    worker.on("message", onMessage);
  });
  try { await ready; await body(worker, messages, waitFor); }
  finally { worker.postMessage({ type: "fixture-close" }); await exited; }
}
const terminal = (jobId: number) => (m: BatchResponse): boolean => m.jobId === jobId && (m.type === "done" || m.type === "cancelled" || m.type === "error");

await test("实际Worker：start后立即cancel必须cancelled而非done", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const request: BatchRequest = { type: "start", jobId: 1, config: { ...defaultExperimentConfig(), durationSec: 30 }, seeds: [11, 12] };
    const t0 = performance.now();
    worker.postMessage(request);
    worker.postMessage({ type: "cancel", jobId: 1 } satisfies BatchRequest);
    const response = await waitFor(terminal(1));
    const elapsed = performance.now() - t0;
    console.log(`  cancel响应 ${elapsed.toFixed(1)}ms；消息 ${messages.map(m => m.type).join(",")}`);
    assert.equal(response.type, "cancelled");
    assert.ok(elapsed < 1000, `cancel响应超限：${elapsed}ms`);
    if (response.type === "cancelled") assert.equal(response.done, 0, "未完成种子不能入账");
    assert.ok(!messages.some(m => m.type === "done"), "cancel后不得done");
  });
});

await test("实际Worker：运行中心跳后cancel在1s内响应且部分种子不入账", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    worker.postMessage({ type: "start", jobId: 2, config: { ...defaultExperimentConfig(), durationSec: 600 }, seeds: [21] } satisfies BatchRequest);
    const beat = await waitFor(m => m.jobId === 2 && (m.type === "heartbeat" || m.type === "done" || m.type === "error"));
    assert.equal(beat.type, "heartbeat", "必须在种子运行中取消，不是跑完后取消");
    const t0 = performance.now();
    worker.postMessage({ type: "cancel", jobId: 2 } satisfies BatchRequest);
    const response = await waitFor(terminal(2));
    const elapsed = performance.now() - t0;
    console.log(`  运行中cancel响应 ${elapsed.toFixed(1)}ms`);
    assert.equal(response.type, "cancelled");
    assert.ok(elapsed < 1000, `cancel响应超限：${elapsed}ms`);
    if (response.type === "cancelled") assert.equal(response.done, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = messages.slice(messages.indexOf(response) + 1);
    assert.ok(!after.some(m => m.jobId === 2), "取消后旧continuation必须沉默");
  });
});

await test("实际Worker：取消时仅保留完整种子，第二种子不串入完成次数", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    worker.postMessage({ type: "start", jobId: 3, config: { ...defaultExperimentConfig(), durationSec: 0.8 }, seeds: [31, 32, 33] } satisfies BatchRequest);
    await waitFor(m => m.jobId === 3 && m.type === "progress");
    worker.postMessage({ type: "cancel", jobId: 3 } satisfies BatchRequest);
    const response = await waitFor(terminal(3));
    assert.equal(response.type, "cancelled");
    if (response.type === "cancelled") assert.equal(response.done, 1);
    assert.equal(messages.filter(m => m.type === "progress" && m.jobId === 3).length, 1);
  });
});

await test("实际Worker：连续新job有序替代，迟到cancel/start和旧续体不能污染最新job", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const slow = { ...defaultExperimentConfig(), durationSec: 600 };
    const latest = { ...defaultExperimentConfig(), scenario: "violent", durationSec: 0.6, seed: 41 };
    worker.postMessage({ type: "start", jobId: 10, config: slow, seeds: [10] } satisfies BatchRequest);
    worker.postMessage({ type: "start", jobId: 11, config: slow, seeds: [11] } satisfies BatchRequest);
    worker.postMessage({ type: "start", jobId: 12, config: latest, seeds: [41, 42] } satisfies BatchRequest);
    worker.postMessage({ type: "cancel", jobId: 11 } satisfies BatchRequest);
    worker.postMessage({ type: "start", jobId: 10, config: slow, seeds: [99] } satisfies BatchRequest);
    const response = await waitFor(terminal(12));
    assert.equal(response.type, "done");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(messages.filter(m => m.type === "heartbeat").every(m => m.jobId === 12), "旧job的心跳也必须沉默");
    assert.deepEqual(messages.filter(m => m.type !== "heartbeat").map(m => `${m.jobId}:${m.type}`), ["10:cancelled", "11:cancelled", "12:progress", "12:progress", "12:done"]);
    if (response.type === "done") {
      assert.deepEqual(response.metricsList, [41, 42].map(seed => runExperiment({ ...latest, seed }).metrics));
    }
    console.log(`  消息顺序 ${messages.map(m => `${m.jobId}:${m.type}`).join(" → ")}`);
  });
});

await test("实际Worker：正常多seed按序progress/done且指标逐位等同同步runner", async () => {
  await withWorker(async (worker, messages, waitFor) => {
    const config = { ...defaultExperimentConfig(), durationSec: 1.1003, solveRateHz: 200, scenario: "violent" };
    const seeds = [51, 52, 53];
    worker.postMessage({ type: "start", jobId: 20, config, seeds } satisfies BatchRequest);
    const response = await waitFor(terminal(20));
    assert.equal(response.type, "done");
    assert.deepEqual(messages.filter(m => m.type === "progress").map(m => m.type === "progress" ? [m.done, m.total, m.seed] : []), [[1, 3, 51], [2, 3, 52], [3, 3, 53]]);
    if (response.type === "done") assert.deepEqual(response.metricsList, seeds.map(seed => runExperiment({ ...config, seed }).metrics));
  });
});

const alignmentConfig: ExperimentConfig = {
  ...defaultExperimentConfig(), scenario: "manual", durationSec: 8,
  initialAttitude: { kind: "fixed-axis", axis: [1, 0, 0], angleDeg: 35 },
};
alignmentConfig.estimators.comp = { ...alignmentConfig.estimators.comp, rampEnabled: false, params: { alpha: 0.01 } };
const equivalenceCases: Array<[string, ExperimentConfig]> = [
  ["默认golden", defaultExperimentConfig()],
  ["violent/200Hz golden", { ...defaultExperimentConfig(), scenario: "violent", durationSec: 12, seed: 777, solveRateHz: 200 }],
  ["粗对准事件", alignmentConfig],
  ["manual+校准+stats截断", {
    ...defaultExperimentConfig(), scenario: "manual", manualTargetDeg: [25, -15, 65], durationSec: 3,
    magCalibrationApplied: true, magCalibration: { kind: "diag", offset: [1, -2, 3], scale: [1.01, 0.98, 1.03], field: 50, residual: 0.01, count: 120 },
    imu: { ...defaultExperimentConfig().imu, sensorSampleHz: 200, sensorDelayMs: 7.5, sensorBandwidthHz: 80 },
  }],
];
for (const [name, config] of equivalenceCases) {
  await test(`同步/异步同seed完整结果、所有指标/事件/序列逐位相等：${name}`, async () => {
    const options = name.includes("截断") ? { statsCapOverride: 10 } : {};
    const synchronous = runExperimentDetailed(config, options);
    const asynchronous = await runExperimentDetailedAsync(config, { ...options, stepsPerSlice: 127 });
    assert.deepEqual(asynchronous, synchronous);
    const { series: _series, ...base } = synchronous;
    assert.deepEqual(await runExperimentAsync(config, { ...options, stepsPerSlice: 512 }), base);
    if (name === "粗对准事件") assert.ok(synchronous.events.some(e => e.type === "align"), "用例必须实际触发对准事件");
    if (name.includes("截断")) assert.ok(synchronous.metrics.every(m => m.percentileApprox));
    if (name.includes("golden")) {
      const snapshot = synchronous.metrics.map(m => `${m.id}=${m.rmse.toFixed(4)}/${m.steadyRmse.toFixed(4)}`).join(" ");
      const expected = name === "默认golden"
        ? "pure=17.1806/24.0518 comp=1.5677/1.5853 mahony=1.0486/0.7463 madg=1.3593/1.3517 kalman=1.2021/1.1128"
        : "pure=2.8363/3.7988 comp=4.4326/3.1868 mahony=4.6080/3.2442 madg=4.0926/3.0673 kalman=5.0006/4.6157";
      assert.equal(snapshot, expected, "既有golden不可漂移");
      console.log(`  ${snapshot}`);
    }
  });
}

await test("异步路径实际让出macrotask；计时器取消不受progress频率限制", async () => {
  let cancelled = false;
  const timer = setTimeout(() => { cancelled = true; }, 5);
  const result = await runExperimentDetailedAsync({ ...defaultExperimentConfig(), durationSec: 30 }, {
    stepsPerSlice: 8, progressEverySec: 1000, shouldCancel: () => cancelled,
  });
  clearTimeout(timer);
  assert.equal(result.termination.reason, "cancelled");
  assert.ok(result.termination.endSec < 1, "微任务让出不能响应计时器，世界不应跑满30s");
  assert.ok(result.metrics.every(m => m.steadyMode === "early-stop"));
});

await test("同步/异步progress钩子取消时刻与部分序列逐位相等", async () => {
  const config = { ...defaultExperimentConfig(), durationSec: 8 };
  const options = { progressEverySec: 1, onProgress: (t: number): boolean => t < 2 };
  const sync = runExperimentDetailed(config, options);
  const asyncResult = await runExperimentDetailedAsync(config, { ...options, stepsPerSlice: 31 });
  assert.deepEqual(asyncResult, sync);
  assert.equal(sync.termination.reason, "cancelled");
});

await test("无solve终止为null，全段记pendingTail；预取消不推进世界", async () => {
  const config = { ...defaultExperimentConfig(), durationSec: 0.001, solveRateHz: 1 };
  const result = runExperiment(config);
  assert.equal(result.termination.lastSolveSec, null);
  assert.equal(result.termination.endSec, 0.001);
  assert.equal(result.termination.pendingTailSec, 0.001);
  assert.ok(result.metrics.every(m => m.n === 0));
  assert.deepEqual(await runExperimentAsync(config), result);
  const cancelled = await runExperimentAsync(config, { shouldCancel: () => true });
  assert.equal(cancelled.termination.reason, "cancelled");
  assert.equal(cancelled.termination.endSec, 0);
  assert.equal(cancelled.termination.lastSolveSec, null);
});

await test("非整步时长精确截末步，trace/同步/异步不超请求；整步步长保持原值", async () => {
  for (const durationSec of [0.0003, 0.0031, 1.1003, 2.0001]) {
    const config = { ...defaultExperimentConfig(), durationSec };
    const result = runExperiment(config);
    assert.ok(result.termination.endSec <= durationSec);
    assert.ok(Math.abs(result.termination.endSec - durationSec) < 1e-12);
    const trace = runTrace(config);
    assert.equal(trace.endSec, result.termination.endSec);
    assert.ok(trace.steps.every(step => step.t <= durationSec));
    assert.deepEqual(await runExperimentAsync(config), result);
  }
  const trace = runTrace({ ...defaultExperimentConfig(), durationSec: 1 });
  assert.equal(trace.steps.length, 500);
  assert.ok(trace.steps.every(step => step.dt === RUN_H), "整步golden路径h不能调整");
});

/**
 * SW-10 的**协作取消契约**（主线程降级路径真正依赖的那几件事）：
 *   · 取消在**下一个计算片**生效，而不是等整个种子跑完（旧实现要在同步循环里等 ~550 ms）；
 *   · 片预算有界，且只影响调度、不影响数值结果；
 *   · 被取消的种子带着 `termination.reason === "cancelled"` 出来，调用方据此把它从完成统计里丢掉
 *     （"半成品不许计入完成"这条在主线程降级分支与冒烟用例里各有一道断言）。
 * 「让出的是 macrotask」由上面的计时器用例单独钉住，这里不重复。
 */
await test("协作取消：取消在下一片生效，片预算有界且只影响调度", async () => {
  const config = { ...defaultExperimentConfig(), durationSec: 30 };
  let sliceCount = 0;
  const startedAt = Date.now();
  const cancelled = await runExperimentAsync(config, {
    stepsPerSlice: 128,
    onProgress: () => { sliceCount++; return true; },
    shouldCancel: () => sliceCount >= 1,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(cancelled.termination.reason, "cancelled", "取消后必须报告 cancelled，而不是「跑完了」");
  assert.ok(cancelled.termination.endSec < config.durationSec, `取消点必须早于末点：${cancelled.termination.endSec}`);
  assert.ok(sliceCount <= 3, `取消必须在下一片生效（实际经过 ${sliceCount} 片）`);
  assert.ok(elapsedMs < 2000, `取消响应必须远小于整段计算（实际 ${elapsedMs} ms）`);

  // 片预算：越界/非有限值被夹到 [1,512]，且数值结果与同步路径逐位一致
  const one = { ...defaultExperimentConfig(), durationSec: 1 };
  const coerced = await runExperimentAsync(one, { stepsPerSlice: 100000 as unknown as number });
  assert.equal(coerced.termination.reason, "completed");
  assert.deepEqual(await runExperimentAsync(one), runExperiment(one), "片预算只影响调度，不允许影响数值结果");
});

await test("墙钟预算先于步数上限让出，完整数值不变，停止回调在异步返回之前", async () => {
  const config = { ...defaultExperimentConfig(), durationSec: 0.1 };
  const slices: Array<{ steps: number; computeMs: number; completed: boolean }> = [];
  let clock = 0;
  let stopped = false;
  const result = await runExperimentAsync(config, {
    stepsPerSlice: 512, maxSliceMs: 4,
    sliceClock: () => clock++,
    onSlice: slice => slices.push(slice),
    onStop: () => { stopped = true; },
  });
  assert.ok(stopped);
  assert.ok(slices.length > 1);
  assert.ok(slices.filter(s => !s.completed).every(s => s.steps <= 4), "时钟预算必须实际触发，而不是只声明字段");
  assert.deepEqual(result, runExperiment(config));
  let cancelled = false;
  let stoppedAfterCancel = false;
  const partial = await runExperimentAsync({ ...config, durationSec: 30 }, {
    maxSliceMs: 4, sliceClock: () => clock++,
    onSlice: () => { cancelled = true; },
    shouldCancel: () => cancelled,
    onStop: () => { stoppedAfterCancel = cancelled; },
  });
  assert.equal(partial.termination.reason, "cancelled");
  assert.ok(stoppedAfterCancel);
});

await test("30s/15000步收尾按4ms/128步预算合并checkpoint，onStop早于扫描且原样本/完整结果逐位一致", async () => {
  const config = { ...defaultExperimentConfig(), durationSec: 30 };
  const sync = runExperimentDetailed(config);
  // 独立原生排序 oracle；同步与异步共用新实现不能充当彼此唯一的正确性证据。
  for (const [i, series] of sync.series.entries()) {
    assert.ok(Object.is(sync.metrics[i].p50, percentile(series.errDeg, 0.5)));
    assert.ok(Object.is(sync.metrics[i].p95, percentile(series.errDeg, 0.95)));
  }
  const nativeSort = Array.prototype.sort, nativeSummary = MetricAccumulator.prototype.summaryTask;
  const tailSlices: Array<{ steps: number; computeMs: number; completed: boolean }> = [];
  let stopped = false, stopCount = 0, turns = 0, summaries = 0, scans = 0;
  let progressAtStop = 0, progress = 0, stoppedAt = 0, timerAt = performance.now(), checkpoints = 0;
  const timerDelays: number[] = [];
  const runTimer = setInterval(() => {
    const now = performance.now();
    timerDelays.push(now - timerAt); timerAt = now;
  }, 10);
  Array.prototype.sort = function<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
    if (stopped && this.length >= 15000) assert.fail("正常有限样本不得退回不可抢占全排序");
    return nativeSort.call(this, compareFn) as T[];
  };
  MetricAccumulator.prototype.summaryTask = function*(...args) {
    assert.ok(stopped, "onStop必须在任何summary扫描之前");
    assert.equal(turns, tailSlices.length, "首扫描前及每个工作片间必须真实处理计时器");
    summaries++;
    let reads = 0;
    const errors = this.errors;
    Object.defineProperty(this, "errors", {
      configurable: true,
      value: new Proxy(errors, { get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      } }),
    });
    const task = nativeSummary.apply(this, args);
    try {
      for (;;) {
        reads = 0;
        const step = task.next();
        assert.ok(reads <= 128, `样本复制片不能超过128项：${reads}`);
        scans += reads;
        if (step.done) return step.value;
        if (step.value === undefined) checkpoints++;
        yield step.value;
      }
    } finally { Object.defineProperty(this, "errors", { configurable: true, value: errors }); }
  };
  try {
    const asyncResult = await runExperimentDetailedAsync(config, {
      stepsPerSlice: 128, maxSliceMs: 4,
      onProgress: () => { assert.ok(!stopped, "onStop之后不得继续积分/发进度"); progress++; },
      onStop: () => {
        stopped = true; stopCount++; progressAtStop = progress;
        stoppedAt = performance.now();
      },
      onSlice: slice => {
        if (!stopped) return;
        assert.equal(turns, tailSlices.length, "工作片之间必须有macrotask，不是微任务");
        tailSlices.push(slice);
        if (!slice.completed) setTimeout(() => { turns++; }, 0);
      },
    });
    assert.equal(stopCount, 1);
    assert.equal(progress, progressAtStop);
    assert.equal(summaries, 5, "五算法P50/P95必须全部保留");
    assert.equal(scans, 75000, "两分位数共用一次副本；样本数不许削减");
    assert.ok(checkpoints > 5 * Math.floor(15000 / 128));
    assert.ok(tailSlices.length < checkpoints / 4, "有限checkpoint必须按预算合并，不得逐checkpoint等timer");
    assert.equal(turns, tailSlices.length - 1, "最后一个分位数终点之后也要处理取消消息");
    assert.ok(tailSlices.slice(1).every(slice => slice.steps <= 128));
    assert.ok(tailSlices.some(slice => slice.steps > 1), "统计checkpoint必须实际合并");
    assert.deepEqual(tailSlices.map(slice => slice.completed), [...Array(tailSlices.length - 1).fill(false), true]);
    assert.ok(asyncResult.metrics.every(metric => metric.n === 15000));
    assert.deepEqual(asyncResult, sync, "metrics/事件次序/终止口径/姿态/完整samples逐位相等");
    const wall = performance.now() - stoppedAt;
    clearInterval(runTimer);
    const peak = Math.max(...tailSlices.slice(1, -1).map(slice => slice.computeMs));
    assert.ok(peak <= 200, `收尾单片不得越过固定200ms目标：${peak}ms`);
    const delays = timerDelays.sort((a, b) => a - b), p95 = delays[Math.ceil(delays.length * 0.95) - 1];
    assert.ok(delays.length >= 40, `响应采样不得削减：${delays.length}`);
    assert.ok(p95 <= 200, `计时器p95不得越过固定200ms目标：${p95}ms`);
    const compute = tailSlices.reduce((sum, slice) => sum + slice.computeMs, 0);
    console.log(`  收尾 ${tailSlices.length} 片；计算总${compute.toFixed(1)}ms/峰值${peak.toFixed(1)}ms；墙钟${wall.toFixed(1)}ms；timer ${delays.length}样本/p95 ${p95.toFixed(1)}ms；五算法各15000样本`);
  } finally {
    clearInterval(runTimer);
    Array.prototype.sort = nativeSort;
    MetricAccumulator.prototype.summaryTask = nativeSummary;
  }
});

await test("收尾首/中/末片计时器取消：onStop单次、终止时刻不漂移、全部指标统一early-stop", async () => {
  const config = { ...alignmentConfig, durationSec: 4 };
  const sync = runExperimentDetailed(config);
  let tailCount = 0, countingTail = false;
  assert.deepEqual(await runExperimentDetailedAsync(config, {
    stepsPerSlice: 128, maxSliceMs: 4,
    onStop: () => { countingTail = true; },
    onSlice: slice => { if (countingTail && !slice.completed) tailCount++; },
  }), sync);
  for (const cancelAfterSlice of [0, Math.floor(tailCount / 2), tailCount - 1]) {
    let stopped = false, stopCount = 0, cancelled = false, tailSlice = 0, progressAtStop = 0, progress = 0;
    const result = await runExperimentDetailedAsync(config, {
      stepsPerSlice: 128, maxSliceMs: 4,
      shouldCancel: () => cancelled,
      onProgress: () => { assert.ok(!stopped); progress++; },
      onStop: () => { stopped = true; stopCount++; progressAtStop = progress; },
      onSlice: slice => {
        if (stopped && tailSlice++ === cancelAfterSlice) {
          assert.equal(slice.completed, false, "取消必须在返回前的收尾片触发");
          setTimeout(() => { cancelled = true; }, 0);
        }
      },
    });
    assert.ok(cancelled);
    assert.equal(stopCount, 1);
    assert.equal(progress, progressAtStop);
    assert.equal(result.termination.reason, "cancelled");
    assert.equal(result.termination.cancelledAtSec, sync.termination.endSec);
    assert.equal(result.metrics.length, 5, "收尾取消不得返回半组算法指标");
    assert.ok(result.metrics.every(metric => metric.steadyMode === "early-stop"));
    assert.deepEqual(result, {
      ...sync,
      termination: { ...sync.termination, reason: "cancelled", cancelledAtSec: sync.termination.endSec },
      metrics: sync.metrics.map(metric => ({ ...metric, steadyMode: "early-stop" })),
    }, "取消只改显式终止口径；完整samples/事件次序/数值与积分末态保持不变");
  }
});

function drain<T>(task: Generator<true | void, T, void>): T {
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
    assert.ok(step.value === undefined || step.value === true, "checkpoint或分位数终点必须使用共享调度协议");
  }
}

await test("精确分位数：原生sort逐位oracle，大量随机/重复/边界/非有限值，输入不变", async () => {
  let seed = 0x12345678;
  const random = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const ps = [0.5, 0.95, 0, 1, -1, 2, 0.01, 0.99, 0.25, NaN, Infinity, -Infinity];
  const cases: number[][] = [
    [], [NaN], [Infinity], [-Infinity], [-0], [0], [-0, 0, -0, 0],
    [Number.MAX_VALUE, -Number.MAX_VALUE], [Number.MIN_VALUE, -Number.MIN_VALUE],
    [NaN, 2, Infinity, 1, -Infinity], [3, NaN, 1, NaN, -0, 0, Infinity, -Infinity],
    [Infinity, Infinity, -Infinity, -Infinity, 0, -0],
  ];
  for (const n of [...Array.from({ length: 65 }, (_, i) => i), 127, 128, 129, 255, 256, 257, 15000, 20000, 60000]) {
    const values = Array.from({ length: n }, () => (random() - 0.5) * 1e6);
    cases.push(values, values.map(v => Math.floor(v / 1e5)), Array(n).fill(3));
    const sorted = [...values].sort((a, b) => a - b);
    cases.push(sorted, [...sorted].reverse(), Array.from({ length: n }, (_, i) => Math.min(i, n - i)));
  }
  for (let i = 0; i < 200; i++) {
    cases.push(Array.from({ length: Math.floor(random() * 2048) }, () => {
      const r = random();
      return r < 0.05 ? -0 : r < 0.1 ? 0 : r < 0.15 ? Infinity : r < 0.2 ? -Infinity : Math.floor(r * 64);
    }));
  }
  for (const values of cases) {
    const original = [...values], probabilities = [...ps, random()];
    const expected = probabilities.map(p => percentile(values, p));
    const result = drain(percentileTask(values, probabilities));
    result.forEach((value, i) => assert.ok(Object.is(value, expected[i]), `n=${values.length}, p=${probabilities[i]}: ${value} ≠ ${expected[i]}`));
    assert.deepEqual(values, original, "精确选择不得改动输入samples");
  }
  console.log(`  ${cases.length}组输入，${cases.length * (ps.length + 1)}项分位数逐位等价`);
});

await test("分区工作量有界：复制/三路比较/邻秩扫描每次next至多256次数值比较", async () => {
  for (const duplicate of [false, true]) {
    let comparisons = 0, slices = 0;
    const values = Array.from({ length: 60000 }, (_, i) => ({
      valueOf: () => { comparisons++; return duplicate ? 3 : (i * 7919) % 60000; },
    })) as unknown as number[];
    const task = percentileTask(values, [0.5, 0.95]);
    for (;;) {
      comparisons = 0;
      const step = task.next();
      // 盒装数仅用于观测：一次 a < pivot 会转换两个操作数；最多512次转换=256次比较。
      assert.ok(comparisons <= 512, `不可抢占工作超过256次数值比较：${comparisons}次转换`);
      slices++;
      if (step.done) break;
      assert.ok(step.value === undefined || step.value === true);
    }
    assert.ok(slices > Math.floor(values.length / 128));
  }
});

await test("MetricAccumulator原分位数口径保留：空样本/非有限数/重复值/有界蓄水池", async () => {
  const estimator = { id: "pure", label: "test" } as Parameters<MetricAccumulator["summary"]>[0];
  for (const values of [[], [3], [3, 1, 3, -0, 0, 2], [NaN, 2, Infinity, 1, -Infinity]]) {
    const acc = new MetricAccumulator();
    for (const [i, value] of values.entries()) acc.add(value, { w: 1, x: 0, y: 0, z: 0 }, i);
    const original = [...acc.errors];
    const summary = acc.summary(estimator);
    assert.ok(Object.is(summary.p50, percentile(original, 0.5)));
    assert.ok(Object.is(summary.p95, percentile(original, 0.95)));
    assert.deepEqual(acc.errors, original, "排序不得原地修改保留samples");
    assert.deepEqual(drain(acc.summaryTask(estimator)), summary);
  }
  const acc = new MetricAccumulator({ capOverride: 10, plannedEndSec: 50 });
  for (let i = 0; i < 25000; i++) acc.add(3 + Math.sin(i), { w: 1, x: 0, y: 0, z: 0 }, i / 500);
  assert.ok(acc.diagnostics().truncated);
  assert.equal(acc.diagnostics().reservoirErr, 20000);
  const samples = [...acc.errors], times = [...acc.times];
  const reservoir = [...(acc as unknown as { resErr: number[] }).resErr];
  const summary = acc.summary(estimator);
  assert.ok(Object.is(summary.p50, percentile(reservoir, 0.5)));
  assert.ok(Object.is(summary.p95, percentile(reservoir, 0.95)));
  assert.ok(summary.percentileApprox);
  assert.deepEqual(drain(acc.summaryTask(estimator)), summary);
  assert.deepEqual(acc.errors, samples);
  assert.deepEqual(acc.times, times);
  assert.deepEqual((acc as unknown as { resErr: number[] }).resErr, reservoir);
});

console.log(`worker-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
