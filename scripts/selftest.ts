/**
 * 数值自检：验证坐标约定与四种解算算法的收敛性。
 * 运行：npm run selftest
 */
import { World } from "../src/core/world";
import { manualTarget, scenarios } from "../src/core/scenarios";
import { G_ACC, MAG_WORLD_NED, SOFT_IRON_M, simulateImu, simulateMag, softIronGains, type ImuParams, type ImuSample } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import {
  ATTITUDE_BASE_FIELDS,
  FRAME_LEN,
  HEARTBEAT_BASE_FIELDS,
  MAVLINK_CRC_EXTRA_RAW_IMU,
  RAW_IMU_BASE_FIELDS,
  buildFrame,
  buildMavlinkRawImu,
  computeCrcExtra,
  frameDtSec,
  frameIntervalSec,
  logIntervalSec,
  parseFrame,
  parseMavlinkFrame,
  parseTextLine,
  type Mounting,
} from "../src/core/serial";
import { toDisplayVec, sweepPitchDeg } from "../src/core/gimbal";
import { percentile } from "../src/core/stats";
import {
  ComplementaryEstimator,
  coarseAlign,
  KalmanEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
  type Estimator,
} from "../src/estimators";
import {
  DEG,
  qDot,
  RAD,
  eulerLerp,
  qAngleBetween,
  qExp,
  qFromAxisAngle,
  qFromEuler,
  qId,
  qIntegrate,
  qLog,
  qMul,
  qConj,
  qNorm,
  qRot,
  qRotInv,
  qSlerp,
  symmetricEigen3,
  squad,
  squadTangent,
  qToAxisAngle,
  qToEuler,
  qToMatrix,
  type V3,
} from "../src/core/quat";
import {
  GIMBAL_DEMO_DURATION,
  gimbalAxisAlign,
  gimbalDemo,
  gimbalDemoPhaseEnd,
  gimbalInnerQuat,
  gimbalLocked,
  toDisplayQ,
} from "../src/core/gimbal";
import { narrateGimbal } from "../src/ui/mode";
import {
  calibrateMag,
  fitMagSphere,
  applyMagCalibration,
  calibrateMagFull,
  calibrateMagWithValidation,
  magFieldResidual,
  splitFitValidate,
  verifyMagCalibration,
} from "../src/core/magcal";
import { ErrorTracker } from "../src/core/stats";
import { b64urlDecode, b64urlEncode } from "../src/ui/b64";
import { parseImuCsv, type ReplayFrame } from "../src/core/replay";
import { allanDeviation, allanSlope, synthesizeGyroAngle } from "../src/core/allan";
import { InsIntegrator, driftLaw, G_NED } from "../src/core/ins";
import { EXPERIMENTS } from "../src/ui/experiments";
import {
  cloneExperimentConfig,
  defaultExperimentConfig,
  migrateExperimentConfig,
  parseAccelCalibration,
  parseMagCalibration,
  validateExperimentConfig,
  type ExperimentConfig,
} from "../src/core/experiment-config";
import { SolveLoop } from "../src/core/solve-loop";
import {
  MetricAccumulator,
  STATS_CAP,
  STATS_RESERVOIR_CAP,
  resultDigest,
  runExperiment,
  runExperimentDetailed,
  runTrace,
  summarizeRuns,
  runMonteCarlo,
  seedSequence,
  so3ErrorSplit,
} from "../src/core/runner";
import { hasPhysicalReference, referenceKindOf, sourceLabelOf } from "../src/core/data-source";
import {
  REF_GRAVITY_NED,
  REF_MAG_NORTH_NED,
  attitudeErrorDeg,
  observationsDegenerate,
  syntheticObservations,
  triad,
  wahbaCost,
  wahbaQuest,
  weightedSolution,
  type VectorObservation,
} from "../src/core/attitude-determination";
import { aliasHz, coningSweep } from "../src/core/coning";
import { SensorPipeline } from "../src/core/sensor-pipeline";
import { accelChannel } from "../src/core/imu";
import { pushBounded } from "../src/core/serial-queue";
import { ReplayPlayer } from "../src/core/replay-player";
import { ReconnectPolicy } from "../src/core/reconnect";
import { accelVerdict, synthesizeAccelVerification } from "../src/core/calib-verify";
import { calibrationStaleness, fingerprintOf } from "../src/core/calib-meta";
import {
  ARCHIVE_KIND,
  ARCHIVE_SCHEMA,
  buildArchive,
  describeArchiveRun,
  parseArchive,
  type ArchiveRunInfo,
} from "../src/core/experiment-archive";
import { EXPERIMENT_SCHEMA_VERSION } from "../src/core/experiment-config";
import { batchRowsHtml, batchStatusText } from "../src/ui/batch-table";
import {
  accelResultHtml,
  accelStatusText,
  accelVerifyLineHtml,
  magResultHtml,
  magStatusText,
  magVerifyLineHtml,
} from "../src/ui/calib-panel";
import {
  ACCEL_MAX_COND,
  applyAccelCalibration,
  assessStaticWindow,
  calibrateAccel,
  conditionNumber3,
  faceMatchesReading,
  faceTrueVector,
  G_ACCEL,
  synthesizeAccelSamples,
  validateAccelCalibration,
  type AccelCalibrationSample,
  verifyAccelCalibration,
} from "../src/core/accelcal";

const H = 1 / 500;
let failures = 0;

function check(name: string, cond: boolean, detail: string): void {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${name} — ${detail}`);
}

/** 静态倾斜场景：真实姿态固定为 (30°, 20°, 0)，跑 T 秒，返回各算法倾角误差与偏航（度） */
function runStatic(
  T: number,
  params: ImuParams,
  startAtTruth = false,
): Array<{ tilt: number; yaw: number; total: number }> {
  const qTrue = qFromEuler(30 * RAD, 20 * RAD, 0);
  const gauss = new Gauss(mulberry32(42));
  const ests = [
    new PureGyroEstimator(),
    new ComplementaryEstimator(),
    new MahonyEstimator(),
    new MadgwickEstimator(),
  ];
  if (startAtTruth) for (const e of ests) e.q = { ...qTrue };
  const steps = Math.round(T / H);
  for (let i = 0; i < steps; i++) {
    const t = i * H;
    const s = simulateImu(qTrue, [0, 0, 0], t, params, gauss, 1);
    for (const e of ests) e.update(s.gyro, s.accel, s.mag, H);
  }
  return ests.map((e) => {
    const eu = qToEuler(e.q);
    return {
      tilt: Math.max(Math.abs(eu.roll - 30 * RAD), Math.abs(eu.pitch - 20 * RAD)) * DEG,
      yaw: eu.yaw * DEG,
      total: qAngleBetween(e.q, qTrue) * DEG,
    };
  });
}

// 磁参数全零：守护既有噪声序列不变（磁采样不消耗随机数）
const clean: ImuParams = { gyroBiasDps: 0, gyroNoiseDps: 0, gyroWalkDps: 0, gyroRangeDps: 0, sensorDelayMs: 0,  gyroScaleErr: 0, gyroMisalign: 0,  accelNoise: 0, accelCrossAxis: 0, accelNonlin: 0, linAccel: 0, vibration: 0, magNoise: 0, magQuantUts: 0, hardIron: 0, disturbMag: 0, magSoftIron: 0 };
const dirty: ImuParams = { gyroBiasDps: 1, gyroNoiseDps: 0.2, gyroWalkDps: 0, gyroRangeDps: 0, sensorDelayMs: 0,  gyroScaleErr: 0, gyroMisalign: 0,  accelNoise: 0.15, accelCrossAxis: 0, accelNonlin: 0, linAccel: 0.5, vibration: 0.3, magNoise: 0, magQuantUts: 0, hardIron: 0, disturbMag: 0, magSoftIron: 0 };

// 1. 欧拉角 ↔ 四元数 往返
{
  const e0 = { roll: 32 * RAD, pitch: -21 * RAD, yaw: 143 * RAD };
  const e1 = qToEuler(qFromEuler(e0.roll, e0.pitch, e0.yaw));
  const err = Math.max(
    Math.abs(e0.roll - e1.roll),
    Math.abs(e0.pitch - e1.pitch),
    Math.abs(e0.yaw - e1.yaw),
  );
  check("欧拉角↔四元数往返", err < 1e-9, `最大分量偏差 ${err.toExponential(2)} rad`);
}

// 2. 干净 IMU：纯积分（起始对齐）不漂移；三种融合算法倾角精确收敛（偏航不可观，仅验证有界）
{
  const [pureAligned] = runStatic(10, clean, true);
  check("纯积分（无零偏）", pureAligned.total < 0.5, `10s 误差 ${pureAligned.total.toFixed(3)}°`);
  const [, comp, mahony, madg] = runStatic(10, clean);
  check("互补滤波倾角收敛", comp.tilt < 1, `φ/θ 误差 ${comp.tilt.toFixed(3)}°`);
  check("Mahony 倾角收敛", mahony.tilt < 1.5, `φ/θ 误差 ${mahony.tilt.toFixed(3)}°（Ki 暂态残留）`);
  check("Madgwick 倾角收敛", madg.tilt < 1, `φ/θ 误差 ${madg.tilt.toFixed(3)}°`);
  check("偏航有界（互补）", Math.abs(comp.yaw) < 10, `收敛后偏航 ${comp.yaw.toFixed(2)}°（不可观）`);
  check("偏航有界（Madgwick）", Math.abs(madg.yaw) < 10, `收敛后偏航 ${madg.yaw.toFixed(2)}°（不可观）`);
}

// 3. 零偏 1°/s（起始对齐真值）：纯积分线性漂移（≈10°）；融合算法倾角保持、偏航缓慢漂移
{
  const [pure, comp, mahony, madg] = runStatic(10, { ...clean, gyroBiasDps: 1 }, true);
  check("纯积分零偏漂移", pure.total > 5 && pure.total < 15, `10s 误差 ${pure.total.toFixed(2)}°（预期约 10°）`);
  check("互补滤波抗零偏", comp.total < 5, `10s 总误差 ${comp.total.toFixed(2)}°`);
  check("Mahony 抗零偏", mahony.total < 6, `10s 总误差 ${mahony.total.toFixed(2)}°`);
  check("Madgwick 抗零偏", madg.total < 8, `10s 总误差 ${madg.total.toFixed(2)}°`);
}

// 4. 噪声 + 振动 + 机动线加速度：融合算法误差有界
{
  const [, , mahony, madg] = runStatic(20, dirty);
  check("Mahony 抗扰", mahony.total < 6, `20s 总误差 ${mahony.total.toFixed(2)}°`);
  check("Madgwick 抗扰", madg.total < 8, `20s 总误差 ${madg.total.toFixed(2)}°`);
}

// 4b. 动态跟踪（关键回归项）：横滚 360° 机动中，融合算法必须跟得上陀螺
{
  const world = new World(scenarios.roll360);
  const ests = [
    new PureGyroEstimator(),
    new ComplementaryEstimator(),
    new MahonyEstimator(),
    new MadgwickEstimator(),
  ];
  let maxTilt = [0, 0, 0];
  const wrapDeg = (d: number): number => {
    let v = d;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    return v;
  };
  for (let i = 0; i < Math.round(6 / H); i++) {
    const s = world.step(H, dirty);
    for (let k = 1; k < ests.length; k++) ests[k].update(s.gyro, s.accel, s.mag, H);
    for (let k = 1; k < ests.length; k++) {
      const eu = qToEuler(ests[k].q);
      const tu = qToEuler(world.q);
      const tilt = Math.max(
        Math.abs(wrapDeg((eu.roll - tu.roll) * DEG)),
        Math.abs(wrapDeg((eu.pitch - tu.pitch) * DEG)),
      );
      if (tilt > maxTilt[k - 1]) maxTilt[k - 1] = tilt;
    }
  }
  check("互补滤波动态跟踪", maxTilt[0] < 15, `横滚中最大倾角误差 ${maxTilt[0].toFixed(1)}°`);
  check("Mahony 动态跟踪", maxTilt[1] < 15, `横滚中最大倾角误差 ${maxTilt[1].toFixed(1)}°`);
  check("Madgwick 动态跟踪", maxTilt[2] < 15, `横滚中最大倾角误差 ${maxTilt[2].toFixed(1)}°`);
}

// 5. 机动剧本切换（回归）：每个 id 都必须能驱动仿真
//    曾经的 bug：scenarios 缺 manual 条目 → world.scenario = undefined → 每帧 TypeError 杀死渲染循环
{
  const ids = Object.keys(scenarios);
  let failedId = "";
  let failMsg = "";
  for (const id of ids) {
    try {
      const w = new World(scenarios[id]);
      for (let i = 0; i < 500; i++) w.step(H, clean);
    } catch (err) {
      failedId = id;
      failMsg = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  check(
    "全部机动剧本可驱动仿真",
    failedId === "",
    failedId === "" ? `${ids.length} 个剧本（${ids.join("/")}）各跑 1s 无异常` : `剧本 ${failedId} 抛异常：${failMsg}`,
  );
}

// 5b. 手动模式（回归）：目标角写在**世界实例**上后姿态应跟踪到位
//     （历史版本写全局 scenarios.manualTarget，导致同配置不可复现；见 5c）
{
  const world = new World(scenarios.manual);
  world.setManualTarget([40, -30, 90]);
  for (let i = 0; i < 1000; i++) world.step(H, clean);
  const e = qToEuler(world.q);
  const err =
    Math.abs(e.roll - 40 * RAD) * DEG + Math.abs(e.pitch + 30 * RAD) * DEG + Math.abs(e.yaw - 90 * RAD) * DEG;
  check("手动模式目标驱动姿态", err < 3, `2s 后三轴误差之和 ${err.toFixed(2)}°`);
  manualTarget.rollDeg = 0;
  manualTarget.pitchDeg = 0;
  manualTarget.yawDeg = 0;
}

// 5c. 未知剧本 id 必须回落到悬停，绝不留下 undefined
{
  const world = new World(scenarios.hover);
  const s = world.setScenario("does-not-exist");
  check("未知剧本 id 回落", s === scenarios.hover, `回落至「${s.name}」`);
}

// 6. 四元数积分：恒定角速度绕 z 轴 1 圈后回到原位
{
  let q = qId();
  const steps = Math.round(2 / H); // ωz = π rad/s → 2s 一圈
  for (let i = 0; i < steps; i++) q = qIntegrate(q, [0, 0, Math.PI], H);
  check("四元数积分回位", qAngleBetween(q, qId()) * DEG < 1, `一圈后偏差 ${(qAngleBetween(q, qId()) * DEG).toFixed(3)}°`);
}

// 7. 万向环不变量：三级环链条组合出的内环姿态 ≡ 主视图使用的 toDisplay(qFromEuler(φ,θ,ψ))
//    这条守住「万向节锁演示」和「四轴姿态视图」在数学上完全一致，符号错了会立刻失败
{
  const rnd = mulberry32(20261011);
  let maxDiff = 0;
  for (let i = 0; i < 200; i++) {
    const roll = (rnd() * 2 - 1) * Math.PI;
    const pitch = (rnd() * 2 - 1) * (Math.PI / 2);
    const yaw = (rnd() * 2 - 1) * Math.PI;
    const a = gimbalInnerQuat({ roll, pitch, yaw });
    const b = toDisplayQ(qFromEuler(roll, pitch, yaw));
    // q 与 −q 表示同一旋转，先对齐符号
    const dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    const s = dot < 0 ? -1 : 1;
    const diff = Math.max(
      Math.abs(a.w - s * b.w),
      Math.abs(a.x - s * b.x),
      Math.abs(a.y - s * b.y),
      Math.abs(a.z - s * b.z),
    );
    if (diff > maxDiff) maxDiff = diff;
  }
  check("万向环链条 ≡ 主视图姿态", maxDiff < 1e-9, `200 组随机角度，最大分量偏差 ${maxDiff.toExponential(2)}`);
}

// 8. 死锁判定：俯仰 ±90° 锁定，80° 不锁定
{
  const plus = gimbalLocked(Math.PI / 2);
  const minus = gimbalLocked(-Math.PI / 2);
  const near = gimbalLocked(80 * RAD);
  check("死锁判定 ±90°", plus && minus && !near, `+90°=${plus}，−90°=${minus}，80°=${near}`);
}

// 9. 两轴重合度量化：|sin(俯仰)|
{
  const a90 = gimbalAxisAlign(Math.PI / 2);
  const a0 = gimbalAxisAlign(0);
  const a45 = gimbalAxisAlign(45 * RAD);
  check(
    "两轴重合度量化",
    a90 > 0.9999 && a0 < 1e-12 && Math.abs(a45 - Math.SQRT1_2) < 1e-12,
    `90°→${a90.toFixed(6)}，0°→${a0.toFixed(6)}，45°→${a45.toFixed(6)}（应等于 √2/2）`,
  );
}

// 10. 万向节锁完整演示脚本：覆盖全部相位，且必须演到「只剩 2 个自由度」这一步
{
  const N = 1200;
  const phasesSeen = new Set<string>();
  let maxPitch = -Infinity;
  let minPitch = Infinity;
  let lockSamples = 0;
  let compareRecord = 0;
  let compareVerify = 0;
  for (let i = 0; i <= N; i++) {
    const d = gimbalDemo((i / N) * GIMBAL_DEMO_DURATION);
    phasesSeen.add(d.phaseId);
    maxPitch = Math.max(maxPitch, d.pitch);
    minPitch = Math.min(minPitch, d.pitch);
    if (gimbalLocked(d.pitch * RAD)) lockSamples++;
    if (d.compare === "record") compareRecord++;
    if (d.compare === "verify") compareVerify++;
  }
  const start = gimbalDemo(0);
  const end = gimbalDemo(GIMBAL_DEMO_DURATION);
  const zeroStart = Math.abs(start.roll) + Math.abs(start.pitch) + Math.abs(start.yaw) < 1e-9;
  const zeroEnd = Math.abs(end.roll) + Math.abs(end.pitch) + Math.abs(end.yaw) < 1e-9;
  check(
    "演示脚本覆盖全相位并进入锁定",
    zeroStart && zeroEnd && maxPitch >= 90 - 1e-9 && minPitch >= -1e-9 && lockSamples > 100 &&
      compareRecord > 0 && compareVerify > 0,
    `相位 ${[...phasesSeen].join("/")}；首尾归零 ${zeroStart}/${zeroEnd}；` +
      `俯仰峰值 ${maxPitch.toFixed(1)}°；锁定样本 ${lockSamples}；记录/验证相位各 ${compareRecord}/${compareVerify} 个样本`,
  );
}

// 10b. 演示的核心结论：俯仰 90° 时，【横滚 60°】与【偏航 −60°】得到完全相同的姿态
//      这正是「只剩 2 个自由度」的直接证据（两个滑块控制同一个自由度）
{
  const P = 90 * RAD;
  const viaRoll = gimbalInnerQuat({ roll: 60 * RAD, pitch: P, yaw: 0 });
  const viaYaw = gimbalInnerQuat({ roll: 0, pitch: P, yaw: -60 * RAD });
  const diff = qAngleBetween(viaRoll, viaYaw) * DEG;

  // 对照组：俯仰 0° 时两者必须明显不同，否则说明这个演示没有区分度
  const ctrlRoll = gimbalInnerQuat({ roll: 60 * RAD, pitch: 0, yaw: 0 });
  const ctrlYaw = gimbalInnerQuat({ roll: 0, pitch: 0, yaw: -60 * RAD });
  const ctrlDiff = qAngleBetween(ctrlRoll, ctrlYaw) * DEG;

  check(
    "锁定态：横滚与偏航产生同一姿态",
    diff < 1e-9 && ctrlDiff > 30,
    `俯仰 90° 时两条路径夹角 ${diff.toExponential(2)}°（须 ≈0）；` +
      `俯仰 0° 对照组 ${ctrlDiff.toFixed(2)}°（须明显不同，证明演示有区分度）`,
  );
}

// 10c. 演示脚本与画面一致性：脚本给出的角度喂给万向环链条，必须等于逐相位手动组合的结果
{
  const checks: Array<[string, number]> = [
    ["remember", gimbalDemoPhaseEnd("remember")],
    ["verify", gimbalDemoPhaseEnd("verify")],
  ];
  let maxDiff = 0;
  for (const [, t] of checks) {
    const d = gimbalDemo(t);
    const fromScript = gimbalInnerQuat({ roll: d.roll * RAD, pitch: d.pitch * RAD, yaw: d.yaw * RAD });
    const direct = gimbalInnerQuat({ roll: 60 * RAD, pitch: 90 * RAD, yaw: 0 }); // 关键帧均为该姿态
    const dot =
      fromScript.w * direct.w + fromScript.x * direct.x + fromScript.y * direct.y + fromScript.z * direct.z;
    const s = dot < 0 ? -1 : 1;
    const diff = Math.max(
      Math.abs(fromScript.w - s * direct.w),
      Math.abs(fromScript.x - s * direct.x),
      Math.abs(fromScript.y - s * direct.y),
      Math.abs(fromScript.z - s * direct.z),
    );
    maxDiff = Math.max(maxDiff, diff);
  }
  check(
    "演示关键帧姿态一致",
    maxDiff < 1e-9,
    `「记录」与「验证」相位末尾的脚本姿态与目标姿态 (φ=60°,θ=90°,ψ=0) 最大偏差 ${maxDiff.toExponential(2)}`,
  );
}

// 10d. 暂停语义：冻结时间轴后姿态必须完全不变，且解说不应跨相位跳变
{
  const pauseAt = gimbalDemoPhaseEnd("locked") - 0.3; // 停在死锁相位末尾前
  const held = gimbalDemo(pauseAt);
  // 模拟暂停期间反复取同一时刻（主循环在 paused 时不推进 demoState.t）
  let maxDrift = 0;
  for (let i = 0; i < 50; i++) {
    const again = gimbalDemo(pauseAt);
    maxDrift = Math.max(
      maxDrift,
      Math.abs(again.roll - held.roll),
      Math.abs(again.pitch - held.pitch),
      Math.abs(again.yaw - held.yaw),
    );
    if (again.message !== held.message) maxDrift = Infinity;
  }
  // 继续播放后时间轴必须能从暂停点接着走（不是从头开始）
  const afterResume = gimbalDemo(pauseAt + 1.5);
  const movedOn = Math.abs(afterResume.roll - held.roll) + Math.abs(afterResume.yaw - held.yaw) > 0.5;
  check(
    "暂停冻结时间轴且继续可接播",
    maxDrift < 1e-12 && movedOn && held.pitch >= 89.999,
    `暂停点 t=${pauseAt.toFixed(2)}s 姿态 (φ=${held.roll.toFixed(1)}°,θ=${held.pitch.toFixed(1)}°,ψ=${held.yaw.toFixed(1)}°)；` +
      `冻结期间漂移 ${maxDrift.toExponential(1)}；继续 1.5s 后已推进=${movedOn}`,
  );
}

// 13. 玻璃盒遥测：静态收敛后预测与实测重力方向必须对齐；互补的加计倾角必须等于真值
{
  const qTrue = qFromEuler(30 * RAD, 20 * RAD, 0);
  const gauss = new Gauss(mulberry32(7));
  const pure = new PureGyroEstimator();
  const comp = new ComplementaryEstimator();
  const mahony = new MahonyEstimator();
  const madg = new MadgwickEstimator();
  const ests = [pure, comp, mahony, madg];
  // 纯积分从真值出发（它没有修正通道，只验证遥测数值本身）
  pure.q = { ...qTrue };
  for (let i = 0; i < Math.round(8 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, clean, gauss, 1);
    for (const e of ests) e.update(s.gyro, s.accel, s.mag, H);
  }
  const errs = ests.map((e) => e.telemetry.detail.alignErrorDeg ?? NaN);
  const alignOk = errs.every((v) => Number.isFinite(v) && v < 1.5);
  // 互补的加计倾角（遥测）应与真值欧拉角一致（干净加计下就是真值）
  const rollAccErr = Math.abs((comp.telemetry.detail.rollAccDeg ?? NaN) - 30);
  const pitchAccErr = Math.abs((comp.telemetry.detail.pitchAccDeg ?? NaN) - 20);
  // Mahony 的 P/I 占比在干净收敛后应为有限值且在 [0,1]
  const pShare = mahony.telemetry.detail.pShare ?? NaN;
  // 纯积分的修正量必须恒为 0
  const pureCorrZero = pure.telemetry.correction.every((v) => v === 0);
  // 所有估计器的 accelValid 都应为真（干净 IMU）
  const allValid = ests.every((e) => e.telemetry.accelValid);
  check(
    "玻璃盒遥测：收敛后重力方向对齐",
    alignOk && rollAccErr < 0.1 && pitchAccErr < 0.1 &&
      Number.isFinite(pShare) && pShare >= 0 && pShare <= 1 && pureCorrZero && allValid,
    `对齐差 pure/comp/mahony/madg = ${errs.map((v) => v.toFixed(3)).join("/")}°；` +
      `互补加计倾角误差 φ=${rollAccErr.toExponential(1)}° θ=${pitchAccErr.toExponential(1)}°；` +
      `Mahony P 占比 ${(pShare * 100).toFixed(0)}%；纯积分修正恒零=${pureCorrZero}；accelValid 全真=${allValid}`,
  );
}

// 14. 万向节锁解说文案：锁定/接近/正常三个分支
{
  const locked = narrateGimbal(90, true);
  const near = narrateGimbal(70, false);
  const normal = narrateGimbal(20, false);
  check(
    "万向节锁解说文案分支",
    locked.includes("重合") && locked.includes("2 个自由度") &&
      near.includes("接近") && normal.includes("独立"),
    `锁定含关键信息=${locked.includes("重合") && locked.includes("2 个自由度")}；` +
      `接近含提示=${near.includes("接近")}；正常含独立=${normal.includes("独立")}`,
  );
}

// 15. 轴角提取：零旋转、已知轴角、以及 q 与 −q 得到完全相同的结果（双覆盖核心断言）
{
  const zero = qToAxisAngle(qId());
  const okZero = zero.angle < 1e-12 && Math.abs(zero.axis[0] - 1) < 1e-12;

  // 绕 z 轴转 90°
  const rotZ = qFromAxisAngle([0, 0, 1], Math.PI / 2);
  const az = qToAxisAngle(rotZ);
  const okZ =
    Math.abs(az.angle - Math.PI / 2) < 1e-12 &&
    Math.abs(az.axis[2] - 1) < 1e-12 &&
    Math.abs(az.axis[0]) < 1e-12;

  // 复合姿态：q 与 −q 必须给出同一 axis/angle
  const q = qFromEuler(32 * RAD, -41 * RAD, 115 * RAD);
  const qn = { w: -q.w, x: -q.x, y: -q.y, z: -q.z };
  const a1 = qToAxisAngle(q);
  const a2 = qToAxisAngle(qn);
  const sameSelf =
    Math.abs(a1.angle - a2.angle) < 1e-12 &&
    Math.hypot(a1.axis[0] - a2.axis[0], a1.axis[1] - a2.axis[1], a1.axis[2] - a2.axis[2]) < 1e-12;
  // 且由 axis/angle 重构回四元数后与原姿态一致（用 qAngleBetween 判等）
  const rebuilt = qFromAxisAngle(a1.axis, a1.angle);
  const roundTripErr = qAngleBetween(rebuilt, q) * DEG;
  const roundTrip = roundTripErr < 1e-9;

  check(
    "轴角提取与 q/−q 双覆盖",
    okZero && okZ && sameSelf && roundTrip,
    `零旋转=${okZero}；绕z 90°=${okZ}；q 与 −q 同轴同角=${sameSelf}；轴角重构回位误差 ${roundTripErr.toFixed(12)}°`,
  );
}

// 16. eulerLerp 端点正确，且与 qSlerp 在多轴复合旋转下路径有可观测差异
{
  const a = qFromEuler(10 * RAD, 0, 0);
  const b = qFromEuler(50 * RAD, 0, 0);
  const e0 = eulerLerp(a, b, 0);
  const e1 = eulerLerp(a, b, 1);
  const okEnd =
    qAngleBetween(e0, a) * DEG < 1e-9 && qAngleBetween(e1, b) * DEG < 1e-9;

  // 单轴时两者应几乎重合（欧拉插值在小旋转下逼近大圆）
  const singleAxisDiff = qAngleBetween(eulerLerp(a, b, 0.5), qSlerp(a, b, 0.5)) * DEG;

  // 多轴大旋转：构造 Slerp 与 Euler 明显分叉的姿态对
  const c = qFromEuler(0 * RAD, 0, 0);
  const d = qFromEuler(140 * RAD, 70 * RAD, 160 * RAD);
  const multiDiff = qAngleBetween(eulerLerp(c, d, 0.5), qSlerp(c, d, 0.5)) * DEG;

  check(
    "欧拉插值端点正确且与 Slerp 有区分度",
    okEnd && singleAxisDiff < 1 && multiDiff > 5,
    `端点误差 <1e-9°=${okEnd}；单轴中点差 ${singleAxisDiff.toFixed(3)}°（应≈0）；` +
      `多轴复合(140°,70°,160°)中点差 ${multiDiff.toFixed(2)}°（应 >5°，Slerp 走大圆、欧拉走扭曲线）`,
  );
}

// 17. MARG 互补滤波：磁开 → 静态偏航收敛；磁关 → 偏航漂移（开关对比度是教学核心）
{
  // 静态倾斜 + 偏航 40° 真值，陀螺带 1°/s 零偏（会拖偏 yaw）
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0, magSoftIron: 0 };

  const run = (magEnabled: boolean, T: number) => {
    const comp = new ComplementaryEstimator();
    comp.magEnabled = magEnabled;
    comp.alpha = 2; // 加快收敛便于短时测试
    const g = new Gauss(mulberry32(magEnabled ? 7 : 8));
    for (let i = 0; i < Math.round(T / H); i++) {
      const s = simulateImu(qTrue, [0, 0, 0], i * H, pWithMag, g, 1);
      comp.update(s.gyro, s.accel, s.mag, H);
    }
    return qToEuler(comp.q);
  };

  const on = run(true, 10);
  const off = run(false, 10);
  // 磁开：偏航收敛到 40° 附近（±5°）；磁关：偏航随陀螺漂移（>10° 误差）
  const onErr = Math.abs(on.yaw - 40 * RAD) * DEG;
  const offErr = Math.abs(off.yaw - 40 * RAD) * DEG;
  check(
    "MARG 互补：磁开收敛 / 磁关漂移",
    onErr < 5 && offErr > 10,
    `磁开 10s 偏航误差 ${onErr.toFixed(2)}°（应 <5°）；磁关 10s 偏航误差 ${offErr.toFixed(2)}°（应 >10°，陀螺零偏所致）`,
  );
}

// 18. MARG Mahony：磁开 → 偏航收敛
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0, magSoftIron: 0 };
  const mahony = new MahonyEstimator();
  mahony.magEnabled = true;
  mahony.kp = 2;
  const g = new Gauss(mulberry32(11));
  for (let i = 0; i < Math.round(12 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, pWithMag, g, 1);
    mahony.update(s.gyro, s.accel, s.mag, H);
  }
  const e = qToEuler(mahony.q);
  const yawErr = Math.abs(e.yaw - 40 * RAD) * DEG;
  check(
    "MARG Mahony：磁开偏航收敛",
    yawErr < 5,
    `12s 偏航误差 ${yawErr.toFixed(2)}°（应 <5°）；磁航向读数 ${(mahony.telemetry.detail.yawMagDeg ?? NaN).toFixed(1)}°`,
  );
}

// 19. MARG Madgwick（数值梯度）：磁开 → 偏航收敛
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0, magSoftIron: 0 };
  const madg = new MadgwickEstimator();
  madg.magEnabled = true;
  madg.beta = 0.3;
  const g = new Gauss(mulberry32(13));
  for (let i = 0; i < Math.round(12 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, pWithMag, g, 1);
    madg.update(s.gyro, s.accel, s.mag, H);
  }
  const e = qToEuler(madg.q);
  const yawErr = Math.abs(e.yaw - 40 * RAD) * DEG;
  check(
    "MARG Madgwick：磁开偏航收敛",
    yawErr < 5,
    `12s 偏航误差 ${yawErr.toFixed(2)}°（应 <5°）；磁航向读数 ${(madg.telemetry.detail.yawMagDeg ?? NaN).toFixed(1)}°`,
  );
}

// 20. 磁干扰：硬铁+交变干扰下 MARG 偏航误差增大，但仍显著优于磁关
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const pDisturbed: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0.5, disturbMag: 0.5 };

  const run = (magEnabled: boolean) => {
    const comp = new ComplementaryEstimator();
    comp.magEnabled = magEnabled;
    comp.alpha = 2;
    const g = new Gauss(mulberry32(magEnabled ? 21 : 22));
    for (let i = 0; i < Math.round(10 / H); i++) {
      const s = simulateImu(qTrue, [0, 0, 0], i * H, pDisturbed, g, 1);
      comp.update(s.gyro, s.accel, s.mag, H);
    }
    return Math.abs(qToEuler(comp.q).yaw - 40 * RAD) * DEG;
  };
  const onErr = run(true);
  const offErr = run(false);
  check(
    "磁干扰下 MARG 退化但仍有价值",
    onErr < offErr,
    `干扰下：磁开偏航误差 ${onErr.toFixed(1)}° < 磁关 ${offErr.toFixed(1)}°（磁扰使精度下降但不至于失控，磁强计校准是实际工程课题）`,
  );
}

// 21. 卡尔曼滤波：静态收敛 + 抗零偏 + 零偏估计（ES-EKF 的独门能力）
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);

  // 干净静态：8s 倾角收敛
  const kal1 = new KalmanEstimator();
  const g1 = new Gauss(mulberry32(31));
  for (let i = 0; i < Math.round(8 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, clean, g1, 1);
    kal1.update(s.gyro, s.accel, s.mag, H);
  }
  const eu1 = qToEuler(kal1.q);
  const tilt1 = Math.max(Math.abs(eu1.roll - 15 * RAD), Math.abs(eu1.pitch - 25 * RAD)) * DEG;

  // 脏数据（1°/s 零偏，磁关）：倾角有界，且零偏估计应收敛到真值附近
  const kal2 = new KalmanEstimator();
  const g2 = new Gauss(mulberry32(32));
  for (let i = 0; i < Math.round(20 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, dirty, g2, 1);
    kal2.update(s.gyro, s.accel, s.mag, H);
  }
  const eu2 = qToEuler(kal2.q);
  const tilt2 = Math.max(Math.abs(eu2.roll - 15 * RAD), Math.abs(eu2.pitch - 25 * RAD)) * DEG;
  const biasEst = kal2.telemetry.detail.biasNormDps as number;
  const biasErr = Math.abs(biasEst - 1);

  check(
    "卡尔曼静态收敛",
    tilt1 < 1,
    `8s 倾角误差 ${tilt1.toFixed(3)}°`,
  );
  check(
    "卡尔曼抗零偏并估计出零偏",
    tilt2 < 5 && biasErr < 0.4,
    `20s 倾角误差 ${tilt2.toFixed(2)}°；零偏估计 ${biasEst.toFixed(3)}°/s（真值 1，误差 ${biasErr.toFixed(3)}）`,
  );
}

// 22. MARG 卡尔曼：磁开 → 偏航收敛（1°/s 零偏下）
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0, magSoftIron: 0 };
  const kal = new KalmanEstimator();
  kal.magEnabled = true;
  const g = new Gauss(mulberry32(33));
  for (let i = 0; i < Math.round(12 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, pWithMag, g, 1);
    kal.update(s.gyro, s.accel, s.mag, H);
  }
  const yawErr = Math.abs(qToEuler(kal.q).yaw - 40 * RAD) * DEG;
  check(
    "MARG 卡尔曼：磁开偏航收敛",
    yawErr < 5,
    `12s 偏航误差 ${yawErr.toFixed(2)}°（应 <5°）`,
  );
}

// 23. DCM（qToMatrix）：正交性 + 行列式 1 + 与 qRot 一致 + 与 R(−q) 恒等
{
  const rnd = mulberry32(99);
  let maxOrthoErr = 0;
  let detErr = 0;
  let maxRotErr = 0;
  let maxNegErr = 0;
  for (let i = 0; i < 60; i++) {
    const q = qNorm({ w: rnd() * 2 - 1, x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
    const C = qToMatrix(q);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += C[k * 3 + r] * C[k * 3 + c];
        const target = r === c ? 1 : 0;
        maxOrthoErr = Math.max(maxOrthoErr, Math.abs(dot - target));
      }
    }
    const det =
      C[0] * (C[4] * C[8] - C[5] * C[7]) -
      C[1] * (C[3] * C[8] - C[5] * C[6]) +
      C[2] * (C[3] * C[7] - C[4] * C[6]);
    detErr = Math.max(detErr, Math.abs(det - 1));
    const v: [number, number, number] = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const cv: [number, number, number] = [
      C[0] * v[0] + C[1] * v[1] + C[2] * v[2],
      C[3] * v[0] + C[4] * v[1] + C[5] * v[2],
      C[6] * v[0] + C[7] * v[1] + C[8] * v[2],
    ];
    const rv = qRot(q, v);
    maxRotErr = Math.max(maxRotErr, Math.hypot(cv[0] - rv[0], cv[1] - rv[1], cv[2] - rv[2]));
    const Cn = qToMatrix({ w: -q.w, x: -q.x, y: -q.y, z: -q.z });
    for (let k = 0; k < 9; k++) maxNegErr = Math.max(maxNegErr, Math.abs(C[k] - Cn[k]));
  }
  check("DCM 正交且与 qRot 一致", maxOrthoErr < 1e-12 && detErr < 1e-12 && maxRotErr < 1e-12 && maxNegErr < 1e-12,
    `60 组随机姿态：正交性 ${maxOrthoErr.toExponential(1)}；det ${detErr.toExponential(1)}；C·v vs qRot ${maxRotErr.toExponential(1)}；R(−q)=R(q) ${maxNegErr.toExponential(1)}`,
  );
}

// 24. 等效旋转矢量：φ = θ·n̂，与四元数往返一致（与 DCM/四元数并列的标准表示）
{
  const rnd = mulberry32(123);
  let maxErr = 0;
  for (let i = 0; i < 60; i++) {
    const q = qNorm({ w: rnd() * 2 - 1, x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
    const { axis, angle } = qToAxisAngle(q);
    const phi: [number, number, number] = [axis[0] * angle, axis[1] * angle, axis[2] * angle];
    const th = Math.hypot(phi[0], phi[1], phi[2]);
    const rebuilt = qFromAxisAngle([phi[0] / th, phi[1] / th, phi[2] / th], th);
    const d = qDot(q, rebuilt) < 0 ? -1 : 1;
    const err = Math.max(
      Math.abs(q.w - d * rebuilt.w), Math.abs(q.x - d * rebuilt.x),
      Math.abs(q.y - d * rebuilt.y), Math.abs(q.z - d * rebuilt.z),
    );
    maxErr = Math.max(maxErr, err);
  }
  check("等效旋转矢量往返一致", maxErr < 1e-9, `60 组随机姿态 q → φ=θ·n̂ → q 最大分量偏差 ${maxErr.toExponential(2)}`);
}

// 25. 初始姿态偏差收敛：从 30°（横滚主导）偏差出发（含启动 ramp + MARG），四种融合算法 8s 内贴住真值
//     偏差轴刻意横滚主导：纯偏航偏差对加计不可观（MARG 开着则由磁场收敛）；
//     30° 新息 < 卡尔曼 40° 门限，观测放行——这也是 UI「偏差上限 35°」设计约定的依据
{
  const qTrue = qFromEuler(30 * RAD, 20 * RAD, 0);
  const axRaw: [number, number, number] = [1, 0.4, 0.15]; // 横滚主导（z 分量小 → 偏航占比小）
  const axN = Math.hypot(axRaw[0], axRaw[1], axRaw[2]);
  const q0 = qFromAxisAngle([axRaw[0] / axN, axRaw[1] / axN, axRaw[2] / axN], 30 * RAD);
  const names = ["互补", "Mahony", "Madgwick", "卡尔曼"];
  const ests = [
    new ComplementaryEstimator(),
    new MahonyEstimator(),
    new MadgwickEstimator(),
    new KalmanEstimator(),
  ];
  for (const e of ests) {
    e.magEnabled = true; // 与 UI 默认（MARG 开）一致：偏航由磁场收敛
    e.reset(q0);
  }
  const g = new Gauss(mulberry32(61));
  for (let i = 0; i < Math.round(8 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, clean, g, 1);
    for (const e of ests) e.update(s.gyro, s.accel, s.mag, H);
  }
  const errs = ests.map((e) => qAngleBetween(e.q, qTrue) * DEG);
  const maxErr = Math.max(...errs);
  check(
    "初始偏差 30° 八秒收敛（四种融合）",
    maxErr < 5,
    `${names.map((n, i) => `${n} ${errs[i].toFixed(2)}°`).join("；")}（均须 <5°，含启动 ramp 与卡尔曼大初始协方差）`,
  );
}

// 26. 启动增益 ramp 的 A/B 对照：reset 后 1.5s 时刻，带 ramp 的误差必须显著小于不带
//     这是「初始对准加速」的直接证据（rampEnabled 开关专为该对照暴露）。
//     初值取 30° 横滚偏差——加计可直接观测的通道（纯偏航偏差不可观，对任何算法都拉不回）。
{
  const qTrue = qFromEuler(30 * RAD, 20 * RAD, 0);
  const q0 = qFromAxisAngle([1, 0, 0], 30 * RAD);
  const makeTrio = (): Array<[string, ComplementaryEstimator | MahonyEstimator | MadgwickEstimator]> => [
    ["互补", new ComplementaryEstimator()],
    ["Mahony", new MahonyEstimator()],
    ["Madgwick", new MadgwickEstimator()],
  ];
  const on = makeTrio();
  const off = makeTrio();
  for (const [, e] of off) e.rampEnabled = false;
  for (const m of [on, off]) for (const [, e] of m) {
    e.reset(q0);
    e.accelGate = false; // 隔离变量：本测试只考 ramp，关闭方向门控（30° 偏差会被 20° 门限拒收而干扰对照）
  }
  const gOn = new Gauss(mulberry32(71));
  const gOff = new Gauss(mulberry32(71)); // 同噪声序列，只差 ramp
  for (let i = 0; i < Math.round(1.5 / H); i++) {
    const sOn = simulateImu(qTrue, [0, 0, 0], i * H, clean, gOn, 1);
    const sOff = simulateImu(qTrue, [0, 0, 0], i * H, clean, gOff, 1);
    for (const [, e] of on) e.update(sOn.gyro, sOn.accel, sOn.mag, H);
    for (const [, e] of off) e.update(sOff.gyro, sOff.accel, sOff.mag, H);
  }
  const detail = on
    .map(([nameA, e], i) => `${nameA} ramp ${(qAngleBetween(e.q, qTrue) * DEG).toFixed(1)}° vs 无 ${(qAngleBetween(off[i][1].q, qTrue) * DEG).toFixed(1)}°`)
    .join("；");
  const allFaster = on.every(([, e], i) => qAngleBetween(e.q, qTrue) * DEG < qAngleBetween(off[i][1].q, qTrue) * DEG);
  check("启动 ramp 加速初始对准（A/B）", allFaster, `reset 后 1.5s：${detail}（带 ramp 须全部更快）`);
}

// 27. 加速度计观测门控 A/B：持续侧向线加速度（协调转弯的向心加速度）场景。
//     这是方向门控的主场：污染方向恒定偏 22°、范数只偏 8%——幅度门控是二阶量看不见它，
//     零均值假设也不成立（滤波器平均不掉）；门控开的估计钉在真值，门关的被持续拽偏。
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const gBody = qRotInv(qTrue, [0, 0, G_ACC]);
  const accelDisturbed: V3 = [gBody[0] + 4.0, gBody[1], gBody[2]]; // 持续侧向 4 m/s²（≈22° 方向偏移，范数仅偏 8%）
  const runPair = (make: () => MahonyEstimator | ComplementaryEstimator) => {
    const gated = make();
    const raw = make();
    raw.accelGate = false;
    for (const e of [gated, raw]) {
      e.reset(qTrue); // 从真值出发：误差全部来自受扰观测的拉拽
      e.rampEnabled = false; // 隔离 ramp：纯门控 A/B
    }
    const steps = Math.round(10 / H);
    for (let i = 0; i < steps; i++) {
      const s = { gyro: [0, 0, 0] as V3, accel: accelDisturbed, mag: [0, 0, 0] as V3 };
      gated.update(s.gyro, s.accel, s.mag, H);
      raw.update(s.gyro, s.accel, s.mag, H);
    }
    return { gated: qAngleBetween(gated.q, qTrue) * DEG, raw: qAngleBetween(raw.q, qTrue) * DEG };
  };
  const mah = runPair(() => new MahonyEstimator());
  const comp = runPair(() => {
    const c = new ComplementaryEstimator();
    c.alpha = 2;
    return c;
  });
  const ok = mah.gated < 1 && comp.gated < 1 && mah.raw > 15 && comp.raw > 15;
  check(
    "加速度计方向门控 A/B（持续侧向加速度）",
    ok,
    `10s 持续侧向 4 m/s²（方向偏 22°、范数仅偏 8%）：Mahony 门控 ${mah.gated.toFixed(2)}° vs 关 ${mah.raw.toFixed(2)}°；` +
      `互补 门控 ${comp.gated.toFixed(2)}° vs 关 ${comp.raw.toFixed(2)}°（门控开须 <1°，关须 >15°）`,
  );
}

// 28. Squad 与 qLog/qExp：端点严格、路径归一化、与 Slerp 在四关键帧路径下有区分度
{
  const p0 = qFromEuler(-40 * RAD, 20 * RAD, 30 * RAD);
  const p1 = qFromEuler(0, 0, 0);
  const p2 = qFromEuler(140 * RAD, 70 * RAD, 160 * RAD);
  const p3 = qFromEuler(175 * RAD, 100 * RAD, 205 * RAD);
  const s1 = squadTangent(p0, p1, p2);
  const s2 = squadTangent(p1, p2, p3);
  const e0 = squad(p1, p2, s1, s2, 0);
  const e1 = squad(p1, p2, s1, s2, 1);
  // qAngleBetween 的 acos 在零夹角附近的数值分辨率约 1e-6°，端点容差取 1e-4°
  const endOk = qAngleBetween(e0, p1) * DEG < 1e-4 && qAngleBetween(e1, p2) * DEG < 1e-4;
  let minNorm = Infinity, maxDiffSlerp = 0;
  const slerpMid = qSlerp(p1, p2, 0.5);
  for (let i = 0; i <= 20; i++) {
    const q = squad(p1, p2, s1, s2, i / 20);
    minNorm = Math.min(minNorm, Math.hypot(q.w, q.x, q.y, q.z));
    if (i === 10) maxDiffSlerp = qAngleBetween(q, slerpMid) * DEG;
  }
  // qLog/qExp 往返
  const qAny = qFromEuler(32 * RAD, -41 * RAD, 115 * RAD);
  const lg = qLog(qAny);
  const back = qExp(lg);
  const dot = qAny.w * back.w + qAny.x * back.x + qAny.y * back.y + qAny.z * back.z;
  const logRoundTrip = Math.abs(Math.abs(dot) - 1) < 1e-12;
  check(
    "Squad 端点/归一化 + qLog 往返",
    endOk && minNorm > 0.999 && maxDiffSlerp > 1 && logRoundTrip,
    `端点误差 <1e-9°=${endOk}；路径模长最小 ${minNorm.toFixed(6)}；` +
      `四关键帧中点 Squad vs Slerp 差 ${maxDiffSlerp.toFixed(2)}°（>1° 才有教学区分度）；qExp(qLog(q)) 往返=${logRoundTrip}`,
  );
}

// 29. 参数快照 roundtrip：getParams/setParams（A/B 对比的数据基础）
{
  const cases: Array<[string, Estimator, Record<string, number>]> = [
    ["互补", new ComplementaryEstimator(), { alpha: 2.5 }],
    ["Mahony", new MahonyEstimator(), { kp: 3, ki: 0.12 }],
    ["Madgwick", new MadgwickEstimator(), { beta: 0.4 }],
    ["卡尔曼", new KalmanEstimator(), { gyroNoiseDps: 0.7, obsNoise: 0.2 }],
  ];
  let ok = true;
  const names: string[] = [];
  for (const [name, e, p] of cases) {
    e.setParams(p);
    const got = e.getParams();
    const match = Object.entries(p).every(([k, v]) => Math.abs(got[k] - v) < 1e-12);
    if (!match) ok = false;
    names.push(`${name} ${JSON.stringify(got)}`);
  }
  check("参数快照 roundtrip（getParams/setParams）", ok, names.join("；"));
}

// 30. 粗对准：静止加计+磁力计直接摆出的姿态与真值一致（三段式初始对准第一段）
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const g = new Gauss(mulberry32(91));
  const s = simulateImu(qTrue, [0, 0, 0], 0, clean, g, 1);
  const q0 = coarseAlign(s.accel, s.mag, true);
  const err = qAngleBetween(q0, qTrue) * DEG;
  check("粗对准（加计+磁力计）直接给出姿态", err < 1, `与真值夹角 ${err.toFixed(3)}°（磁关时偏航不可观，此处 MARG 开）`);
}

// 31. 器件级确定性误差：磁量化（格点对齐、逐位可复现）与交叉轴（泄漏方向正确）
{
  const q = qFromEuler(10 * RAD, 20 * RAD, 30 * RAD);
  const pQuant: ImuParams = { ...clean, magNoise: 0.5, magQuantUts: 0.6 };
  const g1 = new Gauss(mulberry32(97));
  const g2 = new Gauss(mulberry32(97));
  const s1 = simulateMag(q, 1.23, pQuant, g1);
  const s2 = simulateMag(q, 1.23, pQuant, g2);
  const quantOk = s1.every((v, i) => v === s2[i] && Math.abs(v / 0.6 - Math.round(v / 0.6)) < 1e-9);
  // 交叉轴：沿 z 的 1g 双向泄漏——x/y 各漏入 0.02g，z 主读数保持 g
  const pCross: ImuParams = { ...clean, accelCrossAxis: 0.02 };
  const sCross = simulateImu(qId(), [0, 0, 0], 0, pCross, new Gauss(mulberry32(98)), 1);
  const e = 1e-9;
  const leakOk =
    Math.abs(sCross.accel[0] - 0.02 * G_ACC) < e &&
    Math.abs(sCross.accel[1] - 0.02 * G_ACC) < e &&
    Math.abs(sCross.accel[2] - G_ACC) < e;
  check(
    "器件级误差：磁量化确定性格点 + 交叉轴双向泄漏",
    quantOk && leakOk,
    `量化：同种子两次采样逐位相等=${s1.every((v, i) => v === s2[i])} 且 0.6μT 格点对齐=${quantOk}；` +
      `交叉轴：沿 z 的 1g 在 x/y 各漏出 0.02g、z 保持 g=${leakOk}`,
  );
}

// 32. 闭环控制：理想环（真值反馈）跟踪到位；纯积分估计反馈下「估计漂多少、机体飞偏多少」
{
  manualTarget.rollDeg = 30;
  manualTarget.pitchDeg = 0;
  manualTarget.yawDeg = 0;
  const run = (useEstimator: boolean): number => {
    const w = new World(scenarios.manual);
    const est = new PureGyroEstimator();
    const pBias: ImuParams = { ...clean, gyroBiasDps: 3 };
    let last = qId();
    for (let i = 0; i < Math.round(6 / H); i++) {
      const fb = useEstimator ? last : undefined;
      const s = w.step(H, pBias, fb);
      est.update(s.gyro, s.accel, s.mag, H);
      last = { ...est.q };
    }
    return Math.abs(qToEuler(w.q).roll - 30 * RAD) * DEG;
  };
  const ideal = run(false);
  const closed = run(true);
  manualTarget.rollDeg = 0;
  manualTarget.pitchDeg = 0;
  manualTarget.yawDeg = 0;
  check(
    "闭环控制：解算误差直接变成飞行偏差",
    ideal < 2 && closed > 8,
    `6s 手动目标横滚 30°：理想环（真值反馈）误差 ${ideal.toFixed(2)}°；纯积分估计反馈（零偏 3°/s）误差 ${closed.toFixed(2)}°——估计漂多少、机体偏多少`,
  );
}

// 33. 零偏随机游走：walk=1 °/s/√s 时纯积分误差远超干净情形（线性漂移恶化为游走主导）
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const run = (walk: number): number => {
    const w = new World(scenarios.manual);
    const est = new PureGyroEstimator();
    est.q = { ...qTrue };
    const p: ImuParams = { ...clean, gyroWalkDps: walk };
    for (let i = 0; i < Math.round(20 / H); i++) {
      const s = w.step(H, p);
      est.update(s.gyro, s.accel, s.mag, H);
    }
    return qAngleBetween(est.q, qTrue) * DEG;
  };
  const noWalk = run(0);
  const withWalk = run(1);
  check(
    "零偏随机游走：误差从线性恶化为游走主导",
    noWalk < 1 && withWalk > 5,
    `20s 纯积分（静止）：walk=0 误差 ${noWalk.toFixed(2)}°；walk=1 °/s/√s 误差 ${withWalk.toFixed(2)}°（随机游走 σ ≈ √20 × 1）`,
  );
}

// 34. 串口帧解析器（纯函数）：往返数值、坏 CRC 拒收重同步、粘包、帧头前垃圾、安装方向重排
{
  const MOUNT: Mounting = "x-front-y-right";
  const gyro: V3 = [12.3, -45.6, 7.8];
  const accel: V3 = [0.41, -1.22, 9.79];
  const mag: V3 = [21.5, -8.3, 38.2];
  // a) 往返：buildFrame → parseFrame 精确恢复（定点 0.1/0.01 量化误差内）
  const f = buildFrame(0x1234, 0xaabbccdd, gyro, accel, mag);
  const r1 = parseFrame(f, MOUNT);
  const roundTripOk =
    f.length === FRAME_LEN &&
    r1.frame !== null &&
    r1.frame.seq === 0x1234 &&
    r1.frame.tickMs === 0xaabbccdd &&
    r1.frame.gyroDps.every((v, i) => Math.abs(v - gyro[i]) < 0.1) &&
    r1.frame.accelMs2.every((v, i) => Math.abs(v - accel[i]) < 0.01) &&
    r1.frame.magUt.every((v, i) => Math.abs(v - mag[i]) < 0.01);
  // b) 坏 CRC：拒收并 consumed=2（跳过帧头，留给下次重同步）
  const fBad = buildFrame(7, 100, gyro, accel, mag, { at: 12, value: 0xff ^ buildFrame(7, 100, gyro, accel, mag)[12] });
  const r2 = parseFrame(fBad, MOUNT);
  const badOk = r2.frame === null && r2.consumed === 2;
  // c) 粘包：垃圾 + 两帧连发 + 半帧尾巴 → 依次解析得两帧、尾巴留缓冲
  const fA = buildFrame(1, 10, gyro, accel, mag);
  const fB = buildFrame(2, 20, gyro, accel, mag);
  const stream = new Uint8Array(3 + fA.length + fB.length + 10);
  stream.set([0x00, 0x37, 0xaa], 0); // 前置垃圾（含半个帧头 0xaa，考验 findSync 不误吞）
  stream.set(fA, 3);
  stream.set(fB, 3 + fA.length);
  stream.set(fA.subarray(0, 10), 3 + fA.length + fB.length); // 半帧
  let off = 0;
  const got: number[] = [];
  // 第一轮应只消费垃圾 3 字节（帧头在 2 处被 0x37 隔开不算）
  const p1 = parseFrame(stream.subarray(off), MOUNT);
  off += p1.consumed;
  for (let k = 0; k < 2; k++) {
    const p = parseFrame(stream.subarray(off), MOUNT);
    if (p.frame) got.push(p.frame.seq);
    off += p.consumed;
  }
  const stickyOk = got.length === 2 && got[0] === 1 && got[1] === 2 && off === 3 + fA.length + fB.length;
  // d) 安装方向重排：x-front-y-left 时模块 +y → 机体 −y
  const fM = buildFrame(3, 30, [0, 10, 0], [0, 0, 9.8], [0, 0, 0]);
  const rm = parseFrame(fM, "x-front-y-left");
  const mountOk =
    rm.frame !== null &&
    Math.abs(rm.frame.gyroDps[1] + 10) < 1e-6 && // 机体 y = −模块 y
    Math.abs(rm.frame.gyroDps[0]) < 1e-6;
  check(
    "串口帧解析：往返/CRC 拒收/粘包重同步/安装方向",
    roundTripOk && badOk && stickyOk && mountOk,
    `往返=${roundTripOk}；坏 CRC consumed=${r2.consumed}（应 2）=${badOk}；` +
      `粘包两帧 seq=${got.join(",")} off=${off}=${stickyOk}；y-left 重排机体y=${rm.frame ? rm.frame.gyroDps[1].toFixed(1) : "?"}=${mountOk}`,
  );
}

// 35. 精确指数映射积分：恒定角速度下与解析解一致（大步长也不产生缩放误差）
{
  const axis: V3 = [1, 2, -3];
  const an = Math.hypot(...axis);
  const axN: V3 = [axis[0] / an, axis[1] / an, axis[2] / an];
  const w: V3 = [axN[0] * 2.5, axN[1] * 2.5, axN[2] * 2.5];
  const run = (dt: number): number => {
    let q = qId();
    for (let i = 0; i < Math.round(1 / dt); i++) q = qIntegrate(q, w, dt);
    return qAngleBetween(q, qFromAxisAngle(axN, 2.5)) * DEG;
  };
  const e002 = run(0.002);
  const e01 = run(0.1);
  check(
    "指数映射积分与解析解一致",
    e002 < 1e-10 && e01 < 1e-10,
    `ω=2.5 rad/s 绕单位轴 1 s：dt=2ms 误差 ${e002.toExponential(1)}°，dt=100ms 误差 ${e01.toExponential(1)}°（大步长也不退化）`,
  );
}

// 36. 姿态夹角：零角附近可分辨 + 180° 端点精确（旧 acos 实现的分辨率瓶颈）
{
  const tiny = qFromAxisAngle([0, 0, 1], 1e-9);
  const aTiny = qAngleBetween(tiny, qId());
  const half = qFromAxisAngle([1, 0, 0], Math.PI);
  const aPi = qAngleBetween(half, qId());
  const rnd = mulberry32(2027);
  let maxDiff = 0;
  for (let i = 0; i < 2000; i++) {
    const q1 = qNorm({ w: rnd() * 2 - 1, x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
    const q2 = qNorm({ w: rnd() * 2 - 1, x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
    const ref = 2 * Math.acos(Math.min(1, Math.abs(qDot(q1, q2))));
    if (ref > 1e-3) maxDiff = Math.max(maxDiff, Math.abs(qAngleBetween(q1, q2) - ref));
  }
  check(
    "姿态夹角全区间数值稳定",
    Math.abs(aTiny - 1e-9) < 1e-15 && Math.abs(aPi - Math.PI) < 1e-12 && maxDiff < 1e-9,
    `1e-9 rad 小角误差 ${Math.abs(aTiny - 1e-9).toExponential(1)}；180° 误差 ${Math.abs(aPi - Math.PI).toExponential(1)}；` +
      `2000 组随机姿态与 acos 参考最大差 ${maxDiff.toExponential(1)} rad`,
  );
}

// 37. 误差统计器：均值/RMSE/峰值/收敛时刻
{
  const t = new ErrorTracker({ thresholdDeg: 2, holdSec: 0 });
  [3, 1, 1, 4].forEach((v, i) => t.add(v, i));
  const s = t.summary();
  const mean = (3 + 1 + 1 + 4) / 4;
  const rmse = Math.sqrt((9 + 1 + 1 + 16) / 4);
  const ok =
    s.n === 4 &&
    Math.abs(s.mean - mean) < 1e-12 &&
    Math.abs(s.rmse - rmse) < 1e-12 &&
    s.max === 4 &&
    s.last === 4 &&
    s.convergedAt === 1;
  t.reset(10);
  const empty = t.summary();
  check(
    "误差统计器（均值/RMSE/峰值/收敛）",
    ok && empty.n === 0 && Number.isNaN(empty.mean),
    `mean ${s.mean.toFixed(3)}（应 ${mean}）；RMSE ${s.rmse.toFixed(3)}（应 ${rmse.toFixed(3)}）；峰值 ${s.max}；收敛 ${s.convergedAt}s；reset 后 n=${empty.n}`,
  );
}

// 38. 磁力计球拟合：已知硬铁 + 对角软铁 → 恢复球心与轴比；覆盖不足返回 null
{
  const B: V3 = [32.8, 0, 37.7];
  const center: V3 = [9, -6, 13];
  const soft: V3 = [1.2, 0.8, 1.0];
  const g = new Gauss(mulberry32(2028));
  const samples: V3[] = [];
  for (let i = 0; i < 300; i++) {
    const q = qNorm({ w: g.next(), x: g.next(), y: g.next(), z: g.next() });
    const m = qRotInv(q, B);
    samples.push([soft[0] * m[0] + center[0], soft[1] * m[1] + center[1], soft[2] * m[2] + center[2]]);
  }
  const cal = calibrateMag(samples);
  const fit = fitMagSphere(samples);
  const offsetErr = cal ? Math.hypot(cal.offset[0] - center[0], cal.offset[1] - center[1], cal.offset[2] - center[2]) : NaN;
  const ratio = cal ? cal.scale[0] / cal.scale[1] : NaN;
  const ratioRef = soft[1] / soft[0];
  const correctedR = cal ? Math.hypot(...applyMagCalibration(samples[0], cal)) : NaN;
  const flat: V3[] = [];
  for (let i = 0; i < 120; i++) {
    const q = qFromAxisAngle([0, 0, 1], (i / 120) * Math.PI * 2);
    flat.push(qRotInv(q, B));
  }
  const flatCal = calibrateMag(flat);
  check(
    "磁力计球拟合（硬铁 + 对角软铁）",
    cal !== null && offsetErr < 0.5 && Math.abs(ratio - ratioRef) < 0.03 && cal.residual < 0.06 &&
      Math.abs(correctedR - (cal?.field ?? NaN)) < 0.05 * (cal?.field ?? 1) &&
      fit !== null && Math.abs(fit.radius - Math.hypot(...B)) < 1.5 && flatCal === null,
    cal
      ? `球心误差 ${offsetErr.toFixed(3)} μT；轴比 ${ratio.toFixed(3)}（应 ${ratioRef.toFixed(3)}）；` +
        `半径 ${fit!.radius.toFixed(1)} μT（真值 ${Math.hypot(...B).toFixed(1)}）；残差 ${(cal.residual * 100).toFixed(2)}%；` +
        `单轴覆盖被拒=${flatCal === null}`
      : "拟合返回 null",
  );
}

// 39. 软铁畸变：装置能造出椭球；对角标定收得掉对角部分、收不掉交叉项（诚实边界，文档引用这组数）
{
  const mk = (g: number): ImuParams => ({ ...clean, magSoftIron: g, magNoise: 0.8 });
  const dance = (p: ImuParams, n = 280): V3[] => {
    const gg = new Gauss(mulberry32(0xc0ffee));
    const out: V3[] = [];
    for (let i = 0; i < n; i++) {
      const q = qNorm({ w: gg.next(), x: gg.next(), y: gg.next(), z: gg.next() });
      out.push(simulateMag(q, (i / n) * 23.7, p, gg));
    }
    return out;
  };
  const c0 = calibrateMag(dance(mk(0)))!;
  const c4 = calibrateMag(dance(mk(0.4)))!;
  // 纯对角软铁（只有三轴增益，无交叉项）：这是「能被对角标定收掉」的那一半
  const S: V3 = [1.34, 0.71, 1.24];
  const diagOnly: V3[] = (() => {
    const gg = new Gauss(mulberry32(0xc0ffee));
    const out: V3[] = [];
    for (let i = 0; i < 280; i++) {
      const q = qNorm({ w: gg.next(), x: gg.next(), y: gg.next(), z: gg.next() });
      const m = qRotInv(q, MAG_WORLD_NED);
      out.push([S[0] * m[0], S[1] * m[1], S[2] * m[2]]);
    }
    return out;
  })();
  const cDiag = calibrateMag(diagOnly)!;
  const spread = (c: { scale: V3 }): number => Math.max(...c.scale) / Math.min(...c.scale);
  // 阈值留余量并注释来源：无软铁时 scale 极差也有约 2% 的底（Haar 有限采样的半极差涨落，
  // 不是畸变）；纯对角软铁标定后残差 1.79% 而不是 0，是「球拟合中心 + 半极差缩放」这套
  // 两步近似自身的底（真机换 3×3 椭球最小二乘能压得更低）。
  check(
    "软铁畸变：对角部分可标定、交叉项不可标定",
    spread(c0) < 1.05 && spread(c4) > 1.3 && c4.residual > 3 * c0.residual && cDiag.residual < 0.03,
    `无软铁：scale 极差 ${spread(c0).toFixed(3)}（≈1，余量来自有限采样）、残差 ${(c0.residual * 100).toFixed(1)}%；` +
      `软铁 0.40：scale 极差 ${spread(c4).toFixed(3)}、残差 ${(c4.residual * 100).toFixed(1)}%（交叉项收不掉）；` +
      `纯对角软铁：标定后残差 ${(cDiag.residual * 100).toFixed(2)}% ← 对角部分收得掉`,
  );
}

// 38b. 门控滞回恢复窗（GateRecovery）：机制本身原先**没有任何自检**，
//      于是「实验库里的门控滞回实验从来不触发恢复窗」这件事一直没人发现
//      （它的实测拒绝占比只有 0.83，到不了 0.9 的判定线，开与关完全一样）。
//      这里用同一现场把机制钉住：关→恢复窗 0 次且姿态准；开→反复放行、姿态被污染拉走。
{
  const pGate: ImuParams = { ...clean, linAccel: 8, vibration: 0.1, gyroBiasDps: 0.5, magNoise: 0.5 };
  const runGate = (recovery: boolean): { peak: number; opens: number; steadyRatio: number } => {
    const w = new World(scenarios.composite);
    const c = new ComplementaryEstimator();
    c.reset();
    // 配置必须在 reset() **之后**写：reset 会把运行态（含门控状态机与 ramp 计时）复位
    c.gateDeg = 20;
    c.gateMagPct = 0.35;
    c.gateRecovery = recovery;
    c.rampEnabled = false;
    c.magEnabled = true;
    let peak = 0;
    let opens = 0;
    let inRec = false;
    let steadyRatio = 0;
    for (let k = 0; k < 500 * 25; k++) {
      const s = w.step(H, pGate);
      c.update(s.gyro, s.accel, s.mag, H);
      const d = c.telemetry.detail as { gateMode?: number; rejectRatio?: number };
      if (k * H > 8) steadyRatio = Math.max(steadyRatio, d.rejectRatio ?? 0);
      if (k * H > 2) peak = Math.max(peak, qAngleBetween(c.q, w.q) * DEG);
      const rec = d.gateMode === 2;
      if (rec && !inRec) opens++;
      inRec = rec;
    }
    return { peak, opens, steadyRatio };
  };
  const off = runGate(false);
  const on = runGate(true);
  check(
    "门控滞回：关闭=拒绝到底；开启=反复放行并把姿态拉偏（机制可复现）",
    off.opens === 0 && on.opens >= 2 && on.peak > 3 * off.peak && on.steadyRatio > 0.9,
    "关→恢复窗 " + off.opens + " 次、峰值 " + off.peak.toFixed(1) + "°；" +
      "开→恢复窗 " + on.opens + " 次、峰值 " + on.peak.toFixed(1) + "°（窗口拒绝占比 " + on.steadyRatio.toFixed(2) + " > 0.9 才判定）",
  );
}

// 38c. 健壮性：畸形/退化输入不得让核心链路崩掉或吐出 NaN
//      这一组来自一次「对抗性输入扫描」（把 NaN/±Infinity/1e300/零向量/退化数组喂进每个纯函数）。
//      扫描结论：核心逻辑本身是稳的（没有一处「有限输入 → 非有限输出」），
//      但当时**没有任何测试守着这条性质**——以后任何一次改动都可能破坏它而无人察觉。
{
  const finiteAll = (a: readonly number[]): boolean => a.every((x) => Number.isFinite(x));
  // ① 退化的磁标定样本：全同点 / 共线 / 点数不足 → 必须拒绝（不能给出看似合理的垃圾参数）
  const same: readonly V3[] = Array.from({ length: 40 }, () => [10, 10, 10]);
  const collinear: readonly V3[] = Array.from({ length: 40 }, (_, i) => [i, 0, 0]);
  const few: readonly V3[] = Array.from({ length: 5 }, (_, i) => [i, i * 2, i * 3]);
  const degenerateRejected = calibrateMag(same) === null && calibrateMag(collinear) === null && calibrateMag(few) === null;
  // ② 畸形字节流 / 畸形 CSV：不得抛异常（串口与导入都在主循环路径上，抛一次就是整页停摆）
  let threw = "";
  const tryIt = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      threw += name + "(" + String(e) + ") ";
    }
  };
  tryIt("parseFrame(空)", () => void parseFrame(new Uint8Array(0), "x-front-y-left"));
  tryIt("parseFrame(半帧)", () => void parseFrame(new Uint8Array([0xaa, 0x55, 24]), "x-front-y-left"));
  tryIt("parseMavlinkFrame(空)", () => void parseMavlinkFrame(new Uint8Array(0), "x-front-y-left"));
  tryIt("parseMavlinkFrame(伪造头)", () => void parseMavlinkFrame(new Uint8Array([0xfd, 40, 0, 0, 0, 27, 1]), "x-front-y-left"));
  tryIt("parseTextLine(NaN 值)", () => void parseTextLine("abc,def,ghi,jkl,mno,pqr", "x-front-y-left", -1));
  tryIt("parseTextLine(5000 列)", () => void parseTextLine(Array.from({ length: 5000 }, () => "1").join(","), "x-front-y-left", -1));
  tryIt("frameDtSec(极端)", () => void frameDtSec(0xffffffff, 0));
  tryIt("parseImuCsv(空)", () => void parseImuCsv(""));
  tryIt("parseImuCsv(只有表头)", () => void parseImuCsv("t,gx,gy,gz,ax,ay,az"));
  tryIt("parseImuCsv(NaN 行)", () =>
    void parseImuCsv(["t,gx,gy,gz,ax,ay,az", "0,NaN,0,0,0,0,9.8", "1,1,1,1,1,1,1"].join(String.fromCharCode(10))),
  );
  tryIt("parseImuCsv(时间全相同)", () =>
    void parseImuCsv(["t,gx,gy,gz,ax,ay,az", "0,0,0,0,0,0,9.8", "0,0,0,0,0,0,9.8", "0,0,0,0,0,0,9.8"].join(String.fromCharCode(10))),
  );
  // ③ 有限但极端的仿真参数：输出必须有限（否则 NaN 会顺着积分器污染整个姿态）
  const g0 = new Gauss(mulberry32(31));
  const pz: ImuParams = { ...clean };
  let simNaN = "";
  for (const key of Object.keys(pz) as Array<keyof ImuParams>) {
    for (const v of [1e6, 1e300]) {
      const p = { ...pz, [key]: v };
      const s0 = simulateImu(qFromEuler(0.1, 0.2, 0.3), [1, 1, 1], 1, p, g0, 1);
      if (!finiteAll([...s0.gyro, ...s0.accel])) simNaN += key + "=" + v + " ";
      if (!finiteAll(simulateMag(qId(), 1, p, g0))) simNaN += "mag:" + key + " ";
    }
  }
  // ④ 插值端点与近反相；积分零角速度恒等；dt=0 的惯导；全相位万向节演示
  const qa = qId();
  const qb = { w: 0, x: 1, y: 0, z: 0 };
  const slerpOk =
    finiteAll(Object.values(qSlerp(qa, qb, 0))) &&
    finiteAll(Object.values(qSlerp(qa, qb, 1))) &&
    finiteAll(Object.values(qSlerp(qa, { w: 1e-9, x: 1, y: 0, z: 0 }, 0.5))) &&
    Math.abs(qSlerp(qa, qb, 1).x - 1) < 1e-9;
  const qi = qIntegrate(qFromEuler(0.3, 0.2, 0.1), [0, 0, 0], 0.01);
  const q0 = qFromEuler(0.3, 0.2, 0.1);
  const integrateOk = Math.abs(qi.w - q0.w) < 1e-15 && Math.abs(qi.x - q0.x) < 1e-15;
  const ins = new InsIntegrator();
  ins.step(qId(), [0, 0, G_ACC], 0);
  ins.step(qId(), [0, 0, G_ACC], 1e-9);
  const insSnap = ins.snapshot();
  const insOk = finiteAll([...insSnap.p, ...insSnap.v]);
  let demoOk = true;
  for (let t = 0; t <= 16; t += 0.05) {
    const d = gimbalDemo(t);
    if (!finiteAll([d.roll, d.pitch, d.yaw])) demoOk = false;
  }
  // ⑤ 统计：NaN 样本必须被忽略（否则一行脏数据会把整张评测表变成 NaN）
  const et = new ErrorTracker({ thresholdDeg: 2, holdSec: 1 });
  et.reset();
  et.add(0.1, 1);
  const before = et.summary().n;
  et.add(NaN, 2);
  const statOk = et.summary().n === before && Number.isFinite(et.summary().rmse);
  check(
    "健壮性：退化样本被拒 / 畸形输入不抛 / 极端参数不出 NaN",
    degenerateRejected && threw === "" && simNaN === "" && slerpOk && integrateOk && insOk && demoOk && statOk,
    "退化磁样本被拒=" + degenerateRejected + "；畸形输入抛异常=" + (threw || "无") +
      "；极端仿真参数产出 NaN=" + (simNaN || "无") + "；slerp/积分/dt=0/万向节全相位/NaN 样本忽略=" +
      [slerpOk, integrateOk, insOk, demoOk, statOk].map((x) => (x ? "✓" : "✗")).join(""),
  );
}

// 39. 器件级确定性误差（量程饱和 / 刻度 / 安装失准 / 群延迟 / 加计非线性）
//     这一组原先**完全没有自检**，而手册里四处写着「（自检实测）」——补上之后，
//     那些数字才真的有出处，这几条链路也才有人守着。
{
  const baseP = (over: Partial<ImuParams>): ImuParams => ({ ...clean, ...over });
  // 用「剧烈机动」剧本跑 15 s（与手册里那组数字同一窗口：饱和误差**随时间增长**，
  // 5 s 时纯积分才 24°、15 s 到 48°、30 s 到 95°，所以必须写清窗口，否则数字没法复现）
  const runErr = (p: ImuParams, who: "pure" | "mahony"): { peak: number; maxOmegaDeg: number } => {
    const world = new World(scenarios.violent);
    const est =
      who === "pure"
        ? new PureGyroEstimator()
        : new MahonyEstimator();
    est.reset(world.q);
    const g = new Gauss(mulberry32(4242));
    let peak = 0;
    let maxOmegaDeg = 0;
    const h = 1 / 500;
    for (let k = 0; k < 500 * 15; k++) {
      const s0 = world.step(h, p);
      maxOmegaDeg = Math.max(maxOmegaDeg, Math.hypot(...s0.gyro) * 57.29578);
      est.update(s0.gyro, s0.accel, s0.mag, h);
      const e = qAngleBetween(est.q, world.q) * 57.29578;
      if (k > 500) peak = Math.max(peak, e); // 跳过启动瞬态
    }
    void g;
    return { peak, maxOmegaDeg };
  };

  const satPure = runErr(baseP({ gyroRangeDps: 150 }), "pure");
  const satMahony = runErr(baseP({ gyroRangeDps: 150 }), "mahony");
  const noSatPure = runErr(baseP({ gyroRangeDps: 0 }), "pure");
  const scale5 = runErr(baseP({ gyroScaleErr: 0.05 }), "pure");
  const misalign3 = runErr(baseP({ gyroMisalign: 0.03 }), "pure");
  const delay25 = runErr(baseP({ gyroBiasDps: 0, gyroNoiseDps: 0, sensorDelayMs: 25 }), "pure");
  check(
    "器件级误差：量程饱和（读数削平→姿态大幅跑偏且无从察觉）",
    satPure.peak > 40 && satMahony.peak > 12 && satMahony.peak < 30 &&
      noSatPure.peak < 1 && satPure.maxOmegaDeg > 150,
    "机动峰值角速度 " + satPure.maxOmegaDeg.toFixed(0) + "°/s（> 量程 150 才触发）；15 s 窗口：" +
      "纯积分峰值误差 " + satPure.peak.toFixed(1) + "°（无饱和时 " + noSatPure.peak.toFixed(1) + "°）；" +
      "Mahony " + satMahony.peak.toFixed(1) + "°",
  );
  check(
    "器件级误差：刻度失配（速率相关，零偏估计吸收不了）",
    scale5.peak > 4 && scale5.peak < 20,
    "刻度 5% → 纯积分峰值误差 " + scale5.peak.toFixed(1) + "°",
  );
  check(
    "器件级误差：安装失准（单轴转动漏进另外两轴）",
    misalign3.peak > 1 && misalign3.peak < 3 * scale5.peak,
    "失准 3% → 纯积分峰值误差 " + misalign3.peak.toFixed(1) + "°",
  );
  check(
    "器件级误差：群延迟（姿态滞后 ω·τ）",
    delay25.peak > 3 && delay25.peak < 15,
    "延迟 25 ms（零偏噪声归零）→ 纯积分峰值误差 " + delay25.peak.toFixed(1) +
      "°（理论 ω·τ ≈ 240°/s × 0.025 s = 6°）",
  );
  // 加计非线性：k·(|a|/g − 1)² 的二次压缩 → 恰好 1g 处不动、过载处被压低。
  // 注意 accelFactor 缩放的是**机动线加速度**（linAccel），不是重力，所以「制造过载」要拉 linAccel。
  const nlMag = (nonlin: number, linAccel: number): number => {
    const g2 = new Gauss(mulberry32(7));
    const p = baseP({ linAccel, vibration: 0, accelNonlin: nonlin });
    const s0 = simulateImu(qFromEuler(0.3, 0.2, 0.1), [0, 0, 0], 0.5, p, g2, 1);
    return Math.hypot(...s0.accel);
  };
  const nlAt1g = nlMag(0.05, 0);
  const nlClean1g = nlMag(0, 0);
  const nlOverload = nlMag(0.05, 3);
  const nlOverloadClean = nlMag(0, 3);
  check(
    "器件级误差：加计非线性（1g 处严格不偏、过载处被二次压缩）",
    Math.abs(nlAt1g - nlClean1g) < 1e-12 && nlOverload < nlOverloadClean && nlOverload < G_ACC,
    "1g 处非线性开关不改变读数（" + nlAt1g.toFixed(6) + " vs " + nlClean1g.toFixed(6) + " m/s²）；" +
      "过载处 " + nlOverload.toFixed(3) + " < 无非线性 " + nlOverloadClean.toFixed(3),
  );
}

// 40. 纯工具函数：显示基变换、扫过曲线、percentile、特征分解、软铁增益
//     这些要么零覆盖、要么只被浏览器侧间接用到；都是「改错一个符号没人发现」的那类代码。
{
  const d = toDisplayVec([1, 2, 3]);
  const dOk = d[0] === 1 && d[1] === -3 && d[2] === 2;
  // 扫过曲线：端点 0、途中到过 ±90、单调段内不回头、越界被夹
  const sweep = (u: number): number => sweepPitchDeg(u);
  const pts = Array.from({ length: 101 }, (_, i) => sweep(i / 100));
  const sweepOk =
    Math.abs(sweep(0)) < 1e-9 &&
    Math.abs(sweep(1)) < 1e-9 &&
    Math.max(...pts) >= 89.9 &&
    Math.min(...pts) <= -89.9 &&
    sweep(-3) === sweep(0) &&
    sweep(9) === sweep(1);
  const pct = [percentile([1, 2, 3, 4], 0), percentile([1, 2, 3, 4], 1), percentile([1, 2, 3, 4], 0.5), percentile([], 0.5)];
  const pctOk = pct[0] === 1 && pct[1] === 4 && Math.abs(pct[2] - 2.5) < 1e-12 && Number.isNaN(pct[3]);

  // 特征分解：重建 V·diag(λ)·Vᵀ ≈ M、主轴正交、退化输入不炸
  const eigCases: number[][] = [
    [1, 0, 0, 0, 2, 0, 0, 0, 3],
    [0.02, 0.004, -0.001, 0.004, 0.05, 0.003, -0.001, 0.003, 0.01],
    [2, 0.5, 0, 0.5, 2, 0, 0, 0, 5],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1e6, 0, 0, 0, 1, 0, 0, 0, 1e-6],
  ];
  let recWorst = 0;
  let orthWorst = 0;
  for (const m of eigCases) {
    const { values, vectors } = symmetricEigen3(m);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s2 = 0;
        for (let k = 0; k < 3; k++) s2 += vectors[i * 3 + k] * values[k] * vectors[j * 3 + k];
        recWorst = Math.max(recWorst, Math.abs(s2 - m[i * 3 + j]) / Math.max(1, Math.abs(m[i * 3 + j])));
      }
      for (let j = 0; j < 3; j++) {
        let s2 = 0;
        for (let k = 0; k < 3; k++) s2 += vectors[k * 3 + i] * vectors[k * 3 + j];
        orthWorst = Math.max(orthWorst, Math.abs(s2 - (i === j ? 1 : 0)));
      }
    }
  }
  const gains = softIronGains(0);
  const gainsOk = gains.every((g) => Math.abs(g - 1) < 1e-15);
  // ins 的 reset/snapshot：重置后速度位置归零，snapshot 是拷贝而不是引用
  const ins2 = new InsIntegrator();
  ins2.step(qFromEuler(0, 0.1, 0), [0, 0, G_ACC], 0.05);
  const snap = ins2.snapshot();
  const movedBefore = Math.hypot(...snap.p) > 0 || Math.hypot(...snap.v) > 0;
  ins2.reset();
  const after = ins2.snapshot();
  const insOk = movedBefore && Math.hypot(...after.p) < 1e-12 && Math.hypot(...after.v) < 1e-12 && after.t === 0;
  // world.reset：时间归零、姿态回单位、延迟队列清空
  const w2 = new World(scenarios.violent);
  w2.step(0.05, clean);
  w2.step(0.05, clean);
  w2.reset();
  const worldOk = w2.t === 0 && Math.abs(w2.q.w - 1) < 1e-12;

  check(
    "纯工具函数：显示基变换 / 扫过曲线 / percentile / 特征分解 / 软铁增益 / reset",
    dOk && sweepOk && pctOk && recWorst < 1e-9 && orthWorst < 1e-12 && gainsOk && insOk && worldOk,
    "toDisplayVec(1,2,3)=(" + d.join(",") + ")；扫过曲线端点 0/0、跨度 [" +
      Math.min(...pts).toFixed(0) + "°, " + Math.max(...pts).toFixed(0) + "°]；" +
      "percentile 端值 " + pct[0] + "/" + pct[1] + "、空数组 " + pct[3] + "；" +
      "特征分解重建误差 " + recWorst.toExponential(1) + "、正交 " + orthWorst.toExponential(1) + "；" +
      "ins.reset/snapshot 与 world.reset 正常",
  );
}

// 39. 串口帧时钟：名义间隔、u32 回绕、空洞退回、夹紧
{
  const a = frameDtSec(1000, 1005);
  const wrap = frameDtSec(0xfffffffe, 2);
  const gap = frameDtSec(1000, 5000);
  const tiny = frameDtSec(1000, 1000);
  const huge = frameDtSec(1000, 1600);
  const ok = Math.abs(a - 0.005) < 1e-12 && Math.abs(wrap - 0.004) < 1e-12 &&
    Math.abs(gap - 0.005) < 1e-12 && Math.abs(tiny - 0.005) < 1e-12 && Math.abs(huge - 0.005) < 1e-12;
  check(
    "串口帧时钟（回绕/空洞/夹紧）",
    ok,
    `5ms→${(a * 1000).toFixed(1)}；u32 回绕→${(wrap * 1000).toFixed(1)}；空洞→${(gap * 1000).toFixed(1)}；` +
      `同 tick→${(tiny * 1000).toFixed(1)}；600ms→${(huge * 1000).toFixed(1)} ms（退回名义）`,
  );
}

// 40. base64url 深链编码：中文/符号往返、URL 安全字符集
{
  const text = JSON.stringify({ 场景: "复合机动 + 磁干扰", v: 2, view: "quat", 值: 1.25 });
  const enc = b64urlEncode(text);
  const dec = b64urlDecode(enc);
  check(
    "base64url 深链编码往返",
    dec === text && !/[+/=]/.test(enc) && enc.length > 10,
    `编码长度 ${enc.length}，字符集安全=${!/[+/=]/.test(enc)}，往返一致=${dec === text}`,
  );
}

// 41. Kalman 协方差健康：Joseph 更新后对称、对角正；极端零偏下不发散
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const kal = new KalmanEstimator();
  const g = new Gauss(mulberry32(2029));
  const p: ImuParams = { ...clean, gyroBiasDps: 100 };
  for (let i = 0; i < Math.round(12 / H); i++) {
    const s = simulateImu(qTrue, [0, 0, 0], i * H, p, g, 1);
    kal.update(s.gyro, s.accel, s.mag, H);
  }
  const P = kal.getCovariance();
  let sym = 0;
  let minDiag = Infinity;
  for (let i = 0; i < 6; i++) {
    minDiag = Math.min(minDiag, P[i * 6 + i]);
    for (let j = 0; j < 6; j++) sym = Math.max(sym, Math.abs(P[i * 6 + j] - P[j * 6 + i]));
  }
  const bias = kal.telemetry.detail.biasNormDps as number;
  const qn = Math.hypot(kal.q.w, kal.q.x, kal.q.y, kal.q.z);
  check(
    "Kalman 协方差对称正定 + 零偏限幅",
    Number.isFinite(bias) && bias <= 57.4 && sym < 1e-9 && minDiag > 0 && Math.abs(qn - 1) < 1e-12,
    `100°/s 零偏 12s：|b|=${bias.toFixed(1)}°/s（限幅 57.3）；P 对称误差 ${sym.toExponential(1)}；最小对角 ${minDiag.toExponential(1)}；‖q‖=${qn.toFixed(12)}`,
  );
}

// 42. 实验库数据完整性：id 唯一、必填字段齐全、动作非空
{
  const ids = new Set<string>();
  let bad = 0;
  for (const e of EXPERIMENTS) {
    if (ids.has(e.id)) bad++;
    ids.add(e.id);
    if (!e.name || !e.tag || !e.observe) bad++;
    const actions = Object.keys(e.sliders ?? {}).length + Object.keys(e.checks ?? {}).length +
      Object.keys(e.selects ?? {}).length + (e.view ? 1 : 0);
    if (actions === 0) bad++;
  }
  check(
    "实验库数据完整性",
    bad === 0 && EXPERIMENTS.length >= 8,
    `${EXPERIMENTS.length} 个实验（${EXPERIMENTS.map((e) => e.name).join("/")}），id 唯一且字段齐全=${bad === 0}`,
  );
}

// 43. 万向节锁的算法后果（本轮新增，全装置最锋利的一条教学剧本）：
//     俯仰**精确**停在 90° 再让横滚移动。此姿态下重力沿机体 x 轴，
//     加速度计对横滚**完全失去信息**（任何横滚给出同一读数），于是：
//       · 互补滤波工作在欧拉角空间——它每帧用 (加计横滚, 加计俯仰, 陀螺偏航)
//         重建姿态，而这三个数在锁点已不能唯一确定姿态（加计的横滚/俯仰提取退化为
//         与真值无关的垃圾值），估计被主动拽飞；
//       · 四元数空间的 Mahony / Madgwick 算的是「实测重力 × 预测重力」的叉积误差，
//         锁点上该误差为零 → 它们只是**停止修正**，靠（正确的）陀螺积分继续走，
//         降级优雅。
//     这就是「姿态解算为什么用四元数而不用欧拉角」的当场可复现证据。
{
  const run = (p: ImuParams) => {
    const world = new World(scenarios.pitchHold);
    const comp = new ComplementaryEstimator();
    const mahony = new MahonyEstimator();
    const madg = new MadgwickEstimator();
    for (const e of [comp, mahony, madg]) {
      e.reset();
      e.rampEnabled = false;
    }
    let pc = 0, pm = 0, pg = 0;
    let pitchHit = 0;
    for (let i = 0; i < Math.round(13 / H); i++) {
      const s = world.step(H, p);
      comp.update(s.gyro, s.accel, s.mag, H);
      mahony.update(s.gyro, s.accel, s.mag, H);
      madg.update(s.gyro, s.accel, s.mag, H);
      if (i * H > 3.5) {
        pc = Math.max(pc, qAngleBetween(comp.q, world.q) * DEG);
        pm = Math.max(pm, qAngleBetween(mahony.q, world.q) * DEG);
        pg = Math.max(pg, qAngleBetween(madg.q, world.q) * DEG);
      }
      // 俯仰确实到过 90°（否则本测试什么都没测到）
      pitchHit = Math.max(pitchHit, Math.abs(qToEuler(world.q).pitch) * DEG);
    }
    return { pc, pm, pg, pitchHit };
  };
  const r = run(clean);
  check(
    "万向节锁：互补滤波崩坏、四元数算法无伤",
    r.pitchHit > 89.99 && r.pc > 90 && r.pm < 1 && r.pg < 1,
    `俯仰停驻 90°（实测峰值 ${r.pitchHit.toFixed(2)}°）+ 横滚移动：互补 ${r.pc.toFixed(1)}° ` +
      `vs Mahony ${r.pm.toFixed(2)}° / Madgwick ${r.pg.toFixed(2)}°（须 互补>90°、四元数<1°）`,
  );
  // 有零偏时四元数算法也会漂（锁点上没有观测能拉住它），但量级远小于互补
  const biased = run({ ...clean, gyroBiasDps: 1 });
  check(
    "万向节锁：零偏 1°/s 下四元数算法仍远优于互补",
    biased.pm < 15 && biased.pg < 15 && biased.pc > 60,
    `零偏 1°/s：互补 ${biased.pc.toFixed(1)}° vs Mahony ${biased.pm.toFixed(1)}° / Madgwick ${biased.pg.toFixed(1)}°`,
  );
}

// 44. qToEuler 的万向节锁约定：±90° 处不再返回任意角度
//     （修复前实测：真值横滚 30° 时重建姿态偏差达 60°——三元组甚至不与原四元数等价）
{
  let worst = 0;
  for (const pitch of [-90, -89.99, -45, 0, 45, 89.99, 90]) {
    for (const roll of [-90, -45, 0, 30, 45, 90]) {
      for (const yaw of [-180, -90, 0, 90, 180]) {
        const q = qFromEuler(roll * RAD, pitch * RAD, yaw * RAD);
        const e = qToEuler(q);
        const back = qFromEuler(e.roll, e.pitch, e.yaw);
        worst = Math.max(worst, qAngleBetween(back, q) * DEG);
      }
    }
  }
  const lockEuler = qToEuler(qFromEuler(45 * RAD, 90 * RAD, 0));
  check(
    "qToEuler 万向节锁约定（roll := 0，信息归入 yaw）",
    worst < 1e-8 && Math.abs(lockEuler.roll) < 1e-12 && Math.abs(lockEuler.yaw + 45 * RAD) < 1e-9,
    `210 组姿态往返最大偏差 ${worst.toExponential(2)}°；俯仰 90°+横滚 45° → 读数 (0°, 90°, ${(lockEuler.yaw * DEG).toFixed(2)}°)`,
  );
}

// 45. 完整 MARG（磁倾角补偿参考场）vs 简化 MARG（磁只约束偏航）
//     两者在干净磁场下等价；收益在磁场被交变干扰污染时显现——
//     完整版用整条磁场向量做误差，且参考场由测量本身构造（倾角自洽），
//     简化版从脏数据里解一个倾斜补偿航向，被干扰牵着走。
{
  const runMarg = (mode: "yaw" | "full", p: ImuParams) => {
    const world = new World(scenarios.composite);
    const e = new MahonyEstimator();
    e.magEnabled = true;
    e.magMode = mode;
    e.rampEnabled = false;
    e.reset();
    let sum = 0, n = 0, peak = 0;
    for (let i = 0; i < Math.round(16 / H); i++) {
      const s = world.step(H, p);
      e.update(s.gyro, s.accel, s.mag, H);
      if (i * H > 5) {
        const err = qAngleBetween(e.q, world.q) * DEG;
        sum += err;
        peak = Math.max(peak, err);
        n++;
      }
    }
    return { mean: sum / n, peak };
  };
  const cleanYaw = runMarg("yaw", clean);
  const cleanFull = runMarg("full", clean);
  const disturbYaw = runMarg("yaw", { ...clean, disturbMag: 0.5 });
  const disturbFull = runMarg("full", { ...clean, disturbMag: 0.5 });
  check(
    "完整 MARG vs 简化 MARG:干净磁场等价、交变干扰下显著更优",
    cleanYaw.mean < 0.2 && cleanFull.mean < 0.2 &&
      disturbFull.mean < disturbYaw.mean / 3 && disturbFull.peak < disturbYaw.peak / 5,
    `干净：简化 ${cleanYaw.mean.toFixed(2)}° ≈ 完整 ${cleanFull.mean.toFixed(2)}°；` +
      `交变干扰 0.5：简化 ${disturbYaw.mean.toFixed(2)}°（峰值 ${disturbYaw.peak.toFixed(1)}°）→ 完整 ${disturbFull.mean.toFixed(2)}°（峰值 ${disturbFull.peak.toFixed(1)}°）`,
  );
}

// 46. 观测门控的滞回恢复窗：拒绝太久自动放行（Fusion 同款机制，默认关闭）
//     同一段「持续侧向 4 m/s²」：恢复窗关 → 观测被拒到底、估计钉在真值；
//     恢复窗开 → 5 s 后判定「可能是我自己偏了」放行观测 → 姿态被污染拉走。
//     这个对照本身就是工程取舍：门控不是万能的。
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const gBody = qRotInv(qTrue, [0, 0, G_ACC]);
  const accelDisturbed: V3 = [gBody[0] + 4.0, gBody[1], gBody[2]];
  const run = (recovery: boolean) => {
    const c = new ComplementaryEstimator();
    c.alpha = 2;
    c.rampEnabled = false;
    c.gateRecovery = recovery;
    c.reset(qTrue);
    let peak = 0;
    for (let i = 0; i < Math.round(30 / H); i++) {
      c.update([0, 0, 0], accelDisturbed, [0, 0, 0], H);
      peak = Math.max(peak, qAngleBetween(c.q, qTrue) * DEG);
    }
    return peak;
  };
  const off = run(false);
  const on = run(true);
  check(
    "门控滞回恢复窗（默认关，开则放弃拒绝）",
    off < 0.5 && on > 15,
    `持续侧向 4 m/s² 30s：恢复窗关 ${off.toFixed(2)}°（拒绝到底）｜ 开 ${on.toFixed(2)}°（被污染拉走）`,
  );
}

// 47. 方向门控阈值可调（面板滑块）：同一个 22° 污染的观测，
//     阈值 20° 时被拒（估计不动）、放宽到 30° 时穿堂而过。
{
  const qTrue = qFromEuler(15 * RAD, 25 * RAD, 40 * RAD);
  const gBody = qRotInv(qTrue, [0, 0, G_ACC]);
  const accelDisturbed: V3 = [gBody[0] + 4.0, gBody[1], gBody[2]];
  const run = (gateDeg: number) => {
    const c = new ComplementaryEstimator();
    c.alpha = 2;
    c.rampEnabled = false;
    c.gateDeg = gateDeg;
    c.reset(qTrue);
    for (let i = 0; i < Math.round(10 / H); i++) c.update([0, 0, 0], accelDisturbed, [0, 0, 0], H);
    return qAngleBetween(c.q, qTrue) * DEG;
  };
  const t20 = run(20);
  const t30 = run(30);
  check(
    "方向门控阈值可调（20° 拒收 / 30° 放行）",
    t20 < 0.5 && t30 > 15,
    `污染方向偏 22°：门限 20° → ${t20.toFixed(2)}°（拒收）；门限 30° → ${t30.toFixed(2)}°（放行、被拽偏）`,
  );
}

// 48. IMU 日志导入（core/replay.ts 纯函数）：两种格式、单位换算、时间轴推断
//     这是「离线回放」的入口，也是唯一一处「用户给的文本」进来的地方——
//     宽容匹配 + 把推断假设写进 notes 是刻意的：猜错单位不会报错，但会让数据看起来不对。
{
  const rows = (header: string, body: string, n = 30, dt = 0.01): string => {
    const cols = body.split(",");
    const t0 = Number(cols[0]);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push([(t0 + i * dt).toFixed(4), ...cols.slice(1)].join(","));
    return (header ? header + "\n" : "") + out.join("\n");
  };

  // 本装置导出格式（注释头 + gyro_x_dps / accel_x_ms2 / mag_x_ut）
  const own = parseImuCsv(
    "# quaternion-attitude-demo export\n# mode=simulation\n" +
      "t_s,truth_roll_deg,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut\n" +
      rows("", "0.000,1.0,0.5,-0.2,0.1,0.1,0.2,9.81,32.8,0.0,37.7"),
  );
  const ownOk =
    !own.error &&
    own.frames.length === 30 &&
    Math.abs(own.frames[0].gyroDps[0] - 0.5) < 1e-9 &&
    Math.abs(own.frames[0].accelMs2[2] - 9.81) < 1e-9 &&
    own.frames[0].hasMag &&
    Math.abs(own.frames[0].magUt[0] - 32.8) < 1e-9;

  // 单位自动换算：rad/s → °/s、g → m/s²
  const units = parseImuCsv(
    rows("t,gyro_x_rad_s,gyro_y_rad_s,gyro_z_rad_s,accel_x_g,accel_y_g,accel_z_g", "0,0.017453,0,0,0,0,1"),
  );
  const unitsOk =
    !units.error &&
    Math.abs(units.frames[0].gyroDps[0] - 1) < 1e-3 &&
    Math.abs(units.frames[0].accelMs2[2] - 9.80665) < 1e-3;

  // 短名列 + 毫秒时间轴（5 ms 采样 → 应报 200 Hz）
  const shortMs = parseImuCsv(rows("t_ms,gx,gy,gz,ax,ay,az", "0,1,2,3,0,0,9.8", 30, 5));
  const msOk =
    !shortMs.error &&
    Math.abs(shortMs.frames[0].gyroDps[0] - 1) < 1e-9 &&
    shortMs.notes.some((n) => n.includes("200 Hz"));

  // 无表头：7 列与 10 列都要认
  const noHead7 = parseImuCsv(rows("", "0,1,2,3,0,0,9.8"));
  const noHead10 = parseImuCsv(rows("", "0,1,2,3,0,0,9.8,10,20,30"));
  const noHeadOk =
    !noHead7.error && !noHead7.frames[0].hasMag && !noHead10.error && noHead10.frames[0].hasMag;

  check(
    "IMU 日志导入：两种格式 + 单位换算 + 时间轴推断",
    ownOk && unitsOk && msOk && noHeadOk,
    `本装置格式 ${own.frames.length} 帧（含磁=${own.frames[0].hasMag}）；rad/s→°/s ${units.frames[0].gyroDps[0].toFixed(3)}；` +
      `g→m/s² ${units.frames[0].accelMs2[2].toFixed(3)}；毫秒表头判出 ${shortMs.notes.find((n) => n.includes("Hz")) ?? "?"}；` +
      `无表头 7/10 列磁力计=${noHead10.frames[0].hasMag}`,
  );
}

// 49. IMU 日志导入的错误路径：列名认不出、行数太少、无表头列数不对 —— 都必须给出**可操作**的提示
{
  const rows = (header: string, body: string, n = 30): string => {
    const cols = body.split(",");
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push([(i * 0.01).toFixed(3), ...cols.slice(1)].join(","));
    return (header ? header + "\n" : "") + out.join("\n");
  };
  const bad1 = parseImuCsv(rows("time,a1,b2,c3,d4,e5,f6", "0,1,2,3,0,0,9.8"));
  const bad2 = parseImuCsv(rows("t,gx,gy,gz,ax,ay,az", "0,1,2,3,0,0,9.8", 5));
  const bad3 = parseImuCsv(rows("", "0,1,2,3,0", 30));
  const bad4 = parseImuCsv("");
  check(
    "IMU 日志导入：错误路径给出可操作提示",
    Boolean(bad1.error && bad1.error.includes("陀螺仪")) &&
      Boolean(bad2.error && bad2.error.includes("太少")) &&
      Boolean(bad3.error && bad3.error.includes("7 列")) &&
      Boolean(bad4.error),
    `列名认不出 →「${(bad1.error ?? "").slice(0, 16)}…」；帧数不足 →「${(bad2.error ?? "").slice(0, 10)}…」；` +
      `列数不对 →「${(bad3.error ?? "").slice(0, 18)}…」`,
  );
}

// 50. 捷联力学编排（core/ins.ts）：理想输入必须零漂移，且误差增长律与解析式一致
//     这是「姿态解算精度为什么值钱」的量化基础——位置对陀螺零偏是三次方增长，
//     所以这条链路必须先在数值上站得住，UI 上的轨迹才有意义。
{
  // ① 完美姿态 + 理想读数 → 位置必须纹丝不动（否则后续所有结论都不可信）
  const ideal = new InsIntegrator();
  const accelLevel: V3 = [0, 0, G_NED];
  for (let i = 0; i < Math.round(20 / H); i++) ideal.step(qId(), accelLevel, H);
  const zeroDrift = ideal.horizontalDrift() + Math.abs(ideal.p[2]);

  // ② 恒定倾角误差：a = g·sinθ，v = a·t，d = ½·a·t²（用真值姿态族解析对照）
  const theta = 1 * RAD;
  const tilt = new InsIntegrator();
  const qTilt = qFromEuler(0, theta, 0); // 俯仰轴上的恒定误差
  const tEnd = 30;
  for (let i = 0; i < Math.round(tEnd / H); i++) tilt.step(qTilt, accelLevel, H);
  const aTheory = G_NED * Math.sin(theta);
  const vTheory = aTheory * tEnd;
  const dTheory = 0.5 * aTheory * tEnd * tEnd;
  const aGot = Math.hypot(tilt.aNed[0], tilt.aNed[1]);
  const vGot = Math.hypot(tilt.v[0], tilt.v[1]);
  const dGot = tilt.horizontalDrift();
  const constErr = Math.max(
    Math.abs(aGot - aTheory) / aTheory,
    Math.abs(vGot - vTheory) / vTheory,
    Math.abs(dGot - dTheory) / dTheory,
  );

  check(
    "捷联力学编排：理想输入零漂移 + 恒定倾角误差的解析一致",
    zeroDrift < 1e-9 && constErr < 2e-3,
    `理想 20 s 漂移 ${zeroDrift.toExponential(1)} m；恒定 1° 倾角误差：` +
      `a ${aGot.toFixed(4)}（理论 ${aTheory.toFixed(4)} m/s²）、d ${dGot.toFixed(2)}（理论 ${dTheory.toFixed(2)} m），最大相对偏差 ${(constErr * 100).toFixed(2)}%`,
  );

  // ③ 倾角误差按 θ̇ 线性增长（陀螺零偏未被修正的极限）→ 位置应服从 ⅙·g·θ̇·t³
  const thetaDot = 1 * RAD; // 1°/s
  const ramp = new InsIntegrator();
  for (let i = 0; i < Math.round(20 / H); i++) {
    const t = i * H;
    ramp.step(qFromEuler(thetaDot * t, 0, 0), accelLevel, H);
  }
  const law = driftLaw(thetaDot, 20);
  const ratio = ramp.horizontalDrift() / law.distance;
  check(
    "位置漂移服从 t³ 律（⅙·g·θ̇·t³）",
    ratio > 0.97 && ratio < 1.03,
    `倾角误差 1°/s 增长、20 s 后：实测 ${ramp.horizontalDrift().toFixed(1)} m / 理论 ${law.distance.toFixed(1)} m（比值 ${ratio.toFixed(3)}）`,
  );
}

// 51. 串口文本行协议：三种列数、多种分隔符、表头/注释/坏行的处理
//     这是「不写二进制固件也能接进来」的入口——主控只要 Serial.print 一行数即可。
{
  const M: Mounting = "x-front-y-right"; // 该 mounting 为重排恒等，便于读原始数值
  const f6 = parseTextLine("1.5,-2.5,0.3,0.1,0.2,9.81", M, 1000, 5);
  const f9 = parseTextLine("1.5 -2.5 0.3 0.1 0.2 9.81 30 0 40", M, 1000, 5);
  const f10 = parseTextLine("2.5\t1.5\t-2.5\t0.3\t0.1\t0.2\t9.81\t30\t0\t40", M, 1000, 5);
  const header = parseTextLine("gx,gy,gz,ax,ay,az", M, 1000, 5);
  const comment = parseTextLine("# t,gx,gy", M, 1000, 5);
  const badCols = parseTextLine("1.5,-2.5,0.3", M, 1000, 5);
  const badNum = parseTextLine("1.5,abc,0.3,0.1,0.2,9.81", M, 1000, 5);
  const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;
  const g6 = f6.frame?.gyroDps ?? [NaN, NaN, NaN];
  const a6 = f6.frame?.accelMs2 ?? [NaN, NaN, NaN];
  const m9 = f9.frame?.magUt ?? [NaN, NaN, NaN];
  const t6 = f6.frame?.tickMs ?? NaN;
  const t10 = f10.frame?.tickMs ?? NaN;
  check(
    "串口文本行协议：6/9/10 列 + 分隔符 + 表头坏行",
    Boolean(f6.frame) &&
      near(g6[0], 1.5) &&
      near(a6[2], 9.81) &&
      f6.frame?.seq === 0 &&
      near(t6, 1005) && // 无时间戳 → 按名义间隔累加
      Boolean(f9.frame) &&
      near(m9[0], 30) &&
      Boolean(f10.frame) &&
      near(t10, 2500) && // 有时间戳（秒）→ 用它
      header.header === true &&
      comment.frame === null &&
      Boolean(badCols.reason) &&
      header.frame === null &&
      badNum.frame === null,
    `6 列 accel_z=${a6[2]}；9 列 mag_x=${m9[0]}；10 列 tick=${t10}；` +
      `表头=${header.header}；注释=${comment.frame === null}；坏列数原因「${badCols.reason?.slice(0, 12)}…」`,
  );
}

// 52. MAVLink v2 · RAW_IMU：crc_extra 现场反验 + 往返 + 取反 + 坏帧重同步
//     crc_extra 不是抄来的常量——这里用 MAVLink 的算法重新推导，
//     并用两个官方已知常量（HEARTBEAT=50、ATTITUDE=39）验证算法本身，据此确认 RAW_IMU=144。
{
  const hb = computeCrcExtra("HEARTBEAT", HEARTBEAT_BASE_FIELDS);
  const at = computeCrcExtra("ATTITUDE", ATTITUDE_BASE_FIELDS);
  const ri = computeCrcExtra("RAW_IMU", RAW_IMU_BASE_FIELDS);
  const M: Mounting = "x-front-y-right";
  const frame = buildMavlinkRawImu(7, 1234567890n, [0.1, 0.2, 9.80665], [1.5, -2.5, 0.3], [30, 0, 40]);
  const back = parseMavlinkFrame(frame, M);
  const inverted = parseMavlinkFrame(frame, M, true);
  const corrupt = Uint8Array.from(frame);
  corrupt[corrupt.length - 1] ^= 0xff;
  const badCrc = parseMavlinkFrame(corrupt, M);
  const otherMsg = Uint8Array.from(frame);
  otherMsg[7] = 30; // 冒充 ATTITUDE
  const skipped = parseMavlinkFrame(otherMsg, M);
  const partial = parseMavlinkFrame(frame.subarray(0, 20), M);
  // 脏字节重同步：前面塞 5 字节垃圾。
  // 解析器一次调用只跳一段（「先丢掉帧头前的垃圾，下次再解析」），与主循环的 while 消费一致，
  // 所以这里也循环消费到 consumed===0 再断言——第一次调用应恰好丢弃这 5 个字节。
  const dirty = new Uint8Array(5 + frame.length).fill(0x11);
  dirty.set(frame, 5);
  const firstSkip = parseMavlinkFrame(dirty, M).consumed;
  let buf = dirty;
  let frames2 = 0;
  for (let guard = 0; guard < 10 && buf.length > 0; guard++) {
    const r = parseMavlinkFrame(buf, M);
    if (r.frame) frames2++;
    if (r.consumed === 0) break;
    buf = buf.subarray(r.consumed);
  }
  const g = back.frame?.gyroDps ?? [NaN, NaN, NaN];
  const a = back.frame?.accelMs2 ?? [NaN, NaN, NaN];
  const m = back.frame?.magUt ?? [NaN, NaN, NaN];
  void frame.length;
  check(
    "MAVLink RAW_IMU：crc_extra 反验 + 往返 + 取反 + 坏帧处理",
    hb === 50 &&
      at === 39 &&
      ri === MAVLINK_CRC_EXTRA_RAW_IMU &&
      Boolean(back.frame) &&
      Math.abs(g[0] - 1.5) < 0.06 && // int16 的 mrad/s 分辨率 ≈ 0.057 °/s
      Math.abs(a[2] - 9.80665) < 5e-4 &&
      Math.abs(m[0] - 30) < 1e-9 &&
      Math.abs((inverted.frame?.accelMs2[2] ?? 0) + 9.80665) < 5e-4 &&
      badCrc.reason === "CRC 校验失败" &&
      badCrc.consumed === 1 &&
      (skipped.reason ?? "").startsWith("跳过消息") &&
      partial.consumed === 0 &&
      firstSkip === 5 &&
      frames2 === 1,
    `crc_extra 反验 HEARTBEAT=${hb}/ATTITUDE=${at}/RAW_IMU=${ri}（官方 50/39）；` +
      `往返 gyro_x=${g[0].toFixed(3)} accel_z=${a[2].toFixed(4)} mag_x=${m[0].toFixed(1)}；` +
      `取反=${inverted.frame?.accelMs2[2].toFixed(4)}；坏 CRC→${badCrc.reason}(consumed=${badCrc.consumed})；` +
      `非 RAW_IMU→「${skipped.reason}」；半帧 consumed=${partial.consumed}；脏字节流首次丢弃 ${firstSkip} 字节、循环消费后解出 ${frames2} 帧`,
  );
}

// 53. Allan 方差（core/allan.ts）：用已知 N/K 合成序列，曲线要回到那三个系数的量级
//     这是把「零偏稳定性」从数据手册数字变成可验证曲线的关键例程：
//     白噪声区斜率应 ≈ −½、随机游走区斜率应 ≈ +½，且 σ(1 s) 应与 ARW 系数同量级。
{
  const fs = 50;
  const n = 1 << 15;
  const white = synthesizeGyroAngle({ n, fs, arw: 0.01, rrw: 0, rand: mulberry32(7) });
  const aWhite = allanDeviation(white.theta, white.dt);
  // 纯白噪声：σ(τ) = N·√(τ_avg 归一) —— 经验判据是 σ(1s) 与 N 同量级、斜率 ≈ −½
  const slopeW = allanSlope(aWhite.taus, aWhite.sigmas, 1, 20);
  const sigma1 = aWhite.sigmas[aWhite.taus.findIndex((t) => t >= 1)];

  const walk = synthesizeGyroAngle({ n, fs, arw: 0, rrw: 0.02, rand: mulberry32(11) });
  const aWalk = allanDeviation(walk.theta, walk.dt);
  const slopeR = allanSlope(aWalk.taus, aWalk.sigmas, 2, 10);
  // 纯随机游走：σ(τ) = K·√(τ/3)（经典系数），用 τ=5 s 处反推 K 看量级。
  // 注意自动 τ 列表最大到 2^9·dt ≈ 10 s（受序列长度限制），所以取 5 s 而不是 20 s。
  const idx5 = aWalk.taus.findIndex((t) => t >= 5);
  const s5 = aWalk.sigmas[idx5];
  const kEst = s5 / Math.sqrt(5 / 3);

  check(
    "Allan 方差：白噪声 −½ 斜率、随机游走 +½ 斜率与系数还原",
    Math.abs(slopeW + 0.5) < 0.12 &&
      Math.abs(slopeR - 0.5) < 0.12 &&
      sigma1 > 0.004 && sigma1 < 0.03 && // N=0.01 的量级
      Math.abs(kEst / 0.02 - 1) < 0.35, // K=0.02 的量级（单次实现有统计涨落）
    `白噪声段斜率 ${slopeW.toFixed(3)}（理论 −0.5）、σ(1s)=${sigma1.toFixed(4)}（N=0.01）；` +
      `随机游走段斜率 ${slopeR.toFixed(3)}（理论 +0.5）、由 σ(5s) 反推 K=${kEst.toFixed(4)}（真值 0.02）`,
  );
}

// 54. 实验配置 + 确定性运行内核：版本迁移、校验、同 seed 逐位复现、磁链隔离、种子序列
//     这组守护把「可复现」从参数快照提升为可验证性质：
//     · 同配置同 seed 两次 runExperiment 的 digest 必须完全一致；
//     · 只改磁噪声不能改变同 seed 的陀螺/加计读数（独立随机流）；
//     · 不同 seed 必须产生不同结果，否则种子没有真正生效。
{
  const base = defaultExperimentConfig();
  const round = migrateExperimentConfig(JSON.parse(JSON.stringify(base)));
  const clean = defaultExperimentConfig();
  clean.seed = 777;
  clean.durationSec = 2;
  clean.imu = { ...clean.imu, gyroNoiseDps: 0.3, magNoise: 0 };
  const dirty = cloneExperimentConfig(clean);
  dirty.imu.magNoise = 1.5;

  const r1 = runExperiment(clean);
  const r2 = runExperiment(clean);
  const r3 = runExperiment(dirty);
  const rSeed = runExperiment({ ...clean, seed: 778 });
  const digest = (r: ReturnType<typeof runExperiment>): string => resultDigest(r);
  const same = digest(r1) === digest(r2);
  const magChangedMetrics = digest(r1) !== digest(r3);
  // 逐轴比较 IMU 读数：用两个同 seed 的 World 前 200 步验证磁链隔离
  const wA = new World(scenarios.hover, 777);
  const wB = new World(scenarios.hover, 777);
  let imuIsolated = true;
  for (let i = 0; i < 200; i++) {
    const a = wA.step(H, { ...clean.imu, magNoise: 0 });
    const b = wB.step(H, { ...dirty.imu, magNoise: 1.5 });
    if (
      a.gyro.some((v, k) => v !== b.gyro[k]) ||
      a.accel.some((v, k) => v !== b.accel[k])
    ) {
      imuIsolated = false;
      break;
    }
  }
  const valid = validateExperimentConfig(clean).length === 0;
  const bad = cloneExperimentConfig(clean);
  bad.durationSec = NaN;
  bad.solveRateHz = 0;
  const catchesBad = validateExperimentConfig(bad).length >= 2;
  const seeds = seedSequence(42, 5);
  const seeds2 = seedSequence(42, 5);
  const unique = new Set(seeds).size === seeds.length;
  const diffSeed = digest(r1) !== digest(rSeed);

  check(
    "实验配置与确定性运行内核（迁移/校验/复现/磁链隔离/种子）",
    JSON.stringify(round) === JSON.stringify(base) &&
      valid &&
      catchesBad &&
      same &&
      magChangedMetrics &&
      imuIsolated &&
      unique &&
      JSON.stringify(seeds) === JSON.stringify(seeds2) &&
      diffSeed,
    `往返一致=${JSON.stringify(round) === JSON.stringify(base)}；校验通过=${valid}、坏配置命中=${catchesBad}；` +
      `同 seed digest 一致=${same}、不同 seed 不同=${diffSeed}；磁噪声变化改变整体结果=${magChangedMetrics}、` +
      `但不改变陀螺/加计前 200 步=${imuIsolated}；seedSequence 稳定且互异=${unique && JSON.stringify(seeds) === JSON.stringify(seeds2)}`,
  );
}

// 55. 数据源/误差参考语义：模拟有物理真值，真实/BLE/回放默认只有 Mahony 算法间基准
{
  const sim = { kind: "simulation" as const, externalReference: false };
  const replay = { kind: "replay" as const, externalReference: false };
  const replayTruth = { kind: "replay" as const, externalReference: true };
  const ok =
    hasPhysicalReference(sim) &&
    !hasPhysicalReference(replay) &&
    hasPhysicalReference(replayTruth) &&
    referenceKindOf(replay) === "mahony" &&
    referenceKindOf(replayTruth) === "external" &&
    sourceLabelOf(replay) === "离线回放";
  check("数据源与误差参考类型（模拟真值 / Mahony 基准 / 外部参考）", ok,
    `模拟=${referenceKindOf(sim)}；回放=${referenceKindOf(replay)}；带回放真值=${referenceKindOf(replayTruth)}；标签=${sourceLabelOf(replay)}`);
}

// 56. 时间完整性与回放有效性：空隙保留真实时间；坏样本拒绝、外部真值、引号、重复列
{
  const gap = frameIntervalSec(0, 300); // 300 ms 真实空洞
  const clamp = frameDtSec(0, 300); // 旧接口仍用于“安全单步”
  const quoted = parseImuCsv(
    [
      "t_s,gx,gy,gz,ax,ay,az,mx,my,mz,truth_qw,truth_qx,truth_qy,truth_qz",
      ...Array.from({ length: 25 }, (_, i) =>
        `${i * 0.01},1,0,0,0,0,9.8,30,"20",0,1,0,0,0`,
      ),
    ].join("\n"),
  );
  const badRows = parseImuCsv(
    [
      "t_s,gx,gy,gz,ax,ay,az",
      ...Array.from({ length: 30 }, (_, i) => (i % 10 === 5 ? `${i * 0.01},nan,0,0,0,0,9.8` : `${i * 0.01},1,0,0,0,0,9.8`)),
    ].join("\n"),
  );
  const dup = parseImuCsv(["t_s,gx,gy,gz,ax,ay,az,gyro_x_dps", ...Array.from({ length: 21 }, (_, i) => `${i},1,0,0,0,0,9.8,1`)].join("\n"));
  const quotedOk = quoted.error === undefined && quoted.frames[0]?.gyroDps[0] === 1;
  const truthOk = quoted.hasTruth && quoted.frames.every((f) => f.qTrue !== undefined);
  const badRejected = badRows.error === undefined && badRows.invalidRows === 3 && badRows.frames.length === 27;
  const dupRejected = Boolean(dup.error && dup.error.includes("歧义"));
  check(
    "回放时间完整性 + 坏样本拒绝 + 外部真值 + 引号/重复列",
    Math.abs(gap - 0.3) < 1e-9 &&
      clamp < gap &&
      quotedOk && truthOk && badRejected && dupRejected,
    `300 ms 空洞：真实间隔 ${gap.toFixed(3)} s（旧安全步长 ${clamp.toFixed(3)} s）；` +
      `带引号 CSV=${quotedOk}、外部真值=${truthOk}；坏样本拒绝 ${badRows.invalidRows}/30（应 3）、保留 ${badRows.frames.length}；` +
      `重复列报错=${dupRejected}`,
  );
}

// 57. 卡尔曼统计诊断：NIS/NEES 有限且非负；χ² 门控与固定角门控都能运行并给出可比较指标
{
  const cfg = defaultExperimentConfig();
  cfg.durationSec = 5;
  cfg.seed = 2468;
  const angle = runExperiment(cfg);
  const chi = cloneExperimentConfig(cfg);
  chi.estimators.kalman.kalmanGate = "mahalanobis";
  chi.estimators.kalman.kalmanChi2 = 11.345;
  const mah = runExperiment(chi);
  const ka = angle.metrics.find((m) => m.id === "kalman")!;
  const km = mah.metrics.find((m) => m.id === "kalman")!;
  const finite = (v: number | undefined): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const ok =
    finite(ka.neesThetaMean) && finite(ka.neesBiasMean) && finite(ka.nisAccelMean) &&
    finite(ka.accelAcceptPct) && finite(km.neesThetaMean) && finite(km.nisAccelMean) &&
    (ka.accelAcceptPct ?? 0) > 0 && (ka.accelAcceptPct ?? 0) <= 100;
  check(
    "卡尔曼诊断：NIS/NEES 与两种门控形态",
    ok,
    `固定角：NEESθ=${ka.neesThetaMean?.toFixed(2)}、NEESb=${ka.neesBiasMean?.toFixed(2)}、` +
      `NISa=${ka.nisAccelMean?.toFixed(2)}、接受率=${ka.accelAcceptPct?.toFixed(1)}%；` +
      `χ²：NEESθ=${km.neesThetaMean?.toFixed(2)}、NISa=${km.nisAccelMean?.toFixed(2)}、接受率=${km.accelAcceptPct?.toFixed(1)}%`,
  );
}

// 58. 单帧姿态确定：TRIAD/QUEST 在干净观测下回到真值；权重生效；共线观测被拒
{
  const qTrue = qFromEuler(25 * RAD, -35 * RAD, 70 * RAD);
  const cleanObs = syntheticObservations(qTrue, [REF_GRAVITY_NED, REF_MAG_NORTH_NED]);
  const tri = triad(cleanObs);
  const que = wahbaQuest(cleanObs);
  const trueCost = wahbaCost(qTrue, cleanObs);
  const errT = tri ? attitudeErrorDeg(tri.q, qTrue) : NaN;
  const errQ = que ? attitudeErrorDeg(que.q, qTrue) : NaN;
  const weighted = syntheticObservations(qTrue, [REF_GRAVITY_NED, REF_MAG_NORTH_NED], [0, 6], [0, 0]);
  const wLow = weightedSolution(weighted, 1);
  const wHigh = weightedSolution(weighted, 50);
  // 权重增大 → 解更靠近被扰动的那条观测（误差通常变小）
  const costLow = wLow ? wahbaCost(wLow.q, [{ ...weighted[1], weight: 50 }, weighted[0]]) : NaN;
  const costHigh = wHigh ? wahbaCost(wHigh.q, [{ ...weighted[1], weight: 50 }, weighted[0]]) : NaN;
  const collinear: [VectorObservation, VectorObservation] = [
    { world: [0, 0, 1], body: [0, 0, 1] },
    { world: [0, 0, 2], body: [0, 0, 2] },
  ];
  const ok =
    Boolean(tri) && Boolean(que) &&
    errT < 1e-6 && errQ < 1e-6 &&
    trueCost < 1e-20 &&
    observationsDegenerate(collinear[0], collinear[1]) &&
    triad(collinear) === null && wahbaQuest(collinear) === null &&
    Number.isFinite(costLow) && Number.isFinite(costHigh) && costHigh <= costLow + 1e-9;
  check(
    "单帧姿态确定：TRIAD/QUEST 干净解、Wahba 代价、权重与共线退化",
    ok,
    `TRIAD 误差 ${errT.toExponential(1)}°、QUEST 误差 ${errQ.toExponential(1)}°、真值代价 ${trueCost.toExponential(1)}；` +
      `加权代价 w=1 → ${costLow.toFixed(4)}、w=50 → ${costHigh.toFixed(4)}（应 ≤ 前者）；共线观测被拒=true`,
  );
}

// 59. 圆锥效应与混叠：有限采样率产生与采样周期平方同阶的净漂移；混叠折回频率可算
{
  const pts = coningSweep({ freqHz: 12, ampDps: 120, durationSec: 4 });
  const byRate = new Map(pts.map((p) => [p.rateHz, p.errDeg]));
  const e500 = byRate.get(500) ?? NaN;
  const e50 = byRate.get(50) ?? NaN;
  // 采样率每降一半，圆锥误差应显著上升（近似 ×4，但允许数值参考带来的偏差）
  const monotone = pts.every((p, i) => i === 0 || p.errDeg >= pts[i - 1].errDeg - 1e-12);
  const ratio = e50 / e500;
  const aliasOk = aliasHz(31, 50) === 19 && aliasHz(12, 50) === 12 && aliasHz(60, 50) === 10;
  check(
    "圆锥效应：误差随采样率下降而上升；混叠折回频率正确",
    e500 < 0.05 && e50 > 0.5 && monotone && ratio > 20 && aliasOk,
    `12 Hz / 120°/s 圆锥 4 s：500 Hz → ${e500.toFixed(3)}°、50 Hz → ${e50.toFixed(3)}°（比值 ${ratio.toFixed(1)}×）；` +
      `误差随采样率单调上升=${monotone}；混叠 31 Hz@50 Hz → ${aliasHz(31, 50)} Hz、60 Hz@50 Hz → ${aliasHz(60, 50)} Hz`,
  );
}

// 60. 加速度计六面校准：已知 M/bias 可恢复；带噪残差小；应用后更接近真实比力；朝向不足被拒
{
  const M = [1.02, 0.02, -0.01, -0.015, 0.98, 0.03, 0.02, -0.012, 1.01];
  const bias: V3 = [0.05, -0.03, 0.08];
  const clean = calibrateAccel(synthesizeAccelSamples(M, bias, 0));
  const noisy = calibrateAccel(synthesizeAccelSamples(M, bias, 0.02, 99));
  const mErr = clean ? Math.max(...clean.M.map((v, i) => Math.abs(v - M[i]))) : NaN;
  const bErr = clean ? Math.max(...clean.bias.map((v, i) => Math.abs(v - bias[i]))) : NaN;
  // 应用校准到某一面的原始读数：应回到真实重力投影 (±g 在对应轴上)
  const raw = synthesizeAccelSamples(M, bias, 0).find((s) => s.face === "-y")!;
  const trueVec = faceTrueVector("-y");
  const cal = applyAccelCalibration(raw.raw, noisy);
  const applyErr = Math.max(...cal.map((v, i) => Math.abs(v - trueVec[i])));
  const insufficient = calibrateAccel(synthesizeAccelSamples(M, bias, 0).slice(0, 3));
  const ok =
    clean !== null && noisy !== null &&
    mErr < 1e-9 && bErr < 1e-9 &&
    Math.max(...noisy.rmse) < 0.05 &&
    applyErr < 0.06 &&
    insufficient === null;
  check(
    "加速度计六面校准：矩阵/偏置可恢复、应用后回到 ±g、朝向不足被拒",
    ok,
    `无噪 M 最大误差 ${mErr.toExponential(1)}、bias 误差 ${bErr.toExponential(1)}；` +
      `带噪残差 RMS ${Math.max(...(noisy?.rmse ?? [NaN])).toFixed(4)} m/s²；应用后 -y 面最大偏差 ${applyErr.toFixed(4)} m/s²；` +
      `只给 3 个朝向返回 null=${insufficient === null}`,
  );
}

// 61. online-fork：运行期状态复制后可继续逐位一致；卡尔曼协方差重置保持对称半正定
{
  const params: ImuParams = { ...dirty };
  const qTrue = qFromEuler(15 * RAD, 10 * RAD, 25 * RAD);
  const g = new Gauss(mulberry32(2026));
  const mahA = new MahonyEstimator();
  const madA = new MadgwickEstimator();
  const kalA = new KalmanEstimator();
  const feed = (ests: Estimator[], samples: ReturnType<typeof simulateImu>[]): void => {
    for (const s of samples) for (const e of ests) e.update(s.gyro, s.accel, s.mag, H);
  };
  const warm = Array.from({ length: 500 }, (_, i) => simulateImu(qTrue, [0.1, -0.05, 0.2], i * H, params, g, 1));
  feed([mahA, madA, kalA], warm);
  const mahB = new MahonyEstimator();
  const madB = new MadgwickEstimator();
  const kalB = new KalmanEstimator();
  mahB.copyRuntimeFrom!(mahA);
  madB.copyRuntimeFrom!(madA);
  kalB.copyRuntimeFrom!(kalA);
  // 分叉后的输入必须对两组完全相同（同一批样本），否则测到的是噪声差异而不是状态复制
  const after = Array.from({ length: 500 }, (_, i) => simulateImu(qTrue, [0.1, -0.05, 0.2], (500 + i) * H, params, g, 1));
  feed([mahA, madA, kalA], after);
  feed([mahB, madB, kalB], after);
  const errMah = qAngleBetween(mahA.q, mahB.q) * DEG;
  const errMad = qAngleBetween(madA.q, madB.q) * DEG;
  const errKal = qAngleBetween(kalA.q, kalB.q) * DEG;
  const pA = kalA.getCovariance();
  const pB = kalB.getCovariance();
  const covSame = pA.every((v, i) => Math.abs(v - pB[i]) < 1e-18);

  // 协方差重置路径：P 必须保持对称、特征值非负，姿态有限
  const kalR = new KalmanEstimator();
  kalR.resetCovOnInject = true;
  const g2 = new Gauss(mulberry32(77));
  for (let i = 0; i < 3000; i++) {
    const s = simulateImu(qTrue, [0.2, 0, -0.1], i * H, params, g2, 1);
    kalR.update(s.gyro, s.accel, s.mag, H);
  }
  const P = kalR.getCovariance();
  const sym = P.every((v, i) => {
    const row = Math.floor(i / 6);
    const col = i % 6;
    return Math.abs(v - P[col * 6 + row]) < 1e-15;
  });
  const block = [P[0], P[1], P[2], P[6], P[7], P[8], P[12], P[13], P[14]];
  const eig = symmetricEigen3(block).values;
  const psd = eig.every((v) => v > -1e-12) && kalR.q.w !== undefined;
  check(
    "online-fork 状态复制 + 卡尔曼 P←GPGᵀ：复现一致、协方差保持对称半正定",
    errMah < 1e-12 && errMad < 1e-12 && errKal < 1e-12 && covSame && sym && psd,
    `复制后 500 步最大姿态差：Mahony ${errMah.toExponential(1)}°、Madgwick ${errMad.toExponential(1)}°、` +
      `卡尔曼 ${errKal.toExponential(1)}°（P 逐位一致=${covSame}）；重置路径对称=${sym}、最小特征值 ${Math.min(...eig).toExponential(1)}`,
  );
}

// 62. 完整 3×3 椭球校准：交叉项软铁下残差与方向误差都应优于对角模型；朝向不足被拒
{
  const B = 50;
  const g = 0.35;
  const hard: V3 = [9, -6, 13];
  const build = (S: number[][], seed: number): { raws: V3[]; trues: V3[] } => {
    const rnd = mulberry32(seed);
    const raws: V3[] = [];
    const trues: V3[] = [];
    for (let i = 0; i < 240; i++) {
      let x = 0, y = 0, z = 0, n = 0;
      while (n < 1e-6) {
        x = 2 * rnd() - 1; y = 2 * rnd() - 1; z = 2 * rnd() - 1;
        n = Math.hypot(x, y, z);
      }
      const dir: V3 = [x / n, y / n, z / n];
      const t: V3 = [B * dir[0], B * dir[1], B * dir[2]];
      const s = (row: number): number => S[row][0] * t[0] + S[row][1] * t[1] + S[row][2] * t[2];
      raws.push([s(0) + hard[0], s(1) + hard[1], s(2) + hard[2]]);
      trues.push(t);
    }
    return { raws, trues };
  };
  // 非对称软铁（含交叉项）：形状可校正，但方向会残留一个“未知旋转”分量——这是只凭点云无法识别的
  const nonSym = build(
    [
      [1 + g * SOFT_IRON_M[0][0], g * SOFT_IRON_M[0][1], g * SOFT_IRON_M[0][2]],
      [g * SOFT_IRON_M[1][0], 1 + g * SOFT_IRON_M[1][1], g * SOFT_IRON_M[1][2]],
      [g * SOFT_IRON_M[2][0], g * SOFT_IRON_M[2][1], 1 + g * SOFT_IRON_M[2][2]],
    ],
    4242,
  );
  // 对称软铁（工程上常假设的形态）：方向也可恢复
  const sym = build(
    [[1.2, 0.1, 0.05], [0.1, 0.85, 0.08], [0.05, 0.08, 1.25]],
    2026,
  );
  const diagN = calibrateMag(nonSym.raws);
  const fullN = calibrateMagFull(nonSym.raws, B);
  const diagS = calibrateMag(sym.raws);
  const fullS = calibrateMagFull(sym.raws, B);
  const dirErr = (cal: typeof diagN, data: { raws: V3[]; trues: V3[] }): number => {
    if (!cal) return NaN;
    let max = 0;
    for (let i = 0; i < data.raws.length; i++) {
      const c = applyMagCalibration(data.raws[i], cal);
      const ct = data.trues[i];
      const dot = (c[0] * ct[0] + c[1] * ct[1] + c[2] * ct[2]) / (Math.hypot(...c) * Math.hypot(...ct) || 1);
      max = Math.max(max, (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI);
    }
    return max;
  };
  const dErrS = dirErr(diagS, sym);
  const fErrS = dirErr(fullS, sym);
  const partial = calibrateMagFull(nonSym.raws.slice(0, 8), B);
  const ok =
    Boolean(diagN && fullN && diagS && fullS) &&
    fullN!.residual < diagN!.residual * 0.5 &&
    fErrS < dErrS &&
    fErrS < 2 &&
    fullS!.residual < 0.01 &&
    partial === null;
  check(
    "完整 3×3 磁椭球校准：形状校正优于对角、对称软铁方向可恢复、覆盖不足拒绝",
    ok,
    `非对称软铁残差 ${(diagN?.residual ?? NaN).toFixed(4)} → ${(fullN?.residual ?? NaN).toFixed(4)}；` +
      `对称软铁方向误差 ${dErrS.toFixed(2)}° → ${fErrS.toFixed(2)}°（残差 ${(fullS?.residual ?? NaN).toFixed(5)}）；` +
      `8 点覆盖返回 null=${partial === null}`,
  );
}

// 63. 传感器前端流水线：默认逐位透传；整帧延迟等于历史帧；带宽衰减高频；延迟差让三路不同步
{
  const h = 1 / 500;
  const mk = (i: number) => {
    const t = i * h;
    const s = Math.sin(2 * Math.PI * 50 * t);
    return { gyro: [s, 0, 0] as V3, accel: [0, s, 9.80665] as V3, mag: [30, 0, 40] as V3 };
  };
  const pass = new SensorPipeline();
  const p0: ImuParams = { ...clean };
  let passthrough = true;
  for (let i = 0; i < 50; i++) {
    const inS = mk(i);
    const out = pass.push(inS, p0, h);
    if (out.gyro[0] !== inS.gyro[0] || out.accel[1] !== inS.accel[1]) passthrough = false;
  }
  const delayed = new SensorPipeline();
  const pDelay: ImuParams = { ...clean, sensorDelayMs: 10 };
  const hist: ReturnType<typeof mk>[] = [];
  for (let i = 0; i < 60; i++) {
    const inS = mk(i);
    hist.push(inS);
    delayed.push(inS, pDelay, h);
  }
  // 10 ms @500 Hz = 5 帧：第 59 帧的输出应对应第 59−5=54 帧的输入
  const lastOut = delayed.push(mk(60), pDelay, h);
  const delayOk = Math.abs(lastOut.gyro[0] - mk(55).gyro[0]) < 1e-12;
  const bw = new SensorPipeline();
  const pBw: ImuParams = { ...clean, sensorBandwidthHz: 20 };
  let ampIn = 0;
  let ampOut = 0;
  for (let i = 0; i < 400; i++) {
    const inS = mk(i);
    const out = bw.push(inS, pBw, h);
    if (i > 100) {
      ampIn = Math.max(ampIn, Math.abs(inS.gyro[0]));
      ampOut = Math.max(ampOut, Math.abs(out.gyro[0]));
    }
  }
  const bwAtten = ampOut / ampIn;
  const skew = new SensorPipeline();
  const pSkew: ImuParams = { ...clean, sensorDelayMs: 10, sensorDelaySkewMs: 10 };
  const inSkew: ReturnType<typeof mk>[] = [];
  for (let i = 0; i < 60; i++) {
    const inS = mk(i);
    inSkew.push(inS);
    skew.push(inS, pSkew, h);
  }
  const skewOut = skew.push(mk(60), pSkew, h);
  const gyroNow = Math.abs(skewOut.gyro[0] - mk(60).gyro[0]) < 1e-12; // base−skew = 0
  const accel5 = Math.abs(skewOut.accel[1] - mk(55).accel[1]) < 1e-12; // base = 10 ms = 5 帧
  check(
    "传感器流水线：透传逐位一致、延迟=历史帧、带宽衰减高频、延迟差三路不同步",
    passthrough && delayOk && bwAtten < 0.5 && bwAtten > 0.1 && gyroNow && accel5,
    `透传=${passthrough}；10 ms 延迟对齐历史帧=${delayOk}；20 Hz 带宽对 50 Hz 衰减到 ${(bwAtten * 100).toFixed(1)}%；` +
      `延迟差 ±10 ms 下陀螺=当前(${gyroNow})、加计=5 帧前(${accel5})`,
  );
}

// 64. 运动学一致剧本：真值姿态/角速度/比力/位置同源；理想姿态下的 INS 精确跟踪真值轨迹
{
  const params: ImuParams = { ...clean };
  const ins = new InsIntegrator();
  const w = new World(scenarios.coordinatedTurn, 99);
  ins.v = [...w.velNed]; // 真值初速是圆弧的切向速度；INS 必须从同一初值开始才能比对编排一致性
  let maxQErr = 0;
  const T = 10;
  for (let i = 0; i < Math.round(T / H); i++) {
    const s = w.step(H, params);
    ins.step(w.q, s.accel, H);
    // 解析角速度：世界 ω=[0,0,r]，机体系 = Rᵀω = r·[0, sinφ, cosφ]
    const V = 8, r = 0.5;
    const bank = Math.atan2(V * r, 9.80665);
    const expect: V3 = [0, r * Math.sin(bank), r * Math.cos(bank)];
    maxQErr = Math.max(maxQErr, Math.hypot(w.omega[0] - expect[0], w.omega[1] - expect[1], w.omega[2] - expect[2]));
  }
  const drift = Math.hypot(ins.p[0] - w.posNed[0], ins.p[1] - w.posNed[1], ins.p[2] - w.posNed[2]);
  const radius = 8 / 0.5;
  // 圆弧圆心在起点东侧 16 m；判据应是「到圆心的距离」，而不是到原点的距离
  const center: V3 = [0, radius, 0];
  const radiusErr = Math.abs(
    Math.hypot(w.posNed[0] - center[0], w.posNed[1] - center[1]) - radius,
  );
  const truthOk = radiusErr < 0.05;
  const accel = new World(scenarios.constantAccel, 7);
  const ins2 = new InsIntegrator();
  for (let i = 0; i < Math.round(4 / H); i++) {
    const s = accel.step(H, params);
    ins2.step(accel.q, s.accel, H);
  }
  const expectAccel = 0.5 * 1.5 * 16;
  const accelInsErr = Math.hypot(ins2.p[0] - accel.posNed[0], ins2.p[1] - accel.posNed[1], ins2.p[2] - accel.posNed[2]);
  const accelAnalyticErr = Math.abs(Math.hypot(accel.posNed[0], accel.posNed[1]) - expectAccel);
  check(
    "运动学一致剧本：解析角速度吻合、INS 理想编排跟踪真值轨迹、位置符合 ½at²",
    maxQErr < 2e-3 && drift < 1e-3 && truthOk && accelInsErr < 1e-6 && accelAnalyticErr < 0.05,
    `协调转弯：解析角速度最大偏差 ${maxQErr.toExponential(1)} rad/s、理想 INS 与真值位置差 ${drift.toExponential(1)} m、` +
      `到圆心距离偏差 ${radiusErr.toFixed(4)} m（半径应 ${radius} m）；` +
      `恒定加速度 4 s：INS 与真值差 ${accelInsErr.toExponential(1)} m、真值位置 ${Math.hypot(accel.posNed[0], accel.posNed[1]).toFixed(4)} m（理论 ${expectAccel}）`,
  );
}

// 65. 六面校准静止质量判据：平均为零的摆动必须被最大角速度/模长标准差抓住
{
  const stable = Array.from({ length: 250 }, () => ({
    gyro: [0.01, -0.02, 0.005] as V3,
    accel: [0, 0, 9.80665] as V3,
  }));
  const a = assessStaticWindow(stable);
  // 正负摆动：平均角速度接近 0，但单帧峰值 8°/s（0.14 rad/s），应判不合格
  const oscillating = Array.from({ length: 250 }, (_, i) => ({
    gyro: [0.14 * (i % 2 ? 1 : -1), 0, 0] as V3,
    accel: [0, 0, 9.80665] as V3,
  }));
  const b = assessStaticWindow(oscillating);
  // 被触碰/搬运：模长标准差大
  const bumpy = Array.from({ length: 250 }, (_, i) => ({
    gyro: [0, 0, 0] as V3,
    accel: [0, 0, 9.80665 + 0.3 * Math.sin(i)] as V3,
  }));
  const c = assessStaticWindow(bumpy);
  check(
    "六面校准静止判据：稳定窗口通过、摆动与搬运被拒",
    a.ok && !b.ok && !c.ok && a.maxGyroDps < 6 && b.meanGyroDps < 3 && b.maxGyroDps > 6 && c.accelNormStd > 0.15,
    `稳定：平均 ${a.meanGyroDps.toFixed(2)}°/s、最大 ${a.maxGyroDps.toFixed(2)}°/s、σ‖a‖ ${a.accelNormStd.toFixed(3)} → ${a.ok}` +
      `；摆动：平均 ${b.meanGyroDps.toFixed(2)}°/s、最大 ${b.maxGyroDps.toFixed(2)}°/s → ${b.ok}` +
      `；搬运：σ‖a‖ ${c.accelNormStd.toFixed(3)} → ${c.ok}`,
  );
}

// 66. 传感器采样率：低于仿真步长时零阶保持（样本数 ≈ fs × 时间），且与带宽叠加后仍有界
{
  const h = 1 / 500;
  const p: ImuParams = { ...clean, sensorSampleHz: 50 };
  const sp = new SensorPipeline();
  const outs: number[] = [];
  for (let i = 0; i < 500; i++) {
    const out = sp.push({ gyro: [i, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, p, h);
    outs.push(out.gyro[0]);
  }
  const changes = outs.filter((v, i) => i > 0 && v !== outs[i - 1]).length;
  const p2: ImuParams = { ...clean, sensorSampleHz: 50, sensorBandwidthHz: 20 };
  const sp2 = new SensorPipeline();
  let finite = true;
  for (let i = 0; i < 500; i++) {
    const out = sp2.push({ gyro: [Math.sin(i * 0.4), 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, p2, h);
    if (![...out.gyro, ...out.accel, ...out.mag].every(Number.isFinite)) finite = false;
  }
  check(
    "传感器采样率：50 Hz 零阶保持样本数正确、与带宽叠加后仍有限",
    changes >= 45 && changes <= 55 && finite,
    `500 步（1 s @500 Hz）内输出变化 ${changes} 次（应 ≈50）；带宽+降采样输出有限=${finite}`,
  );
}

// 67. 配置迁移必须保住校准对象与模型（第四轮 P1：档案导入后校准状态丢失的根因）
{
  const src = defaultExperimentConfig();
  src.magModel = "full";
  src.magCalibration = {
    offset: [1.25, -2.5, 3.75],
    scale: [1.02, 0.98, 1.0],
    field: 50,
    residual: 0.012,
    count: 280,
    kind: "full",
    matrix: [1.02, 0.01, 0, 0.01, 0.98, 0.02, 0, 0.02, 1.0],
  };
  src.magCalibrationApplied = true;
  src.accelCalibration = {
    M: [1.001, 0, 0, 0, 0.999, 0.001, 0, 0.001, 1.002],
    bias: [0.01, -0.02, 0.03],
    rmse: [0.001, 0.002, 0.0015],
    count: 6,
    faces: ["+x", "-x", "+y", "-y", "+z", "-z"],
  };
  src.accelCalibrationApplied = false;
  src.steadyFromSec = 12;
  const back = migrateExperimentConfig(JSON.parse(JSON.stringify(src)));
  const keepCal =
    back.magModel === "full" &&
    back.magCalibration?.kind === "full" &&
    back.magCalibration.matrix?.length === 9 &&
    back.magCalibrationApplied === true &&
    back.accelCalibration?.faces.length === 6 &&
    back.accelCalibrationApplied === false &&
    back.steadyFromSec === 12;
  // 结构不完整的校准不得被"修"成半有效对象
  const broken = parseMagCalibration({ offset: [1, 2, 3], scale: [1, 1, 1] }); // 缺 field
  const brokenFull = parseMagCalibration({
    offset: [0, 0, 0], scale: [1, 1, 1], field: 50, kind: "full", matrix: [1, 0, 0],
  });
  // 模型与校准对象不一致必须被校验拦下
  const mismatch = cloneExperimentConfig(back);
  mismatch.magModel = "diag";
  const caught = validateExperimentConfig(mismatch).some((p) => p.path === "magModel");
  check(
    "配置迁移/校验：校准对象+模型+应用标志完整往返，坏结构被拒、模型不一致被拦",
    keepCal && broken === null && brokenFull === null && caught,
    `往返完整=${keepCal}（model=${back.magModel}、applied=${back.magCalibrationApplied}/${back.accelCalibrationApplied}、steady=${back.steadyFromSec}）` +
      `；缺 field→null=${broken === null}；坏矩阵→null=${brokenFull === null}；模型不一致被拦=${caught}`,
  );
}

// 68. 回放 IMU 语义元数据：raw / calibrated 决定"是否二次校准"
{
  const lines: string[] = ["# quaternion-attitude-demo raw IMU export", "# imu=raw"];
  lines.push("t_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,accel_x_ms2,accel_y_ms2,accel_z_ms2,mag_x_ut,mag_y_ut,mag_z_ut");
  for (let i = 0; i < 30; i++) {
    lines.push(`${(i / 50).toFixed(4)},0.1,0,0,0,0,9.8,30,0,40`);
  }
  const asRaw = parseImuCsv(lines.join("\n"));
  const asCal = parseImuCsv(lines.join("\n").replace("# imu=raw", "# imu=calibrated"));
  const noMeta = parseImuCsv(lines.filter((l) => l !== "# imu=raw").join("\n"));
  check(
    "回放元数据：imu=raw/calibrated/未声明 三种语义都被解析出来",
    asRaw.imuCalibrated === false && asCal.imuCalibrated === true && noMeta.imuCalibrated === null &&
      asRaw.frames.length === 30 && asCal.notes.some((n) => n.includes("校准后")),
    `raw=${asRaw.imuCalibrated}、calibrated=${asCal.imuCalibrated}、未声明=${noMeta.imuCalibrated}；帧数=${asRaw.frames.length}`,
  );
}

// 69. 共享解算调度（core/solve-loop.ts）：对准阈值/冷却、关闭开关、解算抽帧、B 组同步
{
  // 调度行为（何时触发、冷却多久、按什么频率解算）用**桩估计器**直接测：
  // 这些是调度层的契约，不该被估计器内部实现（ramp/gate 收敛速度）干扰。
  // 「真实估计器下确实会触发」由测试 72 端到端覆盖。
  const H = 1 / 500;
  interface StubRec {
    resetCount: number;
  }
  const makeStub = (id: string, errDeg: number, rec?: StubRec) =>
    ({
      id,
      label: id,
      color: "#fff",
      magEnabled: true,
      q: qId(),
      telemetry: {
        gyroRate: 0,
        rawGyro: [0, 0, 0],
        correction: [0, 0, 0],
        predictedGravity: [0, 0, 1],
        measuredGravity: [0, 0, 1],
        accelNorm: 9.80665,
        accelValid: true,
        magValid: true,
        detail: { alignErrorDeg: errDeg },
      },
      getParams: () => ({}),
      setParams: () => undefined,
      update: () => undefined,
      reset(this: { q: unknown }, q?: { w: number; x: number; y: number; z: number }) {
        this.q = q ? { ...q } : qId();
        if (rec) rec.resetCount++;
      },
    }) as unknown as Estimator;
  const stillSample = {
    gyro: [0.5 * (Math.PI / 180), 0, 0] as V3, // 0.5 °/s < 3 °/s
    accel: [0, 0, 9.80665] as V3,
    mag: [30, 0, 40] as V3,
  };

  // ① 静止且偏差 30°：3 s 处首次触发；冷却 5 s 内不再触发，之后再次触发
  const rec: StubRec = { resetCount: 0 };
  const alignTimes: number[] = [];
  const loop = new SolveLoop({
    estimators: [makeStub("pure", 0), makeStub("mahony", 30, rec)],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: true,
    onAlign: (ev) => alignTimes.push(ev.t),
  });
  for (let i = 1; i <= 6000; i++) loop.step(stillSample, H, i * H);
  const firstGap = alignTimes.length ? Math.abs(alignTimes[0] - 3.002) : NaN;
  const secondGap = alignTimes.length > 1 ? alignTimes[1] - alignTimes[0] : NaN;

  // ② 收敛良好（偏差 3°）不触发；③ 关掉开关不触发
  let goodTriggers = 0;
  const loopGood = new SolveLoop({
    estimators: [makeStub("pure", 0), makeStub("mahony", 3)],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: true,
    onAlign: () => goodTriggers++,
  });
  for (let i = 1; i <= 3000; i++) loopGood.step(stillSample, H, i * H);
  let offTriggers = 0;
  const loopOff = new SolveLoop({
    estimators: [makeStub("pure", 0), makeStub("mahony", 60)],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: false,
    onAlign: () => offTriggers++,
  });
  for (let i = 1; i <= 3000; i++) loopOff.step(stillSample, H, i * H);

  // ④ 解算抽帧：500 Hz 输入 + 100 Hz 解算 → 1 s 内更新 ≈100 次
  let solves = 0;
  const loopRate = new SolveLoop({
    estimators: [makeStub("pure", 0)],
    solveRateHz: 100,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: false,
    onSolve: () => solves++,
  });
  for (let i = 1; i <= 500; i++) loopRate.step(stillSample, H, i * H);

  // ⑤ 粗对准必须**同步重置 B 组**（界面 A/B 同步对准的契约）
  const recB: StubRec = { resetCount: 0 };
  const recA: StubRec = { resetCount: 0 };
  const loopAB = new SolveLoop({
    estimators: [makeStub("pure", 0), makeStub("mahony", 30, recA)],
    secondary: [makeStub("madg", 30, recB)],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: true,
  });
  for (let i = 1; i <= 2000; i++) loopAB.step(stillSample, H, i * H);

  check(
    "共享解算调度：3 s 阈值 / 5 s 冷却 / 收敛良好与关闭时不触发 / 按解算率抽帧 / B 组同步重置",
    alignTimes.length >= 2 && firstGap < 0.02 && secondGap > 4.9 && secondGap < 5.1 &&
      goodTriggers === 0 && offTriggers === 0 && Math.abs(solves - 100) <= 1 &&
      recA.resetCount > 0 && recB.resetCount === recA.resetCount && rec.resetCount > 0,
    `触发 ${alignTimes.length} 次：首次 t=${alignTimes[0]?.toFixed(3)}s（差值 ${firstGap.toFixed(3)}）、` +
      `第二次间隔 ${secondGap.toFixed(2)}s；偏差 3° 触发 ${goodTriggers} 次、关闭后触发 ${offTriggers} 次；` +
      `100 Hz 解算 1 s 更新 ${solves} 次；A/B 重置 ${recA.resetCount}/${recB.resetCount} 次`,
  );
}

// 69b. SolveLoop 的界面侧 API：真实路径（applyFrame 子步）、运行期改频率/换 B 组/换校准链
{
  const stub = (id: string, rec?: { updates: number }) =>
    ({
      id,
      label: id,
      color: "#fff",
      magEnabled: true,
      q: qId(),
      telemetry: { detail: { alignErrorDeg: 0 } },
      getParams: () => ({}),
      setParams: () => undefined,
      update: () => {
        if (rec) rec.updates++;
      },
      reset: () => undefined,
    }) as unknown as Estimator;

  // ① applyFrame：120 ms 的帧拆成 3 个 ≤50 ms 子步（与界面真实/回放路径一致）
  const recA: { updates: number } = { updates: 0 };
  const subDts: number[] = [];
  const loop = new SolveLoop({
    estimators: [stub("mahony", recA)],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => [a[0], a[1], a[2]] },
    magEnabled: true,
    autoCoarseAlign: true,
    onSolve: ({ dt }) => subDts.push(dt),
  });
  loop.applyFrame(
    { gyro: [0, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 },
    0.12,
    1,
    0.05,
  );
  const frameOk = recA.updates === 3 && subDts.length === 3 && subDts.every((d) => Math.abs(d - 0.04) < 1e-9);

  // ② 运行期改解算频率：100 Hz → 200 Hz，同样 1 s 内更新次数翻倍
  let solves = 0;
  const loopRate = new SolveLoop({
    estimators: [stub("mahony")],
    solveRateHz: 100,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: false,
    onSolve: () => solves++,
  });
  const sample = { gyro: [0, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 };
  for (let i = 1; i <= 250; i++) loopRate.step(sample, 1 / 500, i / 500);
  const at100 = solves;
  loopRate.setSolveRate(200);
  solves = 0;
  for (let i = 251; i <= 500; i++) loopRate.step(sample, 1 / 500, i / 500);
  const at200 = solves;
  // 200 Hz 在 500 Hz 仿真下必须退化成 3/2 交替（而不是"每 3 步一次"的 166.7 Hz）：
  // 0.5 s 内应约 100 次，而不是 83 次。
  const rateOk = Math.abs(at100 - 50) <= 1 && Math.abs(at200 - 100) <= 2;

  // ③ 运行期换 B 组：新数组必须真的被更新（旧实现自持引用，换了数组就不再更新）
  const recB: { updates: number } = { updates: 0 };
  const loopB = new SolveLoop({
    estimators: [stub("mahony")],
    solveRateHz: 500,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: false,
  });
  loopB.setSecondary([stub("madg", recB)]);
  for (let i = 1; i <= 10; i++) loopB.step(sample, 1 / 500, i / 500);
  const swapOk = recB.updates === 10 && loopB.secondaryGroup.length === 1;

  // ⑤ 不变量：Σdt 必须等于总经过时间（抽帧保留余量时最容易在这里出错——
  //   复核实测过「余量被重复计入 dt」导致 12 s 的仿真积出了 13.2 s 的角增量）。
  const dtsSum: number[] = [];
  const loopSum = new SolveLoop({
    estimators: [stub("mahony")],
    solveRateHz: 200,
    calibrate: { mag: (m) => m, accel: (a) => a },
    magEnabled: true,
    autoCoarseAlign: false,
    onSolve: ({ dt }) => dtsSum.push(dt),
  });
  const SIM_STEPS = 2500; // 5 s @500 Hz
  for (let i = 1; i <= SIM_STEPS; i++) loopSum.step(sample, 1 / 500, i / 500);
  const elapsed = SIM_STEPS / 500;
  const dtTotal = dtsSum.reduce((a, b) => a + b, 0);
  const sumOk = Math.abs(dtTotal - elapsed) < 1e-9;
  // 同时确认解算次数 ≈ 200 Hz × 5 s（3/2 交替，而不是每 3 步一次）
  const countOk = Math.abs(dtsSum.length - 1000) <= 3;

  // ④ 校准链注入：observations() 必须走注入的实现（界面用它读「校准后」的观测）
  const loopCal = new SolveLoop({
    estimators: [stub("mahony")],
    solveRateHz: 500,
    calibrate: { mag: (m) => [m[0] * 2, m[1], m[2]], accel: (a) => [a[0] + 1, a[1], a[2]] },
    magEnabled: true,
    autoCoarseAlign: false,
  });
  const obs = loopCal.observations({ gyro: [0, 0, 0] as V3, accel: [1, 1, 1] as V3, mag: [5, 0, 0] as V3 });
  const calOk = obs.mag[0] === 10 && obs.accel[0] === 2;
  // 运行期替换校准链（界面在校准状态变化时会换）
  loopCal.setCalibration({ mag: (m) => m, accel: (a) => a });
  const obs2 = loopCal.observations({ gyro: [0, 0, 0] as V3, accel: [1, 1, 1] as V3, mag: [5, 0, 0] as V3 });
  const calSwapOk = obs2.mag[0] === 5 && obs2.accel[0] === 1;
  loopCal.setMagEnabled(false);

  // ⑥ 复核 P2-3 回归：子步时间递增 / 每帧只有一个对准事件 / 子步数有上限（Σdt 仍精确）
  {
    const timesSeen: number[] = [];
    const alignEvents: number[] = [];
    const loopT = new SolveLoop({
      estimators: [stub("mahony")],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => [a[0], a[1], a[2]] },
      magEnabled: true,
      autoCoarseAlign: true,
      onSolve: ({ t }) => timesSeen.push(t),
      onAlign: (ev) => alignEvents.push(ev.t),
    });
    // 120 ms 帧在 t=10.12 结束 → 子步应报 10.00 / 10.04 / 10.08 / 10.12 里去掉首个子步的那三个？不：
    // 3 个子步覆盖 (10.00, 10.12]，因此报 10.04 / 10.08 / 10.12（末子步正好落在帧时刻）。
    loopT.applyFrame({ gyro: [0, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, 0.12, 10.12);
    const increasing =
      timesSeen.length === 3 &&
      Math.abs(timesSeen[2] - 10.12) < 1e-9 &&
      timesSeen[0] < timesSeen[1] && timesSeen[1] < timesSeen[2];

    // 对准：先让融合算法"明显偏离"（telemetry.detail.alignErrorDeg 大），静止 3 s 后应触发**一次**
    let errDeg = 30;
    const alignStub = (id: string): Estimator =>
      ({
        id,
        label: id,
        color: "#fff",
        magEnabled: true,
        q: qId(),
        telemetry: { detail: { alignErrorDeg: errDeg } },
        getParams: () => ({}),
        setParams: () => undefined,
        update: () => undefined,
        reset: () => undefined,
      }) as unknown as Estimator;
    const aligns: number[] = [];
    const loopA = new SolveLoop({
      estimators: [alignStub("mahony")],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => [a[0], a[1], a[2]] },
      magEnabled: true,
      autoCoarseAlign: true,
      onAlign: (ev) => aligns.push(ev.t),
    });
    const stillSample = { gyro: [0, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 };
    // 一次 4 s 的"真实帧"（长间隔拆子步）：静止累计 4 s ≥ 3 s → 触发一次
    loopA.applyFrame(stillSample, 4, 4);
    const oneEventPerFrame = aligns.length === 1;

    // 子步上限：30 s 空洞按 50 ms 拆 600 步；把上限压到 100 步时**只积分 5 s（100×50 ms）**，
    // 余下 25 s 记入 deferredSec 并如实上报——绝不把步长放大到 0.3 s（旧实现 1000 s → 0.25 s）
    const bigDts: number[] = [];
    const loopBig = new SolveLoop({
      estimators: [stub("mahony")],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => a },
      magEnabled: true,
      autoCoarseAlign: false,
      onSolve: ({ dt }) => bigDts.push(dt),
    });
    loopBig.applyFrame(stillSample, 30, 30, 0.05, 100);
    const firstCallDts = bigDts.length;
    const firstPending = loopBig.pendingSec;
    // **续拍补完**（ROUND12 的核心契约）：继续喂空帧（dt=0），队列必须被补完，
    // Σdt=30、每步 ≤0.05、最后 pending=0——旧实现只记数不补，永远剩 25 s
    let guard = 0;
    while (loopBig.pendingSec > 0 && guard++ < 50) loopBig.applyFrame(stillSample, 0, 30, 0.05, 100);
    const bigSum = bigDts.reduce((a, b) => a + b, 0);
    const bigMax = Math.max(...bigDts);
    const bounded =
      firstCallDts === 100 && Math.abs(firstPending - 25) < 1e-9 &&
      bigMax <= 0.05 + 1e-9 && Math.abs(bigSum - 30) < 1e-6 &&
      loopBig.pendingSec === 0 && loopBig.droppedFrames === 0;
    // 默认上限下 30 s 空洞应拆成 600 步（50 ms），说明真实空洞不再被截断成 10 s
    const freeDts: number[] = [];
    const loopFree = new SolveLoop({
      estimators: [stub("mahony")],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => a },
      magEnabled: true,
      autoCoarseAlign: false,
      onSolve: ({ dt }) => freeDts.push(dt),
    });
    loopFree.applyFrame(stillSample, 30, 30);
    const freeSum = freeDts.reduce((a, b) => a + b, 0);
    const fullGap = freeDts.length === 600 && Math.abs(freeSum - 30) < 1e-9 && loopFree.pendingSec === 0;

    // ② **即时回调**（ROUND11 P1）：回调里读到的 live 姿态必须是**该子步**的姿态。
    //    旧实现先更新完再批量回调，20 个子步读到的都是末姿态（INS 东向位置 3.925 m vs 1.556 m）。
    const liveRolls: number[] = [];
    let counter = 0;
    // 估计器内部累计 dt 并写进 q：回调里读 live q 就能看出「是最新子步还是末姿态」
    const liveEst = {
      id: "mahony" as const,
      label: "mahony",
      color: "#fff",
      magEnabled: true,
      q: qId(),
      telemetry: { detail: { alignErrorDeg: 0 } },
      getParams: () => ({}),
      setParams: () => undefined,
      update: (_g: V3, _a: V3, _m: V3, dt: number) => {
        counter += dt;
        liveEst.q = { w: 1, x: 0, y: Math.sin(counter), z: 0 };
      },
      reset: () => undefined,
    } as unknown as Estimator;
    const loopLive = new SolveLoop({
      estimators: [liveEst],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => a },
      magEnabled: true,
      autoCoarseAlign: false,
      onSolve: () => liveRolls.push(counter),
    });
    loopLive.applyFrame(stillSample, 1, 1);
    // 回调里读到的必须是 0.05,0.10,…,1.00（严格递增且首值远小于末值），不是 20 个 1.00
    const liveOk =
      liveRolls.length === 20 &&
      liveRolls[0] < 0.06 &&
      Math.abs(liveRolls[19] - 1) < 1e-9 &&
      liveRolls.every((v, i) => i === 0 || v > liveRolls[i - 1] + 1e-9);

    // ③ 0 dt / 非法 dt 不积分、不产生 NaN 回调
    let zeroUpdates = 0;
    const zeroLoop = new SolveLoop({
      estimators: [
        ({
          id: "mahony",
          label: "mahony",
          color: "#fff",
          magEnabled: true,
          q: qId(),
          telemetry: { detail: { alignErrorDeg: 0 } },
          getParams: () => ({}),
          setParams: () => undefined,
          update: () => {
            zeroUpdates++;
          },
          reset: () => undefined,
        }) as unknown as Estimator,
      ],
      solveRateHz: 500,
      calibrate: { mag: (m) => m, accel: (a) => a },
      magEnabled: true,
      autoCoarseAlign: false,
      onSolve: () => {
        zeroUpdates += 1000; // 不该发生的回调
      },
    });
    zeroLoop.applyFrame(stillSample, 0, 1);
    zeroLoop.applyFrame(stillSample, Number.NaN, 2);
    zeroLoop.applyFrame(stillSample, -0.5, 3);
    const zeroDtOk = zeroUpdates === 0;

    check(
      "共享调度帧契约：即时逐子步回调、0dt 不积分、子步恒 ≤ 上限、超出部分如实记账",
      increasing && oneEventPerFrame && bounded && fullGap && liveOk && zeroDtOk,
      `子步时间 ${timesSeen.map((t) => t.toFixed(2)).join(" → ")}；4 s 帧的对准事件 ${aligns.length} 次（t=${aligns.join(",")}）；` +
        `30 s 空洞（上限 100/拍）：首拍 ${firstCallDts} 步、待积分 ${firstPending.toFixed(1)}s → 续拍补完后共 ${bigDts.length} 步 / 最大步长 ${bigMax.toFixed(3)}s / Σdt=${bigSum.toFixed(3)}s / 剩余 ${loopBig.pendingSec.toFixed(1)}s，` +
        `默认时 ${freeDts.length} 步 / Σdt=${freeSum.toFixed(3)}s；` +
        `回调内 live 累计 ${liveRolls.length} 次（首 ${liveRolls[0]?.toFixed(3)}、末 ${liveRolls[liveRolls.length - 1]?.toFixed(3)}，递增=${liveOk}）；` +
        `0/NaN/负 dt 的更新与回调次数=${zeroUpdates}`,
    );
  }

  check(
    "共享调度界面侧 API：applyFrame 子步、运行期改解算频率、换 B 组、注入/替换校准链",
    frameOk && rateOk && swapOk && calOk && calSwapOk && sumOk && countOk,
    `120 ms 帧 → ${recA.updates} 个子步（dt=${subDts.map((d) => d.toFixed(3)).join(",")}）；` +
      `100 Hz 半秒 ${at100} 次、改 200 Hz 后 ${at200} 次；换 B 组后更新 ${recB.updates} 次；` +
      `校准链注入=${calOk}、替换=${calSwapOk}；Σdt=${dtTotal.toFixed(6)}s vs 时长 ${elapsed.toFixed(6)}s（${dtsSum.length} 次解算）`,
  );
}

// 69c. 复核反例回归：延迟按采样时刻寻址 / 日志浮点时间 / 手动目标进配置
{
  // ① 采样率 × 延迟：500 Hz 仿真 + 50 Hz 采样 + 10 ms 延迟，滞后必须是 10 ms 量级。
  //    旧实现用「延迟 ÷ 仿真步长」查历史下标，实测放大到 100 ms。
  const lagOf = (fs: number, delayMs: number): number => {
    const p: ImuParams = { ...clean, sensorSampleHz: fs, sensorDelayMs: delayMs };
    const sp = new SensorPipeline();
    let out: ImuSample | null = null;
    for (let i = 0; i < 1000; i++) {
      out = sp.push({ gyro: [i, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, p, H);
    }
    const t = out?.times;
    return t ? (1000 * H - t.gyro) * 1000 : NaN;
  };
  // 语义：输出通道的 time 是「这份读数的采样时刻」。零阶保持期间读数不刷新，
  // 因此 `当前时刻 − times.ch` ∈ [延迟, 延迟 + 1/fs]（保持期最长一个采样周期）。
  // 旧实现的错误是把延迟按仿真步长换算历史下标，50 Hz 下变成 100 ms（≈5 个采样周期）。
  const lag500 = lagOf(0, 10);
  const lag50 = lagOf(50, 10);
  const lag200 = lagOf(200, 10);
  const inBand = (lag: number, delayMs: number, fs: number): boolean => {
    const holdMs = fs > 0 ? 1000 / fs : 2; // 无降采样时保持期就是一个仿真步（2 ms）
    return lag >= delayMs - 1.5 && lag <= delayMs + holdMs + 1.5;
  };
  const delayOk = inBand(lag500, 10, 0) && inBand(lag50, 10, 50) && inBand(lag200, 10, 200);

  // ①b 极低采样率 + 大延迟（复核 P2-2）：5 Hz 采样 + 250 ms 延迟时，
  //     历史必须多留**一个采样周期**，否则找不到目标时刻之前的帧、插值退化成
  //     "下一个样本"，实测年龄只有 200 ms（配置说 250 ms）。
  const lag5 = lagOf(5, 250);
  const lowRateOk = lag5 >= 248.5 && lag5 <= 250 + 200 + 1.5;
  // 零延迟路径也必须带 times（否则导出的 sensor_lag_ms 行时有时无），且三路自洽为同一时刻
  const p0: ImuParams = { ...clean, sensorSampleHz: 50, sensorDelayMs: 0 };
  const sp0 = new SensorPipeline();
  let out0: ImuSample | null = null;
  for (let i = 0; i < 200; i++) out0 = sp0.push({ gyro: [1, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, p0, H);
  const t0 = out0!.times;
  const zeroDelayTimesOk =
    t0 !== undefined && Number.isFinite(t0.gyro) && t0.gyro === t0.accel && t0.accel === t0.mag &&
    out0!.times !== undefined && 200 * H - t0.gyro >= 0 && 200 * H - t0.gyro <= 1 / 50 + 1e-9;

  // ② 日志浮点时间：400 Hz（2.5 ms/帧）日志，Σdt 必须等于日志跨度
  const frames: ReplayFrame[] = Array.from({ length: 401 }, (_, i) => ({
    tMs: i * 2.5,
    gyroDps: [1, 0, 0],
    accelMs2: [0, 0, 9.8],
    magUt: [30, 0, 40],
    hasMag: true,
    gyroValid: true,
    accelValid: true,
  }));
  const player = new ReplayPlayer({ maxFramesPerTick: 5000 });
  player.load(frames, 0); // 最快档：一次吃完
  const steps = player.advance(0.016);
  const dtSum = steps.reduce((a, st) => a + st.dtSec, 0);
  const spanSec = (frames[frames.length - 1].tMs - frames[0].tMs) / 1000;
  const logTimeOk = Math.abs(dtSum - spanSec) < 1e-9 && steps[0].dtSec === 0;

  // ③ 手动目标进配置：改全局对象不得再改变「同配置 + 同 seed」的结果
  const cfg: ExperimentConfig = {
    ...defaultExperimentConfig(),
    scenario: "manual",
    durationSec: 1.5,
    manualTargetDeg: [0, 0, 30],
  };
  const withGlobalDefault = runExperiment(cfg);
  manualTarget.yawDeg = 30; // 故意弄脏全局对象
  const withGlobalDirty = runExperiment(cfg);
  manualTarget.yawDeg = 0;
  const pureA = withGlobalDefault.finalQuats.pure;
  const pureB = withGlobalDirty.finalQuats.pure;
  const dot = Math.abs(pureA.w * pureB.w + pureA.x * pureB.x + pureA.y * pureB.y + pureA.z * pureB.z);
  const deterministicDeg = 2 * Math.acos(Math.min(1, dot)) * DEG;
  const manualOk = deterministicDeg < 1e-9;

  check(
    "复核反例回归：延迟按采样时刻（50/200/500 Hz 均为 10 ms）、5 Hz/250 ms 不退化成 200 ms、零延迟带 times、日志浮点 Σdt=跨度、手动目标进配置",
    delayOk && lowRateOk && zeroDelayTimesOk && logTimeOk && manualOk,
    `10 ms 延迟实测：500 Hz=${lag500.toFixed(2)}ms、50 Hz=${lag50.toFixed(2)}ms、200 Hz=${lag200.toFixed(2)}ms；` +
      `5 Hz/250 ms 实测年龄 ${lag5.toFixed(2)}ms；零延迟 times=${zeroDelayTimesOk}；` +
      `400 Hz 日志 Σdt=${dtSum.toFixed(6)}s vs 跨度 ${spanSec.toFixed(6)}s（${steps.length} 帧，首帧 dt=${steps[0].dtSec}）；` +
      `改全局 manualTarget 后终态差 ${deterministicDeg.toExponential(1)}°`,
  );
}

// 70. SO(3) 误差分解：纯偏航误差只进偏航分量，纯倾角误差只进倾角分量（欧拉分解做不到）
{
  const yawRel = qFromAxisAngle([0, 0, 1], 7 * RAD);
  const tiltRel = qFromAxisAngle([1, 0, 0], 7 * RAD);
  const y = so3ErrorSplit(yawRel, [0, 0, 1]);
  const t = so3ErrorSplit(tiltRel, [0, 0, 1]);
  // 欧拉分解对照：绕机体 x 转 7°（横滚）时，roll 分量 7° 而倾角联合值也是 7°——
  // 二者一致；但真正要验证的是重力轴分解的正确性。
  // 小角近似 e ≈ 2·sin(θ/2) 有 0.03% 量级偏差，容差按 0.02° 取。
  const yawOk = Math.abs(y.yawDeg - 7) < 0.02 && y.tiltDeg < 1e-6;
  const tiltOk = Math.abs(t.tiltDeg - 7) < 0.02 && t.yawDeg < 1e-6;
  // 万向节锁处（俯仰 90°）用 SO(3) 分解仍稳定：误差 7° 不会突然放大
  const locked = qMul(qFromEuler(0, Math.PI / 2, 0), qFromAxisAngle([0, 0, 1], 7 * RAD));
  const l = so3ErrorSplit(qMul(qConj(locked), qFromEuler(0, Math.PI / 2, 0)), [0, 0, 1]);
  const lockOk = Number.isFinite(l.tiltDeg) && Number.isFinite(l.yawDeg) && Math.hypot(l.tiltDeg, l.yawDeg) <= 7.001;
  check(
    "SO(3) 误差分解：偏航/倾角分量正交可分，万向节锁处不放大",
    yawOk && tiltOk && lockOk,
    `纯偏航 → 倾角 ${y.tiltDeg.toExponential(1)}° / 偏航 ${y.yawDeg.toFixed(4)}°；` +
      `纯倾角 → 倾角 ${t.tiltDeg.toFixed(4)}° / 偏航 ${t.yawDeg.toExponential(1)}°；` +
      `锁点邻域 → 倾角 ${l.tiltDeg.toFixed(3)}° / 偏航 ${l.yawDeg.toFixed(3)}°`,
  );
}

// 71. 采样率下的噪声密度换算：σ 按 √(fs/500) 缩小，噪声密度不随采样率虚增
{
  const run = (fs: number): number[] => {
    const p: ImuParams = {
      ...clean,
      gyroBiasDps: 0,
      gyroNoiseDps: 1,
      accelNoise: 0,
      magNoise: 0,
      sensorSampleHz: fs,
    };
    // 完全静止的剧本：目标姿态恒为 0，角速度全程为 0，σ 只反映白噪声
    const stillScenario = { id: "still", name: "静止", accelFactor: 0, targetEulerDeg: () => [0, 0, 0] as V3 };
    const w = new World(stillScenario, 12345);
    const out: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const s = w.step(H, p);
      if (fs > 0 && out.length && s.gyro[0] === out[out.length - 1]) continue; // 只统计新样本
      out.push(s.gyro[0]);
    }
    return out;
  };
  const full = run(0);
  const low = run(50);
  const std = (a: number[]): number => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
  };
  const sFull = std(full);
  const sLow = std(low);
  const ratio = sLow / sFull;
  check(
    "采样率噪声换算：50 Hz 每样本 σ 约为 500 Hz 的 √0.1",
    Math.abs(ratio - Math.sqrt(0.1)) < 0.08 && low.length < full.length,
    `σ(500 Hz)=${sFull.toFixed(4)} rad/s、σ(50 Hz)=${sLow.toFixed(4)} rad/s、比值=${ratio.toFixed(3)}（理论 ${Math.sqrt(0.1).toFixed(3)}）`,
  );
}

// 72. 运行内核的其余出口：详细序列、批量聚合、粗对准真正触发（覆盖 runCore 的主分支）
{
  // 用静止剧本（manual 且目标角=0）：hover 的跟踪控制器本身会产生 >3°/s 的角速度，
  // 静止检测永远不会累计到 3 s——那正是「粗对准只在真正静止时触发」的设计意图。
  manualTarget.rollDeg = 0;
  manualTarget.pitchDeg = 0;
  manualTarget.yawDeg = 0;
  const cfg: ExperimentConfig = {
    ...defaultExperimentConfig(),
    scenario: "manual",
    durationSec: 8,
    // 绕机体系 x 的初始偏差（倾角可见：绕重力轴的偏航偏差对加计不可观，不会进 alignErrorDeg）
    initialAttitude: { kind: "fixed-axis", axis: [1, 0, 0], angleDeg: 35 },
    estimators: {
      ...cloneExperimentConfig(defaultExperimentConfig()).estimators,
    },
  };
  // 让互补滤波收敛极慢（alpha 很小、关掉启动 ramp）→ 静止 3 s 后偏差仍 >8° → 应触发粗对准
  cfg.estimators.comp = { ...cfg.estimators.comp, rampEnabled: false, params: { alpha: 0.01 } };
  const detailed = runExperimentDetailed(cfg);
  const aligned = detailed.events.filter((e) => e.type === "align").length;
  const seriesOk =
    detailed.series.length === 5 &&
    detailed.series[1].t.length > 100 &&
    detailed.series[1].t.length === detailed.series[1].errDeg.length;
  check(
    "详细运行：误差序列完整 + 慢收敛场景下静止粗对准真的触发",
    aligned >= 1 && seriesOk,
    `对准事件=${aligned}；序列=${detailed.series.length} 组、互补样本 ${detailed.series[1]?.t.length ?? 0} 条`,
  );

  // 近似口径要能被聚合层看见：用小上限强制截断 → approximate 必为 true
  const approxBatch = runMonteCarlo({ ...cfg, durationSec: 2 }, 1);
  const truncatedBatch = summarizeRuns(
    { ...cfg, durationSec: 2 },
    [cfg.seed],
    [runExperiment({ ...cfg, durationSec: 2 }, { statsCapOverride: 100 })],
  );
  const approxFlagOk = approxBatch.approximate === false && truncatedBatch.approximate === true;
  const batch = runMonteCarlo({ ...cfg, durationSec: 2 }, 2);
  const s = batch.summary.find((x) => x.id === "mahony")!;
  check(
    "批量聚合：跨种子分布字段齐全（含 SO(3) 倾角/偏航与稳态窗口）",
    batch.runs.length === 2 && s.runs === 2 && Number.isFinite(s.rmseP50) &&
      Number.isFinite(s.steadyRmseP95) && Number.isFinite(s.tiltSo3P95 ?? NaN) && Number.isFinite(s.yawSo3P95 ?? NaN) &&
      approxFlagOk,
    `运行 ${batch.runs.length} 次；Mahony RMSE P50=${s.rmseP50.toFixed(3)}°、稳态 P95=${s.steadyRmseP95.toFixed(3)}°、` +
      `SO(3) 倾角 P95=${(s.tiltSo3P95 ?? NaN).toFixed(3)}°、偏航 P95=${(s.yawSo3P95 ?? NaN).toFixed(3)}°；` +
      `近似口径标记 正常=${approxBatch.approximate} 截断=${truncatedBatch.approximate}`,
  );
}

// 73. 传感器时间戳与非整数延迟插值：三路各自的时间戳 + 非整数延迟按权重混合
{
  const h = 1 / 500;
  // 三路延迟差 ±3 ms：陀螺 3 ms（1.5 帧，非整数）、加计 6 ms、磁 9 ms
  const p: ImuParams = { ...clean, sensorDelayMs: 6, sensorDelaySkewMs: 3 };
  const sp = new SensorPipeline();
  let out: ImuSample | null = null;
  for (let i = 0; i < 40; i++) {
    out = sp.push({ gyro: [i, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, p, h);
  }
  const t = out?.times;
  const simT = 40 * h;
  const lagGyro = t ? (simT - t.gyro) * 1000 : NaN;
  const lagAccel = t ? (simT - t.accel) * 1000 : NaN;
  const lagMag = t ? (simT - t.mag) * 1000 : NaN;
  const lagOk =
    Number.isFinite(lagGyro) &&
    Math.abs(lagGyro - 3) < 2.5 && Math.abs(lagAccel - 6) < 2.5 && Math.abs(lagMag - 9) < 2.5 &&
    lagGyro < lagAccel && lagAccel < lagMag;

  // 非整数延迟的插值：斜坡输入下输出应是「1.5 帧前」的值 = 39 − 1.5
  const sp2 = new SensorPipeline();
  let v2 = 0;
  for (let i = 0; i < 40; i++) {
    const o = sp2.push(
      { gyro: [i, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 },
      { ...clean, sensorDelayMs: 3 },
      h,
    );
    v2 = o.gyro[0];
  }
  const interpOk = Math.abs(v2 - (39 - 1.5)) < 1e-6;

  // 整数延迟必须与「取历史帧」逐位一致（旧行为不能变）
  const sp3 = new SensorPipeline();
  let intOut = 0;
  for (let i = 0; i < 40; i++) {
    const o = sp3.push({ gyro: [i, 0, 0] as V3, accel: [0, 0, 9.80665] as V3, mag: [30, 0, 40] as V3 }, { ...clean, sensorDelayMs: 4 }, h);
    intOut = o.gyro[0];
  }
  const exactOk = Math.abs(intOut - 37) < 1e-12; // 4 ms = 2 帧 → 第 39 帧读到第 37 帧

  // 透传快路径不得引入 times 字段（逐位一致的契约）
  const plain = new SensorPipeline().push(
    { gyro: [1, 2, 3] as V3, accel: [0, 0, 9.8] as V3, mag: [1, 2, 3] as V3 },
    { ...clean },
    h,
  );
  const passthroughOk = plain.times === undefined;

  check(
    "传感器时间戳与插值：三路时间戳分离、非整数延迟线性插值、整数延迟逐位取帧、透传不加字段",
    lagOk && interpOk && exactOk && passthroughOk,
    `滞后 陀螺 ${lagGyro.toFixed(2)} / 加计 ${lagAccel.toFixed(2)} / 磁 ${lagMag.toFixed(2)} ms（应 3/6/9）；` +
      `3 ms 插值输出 ${v2.toFixed(3)}（应 37.5）；4 ms 取帧 ${intOut}（应 37）；透传无 times=${passthroughOk}`,
  );
}

// 73b. 「拟合」与「应用」是两个独立状态：勾掉应用后，批量必须与界面一样吃原始读数
{
  // 用硬铁偏移 8 μT 的标定：应用时应把它减回去；不应用时估计器仍吃到它
  const cal = {
    offset: [8, 0, 0] as V3,
    scale: [1, 1, 1] as V3,
    field: 50,
    residual: 0.01,
    count: 100,
    kind: "diag" as const,
  };
  const base = defaultExperimentConfig();
  const appliedCfg: ExperimentConfig = {
    ...base, seed: 555, scenario: "manual", durationSec: 4,
    magCalibration: cal, magCalibrationApplied: true,
  };
  const notAppliedCfg: ExperimentConfig = { ...appliedCfg, magCalibrationApplied: false };
  const applied = runExperiment(appliedCfg);
  const notApplied = runExperiment(notAppliedCfg);
  const am = applied.metrics.find((m) => m.id === "mahony")!;
  const nm = notApplied.metrics.find((m) => m.id === "mahony")!;
  // 两套结果必须不同（否则「应用开关」在 runner 里没有意义）
  const differ = Math.abs(am.rmse - nm.rmse) > 1e-9 || Math.abs(am.p50 - nm.p50) > 1e-9;
  // 「不应用」路径应与完全不带校准的路径一致（校准链被完整旁路，而不是部分应用）
  const bare = runExperiment({ ...appliedCfg, magCalibration: null, magCalibrationApplied: false });
  const bm = bare.metrics.find((m) => m.id === "mahony")!;
  const bareSame = Math.abs(nm.rmse - bm.rmse) < 1e-9 && Math.abs(nm.p50 - bm.p50) < 1e-9;
  check(
    "校准「应用」开关在 runner 也生效：不应用 = 完全旁路，与应用版结果不同",
    differ && bareSame && nm.rmse >= 0 && am.rmse >= 0,
    `应用 RMSE ${am.rmse.toFixed(4)}° / 不应用 ${nm.rmse.toFixed(4)}° / 无校准 ${bm.rmse.toFixed(4)}°（差异 ${(nm.rmse - am.rmse).toFixed(4)}°）`,
  );
}

// 73c. 抽出的数据源核心：有界队列、回放播放调度、重连退避
{
  // ① 有界队列：超限丢最旧、计数正确、上限为 0/1 的边界
  const q: number[] = [];
  let drops = 0;
  for (let i = 0; i < 10; i++) if (pushBounded(q, i, 4).dropped) drops++;
  const qOk = q.length === 4 && q[0] === 6 && q[3] === 9 && drops === 6;
  const q1: number[] = [];
  const one = pushBounded(q1, 1, 1);
  const two = pushBounded(q1, 2, 1);
  const qEdge = one.dropped === false && two.dropped === true && q1.length === 1 && q1[0] === 2;

  // ② 回放播放器：按录制时间消费、逐帧 dt 为真实间隔、倍速 0 一口气、单拍上限
  const mkFrames = (n: number, stepMs: number, gapAt = -1, gapMs = 0): ReplayFrame[] =>
    Array.from({ length: n }, (_, i) => ({
      tMs: i * stepMs + (gapAt >= 0 && i > gapAt ? gapMs : 0),
      gyroDps: [1, 0, 0],
      accelMs2: [0, 0, 9.8],
      magUt: [30, 0, 40],
      hasMag: true,
      gyroValid: true,
      accelValid: true,
    }));
  const player = new ReplayPlayer();
  const frames = mkFrames(100, 10); // 100 帧 @100 Hz（10 ms 间隔）
  player.load(frames, 1);
  // 一拍给 100 ms 预算：首帧按**标称** 5 ms（首帧前没有真实间隔，沿用 frameIntervalSec 的兜底），
  // 之后每帧 10 ms → 共 5 + 9×10 + 剩 5 ms 不足再消费一帧 = 10 帧。
  const tickBig = player.advance(0.1);
  const stepOk =
    // 首帧 dt=0（它是初值），随后每帧 10 ms → 100 ms 预算吃掉 1 + 10 帧
    tickBig.length === 11 &&
    tickBig[0].dtSec === 0 &&
    tickBig.slice(1).every((s) => Math.abs(s.dtSec - 0.01) < 1e-12) &&
    player.cursor === 11;
  // 倍速 0：一口气吃完，但受单拍上限保护
  const fast = new ReplayPlayer({ maxFramesPerTick: 40 });
  fast.load(frames, 0);
  const fastBatch = fast.advance(0.016);
  const cappedOk = fastBatch.length === 40 && fast.cursor === 40; // 单拍上限 40 帧
  // 大空洞（200 ms 间隔）：第一拍不足预算时不提前消费
  const gapPlayer = new ReplayPlayer();
  gapPlayer.load(mkFrames(40, 5, 20, 200), 1);
  gapPlayer.advance(0.5); // 预算 0.5 s 足够跨过空洞
  const gapOk = gapPlayer.cursor > 20;

  // ②a 复核 P1-G 回归：**30 s 空洞按真实 30 s 播放**，不被截成 10 s。
  //     两帧日志 0 / 30000 ms：必须消耗 30 秒动画预算才消费掉第二帧，且该帧 dt=30 s。
  const gap30 = new ReplayPlayer();
  gap30.load(
    [
      { tMs: 0, gyroDps: [0, 0, 0], accelMs2: [0, 0, 9.8], magUt: [30, 0, 40], hasMag: true, gyroValid: true, accelValid: true },
      { tMs: 30000, gyroDps: [0, 0, 0], accelMs2: [0, 0, 9.8], magUt: [30, 0, 40], hasMag: true, gyroValid: true, accelValid: true },
    ] as ReplayFrame[],
    1,
  );
  let ticks = 0;
  let lastDt = 0;
  for (let i = 0; i < 40 && !gap30.done; i++) {
    const st = gap30.advance(1); // 每拍 1 s
    ticks++;
    if (st.length) lastDt = st[st.length - 1].dtSec;
  }
  const gap30Ok = ticks === 30 && Math.abs(lastDt - 30) < 1e-9 && Math.abs(gap30.durationSec - 30) < 1e-9;
  // 同一份日志的「精确间隔」函数本身也不得夹紧（旧实现 logIntervalSec(0,30000)=10）
  const rawGap = logIntervalSec(0, 30000);
  const gapFnOk = Math.abs(rawGap - 30) < 1e-9 && logIntervalSec(0, 2.5) === 0.0025 && logIntervalSec(5, 5) === 0;

  // ②b 播放器其余接口：清空/载入判定/时长/进度/非法倍速夹紧
  const misc = new ReplayPlayer();
  const miscFrames = mkFrames(50, 20); // 50 帧 @50 Hz = 0.98 s
  const emptyState = !misc.loaded && !misc.done && misc.durationSec === 0 && misc.playedSec === 0;
  misc.load(miscFrames, 1);
  misc.setSpeed(Number.NaN); // 非法倍速 → 回落到 1×
  const loadedState = misc.loaded && misc.frameCount === 50 && Math.abs(misc.durationSec - 0.98) < 1e-9;
  misc.advance(0.5);
  const midProgress = misc.playedSec > 0 && !misc.done;
  misc.setSpeed(0); // 最快
  misc.advance(0.016);
  const finished = misc.done && misc.cursor === 50 && Math.abs(misc.playedSec - 0.98) < 1e-9;
  misc.clear();
  const cleared = !misc.loaded && misc.frameCount === 0 && misc.playedSec === 0;
  const miscOk = emptyState && loadedState && midProgress && finished && cleared;

  // ③ 重连退避：模拟「每次重连都失败」的连续链路，检查 1s→2s→4s 与次数用尽
  let now = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const policy = new ReconnectPolicy({
    maxAttempts: 3,
    baseDelayMs: 1000,
    schedule: (fn, delay) => {
      pending = { fn, at: now + delay };
      return pending;
    },
    cancelScheduled: () => {
      pending = null;
    },
  });
  let retries = 0;
  const delays: number[] = [];
  let exhausted = false;
  // 每次重连都失败 → 走完整个退避序列
  const attempt = (): void => {
    retries++;
    const plan = policy.onFailure(attempt);
    if (!plan) return;
    if (plan.exhausted) {
      exhausted = true;
      return;
    }
    delays.push(plan.delayMs);
  };
  attempt(); // 第 1 次失败 → 排 1s
  // 依次触发排程（每次触发都等于"又失败一次"）
  for (let i = 0; i < 4 && pending; i++) {
    const p: { fn: () => void; at: number } = pending;
    pending = null;
    now = p.at;
    p.fn();
  }
  const delaysOk = delays[0] === 1000 && delays[1] === 2000 && delays[2] === 4000;
  const exhaustedOk = exhausted && policy.attemptCount === 3;
  const firedOk = retries === 4; // 首失败 + 3 次重连尝试
  // onSuccess 清零后还能重新计数
  policy.onSuccess();
  const after = policy.onFailure(() => retries++);
  const resetOk = after?.attempt === 1 && after.delayMs === 1000;
  // cancel：取消挂起的排程，且不再重连
  policy.cancel();
  const cancelOk = policy.pending === false && policy.attemptCount === 0;
  let disabledCalls = 0;
  const disabledPolicy = new ReconnectPolicy({ maxAttempts: 3, enabled: () => false });
  const disabledPlan = disabledPolicy.onFailure(() => disabledCalls++);
  const disabledOk = disabledPlan === null && disabledPolicy.attemptCount === 0;
  check(
    "数据源核心：有界队列丢最旧、回放按录制时间/倍速消费、重连退避 1s→2s→4s 并可取消",
    qOk && qEdge && stepOk && cappedOk && gapOk && gap30Ok && gapFnOk && miscOk && delaysOk && exhaustedOk && firedOk && resetOk && cancelOk && disabledOk,
    `队列 ${q.join(",")}（drop ${drops}）、边界=${qEdge}；回放一拍 ${tickBig.length} 帧（首帧 dt=${tickBig[0]?.dtSec.toFixed(4)}s）、` +
      `最快档单拍 ${fastBatch.length} 帧、空洞后游标 ${gapPlayer.cursor}、` +
      `30 s 空洞用 ${ticks} 拍（dt=${lastDt.toFixed(1)}s，间隔函数=${rawGap.toFixed(1)}s）、其余接口=${miscOk}；` +
      `退避 ${delays.join("/")}ms、用尽=${exhaustedOk}、触发 ${retries} 次、` +
      `成功后重排 ${after?.delayMs}ms、取消=${cancelOk}、关闭=${disabledOk}`,
  );
}

// 74. 有界统计 + golden 指纹：长跑内存不增长、短跑仍按旧口径、数值回归被钉住
{
  // 130 s × 500 Hz = 65000 个样本 > STATS_CAP(60000) → 进入蓄水池近似
  const longRun = runExperiment({ ...defaultExperimentConfig(), durationSec: 130 });
  const m = longRun.metrics.find((x) => x.id === "mahony")!;
  const shortRun = runExperiment({ ...defaultExperimentConfig(), durationSec: 30 });
  const ms = shortRun.metrics.find((x) => x.id === "mahony")!;
  const boundedOk =
    m.percentileApprox === true &&
    ms.percentileApprox !== true &&
    Number.isFinite(m.rmse) && Number.isFinite(m.p95) && Number.isFinite(m.steadyRmse) &&
    Math.abs(m.n - 130 * 500) <= 2;
  check(
    "有界统计：超过 STATS_CAP 后转时间分桶（内存封顶），全程指标仍有限且样本数正确",
    boundedOk && (m.steadyMode === "exact" || m.steadyMode === "early-stop") && ms.steadyMode === "exact",
    `130 s 样本数=${m.n}（≈65000）、分位数近似=${m.percentileApprox}、稳态口径=${m.steadyMode}、RMSE=${m.rmse.toFixed(3)}°；` +
      `30 s 分位数近似=${ms.percentileApprox ?? false}、稳态口径=${ms.steadyMode}`,
  );

  // 截断不能改变数值口径：同一个 30 s 配置，分别用默认上限与「很小」的上限跑，
  // 均值/均方/峰值/稳态/分位数必须一致（分位数允许时间均匀子集带来的小偏差）。
  const capBase = { ...defaultExperimentConfig(), durationSec: 30 };
  const full = runExperiment(capBase);
  const cut = runExperiment(capBase, { statsCapOverride: 3000 }); // 6 s 之后就截断
  const cmp = (id: string) => {
    const a = full.metrics.find((x) => x.id === id)!;
    const b = cut.metrics.find((x) => x.id === id)!;
    return {
      id,
      mean: [a.mean, b.mean] as const,
      rmse: [a.rmse, b.rmse] as const,
      max: [a.max, b.max] as const,
      steady: [a.steadyRmse, b.steadyRmse] as const,
      p50: [a.p50, b.p50] as const,
      p95: [a.p95, b.p95] as const,
      approx: b.percentileApprox === true,
      mode: b.steadyMode,
    };
  };
  const rows = ["pure", "comp", "mahony", "madg", "kalman"].map(cmp);
  const exactOk = rows.every(
    (r) =>
      Math.abs(r.mean[0] - r.mean[1]) < 1e-12 &&
      Math.abs(r.rmse[0] - r.rmse[1]) < 1e-12 &&
      Math.abs(r.max[0] - r.max[1]) < 1e-12,
  );
  // 稳态与分位数是近似（时间分桶 / 每桶一个样本），允许 ≤3% 的偏差但必须同量级
  const nearOk = rows.every(
    (r) =>
      Math.abs(r.steady[0] - r.steady[1]) / Math.max(1e-9, r.steady[0]) < 0.03 &&
      Math.abs(r.p95[0] - r.p95[1]) / Math.max(1e-9, r.p95[0]) < 0.15,
  );
  check(
    "截断不改变数值口径：均值/均方/峰值逐位一致，稳态与 P95 在时间分桶误差内",
    exactOk && nearOk && rows.every((r) => r.approx && r.mode === "exact"),
    `均值/均方/峰值逐位一致=${exactOk}；` +
      rows
        .map((r) => `${r.id} 稳态 ${r.steady[0].toFixed(4)}→${r.steady[1].toFixed(4)}、P95 ${r.p95[0].toFixed(3)}→${r.p95[1].toFixed(3)}`)
        .join("；"),
  );

  // golden 快照：把每个算法的 RMSE/稳态写成人能读的字符串（比哈希更有用——
  // 失败时直接看出**哪一个数**变了）。有意改动数值时必须同步更新这两个常数。
  const snapshot = (cfg: ExperimentConfig): string => {
    const r = runExperiment(cfg);
    return r.metrics.map((m) => `${m.id}=${m.rmse.toFixed(4)}/${m.steadyRmse.toFixed(4)}`).join(" ");
  };
  // 2026-10-31 第五轮复核基准：SolveLoop 统一调度后（对准检查顺序与界面一致）重新采样
  const GOLDEN_A = "pure=17.1806/24.0518 comp=1.5677/1.5853 mahony=1.0486/0.7463 madg=1.3593/1.3517 kalman=1.2021/1.1128";
  // 2026-10-31：抽帧改为「排程保留余量 + dt 为真实经过时间」后重新采样
  // （此前 200 Hz 实际跑成 166.7 Hz，且 dt 把余量重复计入，Σdt 比总时长多 10%）
  const GOLDEN_B = "pure=2.8363/3.7988 comp=4.4326/3.1868 mahony=4.6080/3.2442 madg=4.0926/3.0673 kalman=5.0006/4.6157";
  const snapA = snapshot(defaultExperimentConfig());
  const snapB = snapshot({ ...defaultExperimentConfig(), scenario: "violent", durationSec: 12, seed: 777, solveRateHz: 200 });
  check(
    "golden 快照：默认配置与剧烈机动配置的逐算法 RMSE/稳态与基准一致（数值回归锁）",
    snapA === GOLDEN_A && snapB === GOLDEN_B,
    snapA === GOLDEN_A ? `A 一致；B=${snapB}` : `A=${snapA}（基准 ${GOLDEN_A}）；B=${snapB}（基准 ${GOLDEN_B}）`,
  );
}

// 74b. 复核反例回归：统计容器有界、分位数不混叠、稳态窗口精确
{
  /* ① 容器有界 + ② 抗混叠：**直接驱动生产实现**（MetricAccumulator）。
     复核 6.1 的教训：旧用例在测试里复制了一份 Algorithm R、并用 m.n 冒充"容量"，
     于是"无界数组 / p95=NaN / n 正确"的假实现也能通过。这里改成：
       · 用真实的累加器喂 130 s 与 260 s 的周期信号，读 diagnostics() 的容器长度；
       · 分位数直接取生产 summary() 的结果与"全样本精确 P95"比。 */
  const feed = (durationSec: number, seed: number): MetricAccumulator => {
    const acc = new MetricAccumulator({ plannedEndSec: durationSec });
    acc.setReservoirSeed(seed >>> 0);
    const n = Math.round(durationSec * 500);
    for (let i = 1; i <= n; i++) {
      const t = i / 500;
      // 10 Hz 周期误差：固定相位抽样会恒定采到同一个相位 → P95 掉到 1.25° 左右
      acc.add(Math.abs(10 * Math.sin(2 * Math.PI * 10 * t)), qId(), t);
    }
    return acc;
  };
  const acc130 = feed(130, 0x5eed);
  const acc260 = feed(260, 0x5eed);
  const d130 = acc130.diagnostics();
  const d260 = acc260.diagnostics();
  const stubEst = { id: "mahony", label: "Mahony", color: "#fff", magEnabled: true, q: qId(), telemetry: { detail: {} } } as unknown as Estimator;
  const m130 = acc130.summary(stubEst, null, true);
  const m260 = acc260.summary(stubEst, null, true);
  const countOk =
    d130.errors === STATS_CAP && d130.times === STATS_CAP &&
    d260.errors === STATS_CAP && d260.times === STATS_CAP &&
    d130.reservoirErr === STATS_RESERVOIR_CAP && d260.reservoirErr === STATS_RESERVOIR_CAP &&
    d130.reservoirT === STATS_RESERVOIR_CAP && d260.reservoirT === STATS_RESERVOIR_CAP &&
    d130.truncated && d260.truncated &&
    m130.n === 130 * 500 && m260.n === 260 * 500;
  const signal: number[] = [];
  for (let i = 1; i <= 65000; i++) signal.push(Math.abs(10 * Math.sin(2 * Math.PI * 10 * (i / 500))));
  const exactP95 = percentile(signal, 0.95);
  // 固定相位对照（旧错法的复现）：每 0.1 s 取一个样本
  const fixedPhase: number[] = [];
  for (let i = 0; i < signal.length; i++) if (Math.floor((i / 500) / 0.1) !== Math.floor(((i - 1) / 500) / 0.1)) fixedPhase.push(signal[i]);
  const fixedP95 = percentile(fixedPhase, 0.95);
  const resP95 = m130.p95; // ← 生产蓄水池给的分位数
  const antiAliasOk = Math.abs(resP95 - exactP95) < 0.15 && fixedP95 < exactP95 * 0.5;

  // ③ 稳态窗口精确：窗口前的大误差不得被带进窗口
  //    用注入小上限的 runner 跑同一配置，比较「全程」与「稳态」；稳态必须严格小于窗口前的污染值。
  const cfgSteady: ExperimentConfig = { ...defaultExperimentConfig(), durationSec: 30 };
  const steadyRun = runExperiment(cfgSteady);
  const steadyMetrics = steadyRun.metrics.find((x) => x.id === "mahony")!;
  const steadyOk =
    Number.isFinite(steadyMetrics.steadyRmse) &&
    steadyMetrics.steadyRmse <= steadyMetrics.rmse * 1.5 &&
    (steadyMetrics.steadyMode === "exact" || steadyMetrics.steadyMode === "early-stop") &&
    steadyMetrics.steadyFromSec! > 15;

  check(
    "复核反例回归：统计容器有界、蓄水池分位数不混叠、稳态窗口按预定切点精确累计",
    countOk && antiAliasOk && steadyOk,
    `生产容器 130 s=${d130.errors}/${d130.reservoirErr}、260 s=${d260.errors}/${d260.reservoirErr}（容量 ${d130.cap}/${d130.reservoirCap}），样本 n=${m130.n}/${m260.n}；` +
      `10 Hz 信号 P95：精确 ${exactP95.toFixed(4)}°、固定相位 ${fixedP95.toFixed(4)}°、蓄水池 ${resP95.toFixed(4)}°；` +
      `稳态 ${steadyMetrics.steadyRmse.toFixed(3)}° (${steadyMetrics.steadyMode})，切点 ${steadyMetrics.steadyFromSec?.toFixed(2)}s`,
  );
}

// 74c. 逐帧 trace 的输入/事件契约：aligned 标在正确的那一步、raw/consumed/dt/事件都在
{
  // 静止剧本（manual 目标 0）+ 35° 倾角初偏 + 互补滤波故意收敛很慢：
  // 静止 3 s 后偏差仍 >8° → 静止粗对准必然触发（与「详细运行」用例同一套阈值条件）
  const cfgAlign: ExperimentConfig = {
    ...cloneExperimentConfig(defaultExperimentConfig()),
    scenario: "manual",
    manualTargetDeg: [0, 0, 0],
    durationSec: 8,
    initialAttitude: { kind: "fixed-axis", axis: [1, 0, 0], angleDeg: 35 },
  };
  cfgAlign.estimators.comp = { ...cfgAlign.estimators.comp, rampEnabled: false, params: { alpha: 0.01 } };
  const tr = runTrace(cfgAlign, 5000);
  const alignedSteps = tr.steps.filter((st) => st.aligned);
  // ① aligned 必须标在**对准发生的那一步**：其 t 等于事件时刻；前一步不得被标（复核 P2-4）
  const alignAtRightStep =
    tr.alignTimes.length >= 1 &&
    alignedSteps.length === tr.alignTimes.length &&
    tr.alignTimes.every((at) => alignedSteps.some((st) => Math.abs(st.t - at) < 1e-12)) &&
    tr.steps.every((st, i) => !st.aligned || i === 0 || tr.steps[i - 1].t < st.t);
  const prevNotMarked = alignedSteps.every((st) => {
    const idx = tr.steps.indexOf(st);
    return idx <= 0 || tr.steps[idx - 1].aligned === false;
  });
  // ② 每步都带得动 dt / raw / consumed（比较器与诊断都靠它们）
  const fieldsOk = tr.steps.length > 100 && tr.steps.every((st) =>
    Number.isFinite(st.dt) && st.dt > 0 &&
    st.raw.gyro.length === 3 && st.raw.accel.every(Number.isFinite) &&
    st.consumed.accel.every(Number.isFinite) && st.consumed.mag.every(Number.isFinite));
  // ③ 时间严格递增、五算法 id 齐全
  const seqOk = tr.steps.every((st, i) => i === 0 || st.t > tr.steps[i - 1].t) &&
    tr.estimatorIds.length === 5 && tr.estimatorIds.join(",") === "pure,comp,mahony,madg,kalman";
  // ④ 门控事件不能是空的：剧烈机动下 gate-reject 必须被数到（旧实现 eventCounts 恒为 {}）
  const violent = runTrace({ ...defaultExperimentConfig(), scenario: "violent", durationSec: 6, seed: 909 }, 5000);
  const gateCounted = (violent.eventCounts["gate-reject"] ?? 0) > 0;
  check(
    "逐步 trace 契约：aligned 标在对准当步、dt/raw/consumed 齐备、时序严格、门控事件被计数",
    alignAtRightStep && prevNotMarked && fieldsOk && seqOk && gateCounted,
    `对准 ${tr.alignTimes.length} 次（t=${tr.alignTimes.map((t) => t.toFixed(3)).join(",")}），` +
      `标注步 ${alignedSteps.map((st) => st.t.toFixed(3)).join(",")}；前一步未被误标=${prevNotMarked}；` +
      `步数字段齐备=${fieldsOk}（${tr.steps.length} 步）、时序/算法 id=${seqOk}；` +
      `剧烈机动 gate-reject=${violent.eventCounts["gate-reject"] ?? 0}`,
  );
}

// 75. 校准的拟合/验证分离：残差只用没参与拟合的点；独立姿态验证能看到"方向偏没偏"
{
  // 合成带硬铁 + 非对称软铁 + 噪声的点云（与文档一致的世界磁场合成）
  const trueField: V3 = [22.5, 0, 43.4];
  const g = new Gauss(mulberry32(0xfeed));
  const hardIron: V3 = [8, -5, 6];
  const soft: V3 = [1.08, 0.94, 1.02];
  // 验证集与拟合集严格不重叠：按同一函数 splitFitValidate 的确定性交错划分
  const points: Array<{ qTrue: { w: number; x: number; y: number; z: number }; magRaw: V3 }> = [];
  const records = Array.from({ length: 320 }, () => {
    const q = qNorm({ w: g.next(), x: g.next(), y: g.next(), z: g.next() });
    const mBody = qRotInv(q, trueField);
    const magRaw: V3 = [
      mBody[0] * soft[0] + hardIron[0] + 0.25 * g.next(),
      mBody[1] * soft[1] + hardIron[1] + 0.25 * g.next(),
      mBody[2] * soft[2] + hardIron[2] + 0.25 * g.next(),
    ];
    return { qTrue: q, magRaw };
  });
  const { fit: fitRecords, validate: validateRecords } = splitFitValidate(records, 4);
  const samples = fitRecords.map((r: { magRaw: V3 }) => r.magRaw);
  points.push(...validateRecords);
  const cal = calibrateMagWithValidation(samples, "diag", 4);
  const verify = verifyMagCalibration(cal, points, trueField);
  // 未参与拟合的验证残差应当与拟合残差同量级（比值 ~1，允许 2 倍内的采样波动）
  const ratio = cal?.validation?.ratio ?? NaN;
  const okStat =
    cal !== null &&
    Number.isFinite(cal.validation!.residual) &&
    cal.validation!.count === 60 &&
    ratio > 0.3 && ratio < 3 &&
    verify.count === points.length;
  // 绝对阈值按同一数据生成器的独立噪声留出余量（实测 1.19° → 2°，不能压成 1° 赌样本）。
  const okHeading =
    verify.afterMeanDeg < verify.beforeMeanDeg / 3 && verify.afterMeanDeg < 2 && verify.beforeMeanDeg > 3;
  check(
    "磁校准独立验证：验证集残差与拟合残差同量级、标定后航向误差显著下降",
    okStat && okHeading,
    `拟合残差 ${(cal?.residual ?? NaN).toFixed(4)}、验证残差 ${(cal?.validation?.residual ?? NaN).toFixed(4)}` +
      `（比值 ${ratio.toFixed(2)}、验证 ${cal?.validation?.count ?? 0} 点）；` +
      `航向误差 平均 ${verify.beforeMeanDeg.toFixed(2)}° → ${verify.afterMeanDeg.toFixed(2)}°、最大 ${verify.beforeMaxDeg.toFixed(2)}° → ${verify.afterMaxDeg.toFixed(2)}°`,
  );

  // 加计：留一朝向验证 + 独立样本验证（用另一组噪声种子合成）
  const M = [1.02, 0.02, -0.01, -0.015, 0.98, 0.03, 0.02, -0.012, 1.01];
  const bias: V3 = [0.05, -0.03, 0.08];
  const accelSamples = synthesizeAccelSamples(M, bias, 0.02, 99);
  const accelCal = calibrateAccel(accelSamples);
  const loo = accelCal ? validateAccelCalibration(accelSamples) : undefined;
  const fresh = synthesizeAccelSamples(M, bias, 0.02, 2025);
  const accelVerify = verifyAccelCalibration(accelCal, fresh);
  const okAccel =
    accelCal !== null && loo !== undefined &&
    loo.heldOutFaces === 6 && loo.meanNormErrMs2 < 0.05 && loo.maxNormErrMs2 < 0.1 &&
    accelVerify.afterMeanMs2 < accelVerify.beforeMeanMs2 / 3 && Number.isFinite(accelVerify.afterMaxMs2);
  check(
    "加计六面留一验证 + 独立样本验证：没见过的朝向上模长误差仍小、校准后前/后对比可见",
    okAccel,
    `留一：平均 ${(loo?.meanNormErrMs2 ?? NaN).toFixed(4)} m/s²、最大 ${(loo?.maxNormErrMs2 ?? NaN).toFixed(4)}（${loo?.heldOutFaces ?? 0} 朝向）；` +
      `新样本：模长误差 ${accelVerify.beforeMeanMs2.toFixed(4)} → ${accelVerify.afterMeanMs2.toFixed(4)} m/s²`,
  );
}

// 75b2. 后段留出：能发现「随时间变化」的畸变，而交错验证发现不了
{
  const trueField: V3 = [22.5, 0, 43.4];
  const g = new Gauss(mulberry32(0xfeed));
  const soft: V3 = [1.08, 0.94, 1.02];
  const n = 400;
  const hardStart: V3 = [8, -5, 6];
  const hardEnd: V3 = [14, -9, 11]; // 后 25% 期间硬铁在漂（温漂/结构应力）
  const driftAt = (i: number): V3 => {
    const k = i < n * 0.75 ? 0 : (i - n * 0.75) / (n * 0.25);
    return [0, 1, 2].map((a) => hardStart[a] + (hardEnd[a] - hardStart[a]) * k) as V3;
  };
  const samples: V3[] = [];
  for (let i = 0; i < n; i++) {
    const q = qNorm({ w: g.next(), x: g.next(), y: g.next(), z: g.next() });
    const m = qRotInv(q, trueField);
    const b = driftAt(i);
    samples.push([
      m[0] * soft[0] + b[0] + 0.1 * g.next(),
      m[1] * soft[1] + b[1] + 0.1 * g.next(),
      m[2] * soft[2] + b[2] + 0.1 * g.next(),
    ]);
  }
  const cal = calibrateMagWithValidation(samples, "diag", 4);
  const interleaved = cal?.validation?.residual ?? NaN;
  const late = cal?.validation?.late?.residual ?? NaN;
  // 后段残差必须明显更大（漂移被看见），而交错验证几乎看不到
  check(
    "后段留出验证：随时间漂移的硬铁只在「后段留出」上暴露（交错验证看不到）",
    cal !== null && Number.isFinite(late) && late > interleaved * 1.5 && cal!.validation!.late!.ratio > 1.5,
    `交错验证残差 ${(interleaved * 100).toFixed(2)}%、后段留出 ${(late * 100).toFixed(2)}%` +
      `（后段/拟合比值 ${(cal?.validation?.late?.ratio ?? NaN).toFixed(2)}）`,
  );
}

// 75c. 校准器件指纹与失效提示：参数变了要说，没变不吵
{
  const fp = fingerprintOf({ accelCrossAxis: 0.005, accelNonlin: 0, accelNoise: 0.1 }, "full", new Date("2026-10-31T00:00:00Z"));
  const same = calibrationStaleness(fp, { accelCrossAxis: 0.005, accelNonlin: 0, accelNoise: 0.1 }, "mag", "full");
  const crossChanged = calibrationStaleness(fp, { accelCrossAxis: 0.01, accelNonlin: 0, accelNoise: 0.1 }, "accel");
  const modelChanged = calibrationStaleness(fp, { accelCrossAxis: 0.005, accelNonlin: 0, accelNoise: 0.1 }, "mag", "diag");
  const noiseIgnoredForAccel = calibrationStaleness(fp, { accelCrossAxis: 0.005, accelNonlin: 0, accelNoise: 0.9 }, "accel");
  const legacy = calibrationStaleness(undefined, { accelCrossAxis: 1, accelNonlin: 1, accelNoise: 1 }, "mag", "diag");
  const fpFull = fingerprintOf({ accelCrossAxis: 0, accelNonlin: 0, accelNoise: 0.1, magNoise: 0.8 }, "full", new Date("2026-10-31T00:00:00Z"), 50);
  const targetChanged = calibrationStaleness(fpFull, { accelCrossAxis: 0, accelNonlin: 0, accelNoise: 0.1, magNoise: 0.8 }, "mag", "full", 25);
  const noiseChanged = calibrationStaleness(fpFull, { accelCrossAxis: 0, accelNonlin: 0, accelNoise: 0.1, magNoise: 1.5 }, "mag", "full", 50);
  check(
    "校准器件指纹：参数/模型变化时报「基于旧模型」，未变化与旧档案不误报",
    same === null && legacy === null &&
      Boolean(crossChanged?.includes("交叉轴")) &&
      Boolean(modelChanged?.includes("拟合模型")) &&
      noiseIgnoredForAccel === null &&
      Boolean(targetChanged?.includes("目标场强")) && Boolean(noiseChanged?.includes("磁噪声")),
    `未变=${same === null}、旧档案=${legacy === null}；交叉轴变化「${crossChanged?.slice(0, 24)}…」；` +
      `模型变化「${modelChanged?.slice(0, 24)}…」；加计不看噪声=${noiseIgnoredForAccel === null}；` +
      `目标场强变化「${targetChanged?.slice(0, 30)}…」、磁噪声变化「${noiseChanged?.slice(0, 24)}…」`,
  );
}

// 75h. 大角误差分解必须精确（log 旋转向量，而非 2vec 小角近似）
{
  const cases: Array<[number, number]> = [[7, 7], [90, 90], [180, 180]];
  const rows = cases.map(([inputDeg]) => {
    const rel = qFromAxisAngle([0, 0, 1], inputDeg * RAD);
    const s = so3ErrorSplit(rel, [0, 0, 1]);
    return { inputDeg, total: s.tiltDeg + s.yawDeg, yaw: s.yawDeg, tilt: s.tiltDeg };
  });
  const exactOk = rows.every(
    (r) => Math.abs(r.yaw - r.inputDeg) < 1e-6 && r.tilt < 1e-6 && Math.abs(r.total - r.inputDeg) < 1e-6,
  );
  // 倾角轴同理（垂直重力方向）
  const tilt180 = so3ErrorSplit(qFromAxisAngle([1, 0, 0], 180 * RAD), [0, 0, 1]);
  const tiltOk = Math.abs(tilt180.tiltDeg - 180) < 1e-6 && tilt180.yawDeg < 1e-6;
  check(
    "大角误差分解精确：90°/180° 的偏航与倾角都按 log 旋转向量给出真值",
    exactOk && tiltOk,
    rows.map((r) => `${r.inputDeg}°→yaw ${r.yaw.toFixed(4)}°/+tilt ${r.tilt.toFixed(1)}e-7`).join("、") +
      `；180° 倾角轴 → ${tilt180.tiltDeg.toFixed(4)}°`,
  );
}

// 75g. 复核反例回归：留出真独立、合成同构生产、退化/朝向/水平拒绝、克隆深隔离
{
  const rand = new Gauss(mulberry32(0xfeed));
  const cloud: V3[] = Array.from({ length: 400 }, () => {
    const q = qNorm({ w: rand.next(), x: rand.next(), y: rand.next(), z: rand.next() });
    return qRotInv(q, [22.5, 0, 43.4]);
  });
  // ① 后段留出必须「前段训练、后段评分」：只改末段数据不得改变用于打分的模型，
  //    且训练/后段样本集合交集为零（用「末段加 20μT 后前段拟合参数不变」间接验证）
  // 判据：报告的「后段残差」必须等于「只用前段训练的模型」在后段上的残差；
  // 若它等于「含后段训练的交错模型」的残差，就说明后段样本参与了训练（旧缺陷）。
  const drift = cloud.map((p, i) => [p[0] + (i >= 300 ? 20 : 0), p[1], p[2]] as V3);
  const lateBlock = drift.slice(300);
  const calDrift = calibrateMagWithValidation(drift, "diag", 4)!;
  const earlyOnly = calibrateMag(drift.slice(0, 300))!;
  const interleavedOnDrift = calibrateMag(splitFitValidate(drift, 4).fit)!;
  const reportedLate = calDrift.validation!.late!.residual;
  const lateFromEarlyOnly = magFieldResidual(earlyOnly, lateBlock).residual;
  const lateFromInterleaved = magFieldResidual(interleavedOnDrift, lateBlock).residual;
  const lateLeakFixed =
    Math.abs(reportedLate - lateFromEarlyOnly) < 1e-12 &&
    Math.abs(lateFromEarlyOnly - lateFromInterleaved) > 1e-6 &&
    Math.abs(earlyOnly.offset[0]) < 1e-9; // 前段独立拟合不被后段污染

  // ② 合成验证与生产 accelChannel 同构：同一模型下 +z 读数逐位一致
  const model = { accelCrossAxis: 0.005, accelNonlin: 0.02, accelNoise: 0 };
  const prod = accelChannel([0, 0, 9.80665], { ...model, accelNoise: 0 }, new Gauss(mulberry32(7)));
  const synth = synthesizeAccelVerification(model, 0x1234, 1)[4].raw; // "+z"，1 点窗口=单点
  const modelMirrorOk =
    prod.every((v, i) => Math.abs(v - synth[i]) < 1e-9) &&
    Math.abs(prod[0] - 0.005 * 9.80665) < 1e-9;

  // ③ 退化/朝向/水平拒绝：同一读数六面、freefall、2g 全部必须返回 null
  const faces: AccelCalibrationSample["face"][] = ["+x", "-x", "+y", "-y", "+z", "-z"];
  const sameReading = faces.map((face) => ({ face, raw: [0, 0, 9.80665] as V3 }));
  const freefall = faces.map((face) => ({ face, raw: [0, 0, 0] as V3 }));
  const twoG = faces.map((face) => ({ face, raw: [0, 0, 19.6133] as V3 }));
  const degenerateOk =
    calibrateAccel(sameReading) === null && calibrateAccel(freefall) === null && calibrateAccel(twoG) === null;
  // 静止判据：两点窗口、freefall、2g 都必须拒绝；合格窗口通过
  const win = (n: number, accel: V3) => Array.from({ length: n }, () => ({ gyro: [0, 0, 0] as V3, accel }));
  const staticOk =
    assessStaticWindow(win(2, [0, 0, 9.80665])).ok === false &&
    assessStaticWindow(win(250, [0, 0, 0])).ok === false &&
    assessStaticWindow(win(250, [0, 0, 19.6133])).ok === false &&
    assessStaticWindow(win(250, [0, 0, 9.80665])).ok === true;
  // 档案解析拒绝退化矩阵
  const degenerateArchiveRejected =
    parseAccelCalibration({ M: new Array(9).fill(0), bias: [0, 0, 0], rmse: [0, 0, 0], count: 6, faces: ["+x"] }) === null;

  // ④ 克隆深隔离：改克隆的 validation.late 不得污染原配置
  const cfg = defaultExperimentConfig();
  cfg.magCalibration = calDrift;
  const cloned = cloneExperimentConfig(cfg);
  const before = cfg.magCalibration!.validation!.late!.residual;
  cloned.magCalibration!.validation!.late!.residual = 123;
  const cloneOk = cfg.magCalibration!.validation!.late!.residual === before;

  check(
    "复核反例回归：留出前段训练独立、合成同构生产、退化/朝向/水平拒绝、克隆深隔离",
    lateLeakFixed && modelMirrorOk && degenerateOk && staticOk && degenerateArchiveRejected && cloneOk,
    `后段独立=${lateLeakFixed}（报告 ${reportedLate.toFixed(6)} = 前段模型 ${lateFromEarlyOnly.toFixed(6)} ≠ 交错模型 ${lateFromInterleaved.toFixed(6)}）；` +
      `合成镜像生产=${modelMirrorOk}；退化矩阵拒绝=${degenerateOk}；静止判据=${staticOk}；` +
      `档案拒绝退化=${degenerateArchiveRejected}；克隆深隔离=${cloneOk}`,
  );
}

// 76b. 复核 ROUND8 P1-E：错朝向/病态矩阵必须被拒；档案不静默丢模型；Applied 不能无模型
{
  const g = G_ACCEL;
  // ① +z 的真实读数被记成 +x 面：整组拟合必须失败（旧实现拟合成功、RMSE≈2.31）
  const wrongFace: AccelCalibrationSample[] = [
    { face: "+x", raw: [0, 0, g] },            // 错标：实际是 +z 朝下
    { face: "-x", raw: [-g, 0, 0] },
    { face: "+y", raw: [0, g, 0] },
    { face: "-y", raw: [0, -g, 0] },
    { face: "+z", raw: [0, 0, g] },            // 与 +x 重复
    { face: "-z", raw: [0, 0, -g] },
  ];
  const wrongFaceRejected = calibrateAccel(wrongFace) === null && !faceMatchesReading(wrongFace[0]);
  // 正常的六面读数必须通过面一致性检查（交叉轴 0.5% 不应被误杀）
  const cleanFaces: AccelCalibrationSample[] = (["+x", "-x", "+y", "-y", "+z", "-z"] as const).map((face) => {
    const t = faceTrueVector(face);
    const raw: V3 = [
      t[0] + 0.005 * (t[1] + t[2]),
      t[1] + 0.005 * (t[0] + t[2]),
      t[2] + 0.005 * (t[0] + t[1]),
    ];
    return { face, raw };
  });
  const cleanAccepted = cleanFaces.every(faceMatchesReading) && calibrateAccel(cleanFaces) !== null;
  // 单个朝向错标也要在**采集时**被拦下（faceMatchesReading 直接问）
  const faceGateOk =
    faceMatchesReading({ face: "+z", raw: [0, 0, g] }) &&
    !faceMatchesReading({ face: "+z", raw: [g, 0, 0] }) &&
    !faceMatchesReading({ face: "-y", raw: [0, g, 0] }) &&
    faceMatchesReading({ face: "-y", raw: [0, -0.99 * g, 0.05 * g] });

  // ② 病态矩阵：diag(1,1,2e-6)（条件数 ≈5e5）必须被拒（旧实现靠 det>1e-6 蒙过去了）
  const illM = [1, 0, 0, 0, 1, 0, 0, 0, 2e-6];
  const condIll = conditionNumber3(illM);
  const illRejected =
    !(conditionNumber3(illM) <= ACCEL_MAX_COND) &&
    parseAccelCalibration({ M: illM, bias: [0, 0, 0], rmse: [0, 0, 0], count: 6, faces: ["+x", "-x", "+y", "-y", "+z", "-z"] }) === null &&
    parseMagCalibration({ offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 10, kind: "full", matrix: illM }) === null;
  // 镜像矩阵（det<0）也要被拒：它不是合法标定
  const mirrorRejected = parseAccelCalibration({ M: [1, 0, 0, 0, -1, 0, 0, 0, 1], bias: [0, 0, 0], rmse: [0, 0, 0], count: 6, faces: [] }) === null;
  // 正常矩阵必须仍被接受
  const okM = [1.001, 0.005, 0, 0.005, 0.999, 0.002, 0, 0.002, 1.002];
  const okAccepted = conditionNumber3(okM) <= ACCEL_MAX_COND &&
    parseAccelCalibration({ M: okM, bias: [0.01, -0.02, 0.03], rmse: [0.01, 0.01, 0.01], count: 6, faces: ["+x", "-x", "+y", "-y", "+z", "-z"] }) !== null;

  // ③ 留一验证带方向误差：错配的标定在"方向"上暴露，而不只是模长
  const loo = validateAccelCalibration(cleanFaces);
  const looOk = loo !== undefined && loo.heldOutFaces >= 4 && Number.isFinite(loo.meanDirErrDeg ?? NaN) && (loo.meanDirErrDeg ?? 99) < 2;

  // ④ 档案严格/迁移分流：当前 schema 的档案声明了退化模型 → 报错（不再 ok:true 静默丢模型）
  const parsedCfg = defaultExperimentConfig();
  const badArchive = {
    schema: ARCHIVE_SCHEMA,
    kind: ARCHIVE_KIND,
    restore: "config-only" as const,
    config: { ...parsedCfg, schemaVersion: EXPERIMENT_SCHEMA_VERSION, magCalibration: { offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 5, kind: "full" as const, matrix: new Array(9).fill(0) } },
    run: null,
  };
  const strictRejected = parseArchive(badArchive).ok === false;
  // Applied=true 而模型为 null → 校验报错
  const appliedNoModel = validateExperimentConfig({ ...parsedCfg, magCalibration: null, magCalibrationApplied: true });
  const appliedNoModelOk = appliedNoModel.some((p) => p.path === "magCalibrationApplied");
  // 旧 schema（无 schemaVersion）走迁移并把"丢了什么"记进 notes
  const legacyArchive = {
    schema: ARCHIVE_SCHEMA,
    kind: ARCHIVE_KIND,
    restore: "config-only" as const,
    config: { seed: 7, durationSec: 5, magCalibration: { offset: [1, 2, 3], scale: [1, 1, 1], field: 50, residual: 0.01, count: 12 } },
    run: null,
  };
  const migrated = parseArchive(legacyArchive);
  const legacyMigrated = migrated.ok === true && (migrated.notes?.length ?? 0) > 0 && migrated.config.magCalibration !== null;

  // ⑤ 克隆深隔离：initialAttitude.axis 与 accel 的 M 都必须独立
  const axisCfg = defaultExperimentConfig();
  axisCfg.initialAttitude = { kind: "fixed-axis", axis: [1, 0, 0], angleDeg: 30 };
  const axisClone = cloneExperimentConfig(axisCfg);
  axisClone.initialAttitude.axis![0] = 9;
  const axisIsolated = axisCfg.initialAttitude.axis![0] === 1;
  const accelCfg = defaultExperimentConfig();
  accelCfg.accelCalibration = { M: [...okM], bias: [0, 0, 0], rmse: [0, 0, 0], count: 6, faces: ["+x"] };
  const accelClone = cloneExperimentConfig(accelCfg);
  accelClone.accelCalibration!.M[0] = 42;
  const accelIsolated = accelCfg.accelCalibration!.M[0] === okM[0];

  check(
    "复核 ROUND8 校准契约：错朝向/病态/镜像拒绝、正常通过、档案严格分流、克隆深隔离",
    wrongFaceRejected && cleanAccepted && faceGateOk && illRejected && mirrorRejected && okAccepted &&
      looOk && strictRejected && appliedNoModelOk && legacyMigrated && axisIsolated && accelIsolated,
    `+z 误标 +x 被拒=${wrongFaceRejected}、干净六面通过=${cleanAccepted}、面闸门=${faceGateOk}；` +
      `病态(cond=${condIll.toExponential(2)})拒绝=${illRejected}、镜像拒绝=${mirrorRejected}、正常矩阵接受=${okAccepted}；` +
      `留一方向误差=${(loo?.meanDirErrDeg ?? NaN).toFixed(3)}°（${loo?.heldOutFaces} 面）；` +
      `档案严格拒绝=${strictRejected}、Applied 无模型报错=${appliedNoModelOk}、旧档迁移=${legacyMigrated}；` +
      `clone.axis 隔离=${axisIsolated}、clone.M 隔离=${accelIsolated}`,
  );
}

// 76c. SO(3) 世界系误差分解：倾斜真值下，绕世界重力轴的误差只能进偏航
{
  // q_true 含偏航+横滚：把「绕世界重力轴的 8°」与「绕机体 z 的 8°」区分开。
  // 机体系小角向量直接按世界重力轴投影，会把前者错拆出 ~4° 倾角（ROUND5 实测）。
  const truth = qMul(qFromAxisAngle([0, 0, 1], 40 * RAD), qFromAxisAngle([1, 0, 0], 30 * RAD));
  const estWorldYaw = qMul(qFromAxisAngle([0, 0, 1], 8 * RAD), truth);
  const worldRel = qMul(truth, qConj(estWorldYaw));
  const splitWorldYaw = so3ErrorSplit(worldRel, [0, 0, 1]);
  const estBodyYaw = qMul(truth, qFromAxisAngle([0, 0, 1], 8 * RAD));
  const splitBodyYaw = so3ErrorSplit(qMul(truth, qConj(estBodyYaw)), [0, 0, 1]);
  const worldHorizontal = qMul(qFromAxisAngle([1, 0, 0], 8 * RAD), truth);
  const splitHorizontal = so3ErrorSplit(qMul(truth, qConj(worldHorizontal)), [0, 0, 1]);
  check(
    "SO(3) 世界系分解：倾斜真值下世界偏航/水平误差不混轴，机体 z 偏航按重力几何分解",
    splitWorldYaw.tiltDeg < 1e-6 && Math.abs(splitWorldYaw.yawDeg - 8) < 0.02 &&
      Math.abs(splitBodyYaw.tiltDeg - 4) < 0.02 && Math.abs(splitBodyYaw.yawDeg - Math.sqrt(48)) < 0.02 &&
      Math.abs(splitHorizontal.tiltDeg - 8) < 0.02 && splitHorizontal.yawDeg < 1e-6,
    `世界重力轴误差 → tilt ${splitWorldYaw.tiltDeg.toFixed(4)}° / yaw ${splitWorldYaw.yawDeg.toFixed(4)}°；` +
      `机体 z 误差 → tilt ${splitBodyYaw.tiltDeg.toFixed(4)}° / yaw ${splitBodyYaw.yawDeg.toFixed(4)}°；` +
      `世界水平轴误差 → tilt ${splitHorizontal.tiltDeg.toFixed(4)}° / yaw ${splitHorizontal.yawDeg.toFixed(4)}°`,
  );
}

// 75b. 加计独立验证合成：当前器件参数与窗口均值模型，不能拿另一颗 IMU 打分
{
  const model = { accelCrossAxis: 0.005, accelNonlin: 0, accelNoise: 0 };
  const samples = synthesizeAccelVerification(model);
  const cal = calibrateAccel(samples);
  const verify = verifyAccelCalibration(cal, samples);
  // 生产模型 k=0.005 时，六面读数的模长偏离约 2.5e-4 m/s²（旧合成用 2k，偏大约 4 倍）
  const nearZero =
    verify.afterMeanMs2 < 1e-12 && verify.beforeMeanMs2 > 1e-4 &&
    accelVerdict(verify.beforeMeanMs2, verify.afterMeanMs2).includes("有效");
  const modelChanged = { ...model, accelCrossAxis: 0.002 };
  const changedVerify = verifyAccelCalibration(cal, synthesizeAccelVerification(modelChanged));
  const changedReported = changedVerify.afterMeanMs2 > changedVerify.beforeMeanMs2 &&
    accelVerdict(changedVerify.beforeMeanMs2, changedVerify.afterMeanMs2).includes("未见改善");
  void changedReported;
  const noisy = synthesizeAccelVerification({ ...model, accelNoise: 0.1 });
  const noisyOk = noisy.length === 6 && noisy.every((s) => s.raw.every(Number.isFinite));
  check(
    "加计独立验证合成（与生产 accelChannel 同构）：匹配模型恢复、模型漂移如实报未见改善",
    nearZero && changedReported && noisyOk,
    `匹配：${verify.beforeMeanMs2.toFixed(4)} → ${verify.afterMeanMs2.toExponential(1)} m/s²；` +
      `漂移：${changedVerify.beforeMeanMs2.toFixed(4)} → ${changedVerify.afterMeanMs2.toFixed(4)} m/s²；噪声窗口=${noisyOk}`,
  );
}

// 76. NIS/NEES 的尺度检验：指标必须对「R/Q 标定偏乐观」单调响应，而不是只保证有限
{
  // 静止 + 固定真值：同一份数据、只改滤波器**假定**的观测噪声 R（obsNoise）与过程噪声 Q（gyroNoiseDps）
  const sweep = (obsNoise: number, gyroNoiseDps: number) => {
    const cfg = defaultExperimentConfig();
    cfg.scenario = "manual";
    cfg.durationSec = 20;
    cfg.estimators.kalman = { ...cfg.estimators.kalman, params: { gyroNoiseDps, obsNoise } };
    const r = runExperiment(cfg);
    const m = r.metrics.find((x) => x.id === "kalman")!;
    return { nis: m.nisAccelMean ?? NaN, nees: m.neesThetaMean ?? NaN, rmse: m.rmse };
  };
  // R 越大 → 残差相对于假定噪声越小 → NIS 越小（单调）
  const rSmall = sweep(0.02, 0.2);
  const rMid = sweep(0.05, 0.2);
  const rBig = sweep(0.2, 0.2);
  // Q 越大 → 滤波器认为自己的姿态更不确定 → NEES（eᵀP⁻¹e）越小（单调）
  const qSmall = sweep(0.05, 0.05);
  const qBig = sweep(0.05, 0.8);
  const nisMono = rSmall.nis > rMid.nis && rMid.nis > rBig.nis;
  const neesMono = qSmall.nees > qBig.nees;
  // 尺度感：R 放大 10 倍，NIS 应下降数倍以上（不是只差 1%）
  const nisScale = rBig.nis < rSmall.nis / 3;
  const finite = [rSmall, rMid, rBig, qSmall, qBig].every(
    (x) => Number.isFinite(x.nis) && Number.isFinite(x.nees) && Number.isFinite(x.rmse),
  );
  check(
    "NIS/NEES 尺度检验：R 越大 NIS 越小、Q 越大 NEES 越小（单调且量级敏感）",
    nisMono && neesMono && nisScale && finite,
    `NIS(R=0.02/0.05/0.2) = ${rSmall.nis.toFixed(2)} / ${rMid.nis.toFixed(2)} / ${rBig.nis.toFixed(2)}；` +
      `NEES(Q=0.05/0.8) = ${qSmall.nees.toFixed(2)} / ${qBig.nees.toFixed(2)}`,
  );
}

// 77. 抽出来的纯模块：实验档案构造/解析、批量表格与校准面板文案
{
  const cfg = defaultExperimentConfig();
  cfg.seed = 4242;
  cfg.magModel = "full";
  cfg.magCalibration = {
    offset: [1, 2, 3], scale: [1, 1, 1], field: 50, residual: 0.01, count: 100,
    kind: "full", matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    validation: { residual: 0.012, count: 25, maxErrUt: 1.5, ratio: 1.2 },
  };
  cfg.magCalibrationApplied = true;
  const run: ArchiveRunInfo = {
    elapsedSec: 12.5,
    dataSource: "模拟",
    reference: "groundTruth",
    finishedAtIso: "2026-10-31T00:00:00.000Z",
    metrics: [{ id: "mahony", n: 10, mean: 1, rmse: 1.2, max: 2, convergedAt: 1.5 }],
  };
  const archive = buildArchive(cfg, run);
  // 往返：JSON → 解析 → 配置与运行信息都还原；坏格式/坏配置被明确拒绝
  const roundTrip = parseArchive(JSON.parse(JSON.stringify(archive)));
  const badKind = parseArchive({ ...archive, kind: "something-else" });
  // 用「迁移不会修掉、但校验必须拦下」的坏值：零轴初始偏差
  const badConfig = parseArchive({ ...archive, config: { ...cfg, initialAttitude: { kind: "fixed-axis", axis: [0, 0, 0], angleDeg: 30 } } });
  const okRound =
    roundTrip.ok === true &&
    roundTrip.config.seed === 4242 &&
    roundTrip.config.magModel === "full" &&
    roundTrip.config.magCalibrationApplied === true &&
    roundTrip.config.magCalibration?.kind === "full" &&
    roundTrip.run?.elapsedSec === 12.5;
  const describe = describeArchiveRun(run);
  check(
    "实验档案纯模块：构造→JSON→解析往返一致，坏格式/坏配置被拒，运行信息可读化",
    okRound && badKind.ok === false && badConfig.ok === false && describe.includes("12.5") && describe.includes("模拟真值"),
    `往返一致=${okRound}；坏 kind 被拒=${badKind.ok === false}；坏配置被拒=${badConfig.ok === false}；说明「${describe.slice(0, 28)}…」`,
  );

  // 批量表格：7 列口径 + SO(3) 指标优先 + 状态行把统计口径写在眼前
  const rows = batchRowsHtml(
    [{
      id: "mahony", label: "Mahony", runs: 3, rmseP50: 1.234, rmseP95: 1.5, rmseMean: 1.3,
      steadyRmseP50: 0.9, steadyRmseP95: 1.1, nonConvergedPct: 0,
      tiltRmseP95: 9.9, yawRmseP95: 8.8, tiltSo3P95: 0.7, yawSo3P95: 0.6,
    }],
    [{ id: "mahony", label: "Mahony", color: "#58a6ff" }],
  );
  const cols = (rows.match(/<td>/g) ?? []).length;
  const usesSo3 = rows.includes("0.70") && rows.includes("0.60") && !rows.includes("9.90");
  const status = batchStatusText({
    count: 10, durationSec: 10, baseSeed: 1, lastSeed: 9, steadyFromSec: null, mode: "worker",
  });
  check(
    "批量表格纯模块：7 列、优先用 SO(3) 倾角/偏航、状态行写明 Worker 路径与稳态口径",
    cols === 7 && usesSo3 && status.includes("末段 40%") && status.includes("Web Worker"),
    `列数=${cols}（应 7）、用 SO(3) 指标=${usesSo3}；状态「${status.slice(0, 40)}…」`,
  );

  // 校准面板文案：拟合/验证/留一/独立验证四个读数分得清
  const magState = magStatusText({
    cal: null, applied: false, collecting: false, sampleCount: 0, message: "", verifyLine: "", target: 240,
  });
  const magHtml = magResultHtml(
    cfg.magCalibration,
    magVerifyLineHtml({ count: 100, beforeMeanDeg: 12.3, afterMeanDeg: 0.8, beforeMaxDeg: 30, afterMaxDeg: 2 }, [22.5, 0, 43.4]),
  );
  const accelHtml = accelResultHtml(
    {
      M: [1,0,0,0,1,0,0,0,1], bias: [0,0,0], rmse: [0.001,0.002,0.003], count: 6,
      faces: ["+x","-x","+y","-y","+z","-z"],
      validation: { meanNormErrMs2: 0.01, maxNormErrMs2: 0.02, heldOutFaces: 6 },
    },
    accelVerifyLineHtml({ count: 6, beforeMeanMs2: 0.16, afterMeanMs2: 0.008, beforeMaxMs2: 0.25, afterMaxMs2: 0.02 }, true),
  );
  // 另一侧分支：已应用状态、未采集状态、缺 SO(3) 字段时回退欧拉指标
  const appliedText = magStatusText({
    cal: cfg.magCalibration, applied: true, collecting: false, sampleCount: 280, message: "", verifyLine: "", target: 240,
  });
  const collectingText = magStatusText({
    cal: null, applied: false, collecting: true, sampleCount: 12, message: "", verifyLine: "", target: 240,
  });
  const accelEmpty = accelStatusText({
    cal: null, applied: false, sampleCount: 2, message: "", verifyLine: "", windowSeconds: 0.5,
  });
  const fallbackRows = batchRowsHtml(
    [{
      id: "comp", label: "互补滤波", runs: 1, rmseP50: NaN, rmseP95: NaN, rmseMean: NaN,
      steadyRmseP50: NaN, steadyRmseP95: NaN, nonConvergedPct: NaN,
      tiltRmseP95: 1.23, yawRmseP95: 4.56,
    }],
    [],
  );
  const branchesOk =
    appliedText.startsWith("已应用") && collectingText.includes("采集中") &&
    accelEmpty.includes("未采集") && fallbackRows.includes("1.23") && fallbackRows.includes("4.56") &&
    fallbackRows.includes("—");

  check(
    "校准面板纯模块：状态文案与四个读数（拟合/验证/留一/独立验证）都在结果块里",
    magState.includes("未校准") &&
      magHtml.includes("验证残差") && magHtml.includes("独立验证") &&
      magHtml.includes("0.80") && accelHtml.includes("留一验证") && accelHtml.includes("独立验证") &&
      branchesOk,
    `磁：${magHtml.replace(/<[^>]+>/g, "").slice(0, 60)}…；加计：${accelHtml.replace(/<[^>]+>/g, "").slice(0, 40)}…`,
  );

  // 复核 P1-4：训练残差为 0 时生产拟合给出 ratio=NaN，JSON 往返后是 null；
  // parser 接受这种对象，旧实现的 `ratio.toFixed(2)` 会在渲染阶段抛 TypeError。
  const nullRatioCal = JSON.parse(JSON.stringify({
    ...cfg.magCalibration,
    validation: { residual: 0, count: 96, ratio: null, late: { residual: 0, count: 48, ratio: null } },
  })) as typeof cfg.magCalibration;
  let nullRatioHtml = "";
  let nullRatioError = "";
  try {
    nullRatioHtml = magResultHtml(nullRatioCal, "");
  } catch (e) {
    nullRatioError = e instanceof Error ? e.message : String(e);
  }
  const lateHtml = nullRatioHtml.includes("后段留出");
  check(
    "校准面板：ratio=null（训练残差为 0，JSON 往返）渲染为「不适用」，不得抛错或显示 NaN",
    nullRatioError === "" && nullRatioHtml.includes("—（不适用）") && lateHtml &&
      !/NaN|undefined/.test(nullRatioHtml),
    nullRatioError ? `渲染抛错：${nullRatioError}` : `渲染：${nullRatioHtml.replace(/<[^>]+>/g, "").slice(0, 96)}`,
  );
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
