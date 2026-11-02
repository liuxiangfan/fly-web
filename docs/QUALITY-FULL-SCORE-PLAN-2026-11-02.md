# 满分质量整改任务书 · 四元数姿态解算学习演示装置

> 审查日期：2026-11-02  
> 评分基线：提交 `d6c4a22`（`round12-quality-fixes`）  
> 当前基线得分：**84 / 100**  
> 目标：修复本报告中的正确性、事务性和硬件生命周期缺口，使各维度达到可复核的满分标准。
>
> **重要边界**：本报告记录的是对 `d6c4a22` 的审查结论。报告编写时工作树可能已经包含后续未提交修复；
> 未提交代码、未完整复跑的测试或“已经开始修改”都不能当作问题已解决。后续模型必须以实际 diff、定向红→绿反例、
> 完整门禁输出和提交记录为证据，逐项更新本报告的状态。
>
> **整改状态（2026-11-02 实施轮）**：P1-1…P1-6、P2-1…P2-4 已修复并各带永久反例；
> P2-5 部分完成（门禁不再假绿 + 状态等待，未拆 shard、无 Ubuntu CI 多轮证据）。
> 真机 30 min 与「视觉证据绑定当前 commit」两项**仍未完成**，见第 9 节。**不要**把本页当成满分结论。

---

## 1. 给后续模型的阅读顺序

1. 先读 [`PROJECT-STATE.md`](PROJECT-STATE.md)，了解当前架构、坐标系、命令与机器计数区域。
2. 再读本文，按第 5 节的 P0/P1/P2 顺序修复，不要先增加新功能或教学页。
3. 涉及时间调度时，同时读：
   - `src/core/replay-player.ts`
   - `src/core/solve-loop.ts`
   - `src/core/runner.ts`
   - `src/main.ts` 的 replay / `onSolveDefault` / `onFrame`
4. 涉及档案时，同时读：
   - `src/core/experiment-config.ts`
   - `src/core/experiment-archive.ts`
   - `src/core/calibration-validation.ts`
   - `src/ui/calib-panel.ts`
   - `src/main.ts` 的 `currentExperimentConfig` / `applyArchiveChecked`
5. 涉及设备时，同时读：
   - `src/core/transport-session.ts`
   - `src/main.ts` 的串口/BLE连接、重连、断开与切源事务
6. 每修一个问题，先保存能打红旧实现的反例，再修生产代码；不允许只改测试期望。

---

## 2. 评分方法与当前得分

| 维度 | 当前 | 满分 | 判定口径 |
|---|---:|---:|---|
| 功能与教学完整性 | 18 | 20 | 五算法、A/B、校准、INS、批量、回放、万向节、四元数和文档是否形成可操作因果链 |
| 数值与时间语义 | 12 | 20 | 原始时间、有效时间、解算子步、真值、记录和统计是否同口径 |
| 档案与数据完整性 | 10 | 15 | 导出/导入是否规范化等价；失败是否真正原子；parser 接受的数据是否都可应用与渲染 |
| 连接与资源生命周期 | 9 | 15 | setup/open/read/cancel/release/close/GATT 是否有界、可重试、无旧会话污染 |
| 测试与门禁可信度 | 12 | 15 | 负例是否打生产路径；门禁能否假绿；是否稳定复现而非偶然通过 |
| UI、教学体验、可访问性 | 14 | 15 | 桌面/窄屏/文档/打印/键盘/文本等价视图是否清晰可读 |
| 性能、文档与交付工程 | 9 | 10 | 首屏与总量预算、状态文档、CI、长稳证据和部署证据是否完整 |
| **总分** | **84** | **100** | 功能完成度高，但仍有影响结论可信度的 P1 问题 |

> 上表是**审查基线**（`d6c4a22`）。整改后的逐项状态与证据见 **第 9 节**（含剩余缺口与不能声称满分的两项）。

### 2.1 已确认的强项

- 教学与数字对照很完整：五算法、真值/误差、A/B、门控、校准、INS、批量统计、回放、文档均已接线。
- `npm run check` 在审查基线上为 161 个 `[PASS]`、0 `[FAIL]`；时间/schema/lifecycle/Worker/trace/soak/status 都有独立契约。
- `npm run build`、14 项预算和 `doccheck --recompute` 通过；主包 gzip 约 100 KiB（上限 108 KiB）。
- 两份 600 s 软件报告存在且结构完整：batch 3/3 批；reconnect 54 次断线、54 次逐段恢复。
- 桌面 1440×900 与窄屏 390×844 当前预览可读；运行时观察约 41 FPS，短观察窗口无即时控制台错误。

### 2.2 不得误读为“完成”的证据

- mock 重连和软件 soak 不能替代串口/BLE 真机。
- 一次 `smoke` 通过不能证明稳定：本次审查先出现 **87/90**，立即复跑才为 **90/90**，且浏览器进程被回收并自动重启。
- `PROJECT-STATE.md` 的自述、verify 清单和历史 PASS 数是线索，不是问题已修复的证明。
- 测试通过不能覆盖测试自身写错的判据。例如旧的回退时间测试把 0.10 s 日志积成 0.14 s 写成了“正确期望”。
- 当前工作树中的在途修改没有完整门禁与提交证据，不能在此文档中标为已完成。

---

## 3. 审查时的实际门禁结果

严格链路：

```text
npx tsc --noEmit                    通过
npm run check                       通过（161 [PASS] / 0 [FAIL]）
npm run build                       通过
npm run budget                      通过（14/14）
npx tsx scripts/doccheck.ts --recompute  通过（4/4）
npm run smoke                       第一次 87/90；立即复跑 90/90，伴随浏览器重启 warning
```

第一次 smoke 的三个失败：

1. 全帧原始 IMU：记录 50 帧，但导出 0 数据行。
2. 协调转弯：2 s 真值位置只有 0.38 m（期望 >1 m）。
3. 严格读锁：close 失败 10 次，重连后 `serial=false`、打开端口仍为 1。

这些失败随后消失，说明当前门禁存在时序、页面状态或浏览器资源敏感性。达到满分前必须消除，而不是只接受复跑绿色。

---

## 4. 已确认问题与复现标准

### P1-1：日志时间回退仍会重复积分

**位置**：

- `src/core/replay.ts`：少量时间回退被接受
- `src/core/replay-player.ts`：有效时间轴构造
- `scripts/time-contract.test.ts`：回退测试

**审查基线行为**：

41 帧，正常时间 `0…400 ms`，将第 20 帧由 200 ms 改为 150 ms；陀螺固定 90°/s。

```text
原始覆盖跨度：0.40 s
实际 duration / played / integrated：0.44 s
实际纯积分偏航：39.6°
物理期望：36°
```

原因：负间隔被夹为 0，但后续又从回退值重新累计，已经覆盖的时间段被积了第二遍。

**旧测试盲区**：旧测试把 `0→50→90→50→100 ms` 的 0.10 s 时间轴期待成 0.14 s，只验证 `duration == played == integrated`，没有验证不重叠。

**满分修复标准**：

- 严格回退要么拒绝，要么使用历史最大时间构造单调有效时间轴。
- 重复时间戳可以保留，dt=0。
- `Σdt` 必须等于单调覆盖跨度，不能超过。
- 加 1 次、多次、末帧回退、重复时间戳四类永久测试。

### P1-2：长间隔分拍时，外部真值提前跳到帧末

**位置**：

- `src/main.ts`：`stepReplayPlayback`
- `onSolveDefault`
- `referenceQ` / `truthWaveforms`

**复现**：

日志两帧：`t=0/10 s`；真值偏航 `0°/90°`；陀螺 `9°/s`；最快档，每拍最多积分 5 s，子步 ≤50 ms。

审查基线在源帧刚入队时就把 `state.externalTruth` 设为 90°：

```text
t=0.05 s：估计约 0.45°，真值已显示 90°，假误差约 89.55°
t≈5 s：估计约 45°，真值仍显示 90°，假误差约 45°
```

**影响**：外部真值误差、真值重力/磁波形、差分角速度和统计。

**满分修复标准**：

- 保存相邻源帧的前/后真值。
- 每个解算子步按 `qSlerp(qPrev,qNext,α)` 获取该子步真值。
- 真值角速度与波形使用同一有效时间轴。
- 增加 10 s 长空洞的生产浏览器用例：完美角速度日志的均值误差接近 0，不允许只测“外部真值选项可用”。

### P1-3：档案失败回滚不是真正原子

**位置**：

- `src/main.ts`：`applyArchiveChecked`
- `applyArchiveConfig`
- `resetExperimentBaseline`
- `resetSim`

**复现输入**：

先积累曲线、记录和校准历史，开启 A/B；从页面自身导出档案，仅把 `config.imu.gyroBiasDps` 改为超出滑块范围的值。

**审查基线行为**：

- 先真正应用档案、触发控件事件和 reset。
- 读回发现被夹值，再应用旧配置。
- 配置值恢复了，但曲线、统计、记录、校准历史、采集样本、回放游标和 A/B 运行期状态已经丢失。
- 提示“已保持原配置”与实际不符。

**满分修复标准**：

- 在触碰活状态前完成 schema、规范化、UI 可表达性和渲染安全检查。
- 推荐实现“探测写入”与“破坏性提交”分离：验证阶段不得 reset、不得清历史。
- 失败导入后逐项断言：simTime、曲线点数、logRows、rawRows、校准历史、A/B、回放游标均不变。
- 异常路径和用户/自动化入口共用同一事务。

### P1-4：合法校准档案可在 UI 渲染阶段抛错

**位置**：

- `src/core/calibration-validation.ts`：允许 `validation.ratio === null`
- `src/core/magcal.ts`：训练残差为 0 时产生 NaN
- `src/ui/calib-panel.ts`：直接 `ratio.toFixed(2)`

**复现**：96 点依次重复六个轴向点，训练残差为 0；ratio 为 NaN，JSON 后为 null；parse 接受，UI 渲染时报：

```text
TypeError: Cannot read properties of null (reading 'toFixed')
```

且异常可能发生在新校准已挂载、旧历史已清空之后，绕过回滚。

**满分修复标准**：

- ratio 为 `number | null` 时，null 显示“—（不适用）”。
- parser 接受的每一种对象都必须可安全渲染、应用和再次导出。
- 新增纯函数渲染测试和浏览器档案导入测试。

### P1-5：串口释放失败后丢失可重试会话

**位置**：

- `src/core/transport-session.ts`
- `src/main.ts`：`serialDisconnect`、`dropSerialSession`、自动重连/切源

**审查基线行为**：close 暂时失败时，`dispose()` 返回 false；但 main 已清除 session/port/lastPort，并忽略 false。物理端口仍开着，代码失去引用，驱动恢复后无法再 close。

**满分修复标准**：

- close=false 的会话进入 `pendingCleanup/quarantine`，保留强引用。
- 后台有界退避重试，直到真正 close 或明确终止。
- 新连接前必须确认同句柄旧 lease 已释放。
- UI/调试出口显示待清理数；正常态必须为 0。
- 测试“先失败、驱动恢复后自动关闭”，不能由测试手工拿旧引用再调用 dispose 来冒充生产恢复。

### P1-6：setup/open/close/GATT 仍有不落定 Promise 路径

**审查基线**只给 reader cancel/readDone 有界等待；setup/open/GATT/close 无界时，释放事务仍可永久挂起。

**满分修复标准**：

- setup/open/GATT discovery/close 均有超时与明确状态。
- 迟到的 open 成功必须发现 session 已 disposed，并立即自行 close。
- close 超时不能谎称已关闭；后续成功要修正 openPorts 记账。
- 新增三类契约：setup 永不落定、close 永不落定、close 迟到成功。

### P2-1：被忽略的档案字段实际会改变算法结论

`steadyFromSec` 和 `autoCoarseAlign` 不能作为纯展示字段忽略：前者改变稳态 RMSE，后者会重置姿态并改变全程 RMSE。

已复现同 seed/同输入，仅切粗对准与稳态窗口：

```text
互补 RMSE：34.2785° → 20.9912°
稳态 RMSE：34.2785° → 0°
```

**满分标准**：两者进入活状态、导入恢复和读回比较；若 UI 无控件，可由档案直接写内核状态，但必须在状态提示中可见。

### P2-2：默认配置、可选字段和 UI 读回没有统一规范形态

审查中发现默认档案可能出现：

- `pure.magEnabled: false → true`
- `kalmanResetCov: 缺失 → false`
- `magTargetUts: 50 → 缺失`

**满分标准**：定义唯一 canonical form；默认配置自身应满足：

```text
buildArchive(defaultConfig) → parse → apply → readback → deepEqual(canonical)
```

full/diag kind、matrix、target field 也必须同构。

### P2-3：通用 runner 配置被 UI 档位收窄

runner 可以正确运行 200 Hz，但通用配置 validator 因 UI 下拉没有 200 Hz 而拒绝。

**建议**：分为两层：

- `RunnerConfig`：内核支持的物理范围。
- `UiArchiveConfig`：UI 能表达的离散选项。

不要让 UI 枚举成为数值内核的通用 schema。

### P2-4：保护参数缺少统一的有限整数校验

已复现：

- `maxFramesPerTick: NaN` 可导致一帧不消费。
- `Infinity` 取消上限。
- `runTrace(..., NaN)` 失去上限。
- `maxSteps=1.5` 记录 2 步。

**满分标准**：所有 max/cap/steps 参数统一要求有限非负整数；非法值明确拒绝或回落默认值，并有测试。

### P2-5：浏览器门禁不稳定

同一提交、同一环境：第一次 87/90，紧接着 90/90；成功轮伴随：

```text
[warn] 新建标签页失败（Target.createTarget: Session with given id not found）——重启浏览器后重试
```

**满分标准**：

- 拆分冒烟 shard，减少一个浏览器连续创建大量 WebGL 页。
- 每组独立 page/context，避免跨用例状态污染。
- 用具体状态等待替代固定 sleep。
- 浏览器重启时重跑当前 shard，或判基础设施失败；不能从中段继续并把 warning 当全绿。
- Windows 与 Ubuntu CI 各连续 5 次 90/90，零 warning、零重启。

---

## 5. 建议实施顺序

### S0 · 固化红测试（必须先做）

- 回退时间不重叠。
- 10 s 长间隔外部真值逐子步插值。
- 档案失败后完整现场不变。
- `ratio:null` 可渲染。
- close=false 后生产代码自动重试。
- setup/close 永不落定有界返回。

停止条件：每个反例都能在旧基线失败；不能只写与实现同构的正向测试。

### S1 · 时间与真值

修复有效时间轴、TruthTrack、真值波形和误差基准，跑 time/trace/browser 定向测试。

### S2 · 档案事务与 canonical form

先验证后提交；统一默认字段；恢复稳态窗口和粗对准；增加失败现场不变的浏览器契约。

### S3 · 连接释放事务

setup/close/GATT 超时；失败会话 quarantine；后台重试；生产重连测试和真机脚本。

### S4 · 门禁稳定化

拆 shard，消除固定 sleep 和跨页状态；连续多轮验证。

### S5 · 真机与发布证据

串口/BLE 各 30 min；PR/CI；线上部署后 smoke；回滚演练。

---

## 6. 满分验收矩阵（100/100）

### 6.1 数值与时间（20/20）

- 时间回退拒绝或单调规范化，无重叠积分。
- duration/played/integrated/日志覆盖跨度同口径。
- 外部真值逐子步插值。
- UI、runner、Worker、回放在同输入下逐子步对拍。
- 本报告 P1-1/P1-2 全部有生产红→绿证据。

### 6.2 档案与校准（15/15）

- 无效档案在提交前被拒绝，现场完全不变。
- 任一异常都能保留/恢复曲线、记录、历史、A/B、回放和算法运行态。
- parser 接受的所有对象都能渲染、应用、导出。
- 导出→导入→再导出达到 canonical 深等价。
- 粗对准、稳态窗口和默认可选字段均可复现。

### 6.3 设备生命周期（15/15）

- setup/open/read/cancel/release/close/GATT 全部有界。
- close 失败不丢 session；后台恢复后自动关闭。
- 旧会话不能污染、清理或关闭新会话。
- 串口/BLE 各 30 min 真机：拔插、离开范围、设备复位、睡眠唤醒、被其它程序占用。
- 最终 openPorts=0、pendingCleanup=0、监听器=0、无 unhandled rejection。

### 6.4 门禁稳定性（15/15）

- 所有本报告 P1 反例进入 `npm run check` 或 smoke。
- Windows 本地连续 5 次完整冒烟全绿、无 warning。
- Ubuntu CI 连续 5 次全绿、无重启。
- 浏览器进程失败不会从中段继续伪造完整通过。

### 6.5 长稳与性能（10/10）

- 600 s batch/reconnect 报告包含 commit SHA、dist hash、浏览器版本、参数和起止时间。
- 堆判定同时检查起点→终点、线性趋势和峰值。
- 主包与全部 JS 至少保留 10% 余量（当前全部 JS 余量约 4%，尚不满分）。

### 6.6 UI、可访问性与教学（15/15）

- 320/390/768/1440 四档布局。
- 200% 文本缩放。
- 全键盘操作、焦点顺序、屏幕阅读器语义。
- 文档/打印/弹窗/三种 3D 视图有**当前 commit**的视觉证据。
- 所有画布都有等价文本/表格读数。

### 6.7 交付工程（10/10）

- `npx tsc --noEmit → npm run check → npm run build → npm run budget → doccheck --recompute → smoke` 全绿。
- 工作树干净，PR 审查通过。
- 合并到 master，线上页面可显示 build commit。
- 部署后 smoke 与回滚演练通过。
- PROJECT-STATE 只写有实际证据的完成声明。

---

## 7. 每次修复后的必跑命令

最小定向：

```bash
npx tsx scripts/time-contract.test.ts
npx tsx scripts/schema-contract.test.ts
npx tsx scripts/lifecycle-contract.test.ts
npx tsx scripts/worker-contract.test.ts
node scripts/trace-contract.test.mjs
node --test scripts/soak-contract.test.mjs scripts/status-contract.test.mjs
```

最终严格顺序：

```bash
npx tsc --noEmit
npm run check
npm run build
npm run budget
npx tsx scripts/doccheck.ts --recompute
npm run smoke
```

UI 变更后：重新 build、强刷、检查控制台，并保存当前 commit 对应的桌面/窄屏/文档/打印截图。

---

## 8. 完成审计清单（后续模型不得跳过）

在宣布“满分”前，逐项给出实际证据：

- [ ] 本报告所有 P1/P2 已有代码 diff、测试路径和测试输出。
- [ ] 没有把旧的错误期望改名后继续保留。
- [ ] 失败导入不会改变任何现场数据。
- [ ] 时间回退不重叠，长间隔真值不提前。
- [ ] setup/close 永不落定不会挂死；close=false 不丢引用。
- [ ] smoke 连续多轮稳定，无浏览器重启 warning。
- [ ] 真机串口/BLE 30 min 报告存在，非 mock。
- [ ] 视觉证据绑定当前 commit。
- [ ] 长稳报告绑定 commit/dist/browser。
- [ ] 完整门禁按严格顺序全绿。
- [ ] 工作树干净，PR/CI/部署后 smoke/回滚均有证据。

如果任一项缺证据，结论只能是“仍在优化”，不能写“各维度满分”。

---

## 9. 整改执行记录与复核证据（2026-11-02 实施轮）

> 整改提交：`8161ef3`（本页的 P1/P2 代码、反例与门禁输出都包含在该提交里；本节随后的小修见提交历史）。

> 本节由实施轮写成：每条都给出**产物文件、永久反例、实测输出**。第 6 节的验收矩阵逐项对应，
> 未达成项在 9.13 里明确列出——**本页不声称满分**。

### 9.1 P1-1 时间回退不再重复积分 ✅

- 产物：`src/core/replay-player.ts`（`rebuildTimeline` 改为**运行最大值**单调有效时间轴：回退帧 dt=0，
  后续帧从前驱的历史最大时刻起算，Σdt 恒等于单调覆盖跨度）。
- 永久反例：`scripts/time-contract.test.ts`「时间列回退不得重复积分」——单次回退 `0→50→90→50→100`
  断言 duration/played/integrated 全部为 **0.10 s**（旧实现 0.14 s）；另加多次回退 `0→100→60→80→120` = 0.12 s。
- 实测：`time-contract: 15 PASS / 0 FAIL`。

### 9.2 P1-2 长间隔外部真值逐子步插值 ✅

- 产物：新增 `src/core/truth-track.ts`（`push/commit/at`：相邻源帧前后真值按 `qSlerp` 插值，
  时间跨度非正时取终点值、绝不外推）；`src/main.ts` 的 `stepReplayPlayback`（只登记帧末真值）、
  `onSolveDefault`（**每个子步**取 `replayTruth.at(ctx.t)` 写入 `state.externalTruth`）、
  `onFrame`（帧完成才 `commit()`），`truthWaveforms()` 的重力/磁场投影与差分角速度因此共用同一条子步时间轴。
- 永久反例：`time-contract`「外部真值按子步时刻插值」（t=0.05 s 必须 ≈0.45° 而不是 90°；t=5 s ≈45°；
  越界不外推；提交后终点成为下一帧起点）。
- 生产浏览器反例：`scripts/browser-smoke.mjs`「外部真值回放：基准切到外部真值，且长间隔按子步插值」——
  19 帧 10 ms + 一帧 9.82 s 空洞的**完美日志**，Mahony 平均误差实测 **0.39°**（旧实现在 t≈0.05 s 报 89.55°）。

### 9.3 P1-3 档案失败回滚真正原子 ✅

- 产物：`src/main.ts` 拆成 `writeArchiveState()`（非破坏性探测写入：不 reset、不清历史，
  由 `archiveProbeDepth` 抑制 `resetSim`）与 `commitArchiveRestore()`（只在读回比较通过后清采集状态 + `resetSim`）。
  失败路径只 `writeArchiveState(before)` 把旧配置写回控件。
- 永久反例：新增调试出口 `attitudeDemo.experiment.site()`（simTime / 三图点数 / logRows / rawRows /
  磁校准历史 / A-B 开关与模式 / 回放游标 / seed / steadyFromSec / autoCoarseAlign），
  浏览器用例对三类坏档案（333 Hz、越界滑块、固定轴初始姿态）逐次断言 **现场 JSON 完全不变**。
- 实测：`失败导入后现场不变=true`（现场：logRows 50、rawRows 261、magHistory 5、A/B on）。
- 同一事务里还堵住两个「探测写入会漏掉运行期状态」的出口：
  ① `ab-mode` 的 change 处理器在探测阶段直接返回（旧路径会 `snapshotAB()` 重建 B 组与 `metricsB`，
  失败回滚写回控件也恢复不了它——这正是「失败导入不得改变 A/B 运行期状态」的漏洞）；
  ② 可选的 `steadyFromSec` / `autoCoarseAlign` / `manualTargetDeg` / `ab` / `magTargetUts` 在缺失时
  按**文档默认值**落盘并参与比较（`applyArchiveChecked` 用规范化后的 `want` 比较语义，而不是「键有没有写」），
  于是「少写一个可选键」的合法档案不会被拒。
- 成功导入会**关闭 A/B 并说明**（导入替换的是 A 组参数，旧 B 组不再可比）——与「装载实验基线关闭 A/B」同一约定。

### 9.4 P1-4 ratio=null 可安全渲染 ✅

- 产物：`src/ui/calib-panel.ts` 的 `ratioText()`：`null/NaN/undefined` → `—（不适用）`。
- 永久反例：`scripts/selftest.ts`「校准面板：ratio=null（训练残差为 0，JSON 往返）渲染为「不适用」，
  不得抛错或显示 NaN」（含 `late.ratio`）；浏览器侧「ratio=null 档案可导入可渲染」（导入 ok、读数含「不适用」、无 NaN）。

### 9.5 P1-5 close 失败不丢会话、后台自动重试 ✅

- 产物：`src/main.ts` 的 `quarantineSerialSession()` + `flushSerialCleanup()`（2 s 退避重试直到 `dispose()` 返回 true），
  在 `serialConnect` / `serialAutoReconnect` / `serialDisconnect` / `dropSerialSession` / `cancelPendingReconnects`
  五条路径上接住 `dispose() === false`；新增出口 `plumbing().pendingPortCleanup`（正常态必须为 0）。
- 永久反例：浏览器用例「连接释放：close 失败不丢引用，生产代码后台自动重试直到真正关闭」——
  假端口前 3 次 `close()` 拒绝，用例**不手工再调用 dispose**，只等生产重试；
  实测 `待清理 1 → 0`、`openPorts 1 → 0`、夹具端口 `opened=false`、close 共调用 4 次。

### 9.6 P1-6 setup/open/close 有界 ✅

- 产物：`src/core/transport-session.ts`——`dispose()` 对 `setupPromise` 做 1 s 有界等待；
  `SerialTransportSession.close()` 对 `port.close()` 做 800 ms 有界等待，超时如实返回 false，
  并在后台成功时补记「已关闭」（不让 `openPorts` 永久多 1）；迟到的 `open()` 发现 `disposed` 后**自行 close** 并抛错。
- 永久反例：`scripts/lifecycle-contract.test.ts` 新增三条——「close 永不落定」「同一 tick 内 dispose」
  「open 永不落定 + 迟到的 open 必须自行关闭」，实测 `lifecycle-contract: 10 PASS / 0 FAIL`。

### 9.7 P2-1 被忽略的字段进活状态 ✅

- 产物：`src/core/experiment-config.ts` 的 `ARCHIVE_IGNORED_KEYS` 只保留 `durationSec`；
  `steadyFromSec` / `autoCoarseAlign` 进 `writeArchiveState` 与 `currentExperimentConfig`（活状态 + 读回比较）。
- 永久反例：`schema-contract`「往返比较指出会被界面改写/丢失的字段（durationSec 除外）」断言两者缺失/被改写**必须报出**；
  浏览器往返用例的 `sameConfig` 现在**不再**剔除这两个字段。

### 9.8 P2-2 canonical form ✅

- 产物：`DEFAULT_ESTIMATOR_TUNING.kalman.kalmanResetCov = false`、`magTargetUts = 50`、
  `pure.magEnabled = false`（与界面读回同形）；`currentExperimentConfig` 无标定时也写 `magTargetUts`。
- 永久反例：`schema-contract`「canonical form：默认配置 buildArchive→JSON→parse→再导出 达到逐字节等价」
  （① 解析结果与默认配置 deepEqual；② 再导出 JSON 逐字节相同；③ diag/full 两种校准 kind/matrix 同构）。

### 9.9 P2-3 内核范围与 UI 档位分层 ✅

- 产物：`experiment-config.ts` 新增 `KERNEL_SOLVE_RATE_HZ = {min:10,max:1000}`；schema 层
  （`experimentConfigProblems`）只守物理范围（有限整数），界面层（`archiveExpressibilityProblems`）
  才要求落在 `SOLVE_RATE_CHOICES` 下拉档位内。
- 永久反例：`schema-contract`「内核频率与 UI 档位分层：200 Hz 内核可跑，界面层才拒绝非下拉档位」；
  `selftest` 早已测得 200 Hz 在 500 Hz 仿真下正确（3/2 交替）。浏览器用例里 333 Hz 仍被拒，错误码为
  `solveRateHz（界面下拉只有 500 / 250 / 125 / 100 / 50 Hz；333 Hz 只能由脚本/runner 使用）`。

### 9.10 P2-4 上限参数统一有限非负整数 ✅

- 产物：`ReplayPlayer` 的 `maxFramesPerTick`（NaN → 回落 4000、向下取整）、`runTrace` 的 `maxSteps`
  （NaN → 20000、1.5 → 1）；`SolveLoop.enqueueFrame/drain` 的 `maxSubstep/maxSubsteps/maxSeconds` 原有夹紧保留。
- 永久反例：`time-contract`「保护参数必须是有限正数：NaN/Infinity/小数不得取消上限」
  + trace 截断用例里 `runTrace(cfg, NaN).steps.length === 5000`、`runTrace(cfg, 1.5).steps.length === 1`。

### 9.11 P2-5 门禁稳定化 ◐ 部分完成

- 已做：① `browser-smoke.mjs` 的 `browserRestarts` 计数——浏览器进程被回收后即使续跑全绿，
  文件末尾也会输出 `[FAIL] 浏览器进程被回收 … 基础设施失败` 并让退出码非 0（**不能再从中段继续假装全绿**）；
  ② 把三处「赌墙钟」的固定 sleep 改成状态等待：全帧原始 IMU 记录（等 `raw().rows` 到阈值，且开关改为幂等）、
  协调转弯（等 `world.posNed` 距离 > 1.2 m）、外部真值回放（等 `replay.info.idx >= frames`）、
  严格读锁（等夹具真的拒绝过 close / 等 serial 真的重连上 / 等帧计数真的增长）；
  ③ CSV 导出的三处拦截（全帧源、两档 24/48 列、导出→导入闭环）原来固定等 250/400 ms 就取 `blob.text()`，
  慢机器上一轮实测渲染掉到 4 fps 时读不完，会误报「未生成 / 0 列」——现在轮询等文本落地，
  并把提示条文本一起带回失败详情（是「没生成」还是被产品规则拒绝，一眼可辨）。
- 实测稳定性（**同一 commit + 同一 dist（构建可复现：连续两次 build 的 distHash 相同）连续 5 次**）：
  **91 PASS / 0 FAIL / 0 warning / 0 浏览器重启**，日志在 `.audit-smoke/stab-*.log`（已加入 `.gitignore`，本地证据）。
- 稳定性不是一次就绿，过程中抓到并修掉两类门禁自身的不稳定（正是复核 P2-5 要的「稳定复现而非偶然通过」）：
  ① **CSV 导出异步读取竞态**：三处拦截固定等 250/400 ms 就取 `blob.text()`，慢机器（该轮实测 4 fps）
  读不完 → 误报「未生成 / 0 列 / 导出前已记录 undefined 行」；改为轮询等文本落地，并把提示条文本带进失败详情。
  ② **渲染进程被回收**：`goto` 抛 `Navigating frame was detached`，整条冒烟在最后几项中断
  （该轮之前已 4 次全绿）。新增 `gotoSafe()`：同一页面上重试一次并计入 `browserRestarts`，
  外层 catch 把这类错误显式标成「基础设施失败」——重试只为继续收集诊断，**结论仍判失败**，绝不当成全绿。
- **未做**：拆 shard（一页/独立 context per 用例组）、Ubuntu CI 连续 5 次。因此门禁维度**不能判满分**——
  「Windows 本地连续 5 次全绿」这条满足，但第 6.4 节要求的另一半（CI 多轮 + shard 化）没有做。

### 9.12 本轮门禁实测（严格顺序）

```text
npx tsc --noEmit                      通过
npm run check                         selftest 125 + scene 10 + html 15 + doc 4 = 154 项，0 FAIL
                                      契约：time 15 / schema 98 / lifecycle 10 / worker 13 / trace 11 / soak+status
npm run build                         通过（主包 257.8 KB / gzip 103.5 KB）
npm run budget                        14/14 通过（主包 gzip 101 KB，上限 108 KB；全部 JS 合计 262/272 KB）
npx tsx scripts/doccheck.ts --recompute   4/4 通过（10.2 s 只读复算）
npm run smoke                         91 PASS / 0 FAIL，零 warning、零浏览器重启
                                      连续 5 次（同一 commit / 同一 dist）全部 91/91、零 warning（见 9.11）
node scripts/soak.mjs --batch --seconds=120
                                      PASS：堆 起点→终点 +10.5 MB、峰值增量 10.5 MB（上限 48）、
                                      线性趋势 +5.3 MB（上限 24）；报告已带 commit/dist/浏览器/时间窗溯源
```

### 9.13 视觉验收（绑定提交 `e67f551`）

六张可判读截图，全部在**提交 `e67f551` 的构建产物**上拍摄（该次 `dist` 的 sha256 前 16 位 =
`d7356bc1443a10c4`，构建可复现：同一源码连续两次 build 的 distHash 相同）。
文件按 `.gitignore` 的既有约定留在本地 `screenshots/`（不进仓库），本节记录**路径 + 尺寸 + sha256**，
任何人可以用同一份源码重建并逐张核对：

| 组 | 文件 | 尺寸 | sha256（前 16） | 判读要点 |
|---|---|---|---|---|
| 桌面 | `screenshots/visual-e67f551/desktop-1440x900.png` | 1440×900 | `8f64b785d4f20421` | 左栏四元数/欧拉读数、真值对照、三块曲线与图例读数、右栏控制台；无重叠、无横向溢出 |
| 窄屏 | `screenshots/visual-e67f551/narrow-390x844.png` | 390×844 | `461fc5ff85cee6e6` | 390 px 下正确堆叠（顶栏按钮换行、3D 场景在下、面板单列），无横向滚动 |
| 文档 | `screenshots/visual-e67f551/docs-math-1440x900.png` | 1440×900 | `fb4de0b61e1df463` | 左模块栏 + 中栏正文（公式 `q̇ = ½ q ⊗ ω`）+ 右「本页目录」跟随高亮，浅色主题排版正常 |
| 打印 | `screenshots/visual-e67f551/print-docs-794x1123.png` | 794×1123（A4 比例） | `17a7af4c18eb7ed7` | 打印媒体下应用外壳隐藏、只剩当前文档页；公式与示意图完整 |
| 打印 | `screenshots/visual-e67f551/print-table-794x1123.png` | 794×1123 | `ecac27a97abee3e5` | 打印媒体下的两张表格（「症状→病因→实验」与「对比与选型」）列宽与文字完整，无截断 |
| 打印机（宽） | `screenshots/visual-e67f551/print-docs-1440x900.png` | 1440×900 | `29451e27995c1d20` | 宽视口下的打印媒体（对照：内容随视口重排，外壳仍隐藏） |

> 拍摄方式：`node scripts/shot.mjs`（桌面/窄屏/文档）；打印组用一次性脚本「先在屏幕媒体下打开文档、
> 再 `emulateMediaType("print")`」——顺序反过来会被「打印时隐藏外壳」的规则把文档层一起挡掉
> （`--print` 直接配合 `--do` 时踩到过）。两个一次性脚本用完即删，未进仓库。

### 9.14 冒烟分片与 CI（复核 P2-5 的另一半）

- **分片**：`scripts/browser-smoke.mjs` 支持 `SMOKE_SHARD=all|app|devices`。
  · `app`（72 项）：主页面用例（读数/曲线/文档/档案/导出/批量/trace/可访问性/长跑）；
  · `devices`（19 项）：独立页面用例（假串口 / 假 BLE / 协议端到端 / 加计采面 / 真实串口模式）；
  · 两片**恰好覆盖全部 91 项**（72 + 19 = 91，且两片各自 0 FAIL）。
  分片的动机是复核指出的「一个浏览器连续创建大量 WebGL 页面会被回收」：分片后单进程的页面数与运行时间都降下来，
  CI 上两片并行跑。
- **驱动器**：新增 `scripts/ci-run-smoke.mjs`——自己起 `vite preview`（`--host 127.0.0.1`）、
  探活到 200 才开跑、连跑 N 次、逐次输出落盘、任何一次有 FAIL 或 warning 都判失败。
  这样 Windows / Ubuntu 用的是同一段逻辑（不用在 workflow 里写两套 shell）。
- **workflow**：新增 `.github/workflows/ci.yml`
  · `gate`（Ubuntu）：`tsc --noEmit` → `npm run check` → `build` → `budget` → `doccheck --recompute`；
  · `smoke-shards`（Ubuntu，矩阵 app/devices）：分片并行跑一次冒烟；
  · `smoke-stability`（`workflow_dispatch`）：在 Ubuntu 与 Windows 上各连跑 5 次 `SMOKE_SHARD=all`，
    零 warning、零重启才算过。**为什么只手动触发**：仓库是私有的，稳定性验收一次要吃 ~100 分钟 Actions 配额，
    不该挂在每次 push 上。
- 浏览器候选路径补齐 Linux（`/usr/bin/google-chrome` 等）——旧列表只有 Windows 路径，
  Ubuntu runner 上会直接「找不到 Edge/Chrome」退出码 2。
- **本地实测**：`SMOKE_SHARD=app` 72 PASS / `SMOKE_SHARD=devices` 19 PASS，`SMOKE_SHARD=all` 仍为 91 项。
- **远端实测（GitHub Actions）**：
  · PR #1 的 CI（run `41492894479`）：`gate` + `smoke-shards (app)` + `smoke-shards (devices)` 全部成功（Ubuntu）；
  · 稳定性作业（run `41492896547`，分支 `ci-stability`）：**Ubuntu 连续 5 次完整冒烟全部 91 PASS / 0 FAIL / 0 warning**
    （逐次结果见 artifact `smoke-stability-ubuntu/summary-all.json`）。这一轮跑出了 3 个**只在 Linux CI 暴露**的门禁缺陷，
    都已修掉并保留：
    ① 假 BLE 设备原来是在**页面加载后**才注入的——Ubuntu 的 Chrome 默认不带 Web Bluetooth，应用启动时已把「连接 BLE」
       按钮永久置灰，于是 `click()` 什么都不做（devices 分片 5 条红）。改为 `makeFakeSerialPage({ble:true|'hang'})`
       在 `goto` 之前注入（与既有的 `runBleCase` 一致）。
    ② 「顺序/校准演示在重绘」把**第一帧**也纳入 `painted()`：Ubuntu 第 5 轮首帧墨迹 19200 > 半屏，被判成「不像正常绘图」。
       改为与互补演示同一套判据（丢弃首帧，比较后两次：都画过 + 指纹不同）。
    ③ 「40 s 回放裁剪」等 3 s 墙钟：Ubuntu 第 4 轮只喂进 30 s 仿真时间（判据要 >35）。改为状态等待（等 `simTime ≥ 39`
       或回放游标到末尾，上限 60 s）。
- 另外把「候选浏览器启动失败 → 试下一个」从 `[warn]` 降为 `[info]`（可预期回退，不是浏览器被回收），
  puppeteer 的 launch 超时 30 s → 60 s（CI 冷启动偶发 WS 超时）。
- **Windows CI（`windows-latest`）实测未通过**（run `41497738131`，5 次最好 34 项后就中断）：两类环境性失败——
  ① `Target.createTarget timed out`（浏览器进程被回收，门禁**正确判为基础设施失败**，没有伪装成绿）；
  ② 启动 30 s 内 `#fps` 未就绪 / 页面交互超时（该 runner 只有 2 vCPU，WebGL + swiftshader 初始化明显更慢）。
  另有一次批量评测因 Worker 未能在看门狗窗口内启动而回退到主线程（界面行为是正确的降级，但该用例断言「执行路径=worker」）。
  这一项**留作未达标**：不在本机复现，也没有在 CI 上把它调绿；不通过放宽断言来「修好」。

### 9.15 仍未达标（不得写成「各维度满分」）

| 未达成项 | 现状 | 为什么不能算满分 |
|---|---|---|
| 真机 30 min（串口/BLE，拔插/离开范围/休眠/复位） | **未完成**：串口无硬件；BLE 模块不在广播（9.16 有两次实测与三条证据） | 第 6.3 节明确要求真机证据；mock 与「模块不广播」都不算证据 |
| ~~Ubuntu CI 连续 5 次~~ | **已达成**：run `41492896547`，Ubuntu 连续 5 次 91 PASS / 0 FAIL / 0 warning | — |
| Windows CI 连续 5 次 | **未达成**：`windows-latest` 两轮实跑（run `41497738131`、`41512936266`），10 次全失败，失败点每次不同（见 9.17） | 第 6.4 节要求两个系统各 5 次；Windows **本地**已连续 5 次全绿 |
| 视觉证据绑定当前 commit | **已做**：见 9.13（六张截图绑定 `e67f551` 的 dist `d7356bc1443a10c4`，附 sha256） | — |
| 全部 JS 的 10% 体积余量 | **未达标**：全部 JS 合计 gzip 262/272 KB（余量 3.7%；three.js 一家 132 KB） | 第 6.5 节要求 ≥10%；要达标必须砍功能或改预算口径，两者都不该做 |
| PR 审查 / 合并 master / 部署后 smoke / 回滚演练 | **未做** | 第 6.7 节要求，且需远端环境 |

已补齐的 6.5 项（本轮新增）：

- **堆判定三项齐备**（`scripts/soak-contract.mjs:heapVerdict`）：起点→终点增长（≤heapLimit）、
  **峰值增量**（窗口内最高点相对基线，上限 2×heapLimit，专门抓「中途冲到 60 MB 又跌回来」）、
  **线性趋势**（最小二乘斜率 ×(n-1)，抓「末点被 GC 拉低掩盖的慢泄漏」）；样本不足 3 点时不假装有趋势结论。
  永久反例：`scripts/soak-contract.test.mjs`「heap verdict checks start→end growth, transient peak and linear trend together」
  （尖峰回落 / 单调爬升 / 慢泄漏被 GC 掩盖 / 两点样本四类）。
- **报告溯源**（`scripts/soak.mjs`）：报告新增 `commit`（`git rev-parse HEAD`）、`distHash`（dist 全量文件 sha256 前 16 位）、
  `browserVersion`、`startedAt`/`finishedAt`，终端也打印一行溯源信息——600 s 结论因此能绑定具体代码与产物。

结论：本轮把**影响结论可信度的 P1/P2 全部修掉并留下永久反例**，功能/数值时间/档案/生命周期/门禁四个维度
已可用实测输出复核；但上表五项缺证据（其中体积余量是实打实的未达标），因此**只能写
「按本轮证据已达可复核的高质量水准」，不能写「各维度满分」**。

### 9.18 「线上到底是哪个提交」：构建标识 + 部署后 smoke（6.7 的前置）

6.7 要求「合并到 master，线上页面可显示 build commit」——之前页面并没有构建标识，这一项**做不了**。现在补齐：

- `vite.config.ts` 在**编译期**注入 `__BUILD_COMMIT__` / `__BUILD_TIME__`（CI 用 `GITHUB_SHA`，本地用
  `git rev-parse --short=12 HEAD`，无 git 时退化为 `unknown`）。运行时不再读环境，Worker / 离线包看到的是同一个值。
- 「关于本装置」页标题下多一行 `构建：<commit> · <UTC 时间>`（`#build-stamp-value`，mono 样式）；
  同时通过 `attitudeDemo.build()` 暴露给自动化。截图：`screenshots/visual-buildstamp/about-1440x900.png`
  （sha256 前 16 位 `d6bb194e53c8fe98`；该图拍摄于工作树 = `c88e196` + 本次改动，因此页脚显示 `c88e196ba394`）。
- 新增 `scripts/postdeploy-smoke.mjs`（`npm run postdeploy:smoke -- --url=<线上地址> --expect=<commit>`）：
  打开线上页面 → 断言 HTTP 200、`attitudeDemo.build().commit` 以期望提交开头、页脚渲染出构建标识、
  仿真时钟真的推进、评测表 5 行、canvas 有 WebGL、控制台零错误，并写出带时间戳的 JSON 报告。
  本地预演已通过：`构建标识 c88e196ba394（期望 c88e196ba394）；页脚「c88e196ba394 · 2026-11-02 21:17:04 UTC」；
  时钟 0.5→2.0 s；评测表 5 行；canvas=true；控制台错误 0`（`.audit-smoke/postdeploy-local.json`）。
- 部署后要做的两件事因此变成一条命令：合并后 `npm run postdeploy:smoke -- --url=https://fly_web.070616.xyz/ --expect=<merge commit>`；
  回滚 = 反向提交 + 再跑同一条命令（`--expect` 换成回滚目标提交）。

### 9.17 Windows CI 两轮实跑的失败画像（2026-11-03）

`windows-latest`（2 vCPU + swiftshader）上跑了两轮、共 10 次完整冒烟，**全部失败**，但失败点每次不同：

| 轮次 | 结果 | 典型失败 |
|---|---|---|
| run `41497738131`（5 次） | 5/5 失败 | `Target.createTarget timed out`（浏览器被回收，门禁判基础设施失败）；启动 30 s 内 `#fps` 未就绪；批量评测回退 `main` |
| run `41512936266`（5 次） | 5/5 失败 | 另一处「脉冲环=false」；其余 4 次是**不同位置**的 `waitForFunction` 超时（8 s / 15 s / 30 s / 240 s） |

已做的针对性加固（都进了仓库，且本地/Ubuntu 不受影响）：

- `WORKER_STALL_MS` 15 s → **60 s**：Worker 里每个种子是同步跑完的，单线程下定时器发不出消息；
  2 vCPU 上单个种子就可能 >15 s，会被误判成「Worker 卡死」并**静默回退主线程**（这是真缺陷，
  慢机器上用户拿不到 Worker 加速）。60 s 仍能判出真正死掉的 Worker。
- 冒烟：`protocolTimeout=300 s`、首页首帧等待 30→60 s、批量完成等待 120→240 s、万向节脉冲环改状态等待。

**结论**：失败是「这台 runner 跑不动这套 WebGL 全量套件」的环境容量问题，不是某一处产品缺陷
（同一提交在本机 Windows 上连续 5 次 91/91、在 Ubuntu CI 上连续 5 次 91/91）。
按任务书自己的口径，Windows CI 这一格记**未达成**；**不通过继续放宽断言或跳过用例把它「调绿」**。

### 9.16 真机验收：硬件探测与自动化边界（2026-11-02 实测）

**本机实际存在的硬件（PowerShell/PnP 实测）**

- **串口：没有可用设备。** `Win32_SerialPort` / PnP 里没有任何 USB 串口桥（CP210x / CH340 / FTDI / CDC 均为空）；
  仅有的 `COM12` / `COM13` 是「蓝牙链接上的标准串行」的**残留 RFCOMM 端点**，`SerialPort.Open()` 报
  「端口不存在」。→ **串口 30 min 在这台机器上无法执行**（缺硬件，不是缺脚本）。
- **BLE：有一个已配对的 HM-10 模块**（`FriendlyName=HMSoft`，`InstanceId=BTHLE\DEV_4C2498B48BDD\…`，
  `Status=OK`、`Present=True`，上次 Windows 侧连接时间 2026-10-04）。
  → BLE 走 Web Bluetooth，**设备选择器是浏览器原生对话框**，puppeteer/CDP 无法代选；
  原点一次「连接 BLE IMU」后必须由人选择设备。

**为此新增的真机长稳脚本**：`scripts/hw-soak.mjs`（`npm run hw:soak -- --kind=ble --minutes=30`）

- 有头 Chrome + 固定 profile 启动，自动点「连接 BLE IMU / 连接真实 IMU」把系统对话框弹出来（只差人选设备）；
- 连接成功后全自动：每 2 s 采样（帧数/字节/重连/端口/清理/状态行），按 25% / 55% / 75% 三个时间点
  用 `pnputil /disable-device` **关闭本机蓝牙无线电 8 s / 8 s / 20 s** 模拟「离开范围」与「长断链」（软件代理，
  报告里标 `simulated: "radio-off"`）；串口模式则如实标注「拔插/休眠/复位需人工」；
- 结束时自动断开并断言 `openPorts=0 / pendingPortCleanup=0`；报告带 `commit / distHash / 浏览器版本 / 起止时间`。

**实际尝试（2026-11-02 23:50 与 2026-11-03 00:5x，两次）**

| 次数 | 做法 | 结果 |
|---|---|---|
| ① | `--kind=ble --minutes=0.05` | 有头浏览器 + 自动点击连接 + 系统设备对话框都正常弹出；**180 s 内无人选择设备**，按设计超时（`failure: "180 s 内没有建立连接…"`，`.audit-smoke/hw-ble-probe.json`） |
| ② | 用 **Computer Use 驱动**该对话框（自动点击「启用蓝牙」→ 蓝牙无线电从 **SystemRadioState=0（关）** 变为 On，WinRT 复核 `蓝牙 kind=Bluetooth state=On`），随后 `--kind=ble --minutes=30` | 对话框扫描结果始终是「**找不到兼容设备**」；重新扫描无效；人工选设备这一步已被自动化替代，仍然没有可连的设备 → 300 s 连接窗口内未建立连接 |

**为什么「找不到兼容设备」**（三条独立证据一致指向「模块没有在广播」）：

- `HKCU\…\CapabilityAccessManager\ConsentStore\bluetooth` 里 **HMSoft 的 BLE 地址（4c:24:98:b4:8b:dd）就是 `Allow`**
  —— 操作系统层面的权限不是瓶颈；Windows 11 25H2（build 26200）的「隐私和安全性 → 应用权限」里**没有蓝牙条目**
  （Chromium 提示里的「系统设置」路径在这个版本上不存在），Win32 应用也不走那套 per-app 授权。
- PnP 里 HMSoft 的 `LastArrivalDate = 2026-11-02 22:11:33`（整栈枚举时刻），`Bluetooth_LastConnectedTime = 2026-10-04 07:58:19`
  —— **今天没有任何新的广播到达**（对照：AULA 键盘 `lastConnected = 2026-11-03 08:07`，同一套查询能看到活跃设备）。
- 配对状态是「已配对」而不是「已连接」；HM-10 若在广播，Web Bluetooth 选择器与 Windows 侧都应立刻看到它。

**结论**：BLE 30 min 报告**没有产生**（模块未上电/不在范围/被别的中心占用三者之一），串口侧则**根本没有硬件**。
按任务书自己的口径，这两项只能记为未达标——**不写「已做真机验收」，也不伪造任何 30 min 报告**。

**硬件窗口恢复后的三步**（前两步在本机已用 Computer Use 走通，只差设备本身可用）：

1. **先给 HM-10 上电**（并确认它没被手机等别的中心占用、在主机 1–2 m 内、指示灯在闪），
   再执行 `npm run hw:soak -- --kind=ble --minutes=30`，在弹出的系统对话框里选 `HMSoft`；
   期间脚本会三次尝试关闭/恢复蓝牙无线电（无管理员权限时会如实记为「扰动跳过」而不是算作失败）。
2. 串口侧需要接上真实 IMU（USB-TTL 或飞控转发），`npm run hw:soak -- --kind=serial --minutes=30 --baud=…`，
   并在中途**人工拔插一次**、**让主机休眠再唤醒一次**、**给设备复位一次**（脚本会把人工事件时间点标出来）。
3. 把两份 JSON 放到 `docs/generated/` 并在本节登记（含 commit / distHash / 浏览器版本）。
