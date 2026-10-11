/**
 * 数值自检：验证坐标约定与四种解算算法的收敛性。
 * 运行：npm run selftest
 */
import { World } from "../src/core/world";
import { manualTarget, scenarios } from "../src/core/scenarios";
import { simulateImu, type ImuParams } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import {
  ComplementaryEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
} from "../src/estimators";
import { DEG, RAD, qAngleBetween, qFromEuler, qId, qIntegrate, qToEuler } from "../src/core/quat";

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
    for (const e of ests) e.update(s.gyro, s.accel, H);
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

const clean: ImuParams = { gyroBiasDps: 0, gyroNoiseDps: 0, accelNoise: 0, linAccel: 0, vibration: 0 };
const dirty: ImuParams = { gyroBiasDps: 1, gyroNoiseDps: 0.2, accelNoise: 0.15, linAccel: 0.5, vibration: 0.3 };

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
    for (let k = 1; k < ests.length; k++) ests[k].update(s.gyro, s.accel, H);
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

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
