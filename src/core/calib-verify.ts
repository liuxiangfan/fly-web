/**
 * 校准独立验证的数据合成与结论判定（DOM-free）。
 *
 * 从 main.ts 抽出来的原因：验证读数不能只由浏览器字符串测试间接覆盖。
 * 尤其要避免两种「看起来有效」：拟合/验证集重叠、或用硬编码的另一颗 IMU 给任何配置都打高分。
 *
 * **2026-10-31 复核修正**：合成必须与**生产传感器模型逐位同构**，否则验证的是另一颗虚构器件。
 * 旧实现用 `2k` 交叉轴（生产是 `k`）、并按分量做非线性（生产先按模长、再交叉轴混合），
 * 复核反例：k=0.005 时生产读出 `[0.04903325, 0.04903325, 9.80665]`，验证合成却是
 * `[0.0980665, 0.0980665, 9.80665]`——于是「校准有效」可能只是两台虚构器件之间的差异。
 * 现在统一调用 `accelChannel()`（`core/imu.ts` 里的单点加计链路，simulateImu 亦复用它）。
 */
import type { AccelCalibrationSample } from "./accelcal";
import { accelChannel } from "./imu";
import type { V3 } from "./quat";
import { Gauss, mulberry32 } from "./rng";

export interface AccelDeviceModel {
  accelCrossAxis: number;
  accelNonlin: number;
  accelNoise: number;
}

/**
 * 用当前器件模型合成一组新的 0.5 s 窗口均值样本（500 Hz × 250 点）。
 * 六面拟合的输入是窗口均值，因此噪声也按窗口均值合成（σ/√n），与真实采集一致。
 */
export function synthesizeAccelVerification(
  model: AccelDeviceModel,
  seed = 0x1234,
  samplesPerFace = 250,
): AccelCalibrationSample[] {
  const faces: Array<[AccelCalibrationSample["face"], V3]> = [
    ["+x", [1, 0, 0]],
    ["-x", [-1, 0, 0]],
    ["+y", [0, 1, 0]],
    ["-y", [0, -1, 0]],
    ["+z", [0, 0, 1]],
    ["-z", [0, 0, -1]],
  ];
  const g = new Gauss(mulberry32(seed));
  return faces.map(([face, dir]) => {
    const base: V3 = [dir[0] * 9.80665, dir[1] * 9.80665, dir[2] * 9.80665];
    // 每个采样点单独过一遍生产链路，再取窗口均值（与真实采集的「静止窗口取均值」一致）
    const sum: V3 = [0, 0, 0];
    for (let i = 0; i < samplesPerFace; i++) {
      const s = accelChannel(base, model, g);
      sum[0] += s[0];
      sum[1] += s[1];
      sum[2] += s[2];
    }
    const raw: V3 = [sum[0] / samplesPerFace, sum[1] / samplesPerFace, sum[2] / samplesPerFace];
    return { face, raw };
  });
}

export function accelVerdict(beforeMs2: number, afterMs2: number): string {
  if (!Number.isFinite(beforeMs2) || !Number.isFinite(afterMs2)) return "（验证数据无效）";
  if (afterMs2 < beforeMs2 * 0.5) return "（校准有效）";
  if (afterMs2 < beforeMs2) return "（改善有限）";
  return "（未见改善：当前配置下标定与验证器件模型不同，或标定没有抓住真正的系统误差）";
}
