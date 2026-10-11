/** 诊断：剧烈机动下四种算法的误差时间线（复现浏览器中 Madgwick 139° 现象） */
import { World } from "../src/core/world";
import { scenarios } from "../src/core/scenarios";
import type { ImuParams } from "../src/core/imu";
import {
  ComplementaryEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
} from "../src/estimators";
import { DEG, qAngleBetween, qToEuler } from "../src/core/quat";

const H = 1 / 500;
const params: ImuParams = { gyroBiasDps: 1, gyroNoiseDps: 0.2, accelNoise: 0.1, linAccel: 1, vibration: 0.3 };

const world = new World(scenarios.violent);
const ests = [
  new PureGyroEstimator(),
  new ComplementaryEstimator(),
  new MahonyEstimator(),
  new MadgwickEstimator(),
];
const marks = [1, 2, 3, 4, 5, 6, 7, 8, 10, 14, 21];
let mi = 0;

for (let i = 0; i < Math.round(21 / H); i++) {
  const s = world.step(H, params);
  for (const e of ests) e.update(s.gyro, s.accel, H);
  const t = world.t;
  if (mi < marks.length && t >= marks[mi]) {
    mi++;
    const errs = ests.map((e) => (qAngleBetween(e.q, world.q) * DEG).toFixed(1).padStart(6));
    const madgE = qToEuler(ests[3].q);
    const trueE = qToEuler(world.q);
    console.log(
      `t=${t.toFixed(1).padStart(4)}  误差 pure${errs[0]} comp${errs[1]} mahony${errs[2]} madg${errs[3]}` +
        `  | 真实ψ=${(trueE.yaw * DEG).toFixed(0)} madgψ=${(madgE.yaw * DEG).toFixed(0)}` +
        ` 真实φθ=${(trueE.roll * DEG).toFixed(0)}/${(trueE.pitch * DEG).toFixed(0)}` +
        ` madgφθ=${(madgE.roll * DEG).toFixed(0)}/${(madgE.pitch * DEG).toFixed(0)}`,
    );
  }
}
