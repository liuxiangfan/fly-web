/**
 * 数值自检：验证坐标约定与四种解算算法的收敛性。
 * 运行：npm run selftest
 */
import { World } from "../src/core/world";
import { manualTarget, scenarios } from "../src/core/scenarios";
import { G_ACC, simulateImu, simulateMag, type ImuParams } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import {
  FRAME_LEN,
  buildFrame,
  frameDtSec,
  parseFrame,
  type Mounting,
} from "../src/core/serial";
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
  qNorm,
  qRot,
  qRotInv,
  qSlerp,
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
import { calibrateMag, fitMagSphere, applyMagCalibration } from "../src/core/magcal";
import { ErrorTracker } from "../src/core/stats";
import { b64urlDecode, b64urlEncode } from "../src/ui/b64";
import { parseImuCsv } from "../src/core/replay";
import { EXPERIMENTS } from "../src/ui/experiments";

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
const clean: ImuParams = { gyroBiasDps: 0, gyroNoiseDps: 0, gyroWalkDps: 0, gyroRangeDps: 0, sensorDelayMs: 0,  gyroScaleErr: 0, gyroMisalign: 0,  accelNoise: 0, accelCrossAxis: 0, accelNonlin: 0, linAccel: 0, vibration: 0, magNoise: 0, magQuantUts: 0, hardIron: 0, disturbMag: 0 };
const dirty: ImuParams = { gyroBiasDps: 1, gyroNoiseDps: 0.2, gyroWalkDps: 0, gyroRangeDps: 0, sensorDelayMs: 0,  gyroScaleErr: 0, gyroMisalign: 0,  accelNoise: 0.15, accelCrossAxis: 0, accelNonlin: 0, linAccel: 0.5, vibration: 0.3, magNoise: 0, magQuantUts: 0, hardIron: 0, disturbMag: 0 };

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

// 5b. 手动模式（回归）：滑块写入共享目标 manualTarget 后姿态应跟踪到位
{
  const world = new World(scenarios.manual);
  manualTarget.rollDeg = 40;
  manualTarget.pitchDeg = -30;
  manualTarget.yawDeg = 90;
  for (let i = 0; i < 1000; i++) world.step(H, clean);
  const e = qToEuler(world.q);
  const err =
    Math.abs(e.roll - 40 * RAD) * DEG + Math.abs(e.pitch + 30 * RAD) * DEG + Math.abs(e.yaw - 90 * RAD) * DEG;
  check("手动模式滑块驱动姿态", err < 3, `2s 后三轴误差之和 ${err.toFixed(2)}°`);
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
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0 };

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
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0 };
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
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0 };
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
  const pWithMag: ImuParams = { ...dirty, magNoise: 0.8, hardIron: 0, disturbMag: 0 };
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

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
