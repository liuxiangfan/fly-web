# 项目状态 · 四元数姿态解算学习演示装置

<!-- current:begin -->

> **当前实现分支：`feat/teaching-interaction-ab`（2026-11-16，工作树未提交）**。阶段 A（单变量对照、任务条、参数反馈）与阶段 B（预测练习）已接入。C/D 已按 `CD-WIRING-DECISION-PLAN.md` 完成 P1 实测失败 → 所有者选择 **P2** → 一次性有归因调线（全部 JS 325、教学 chunk 144、总产物 2250 KiB）并正式接线。四个诊断面板在打开「玻璃盒」分区时按需创建；回看与 ESKF 采集各有显式开关；同时保留通用结构修复：共享转义、`worker-core` 统一（修复 Worker 反向引用教学 UI）、懒加载 chunk 不再首屏预加载。
>
> 文档更新：2026-11-07 · 分支已合并（PR #2 → master `db1a93f`）· 正式版 [v0.2.0](https://github.com/liuxiangfan/fly-web/releases/tag/v0.2.0) 已发布并部署。
> 线上 <https://fly_web.070616.xyz> 的 `build-provenance.json` 指向合并提交 `db1a93f`，`sourceDigest` 与冻结证据一致（`2bb7ea30…`）。旧预发行 `v0.2.0-rc.1` 保留，不再更新。
> 性能工作（软件渲染画质档、取消停止时刻口径、公式复制回退）的方法与后续工单见 [`WINDOWS-PERFORMANCE-OPTIMIZATION-PLAN.md`](WINDOWS-PERFORMANCE-OPTIMIZATION-PLAN.md)。

## 一句话

纯前端四元数姿态解算教学软件：多数据源与离线回放、五算法数字对照、Three.js 姿态／万向节／四元数视图、校准数学、INS、批量评测与应用内教材。

- 在线入口：<https://fly_web.070616.xyz>；2026-11-06 核对线上提交 `58a11ba09a91` 与远端 master 一致；本次 v0.2.0 修复尚未部署。
- 坐标：世界 NED、机体 FRD，四元数 `q` 为机体系→世界系；显示 X=北、Y=上、Z=东。
- 技术栈：Vite + TypeScript（无框架）+ Three.js；KaTeX 字体；手写 Canvas 图表。
- **本阶段范围**：只支持 Windows 本机运行（不追求跨平台），硬件部分不在范围内。

## 当前机器口径

<!-- baseline: bc95b96db048ef13e5952ee76200e911331368c8 -->
<!-- 基线口径：上一行是本轮 CI 证据（run 42384961739 的 head）的提交；本机长稳/视觉/性能报告采集于 e9b1edd，两者产品源码摘要同为 2bb7ea30（其间只有 scripts 与文档改动），所以证据仍然有效。 -->
<!-- counts: experiments=19 demos=8 selftest=126 smoke=129 docpages=15 -->
<!-- verify: check=155 contracts=yes status=yes smoke=129 budget=19 evidence=yes -->
数值自检 126 + 场景几何 10 + HTML 契约 15 + 文档基准 4

- `npm run check` = selftest（126）+ scenecheck（10）+ htmlcheck（15）+ doccheck（4），共 **155 项**；随后执行 contracts、statuscheck 与 evidencecheck。
- `contracts` 链（每个文件都是独立反例集）：time / schema / doc-search / formula-copy / archive-ui / lifecycle / worker / comparison（配置、报告、Worker、UI）/ 参数任务 / 学习活动 / 事件与可观性 / 回看与 ESKF / 估计器诊断 / trace / catalog，以及 node:test 的 soak / evidence（含测试现场归属）/ smoke-verdict / status / budget 契约。
- `npm run budget` = **19 项**产物预算；判定在 `scripts/budget-core.mjs`，报告名义上限／有效门槛／剩余／基线增量。本分支新增按需分类（目录 JSON、教学交互 chunk、诊断 chunk、CSV 导出 tools-ui、共享数值内核、Worker 入口），并把主包对 runner 的静态依赖改为按需加载。按 `CD-WIRING-DECISION-PLAN.md` §4 的 P2 决策，仅调整三项并冻结新基线：全部 JS 325→292.5、教学 chunk 144→129.6、总产物 2255→2029.5 KiB；主包 283.5 KiB 等原有门槛不动。2026-11-20 所有者再授权：阶段3只读报告实测新增约 2 KiB gzip，仅全部 JS 名义 325→328 KiB（有效 292.5→295.2），其余上限不动（归因见 distbudget.mjs）。
- 浏览器冒烟声明 **129 项**（app 108 + devices 21）；驱动器比对的是**完整集合**（清单 `scripts/smoke-manifest.json`，由契约测试守着不漂移），不是 PASS 行数。
- 本分支阶段1结构优化候选（2026-11-20）：源码摘要 `056916cd9100271bc844284b9b660e46`，构建 `056916cd9100-2ad7628585092553`（提交仍显示 `7d5cf97`，工作树 dirty）。全部 JS gzip **294905 / 有效 299520 B，余 4615 B**，18/18 预算通过；完整 check 与 **120 项浏览器**通过，批量 `mode=worker` 已恢复。旧 `b4894a07…` / `e90fe931…` / `2d93cd3d…` 只作历史。CI 未触发（未获推送授权）。
- **阶段1/2/3/5 全部完成并闭环（2026-11-20 最终候选）**：`sourceDigest=ed0f78fb0e2f756be234f370b1954f11`、`buildId=ed0f78fb0e2f-fd379a47f3f6d9f4`、`sourceFiles=135`（提交 `7d5cf97`，工作树 dirty）。复盘导航、只读实验报告（生成/导出/打印/导入不改配置）、文字三档、SW 等待确认更新与离线预热均落地，细节见 CHANGELOG 2026-11-20 各节。
- **最终门禁**：`npx tsc --noEmit` PASS；`npm run check` 全绿（155 基础项 + 全契约 + statuscheck + evidencecheck）；`npm run build` PASS；`npm run budget` **19/19**（全部 JS 名义经所有者授权 325→328 KiB，有效 292.5→295.2；贴线项：产物总量余 0.0 KB、全部 JS gzip 余 0.1 KB，已如实登记）。
- **最终证据**：本机五轮 **129×5 全绿**（app 108 + devices 21，零 warning；前两次尝试各有 1 轮环境类失败——渲染进程被系统回收/导航超时，第三次完整通过，过程不隐瞒）；三份 600 s 长稳全 PASS：教学 119 样本/9 真实换源/11 取消、堆水位 −0.984 MB；批量水位 +2.410 MB；重连 66/66 恢复、水位 +8.348 MB；末段与采样覆盖均过。性能 30.3 fps、真实输入 p95 5.910 ms、可交互 2424 ms、控制台 0。视觉 11 张逐张查看无重叠/溢出/空白画布，控制台 0。`evidence:verify` 三层绑定通过（7 条新 current 全部同身份）。复盘/报告/三档/更新横幅截图另存 `D:/test-artifacts/quaternion-attitude/visual/`。**发布状态（2026-11-20）**：PR #3（38d9883）与 PR #4（字体用例时序修复 511fb63）已合并，master `574bbf77`；Cloudflare 部署 verify/deploy/smoke-suite 三作业全绿，线上 buildId 与 master 一致、部署后 smoke 通过；Release **v0.3.0** 已发布（tag 指向 master）。读屏范围外、硬件为软件替身、GPU IBL 未实测的边界不变。
- **已知边界（如实登记）**：主包 index 仍静态引用 `teaching-ui`（RollingChart 与对照台共享 `ui/chart.ts`），教学 chunk 实际首屏加载且有空闲预取；按需分类预算口径不变，但若要做到「教学 UI 真正不首屏」需把 chart.ts 移回首屏侧并重新推导主包门槛，属另一轮结构专项，本阶段未做。
- 前序候选体积（e90）：全部 JS gzip **295424 / 有效 299520 B（余 4096 B）**，raw 983509 B、12 个 JS；新候选加入 F-05/F-07 后仍需重采尺寸，预算已 18/18 通过。结构来源为移除 RoomEnvironment/PMREM、轻量轨道控制器、五估计器工厂去重及 runner/学习面板具名动态入口。IBL 反射取舍与高质量 GPU 未实测边界见第五次复核。

### 教学方案 F-05/F-07 补齐（当前候选）

- 评估补记为 [`TEACHING-REVIEW-FIFTH-2026-11-19.md`](TEACHING-REVIEW-FIFTH-2026-11-19.md) 第 11 节；不重新评分。
- **F-05**：传感器真实削顶分支提供可选只读信号；饱和、串口/BLE 断流与恢复、重连 attempt/success/exhausted、参数变化、视图切换、实验装载均进入事件时间轴。参数事件取最终生效值，程序化装载只记一条聚合事件。
- **F-07**：`diagFullP` 默认关闭；开启时在同一 `update()` 记录输入/预测/观测前后/最终共七处完整 6×6 P 独立副本，面板可展开；关闭时无额外字段且数值逐位一致。
- 新增 `imu-saturation-contract` 3 项、`eskf-fullp-contract` 4 项；事件/遥测契约扩正反例。冒烟清单 **120（app 99 + devices 21）**，新增用例已在两分片真实通过。
- 新候选证据已闭环：120×5、教学 119 样本/9 真实换源、批量 114 样本、重连 66/66、性能 31.1 fps/输入 p95 2.860 ms/取消 52.4 ms、11 张逐图与 strict 均通过。全部 JS gzip **296640 B，余 2880 B**；预算通过但 4 KiB 目标因功能扩展回退，已如实登记。教学领域复核、读屏、GPU IBL 与远端发布边界不变。

### 第五次结构减重专项历史验收（2026-11-19，前序候选）

- 评估文件：[`TEACHING-REVIEW-FIFTH-2026-11-19.md`](TEACHING-REVIEW-FIFTH-2026-11-19.md)。基线评分保留 **84/100 暂定**，不因减重自动加分。
- 全部 JS gzip 从第四次 **299442 B** 降至 **295424 B**，有效门槛不变，余量 **4096 B**；目标已达成。新候选 `sourceDigest=e90fe931c33d53fad2455d2650adcd92`、`buildId=e90fe931c33d-f56a3da77a48a479`。
- 结构改动：移除仅作反射点缀的 RoomEnvironment/PMREM；本地轻量轨道控制器保留旋转、平移、滚轮、捏合、阻尼与边界，新增契约 **6/6**；`createEstimators()` 统一五算法装配；runner-ui 与 learning-panel-ui 收窄动态入口，Worker 不反向引用 UI。
- 首次完整 check 因旧契约只接受字面量 `core/runner` 失败；已更新为接受 runner 或 runner-ui，仍要求动态加载、禁止静态引入。重跑 `tsc → check` 全部通过（155 基础项＋全契约 0 FAIL）。
- 新候选五轮 **117×5**、教学 600 s（119 样本、118 动作、9 真实换源、停载静默、堆水位 +2.681 MB／趋势 −0.778 MB）、批量 600 s（117 样本、水位 +4.278 MB／趋势 6.755 MB）、重连 600 s（122 样本、66/66 恢复、水位 +7.841 MB／趋势 17.309 MB）均通过；性能 30.4 fps、输入 p95 2.887 ms、取消 20.8 ms、可交互 3049 ms；11 张实际逐图无意外重叠、横向溢出或空白画布。strict 三层绑定通过。真实拖拽与暂停后滚轮改变相机位置已验证。高质量 GPU 的 IBL 外观未实测；读屏仍范围外，远端 CI／发布未授权。

### 第四次整改历史验收（2026-11-19）

- 教学命题：Ki=0.5 在固定无噪声 20 s 窗口里确实优于 Ki=0.05，不再把该实测事实判为错误；错误项改为“任何条件下越大越好且绝不振荡”。本窗口未实测大 Ki 振荡。门控教材、实验库、claim 与契约共用生产配置：20 s Mahony RMSE 15.2436°→12.5274°，改善 2.7163°、拒绝 8272 帧，峰值两侧同为 57.6005°，不承诺峰值改善。
- 真实换源量具：`teaching-load/v2` 调用生产 `replay.import()` / `replay.stop()`；保存 active false→true→false、source simulation→replay→simulation、消费 idx 与真实诊断 runId 推进。旧假换源教学报告保留正文与哈希，但降为历史 `invalid-source-switch`，仅供容量和内存观测。最终 `generated/soak-teaching-600-2d93cd3d-fourth.json` **600 s 通过**：117 样本、116 动作、9 次真实换源，runId 2→20，回放消费 idx 3–20；11 次对照取消均落定且无迟到回写（0.5–1.3 ms），控制台/动作错误 0；墙钟 600088 ms、最大采样间隔 7056 ms、同 run 累计时钟 355.694 s；回看 750 / 事件 512 封顶，停载静默；堆水位 +2.472 MB、峰值增量 26.810 MB、趋势 3.446 MB、末段 PASS，无豁免。停载边界是关回看/ESKF并暂停生产解算，事件记录器没有独立停采开关。
- 证据治理：视觉采集路径按完整 sourceDigest/buildId/UUID 独立，PNG 为 `localOnly:true`，本机有图继续核像素哈希；历史原件丢失条目记 `OBSERVED/unrecoverable`，未知覆盖关联为 null，不补造原件或完整 hash。
- 视觉复核：11 张新截图位于 `screenshots/visual-2d93cd3d5131d3eb6eeb9f594c4346c6/2d93cd3d5131-15c789e0829d1fe9/2c61c8f4-26c8-451b-a90b-9084b96838eb/`；本机后续图像输入成功，已实际逐张查看桌面、320/390/768、200% 缩放、三视图、文档与两种打印。未发现意外重叠、横向溢出或空白画布，控制台 0。早期同会话的图像不支持错误保留为过程记录，不再描述为本版无法看图；这不扩大为所有者逐图验收或读屏验收。
- 未闭环：至少 4 KiB 演进余量；FIX-16 远端 CI/发布未授权。读屏仍为范围外。

### 上一构建 `027b2d0c` 的历史验收（不作为第四次新构建验收）

- `npx tsc --noEmit`、`npm run check`（155 项基础检查 + 扩展契约链）、`npm run build`、`npm run budget`（18/18）通过。
- 浏览器完整集合：app **97/97**、devices **20/20**，合计 **117**，零 FAIL、零 warning、零未计划重启；app 的控制台零错误用例通过。
- 稳定性 **5×(app+devices)**：每轮 117 项完整集合、零失败／warning／未计划重启——`generated/stability-local-windows-027b2d0c.json`。
- 视觉 **11 张**（320/390/768/1440、200% 缩放、三视图、文档与打印；控制台零错误）——`generated/visual-evidence.json`；项目所有者已人工确认功能正常、无问题。截图按源码摘要存 `screenshots/visual-027b2d0c/`。
- 性能：墙钟 32.8 fps（软件渲染 Chrome）、真实输入 p95 2.9 ms、运行期 timer p95 12.9 ms、主线程取消 request→runner 74.5 ms / input→runner 75.1 ms、可交互 2389 ms、堆峰值 20.9 MB——`generated/perf-report.json`。
- 长稳 **600 s ×3**：批量 115 样本、仿真时钟 365.7 s、水位 3.2 MB／峰值 26.7 MB／趋势 9.9 MB；重连 66/66 恢复、122 样本、仿真时钟 422.7 s、水位 7.6 MB／峰值 26.5 MB／趋势 15.7 MB；教学负载 236 次动作（含 11 次换源）、回看峰值 643 帧、事件 512 封顶、停采后静默、水位 2.6 MB／峰值 29.8 MB／趋势 7.0 MB——`generated/soak-*-600-027b2d0c.json`。**注意**：四次复核实测该「换源」只改 `source-select` 的值，没有真正进入回放，11 次不计为有效换源覆盖；修复与重采见 `TEACHING-REVIEW-FOURTH-2026-11-18.md`。
- **二次复核 TQ-01～09（2026-11-17）**：固定教学基线与全 IMU 归零；偏航题三组倾角/纯偏航正负对照；Ki 题磁开+Δ≥0.5°；门控 claim 先装载 gate 实验；回看帧驱动观测/ESKF Inspector 并锁定游标；学习证据计划+各侧结构化结果绑定；新增 600 s 教学负载证据；旧 CI/部署标历史，截图按 sourceDigest 存放；预算通过结构合并与压缩压回门槛内。
- **教学小项（2026-11-17）**：`task-context.deviatingIds()` 成为 task-strip 与 markDeviation 共用的偏离策略，TaskKind/TaskDescriptor 复用同一类型；回看进入/上一帧/下一帧同步三张曲线与 IMU 游标、退出清空；claim 注册表 3→13，新增 10 条 run-experiment 覆盖实验索引主要结论，浏览器 claim 往返同时验证预测/实验/对照。
- **TEACHING-FIX**：FIX-01～FIX-13、FIX-17 已完成（证据 patch/选项实测判定、ESKF 重置雅可比、观测状态语义、回看状态字段、对照 stale、claim 教材往返、五算法事件、取消传播、任务条时序、8 行对照指标、四条浏览器完整路径、课程首步 `data-imu-mode` 根因；FIX-17 五题正反例与种子/初始姿态复核并整改）。FIX-14 读屏经所有者明确为范围外；FIX-15 经所有者人工确认；仅 FIX-16 待授权。
- **WP-03 A 定向优化**：canvas 尺寸未变不重设位图、曲线按 revision 脏绘制、INS 关态占位缓存、telemetry detail／评测表内容去重、非万向节视图不刷新 DOM；暂停 5 s 两条展开曲线各 46 次 render→46 跳过/0 绘制、评测表 10 次刷新/0 写 DOM，恢复播放后正常绘制。
- 严格验收：`npm run evidence:verify` 通过（8 条 current 源码/构建绑定证据，源码 `027b2d0c…` / 构建 `027b2d0c48c4-58d3f6a0…`）；旧 CI/部署条目已降为历史 scope，不再冒充当前源码验收。
- 视觉与读屏边界：新增 claim/预测/对照/回看 UI 已做模型截图与浏览器路径检查（1440/390、控制台零错误、无横向溢出）；项目所有者 2026-11-17 人工确认视觉功能正常、无问题；读屏经所有者明确为范围外（不需要该功能）。
- **仍未做**：仅 FIX-16 CI/线上核验与发布（需所有者授权推送）。FIX-14 读屏为范围外，FIX-15 已由所有者确认，FIX-17 已完成整改。

### v0.2.0 冻结证据（旧源码 `2bb7ea30`，不作为本分支严格验收）

- 稳定性 **5×(app+devices)**：每轮旧清单 **107 项完整集合**、零失败零 warning 零重启——`generated/stability-local-windows-2bb7ea30.json`。
- 长稳 **600 s ×2**：批量（常驻水位 0.9 MB、峰值增量 26.4 MB、趋势 6.0 MB、116 样本）与软件替身重连（4.6 MB、27.8 MB、16.7 MB、122 样本）——`generated/soak-*-600-2bb7ea30.json`。
- 视觉 11 张（320/390/768/1440 视口、200% 文字缩放、打印与三视图，控制台零错误）——`generated/visual-evidence-2bb7ea30.json`；性能 `generated/perf-report-2bb7ea30.json`（墙钟 58.9 fps、真实输入 p95 1.3 ms、运行期 timer p95 13.4 ms、取消 11.9 ms、堆峰值 20.9 MB）；体积归因 `generated/size-report-2bb7ea30.json`。
- 严格验收通过：`npm run evidence:verify`（源码摘要 + 产物摘要 + buildId 三层绑定）。
- **CI 侧五轮稳定性**：`workflow_dispatch` 在 Windows 上连跑 5 轮（run 42384961739，head `bc95b96`）——每轮旧清单 107 项、零 FAIL、零 warning、零未计划重启，登记为 `ci-stability-win-bc95b96`（current，`evidence:verify` 通过）；脚本按 artifacts 核对 workflow/job/attempt、冒烟步骤真的执行、五轮完整集合与 head_sha 绑定。
- **单浏览器标签页上限**：CI 上同一浏览器开到第 10~11 个标签页时渲染进程会被回收（两次同一位置；JS 堆 12 MB、工作集 812–863 MB，非内存耗尽）。现达到 10 个标签页即**主动重建**并记入 `plannedRecycles`；未计划的回收仍判本轮失败。
- **Windows CI**：提交 `2640153` 的 `gate`、`smoke-shards (app)` 87/87、`smoke-shards (devices)` 20/20 全绿，完整 `smoke-suite` 重跑后旧清单 107 个用例全部通过 / 0 FAIL / 0 warn（SW-10 事件→handler 0.3 ms、事件→runner 14.7 ms、timer p95 39.6 ms，修复前 302.5／314.4／326.2 ms）。提交 `e9b1edd` 的 `smoke-suite` 也已全绿；同轮 CI 的 app 分片仍遇到一次 Chrome 进程被回收（87 项本身全 PASS），现场记录显示当时 JS 堆仅 12 MB、DOM 1 个文档——**不是应用内存泄漏**，是 2 vCPU + SwiftShader 环境下的进程级回收，已加工作集采样继续观察。
- **提交 `b12b832` 两条工作流首轮即全绿**：`CI`（gate、app 87/87、devices 20/20）与 `Deploy`（verify、smoke-suite）均一次通过，未靠重跑；SW-10 事件→handler 0.2 ms、事件→runner 18.8 ms（来源 runner-stop）。软件渲染下关闭 GPU watchdog 后进程回收未再出现；工作集趋势约 2.5→2.8 GB，增长平缓（非泄漏）。
- 历史（保留不删）：线上部署 `95a80413`（run 42040828875）曾通过部署后 smoke；`42074606433` 那轮 smoke-suite 两项断言失败，已由画质档修复覆盖。smoke-suite 仍是 `continue-on-error: true`，工作流总览成功不代表套件通过，发布验收必须单独看该作业。

代码修改后的验证顺序：

```bash
npx tsc --noEmit
npm run check
npm run build
npm run budget
npx tsx scripts/doccheck.ts --recompute
node scripts/evidencecheck.mjs --require-source --require-build   # 严格验收：源码 + 产物 + 被服务产物身份
```

需要浏览器验证时，源码或入口 HTML 改变后必须重建并强刷；预览统一 4173 端口。

### 测试现场与磁盘归属（2026-11-19）

- 本项目管理得住的浏览器 profile、临时构建与下载产物，默认全部落在 `D:/test-artifacts/quaternion-attitude`，
  按用途分目录：`smoke/`、`soak/`、`evidence-contract/`、`build-probes/`、`perf/`、`visual/`、
  `postdeploy/`、`screenshots/`、`ci-downloads/`、`hw-soak/`。
- 唯一入口是 `scripts/test-artifacts.mjs`：`testArtifactRoot(kind)` 建根、`testArtifactTempDir(kind, prefix)`
  每任务 `mkdtemp` 独立目录、`cleanupArtifactDir(dir)` 尽力清理（Windows 文件占用时只告警，不改变结论）。
  不修改全局 `TEMP`，不共享浏览器 profile。
- 覆盖范围：浏览器冒烟（`SMOKE_PROFILE` 可显式覆盖）、batch/reconnect/teaching 长稳、证据契约夹具、
  体积归因重建、CI 产物下载、性能/视觉/探针/截图/部署后 smoke。`hw-soak` 的 profile 为保留原生设备
  授权而**故意不自动删除**，但位置同样在 D 盘。
- 进程生命周期：冒烟达到 10 个标签页会主动重建浏览器，重建时**旧 profile 也删除**；失败候选浏览器的
  profile 在候选尝试结束后延迟补删；Chrome 优先于 Edge（本机 Edge 启动失败会晚一步 relaunch 并重建
  profile，清理后仍可能留下目录）。2026-11-19 实测：app 97/97、devices 20/20 后 D 盘 `smoke/` 为空、
  无残留浏览器进程；20 s 长稳与教学负载后 `soak/` 为空；`size:report` 重建后 `build-probes/` 为空。
- `QUAT_TEST_ARTIFACT_ROOT` 只改变根位置，不改变「每任务独立目录 + 收尾清理」；D 盘不可写时脚本直接失败，
  不会静默回退到 C 盘。清理前先确认没有运行中的浏览器或长稳进程。
- **异常残留自动清理**：`testArtifactRoot()` 每进程最多触发一次 `pruneTestArtifacts()`，默认只删白名单 kind 下
  超过 24 h 且未被浏览器占用的单任务目录；`QUAT_TEST_ARTIFACT_MAX_AGE_MS<=0` 可关闭。新目录、活跃目录或
  占用查询失败的目录全部跳过；`_migrated-c-temp/`、`_ops/`、`hw-soak/` 永不在自动清理范围。
  模型对这些临时任务目录的自主删除授权与完整保留清单见根目录 `AGENTS.md`。
- **迁移归档已删除**：C 盘旧测试现场共成功迁出 766 个目录；24 个 smoke profile 与 2 个 Puppeteer 默认
  profile 因仍被旧浏览器占用而跳过。`_migrated-c-temp/` 中约 **19.3 GiB** 的可再生测试现场经所有者授权后
  已于 2026-11-19 删除，D 盘可用空间由 **61 GB 增至 81 GB**；`_ops/` 仅保留几十 KiB 的迁移/盘点报告。
  完整实施回执见 [`TEACHING-REVIEW-FOURTH-2026-11-18.md`](TEACHING-REVIEW-FOURTH-2026-11-18.md) 第 7 节。
- 边界：浏览器安装目录、npm/Node 全局缓存、其他工具的私有临时目录不归本项目控制，因此不承诺迁到 D 盘；
  全局 `TEMP` 环境变量也没有改。项目内的 `dist/`、`docs/generated/`、`screenshots/` 本来就在 D 盘工作区。

```bash
# 驱动器自行启动／停止预览；不要同时占用同一个端口
node scripts/ci-run-smoke.mjs --shard=both --runs=1
# 或先在独立终端运行 npm run preview，再执行 npm run smoke
```

UI 变化还需截图与控制台检查。页面缩放、纯文字放大与读屏是**三套不同的验收项**（见 [`ACCESSIBILITY-ACCEPTANCE.md`](ACCESSIBILITY-ACCEPTANCE.md)），不能用 DPR 变化互相替代。

## 软件工单实施状态（SW-01～SW-12）

| 工单 | 状态 | 落地内容与反例 |
|---|---|---|
| SW-01 时间单位 | 已实施 | 显式 `s/ms/us` 不再被 `dt>0.5` 启发式覆盖；未知单位保留秒并给出可执行提示；`monotonicTimelineMs` 成为时间轴唯一来源（`time-contract` 17 项） |
| SW-02 Madgwick 遥测 | 已实施 | 遥测只报**修正项**贡献（零观测时修正为 0），与积分路径逐位一致（selftest 13b） |
| SW-03 档案事务 | 已实施 | 导入拆成 prepare（三个纯计划）→ commit（渲染/读回/回滚）；渲染失败时现场零改动（`browser-smoke` 档案用例 + `archive-ui-contract`） |
| SW-04 schema／克隆／规范形 | 已实施 | 克隆/迁移/规范化/校验共用同一份白名单与字段顺序；未知参数键明确拒绝并给字段路径（`schema-contract` 106 项，含第四次 CSV 纯序列化等价/不可变/回放列契约） |
| SW-05 超时与迟到完成 | 已实施 | 原始操作与会话所有权分离：超时后句柄进隔离队列、迟到落定自行关闭、`dispose` 只在真正关闭后返回 true（`lifecycle-contract` 18 项） |
| SW-06 证据交叉绑定 | 已实施 | `dist/build-provenance.json`（源码摘要 + 产物摘要 + buildId）；页面自报 buildId；采集前后核对被服务产物身份与漂移；校验器按类型解析报告正文（含本机像素 hash、历史覆盖链和真实教学换源）；独立 `evidence-contract` 21 项，另含测试现场归属与自动清理契约 |
| SW-07 完整集合与 CI 登记 | 已实施 | 冒烟清单 + 结构化 `completed` 结果 + 统一判定（assert/incomplete/env/unknown）；`register-ci-run` 强化为"workflow/job/attempt + 步骤真的执行 + 产物五轮完整集合 + 摘要绑定 head_sha"（`smoke-verdict.test` 8 项）。Windows CI 上的五轮由 `workflow_dispatch` 触发并按登记脚本核对（本阶段只支持 Windows，不跑 Ubuntu） |
| SW-08 长稳末段增长 | 已实施 | 保留水位/峰值/趋势，新增"末段翘尾"判据（尾窗水位 + 持续超阈 + 不回落）与**停载后回落观察**阶段；采样覆盖（墙钟/空洞/样本数）单独判定（`soak-contract` 11 项） |
| SW-09 预算口径与性能 | 口径已实施；第五次结构减重本机闭环 | 口径、纯函数判定、边界测试、sourcemap 归因、真实页面性能实测已落地。第五次全部 JS gzip 299442→295424 B，余 4096 B；移除 RoomEnvironment/PMREM、轻量轨道控制器、估计器工厂与具名动态入口，未抬线、未删功能。新构建五轮 117×5、三份 600 s、性能、视觉与 strict 全通过；244.8 KiB 等更早历史目标不改写 |
| SW-10 主线程降级取消 | 已实施 | 降级分支复用 runner 异步出口（128 步/片 + macrotask 让出），取消在下一片生效、半成品种子不计入统计；本机实测取消 11~73 ms、输入延迟 p95 ≤ 5 ms（真实点击取消用例 + `worker-contract`） |
| SW-11 可访问性与窄屏 | 部分实施 | 窄屏文档目录改 `<details>` 折叠（首屏即见正文）、纯键盘往返与焦点归还、根字号放大的实测记录、Ctrl+K 搜索转义反例；**读屏为范围外、视觉已由所有者确认；真实浏览器字体设置路径仍未验证**（逐条记在 `ACCESSIBILITY-ACCEPTANCE.md`） |
| SW-12 职责拆分与覆盖 | 部分实施 | 已拆出 `ui/doc-search.ts`（纯函数 + 6 项契约 + 冒烟覆盖，顺带修掉查询串注入）；**校准栈/装配层其余部分未拆** |

仍未完成的事（不许被上面的表格掩盖）：

1. ~~跨平台 CI 轮次~~ 已闭环（Windows 范围）：`workflow_dispatch` 连跑 5 轮 ×旧清单 107 个用例通过，并已用 `register-ci-run.mjs` 从 artifacts 核对登记为 current（`ci-stability-win-bc95b96`）。跨平台不在本阶段范围。
2. SW-09 的减重阶段：保留为**未达成的历史目标**——P2 已明确用一次性调线换取 C/D 教学能力，不宣称完成 244.8 KiB 减重；主包/外壳/Worker 等原有门槛未放宽。
3. SW-11 的真实浏览器字体设置路径（读屏已由所有者明确为范围外，视觉已由所有者确认）。
4. SW-12 的装配层拆分（`src/main.ts` 仍约 350 KB 源码，占主包归因的第一位）。
5. 教学扩展 C/D 已按 P2 接线完成；阶段 E 的自动证据已重采，读屏为范围外、视觉已由所有者确认，仅剩 CI/线上核验与发布授权。

## 架构速览

| 文件 | 职责 |
|---|---|
| `src/core/quat.ts` | Hamilton 四元数、指数积分、Euler／轴角／Slerp、旋转与矩阵 |
| `src/core/world.ts` / `imu.ts` / `scenarios.ts` | 真值世界、IMU 误差模型与机动剧本 |
| `src/estimators/index.ts` | 五算法统一接口与遥测（修正项遥测见 SW-02） |
| `src/core/solve-loop.ts` | UI／runner／Worker 共享解算抽帧、FIFO 分拍、粗对准与校准链 |
| `src/core/runner.ts` | 无 DOM 单种子、trace、**异步出口（片预算 + shouldCancel）**、批量统计与取消内核 |
| `src/core/runner-ui.ts` / `ui/learning-panel-ui.ts` | 生产动态入口的具名适配层；测试 helper 保留原模块，Worker 不反向引用 UI |
| `src/scene/orbit-controls.ts` | 教学视图轻量轨道控制器：旋转、平移、滚轮、捏合、阻尼、边界与 dispose；独立 6 项契约 |
| `src/core/replay*.ts` / `truth-track.ts` | CSV 解析（显式时间单位）、有效时间轴、背压播放与真值插值 |
| `src/core/experiment-config.ts` / `experiment-archive.ts` | 配置 schema、迁移、规范化与档案解析（同一份白名单） |
| `src/core/archive-ui.ts` | 档案控件写入计划、量化（网格内夹取）与预测读回 |
| `src/core/csv-export.ts` | 不读 DOM／活状态的记录快照纯序列化，保持列序、原始四元数、源／消费 IMU 与六位小数格式；CSV 装配与下载仍在 main |
| `src/core/transport-session.ts` / `reconnect.ts` | API 会话所有权、隔离队列、释放与重试策略 |
| `src/ui/doc-search.ts` | **文档全文搜索纯函数**（索引/打分/片段/转义/键盘移动） |
| `src/ui/telemetry-diagnostics.ts` | **C/D 诊断服务**：按需挂载可观性/事件/回看/ESKF 面板，管理回看帧与单步采集开关 |
| `src/core/event-recorder.ts` / `event-timeline.ts` | 观测边沿归并、有界事件时间轴与 runId 隔离 |
| `src/core/observability.ts` | 分轴误差与观测状态解释（只读遥测，不下系统级结论） |
| `src/core/review-buffer.ts` | 有界回看帧缓冲、真值/消费输入/遥测快照与容量隔离 |
| `src/main.ts` | DOM／Three.js 装配层；仍承担批量、校准、档案、导出等流程，待继续拆分 |
| `src/workers/batch.worker.ts` | 批量评测 Worker、心跳与协作取消 |
| `scripts/build-provenance.mjs` / `served-build.mjs` | 构建溯源与"被服务产物身份 + 采集漂移"核对 |
| `scripts/smoke-manifest.mjs` / `smoke-verdict.mjs` / `ci-registration.mjs` | 冒烟完整集合清单、统一判定与 CI 登记判定（纯函数） |
| `scripts/budget-core.mjs` / `distbudget.mjs` | 预算纯函数判定（有效门槛/剩余/基线增量）与测量报告 |
| `scripts/evidence-report.mjs` / `evidencecheck.mjs` | 按类型解析报告正文、索引与正文/构建/被服务产物交叉校验 |
| `scripts/size-report.mjs` / `perf-report.mjs` | 体积归因（sourcemap）与真实页面性能实测 |
| `scripts/*contract*` | 时间、schema、文档搜索、生命周期、worker、trace、soak、evidence、smoke 判定、status、budget 反例 |
| `scripts/browser-smoke.mjs` | 浏览器端到端检查（app/devices 分片，结构化结果 + 完整集合比对） |

## 关键约定

- `SolveLoop` 是调度语义的唯一来源，禁止再写第二套抽帧／粗对准。
- 回放必须背压、不得丢源帧；实时入口拒绝／丢弃要可观测。
- CSV 是源 IMU 行日志，不是 solve trace；逐子步对齐用 trace 契约。
- `ExperimentArchive.restore = "config-only"` 不恢复曲线、当前时刻和运行快照。
- parser 接受的对象必须安全渲染、应用、深拷贝和再导出；失败返回值与异常边界必须清楚。
- 任何旧 session、通知或批量任务均不得污染／关闭新会话，不能用计数归零替代真实释放。
- **证据不许"贴摘要"**：报告正文、索引、源码摘要、产物摘要与被服务产物身份五者必须能互相核对；
  源码或产物一变，旧证据就整次作废（`evidencecheck --require-source --require-build`）。
- 基准数字来自 `docs/generated/benchmarks.json`；正文数字块由生成器渲染，禁止手改。
- `.zcodeignore` 是本地工具文件：禁止修改、提交或删除。

## 文档入口

- 软件质量复核历史（含 2026-11-03／11-05 旧评分）：[`QUALITY-AUDIT-HISTORY.md`](QUALITY-AUDIT-HISTORY.md)
- 软件路线图：[`ROADMAP.md`](ROADMAP.md)
- 具体实施方法：[`SOFTWARE-IMPROVEMENT-PLAN.md`](SOFTWARE-IMPROVEMENT-PLAN.md)
- 教学功能与交互扩展规格（含已实施阶段与验收口径）：[`TEACHING-INTERACTION-EXPANSION-PLAN.md`](TEACHING-INTERACTION-EXPANSION-PLAN.md)
- 阶段 C/D 接线与体积取舍的决策协议（P1 实测失败 → P2 已执行）：[`CD-WIRING-DECISION-PLAN.md`](CD-WIRING-DECISION-PLAN.md)
- 教学扩展实施缺陷修复方案（FIX-01～FIX-17，含待人工项）：[`TEACHING-FIX-PLAN.md`](TEACHING-FIX-PLAN.md)
- 教学扩展二次复核（2026-11-17，含 TQ-01～TQ-09 后续整改）：[`TEACHING-REVIEW-2026-11-17.md`](TEACHING-REVIEW-2026-11-17.md)
- 教学扩展三次复核（2026-11-18，84 分评估与体积整改）：[`TEACHING-REVIEW-2026-11-18.md`](TEACHING-REVIEW-2026-11-18.md)
- 教学扩展四次复核（含 87→84 修正、磁盘治理与 JS 余量决策）：[`TEACHING-REVIEW-FOURTH-2026-11-18.md`](TEACHING-REVIEW-FOURTH-2026-11-18.md)
- 可访问性／窄屏验收记录（含未测项）：[`ACCESSIBILITY-ACCEPTANCE.md`](ACCESSIBILITY-ACCEPTANCE.md)
- 既有验证记录与边界：[`VERIFICATION-EVIDENCE.md`](VERIFICATION-EVIDENCE.md)
- 产品与文档变更：[`CHANGELOG.md`](CHANGELOG.md)
- 外部资料：[`RESEARCH-NOTES.md`](RESEARCH-NOTES.md)

<!-- current:end -->

<!-- history:begin 历史细节由 QUALITY-AUDIT-HISTORY 与 CHANGELOG 承载 -->

## 历史说明

旧轮次报告、满分自评与路线图结论是历史记录，不再视为当前承诺。后续复核已经发现新的内部反例，软件结论以本页、质量复核历史索引与软件实施方案为准。

原始报告仍可通过Git历史读取。此处只保留精简恢复入口，不复制多轮历史门禁数字。

<!-- history:end -->
