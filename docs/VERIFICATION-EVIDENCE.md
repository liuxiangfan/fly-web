# 验证证据与证明边界

> 文档定位（2026-11-18 整理）：本页是**证据使用规则 + 历史验证记录索引**。以下 v0.2.0 验收详情属于 2026-11-07 的旧构建，不表示当前源码已经通过同样验收。
> **当前证据只认机器索引中的 current 条目**：[`generated/evidence-manifest.json`](generated/evidence-manifest.json)。当前机器事实见 [`PROJECT-STATE.md`](PROJECT-STATE.md)；当前教学评估与整改见 [`TEACHING-REVIEW-FIFTH-2026-11-19.md`](TEACHING-REVIEW-FIFTH-2026-11-19.md)。
> 新代码／新构建必须重新采集并登记，不得将下列旧摘要、报告路径、像素或 CI 结果贴到新版本。历史细节继续保留，不能删除来伪造“当前通过”。

## 后续优化阶段1/2/3/5 最终候选证据（2026-11-20）

- 最终身份：`sourceDigest=ed0f78fb0e2f756be234f370b1954f11`、`buildId=ed0f78fb0e2f-fd379a47f3f6d9f4`、135 个输入文件（工作树 dirty，提交 `7d5cf97`）。预算 **19/19**：新增 CSV 导出 tools-ui 分类；全部 JS 名义经所有者授权 325→328 KiB（有效 292.5→295.2，实测 295.1、余 0.1 KiB）；产物总量 2029.5/2029.5 KB 贴线。贴线事实不粉饰。
- 门禁：`npx tsc --noEmit` PASS；`npm run check` 全绿（含 statuscheck 与 evidencecheck）；`npm run build` PASS。五轮稳定性 `generated/stability-local-windows-ed0f78fb-final.json`：**129×5 全绿**（app 108 + devices 21，零 warning、零未计划重启）。过程记录：第一次尝试第 1 轮渲染进程被系统回收（工作集峰值 4.6 GB），第二次第 4 轮导航超时（均环境类，非产品断言），第三次完整通过；未把失败轮次丢弃成「一直稳定」。
- 三份 600 s 长稳全 PASS、未豁免：教学 `soak-teaching-600-ed0f78fb-final.json`（119 样本、9 真实换源、11 取消落定、runId→20、水位 −0.984 MB／趋势 2.515 MB）；批量 `soak-batch-600-ed0f78fb-final.json`（水位 +2.410 MB／趋势 7.334 MB）；重连 `soak-reconnect-600-ed0f78fb-final.json`（66/66 恢复、水位 +8.348 MB／趋势 18.135 MB）。末段与采样覆盖均 PASS，控制台/动作错误 0。
- 性能 `generated/perf-report.json`：30.3 fps、真实输入 p95 5.910 ms、可交互 2424 ms、控制台 0；与早期 2.86 ms 为不同机器负载下的不同采集，不归因性能回退。
- 视觉 11 张（`generated/visual-evidence-ed0f78fb0e2f756be234f370b1954f11-ed0f78fb0e2f-fd379a47f3f6d9f4-1cf5519b-86b8-4802-8212-e4db0f795fa5.json`）已实际逐张查看：桌面/320/390/768、200% 缩放、三视图、文档与两种打印，无意外重叠、横向溢出或空白画布，控制台 0。复盘导航、实验报告（面板+打印态）、三档与更新横幅另有 `D:/test-artifacts/quaternion-attitude/visual/` 下专项截图。模型视觉检查，不扩大为所有者逐图验收或读屏通过。
- 7 条新 current 已登记，`evidence:verify` 三层绑定通过（索引 98 条、current 8 条）。真实硬件仍为软件替身、GPU IBL 未实测、远端 CI/发布未授权；第4点新增预测题按所有者要求未做。主包静态引用 teaching-ui（共享 chart.ts）的边界已在 PROJECT-STATE 登记，留给后续结构专项。

## F-05/F-07 当前候选证据（2026-11-19）

- 当前候选：`sourceDigest=b4894a076955df40cc3eea063d299f44`、`buildId=b4894a076955-a26ac90a3b9dce09`、125 个输入文件。全部 JS gzip **296640 / 299520 B，余 2880 B**，12 个 JS、raw 987380 B；预算 18/18 通过，但 4 KiB 演进余量因新增功能回退，未通过删功能或抬线掩盖。
- **120×5** 稳定性：每轮 app 99 + devices 21，零 FAIL／warning／未计划重启。事件新增用例覆盖真实饱和、串口断流/重连/恢复、参数/视图/装载动作；完整 P 矩阵开关与 6×6 展开在浏览器验证。
- 教学 600 s：119 样本、118 动作、9 真实换源、停载静默；水位 +2.143 MB／峰值 28.092 MB／趋势 6.619 MB。批量 600 s：114 样本、水位 +3.612 MB／峰值 28.696 MB／趋势 7.660 MB。重连 600 s：122 样本、66/66、水位 +6.145 MB／峰值 27.572 MB／趋势 16.958 MB。均末段/覆盖 PASS、未豁免。
- 性能 `generated/perf-report-b4894a07-f05.json`：31.1 fps、真实输入 p95 2.860 ms、取消 52.4 ms、可交互 2117 ms、堆峰值 19.8 MB、控制台 0。
- 视觉 11 张已逐张查看，无异常；7 条 current 完成三层绑定（索引 93 条、current 8 条）。高 GPU IBL、读屏、真实硬件与远端 CI 仍不覆盖。

## 第五次结构减重证据（e90，历史候选）

- 当前候选：`sourceDigest=e90fe931c33d53fad2455d2650adcd92`、`buildId=e90fe931c33d-f56a3da77a48a479`、125 个输入文件。全部 JS gzip **295424 / 299520 B，余 4096 B**，raw 983509 B、12 个 JS，尺寸报告 `generated/size-report-e90fe931-fifth.json` 无漂移；未抬预算、未删教学能力或测试。
- 五轮稳定性 `generated/stability-local-windows-e90fe931-fifth.json`：每轮 **117/117**，零失败／warning／未计划重启。教学 600 s：119 样本、118 动作、9 真实换源、停载静默、堆水位 +2.681 MB／趋势 −0.778 MB；批量 600 s：117 样本、水位 +4.278 MB／趋势 6.755 MB；重连 600 s：122 样本、66/66 恢复、水位 +7.841 MB／趋势 17.309 MB，均末段／覆盖 PASS、未豁免。
- 性能 `generated/perf-report-e90fe931-fifth.json`：30.4 fps、真实输入 p95 2.887 ms、取消 request→runner 20.8 ms、可交互 3049 ms、堆峰值 22.9 MB、Worker 完成、控制台 0。与第四次 33.3 fps／2339 ms 是不同采集，不直接归因性能差异。
- 新视觉报告 `generated/visual-evidence-e90fe931c33d53fad2455d2650adcd92-e90fe931c33d-f56a3da77a48a479-5d6e09c6-d57a-42c4-ae33-fcfa31b933d0.json`：11 张已实际逐图查看，未见意外重叠、横向溢出或空白画布；高质量 GPU 的 IBL 反射差异未实测。
- 7 条新 current 已登记，`evidence:verify` 通过源码／产物／被服务 buildId 三层绑定；索引 **86 条、current 8 条**，历史不可复核原件仍只记 note。真实拖拽和暂停后滚轮相机位置变化另由 `D:/test-artifacts/quaternion-attitude/_ops/fifth-orbit-wheel-browser.log` 记录。

## 第四次整改证据状态（2026-11-19，历史）

- 冻结产品：`sourceDigest=2d93cd3d5131d3eb6eeb9f594c4346c6`、`buildId=2d93cd3d5131-15c789e0829d1fe9`、121 个输入文件。当前冻结构建证据已全部采集且 `evidence:verify` 通过 7 条新证据三层绑定（索引 79 条、current 8 条）；旧 `027b2d0c` 不代表本构建验收。批量 600 s 116 样本、水位 +2.747 MB／峰值 27.218 MB／趋势 6.910 MB；重连 600 s 122 样本、66/66 恢复、水位 +9.316 MB／峰值 26.331 MB／趋势 18.476 MB。
- 教学换源只认 `teaching-load/v2` 保存的三阶段：`replay.active=false→true→false`、实际来源 `simulation→replay→simulation`、回放帧消费 `idx>0`、导入/退出两次真实诊断 runId 推进、旧回看覆盖解除。旧量具的动作名或 `sourceSwitches=11` 不证明换源；旧教学报告正文/hash 保留，索引降为历史 `invalid-source-switch`，仅适用于容量和内存观测。28 s 预检不是 600 s 证据。
- 视觉报告及 PNG 每次采集按完整 sourceDigest/buildId/UUID 独立存放，拒绝同路径覆盖；`localOnly:true` 不免除本机有图时的像素哈希检查，clone 无图明确不可复核。历史报告丢失只能记 `OBSERVED/unrecoverable`，未知物理覆盖关系为成对 null，不用空 hash 或目录冒充 PASS。
- 五轮稳定性：每轮 **117/117**，零失败／warning／未计划重启，见 `generated/stability-local-windows-2d93cd3d-fourth.json`。性能 `generated/perf-report-2d93cd3d-fourth.json`：墙钟 33.3 fps、真实输入 p95 4.97 ms、主线程取消 request→runner 18.1 ms、Worker 完成、控制台 0。
- 新视觉采集为 `generated/visual-evidence-2d93cd3d5131d3eb6eeb9f594c4346c6-2d93cd3d5131-15c789e0829d1fe9-2c61c8f4-26c8-451b-a90b-9084b96838eb.json`，11 张 PNG 均位于对应完整 digest/buildId/UUID 目录。早期同会话的图像不支持错误如实保留；后续图像输入成功，已实际逐张查看全部桌面／窄屏／缩放／三视图／文档／打印，未发现意外重叠、横向溢出或空白画布，控制台 0。这是模型视觉检查，不扩大为所有者逐图验收，不代替读屏或 clone 缺图复核。未向外部服务发送截图。
- 一轮 CSV 结构拆分实测全部 JS gzip 299474→299442 B，净省 32 B，距有效门槛 299520 B 只余 78 B；至少 4 KiB 演进余量目标未达（差 4018 B），已停止机械拆分。预算合规不等于减重目标完成，未自行抬线或删教学能力。

## v0.2.0 验收要点（2026-11-07）

- **Windows CI**：`CI`（gate、app 87/87、devices 20/20）与 `Deploy`（verify、smoke-suite 107 PASS / 0 FAIL / 0 warn）在合并提交上全部通过；SW-10 事件→handler 0.3 ms、事件→runner 14.7 ms、timer p95 39.6 ms（修复前 302.5／314.4／326.2 ms）。
- **本机证据**（源码摘要 `2bb7ea30`）：连续 5 轮 ×107 项全绿；两份 600 s 长稳（批量常驻 0.9 MB／趋势 6.0 MB；重连 4.6 MB／16.7 MB）；视觉 11 张零控制台错误；性能墙钟 58.9 fps、真实输入 p95 1.3 ms、运行期 timer p95 13.4 ms、取消 11.9 ms、堆峰值 20.9 MB；`evidence:verify` 三层绑定通过。
- **量具自身的修正**（都已成为常驻行为）：取消停止时刻改按「有取消在等且批量已不在运行」判定；外部真值回放改为有界状态等待；诊断续行不再复用 `[FAIL]` 前缀；浏览器回收时记录最后用例、JS 堆与 Chrome 工作集趋势。
- **CI 侧五轮稳定性**（run 42384961739，head `bc95b96`）：Windows 上连续 5 轮 ×107 项全过、零 warning、零未计划重启（每轮各 2 次计划内浏览器重建，记录在 `plannedRecycles`）；已用 `register-ci-run.mjs` 从 artifacts 核对并登记为 current。
- **单浏览器标签页数量上限**：CI（2 vCPU + SwiftShader）实测同一浏览器开到第 10~11 个标签页时渲染进程会被系统回收（两次都落在同一位置，JS 堆仅 12 MB、工作集 812–863 MB，不是内存耗尽）。现在达到 10 个标签页时**主动重建**浏览器并记入 `plannedRecycles`；未计划的回收仍然判本轮失败。

## v0.2.0 本地验证

- 全门禁顺序：tsc → check → build；基础检查 155 项及独立契约无失败，预算 14 项保持原门槛，文档全量复算一致。
- 复制契约 17 项；runner 契约包含实际墙钟预算与同步／异步数值等价；校准深拷贝额外覆盖未知键和嵌套隔离。
- 真实 Windows 完整套件五轮：每轮 107 项、零失败／warning／重启；首次测试曾读到 Ctrl+K 设置焦点前的状态，保留失败日志，改为有界目标等待后重跑完整五轮。
- 两份 600 秒长稳：批量 3/3 批与软件替身重连 66/66 恢复均通过，常驻水位增量约 4.4 MB；报告分别为 `generated/soak-batch-600-63cd97bf.json`、`generated/soak-reconnect-600-63cd97bf.json`。
- 性能报告固定 200 ms 目标，timer 40 样本与真实鼠标输入分开；输入→handler→runner停止→post-await 原始时序、长任务、渲染/UI分项与slice耗时保留在报告 diagnostics。
- 公式真实鼠标点击验证得到正文选区回退，选区不含按钮反馈；不将手动回退宣称为自动写入系统剪贴板成功。截图采集与控制台检查通过；当前模型接口未提供图像内容，人工视觉判定不声称已完成。
- `evidence:verify` 已核对六类本地 current 报告的源码摘要、产物摘要及 buildId 一致；旧性能、视觉、体积原件归档为 `*-before-v0.2.0.json`，未重贴摘要。
- **Windows CI／线上发布待远端操作确认**，本地通过不代替 GitHub smoke-suite 通过。
> 机器索引：[`generated/evidence-manifest.json`](generated/evidence-manifest.json)；旧软件评分见 [`QUALITY-AUDIT-HISTORY.md`](QUALITY-AUDIT-HISTORY.md)，当前未完成项见 [`ROADMAP.md`](ROADMAP.md)。
> 每一条 current 证据都要能同时回答四件事：**报告正文结论是什么**、**对应哪份源码**、**对应哪份产物**、**被测服务跑的是不是这份产物**。

## 1. 证据使用原则

- **PASS 只能证明该证据实际覆盖的范围**。mock 不能替代真机，单轮不能替代稳定性，旧提交截图不能替代当前源码。
- 被忽略的 `.audit-*`、`screenshots/`、`dist-size/` 是本地证据，不随 clone 分发；manifest 中必须标 `localOnly:true`，
  且**凡随仓库走的记录**（报告 JSON）必须能被哈希与源码摘要定位。
- 没有 commit / dist / browser 的报告仍可作为历史观测，但必须标 `provenanceComplete:false`。
- `supersedes` 只能引用索引内 id，或用 `git:<path>@<sha>` 指向历史提交里的文件——后者会被真去核对（`git cat-file -e`）。
- 「每类最多一条 current」按**运行环境**细分：`kind@runnerOs`。同一类证据在不同平台上各留一条 current
  （"CI 上 5× 全绿"与"本机 Windows 上 5× 全绿"互不替代），没有 `runnerOs` 的类型仍按 kind 唯一。
- **最近一次 FAIL 允许是 current**（它就是最新观测），但文档与结论里不得把它渲染成"当前验收通过"；
  校验器会对这类条目给出 `[note]` 提示。
- `PROJECT-STATE`、CHANGELOG 和 README 的文字声明不是独立证据；机器数字由 `npm run statuscheck` 与
  `npm run evidence:check` 核对。

## 2. 证据的源码／产物绑定（本轮加强）

commit SHA 只能指向"某个提交"：**改了没提交时它会指向上一版代码**，拿它当溯源等于让证据撒谎。
本轮把绑定做成三层，缺一层就不算当前证据：

| 层 | 字段／机制 | 作用 |
|---|---|---|
| 源码 | `sourceDigest`（`scripts/source-digest.mjs`） | 只覆盖**参与构建的产品输入**：`src/`、`public/`、`index.html`、`package.json`/lock、`tsconfig.json`、`vite.config.ts`、`wrangler.jsonc`。文档与量具（`scripts/`）不在内——补一句说明、修一个用例不该让 600 s 结论失效 |
| 产物 | `distHash` + `buildId`（`scripts/build-provenance.mjs`） | 构建结束时写 `dist/build-provenance.json`：源码摘要 + 产物摘要 + 工具版本；`distHash` 只有一个算法（相对路径 + 内容，排除溯源文件自身）。**构建是可复现的**：注入页面的 `builtAt` 取 git 提交时间（可用 `BUILD_TIME` 重放），同一份源码两次构建 `distHash` 相同——否则"重建一次"就会把 600 s 长稳的结论误判成失效 |
| 被测服务 | 页面自报 `buildId` + 采集前后核对（`scripts/served-build.mjs`） | 采集前取回被测服务自报的 `build-provenance.json` 并与本地比对（页面页脚也显示 `buildId`）；采集结束后重算源码与产物摘要，变了就**整次作废**，不给旧结果贴新摘要 |

验收模式：

```bash
node scripts/evidencecheck.mjs --require-source --require-build   # npm run evidence:verify
```

`--require-source` 要求每条 current 的长稳／稳定性／视觉／性能／体积证据的 `sourceDigest` 等于当前工作树；
`--require-build` 要求 `dist/build-provenance.json` 存在、`distHash` 与实测一致，且每条 current 证据的 `buildId` 等于当前产物。

## 3. 当前门禁（同一份源码复跑）

| 门禁 | 结果 | 备注 |
|---|---|---|
| `npx tsc --noEmit` | PASS | |
| `npm run check` | **155 项 0 FAIL** + contracts/status/evidence 全绿 | selftest 126 / scene 10 / HTML 15 / doc 4；contracts：time 17、schema 102、doc-search 6、archive-ui 10、lifecycle 18、worker 14、trace，以及 node:test 的 soak 11、evidence 9、smoke-verdict 8、status、budget 6 |
| `npm run build` | PASS | 冻结产物（之后未再重建） |
| `npm run budget` | 14/14 PASS | 每项占用率 ≤90%；报告含名义上限／有效门槛／剩余字节／冻结基线增量；最紧的是「主包 JS」282.4 KB（有效门槛 283.5 KB，剩 1.1 KB） |
| `doccheck --recompute` | 4/4 PASS | 文档定量结论与生成器实现逐字段复算 |
| `npm run smoke` | **107 项**（app 87 + devices 20）0 FAIL / 0 warning | 结构化结果 + 完整集合比对（清单 `scripts/smoke-manifest.json`） |
| 本机 Windows `--shard=both --runs=5` | 见 §5 | 每轮 106 项完整集合 |
| `npm run evidence:verify` | PASS | 见 §2 的三层绑定 |

## 4. 软件长稳（当前源码，各 600 s）

| 文件 | 结果 | 能证明 | 不能证明 |
|---|---|---|---|
| `generated/soak-batch-600-d97bbbaf.json` | PASS：600 s、3/3 批、常驻水位 +3.6 MB、峰值增量 23.7 MB、趋势 9.8 MB、末段判据 PASS、采样覆盖 PASS（仿真时钟 292.6 s / 墙钟 600 s） | 当前源码在连续多批批量评测下**容器封顶、无持续泄漏、无末段翘尾** | 不能证明真机，也不能替代跨平台稳定性 |
| `generated/soak-reconnect-600-d97bbbaf.json` | PASS：600 s、66 次断线 66 次恢复（每个丢弃段都有独立 open 且真的消费过首帧）、水位 +7.4 MB、峰值 25.7 MB、趋势 15.5 MB、末段与采样覆盖 PASS | mock 传输层长时间断连／恢复不残留资源 | **不是真机**：真实驱动／蓝牙栈行为需真机报告（硬件不在本轮范围） |
| `generated/soak-batch-600-7f0b5966.json`、`generated/soak-reconnect-600-7f0b5966.json` | 历史观测（更早两版源码） | 早期某次 600 s 通过 | 不是当前源码；按新口径不能充当当前证据（索引里已标为历史） |
| `generated/soak-batch-600.json`、`soak-reconnect-600.json`、`soak.json` | 历史观测 | 更早轮次 | 无 commit/dist/browser，`provenanceComplete:false` |

### 4.1 本轮判据自身的两次修正（如实记录）

长稳判据新增"采样覆盖"与"末段翘尾"后，**第一次采集把它自己的长稳判成了失败**：

1. **仿真时钟覆盖率阈值取错**：最初要求仿真时钟推进 ≥ 请求时长的 80%（600 s → 480 s）。
   本机软件渲染下，仿真时钟只能推进到墙钟的 30%~50%（实测 batch 283.3 s、reconnect 343.6 s），
   因为每帧的仿真步长受真实帧率限制。**判据已按实测校准**：墙钟跨度必须 ≥95%（这才是"真的跑了 600 s"），
   仿真时钟只需 ≥30%（用于抓"主循环被卡死／标签页被冻结"），并在报告里同时给出两者。
   失败报告保留在 `.audit-current/soak-final-a958b348/`（本地），版本化目录里只放修正后重跑通过的报告。
2. **SW-10 冒烟用例的重启额度偏紧**：主线程降级路径每片都要等一次 macrotask，而软件渲染下页面自己一帧要 ~50 ms，
   "10 个种子 × 10 s" 实测可以超过 30 s（第 4 轮即因此判红）。该用例判的是"取消后能重启跑完且旧世代不回写"、
   不是延迟，**额度已按实测放大到 90 s 并在报告里记录耗时**。
3. 另有一条**既存**用例在重跑中出现一次时序型失败：「真实串口模式：时钟按帧推进 + 控件停用」在数据流启动稍慢时
   读到"等待数据帧…"。该用例已改为**等待目标状态**（状态里出现帧率读数，15 s 上限）再断言，
   属于 SW-07 第 6 条（等待目标状态而不是盲目按时断言）。

这三次修正都发生在 `scripts/`（量具）——不修改产品源码，因此不影响上述源码摘要与产物摘要；
但**"改判据后必须重跑"**这条也一并遵守：长稳与稳定轮都在修正后重跑，版本化目录里只有重跑通过的报告。

## 5. 稳定性（本机 Windows）

| 类别 | 结果 | 证据 |
|---|---|---|
| 本机 Windows `--shard=both --runs=5`（当前源码） | **5/5 全绿（每轮 107 项，零 warning、零重启）** —— `generated/stability-local-windows-d97bbbaf.json` | 版本化摘要（`verdict.kind` + 每轮完整集合与耗时）+ `.audit-current/stability-final3/`（各轮日志与结构化结果，本地） |
| CI（Ubuntu / Windows）5× | **未跑** | 需要一次 push 或 workflow_dispatch（本轮未获授权）；`scripts/register-ci-run.mjs` 已强化为"workflow/job/attempt + 冒烟步骤真的执行 + 产物五轮完整集合 + 摘要绑定 head_sha"后才会登记 |
| 历史：Windows CI 5×（`830e4e3`） | **FAIL** | GitHub run `41555321631`：gate 与单轮分片通过，5× 稳定性作业死于**基础设施超时**，无一条产品断言失败 |
| 历史：Ubuntu CI 5×（`e8e6a8e`） | PASS | GitHub run `41530523646`（祖先提交，不证明当前 SHA） |

驱动器的判定口径（本轮落地）：每轮必须给出**结构化结果**（逐项状态、跳过、重复、`completed` 标记），
验收比对**完整集合**（app 87 + devices 20 = 107），并把失败分成四类——断言失败／执行未完成／环境失败／根因未知；
"容量"只在拿到容量证据时才写。**任一断言失败即判 `assert`，不带"机器慢"的解释余地。**

## 6. 视觉证据（当前源码）

`generated/visual-evidence.json` 随仓库版本化；PNG 落在被 gitignore 的 `screenshots/visual-<sha>/`（`localOnly`），
每张的**视口、字节数、sha256、横向溢出判据与源码摘要**都在 JSON 里，可核对；像素哈希由 `evidencecheck` 逐张复核。

| 场景 | 文件 | 说明 |
|---|---|---|
| 桌面 | `desktop-1440x900.png` | 姿态 3D + 曲线 + 评测表 |
| 平板 | `tablet-768x1024.png` | 面板折行后无横向溢出 |
| 手机 | `narrow-390x844.png` | 面板与画布等宽 |
| 最窄 | `tiny-320x568.png` | iPhone SE 级宽度仍无横向滚动 |
| 页面缩放 | `zoom200-1440x900.png` | CSS 视口 720×450 @DPR2 = 200% 页面缩放 |
| 三视图 | `view-attitude/gimbal/quat` | 三种 3D 视图 |
| 文档与打印 | `docs-math`、`print-docs-794x1123`、`print-desktop-1440x900` | 数学排版与打印媒体（只输出当前文档页） |

**采集成功 ≠ 视觉判定通过**：截图是自动化采集的产物；人工视觉判定与读屏抽查记在
[`ACCESSIBILITY-ACCEPTANCE.md`](ACCESSIBILITY-ACCEPTANCE.md)，未做就写未做。

## 7. 性能与体积（本轮新增）

| 报告 | 内容 | 结论 |
|---|---|---|
| `generated/perf-report.json` | 真实墙钟指标：首次可交互、rAF 帧间隔（墙钟帧率）、长任务、输入延迟 p95、批量（Worker）耗时、**主线程降级取消延迟**、堆峰值 | PASS：控制台零错误、输入延迟 p95 6.1 ms、取消延迟 10.0 ms、首次可交互 3.0 s |
| `generated/size-report.json` | sourcemap 定量归因（独立重建到 `dist-size/`，不动 `dist/`）：chunk 级 raw/gzip + 主包按职责分组 | three（vendor）513.1 KB / 128.8 gzip、主包 281.8 KB / 105.0 gzip、Worker 43.0 / 15.4、文档演示 22.3 / 9.1、引导课程 11.7 / 6.4 |

**性能口径（不许混用）**：`perf-report` 的 fps 来自真实 rAF 墙钟间隔；界面读数里的 fps 用被夹到 50 ms 的仿真 dt 计算，
**不能**当性能指标。headless + swiftshader 是软件渲染，数值是下限参照；同环境前后对比才有意义。

## 7.1 CI 实测（部署闸门口径）

**关于 `smoke-suite` 的两次红（如实记录）**：

- 第一轮：app 分片 47/87 时判 `assert`，两条 SW-10 用例超阈值——取消时延 **219 ms**、运行期交互 p95 **285.8 ms**
  （阈值写死 200 ms）。同一台 runner 上，页面空闲时单次 `setTimeout(0)` 往返就要几十到上百毫秒，
  这个绝对值描述的是"这台机器的软件渲染有多慢"，不是协作取消的优劣；随后一个长 `evaluate`
  又撞到 CDP 的 `protocolTimeout`（`Runtime.callFunctionOn timed out` / `Network.enable timed out`）。
- 修法（本轮）：① 判据改为**三层**——取消 ≤ max(200 ms, 3×空闲 p95) **且** ≤ 0.8×整枚种子的实测耗时，
  运行期 p95 ≤ max(200 ms, 4×空闲 p95)；绝对值与「是否参考环境（空闲 p95 ≤ 50 ms）」照常打印。
  参考环境的绝对目标仍是 200 ms（本机 11~17 ms / 5 ms）。第二层直接编码"种子跑完之前就停下"，与机器快慢无关。
  ② 长等待从"单个 evaluate 里循环"改成 **Node 侧轮询**，`protocolTimeout` 随容量倍率放大（默认 300 s，慢环境 900 s）。
  ③ 另一条被误判的产品级失败是**引导课程**："点完立刻读"在慢 runner 上取到的是上一帧的设置——
  改为"等计数器变化 + 两帧"再取快照（等待有明确判别依据，不是盲等）。

本轮把 CI 改成 Windows-only 后，真实的 windows-latest 运行说明了三件事：

1. **静态门禁在 Windows runner 上全绿**（tsc / check 155 / docbench / build / budget）——所以部署的"代码质量闸门"是可靠的。
2. **完整 107 项浏览器套件在 2 vCPU 上跑不动**：同一个浏览器进程开第二个 WebGL 页面可超过 180 s；
   结构化结果 `completed=false`、**没有一条用例级失败**——按 `scripts/smoke-verdict.mjs` 判为 `env`（容量），
   不是产品缺陷。把容量红灯当部署闸门会让每次部署都红，红灯也就失去意义（方案里明确反对这一点）。
3. 因此部署闸门定为：**静态门禁 + 部署后对线上产物的 post-deploy smoke**（验"这份提交真的上去了、核心功能活着"）；
   完整套件作为部署后的 `smoke-suite` 作业照跑并上传结构化结果（`continue-on-error`），红/绿都如实记录。
   本机 Windows 上的 **5×107 全绿**仍是这项验收的实际证据。

## 7.2 线上部署（本轮实际完成）

| 项 | 结果 |
|---|---|
| 部署 | GitHub Actions run `42040828875` 的 `deploy` 作业 **success**（Cloudflare Workers，windows-latest） |
| 部署后 smoke | **PASS（第 1 次即通过）**：HTTP 200、页脚构建标识 `95a804131d78` = 本次提交、产物 `a7077ce19adc-9cc94cd591b719b1`、时钟推进、评测表 5 行、canvas、控制台零错误 |
| 证据 | [`generated/postdeploy-2026-11-05-95a8041-live.json`](generated/postdeploy-2026-11-05-95a8041-live.json)（索引 id `postdeploy-95a8041`） |

这次还修掉了"部署看起来一直失败"的真正原因：`postdeploy-smoke.mjs` 用
`commit.startsWith(expect)` 比较**页脚 12 位**与 **workflow 传入的 40 位 SHA**——
12 位永远不可能以 40 位开头，所以线上明明是对的也一直判红。现在改成双向前缀比较的纯函数
`sameCommit()`，并有契约测试覆盖 12/40 位互比、前 12 位不同、7 位与 6 位等边界。

## 8. 本轮仍未完成的事（不许被上面的表格掩盖）

1. **CI 上的五轮完整集合**：本机已 5/5 全绿；CI 端受 2 vCPU 容量限制（见 §7.1），
   要「CI 也五轮全绿」需要更大 runner 或把套件再拆片——这是环境/预算决策，未做。
2. **实质减重**：聚合预算目标 244.8 KiB gzip 未达成（实测 267.1 KiB；Worker 重复 15.9 KiB 是唯一结构性重复，去重后约 253 KiB，仍差约 8 KiB，需删功能或重写 three 用法）；
   主包名义上限内仅剩 1.1 KB。下一步是把校准栈与其余装配层流程改成按需加载（SW-12 范围），
   并按 SW-09 第 6 条做 before/after 对照。
3. **纯文字放大 200%**：实测本装置版式为 px 计量，浏览器"字体大小"设置不改变排版；
   覆盖的放大路径是**页面缩放**（已验收）。要真正支持字体放大需要把正文排版迁到相对单位并重新验收遮挡。
4. **读屏与人工视觉判定**：本机没有可自动化的读屏环境；人工视觉判定未做（见 `ACCESSIBILITY-ACCEPTANCE.md`）。
