/**
 * IMU 日志导入（纯函数，可在 Node 自检）。
 *
 * 用途：把一份**录制的原始 IMU 数据**喂回装置做离线回放——不必有硬件，
 * 也可以用自己飞控/别人数据集里的真实噪声来跑五种算法。
 * 与「真实串口」共用同一套回放语义：没有真值，误差曲线以 Mahony 为基准。
 *
 * 接受的格式（按优先级）：
 *   1. 本装置导出的 CSV 里的原始 IMU 列（`gyro_x_dps` / `accel_x_ms2` / `mag_x_ut` …）
 *      —— 勾上导出弹窗里的「原始 IMU」即可拿到，与回放形成闭环。
 *   2. 带表头的通用 CSV：列名里能认出 g/x/y/z、a、m、t 即可（大小写、下划线宽容匹配）。
 *   3. 无表头的纯数字表：每行 7 列（t + 陀螺 3 + 加计 3）或 10 列（再加磁力计 3）。
 *
 * 单位从列名推断，识别不出时按「°/s、m/s²、μT」处理并把假设写进 notes——
 * 猜错单位不会报错但会让数据看起来不对，所以宁可把它**说出来**。
 * 时间列同理：识别为 ms 还是 s，判断依据也写进 notes。
 */
import type { V3 } from "./quat";

export interface ReplayFrame {
  /** 采样时刻（毫秒，任意零点；回放只用相邻差值） */
  tMs: number;
  /** °/s（机体系） */
  gyroDps: V3;
  /** m/s²（静止时机体 z ≈ +9.81） */
  accelMs2: V3;
  /** μT（机体系）；缺失时全 0 */
  magUt: V3;
  /** 该行是否带磁力计数据（三列都解析成功） */
  hasMag: boolean;
}

export interface ReplayParseResult {
  frames: ReplayFrame[];
  /** 识别到的列名 → 用途（诊断/提示用） */
  mapping: Record<string, string>;
  /** 跳过的行数（空行、注释、坏行） */
  skipped: number;
  /** 单位与时间轴的推断说明（原样显示给用户） */
  notes: string[];
  /** 失败原因；成功时为 undefined */
  error?: string;
}

const G = 9.80665;

/** 归一化列名：小写、去空格与常见分隔符，便于宽容匹配 */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s()[\]{}]/g, "").replace(/[-\/]+/g, "_");
}

type Axis = { x: number; y: number; z: number };

/** 判断某列属于哪个物理量、哪个轴、什么单位 */
interface ColSpec {
  role: "t" | "gyro" | "accel" | "mag";
  axis?: "x" | "y" | "z";
  /** 该列数值需要乘以的系数，换算到 °/s、m/s²、μT、秒 */
  scale: number;
}

function classify(header: string): ColSpec | null {
  const k = normKey(header);
  if (!k) return null;
  const has = (...keys: string[]) => keys.some((x) => k === x || k.includes(x));
  // 时间列：必须**整体**是时间名的有限形式。早期版本用「列名里含 _ms」判时间，
  // 结果把 accel_x_ms2 也当成了时间列（陀螺/加计映射随之丢失）——这类宽匹配是陷阱。
  if (/^(t|time|timestamp|tick|t_sec|t_s|t_ms|t_us|tsec|tms|time_s|time_ms|time_us|tick_ms)$/.test(k)) {
    const ms = /_?ms$/.test(k) || k === "tick" || k === "tms" || k === "tickms";
    return { role: "t", scale: ms ? 0.001 : 1 };
  }
  // 轴
  const axis: "x" | "y" | "z" | undefined = /(^|[^a-z])x($|[^a-z])|_x$|^gx$|^ax$|^mx$/.test(k)
    ? "x"
    : /(^|[^a-z])y($|[^a-z])|_y$|^gy$|^ay$|^my$/.test(k)
      ? "y"
      : /(^|[^a-z])z($|[^a-z])|_z$|^gz$|^az$|^mz$/.test(k)
        ? "z"
        : undefined;
  if (!axis) return null;
  const gyroUnit = has("rad") ? 180 / Math.PI : 1; // rad/s → °/s
  const accelUnit = /(^|[^a-z])g($|[^a-z])|_g$|in_g/.test(k) ? G : 1; // g → m/s²
  if (has("gyro", "omega", "rate", "dps", "w_")) {
    return { role: "gyro", axis, scale: gyroUnit };
  }
  if (has("accel", "accl", "specific", "linacc")) return { role: "accel", axis, scale: accelUnit };
  if (has("mag", "magnetic", "compass")) return { role: "mag", axis, scale: 1 };
  // 无前缀的短名（gx/ax/mx）
  if (/^g[x-z]$|^w[x-z]$/.test(k)) return { role: "gyro", axis, scale: gyroUnit };
  if (/^a[x-z]$/.test(k)) return { role: "accel", axis, scale: accelUnit };
  if (/^m[x-z]$/.test(k)) return { role: "mag", axis, scale: 1 };
  return null;
}

function medianDelta(times: number[]): number {
  if (times.length < 3) return 0;
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** 解析一行 CSV（容忍引号包裹与多余空格） */
function splitRow(line: string): string[] {
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

/**
 * @param maxRows 上限保护：超过则截断（默认 20 万行 ≈ 11 分钟 @300 Hz）
 */
export function parseImuCsv(text: string, maxRows = 200000): ReplayParseResult {
  const notes: string[] = [];
  const mapping: Record<string, string> = {};
  const raw = text.replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);

  // 找出表头行：第一个非空、非注释、且含非数字内容的行
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("#")) continue;
    const cells = splitRow(l);
    const numeric = cells.every((c) => c === "" || Number.isFinite(Number(c)));
    if (!numeric) headerIdx = i;
    break;
  }

  // 建立列映射
  let colRoles: Array<ColSpec | null> = [];
  let cols = 0;
  if (headerIdx >= 0) {
    const header = splitRow(lines[headerIdx]);
    cols = header.length;
    colRoles = header.map((h) => classify(h));
    header.forEach((h, i) => {
      const spec = colRoles[i];
      if (spec) mapping[h] = spec.axis ? `${spec.role}.${spec.axis}` : spec.role;
    });
  } else {
    // 无表头：按列数推断（7 列 = t+g+a；10 列 = +m）
    const firstData = lines.find((l) => l.trim() && !l.startsWith("#"));
    if (!firstData) return { frames: [], mapping, skipped: 0, notes, error: "文件里没有可解析的数据行" };
    cols = splitRow(firstData).length;
    if (cols !== 7 && cols !== 10) {
      return {
        frames: [], mapping, skipped: 0, notes,
        error: `无表头时只支持 7 列（t + 陀螺 3 + 加计 3）或 10 列（再加磁力计 3），当前是 ${cols} 列。请加上表头，或导出时勾选「原始 IMU」。`,
      };
    }
    colRoles = [{ role: "t", scale: 1 }];
    for (const role of ["gyro", "accel"] as const) {
      for (const axis of ["x", "y", "z"] as const) colRoles.push({ role, axis, scale: 1 });
    }
    if (cols === 10) {
      for (const axis of ["x", "y", "z"] as const) colRoles.push({ role: "mag", axis, scale: 1 });
    }
    notes.push("无表头：按列位置解释（t, gx, gy, gz, ax, ay, az [, mx, my, mz]），单位按 °/s / m/s² / μT");
    Object.assign(mapping, { "(列 1)": "t", "(列 2-4)": "gyro.xyz", "(列 5-7)": "accel.xyz" });
    if (cols === 10) mapping["(列 8-10)"] = "mag.xyz";
  }

  // 索引：角色 → 轴 → 列号
  const idx: Record<string, Partial<Axis>> = { t: {}, gyro: {}, accel: {}, mag: {} };
  const scaleOf: Record<string, Partial<Axis>> = { t: {}, gyro: {}, accel: {}, mag: {} };
  colRoles.forEach((spec, i) => {
    if (!spec) return;
    if (spec.role === "t") {
      idx.t.x = i;
      scaleOf.t.x = spec.scale;
    } else if (spec.axis) {
      idx[spec.role][spec.axis] = i;
      scaleOf[spec.role][spec.axis] = spec.scale;
    }
  });
  if (idx.t.x === undefined) {
    return { frames: [], mapping, skipped: 0, notes, error: "找不到时间列（列名里需要有 t / time / timestamp / tick）" };
  }
  if (idx.gyro.x === undefined || idx.accel.x === undefined) {
    return {
      frames: [], mapping, skipped: 0, notes,
      error: "找不到陀螺仪或加速度计列。列名请包含 gyro/accel（或 gx/gy/gz、ax/ay/az），行首是时间列。",
    };
  }

  // 逐行取值
  const frames: ReplayFrame[] = [];
  let skipped = 0;
  const startLine = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = startLine; i < lines.length && frames.length < maxRows; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("#")) continue;
    const cells = splitRow(l);
    if (cells.length < 7) {
      skipped++;
      continue;
    }
    const num = (c: number | undefined): number => (c === undefined ? NaN : Number(cells[c]));
    const t = num(idx.t.x) * (scaleOf.t.x ?? 1);
    const pick = (role: "gyro" | "accel" | "mag", axis: "x" | "y" | "z"): number => {
      const c = idx[role][axis];
      if (c === undefined) return 0;
      const v = Number(cells[c]);
      return Number.isFinite(v) ? v * (scaleOf[role][axis] ?? 1) : 0;
    };
    if (!Number.isFinite(t)) {
      skipped++;
      continue;
    }
    const magUt: V3 = [pick("mag", "x"), pick("mag", "y"), pick("mag", "z")];
    frames.push({
      tMs: t * 1000,
      gyroDps: [pick("gyro", "x"), pick("gyro", "y"), pick("gyro", "z")],
      accelMs2: [pick("accel", "x"), pick("accel", "y"), pick("accel", "z")],
      magUt,
      hasMag: idx.mag.x !== undefined && idx.mag.y !== undefined && idx.mag.z !== undefined,
    });
  }

  if (frames.length < 20) {
    return { frames, mapping, skipped, notes, error: `只解析到 ${frames.length} 帧，太少（至少 20 帧才能看出算法行为）` };
  }

  // 时间轴：先按列名给的单位解释；若中位采样间隔 > 0.5 s（几乎不可能是真实采样间隔，
  // 更可能是毫秒被当成秒），就按毫秒重解释一次。两种情况的假设都写进 notes。
  const checkMonotonic = (): boolean => {
    let bad = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i].tMs <= frames[i - 1].tMs) bad++;
    return bad === 0;
  };
  if (!checkMonotonic()) {
    // 容忍少量重复时间戳（有些日志会重复写同一 tick），全部重复才算错
    const bad = frames.filter((f, i) => i > 0 && f.tMs < frames[i - 1].tMs).length;
    if (bad > frames.length * 0.05) {
      return { frames: [], mapping, skipped, notes, error: "时间列不是递增的（无法作为回放时钟）——检查是不是选错了时间列" };
    }
    notes.push(`时间列有 ${bad} 处回退（已容忍，回放时按 frameDtSec 夹紧）`);
  }
  let dtMed = medianDelta(frames.map((f) => f.tMs)) / 1000;
  if (dtMed > 0.5) {
    for (const f of frames) f.tMs = f.tMs / 1000;
    dtMed = medianDelta(frames.map((f) => f.tMs)) / 1000;
    notes.push("时间列按**毫秒**重新解释（按秒算出的中位采样间隔超过 0.5 s，不合理）");
  }
  const span = (frames[frames.length - 1].tMs - frames[0].tMs) / 1000;
  notes.push(
    `时间轴：${frames.length} 帧 / ${span.toFixed(2)} s，中位采样间隔 ${(dtMed * 1000).toFixed(2)} ms（约 ${(1 / dtMed).toFixed(0)} Hz）`,
  );
  if (!frames[0].hasMag && !frames.some((f) => f.hasMag)) {
    notes.push("没有磁力计列：MARG 对这组数据无效（偏航将只能靠陀螺积分）");
  }
  const anyNonZero = (role: "gyro" | "accel") =>
    frames.some((f) => Math.hypot(...(role === "gyro" ? f.gyroDps : f.accelMs2)) > 1e-9);
  if (!anyNonZero("accel")) notes.push("加速度计列全是 0：检查列映射或单位");
  if (!anyNonZero("gyro")) notes.push("陀螺仪列全是 0：检查列映射或单位");
  return { frames, mapping, skipped, notes };
}
