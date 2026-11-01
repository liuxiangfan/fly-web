/**
 * 传感器前端流水线：带宽（一阶低通）、采样率零阶保持与**各传感器独立延迟**。
 *
 * 为什么单独成模块：这几项都属于「采样前/采样时的物理效应」，与姿态算法无关；
 * 把它们从 World 里拆出来，一是有独立自检（无滤波器时逐位透传、纯延迟等于历史帧），
 * 二是给「群延迟只是整帧延后」这个过强简化补上前提：真实陀螺/加计/磁的传输与滤波不同步。
 *
 * 约定：
 *  - `sensorBandwidthHz <= 0` 表示关闭（完全透传，既有噪声序列逐位不变）；
 *  - 有效延迟 = `sensorDelayMs` ± 各传感器差：陀螺 −skew、加计 0、磁 +skew（都夹到 ≥0）；
 *  - 延迟用历史队列 + **非整数延迟线性插值**实现：整数帧延迟取历史帧（与旧实现逐位一致），
 *    非整数（如 2.5 ms @500 Hz）在相邻两帧间按权重插值，而不是四舍五入成整帧；
 *  - 输出带**各通道自己的采样时刻** `times`（秒）：`times.gyro < times.accel < times.mag`
 *    说明三路延迟不同步。透传快路径不加 `times`，以保持历史逐位一致的契约。
 */
import type { ImuParams, ImuSample } from "./imu";
import type { V3 } from "./quat";

interface HistoryEntry {
  sample: ImuSample;
  /** 这一帧「底层样本被采到」的时刻（秒，与调用方传入的时间累加一致） */
  takenAt: number;
}

export class SensorPipeline {
  private history: HistoryEntry[] = [];
  private lpGyro: V3 | null = null;
  private lpAccel: V3 | null = null;
  private lpMag: V3 | null = null;
  /** 采样率低于仿真步长时的零阶保持状态 */
  private held: ImuSample | null = null;
  private heldTakenAt = 0;
  private sampleAcc = 0;
  private lastOut: ImuSample | null = null;
  /** 内部时间累计（每 push 加 h）：只用于给输出打时间戳，与 World.t 同源同尺度 */
  private simT = 0;

  reset(): void {
    this.history.length = 0;
    this.lpGyro = null;
    this.lpAccel = null;
    this.lpMag = null;
    this.held = null;
    this.heldTakenAt = 0;
    this.sampleAcc = 0;
    this.lastOut = null;
    this.simT = 0;
  }

  /** 推入一帧「真值 + 噪声」采样，返回经过带宽/采样率/延迟后的采样 */
  push(sample: ImuSample, p: ImuParams, h: number): ImuSample {
    this.simT += h;
    const bw = p.sensorBandwidthHz ?? 0;
    const skew = Math.max(0, p.sensorDelaySkewMs ?? 0);
    const base = Math.max(0, p.sensorDelayMs ?? 0);
    const fs = p.sensorSampleHz ?? 0;
    const gyroDelay = Math.max(0, base - skew);
    const accelDelay = base;
    const magDelay = base + skew;

    const decimating = fs > 0 && fs * h < 1 - 1e-9; // 采样率低于仿真步长
    // 无带宽、无采样率降频、无延迟差且共用延迟为 0：完全透传（保持历史基准逐位一致）
    if (!(bw > 0) && !decimating && skew === 0 && base === 0) {
      this.history.length = 0;
      this.held = null;
      this.lastOut = sample;
      return sample;
    }

    let filtered = sample;
    if (bw > 0) {
      const a = 1 - Math.exp(-2 * Math.PI * bw * h);
      const filt = (prev: V3 | null, cur: V3): V3 =>
        prev ? [prev[0] + a * (cur[0] - prev[0]), prev[1] + a * (cur[1] - prev[1]), prev[2] + a * (cur[2] - prev[2])] : [...cur];
      this.lpGyro = filt(this.lpGyro, sample.gyro);
      this.lpAccel = filt(this.lpAccel, sample.accel);
      this.lpMag = filt(this.lpMag, sample.mag);
      filtered = { gyro: [...this.lpGyro], accel: [...this.lpAccel], mag: [...this.lpMag] };
    }

    // 采样率降频：每 1/fs 秒才取一个新样本，其余时间保持上一个样本（零阶保持）
    let sampled = filtered;
    let newSample = true;
    if (decimating) {
      const period = 1 / fs;
      this.sampleAcc += h;
      if (this.sampleAcc + 1e-12 < period && this.held) {
        sampled = this.held;
        newSample = false;
      } else {
        this.sampleAcc = Math.max(0, this.sampleAcc - period);
        this.held = filtered;
        this.heldTakenAt = this.simT; // 新样本的采样时刻（保持相位的样本沿用上一次的时刻）
      }
    } else {
      this.held = filtered;
      this.heldTakenAt = this.simT;
    }

    const maxDelay = Math.max(gyroDelay, accelDelay, magDelay);
    if (maxDelay <= 0) {
      this.history.length = 0;
      // 零延迟也要给 times：采样保持（fs < 500 Hz）本身就带最多一个采样周期的滞后，
      // 缺了 times 调用方就只能猜——而且"有时有、有时没有"会让导出的
      // `# sensor_lag_ms=` 行时有时无（复核 P2-2）。
      const out0: ImuSample = {
        gyro: sampled.gyro,
        accel: sampled.accel,
        mag: sampled.mag,
        times: { gyro: this.heldTakenAt, accel: this.heldTakenAt, mag: this.heldTakenAt },
      };
      this.lastOut = out0;
      return out0;
    }
    if (!newSample && this.lastOut) return this.lastOut; // 没有新样本：延迟输出保持不变
    this.history.push({ sample: sampled, takenAt: this.heldTakenAt });
    // 历史按**时间**保留：降采样后样本间隔是 1/fs，用仿真空步数估长度会严重偏小。
    // 必须多留**一个采样周期**：插值要找"跨过目标时刻的相邻两帧"，只留 maxDelay+余量时
    // 缓慢采样（5 Hz/250 ms 延迟）会在历史里找不到目标之前的帧，插值退化成"下一个样本"，
    // 实际年龄 200 ms 而不是配置的 250 ms（复核 P2-2）。
    const samplePeriod = fs > 0 ? 1 / fs : 0;
    const keepSec = maxDelay / 1000 + samplePeriod + 2 * h + 0.05;
    while (this.history.length > 2 && this.simT - this.history[0].takenAt > keepSec) this.history.shift();

    /**
     * 按延迟（ms）取通道值：**按各帧的采样时刻寻址**，与仿真步长无关。
     *
     * 这段原来是「延迟 ÷ 仿真步长 → 历史下标」：在降采样时历史里只有新样本，
     * 下标换算会把 10 ms 的延迟放大成「几个采样周期」——500 Hz 仿真 + 50 Hz 采样
     * 实测变成 100 ms（复核反例），延迟实验的结论因此不可信。
     * 现在改为：目标时刻 = 当前时刻 − 延迟，在历史里找**跨过该时刻的相邻两帧**插值；
     * 时间轴上的点总是精确落在两帧之间，量化误差只剩插值本身的 O(h²)。
     */
    const now = this.simT;
    const pick = (delayMs: number, fn: (s: ImuSample) => V3): { v: V3; t: number } => {
      const target = now - delayMs / 1000;
      const n = this.history.length;
      // newest-at-or-before：从新到旧找第一个 takenAt <= target 的帧
      let lo = 0;
      for (let i = n - 1; i >= 0; i--) {
        if ((this.history[i] as HistoryEntry).takenAt <= target + 1e-12) {
          lo = i;
          break;
        }
      }
      const eLo = this.history[lo] as HistoryEntry;
      const eHi = lo + 1 < n ? (this.history[lo + 1] as HistoryEntry) : null;
      if (!eHi) return { v: fn(eLo.sample), t: eLo.takenAt }; // 延迟长于历史：退化到最旧帧（调用方已有 keepSec 保证）
      const span = eHi.takenAt - eLo.takenAt;
      const frac = span > 1e-15 ? Math.min(1, Math.max(0, (target - eLo.takenAt) / span)) : 0;
      if (frac < 1e-9) return { v: fn(eLo.sample), t: eLo.takenAt };
      if (frac > 1 - 1e-9) return { v: fn(eHi.sample), t: eHi.takenAt };
      const a = fn(eLo.sample);
      const b = fn(eHi.sample);
      return {
        v: [a[0] + frac * (b[0] - a[0]), a[1] + frac * (b[1] - a[1]), a[2] + frac * (b[2] - a[2])],
        t: eLo.takenAt + frac * span,
      };
    };
    const g = pick(gyroDelay, (s) => s.gyro);
    const a = pick(accelDelay, (s) => s.accel);
    const m = pick(magDelay, (s) => s.mag);
    const out: ImuSample = {
      gyro: g.v,
      accel: a.v,
      mag: m.v,
      // 各通道的采样时刻：三路延迟不同步时这三个数会分开
      times: { gyro: g.t, accel: a.t, mag: m.t },
    };
    this.lastOut = out;
    return out;
  }
}
