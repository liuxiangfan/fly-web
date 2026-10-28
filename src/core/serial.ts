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

/* ==========================================================================
   文本行协议：让「不写二进制固件」也能接进来
   --------------------------------------------------------------------------
   现实里最省事的做法是主控直接打印一行数：Serial.print(gx); Serial.print(',');
   ... 于是任何能输出串口的板子（Arduino / ESP32 / 树莓派）都能接上本装置，
   不必实现 28 字节帧协议。代价是带宽与时间戳精度，所以默认仍是二进制协议、
   文本模式在同一套回放路径上跑（帧时钟按名义间隔累加，有 t 列时优先按它计）。
   ========================================================================== */

export type SerialProtocol = "binary" | "text" | "mavlink";

/** 文本行协议每行最多这么多个数（多于此判为坏行，防把日志粘成一行时炸内存） */
const TEXT_MAX_FIELDS = 16;

export interface TextLineResult {
  /** 解析成功时的帧；失败/表头/注释为 null */
  frame: SerialImuFrame | null;
  /** 该行是否被当作表头忽略（首次出现非数字行） */
  header?: boolean;
  /** 失败原因（用于状态行统计提示，限流显示） */
  reason?: string;
}

/**
 * 解析一行文本 IMU 数据。规则（与仓库文档、导入回放三处口径一致）：
 *   6 列：gx,gy,gz,ax,ay,az
 *   9 列：再加 mx,my,mz
 *   10 列：再加一列**时间戳（秒）**放在最前（有它就用它计时，比名义间隔准）
 * 分隔符允许逗号 / 空格 / Tab / 分号；`#` 开头是注释；非数字行当表头忽略（只忽略一次）。
 * 单位固定：°/s、m/s²、μT——与二进制帧协议一致，不做自动单位换算（那是导入回放的职责，
 * 因为离线文件常常来自别人的工具链；这里如果猜单位反而会掩盖配置错误）。
 *
 * @param prevTickMs  上一帧时间（ms），无时间戳时用于累加名义间隔
 * @param nominalMs   名义帧间隔（ms）
 */
export function parseTextLine(
  line: string,
  mounting: Mounting,
  prevTickMs: number,
  nominalMs = NOMINAL_FRAME_MS,
): TextLineResult {
  const t = line.trim();
  if (!t || t.startsWith("#") || t.startsWith("//")) return { frame: null };
  const fields = t.split(/[,\s;]+/).filter((f) => f.length > 0);
  if (fields.length > TEXT_MAX_FIELDS) return { frame: null, reason: "字段过多（分隔符不对？）" };
  const nums = fields.map((f) => Number(f));
  if (nums.some((n) => !Number.isFinite(n))) {
    // 非数字行：当作表头忽略（第 3 列起才可能是表头，单个数是非数字则肯定是坏行）
    const hasLetters = /[a-zA-Z_一-龥]/.test(t);
    if (hasLetters) return { frame: null, header: true };
    return { frame: null, reason: "含无法解析的数字" };
  }
  let tSec: number | null = null;
  let g: number[];
  let a: number[];
  let m: number[] | null;
  if (nums.length === 6) {
    [g, a] = [nums.slice(0, 3), nums.slice(3, 6)];
    m = null;
  } else if (nums.length === 9) {
    [g, a, m] = [nums.slice(0, 3), nums.slice(3, 6), nums.slice(6, 9)];
  } else if (nums.length === 10) {
    tSec = nums[0];
    [g, a, m] = [nums.slice(1, 4), nums.slice(4, 7), nums.slice(7, 10)];
  } else {
    return {
      frame: null,
      reason: `列数 ${nums.length} 不支持（要 6 = 陀螺+加计、9 = 再加磁力计、10 = 时间戳 + 9）`,
    };
  }
  const tickMs = tSec !== null ? tSec * 1000 : prevTickMs + nominalMs;
  const gv: V3 = remount([g[0], g[1], g[2]], mounting);
  const av: V3 = remount([a[0], a[1], a[2]], mounting);
  const mv: V3 = m
    ? remount([m[0], m[1], m[2]], mounting)
    : [0, 0, 0];
  return {
    frame: { seq: 0, tickMs, gyroDps: gv, accelMs2: av, magUt: mv },
  };
}

/* ==========================================================================
   MAVLink v2（只解 RAW_IMU）——让装了 PX4/ArduPilot 的飞控不必改固件就能接入
   --------------------------------------------------------------------------
   本装置的二进制帧协议要求用户在自己的主控上组帧；而飞控用户手上已经有 MAVLink 流，
   于是「选对协议 + 点连接」就能用。这里只实现需要的那一条消息（RAW_IMU / id 27：
   9 轴原始读数），不做完整 MAVLink 栈——够用、可读、可验证。
   ========================================================================== */

/** MAVLink v2 起始符 */
export const MAVLINK_STX = 0xfd;
/** RAW_IMU 的消息 id（注意：不是 9——26 是 SCALED_IMU，27 才是 RAW_IMU） */
export const MAVLINK_MSG_RAW_IMU = 27;

/**
 * RAW_IMU 的 crc_extra。**这个常量不是抄来的，是算出来的**：
 * MAVLink 的 crc_extra = (CRC16/MCRF4XX 累计「消息名 + 各**基础字段**的『类型 字段名』」) 的高低字节异或，
 * 扩展字段（MAVLink 2 新增的）不参与——这正是新增扩展字段不破坏兼容的原因。
 * 算法本身用两个公开已知的常量反验过：HEARTBEAT → 50、ATTITUDE → 39，都与官方一致；
 * 据此算出 RAW_IMU → 144。自检里会**重新推导一遍并断言**（改字段表就当场失败）。
 */
export const MAVLINK_CRC_EXTRA_RAW_IMU = 144;

/** RAW_IMU 的单位换算（MAVLink 规范：加速度 mG、角速度 mrad/s、磁场 mGauss） */
const MG_TO_MS2 = 9.80665 / 1000;
const MRAD_TO_DPS = 180 / Math.PI / 1000;
const MGAUSS_TO_UT = 0.1;

/** CRC-16/MCRF4XX（MAVLink 用的那个：poly 0x1021、初值 0xFFFF、无反射无终值异或） */
export function mavlinkCrc16(data: Uint8Array, from: number, toExclusive: number): number {
  let crc = 0xffff;
  for (let i = from; i < toExclusive; i++) {
    let t = data[i] ^ (crc & 0xff);
    t = (t ^ (t << 4)) & 0xff;
    crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
  }
  return crc;
}

/** 把 crc_extra 折进 CRC（MAVLink 对每条消息都用它做一次「盐」） */
function foldCrcExtra(crc: number, extra: number): number {
  let t = extra ^ (crc & 0xff);
  t = (t ^ (t << 4)) & 0xff;
  return ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
}

/**
 * 由消息定义推导 crc_extra（导出是为了让自检能独立重算、锁定常量）。
 * @param fields 基础字段的 [类型, 字段名]，**按线序**（类型大小降序，同大小保持声明序）
 */
export function computeCrcExtra(name: string, fields: Array<[string, string]>): number {
  const bytes: number[] = [];
  const push = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  };
  push(`${name} `);
  for (const [type, fname] of fields) push(`${type} ${fname} `);
  let crc = 0xffff;
  const buf = Uint8Array.from(bytes);
  crc = mavlinkCrc16(buf, 0, buf.length);
  return (crc & 0xff) ^ (crc >> 8);
}

/** RAW_IMU 的基础字段（线序）——自检用它重算 crc_extra */
export const RAW_IMU_BASE_FIELDS: Array<[string, string]> = [
  ["uint64_t", "time_usec"],
  ["int16_t", "xacc"], ["int16_t", "yacc"], ["int16_t", "zacc"],
  ["int16_t", "xgyro"], ["int16_t", "ygyro"], ["int16_t", "zgyro"],
  ["int16_t", "xmag"], ["int16_t", "ymag"], ["int16_t", "zmag"],
];

/** 供测试/文档用的两个校验消息定义（官方 crc_extra 分别 50 与 39） */
export const HEARTBEAT_BASE_FIELDS: Array<[string, string]> = [
  ["uint32_t", "custom_mode"], ["uint8_t", "type"], ["uint8_t", "autopilot"],
  ["uint8_t", "base_mode"], ["uint8_t", "system_status"], ["uint8_t", "mavlink_version"],
];
export const ATTITUDE_BASE_FIELDS: Array<[string, string]> = [
  ["uint32_t", "time_boot_ms"], ["float", "roll"], ["float", "pitch"], ["float", "yaw"],
  ["float", "rollspeed"], ["float", "pitchspeed"], ["float", "yawspeed"],
];

export interface MavlinkParseResult {
  frame: SerialImuFrame | null;
  /** 本次吞掉的字节数（0 = 数据不够，等更多字节） */
  consumed: number;
  /** 失败原因（状态行提示用） */
  reason?: string;
}

/**
 * 从字节流里解一条 RAW_IMU。
 * @param invert 是否把三路读数取反——**这是必要的开关**：RAW_IMU 输出的是器件原始读数，
 *   它的符号取决于飞控里 IMU 的安装朝向，MAVLink 并不规定。本装置要求
 *   「静止时加计读数指向机体『下』、z 为正」，若你的飞链静止时 z 为负就勾选取反。
 *   判定方法是可观察的：连上后看 IMU 原始波形面板，静止时加计 z 应当是 +9.8 量级。
 */
export function parseMavlinkFrame(
  buffer: Uint8Array,
  mounting: Mounting,
  invert = false,
): MavlinkParseResult {
  // 找 STX
  let start = -1;
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === MAVLINK_STX) {
      start = i;
      break;
    }
  }
  if (start < 0) return { frame: null, consumed: Math.max(0, buffer.length - 1) };
  if (start > 0) return { frame: null, consumed: start };
  if (buffer.length < 12) return { frame: null, consumed: 0 }; // 最短帧头 10 + CRC 2

  const len = buffer[1];
  const incompat = buffer[2];
  const signed = (incompat & 0x01) !== 0;
  const total = 12 + len + (signed ? 13 : 0);
  if (buffer.length < total) return { frame: null, consumed: 0 }; // 帧不完整，等更多字节

  const msgid = buffer[7] | (buffer[8] << 8) | (buffer[9] << 16);
  const rx = buffer[10 + len] | (buffer[11 + len] << 8);
  if (msgid !== MAVLINK_MSG_RAW_IMU) {
    // 别的消息（心跳、姿态…）整帧跳过：飞控的流里它们占大多数
    return { frame: null, consumed: total, reason: `跳过消息 id=${msgid}` };
  }
  const want = foldCrcExtra(mavlinkCrc16(buffer, 1, 10 + len), MAVLINK_CRC_EXTRA_RAW_IMU);
  if (want !== rx) return { frame: null, consumed: 1, reason: "CRC 校验失败" }; // 只跳 1 字节重新找 STX

  // payload（线序）：u64 time_usec，随后 9×i16
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const low = dv.getUint32(10, true);
  const high = dv.getUint32(14, true);
  const tickMs = (low + high * 4294967296) / 1000; // μs → ms（u64 拆两半，避免精度丢失）
  const i16At = (o: number): number => dv.getInt16(o, true);
  const sign = invert ? -1 : 1;
  const toNed = (x: number, y: number, z: number): V3 =>
    remount([x * sign, y * sign, z * sign], mounting);
  // payload 字段序（RAW_IMU 的声明序）：u64 time_usec → xacc,yacc,zacc → xgyro,ygyro,zgyro → xmag,ymag,zmag
  // 即 payload 偏移 8/10/12 是**加速度**、14/16/18 是角速度、20/22/24 是磁场。
  // （此前把陀螺与加计写反过——往返自检当场抓到。）
  const frame: SerialImuFrame = {
    seq: buffer[4],
    tickMs,
    accelMs2: toNed(i16At(18) * MG_TO_MS2, i16At(20) * MG_TO_MS2, i16At(22) * MG_TO_MS2),
    gyroDps: toNed(i16At(24) * MRAD_TO_DPS, i16At(26) * MRAD_TO_DPS, i16At(28) * MRAD_TO_DPS),
    magUt: toNed(i16At(30) * MGAUSS_TO_UT, i16At(32) * MGAUSS_TO_UT, i16At(34) * MGAUSS_TO_UT),
  };
  return { frame, consumed: total };
}

/**
 * 按协议组一条 RAW_IMU 帧（自检往返用；也方便他人拿去做发送端参考）。
 * @param accelMs2 m/s²、@param gyroDps °/s、@param magUt μT（本装置的内部单位）
 */
export function buildMavlinkRawImu(
  seq: number,
  timeUs: bigint,
  accelMs2: V3,
  gyroDps: V3,
  magUt: V3,
  signed = false,
): Uint8Array {
  const payload = new Uint8Array(26);
  const dv = new DataView(payload.buffer);
  dv.setBigUint64(0, timeUs, true);
  const put = (o: number, v: number): void => {
    dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v))), true);
  };
  put(8, accelMs2[0] / MG_TO_MS2);
  put(10, accelMs2[1] / MG_TO_MS2);
  put(12, accelMs2[2] / MG_TO_MS2);
  put(14, gyroDps[0] / MRAD_TO_DPS);
  put(16, gyroDps[1] / MRAD_TO_DPS);
  put(18, gyroDps[2] / MRAD_TO_DPS);
  put(20, magUt[0] / MGAUSS_TO_UT);
  put(22, magUt[1] / MGAUSS_TO_UT);
  put(24, magUt[2] / MGAUSS_TO_UT);
  const d = new Uint8Array(12 + payload.length);
  d[0] = MAVLINK_STX;
  d[1] = payload.length;
  d[2] = signed ? 0x01 : 0x00; // incompat
  d[3] = 0x00; // compat
  d[4] = seq & 0xff;
  d[5] = 1; // sysid
  d[6] = 1; // compid
  d[7] = MAVLINK_MSG_RAW_IMU & 0xff;
  d[8] = (MAVLINK_MSG_RAW_IMU >> 8) & 0xff;
  d[9] = (MAVLINK_MSG_RAW_IMU >> 16) & 0xff;
  d.set(payload, 10);
  const crc = foldCrcExtra(mavlinkCrc16(d, 1, 10 + payload.length), MAVLINK_CRC_EXTRA_RAW_IMU);
  d[10 + payload.length] = crc & 0xff;
  d[11 + payload.length] = (crc >> 8) & 0xff;
  return d;
}
