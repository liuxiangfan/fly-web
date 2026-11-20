/**
 * 参数元数据与变化反馈（F-04 的纯数据/文案层）。
 *
 * 这里登记的是**真实控件 ID** 与 main.ts 的实际行为：
 * - `resets` 只描述该控件自身是否会调用 `resetSim()`，不是「看起来像会重置」；
 *   solve-rate / init-offset-toggle / experiment-seed 在 main.ts 里确实复位，
 *   IMU 污染滑块、门控、增益、Q/R、磁形态等都是运行期热更新，不重置。
 * - 量化反馈由调用方传入**实际生效值**；本模块不读 DOM、不猜控件步距。
 * - 描述文案把「改了什么 / 影响哪里 / 本轮是否重置 / 建议观察」分开，
 *   方便任务条、轻量提示和等价文本复用同一份口径。
 *
 * 不 import 配置或 DOM：配置字段只用字符串路径记录，便于在 Node 契约测试中直接核对。
 */

export type ParameterAffects = "sensor" | "estimator" | "schedule" | "display";

export interface ControlMeta {
  readonly id: string;
  /** 配置字段路径（ExperimentConfig 的字符串摘要；本模块不 import 配置） */
  readonly path: string;
  readonly label: string;
  readonly unit?: string;
  readonly affects: ParameterAffects;
  /** main.ts 中该控件自身是否调用 resetSim() */
  readonly resets: boolean;
  readonly observe: string;
  readonly doc?: { readonly page: string; readonly anchor?: string };
  /** 全局开关实际广播到哪些算法/组件 */
  readonly broadcast?: string;
}

export interface ParameterDescription {
  /** 一行标题，如「解算频率：500 → 50 Hz」；量化时附「请求 …，已量化」 */
  readonly head: string;
  /** 多行详情：影响层、真实重置行为、量化说明、模式说明 */
  readonly detail: string;
  /** 建议观察 */
  readonly observe: string;
}

export type ParameterValue = number | string | boolean;

/** 与 index.html 真实 id 一一对应；顺序只影响调试输出，不影响查询。 */
export const PARAMETER_METAS: readonly ControlMeta[] = [
  {
    id: "imu-gyro-bias",
    path: "imu.gyroBiasDps",
    label: "陀螺仪零偏",
    unit: "°/s",
    affects: "sensor",
    resets: false,
    observe: "纯积分漂移斜率与各融合算法的稳态误差；零偏越大，偏航越先离开罗盘",
    doc: { page: "manual", anchor: "d-imu" },
  },
  {
    id: "imu-gyro-noise",
    path: "imu.gyroNoiseDps",
    label: "陀螺仪噪声",
    unit: "°/s",
    affects: "sensor",
    resets: false,
    observe: "姿态曲线的抖动幅度；纯积分的随机游走比恒定零偏更快发散",
    doc: { page: "manual", anchor: "d-imu" },
  },
  {
    id: "imu-lin-accel",
    path: "imu.linAccel",
    label: "机动线加速度",
    unit: "m/s²",
    affects: "sensor",
    resets: false,
    observe: "门控拒绝次数、方向阈值边界与机动中的姿态误差",
    doc: { page: "manual", anchor: "d-imu" },
  },
  {
    id: "imu-vibration",
    path: "imu.vibration",
    label: "电机振动",
    affects: "sensor",
    resets: false,
    observe: "高频抖动是否被门控误伤；开带宽前后 IMU 波形与误差毛刺",
    doc: { page: "manual", anchor: "d-imu" },
  },
  {
    id: "imu-delay",
    path: "imu.sensorDelayMs",
    label: "传感器群延迟",
    unit: "ms",
    affects: "sensor",
    resets: false,
    observe: "机动中的姿态滞后（约 ω·τ）与误差曲线的相位差",
    doc: { page: "manual", anchor: "d-imu" },
  },
  {
    id: "solve-rate",
    path: "solveRateHz",
    label: "解算频率",
    unit: "Hz",
    affects: "schedule",
    resets: true,
    observe: "解算事件疏密、低频率下高速机动的跟踪损失；底层仿真仍为 500 Hz",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "gate-toggle",
    path: "estimators.comp.accelGate",
    label: "加速度计观测门控",
    affects: "estimator",
    resets: false,
    observe: "机动污染下门控开/关的姿态误差；卡尔曼另有独立的野值门控",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "互补、Mahony、Madgwick 三算法（广播）",
  },
  {
    id: "gate-deg",
    path: "estimators.comp.gateDeg",
    label: "门控方向阈值",
    unit: "°",
    affects: "estimator",
    resets: false,
    observe: "22° 级侧向污染会被拒还是放行；阈值过紧会误伤正常机动",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "互补、Mahony、Madgwick 三算法（广播）",
  },
  {
    id: "gate-mag",
    path: "estimators.comp.gateMagPct",
    label: "门控幅度阈值",
    unit: "%",
    affects: "estimator",
    resets: false,
    observe: "‖a‖ 偏离 g 的拒绝次数；机动越剧烈越容易触发",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "互补、Mahony、Madgwick 三算法（广播）",
  },
  {
    id: "gate-recovery",
    path: "estimators.comp.gateRecovery",
    label: "门控自动恢复（滞回）",
    affects: "estimator",
    resets: false,
    observe: "持续污染下是否出现 1.5 s 恢复窗，以及恢复窗放行造成的误差峰值",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "互补、Mahony、Madgwick 三算法（广播）",
  },
  {
    id: "mag-enable",
    path: "estimators.comp.magEnabled",
    label: "启用磁力计（MARG）",
    affects: "estimator",
    resets: false,
    observe: "偏航误差是否被磁北约束；关闭后零偏会让偏航误差持续累积",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "互补、Mahony、Madgwick（纯积分无磁观测）",
  },
  {
    id: "mag-mode",
    path: "estimators.mahony.magMode",
    label: "磁修正形态",
    affects: "estimator",
    resets: false,
    observe: "磁干扰/硬铁下简化与完整 MARG 的偏航误差差异",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "Mahony、Madgwick（两算法同步）",
  },
  {
    id: "mahony-kp",
    path: "estimators.mahony.params.kp",
    label: "Mahony Kp",
    affects: "estimator",
    resets: false,
    observe: "收敛速度与噪声放大：Kp 大快而抖，Kp 小慢而稳",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "mahony-ki",
    path: "estimators.mahony.params.ki",
    label: "Mahony Ki",
    affects: "estimator",
    resets: false,
    observe: "恒定零偏被积分项消掉的快慢；Ki=0 时会留下稳态偏差",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "madg-beta",
    path: "estimators.madg.params.beta",
    label: "Madgwick β",
    affects: "estimator",
    resets: false,
    observe: "跟随速度与噪声抑制的折中；β 没有积分项，零偏会留下稳态误差",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "kalman-proc",
    path: "estimators.kalman.params.gyroNoiseDps",
    label: "卡尔曼 Q",
    unit: "°/s",
    affects: "estimator",
    resets: false,
    observe: "卡尔曼增益与跟随速度；Q 大更信观测、毛刺更明显",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "kalman-obs",
    path: "estimators.kalman.params.obsNoise",
    label: "卡尔曼 R",
    unit: "g",
    affects: "estimator",
    resets: false,
    observe: "卡尔曼的平滑程度与收敛速度；R 大更信预测",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "kalman-gate",
    path: "estimators.kalman.kalmanGate",
    label: "卡尔曼野值门控",
    affects: "estimator",
    resets: false,
    observe: "玻璃盒里的 NIS 与观测接受/拒绝状态；只影响卡尔曼",
    doc: { page: "manual", anchor: "d-algo" },
    broadcast: "仅卡尔曼",
  },
  {
    id: "init-offset-toggle",
    path: "initialAttitude.kind",
    label: "重置时随机初始姿态偏差",
    affects: "estimator",
    resets: true,
    observe: "重置后五条误差曲线是否从 20–35° 偏差收敛；纯积分会停在偏差处",
    doc: { page: "manual", anchor: "d-algo" },
  },
  {
    id: "experiment-seed",
    path: "seed",
    label: "实验种子",
    affects: "schedule",
    resets: true,
    observe: "相同配置与种子的重放一致性；换种子后噪声序列与随机初值的差异",
    doc: { page: "manual", anchor: "d-start" },
  },
];

const META_BY_ID = new Map(PARAMETER_METAS.map((meta) => [meta.id, meta]));

/** 未登记的控件返回 undefined：调用方不得伪造说明。 */
export function parameterMeta(id: string): ControlMeta | undefined {
  return typeof id === "string" ? META_BY_ID.get(id) : undefined;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-9) return String(rounded);
  return String(Number(value.toFixed(6)));
}

function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  // 角度类与百分号按界面习惯紧贴数字（20°、35%）；其余留一个空格（50 Hz、30 ms）。
  return unit.startsWith("°") || unit === "%" ? `${text}${unit}` : `${text} ${unit}`;
}

function formatValue(meta: ControlMeta, value: ParameterValue | undefined, includeUnit = true): string {
  if (typeof value === "boolean") return value ? "开" : "关";
  if (typeof value === "number") return withUnit(formatNumber(value), includeUnit ? meta.unit : undefined);
  if (typeof value === "string") {
    if (meta.id === "mag-mode") {
      if (value === "full") return "完整 MARG";
      if (value === "yaw") return "简化（只约束偏航）";
    }
    if (meta.id === "kalman-gate") {
      if (value === "mahalanobis") return "χ² 马氏距离";
      if (value === "angle") return "新息夹角 40°";
    }
    return value;
  }
  return "—";
}

function sameValue(a: ParameterValue | undefined, b: ParameterValue | undefined): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

/** 影响层文案：说明「改了这一项，哪里会变」，不把 display 层冒充成解算变化。 */
function impactText(meta: ControlMeta, after: ParameterValue): string {
  if (meta.id === "solve-rate") {
    if (typeof after === "number" && Number.isFinite(after) && after >= 1) {
      return `估计器每 ${formatNumber(1000 / after)} ms 更新；底层仿真仍为 500 Hz`;
    }
    return "估计器更新节拍变化；底层仿真仍为 500 Hz";
  }
  if (meta.id === "init-offset-toggle") {
    return after === true
      ? "下一次重置时五个算法从同一个 20–35° 随机初始偏差出发；真值仍从水平开始"
      : "重置后各算法从水平姿态出发，不再注入随机初始偏差";
  }
  if (meta.id === "experiment-seed") {
    return "下一轮的噪声序列与随机初始偏差由新种子派生；相同配置 + 相同种子可复现";
  }
  switch (meta.affects) {
    case "sensor":
      return "直接改变喂给五种算法的传感器读数；仿真步长与解算频率不变";
    case "estimator":
      return `${meta.broadcast ?? "对应估计器"}即时采用新值；已记录的曲线与统计保留`;
    case "schedule":
      return "改变本轮实验的起点/调度；已有曲线与统计按实际重置行为处理";
    case "display":
      return "只改变显示层，不改变仿真或解算结果";
  }
}

/**
 * 重置说明以**实际观察到的调用**为准；`resetOccurred` 省略时只陈述登记行为，
 * 不根据元数据声称「已重置」（C.3：不能仅根据元数据声称成功）。
 */
function resetText(meta: ControlMeta, resetOccurred: boolean | undefined): string {
  if (resetOccurred === true) {
    return meta.resets
      ? "已重置仿真（曲线、统计与随机序列从本轮起点重新开始）"
      : "已重置仿真（由其他动作触发；该控件本身登记为不重置，曲线已清零）";
  }
  if (resetOccurred === false) {
    return meta.resets
      ? "实际未重置（与元数据登记的重置行为不一致）；当前曲线保留"
      : "从当前状态继续（未触发重置，已有曲线保留）";
  }
  return meta.resets
    ? "按登记行为会重置仿真（实际调用由界面确认后报告）"
    : "登记为不重置，从当前状态继续";
}

function modeNote(meta: ControlMeta, after: ParameterValue): string | undefined {
  if (meta.id === "mag-mode") {
    return after === "full"
      ? "模式说明：完整 MARG 使用整条磁场向量并做磁倾角补偿（Mahony/Madgwick）"
      : "模式说明：简化模式只取磁场误差的偏航分量来约束航向";
  }
  if (meta.id === "kalman-gate") {
    return after === "mahalanobis"
      ? "模式说明：χ² 马氏距离门控（3 自由度 99%），随 P/R 自适应，只影响卡尔曼"
      : "模式说明：固定 40° 新息夹角门控（历史基线），只影响卡尔曼";
  }
  if (meta.id === "gate-toggle") {
    return after === true
      ? "模式说明：门控打开后方向/幅度阈值生效；启动 ramp 期间自动旁路"
      : "模式说明：门控关闭后持续机动会污染姿态；卡尔曼的野值门控不受影响";
  }
  return undefined;
}

/**
 * 生成一次参数变化反馈。
 *
 * @param before 变化前的稳定值
 * @param after 用户请求的新值
 * @param actualValue 实际生效值（滑块/数值框量化后）；与 after 不同时显示「请求 → 实际」
 * @param resetOccurred 本次提交后是否真的调用了 resetSim()；省略则不声称已重置
 */
export function describeParameterChange(
  meta: ControlMeta,
  before: ParameterValue,
  after: ParameterValue,
  actualValue?: ParameterValue,
  resetOccurred?: boolean,
): ParameterDescription {
  const effective = actualValue === undefined ? after : actualValue;
  const quantized = !sameValue(after, effective);
  const requestedText = formatValue(meta, after);
  const effectiveText = formatValue(meta, effective);
  const beforeText = formatValue(meta, before, false);

  let head = sameValue(before, effective)
    ? `${meta.label}：${effectiveText}（未变化）`
    : `${meta.label}：${beforeText} → ${effectiveText}`;
  if (quantized) head += `（请求 ${requestedText}，已量化）`;

  const detail: string[] = [`影响：${impactText(meta, effective)}`];
  detail.push(`本轮处理：${resetText(meta, resetOccurred)}`);
  if (quantized) {
    detail.push(`量化：请求 ${requestedText} → 实际 ${effectiveText}（按控件步距/合法网格生效）`);
  }
  const note = modeNote(meta, effective);
  if (note) detail.push(note);

  return {
    head,
    detail: detail.join("\n"),
    observe: `建议观察：${meta.observe}`,
  };
}
