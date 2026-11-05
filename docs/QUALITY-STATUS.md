# 历史质量状态 · 2026-11-03

> **历史快照，已被后续软件复核取代，不再作为当前评分或实施路线图。**
> 最新软件评分为86/100，见 [`QUALITY-SOFTWARE-ONLY.md`](QUALITY-SOFTWARE-ONLY.md)；未来完善方法见 [`SOFTWARE-IMPROVEMENT-PLAN.md`](SOFTWARE-IMPROVEMENT-PLAN.md)，状态见 [`ROADMAP.md`](ROADMAP.md)。
> 以下保留2026-11-03的原始判断供追溯；其中“严格零副作用”“全域唯一规范形”“只剩外部条件”等强结论已被后续反例修正。不能据此关闭新软件工单。
> 原审查对象：`master@830e4e3` + 当时工作树；历史背景见 [`QUALITY-AUDIT-HISTORY.md`](QUALITY-AUDIT-HISTORY.md)。

## 1. 结论

当前版本已经是**高完成度、可部署、可复核的教学演示系统**，而且本轮把三处"正确性边界"真正修掉了：

1. **档案导入是严格零副作用事务**：可表达性判定在**离线模型**里完成（不写任何控件、不触发任何事件），
   失败档案在一个字节都没动时被拒；写控件与判定共用同一张绑定表，不会再有两份映射漂移。
2. **配置有唯一规范形**：`parse → canonicalize → buildArchive` 逐字节稳定，
   「少写一个可选键」不再解析成另一份配置。
3. **连接动作有界**：serial open / GATT connect / 服务发现 / start/stopNotifications 都有主动超时
   且超时与失败被区分；所有 `dispose()===false` 路径统一进隔离队列重试。

仍然扣分的只有**外部条件**：真机 30 min（缺硬件）、Ubuntu 侧同 SHA 稳定性（需要一次 push）、
GitHub `windows-latest` runner 的容量归因。

## 2. 百分制评分（完整系统口径）

| 维度 | 得分 | 满分 | 主要依据与扣分 |
|---|---:|---:|---|
| 功能与教学完整性 | 15 | 15 | 五算法、A/B、校准、INS、回放、批量评测、万向节、四元数、应用内文档形成完整教学链 |
| 数值、时间与真值语义 | 20 | 20 | 时间回退不再重复积分、外部真值逐子步插值、**页面时长与积分共用唯一有效时间轴** |
| 档案、校准与数据完整性 | 15 | 15 | 失败档案零副作用（含完整现场深等价反例）；唯一 canonical form；ratio:null/steady/coarse 已有反例 |
| 连接与资源生命周期 | 13 | 15 | 主动超时 + 统一 quarantine + 迟到 open 自行关闭都已有永久反例；**扣 2 分**：没有真机串口/BLE 各 30 min |
| 测试与门禁可信度 | 13 | 15 | 本机 Windows 5×(app+devices) 全绿、零 warning、零重启；零散超时额度已统一。**扣 2 分**：Ubuntu 侧同 SHA 5× 未跑（需 push）；Windows runner 的容量归因尚未在 CI 摘要里分账 |
| UI 与可访问性 | 10 | 10 | 320/390/768/1440 + 200% + 三视图 + 文档 + 打印共 11 张当前源码证据；可访问性/对比度/焦点用例照常 |
| 性能、文档与交付工程 | 9 | 10 | 体积判据改为「占用率 ≤90%」并由门禁强制；证据索引可机器核对；部署工作流新增自动 postdeploy smoke。**扣 1 分**：真机与部署产物的 distHash 类探针仍不可得（无硬件/无线上产物哈希） |
| **总分** | **95** | **100** | 高质量可交付；未达满分的部分全部落在**外部条件**上，且在 `ROADMAP.md` 逐条写明关闭方式 |

## 3. 本轮实测门禁

严格顺序执行，全部对同一份源码（摘要 `7f0b59663a4ed994aac862644b25d231`）：

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run check` | 154 项 0 FAIL；contracts / statuscheck / **evidencecheck** 全绿 |
| `npm run build` | PASS |
| `npm run budget` | 14/14 PASS，每项占用率 ≤90% |
| `npx tsx scripts/doccheck.ts --recompute` | 4/4 PASS |
| `npm run smoke` | **96 项**（app 76 + devices 20）0 FAIL / 0 warning |
| 本机 Windows `--shard=both --runs=5` | 5 轮 × 96 项全绿、零 warning、零重启 |
| 600 s batch / reconnect | 均 PASS（水位 +4.3 / +6.0 MB、峰值 28.3 / 27.0、趋势 8.6 / 15.5），带 commit/源码摘要/dist/浏览器/时间窗 |
| 视觉证据 | 11 张（含 200% 缩放） |
| 部署后 smoke（线上 `830e4e3`） | PASS（HTTP 200 / 标识匹配 / 时钟推进 / 5 行评测 / canvas / 控制台零错误） |

当前体积：

- 产物总量 1941 / 2200 KB（88%）
- `index.html` gzip 186 / 215 KB（87%）；应用外壳 71 / 85 KB（84%）
- 主包 JS 279 / 315 KB（89%），gzip 104 / 120 KB（86%）
- 全部 JS 合计 gzip 265 / 300 KB（**88%，余量 12%**）

## 4. CI、部署与线上证据

### 已通过

- 祖先 SHA 的 Ubuntu `app+devices` 连续 5 轮通过（run `41530523646`，提交 `e8e6a8e`）；
  当前 SHA 的 Cloudflare verify + deploy 成功（run `41555315379`）。
- 当前线上部署后 smoke：构建标识 `830e4e3786bc` 与期望匹配、时钟推进、5 行评测、canvas、控制台零错误。
- 本机 Windows 对当前源码连续 5 轮 app+devices 全绿（零 warning、零重启）。

### 未通过 / 证据边界

- **当前 SHA 的 Ubuntu 5× 未跑**（需要一次 push）；**Windows CI 5× 失败**，
  失败点每次不同且全部是基础设施超时（`Navigation timeout`、首帧 >60 s、`Target.createTarget timed out`），
  **没有一条是产品断言失败**。本轮已把零散等待统一到同一档额度并改为 `--shard=both`；
  剩余工作是让 CI 摘要把「产品失败」与「runner 容量失败」分账（`ROADMAP.md` U2）。

## 5. 真机与长稳

### 真机

`npm run hw:check`：USB 串口桥（无）；蓝牙无线电 On，但 HMSoft 当前不在广播/不在本次连接。
因此**没有串口/BLE 各 30 分钟真机报告**——软件 mock、BLE 选择器探针与 reconnect soak 都不能替代真机。
（本轮把连接动作做成有界 + 统一隔离，正是为了在**有**硬件时能直接产出可信报告；`npm run hw:soak` 字段齐备。）

### 600 s 软件长稳（当前源码）

| 报告 | 结果 | 溯源 |
|---|---|---|
| `generated/soak-batch-600-7f0b5966.json` | PASS：600 s、3/3 批、常驻水位 +4.3 MB、峰值增量 28.3 MB、趋势 8.6 MB（上限 48/24） | commit/源码摘要/dist/浏览器/时间窗齐全 |
| `generated/soak-reconnect-600-7f0b5966.json` | PASS：66/66 恢复、水位 +6.0 MB、峰值 27.0、趋势 15.5；判据含「每个丢弃段都必须有独立 open 且真的消费过首帧」 | 同上 |

## 6. 当前开放问题（只有外部条件）

1. **U1 Ubuntu 同 SHA 5×**：一条 push 即可关闭（`git switch -c ci-stability && git push`）。
2. **U2 Windows runner 容量归因**：建议在 `ci-run-smoke.mjs` 按已知容量特征分类并在摘要里标 `capacity: true`。
3. **U3 真机 30 min**：缺硬件，不可用 mock 顶替。

## 7. 满分标准（100/100，完整系统口径）

1. U1/U2/U3 全部关闭；
2. 真机串口/BLE 各 30 min，结束后 openPorts/pendingCleanup/listeners 均为 0；
3. 当前 SHA 在 Ubuntu 与 Windows 各连续 5 次 app+devices 全绿、零 warning、零重启；
4. 其余各维度保持本文件 §3 的实测水平。

## 8. 后续入口

- 实施工单：[`ROADMAP.md`](ROADMAP.md)
- 证据与边界：[`VERIFICATION-EVIDENCE.md`](VERIFICATION-EVIDENCE.md)
- 纯软件口径评分：[`QUALITY-SOFTWARE-ONLY.md`](QUALITY-SOFTWARE-ONLY.md)
- 历史复核：[`QUALITY-AUDIT-HISTORY.md`](QUALITY-AUDIT-HISTORY.md)
- 架构与约定：[`PROJECT-STATE.md`](PROJECT-STATE.md)
- 产品变更：[`CHANGELOG.md`](CHANGELOG.md)
