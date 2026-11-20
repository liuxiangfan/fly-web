import assert from "node:assert/strict";
import { simulateImu } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import { defaultExperimentConfig } from "../src/core/experiment-config";

const q = { w: 1, x: 0, y: 0, z: 0 };
const base = defaultExperimentConfig().imu;

function run(range: number, seed: number) {
  const p = { ...base, gyroRangeDps: range };
  const g = new Gauss(mulberry32(seed));
  const sample = simulateImu(q, [4, -5, 6], 1.25, p, g, 0);
  return { sample, next: g.next() };
}

// 未启用满量程时：没有观测字段，保持历史样本形状。
const off = run(0, 1234);
assert.equal("gyroSaturated" in off.sample, false);

// 启用削顶只改变被削顶的读数；随机流消耗与关闭时逐位一致，数值等于手工 clamp。
const on = run(150 / 57.29578, 1234);
const lim = (150 / 57.29578) / 57.29578;
for (let i = 0; i < 3; i++) {
  const expected = Math.max(-lim, Math.min(lim, off.sample.gyro[i]));
  assert.equal(on.sample.gyro[i], expected, `削顶轴 ${i} 数值必须等于手工 clamp`);
}
assert.equal(on.next, off.next, "观测信号不得额外消耗随机数");
assert.equal(on.sample.gyroSaturated, true, "真实削顶必须产生只读信号");
assert.deepEqual(on.sample.accel, off.sample.accel, "削顶观测不得改变加计");
assert.deepEqual(on.sample.mag, off.sample.mag, "削顶观测不得改变磁链");

// 读数恰好等于量程但没有发生 clamp 变化时，不得误报饱和。
const exact = new Gauss(mulberry32(7));
const p = { ...base, gyroRangeDps: 0 };
const exactSample = simulateImu(q, [0, 0, 0], 0, p, exact, 0);
assert.equal("gyroSaturated" in exactSample, false);

console.log("imu-saturation-contract: 3 PASS / 0 FAIL");
