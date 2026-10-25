# 项目状态 · 四元数姿态解算学习演示装置

> **本文件是项目的恢复锚点。** 会话上下文被压缩后，从这里可以快速接续全部关键信息。
> 最后更新：2026-10-25（真实 IMU 串口接入 + A/B 视觉修复 + 曲线区可折叠面板；自检 60 项）

## 一句话

纯前端（无后端）的四轴无人机四元数姿态解算教学演示装置：Three.js 3D 姿态可视化 +
模拟 IMU（含磁力计）+ 五种解算算法（含卡尔曼）实时对比 + 万向节锁平衡环架 + 四元数插值视图 +
应用内文档页（控制项百科 + 完整数学推导 + 滤波算法讲解 + 工程实践）。
**已部署**：GitHub Actions → Cloudflare Workers，域名 `fly_web.070616.xyz`
（备用 quaternion-attitude-demo.liu06167492.workers.dev），push 即自动上线。

## 技术栈与命令

- Vite + TypeScript（无框架）+ Three.js（three ^0.170）
- `npm run dev` / `npm run build`（= `tsc --noEmit && vite build` → `dist/`）/ `npm run preview`
- `npm run check` = `selftest`（Node 数值自检）+ `scenecheck`（Node 下构建真实 three.js 场景图做几何校验），共 60 项
- 诊断脚本：`scripts/diag.ts`（收敛时间线）、`scripts/diag-violent.ts`（剧烈机动复现）
- 源码改动后必须 `npm run build` 并在浏览器 **Ctrl+F5 强刷**（preview 服务的是构建产物）
- 部署：`.github/workflows/deploy.yml`（wrangler v4），依赖 GitHub secrets 里的 Cloudflare 凭据
- Git：`github.com/liuxiangfan/fly-web`，master 与远端同步
  （近期提交：50bf534 玻璃盒+MARG+四元数视图 → 7ea40b6 四元数视图重做+文档页 → 本轮文档重做+数学模块）

## 架构（src/）

| 文件 | 职责 |
|---|---|
| `core/quat.ts` | 纯 TS 四元数库：qMul/qConj/qDot/qNorm/qIntegrate/qFromEuler(ZYX)/qToEuler/qAngleBetween/qRot/qRotInv/qSlerp（短路径+小角分支）/qFromAxisAngle/**qToAxisAngle**/**eulerLerp**/**qToMatrix**（四元数→DCM，与 qRot 严格一致）；NED 航空约定 | |
| `core/gimbal.ts` | 万向环纯数学：`gimbalInnerQuat`、`gimbalAxisAlign`=sin(pitch)、`gimbalLocked`、`gimbalDemo(t)`（9 相位 14 秒）、`toDisplayQ`（NED→显示，S=Rx(90°)）；向量转换 `toDisplayVec`：(x,y,z)→(x,−z,y) |
| `core/imu.ts` | IMU 模拟：accel = Rᵀ·(0,0,g) + 线加速度扰动 + 振动 + 白噪声；陀螺零偏方向 [1,−0.7,0.5]；**磁链**：`MAG_WORLD_NED`（磁倾角 49°，~50μT）+ `simulateMag`（投影→硬铁→交变干扰→噪声），磁参数全零时不消耗 gauss.next() |
| `core/scenarios.ts` | 6 种机动剧本（hover/manual/roll360/pitch/composite/violent）+ 共享 `manualTarget`；`setScenario` 对未知 id 回落 hover |
| `core/world.ts` | 真实姿态积分 + 姿态跟踪控制器（K=5，ω_max=4.2 rad/s）+ IMU 生成 |
| `estimators/index.ts` | 五估计器统一 `Estimator` 接口：`update(gyro,accel,mag,dt)` + `reset(initial?)`（initial 缺省=水平；传非单位姿态即「初始姿态偏差」演示）+ `magEnabled` + `telemetry`（rate/rawGyro/correction/predictedGravity/measuredGravity/accelNorm/accelValid/magValid/detail）。Mahony MARG：磁误差 z 分量并入；Madgwick：独立偏航方向分量；互补：`tiltCompensatedYaw`；**KalmanEstimator**：ES-EKF/MEKF（6 维误差状态 [δθ,δb]，重力+磁场观测，40° 新息门控，可估计陀螺仪零偏，参数 Q=gyroNoiseDps / R=obsNoise）。**启动增益 ramp**：互补/Mahony/Madgwick 共用 rampK()——reset 后 2.5s 内修正增益从 6 倍线性衰减（Fusion 同款，只放比例/梯度项），`rampEnabled` 公开供自检 A/B。**加速度计观测门控 accelGate**（同三家）：幅度（‖a‖ 偏 g 超 35%）+ 方向（与预测夹角超 `ACCEL_GATE_DEG=20°`）双层拒绝，ramp 期间关闭（Fusion 语义），被拒帧退化纯积分 |
| `scene/setup.ts` | 渲染器/相机/灯光/地面/网格/罗盘/主四轴+幻影/万向环架；`toDisplay`、`setView`、`syncVisibility`；玻璃盒双箭头 + 磁航向箭头 + 等效旋转轴箭头 `axisArrow`（青色，`#axis-toggle` 控制） |
| `core/serial.ts` | 真实 IMU 串口帧解析（纯函数）：CRC8/粘包重同步/安装方向重排/`buildFrame` 测试往返；帧协议见 `firmware/gy87.h` |
| `firmware/` | STM32F4 + GY-87 固件参考（`gy87.h` 帧规格表；用户自行实现并已验证） |
| `scene/quad.ts` | `buildQuad(ghost, {axes})` 程序化四轴（PBR 质感版）：RoundedBox 亮漆机身+云台球+锥形机臂+电机铃+前后航行灯（前青后红）+桨叶与半透明桨盘；ghost=EdgesGeometry 轮廓线；桨尖径向包络 ≤0.68（scenecheck 穿模断言守护） |
| `scene/gimbal.ts` | 平衡环架：外环偏航（蓝）→ 中环俯仰（金）→ 内环横滚（绿）；枢轴销连接相邻环；环标签随环转动；环内嵌四轴 scale 1.15 |
| `scene/quatview.ts` | 四元数视图（球面参考方案）：参考球+赤道环+极轴；Slerp 白 / 欧拉品红双 Tube 弧（r=0.012）+ 滑动 marker；起终点蓝/橙球；中央四轴 0.55 + 机头箭头 + 轴角青箭头；q/−q 并排组（X ±0.95）。`parts.slerpPoints/eulerPoints` 采样点数组供 scenecheck 断言。`SPHERE_RADIUS=0.85`。**4D 立体投影模式**（`projGroup`）：S³ 从南极 (−1,0,0,0) 投影 p=(x,y,z)/(1+w)，赤道 w=0 恰为参考球；青点 q（球内）/品红 −q（球外，倒易 |p(q)|·|p(−q)|=1）/轨迹线/i-j-k 基架/中央姿态四轴；lastDir 方向延续防极点跳变。API：`setInterpolation/setNegation/showNegation/setProjection/showProjection`；parts 增 `projGroup/projQPos/projNegPos` |
| `scene/labels.ts` | `makeTextSprite(text, color, {size, bold, alwaysOnTop})` 通用文字标签 |
| `ui/mode.ts` | 视图策略（纯函数）+ `narrateGimbal`；**精简模式已删除** |
| `ui/chart.ts` | `RollingChart` 手绘 canvas 时序图；系列构造时固定 |
| `main.ts` | 装配层：500 Hz 定步长仿真（追帧上限 0.25 s）、滑块三件套、视图切换、磁航向箭头、受扰黏性提示（1.5 s）、文档页开关（按钮/Esc）+ 目录 IntersectionObserver 高亮 |

## 关键约定（改代码前必读）

- **坐标系**：世界 NED（x 北 / y 东 / z 下），机体 FRD；q 为机体系→世界系。
  显示坐标 X=北、Y=上、Z=东，NED→显示用 S=Rx(90°)；向量转换用 `toDisplayVec`。
- **机体轴标签**：x 前 +X（红）、y 右 +Z（绿）、z 下 −Y（蓝）。**z 指向地面是 NED 约定，不是 bug**。
- **颜色**：数据系列色写在 JS 里（真实 `#e6edf3` / 纯积分 `#f85149` / 互补 `#ffa657` /
  Mahony `#58a6ff` / Madgwick `#7ee787`）；UI 强调色是 CSS `--accent: #22d3ee`（仪表青）。
  两者刻意区分，不要混用。
- **滑块三件套**：HTML 静态声明 `input[type=range]` + `data-num` + `data-step`，由 `bindSlider` 动态绑定。
  读数由数值输入框承担，**不要再引入 `<output>`**（曾被批量转换脚本删光，导致 14 个滑块初始化中断）。
- **事件回调**：不能直接写 `addEventListener("input", stopDemo)`——事件对象会误入 `keepConclusion` 参数，
  必须包一层 `() => stopDemo()`。
- **术语**：界面与文档一律用全称「陀螺仪」「加速度计」，不用「陀螺」「加计」简称（用户明确要求）。
- **图标**：`public/favicon.svg`（四轴俯视 X 机架 + 四色旋翼环 + 机头向量），由 index.html `<link rel=icon>` 引用。
- **显隐机制**：`body[data-view=attitude|gimbal|quat]` 驱动 CSS（quat 视图隐藏 charts/scenario/view/telemetry/imu/algo/readout）。
  JS 依赖的类名钩子：`.hidden` `.active` `.num-input` `.step-input` `.section-*` `.legend-chip[data-est]`
  `#gimbal-compare.ok|.warn` `#gimbal-status.warn`。
- **文档页（浅色三栏）**：`#docs-overlay` 局部覆盖设计变量为浅色主题（纸面 #eef1f6）；
  `.docs-shell` 三栏网格 208px | 内容 | 188px，三个面板各自独立滚动、零间隙。
  左栏 `.module-link` 纯模块按钮（子目录与箭头已按用户要求删除，点击即切换）；
  中栏 `.doc-pages` 内 7 个 `.doc-page` 分页（manual / math / filters / 4 个 `f-*-detail` 推导独立页，
  推导页由 h2 标题的「完整推导 →」胶囊进入、页内 `back-link` 返回、步骤 h3 带 `fd-*-{n}` id）；
  右栏 `#docs-chapter-toc`「本页目录」由 JS 按当前页 section[id]/h3[id] 动态生成 + IntersectionObserver 跟随高亮。
  滚动位置**按页**记忆（docScrollMemory），退出再进入回到上次页面与位置。锚点跳转统一走 jumpToHash
  （目标在其它页先 showDocPage 再平滑滚动）。顶部 `.doc-index` chips 已删除。
  **图示**：9 个 figure = 8 幅内联 SVG（数学工具箱三联图/倾斜机体与加速度计读数/两个「下」与叉积误差/
  Slerp 大圆对比/互补三信号/Mahony P-I 分工/Madgwick 梯度碗/卡尔曼增益自适应——曲线类 SVG 由脚本
  预计算生成）+ 1 个 Canvas 实时演示（#fig-comp-demo 互补滤波三路信号，stepCompDemo 挂在主循环 frame()，
  仅当文档开且在 filters 页时运转 updateCompDemoRun()）。**单次扫描模式**：一轮 CD_N=560 样本从左端
  「起点」刻度向右描绘（四色笔头圆点=当前时刻，底部橙色进度条），画满停顿 CD_HOLD=1.4s 后清空重播。
  文档正文字号 14.5px（用户嫌细后整体 +1px，标题/公式/卡片/表格/目录同步上调）。浅色图色板：红 #e5484d 橙 #d97706
  绿 #059669 紫 #7c3aed 品红 #c026a3 噪声灰 #94a3b8。
  **图示排版规约**（用户反馈文字重叠后确立）：所有 SVG 文字带白色描边光晕
  （CSS `.doc-fig text { paint-order: stroke; stroke:#fff; stroke-width:3.5px }`）；
  图例放图外专用边距带或白底盒；曲线类图不在图内放长注释（写进 figcaption）；
  图 1 用 ①②③ 徽章标题标明阅读起点；图 7 之字路径用 marker-mid/end 标方向。
  控制项条目 `.ctl` 三段式 `.k1/.k2/.k3`；公式 `.formula` 纯 Unicode pre-wrap；对比表 `.docs-table`。
- **字体**：Fira Sans / Fira Code 通过 `media="print" onload` 非阻塞加载；国内网络失败时自动降级系统字体。

## 参考资料（2026-10-25 内容丰富轮）

- **[外部资料汇编](RESEARCH-NOTES.md)（docs/RESEARCH-NOTES.md）**：2026-10-25 四线网络调研 47 条资源
  （A 数学教学可视化 / B 算法论文教程 / C 开源实现官方文档 / D 教学设计与传感器实践），
  关键内容（公式/参数/流程）已内联摘录、无需联网，附 P1/P2/P3 综合改进建议——**后续模型完善项目时从这里开始读**。
  本轮（外部资料落地轮）已落地其中 P1 全部 + P2 器件预设，见下方里程碑。
- [i2Nav《惯性导航姿态算法》讲义](http://i2nav.com/ueditor/jsp/upload/file/20220419/1650373794259063852.pdf)（四种姿态表示框架）与 [KF-GINS](https://github.com/i2Nav-WHU/KF-GINS)（ESKF 架构）
- [eater.net 可视化四元数](https://eater.net/quaternions)（4D 立体投影交互思路）
- [euclideanspace 四元数](https://www.euclideanspace.com/maths/algebra/realNormedAlgebra/quaternions/index.htm)（为什么四个数/球面直觉/i-j-k 旋转解释）
- [UIUC 四元数笔记](https://new.math.uiuc.edu/oldnew/math595/2015/miller7/index.html)（反射三明治/2×2 复矩阵）
- [Rfly 课程](https://rfly.buaa.edu.cn/course.html)（传感器标定等工程实践要点）

## 已完成里程碑

- **A/B 视觉修复 + 曲线区可折叠**（2026-10-25，用户反馈驱动）：
  - 用户报「B 组颜色不对/纯积分 B 取消不掉/卡尔曼 B 不存在」——排查实为**视觉假象**：B 是 A 的参数克隆，
    未改参数时五对曲线逐点重合（纯积分 B 取消后红色 A 实线仍在原地、卡尔曼 B 被 A 完全遮挡）。
    图例 DOM 与点击行为本身正常（复现验证）
  - 修复：**纯陀螺仪积分移出 B 组**（无参数，永远与 A 重合——困惑根源；B 组=四种融合算法，
    `AB_TARGETS`/通道 5+4/errVisibleB 4 长）+ **B 曲线半透明**（8 位 hex alpha 0.6，重合也可分层次）
  - 曲线区**可折叠面板**：三面板标题栏加 `fold-btn` 箭头，点击 toggle collapsed（canvas+图例 display:none，
    ResizeObserver 展开自动重绘）；IMU 面板默认收起；d-display/d-algo 文案同步
  - 验证：浏览器断言（B 芯片 4 个带 alpha、A/B 改参分化 2.10° vs 0.95°、折叠切换、零错误）+ 60 项自检
- **真实 IMU 串口接入**（2026-10-25，用户硬件 STM32F4 + GY-87，固件由用户自行编写并已在 SerialWeb 验证）：
  - **帧协议**（`firmware/gy87.h` 规格表 + 用户固件对齐）：0xAA 0x55 | len=24 | seq u16 | tick u32 |
    gyro i16×3 (0.1°/s) | accel i16×3 (0.01m/s²) | mag i16×3 (0.01μT) | CRC8(0x07)，28 字节小端
  - **`src/core/serial.ts` 纯函数解析器**：流式喂入/粘包重同步（丢到下一帧头）/坏 CRC 拒收（consumed=2）/
    安装方向重排（4 种 mounting → NED 机体系）/`buildFrame` 供测试往返；selftest 34 四项断言全过
  - **main.ts 连接管理**：`btn-serial` 用户手势触发 `requestPort()`（最小 Web Serial 类型面 declare global）→
    `open(921600)` → readLoop 拼缓冲（1KB 上限）→ `serialDrainBuffer` 弹帧；丢帧统计（seq 回绕）；
    断线/拔出提示；`serial-mounting` 下拉换向时清缓冲
  - **真实模式语义**（`state.real` + `applyDataSourceSemantics`）：模拟剧本与污染滑块停用（stepSim 分流吃
    `serialState.lastFrame`，gyro °/s→rad/s）、**无真值基准** → 幻影隐藏（frame 每帧压制）、误差曲线改
    「vs Mahony 基准」（`err-title` 同步文案）、readout-true 标注「基准(Mahony)」、静止检测粗对准保留
  - **IMU 原始波形第三面板**（`#imu-canvas` 18 通道）：陀螺/加计/磁三组实测三轴 + 模拟模式三组真值对照
    （真实模式真值 NaN 不画）；三页签切 visible 掩码（`imuTabMask`）；`logRow` 每 40ms push
  - **坑**：SW 缓存导致浏览器拿旧构建——开发循环先 `unregister + caches.delete` 再 reload；
    `qAngleBetween` 的 acos 在零夹角附近分辨率 ~1e-6°（端点断言别定 1e-9）
  - 验证：tsc/check(60)/build 全绿；浏览器验收控件/页签/波形（加计 z≈9.8 精确、真值虚线贴合、
    SW 缓存坑实测并记录）；真实设备连接流程待用户硬件到位后走通
- **待办清零轮**（2026-10-25，候选增强 4 项 + 长线 5 项全部落地）：
  - **A/B 参数对比**：`ab-toggle` 勾选瞬间五算法各克隆 B 组（`getParams/setParams` 快照、姿态重置、参数冻结、
    磁力计开关同步）；误差图扩为 12 通道（A 实线 / B 虚线 `dash:[5,3]`），`#err-legend-b` 第二图例行
    （`body[data-ab=on]` 控制显隐）；`btn-ab-snapshot` 随时重快照；B 组卡尔曼零偏从快照时刻重学（文档注明）
  - **闭环控制演示**：`World.step(h, params, feedbackQ?)`——`loop-toggle` 勾选后控制器改用所选估计器姿态
    计算跟踪误差（因果序：用上一步估计），「估计漂多少、机体飞偏多少」；selftest 32：理想环 0.00° vs
    纯积分估计反馈（零偏 3°/s）13.47°
  - **IMU 误差模型升级**：`gyroWalkDps`（零偏随机游走，World 持有 `gyroWalk` 状态每步推进，
    0 = 不消耗随机数、序列守护不变）、`accelCrossAxis`（双向泄漏）、`accelNonlin`（偏离 1g 二次压缩）、
    `magQuantUts`（确定性取整）——全部默认 0；4 个新滑块 + d-imu 条目；selftest 30/31（粗对准 0.000°、
    量化格点/交叉轴泄漏）；**坑**：walk 状态单位 °/s，只在 simulateImu 统一转 rad/s（曾双除 57.3 缩小 57 倍）
  - **Allan 方差演示**（`#fig-allan-demo`，m-sensor）：合成 655s@50Hz 已知 N/K 序列 → 非重叠 Allan σ(τ)
    log-log 曲线 + ±½ 斜率参考线 + 公式与读法；惰性一次绘制
  - **深链分享 + PWA**：`deepHash()`（21 滑块 + 7 开关 + 5 下拉 → base64(json) → `#s=`），
    `applyDeepLink()` 初始化还原（dispatch input/change），`updateHash()` 挂 frame 的 0.1s UI 块（replaceState）；
    `btn-share` 复制 + toast；`public/manifest.webmanifest` + `public/sw.js`（stale-while-revalidate 运行时缓存）
    + `import.meta.env.PROD` 下注册（tsconfig types 加 vite/client）
  - **Squad**：quat.ts 加 `qLog/qExp/squadTangent/squad`；`QUAT_POSE_PAIRS` 新增四关键帧预设
    （path=[p0,p1,p2,p3]）；quatview 第三条琥珀弧（`parts.squadPoints`，无 path 隐藏）；m-slerp 加推导节
    （内积切线 + 三层 Slerp 嵌套直觉 + Dam 报告引用）；scenecheck 四元数断言扩展 squad 端点/点数
  - **三段式初始对准·静止检测**：`stepStillness`（|ω|<3°/s 持续 3s 且融合估计对齐差 >8° →
    `coarseAlign(accel, mag, magEnabled)` 重置四家融合估计，纯积分保留作对照；5s 冷却）；
    `#align-chip` 提示 3s；selftest 30 验证 coarseAlign 精度
  - **立体投影三段式**：`#proj-section` canvas（w–i 平面 S³ 剖面 inset：单位圆 + q/−q 对径点实时位置，
    drawProjSection 挂 updateProjTurn）+ 面板 hint「抬升→旋转→投影」三段式叙事
  - **文档叙事**：8 个 `.doc-hook` 钩子盒（量化开胃问题：总览/表示/ijk/传感器/积分/叉积/工程实践/滤波总览）
    + `btn-sandbox` 一键沙盒（复合机动+中等污染+玻璃盒+初始偏差+A/B 快照+回姿态视图）
  - **selftest 28–33**：Squad 端点/归一化/区分度/qLog 往返、参数快照 roundtrip、粗对准、量化+交叉轴、
    闭环、随机游走——共 33 项；**坑**：qAngleBetween 的 acos 在零夹角附近分辨率 ~1e-6°，端点断言容差 1e-4°
  - **tsconfig 纳入 scripts**（include + node types）：修复 diag*.ts 停留在旧 API（update 三参、缺 ImuParams 字段）、
    scenecheck 未用导入——类型检查不再有盲区
  - 验证：tsc/check(59)/build 全绿；浏览器验证见下轮（本次 commit 前快速抽查）
- **外部资料落地轮·三**（2026-10-25，依据 RESEARCH-NOTES.md §6 P2-9/10/11/12③）：
  - **加速度计观测门控（幅度+方向双层）**：互补/Mahony/Madgwick 加 `accelGate`（默认开，公开供自检 A/B）——
    幅度（‖a‖ 偏 g 超 35%）+ **方向**（实测与预测重力夹角超 `ACCEL_GATE_DEG=20°`）；
    启动 ramp 期间按 Fusion 语义关闭拒绝（否则初始偏差被拒收卡死）；被拒帧整帧退化为纯积分（磁航向一并跳过）。
    关键认知（selftest 调参时实证）：**垂直于重力的污染对范数只有二阶影响**（4 m/s² 侧向 → 范数仅偏 8%），
    幅度门控对它盲——方向门控才是主手段（Fusion 同款）；而高频零均值振动反而该让滤波器平均、
    方向门控在该场景更差——门控的真正主场是**持续单向线加速度（协调转弯）**
  - **selftest 第 27 项**：「持续侧向 4 m/s² A/B」——门控开 0.00° vs 关 24.9°（手工构造恒定侧向加速度样本，
    非 simulateImu 正弦）；ramp A/B 组同步关 accelGate（单变量隔离）
  - **等效旋转轴开关**（`#axis-toggle`）：setup.ts 加 `axisArrow`（青 0x22d3ee，挂场景、从机体中心沿
    世界系轴伸出，长度随转角）；main.ts frame() 每帧更新（qToAxisAngle，近零旋转隐藏）
  - **磁力计「校准舞蹈」canvas 演示**（`#fig-calib-demo`，m-practice）：合成已知硬铁 [9,-6,13]μT +
    软铁 diag(1.18,0.88,1)，Lissajous+确定性伪随机抖动翻滚采 240 点；左原始椭球（红）/右标定后球（绿），
    底部覆盖度进度条；`stepCalibDemo` 挂主循环、`updateFigDemoRun` 统一管三个文档演示
  - **文档**：f-compare 新增「观测可信度管理」段（三套门控对比：幅度/方向/新息，Fusion 10°+恢复窗，
    启动期关闭的取舍）；m-frame ② 门控行改双门控口径；d-imu 机动线加速度条目同步；
    m-slerp 加「等步长递推 p_{k+1}=c·p_k−p_{k-1}」实现备注（Shoemake/维基出处）；d-display 加轴开关条目
  - 验证：tsc/check(53)/build 全绿；浏览器实测轴箭头（45° 横滚 → 沿世界北向轴伸出）、校准舞蹈
    （像素级红/绿点云断言 + 86/240 截图）、控制台零错误
- **外部资料落地轮·二**（2026-10-25，依据 RESEARCH-NOTES.md §6 P2-5 + P3 快赢）：
  - **初始姿态偏差 + 启动增益 ramp**（P2-5）：`Estimator.reset(initial?)`；互补/Mahony/Madgwick 加
    rampK()（2.5s 增益 6→1 线性衰减，只放比例/梯度项）；面板新开关「重置时随机初始姿态偏差」
    （`#init-offset-toggle`，五家共用同一随机初值 20–35°，上限刻意留在卡尔曼 40° 门控内；
    开关 change 即触发 resetSim）；`randomInitOffset()` 均匀球面随机轴
  - **selftest +2（共 52 项）**：25「初始偏差 30° 八秒收敛（四种融合）」（偏差轴横滚主导 + MARG 开——
    纯偏航偏差加计不可观，第一版用 z 主导轴误设计已修正）；26「启动 ramp A/B 对照」
    （1.5s 时带 ramp 全部 0.0° vs 无 ramp 3–4.5°，同噪声序列只差 rampEnabled）
  - **修复既有 bug：MARG 默认状态不同步**——mag-enable checkbox 默认勾选但不触发 change，
    ests[].magEnabled 初始全 false，UI 显示「MARG 开」而算法实际没用磁力计（琥珀箭头照漂）。
    改为 applyMagEnable() + 初始化显式调用
  - **比力符号口径修正**（P3-15，调研核对时发现的文档自相矛盾）：m-sensor 原文 f=Rᵀ(a−g)（静止=机体「上」）
    与后文「读数 [0,0,+9.8] 沿机体下」矛盾；现明确两层：真实器件输出比力本尊（静止沿「上」），
    本装置取反号 ã=Rᵀ·g（读数=重力投影方向，沿「下」），归一化后与算法等价；d-coords 对应条目同步改写
  - **文档深化**：m-practice 初始对准节扩写（粗对准/精对准、ramp、陀螺仪偏航不可观、门控拒绝救援两条红线）
    + 新增「片上融合 vs 软件融合：BNO055 的另一条路」小节（P3-14）；
    f-kalman-detail 新增第七步「与文献标准做法的逐项对照」表（Φ 一阶截断/Joseph 形式/40° 固定门控 vs χ²
    马氏距离/注入后协方差重置，P3-16）
  - 验证：tsc/check(52)/build 全绿；浏览器（4177 端口，4176 被旧进程占用属已知坑）实测开关收敛流程：
    重置 0.4s 各融合在 ramp 作用下猛拉（互补 7.4°/Mahony 2.7°/卡尔曼 1.4°）、5s 后全部 ≤1.8°、
    纯积分停在偏差处线性爬升（对照行为正确）；主视图截图确认误差曲线高台骤降形态；控制台零错误
- **外部资料落地轮**（2026-10-25，依据 RESEARCH-NOTES.md §6 的 P1/P2 建议）：
  - **IMU 器件预设**（P2-8）：`main.ts` IMU_PRESETS（MPU-9250 / ICM-42688-P / BNO055 / 自定义），
    噪声密度 × √(500/2) 采样换算写滑块；手动碰预设管理的滑块自动回「自定义」；
    文档 d-imu 新增「器件预设」条目 + 三器件规格对照表。预设接管的三滑块绑定存 `imuSliders` 对象
  - **4D 投影「累计旋转」读数**（P1-1）：`updateProjTurn` 把按 i/j/k 的次数折算累计转角与「哪张皮」解说
    （0 次/+1、2 次/−1、4 次/+1），面板 `#proj-turn` 行 + hint 重写 + 文档 m-4d 补「纬度=半角」段；
    **顺带修复真 bug**：`projAnimateTo` 目标原来基于 `projState.q`（动画完成才更新），0.7s 内快速连按
    第二次目标仍基于旧值 →「连按两次=−q」落空、读数与实际脱节；新增 `projChainBase()`（动画中取 anim.to 链尾叠加），
    node 验证快速双击→−1、慢速两次→−1、四次→+1 全部成立
  - **旋转顺序不可交换演示**（P1-3）：文档数学页新 figure `#fig-order-demo`（Canvas，720×240），
    两颗骰子「先偏航后横滚 vs 先横滚后偏航」（世界系 Rx·Ry / Ry·Rx），ψ=φ 在 0–90° 往返，
    底部实时显示两姿态夹角（矩阵迹反解轴角）；`stepOrderDemo` 挂主循环，
    `updateCompDemoRun` 改名 **`updateFigDemoRun`**（同时管互补演示与顺序演示的运转开关）
  - **万向节锁矩阵证据 + 欧拉复合公式纠错**（P1-2）：文档原写 R = Rx(φ)·Ry(θ)·Rz(ψ) 与代码
    `qFromEuler`（实为 R = Rz(ψ)·Ry(θ)·Rx(φ)）矛盾，已数值验证并改正；
    新增矩阵证据 formula（θ=90° 时矩阵只含 (φ−ψ)，R(10°,90°,0°)≡R(0°,90°,−10°)）；
    面板/文档的演示描述修正为「横滚 +60° vs 偏航 −60°」（与 gimbal.ts 实际脚本一致）
  - **qToEuler 换 atan2 稳定 pitch 公式**（P1-6）：2·atan2(√(1+2d), √(1−2d))−π/2（d=q.w·q.y−q.z·q.x），
    与 asin 形式在 20 万随机四元数上最大差 5.6e-16 rad，±90° 附近数值更稳
  - **参数物理含义标注**（P1-4）：d-algo 的 Kp/Ki/β 条目与 f-mahony/f-madg 页新增实战锚点
    （Kp≈1.5/Ki≈0.005、twoKp=2×Kp 约定、β=√(3/4)·ζ̄ 单位 rad/s、原始代码默认 β=0.1、
    运算量 IMU 109/MARG 277、Mahony 2008 出处与 k₁/k₂ 加权讨论）
  - **约定与性能口径**（P1-6b）：数学页新增 **Hamilton vs JPL/Shuster 约定对照表**
    （ij=k vs ij=−k、分量顺序、使用者清单）+ m-reps 计算量对照段（复合 28 vs 45 次、
    qRot 交叉积式省 30%、Madgwick 109 次）；d-coords 补约定行
  - 验证：tsc/check/build 全绿；浏览器验证预设三档写入与回落、turn 初值、文档九项内容断言、
    四张截图（三栏布局/规格表/矩阵证据/顺序演示动画活帧 ψ=7° 夹角 14.8°），控制台零错误；
    rAF 间歇停摆期间以 scenecheck 几何断言与 node 逻辑验证补位（既有已知坑）
- **M1 + M2**（`0315075`）：3D 可视化、模拟 IMU、四算法、双图表、6 种机动、手动控制
- **M3**（`3635b9c` + `64a5432`）：平衡环架万向节锁演示 + 机体轴标签 + 滑块数值/步距输入 + 术语统一
- **前端重设计**（`64a5432`）：Dark Mode(OLED) 设计系统、自定义滑杆、可访问性达标（对比度 5.2–17.9:1）
- **玻璃盒 + MARG + 四元数视图**（`50bf534`）：估计器 telemetry + 双重力箭头 + 内部读数块；
  磁力计链与三种 MARG 修正；第三视图「四元数」
- **四元数视图视觉重做 + 文档页 v1**（`7ea40b6`）：球面参考方案（Tube 弧/滑动 marker/q−q 并排）；
  应用内文档层；面板「原理速览」迁移删除
- **M4 部署**：GitHub Actions → Cloudflare Workers，`fly_web.070616.xyz` 上线；Release v0.1.0
- **参考资料内容丰富**（本轮）：
  - 数学原理新章 ×5：「为什么恰好是四个数」（维度阶梯+毛球定理/布鲁姆桥彩蛋，图 9）、
    「四种姿态表示」（欧拉角/DCM/等效旋转矢量/四元数 + 对比表）、「i、j、k 到底是什么」
    （乘法环图 10 + 反射/旋转三明治 + SU(2) 进阶框）、「立体投影」（投影公式/倒易点对/玩法）、
    「工程实践备忘」（标定三流水线/初始对准/ESKF 架构）
  - 四元数视图新增 **4D 立体投影模式**：模式下拉切换；左乘 i/j/k 按钮以 nlerp 弦插值动画
    （保证终点精确，连按两次 i 演示 q→−q 双重覆盖）；scenecheck 新增投影几何断言
  - core 新增 `qToMatrix`（DCM）；selftest 新增 DCM 正交性/旋转矢量往返（共 50 项检查）
- **文档页三模块 + 卡尔曼滤波**（ec743c4 后）：
  - 文档页改「左栏大模块 / 右侧目录+章节」双栏：控制项手册、数学原理（零基础向：类比导入 + 数学工具箱 + 白话块）、滤波算法讲解（互补/Mahony/Madgwick/卡尔曼详解 + 对比选型表）
  - 新增 **KalmanEstimator**（ES-EKF）：误差状态 [δθ(3), δb(3)]，重力/磁场两组观测、40° 新息门控、零偏在线估计；UI 增卡尔曼 Q/R 滑块、曲线系列 #c084fc、玻璃盒零偏估计与新息读数
  - 术语全称化（陀螺仪/加速度计）、删副标题、favicon.svg、控制项列表化
- **质感升级**（本轮）：
  - 公式排版 v2：katex 本地字体（仅用字体，无 CDN）；.formula = KaTeX_Main 衬线 16px +
    **盒子包裹**（bg-card + 左强调线，与正文区分）；配套三件套：`.frac` 堆叠分数（分割线上分子下分母，
    9 处）、`.mtx` CSS 括号矩阵（左右竖线+端帽+grid 单元格，3 处：R(q)/f(q)/A 矩阵）、
    `.fvars` 变量含义表（公式后注释行，14 处）；全部公式按「一句一行」重排，｜分隔行已拆散；
    数学工具箱章新增「记号一览」表（顶部点/尖帽/δ/范数/转置逆/⊗×·/∫Σ/∇/lim 十行）；
    分数全量上下式（32 处 .frac，含 θ/2、ω·dt/2 等内嵌小分数与 K=P·Hᵀ/(H·P·Hᵀ+R) 这类逆序括号→分数）；
    全部 SVG 箭头由实心三角改为开口 V 形（chevron marker），marker id 按图唯一化（修复跨图 id 冲突）；
    图 7 重做为 7 大步之字 + 3 枚切向小箭头（去掉逐点 marker-mid 的杂乱）；
    排版 v4（符号系统化）：½ 全部改为上下分数（9 处含标题/散文）；组合字符点(24)/帽(80)
    改 CSS 定位记号 `.od`/`.oh`（::after 悬浮 ˙/ˆ，不再与后续字母重叠）；上标修饰字母
    ᵀ/⁻¹/⁺/⁻ 全部转 `<sup>`（22+8 处，字号 0.72em 可读）；S¹/S³ 转上标；
    ω_used/ω_corr 转真下标；图 2 SVG 内 f_z/f_x 用 tspan 位移下标（SVG 无 <sub>）
  - 渲染：RoomEnvironment PMREM IBL（environmentIntensity 0.35）+ 冷色轮廓补光；
    万向环改 MeshPhysicalMaterial 阳极金属（envMapIntensity 1.35）；新四轴模型见上
  - UI：面板/图表卡片渐变表面+分层阴影+hover 描边；主按钮内高光；滑杆轨道值填充
    （--fill CSS 变量，bindSlider 维护）；chips 玻璃增强；seg/表头光效
  - 四元数视图三演示组切换改 0.4s 淡入淡出+轻缩放（quatFades，材质基准透明度
    记录于 userData.__quatBaseOp，可被安全打断并还原）
  - selftest 新增 3 项卡尔曼测试（静态收敛 / 抗零偏+零偏估计 / MARG 偏航收敛），共 47 项
- **文档页重做 + 数学原理模块**（ec743c4）：
  - 侧边目录（sticky + 滚动跟随高亮）+ 9 个功能章节 + 9 节数学推导
  - 功能章改为**控制项百科**：每个滑块/开关/标记三段式「是什么 / 起什么作用 / 改了会怎样」
  - 数学章完整推导链：数据流水线总览 → SO(3) 与四元数（乘法/旋转公式/R(q) 矩阵/双重覆盖）→
    三传感器测量模型 → q̇=½q⊗ω 四步推导（含左右乘辨析与离散化）→ 叉积误差三性质 →
    Mahony P/I（含 Ki 消零偏机制）与 Madgwick 梯度下降 → 倾斜补偿航向与 MARG →
    Slerp 推导与短路径 → 500 Hz 一帧伪代码（每行对应可见现象）
  - 删除旧粘贴式文档残留与死 CSS（details 折叠样式）

## 验证体系

- `npx tsc --noEmit` → `npm run check`（60 项全 PASS）→ `npm run build`
- `selftest` 覆盖：欧拉↔四元数往返、无零偏不漂、零偏线性漂移、抗扰、动态跟踪、剧本切换、
  万向环链条≡主视图、死锁判定、演示全相位、锁定态等价、磁力计（含参数全零守护）、
  轴角双覆盖（qToAxisAngle 对 q 与 −q 恒等）、欧拉插值端点与区分度
- `scenecheck` 校验：内环姿态≡toDisplay（3.9e-16）、环面含自转轴、枢轴销连通、间隙不穿模、
  四轴不穿出内环、死锁轴重合、轴/环标签、四元数视图弧线端点与采样点数组、q/−q 恒等
- UI 改动后浏览器截图确认 + 控制台零错误

## 待办

- ~~候选增强（A/B 对比、闭环控制、Allan 方差、深链+PWA）~~ 全部完成（待办清零轮）
- ~~长线大件（Squad、叙事钩子+沙盒、S³ 剖面三段式、静止检测、新误差滑块）~~ 全部完成（待办清零轮）
- **安全**：Cloudflare API token 曾在对话中暴露（已写入 GitHub 加密 secrets，未入代码库），
  **用户仍未确认轮换，需再次提醒**
- 远期可选（未列入正式待办）：Web Serial 接真实 IMU、guided tour 课程剧本、参数整定小游戏、误差分解视图

- **4D 投影模式重排版**（本轮）：
  - 投影球缩至 PROJ_RADIUS=0.62（导出常量；scenecheck 投影断言改用它）——给「姿态舞台」与 −q 钳制位留画面
  - **姿态四轴移到球下方独立舞台**（y −0.98、scale 0.42、「3D 姿态（与 q 同步）」标签）——不再遮挡原点区 q 点/轨迹
  - 语义锚点：球内/球外 w>0/w<0 标注、原点「1」标签、i/j/k 基点加大；**−q 品红轨迹**（与青色 q 轨迹对称，内外互换可见）
  - q 标签近原点时最小竖直偏移（不与「1」重叠）；面板 hint 同步新布局（尖括号需 HTML 转义——vite html parser 拦截）
  - **模式级相机推拉**：QUAT_FRAMING interp/proj 两套取景，0.55s ease 过渡（−q 3R≈1.86 保证在画内）
  - **连按无缝续接**：projState.current 记录当前显示帧，动画中途再按从画面位置出发不跳变
- **外部评估修复轮**（f2881f1，Qwen 评估驱动，15 项）：
  - P1 解卷绕累积（循环剧本每圈 +360° 永不复位 → 读数几万度）：channelValues 加**集体重定位**
    （本通道全部系列同越 ±180° 时整体平移 360° 并同步 attPrev），图例读数显示时包裹 ±180°；
    实测 roll360 跑过一圈读数有界
  - P1 文档 Mahony 公式块符号与代码矛盾（减号→加号，e=a×ĝ 约定下加号才对）
  - P2 quat 视图两条 hint 漏 .quat-interp-only；罗盘缩短至 1.42/标签内移 1.62（不再被面板裁切）；
    ≤1280px 右栏目录改为内容列顶部横向滚动条（grid 双行布局）；三张 docs-table 包 .tscroll 横滚容器
  - P3 姿态对下拉加宽 232px；Canvas 演示绘制顺序改「噪声→陀螺→融合(α0.8)→真实(2.2 最后)」黑线可见、
    起点刻度移图例下方；chart-header row-gap
  - 文档口径：五种算法/六条曲线（+卡尔曼）、chips 补磁航向指示、总览补初始对准交代、
    m-error 补「两道防线=观测可信度管理」小结、卡尔曼调参块补 Q/R 单位换算、
    五个通识章节（m-why/reps/ijk/slerp/4d）加「选读」徽标、TOC 支持 data-toc 纯文本
    （修复积分方程标题在目录里退化）、.od/.oh 加 line-height:1 跨上下文稳定
  - README 全量同步现状（五算法/四元数视图/4D 投影/文档三模块/50 项检查/favicon）
- **排版 v3/v4**（c4a04bd/3b49350）：

- **taste-skill（tasteskill v2）data-terminal 重饰**（本轮）：
  - 风格表 seed 887383732（data-terminal，devtools/dark）；face = Fira Code 全数值 mono + 青色 1px 选中线
  - 动作：所有选中态（视图 seg/图表 tab）= 1px 强调线；主按钮=反白（#eef2f8 底深字）；
    面板/图表卡平涂仅留 1px 边（边影不并存）；chips 不透明（无 backdrop blur）；
    滑杆拇指中性平涂无辉光、轨道硬切填充；图例点/进度条去辉光；复选框中性色
  - 卡尔曼数据色 紫 #c084fc → 玫瑰 #e05fb0（violet 禁用；全链同步：估计器/文档图 7·8·9/文案「品红」）
  - 删除上电扫光与标题阴刻（frontend-design 轮引入的装饰动效/影——app-screen 规则禁止入场表演）
  - 全页 sub/sup ≥11px；.tel-line .dim 与 .ctl-range 10.5→11px；圆角收紧 4/6/8
  - 豁免（lint taste-skill-ignore / 报告说明）：mono=风格 face 选项；em-dash=中文破折号；
    滑杆硬切填充与键盘焦点环=功能性；对比图 6 系列=产品核心问题（同主题同色全站一致）
  - 门禁：lint --app 0 FAIL；inspect --app 1440/768/390 = **0 FAIL 0 WARN**（before 4 FAIL）
  - `.taste-skill/`（方向表+前后对照截图）已加入 .gitignore

## 已知坑

- 批量改 DOM 时务必全量回归滑块（历史事故：`<output>` 被删导致绑定中断）。
- index.html 大改后注意标签闭合：Vite build 的 HTML parser 会拦截坏标签（如 `</sub‖` 漏 `>` 直接 build 失败），
  但**闭合错位不会报错**（曾产生游离孤儿节点）——改完 grep 校验结构。
- 内嵌四轴 scale > 1.3 会穿出内环（scenecheck 断言拦截，实测 1.15 时间隙 0.086）。
- 测试环境 rAF 会间歇停摆：截图可能超时或 3D 区黑屏，此时以 `scenecheck` 的几何断言替代视觉验证。
- `vite preview` 服务的是 `dist/`，改源码不重新构建就不会生效；4173 被旧进程占用时会自动换 4174，
  浏览器测试以实际输出端口为准。
- GitHub 直连间歇性中断：push 失败多重试或稍后再推。
