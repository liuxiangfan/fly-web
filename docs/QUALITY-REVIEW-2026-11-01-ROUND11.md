# 第十轮完成质量独立复核与下一步任务书（ROUND11，2026-11-01）

> 对象：当前未提交工作树，独立复核 ROUND10 的完成声明。
> 本轮只复跑门禁、检查生产实现、运行工程外反例，并更新审查文档；**未修改产品源码或测试实现，未提交/推送/部署**。
>
> **ROUND12复核限定（2026-11-01）**：本文末尾第十一轮实施附表为历史记录，不代表R0–R5完整结项。即时子步/0dt等确实已修，但deferred仅累加未恢复、消费快照跨reset、串口系统读锁和BLE异常/订阅/后续掉线监听、strict递归和校准一致性仍有软件P1。预算288/110KiB及SW单列确实放宽/改变旧限制，附表“非抬预算过门禁”不准确。当前证据与实施顺序见 [`QUALITY-REVIEW-2026-11-01-ROUND12.md`](QUALITY-REVIEW-2026-11-01-ROUND12.md)。
> 优先级按影响和可达性划分，不按发现数量打分；正常路径通过与负面契约失败分别报告。

## 1. 总体判断

**第十轮有实质修复，但“A–E 全部完成，下一步主要是真机”的结论仍不成立。**

已修的内容包括：串口→BLE 一次切换成功、部分过期连接不再提交、旧 reader 的 done 不再清新连接、重连耗尽退出冻结、全帧源导出保留 calibrated 标签、历史校准列数值冻结、错面和部分病态模型拒绝、配置克隆隔离、默认解算率下的 trace 标记、生产统计容器测试、正文基准数字块绑定、CI 全量只读复算。这些进步不能抹掉。

但本次生产反例确认仍有四个直接影响教学/真实数据可信度的薄弱环节：

1. **子步回调晚于全部姿态更新，INS 把末姿态重复用于之前的每个子步**；
2. **连接资源回收仍不满足 Web Serial 锁约束，迟到的数据和 BLE 回调仍能污染替代连接**；
3. **25 Hz 源列导出仍丢 calibrated 语义，“实际消费读数”快照并非总是实际算法输入**；
4. **严格档案实际上仍默认迁移，校准输入没有完整时间覆盖和模型合法性约束**。

新的门禁能拒绝更多坏输入，但仍未守住上述契约。当前合理定位是：**模拟教学主路径丰富且可运行；真实接入、数据闭环与校准/验收治理尚需软件修复，不能称为完美交付。**

## 2. 本轮实测门禁与证据边界

顺序：`npx tsc --noEmit` → `npm run check` → `npm run build`，随后 budget、doccheck 全量复算、smoke、coverage。

| 检查 | 本轮结果 | 覆盖边界 |
|---|---|---|
| TypeScript | exit 0 | 不证明数学、异步和时序正确性 |
| check | **161 PASS / 0 FAIL** | 124 数值 + 10 几何 + 15 HTML + 3 文档 + 9 状态；152 只是前四项之和 |
| build | exit 0 | 本地构建，未部署 |
| budget | **10 项 PASS** | 总量约1908 KiB；主包gzip仅剩6字节，不等于有增长余量 |
| doccheck --recompute | PASS，复算阶段约4.9秒 | 真实只读重算已存在；默认doccheck未调用cheapOnly重算 |
| smoke | **85 PASS / 0 FAIL** | 证明这些用例通过，不证明其夹具忠实或比较器覆盖完整 |
| coverage | 语句 **97.14%**、分支 **82.03%**、函数 **96.01%** | runner分支71.62%、配置分支69.61%、archive分支66.66%；仍无硬阈值门禁 |
| 分钟级soak | **本轮未重新执行** | 上轮25–45秒结果不是10分钟验收；本轮对原判据和CLI做隔离反例，已发现不足 |
| 真机/视觉 | **未验收** | 没有硬件30分钟证据；本轮截图内容仍被省略，不能据文件生成判定布局通过 |

日志目录：`.audit-current/2026-11-01-round11-151602/`。

### 2.1 必须纠正的前轮结论

- ROUND10末条回复称“视觉上抽查了总览、参考文献、关于本装置三页”，但当时 Read 返回 **Media omitted**。本轮再次通过官方浏览器截图接口尝试，仍返回同样提示。DOM文字可读、截图文件存在均不等于图像已判读。**视觉验收应保持未完成**。
- “每条都先有能失败的负例、再修实现”没有完整红→绿证据支持，不能作为所有条目的交付结论。部分测试在实现之后补写，且经过了更换测试操作路径/判据等调整。
- `serialOpenPorts` 在 close 前就减数，甚至 close 失败也保持0；它不是物理资源已回收的证据。
- `gate-reject` 的“被拒帧数”和稀疏事件日志的“事件条数”不是同一个量：本轮同运行可分别为76和3，报告不可混用。

## 3. 确实已修的正向对照

| 项目 | 本轮独立生产证据 |
|---|---|
| 过期自动open在用户断开后完成 | 不提交running，端口关闭 |
| 串口→BLE自我作废 | 一次成功，BLE通知开启 |
| 旧reader返回done清掉新B | 新B仍running、队列保持、新reader仍锁定 |
| reader主动报错的正常重连 | 先释放再关闭，open2/close1，空窗来源serial/reference=mahony且时间保持 |
| BLE耗尽/掉线重置 | 空窗t=24保持、来源ble；耗尽pending=false |
| 订阅start await期间导回放 | 完成后ble=false、监听0、GATT断开 |
| 全帧源导出calibrated | 解析回calibrated、首磁值25、应用开关锁定 |
| 历史校准列不可变 | 改当前标定后，既有行的导出数值不变 |
| 错朝向/条件数约707107/det<0 | 被拒，正常六面通过 |
| 档案应用清理/深克隆 | 磁与加计两侧采集、样本、pending、窗口、验证行清除；原对象不受修改影响 |
| clone.axis/M/offset | 独立，修改克隆不污染原对象 |
| 30秒日志空洞 | 10秒仅首帧，20秒无第二帧，30秒消费dt=30，played=30 |
| 生产统计 | 65000/130000点容器均60000/20000，P95约9.980267°，边界阶跃稳态0 |
| 显式取消 | reason=cancelled、steadyMode=early-stop；正常1.1秒/1Hz不再误判取消 |
| 门禁改进 | 空records/重复算法ID拒绝；七种既有trace负面对照有效；数字块与存档绑定、全量复算真实存在 |

## 4. 高优先级软件残留

### P1-1 子步“时间递增”了，但姿态没有随回调递增

位置：`src/core/solve-loop.ts:202–221`，`src/main.ts:3865–3867,4982–4984`。

`applyFrame`先更新完所有估计器，存下ctx，再批量调用onSolve。UI的INS回调读的是活估计器q，因此前面所有子步都看到末态。若末帧发生粗对准，前面的aligned=false回调甚至会读到对准后的q。

**生产对拍**（相同输入、相同积分器）：1秒拆20步，全部回调横滚都是57.2958°；逐个生产子步回调应从2.8648°逐渐到57.2958°。最终q差0°，但东向位置 **3.924863m vs 1.556034m**，垂向位置 **2.144162m vs 0.397109m**。

这解释了为什么“末态姿态一致、dt总和一致”无法验收INS正确性。应即时逐子步回调，或每ctx带相应姿态/遥测快照并要求消费者只读快照；推荐前者，结构更简单。

### P1-2 串口锁与所有权仍不完整；记账可以假装回收成功

位置：`src/main.ts:5409–5417,5476–5506,5537–5588,6562–6573`。

- 系统disconnect先close，未先等待reader.cancel/释放锁。严格夹具按Web Serial锁约束执行：首次close报 **stream locked**；随后open4/close1，三次already open；物理port仍open，**openPorts却为0**。
- read循环在await前检查token，但await后未检查。A.read挂起→断开A→连接B→A迟到返回value：旧帧gyro=[7,0,0]仍被解析到B队列。旧done已修，不代表旧value已修。
- 自动重连cancel await后仍操作全局reader，没有再次确认归属；隔离续体测试能清除替代reader并继续尝试旧端口。该项是并发逻辑证据，正式修复须加真实浏览器可达序列。

修复需围绕“会话对象+捕获句柄”建立异步dispose；不是增加一个先减计数的计量函数。

### P1-3 BLE释放和回调仍能影响新连接

位置：`src/main.ts:6197–6255,6388–6421,6425–6515,6524–6543,6584–6595`。

实测：

- 初连获得GATT后发现服务没有通知特征：状态connected=false，**GATT仍connected=true，设备lost监听仍1个**。
- 旧设备GATT续体过期后disconnect，残留lost回调能清掉新串口B队列，B reader仍锁着。
- bleDisconnect在stopNotifications await后用全局device/bleCleanup：并发切源→连接新BLE B→旧stop完成，**B被断开**。此为直接生产函数并发反例，按钮禁用不代替导入/切源等公共入口的所有权保证。
- 同一connectionGeneration内B/C特征选择乱序完成，B和C都notifying，C监听残留1个；需要独立subscription generation或串行化队列。
- 特征切换start失败，UI的`.then()`没有`.catch()`，出现 **unhandledRejection: notify rejected**，旧特征却已停通知。

每个lost/notify回调必须闭包捕获所属设备、会话与订阅令牌；清理只清自己资源，初连失败也必须真正断GATT并摘设备事件。

### P1-4 全帧往返修了，25 Hz源列往返仍会二次校准

位置：`src/main.ts:599–601,709–727,4764–4838`。

- LogRow已保存sourceCalibrated，但exportCsv选择源列时仍无条件标 `# imu=raw`。校准来源25→源列导出标raw→回放应用offset5，实际输入变 **20**。全帧导出修复不覆盖这个默认档。
- imuConsumed在logRow里重新调用observations，不是从最近一次onSolve取实际输入。解算15Hz（核心允许的频率）时，0.08秒行写gyro=.08，最近真实算法输入是.068；0.04秒行甚至早于第一次解算。更直接地：算法消费mag25后改标定，在未更新算法的情况下logRow可记录consumed20。
- mode/reference头部仍使用当前全局状态并把BLE/replay统称real-serial；这不是逐段录制身份快照。对“历史导出字节不变”的承诺应区分数值行与全文件元数据。

应把acquisition/source与consumedAtSolve分开记录，保存solveId/time/calibrationRevision；导出读取录制时语义，不能“根据按钮档位”宣称源读数raw。

### P1-5 档案所谓严格模式仍在修复坏输入，而不是拒绝它

位置：`src/core/experiment-archive.ts:73–98`，`src/core/experiment-config.ts:318–393`，`src/main.ts:3555–3571`。

当前v3档案仅声明schema、duration="oops"、axis中非数值，都返回 **ok=true、notes=[]**，分别被默认到30秒/合法轴。缺config、primitive、数组与未来v999也可以成为默认配置。

strict只对校准对象预检查，随后仍调用宽松migrate，因此不是完整strict schema。旧版丢模型的notes虽由解析器返回，却不在导入UI展示；用户仍看到绿色“已导入同一配置”。坏run.elapsedSec还会在**应用配置之后**才因toFixed报错：界面提示失败，但配置已改。

需要原始JSON结构先验证；v3严格解析、明确支持的旧版才迁移、未来版拒绝。导入应先生成全部校验/提示结果，再原子提交，出错时保持原状态不变。

### P1-6 校准合法性只覆盖了部分坏矩阵，采面时间仍可造假

位置：`src/core/experiment-config.ts:403–429,484–520`，`src/main.ts:261–280`，`src/core/accelcal.ts:132–164`。

- full磁模型应是约定的对称正定校正结构；det>0不等于正定。`diag(-1,-1,1)`的det正、条件数上界3，磁full/加计/strict档案均接受；生产磁校准+粗对准航向 **−180°**。
- tiny `1e-10I`、huge `1000I`、bias1000、负rmse/count、非法faces亦可能被解析接受。拟合路径的偏置/残差门槛没有复用于导入路径。
- 49点t=0+1点t=.5成功采一面；4000点全部同刻也成功，文案是 **0.00秒均值**。样本数和max-min跨度不能证明连续0.5秒覆盖；达到容量应失败而不是代替时长条件。
- 新增方向验证字段meanDirErrDeg/maxDirErrDeg在parseAccelCalibration中丢失，档案往返后没有这两个字段。

模型验证应共用一个生产模块：按磁/加计各自结构验正性、合理增益/偏置/残差、faces/count；采集需严格递增时间、最大间隙和点密度。

## 5. P2边界与验收盲区

### 5.1 时间、事件、子步安全

- 0dt仍更新估计器：互补correction三轴NaN；回放首帧dt=0尚未真正跳积分。
- maxSubsteps=2.5时循环跑3步但步长按2.5算，Σdt=.144而请求.12；NaN/负参数会漏更新或写非有限值。公共数值入口应规范化/拒绝输入。
- 超长间隔通过增大dt来满足数量上限：1000秒/4000步变dt=.25；与生产.05秒子步对拍，Madgwick差23.3342°、Kalman差60.9464°。应分拍执行并保留pending工作，不增大安全积分步长。
- 合法0.1秒/1Hz运行零解算却报lastSolve=.1、tail0；请求1.007跑1.008。无solve用null，末步准确到请求时长，tail口径明确。
- 100Hz下实际align=3.002秒但没有aligned trace步；恢复窗2250帧被当作2250次恢复事件，而三算法实际各进入一次。事件应有独立、带时间/算法/类型的流。

### 5.2 trace比较器仍接受无效的输入/事件契约

位置：`scripts/browser-smoke.mjs:1433–1546`。

隔离执行原page.evaluate函数及最终断言，以下全部 **fullCheck=true**：

- runner某dt改成900；UI某dt正数但改成900；
- runner删除全部dt/raw/consumed；UI的raw/consumed塞NaN；
- 删除aligned和全部事件；五算法身份全改pure；
- 双方同时删除200个内部帧，只剩1800帧但保持末时刻4秒。

目前只比t/q，检查UI部分字段形状。应显式核预期帧数/solve schedule、五个准确id、双边有限IMU、dt/time关系、输入值与完整事件流。不能用“存在字段”替代“内容等价”。

### 5.3 doccheck的schema仍不严，默认无复算；正文绑定只覆盖新数字块

位置：`scripts/doccheck.ts:34–54,78–101,123–151,195–230`。

确认已修空records和重复id，但仍有：

- 全部data-benchmark删除，引用0，exit0。
- P50=170、P95=1，exit0（不需要改数字块：pure记录未在块里显示）。
- Wahba误差−99、接受率9999、中间圆锥误差9999：**同步重生成数字块后**默认doccheck仍exit0。这不是数字块比较失效，而是schema不拒物理不合法值。
- 空config并改samples=0、重复seed、伪窗口100..999仍exit0。
- root/部分metrics=null抛未捕获TypeError，不是结构化字段错误。
- cheapOnly函数存在但默认doccheck未调用；全量`--recompute`和CI确实有效，须保留，不能宣称不存在复算。
- 数字块之外的正文NEES文字改9999，doccheck仍通过。绑定保证应限定到生成块，其他教材数字建立专门来源/容差关系。

### 5.4 soak和statuscheck仍不能据此验收长稳

- **CLI命名不一致**：实际读args.dropEvery；`--drop-every=3`仍得到8秒/800帧，`--dropEvery=3`才3秒/300帧。第十轮“3秒注入”的测试说明不成立。
- makeStream在授权open前就创建初始活动流，替代规则复杂；应只在成功open后创建一条流，严格锁/close约束不能靠幽灵流忽略计数绕过。
- 帧序列10→0→11（离线时回退）、某次重连后不供帧但下一次恢复、所有采样点离线但累计增长仍pass。仅比较同重连计数的相邻live点会漏掉整个失败段。
- heap缺测、容器全0仍被判pass；应把有界性与触顶裁剪、堆测量分别标PASS/FAIL/NOT_MEASURED。
- batch的rows>0和genAfter!=genBefore不是结果完整性：1行、世代倒退、只1批也可pass，没有expectedSeeds校验。
- statuscheck顶层152改999不报错，删除所有budget声明仍pass0处，添加带日期的历史check100又会失败；需机器清单与明确current/history区，不继续堆正则。
- mobile页面没有console/pageerror监听，注入错误仍“控制台零错误”；统一所有页收集并最后汇总。

## 6. 下一步实施计划（按依赖分包，不扩新功能）

### R0 证据与预算基线

1. 先将本轮所有关键反例转为永久测试，记录“修复前失败、修复后通过”；不复制生产算法，不用假容量/先减计数作为验收。
2. 纠正视觉、计数、短稳、事件单位和“全部已修”声明。当前主包gzip110586/110592字节，**余量6字节**。
3. 在不抬预算的前提下消除重复实现/字符串；若拆模块，统计全部首屏依赖与动态加载总预算，不能把文件移出统计集合来假减包。

**验收**：基线日志和源码指纹可复查；原数值golden保留；主包留可维护余量，不以6字节结项。不要为微小压缩引入新的异步或数值语义。

### R1 修复逐子步数据流（第一优先）

- applyFrame逐子步即时更新→回调→最后一次静止检测/事件，确保每回调读取该子步q；若使用快照则INS/遥测/统计必须一起改用快照。
- 0dt仅初始化/记录，不更新估计器/INS；输入验证、整数上限；超长空洞按≤50ms分拍，Σdt和回放预算不丢。
- 显式report无solve/null、accurate end、pending tail；独立对准/拒绝/恢复/卡尔曼事件流。

**红测试**：1秒20步INS对拍位置与速度一致；对准不追溯前步；0dt遥测有限；.12秒/cap2.5按已定义规则拒绝或整数化；1000秒分拍与安全步逐状态一致；100Hz/3.002秒事件不丢。

### R2 连接会话所有权闭环

- 新建最小transport session（generation、port/reader或device/char、disposePromise、status）；共享dispose仅处理捕获会话，不清替代会话。
- 每await返回后、每读值进入解析前确认token；设备/特征事件闭包绑定会话。
- cancel→等待read结束→release→close→确认成功，再重open；记账按资源实际结果更新。
- BLE初连失败/过期/断开均摘device与char监听；特征选择独立token/串行化；失败捕获并回滚合法订阅状态。
- 用户切源无条件取消两套旧重连排程，连接/disposing/idle/exhausted状态与source身份分开。

**红测试**：严格锁端口drop后成功重开；旧value丢弃、旧done仍不清B；旧close/stop/lost不清B；无notify服务GATT关闭；B/C乱序只有最后意图有效；失败无未处理拒绝。工程外夹具之外至少提供浏览器公共入口可达测试。

### R3 导出与消费记录契约

- 每行保存源语义/身份/参考；onSolve冻结actual consumed与solveId/time/calibrationRevision，日志不再次calibrate。
- raw来源恢复当前校准的行为与原录制消费值必须区分：若要严格重现历史消费，导出consumed或带当时校准版本，不承诺只靠当前标定重现。
- 源列默认档保留calibrated语义；混语义分段/拒绝混导，不清空用户已有记录来掩盖归属问题。

**红测试**：25Hz与全帧raw/calibrated各至少3轮往返，每帧输入不变；改标定后既有行/录制元数据不改；低解算率行显式标“最近消费时刻”，不伪造未消费样本；空/坏源样本明确拒绝。

### R4 严格schema与校准合法性共用

- 原始未知数据先结构校验；v3严格、旧版白名单迁移、未来版拒绝；run元数据也校验，先准备全部提示再提交。
- 磁full按合法校正结构验对称正定；加计按本项目刻度/交叉轴约定验正增益；共享合理增益、偏置、残差、count/faces/validation校验。
- 采面评估使用真实时间戳的严格递增、最小覆盖、最大间隙/密度；达容量但未覆盖判失败。解析保留方向误差和器件指纹。
- 所有notes显示明确警告，不再丢模型却绿色声称同一配置恢复。

**红测试**：4000同刻、49同刻+末一点拒；v3仅schema/错类型/坏axis拒；缺/primitive/数组/未来版拒；diag(-1,-1,1)、tiny/huge、bias1000、负残差/count、坏faces拒；合法模型跨JSON往返和UI应用全字段不变；坏run导入失败且原状态不变。

### R5 门禁判定自身的负面对照

- 提取trace comparator为可直接测试的纯函数，双侧schema/预期schedule/IMU/dt/事件全比较；保留旧七负例并补本轮内帧删除、身份重复、事件删除、输入NaN等。
- doccheck先schema/物理关系，再默认只读小基准与数字块绑定；CI全量复算保留。seed/window/config/metric关系完整，所有引用删光必失败。
- 状态使用机器可读当前清单，统一生成计数；明确152子检查+9状态=161，历史不参与current校验。
- soak统一CLI，记录每个drop/open/firstFrame/recovery事件和每段帧增量；batch严格expected generation/seeds/results；缺测不算通过。统一所有页面错误汇总。

**验收**：本轮每个无效fixture都失败且给字段路径/判据原因；干净fixture通过；脚本异常不吞；只读复算不改任何存档；计数变化无需修改更大硬编码常数。

### R6 软件长稳 → 真机 → 视觉（最后验收，不混口径）

1. R1–R5先过规定全链 `tsc → check → build → budget → smoke → doccheck --recompute`。
2. 单独环境分别batch/reconnect **600秒**，独立报告、不覆盖历史；记录实际墙钟/注入时序/每段恢复/CPU帧耗时/容器触顶裁剪/堆采样。
3. STM32+GY-87串口和BLE分别 **30分钟**，记录设备固件/采样率、拔插、范围丢失、休眠与复位；mock不能替代。
4. 图像能真实判读后验桌面/390px窄屏、文档算法详情/基准块/校准/导出与打印；可访问性AA与布局视觉分开给结果。
5. Worker协作取消采用可yield的分片运行，不只靠同步onProgress读Set；验证cancel请求确实被收到、不再发done，主界面terminate隔离能力保留。

## 7. 证据索引、失败项与审查局限

### 本轮保存

- 门禁：`.audit-current/2026-11-01-round11-151602/{tsc,check,build,budget,doc-recompute,smoke,coverage}.log`。
- 连接/记录：`D:/zcode-readonly-round10-lifecycle-JPUDOiRa/audit.cjs`，本轮输出 `lifecycle.log`。
- 时间/校准：`D:/round10-independent-audit-q8fjl9pg/{audit.mts,results.jsonl,followup.mts,followup.jsonl}`。
- 门禁：`D:/round11-gate-recheck-uzYomqvy/audit.cjs`，本轮输出 `governance.log`；原已保存分析 `D:/zcode-round10-governance-JlDKDQ/results.json`。

连接与门禁审查代理因提供方token速率限制中断，本轮由主代理读取已保存夹具并执行，不把其未完成的总结当证据。时间/校准审查完成。**没有改模型、权限、AGENTS或配置来绕过限制。**

### 明确排除

连接夹具整套退出1，其中3条标HARNESS_FAILURE，分别是旧初连A/B复用序列、回放空窗冻结假设、BLE连接空窗模拟推进假设；**没有把这些未成立的反例列为本轮已确认缺陷**。read/value、严格锁close、BLE资源/监听、导出语义等VERIFIED项分别有实际状态输出。

全帧重开语义混合的helper层反例可成立，但正常UI切源的resetSim通常会清空记录，因此这里只作为分段设计的边界提醒，不列主路径P1。15Hz为核心配置允许值，非UI预置默认；实际消费快照问题还另有不依赖15Hz的生产函数反例。

AST/VM严格硬件夹具与生产数值对拍证明逻辑问题，不等于真实设备验收。schema反例中同步重渲染数字块的项目已显式标注，不能误述为“正文绑定没有效果”。本轮没有新分钟级soak和可判读视觉结果。

## 8. 结项停止条件

R1–R5的关键生产反例未全部消失前，不能再次把软件契约标“全部完成”。没有真实600秒、硬件30分钟、可判读图像时分别保留未验收；测试PASS、覆盖率高、文件存在与注释承诺都不能代替证据。

**建议：冻结新增教学模块，先完成逐子步/会话所有权/录制消费契约，再完善strict输入与门禁自身。比继续增加绿用例，更需要让坏实现和坏输入必然失败。**

---

## 附：第十一轮实施结果（2026-11-01，同一工作树）

按本文第 6 节 R0–R5 实施并验收（未做 R6 的硬件/视觉部分）：

| 包 | 结果 | 永久负例 |
|---|---|---|
| R1 逐子步数据流 | 已修 | `共享调度帧契约`：即时回调（回调内 live 累计 0.05→1.00 递增）、0/NaN/负 dt 零更新、上限 100 时 100×50 ms（Σdt=5 s、记账 25 s） |
| R2 连接会话所有权 | 已修 | 冒烟 4 条：旧 reader **迟到数据** 0 帧进队、严格读锁 close 失败被计数且释放锁后重连成功、BLE 初连失败后 GATT 断+监听 0、旧 done 不打新连接；另有订阅顺序回归（重订阅 3 次监听数恒 1） |
| R3 录制/消费/导出契约 | 已修 | `lastSolveInput` 由 onSolve 冻结（不再重算标定）；源列按逐行 `sourceCalibrated` 标 `# imu=`，混语义拒绝 |
| R4 strict 输入与校准 | 已修 | 档案：缺/坏 config、类型不符、未来版本拒；`diag(-1,-1,1)` 等负定矩阵在解析与校验两侧都拒；采面：恒定时间戳/400 ms 断流/仅堆 4000 样本全部拒绝 |
| R5 门禁自身 | 部分修 | soak `--drop-every` 生效且 `opens ≥ 断链数`；doccheck 关系约束 + 零引用失败；窄屏错误汇总。**未做**：trace 比较器双侧 dt/IMU/事件、独立 node 侧比较器自检、statuscheck 机器清单 |
| R0 预算计量 | 已修 | `sw.js` 单列（3 KB/gzip 1 KB，上限 8 KB）；主包上限 285/108 → **288/110 KB**（据本轮实测增量，非"抬预算过门禁"），并写明再加功能前先减体积 |

本轮门禁（严格顺序）：`npx tsc --noEmit` → `npm run check`（**161 PASS / 0 FAIL**）→ `npm run build` → `npm run budget`（11 项）→
`npx tsx scripts/doccheck.ts --recompute`（4.1 s，全字段一致）→ `npm run smoke`（**88 PASS / 0 FAIL**）→
`npm run soak --reconnect --drop-every=3`（实际断链 5 次 / 重连 5 次、停流对 0）。

**仍未验收**：R6 的真机 30 min、10 分钟软件长稳、可判读图像的桌面/窄屏/文档/打印视觉验收；
trace 比较器的完整输入/事件契约、Worker 协作取消、跨时段校准数据仍在待办。
