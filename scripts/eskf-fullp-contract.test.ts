/** F-07：按需完整 6×6 P 诊断快照与面板的独立契约。 */
import assert from "node:assert/strict";
import {
  KalmanEstimator,
  type KalmanObservationSnapshot,
  type KalmanStepSnapshot,
} from "../src/estimators";
import { eskfSnapshotHtml } from "../src/ui/eskf-panel";
import { G_ACC, MAG_WORLD_NED } from "../src/core/imu";
import { qFromEuler, qRotInv, type V3 } from "../src/core/quat";

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

const DT = 0.0025;
const Q_TRUE = qFromEuler(0.15, -0.1, 0.35);
const samples = Array.from({ length: 12 }, (_, i) => ({
  gyro: [0.01 + 0.002 * Math.sin(i * 0.07), -0.02, 0.03] as V3,
  accel: qRotInv(Q_TRUE, [0, 0, G_ACC]),
  mag: qRotInv(Q_TRUE, MAG_WORLD_NED),
}));

function diagOf(p: number[]): number[] {
  return [p[0], p[7], p[14], p[21], p[28], p[35]];
}

function assertFullP(value: number[] | undefined, diagonal: number[], label: string): number[] {
  assert.ok(value, `${label} 缺少完整 P`);
  assert.equal(value.length, 36, `${label} 必须是 6×6 行主序数组`);
  assert.ok(value.every(Number.isFinite), `${label} 必须全部为有限数`);
  assert.deepEqual(diagOf(value), diagonal, `${label} 与同一时刻 P 对角不一致`);
  return value;
}

function assertNoFullP(snapshot: KalmanStepSnapshot): void {
  for (const key of ["pFullInput", "pFullPredicted", "pFullFinal"] as const) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, key), false, `关闭时不应写入 ${key}`);
    assert.equal(snapshot[key], undefined);
  }
  for (const obs of snapshot.observations) {
    for (const key of ["pFullBefore", "pFullAfter"] as const) {
      assert.equal(Object.prototype.hasOwnProperty.call(obs, key), false, `关闭时不应写入 ${key}`);
      assert.equal(obs[key], undefined);
    }
  }
}

test("diagFullP 默认/显式关闭：旧数值与快照逐位一致，且没有 pFull 字段", () => {
  const legacy = new KalmanEstimator();
  legacy.magEnabled = true;
  const explicitOff = new KalmanEstimator();
  explicitOff.magEnabled = true;
  explicitOff.diagFullP = false;
  const offSnaps: KalmanStepSnapshot[] = [];
  explicitOff.diagnostics = (snap) => offSnaps.push(snap);
  const noSink = new KalmanEstimator();
  noSink.magEnabled = true;
  assert.equal(legacy.diagFullP, false);

  for (const sample of samples) {
    legacy.update(sample.gyro, sample.accel, sample.mag, DT);
    explicitOff.update(sample.gyro, sample.accel, sample.mag, DT);
    noSink.update(sample.gyro, sample.accel, sample.mag, DT);
    assert.deepEqual(explicitOff.q, legacy.q);
    assert.deepEqual(explicitOff.getCovariance(), legacy.getCovariance());
    assert.deepEqual(explicitOff.telemetry, legacy.telemetry);
    assert.deepEqual(noSink.q, legacy.q);
    assert.deepEqual(noSink.getCovariance(), legacy.getCovariance());
    assert.deepEqual(noSink.telemetry, legacy.telemetry);
  }
  assert.equal(offSnaps.length, samples.length);
  for (const snap of offSnaps) assertNoFullP(snap);
});

test("diagFullP 开启：输入/预测/逐观测/最终 P 精确对应生产时刻且互不别名", () => {
  const reference = new KalmanEstimator();
  reference.magEnabled = true;
  const full = new KalmanEstimator();
  full.magEnabled = true;
  full.diagFullP = true;
  const snaps: KalmanStepSnapshot[] = [];
  full.diagnostics = (snap) => snaps.push(snap);

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    reference.update(sample.gyro, sample.accel, sample.mag, DT);
    full.update(sample.gyro, sample.accel, sample.mag, DT);
    assert.deepEqual(full.q, reference.q, `第 ${i} 步 q 被采集改变`);
    assert.deepEqual(full.getCovariance(), reference.getCovariance(), `第 ${i} 步 P 被采集改变`);
    assert.deepEqual(full.telemetry, reference.telemetry, `第 ${i} 步遥测被采集改变`);

    const snap = snaps[i];
    const input = assertFullP(snap.pFullInput, snap.pDiagInput, "输入 P");
    const predicted = assertFullP(snap.pFullPredicted, snap.pDiagPredicted, "预测 P");
    const final = assertFullP(snap.pFullFinal, snap.pDiagFinal, "最终 P");
    assert.deepEqual(final, full.getCovariance(), "最终完整 P 必须等于生产 P");
    if (i === 0) assert.deepEqual(input, new KalmanEstimator().getCovariance());
    assert.equal(snap.observations.length, 2);

    const arrays = [input, predicted, final];
    let previousAfter: number[] | undefined;
    for (const obs of snap.observations) {
      const before = assertFullP(obs.pFullBefore, obs.pDiagBefore, `${obs.channel} 观测前 P`);
      const after = assertFullP(obs.pFullAfter, obs.pDiagAfter, `${obs.channel} 观测后 P`);
      assert.deepEqual(before, previousAfter ?? predicted, `${obs.channel} 前 P 阶段链断裂`);
      previousAfter = after;
      arrays.push(before, after);
    }
    assert.deepEqual(previousAfter, final, "最后观测后 P 必须等于最终 P");
    assert.equal(new Set(arrays).size, arrays.length, "每个阶段的完整 P 必须是独立副本");

    const production = full.getCovariance();
    input[0] = -123;
    snap.observations[0].pFullAfter![1] = -456;
    assert.deepEqual(full.getCovariance(), production, "修改 UI 快照不得影响估计器");
    assert.notEqual(final[0], -123, "阶段数组不得共享引用");
  }
});

function renderedSnapshot(withFullP: boolean): KalmanStepSnapshot {
  const kal = new KalmanEstimator();
  kal.magEnabled = true;
  kal.diagFullP = withFullP;
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (value) => { snap = value; };
  kal.update(samples[0].gyro, samples[0].accel, samples[0].mag, DT);
  assert.ok(snap);
  return snap;
}

test("UI：7 个阶段的完整 P 均可展开为 6×6，保留对角/S/K/dx 与转义", () => {
  const snap = renderedSnapshot(true);
  const injected = '<img src=x onerror="alert(1)">';
  (snap.observations[0] as KalmanObservationSnapshot).gate.reason = injected;
  const html = eskfSnapshotHtml(snap, 1.25);
  assert.equal((html.match(/data-matrix="P"/g) ?? []).length, 7);
  assert.ok(html.includes("完整 P"));
  assert.ok(html.includes("6×6"));
  assert.ok(html.includes("P 对角"));
  assert.ok(html.includes('data-matrix="S"'));
  assert.ok(html.includes('data-matrix="K"'));
  assert.ok(html.includes('data-matrix="dx"'));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes(injected));
});

test("UI：未开启完整 P 时明确未记录，不补零、不生成空矩阵", () => {
  const html = eskfSnapshotHtml(renderedSnapshot(false), null);
  assert.equal((html.match(/data-matrix="P"/g) ?? []).length, 0);
  assert.ok(html.includes("完整 P"));
  assert.ok(html.includes("未记录"));
  assert.ok(html.includes("不补 0"));
  assert.ok(html.includes("P 对角"));
});

console.log(`eskf-fullp-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
