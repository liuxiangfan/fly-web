# 项目状态 · 四元数姿态解算学习演示装置

> **本文件是项目的恢复锚点。** 会话上下文被压缩后，从这里可以快速接续全部关键信息。
> 最后更新：2026-10-25（质感升级：KaTeX 公式排版 / IBL+PBR 三维渲染 / 模型重做 / UI 精修 / 视图过渡动画）

## 一句话

纯前端（无后端）的四轴无人机四元数姿态解算教学演示装置：Three.js 3D 姿态可视化 +
模拟 IMU（含磁力计）+ 五种解算算法（含卡尔曼）实时对比 + 万向节锁平衡环架 + 四元数插值视图 +
应用内文档页（控制项百科 + 完整数学推导 + 滤波算法讲解 + 工程实践）。
**已部署**：GitHub Actions → Cloudflare Workers，域名 `fly_web.070616.xyz`
（备用 quaternion-attitude-demo.liu06167492.workers.dev），push 即自动上线。

## 技术栈与命令

- Vite + TypeScript（无框架）+ Three.js（three ^0.170）
- `npm run dev` / `npm run build`（= `tsc --noEmit && vite build` → `dist/`）/ `npm run preview`
- `npm run check` = `selftest`（Node 数值自检）+ `scenecheck`（Node 下构建真实 three.js 场景图做几何校验），共 50 项
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
| `estimators/index.ts` | 五估计器统一 `Estimator` 接口：`update(gyro,accel,mag,dt)` + `magEnabled` + `telemetry`（rate/rawGyro/correction/predictedGravity/measuredGravity/accelNorm/accelValid/magValid/detail）。Mahony MARG：磁误差 z 分量并入；Madgwick：独立偏航方向分量；互补：`tiltCompensatedYaw`；**KalmanEstimator**：ES-EKF/MEKF（6 维误差状态 [δθ,δb]，重力+磁场观测，40° 新息门控，可估计陀螺仪零偏，参数 Q=gyroNoiseDps / R=obsNoise） |
| `scene/setup.ts` | 渲染器/相机/灯光/地面/网格/罗盘/主四轴+幻影/万向环架；`toDisplay`、`setView`、`syncVisibility` |
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

- [i2Nav《惯性导航姿态算法》讲义](http://i2nav.com/ueditor/jsp/upload/file/20220419/1650373794259063852.pdf)（四种姿态表示框架）与 [KF-GINS](https://github.com/i2Nav-WHU/KF-GINS)（ESKF 架构）
- [eater.net 可视化四元数](https://eater.net/quaternions)（4D 立体投影交互思路）
- [euclideanspace 四元数](https://www.euclideanspace.com/maths/algebra/realNormedAlgebra/quaternions/index.htm)（为什么四个数/球面直觉/i-j-k 旋转解释）
- [UIUC 四元数笔记](https://new.math.uiuc.edu/oldnew/math595/2015/miller7/index.html)（反射三明治/2×2 复矩阵）
- [Rfly 课程](https://rfly.buaa.edu.cn/course.html)（传感器标定等工程实践要点）

## 已完成里程碑

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
  - 公式排版：katex 本地字体（仅用字体，无 CDN）；.formula 改 KaTeX_Main 衬线 16px、
    去背景盒仅留淡竖线——融入正文流（用户反馈「割裂感」的解法）
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

- `npx tsc --noEmit` → `npm run check`（44 项全 PASS）→ `npm run build`
- `selftest` 覆盖：欧拉↔四元数往返、无零偏不漂、零偏线性漂移、抗扰、动态跟踪、剧本切换、
  万向环链条≡主视图、死锁判定、演示全相位、锁定态等价、磁力计（含参数全零守护）、
  轴角双覆盖（qToAxisAngle 对 q 与 −q 恒等）、欧拉插值端点与区分度
- `scenecheck` 校验：内环姿态≡toDisplay（3.9e-16）、环面含自转轴、枢轴销连通、间隙不穿模、
  四轴不穿出内环、死锁轴重合、轴/环标签、四元数视图弧线端点与采样点数组、q/−q 恒等
- UI 改动后浏览器截图确认 + 控制台零错误

## 待办

- 候选增强：A/B 参数对比、深链分享 + PWA、闭环控制演示、IMU 误差模型升级（Allan 方差级噪声）
- **安全**：Cloudflare API token 曾在对话中暴露（已写入 GitHub 加密 secrets，未入代码库），
  **用户仍未确认轮换，需再次提醒**

## 已知坑

- 批量改 DOM 时务必全量回归滑块（历史事故：`<output>` 被删导致绑定中断）。
- index.html 大改后注意标签闭合：Vite build 的 HTML parser 会拦截坏标签（如 `</sub‖` 漏 `>` 直接 build 失败），
  但**闭合错位不会报错**（曾产生游离孤儿节点）——改完 grep 校验结构。
- 内嵌四轴 scale > 1.3 会穿出内环（scenecheck 断言拦截，实测 1.15 时间隙 0.086）。
- 测试环境 rAF 会间歇停摆：截图可能超时或 3D 区黑屏，此时以 `scenecheck` 的几何断言替代视觉验证。
- `vite preview` 服务的是 `dist/`，改源码不重新构建就不会生效；4173 被旧进程占用时会自动换 4174，
  浏览器测试以实际输出端口为准。
- GitHub 直连间歇性中断：push 失败多重试或稍后再推。
