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
import { qNorm, type Quat, type V3 } from "./quat";

export interface ReplayFrame {
  /** 采样时刻（毫秒，任意零点；回放只用相邻差值） */
  tMs: number;
  /** °/s（机体系） */
  gyroDps: V3;
  /** m/s²（静止时机体 z ≈ +9.81） */
  accelMs2: V3;
  /** μT（机体系）；缺失时全 0 */
  magUt: V3;
  /** 该行是否带**有效**磁力计数据（三列都存在且有限） */
  hasMag: boolean;
  /** 该行三轴陀螺仪是否都有效（无效帧不会进入 frames） */
  gyroValid: boolean;
  /** 该行三轴加速度计是否都有效（无效帧不会进入 frames） */
  accelValid: boolean;
  /** 可选外部真值姿态（带 truth_qw… 或 q_true_w… 列时） */
  qTrue?: Quat;
}

export interface ReplayParseResult {
  frames: ReplayFrame[];
  /** 识别到的列名 → 用途（诊断/提示用） */
  mapping: Record<string, string>;
  /** 跳过的行数（空行、注释、坏行） */
  skipped: number;
  /** 因关键列缺失/非有限而拒绝的样本行数（不会被当成 0 喂进估计器） */
  invalidRows: number;
  /** 单位与时间轴的推断说明（原样显示给用户） */
  notes: string[];
  /** 是否包含外部真值姿态列 */
  hasTruth: boolean;
  /**
   * 日志元数据声明的 IMU 列语义：
   *  - `false` = 原始读数（回放时应按需再次应用磁/加计校准，本装置导出默认值）；
   *  - `true` = 已经校准过的读数（回放**不得**重复校准）；
   *  - `null` = 日志没有声明（按原始处理，并在 notes 里说明假设）。
   */
  imuCalibrated: boolean | null;
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
  /**
   * 时间列的单位**来源**：显式（列名声明 s/ms/us）还是未知（裸 t/time/timestamp）。
   *
   * 为什么必须把"来源"和"换算系数"分开存：只留系数的话，后面就无法区分
   * 「列名已经声明毫秒」与「裸列名按秒解释」——两者都会得到同一个 scale，
   * 于是一个 19 秒的低频日志会被"毫秒被当成秒"的启发式再除 1000（复核 SW-01）。
   */
  timeUnit?: "s" | "ms" | "us" | "unknown";
}

function classify(header: string): ColSpec | null {
  const k = normKey(header);
  if (!k) return null;
  const has = (...keys: string[]) => keys.some((x) => k === x || k.includes(x));
  // 时间列：必须**整体**是时间名的有限形式。早期版本用「列名里含 _ms」判时间，
  // 结果把 accel_x_ms2 也当成了时间列（陀螺/加计映射随之丢失）——这类宽匹配是陷阱。
  if (/^(t|time|timestamp|tick|t_sec|t_s|t_ms|t_us|tsec|tms|time_s|time_ms|time_us|tick_ms)$/.test(k)) {
    // 显式单位优先：声明了 s/ms/us 就严格按它换算，**禁止**后续启发式再改一次。
    // 裸 t / time / timestamp 单位未知，允许按中位间隔推断（推断结果写进 notes）。
    const timeUnit: "s" | "ms" | "us" | "unknown" =
      /_?us$/.test(k) ? "us"
        : /_?ms$/.test(k) || k === "tick" || k === "tms" || k === "tickms" ? "ms"
          : k === "t" || k === "time" || k === "timestamp" ? "unknown"
            : "s";
    const scale = timeUnit === "ms" ? 0.001 : timeUnit === "us" ? 1e-6 : 1;
    return { role: "t", scale, timeUnit };
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

/**
 * 时间列单位的可读名（写进 notes，让"猜了什么单位"在界面上可见）。
 * 参数写成完整联合类型：调用点因为初始值被 TS 收窄成字面量，直接比较会报"无重叠"。
 */
export function labelOfTimeUnit(unit: "s" | "ms" | "us" | "unknown"): string {
  switch (unit) {
    case "s": return "秒";
    case "ms": return "毫秒";
    case "us": return "微秒";
    default: return "未知";
  }
}

/**
 * 有效时间轴 = 逐帧**运行最大值**（单调不降）。
 * 时间列允许少量回退（见 `parseImuCsv` 的容忍策略），但回退段不能再被积一次：
 * 长度、进度与每帧 dt 必须共用这一条轴，否则「时长」与「实际积分」会各说各话。
 * 这里导出为纯函数，让解析器的时长提示与 `ReplayPlayer` 用**同一份实现**，
 * 而不是各自再写一遍"末帧减首帧"。
 */
export function monotonicTimelineMs(tMs: readonly number[]): number[] {
  const out = new Array<number>(tMs.length);
  let prev = tMs.length > 0 ? tMs[0]! : 0;
  for (let i = 0; i < tMs.length; i++) {
    const t = Math.max(prev, tMs[i]!);
    out[i] = t;
    prev = t;
  }
  return out;
}

/**
 * 解析一行 CSV：支持双引号包裹字段与 "" 转义逗号；容许多余空格。
 * 旧实现只去掉首尾引号，遇到 "a,b" 会错列——这类日志在 Excel 导出里很常见。
 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * @param maxRows 上限保护：超过则截断（默认 20 万行 ≈ 11 分钟 @300 Hz）
 */
export function parseImuCsv(text: string, maxRows = 200000): ReplayParseResult {
  const notes: string[] = [];
  const mapping: Record<string, string> = {};
  const raw = text.replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);

  // 注释行里的 IMU 语义声明（本装置导出的 `# imu=raw` / `# imu=calibrated`）
  let imuCalibrated: boolean | null = null;
  for (const l of lines) {
    const m = /^\s*#\s*imu\s*=\s*(raw|calibrated|cal)\b/i.exec(l);
    if (!m) continue;
    imuCalibrated = m[1].toLowerCase() !== "raw";
    break;
  }

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
  /** 外部真值四元数列（truth_qw / q_true_w / ref_qx …） */
  const truthIdx: Partial<Record<"w" | "x" | "y" | "z", number>> = {};
  let cols = 0;
  if (headerIdx >= 0) {
    const header = splitRow(lines[headerIdx]);
    cols = header.length;
    colRoles = header.map((h) => classify(h));
    header.forEach((h, i) => {
      const spec = colRoles[i];
      if (spec) mapping[h] = spec.axis ? `${spec.role}.${spec.axis}` : spec.role;
      const k = normKey(h);
      const m =
        /^(?:truth|true|ref|reference)_?q_?([wxyz])$/.exec(k) ??
        /^q_?(?:truth|true|ref|reference)_?([wxyz])$/.exec(k);
      if (m) {
        truthIdx[m[1] as "w" | "x" | "y" | "z"] = i;
        mapping[h] = `truth.${m[1]}`;
      }
    });
    // 重复/歧义列：同一 role.axis 出现两次时数据归属不可判定，直接报错而不是悄悄覆盖
    const seen = new Map<string, number>();
    colRoles.forEach((spec, i) => {
      if (!spec || !spec.axis) return;
      const key = `${spec.role}.${spec.axis}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if ((seen.get(key) ?? 0) > 1) {
        return; // 统一在循环外报错，避免提前 return 丢失信息
      }
      void i;
    });
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (dup.length) {
      return {
        frames: [], mapping, skipped: 0, invalidRows: 0, hasTruth: false, imuCalibrated, notes,
        error: `列名有歧义：${dup.join("、")} 各出现多次。请保留一份（例如 gyro_x_dps 与 gx 只留一个），否则无法判断该用哪一列。`,
      };
    }
  } else {
    // 无表头：按列数推断（7 列 = t+g+a；10 列 = +m）
    const firstData = lines.find((l) => l.trim() && !l.startsWith("#"));
    if (!firstData) return { frames: [], mapping, skipped: 0, invalidRows: 0, hasTruth: false, imuCalibrated, notes, error: "文件里没有可解析的数据行" };
    cols = splitRow(firstData).length;
    if (cols !== 7 && cols !== 10) {
      return {
        frames: [], mapping, skipped: 0, invalidRows: 0, hasTruth: false, imuCalibrated, notes,
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
  /** 时间列的单位来源（显式 s/ms/us 或未知）；决定是否允许"毫秒被当成秒"的启发式 */
  let timeUnit: "s" | "ms" | "us" | "unknown" = "unknown";
  colRoles.forEach((spec, i) => {
    if (!spec) return;
    if (spec.role === "t") {
      idx.t.x = i;
      scaleOf.t.x = spec.scale;
      // 无表头路径的 ColSpec 不带 timeUnit → 视为"未知"，与裸 t/time 同样允许启发式
      timeUnit = spec.timeUnit ?? "unknown";
    } else if (spec.axis) {
      idx[spec.role][spec.axis] = i;
      scaleOf[spec.role][spec.axis] = spec.scale;
    }
  });
  if (idx.t.x === undefined) {
    return { frames: [], mapping, skipped: 0, invalidRows: 0, hasTruth: false, imuCalibrated, notes, error: "找不到时间列（列名里需要有 t / time / timestamp / tick）" };
  }
  if (idx.gyro.x === undefined || idx.accel.x === undefined) {
    return {
      frames: [], mapping, skipped: 0, invalidRows: 0, hasTruth: false, imuCalibrated, notes,
      error: "找不到陀螺仪或加速度计列。列名请包含 gyro/accel（或 gx/gy/gz、ax/ay/az），行首是时间列。",
    };
  }

  // 逐行取值：关键列缺失/非有限 → 整行拒绝（绝不把坏样本填 0 喂进估计器）
  const frames: ReplayFrame[] = [];
  let skipped = 0;
  let invalidRows = 0;
  let truthRows = 0;
  const startLine = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = startLine; i < lines.length && frames.length < maxRows; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("#")) continue;
    const cells = splitRow(l);
    if (cells.length < 7) {
      skipped++;
      continue;
    }
    const tRaw = idx.t.x === undefined ? NaN : Number(cells[idx.t.x]);
    const t = tRaw * (scaleOf.t.x ?? 1);
    const axisVal = (role: "gyro" | "accel" | "mag", axis: "x" | "y" | "z"): number | null => {
      const c = idx[role][axis];
      if (c === undefined) return null;
      const v = Number(cells[c]);
      return Number.isFinite(v) ? v * (scaleOf[role][axis] ?? 1) : null;
    };
    if (!Number.isFinite(t)) {
      skipped++;
      continue;
    }
    const gx = axisVal("gyro", "x"), gy = axisVal("gyro", "y"), gz = axisVal("gyro", "z");
    const ax = axisVal("accel", "x"), ay = axisVal("accel", "y"), az = axisVal("accel", "z");
    if (gx === null || gy === null || gz === null || ax === null || ay === null || az === null) {
      invalidRows++;
      continue;
    }
    const mx = axisVal("mag", "x"), my = axisVal("mag", "y"), mz = axisVal("mag", "z");
    const hasMag = mx !== null && my !== null && mz !== null;
    const qw = truthIdx.w === undefined ? NaN : Number(cells[truthIdx.w]);
    const qx = truthIdx.x === undefined ? NaN : Number(cells[truthIdx.x]);
    const qy = truthIdx.y === undefined ? NaN : Number(cells[truthIdx.y]);
    const qz = truthIdx.z === undefined ? NaN : Number(cells[truthIdx.z]);
    const truthOk = [qw, qx, qy, qz].every(Number.isFinite);
    if (truthOk) truthRows++;
    frames.push({
      tMs: t * 1000,
      gyroDps: [gx, gy, gz],
      accelMs2: [ax, ay, az],
      magUt: hasMag ? [mx as number, my as number, mz as number] : [0, 0, 0],
      hasMag,
      gyroValid: true,
      accelValid: true,
      ...(truthOk ? { qTrue: qNorm({ w: qw, x: qx, y: qy, z: qz }) } : {}),
    });
  }
  const hasTruth = truthRows > 0 && truthRows === frames.length;
  if (invalidRows > 0) notes.push(`拒绝了 ${invalidRows} 行关键列缺失/非有限样本（不会当成 0 参与解算）`);
  if (truthRows > 0 && !hasTruth) {
    notes.push(`外部真值列只覆盖 ${truthRows}/${frames.length} 帧：为避免误差基准中途切换，本次不启用外部真值`);
  }

  if (frames.length < 20) {
    return { frames, mapping, skipped, invalidRows, hasTruth, imuCalibrated, notes, error: `只解析到 ${frames.length} 帧，太少（至少 20 帧才能看出算法行为）` };
  }

  // 时间轴：**声明了单位就严格按它解释**，只有单位未知的裸列名（t / time / timestamp）
  // 和无表头文件才允许"中位间隔 >0.5 s 说明其实是毫秒"的启发式。
  //
  // 为什么必须这样分开（复核 SW-01）：表头写 `t_s`、时间 0…19（1 Hz）的日志曾被启发式
  // 再除 1000，19 秒变成 0.019 秒——时长、积分与收敛判断一起失真。
  // 单位来源与推断结果都写进 notes，"猜错单位不会报错但看起来不对"这条约定仍然成立。
  const checkMonotonic = (): boolean => {
    let bad = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i].tMs <= frames[i - 1].tMs) bad++;
    return bad === 0;
  };
  if (!checkMonotonic()) {
    // 容忍少量重复时间戳（有些日志会重复写同一 tick），全部重复才算错
    const bad = frames.filter((f, i) => i > 0 && f.tMs < frames[i - 1].tMs).length;
    if (bad > frames.length * 0.05) {
      return { frames: [], mapping, skipped, invalidRows, hasTruth: false, imuCalibrated, notes, error: "时间列不是递增的（无法作为回放时钟）——检查是不是选错了时间列" };
    }
    notes.push(`时间列有 ${bad} 处回退（已容忍，回放时按 frameDtSec 夹紧）`);
  }
  const timeUnitLabel = labelOfTimeUnit(timeUnit);
  const dtMed = medianDelta(frames.map((f) => f.tMs)) / 1000;
  if (timeUnit === "unknown") {
    // 单位未知的裸列名（t / time / timestamp）与无表头文件：**按约定当秒解释，不静默改写**。
    //
    // 为什么不再"中位间隔 >0.5 s 就除以 1000"：那种启发式无法区分"1 Hz 的秒"与"每点 1000 ms 的毫秒"，
    // 只要猜错就把 19 秒变成 0.019 秒（或反过来），而猜错时用户看不出哪里不对。
    // 现在改为：按秒解释 + 给出可操作提示（要毫秒就写 t_ms / time_ms），把选择权交回用户。
    if (dtMed > 0.5) {
      notes.push(
        `时间列未声明单位：按**秒**解释（中位间隔 ${dtMed.toFixed(2)} s）。` +
          `如果这份日志的时间其实是毫秒，请把时间列表头写成 t_ms / time_ms（本装置不替用户猜单位）`,
      );
    } else {
      notes.push(`时间列未声明单位：按**秒**解释（中位间隔 ${(dtMed * 1000).toFixed(2)} ms）`);
    }
  } else if (dtMed > 0.5) {
    notes.push(`时间列已声明为${timeUnitLabel}：即使中位间隔 ${dtMed.toFixed(2)} s（低频日志）也按声明解释，不再按毫秒重算`);
  }
  // 时长口径与 ReplayPlayer 共用同一条有效时间轴（回退段不被重复计入），不在这里另算"末帧减首帧"
  const timeline = monotonicTimelineMs(frames.map((f) => f.tMs));
  const span = (timeline[timeline.length - 1]! - timeline[0]!) / 1000;
  const rawSpan = (frames[frames.length - 1]!.tMs - frames[0]!.tMs) / 1000;
  notes.push(
    `时间轴：${frames.length} 帧 / ${span.toFixed(2)} s，中位采样间隔 ${(dtMed * 1000).toFixed(2)} ms（约 ${dtMed > 0 ? (1 / dtMed).toFixed(0) : "?"} Hz）`,
  );
  if (rawSpan !== span) notes.push(`时间列有回退：有效时长按单调覆盖计（原始首末差 ${rawSpan.toFixed(2)} s）`);
  if (!frames[0].hasMag && !frames.some((f) => f.hasMag)) {
    notes.push("没有磁力计列：MARG 对这组数据无效（偏航将只能靠陀螺积分）");
  }
  if (hasTruth) notes.push(`检测到外部真值姿态（truth_q*）：${truthRows} 帧可用于物理误差评估（不再以 Mahony 为唯一基准）`);
  notes.push(
    imuCalibrated === true
      ? "元数据声明 IMU 列已是**校准后**读数（# imu=calibrated）：回放不再二次应用磁/加计校准"
      : imuCalibrated === false
        ? "元数据声明 IMU 列为**原始**读数（# imu=raw）：回放是否应用校准由回放开关决定"
        : "日志未声明 IMU 列语义：按**原始读数**处理（回放时是否应用校准由回放开关控制）",
  );
  const anyNonZero = (role: "gyro" | "accel") =>
    frames.some((f) => Math.hypot(...(role === "gyro" ? f.gyroDps : f.accelMs2)) > 1e-9);
  if (!anyNonZero("accel")) notes.push("加速度计列全是 0：检查列映射或单位");
  if (!anyNonZero("gyro")) notes.push("陀螺仪列全是 0：检查列映射或单位");
  return { frames, mapping, skipped, invalidRows, hasTruth, imuCalibrated, notes };
}
