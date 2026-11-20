# 质量复核历史索引

> 本文件压缩替代 2026-10-31 至 2026-11-02 的多份轮次审查、建议书和旧路线图。
> 原始全文已进入 Git 历史；需要逐字复核时使用下表的“原路径 + 最后保留提交”读取，例如：
> `git show 56e3d0b:docs/QUALITY-REVIEW-2026-11-01-ROUND12.md`。
>
> **注意**：各轮评分使用的量表不同，不能画成简单上升曲线。本文件只提供历史索引，不提供当前评分。
> 2026-11-03／11-05 的质量快照已于 2026-11-19 整合进本文件；原始全文可按第 5 节的 Git 定位读取。
> 当前待办见 [`ROADMAP.md`](ROADMAP.md)，教学最新评估见 [`TEACHING-REVIEW-FIFTH-2026-11-19.md`](TEACHING-REVIEW-FIFTH-2026-11-19.md)。

## 1. 评分与判断演变

| 日期 / 轮次 | 当时结论 | 核心价值 | 后续如何修正 |
|---|---|---|---|
| 2026-10-31 初审 | 82/100 | 指出 A/B 参数未冻结、粗对准不同步、档案只是配置而非快照、运动学闭环无效、外部真值入口不完整 | ROUND4–7 将“看起来完整”转成可复现实验和反例 |
| ROUND4 | 84/100 | 档案校准/模型/应用状态、raw/calibrated 语义、外部真值波形、runner 与 UI 语义 | 后续发现“配置恢复”仍不等于严格事务 |
| ROUND5 | 91/100（启发式） | 修正 SO(3) 世界系、独立验证重叠、加计验证硬编码、BLE 重连特征 | 评分标准较宽，真机与跨路径边界仍未验收 |
| ROUND6 | 92/100（启发式） | runner 的校准应用、Worker 心跳/主线程取消、校准指纹 | ROUND7 用更强负例证明旧“接近完成”仍过早 |
| ROUND7 | 不给单一分 | 发现取消复活、重连污染、留出泄漏、模型退化、导出语义与时间单位问题 | 成为 ROUND8/10 的 A–E 实施输入 |
| ROUND8 | 不再沿用 92 | 确认默认模拟可用，但连接所有权、数据闭环与门禁治理不足 | ROUND10 实施后又被 ROUND11 独立复核 |
| ROUND10 | A–E 结算 | 连接、导出/回放、校准、时间/trace、门禁/长稳 | ROUND11 纠正：部分测试与锁/所有权仍不完整 |
| ROUND11 | 独立复核 | 子步姿态末态误用、串口锁与 BLE 回调所有权、25 Hz 源列语义、strict 仍默认化 | ROUND12 提出真正分拍、会话事务、recursive strict |
| ROUND12 | 软件 P1 清单 | backlog 不真分拍、系统断链跳过锁释放、消费快照跨 reset、BLE 竞态、strict/校准判据不同步 | 提交 `56e3d0b` 完成主干修复 |
| 2026-11-02 满分任务书 | 对 `d6c4a22` 重新按严格量表评为 84/100 | 回退时间重复积分、帧末真值提前、档案非原子、ratio:null、close 丢引用、setup/close 无界、门禁不稳 | 提交 `8161ef3` 等完成大部分 P1/P2，并新增 CI/证据体系 |
| 2026-11-03 当前复核 | `830e4e3`：86/100 | 软件主线、单轮 CI、部署和线上 smoke 强；严格档案事务、主动连接 timeout、当前双 OS 5×、真机与证据溯源仍缺 | 后续软件复核与实施工单继续修正 |
| 2026-11-03 质量快照 | 95/100（完整系统旧口径） | 当时声称档案严格零副作用、配置唯一规范形、连接动作有界，扣分集中于真机与外部验证 | 后续反例推翻「只剩外部条件」；原文 `QUALITY-STATUS.md` 已整合删除 |
| 2026-11-05 软件评估 | 93/100（软件旧口径） | SW-01～SW-12 实施后，正确性、异常安全与证据绑定提升；剩余为减重、可访问性与装配层拆分 | 后续教学评审发现新反例；原文 `QUALITY-SOFTWARE-ONLY.md` 已整合删除 |
| 2026-11-18 阶段优化评估 | 87/100（后被推翻） | 在深入核对教学长稳换源前给出 | 四次复核发现 `source-select` 并未真正换源，回调暂定 84/100；临时治理方案 `CLEANUP-AND-REVIEW-2026-11-18.md` 已整合删除 |
| 2026-11-19 第五次复核与结构减重 | 保留暂定 84/100，不自动加分 | 全部 JS 净省 4018 B、余 4096 B；依赖裁剪、轻量控制器、估计器工厂与具名动态入口；新候选完整证据重采 | 五轮 117×5、三份 600 s、性能、11 张实际逐图、尺寸与 strict 全通过；7 条新 current、125 输入文件；GPU IBL 外观未实测，远端未授权 |
| 2026-11-19 第四次整改回填 | 保留暂定 84/100，不重新评分 | 真实 replay 三阶段量具、Ki 普适命题、Gate 生产配置口径、视觉独立采集与历史丢失证据保真已实施；一轮 CSV 纯 core 拆分 | 净省 32 B、余 78 B，距 ≥4 KiB 余量目标仍差 4018 B；最终冻结构建教学／批量／重连 600 s、五轮稳定性、性能与 strict 新绑定均已 PASS（9 次真实换源，批量 116 样本，重连 66/66）；11 张截图已实际逐张查看，单项通过与边界均已登记 |

## 2. 核心反例如何转为永久契约

### 数值与时间

- 解算率抽帧、Σdt、0dt、长空洞与背压：`scripts/time-contract.test.ts`、`src/core/solve-loop.ts`。
- 时间回退不重复积分：ReplayPlayer 使用历史运行最大值；单次/多次回退进入 time contract。
- 外部真值长间隔：`src/core/truth-track.ts` 逐子步 slerp；纯契约与浏览器完美日志共同守护。
- UI / runner 对拍：`scripts/trace-contract.mjs` 与浏览器 2000 步 trace。

### 档案与校准

- 当前 schema recursive strict、未来版本拒绝、字段路径错误：`schema-contract.test.ts`。
- `diag + matrix`、SPD / near-identity 分流、病态矩阵与校准质量：`calibration-validation.ts`。
- `ratio:null`：纯渲染与浏览器档案导入测试。
- canonical 默认字段、steady/coarse 读回：schema 与浏览器往返测试。
- 仍有效的限制：档案探测仍触发真实 UI 事件，见当前 ROADMAP P0。

### 连接与资源

- pending read、releaseLock→close、迟到 reader、同句柄 session、notification rollback：`lifecycle-contract.test.ts`。
- close=false quarantine 与生产后台重试：浏览器连接所有权用例。
- 切源取消已排程重连：串口→BLE/回放与 BLE→串口双向用例。
- 仍有效的限制：连接动作本身的主动 timeout 与真机 30 min 未完成。

### 门禁与证据

- 状态 current/history、counts/verify 清单：`status-contract.mjs`。
- 文档基准结构/关系/正文渲染/复算：`doccheck.ts`。
- soak 的 heap 起终/峰值/趋势、批次数与逐段 reconnect：`soak-contract.mjs`。
- 浏览器进程重启不再假绿，app/devices 分片与 CI 驱动：`browser-smoke.mjs`、`ci-run-smoke.mjs`、`.github/workflows/ci.yml`。

- 教学换源不再按动作名称计数：`scripts/teaching-load.mjs`／`soak-contract.test.mjs` 验证 `replay.import()/stop()` 的 active、sourceKind、idx 与诊断 runId 三阶段；`evidence-report.mjs`／`evidence-contract.test.mjs` 要求 `teaching-load/v2`、完整记录与汇总一致，拒绝旧假换源成为 current。旧教学报告的当时 PASS 保留，但标 `current=false`、`measurementStatus=invalid-source-switch`，只用于容量／内存观测。
- 视觉复采与历史丢失：完整 sourceDigest／buildId／UUID 独立路径并拒绝覆盖；本地 PNG 如实标 `localOnly:true`。`evidencecheck.mjs` 与证据契约将不可恢复历史保留为 `OBSERVED/unrecoverable`，未知覆盖者／覆盖时间成对 `null`；保留已知原 hash／前缀，不伪造关联或把缺失报告当 PASS。

### 2026-11-19 第四次整改的证据状态（不重评）

冻结身份为 `sourceDigest=2d93cd3d5131d3eb6eeb9f594c4346c6`、`buildId=2d93cd3d5131-15c789e0829d1fe9`、`sourceFiles=121`。已完成代码和完整回填见四次复核第 8.4／9 节：真实 replay 三阶段、teaching-load/v2 全记录、取消 settled／旧 job 隔离、关 review/ESKF＋暂停生产后的静默（事件没有独立停采开关）、Ki 普适命题与 Gate 生产配置口径。

- `tsc → check（155 基础项＋全契约 0 FAIL）→ build → budget（18/18）` 有磁盘回执；CSV 纯 core 拆分的 schema 106 PASS/0 FAIL。JS 299474→299442 B，净省 32 B，有效上限 299520 B、余 78 B，距 ≥4 KiB 余量目标差 4018 B；已停止机械拆分、不抬线、不删功能。
- 最终教学 600 s PASS 后，五轮 117 项稳定性、批量／重连 600 s、性能与 strict 新绑定也已全部通过；索引 79 条、current 8 条，丢失原件只保留 note。不拿旧 current 当整体验收。
- 五轮 117 项稳定性已全部通过（每轮零失败／warning／未计划重启），批量 600 s（116 样本、常驻水位 +2.747 MB、峰值 27.218 MB、趋势 6.910 MB）、重连 600 s（122 样本、66/66 恢复、水位 +9.316 MB、峰值 26.331 MB、趋势 18.476 MB）均 PASS，性能报告通过（33.3 fps、真实输入 p95 4.97 ms、取消 18.1 ms、控制台 0），strict 新绑定已通过。
- **本版视觉已完成**：早期工具返回 `Media omitted`／模型不支持图像的错误保留为过程记录；后续图像输入成功，已实际查看全部 11 张独立采集 PNG，未见意外重叠、横向溢出或空白画布，控制台 0。这仅代表模型视觉检查，不扩大所有者确认或读屏范围。
- 最终重采串行 runner 已安排；首次 `_ops/` 辅助 runner 的 Windows ESM `d:` 导入路径错误已改 `pathToFileURL`，未改源码，不计产品失败或测试通过；教学 600 s、五轮稳定性、批量／重连、性能、视觉与 strict 随后全部通过。保留评分和磁盘回执，不删除文件、不提交／推送／发布。

## 3. 被后轮推翻的重要旧结论

1. **“门禁全绿 = 项目完成”**：旧 smoke 曾在启动前崩溃、0 项执行；后续才修复并增加 manifest。
2. **“只剩真机”**：ROUND7、11、12 和满分复核持续找到时间、档案、连接事务的软件 P1。
3. **“close 调用过 = 端口已释放”**：真实锁约束证明必须 cancel/readDone/releaseLock/close 且按实际结果记账。
4. **“少量时间回退夹成 0 即可”**：会重复积分；必须构造单调有效时间轴。
5. **“失败档案重新应用旧配置就原子”**：曲线/历史等已被 reset，必须先验证后提交；当前仍需 detached probe 收口。
6. **“一次/本地 5× smoke 足以证明跨平台稳定”**：当前 Windows CI 5×仍失败。
7. **“600 s PASS 自动对应当前提交”**：旧报告没有 commit/dist/browser provenance，只能证明某次历史运行。

## 4. 修复提交索引

| 提交 | 主题 |
|---|---|
| `56e3d0b` | 真正分拍、连接会话事务、recursive strict、门禁独立判定 |
| `9da9bfc` | 浏览器门禁自愈、连接释放可重试、档案往返闭环、600 s/视觉证据 |
| `d6c4a22` | 实时丢帧可见性与 CSV/消费边界 |
| `8161ef3` | 满分复核 P1 与 P2-1…P2-4 红→绿整改 |
| `566086b` | PR #1 合并：质量整改、冒烟分片、Ubuntu 5×、构建标识与部署后 smoke |
| `830e4e3` | 当前 master：Windows 低视口稳定性尝试；普通 gate/shard/deploy 通过，Windows 5×仍失败 |

完整产品变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 5. 原始文档 Git 定位

下列文件已从当前树整合删除；最后保留全文的提交如下：

| 原路径 | 最后保留提交 |
|---|---|
| `docs/QUALITY-REVIEW-2026-10-31.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-10-31-ROUND4.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-10-31-ROUND5.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-10-31-ROUND6.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-10-31-ROUND7.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-11-01-ROUND8.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-11-01-ROUND10.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-11-01-ROUND11.md` | `56e3d0b` |
| `docs/QUALITY-REVIEW-2026-11-01-ROUND12.md` | `56e3d0b` |
| `docs/IMPROVEMENT-PROPOSAL.md` | `8bda0bb`（后续提交含状态更新，可用 `git log -- path` 选择） |
| `docs/NEXT-ITERATION-ROADMAP.md` | `9da9bfc`（后续合并提交含补遗） |
| `docs/QUALITY-FULL-SCORE-PLAN-2026-11-02.md` | `aba9bf6` |
| `docs/QUALITY-STATUS.md` | `eded35a`（Git 原文）；2026-11-18 的后续标头修订见当前未提交工作树 |
| `docs/QUALITY-SOFTWARE-ONLY.md` | `7d5cf97`（Git 原文）；2026-11-18 的后续标头修订见当前未提交工作树 |
| `docs/CLEANUP-AND-REVIEW-2026-11-18.md` | 未提交文件；87 分阶段结论与 D 盘治理已保留在四次复核及本节 |

示例：

```bash
git show 56e3d0b:docs/QUALITY-REVIEW-2026-11-01-ROUND12.md
git log --all -- docs/NEXT-ITERATION-ROADMAP.md
```

## 6. 后续与当前入口

- 历史软件评估（2026-11-03／11-05）与 2026-11-18 阶段评分：见第 1 节与第 5 节 Git 定位
- 当前实施工单：[`ROADMAP.md`](ROADMAP.md)
- 证据使用原则及历史验证：[`VERIFICATION-EVIDENCE.md`](VERIFICATION-EVIDENCE.md)
- 教学最新评估、体积与磁盘治理：[`TEACHING-REVIEW-FOURTH-2026-11-18.md`](TEACHING-REVIEW-FOURTH-2026-11-18.md)
- 架构与当前事实：[`PROJECT-STATE.md`](PROJECT-STATE.md)
- 产品变更：[`CHANGELOG.md`](CHANGELOG.md)
