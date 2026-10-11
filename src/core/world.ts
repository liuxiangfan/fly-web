import type { ImuParams, ImuSample } from "./imu";
import { simulateImu } from "./imu";
import type { Quat, V3 } from "./quat";
import { qFromEuler, qId, qIntegrate, qMul, qConj, RAD } from "./quat";
import { Gauss } from "./rng";
import { manualTarget, scenarios, type ManualTarget, type Scenario } from "./scenarios";

const K_TRACK = 5; // 跟踪增益（rad/s per rad 姿态误差）
const W_MAX = 4.2; // 角速度上限（rad/s ≈ 240°/s）

/** 仿真世界：真实姿态 + 姿态跟踪控制器 + IMU 生成 */
export class World {
  t = 0;
  q = qId();
  omega: V3 = [0, 0, 0];
  scenario: Scenario;
  /** 与 scenarios.manual 共享同一对象，滑块写入即生效 */
  manual: ManualTarget = manualTarget;
  gauss = new Gauss();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  /** 按 id 切换剧本；未知 id 回落到悬停，避免 scenario 变成 undefined 击穿仿真循环 */
  setScenario(id: string): Scenario {
    this.scenario = scenarios[id] ?? scenarios.hover;
    return this.scenario;
  }

  reset(): void {
    this.t = 0;
    this.q = qId();
    this.omega = [0, 0, 0];
  }

  /** 目标四元数：由当前剧本给出（手动模式即读滑块写入的共享目标） */
  private targetQ(): Quat {
    const [r, p, y] = this.scenario.targetEulerDeg(this.t);
    return qFromEuler(r * RAD, p * RAD, y * RAD);
  }

  /** 机体系误差 → 期望角速度（比例控制，限幅，短路径） */
  private trackRate(qTarget: Quat): V3 {
    const qe = qMul(qConj(this.q), qTarget);
    const v: V3 = [qe.x, qe.y, qe.z];
    const vn = Math.hypot(v[0], v[1], v[2]);
    if (vn < 1e-9) return [0, 0, 0];
    const s = qe.w < 0 ? -1 : 1;
    const angle = 2 * Math.atan2(vn, Math.abs(qe.w));
    const rate = Math.min(K_TRACK * angle, W_MAX);
    const k = (s * rate) / vn;
    return [v[0] * k, v[1] * k, v[2] * k];
  }

  /** 推进一个仿真步（h 秒），返回该步的 IMU 采样 */
  step(h: number, imuParams: ImuParams): ImuSample {
    const omega = this.trackRate(this.targetQ());
    this.omega = omega;
    this.q = qIntegrate(this.q, omega, h);
    this.t += h;
    return simulateImu(this.q, omega, this.t, imuParams, this.gauss, this.scenario.accelFactor);
  }
}
