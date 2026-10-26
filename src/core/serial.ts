/**
 * 真实 IMU 串口链路（纯函数部分，可在 Node 自检）：
 * 帧协议见 firmware/gy87.h——0xAA 0x55 | len=24 | seq u16 | tick u32 |
 * gyro i16×3 (0.1°/s) | accel i16×3 (0.01m/s²) | mag i16×3 (0.01μT) | crc8。
 * 解析器为流式喂入设计：任意粘包/截断/坏帧都能重同步（丢到下一个帧头）。
 */
import type { V3 } from "./quat";

export interface SerialImuFrame {
  seq: number;
  tickMs: number;
  /** °/s，机体系（已按 mounting 方向重排） */
  gyroDps: V3;
  /** m/s²，静止时 z ≈ +9.8（本装置取反号约定：读数 = 重力投影方向） */
  accelMs2: V3;
  /** μT，机体系 */
  magUt: V3;
}

/** CRC-8（多项式 0x07，初值 0），与固件一致；覆盖 len 起到 CRC 前的所有字节 */
export function crc8(data: Uint8Array, from: number, toExclusive: number): number {
  let crc = 0;
  for (let i = from; i < toExclusive; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** GY-87 模块在机体上的安装方向：模块丝印轴 → NED 机体系（x 前 y 右 z 下）的映射 */
export type Mounting = "x-front-y-left" | "x-front-y-right" | "y-front-x-left" | "y-front-x-right";

/** 模块三轴 → NED 机体系三轴的重排矩阵行（每行取模块轴下标，含符号） */
const MOUNT_MAP: Record<Mounting, Array<[number, number]>> = {
  // [模块轴下标, 符号] × 3（NED x/y/z 行）
  "x-front-y-left": [[0, 1], [1, -1], [2, 1]], // 默认：模块 x=前、y=左 → 机体 y(右)=−模块y
  "x-front-y-right": [[0, 1], [1, 1], [2, 1]],
  "y-front-x-left": [[1, 1], [0, -1], [2, 1]],
  "y-front-x-right": [[1, 1], [0, 1], [2, 1]],
};

function remount(v: V3, m: Mounting): V3 {
  const rows = MOUNT_MAP[m];
  return [
    v[rows[0][0]] * rows[0][1],
    v[rows[1][0]] * rows[1][1],
    v[rows[2][0]] * rows[2][1],
  ];
}

/** 固件帧总长（含帧头与 CRC） */
export const FRAME_LEN = 28;

/** 固件名义帧间隔（200 Hz）——tick 缺失/回绕/异常时的兜底 dt */
export const NOMINAL_FRAME_MS = 5;

/**
 * 由相邻两帧的固件 tick（u32 毫秒）求真实积分步长（秒）。
 * 用固件时间而不是主机到达时间：串口缓冲/浏览器调度会抖动，但 tick 是
 * 采样时刻的真值；`>>> 0` 处理 u32 回绕（约 49.7 天一圈）。
 * 异常情况（首帧、回绕后的巨跳、超过 200ms 的空洞）退回名义帧间隔，
 * 最终夹在 [1ms, 50ms]——坏时间戳不会把滤波器一步推飞。
 */
export function frameDtSec(prevTickMs: number, tickMs: number, nominalMs = NOMINAL_FRAME_MS): number {
  const deltaMs = (tickMs - prevTickMs) >>> 0;
  const ms = deltaMs > 0 && deltaMs <= 200 ? deltaMs : nominalMs;
  return Math.min(0.05, Math.max(0.001, ms / 1000));
}

const le16 = (d: Uint8Array, i: number): number => d[i] | (d[i + 1] << 8);
const lei16 = (d: Uint8Array, i: number): number => {
  const v = le16(d, i);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const leu32 = (d: Uint8Array, i: number): number =>
  (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/** 在 buffer 中从 from 开始找 0xAA 0x55；找不到返回 -1 */
function findSync(buffer: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0xaa && buffer[i + 1] === 0x55) return i;
  }
  return -1;
}

/**
 * 喂入任意长度的字节流，弹出完整且 CRC 正确的帧（一次至多一帧），
 * 返回 { frame, consumed }——consumed 为本次吞掉的字节数（含坏帧丢弃部分）。
 * 调用方把剩余字节留在缓冲区尾部继续喂。帧 gap 由接收节奏自然形成，无需分隔符。
 */
export function parseFrame(
  buffer: Uint8Array,
  mounting: Mounting,
): { frame: SerialImuFrame; consumed: number } | { frame: null; consumed: number } {
  let start = findSync(buffer, 0);
  if (start < 0) return { frame: null, consumed: Math.max(0, buffer.length - 1) }; // 留 1 字节防帧头劈跨
  if (start > 0) return { frame: null, consumed: start }; // 先丢弃帧头前的垃圾，下次再解析
  if (buffer.length < FRAME_LEN) return { frame: null, consumed: 0 }; // 帧不完整：等更多字节
  if (buffer[2] !== 24) return { frame: null, consumed: 2 }; // len 错：帧头是巧合，跳过重同步
  if (crc8(buffer, 2, 27) !== buffer[27]) return { frame: null, consumed: 2 }; // 坏帧：跳过帧头重同步
  const frame: SerialImuFrame = {
    seq: le16(buffer, 3),
    tickMs: leu32(buffer, 5),
    gyroDps: remount([lei16(buffer, 9) / 10, lei16(buffer, 11) / 10, lei16(buffer, 13) / 10], mounting),
    accelMs2: remount(
      [lei16(buffer, 15) / 100, lei16(buffer, 17) / 100, lei16(buffer, 19) / 100],
      mounting,
    ),
    magUt: remount([lei16(buffer, 21) / 100, lei16(buffer, 23) / 100, lei16(buffer, 25) / 100], mounting),
  };
  return { frame, consumed: FRAME_LEN };
}

/** 测试/演示用：按协议组一帧（与固件组帧一致；selftest 往返验证用） */
export function buildFrame(
  seq: number,
  tickMs: number,
  gyroDps: V3,
  accelMs2: V3,
  magUt: V3,
  corrupt?: { at: number; value: number },
): Uint8Array {
  const d = new Uint8Array(FRAME_LEN);
  d[0] = 0xaa;
  d[1] = 0x55;
  d[2] = 24;
  d[3] = seq & 0xff;
  d[4] = (seq >> 8) & 0xff;
  d[5] = tickMs & 0xff;
  d[6] = (tickMs >> 8) & 0xff;
  d[7] = (tickMs >> 16) & 0xff;
  d[8] = (tickMs >>> 24) & 0xff;
  const put = (off: number, v: number, scale: number): void => {
    const x = Math.round(v * scale);
    const u = x < 0 ? x + 0x10000 : x;
    d[off] = u & 0xff;
    d[off + 1] = (u >> 8) & 0xff;
  };
  put(9, gyroDps[0], 10);
  put(11, gyroDps[1], 10);
  put(13, gyroDps[2], 10);
  put(15, accelMs2[0], 100);
  put(17, accelMs2[1], 100);
  put(19, accelMs2[2], 100);
  put(21, magUt[0], 100);
  put(23, magUt[1], 100);
  put(25, magUt[2], 100);
  d[27] = crc8(d, 2, 27);
  if (corrupt) d[corrupt.at] = corrupt.value;
  return d;
}
