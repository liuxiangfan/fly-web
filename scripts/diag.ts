/** 诊断：干净 IMU 下各算法误差随时间的演化 + 最终欧拉角 */
import { simulateImu, type ImuParams } from "../src/core/imu";
import { Gauss, mulberry32 } from "../src/core/rng";
import {
  ComplementaryEstimator,
  MadgwickEstimator,
  MahonyEstimator,
  PureGyroEstimator,
} from "../src/estimators";
import { DEG, RAD, qAngleBetween, qFromEuler, qToEuler } from "../src/core/quat";

const H = 1 / 500;
const clean: ImuParams = { gyroBiasDps: 0, gyroNoiseDps: 0, gyroWalkDps: 0, gyroRangeDps: 0, sensorDelayMs: 0,  gyroScaleErr: 0, gyroMisalign: 0,  accelNoise: 0, accelCrossAxis: 0, accelNonlin: 0, linAccel: 0, vibration: 0, magNoise: 0, magQuantUts: 0, hardIron: 0, disturbMag: 0, magSoftIron: 0 };
const qTrue = qFromEuler(30 * RAD, 20 * RAD, 0);

const ests = [
  new PureGyroEstimator(),
  new ComplementaryEstimator(),
  new MahonyEstimator(),
  new MadgwickEstimator(),
];
const gauss = new Gauss(mulberry32(42));
const marks = [0.5, 1, 2, 4, 8, 12, 20];
let mi = 0;

console.log("真值欧拉角: 30.0, 20.0, 0.0 (度)");
for (let i = 0; i < Math.round(20 / H); i++) {
  const s = simulateImu(qTrue, [0, 0, 0], i * H, clean, gauss, 1);
  for (const e of ests) e.update(s.gyro, s.accel, s.mag, H);
  const t = i * H;
  if (mi < marks.length && t >= marks[mi]) {
    mi++;
    const errs = ests.map((e) => (qAngleBetween(e.q, qTrue) * DEG).toFixed(3).padStart(8));
    console.log(`t=${t.toFixed(1).padStart(5)}s  误差(度): pure${errs[0]} comp${errs[1]} mahony${errs[2]} madg${errs[3]}`);
  }
}
for (const e of ests) {
  const eu = qToEuler(e.q);
  console.log(
    `${e.label.padEnd(8)} 最终欧拉角: φ=${(eu.roll * DEG).toFixed(3)} θ=${(eu.pitch * DEG).toFixed(3)} ψ=${(eu.yaw * DEG).toFixed(3)}`,
  );
}
