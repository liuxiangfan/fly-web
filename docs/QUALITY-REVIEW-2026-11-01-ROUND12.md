# 第十一轮完成质量独立复核与后续建议（ROUND12，2026-11-01）

> 对象：当前未提交工作树，重点核验 ROUND11 报告附表之后的修复。
> 本轮复跑现有门禁、执行工程外生产反例、更新审查与恢复文档；**未修改产品源码/测试实现，未提交、推送或部署**。
> 结论分别标“确实已修”“仍有缺陷”“未验收”。AST/VM夹具证明逻辑契约，不等于真机验收；夹具失败不算产品缺陷。

## 1. 总体结论

**第十一轮有真实进步，但“R0–R5 已实施并验收完毕”的总体完成声明仍然过强。**

最重要的有效修复是：逐子步即时回调确实恢复了INS积分正确性；0dt不更新；旧reader迟到value被丢弃；BLE无notify特征的已知失败分支释放资源；源列导出按记录语义标注；部分档案原始类型与未来版本拒绝；旧采面时间反例被拦；doccheck已拒绝此前几种物理不合法值；窄屏错误采集和soak CLI也修好了。

但软件还不满足稳健交付标准。核心残留已集中到：

1. **超限时间只是记数，没有分拍恢复，也没有UI报告**，回放时钟与积分时钟脱钩；
2. **系统级串口drop仍没正确释放读锁**，BLE异常、重订阅乱序和后续掉线监听仍有生命周期漏洞；
3. **消费快照跨reset残留，导出仍缺消费时刻契约**；
4. **strict档案只验“声明了的部分字段”，嵌套坏输入仍默认化**；
5. **校准结构验证不一致，测试夹具和门禁仍能放过坏契约**。

建议暂不增加教学模块。下一步不是继续堆更多PASS，而是将上述独立生产反例变成能否结项的硬条件。

## 2. 本轮门禁实测

严格顺序：`npx tsc --noEmit` → `npm run check` → `npm run build`；随后budget、doccheck全量复算、smoke、coverage。

| 检查 | 结果 | 说明 |
|---|---|---|
| TypeScript | exit0 | 类型一致，不代表状态/数学契约一致 |
| check | **161 PASS / 0 FAIL** | 124数值 + 10几何 + 15HTML + 3文档 + 9状态 |
| build | exit0 | 本地构建，不等于线上版本更新 |
| budget | **11项PASS** | 按第十一轮上调后的288/110 KiB主包限制与SW单列口径 |
| doccheck --recompute | PASS | 本轮复算阶段约15秒；同一生产生成器只读重算真实存在 |
| smoke | **88 PASS / 0 FAIL** | 证明这些断言通过，不证明所有夹具忠实或所有路径覆盖 |
| coverage | 语句 **96.96%**、分支 **81.76%**、函数 **95.87%** | runner分支71.62%、archive68.25%、配置70.45%；无阈值约束 |
| 600秒长稳/真机/视觉 | **本轮未新增验收** | 秒级smoke/前轮30秒soak不是10分钟；无真实设备/可判读图像证据 |

本轮日志：`.audit-current/2026-11-01-round12-171454/`。

### 2.1 预算必须按事实报告

当前Node v24.14.0、主包 `index-DycL5U0P.js`：

- 主包原始 **293811字节**，gzip **111313字节**；SW原始2743/gzip1308字节。
- 新主包上限110KiB=112640字节，余量 **1327字节**。
- 原主包+SW上限108KiB=110592字节，而当前两者gzip合计 **112621字节**，超原口径 **2029字节**。
- 原始主包293811也超过旧285KiB=291840字节。

SW单列可作为更清晰的预算分类，但上限285/108→288/110确实是**放宽限制**。上一轮“据实测增量，非抬预算过门禁”措辞不准确：新门禁通过不等于原预算达标，也不应把容许增量表述为已经减体积。保留完整总量与全部JS传输参照，性能改善需独立测量。

## 3. 本轮正向复核：确实已修，不重复记为缺陷

| 条目 | 实际生产证据 |
|---|---|
| 即时子步回调与INS | 1秒/20步，批次与逐单步生产对拍位置均 `[0,1.5560335528,0.3971088631]`，速度/位置一致、q差0°；首回调横滚2.8648°、末57.2958° |
| 0dt | 回调0次、互补遥测未改变，不再出现原0dt correction NaN |
| 旧value与旧done | native ReadableStream夹具分别验证新B队列保持、帧增量0、新reader仍锁着 |
| 普通reader异常重连 | readable真正解除锁后可关闭并重开；但冗余关闭仍有记账问题，见下 |
| 无notify BLE初连分支 | GATT断开，设备lost监听0 |
| 旧采面时间反例 | 同刻、49同刻+末点、400ms断流、容量先达而不足0.5秒均拒；正常覆盖通过 |
| 部分strict拒绝 | duration字符串、未来v999明确报错；notes对旧版显示黄色警告 |
| 旧坏run半提交 | malformed run虽仍可抛TypeError，但真实import函数在apply前失败，applied=0；此旧半提交问题已修 |
| 校准已知反例 | diag(-1,-1,1)、非法字符串faces拒，方向验证指标往返保留，已知deepclone隔离有效 |
| doccheck已知负例 | P50反序、Wahba负误差、接受率9999、圆锥9999、全部引用删除均exit1 |
| 小屏与CLI | 窄屏console/pageerror注入能使错误检查失败；`--drop-every=3`/`--dropEvery=3`均得到3 |
| 原有trace负对照 | 非单位q、NaNq、明显中途姿态错、错时序等既有对照仍有效；完整输入/事件覆盖未完成 |

源列/消费值改成快照和语义分流是正确方向，但其reset/导出时刻等剩余契约见P1-3，不能据单次不可变导出宣称完全可复现。

## 4. 当前软件P1

### P1-1 超长帧并没有分拍，丢失的积分时间被改名为deferred

位置：`src/core/solve-loop.ts:207–241`，`src/main.ts:6038–6069`。

生产实测：

- `applyFrame(...30秒, maxSubsteps=100)`只积分约5秒，deferred=25。再输入下一帧0.05秒后，累计只积分5.05秒，回调时刻却跳至30.05，deferred仍25；安全完整积分参考是30.05秒。
- 默认上限4000/50ms下，两帧0/300000ms的回放：播放器cursor=2、done=true、played=300、帧dt总和300；**估计器/INS仅积分200秒、最后solve时刻200、deferred100**。
- `SolveLoop.reset()`之后deferred仍保留；main.ts中没有读取deferredTotalSec/resetDeferred的接线，用户只收到绿色“回放完成”，没有缺失100秒的提示。

当前实现改善了“不能增大安全子步”的一半，却没有兑现“下一拍继续处理”。永久测试被改成接受“Σdt=5、记账25”，因而把**丢弃时间**本身写成绿验收。

**建议**：由回放调度器保留pending frame（sample、remainingSec、currentT、truth/source信息），每拍在CPU预算内做≤50ms积分，后续帧不得超车。remaining=0之后才提交cursor/played/record/完成提示；reset/cancel清pending。若产品选择不补长空洞，就明确以断段/未积分状态停止、列出数据缺口，不能正常完成并宣称完整回放。

**必过反例**：300/1000秒日志多拍后积分Σdt、INS.t、played、完成窗口一致；每步≤50ms；超限帧与下一帧顺序不乱；有pending时done=false；reset旧pending不复活。测试禁止把“余量已永久丢弃”当通过。

### P1-2 串口系统事件路径仍跳过cancel/release，close失败后还继续open

位置：`src/main.ts:5493–5532,5607–5624,5682–5699,6765–6772`。

忠实native ReadableStream锁约束下：系统disconnect仍直接releasePortHandle，没有先cancel/release当前reader；pendingReader只在另外的释放函数里赋值，这一路没赋。

实测：**端口仍open、reader locked=true、open4/close7、四次close失败、0次重连成功，最后状态切模拟**。记账不再先减0确实改善了，但资源本身仍没收回。

`closePortVerified`返回false后，自动重连忽略它而执行open：注入close失败时生产trace仍“close失败→close失败→open→already open”。普通报错重连虽然成功，还发生重复close、已关闭端口再close失败等不精确记账；openPorts标量不能可靠区分资源实例。

**建议**：用捕获会话的一个async disposePromise统一主动断开、系统drop、reader异常和重开；真正等待cancel/read完成/release/close；不得在close失败时open。成功关闭同一资源只记一次，失败状态保留error/资源占用，不能切模拟后假装资源已经退出。

### P1-3 新消费快照未随reset清除，消费时刻未进入导出契约

位置：`src/main.ts:2953–2988,3882–3917,4830–4930`。

AST原生产函数反例：

1. onSolve在旧轮t=.01消费mag25→调用生产resetSim→新轮首个25Hz记录时刻.04、尚未有新solve，consumedSnapshotFor(.04)仍返回**旧轮mag25**。快照只验t不验run generation。
2. 旧轮t=.12→reset→新轮.04：快照为null，但lastSolveInput.t仍.12、Number.isFinite仍true，LogRow可留下旧时刻。
3. `consumedSolveT`已存入LogRow，却在exportCsv代码中完全未使用。低频解算下消费者不知道“这一行是哪个solve时刻的输入”；导入回放仍按行t把它当新样本。

**建议**：最近消费存 `{runId,solveId,t,dt,sourceCalibrated,raw,consumed,calibrationRevision}`，reset清null并推进runId，日志只引用同run的消费。导出源数据与solve trace各自有明确时间轴；若消费列仍附在25Hz行上，应导出消费时刻/solveId并禁止声称它能完整复现原采样。首帧/null不能填0假有效。

### P1-4 BLE生命周期仍有异常分支、同特征竞争和二次掉线缺监听

位置：`src/main.ts:6341–6373,6450–6487,6505–6527,6639–6717,6724–6742,6782–6796`。

- 服务发现抛异常（不是已修的“空notify列表”分支）时：BLE状态false，**GATT仍true、lost监听1个**。
- 旧BLE connect await reject，在新串口B已running且queue=1后，catch没有generation判断，调用全局bleCleanup把**B queue清0**。
- 同特征same generation快速重订阅：新尝试已提交listener1，但旧start迟到后stale分支stopNotifications，**notifying=false、随后帧增量0**。只看“监听数恒1”的mock不证明通知实际活跃。
- 新特征订阅失败：旧特征已stop/摘监听，state仍connected=true，UI未捕获reject，出现**unhandledRejection: notify rejected**；没有恢复合法旧订阅。
- BLE自动重连失败时disposeBleAttempt摘lost监听；随后重连成功却没有恢复监听。第二次真实EventTarget断链后 **GATT=false，状态connected=true，lost监听0、没有重连**。

**建议**：设备/订阅回调闭包绑定session与subscription id，catch/finally也验归属；同特征共享notify状态不能由过期续体stop，采用串行事务或资源引用归属。失败回滚旧订阅（或显式error停止），全部Promise拒绝被捕获。每次新/重连成功都安装当前会话的lost监听，先摘后挂；废弃只摘自己注册的回调，不动替代会话。

### P1-5 严格档案仍只验部分顶层已声明字段；校准合法性判据不同步

位置：`src/core/experiment-archive.ts:58–156`，`src/core/experiment-config.ts:389–592`。

**strict反例**：当前v3仅`{schemaVersion:3}`、empty imu/estimators/initialAttitude、`imu.gyroNoiseDps="bad"`、`estimators.mahony.params.kp="bad"`、fixed-axis.angle字符串均 **ok=true、notes=[]**，被静默默认。缺字段、nested字段和required算法列表没有验证。版本为字符串/负数被当旧版迁移而不是明确非法版本。

**校准反例**：

- 磁full缺matrix：`calibrationProblems/validateExperimentConfig`均[]，parse拒。所谓共用判据仍产生两个标准，缺matrix在`if(M)`之外被绕过。
- 加计非对称 `[1,3,0;0,1,0;0,0,1]`被parse/validate接受。**Sylvester判据只可用于对称矩阵**；不能把通过几个主子式称为一般非对称刻度矩阵“正定”。加计实际模型允许安装/交叉轴，需明确使用本项目的near-identity结构与奇异值/增益，而不是误用SPD术语。
- count0/faces[]、单面/重复面、rmse=.49g等仍接受；parsing会筛掉非字符串faces，使原坏输入在parse后变成成功。mag偏移1000/residual.9/count0也通过，阈值虽有边界却不足以支撑“可用标定”。
- 采面拒掉四个旧时间负例，但49点集中首1ms、后面稀疏覆盖也可成功：等权均值不是时间均值。对真实采集应检查密度/时间权重，避免名义0.5秒均值实际被短簇支配。

**建议**：v3在迁移前严格验required+全部nested字段；旧版仅白名单迁移且每个修正均有notes。原始cal模型先验形状，不过滤错误元素；拟合/导入/应用共用同一合法性评估。磁fullSPD、加计合法刻度/安装结构分别定义；拟合质量/覆盖不达标应明确reject/warn状态，不用过宽范围自动宣称成功。

## 5. P2与验收治理不足

### 5.1 永久测试仍允许实现自行放宽“完成”的定义

- `scripts/selftest.ts:2866–2973`把长帧验收从完整Σdt30改为Σdt5+deferred25，却没要求后续补完。应对完整任务验收，不是仅当前函数新实现验收。
- `scripts/browser-smoke.mjs:2120–2205`旧value和done放在同一条read上：lateValue完成后没有第二个pending，finish=false仍不要求finished=true，因此“旧done也通过”不是这个永久用例实际证明的。独立native夹具的old done正向是真实有效的，须永久分成两例。
- 严格锁冒烟`2210–2266`让测试人工`__lockAll(false)`，锁不由真实cancel/release改变。它证明“人工解锁后重开”，**不证明应用自动释放锁**。用真实ReadableStream.locked和close约束，否则刚复现的系统drop会继续绿。
- BLE同特征mock不模拟真实notifying状态，stop后仍能__emit，这会藏住本轮“监听1但通知已经停了”。

### 5.2 trace/doccheck/soak/status还有原残留，不能标R5完成

- trace（`1433–1546`）7类新增坏契约仍fullCheck=true：runner dt900、UI正dt900、删除runner输入、NaN输入、删事件、身份全pure、双方删200内部帧剩1800。t/q的旧负面对照已有效，不再称完全没比较。
- doccheck（`141–169,213–248`）新P50关系/负误差/百分比/零引用确实拒绝，但空config+samples0、5重复seed、窗口100..999、5s/50Hz/250样本仍默认通过；渲染块（`benchmark-records.ts:161`）硬写“30s/10种子/15000样本”。正确的正文应从实际记录的配置/种子/样本数生成，或对这些固定基准明确验固定值。
- 默认doccheck没有调用cheapOnly复算，CI/full --recompute真实存在并且本轮通过，应分别标范围而不是抹掉已修复算。
- soak（`335–386`）CLI已修，但加入opens门槛后仍接受：全程离线但累计计数增长、帧10→0→11、某次重连无帧后下一次恢复、missing heap/零容量、仅一批/一行/世代倒退（只是布尔!=，无expected seed结果）。真实事件段与每段firstFrame/recovery仍未绑定。
- statuscheck（`73–158`）当前首标题数字改999不报、删除budget声明也可pass0处；当前/历史没有机器边界。不要继续改更大常数“同步数字”。
- run metadata仍可接受对象并在describe抛TypeError，但真正import现在**apply0**，是结构化错误不足，不是旧半提交缺陷；不要重复报告已修问题。
- termination未解算时lastSolve伪时间、低解算率align遗漏、Worker同步cancel等前轮P2仍在，无本轮新完成证据。

## 6. 推荐下一步顺序（先闭环，再长稳）

### S0 验收事实校正与冻结范围

将本报告确认的生产反例转永久红测试。完成状态逐契约列出，不再整包“已修”；长期测试/硬件/视觉保持未验收。预算保留原参照与现限制，明确上调代价；先剔除重复实现、消除临时不必要调试接口与类型绕行，不能为几百字节引入新的状态语义。

### S1 真正分拍执行与run-bound消费快照（最高优先）

- pending replay帧有持久结构与pump入口，每拍只处理预算内≤50ms，未处理时间必须保留sample/qTrue及校准语义，后续帧排队。
- 只有剩余归0才发布帧完成，显示已处理/待处理，不提前绿色完成。
- reset清pending/deferred/lastSolveInput，并用runId隔离跨轮。消费值导出有独立solve时间、dt、id，不冒充源采样。

**验收**：300/1000秒多拍总积分一致、下一帧不超车；reset后新首行无旧值；null/初值不制造有效消费；批次INS与逐安全步数值对拍。

### S2 会话事务统一dispose与订阅（P1）

- 串口四条出口共用capture-session async dispose，cancel完成后release，再close；返回false不许open；可重用disposePromise防重复close，状态记账按唯一资源结果。
- 每await续体包括catch/finally严格归属；BLE失败与订阅回滚为事务，不先永久销毁旧通路再赌新start。
- 同特征竞争不能让旧stop影响新通知；成功重连每次恢复设备事件监听。

**验收**：系统disconnect原生读锁自动解除/旧value及done分别丢弃/失败close不open；旧await reject不清B；服务抛异常无残GATT；same-char乱序后真实通知仍活；首次重连失败→成功→第二次drop再次成功；所有拒绝被捕获。

### S3 原始schema与校准判据统一（P1）

定义strict required+recursive field类型，迁移只用于合法旧版；raw模型结构先验不清洗错误；矩阵判据按磁/加计不同物理结构，合法性/质量/覆盖分层返回。

**验收**：v3只schema/缺算法/坏IMU与kp/angle拒；full缺M解析与validate一致；near-identity加计合法模型保留，非法大交叉轴/坏face元素拒；覆盖和残差不伪称有效；合法JSON往返全字段不丢。

### S4 测试判定独立于实现（P1/P2）

提取纯comparator/validator，补双侧t/dt/IMU/事件与固定expected schedule；真实锁与notifying mock，正向对照+坏实现注入；doccheck默认小基准只读复算/所有指标关系与出处；机器current manifest；soak每段原始事件/firstFrame与结果generation+seeds，缺测分开显示。

**验收**：本轮无效fixture必失败且干净fixture必通过；不人工解锁/不靠手工boolean宣称完整批量；每条红→绿保存日志；默认check实际输出与报告匹配。

### S5 最终软件/真机/视觉验收

S1–S4完成后跑规定全链，分别batch/reconnect **600秒**，独立报告与实际墙钟。随后串口/BLE各 **30分钟**（拔插/范围/休眠/复位），真正能判读图像才做桌面/390px/文档/导出/打印视觉。mock、文件存在、对比度AA均不替代真实硬件或布局判读。

## 7. 本轮证据与限制

- 门禁：`.audit-current/2026-11-01-round12-171454/{tsc,check,build,budget,doc-recompute,smoke,coverage}.log`。
- 时间/快照：`D:/round12-time-recheck-9BlazbUO/{audit.cjs,extracted.ts,results.json}`；主代理实跑exit0，`time-snapshot.log`保存在本轮日志目录。
- 连接：`D:/zcode-readonly-round11-lifecycle-a8dQUren/{audit.cjs,extracted-main.ts,results.json,run.log}`；native ReadableStream + EventTarget +原生产AST。
- 校准/档案/门禁：`D:/round11-quality-readonly-RK0JBL2s/{audit.cjs,production.jsonl,production-results.json,governance-fixed.cjs,results.json,audit.log}`与`source-snapshots`。

时间审查代理被提供方速率限制中断且其目录未落证据，主代理直接执行独立生产夹具；没有预测pending结果或把未执行猜测作为结论。连接审查中重入保护阻止新连接的设想，及其他HARNESS_FAILURE/NOT_REPRODUCED，**均排除**；只采用实际VERIFIED项。

本轮没有新分钟级soak、硬件或图像验收。完整门禁通过与上述隔离反例失败同时成立，不能互相抵消。

**最终建议：把“修复完成”改成“闭环证据完成”。先补pending帧处理、统一连接事务、strict递归和独立验收判定；不要再以改测试期望/提高预算/补注释的方式替代完整实现。**
