import type { ImuParams, ImuSample } from "./imu";
import { simulateImu } from "./imu";
import type { Quat, V3 } from "./quat";
import { qFromEuler, qId, qIntegrate, qMul, qConj, RAD } from "./quat";
import { Gauss, mulberry32 } from "./rng";
import { manualTarget, scenarios, type ManualTarget, type Scenario } from "./scenarios";
import { SensorPipeline } from "./sensor-pipeline";

const K_TRACK = 5; // 跟踪增益（rad/s per rad 姿态误差）
const W_MAX = 4.2; // 角速度上限（rad/s ≈ 240°/s）

/**
 * 采样率下的噪声口径（P2 修复）：
 * UI 滑块上的 gyroNoiseDps / accelNoise / magNoise 是**在 500 Hz 基准采样率下**的每样本 σ，
 * 等价于噪声密度 σ/√(fs/2)。当 `sensorSampleHz < 500` 时，器件实际每样本平均更久、
 * 带宽更窄，每样本 σ 应按 √(fs/500) 缩小——否则「降低采样率」会凭空放大噪声幅度。
 * 采样率 ≥ 基准或未启用时原样透传（保证历史默认值逐位不变）。
 */
function noiseScaledParams(p: ImuParams, h: number): ImuParams {
  const fs = p.sensorSampleHz ?? 0;
  const simHz = 1 / h;
  if (!(fs > 0) || fs >= simHz) return p;
  const scale = Math.sqrt(fs / simHz);
  return {
    ...p,
    gyroNoiseDps: p.gyroNoiseDps * scale,
    accelNoise: p.accelNoise * scale,
    magNoise: p.magNoise * scale,
  };
}

/** 仿真世界：真实姿态 + 姿态跟踪控制器 + IMU 生成 */
export class World {
  t = 0;
  q = qId();
  omega: V3 = [0, 0, 0];
  /** 运动学一致模式下的真值位置/速度（NED，米 / 米每秒）；普通剧本恒为 0 */
  posNed: V3 = [0, 0, 0];
  velNed: V3 = [0, 0, 0];
  /** 最近一步的世界系平动加速度（仅运动学模式；供 INS 真值/诊断） */
  currentAccelWorld: V3 = [0, 0, 0];
  /** 上一步的世界系平动加速度（梯形积分，与 INS 面板同阶） */
  private accelWorldPrev: V3 = [0, 0, 0];
  scenario: Scenario;
  /** 陀螺零偏随机游走的累积状态（°/s 三轴）：gyroWalkDps>0 时每步由高斯流推进（°/s/√s · √dt） */
  gyroWalk: V3 = [0, 0, 0];
  /**
   * 手动剧本的**实例**目标（默认用 scenarios.manualTarget 的当前值初始化）。
   * 不再与其他 World 共享同一对象：配置里的 `manualTargetDeg` 经 `setManualTarget()`
   * 写进来，同配置 + 同 seed 才能真正复现。
   */
  manual: ManualTarget = { ...manualTarget };
  gauss = new Gauss();
  /** 磁力计独立随机流：磁链开关不改变陀螺/加计噪声序列（同 seed 单变量对比的前提） */
  magGauss = new Gauss();
  /** 确定性种子；undefined = 沿用历史行为（Math.random，不可复现） */
  private seed?: number;
  /**
   * 传感器前端：带宽滤波 + 各传感器独立延迟（见 core/sensor-pipeline.ts）。
   * 历史实现只有整帧延迟；现在把「抗混叠带宽」与「三路时间戳不同步」也纳入同一层，
   * 默认参数下输出与旧实现逐位一致（pipeline 有透传快路径）。
   */
  private pipeline = new SensorPipeline();

  constructor(scenario: Scenario, seed?: number) {
    this.scenario = scenario;
    this.seed = seed;
    this.velNed = scenario.kinematic?.initialVelocityNed ? ([...scenario.kinematic.initialVelocityNed] as V3) : [0, 0, 0];
    if (seed !== undefined) {
      this.gauss = new Gauss(mulberry32(seed >>> 0));
      this.magGauss = new Gauss(mulberry32((seed ^ 0x9e3779b9) >>> 0));
    }
  }

  /**
   * 设置手动目标（度）。配置里的 `manualTargetDeg` 通过它进入世界；
   * 同配置 + 同 seed 因此可复现，不再依赖 `scenarios.manualTarget` 的进程级状态。
   */
  setManualTarget(deg: readonly [number, number, number]): void {
    this.manual.rollDeg = deg[0];
    this.manual.pitchDeg = deg[1];
    this.manual.yawDeg = deg[2];
  }

  /** 按 id 切换剧本；未知 id 回落到悬停，避免 scenario 变成 undefined 击穿仿真循环 */
  setScenario(id: string): Scenario {
    this.scenario = scenarios[id] ?? scenarios.hover;
    return this.scenario;
  }

  /** 复位；传入 seed 时重新播种（确定性实验），不传则重置状态但保留当前随机流位置 */
  reset(seed?: number): void {
    if (seed !== undefined) this.seed = seed;
    if (this.seed !== undefined) {
      this.gauss = new Gauss(mulberry32(this.seed >>> 0));
      this.magGauss = new Gauss(mulberry32((this.seed ^ 0x9e3779b9) >>> 0));
    }
    this.t = 0;
    this.q = qId();
    this.omega = [0, 0, 0];
    this.gyroWalk = [0, 0, 0];
    this.posNed = [0, 0, 0];
    this.velNed = this.scenario.kinematic?.initialVelocityNed
      ? ([...this.scenario.kinematic.initialVelocityNed] as V3)
      : [0, 0, 0];
    this.currentAccelWorld = [0, 0, 0];
    this.accelWorldPrev = [0, 0, 0];
    this.pipeline.reset();
  }

  /** 运动学一致模式下由姿态解析角速度：中心差分相对四元数，2h 窗口 */
  private kinematicOmega(t: number, h: number): V3 {
    const k = this.scenario.kinematic!;
    const e1 = k.attitudeEulerDeg(t - h).map((v) => v * RAD) as V3;
    const e2 = k.attitudeEulerDeg(t + h).map((v) => v * RAD) as V3;
    const q1 = qFromEuler(e1[0], e1[1], e1[2]);
    const q2 = qFromEuler(e2[0], e2[1], e2[2]);
    const dq = qMul(qConj(q1), q2); // q2 ≈ q1 ⊗ Δq_body
    const s = dq.w < 0 ? -1 : 1;
    return [2 * s * dq.x / (2 * h), 2 * s * dq.y / (2 * h), 2 * s * dq.z / (2 * h)];
  }

  /** 目标四元数：由当前剧本给出（手动模式即读滑块写入的共享目标） */
  private targetQ(): Quat {
    const [r, p, y] = this.scenario.targetEulerDeg(this.t, this);
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
    const k = this.scenario.kinematic;
    if (k) {
      const tNew = this.t + h;
      const e = k.attitudeEulerDeg(tNew).map((v) => v * RAD) as V3;
      this.q = qFromEuler(e[0], e[1], e[2]);
      this.omega = this.kinematicOmega(tNew, h);
      const a = k.accelWorld(tNew);
      this.currentAccelWorld = a;
      // 真值平动：梯形积分（与 INS 面板同阶，方便解析对照）
      const aPrev = this.accelWorldPrev;
      const vPrev: V3 = [...this.velNed];
      const vNew: V3 = [
        vPrev[0] + ((aPrev[0] + a[0]) / 2) * h,
        vPrev[1] + ((aPrev[1] + a[1]) / 2) * h,
        vPrev[2] + ((aPrev[2] + a[2]) / 2) * h,
      ];
      this.posNed = [
        this.posNed[0] + ((vPrev[0] + vNew[0]) / 2) * h,
        this.posNed[1] + ((vPrev[1] + vNew[1]) / 2) * h,
        this.posNed[2] + ((vPrev[2] + vNew[2]) / 2) * h,
      ];
      this.velNed = vNew;
      this.accelWorldPrev = a;
      this.t = tNew;
      const p = noiseScaledParams(imuParams, h);
      const sample = simulateImu(this.q, this.omega, this.t, p, this.gauss, this.scenario.accelFactor, this.gyroWalk, this.magGauss, a);
      return this.pipeline.push(sample, imuParams, h);
    }
    const omega = this.trackRate(feedbackQ ?? this.q, this.targetQ());
    this.omega = omega;
    this.q = qIntegrate(this.q, omega, h);
    this.t += h;
    const p = noiseScaledParams(imuParams, h);
    const sample = simulateImu(this.q, omega, this.t, p, this.gauss, this.scenario.accelFactor, this.gyroWalk, this.magGauss);
    return this.pipeline.push(sample, imuParams, h);
  }
}
