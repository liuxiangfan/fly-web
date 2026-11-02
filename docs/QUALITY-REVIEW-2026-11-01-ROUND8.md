# 完成质量复核与后期方案（ROUND8，2026-11-01）

> 对象：当前未提交工作树，重点核验 ROUND7 之后的修复。
> 本轮只做独立只读审查、现有门禁复跑与定向反例，**未修产品源码、未修改测试实现**。
> 判定分别标注“确实已修”“仍有缺陷”“验证不足”，不把旧缺陷当成新缺陷重复计数。

## 1. 总体判断

**上一轮确有实质进步，但“W0–W5 全部完成、只剩硬件现场验收”的结论仍不成立。**

较可靠的成果：单组模拟解算的共享调度；浮点短间隔日志时间；manual 目标进入配置；定长蓄水池与预定稳态累计；SO(3) log 误差分解；加计验证复用生产链路；后段评分改用前段训练；批次取消结算和世代隔离；逐步姿态/时间比较；全部15个文档页的实际激活。

主要剩余风险已收敛到四类：

1. **连接生命周期没有完整覆盖自动重连和订阅 await**；
2. **校准仍能接受错朝向/严重病态输入，档案可静默丢失无效模型**；
3. **导出历史会被当前标定重算，连续重导出回放仍可二次校准**；
4. **测试仍有复制算法、伪容量、宽松 schema 和弱恢复判据，不能充分守住修复**。

不再给“92/100”一类缺乏量表的总分。当前适合限定表述：**教学功能丰富，默认模拟主路径可用；真实接入、数据闭环和验收治理尚未达到稳健交付标准。**

## 2. 本轮实测门禁

严格顺序：`npx tsc --noEmit` → `npm run check` → `npm run build`，随后 budget、smoke、coverage。

| 检查 | 当前结果 | 解释 |
|---|---|---|
| TypeScript | exit 0 | 类型一致，不证明数学/异步语义 |
| check | **155 PASS、0 FAIL** | 121数值 + 10几何 + 15HTML + 2文档检查 + 7状态计数；不是文档中149 |
| build | exit 0 | 本轮未提交/推送，不等于线上版本已更新 |
| budget | **10项 PASS** | 总产物1899KiB/2048；主JS约278KiB/285、gzip106KiB/108；Worker42KiB/64；HTML536KiB、gzip186KiB/195 |
| smoke | **78 PASS、0 FAIL**，exit 0 | 覆盖当前成功路径；不能替代定向负面契约 |
| coverage | 语句 **96.70%**、分支 **81.73%**、函数 **95.65%** | runner语句91.78%；测试命令没有强制阈值，CI亦非全部覆盖 |
| soak | **本轮未重新执行分钟级长稳** | 已读取现有2026-10-31报告：batch=true/reconnect=false，verdict.pass=true；保留它为历史证据，不写成本轮通过 |
| 视觉/真机 | **本轮未新增验收** | 浏览器运行环境可发现IAB，但没有可用于本轮结论的新判读截图；无真实设备30min记录 |

日志：`.audit-current/2026-11-01/{tsc,check,build,budget,smoke,coverage}.log`。运行测试的主要TEMP/TMP/profile放D盘，未删除C盘缓存或终止用户进程。

## 3. 确实已修：不应继续重复报告为现行缺陷

定向验证直接调用生产核心；统计私有类仅在仓库外副本增加export，类体不改。

| ROUND7问题 | 当前生产实现证据 |
|---|---|
| 旧批次watchdog复活/无Worker混批 | 旧seed100×2取消，新seed800×2，推进20秒，仅运行 `[800,801]`，timer=0、fallback=0、旧Promise已结算；回退路径也隔离 |
| 小数毫秒截断 | 400Hz日志 Σdt≈1秒，首帧dt=0；但大空洞另有残留（见后文） |
| manual依赖全局 | 改全局目标不再改变相同配置结果，终态差0° |
| 分位数周期混叠/容器随时长增长 | 65000/130000点：errors/times均60000，resErr/resT均20000；生产P95=9.980267° |
| 稳态切桶污染 | 显式1.48秒切点，窗口前100°、之后0°，生产稳态RMSE=0° |
| 小角近似用于90°/180° | log向量90°/180°返回正确角度 |
| 加计验证2k/不同非线性 | 当前共享accelChannel，对无噪/含噪/任意姿态及非1g模型对拍最大差0；k=.005的+z两侧均0.04903325 |
| 后段75%训练泄漏 | 当前后段报告0.20594643936838064，等于前300点模型，不等于交错训练模型0.14575463220495197 |
| M=0假成功 | 同读数六面、全零、恒定2g已返回null |
| 历史恢复共享对象/仍在采集 | 当前历史恢复深拷贝、collecting=false、samples=0、验证行清空 |
| 只比较终点 | 已逐步比较t和q：中途改10°但终点不变会失败；输入/事件契约仍不完整 |
| 对比度漏扫5页 | 当前已激活并核扫描集合15/15，不能再称“仍漏扫”；AA不是AAA，也不是视觉验收 |

## 4. 当前高优先级残留

### P1-A：自动重连及BLE订阅仍绕过连接世代

位置：`src/main.ts:5345–5364,5977–6001,6051–6075,6182–6197`。

实测生产函数AST抽取 + 严格port/EventTarget：

- 自动串口open挂起 → 用户断开 → 原await完成，仍 `running=true, portOpen=true, reconnects=1, lastPort=null`；
- 自动BLE connect挂起 → 用户断开 → 旧await完成，仍connected=true；其通知仍经真实解析器入队；
- 串口自动重连挂起 → 导入回放 → 旧await完成，可同时serial=true和replayFrames=60；
- BLE只在 `bleSubscribe` 前检查世代；startNotifications期间换回放，完成后仍提交ble=true；
- 特征A.stopNotifications挂起期间切来源，续体仍订特征B或留下B监听。

**影响**：用户的断开/切源意图不可靠，旧连接重新占资源并向新实验写帧。

### P1-B：串口→BLE切换会使本次BLE自己失效

位置：`src/main.ts:6133,6149,5371,6182`。

BLE先捕获generation；内部调用serialDisconnect又递增generation。因此已连串口后发起一次BLE连接，输出 `serial=false, ble=false, gatt=false, notifications=0`，旧device引用仍可能保留。

这是**当前真实装配逻辑问题**，不是“需要再模块化才优雅”的偏好问题。

### P1-C：旧reader收尾能破坏新连接；异常端口不close；耗尽仍永久冻结

位置：`src/main.ts:5428–5435,5329–5336,6087–6090`。

- A.read挂起 → 系统断链 → 新B连接 → A返回done，旧finally将B.running=false、port=null、queue清零，B reader还锁着；
- 严格“端口已经open”的mock：最终open=4、close=0，三次重试均already open；
- 串口/BLE在1/3/7秒连续失败后仍 `reconnecting=true, timerPending=false`，主循环继续冻结。

**影响**：看起来自动重连，实际无法真正恢复；“取消后不会回来”和“失败后回模拟”都未完整成立。

### P1-D：空窗虽不再推进仿真，但数据源/真值身份仍错误；BLE仍重置轮次

位置：`src/main.ts:5651–5659,383–406,3906–3917,6100–6129`。

- 串口空窗 t=24冻结、simulation步骤0，确实修了数据混入；但kind仍simulation、reference=groundTruth、real=false；
- BLE lost先cleanup再排重连，实测t24→0，reset=1。

**影响**：真实记录在空窗可能被标成模拟真值，UI控件与导出标签语义错；BLE记录仍被清空。应独立表示来源身份与连接状态，不依赖“当前是否running”推导全部语义。

### P1-E：错朝向/病态校准仍可成功；无效档案被静默默认化

位置：`src/main.ts:260–289,3419之后档案恢复`；`src/core/accelcal.ts:150–193`；`src/core/experiment-config.ts:230,465–492`及archive解析。

已修零矩阵不代表全部输入合法：

- 251点实际+z读数可按+x保存；采样间隙也未按连续时间覆盖核验；
- 单面误标仍拟合成功，M=`[.5,0,0,0,1,0,.5,0,1]`，RMSE轴值约2.31145；
- `diag(1,1,2e-6)`配较大偏置仍可拟合，条件数约**500000**，留一模长误差接近0；
- parse零矩阵确实返回null，但 `parseArchive`仍ok=true、Applied=true——无效模型被丢掉而档案宣称恢复成功；
- 负/零对角scale、非正定full矩阵、缺失/原始类型config等仍可进入宽松默认迁移；
- 档案apply只清加计采集状态，磁collecting/samples/旧验证行仍保留并共享传入对象。

**影响**：用户看见“拟合成功”“档案恢复成功”，实际模型无效、被丢失或被旧采集状态污染。

### P1-F：历史导出和连续往返仍不闭环

位置：`src/main.ts:4683之后exportCsv,4773之后exportRawCsv,日志记录与回放入口`。

实测原记录/导出函数：

- 同一历史mag行，在更换当前offset=5后导出30→25，记录本身仍是30；
- calibrated回放再全帧导出强写raw，多轮实际consumed mag **25→20→20**；
- 对照真正raw链多轮始终25不变；
- calibrated旁路还可手动重新开启，再次校准且状态标签不准确。

上一轮并未改逐行实际输入记录，因此“导出闭环全部修复”仍过强。

### P1-G：日志大空洞仍被压缩

位置：`src/core/serial.ts:97–101`、`src/core/replay-player.ts:99–103`。

`logIntervalSec(0,30000)=10`。两帧时间0/30000ms，1×仅播放10秒就吃完，Σdt=10秒，但played显示30秒。

**影响**：小数时间修好，大空洞时间完整性仍破坏。需要保留真实30秒间隔，通过子步数量/预算处理安全，不静默改时钟。

## 5. P2：仍需约束的边界

1. **统计结束口径靠99%猜终止原因**。`runner.ts:348,574–580`：计划1.007秒，在1秒钩子取消仍exact；正常1.1秒/1Hz反报early-stop（末解算在1秒）。1.006秒/100Hz Σdt只到1秒，结束world到1.006秒。应记录请求结束、实际结束、末解算、终止原因与剩余尾时间。
2. **采样前端极低采样边界**。`sensor-pipeline.ts:100–110,133–145`：允许5Hz/250ms，t2.002秒读数时间1.802秒，年龄200ms小于配置250ms，保留策略丢掉插值下界。启动首帧年龄0ms、50Hz零delay缺times，需预热与完整timestamps语义。
3. **真实路径回调重复**。`solve-loop.ts:192–205,243`：一reset两onAlign；三子步t均相同、aligned=false；0dt仍调用估计器和积分回调，不等“首帧跳过积分”。
4. **trace事件标错帧**。`runner.ts:400–405,440–448`：align实际3.002秒，却标前帧3.000秒；violent/8s可有162条gate-reject，trace.eventCounts仍空；缺dt、raw、consumed IMU。
5. **initialAttitude.axis仍未深拷贝**：修改clone.axis[0]=9会污染原配置，说明“深拷贝配置”仍有遗漏。
6. **Worker协作cancel协议仍不能收消息**。同步start(job77,3×10s)紧跟cancel，真实Node Worker返回done、3progress、cancelled0。主界面terminate已有效，这是协作协议缺陷，不能重复记为批次隔离失败。

## 6. 测试盲区：修复本身有效，回归未必守得住

### 6.1 生产统计未被新的容量/抗混叠用例直接测试

`scripts/selftest.ts:3292–3340` 用m.n填“容量”、res/buckets写0，并另复制Algorithm R。执行实际测试块、给它“无界数组/p95=NaN/n正确”的假runner仍PASS。

本轮真实生产类容量/周期P95/边界稳态均正确，但永久测试可在实现再次退化时继续绿。应抽测试友好的只读统计diagnostics或独立类，直接给生产实现输入，禁止在测试中复制答案。

### 6.2 真逐帧比较已修，比较器schema/完整性仍弱

`browser-smoke.mjs:1237–1290` 中间10°错帧可fail；但以下负面输入仍PASS：双方只1501帧、runner多尾帧、双方倒序、每帧空quats、中途NaN、非单位w=2。

它只比一个受限配置的t/q，assert阈值1e-3°；5.12e-6°是当次观察，不是门禁阈值。应先验长度/五算法/有限单位q/严格时序，再比dt/IMU/事件。

### 6.3 doccheck是有限的范围检查，不是复算

`doccheck.ts:28–48,65–109` 已能拒绝null数值和缺引用ID，但以下仍exit0：全部引用删除、空records、records数组/字符串；P50=170/P95=1、重复算法ID、Wahba=-99、acceptPct=9999、圆锥中间误差9999。null根或metrics还抛未捕获TypeError。

严格schema、完整性、关系约束应分别建立；CI `.github/workflows/deploy.yml:35–63`没有只读基准复算，正文数字亦未绑定存档。不要把命令名称或注释中的“复算”当实现证据。

### 6.4 soak恢复判据和范围声明仍弱

`soak.mjs:90–100,244–280` 的dropEvery只改预期，真实固定60帧断链。序列 `(t,frames)=(1,1)→(1,1)→(2,2)` 中间停流仍PASS；全离线采样10→0→11回退也PASS。零容量使用和缺堆测量不算失败/缺测。

当前已分开batch/reconnect，启动先验running，新日志三批为4.8/4.1/4.3秒，**不能继续用旧log第二批0秒当现行复现**。但soak未绑定generation与完成结果，未记录逐次恢复事件和正增长。

### 6.5 文档与验收治理

- 状态计数只验首块/首行、部分项数硬编码，后文总数改999仍PASS；PROJECT-STATE当前分项合155却写149，预算七/十项混用。
- AA逐页激活已真实补漏15/15，不代表AAA或图像布局验收。需要真正注入低对比度负面对照。
- 本轮没有新视觉验收。前次截图返回“media omitted”不能推导布局被实际看见；新修复前应确保图像通道可用。
- 预算现已主JSgzip98%、HTMLgzip95%，必须保留冻结参照和加载/交互性能数据，不继续按绿门禁冲容量。

## 7. 后期实施方案（下一轮的具体包）

**先完成软件P1，再安排硬件验收；不是只剩真机。** 不建议继续“大包一口气然后全部✅”：每包给独立红测试、修复证据和有边界的完成状态。

### A. 连接所有权统一（P1，第一优先）

文件：main串口/BLE/reconnect、reconnect核心、data-source。

1. 一次切源先递增意图generation，再用不额外递增的内部dispose清旧链；避免BLE切换自己作废。
2. 初连/autoReconnect/特征切换共用token。每个await后验token；过期时仅清自己句柄/监听，不能清新连接。
3. reader loop捕获port/reader/generation，finally只处理它自己的连接；先cancel/release/close再重open。
4. pending/in-flight/exhausted/disabled各状态明确；耗尽归idle/error，reconnecting=false，不永久freeze。
5. source.kind和reference保持原来源身份，transport.status单独表示重连；断链时禁止模拟数据和模拟真值标签。

**必须通过的负例**：自动open→断开、自动GATT→导回放、订阅await→切源、A读完→新B存活、串口→BLE一次成功、严格open端口回收、耗尽后不freeze。

### B. 导出/回放不可变契约（P1，第二优先）

文件：日志/recordRaw/exportCsv/exportRawCsv/replay解析与播放器。

1. 每行保存raw来源语义与当时consumed IMU/校准版本；导出只序列化记录，不按当前标定重算。
2. 已校准来源的“全帧原始”改称“源IMU”，preserve semantics；不再强写raw。
3. calibrated旁路禁止重复应用，或要求明确实验override并正确标记，不宣称强禁止但又给默认开关覆盖。
4. 浮点delta保留真实空洞；预算耗30秒就显示30秒，积分拆安全子步，给CPU子步上限与分拍机制。

**验收**：两次以上连续导出/回放输入逐帧不变；换标定后历史导出字节不变；30秒空洞played/Σdt/预算均30；空/坏样本拒绝，不填0。

### C. 校准完整性和配置恢复（P1）

1. 校准采集验朝向、连续时间覆盖和点密度，采集面与读数不匹配即拒绝。
2. 求解验条件数/奇异值、合理增益/偏置/残差阈值；磁full验对称正定或约定合法校正结构。
3. 严格“当前schema档案”与“旧版迁移”分流；错误模型返回problem，不默默改null并报ok；Applied不能true而模型null。
4. 档案apply磁/加计都停止采集、清pending/旧样本/验证行；恢复模型深克隆含axis/validation/fittedWith。
5. 留一用向量误差/朝向误差，不只模长；真实跨时段数据接口后续另验。

**验收**：+z误标+x必拒、单面误标整体拟合拒或明确失败评分；条件数50万拒；null/primitive配置拒；零/负/不正定模型明确报错；改clone.axis不影响原；档案导入后无旧采集活动。

### D. 时间、事件、trace与统计永久测试（P1/P2）

1. 生产统计独立模块/只读capacity diagnostics；直接输入周期频率/相位扫描与边界阶跃，断言固定容量与误差范围。
2. 显式run termination reason，分别reportrequested/end/lastSolve/pendingTail；不要用99%猜early stop。
3. applyFrame单次事件、子步t递增；0dt作为首样本初始化而不积分；trace用onSolve.aligned记当前步且包含raw/consumed/dt/所有事件。
4. 采样历史保留目标两侧+采样周期余量；低采样5Hz/250ms组合、warmup、零delay路径times清晰。
5. 比较器验证精确帧数、五算法、finite/unit q、时序；在一个完整fixture中改变中间IMU/dt/align但终点不改必须fail。

### E. 门禁schema、只读复算和长稳证据（P1/P2）

1. doccheck严格schema和关系校验；只读小基准复算对比存档，正文数字由记录生成/比较。缺全部引用/空records/错排序/负错误/超100%接受率各自fail。
2. statuscheck从共同machine-readable manifest核当前段，历史标历史；不要继续硬编码更大常数“修计数”。
3. soak按实际drop事件、恢复时刻、逐段连续帧正增长判断；dropEvery真实控制注入。缺heap/未触顶分项记未验收。
4. 批量绑定generation和expected seed count，不只看running/完成文案；日志记录全部判据/时限/退出码。
5. UI错误跨所有page统一收集并结束汇总；AA负对照覆盖原漏5页；真正能看图时做桌面/窄屏/文档/打印视觉验收。

**长稳**：软件独占环境10分钟分别batch和reconnect；真机串口/BLE分别30分钟，包含拔插/离开范围/休眠/设备重置。软件mock不填硬件验收，3分钟不改叫10分钟。

## 8. 证据索引与覆盖限制

门禁日志：`.audit-current/2026-11-01/`。

仓库外生产反例：

- `D:/round7-readonly-audit-ZrvAFCir/counterexamples.ts`、`followup.ts`、`zero-startup.ts`及JSONL：统计、时间、trace/回调；
- `D:/audit-round7-5GarArkh/audit.mts`、`results.txt`：生产校准对拍、退化/朝向、档案/history/export；该子审查最后汇总受提供方速率限制中断，但上述**已经执行保存的结果**可读取核验；未运行结果不写入结论；
- `D:/zcode-readonly-lifecycle-20261101-gDvjgK/audit.cjs`、`run.log`：旧批隔离、自动重连/订阅/旧reader、严格端口、真实Node Worker；
- `D:/zcode-readonly-scripts-20261101-FNMW8B/audit.cjs`：生产脚本VM负面schema、比较器、soak与伪容量测试。

AST/VM硬件夹具不是实际浏览器或真机；它们证明具体逻辑契约会失败。下一轮应将这些输入转为永久测试，而非再次写测试中的“同算法答案”。

## 9. 交付停止条件

当 A–E 关键负例仍能复现、doccheck只范围检查、trace只q/t而不验事件/输入、硬件或图像未验收时，不得将相应项标“全部完成”。

**本轮结论：修复方向已经正确，部分生产实现真正变好了；下一步应补齐连接与记录所有权、输入校准契约和生产负面测试，避免用新的绿测试继续掩盖残留。**
