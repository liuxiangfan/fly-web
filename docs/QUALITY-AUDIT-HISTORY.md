# 质量复核历史索引

> 本文件压缩替代 2026-10-31 至 2026-11-02 的多份轮次审查、建议书和旧路线图。
> 原始全文已进入 Git 历史；需要逐字复核时使用下表的“原路径 + 最后保留提交”读取，例如：
> `git show 56e3d0b:docs/QUALITY-REVIEW-2026-11-01-ROUND12.md`。
>
> **注意**：各轮评分使用的量表不同，不能画成简单上升曲线。当前唯一评分见 [`QUALITY-STATUS.md`](QUALITY-STATUS.md)。

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
| 2026-11-03 当前复核 | `830e4e3`：86/100 | 软件主线、单轮 CI、部署和线上 smoke 强；严格档案事务、主动连接 timeout、当前双 OS 5×、真机与证据溯源仍缺 | 当前工单见 `ROADMAP.md` |

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

示例：

```bash
git show 56e3d0b:docs/QUALITY-REVIEW-2026-11-01-ROUND12.md
git log --all -- docs/NEXT-ITERATION-ROADMAP.md
```

## 6. 当前入口

- 当前百分制与问题：[`QUALITY-STATUS.md`](QUALITY-STATUS.md)
- 实施工单：[`ROADMAP.md`](ROADMAP.md)
- 证据边界：[`VERIFICATION-EVIDENCE.md`](VERIFICATION-EVIDENCE.md)
- 架构与约定：[`PROJECT-STATE.md`](PROJECT-STATE.md)
- 产品变更：[`CHANGELOG.md`](CHANGELOG.md)
