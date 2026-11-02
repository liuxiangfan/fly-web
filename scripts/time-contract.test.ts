import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SolveLoop } from "../src/core/solve-loop";
import { ReplayPlayer, type ReplayStep } from "../src/core/replay-player";
import { parseImuCsv, type ReplayFrame } from "../src/core/replay";
import { runTrace } from "../src/core/runner";
import { TruthTrack } from "../src/core/truth-track";
import { defaultExperimentConfig } from "../src/core/experiment-config";
import { ComplementaryEstimator, KalmanEstimator, MadgwickEstimator, MahonyEstimator, PureGyroEstimator, emptyTelemetry, type Estimator } from "../src/estimators";
import { qAngleBetween, qId, type V3 } from "../src/core/quat";
import type { ImuSample } from "../src/core/imu";

// 独立生产契约测试：不复制 main 的旧队列，不替换 selftest 的兼容接口。
const sample = (gyro: V3 = [0, 0, 0], mag: V3 = [30, 0, 40]): ImuSample => ({ gyro, accel: [0, 0, 9.80665], mag });
const frame = (tMs: number, rate = 0): ReplayFrame => ({ tMs, gyroDps: [rate, 0, 0], accelMs2: [0, 0, 9.80665], magUt: [30, 0, 40], hasMag: true, gyroValid: true, accelValid: true });
const chain = { mag: (v: V3) => v, accel: (v: V3) => v };
const divergent = (): Estimator => ({ id: "mahony", label: "test", color: "#fff", magEnabled: true, q: qId(), telemetry: { ...emptyTelemetry(), detail: { alignErrorDeg: 30 } }, update() {}, reset() {}, getParams: () => ({}), setParams() {} });
interface Work extends ReplayStep { first: boolean; remainingSec: number; budgetSec: number; tSec: number }
interface WorkPlayer { advanceWork(dt: number, consume: (work: Work) => number | null, maxWorkSec?: number): void; rewind(): void; readonly pendingSec: number }
interface DrainLoop { enqueueFrame(s: ImuSample, dt: number, t: number, sub?: number): boolean; drain(sub?: number, cap?: number, seconds?: number): { processedSec: number; substeps: number }; setHooks(h: { onFrame: (ctx: { sample: ImuSample; dt: number; t: number }) => void }): void }
const workPlayer = (p: ReplayPlayer): ReplayPlayer & WorkPlayer => {
  assert.equal(typeof (p as unknown as WorkPlayer).advanceWork, "function", "需有不提前推进 cursor 的生产工作接口");
  return p as unknown as ReplayPlayer & WorkPlayer;
};
const drainLoop = (l: SolveLoop): SolveLoop & DrainLoop => {
  assert.equal(typeof (l as unknown as DrainLoop).drain, "function", "需有不伪造新源帧的生产 drain 接口");
  return l as unknown as SolveLoop & DrainLoop;
};
let pass = 0, fail = 0;
function test(name: string, body: () => void): void {
  try { body(); pass++; console.log(`PASS ${name}`); }
  catch (err) { fail++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`); }
}

test("积压不得提前按整段 dt 粗对准", () => {
  const align: number[] = [];
  const l = new SolveLoop({ estimators: [divergent()], solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: true, onAlign: e => align.push(e.t) });
  l.applyFrame(sample(), 30, 30, 0.05, 10);
  assert.equal(align.length, 0, "仅处理0.5s，不得在未来30s粗对准");
  assert.ok(Math.abs(l.pendingSec - 29.5) < 1e-9);
});

test("drain 只能用积压帧，不能借后续新帧做对准", () => {
  const align: number[] = [];
  let solvedT = 0;
  const l = new SolveLoop({ estimators: [divergent()], solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: true, onAlign: e => align.push(e.t), onSolve: c => { solvedT = c.t; } });
  l.applyFrame(sample([0.2, 0, 0]), 30, 30, 0.05, 10);
  l.applyFrame(sample(), 30, 60, 0.05, 10);
  assert.ok(solvedT < 2);
  assert.equal(align.length, 0, "前帧仍运动，不能借未来静止帧补足3s");
});

test("0dt/NaN/负dt 不触发粗对准", () => {
  let aligns = 0;
  const l = new SolveLoop({ estimators: [divergent()], solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: false, onAlign: () => aligns++ });
  l.step(sample(), 3, 3);
  l.autoCoarseAlign = true;
  l.applyFrame(sample(), 0, 100);
  l.applyFrame(sample(), NaN, 101);
  l.applyFrame(sample(), -1, 102);
  assert.equal(aligns, 0);
});

test("离线 backpressure 不丢300s源帧，游标/played仅随实处理推进", () => {
  const p = workPlayer(new ReplayPlayer());
  const l = drainLoop(new SolveLoop({ estimators: [new PureGyroEstimator()], solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: false }));
  const frames = Array.from({ length: 12 }, (_, i) => frame(i * 300000));
  p.load(frames, 0);
  let integrated = 0, raw = 0, rawT = 0;
  l.setHooks({ onFrame: c => { raw++; rawT = c.t; } });
  const consume = (w: Work): number => {
    if (w.first) assert.ok(l.enqueueFrame(sample(), w.dtSec, w.tSec));
    const r = l.drain(0.05, 4000, w.budgetSec);
    integrated += r.processedSec;
    return r.processedSec;
  };
  p.advanceWork(0.016, consume, 5);
  assert.equal(p.cursor, 1, "只能完成首帧，300s帧尚未完成");
  assert.ok(Math.abs(p.playedSec - 5) < 1e-8);
  assert.equal(raw, 1, "未完成帧不能按chunk伪造raw");
  assert.ok(!p.done && p.pendingSec > 294);
  let ticks = 0;
  while (!p.done && ticks++ < 1000) p.advanceWork(0.016, consume, 5);
  assert.ok(p.done);
  assert.equal(p.cursor, frames.length);
  assert.equal(raw, frames.length);
  assert.ok(Math.abs(rawT - 3300) < 1e-7);
  assert.ok(Math.abs(integrated - 3300) < 1e-7);
  assert.ok(Math.abs(p.playedSec - integrated) < 1e-7);
  assert.equal(l.droppedFrames, 0);
});

test("零时间/重复时间源帧保留一次，既不积分也不粗对准", () => {
  const res = parseImuCsv("# imu=raw\nt_s,gx,gy,gz,ax,ay,az,mx,my,mz\n" +
    Array.from({ length: 20 }, (_, i) => `${i < 2 ? 0 : (i - 1) * 0.01},${i + 1},0,0,0,0,9.8,30,0,40`).join("\n"));
  assert.equal(res.error, undefined);
  assert.equal(res.frames.length, 20);
  const p = workPlayer(new ReplayPlayer());
  const l = drainLoop(new SolveLoop({ estimators: [divergent()], solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: true }));
  const times: number[] = [], rates: number[] = [];
  l.setHooks({ onFrame: c => { times.push(c.t); rates.push(c.sample.gyro[0]); } });
  p.load(res.frames, 0);
  p.advanceWork(0.016, w => {
    if (w.first) assert.ok(l.enqueueFrame(sample(w.frame.gyroDps), w.dtSec, w.tSec));
    return l.drain(0.05, 4000, w.budgetSec).processedSec;
  }, 5);
  assert.equal(times.length, res.frames.length);
  assert.deepEqual(times.slice(0, 2), [0, 0]);
  assert.ok(Math.abs(times[times.length - 1] - 0.18) < 1e-9);
  assert.deepEqual(rates, res.frames.map((f) => f.gyroDps[0]));
  assert.equal(p.cursor, res.frames.length);
});

test("工作拒绝不得提前消费；正常倍速必须保留真实空洞等待", () => {
  const p = workPlayer(new ReplayPlayer());
  p.load([frame(0), frame(30000)], 1);
  p.advanceWork(1, () => null, 5);
  assert.equal(p.cursor, 0);
  p.advanceWork(1, () => 0, 5);
  assert.equal(p.cursor, 1);
  assert.equal(p.playedSec, 0);
  for (let i = 0; i < 27; i++) p.advanceWork(1, w => w.dtSec, 5);
  assert.equal(p.cursor, 1);
  p.advanceWork(1, w => Math.min(w.dtSec, w.budgetSec), 5);
  assert.equal(p.cursor, 1);
  assert.ok(Math.abs(p.playedSec - 5) < 1e-9);
});

test("reset/rewind清待处理并从首帧重播，末尾也可重播", () => {
  const p = workPlayer(new ReplayPlayer());
  p.load([frame(500), frame(30500)], 0);
  p.advanceWork(0, w => Math.min(w.dtSec, w.budgetSec), 5);
  assert.ok(p.pendingSec > 0);
  p.rewind();
  assert.equal(p.cursor, 0);
  assert.equal(p.playedSec, 0);
  assert.equal(p.pendingSec, 0);
  let first = -1;
  p.advanceWork(0, w => { if (first < 0) first = w.frame.tMs; return Math.min(w.dtSec, w.budgetSec); }, 5);
  assert.equal(first, 500);
  while (!p.done) p.advanceWork(0, w => Math.min(w.remainingSec, w.budgetSec), 5);
  p.rewind();
  assert.ok(!p.done && p.loaded && p.cursor === 0);
});

test("低频单步等到真实 solve（15/200/500Hz），不依赖陈旧排程镜像", () => {
  for (const hz of [15, 200, 500]) {
    let solves = 0, t = 0, steps = 0;
    const l = new SolveLoop({ estimators: [new PureGyroEstimator()], solveRateHz: hz, calibrate: chain, magEnabled: true, autoCoarseAlign: false, onSolve: () => solves++ });
    do { t += 0.002; steps++; } while (!l.step(sample(), 0.002, t) && steps < 1000);
    assert.equal(solves, 1);
    assert.equal(steps, Math.ceil((1 / hz) / 0.002 - 1e-10));
  }
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("function stepOnce()"), main.indexOf('$("btn-step")'));
  assert.ok(!body.includes("solveState.acc"), "main 必须直接使用 stepSim 的真实 solve 返回值");
});

test("分拍与同样safe子步的生产五算法逐步/终态对拍", () => {
  const make = (): Estimator[] => [new PureGyroEstimator(), new ComplementaryEstimator(), new MahonyEstimator(), new MadgwickEstimator(), new KalmanEstimator()];
  const a = make(), b = make();
  const traceA: Array<{ t: number; q: typeof a[0]["q"][]; aligned: boolean }> = [];
  const traceB: typeof traceA = [];
  const la = drainLoop(new SolveLoop({ estimators: a, solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: true, onSolve: c => traceA.push({ t: c.t, q: a.map(e => ({ ...e.q })), aligned: c.aligned }) }));
  const lb = new SolveLoop({ estimators: b, solveRateHz: 0, calibrate: chain, magEnabled: true, autoCoarseAlign: true, onSolve: c => traceB.push({ t: c.t, q: b.map(e => ({ ...e.q })), aligned: c.aligned }) });
  for (const [dt, s] of [[301.13, sample([0.08, -0.03, 0.02])], [10.12, sample()]] as const) {
    const start = traceB.length ? traceB[traceB.length - 1].t : 0;
    la.enqueueFrame(s, dt, start + dt, 0.05);
    while (la.pendingSec > 0) la.drain(0.05, 100, 5);
    lb.applyFrame(s, dt, start + dt, 0.05, 10000);
  }
  assert.equal(traceA.length, traceB.length);
  traceA.forEach((row, i) => {
    assert.ok(Math.abs(row.t - traceB[i].t) < 1e-8);
    assert.equal(row.aligned, traceB[i].aligned);
    row.q.forEach((q, j) => assert.ok(qAngleBetween(q, traceB[i].q[j]) < 1e-6, `${a[j].id} step ${i}`));
  });
});

test("时间列回退不得重复积分：时长/进度/每帧 dt 共用单调有效时间轴", () => {
  const p = workPlayer(new ReplayPlayer());
  // 一帧回退：0 → 50 → 90 → 50 → 100 ms。单调覆盖跨度 = 0.10 s；
  // 旧实现把 50→90 的 40 ms 再积一遍，积出 0.14 s（复核反例）。
  p.load([frame(0), frame(50), frame(90), frame(50), frame(100)], 0);
  assert.ok(Math.abs(p.durationSec - 0.10) < 1e-9, `duration=${p.durationSec}`);
  let integrated = 0;
  while (!p.done) p.advanceWork(0, (w) => { integrated += w.remainingSec; return w.remainingSec; }, 5);
  assert.ok(Math.abs(integrated - 0.10) < 1e-9, `integrated=${integrated}（不得把回退段重复积分）`);
  assert.ok(Math.abs(p.playedSec - p.durationSec) < 1e-9, `played=${p.playedSec} duration=${p.durationSec}`);
  assert.ok(p.playedSec <= p.durationSec + 1e-12, "进度不得超过总时长");

  // 多次回退：0 → 100 → 60 → 80 → 120 的单调覆盖跨度仍是 0.12 s
  const q = workPlayer(new ReplayPlayer());
  q.load([frame(0), frame(100), frame(60), frame(80), frame(120)], 0);
  assert.ok(Math.abs(q.durationSec - 0.12) < 1e-9, `duration=${q.durationSec}`);
  let sum = 0;
  while (!q.done) q.advanceWork(0, (w) => { sum += w.remainingSec; return w.remainingSec; }, 5);
  assert.ok(Math.abs(sum - 0.12) < 1e-9, `integrated=${sum}`);
});

test("外部真值按子步时刻插值：长间隔不得提前使用帧末真值", () => {
  const track = new TruthTrack();
  const yaw = (deg: number) => ({ w: Math.cos((deg * Math.PI) / 360), x: 0, y: 0, z: Math.sin((deg * Math.PI) / 360) });
  track.push(0, yaw(0));
  track.commit();
  track.push(10, yaw(90));
  // 0→10 s 的 90° 匀速旋转：t=0.05 s 应约 0.45°，而不是 90°（旧实现会把帧末真值提前）
  const early = track.at(0.05);
  assert.ok(early);
  assert.ok(qAngleBetween(early!, yaw(0)) * 180 / Math.PI < 1, "t=0.05 s 不得使用 10 s 后的真值");
  assert.ok(Math.abs(qAngleBetween(early!, yaw(0.45)) * 180 / Math.PI) < 1e-6);
  const mid = track.at(5);
  assert.ok(mid && Math.abs(qAngleBetween(mid, yaw(45)) * 180 / Math.PI) < 1e-6);
  const end = track.at(10);
  assert.ok(end && Math.abs(qAngleBetween(end, yaw(90)) * 180 / Math.PI) < 1e-6);
  // 越界不外推：小于起点取起点，大于终点取终点
  assert.ok(Math.abs(qAngleBetween(track.at(-1)!, yaw(0)) * 180 / Math.PI) < 1e-6);
  assert.ok(Math.abs(qAngleBetween(track.at(99)!, yaw(90)) * 180 / Math.PI) < 1e-6);
  // 帧完成后终点成为下一帧起点
  track.commit();
  track.push(20, yaw(180));
  assert.ok(Math.abs(qAngleBetween(track.at(15)!, yaw(135)) * 180 / Math.PI) < 1e-6);
});

test("保护参数必须是有限正数：NaN/Infinity/小数不得取消上限", () => {
  const a = workPlayer(new ReplayPlayer({ maxFramesPerTick: NaN }));
  a.load([frame(0), frame(10), frame(20)], 0);
  a.advanceWork(0, (w) => w.remainingSec, 5);
  assert.ok(a.cursor > 0, "NaN 上限必须回落到默认值，而不是一帧都不消费");
  const b = workPlayer(new ReplayPlayer({ maxFramesPerTick: Infinity }));
  b.load([frame(0), frame(10), frame(20)], 0);
  b.advanceWork(0, (w) => w.remainingSec, 5);
  assert.ok(b.cursor > 0);
});

test("最快档不把无限预算写回：切回 1× 后 dt=0 不得继续推进", () => {
  const p = workPlayer(new ReplayPlayer());
  p.load([frame(0), frame(500), frame(1000), frame(1500)], 1);
  const consume = (w: Work): number => Math.min(w.remainingSec, w.budgetSec);
  p.setSpeed(0);
  p.advanceWork(0, consume, 0.5); // 最快档：单拍预算 0.5 s → 首帧(0) + 第二帧(0.5)
  assert.equal(p.cursor, 2);
  p.setSpeed(1);
  p.advanceWork(0, consume, 5); // 墙钟 dt=0：只允许收尾已接收的那一帧
  assert.equal(p.cursor, 3, "不得凭上一拍的无限预算继续接收新帧");
  p.advanceWork(0.5, consume, 5); // 真实墙钟推进 0.5 s 才允许下一帧
  assert.equal(p.cursor, 4);
});

test("trace 被步数上限截断时：endSec/事件计数与已记录步数同口径，不再报全时长", () => {
  const cfg = { ...defaultExperimentConfig(), durationSec: 10, solveRateHz: 500 };
  const full = runTrace(cfg, 5000); // 5000 步 @500 Hz = 10 s，正好跑完
  assert.equal(full.truncated, false);
  assert.ok(Math.abs(full.endSec - 10) < 1e-9);
  assert.equal(full.fullDurationSec, 10);
  assert.equal(runTrace(cfg, NaN).steps.length, 5000, "NaN 上限不得等于取消保护");
  assert.equal(runTrace(cfg, 1.5).steps.length, 1, "小数上限必须向下取整");
  const cut = runTrace(cfg, 300); // 只记录 300 步 = 0.6 s
  assert.equal(cut.truncated, true);
  assert.equal(cut.steps.length, 300);
  assert.ok(Math.abs(cut.endSec - 0.6) < 1e-9, `endSec=${cut.endSec}`);
  assert.ok(cut.endSec < cut.fullDurationSec);
  assert.equal(cut.alignTimes.length, cut.steps.filter((s) => s.aligned).length, "对准事件必须与已记录步数同口径");
  for (const [k, v] of Object.entries(cut.eventCounts)) {
    assert.ok(Number.isFinite(v) && v >= 0, `事件计数 ${k}=${v}`);
  }
});

test("旧接口与生产接口不得混用（同一段回放两套状态机会互相矛盾）", () => {
  const p = workPlayer(new ReplayPlayer());
  p.load([frame(0), frame(10)], 1);
  p.advanceWork(0.02, (w) => w.remainingSec, 5);
  assert.throws(() => p.advance(0.02), /不能混用/);
});

console.log(`time-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
