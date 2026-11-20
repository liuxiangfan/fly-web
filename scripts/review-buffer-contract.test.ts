/**
 * F-06 回看缓冲的独立契约测试。
 *
 * 不启动浏览器、不 import runner：只验证 core/review-buffer.ts 的数据契约。
 * 覆盖容量/淘汰、时间与 seq 顺序、runId 隔离、变更安全、真值与 times 语义、
 * null 误差、nearest 容差、clear/reset、坏帧拒绝、容量上界和入队开销。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_NEAREST_TOLERANCE_SEC,
  DEFAULT_REVIEW_CAPACITY,
  ReviewBuffer,
  buildReviewFrame,
  type ReferenceKind,
  type ReviewFrame,
} from "../src/core/review-buffer";
import type { EstimatorTelemetry, KalmanStepSnapshot } from "../src/estimators";
import type { ImuSample } from "../src/core/imu";
import type { Quat, V3 } from "../src/core/quat";

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

const Q0: Quat = { w: 1, x: 0, y: 0, z: 0 };
const Q_OFF: Quat = { w: 0.9238795325, x: 0.3826834324, y: 0, z: 0 };

function makeTelemetry(overrides: Partial<EstimatorTelemetry> = {}): EstimatorTelemetry {
  return {
    rate: [0.1, 0.2, 0.3],
    rawGyro: [0.01, -0.02, 0.03],
    correction: [0.09, 0.22, 0.27],
    predictedGravity: [0, 0, 9.80665],
    measuredGravity: [0.1, 0, 9.8],
    accelNorm: 9.81,
    accelValid: true,
    magValid: true,
    accelAccepted: true,
    magAccepted: false,
    detail: { accelWeight: 0.25, gateMode: 0 },
    ...overrides,
  };
}

function makeRaw(overrides: Partial<ImuSample> = {}): ImuSample {
  return {
    gyro: [0.1, 0.2, 0.3],
    accel: [0, 0, 9.80665],
    mag: [30, 0, 38],
    ...overrides,
  };
}

function makeConsumed(): { gyro: V3; accel: V3; mag: V3 } {
  return {
    gyro: [0.11, 0.22, 0.33],
    accel: [0.01, 0, 9.8],
    mag: [31, 1, 37],
  };
}

function makeSnapshot(): KalmanStepSnapshot {
  return {
    dt: 0.01,
    qInput: { w: 1, x: 0, y: 0, z: 0 },
    biasInputRad: [0, 0, 0],
    pDiagInput: [0.007, 0.007, 0.007, 0.00007, 0.00007, 0.00007],
    correctedGyroRad: [0.1, 0.2, 0.3],
    qPredicted: { w: 1, x: 0.3826834324, y: 0, z: 0 },
    pDiagPredicted: [0.0065, 0.0065, 0.0065, 0.000065, 0.000065, 0.000065],
    observations: [
      {
        channel: "accel",
        available: true,
        predicted: [0, 0, 1],
        measured: [0.01, 0, 0.9999],
        innovation: [0.01, 0, -0.0001],
        innovationAngleDeg: 1.25,
        nis: 2.5,
        gate: { kind: "angle", threshold: 40, accepted: true, reason: "applied" },
        S: [0.0025, 0, 0, 0, 0.0025, 0, 0, 0, 0.0025],
        K: new Array<number>(18).fill(0.05),
        dx: [0.001, 0.002, 0.003, 0.00001, 0.00002, 0.00003],
        applied: true,
        qBefore: { w: 1, x: 0, y: 0, z: 0 },
        qAfter: { w: 1, x: 0.3826834324, y: 0, z: 0 },
        biasBeforeRad: [0, 0, 0],
        biasAfterRad: [0.0001, 0, 0],
        pDiagBefore: [0.007, 0.007, 0.007, 0.00007, 0.00007, 0.00007],
        pDiagAfter: [0.006, 0.006, 0.006, 0.00006, 0.00006, 0.00006],
        covarianceResetApplied: false,
      },
    ],
    qFinal: { w: 1, x: 0.3826834324, y: 0, z: 0 },
    biasFinalRad: [0.0001, 0, 0],
    pDiagFinal: [0.006, 0.006, 0.006, 0.00006, 0.00006, 0.00006],
    covarianceResetApplied: false,
  };
}

interface FrameOptions {
  runId?: number;
  seq?: number;
  t?: number;
  truthKind?: ReferenceKind;
  truthQ?: Quat | null;
  estimateId?: ReviewFrame["estimate"]["id"];
  estimateQ?: Quat;
  raw?: ImuSample;
  consumed?: ReviewFrame["input"]["consumed"];
  telemetry?: EstimatorTelemetry;
  totalDeg?: number | null;
  tiltDeg?: number | null;
  yawDeg?: number | null;
  eskf?: ReviewFrame["eskf"];
}

function makeFrame(opts: FrameOptions = {}): ReviewFrame {
  const {
    runId = 1,
    seq = 0,
    t = seq / 25,
    truthKind = "groundTruth",
    truthQ = Q0,
    estimateId = "comp",
    estimateQ = Q0,
    raw = makeRaw(),
    consumed = makeConsumed(),
    telemetry = makeTelemetry(),
    totalDeg = 1.5,
    tiltDeg = 1.0,
    yawDeg = 0.5,
    eskf,
  } = opts;
  return buildReviewFrame({
    runId,
    seq,
    t,
    truthKind,
    truthQ,
    estimateId,
    estimateQ,
    raw,
    consumed,
    telemetry,
    totalDeg,
    tiltDeg,
    yawDeg,
    ...(eskf !== undefined ? { eskf } : {}),
  });
}

function copyFrame(frame: ReviewFrame): ReviewFrame {
  return JSON.parse(JSON.stringify(frame)) as ReviewFrame;
}

test("容量与淘汰：默认 750，满后覆盖最旧并准确计数", () => {
  assert.equal(DEFAULT_REVIEW_CAPACITY, 750);
  assert.equal(new ReviewBuffer().capacity, 750);

  const buffer = new ReviewBuffer(3);
  for (let i = 0; i < 5; i++) buffer.push(makeFrame({ seq: i, t: i / 25 }));
  assert.equal(buffer.size, 3);
  assert.equal(buffer.dropped, 2);
  assert.equal(buffer.health().dropped, 2);
  assert.equal(buffer.health().full, true);
  assert.equal(buffer.health().oldestT, 2 / 25);
  assert.equal(buffer.health().newestT, 4 / 25);
  assert.deepEqual(buffer.list(1).map((frame) => frame.seq), [2, 3, 4]);
  assert.deepEqual(buffer.list(1).map((frame) => frame.t), [2 / 25, 3 / 25, 4 / 25]);

  assert.throws(() => new ReviewBuffer(0), RangeError);
  assert.throws(() => new ReviewBuffer(1.5), RangeError);
  assert.throws(() => new ReviewBuffer(Number.NaN), RangeError);
});

test("读取按 (t, seq) 排序：乱序入队仍得到稳定时间轴", () => {
  const buffer = new ReviewBuffer(8);
  buffer.push(makeFrame({ seq: 5, t: 1.0 }));
  buffer.push(makeFrame({ seq: 2, t: 0.4 }));
  buffer.push(makeFrame({ seq: 9, t: 0.4 }));
  buffer.push(makeFrame({ seq: 1, t: 0.04 }));

  assert.deepEqual(
    buffer.list(1).map((frame) => [frame.t, frame.seq]),
    [
      [0.04, 1],
      [0.4, 2],
      [0.4, 9],
      [1.0, 5],
    ],
  );
  assert.equal(buffer.latest(1)?.seq, 5);
  assert.deepEqual(buffer.list(1, 0.1, 0.5).map((frame) => frame.seq), [2, 9]);
  assert.deepEqual(buffer.list(1, 0.5, 0.1), []);
});

test("runId 隔离：错误轮次读不到帧，reset 后旧轮不可读", () => {
  const buffer = new ReviewBuffer(8);
  for (let i = 0; i < 3; i++) buffer.push(makeFrame({ runId: 100, seq: i, t: i / 25 }));
  for (let i = 0; i < 2; i++) buffer.push(makeFrame({ runId: 200, seq: i, t: 10 + i / 25 }));

  assert.equal(buffer.latest(100)?.runId, 100);
  assert.equal(buffer.latest(200)?.seq, 1);
  assert.equal(buffer.latest(999), null);
  assert.deepEqual([...new Set(buffer.list(100).map((frame) => frame.runId))], [100]);
  assert.deepEqual(buffer.list(200).map((frame) => frame.seq), [0, 1]);
  assert.equal(buffer.nearest(200, 0).frame, null, "run 100 的 t=0 帧不能被 run 200 读到");
  assert.deepEqual(buffer.health().runIds, [100, 200]);

  assert.equal(buffer.clear(100), 3);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.latest(100), null);
  assert.equal(buffer.latest(200)?.seq, 1);

  buffer.reset();
  assert.equal(buffer.size, 0);
  buffer.push(makeFrame({ runId: 300, seq: 0, t: 20 }));
  assert.equal(buffer.latest(200), null, "reset 后旧 runId 不得再读到任何帧");
  assert.equal(buffer.latest(300)?.runId, 300);
  assert.equal(buffer.nearest(200, 20).frame, null);
});

test("变更安全：入参、已入队帧与读取结果都不得共享引用", () => {
  const truthQ: Quat = { ...Q_OFF };
  const estimateQ: Quat = { ...Q0 };
  const raw = makeRaw({ times: { gyro: 0.1, accel: 0.1, mag: 0.1 } });
  const consumed = makeConsumed();
  const telemetry = makeTelemetry();
  const built = buildReviewFrame({
    runId: 1,
    seq: 7,
    t: 0.28,
    truthKind: "groundTruth",
    truthQ,
    estimateId: "comp",
    estimateQ,
    raw,
    consumed,
    telemetry,
    totalDeg: 1.5,
    tiltDeg: 1.0,
    yawDeg: 0.5,
  });

  truthQ.x = 99;
  estimateQ.w = 99;
  raw.gyro[0] = 99;
  raw.mag[2] = 99;
  raw.times!.accel = 99;
  consumed.gyro[0] = 99;
  telemetry.rate[0] = 99;
  telemetry.detail.accelWeight = 99;

  assert.equal(built.truth.q?.x, Q_OFF.x, "buildReviewFrame 必须复制真值四元数");
  assert.equal(built.estimate.q.w, 1, "buildReviewFrame 必须复制估计四元数");
  assert.equal(built.input.raw.gyro[0], 0.1, "buildReviewFrame 必须复制 IMU gyro");
  assert.equal(built.input.raw.mag[2], 38, "buildReviewFrame 必须复制 IMU mag");
  assert.equal(built.input.raw.times?.accel, 0.1, "buildReviewFrame 必须复制 IMU times");
  assert.equal(built.input.consumed.gyro[0], 0.11, "buildReviewFrame 必须复制 consumed");
  assert.equal(built.telemetry.rate[0], 0.1, "buildReviewFrame 必须复制 telemetry 向量");
  assert.equal(built.telemetry.detail.accelWeight, 0.25, "buildReviewFrame 必须复制 detail");

  const buffer = new ReviewBuffer(4);
  buffer.push(built);

  built.truth.q!.x = 88;
  built.estimate.q.w = 88;
  built.input.raw.gyro[0] = 88;
  built.input.raw.times!.gyro = 88;
  built.input.consumed.mag[2] = 88;
  built.telemetry.rate[1] = 88;
  built.telemetry.detail.gateMode = 88;
  built.errors.totalDeg = 88;

  const read = buffer.latest(1);
  assert.ok(read);
  assert.equal(read.truth.q?.x, Q_OFF.x, "push 必须复制待入队帧");
  assert.equal(read.estimate.q.w, 1);
  assert.equal(read.input.raw.gyro[0], 0.1);
  assert.equal(read.input.raw.times?.gyro, 0.1);
  assert.equal(read.input.consumed.mag[2], 37);
  assert.equal(read.telemetry.rate[1], 0.2);
  assert.equal(read.telemetry.detail.gateMode, 0);
  assert.equal(read.errors.totalDeg, 1.5);

  read.truth.q!.x = 77;
  read.estimate.q.w = 77;
  read.input.raw.gyro[0] = 77;
  read.input.raw.times!.accel = 77;
  read.input.consumed.accel[0] = 77;
  read.telemetry.rate[0] = 77;
  read.telemetry.detail.accelWeight = 77;
  read.errors.tiltDeg = 77;

  const again = buffer.latest(1);
  assert.ok(again);
  assert.notEqual(read, again, "每次读取必须返回独立对象");
  assert.notEqual(read.telemetry.detail, again.telemetry.detail);
  assert.equal(again.truth.q?.x, Q_OFF.x, "修改读取结果不得污染缓冲");
  assert.equal(again.estimate.q.w, 1);
  assert.equal(again.input.raw.gyro[0], 0.1);
  assert.equal(again.input.raw.times?.accel, 0.1);
  assert.equal(again.input.consumed.accel[0], 0.01);
  assert.equal(again.telemetry.rate[0], 0.1);
  assert.equal(again.telemetry.detail.accelWeight, 0.25);
  assert.equal(again.errors.tiltDeg, 1.0);

  const listed = buffer.list(1);
  listed[0].telemetry.detail.accelWeight = 55;
  assert.equal(buffer.list(1)[0].telemetry.detail.accelWeight, 0.25);
});

test("真值语义：mahony/none 的 truth.q 恒为 null，其他参考保留四元数", () => {
  for (const kind of ["mahony", "none"] as const) {
    const frame = makeFrame({ truthKind: kind, truthQ: Q_OFF });
    assert.equal(frame.truth.kind, kind);
    assert.equal(frame.truth.q, null, `${kind} 不得携带真值四元数`);
    const buffer = new ReviewBuffer(2);
    buffer.push(frame);
    assert.equal(buffer.latest(1)?.truth.q, null);
  }

  for (const kind of ["groundTruth", "external"] as const) {
    const frame = makeFrame({ truthKind: kind, truthQ: Q_OFF });
    assert.deepEqual(frame.truth.q, Q_OFF);
  }
});

test("IMU times：存在则逐字段复制，不存在则保持字段缺失", () => {
  const raw = makeRaw({ times: { gyro: 0.11, accel: 0.12, mag: 0.13 } });
  const frame = makeFrame({ raw });
  assert.deepEqual(frame.input.raw.times, { gyro: 0.11, accel: 0.12, mag: 0.13 });
  assert.notEqual(frame.input.raw.times, raw.times);
  raw.times!.gyro = 9;
  assert.equal(frame.input.raw.times!.gyro, 0.11);

  const buffer = new ReviewBuffer(2);
  buffer.push(frame);
  const read = buffer.latest(1);
  assert.ok(read);
  assert.deepEqual(read.input.raw.times, { gyro: 0.11, accel: 0.12, mag: 0.13 });
  assert.notEqual(read.input.raw.times, frame.input.raw.times);

  const withoutTimes = makeFrame({ raw: makeRaw() });
  assert.equal("times" in withoutTimes.input.raw, false, "透传快路径不得补 times 字段");
  buffer.push(withoutTimes);
  const readWithout = buffer.latest(1);
  assert.ok(readWithout);
  assert.equal("times" in readWithout.input.raw, false);
});

test("观测状态：accelState/magState/原因码逐项往返，null 原因码保持 null", () => {
  const telemetry = makeTelemetry({
    accelState: "applied",
    magState: "rejected",
    accelReasonCode: "applied",
    magReasonCode: "gate-direction",
  });
  const frame = makeFrame({ telemetry });
  assert.equal(frame.telemetry.accelState, "applied");
  assert.equal(frame.telemetry.magState, "rejected");
  assert.equal(frame.telemetry.accelReasonCode, "applied");
  assert.equal(frame.telemetry.magReasonCode, "gate-direction");

  const buffer = new ReviewBuffer(4);
  buffer.push(frame);
  const read = buffer.list(1)[0];
  assert.ok(read);
  assert.equal(read.telemetry.accelState, "applied");
  assert.equal(read.telemetry.magState, "rejected");
  assert.equal(read.telemetry.accelReasonCode, "applied");
  assert.equal(read.telemetry.magReasonCode, "gate-direction");

  const nullReason = makeFrame({
    telemetry: makeTelemetry({
      accelState: "unrecorded",
      magState: "not-applicable",
      accelReasonCode: null,
      magReasonCode: null,
    }),
  });
  assert.equal(nullReason.telemetry.accelReasonCode, null, "null 原因码不得折成字符串 \"null\"");
  assert.equal(nullReason.telemetry.magReasonCode, null);
  buffer.push(nullReason);
  const readNull = buffer.latest(1);
  assert.ok(readNull?.telemetry.accelReasonCode === null);
  assert.ok(readNull?.telemetry.magReasonCode === null);
});

test("观测状态变更安全：修改取回帧不污染缓冲内原帧", () => {
  const buffer = new ReviewBuffer(2);
  buffer.push(
    makeFrame({
      telemetry: makeTelemetry({
        accelState: "rejected",
        magState: "applied",
        accelReasonCode: "gate-direction",
        magReasonCode: "applied",
      }),
    }),
  );

  const read = buffer.latest(1);
  assert.ok(read);
  read.telemetry.accelState = "applied";
  read.telemetry.magState = "unrecorded";
  read.telemetry.accelReasonCode = "tampered";
  read.telemetry.magReasonCode = "tampered";

  const again = buffer.latest(1);
  assert.ok(again);
  assert.equal(again.telemetry.accelState, "rejected");
  assert.equal(again.telemetry.magState, "applied");
  assert.equal(again.telemetry.accelReasonCode, "gate-direction");
  assert.equal(again.telemetry.magReasonCode, "applied");
});

test("观测状态白名单：非法状态被拒绝，全部合法值可入队", () => {
  const buffer = new ReviewBuffer(8);
  const base = makeFrame();

  for (const field of ["accelState", "magState"] as const) {
    for (const value of ["bogus", "", 42, null]) {
      const badFrame = copyFrame(base);
      (badFrame.telemetry as unknown as Record<string, unknown>)[field] = value;
      assert.throws(
        () => buffer.push(badFrame),
        new RegExp(`ReviewFrame\\.telemetry\\.${field}`),
        `${field}=${String(value)} 必须被拒绝`,
      );
    }
  }
  assert.equal(buffer.size, 0, "非法状态不得入队");

  const states = [
    "applied",
    "accepted-not-applied",
    "rejected",
    "invalid",
    "disabled",
    "unrecorded",
    "not-applicable",
  ] as const;
  states.forEach((state, index) => {
    buffer.push(
      makeFrame({
        seq: index,
        t: index / 25,
        telemetry: makeTelemetry({
          accelState: state,
          magState: state,
          accelReasonCode: null,
          magReasonCode: null,
        }),
      }),
    );
  });
  assert.equal(buffer.size, states.length);
  assert.deepEqual(
    buffer.list(1).map((frame) => frame.telemetry.accelState),
    [...states],
  );
});

test("ESKF 快照：写入帧并往返后字段完整，修改副本不影响缓冲", () => {
  const snapshot = makeSnapshot();
  const frame = makeFrame({ eskf: snapshot });
  assert.deepEqual(frame.eskf, snapshot);
  snapshot.dt = 9;
  assert.equal(frame.eskf?.dt, 0.01, "buildReviewFrame 必须复制快照");

  const buffer = new ReviewBuffer(2);
  buffer.push(frame);
  const read = buffer.latest(1);
  assert.ok(read?.eskf);
  assert.deepEqual(read.eskf, frame.eskf);
  assert.notEqual(read.eskf, frame.eskf, "读取必须返回独立快照对象");
  assert.notEqual(read.eskf.observations, frame.eskf.observations);

  read.eskf.observations[0].nis = 99;
  read.eskf.qFinal.x = 99;
  const again = buffer.latest(1);
  assert.ok(again?.eskf);
  assert.equal(again.eskf.observations[0].nis, 2.5, "修改读取快照不得污染缓冲");
  assert.equal(again.eskf.qFinal.x, 0.3826834324);

  assert.equal("eskf" in makeFrame(), false, "未提供快照时不得凭空写字段");
  assert.equal(makeFrame({ eskf: null }).eskf, null, "显式 null 表示本轮无快照");
});

test("误差字段：null 原样保留，绝不折算为 0", () => {
  const frame = makeFrame({ totalDeg: null, tiltDeg: null, yawDeg: null });
  assert.deepEqual(frame.errors, { totalDeg: null, tiltDeg: null, yawDeg: null });
  assert.equal(frame.errors.totalDeg, null);

  const buffer = new ReviewBuffer(2);
  buffer.push(frame);
  const read = buffer.latest(1);
  assert.ok(read);
  assert.deepEqual(read.errors, { totalDeg: null, tiltDeg: null, yawDeg: null });
  assert.notEqual(read.errors.totalDeg, 0);
  assert.notEqual(read.errors.tiltDeg, 0);
  assert.notEqual(read.errors.yawDeg, 0);

  const mixed = makeFrame({ totalDeg: 1.25, tiltDeg: null, yawDeg: 0 });
  assert.equal(mixed.errors.totalDeg, 1.25);
  assert.equal(mixed.errors.tiltDeg, null);
  assert.equal(mixed.errors.yawDeg, 0);
});

test("nearest：默认 20 ms 容差、带符号 actualDt、超差返回空", () => {
  assert.equal(DEFAULT_NEAREST_TOLERANCE_SEC, 0.02);
  const buffer = new ReviewBuffer(8);
  buffer.push(makeFrame({ seq: 0, t: 0.1 }));
  buffer.push(makeFrame({ seq: 1, t: 0.2 }));

  const hit = buffer.nearest(1, 0.11);
  assert.ok(hit.frame);
  assert.equal(hit.frame.seq, 0);
  assert.ok(Math.abs(hit.actualDt! + 0.01) < 1e-12, `actualDt 应为 -0.01，实际 ${hit.actualDt}`);

  const exact = buffer.nearest(1, 0.2);
  assert.ok(exact.frame);
  assert.equal(exact.frame.seq, 1);
  assert.equal(exact.actualDt, 0);

  const miss = buffer.nearest(1, 0.135, 0.02);
  assert.equal(miss.frame, null);
  assert.equal(miss.actualDt, null);

  const wide = buffer.nearest(1, 0.135, 0.1);
  assert.ok(wide.frame);
  assert.equal(wide.frame.seq, 0);
  assert.ok(Math.abs(wide.actualDt! + 0.035) < 1e-12, "actualDt 必须带符号");

  const tieBuffer = new ReviewBuffer(2);
  tieBuffer.push(makeFrame({ seq: 10, t: 1 }));
  tieBuffer.push(makeFrame({ seq: 11, t: 3 }));
  const tie = tieBuffer.nearest(1, 2, 2);
  assert.ok(tie.frame);
  assert.equal(tie.frame.seq, 10, "等距时优先更早帧");

  assert.equal(buffer.nearest(2, 0.1).frame, null);
  assert.equal(buffer.nearest(1, Number.NaN).frame, null);
  assert.throws(() => buffer.nearest(1, 0.1, -0.01), RangeError);
  assert.throws(() => buffer.nearest(1, 0.1, Number.NaN), RangeError);
});

test("clear/reset：按 runId 清理、保留其余顺序、reset 清空统计", () => {
  const buffer = new ReviewBuffer(3);
  buffer.push(makeFrame({ runId: 1, seq: 0, t: 0 }));
  buffer.push(makeFrame({ runId: 1, seq: 1, t: 0.04 }));
  buffer.push(makeFrame({ runId: 2, seq: 0, t: 0.08 }));
  buffer.push(makeFrame({ runId: 2, seq: 1, t: 0.12 }));
  assert.equal(buffer.dropped, 1);

  assert.equal(buffer.clear(2), 2);
  assert.equal(buffer.size, 1);
  assert.deepEqual(buffer.list(1).map((frame) => frame.seq), [1]);
  assert.deepEqual(buffer.health().runIds, [1]);
  assert.equal(buffer.clear(2), 0);
  assert.equal(buffer.clear(999), 0);

  buffer.reset();
  assert.equal(buffer.size, 0);
  assert.equal(buffer.dropped, 0);
  assert.deepEqual(buffer.health(), {
    capacity: 3,
    size: 0,
    dropped: 0,
    full: false,
    runIds: [],
    oldestT: null,
    newestT: null,
  });
  assert.equal(buffer.latest(1), null);
  assert.deepEqual(buffer.list(1), []);
});

test("坏帧拒绝：校验失败时缓冲长度与 dropped 不变", () => {
  const buffer = new ReviewBuffer(4);
  const valid = makeFrame();
  const mutations: Array<{ name: string; mutate: (frame: ReviewFrame) => void }> = [
    {
      name: "runId 非有限",
      mutate: (frame) => {
        (frame as unknown as { runId: number }).runId = Number.NaN;
      },
    },
    {
      name: "seq 非有限",
      mutate: (frame) => {
        (frame as unknown as { seq: number }).seq = Number.POSITIVE_INFINITY;
      },
    },
    {
      name: "t 非有限",
      mutate: (frame) => {
        (frame as unknown as { t: number }).t = Number.NaN;
      },
    },
    {
      name: "未知 truth.kind",
      mutate: (frame) => {
        (frame.truth as unknown as { kind: string }).kind = "bogus";
      },
    },
    {
      name: "mahony 携带真值四元数",
      mutate: (frame) => {
        (frame.truth as unknown as { kind: string }).kind = "mahony";
      },
    },
    {
      name: "未知估计器 id",
      mutate: (frame) => {
        (frame.estimate as unknown as { id: string }).id = "truth";
      },
    },
    {
      name: "estimate.q 非有限",
      mutate: (frame) => {
        (frame.estimate.q as unknown as { w: number }).w = Number.POSITIVE_INFINITY;
      },
    },
    {
      name: "truth.q 非有限",
      mutate: (frame) => {
        (frame.truth.q as unknown as { x: number }).x = Number.NaN;
      },
    },
    {
      name: "raw.gyro 长度错误",
      mutate: (frame) => {
        (frame.input.raw as unknown as { gyro: number[] }).gyro = [1, 2];
      },
    },
    {
      name: "times 缺字段",
      mutate: (frame) => {
        (frame.input.raw as unknown as { times: unknown }).times = { gyro: 0, accel: 0 };
      },
    },
    {
      name: "consumed.mag 非有限",
      mutate: (frame) => {
        (frame.input.consumed as unknown as { mag: number[] }).mag = [1, 2, Number.NaN];
      },
    },
    {
      name: "telemetry.detail 非对象",
      mutate: (frame) => {
        (frame.telemetry as unknown as { detail: unknown }).detail = [];
      },
    },
    {
      name: "telemetry.detail 值非数字",
      mutate: (frame) => {
        (frame.telemetry.detail as unknown as Record<string, unknown>).gateMode = "0";
      },
    },
    {
      name: "telemetry.accelNorm 非有限",
      mutate: (frame) => {
        (frame.telemetry as unknown as { accelNorm: number }).accelNorm = Number.NaN;
      },
    },
    {
      name: "errors.totalDeg 非有限",
      mutate: (frame) => {
        (frame.errors as unknown as { totalDeg: number }).totalDeg = Number.NaN;
      },
    },
    {
      name: "errors.tiltDeg 缺字段",
      mutate: (frame) => {
        delete (frame.errors as unknown as { tiltDeg?: number }).tiltDeg;
      },
    },
    {
      name: "缺 input",
      mutate: (frame) => {
        delete (frame as unknown as { input?: unknown }).input;
      },
    },
    {
      name: "eskf 含函数",
      mutate: (frame) => {
        (frame as unknown as { eskf: unknown }).eskf = () => 0;
      },
    },
  ];

  for (const { name, mutate } of mutations) {
    const bad = copyFrame(valid);
    mutate(bad);
    assert.throws(() => buffer.push(bad), /ReviewFrame/, name);
  }
  assert.throws(() => buffer.push(null as unknown as ReviewFrame), /ReviewFrame/);
  assert.throws(() => buffer.push({} as ReviewFrame), /ReviewFrame/);

  assert.equal(buffer.size, 0, "坏帧不得改变长度");
  assert.equal(buffer.dropped, 0, "坏帧不得改变淘汰计数");

  buffer.push(valid);
  assert.equal(buffer.size, 1);
});

test("内存上界：大量入队后长度不超过容量", () => {
  const buffer = new ReviewBuffer(32);
  for (let i = 0; i < 5000; i++) buffer.push(makeFrame({ runId: 7, seq: i, t: i / 25 }));

  assert.equal(buffer.size, 32);
  assert.equal(buffer.health().capacity, 32);
  assert.equal(buffer.health().full, true);
  assert.equal(buffer.dropped, 5000 - 32);

  const list = buffer.list(7);
  assert.equal(list.length, 32);
  assert.equal(list[0].seq, 5000 - 32);
  assert.equal(list[31].seq, 4999);
});

test("性能：10k 帧入队在交互预算内", () => {
  const buffer = new ReviewBuffer();
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) buffer.push(makeFrame({ seq: i, t: i / 25 }));
  const elapsed = performance.now() - started;

  assert.equal(buffer.size, DEFAULT_REVIEW_CAPACITY);
  assert.equal(buffer.dropped, 10_000 - DEFAULT_REVIEW_CAPACITY);
  assert.ok(elapsed < 2000, `10k 次 push 耗时 ${elapsed.toFixed(1)} ms，超过 2000 ms`);
  console.log(`INFO 10k 次 push 耗时 ${elapsed.toFixed(1)} ms`);
});

test("模块边界：无 DOM / 无 runner / 只用类型依赖", () => {
  const source = readFileSync(new URL("../src/core/review-buffer.ts", import.meta.url), "utf8");
  assert.ok(
    !/\b(document|window|HTMLElement|localStorage|sessionStorage|indexedDB|requestAnimationFrame)\b/.test(source),
    "review-buffer.ts 不得依赖 DOM 或持久化",
  );
  assert.ok(!/from\s+["'][^"']*runner[^"']*["']/.test(source), "review-buffer.ts 不得 import runner");

  const importLines = source
    .split(/\r?\n/)
    .filter((line) => /^(?:import|export)\b/.test(line) && /\bfrom\s+"/.test(line));
  assert.ok(importLines.length >= 5, `应至少识别 5 条 import/export，实际 ${importLines.length}`);
  for (const line of importLines) {
    assert.ok(/^(?:import|export)\s+type\s/.test(line), `只允许类型依赖：${line}`);
  }
  assert.ok(!/^import\s+["']/m.test(source), "不得有运行时副作用 import");
  const specifiers = importLines
    .map((line) => line.match(/from\s+"([^"]+)"/)?.[1])
    .filter((value): value is string => Boolean(value));
  assert.deepEqual(
    specifiers.sort(),
    ["./data-source", "./experiment-config", "./imu", "./quat", "../estimators"].sort(),
  );
});

console.log(`review-buffer-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
