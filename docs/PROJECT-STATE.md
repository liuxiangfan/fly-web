# 项目状态 · 四元数姿态解算学习演示装置

> **本文件是项目的恢复锚点。** 会话上下文被压缩后，从这里可以快速接续全部关键信息。
> 最后更新：2026-10-11（玻璃盒 + 删除精简模式后）

## 一句话

纯前端（无后端）的四轴无人机四元数姿态解算教学演示装置：Three.js 3D 姿态可视化 +
模拟 IMU + 四种解算算法实时对比 + 万向节锁平衡环架演示。部署目标为 Cloudflare Pages + 用户域名（M4，未做）。

## 技术栈与命令

- Vite + TypeScript（无框架）+ Three.js（three ^0.170）
- `npm run dev` / `npm run build`（= `tsc --noEmit && vite build` → `dist/`）/ `npm run preview`（4173 端口）
- `npm run check` = `selftest`（Node 数值自检）+ `scenecheck`（Node 下构建真实 three.js 场景图做几何校验）
- 诊断脚本：`scripts/diag.ts`（收敛时间线）、`scripts/diag-violent.ts`（剧烈机动复现）
- 源码改动后必须 `npm run build` 并在浏览器 **Ctrl+F5 强刷**（preview 服务的是构建产物）
- Git：`github.com/liuxiangfan/fly-web`，`master` 已推送（HEAD = 64a5432）

## 架构（src/）

| 文件 | 职责 |
|---|---|
| `core/quat.ts` | 纯 TS 四元数库：qMul/qConj/qDot/qNorm/qIntegrate/qFromEuler(ZYX)/qToEuler/qAngleBetween/qRot/qRotInv/qSlerp/qFromAxisAngle；NED 航空约定，雷达 |
| `core/gimbal.ts` | 万向环纯数学：`gimbalInnerQuat`（与 `toDisplayQ(qFromEuler)` 严格相等，自检守护）、`gimbalAxisAlign`=\|sin(pitch)\|、`gimbalLocked`、`gimbalDemo(t)`（9 相位 14 秒演示脚本）、`toDisplayQ`（NED→显示，S=Rx(90°)） |
| `core/imu.ts` | IMU 模拟：accel = Rᵀ·(0,0,g)（静态时 +g 朝机体系「下」）+ 线加速度扰动 + 振动 + 白噪声；陀螺零偏方向 [1,−0.7,0.5] 归一化 |
| `core/scenarios.ts` | 6 种机动剧本（hover/manual/roll360/pitch/composite/violent）+ 共享 `manualTarget`；`World.setScenario` 对未知 id 回落 hover |
| `core/world.ts` | 真实姿态积分 + 姿态跟踪控制器（K=5，ω_max=4.2 rad/s）+ IMU 生成 |
| `estimators/index.ts` | 纯陀螺积分 / 互补滤波 / Mahony / Madgwick 四个估计器（统一 `Estimator` 接口：q + update + reset）|
| `scene/setup.ts` | 渲染器/相机/灯光/地面/网格/罗盘（北+X、东+Z）/主四轴+幻影/万向环架；`toDisplay`、`setView`、`syncVisibility` |
| `scene/quad.ts` | `buildQuad(ghost, {axes})` 程序化四轴：机头 +X、机体右 +Z、上 +Y |
| `scene/gimbal.ts` | 平衡环架：外环偏航（YZ 面，蓝）→ 中环俯仰（XZ 面，金）→ 内环横滚（XY 面，绿）；枢轴销真正连接相邻环；底座立柱；环标签挂在各自 group 并随环转动、同色系；环内嵌小四轴 scale 1.15 |
| `scene/labels.ts` | `makeTextSprite(text, color, {size, bold, alwaysOnTop})` 通用文字标签 |
| `ui/mode.ts` | 精简/完整模式与视图状态策略（纯函数，可测）+ `narrateAttitude`/`narrateGimbal` 解说文案 |
| `ui/chart.ts` | `RollingChart` 手绘 canvas 时序图；**系列在构造时固定**，精简模式用 `setVisible` 掩码 |
| `main.ts` | 装配层：500 Hz 定步长仿真（追帧上限 0.25 s）、滑块三件套、模式/视图切换、演示与暂停、读数刷新 |

## 关键约定（改代码前必读）

- **坐标系**：世界 NED（x 北 / y 东 / z 下），机体 FRD；q 为机体系→世界系。
  显示坐标 X=北、Y=上、Z=东，NED→显示用 S=Rx(90°)；向量转换用 `qRot(S, v)`。
- **机体轴标签**：x 前 +X（红）、y 右 +Z（绿）、z 下 −Y（蓝）。**z 指向地面是 NED 约定，不是 bug**。
- **颜色**：数据系列色写在 JS 里（真实 `#e6edf3` / 纯积分 `#f85149` / 互补 `#ffa657` /
  Mahony `#58a6ff` / Madgwick `#7ee787`）；UI 强调色是 CSS `--accent: #22d3ee`（仪表青）。
  两者刻意区分，不要混用。
- **滑块三件套**：HTML 静态声明 `input[type=range]` + `data-num` + `data-step`，由 `bindSlider` 动态绑定。
  读数由数值输入框承担，**不要再引入 `<output>`**（曾被批量转换脚本删光，导致 14 个滑块初始化中断）。
- **事件回调**：不能直接写 `addEventListener("input", stopDemo)`——事件对象会误入 `keepConclusion` 参数，
  必须包一层 `() => stopDemo()`。
- **显隐机制**：`body[data-mode=basic|full]` + `body[data-view=attitude|gimbal]` 驱动 CSS。
  JS 依赖的类名钩子：`.hidden` `.off` `.active` `.adv` `.opt-adv` `.num-input` `.step-input`
  `.section-*` `.chart-block.att|err` `.legend-chip[data-est]` `#gimbal-compare.ok|.warn` `#gimbal-status.warn`。
- **字体**：Fira Sans / Fira Code 通过 `media="print" onload` 非阻塞加载；国内网络失败时自动降级系统字体。

## 已完成里程碑

- **M1 + M2**（commit `0315075`）：3D 可视化、模拟 IMU、四算法、双图表、6 种机动、手动控制
- **M3**（`3635b9c` + `64a5432`）：平衡环架万向节锁演示（两路径等价证明只剩 2 个自由度、暂停/继续、
  三环三色随动标签）+ 机体轴 x/y/z 标签 + 滑块数值与步距输入 + 「横滚」术语统一
- **前端重设计**（`64a5432`）：Dark Mode(OLED) 设计系统、自定义滑杆、可访问性达标（对比度 5.2–17.9:1）
- **玻璃盒**（未提交）：四估计器暴露 `telemetry`（角速度/修正量/双重力方向/P-I 占比/残差）；
  3D 双箭头（白=预测「下」、品红=实测「下」）挂显示四轴；算法内部读数块（开关 `#telemetry-toggle`，
  `body[data-telemetry]`）；受扰提示带 1.5s 黏性；万向节锁视图强制隐藏玻璃盒（只展示现象）
- **删除精简模式**（未提交）：mode.ts 只剩视图策略；narrator/图例掩码/opt-adv/adv 全部移除；
  界面始终为完整形态。`qad.mode` localStorage 键不再读写（残留值无害）

## 验证体系

- `npx tsc --noEmit` → `npm run check`（全部 PASS）→ `npm run build`
- `selftest` 覆盖：欧拉↔四元数往返、无零偏不漂、零偏线性漂移、抗扰、动态跟踪、剧本切换、
  万向环链条≡主视图、死锁判定、演示全相位、锁定态横滚/偏航等价（含对照组）、暂停语义、模式策略与持久化
- `scenecheck` 在 Node 下构建真实场景图校验：内环姿态≡toDisplay（偏差 3.9e-16）、环面含自转轴、
  枢轴销连通、环间隙不穿模、四轴不穿出内环、死锁轴重合、轴标签方向、环标签随动与层级归属
- UI 改动后用浏览器截图确认（本机 4173），并检查控制台零错误

## 待办

- **M4 部署**：Cloudflare Pages（建议连 GitHub 仓库自动构建）+ 绑定用户域名。**域名待用户提供**；
  已告知国内访问与备案的取舍。
- **玻璃盒（算法内部可视化）**：计划已定稿待批准（遥测字段 + 双重力箭头 + 内部读数块 + 异常态）。
- 之后候选：四元数可视化与 Slerp 对比、MARG 磁力计、IMU 误差模型升级、A/B 参数对比、
  深链分享 + PWA、闭环控制演示。

## 已知坑

- 批量改 DOM 时务必全量回归滑块（历史事故：`<output>` 被删导致绑定中断）。
- 内嵌四轴 scale > 1.3 会穿出内环（scenecheck 4b 有断言拦截，实测 1.15 时间隙 0.086）。
- 测试环境 rAF 会间歇停摆：截图可能超时或 3D 区黑屏，此时以 `scenecheck` 的几何断言替代视觉验证。
- `vite preview` 服务的是 `dist/`，改源码不重新构建就不会生效。
