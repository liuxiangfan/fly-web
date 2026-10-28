/**
 * 参数整定挑战（纯数据）：每个条目 = 一套现场 + 一个可量化的目标 + 卡住时的提示。
 *
 * 设计意图：装置把参数摊开给用户，但「调到多少算好」没人告诉他。这里是三个有唯一
 * 可验证答案的小任务——评分读的是「本轮评测」里同一个 ErrorTracker，所以「通过」
 * 不是自我感觉良好，而是 RMSE 真的落到了阈值以下。
 *
 * 阈值都是**先量后定**的（用探针跑出默认参数与调好参数各自的 RMSE，再把阈值放在
 * 「默认过不了、动手能过」的位置），不是拍脑袋写的：
 *   挑战一：默认 Kp=1/Ki=0.05 → 装置内实测 1.86°；调 Kp≈1.5/Ki≈0.08 → 1.47°；阈值 1.65°（两侧各留 ~11% 余量，
 *     因为仿真用非固定随机种子，RMSE 逐次会波动——阈值贴太紧会出现「该过却没过」）
 *   挑战二：默认 β=0.1 → 3.85°；β=0.4 → 2.39°；阈值 3.0°
 *   挑战三：默认 Q=0.2/R=0.05 → 5.69°；Q=0.1/R=0.2 → 3.50°；阈值 4.5°
 * 注意挑战二里「β 调大反而更好」不是笔误：那个场景的主导误差是陀螺零偏而非振动，
 * 大 β 把零偏压下去了——这正是要让人自己想清楚的地方，所以提示只给方向不give答案。
 */
export interface ChallengeSpec {
  id: string;
  name: string;
  /** 现场简述 —— 用户该看到什么 */
  scene: string;
  /** 目标（含阈值，显示用） */
  goal: string;
  /** 评分口径：看哪个算法的哪个指标 */
  grade: { est: "comp" | "mahony" | "madg" | "kalman"; limit: number };
  /** 一键装载（与实验库同一套 setter，走真实事件路径） */
  sliders?: Record<string, number>;
  checks?: Record<string, boolean>;
  selects?: Record<string, string>;
  /** 卡住时的提示（不直接给答案，给思考方向） */
  hint: string;
}

export const CHALLENGES: ChallengeSpec[] = [
  {
    id: "bias-tune",
    name: "① 把零偏压下去",
    scene: "悬停微扰、陀螺零偏 2°/s、中等线加速度污染。看 Mahony 的误差曲线。",
    goal: "把 Mahony 的 RMSE 调到 1.65° 以下（默认真机实测约 1.86°）",
    grade: { est: "mahony", limit: 1.65 },
    sliders: {
      "imu-gyro-bias": 2, "imu-gyro-noise": 0.2, "imu-lin-accel": 0.8, "imu-vibration": 0.2,
      "imu-mag-noise": 0.8, "mahony-kp": 1, "mahony-ki": 0.05,
    },
    checks: { "mag-enable": true, "gate-toggle": true, "telemetry-toggle": true },
    selects: { "scenario-select": "hover", "source-select": "mahony", "mag-mode": "yaw" },
    hint: "零偏要靠积分项「记账」还清：Ki 太小永远还不完，太大又会振荡。Kp 只管把倾角拉回观测——\n把它调大能不能解决问题？先试一次再判断（实测：只把 Kp 拉到 4 反而更差）。",
  },
  {
    id: "vibration-tune",
    name: "② 强振动下选增益",
    scene: "电机振动 0.9、线加速度 1.5、加计噪声 0.3、陀螺零偏 0.5°/s。看 Madgwick 的曲线。",
    goal: "把 Madgwick 的 RMSE 调到 3.0° 以下（默认 β=0.1 约 3.85°）",
    grade: { est: "madg", limit: 3.0 },
    sliders: {
      "imu-gyro-bias": 0.5, "imu-vibration": 0.9, "imu-lin-accel": 1.5, "imu-accel-noise": 0.3,
      "imu-mag-noise": 0.8, "madg-beta": 0.1,
    },
    checks: { "mag-enable": true, "gate-toggle": true, "telemetry-toggle": true },
    selects: { "scenario-select": "hover", "source-select": "madg", "mag-mode": "yaw" },
    hint: "先问一句：这个场景里主要误差来自振动，还是来自零偏？\nMadgwick 没有积分项，它对零偏只能靠「增益」压——两者对 β 的要求是相反的，试试两头。",
  },
  {
    id: "mag-tune",
    name: "③ 磁场被污染时救偏航",
    scene: "复合机动、硬铁 0.5 + 交变干扰 0.6、磁噪声 1μT。五种算法的偏航会明显分家。",
    goal: "把卡尔曼的 RMSE 调到 4.5° 以下（默认 Q=0.2 / R=0.05 约 5.7°）",
    grade: { est: "kalman", limit: 4.5 },
    sliders: {
      "imu-hard-iron": 0.5, "imu-mag-disturb": 0.6, "imu-mag-noise": 1, "imu-gyro-bias": 1,
      "kalman-proc": 0.2, "kalman-obs": 0.05,
    },
    checks: { "mag-enable": true, "telemetry-toggle": true, "gate-toggle": true },
    selects: { "scenario-select": "composite", "source-select": "kalman", "mag-mode": "yaw" },
    hint: "两条路都通：① 调 Q/R 让滤波器少信被污染的磁场（想想 R 变大意味着什么）；\n② 直接用「磁力计校准」把硬铁球心拟合掉——那是工程上更根本的做法。\n另外看看玻璃盒里的零偏估计 |b|，它和偏航误差是同一件事的两面。",
  },
];
