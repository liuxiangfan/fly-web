# 项目状态 · 四元数姿态解算学习演示装置

<!-- current:begin -->

> **满分质量整改入口（2026-11-02）**：[`QUALITY-FULL-SCORE-PLAN-2026-11-02.md`](QUALITY-FULL-SCORE-PLAN-2026-11-02.md)
> 记录了对提交 `d6c4a22` 的 **84/100** 独立复核、P1/P2 反例、判断标准、实施顺序和 100 分验收矩阵。
> **先读任务书再继续修复**；当前工作树中的未提交修改不算已完成证据，只有红→绿反例、完整门禁和提交记录才算。

> **最新一轮：2026-11-02「满分质量整改轮」**（详见 [`QUALITY-FULL-SCORE-PLAN-2026-11-02.md`](QUALITY-FULL-SCORE-PLAN-2026-11-02.md) 第 9 节与 [`CHANGELOG.md`](CHANGELOG.md) 顶部）。
> 把复核任务书的 P1-1…P1-6 与 P2-1…P2-4 全部修掉，每条都有永久反例：
> **时间**回退不再重复积分（有效时间轴取运行最大值，0.10 s 日志不再积出 0.14 s）；
> **外部真值**按子步 `qSlerp` 插值（新增 `core/truth-track.ts`；10 s 空洞里完美日志 Mahony 平均误差实测 0.39°）；
> **档案**导入拆成「探测写入 / 破坏性提交」，失败时现场逐项不变（新出口 `experiment.site()` 用于断言）；
> **`ratio: null`** 渲染为「—（不适用）」（不再 `TypeError`）；
> **close 失败**不丢会话、生产代码 2 s 退避自动重试（新出口 `plumbing().pendingPortCleanup`）；
> **setup/open/close** 全部有界（迟到 open 自行 close）；
> **稳态窗口/粗对准**进活状态并参与往返；**canonical form** 逐字节可逆；**内核频率范围与 UI 档位分层**（200 Hz 内核可用）；
> **上限参数**统一有限非负整数。浏览器门禁**不再假绿**（浏览器进程被回收即判基础设施失败），
> 八处固定 sleep 改状态等待（含 CSV 导出的 `blob.text()` 读取竞态），并加 `gotoSafe()` 在渲染进程被回收时同页重试一次（结论仍判失败）。
> 本轮实测：`check` 154 项 0 FAIL、`budget` 14/14、`doccheck --recompute` 4/4、
> `smoke` **91 PASS / 0 FAIL（零 warning、零重启）**、同 commit 同 dist **连续 5 次**全绿；
> `soak --batch --seconds=120` 通过（堆增长 +10.5 MB / 峰值增量 10.5 MB / 线性趋势 +5.3 MB），报告带 commit·dist·浏览器·时间窗溯源。
> **冒烟分片与 CI**：`SMOKE_SHARD=app|devices`（72 + 19 = 91，两片各自 0 FAIL）；
> `scripts/ci-run-smoke.mjs` 自起 preview → 探活 200 → 连跑 N 次（任何 FAIL/warning 判失败）；
> `.github/workflows/ci.yml`：gate 与两片冒烟自动跑；稳定性验收走专用分支（`ci-stability` / `ci-stability-win`，
> 因为 `workflow_dispatch` 只认默认分支，而 5×冒烟不该挂在每次 push 上）。**Ubuntu 已实测连续 5 次全绿**
> （run `41492896547`，5×91 PASS / 0 FAIL / 0 warning；PR #1 的 gate + 两片也全绿）；Windows 的同一作业已就绪待跑。
> 浏览器候选路径补齐 Linux。
> **视觉验收**绑定提交 `e67f551`（dist `d7356bc1443a10c4`）：桌面 1440×900 / 窄屏 390×844 / 文档 1440×900 /
> 打印 794×1123 两组共六张，路径·尺寸·sha256 见任务书 9.13。
> **仍未做**：真机串口/BLE 各 30 min（本机实测：串口无硬件、HM-10 不在广播，见任务书 9.16；
> 新增 `npm run hw:soak` 一键复现）、Windows CI 连续 5 次、全部 JS 的 10% 体积余量（262/272 KB）、PR/部署后 smoke。
> 因此本轮结论是「按现有证据达到可复核的高质量水准」，**不是**「各维度满分」。

> **最新一轮：2026-11-01「按两轮独立复核的阻断项修复」**（详见 [`CHANGELOG.md`](CHANGELOG.md) 顶部）。
> 门禁自述（严格顺序）：`npx tsc --noEmit` → `npm run check` → `npm run build` → `npm run budget` →
> `npx tsx scripts/doccheck.ts --recompute` → `npm run smoke`；各项计数见上方 verify 清单
> （与 `npm run statuscheck` 的实测值逐项核对，数字过期即失败）。
> **浏览器门禁本身修好了**：`scripts/browser-smoke.mjs` 顶层的 `const URL` 遮蔽了全局 URL 构造函数，
> 于是它自己第 12 行的 `new URL()` 抛 TDZ——整条冒烟在开浏览器之前就退出，**一项都没跑**却只报「异常」。
> 改名 `APP_URL` 后 90 项全部真实执行；并把「新建标签页失败（浏览器进程被回收）」改成自动重启浏览器继续，
> 一次偶发不再让后面几十项静默跳过。
> **连接释放事务**：`dispose()` 的失败结果不再被永久缓存（close 因读锁失败 → 之后重试真的能关掉），
> 旧 `read` 永不落定时按有界时间推进并如实记账（不再永久卡在「重连中」）；掉线重连**已排程**期间切换来源
> （串口 → BLE → 回放）会取消两侧排程并释放端口，旧定时器不再把旧链路接回来。
> **回放时间轴口径合一**：时长 = 逐帧正间隔之和（时间列有回退时不再出现 `played > duration`）；
> 「最快」档不再把 `Infinity` 写进持久预算，切回有限倍速后墙钟 `dt=0` 不会继续狂飙。
> **实验档案闭环**：导入先拒绝「界面无法表达」的取值（固定轴初始姿态、关闭单个算法），apply 后逐字段
> 读回比较，不一致就**回滚并列出字段**（333 Hz / 越界滑块不再被静默夹值）；界面没有控件的
> `rampEnabled` / `kalmanChi2` 改为真正写回活实例；零样本统计量写 `null`（不再 NaN → null 自拒）；
> `restore` / `seed` / `solveRateHz` / `manualTargetDeg` 按界面可表达的枚举与范围严格校验。
> **校准与长稳门禁**：磁 `kind=diag` 不得携带 matrix（应用路径按 kind 分派，模型标签与解算一致），
> 生产拟合提交前过同一把合法性尺子；soak 两点堆测量不再把 190 MB 增长算成 0，批量必须跑满 3 批。
> **首屏再瘦身**：引导课程（13 步文案，minify 后约 12 KB）改为按需 chunk，主包 gzip 106 → **100 KB**
> （上限 108 KB，占用 93%）；预算新增「引导课程 chunk」独立上限并计入「全部 JS 合计」。
> **顶部声明纳入机器校验**：current 区域内的 `verify` 清单把 check / smoke / budget 与 package.json 的
> check 链一起核对，「N PASS」这类会在门禁外过期的数字一旦写回 current 区域就会失败。
> **doccheck 正文与 runTrace 截断也已收口**：卡尔曼/圆锥/六面的正文数字改由记录配置渲染并加配置健全性关系；
> `runTrace` 到步数上限即停，`endSec` = 已记录的最后时刻（新增 `truncated`/`fullDurationSec`），
> 不再出现「截断的 steps + 全时长 endSec + 全程事件计数」的混口径。
> **长稳与视觉证据（本轮实测）**：`soak --seconds=600` 两段独立报告均通过——
> **batch**：3/3 批跑满、116 个采样点、堆增长 +4.5 MB（上限 24）；
> **reconnect**：54 次断线 **54 次逐段恢复**（每段都用真实消费计数增长证明首帧来自新连接）、
> 122 个采样点、堆增长 +16.0 MB（上限 24），时钟在冻结窗口之外持续推进。
> 报告：`docs/generated/soak-batch-600.json`、`docs/generated/soak-reconnect-600.json`。
> **视觉验收**：六张截图均**可判读**（`screenshots/va-*.png`，该目录在 .gitignore 内，属本地证据）：
> 桌面 1440×900 主界面（左栏读数 / 3D 场景 / 三块曲线无重叠与截断）、窄屏 390×844（正确堆叠、无横向溢出）、
> 文档页（左目录 + 右页内目录 + 公式与提示框排版正常）、打印媒体（应用外壳隐藏、表格与公式完整）、
> 万向节锁视图（三环 + 轴标签 + 「只剩 2 个自由度」引导文案）、导出弹窗（四档选项 + 列数提示 + 说明文字）。
> **仍未做**：串口/BLE 各 30 min 真机（拔插 / 离开范围 / 休眠 / 设备复位）、跨时段真实磁校准数据。

## 一句话

纯前端（无后端）的四轴无人机四元数姿态解算教学演示装置：Three.js 3D 姿态可视化 +
模拟 IMU（含磁力计）+ 五种解算算法（含卡尔曼）实时对比 + 万向节锁平衡环架 + 四元数插值视图 +
应用内文档页（控制项百科 + 完整数学推导 + 滤波算法讲解 + 工程实践）。
**已部署**：GitHub Actions → Cloudflare Workers，域名 `fly_web.070616.xyz`
（备用 quaternion-attitude-demo.liu06167492.workers.dev），push 即自动上线。

<!-- counts: experiments=19 demos=8 selftest=125 smoke=91 docpages=15 -->
<!-- verify: check=154 contracts=yes status=yes smoke=91 budget=14 -->
数值自检 125 + 场景几何 10 + HTML 契约 15 + 文档基准 4
## 技术栈与命令

- Vite + TypeScript（无框架）+ Three.js（three ^0.170）
- `npm run dev` / `npm run build`（= `tsc --noEmit && vite build` → `dist/`）/ `npm run preview`
- `npm run check` = `selftest`（**125 项数值**）+ `scenecheck`（10 项三维场景几何）+ `htmlcheck`（**15 项** HTML↔TS 契约/可访问性/静态资源/文档结构）+ `doccheck`（引用 + 严格 schema + 关系约束 + 正文数字块 + 小基准复算 4 项），共 **154 项**；随后再跑 `contracts`（时间分拍 / 档案 schema / 连接生命周期 / Worker 协作取消 / trace 逐帧 / soak 与状态契约，输出项数另计）与 `statuscheck`（**计数与门禁清单一致性**）
- `npm run budget` = 产物体积预算（总量/字体/字体文件数/index.html/index.html gzip/主包 JS/文档演示 chunk/引导课程 chunk/SW/Worker/全部 JS 合计 gzip/主包 gzip，**14 项上限**；
  防「一次误 import 多背一兆字体」回归。index.html 上限 600 KB（外壳 100 KB / 内联文档 700 KB 分开算）、主包 JS 285 KB / gzip 108 KB（原线，实测 gzip 100 KB）、文档演示 chunk 24 KB、引导课程 chunk 16 KB（点「开始」才加载）、懒加载 Worker 64 KB、Service Worker 8 KB、全部 JS 合计 gzip 272 KB 各自单列，按实测内容走）
- `scripts/shot.mjs` = 开发用截图工具（`--width/--height/--el/--dofile/--json`，页面内脚本求值后截图）
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
| `core/sensor-pipeline.ts` | 传感器前端：一阶抗混叠带宽 + 采样率零阶保持（与解算率分离）+ 各传感器独立延迟；默认逐位透传 |
| `estimators/index.ts` | 五估计器统一 `Estimator` 接口：`update(gyro,accel,mag,dt)` + `reset(initial?)`（initial 缺省=水平；传非单位姿态即「初始姿态偏差」演示）+ `magEnabled` + `telemetry`（rate/rawGyro/correction/predictedGravity/measuredGravity/accelNorm/accelValid/magValid/detail）。Mahony MARG：磁误差 z 分量并入；Madgwick：独立偏航方向分量；互补：`tiltCompensatedYaw`；**KalmanEstimator**：ES-EKF/MEKF（6 维误差状态 [δθ,δb]，重力+磁场观测，40° 新息门控，可估计陀螺仪零偏，参数 Q=gyroNoiseDps / R=obsNoise）。**启动增益 ramp**：互补/Mahony/Madgwick 共用 rampK()——reset 后 2.5s 内修正增益从 6 倍线性衰减（Fusion 同款，只放比例/梯度项），`rampEnabled` 公开供自检 A/B。**加速度计观测门控 accelGate**（同三家）：幅度（‖a‖ 偏 g 超 35%）+ 方向（与预测夹角超 `ACCEL_GATE_DEG=20°`）双层拒绝，ramp 期间关闭（Fusion 语义），被拒帧退化纯积分 |
| `scene/setup.ts` | 渲染器/相机/灯光/地面/网格/罗盘/主四轴+幻影/万向环架；`toDisplay`、`setView`、`syncVisibility`；玻璃盒双箭头 + 磁航向箭头 + 等效旋转轴箭头 `axisArrow`（青色，`#axis-toggle` 控制） |
| `core/serial.ts` | 真实 IMU 串口帧解析（纯函数）：CRC8/粘包重同步/安装方向重排/`buildFrame` 测试往返；**`frameDtSec` 用固件 tick 差算真实积分步长**（u32 回绕/空洞/1–50 ms 夹紧）；帧协议见 `firmware/gy87.h` 与新增 `firmware/README.md` |
| `core/magcal.ts` | 磁力计校准纯数学：代数球面拟合（4×4 高斯消元）→ 硬铁球心 + 各轴半极差软铁缩放 + 残差；最少 12 点、三轴覆盖检查；`applyMagCalibration` |
| `core/accelcal.ts` | 加速度计六面校准：逐输出轴 4 参数最小二乘 → 3×3 刻度/交叉轴矩阵 M + 偏置 b + 各轴残差；朝向不足返回 null；`applyAccelCalibration` |
| `core/attitude-determination.ts` | 单帧姿态确定：TRIAD、Wahba 代价、Davenport/QUEST（K 矩阵 + 谱平移幂迭代，避免 ±特征值同模不收敛）、合成观测与共线退化判定 |
| `core/coning.ts` | 圆锥效应解析数值实验（正交双轴同频振荡 vs 20 kHz 参考）与采样混叠折回频率 |
| `core/experiment-config.ts` | 版本化 `ExperimentConfig`：默认值/校验/旧档案迁移/由 seed 生成初始姿态；UI、实验库、深链、档案、benchmark 的唯一数值来源 |
| `core/runner.ts` | **无 DOM 运行内核（唯一调度）**：`runExperiment`/`runExperimentDetailed` 都走同一个 `runCore`，批量/文档基准/离线复算共用；含**静止粗对准状态机**（`CoarseAlignGate`，|ω|<3°/s 持续 3 s、偏差 >8°、冷却 5 s，配置 `autoCoarseAlign` 可关）、稳态窗口（`steadyFromSec` 绝对起点，缺省末段 40%）、`so3ErrorSplit`（绕重力轴偏航 / 垂直方向倾角的小角分解，欧拉分解留作对照）；输出 RMSE P50/P95、SO(3) 倾角/偏航 P95、门控拒绝、NIS/NEES |
| `core/solve-loop.ts` | **解算调度与静止粗对准（UI 与 runner/Worker 的唯一实现）**：按解算率抽帧（排程保留余量 → 长期平均频率等于所选值；dt 是真实经过时间，Σdt 恒等于总时长）、真实/回放路径的 `applyFrame` 子步、三路校准链注入、A/B 同步重置、3 s/8°/5 s 粗对准状态机 |
| `core/replay-player.ts` | 回放播放调度（纯逻辑）：按录制时间 × 倍速消费帧、逐帧真实 dt、倍速 0 的单拍上限、空洞/回退时间夹紧 |
| `core/serial-queue.ts` | 有界帧队列：超限丢最旧并回报（串口二进制与 MAVLink 两个入口共用一份策略） |
| `core/reconnect.ts` | 断线重连退避状态机：1s/2s/4s、次数上限、成功后清零、主动断开取消；串口与 BLE 各一份实例 |
| `core/calib-meta.ts` | 校准**器件指纹**与失效提示：记录拟合时的交叉轴/非线性/噪声/拟合模型，参数变化时返回「标定基于旧模型」（随档案往返） |
| `core/data-source.ts` | 数据源（simulation/serial/ble/replay）与误差参考（groundTruth/mahony/external/none）显式类型，替代单一 `state.real` 布尔语义 |
| `core/experiment-archive.ts` | 实验档案的**纯逻辑**：`buildArchive` / `parseArchive`（格式+迁移+校验，坏档案明确报错）/ `describeArchiveRun`。main.ts 只负责读控件与写控件 |
| `core/batch-protocol.ts` | 批量评测的 Worker 消息协议（纯类型）：主线程生成种子序列传进去，Worker 只回传每次运行的指标 |
| `workers/batch.worker.ts` | 批量评测 Worker（懒加载 37 KB）：与主线程共用 `runExperiment`，主线程只更新进度；失败/超时自动回退主线程分片路径 |
| `core/replay.ts` | IMU 日志导入（纯函数）：引号 CSV/宽容列名/单位与时间轴推断、坏样本整行拒绝、`truth_q*` 外部真值、**`# imu=raw|calibrated` 元数据**（声明列语义，回放据此决定是否补校准） |
| `core/sensor-pipeline.ts`（续） | 采样率降到 500 Hz 以下时，白噪声 σ 按 √(fs/500) 换算（`world.ts:noiseScaledParams`），让「降采样」不再凭空放大噪声幅度 |
| `core/stats.ts` | `ErrorTracker`：均值/RMSE/峰值/收敛时刻（连续低于阈值 hold 秒），曲线与评测表同源 |
| `firmware/` | STM32F4 + GY-87 固件参考：`gy87.h` 帧规格表 + **`README.md` 协议/接线/组帧 CRC 参考/排障表**（用户自行实现并已验证） |
| `scene/quad.ts` | `buildQuad(ghost, {axes})` 程序化四轴（PBR 质感版）：RoundedBox 亮漆机身+云台球+锥形机臂+电机铃+前后航行灯（前青后红）+桨叶与半透明桨盘；ghost=EdgesGeometry 轮廓线；桨尖径向包络 ≤0.68（scenecheck 穿模断言守护） |
| `scene/gimbal.ts` | 平衡环架（重做）：环带 + 连接轴轴承 + 三根轴向虚线 + 轴端标签 + 载荷组（四轴+机体轴箭头）+ 底座刻度环；`setAngles` 立即 / `setTargetAngles`+`step` 指数阻尼；死锁时环与轴变红 + 环心脉冲环；`parts.axles/axisLabels/payload` 供 scenecheck |
| `scene/quatview.ts` | 四元数视图（重做）：参考球+赤道环+极轴；Slerp 白 / 欧拉品红双 Tube 弧（r=0.012）+ 滑动 marker；起终点蓝/橙球；中央四轴 0.55 + 机头箭头 + 轴角青箭头；q/−q 并排组（X ±0.95）。`parts.slerpPoints/eulerPoints` 采样点数组供 scenecheck 断言。`SPHERE_RADIUS=0.85`。
  重做要点：经纬网格球 + 南北极标注、**偏差带**（三角条带，宽度=角距离）、球外两侧起点/终点线框四轴、
  marker 机头小锥、`setPair`（按姿态对缓存几何）/`setProgress`（每帧零分配，noseLine 就地写顶点）、
  `arcInfo()` 供面板读数、4D 模式 q 标签切向避让。**4D 立体投影模式**（`projGroup`）：S³ 从南极 (−1,0,0,0) 投影 p=(x,y,z)/(1+w)，赤道 w=0 恰为参考球；青点 q（球内）/品红 −q（球外，倒易 |p(q)|·|p(−q)|=1）/轨迹线/i-j-k 基架/中央姿态四轴；lastDir 方向延续防极点跳变。API：`setInterpolation/setNegation/showNegation/setProjection/showProjection`；parts 增 `projGroup/projQPos/projNegPos` |
| `scene/labels.ts` | `makeTextSprite(text, color, {size, bold, alwaysOnTop})` 通用文字标签 |
| `ui/mode.ts` | 视图策略（纯函数）+ `narrateGimbal`；**精简模式已删除** |
| `ui/chart.ts` | `RollingChart` 手绘 canvas 时序图；系列构造时固定；起点附近屏外刻度不再绘制。**定长 `Float64Array` 环形缓冲**（cap = 窗口×25 Hz + 8）：长跑不增长、无 GC 抖动，`size` getter 供长跑自检断言 |
| `ui/batch-table.ts` | 批量结果表与状态文案（纯函数）：7 列口径、SO(3) 倾角/偏航优先、把「稳态窗口/未收敛/执行路径」写在状态行 |
| `ui/calib-panel.ts` | 校准面板的文案与结果块（纯函数）：状态行 + 四个读数（拟合残差 / 验证残差 / 留一验证 / 独立验证）的构造与口径说明 |
| `ui/experiments.ts` | 实验库纯数据：**19 个**「参数快照 + 观察要点」（漂移/门控/振动/磁干扰/初始对准/闭环/卡尔曼调参/万向节锁/Slerp/4D 投影/锁的算法后果/穿越 ±90°/完整 MARG/门控滞回/量程饱和/群延迟/解算频率/**运动学一致剧本（恒定加速度）**/**协调转弯**）；也是引导课程的「现场来源」 |
| `ui/tour.ts` | **引导课程（13 步）**：纯数据 `TOUR_STEPS`（标题/正文/观察要点/实验 id/视图/面板/文档页/预计秒数）+ `mountTour(host)` 执行器。执行器**只驱动用户看得见的界面**（点实验按钮、点视图分段控件、点面板折叠标题），故不 import 主程序任何内部状态；文档步骤不自动打开文档层（模态会盖住「下一步」），只给一个按钮由用户自己开关 |
| `ui/doc-demos.ts` | **文档页八个交互演示**（互补三路实时对比 / 旋转顺序骰子 / 磁校准舞蹈 / Allan 方差 / 一维卡尔曼 / 互补频域 Bode / **Wahba-TRIAD 单帧姿态确定** / **圆锥效应与采样混叠**）。与主仿真解耦：宿主只注入一条上下文 `isVisible(page)`，动画演示由主循环调 `step(dt)`、翻页调 `refresh()`。**抽出的动机**：这 847 行原先埋在 main.ts 里，量出真实耦合只有「文档是否停在该页」一个外部量 |
| `ui/b64.ts` | UTF-8 base64url 深链编解码（独立可测，兼容旧链接） |
| `main.ts` | 装配层：模拟 500 Hz 定步长 + **真实串口帧队列回放（固件 tick dt）**、统一 `state.simTime`、滑块三件套、视图切换、磁航向/轴角箭头、受扰黏性提示、文档页开关 + 目录高亮、实验库/评测表/磁校准/CSV/深链/快捷键 |

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
- **时钟**：界面/曲线/统计/静止检测统一用 `state.simTime`（模拟模式 = `world.t`，真实模式按固件 tick 累加）。
  `world.t` 只用于剧本求值——**不要再用它做 UI 时间**（旧版真实模式因此冻结在 0）。
- **真实模式数据流**：串口帧先入 `serialState.queue`（上限 128、溢出丢最旧），主循环按 rAF 消费；
  每帧只更新一次估计器，dt = `frameDtSec(prevTick, tick)`；无帧不推进。模拟控件由
  `setSimControlsDisabled()` 置灰，`body[data-imu-mode="real"]` 负责视觉。
- **磁校准**：估计器吃 `magForEstimation(sample.mag)`；`state.lastImu` 保留原始读数供波形面板对照。
- **校准应用链（单向）**：`magForEstimation` / `accelForEstimation` 是唯一的校准入口。
  回放时若日志声明 `# imu=calibrated`（`replayState.applyCalibration=false`），两者**原样透传**——
  校准过的日志再校准一次会让「导出 → 回放」数值不闭环；界面上由「回放应用校准」勾选框控制，状态条显示 IMU 语义。
- **导出 IMU 列必须带语义**：`exportCsv` 默认写 `# imu=raw`（原始）、勾选「写成校准后」写 `# imu=calibrated`；
  全帧 `exportRawCsv` 恒为 raw（记录点在校准链之前）。加新的导出格式时必须同步这条元数据，否则回放会猜错。
- **CSV 是「源 IMU 日志」，不是 solve trace**（已知边界）：记录的是每个记录行时刻的**源**读数；
  解算频率低于记录频率时，同一次 solve 会被多行复用（`consumedSnapshotFor` 按 `runId` + 时间去重）。
  回放时按行时间**重新解算**，因此「消费序列」不逐位复现——需要逐位对齐请用 trace 契约
  （`traceFrames` / `traceFramesRunner` + `scripts/trace-contract.mjs`），不要拿 CSV 当 solve trace。
  这也是「导出不可变」只承诺字节不随当前标定变化、而不承诺消费时刻身份的原因。
- **配置档案只承诺「配置子集复现」**：`ExperimentArchive.restore = "config-only"` 保存 `ExperimentConfig`
  （含 `magModel`、`magCalibration{Applied}`、`accelCalibration{Applied}`、`seed`、`steadyFromSec`、`ab.mode`），
  不含当前曲线/原始记录/分叉状态。导入走 `migrateExperimentConfig`（校准对象用 `parseMagCalibration`/`parseAccelCalibration` 宽松解析，
  结构不完整返回 null 而不是半有效对象）→ `validateExperimentConfig`（模型与 `magCalibration.kind` 不一致直接报错）→ `applyArchiveConfig`。
- **「真值波形」来源单一**：`truthWaveforms()` 按 `currentReferenceKind()` 分支——模拟=世界真值；
  外部真值回放=日志 `truth_q*`（重力/磁场投影 + 相邻真值姿态差分角速度）；其余一律 NaN 不画。
  **绝不允许再出现「用 world 冒充日志真值」**（第四轮 P1 的根因）。
- **A/B 克隆只有一份来源**：`abState.frozenTuning` 由 `tuningOf(A)` 生成，B 组实例一律由
  `cloneFromTuning(id, frozen)`（内部调 runner 的 `applyTuning`）构造；不要再手写字段拷贝——历史上 `kalmanResetCov` 就是这样漏掉的。
- **实验/挑战基线会关闭 A/B**：`resetExperimentBaseline()` 把 `ab-toggle` 复位；装载时若原先是开的，
  必须在提示里写明「本次已关闭 A/B」，否则「参数对比中」的实验语义含混。
- **解算调度只有一份**：任何「什么时候更新估计器 / 什么时候粗对准」的逻辑都必须写在 `core/solve-loop.ts`，
  界面（`stepSim`）与 runner（`runCore`）都只能用 `SolveLoop.step/applyFrame`。
  冒烟里有同 seed **逐步**比对（2000 步、时间与姿态都对齐）守着
  （历史教训：两边曾把粗对准放在解算的不同侧，差一帧遥测；只比终点无法发现中途偏差）。
- **抽帧的两个量必须分开**：`solveAcc` 排程（减周期、保留余量，否则 200 Hz 实跑成 166.7 Hz），
  `tSinceSolve` 给 dt（否则余量被重复计入，Σdt 会大于总时长）。自检里有 `Σdt == 时长` 不变量。
- **有界统计**：`MetricAccumulator` 逐点保存前 `STATS_CAP=60000` 个样本（短跑分位数用它，精确）；
  超出后分位数改用**定长蓄水池**（Algorithm R，容量 20000，seed 派生 RNG）——等概率抽样，
  **没有固定相位**，因此不会像「每 0.1 s 取一个样本」那样混叠周期信号（10 Hz 误差 P95 实测与精确值一致）。
  均值/均方/峰值走增量累加，长跑同样精确；稳态窗口用**预定切点**（按配置 durationSec 算出的 40% 点）
  逐样本精确累计，不做整桶比例折算。指标里的 `percentileApprox` / `steadyMode` 说明当前口径。
- **传感器通道时间戳**：`SensorPipeline` 在处理路径上给输出加 `times.{gyro,accel,mag}`（各通道自己的采样时刻）。
  透传快路径**不加**该字段（保持逐位一致契约）；非整数延迟用相邻两帧线性插值（整数延迟仍取历史帧）。
- **批量评测两条路径**：界面走 Web Worker（懒加载 chunk，不计入首屏预算，但有独立上限），
  失败/超时回退主线程分片；两条路径共用 `runExperiment` 与 `summarizeRuns`/`summarizeMetricsLists`，结果口径一致。
  调试出口 `attitudeDemo.experiment.batchMode()` 可确认本次走的是哪条。
- **断线自动重连**：串口与 BLE 共用开关 `#serial-autoreconnect`（默认开），异常断开按 1s/2s/4s 退避最多 3 次；
  **用户主动断开不重连**（`cancelSerialReconnect` + 清掉 `lastPort`/`lastDevice`）。重连成功计数经 `plumbing().reconnects` 暴露给自动化。
- **计数不能靠人记**：`npm run statuscheck` 从源码里数（实验库组数、文档演示画布数、自检/冒烟用例数、文档分页数、
  四类子检查项数、预算项数），与 current 区域顶部的 counts / verify 声明逐项比对，不一致即失败
  （正文里**不要**再原样写出 counts 注释的写法，否则会被当成第二份声明）。新增功能后**先跑它**再改文档。
- **噪声口径**：`gyroNoiseDps`/`accelNoise`/`magNoise` 是 **500 Hz 基准下的每样本 σ**（等价噪声密度）。
  改动这些语义时要同时改 `world.ts:noiseScaledParams` 与文档措辞，不要两套口径混用。
- **统计指标口径**：批量表的「倾角/偏航 P95」是 SO(3) 小角分解（`so3ErrorSplit`，世界系按重力方向拆），
  不受万向节锁影响；欧拉分解（`tiltRmse`/`yawRmse`）只作为对照保留在 `EstimatorRunMetrics` 里。
- **图例**：统一由 `buildLegend` 生成 `<button aria-pressed>`；IMU 图例按页签重建（`rebuildImuLegend`），
  可见性 = 页签掩码 ∧ 用户选择。
- **曲线折叠**：`chartState` + `layoutCharts()` 单一状态源；布局靠 flex（展开块 `flex:1 1 420px`、
  折叠块 `order:9; flex-basis:100%`），**不要再写死 grid-template-areas**（旧版就是它造成空洞）。
- **面板手风琴**：`.panel-section > .panel-head > .panel-toggle` + `.panel-body`；折叠=`.collapsed`；
  摘要由 `updatePanelSummaries()` 在 2 Hz 块里刷新，`#sum-{key}`。
- **动画 vs 物理时间**：`dt`（≤50 ms）给仿真，`dtAnim`（≤250 ms）给演示/播放/相机过渡。
- **快捷键守卫**：input/select/textarea 全让位；button/a 只让位空格。
- **字体**：`src/fonts.css` 指向 `public/fonts/*.woff2`（自托管子集），不再有 Google Fonts 外链。
- **SW**：`public/sw.js` 导航 network-first、`/assets/` 与 `/fonts/` cache-first；改策略先改 `CACHE` 版本。
- **术语**：界面与文档一律用全称「陀螺仪」「加速度计」，不用「陀螺」「加计」简称（用户明确要求）。
- **内嵌画布尺寸**：面板内的 canvas 一律走 `fitInsetCanvas(c, aspect, fallbackW)`（按 CSS 宽度 × DPR 写回位图 + 预缩放 ctx），
  **不要**只写 `width:100%` 的 CSS 而让位图停在内联属性尺寸上——历史事故：`.panel canvas#proj-section` 从不命中（右侧栏没有 .panel 类），
  画布按 520px 属性渲染并在 339px 面板里横向溢出。给 canvas 写 CSS 前先确认选择器**真的命中**。
- **文档演示控件**：文档页内的滑块**故意不带 id**（只带 `data-dock` + `aria-label`），因此不进主滑杆系统、不进深链，
  也不会被 htmlcheck 的「滑块三件套」规则要求配 data-num/data-step。绘制一律「控件变化才重绘」，不要挂进主循环。
- **观测门控**：`gateDeg`/`gateMagPct` 是实例字段（面板滑块实时改）；`gateRecovery` **默认 false**——
  滞回恢复窗会把持续线加速度的污染放进来，与「方向门控救场」实验冲突。不要在没想清楚默认值语义前打开它。
- **磁修正形态**：Mahony/Madgwick 的 `magMode` 默认 `"yaw"`（简化版）。`"full"` 的参考场必须写成世界向量 `(bx, 0, bz)`，
  写成 `(0, bx, bz)` 会把修正推错轴（静态就偏 22°）。改梯度公式后**必须**用有限差分校验（见本轮自检记录）。
- **qToEuler 锁点约定**：`|sin pitch| ≥ 1−1e-12` 时返回 `roll := 0`、信息归入 yaw。这是约定不是精度问题；
  任何依赖「横滚读数」的逻辑在 ±90° 附近都要重新想清楚。
- **文档模块登记**：新增文档页只需在 `main.ts` 的 `DOC_MODULE_OF` 里登记 + 左栏加 `module-link` + 加 `<article data-doc-page>`；
  搜索索引与「本页目录」会自动覆盖（索引按 `.doc-page` 遍历）。
- **数据源三态**：`state.real` 对「真实串口」与「离线回放」都为 true（共用无真值语义）；
  需要区分时用 `dataSourceLabel()`（模拟 / 真实 IMU / 离线回放）。**串口与回放互斥**，
  连接串口成功即退出回放（`stepReplayPlayback` 在帧循环里优先）。
- **回放时钟**：回放按日志时间戳推进 `state.simTime`，**不按墙钟**；每帧用它自身的 dt 调 `updateEstimators`。
- **串口三协议**：`serialProtocol()` 决定分流（`serialDrainBinary/Text/Mavlink`），三者共用 `serialPushFrame`
  入队。**seq 必须用本机自增**（文本无序号、MAVLink 的 seq 含被跳过的消息）。新增协议时：core 里写纯函数解析器 + 自检，
  main.ts 里只做分流，并保证「帧不完整 → consumed 0（等更多字节）、垃圾 → 只跳一段（由调用方循环）」这两条契约。
- **MAVLink 常量必须可推导**：`crc_extra` 由 `computeCrcExtra` + 字段表推导，自检重新推导并断言；
  不要从别处抄一个数字进来——写错的表现是「一帧都收不到」，极难排查。
- **挑战阈值先量后定**：改任何默认参数或场景，都要重跑探针量出「默认 / 调好」两侧的 RMSE，
  再把阈值放在中间留 ~10% 余量（随机种子非固定）。
- **数据到达的判据要看数据**：等「时钟推进」会被 `resetSim()` 清零的时钟骗过；等状态行的帧率或直接读 `lastImu`。
- **BLE 也不要写死猜来的 UUID**：服务 UUID 用已核实的四组 + 自定义输入；特征靠 `properties.notify` 发现。
  默认 ATT MTU 23 → 通知 ≤20 字节，长帧必然分片（流式解析器负责重组，冒烟有用例守）。
- **导出列名即导入契约**：`IMU_EXPORT_COLUMNS`（gyro_x_dps / accel_x_ms2 / mag_x_ut）与 `core/replay.ts` 的识别规则
  是一对，改一边必须改另一边——冒烟里有一条「导出→导入闭环」用例专门守它。
- **禁止用 `includes` 做数据列名的宽容匹配**：`accel_x_ms2` 含 `_ms`，被误判成时间列（已踩）。时间名要整体匹配。
- **`setSimControlsDisabled` 的白名单**：`serial-mounting` / `replay-speed` / `replay-file` 必须在真实模式下保持可用
  （禁用元素的 `click()` 会静默失效）。新增「无模拟也要能用」的控件时记得加进去。
- **记录窗口**：`logRows` 上限 `LOG_ROW_CAP = 850` 行（25 Hz ≈ 34 s），超出裁掉最早的 `LOG_ROW_TRIM = 100` 行；
  导出弹窗会据此提示用户。
- **加计符号与惯导编排**：本装置加计输出是「重力投影」ã = Rᵀ·(0,0,+g)，不是标准比力 f = a − g（差一个符号）。
  导航方程因此是 `a_ned = −R(q̂)·ã + (0,0,+g)`，改 `ins.ts` 前先看文件头的推导。
- **往文档里插内容的两条铁律**（CI 现在会查）：`.ctl` 手册条目必须在 `.doc-page` 内；
  `.doc-pages` 的直接子元素只能是 `.doc-page`。插完先跑 `npm run htmlcheck`，别只靠肉眼看。
- **插入锚点要唯一且带上下文**：本项目里「导入 IMU 日志回放」同时出现在面板与文档中，
  按文本搜第一个出现位置会插错地方——用「离分页边界最近的唯一锚」或用行号校验。
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

## 已完成里程碑（历史细节见 [`CHANGELOG.md`](CHANGELOG.md)）

| 轮次 | 一句话 | 细节 |
| --- | --- | --- |
| 2026-11-02 满分质量整改轮 | P1-1…P1-6 与 P2-1…P2-4 全部修复并各带永久反例：时间回退不重复积分、外部真值逐子步插值、档案导入原子化、`ratio:null` 可渲染、close 失败后台重试、setup/open/close 有界、稳态窗口与粗对准进活状态、canonical form、内核频率分层、上限参数校验 | [任务书第 9 节](QUALITY-FULL-SCORE-PLAN-2026-11-02.md#9-整改执行记录与复核证据2026-11-02-实施轮) |
| 2026-10-31 质量复核修正轮 | SO(3) 世界系、独立验证不重叠、当前器件验证、BLE 重连特征、计数口径同步 | [ROUND5](QUALITY-REVIEW-2026-10-31-ROUND5.md) |
| 2026-10-31 闭环一致性轮 | 档案校准往返、导出/回放 IMU 语义、日志真值波形、唯一 runCore + 静止粗对准、SO(3) 指标、采样噪声换算、Worker 批量、断线重连、计数校验 | [CHANGELOG](CHANGELOG.md#2026-10-31--闭环一致性轮第五轮) |
| 2026-10-30 可复现与结论可信轮 | P0 教材事实校正；确定性配置/种子/独立随机流；runner 与批量评测；实验档案与 benchmark/doccheck；单步与共享游标；NIS/NEES 与 χ² 门控 | [CHANGELOG](CHANGELOG.md#历史里程碑2026-10-25--2026-10-30) |
| 2026-10-28 文档条理与可读性轮 | README 双语、每页"读完能回答什么"、19 章索引、14 分页可寻址、预算拆外壳/文档 | 同上 |
| 2026-10-28 测试盲区审计轮 | 覆盖度测量 + 对抗输入 + mock 忠实性，修掉 14 类真问题（含"从不生效的实验"） | 同上 |
| 2026-10-28 磁力计校准轮 | 应用内校准页、球拟合 + 对角软铁、硬铁/干扰/量化模拟、面板判据 | 同上 |
| 2026-10-28 引导课程轮 | 13 步引导课程（只驱动可见界面）+ 结构化收尾 | 同上 |
| 2026-10-28 BLE 接入轮 | Web Bluetooth 接入（服务/特征枚举、分片重组、与串口互斥） | 同上 |
| 2026-10-26 ~ 10-28 交互/惯性导航/硬件闭环轮 | 交互重做、3D 模型、INS 面板、文本行与 MAVLink 协议、数据闭环 | 同上 |
| 2026-10-25 奠基与上线 | 3D 可视化 + 模拟 IMU + 四算法 + 万向环架 + 文档页 + 部署上线 | 同上 |

## 验证体系

- `npx tsc --noEmit` → `npm run check`（125 数值 + 10 几何 + 15 HTML 契约 + 4 文档基准 + 契约脚本 + 计数与门禁清单核对，全部通过）
  → `npm run build` → `npm run budget`（14 项上限，含文档演示 / 引导课程 chunk / SW / Worker / 全部 JS gzip 合计）
  → `npm run smoke`（91 项浏览器端到端，需 preview）→ `npm run soak`（长稳，单独跑）
  → `npm run benchmark`（手动复算文档基准）/ `npm run doccheck --recompute`（全量只读复算）
- 冒烟里有三条「守机制而不是守功能」的用例，值钱的地方在于它们抓的是**会悄悄坏掉**的东西：
  · **文档页八个演示必须真的在动**：三次采样画布、比对降采样指纹。重绘点只有 `docDemos.step(dt)`，
    所以「指纹变了」等价于「主循环 → 模块的步进链路是通的」。判「画过了」用的是**非白像素占比 < 一半**
    而不是「非白像素 > X」——canvas 从未绘制时 `getImageData` 返回全零（透明黑），反而每个采样点都算「有内容」（踩过）。
  · **全站对比度 WCAG AA**：遍历「有自己的文字且可见」的元素，背景按祖先链 alpha 合成（多数文字的背景来自祖先，
    只看元素自己的 background-color 会算出假的高对比度）。禁用控件按 WCAG 豁免。
  · **长跑稳定性**：15 s 自然跑 + 灌 40 s 仿真时间（走离线回放「最快」档，单帧最多消费 4000 样本）后，
    断言四个滚动容器仍封顶。**只跑 15 s 是不够的**：记录缓冲要 34 s 才到 850 行，不给足时间就证明不了裁剪在跑。
- 浏览器端到端之前用 `scripts/shot.mjs` 做多分辨率溢出审计（`--dofile` 传页面内脚本，返回溢出清单）
- 交互/教学类改动先用**一次性探针脚本**量出数字（本轮的量级表都来自探针），再写进文档与自检；探针用完即删
- `selftest` 覆盖：欧拉↔四元数往返、无零偏不漂、零偏线性漂移、抗扰、动态跟踪、剧本切换、
  万向环链条≡主视图、死锁判定、演示全相位、锁定态等价、磁力计（含参数全零守护）、
  轴角双覆盖（qToAxisAngle 对 q 与 −q 恒等）、欧拉插值端点与区分度
- `htmlcheck`（parse5）校验：id 唯一、JS `$()/getElementById` 引用全部存在、25 个滑块三件套齐全、
  canvas 全有 aria-label、文档锚点/折叠按钮/实验库引用的控件与选项全部命中
- `scenecheck` 校验：内环姿态≡toDisplay（3.9e-16）、环面含自转轴、枢轴销连通、间隙不穿模、
  四轴不穿出内环、死锁轴重合、轴/环标签、四元数视图弧线端点与采样点数组、q/−q 恒等
- UI 改动后浏览器截图确认 + 控制台零错误

## 待办

- ~~候选增强（A/B 对比、闭环控制、Allan 方差、深链+PWA）~~ 全部完成（待办清零轮）
- ~~长线大件（Squad、叙事钩子+沙盒、S³ 剖面三段式、静止检测、新误差滑块）~~ 全部完成（待办清零轮）
- **安全**：Cloudflare API token 曾在对话中暴露（已写入 GitHub 加密 secrets，未入代码库），
  **用户仍未确认轮换，需再次提醒**
- **文档体积的长期对策**（本轮 index.html 触到 460 KB 上限、已按实测抬到 500 KB）：全部文档内联是产品价值
  （离线单页 + 全文搜索 + 打印），但这条线不能无限抬。再涨 1–2 轮应拆成**按需加载的 chunk**——
  代价是全文搜索（现在遍历 DOM）与打印（依赖一次性就绪）都要改，所以前两轮选择了抬上限并记录原因。
- ~~远期可选：Web Serial 接真实 IMU、guided tour 课程剧本、参数整定小游戏、误差分解视图~~ **四项全部落地**（Web Serial→串口三协议轮、引导课程→本轮的 `ui/tour.ts`、小游戏→参数整定挑战轮、误差分解→玻璃盒轮）

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

- **绝对不要把 `io.open(...)` 写进表达式**：本项目两次把源文件截断成 0 字节都是这个原因——
  `io.open(P, "w", newline=io.open(...))` 里 `newline=` 的参数**先被求值**，等于先清空文件再抛异常。
  批量改动一律写成**独立的补丁脚本文件**（`node scripts/_patchN.mjs` / `python 补丁.py`），
  且每处替换都断言唯一匹配、任何一处不匹配就整体不写盘。
- **比现实宽容的 mock 会藏 bug**：冒烟里的假 BLE 特征原来只存最后一个回调（`notifyCb = cb`），
  而真实 `EventTarget` 是累积的——于是「重复订阅叠加监听器、同一帧被消费多次」这个真缺陷
  在整个假设备上**不可能被发现**。写 mock 时先问一句「它比真实环境宽容在哪」，那正是盲区。
- **文档里的数字必须带窗口**：同一个「峰值误差」在 5 s / 15 s / 30 s 窗口下是 24° / 48° / 95°。
  本轮就因为两处引用不同窗口（161° 与 180°、0.03° 与 0.1°）而看起来互相矛盾。
  写数字时一律写清「什么现场、多长时间、什么参数」，并把该现场做成自检用例。
- **「区域替换」注入代码要防止吞掉相邻内容**：用「从 A 到 B 之间整段替换」的方式插代码时，
  如果 B 的锚点出现在别处，替换区间可能把已有内容一起删掉（本轮把一条 43 项的用例吞成 42 项才发现）。
  批量改动用**补丁脚本 + 每处 `split(from).length === 1` 断言**，任何一处不匹配就整体不写盘。
- **浅色主题的子层必须自己声明 `color-scheme`**：`<meta name="color-scheme" content="dark">` 是全局默认，
  浏览器 UA 样式表会据此决定**链接色、滚动条、表单控件**的默认外观。文档层（浅色）没覆盖它 →
  所有文档链接被渲染成暗色方案的浅紫 `rgb(158,158,255)`，在浅底上只有 2.1–2.4:1（远低于 AA）。
  教训有两条：① 双主题页面里，主题边界要连 `color-scheme` 一起声明，不能只换变量；
  ② **可访问性扫描必须覆盖全部页面**——只扫两页时这个缺陷藏了整整一轮（那两页恰好没有普通链接）。
- 批量改 DOM 时务必全量回归滑块（历史事故：`<output>` 被删导致绑定中断）。
- index.html 大改后注意标签闭合：Vite build 的 HTML parser 会拦截坏标签（如 `</sub‖` 漏 `>` 直接 build 失败），
  但**闭合错位不会报错**（曾产生游离孤儿节点）——改完 grep 校验结构。
- 内嵌四轴 scale > 1.3 会穿出内环（scenecheck 断言拦截，实测 1.15 时间隙 0.086）。
- 测试环境 rAF 会间歇停摆：截图可能超时或 3D 区黑屏，此时以 `scenecheck` 的几何断言替代视觉验证。
- `vite preview` 服务的是 `dist/`，改源码不重新构建就不会生效；4173 被旧进程占用时会自动换 4174，
  浏览器测试以实际输出端口为准。
- GitHub 直连间歇性中断：push 失败多重试或稍后再推。
- **测试环境 IAB 后台标签页 `document.hidden=true` 时 rAF 停摆**：仿真/曲线/时钟全部冻结（页面本身正常，
  用户切到前台即恢复）。浏览器验收优先用前台标签或 Node 侧 scenecheck/selftest 补位；不要误判为代码 bug。
- **定期刷新类 UI 不要用「帧 dt 累加」**：它们只在 10 Hz UI 块里收到一帧 dt，累计速度慢 6 倍；
  用墙钟（`now - lastAt >= 500`）驱动评测表/校准面板刷新。
- **字体子集**：`src/fonts.css` 的 13 个文件由 Google Fonts CSS 生成；改动字体族/字重时重新生成并保持
  `unicode-range`，否则中文会整段回退（可接受）或希腊字母失效（不可接受）。
- **溢出审计里有两类良性命中**，别去追：①窄屏（≤1280px）右栏「本页目录」变成横向滚动条，
  其中的 `<a>` 天然超出视口；②`.formula` 内的 CSS 矩阵在 390px 下略宽于内容列，
  已用 `overflow-x: auto` 改成块内横滚。审计脚本应把 `.docs-chapter-toc`、`.formula` 视作滚动祖先排除。
- **文档内容插入位置**：`index.html` 里同一段文字可能同时出现在面板与文档（例如「导入 IMU 日志回放」），
  按文本找第一个出现位置会插错地方。插入后**必须**跑 `npm run htmlcheck`——它现在有两条结构性契约
  （`.ctl` 位于文档页内、`.doc-pages` 直接子元素全是分页），本轮两条都当场抓出了我插错的内容。
- **SW 更新**：导航 network-first 才能保证部署后一次刷新生效；若改成 cache-first 必须同步提升 CACHE 版本。


> **本文件是项目的恢复锚点。** 会话上下文被压缩后，从这里可以快速接续全部关键信息。
<!-- current:end -->

<!-- history:begin 历史里程碑（不参与当前计数/口径校验） -->
> 最后更新：2026-10-31（**闭环一致性轮**：第四轮质量复核指出的四条 P1 全部落地——
> ① 配置档案不再丢校准（校准对象/模型/「是否应用」三者一起往返，迁移与校验补 `parseMagCalibration`/`parseAccelCalibration`）；
> ② 导出 IMU 列显式声明语义 `# imu=raw|calibrated`，回放据此决定是否补校准（默认 raw → 补校准；calibrated → 自动关闭，禁止二次校准），
> 回放面板新增「回放应用校准」开关并在状态条显示 IMU 语义；
> ③ 外部真值回放的「真值波形」改用日志真值（重力/磁场投影 + 相邻真值姿态差分角速度），不再拿模拟 world 冒充日志真值；
> ④ runner 与界面同语义：抽出唯一运行内核、补静止粗对准状态机（`autoCoarseAlign`，可用配置关）、稳态窗口可指定绝对起点 `steadyFromSec`；
> 另：冻结配置改为 A/B 克隆的唯一来源（`applyTuning` 装配）、采样率下噪声按 √(fs/500) 换算、倾角/偏航改用 SO(3) 小角分解（欧拉分解留作对照）。
> 第五轮复核修正 SO(3) 的**世界系**约定、校准验证集重叠与加计验证硬编码模型；第六轮（可验证性轮）再做四件事：
> ① **统一仿真调度** `core/solve-loop.ts`——界面与 runner/Worker 共用同一份「抽帧 + 静止粗对准」，
> 冒烟同 seed **逐步比较 2000 步**（时间差 0、最大单步姿态差 5.12e-6°，即双精度舍入级）；期间发现并修复两处真问题：
> 对准检查顺序两边差一帧、抽帧把余量重复计入 dt（12 s 仿真积出 13.2 s 角增量）；
> ② 有界统计的**稳态窗口改时间分桶**（长跑不再依赖按序号抽样的蓄水池）+「截断不改变数值口径」断言；
> ③ Worker 协议补 **jobId/取消/心跳/停滞看门狗**（30×30 档可取消，取消后状态完全恢复）；
> ④ 校准**器件指纹与失效提示**（改了交叉轴/拟合模型就提示"标定基于旧模型"）+ `npm run soak` 长稳脚本。
> **剩余重点**（见 `QUALITY-REVIEW-2026-10-31-ROUND5.md`）：真机长时间验收、校准跨时段独立验证、数据源/回放调度继续模块化。
> **当前验证口径以脚本实际输出为准**：数值自检 124 + 场景几何 10 + HTML 契约 15 + 文档基准 4 +
> 浏览器冒烟 88（`npm run statuscheck` 会把这些计数与源码实测值对齐，数字过期即失败）；`npm run check` / `npm run smoke` / `npm run budget` / `npm run benchmark` / `npm run doccheck`）
>
> 2026-10-30（**可复现与结论可信轮**：P0 教材事实校正（Wahba 方向/Joseph/互补 α/Madgwick
> 稳态公式/随机游走增长律/INS 垂直通道边界/可观性分层/游离章节归位）；新增版本化实验配置、种子化
> 独立随机流、完整实验基线、same-start A/B、无 DOM runner、多种子批量评测、实验档案 JSON、
> benchmark/doccheck、单步与三图共享游标、卡尔曼 NIS/NEES 与 χ² 门控、回放有效性/外部真值/时间完整性、
> TRIAD/Wahba 与圆锥-混叠演示、加速度计六面校准核心；数学原理拆为「主线推导」与「专题与直觉」两页。
> **当前验证口径以脚本实际输出为准**：数值自检 87 + 场景几何 10 + HTML 契约 15 + 文档基准 1 +
> 浏览器冒烟 55；`npm run check` / `npm run smoke` / `npm run budget` / `npm run benchmark` / `npm run doccheck`）
>
> 2026-10-28（**文档条理与可读性轮**：README 双语（+`README.en.md`）；
> **每个文档页补「读完这一页你应该能回答」**、数学原理补 19 章索引与章末小结 + 公式汇总、
> 滤波算法讲解补小结；14 个分页全部可寻址；产物预算拆成「外壳 59 KB 硬上限 / 内联文档宽松上限」共 9 项。
> （当轮计数：静态自检 105 + 冒烟 51）上一轮（测试盲区审计）见里程碑）
>
> 2026-10-28（**测试盲区审计轮**：用户要求「查找问题、我要完美的项目」。这轮不重复跑已有测试，
> 而是系统性打它们的盲区——覆盖度测量（c8）、对抗性输入扫描、mock 忠实性、文档数字复核。
> 查出并修掉 **14 类真问题**（详见下面里程碑），其中三条最值钱：实验库的「门控滞回」实验**从来不触发它要演示的机制**、
> 「陀螺刻度/失准/群延迟」四个文档功能**零测试覆盖**（文档却写着「自检实测」）、
> 假 BLE mock 比真实 EventTarget 宽容，掩盖了监听器泄漏；
> （当轮计数：数值自检 80 + 场景几何 10 + HTML 契约 14 + 冒烟 50 + 产物预算 7）

<!-- history:end -->

<!-- history:begin 早期里程碑（不参与当前计数/口径校验） -->

> **最新一轮：2026-11-01「按 ROUND12 的 S0–S3 修复」已实施**（详见 [`CHANGELOG.md`](CHANGELOG.md) 顶部）。
> 门禁（严格顺序）：`npx tsc --noEmit` → `npm run check`（**161 PASS / 0 FAIL**）→ `npm run build` →
> `npm run budget`（**13 项**）→ `npx tsx scripts/doccheck.ts --recompute` → `npm run smoke`（**88 PASS / 0 FAIL**）全绿。
> **S1 真正分拍**：`SolveLoop` 改为 FIFO 待积分队列（单拍 ≤maxSubsteps 个子步、每步 ≤50 ms，
> 余量由后续拍继续补，`pendingSec` 可读）；回放侧 `replayBacklog` 每拍 ≤5 s，
> **播放器到底且队列排空**才宣告完成，状态行显示「待积分 x.x s」；消费快照带 `runId`，换轮即作废。
> **S2 连接事务**：系统拔线走 `cancel→释放读锁→close`、close 失败不 open、BLE 异常按归属释放、
> 过期订阅不再退订已提交的新订阅、订阅失败回滚且拒绝可见、重连成功恢复掉线监听。
> **S3 递归 strict**：嵌套字段/枚举类型校验 + 当前 schema 必需字段；磁 full 必须带 matrix 且对称正定；
> 加计按结构验（不套用 SPD）；偏置/残差门槛与拟合一致；count/faces 下限；不再静默过滤非法 face。
> **S0 预算回到原线**：文档演示改按需 chunk，首屏 **270.3 KB / gzip 102.1 KB**（原线 285/108 以内），
> 新增「全部 JS 合计 gzip ≤272 KB」硬线，按需 chunk/Worker/SW/three 一并封顶。
> **S4 门禁自身也已落地**：trace 比较器现在核**固定 schedule/算法身份/双侧 dt/raw/consumed 一致性/对齐事件**
> （11 种畸形输入必须失败，新增 dt 不一致、缺输入、对齐标记不一致、帧数不足）；doccheck 默认就做
> **小基准只读复算**（圆锥/Wahba/六面加计），正文数字块按**记录里的实际时长/种子数/样本量**渲染，
> 当前与历史声明使用独立机器区域；长稳按真实消费事件验证每段恢复。
> **堆缺测即失败**（可用 `--allowNoHeap` 显式跳过）、批量必须声明**期望种子数**；
> 加计采面新增**时间加权密度**（10 段每段 ≥2 样本，专拦"短簇+稀疏补点"）。
> **仍未做**：600 s 软件长稳、串口/BLE 各 30 min 真机、可判读图像的桌面/窄屏/文档/打印视觉验收。
> 上一轮复核报告 [`QUALITY-REVIEW-2026-11-01-ROUND12.md`](QUALITY-REVIEW-2026-11-01-ROUND12.md) 列出了本轮的原始反例与验收标准。

> **第十一轮历史实施：[`QUALITY-REVIEW-2026-11-01-ROUND11.md`](QUALITY-REVIEW-2026-11-01-ROUND11.md)（当前未完成项以ROUND12为准）。**
> 2026-11-01 第十一轮按 ROUND11 的 R1–R5 **已实施并验收**：`tsc` / `check`（**161 PASS / 0 FAIL**：152 子检查 + 9 状态）/
> `build` / `budget`（**11 项**）/ `doccheck --recompute` / `smoke`（**88 PASS / 0 FAIL**）全绿。
> 已修（每条都有永久负例）：**逐子步即时回调**（INS 东向位置 3.925 m → 1.556 m；0 dt 不再积分；
> 子步长度永不因上限放大，超限部分记 `deferredSec`）；**连接会话所有权**（read await 后验令牌挡住迟到数据、
> `cancel→释放锁→close` 与 `closePortFailures` 真实记账、重连不误伤替代 reader、BLE 初连失败断 GATT 摘监听、
> 回调按设备身份归属、订阅先 start 后挂监听）；**录制/消费契约**（`onSolve` 冻结实际消费输入、源列按逐行
> `sourceCalibrated` 标 `# imu=`、混语义拒绝）；**strict 输入**（原始结构校验、未来版本拒绝、notes 展示、
> 先算提示再提交）与**共用校准合法性**（对称正定/增益/偏置/残差/faces）+ 采面连续时间覆盖；
> **门禁自身**（soak CLI 双写法、`opens ≥ 断链数`、doccheck 关系约束与零引用失败、窄屏错误汇总）；
> **预算计量**（sw.js 单列，主包上限据实测增量 285/108 → 288/110 KB）。
> **仍未验收**：真机 30 min（串口/BLE 各一段：拔插/离开范围/休眠/复位）、10 分钟软件长稳、
> 可判读的桌面/窄屏/文档/打印视觉验收（截图通道仍返回 Media omitted）；另：trace 比较器尚未比较双侧
> dt/IMU/事件、Worker 协作取消仍收不到消息、跨时段校准数据与真实硬件标定未验。
> 上一轮报告 [`QUALITY-REVIEW-2026-11-01-ROUND10.md`](QUALITY-REVIEW-2026-11-01-ROUND10.md) 为历史实施记录。

> **历史实施：2026-11-01「复核修复轮（第十轮，按 ROUND8 的 A–E）」**（详见 [`CHANGELOG.md`](CHANGELOG.md) 顶部；当前残留以ROUND11为准）。
> 本轮门禁：`npx tsc --noEmit` / `npm run check`（**153 项 = 124 数值 + 10 几何 + 15 HTML + 3 文档**）/ `npm run build` /
> `npm run budget`（10 项）全绿；`npm run smoke` **85 PASS / 0 FAIL**；`npm run soak` 两种模式（batch / reconnect）均 pass。
> 修复内容与负例一一对应：**连接所有权**（一次切源只递增一次世代、内部 dispose 不再自我作废、订阅/自动重连每个 await 后验世代、
> read 循环带连接令牌、端口有开必有关、重连耗尽不冻结、`sourceIntent` 保持断链期间的来源身份）；
> **导出/回放不可变**（每行冻结当时喂给解算的读数、导出不重算历史、全帧源 IMU 按来源标 `# imu=`、校准日志锁定校准开关、
> 30 s 空洞按真实 30 s 播放）；**校准契约**（错朝向立即拒绝、条件数/镜像/偏置/残差门槛、留一带方向误差、
> 档案严格 schema 不再静默丢模型、Applied 不能无模型、导入清两侧采集并深拷贝）；
> **生产负面测试**（`applyFrame` 子步时间递增且单次对准事件、`termination` 显式终止口径、trace 带 dt/raw/consumed 与
> 正确 `aligned`、统计用例直接驱动生产累加器、低采样历史多留一个周期）；**门禁治理**（trace 比较器 7 种畸形输入必须失败、
> soak 真实丢弃计数与逐段增长、statuscheck 项数取自脚本实际输出、doccheck 严格 schema + 正文数字块核对 + `--recompute` 只读复算、
> 对比度负对照）。
> **仍未做**：真机 30 min 现场验收（串口/BLE 各一段，含拔插/离开范围/休眠/设备复位）与图像通道可用的桌面/窄屏/文档/打印视觉验收
> ——这两项保持「未验收」标签，不用软件 mock 顶替。上一轮报告 [`QUALITY-REVIEW-2026-11-01-ROUND8.md`](QUALITY-REVIEW-2026-11-01-ROUND8.md)
> 与 [`QUALITY-REVIEW-2026-11-01-ROUND10.md`](QUALITY-REVIEW-2026-11-01-ROUND10.md)（本轮结项说明）可对照阅读。

> **最新恢复入口：[`QUALITY-REVIEW-2026-10-31-ROUND7.md`](QUALITY-REVIEW-2026-10-31-ROUND7.md)。**
> 本轮独立复核未修产品源码：现有 `check` 为 **149 PASS / 0 FAIL**（117 数值 + 10 几何 + 15 HTML + 1 文档引用 + 6 状态断言），smoke 为 **76 PASS / 0 FAIL**，预算实为 **10 项**。
> 但已有定向反例证实：取消旧任务仍会回写/串批、重连空窗混入仿真、后段验证75%训练泄漏、验证模型使用错误2k、退化校准被当成功、导出历史/语义不闭环、采样率×延迟与小数日志时间差错误、周期分位数混叠、manual目标不在配置。
> “逐帧一致”目前只比终点，“全部15页对比度”漏扫5页；以下旧里程碑的“完成/已修”需以ROUND7证据与W0–W6工单重新验收，不能直接沿用。
> 新跑 `soak --seconds=120 --interval=10000 --batch` **退出码1**：零错误/容量/堆检查通过，时钟推进16.7→51.1秒未达到阈值。视觉截图无法判读，本轮视觉验收未完成。真机30分钟仍未做。
> 测试日志在 `.audit-current/`（D盘）。
>
> **第九轮已按 W0–W5 修复**（详见 ROUND7 第 6b 节）：批次世代（取消后 17 s 无回写）、连接世代与断线冻结数据流、
> 传感器延迟按采样时刻寻址（50 Hz 下 100 ms→28 ms）、日志浮点时间（Σdt 0.805→1.000000 s）、手动目标进配置、
> 统计改定长蓄水池（10 Hz P95 从混叠的 1.25° 修回 9.98°）与预定切点精确稳态、SO(3) 用 log 旋转向量
> （90°/180° 精确）、校准合成复用生产链路且后段留出改为前段训练、退化/朝向/点数不足一律拒绝、
> 档案不再伪造训练样本、逐帧 trace 升级为**逐步比较**（2000 步、时间差 0、最大姿态差 5.12e-6°）、
> 对比度逐页核对（15/15）、doccheck 增加数值健全性、soak 逐批记录批量并要求帧计数不倒退。
> **仍未做**：真机 30 min 现场验收（需要硬件窗口，保持未验收标签）。

> **下一轮实施先读 [`NEXT-ITERATION-ROADMAP.md`](NEXT-ITERATION-ROADMAP.md)**：
> 2026-10-30 只读审查形成的任务书（P0 事实校正 → P1 可复现实验内核 → P2 批量评测 →
> P3 时间/采样/记录 → P4 卡尔曼诊断 → P5 新实验 → P6 文档重组），含逐项验收标准。
>

<!-- history:end -->
