/**
 * 数值自检：验证坐标约定与四种解算算法的收敛性。
 * 运行：npm run selftest
 */
import { World } from "../src/core/world";
import { manualTarget, scenarios } from "../src/core/scenarios";
import { G_ACC, simulateImu, type ImuParams } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import {
  ComplementaryEstimator,
  KalmanEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
} from "../src/estimators";
import {
  DEG,
  qDot,
  RAD,
  eulerLerp,
  qAngleBetween,
  qFromAxisAngle,
  qFromEuler,
  qId,
  qIntegrate,
  qNorm,
  qRot,
  qRotInv,
  qSlerp,
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
const clean: ImuParams = { gyroBiasDps: 0, gyroNoiseDps: 0, accelNoise: 0, linAccel: 0, vibration: 0, magNoise: 0, hardIron: 0, disturbMag: 0 };
const dirty: ImuParams = { gyroBiasDps: 1, gyroNoiseDps: 0.2, accelNoise: 0.15, linAccel: 0.5, vibration: 0.3, magNoise: 0, hardIron: 0, disturbMag: 0 };

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
    .map(([n, e], i) => `${n} ramp ${(qAngleBetween(e.q, qTrue) * DEG).toFixed(1)}° vs 无 ${(qAngleBetween(off[i][1].q, qTrue) * DEG).toFixed(1)}°`)
    .join("；");
  const allFaster = on.every(([n, e], i) => qAngleBetween(e.q, qTrue) * DEG < qAngleBetween(off[i][1].q, qTrue) * DEG);
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

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
