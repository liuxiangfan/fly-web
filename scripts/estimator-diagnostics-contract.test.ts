/**
 * F-03 显式观测状态 + F-07 ESKF 单步诊断快照的独立契约测试。
 *
 * 不启动浏览器、不改 runner/main：
 *  1. 纯积分两通道 `not-applicable`；互补/Mahony/Madgwick/Kalman 的 applied/
 *     rejected/invalid/disabled/unrecorded 语义来自估计器真实更新路径；
 *  2. 诊断 sink 关闭/开启时，q、零偏、P（全矩阵）、遥测、误差/NEES 逐步逐位一致；
 *  3. 快照含更新前/预测/逐观测/注入后状态，S/K/dx 来自生产计算而非重算；
 *  4. 拒绝/奇异不伪造 K/dx，零观测/加计单路/双路、角度与 χ² 门控、零偏限幅、
 *     P←GPGᵀ 开关都有真实记录；
 *  5. 快照数组与估计器内部状态不共享引用。
 */
import assert from "node:assert/strict";
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
  resetJacobianG,
  type KalmanObservationSnapshot,
  type KalmanStepSnapshot,
} from "../src/estimators";
import { G_ACC, MAG_WORLD_NED } from "../src/core/imu";
import {
  DEG,
  RAD,
  qAngleBetween,
  qExp,
  qFromAxisAngle,
  qFromEuler,
  qId,
  qIntegrate,
  qLog,
  qMul,
  qRot,
  qRotInv,
  type Quat,
  type V3,
} from "../src/core/quat";

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

function approx(actual: number, expected: number, eps = 1e-12, label = "数值"): void {
  assert.ok(Number.isFinite(actual), `${label} 不是有限数：${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${label} 期望 ${expected}，实际 ${actual}`);
}

function gravityInBody(q: Quat): V3 {
  return qRotInv(q, [0, 0, G_ACC]);
}

function magnetInBody(q: Quat): V3 {
  return qRotInv(q, MAG_WORLD_NED);
}

/** 把 MAG_WORLD_NED 绕与它垂直的轴旋转 deg 度，构造“模长可信但方向偏离”的磁测量 */
function rotatedMag(deg: number): V3 {
  return qRot(qFromAxisAngle([0, 1, 0], deg * RAD), MAG_WORLD_NED);
}

function diagOf(P: number[]): number[] {
  return [P[0], P[7], P[14], P[21], P[28], P[35]];
}

function biasFromTelemetry(k: KalmanEstimator): V3 {
  const d = k.telemetry.detail;
  return [d.biasXDps / DEG, d.biasYDps / DEG, d.biasZDps / DEG];
}

function internalBias(k: KalmanEstimator): V3 {
  return (k as unknown as { bias: V3 }).bias;
}

const DT = 0.0025;
const Q_TRUE = qFromEuler(0.15, -0.1, 0.35);

function sample(i: number): { gyro: V3; accel: V3; mag: V3 } {
  return {
    gyro: [0.01 + 0.002 * Math.sin(i * 0.07), -0.02, 0.03 + 0.001 * Math.cos(i * 0.05)],
    accel: gravityInBody(Q_TRUE),
    mag: magnetInBody(Q_TRUE),
  };
}

/* ==========================================================================
   Part 1: 显式观测状态
   ========================================================================== */

test("观测状态：纯积分两通道 not-applicable（初始/更新/重置）", () => {
  const p = new PureGyroEstimator();
  assert.equal(p.telemetry.accelState, "not-applicable");
  assert.equal(p.telemetry.magState, "not-applicable");
  p.update([0.1, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
  assert.equal(p.telemetry.accelState, "not-applicable");
  assert.equal(p.telemetry.magState, "not-applicable");
  assert.equal(p.telemetry.accelReasonCode, "no-correction-channel");
  assert.equal(p.telemetry.magReasonCode, "no-correction-channel");
  p.reset(qFromEuler(0.1, 0, 0));
  assert.equal(p.telemetry.accelState, "not-applicable");
  assert.equal(p.telemetry.magState, "not-applicable");
});

type FusionEstimator = ComplementaryEstimator | MahonyEstimator | MadgwickEstimator;
const FUSION_MAKERS: ReadonlyArray<readonly [string, () => FusionEstimator]> = [
  ["comp", () => new ComplementaryEstimator()],
  ["mahony", () => new MahonyEstimator()],
  ["madg", () => new MadgwickEstimator()],
];

for (const [name, make] of FUSION_MAKERS) {
  test(`观测状态 ${name}：有效加计+磁通过门控 => 两通道 applied`, () => {
    const e = make();
    e.rampEnabled = false;
    e.magEnabled = true;
    e.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
    assert.equal(e.telemetry.accelState, "applied");
    assert.equal(e.telemetry.magState, "applied");
    assert.equal(e.telemetry.accelReasonCode, "applied");
    assert.equal(e.telemetry.magReasonCode, "applied");
  });

  test(`观测状态 ${name}：门控关闭/启动 ramp 下有效观测 => applied`, () => {
    const e = make();
    e.magEnabled = false;
    e.accelGate = false;
    e.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
    assert.equal(e.telemetry.accelState, "applied");
    assert.equal(e.telemetry.magState, "disabled");

    const ramp = make();
    ramp.rampEnabled = true; // 首帧 age=dt < RAMP_SEC，门控不生效
    ramp.magEnabled = false;
    ramp.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
    assert.equal(ramp.telemetry.accelState, "applied");
  });

  test(`观测状态 ${name}：有效观测被方向门控拒绝 => rejected，磁未评估 => unrecorded`, () => {
    const e = make();
    e.rampEnabled = false;
    e.magEnabled = true;
    const tilt = qFromAxisAngle([1, 0, 0], 30 * RAD);
    e.update([0, 0, 0], gravityInBody(tilt), MAG_WORLD_NED, DT);
    assert.equal(e.telemetry.accelValid, true);
    assert.equal(e.telemetry.accelState, "rejected");
    assert.equal(e.telemetry.accelReasonCode, "gate-direction");
    assert.equal(e.telemetry.magState, "unrecorded");
    assert.equal(e.telemetry.magReasonCode, "mag-not-evaluated");
  });

  test(`观测状态 ${name}：模长异常 => invalid（不是门控拒绝）`, () => {
    const e = make();
    e.rampEnabled = false;
    e.magEnabled = false;
    e.update([0, 0, 0], [0, 0, 2], [0, 0, 0], DT);
    assert.equal(e.telemetry.accelValid, false);
    assert.equal(e.telemetry.accelState, "invalid");
    assert.equal(e.telemetry.accelReasonCode, "accel-norm-out-of-range");

    const zero = make();
    zero.rampEnabled = false;
    zero.update([0, 0, 0], [0, 0, 0], [0, 0, 0], DT);
    assert.equal(zero.telemetry.accelState, "invalid");
    assert.equal(zero.telemetry.accelReasonCode, "accel-norm-zero");
  });

  test(`观测状态 ${name}：磁关闭/磁退化/磁可信三态可区分`, () => {
    const disabled = make();
    disabled.rampEnabled = false;
    disabled.magEnabled = false;
    disabled.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
    assert.equal(disabled.telemetry.magState, "disabled");
    assert.equal(disabled.telemetry.magReasonCode, "mag-disabled");

    const invalid = make();
    invalid.rampEnabled = false;
    invalid.magEnabled = true;
    invalid.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 1], DT);
    assert.equal(invalid.telemetry.magState, "invalid");
    assert.equal(invalid.telemetry.magReasonCode, "mag-norm-out-of-range");

    const applied = make();
    applied.rampEnabled = false;
    applied.magEnabled = true;
    applied.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
    assert.equal(applied.telemetry.magState, "applied");
  });
}

test("FIX-03 互补 alpha=0：观测通过门控但修正恒为零 => accepted-not-applied", () => {
  const initial = qFromEuler(0.1, 0.05, 0);
  const on = new ComplementaryEstimator();
  on.rampEnabled = false;
  on.magEnabled = true;
  on.reset(initial);
  on.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
  assert.equal(on.telemetry.accelValid, true);
  assert.equal(on.telemetry.accelState, "applied");
  assert.ok(Math.hypot(...on.telemetry.correction) > 0, "alpha>0 时应有非零修正");

  const off = new ComplementaryEstimator();
  off.rampEnabled = false;
  off.magEnabled = true;
  off.alpha = 0;
  off.reset(initial);
  off.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
  assert.equal(off.telemetry.accelValid, true);
  assert.equal(off.telemetry.accelState, "accepted-not-applied");
  assert.equal(off.telemetry.accelReasonCode, "zero-gain");
  assert.equal(off.telemetry.magState, "accepted-not-applied");
  assert.equal(off.telemetry.magReasonCode, "zero-gain");
  assert.equal(Math.hypot(...off.telemetry.correction), 0);
});

test("FIX-03 Mahony kp=ki=0：观测通过门控但比例/积分项均为零 => accepted-not-applied", () => {
  const e = new MahonyEstimator();
  e.rampEnabled = false;
  e.magEnabled = true;
  e.kp = 0;
  e.ki = 0;
  e.reset(qFromEuler(0.1, 0.05, 0));
  e.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
  assert.equal(e.telemetry.accelValid, true);
  assert.equal(e.telemetry.accelState, "accepted-not-applied");
  assert.equal(e.telemetry.accelReasonCode, "zero-gain");
  assert.equal(e.telemetry.magState, "accepted-not-applied");
  assert.equal(e.telemetry.magReasonCode, "zero-gain");
  assert.deepEqual(e.telemetry.correction, [0, 0, 0]);
});

test("FIX-03 Madgwick beta=0：梯度步长恒为零 => accepted-not-applied", () => {
  const e = new MadgwickEstimator();
  e.rampEnabled = false;
  e.beta = 0;
  e.reset(qFromEuler(0.1, 0.05, 0));
  e.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.equal(e.telemetry.accelValid, true);
  assert.equal(e.telemetry.accelState, "accepted-not-applied");
  assert.equal(e.telemetry.accelReasonCode, "zero-gain");
  assert.deepEqual(e.telemetry.correction, [0, 0, 0]);
});

test("FIX-03 Madgwick 梯度退化（sNorm≤1e-9，残差非零）=> accepted-not-applied", () => {
  // 加计方向与预测重力反向：残差=2，但梯度 Jᵀf 恰为零（对跖奇异点）。
  // 关闭方向门控让观测进入更新分支，验证状态描述的是“数值退化”而非“门控拒绝”。
  const e = new MadgwickEstimator();
  e.rampEnabled = false;
  e.accelGate = false;
  e.update([0, 0, 0], [0, 0, -G_ACC], [0, 0, 0], DT);
  assert.equal(e.telemetry.accelValid, true);
  assert.equal(e.telemetry.accelState, "accepted-not-applied");
  assert.equal(e.telemetry.accelReasonCode, "update-degenerate");
  assert.deepEqual(e.telemetry.correction, [0, 0, 0]);
});

test("FIX-03 磁开启且实际参与修正 => magState applied；加计早退 => unrecorded", () => {
  for (const [name, make] of FUSION_MAKERS) {
    const e = make();
    e.rampEnabled = false;
    e.magEnabled = true;
    e.reset(qFromAxisAngle([0, 0, 1], 30 * RAD));
    e.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
    assert.equal(e.telemetry.magState, "applied", `${name} 磁实际参与修正`);
    assert.equal(e.telemetry.magReasonCode, "applied", `${name} 磁原因码`);
    assert.equal(e.telemetry.accelState, "applied", `${name} 加计正常更新`);

    const skipped = make();
    skipped.rampEnabled = false;
    skipped.magEnabled = true;
    const tilt = qFromAxisAngle([1, 0, 0], 30 * RAD);
    skipped.update([0, 0, 0], gravityInBody(tilt), MAG_WORLD_NED, DT);
    assert.equal(skipped.telemetry.magState, "unrecorded", `${name} 加计早退时磁未评估`);
    assert.equal(skipped.telemetry.magReasonCode, "mag-not-evaluated", `${name} 磁未评估原因码`);
  }
});

test("观测状态 kalman：applied/invalid/rejected/disabled 与显式接受字段一致", () => {
  const applied = new KalmanEstimator();
  applied.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.equal(applied.telemetry.accelAccepted, true);
  assert.equal(applied.telemetry.accelState, "applied");
  assert.equal(applied.telemetry.magState, "disabled");
  assert.equal(applied.telemetry.magReasonCode, "mag-disabled");

  const invalid = new KalmanEstimator();
  invalid.update([0, 0, 0], [0, 0, 2], [0, 0, 0], DT);
  assert.equal(invalid.telemetry.accelAccepted, false);
  assert.equal(invalid.telemetry.accelState, "invalid");
  assert.equal(invalid.telemetry.accelReasonCode, "accel-norm-out-of-range");

  const rejected = new KalmanEstimator();
  const tilt50 = qFromAxisAngle([1, 0, 0], 50 * RAD);
  rejected.update([0, 0, 0], gravityInBody(tilt50), [0, 0, 0], DT);
  assert.equal(rejected.telemetry.accelValid, true);
  assert.equal(rejected.telemetry.accelAccepted, false);
  assert.equal(rejected.telemetry.accelState, "rejected");
  assert.equal(rejected.telemetry.accelReasonCode, "gate-direction");

  const mahalanobis = new KalmanEstimator();
  mahalanobis.gateMode = "mahalanobis";
  const tilt20 = qFromAxisAngle([1, 0, 0], 20 * RAD);
  mahalanobis.update([0, 0, 0], gravityInBody(tilt20), [0, 0, 0], DT);
  assert.equal(mahalanobis.telemetry.accelState, "rejected");
  assert.equal(mahalanobis.telemetry.accelReasonCode, "gate-mahalanobis");

  const magOk = new KalmanEstimator();
  magOk.magEnabled = true;
  magOk.update([0, 0, 0], [0, 0, G_ACC], MAG_WORLD_NED, DT);
  assert.equal(magOk.telemetry.magAccepted, true);
  assert.equal(magOk.telemetry.magState, "applied");

  const magInvalid = new KalmanEstimator();
  magInvalid.magEnabled = true;
  magInvalid.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 1], DT);
  assert.equal(magInvalid.telemetry.magValid, false);
  assert.equal(magInvalid.telemetry.magState, "invalid");
  assert.equal(magInvalid.telemetry.magReasonCode, "mag-norm-out-of-range");

  const magRejected = new KalmanEstimator();
  magRejected.magEnabled = true;
  magRejected.update([0, 0, 0], [0, 0, G_ACC], rotatedMag(50), DT);
  assert.equal(magRejected.telemetry.magValid, true);
  assert.equal(magRejected.telemetry.magAccepted, false);
  assert.equal(magRejected.telemetry.magState, "rejected");
  assert.equal(magRejected.telemetry.magReasonCode, "gate-direction");
});

test("观测状态 kalman 奇异更新（S 不可逆）=> accepted-not-applied + update-degenerate（FIX-08）", () => {
  const kal = new KalmanEstimator();
  kal.obsNoise = 0; // S = HPHt + 0；H 的第三行恒为零 => S 第三行/列全零，不可逆
  kal.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.equal(kal.telemetry.accelAccepted, false);
  // 门控本身已放行，失败发生在求逆：不是“门控拒绝”，因此事件记录器不会生成 gate-reject 边沿。
  assert.equal(kal.telemetry.accelState, "accepted-not-applied");
  assert.equal(kal.telemetry.accelReasonCode, "update-degenerate");
  assert.equal(kal.telemetry.detail.accelRejectCode, 4);
});

test("FIX-02 ESKF 协方差重置雅可比 G = I − ½[δθ̂]×：一阶残差匹配，旧 + 号超容差", () => {
  const dThetaHat: V3 = [0.03, -0.04, 0.05];
  // 文档方向的小步长：一阶近似的二阶误差 ~|δθ̂|²|δθ|，保持在 1e-6 以下。
  const dThetaTrue: V3 = [0.0005, -0.0002, 0.0003];
  const expRot = (v: V3): Quat => qExp([v[0] / 2, v[1] / 2, v[2] / 2]);
  const logRot = (q: Quat): V3 => {
    const v = qLog(q);
    return [2 * v[0], 2 * v[1], 2 * v[2]];
  };
  const negHat: V3 = [-dThetaHat[0], -dThetaHat[1], -dThetaHat[2]];
  const residual = (b: V3): V3 => logRot(qMul(expRot(negHat), expRot(b)));
  // 注入 q⁺ = q ⊗ Exp(δθ̂) 后，真实误差相对 q⁺ 的残差为 Log(Exp(−δθ̂) ⊗ Exp(δθ))。
  // 其中 −δθ̂ 是注入带来的均值平移；协方差雅可比 G 描述的是相对该平移的变化，
  // 所以用 post − post(0) 与 G·δθ_true 比较。
  const post0 = residual([0, 0, 0]);
  const post = residual(dThetaTrue);
  const observed: V3 = [post[0] - post0[0], post[1] - post0[1], post[2] - post0[2]];

  const applyG = (g: number[], b: V3): V3 => [
    g[0] * b[0] + g[1] * b[1] + g[2] * b[2],
    g[6] * b[0] + g[7] * b[1] + g[8] * b[2],
    g[12] * b[0] + g[13] * b[1] + g[14] * b[2],
  ];
  const G = resetJacobianG(dThetaHat);
  const predicted = applyG(G, dThetaTrue);
  const correctErr = Math.hypot(
    observed[0] - predicted[0],
    observed[1] - predicted[1],
    observed[2] - predicted[2],
  );
  assert.ok(correctErr < 1e-6, `正确 G 的一阶残差误差 ${correctErr} 应 < 1e-6`);

  // 旧实现用 + 号（G_old = I + ½[δθ̂]×）：同一观测下误差应明显超过容差。
  const sk = [0, -dThetaHat[2], dThetaHat[1], dThetaHat[2], 0, -dThetaHat[0], -dThetaHat[1], dThetaHat[0], 0];
  const Gold = new Array<number>(36).fill(0);
  for (let i = 0; i < 6; i++) Gold[i * 6 + i] = 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) Gold[i * 6 + j] += 0.5 * sk[i * 3 + j];
  }
  const predictedOld = applyG(Gold, dThetaTrue);
  const oldErr = Math.hypot(
    observed[0] - predictedOld[0],
    observed[1] - predictedOld[1],
    observed[2] - predictedOld[2],
  );
  assert.ok(oldErr > 1e-6, `旧 + 号 G 的误差 ${oldErr} 应 > 1e-6`);

  // 文档 §3.1 的手算值：G·δθ_true（δθ_true = [0.05,−0.02,0.03]）与旧符号对照。
  const docB: V3 = [0.05, -0.02, 0.03];
  const docG = applyG(G, docB);
  approx(docG[0], 0.0501, 1e-12, "G·δθ_true x");
  approx(docG[1], -0.0208, 1e-12, "G·δθ_true y");
  approx(docG[2], 0.0293, 1e-12, "G·δθ_true z");
  const docOld = applyG(Gold, docB);
  approx(docOld[0], 0.0499, 1e-12, "旧 + 号 x");
  approx(docOld[1], -0.0192, 1e-12, "旧 + 号 y");
  approx(docOld[2], 0.0307, 1e-12, "旧 + 号 z");

  // 零偏块保持单位，姿态块左上 3×3 为 I − ½[δθ̂]×。
  const diag = diagOf(G);
  assert.deepEqual(diag.slice(3), [1, 1, 1]);
  approx(G[1], -0.5 * sk[1], 1e-15, "G(0,1)");
  approx(G[2], -0.5 * sk[2], 1e-15, "G(0,2)");
  approx(G[6], -0.5 * sk[3], 1e-15, "G(1,0)");
});

/* ==========================================================================
   Part 2: ESKF 诊断快照
   ========================================================================== */

test("ESKF 快照：sink 关闭/开启逐步 q、bias、P、遥测、误差与 NEES 完全一致", () => {
  const noSink = new KalmanEstimator();
  noSink.magEnabled = true;
  const withSink = new KalmanEstimator();
  withSink.magEnabled = true;
  const snaps: KalmanStepSnapshot[] = [];
  withSink.diagnostics = (snap) => snaps.push(snap);

  for (let i = 0; i < 240; i++) {
    const s = sample(i);
    noSink.update(s.gyro, s.accel, s.mag, DT);
    withSink.update(s.gyro, s.accel, s.mag, DT);

    const snap = snaps[snaps.length - 1];
    assert.ok(snap, `第 ${i} 步缺少快照`);
    assert.deepEqual(withSink.q, noSink.q, `q 第 ${i} 步不一致`);
    assert.deepEqual(withSink.getCovariance(), noSink.getCovariance(), `P 第 ${i} 步不一致`);
    assert.deepEqual(withSink.telemetry, noSink.telemetry, `telemetry 第 ${i} 步不一致`);
    assert.deepEqual(snap.qFinal, noSink.q, `snap.qFinal 第 ${i} 步不一致`);
    assert.deepEqual(snap.pDiagFinal, diagOf(noSink.getCovariance()), `snap.pDiagFinal 第 ${i} 步不一致`);
    assert.deepEqual(snap.biasFinalRad, internalBias(noSink), `snap.biasFinal 第 ${i} 步不一致`);
  }
  assert.equal(snaps.length, 240);

  const truthBias: V3 = [0, 0, 0];
  const neesNo = noSink.neesAgainst(Q_TRUE, truthBias);
  const neesSink = withSink.neesAgainst(Q_TRUE, truthBias);
  assert.deepEqual(neesSink, neesNo);
  const errNo = qAngleBetween(noSink.q, Q_TRUE) * DEG;
  const errSink = qAngleBetween(withSink.q, Q_TRUE) * DEG;
  assert.deepEqual({ err: errSink, nees: neesSink }, { err: errNo, nees: neesNo });
});

test("ESKF 快照：输入/预测/加计+磁顺序/注入后与生产值一致，数组互不别名", () => {
  const kal = new KalmanEstimator();
  kal.magEnabled = true;
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  const gyro: V3 = [0.01, -0.02, 0.03];
  const accel = gravityInBody(Q_TRUE);
  const mag = magnetInBody(Q_TRUE);
  kal.update(gyro, accel, mag, DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;

  assert.equal(s.dt, DT);
  assert.deepEqual(s.qInput, qId());
  assert.deepEqual(s.biasInputRad, [0, 0, 0]);
  assert.equal(s.pDiagInput.length, 6);
  approx(s.pDiagInput[0], 0.087 * 0.087, 1e-15, "P 姿态初始对角");
  approx(s.pDiagInput[3], 0.0087 * 0.0087, 1e-15, "P 零偏初始对角");
  assert.deepEqual(s.correctedGyroRad, gyro); // 初始零偏为零
  assert.deepEqual(s.qPredicted, qIntegrate(qId(), gyro, DT));
  assert.deepEqual(s.qFinal, kal.q);
  assert.deepEqual(s.biasFinalRad, internalBias(kal));
  assert.deepEqual(s.pDiagFinal, diagOf(kal.getCovariance()));
  assert.equal(s.observations.length, 2);

  const [acc, m] = s.observations as [KalmanObservationSnapshot, KalmanObservationSnapshot];
  assert.equal(acc.channel, "accel");
  assert.equal(m.channel, "mag");
  assert.equal(acc.available, true);
  assert.equal(m.available, true);
  assert.equal(acc.applied, true);
  assert.equal(m.applied, true);
  assert.equal(acc.gate.accepted, true);
  assert.equal(acc.gate.reason, "applied");
  assert.equal(acc.S?.length, 9);
  assert.equal(acc.K?.length, 18);
  assert.equal(acc.dx?.length, 6);
  assert.equal(m.S?.length, 9);
  assert.equal(m.K?.length, 18);
  assert.equal(m.dx?.length, 6);
  // S 是对称的新息协方差（不是它的逆）
  assert.ok(acc.S);
  approx(acc.S![1], acc.S![3], 1e-15, "S 对称 (0,1)");
  approx(acc.S![2], acc.S![6], 1e-15, "S 对称 (0,2)");
  approx(acc.S![5], acc.S![7], 1e-15, "S 对称 (1,2)");
  // 生产顺序：磁的更新前状态 = 加计的更新后状态（值相同、引用不同）
  assert.deepEqual(m.qBefore, acc.qAfter);
  assert.notEqual(m.qBefore, acc.qAfter);
  assert.deepEqual(m.pDiagBefore, acc.pDiagAfter);
  assert.notEqual(m.pDiagBefore, acc.pDiagAfter);
  assert.deepEqual(m.biasBeforeRad, acc.biasAfterRad);
  assert.notEqual(m.biasBeforeRad, acc.biasAfterRad);

  // 深拷贝：改快照不改变估计器，也不串到另一条观测记录
  const qW = kal.q.w;
  const p0 = kal.getCovariance()[0];
  const biasX = kal.telemetry.detail.biasXDps;
  const mS0 = m.S![0];
  const accQw = acc.qAfter.w;
  s.qInput.w = 99;
  s.qFinal.w = -99;
  s.pDiagFinal[0] = -1;
  s.biasFinalRad[0] = 123;
  acc.S![0] = -7;
  m.qBefore.w = 42;
  assert.equal(kal.q.w, qW);
  assert.equal(kal.getCovariance()[0], p0);
  assert.equal(kal.telemetry.detail.biasXDps, biasX);
  assert.equal(m.S![0], mS0);
  assert.equal(acc.qAfter.w, accQw);
  assert.notEqual(acc.S, m.S);
  assert.notEqual(acc.dx, m.dx);
  assert.notEqual(acc.qBefore, m.qBefore);
});

test("ESKF 快照：零观测（加计零模长 + 磁关闭）仍记录两通道真实原因", () => {
  const kal = new KalmanEstimator();
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  kal.update([0, 0, 0], [0, 0, 0], [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  assert.equal(s.observations.length, 2);
  const [acc, m] = s.observations;
  assert.equal(acc.channel, "accel");
  assert.equal(acc.available, false);
  assert.equal(acc.applied, false);
  assert.equal(acc.gate.accepted, false);
  assert.equal(acc.gate.kind, "norm");
  assert.equal(acc.gate.reason, "accel-norm-zero");
  assert.equal(acc.S, null);
  assert.equal(acc.K, null);
  assert.equal(acc.dx, null);
  assert.deepEqual(acc.qBefore, acc.qAfter);
  assert.deepEqual(acc.pDiagBefore, acc.pDiagAfter);
  assert.equal(m.channel, "mag");
  assert.equal(m.available, false);
  assert.equal(m.applied, false);
  assert.equal(m.gate.kind, "disabled");
  assert.equal(m.gate.reason, "mag-disabled");
  assert.equal(m.S, null);
  assert.equal(m.K, null);
  assert.equal(m.dx, null);
  assert.equal(s.covarianceResetApplied, false);
  // 零观测时姿态只由预测推进
  assert.deepEqual(s.qFinal, s.qPredicted);
  assert.deepEqual(s.biasFinalRad, s.biasInputRad);
});

test("ESKF 快照：仅加计时磁记录 available=false，不伪造第二条更新", () => {
  const kal = new KalmanEstimator(); // magEnabled 默认 false
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  kal.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  assert.equal(s.observations.length, 2);
  assert.equal(s.observations[0].available, true);
  assert.equal(s.observations[0].applied, true);
  assert.equal(s.observations[1].available, false);
  assert.equal(s.observations[1].applied, false);
  assert.equal(s.observations[1].gate.reason, "mag-disabled");
  assert.equal(s.observations[1].S, null);
});

test("ESKF 快照：角度门控拒绝时无 K/dx，前后状态不变，原因真实", () => {
  const kal = new KalmanEstimator();
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  const tilt50 = qFromAxisAngle([1, 0, 0], 50 * RAD);
  kal.update([0, 0, 0], gravityInBody(tilt50), [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  const acc = s.observations[0];
  assert.equal(acc.channel, "accel");
  assert.equal(acc.available, true);
  assert.equal(acc.applied, false);
  assert.equal(acc.gate.kind, "angle");
  assert.equal(acc.gate.threshold, 40);
  assert.equal(acc.gate.accepted, false);
  assert.equal(acc.gate.reason, "gate-direction");
  assert.ok(acc.innovationAngleDeg !== null && acc.innovationAngleDeg > 40);
  assert.ok(acc.predicted && acc.measured && acc.innovation);
  assert.equal(acc.S, null);
  assert.equal(acc.K, null);
  assert.equal(acc.dx, null);
  assert.deepEqual(acc.qBefore, acc.qAfter);
  assert.deepEqual(acc.pDiagBefore, acc.pDiagAfter);
  assert.deepEqual(acc.biasBeforeRad, acc.biasAfterRad);
  assert.equal(kal.telemetry.accelAccepted, false);
});

test("ESKF 快照：χ² 门控拒绝记录 NIS 与阈值，而不是角度门控", () => {
  const kal = new KalmanEstimator();
  kal.gateMode = "mahalanobis";
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  const tilt20 = qFromAxisAngle([1, 0, 0], 20 * RAD);
  kal.update([0, 0, 0], gravityInBody(tilt20), [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  const acc = s.observations[0];
  assert.equal(acc.available, true);
  assert.equal(acc.applied, false);
  assert.equal(acc.gate.kind, "mahalanobis");
  assert.equal(acc.gate.threshold, kal.gateChi2);
  assert.equal(acc.gate.accepted, false);
  assert.equal(acc.gate.reason, "gate-mahalanobis");
  assert.ok(acc.nis !== null && acc.nis >= kal.gateChi2);
  assert.equal(acc.S, null);
  assert.equal(acc.K, null);
  assert.equal(acc.dx, null);
  assert.deepEqual(acc.qBefore, acc.qAfter);
  assert.equal(kal.telemetry.detail.accelRejectCode, 3);
});

test("ESKF 快照：S 奇异时 applied=false、K/dx/S=null，更新前状态保持不变", () => {
  const kal = new KalmanEstimator();
  kal.obsNoise = 0; // 让 R=0，H 不可观测的第三维使 S 奇异
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  kal.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  const acc = s.observations[0];
  assert.equal(acc.available, true);
  assert.equal(acc.applied, false);
  assert.equal(acc.gate.accepted, true); // 门控本身放行，失败发生在求逆
  assert.equal(acc.gate.reason, "update-degenerate");
  assert.equal(acc.S, null);
  assert.equal(acc.K, null);
  assert.equal(acc.dx, null);
  assert.deepEqual(acc.qBefore, acc.qAfter);
  assert.deepEqual(acc.biasBeforeRad, acc.biasAfterRad);
  assert.deepEqual(acc.pDiagBefore, acc.pDiagAfter);
  assert.equal(acc.covarianceResetApplied, false);
  // 姿态只由预测推进；P 只经过预测传播
  assert.deepEqual(s.qFinal, s.qPredicted);
  assert.deepEqual(s.pDiagFinal, s.pDiagPredicted);
  assert.equal(kal.telemetry.accelAccepted, false);
  assert.equal(kal.telemetry.detail.accelRejectCode, 4);
});

test("ESKF 快照：零偏模长限幅在 biasBefore/After 中如实可见", () => {
  const kal = new KalmanEstimator();
  (kal as unknown as { bias: V3 }).bias = [2, 0, 0]; // 超过 BIAS_LIMIT=1 rad/s
  let snap: KalmanStepSnapshot | null = null;
  kal.diagnostics = (s) => {
    snap = s;
  };
  kal.update([0, 0, 0], [0, 0, G_ACC], [0, 0, 0], DT);
  assert.ok(snap);
  const s = snap as KalmanStepSnapshot;
  const acc = s.observations[0];
  assert.equal(acc.applied, true);
  assert.deepEqual(acc.biasBeforeRad, [2, 0, 0]);
  approx(Math.hypot(...acc.biasAfterRad), 1, 1e-14, "限幅后零偏模长");
  assert.deepEqual(acc.biasAfterRad, s.biasFinalRad);
  assert.deepEqual(s.biasFinalRad, biasFromTelemetry(kal));
  approx(kal.telemetry.detail.biasNormDps, 1 * DEG, 1e-12, "遥测零偏模长");
});

test("ESKF 快照：resetCovOnInject 逐条已接受观测记录，关闭时如实为 false", () => {
  const run = (enabled: boolean): { kal: KalmanEstimator; snaps: KalmanStepSnapshot[] } => {
    const kal = new KalmanEstimator();
    kal.magEnabled = true;
    kal.resetCovOnInject = enabled;
    const snaps: KalmanStepSnapshot[] = [];
    kal.diagnostics = (s) => snaps.push(s);
    for (let i = 0; i < 20; i++) {
      const s = sample(i);
      kal.update(s.gyro, s.accel, s.mag, DT);
    }
    return { kal, snaps };
  };
  const off = run(false);
  const on = run(true);
  for (const snap of off.snaps) {
    assert.equal(snap.covarianceResetApplied, false);
    for (const obs of snap.observations) assert.equal(obs.covarianceResetApplied, false);
  }
  let accepted = 0;
  let resetObs = 0;
  for (const snap of on.snaps) {
    for (const obs of snap.observations) {
      if (!obs.applied) continue;
      accepted++;
      assert.equal(obs.covarianceResetApplied, true);
      if (obs.covarianceResetApplied) resetObs++;
    }
    assert.equal(snap.covarianceResetApplied, snap.observations.some((o) => o.covarianceResetApplied));
  }
  assert.ok(accepted > 0);
  assert.equal(resetObs, accepted);
  const onLast = on.snaps[on.snaps.length - 1];
  const offLast = off.snaps[off.snaps.length - 1];
  assert.equal(onLast.covarianceResetApplied, true);
  assert.notDeepEqual(onLast.pDiagFinal, offLast.pDiagFinal);
});

console.log(`estimator-diagnostics-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
