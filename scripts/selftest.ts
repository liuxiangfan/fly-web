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
import {
  GIMBAL_DEMO_DURATION,
  gimbalAxisAlign,
  gimbalDemo,
  gimbalDemoPhaseEnd,
  gimbalInnerQuat,
  gimbalLocked,
  toDisplayQ,
} from "../src/core/gimbal";
import {
  estimatorMask,
  loadMode,
  resolveScenario,
  resolveSource,
  saveMode,
  type KvStore,
  type UiMode,
} from "../src/ui/mode";

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

// 11. 精简模式策略：不允许的选项收敛，曲线掩码只留纯积分与 Mahony
{
  const ids = ["pure", "comp", "mahony", "madg"];
  const basicMask = estimatorMask("basic", ids);
  const fullMask = estimatorMask("full", ids);
  const srcBasic = resolveSource("madg", "basic");
  const srcFull = resolveSource("madg", "full");
  const scBasic = resolveScenario("violent", "basic");
  const scFull = resolveScenario("violent", "full");
  const keep = resolveSource("pure", "basic");
  check(
    "精简模式收敛选项与掩码",
    JSON.stringify(basicMask) === JSON.stringify([true, false, true, false]) &&
      fullMask.every(Boolean) &&
      srcBasic === "mahony" &&
      srcFull === "madg" &&
      scBasic === "hover" &&
      scFull === "violent" &&
      keep === "pure",
    `掩码 basic=${JSON.stringify(basicMask)}；显示源 madg→${srcBasic}(basic)/${srcFull}(full)；机动 violent→${scBasic}(basic)/${scFull}(full)`,
  );
}

// 12. 模式持久化：缺失/非法值回落 basic，写入 full 后读回 full
{
  const mem = new Map<string, string>();
  const store: KvStore = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  };
  const greedy: KvStore = { getItem: () => "垃圾值", setItem: () => {} };
  const initial = loadMode(store);
  saveMode("full", store);
  const afterWrite = loadMode(store);
  saveMode("basic", store);
  const afterBasic = loadMode(store);
  const garbage = loadMode(greedy);
  const modes: UiMode[] = [initial, afterWrite, afterBasic, garbage];
  check(
    "模式持久化与非法值回落",
    initial === "basic" && afterWrite === "full" && afterBasic === "basic" && garbage === "basic",
    `空→${modes[0]}，写 full→${modes[1]}，写 basic→${modes[2]}，非法值→${modes[3]}`,
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

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
