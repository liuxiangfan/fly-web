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
  /** 陀螺零偏随机游走的累积状态（°/s 三轴）：gyroWalkDps>0 时每步由高斯流推进（°/s/√s · √dt） */
  gyroWalk: V3 = [0, 0, 0];
  /** 与 scenarios.manual 共享同一对象，滑块写入即生效 */
  manual: ManualTarget = manualTarget;
  gauss = new Gauss();
  /**
   * 传感器群延迟的环形缓冲（`sensorDelayMs` > 0 时启用）：
   * 真实 MEMS 的传输 + 抗混叠滤波把整帧采样推迟若干毫秒，算法拿到的是**过时**的姿态源。
   * 延迟对倒数第二步的积分没有影响（积分与采样同步滞后），但会让输出姿态相对真值
   * 滞后 ω·τ —— 机动中直接看到误差抬头，控制回路里表现为相位裕度被吃掉。
   */
  private delayBuf: ImuSample[] = [];

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
    this.gyroWalk = [0, 0, 0];
    this.delayBuf.length = 0;
  }

  /** 目标四元数：由当前剧本给出（手动模式即读滑块写入的共享目标） */
  private targetQ(): Quat {
    const [r, p, y] = this.scenario.targetEulerDeg(this.t);
    return qFromEuler(r * RAD, p * RAD, y * RAD);
  }

  /** 机体系姿态误差 → 期望角速度（比例控制，限幅，短路径） */
  private trackRate(qCurrent: Quat, qTarget: Quat): V3 {
    const qe = qMul(qConj(qCurrent), qTarget);
    const v: V3 = [qe.x, qe.y, qe.z];
    const vn = Math.hypot(v[0], v[1], v[2]);
    if (vn < 1e-9) return [0, 0, 0];
    const s = qe.w < 0 ? -1 : 1;
    const angle = 2 * Math.atan2(vn, Math.abs(qe.w));
    const rate = Math.min(K_TRACK * angle, W_MAX);
    const k = (s * rate) / vn;
    return [v[0] * k, v[1] * k, v[2] * k];
  }

  /**
   * 推进一个仿真步（h 秒），返回该步的 IMU 采样。
   * feedbackQ（闭环演示）：缺省时跟踪控制器用真实姿态算误差（理想飞控）；
   * 传入估计器输出的姿态后，控制器改用估计姿态——解算误差直接进入控制回路，
   * 「估计漂多少，机体就飞偏多少」：姿态解算精度的工程意义由此可见。
   */
  step(h: number, imuParams: ImuParams, feedbackQ?: Quat): ImuSample {
    if (imuParams.gyroWalkDps > 0) {
      // gyroWalk 状态单位 °/s（simulateImu 里与恒定零偏一起统一转 rad/s）
      const k = imuParams.gyroWalkDps * Math.sqrt(h);
      this.gyroWalk[0] += k * this.gauss.next();
      this.gyroWalk[1] += k * this.gauss.next();
      this.gyroWalk[2] += k * this.gauss.next();
    }
    const omega = this.trackRate(feedbackQ ?? this.q, this.targetQ());
    this.omega = omega;
    this.q = qIntegrate(this.q, omega, h);
    this.t += h;
    const sample = simulateImu(this.q, omega, this.t, imuParams, this.gauss, this.scenario.accelFactor, this.gyroWalk);
    return this.delayed(sample, imuParams.sensorDelayMs, h);
  }

  /**
   * 群延迟：把采样按 sensorDelayMs 排队，返回队列里最老的那一帧
   * （队列始终保持约 delay/h 帧，因此输出恰好滞后 sensorDelayMs）。
   * 延迟为 0 时零开销直通（不建队列、不改任何既有行为）。
   */
  private delayed(sample: ImuSample, delayMs: number, h: number): ImuSample {
    if (!(delayMs > 0)) {
      if (this.delayBuf.length) this.delayBuf.length = 0;
      return sample;
    }
    this.delayBuf.push(sample);
    const keep = Math.max(1, Math.round(delayMs / 1000 / h));
    let out = sample;
    while (this.delayBuf.length > keep) out = this.delayBuf.shift() as ImuSample;
    return out;
  }
}
