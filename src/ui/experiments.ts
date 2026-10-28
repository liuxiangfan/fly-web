/**
 * 实验库（纯数据）：每个条目是一组「参数快照 + 观察要点」。
 *
 * 设计原则：每个实验只讲**一个**因果链——改了哪个物理量、看哪条曲线/哪个数字、
 * 结论是什么。比让用户自己在 24 个滑块里摸索更容易复现教学现场；
 * 同时也是文档「快速上手」里的一条条可点击入口。
 */
import type { UiView } from "./mode";

export interface ExperimentSpec {
  id: string;
  name: string;
  /** 分类短标签（显示为小胶囊） */
  tag: string;
  /** 观察要点：HTML 片段（只允许 <b>/<span class="mono"> 等内联标签） */
  observe: string;
  /** 滑块 id → 值（内部会走 input 事件，等价于用户拖动） */
  sliders?: Record<string, number>;
  checks?: Record<string, boolean>;
  selects?: Record<string, string>;
  view?: UiView;
  /** 应用后是否重置仿真（默认 true） */
  reset?: boolean;
}

export const EXPERIMENTS: ExperimentSpec[] = [
  {
    id: "drift",
    name: "零偏漂移",
    tag: "对照组",
    observe:
      "纯陀螺仪积分只看陀螺仪：3°/s 零偏让它每秒偏 3°，误差曲线一路爬升。" +
      "切到 Mahony / 卡尔曼，看它们如何用加速度计把倾角拉住，而偏航仍在慢慢漂（加计看不见偏航）。",
    sliders: {
      "imu-gyro-bias": 3,
      "imu-gyro-noise": 0.2,
      "imu-lin-accel": 0,
      "imu-vibration": 0,
      "imu-mag-noise": 0,
    },
    checks: { "telemetry-toggle": true },
    selects: { "scenario-select": "hover", "source-select": "pure" },
  },
  {
    id: "gate",
    name: "方向门控救场",
    tag: "抗扰",
    observe:
      "机动线加速度让加计读数偏 20° 以上。打开/关闭「加速度计方向门控」对比：" +
      "门控开时融合算法拒绝被污染的观测（误差曲线贴地），关掉后姿态被持续拽偏——" +
      "垂直方向的污染对向量模长只有二阶影响，幅度门控看不见它。",
    sliders: {
      "imu-lin-accel": 4,
      "imu-vibration": 0.1,
      "imu-gyro-bias": 1,
      "imu-mag-noise": 0.8,
    },
    checks: { "gate-toggle": true, "telemetry-toggle": true },
    selects: { "scenario-select": "violent", "source-select": "mahony" },
  },
  {
    id: "vibration",
    name: "电机振动",
    tag: "抗扰",
    observe:
      "振动是高频、零均值的——滤波器可以把它平均掉，但振幅越大、残余抖动越大。" +
      "把「电机振动」拉到 1.0 看误差曲线的毛刺；再关掉加速度计门控对比（高频振动反而可能被门控误伤）。",
    sliders: {
      "imu-vibration": 1,
      "imu-gyro-bias": 1,
      "imu-lin-accel": 0,
      "imu-mag-noise": 0.8,
    },
    checks: { "telemetry-toggle": true },
    selects: { "scenario-select": "hover", "source-select": "madg" },
  },
  {
    id: "magnetic",
    name: "磁干扰与偏航",
    tag: "磁力计",
    observe:
      "硬铁偏移把磁球推离原点，交变干扰让航向左右摆动。MARG 开着时偏航被磁场拽住、" +
      "关掉后只剩陀螺仪积分——两条偏航曲线会明显分叉。下面的「磁力计校准」可以把硬铁/软铁拟合掉。",
    sliders: {
      "imu-hard-iron": 0.6,
      "imu-mag-disturb": 0.5,
      "imu-mag-noise": 1,
      "imu-gyro-bias": 1,
    },
    checks: { "mag-enable": true, "telemetry-toggle": true },
    selects: { "scenario-select": "composite", "source-select": "mahony" },
  },
  {
    id: "align",
    name: "初始对准",
    tag: "启动",
    observe:
      "五个算法从同一个 20–35° 的随机错误初值出发。互补/Mahony/Madgwick 靠启动增益 ramp、" +
      "卡尔曼靠大初始协方差，在几秒内收敛；纯积分没有观测通道，永远停在偏差处。" +
      "也可以等待静止 3 秒，看「粗对准」提示出现。",
    sliders: { "imu-gyro-bias": 1, "imu-mag-noise": 0.8, "imu-lin-accel": 0.5, "imu-vibration": 0.2 },
    checks: { "init-offset-toggle": true, "telemetry-toggle": true, "mag-enable": true },
    selects: { "scenario-select": "hover", "source-select": "truth" },
  },
  {
    id: "closed-loop",
    name: "闭环控制",
    tag: "控制",
    observe:
      "控制器改用纯陀螺仪积分的姿态做反馈：估计漂多少，机体就真的飞偏多少。" +
      "关掉闭环（理想飞控）机体稳稳跟住目标；打开后立刻看到真实姿态被估计误差拖走。" +
      "再切到卡尔曼反馈，偏差会小一个数量级。",
    sliders: { "imu-gyro-bias": 3, "imu-gyro-noise": 0.2, "imu-lin-accel": 0.5, "imu-vibration": 0.2 },
    checks: { "loop-toggle": true, "telemetry-toggle": false },
    selects: { "scenario-select": "hover", "source-select": "pure" },
  },
  {
    id: "kalman-tuning",
    name: "卡尔曼 Q/R 调参",
    tag: "调参",
    observe:
      "Q 大 = 更信加速度计（跟得快、噪声大）；R 大 = 更信陀螺仪（平滑、滞后）。" +
      "把 R 拉到 1.0，卡尔曼几乎退化成纯积分；把 Q 拉到 2，它开始追着加计噪声抖。" +
      "面板里的「零偏估计 |b|」是它和固定增益算法最本质的区别。",
    sliders: { "kalman-proc": 0.2, "kalman-obs": 0.05, "imu-gyro-bias": 1, "imu-vibration": 0.3 },
    checks: { "telemetry-toggle": true, "mag-enable": true },
    selects: { "scenario-select": "hover", "source-select": "kalman" },
  },
  {
    id: "gimbal",
    name: "万向节锁",
    tag: "几何",
    observe:
      "把俯仰拖到 ±90°：内外环轴重合、两环变红，横滚与偏航退化成同一个自由度。" +
      "点「演示：只剩 2 个自由度」看脚本自动证明：横滚 +60° 与偏航 −60° 得到完全相同的姿态。",
    selects: { "scenario-select": "hover" },
    view: "gimbal",
    reset: false,
  },
  {
    id: "slerp",
    name: "Slerp vs 欧拉插值",
    tag: "插值",
    observe:
      "白色弧是 Slerp（旋转群上的大圆），品红弧是欧拉角逐分量插值（穿过欧拉空间）。" +
      "选「偏航+俯仰+横滚（差异最大）」并播放：两条弧在中点分开 50° 以上——" +
      "这就是动画必须用四元数插值的原因。",
    selects: { "quat-mode": "interp", "quat-pair-select": "combo" },
    view: "quat",
    reset: false,
  },
  {
    id: "proj",
    name: "4D 立体投影",
    tag: "四元数",
    observe:
      "q 是 S³ 上的点，从这里投影到日常三维空间：青色 q 在球内、品红 −q 在球外。" +
      "连按两次「左乘 i」：3D 姿态复原、q 却走到 −q（内外互换）——转 360° ≠ 没转；" +
      "按四次（720°）才真正回到 +1。",
    selects: { "quat-mode": "proj" },
    view: "quat",
    reset: false,
  },
  {
    id: "lockAlgo",
    name: "万向节锁的算法后果",
    tag: "几何×算法",
    observe:
      "俯仰<b>精确</b>停在 90°（重力沿机体 x 轴，加速度计对横滚完全失去信息），再让横滚移动。" +
      "<b>橙色（互补滤波，活在欧拉角空间）的姿态被一路拽走（自检实测 180°）</b>，" +
      "而蓝/绿（Mahony / Madgwick，活在四元数空间）稳在 <b>0.15° 以内</b>（自检实测 20 秒窗口：Mahony 0.09°、Madgwick 0.15°）——" +
      "它们在锁点上只是「停止修正」，靠陀螺积分继续走，属于优雅降级。" +
      "本实验把噪声全部归零，好让现象干净；把「陀螺仪噪声」调到 0.2 再看，" +
      "互补的偏差反而会变小（噪声把那套错误的修正方向「抖散」了）——误差不是消失了，是被掩盖了。" +
      "把陀螺仪零偏调到 1°/s：四元数算法也开始漂（锁点上没有观测能拉住它），但仍远好于互补。",
    sliders: {
      "imu-gyro-bias": 0, "imu-gyro-noise": 0, "imu-accel-noise": 0, "imu-mag-noise": 0,
      "imu-lin-accel": 0, "imu-vibration": 0,
    },
    checks: { "telemetry-toggle": true, "mag-enable": false },
    selects: { "scenario-select": "pitchHold", "source-select": "comp" },
  },
  {
    id: "sweep90",
    name: "穿越 ±90°",
    tag: "几何×算法",
    observe:
      "俯仰从 0° 慢扫到 180° 再回来，两次穿过万向节锁。" +
      "看误差曲线的形状：互补滤波在穿越点出现尖峰（欧拉重建在锁点邻域条件数急剧恶化），" +
      "四元数算法基本平坦。与「停驻 90°」剧本对照——一个是穿越的暂态，一个是持续命中奇点。",
    sliders: { "imu-gyro-bias": 0.5, "imu-gyro-noise": 0.1, "imu-lin-accel": 0.3, "imu-vibration": 0.1 },
    checks: { "telemetry-toggle": false },
    selects: { "scenario-select": "pitchSweep", "source-select": "comp" },
  },
  {
    id: "margFull",
    name: "完整 MARG vs 简化",
    tag: "磁力计",
    observe:
      "「磁修正形态」切到<b>完整 MARG</b>：用整条磁场向量做误差，参考场由测量本身构造（磁倾角自洽）。" +
      "先把「磁干扰强度」拉到 0.5，对比偏航曲线——简化版被交变干扰牵着走，完整版几乎不受影响" +
      "（自检实测：均值 8.5° → 1.0°）。再把干扰归零：两者在干净磁场下完全等价，" +
      "说明完整版不是「更强」，而是「对倾角失配更宽容」。",
    sliders: { "imu-mag-disturb": 0.5, "imu-hard-iron": 0.3, "imu-mag-noise": 1, "imu-gyro-bias": 0.5 },
    checks: { "mag-enable": true, "telemetry-toggle": true },
    selects: { "mag-mode": "full", "scenario-select": "composite", "source-select": "mahony" },
  },
  {
    id: "gateHysteresis",
    name: "门控滞回的双刃",
    tag: "抗扰",
    observe:
      "持续单向线加速度（协调转弯）会让观测被<b>连续拒绝</b>。工业库（Fusion）的做法是：" +
      "5 秒滑动窗口里拒绝占比超 90%（且已积累 ≥ 80% 窗口）就判「可能是我自己偏了」，开 1.5 秒恢复窗放行观测。" +
      "打开「拒绝过久自动恢复」开关等约 <b>4 秒</b>：互补滤波的姿态会被污染的观测拉走——" +
      "这就是门控的取舍：拒绝观测保短期准确，但拒绝太久会失去纠错能力。关掉开关则是「拒绝到底」。" +
      "（自检实测：线加速度 8 m/s²、磁力计开（默认）时，关→峰值误差 <b>5.4°</b>、开→<b>19.7°</b>，25 秒内恢复窗放了 4 次。）" +
      "注意<b>线加速度必须够大</b>：4 m/s² 时窗口拒绝占比只有约 0.83，到不了 0.9 的判定线，" +
      "开关打开也不会触发——这条阈值本身也是「调参要看量」的例子。",
    sliders: { "imu-lin-accel": 8, "imu-vibration": 0.1, "imu-gyro-bias": 0.5, "imu-mag-noise": 0.5, "gate-deg": 20, "gate-mag": 35 },
    checks: { "gate-toggle": true, "gate-recovery": true, "telemetry-toggle": true },
    selects: { "scenario-select": "composite", "source-select": "comp" },
  },
  {
    id: "gyroSaturation",
    name: "陀螺仪量程饱和",
    tag: "器件",
    observe:
      "把「陀螺仪量程」拉到 ±150 °/s（真实器件的低档），再跑剧烈机动：" +
      "峰值角速度超过量程的瞬间读数被<b>削平</b>，积分器拿到一串「恒定最大速率」→" +
      "姿态大幅跑偏且<b>无法察觉</b>。切到 IMU 原始波形页签能看到那条平顶。" +
      "工程上靠量程告警 + 抬高陀螺噪声让滤波器少信积分项。",
    checks: { "telemetry-toggle": false },
    selects: { "imu-gyro-range": "150", "scenario-select": "violent", "source-select": "mahony" },
  },
  {
    id: "sensorDelay",
    name: "传感器群延迟",
    tag: "器件",
    observe:
      "真实 MEMS 有传输 + 抗混叠滤波延迟，算法拿到的是过时数据。把「传感器群延迟」拉到 25 ms：" +
      "机动中姿态滞后约 <b>ω·τ</b>（峰值 240°/s × 0.025 s ≈ 6°）。" +
      "看纯陀螺仪积分那条红线——它本该没有误差（零偏噪声都设为 0），现在整条抬起来了，" +
      "抬升高度就是 ω·τ。控制回路里这就是被吃掉的相位裕度。",
    sliders: { "imu-gyro-bias": 0, "imu-gyro-noise": 0, "imu-lin-accel": 0.3, "imu-vibration": 0.2, "imu-delay": 25 },
    checks: { "telemetry-toggle": false },
    selects: { "scenario-select": "violent", "source-select": "pure" },
  },
  {
    id: "solveRate",
    name: "解算频率",
    tag: "实现",
    observe:
      "仿真仍是 500 Hz，但把「解算频率」降到 50 Hz——估计器每 20 ms 才吃一次数据。" +
      "本装置用的是<b>精确指数积分</b>（不是一阶欧拉），所以低频率下仍能跟住大部分机动；" +
      "高速旋转时每步转过的角度太大，误差才开始抬头。" +
      "这就是飞控姿态环要跑在数百赫兹的原因。",
    sliders: { "imu-gyro-bias": 0.5, "imu-gyro-noise": 0.2, "imu-lin-accel": 0.5, "imu-vibration": 0.2 },
    checks: { "telemetry-toggle": false },
    selects: { "solve-rate": "50", "scenario-select": "violent", "source-select": "madg" },
  },
];

/** 按 id 查实验（未知 id 返回 undefined，便于 UI 安全处理） */
export function findExperiment(id: string): ExperimentSpec | undefined {
  return EXPERIMENTS.find((e) => e.id === id);
}
