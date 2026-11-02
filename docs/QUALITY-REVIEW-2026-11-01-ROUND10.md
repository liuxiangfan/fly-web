# 复核修复结算（第十轮，2026-11-01）：ROUND8 的 A–E 落地情况

> 对象：`QUALITY-REVIEW-2026-11-01-ROUND8.md` 列出的 P1/P2 与测试盲区。
> 本文只记「这一轮改了什么、用什么证据守住、还差什么」，不重复 ROUND8 的分析。
>
> **ROUND11复核限定（2026-11-01）**：本文为历史实施记录，当前正确性与下一步以 [`QUALITY-REVIEW-2026-11-01-ROUND11.md`](QUALITY-REVIEW-2026-11-01-ROUND11.md) 为准。已有有效修复，但仍有子步INS末态误用、连接锁/回调所有权、25Hz源列语义与严格输入/校准契约缺陷，不能据本文认定A–E全部完成。check完整输出是161 PASS（152子检查 + 9状态）；所列25–45秒soak不是10分钟验收，`--drop-every=3`实际未正确读参；前轮回复的三页视觉抽查没有可判读图像证据，视觉仍未验收。

## 1. 本轮门禁结果（全部绿）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run check` | **152 项全 PASS**（124 数值 + 10 几何 + 15 HTML + 3 文档）+ **计数一致性** PASS |
| `npm run build` | exit 0 |
| `npm run budget` | **10 项全 PASS**（主包 JS gzip 紧贴上限，见 §4） |
| `npm run smoke` | **85 PASS / 0 FAIL**（原 78 + 连接所有权 5 + 导出不可变 2） |
| `npm run soak` | `--batch` 与 `--reconnect` 两种模式均 pass（判据已收紧，见 §3） |
| `npx tsx scripts/doccheck.ts --recompute` | PASS（只读复算全部基准记录，已接入 CI） |

## 2. A–E 逐包落地与对应负例

### A 连接所有权（P1）

| ROUND8 反例 | 现在 |
|---|---|
| 自动串口 open 挂起 → 用户断开 → 旧 await 完成后仍 `running=true` | 自动重连捕获世代，每个 await 后校验；过期只关掉自己打开的端口且不提交状态 |
| 自动 GATT 挂起 → 导入回放 → 旧 await 完成仍 `connected=true` | 同上（BLE 版），另加 `closeBleGatt(device)` 兜底断开 |
| 串口自动重连挂起 → 导入回放 → `serial=true` 与 `replayFrames=60` 同时成立 | 冒烟「挂起的过期重连自己收尾、不碰新来源」：放行过期 open 后仍 `replay=true`、`openPorts=0` |
| 订阅 await 期间切源，完成后仍提交 `ble=true` | `bleSubscribe(char, gen)` 逐 await 校验；过期摘监听+退订不提交（冒烟「订阅 await 期间换来源」） |
| 串口→BLE 一次切换自己作废（`serial=false/ble=false/通知数 0`） | 一次切源只递增一次世代 + 内部 dispose 不递增（冒烟「串口 → BLE 切换一次成功」） |
| A reader 迟到结束打死新连接 | `connToken` 归属检查（冒烟「旧 reader 迟到结束不打死新连接」：随后 0.5 s 仍新增帧） |
| 严格端口 open=4/close=0 | `serialOpenPorts` 记账，异常/过期路径都真正 close；`plumbing().openPorts` 可断言 |
| 耗尽后永久冻结 | `abandonSerialTransport/abandonBleTransport` 一并清过渡态（冒烟：`reconnectPending=false`、端口 0、时钟继续走） |
| 空窗期间来源身份错（记成模拟真值） | 新增 `sourceIntent`，过渡态保持原来源（`plumbing().sourceKind` 断言） |

### B 导出/回放不可变（P1）

- `LogRow` 新增 `imuConsumed`（当时实际喂给解算的读数）与 `sourceCalibrated`；`exportCsv` 只序列化记录。
  冒烟「导出不可变」：铺一份 offset=[5,0,0] 的标定 → 导出 → 摘掉当前标定 → 再导出，**共同前缀逐字节相同**。
- 全帧记录改名「全帧源 IMU」并按来源标 `# imu=calibrated`；记录期间语义变化清空重记。
  冒烟「全帧源导出语义」：原始来源 → `raw`，校准来源 → `calibrated`（旧实现恒写 `raw`）。
- 声明 `# imu=calibrated` 的日志把「应用校准」开关**禁用**（不再只是默认关）。
- `logIntervalSec` 去掉上限夹紧；`applyFrame` 拆子步且子步数有上限 → 30 s 空洞按 30 s 播放（selftest 断言 30 拍、dt=30 s）。

### C 校准完整性与配置恢复（P1）

- `faceMatchesReading()`：采集时与拟合时都拒「面与读数不符」；`conditionNumber3()`（Frobenius 上界）+
  偏置/残差门槛：`diag(1,1,2e-6)`（上界 7e5）与镜像矩阵（det<0）被拒；留一新增方向误差。
  selftest「复核 ROUND8 校准契约」逐条断言（含干净六面必须通过，避免误杀）。
- `parseArchive` 分流：当前 schema 的档案声明了不可用模型 → 报错；旧 schema 迁移把丢弃项写进 `notes`；
  `validateExperimentConfig` 拒绝「Applied=true 而模型为 null」。
- `applyArchiveConfig` 停掉磁/加计两侧采集、清 pending/样本/验证行，并深拷贝模型；
  `cloneExperimentConfig` 补 `initialAttitude.axis` 深拷贝。

### D 时间/事件/trace/统计（P1/P2）

- `applyFrame`：子步时间递增、每帧只有一个对准事件、子步数有上限（selftest「共享调度帧契约」）。
- `runner` 新增 `termination`（reason/requestedEnd/end/lastSolve/pendingTail）；`steadyMode` 由显式完成标志决定
  （不再用 99% 猜）。
- `runTrace`：每步 `dt/raw/consumed`、`aligned` 标在**对准当步**（selftest 实测 t=3.002 标在 3.002）、
  门控事件计数不再为空（剧烈机动 76 条）、提供 `alignTimes`。
- `MetricAccumulator` 导出 + `diagnostics()`：统计回归用例直接驱动生产实现（130 s / 260 s 容器均为 60000/20000，
  10 Hz 周期信号 P95 与精确值一致、固定相位对照掉到 1/4）。
- 采样历史多留一个采样周期：5 Hz/250 ms 不再退化成 200 ms；零延迟路径也带 `times`。

### E 门禁 schema、只读复算与长稳（P1/P2）

- 逐帧比较器：先验 schema（精确帧数、五算法、有限单位四元数、严格时序）并在内部执行数值门槛；
  7 种畸形输入（含「双方一起截断」与「中点偏 10°、终点不变」）**必须全部判失败**，冒烟逐项断言。
- `soak`：丢弃节奏由 `--drop-every` 真实控制并计数，重连判据与**实际断链数**比较，逐段要求「存活期间帧计数严格增长」，
  批次绑定 generation 与表格行数（`gen 0→1`、5 行）。
- `statuscheck`：htmlcheck/doccheck 的项数**跑脚本读实际输出**；新增「合计项数」与「预算项数」口径核对
  （改后文总数会失败）。`doccheck`：严格 schema + 正文数字块与存档逐字核对 + `--recompute` 只读复算（CI 已接入）。
- 对比度扫描新增低对比度**负对照**：注入了探针必须被抓到，否则「全站达 AA」只是没在扫。

## 3. 长稳证据（本轮实跑）

- `node scripts/soak.mjs --seconds=45 --batch`：3 批全部 completed，`gen 0→1 / 1→2 / 2→3`、每批 5 行；
  零错误、容器封顶、堆 +5.7 MB。
- `node scripts/soak.mjs --seconds=25~40 --reconnect --drop-every=3`：实际断链 2~4 次、重连成功数 ≥ 实际断链数、
  累计帧严格增长、停流对 0、零错误。判据收紧后仍然通过（此前版本会因「幽灵断链」判定口径混乱而给出无意义结论）。

## 4. 已知代价与未做项（不粉饰）

1. **主包体积紧贴上限**：本轮为实现上述契约增加了约 2.4 KB gzip，`主包 JS gzip` 从 106 KB 升到 108 KB（上限 108 KB，
   实测余量 6 字节）。已做的收敛：条件数改用 Frobenius 上界（省下 Jacobi 分解）、内联端口计数与快照函数、
   压缩若干状态文案。**下一步加功能前必须先减体积**，不能靠抬上限。
2. **真机 30 min 未做**：串口/BLE 各一段（含拔插、离开范围、休眠、设备复位）仍是硬件窗口问题，
   保持「未验收」标签；软件 mock 不代替它。
3. **视觉验收未做**：本轮无可用图像通道，桌面/窄屏/文档/打印的目视审查未完成（对比度已有负对照保证扫描有效）。
4. **协作式取消**：Worker 的 `cancel` 消息在同步循环里仍收不到（主界面 `terminate` 有效），
   属协议缺陷而非批次隔离失败，未在本轮修（记录在案）。
