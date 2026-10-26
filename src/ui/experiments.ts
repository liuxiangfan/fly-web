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
];

/** 按 id 查实验（未知 id 返回 undefined，便于 UI 安全处理） */
export function findExperiment(id: string): ExperimentSpec | undefined {
  return EXPERIMENTS.find((e) => e.id === id);
}
