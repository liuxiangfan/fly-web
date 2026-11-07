# 项目状态 · 四元数姿态解算学习演示装置

<!-- current:begin -->

> 文档更新：2026-11-07 · 修复分支：`fix/smoke-interaction-release` · 已发布 [v0.2.0-rc.1 预发行](https://github.com/liuxiangfan/fly-web/releases/tag/v0.2.0-rc.1)，提交 `c7d353b0605e`；正式 v0.2.0 仍未发布，PR #2 未合并。
> 2026-11-07 按 [`WINDOWS-PERFORMANCE-OPTIMIZATION-PLAN.md`](WINDOWS-PERFORMANCE-OPTIMIZATION-PLAN.md) 的 WP-01/WP-03 做了**软件渲染画质档**与课程冷加载反馈：SwiftShader/llvmpipe 等无 GPU 环境自动关闭 MSAA/阴影/IBL、像素比封顶 1，正常 GPU 仍走原画质。提交 `2640153` 的 Windows CI：`gate`、`smoke-shards (app)` 87/87、`smoke-shards (devices)` 20/20 全绿；完整 `smoke-suite` 重跑后 **107 PASS / 0 FAIL / 0 warn**。SW-10 事件→handler 0.3 ms、事件→runner 14.7 ms、timer p95 39.6 ms（修复前 302.5／314.4／326.2 ms）；课程 13 步全过。
> 最新软件质量复核：见 [`QUALITY-SOFTWARE-ONLY.md`](QUALITY-SOFTWARE-ONLY.md)（本轮按软件工单实施后重新评分，含"未做到"的逐条说明）。
> 顺序与状态看 [`ROADMAP.md`](ROADMAP.md)，具体方法与反例看 [`SOFTWARE-IMPROVEMENT-PLAN.md`](SOFTWARE-IMPROVEMENT-PLAN.md)。

## 一句话

纯前端四元数姿态解算教学软件：多数据源与离线回放、五算法数字对照、Three.js 姿态／万向节／四元数视图、校准数学、INS、批量评测与应用内教材。

- 在线入口：<https://fly_web.070616.xyz>；2026-11-06 核对线上提交 `58a11ba09a91` 与远端 master 一致；本次 v0.2.0 修复尚未部署。
- 坐标：世界 NED、机体 FRD，四元数 `q` 为机体系→世界系；显示 X=北、Y=上、Z=东。
- 技术栈：Vite + TypeScript（无框架）+ Three.js；KaTeX 字体；手写 Canvas 图表。
- **本阶段范围**：只支持 Windows 本机运行（不追求跨平台），硬件部分不在范围内。

## 当前机器口径

<!-- baseline: 54d85f57600ff09cc7b5f6c137bd65daf1f292e3 -->
<!-- 基线口径：上一行是**本轮证据采集时**的提交；此后只有文档与证据登记改动，产品源码摘要未变（2bb7ea30…）。 -->
<!-- counts: experiments=19 demos=8 selftest=126 smoke=107 docpages=15 -->
<!-- verify: check=155 contracts=yes status=yes smoke=107 budget=14 evidence=yes -->
数值自检 126 + 场景几何 10 + HTML 契约 15 + 文档基准 4

- `npm run check` = selftest（126）+ scenecheck（10）+ htmlcheck（15）+ doccheck（4），共 **155 项**；随后执行 contracts、statuscheck 与 evidencecheck。
- `contracts` 链（每个文件都是独立反例集）：time / schema / doc-search / formula-copy / archive-ui / lifecycle / worker / trace，以及 node:test 的 soak / evidence / smoke-verdict / status / budget 契约。
- `npm run budget` = **14 项**产物预算；判定在 `scripts/budget-core.mjs`，报告名义上限／有效门槛／剩余／基线增量。v0.2.0 修复通过复用重复代码减下 1763 字节；2026-11-07 的软件渲染画质档再加约 0.7 KiB，主包 283.2 KiB，门槛仍为 283.5 KiB，余量仅 0.3 KiB，未抬上限。
- 浏览器冒烟声明 **107 项**（app 87 + devices 20）；驱动器比对的是**完整集合**（清单 `scripts/smoke-manifest.json`，由契约测试守着不漂移），不是 PASS 行数。
- 产品源码摘要（2026-11-07 软件渲染画质档）：`2bb7ea308692fcecbe6f5384b9618229`（84 个构建输入文件）；本地验收构建 `2bb7ea308692-e791bb9d179928b1`（提交 `e9b1edd`，工作树干净）。仅同一提交、依赖与构建环境下产物可复现；提交戳改变仍会改变产物，不能沿用旧 buildId。
- 全部 JS gzip 约 268 KiB（名义上限 300 KiB，有效门槛 270 KiB，剩约 1.9 KiB）。

本轮证据（同一份冻结构建 `2bb7ea30` / `e791bb9d`，均在本机 Windows 采集并已登记进索引）：

- 稳定性 **5×(app+devices)**：每轮 **107 项完整集合**、零失败零 warning 零重启——`generated/stability-local-windows-2bb7ea30.json`。
- 长稳 **600 s ×2**：批量（常驻水位 0.9 MB、峰值增量 26.4 MB、趋势 6.0 MB、116 样本）与软件替身重连（4.6 MB、27.8 MB、16.7 MB、122 样本）——`generated/soak-*-600-2bb7ea30.json`。
- 视觉 11 张（320/390/768/1440 视口、200% 文字缩放、打印与三视图，控制台零错误）——`generated/visual-evidence-2bb7ea30.json`；性能 `generated/perf-report-2bb7ea30.json`（墙钟 58.9 fps、真实输入 p95 1.3 ms、运行期 timer p95 13.4 ms、取消 11.9 ms、堆峰值 20.9 MB）；体积归因 `generated/size-report-2bb7ea30.json`。
- 严格验收通过：`npm run evidence:verify`（源码摘要 + 产物摘要 + buildId 三层绑定）。
- **Windows CI**：提交 `2640153` 的 `gate`、`smoke-shards (app)` 87/87、`smoke-shards (devices)` 20/20 全绿，完整 `smoke-suite` 重跑后 107 PASS / 0 FAIL / 0 warn（SW-10 事件→handler 0.3 ms、事件→runner 14.7 ms、timer p95 39.6 ms，修复前 302.5／314.4／326.2 ms）。提交 `e9b1edd` 的 `smoke-suite` 也已全绿；同轮 CI 的 app 分片仍遇到一次 Chrome 进程被回收（87 项本身全 PASS），现场记录显示当时 JS 堆仅 12 MB、DOM 1 个文档——**不是应用内存泄漏**，是 2 vCPU + SwiftShader 环境下的进程级回收，已加工作集采样继续观察。
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
| SW-04 schema／克隆／规范形 | 已实施 | 克隆/迁移/规范化/校验共用同一份白名单与字段顺序；未知参数键明确拒绝并给字段路径（`schema-contract` 102 项） |
| SW-05 超时与迟到完成 | 已实施 | 原始操作与会话所有权分离：超时后句柄进隔离队列、迟到落定自行关闭、`dispose` 只在真正关闭后返回 true（`lifecycle-contract` 18 项） |
| SW-06 证据交叉绑定 | 已实施 | `dist/build-provenance.json`（源码摘要 + 产物摘要 + buildId）；页面自报 buildId；采集前后核对被服务产物身份与漂移；校验器按类型解析报告正文（含像素哈希）（`evidence-contract` 9 项） |
| SW-07 完整集合与 CI 登记 | 已实施（本机部分） | 冒烟清单 + 结构化 `completed` 结果 + 统一判定（assert/incomplete/env/unknown）；`register-ci-run` 强化为"workflow/job/attempt + 步骤真的执行 + 产物五轮完整集合 + 摘要绑定 head_sha"（`smoke-verdict.test` 8 项）。**跨平台 CI 轮次未跑**（需授权推送） |
| SW-08 长稳末段增长 | 已实施 | 保留水位/峰值/趋势，新增"末段翘尾"判据（尾窗水位 + 持续超阈 + 不回落）与**停载后回落观察**阶段；采样覆盖（墙钟/空洞/样本数）单独判定（`soak-contract` 11 项） |
| SW-09 预算口径与性能 | 部分实施 | 口径、纯函数判定、边界测试、sourcemap 归因（`npm run size:report`）、真实页面性能实测（`npm run perf`：可交互/墙钟帧率/长任务/输入延迟/取消延迟/堆峰值）已落地；**名义上限内剩余 1.1 KB，减重阶段未完成**（见 `QUALITY-SOFTWARE-ONLY.md`） |
| SW-10 主线程降级取消 | 已实施 | 降级分支复用 runner 异步出口（128 步/片 + macrotask 让出），取消在下一片生效、半成品种子不计入统计；本机实测取消 11~73 ms、输入延迟 p95 ≤ 5 ms（真实点击取消用例 + `worker-contract`） |
| SW-11 可访问性与窄屏 | 部分实施 | 窄屏文档目录改 `<details>` 折叠（首屏即见正文）、纯键盘往返与焦点归还、根字号放大的实测记录、Ctrl+K 搜索转义反例；**读屏抽查、真实浏览器字体设置路径与人工视觉判定未做**（逐条记在 `ACCESSIBILITY-ACCEPTANCE.md`） |
| SW-12 职责拆分与覆盖 | 部分实施 | 已拆出 `ui/doc-search.ts`（纯函数 + 6 项契约 + 冒烟覆盖，顺带修掉查询串注入）；**校准栈/装配层其余部分未拆** |

仍未完成的事（不许被上面的表格掩盖）：

1. 跨平台 CI 轮次（需授权推送后运行）与 `register-ci-run` 的真实运行登记。
2. SW-09 的减重阶段（目标：按冻结基线的聚合预算留 10% 余量 ≈ 244.8 KiB gzip；当前 266 KiB）。
3. SW-11 的读屏、真实字体设置路径与人工视觉判定。
4. SW-12 的装配层拆分（`src/main.ts` 仍约 350 KB 源码，占主包归因的第一位）。

## 架构速览

| 文件 | 职责 |
|---|---|
| `src/core/quat.ts` | Hamilton 四元数、指数积分、Euler／轴角／Slerp、旋转与矩阵 |
| `src/core/world.ts` / `imu.ts` / `scenarios.ts` | 真值世界、IMU 误差模型与机动剧本 |
| `src/estimators/index.ts` | 五算法统一接口与遥测（修正项遥测见 SW-02） |
| `src/core/solve-loop.ts` | UI／runner／Worker 共享解算抽帧、FIFO 分拍、粗对准与校准链 |
| `src/core/runner.ts` | 无 DOM 单种子、trace、**异步出口（片预算 + shouldCancel）**、批量统计与取消内核 |
| `src/core/replay*.ts` / `truth-track.ts` | CSV 解析（显式时间单位）、有效时间轴、背压播放与真值插值 |
| `src/core/experiment-config.ts` / `experiment-archive.ts` | 配置 schema、迁移、规范化与档案解析（同一份白名单） |
| `src/core/archive-ui.ts` | 档案控件写入计划、量化（网格内夹取）与预测读回 |
| `src/core/transport-session.ts` / `reconnect.ts` | API 会话所有权、隔离队列、释放与重试策略 |
| `src/ui/doc-search.ts` | **文档全文搜索纯函数**（索引/打分/片段/转义/键盘移动） |
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

- 软件质量评价：[`QUALITY-SOFTWARE-ONLY.md`](QUALITY-SOFTWARE-ONLY.md)
- 软件路线图：[`ROADMAP.md`](ROADMAP.md)
- 具体实施方法：[`SOFTWARE-IMPROVEMENT-PLAN.md`](SOFTWARE-IMPROVEMENT-PLAN.md)
- 可访问性／窄屏验收记录（含未测项）：[`ACCESSIBILITY-ACCEPTANCE.md`](ACCESSIBILITY-ACCEPTANCE.md)
- 既有验证记录与边界：[`VERIFICATION-EVIDENCE.md`](VERIFICATION-EVIDENCE.md)
- 历史审查：[`QUALITY-AUDIT-HISTORY.md`](QUALITY-AUDIT-HISTORY.md)
- 产品与文档变更：[`CHANGELOG.md`](CHANGELOG.md)
- 外部资料：[`RESEARCH-NOTES.md`](RESEARCH-NOTES.md)

<!-- current:end -->

<!-- history:begin 历史细节由 QUALITY-AUDIT-HISTORY 与 CHANGELOG 承载 -->

## 历史说明

旧轮次报告、满分自评与路线图结论是历史记录，不再视为当前承诺。后续复核已经发现新的内部反例，软件结论以本页、`QUALITY-SOFTWARE-ONLY.md` 与软件实施方案为准。

原始报告仍可通过Git历史读取。此处只保留精简恢复入口，不复制多轮历史门禁数字。

<!-- history:end -->
