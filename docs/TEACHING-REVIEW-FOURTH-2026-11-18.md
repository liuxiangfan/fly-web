# 教学扩展四次复核：评估修正与 D 盘测试现场迁移方案

> 编写日期：2026-11-18。  
> 文档性质：**第四次评估记录、问题修正清单和 D 盘目录迁移方案**。  
> 目的：回答“最新评估结果是什么、为什么容量下降、能否把浏览器配置和临时现场放到 D 盘”。  
> 本报告保留发现问题时的评估与磁盘治理历史；2026-11-19 的第四次代码整改、未达体积目标和最终证据待采状态见第 8.4／9 节，不宣称已发布或调整 JS 预算。
> **2026-11-19 磁盘实施回执**：D 盘默认目录、逐任务清理、异常残留自动清理和迁移归档删除均已完成，见第 7 节；本次文档回填不执行删除。
> **冻结身份**：`sourceDigest=2d93cd3d5131d3eb6eeb9f594c4346c6`、`buildId=2d93cd3d5131-15c789e0829d1fe9`、`sourceFiles=121`。代码已完成不等于最终证据已齐；本次不重新评分。

## 1. 发现问题时的评估：**84 / 100（暂定，保留原评分）**

本节保留第四次复核发现问题时的判断；整改后的状态以第 9 节为准，不用后续回归通过改写当时的反例。

### 1.1 分数为什么不是之前写的 87

此前的阶段性 87 分是在深入检查教学长稳换源动作之前给出的。后续独立浏览器实测发现：脚本把 `replay` 和 `sim` 写入 `#source-select`，但该控件只有 `truth/pure/comp/mahony/madg/kalman`，没有 `replay/sim` 选项。

因此原来的“11 次换源”**没有实际发生**。不能再把 `sourceSwitches=11` 当作真实换源、runId 隔离和关闭后 sink 回收的证据。发现这个问题后，综合评分回调为 **暂定 84 分**，而不是将文档改成已通过。

此外还发现：

- Ki 的一个错误选项在当前固定条件下实际成立，却被静态 `always-false` 判假；
- 实验库仍有“误差曲线贴地”的旧文案；
- 门控契约所使用的配置与文档声称绑定的 runner 配置并不完全相同。

这些问题不会否定其他已证实的修复，但不能用 117 项回归全绿覆盖它们。

### 1.2 分项评分

| 维度 | 得分 | 满分 | 当前评价 |
|---|---:|---:|---|
| 单变量对照与报告 | 13 | 15 | 双侧配置、取消、stale、报告与真实完成对照可靠；换源量具和结果覆盖仍需补齐 |
| 预测学习与因果证据 | 18 | 20 | 固定教学基线和倾角修正证据成立；Ki 的具体错误分支与窗口结果不自洽 |
| 观测状态与 ESKF 解剖 | 14 | 15 | 雅可比、采集时刻、同源历史帧、缺快照不回退实时均已确认 |
| 任务上下文与参数反馈 | 9 | 10 | 类型、偏离策略、重置反馈、聚合与退出路径保留 |
| 教材导航与执行入口 | 8 | 10 | claim 有真实对照和返回；部分文案及契约数值仍不一致 |
| 历史回看与跨视图联动 | 14 | 15 | 同帧姿态／输入／Inspector／游标与退出恢复正确；真实换源覆盖不足 |
| 资源、验收与交付 | 8 | 15 | 门禁通过，但 46 B JS 余量、证据分发、CI 未授权及磁盘生命周期管理仍需整改 |
| **合计** | **84** | **100** | 权重严格为 100；是教学与工程可信度评分，不是通过率 |

### 1.3 已证实的改进

- `tsc`、`check`、`build`、18 项预算及严格证据校验通过；
- 完整浏览器集合 **117/117、零 FAIL、零 warning**；
- 倾角修正有真正的正常修正与无修正负对照；
- Ki 的窗口内 RMSE 改善真实存在；
- 门控 claim 已真实跑完同窗口 A/B，能看到指标改善和拒绝事件；
- 历史 Inspector 使用历史帧与其采集时刻，缺快照时不伪造；
- `size-report` 已包含 `sw.js`，分类与预算总计一致；
- 可再生浏览器 profile 已实际回收约 **5.6 GB**，而不是只讨论清理。

### 1.4 当时不能关闭的问题（整改状态见第 9 节）

1. **假换源**：`source-select` 不包含 `replay/sim`，按动作名计数不能证明换源。
2. **Ki 分支命题错误**：当前 `Ki=0.5` 的稳态 RMSE 实测比 `Ki=0.05` 更低，“本题窗口内一定更低”反而为真，不应作为反例。
3. **门控文案／契约口径**：旧的“贴地”表述仍在实验库，不能把多组配置的数字写成同一个 runner 的证明。
4. **视觉分发**：current 视觉条目曾出现 `localOnly:false`，而 PNG 实际在 gitignore 的 `screenshots/`。本机有图不等于干净 clone 也能复核。
5. **余量与发布**：全部 JS 约 299474 B / 299520 B，仅余 46 B；新版本 CI、线上核验、发布仍需授权。

---

## 2. 容量为什么持续下降

### 2.1 直接原因

每次优化／验证循环都会创建浏览器用户数据目录、临时 Git 夹具和报告。它们包含 GPU 缓存、着色器缓存、数据库、Cookie、本地存储、历史记录和原始采样。

**关闭浏览器只关闭进程，不会删除这些目录。** 所以“测试跑完了”与“磁盘被释放了”不是一回事。

### 2.2 实测来源

| 来源 | 实测 |
|---|---:|
| `.audit-current/soak-profiles` | **61 个配置目录，约 5.6 GB** |
| 其他一次性 profile | 约 **0.96 GB** |
| `hw-profile-ble` | 约 **88 MB** |
| Temp `quat-demo-smoke-profile-*` | **245 个目录** |
| Temp `evc-*` | **530 个目录** |
| 所有 `.audit-current` | 曾约 **6.7 GB** |
| `docs/generated` | 约 **38.6 MB** |
| `screenshots` | 约 **37 MB** |
| `dist` | 约 **2.1 MB** |

代码层面的原因：

- `scripts/soak-teaching.mjs` 和 `scripts/soak.mjs` 每次 `mkdtempSync()`，没有对应的清理；
- `scripts/evidence-contract.test.mjs` 每次 `scene()` 创建临时 Git 现场，没有 `t.after()` 或 `finally` 清理；
- `browser-smoke.mjs` 有清理，但 Windows crashpad 或残留浏览器持锁时，失败会静默留下目录；
- 重复优化、不同 digest、sourcemap 重建与原始采样让历史目录不断增长。

### 2.3 已回收的空间

在确认没有活跃长稳浏览器使用后，已删除并重建空的 `.audit-current/soak-profiles`：

- 回收 **约 5.6 GB**；
- `.audit-current` 从 **约 6.7 GB 降到约 2.2 GB**；
- 没有删除正式报告、截图、源码或其他证据。

系统 Temp 中仍有活跃 Edge 进程占用旧冒烟 profile，因此**没有直接清空 Temp**。不能把“临时目录”一概视为安全删除对象。

---

## 3. 浏览器配置和临时现场能放到 D 盘吗？

**可以，而且建议这样安排。** 方案编写时 D 盘约 **86 GB 可用**、C 盘约 **12.5 GB 可用**；2026-11-19 删除迁移归档后，D 盘实测约 **81 GB 可用**。

已创建空的目录：

```text
D:\test-artifacts\quaternion-attitude\smoke
D:\test-artifacts\quaternion-attitude\soak
D:\test-artifacts\quaternion-attitude\evidence-contract
D:\test-artifacts\quaternion-attitude\build-probes
```

### 3.1 推荐目录职责

```text
D:\test-artifacts\quaternion-attitude\
  smoke\              # 每次冒烟的独立 profile，结束即删
  soak\               # 长稳 profile，结束即删
  evidence-contract\  # 每次契约测试的独立临时 Git 夹具
  build-probes\       # sourcemap、归因及临时对照构建
  perf\ visual\ postdeploy\ screenshots\  # 对应采集工具的独立 profile
  ci-downloads\       # CI 产物下载，登记后删除
  contracts\          # 测试现场归属与自动清理的契约夹具
  hw-soak\            # 保留：原生设备授权 profile，不自动删
  _ops\               # 保留：少量迁移/盘点审计报告
```

不要把 Chrome/Edge 浏览器本体、用户默认浏览器目录、全局 `TEMP`、npm 缓存或其他应用缓存一起迁移。只迁移**本项目自动化明确创建的临时数据**。

`docs/`、正式报告、教学源码、`node_modules` 仍留在原项目，不需要整体搬迁。测试报告的正式证据可继续放 `docs/generated`；大样本和原始制品可另放 D 盘并保留哈希与身份链接。

### 3.2 已落地的脚本行为（2026-11-19）

统一入口为 `scripts/test-artifacts.mjs`，默认根是 `D:/test-artifacts/quaternion-attitude`。
不再需要给每个脚本设置不同环境变量；如需整体换根，统一用：

```bash
QUAT_TEST_ARTIFACT_ROOT="D:/test-artifacts/quaternion-attitude" npm run smoke
```

- **普通冒烟**：`browser-smoke.mjs` 每次启动按 PID／候选序号／时间创建独立目录，正常结束删除；
  达到 10 个标签页主动重建浏览器时删除旧 profile；失败候选在候选尝试结束后延迟补删。
  Chrome 优先、Edge 回退。`SMOKE_PROFILE` 仍可显式覆盖，但不得让多个浏览器／分片共用。
- **普通／教学长稳**：`soak.mjs` 与 `soak-teaching.mjs` 默认都进入 D 盘 `soak/`，
  Windows 上显式传入非 D 盘 `profileRoot` 会直接拒绝；`browser.close()` 后删除自己的 profile。
  路径迁移当时尚未修复假换源；现已改用真实 replay 量具，最终 600 s 重采状态见第 9 节，D 盘治理本身不计换源验收。
- **证据契约**：`evidence-contract.test.mjs` 每次 `scene()` 在 D 盘 `evidence-contract/` 建独立 Git 夹具，
  文件级 `after()` 统一清理；不再使用 `tmpdir()/evc-*`。
- **sourcemap／临时构建**：`size-report.mjs` 在 D 盘 `build-probes/` 每任务建独立重建目录，
  正常结束或异常退出都删除；不修改 `dist/`。
- **其他入口**：`register-ci-run` 的下载产物、`perf-report`、`visual-evidence`、`perf-probe`、
  `postdeploy-smoke`、`shot` 也已统一使用 D 盘独立 profile 并收尾清理。
- **真机长稳**：`hw-soak` 的 profile 位于 D 盘 `hw-soak/`，为保留设备授权而不自动删除。

### 3.3 不建议的迁移方式

- 不要把 `TEMP` 全局改到 D：会把其他应用的缓存和不可信下载内容混进测试现场；
- 不要多个测试共享一个 profile：会造成锁竞争、状态污染和“删不掉”；
- 不要搬正在使用的浏览器目录：先让对应测试正常退出，或保留原目录直到释放；
- 不要通过移动正式报告来掩盖体积：原始采样保留哈希、构建身份和下载／读取方式；
- 不要把 D 目录当成永久堆积区：换盘只是缓解容量，仍需自动清理；
- 不要修改预算以解决磁盘占用，JS 体积预算与测试磁盘占用是两个问题。

---

## 4. 后续整改顺序

### 第一步：修量具，先证明真实换源 —— **代码完成，最终 600 s 已通过（第 9 节）**

1. 将教学 soak 的换源改为真实 `replay.import()` → `replay.stop()`；
2. 断言实际 `replay.active` 为 `false→true→false`；
3. 校验诊断帧／事件计数的 runId 变化，不能仅按 `kind:"source"` 计数；
4. 如果导入或退出失败，该动作与报告判失败，不能写“换源成功”；
5. 更新教学报告及其解析器，旧假换源记录标为量具无效，不贴新摘要。

### 第二步：修教学命题与文案 —— **已实施并有契约回执（第 9 节）**

- Ki 错误分支改成真正错误的普适命题，例如“Ki 越大越好且不会振荡”，不要保留当前成立的从句；
- 若要实测振荡，使用真正的窗口序列／对照，而不是靠低 RMSE 推断；
- 统一实验库、教材、claim 和契约的实际 runner 条件及数字；
- 删除“曲线贴地”等无法由实际数据支持的表述，或改为当前实测的有限窗口结论。

### 第三步：落实 D 目录与自动清理 —— **已完成（2026-11-19）**

- 普通冒烟和长稳在关闭浏览器后删除自己的 profile；主动重建时同步删除旧 profile；
- 契约夹具改为 D 盘独立目录并统一 `after()` 清理；
- 清理失败会告警；删除前按唯一 profile 路径处理残留测试浏览器进程，不碰用户浏览器；
- `pruneTestArtifacts()` 自动清理白名单 kind 下超过 24 h 且未被占用的异常残留；
  新目录、活跃目录、占用查询失败目录和保留目录全部跳过；
- 正式报告、视觉证据、真机授权 profile 与迁移审计报告不删；
- app 97/97、devices 20/20 后 D 盘 `smoke/` 为空；短长稳与 `size:report` 后对应目录也为空。

### 第四步：重新验证

```bash
npx tsc --noEmit
npm run check
npm run build
npm run budget
node scripts/ci-run-smoke.mjs --shard=both --runs=1
npm run evidence:verify
```

如果修改了实际换源或教学量具，需要重新采集真实 600 秒教学报告；不能用已有“11 次换源”的旧报告冒充修正后的验收。

---

## 5. 文档合并与保留边界

本次同时做了文档收敛：

- 旧 `QUALITY-STATUS` 与 `QUALITY-SOFTWARE-ONLY` 的评分、日期、修正关系已整合进 `QUALITY-AUDIT-HISTORY`，
  并于 2026-11-19 从工作区删除；原文仍可按历史索引中的 Git 定位读取；
- 本清理方案 `CLEANUP-AND-REVIEW-2026-11-18.md` 也已删除：87 分阶段结论、磁盘治理与保留边界由四次复核承接；
- `ROADMAP` 收敛为当前真实待办，保留体积、证据、磁盘治理、教学重载和装配层拆分；
- `VERIFICATION-EVIDENCE` 改为证据规则＋历史记录，机器索引为当前入口；
- 完整教学规格、各轮反例、原始报告、失败记录、数学资料保留，不为了“删无用文档”而抹掉证据。

旧报告里的 87 分应视为**发现换源量具问题前的阶段评分**；本次保留第四次暂定 84 分，不因代码整改、短测或文档回填自动加分。最终证据状态见第 9 节。

## 6. 给接手模型的交付要求

```text
[x] 已确认 source-select 不再被误写 replay/sim（量具改用生产 replay 端口）
[x] 已证明 replay.active 的真实 false→true→false（最终冻结构建 600 s，9 次真实换源）
[x] 换源动作失败会阻止报告 PASS（量具与解析器契约）
[x] Ki 反例改为错误的普适保证，不否定本窗口 Ki=0.5 更低，不声称已测振荡
[x] 实验库、教材、claim、契约使用同一组生产 runner 条件
[x] profile 与契约夹具分别使用独立 D 盘目录
[x] 关闭测试后自动清理自己的目录，没有误删他人现场
[x] 超过 24 h 的异常残留自动清理，活跃目录与保留清单不误删
[x] 正式报告与原始证据未删除
[x] localOnly 与实际本地分发方式一致（采集代码；最终视觉证据与判定仍未完成）
[ ] 最终冻结构建五轮稳定性、visual/perf/batch/reconnect/教学600 s 与 strict 新绑定齐全
```

最终结论：**把测试临时现场放到 D 盘是对的，但迁移目录不是清理机制。** 真正要同时解决的是“每次测试创建什么、归谁所有、何时清理、失败时保留什么”，否则只是把 C 盘的问题搬到 D 盘。

---

## 7. 2026-11-19 实施回执：迁移、删除与自主清理边界

### 7.1 旧残留迁移结果

- 从 C 盘 Temp 成功迁出 **755 个** smoke／evidence-contract 目录和 **11 个** Puppeteer 默认 profile，共 **766 个**；
- **24 个** smoke profile 与 **2 个** Puppeteer 默认 profile 仍被旧浏览器进程占用，全部跳过，未强行移动；
- 没有进行额外的 C 盘全盘清理。

迁移到 D 盘 `_migrated-c-temp/` 的实测构成：

| 归档 | 数量 | 大小 | 性质 |
|---|---:|---:|---|
| `smoke/` | 249 个 profile（含 24 个占用源留下的副本） | 18,690.6 MiB | 可再生的浏览器测试现场 |
| `puppeteer-default/` | 11 个 profile | 1,069.5 MiB | 可再生的浏览器测试现场 |
| `evidence-contract/` | 530 个临时 Git 夹具 | 15.2 MiB | 可再生的契约夹具 |

合计约 **19.3 GiB（20.7 GB）**。这些不是正式证据、源码或发布产物。

### 7.2 归档删除结果

所有者于 2026-11-19 明确授权后，已删除整个 `_migrated-c-temp/`：

- 删除前确认没有浏览器进程使用该归档；
- D 盘可用空间由 **61 GB 增至 81 GB**，释放约 **20 GB**；
- `_ops/` 中几十 KiB 的迁移与盘点报告保留；
- 正式报告、`dist/`、`screenshots/`、真机授权 profile 均未删除。

### 7.3 后续不再堆积的机制

`scripts/test-artifacts.mjs` 现在同时承担三种生命周期：

1. 正常结束：`cleanupArtifactDir()` 删除本次任务目录；
2. 主动重建：删除被替换的旧浏览器 profile；
3. 异常残留：`pruneTestArtifacts()` 默认删除白名单 kind 下超过 **24 h** 且未被占用的单任务目录，
   `QUAT_TEST_ARTIFACT_MAX_AGE_MS<=0` 可关闭。

自动清理只覆盖 `smoke/soak/evidence-contract/build-probes/perf/visual/postdeploy/screenshots/ci-downloads/contracts`。
`_migrated-c-temp/`（若以后再次产生）、`_ops/`、`hw-soak/` 不在白名单；新目录、活跃目录和占用查询失败目录都跳过。
根目录 `AGENTS.md` 已明确：模型可自主删除这些无用的单任务测试目录，不必每次再请求确认；保留清单外仍需授权。

新增两项反例后，`evidence-contract` 共 **15 项**，其中测试现场归属与自动清理 **6 项**：
默认根、环境变量覆盖、任务独立、幂等清理、保留清单、活跃/查询失败跳过。

### 7.4 磁盘治理当轮验证与当时未关闭的问题

- `npx tsc --noEmit`、`npm run check`、`npm run build`、`npm run budget`（18/18）通过；
- app **97/97**、devices **20/20** 通过，结束后 D 盘当前临时目录为空、无残留测试浏览器进程；
- `evidence:verify --require-source --require-build` 通过；
- **当时仍未关闭**：真实换源量具、Ki 错误分支、门控文案/契约口径、视觉 `localOnly` 分发、46 B JS 余量、
  当前版本 CI 与线上发布。以上保留为磁盘治理当轮回执，后续整改见第 9 节；D 盘治理不改变暂定 **84/100** 评分，也不替代真实 600 s 教学换源重采。

---

## 8. 46 B JS 演进余量的处理决策建议

### 8.1 问题与已尝试路径

方案提出时，全部 JS gzip 约 **299474 B / 有效上限 299520 B**，只剩 **46 B**，远低于工单要求的 **2–4 KiB**；本轮拆分后的实测见第 8.4 节。
已实测的路径包括：合并三个 lazy chunk（省 681 B，但会把诊断并入教学行并使该行超限，故只合并 comparison）、
观察状态标签／算法名／证据文案去重、claim 数据移入 HTML、教材文案压缩。继续压缩文案收益递减且损害教学表达；
删除教学语义分支属于禁止项。下一步只剩 `main.ts` 结构工作或调整预算。

### 8.2 建议：有边界地拆 `main.ts`，不抬上限、不把 46 B 当长期可接受状态

推荐顺序是：**另行安排 `main.ts` 的小步结构拆分**，先恢复演进余量，再考虑新增功能。

但必须明确：**单纯把代码搬到新文件不会自动减少总 JS**。拆分的正确目的应是剥离独立职责、让确实可延迟的
功能进入按需 chunk、减少装配层与重复代码，而不是制造更多文件或把体积藏进不计入预算的位置。

实施边界：

1. 先迁纯逻辑、无 DOM／浏览器副作用的模块，例如状态推导、配置转换、报告组装、序列化辅助逻辑；
2. 再拆已有独立 UI 面板，保持现有加载边界，不把面板一律懒加载；
3. 只对确实不在首屏需要的功能做按需加载；
4. 每次只迁一个职责，保持可回退，立即验证首屏、Worker、取消、换源、回放、面板生命周期；
5. 不删除教学分支、题目、证据或 UI，不改变任何数值验收阈值。

### 8.3 验收目标与失败汇报

- 全部 JS gzip 至少恢复 **4 KiB** 余量，理想约 **8 KiB**；
- 每步执行 `npx tsc --noEmit` → `npm run check` → `npm run build` → `npm run budget`，并跑对应浏览器路径；
- 若一轮结构拆分后仍无法恢复至少 **2–4 KiB**，停止机械拆分并向所有者报告；
- **不得自行抬「全部 JS」上限**；如确需调整，必须单独说明原因、增量、对应教学能力、新冻结基线与复审时间，
  由所有者明确决策。

“接受当前余量”只适合作为短期冻结发布的选择：它表示合规但没有演进空间，不适合继续迭代。
当前建议因此是：**先做有边界的 `main.ts` 拆分；失败则停下报告，不自动选择抬线或删功能。**

### 8.4 2026-11-19 一轮拆分实测：目标未达，已停止机械拆分

- `src/core/csv-export.ts` 接手记录快照的 CSV 纯序列化；`main.ts` 仍负责 DOM、元数据和下载，不读活状态重算历史校准。
- schema 契约为 **106 PASS / 0 FAIL**，覆盖旧格式逐字节等价、三种参考、列开关、源／消费快照、原始四元数、入参不变与全帧回放语义。
- 全部 JS gzip **before 299474 B → after 299442 B**，有效上限不变 **299520 B**；净省 **32 B**，余量 **46→78 B**。
- 验收要求恢复至少 **4 KiB（4096 B）余量**，当前仍差 **4096−78=4018 B**；目标不是“净减 4 KiB”，也不能用预算 18/18 通过替代余量目标。
- 按失败汇报边界，**已停止机械拆分**。不调预算、不删功能／教学语义／测试，不继续压缩文案掩盖未达目标；后续结构工作或预算决策须另行明确。
- 冻结构建体积回执：`D:/test-artifacts/quaternion-attitude/_ops/fourth-size-current.json`（`totals.gzipSum=299442`、12 个 JS、`driftProblems=[]`）；预算回执：同目录 `fourth-budget.log`。

---

## 9. 2026-11-19 第四次整改回执：代码通过，最终证据串行重采

### 9.1 冻结身份与本次回填范围

- `sourceDigest=2d93cd3d5131d3eb6eeb9f594c4346c6`
- `buildId=2d93cd3d5131-15c789e0829d1fe9`，`distHash=15c789e0829d1fe9`，`sourceFiles=121`
- `dist/build-provenance.json` 与本轮体积回执身份一致；工作树未提交，不能把旧 HEAD 当作本轮新提交。
- 本次仅回填四次复核、CHANGELOG、质量历史索引与 ROADMAP；保留既有其它会话改动、原始报告和磁盘治理回执，不删文件、不动 README、不重新评分、不提交／推送／发布。

### 9.2 已完成代码与量具

| 项目 | 已完成实现／永久反例 | 能证明与不能证明的边界 |
|---|---|---|
| 真实 replay 换源 | `scripts/teaching-load.mjs` 调用生产 `replay.import()/stop()`；三个阶段同时核 active=`false→true→false`、sourceKind=`simulation→replay→simulation`、回放 idx>0、导入／退出 diagnostics.runId 递增及旧回看覆盖退出 | 导入或退出失败保留观察并判失败，不按动作名称计成功；不是只给下拉框写不存在的选项 |
| 教学 v2 报告 | `soak-teaching.mjs` 写 `loadSchema: teaching-load/v2`，保留全部 before/during/after、sourceTransitions、错误与汇总；`evidence-report.mjs`／证据契约重核三阶段和数量一致性 | 旧格式及三阶段失配不能用于当前验收；不截断后半程记录、不贴新摘要 |
| 取消与旧 job 隔离 | 等待 cancel 与 pending 运行 settled，记录 settledMs、after 与 300 ms 后 later 的 state／jobId；核仍为 cancelled 且旧 job 不回写 | 记录取消落定，不把点击次数当作 runner 已停；浏览器内部资源数量仍未测 |
| 停载静默 | 退出回看、关 review／ESKF 采集、取消对照／清任务并暂停生产解算，再观察 2 s 回看／事件不新增 | **事件记录器没有独立停采开关**；静默是在暂停生产后观察，不能宣称单独停事件采集或所有 Worker／timer／listener 已回收 |
| 视觉采集保真 | `visual-evidence.mjs` 写 localOnly=true；PNG 路径 `screenshots/visual-<完整digest>/<buildId>/<UUID>/`，JSON 默认也含完整 digest／buildId／UUID；已存在路径拒绝覆盖 | 采集机制完成不等于本版视觉判定完成；本机 PNG 不等于干净 clone 可逐图复核 |
| 历史证据保真 | 旧假换源条目 current=false、measurementStatus=invalid-source-switch，限容量／内存观测；丢失历史视觉报告 OBSERVED／unrecoverable、provenanceComplete=false | 保留原路径、已知原 hash／前缀；未知覆盖者／覆盖时间成对 null，未知采集时间不编造；原件丢失不能换目录、新报告或伪造完整 hash 当 PASS |

### 9.3 Ki 与 Gate：同条件有限窗口结果

**Ki** 使用固定教学基线：零偏 2°/s、水平初态、磁修正开启、零噪声、20 s，三个运行各 **n=10000**、稳态口径 exact：

| Ki | steadyRmse（°） |
|---|---:|
| 0 | 2.6304009092041056 |
| 0.05 | 1.2794852075106424 |
| 0.5 | 0.016280202313547803 |

A−B=`1.3509157016934632°`；0.5 在本窗口更低是真实结果，不能继续将其判假。错误选项改为“无论观测、噪声和采样条件，Ki 越大越好且绝不超调／振荡”的**普适保证**，解释承认窗口内结果并区分理论补充。**未实测大 Ki 振荡**，也未证明渐近归零已经在 20 s 内完成。相关永久反例在 `learning-activity-contract.test.ts`／`learning-panel-contract.test.ts`。

**Gate** 契约沿生产流程 `defaultExperimentConfig()` → gate 参数覆盖 → 关闭 A 门控并冻结 → `buildComparisonPair()`；不用预测题的零噪声基线替代实验库。固定种子 24301、500 Hz、水平初态、磁修正／启动 ramp 开、恢复窗关，保留默认陀螺噪声 0.2°/s、加计噪声 0.1 与五算法；gate 覆盖 violent、linAccel=4、vibration=0.1、gyroBiasDps=1、magNoise=0.8。

| 20 s Mahony 指标 | A：门控关 | B：门控开 |
|---|---:|---:|
| 全程 RMSE（°） | 15.243638770525585 | 12.52735392220622 |
| 拒绝帧数 | 0 | 8272 |
| max（°） | 57.600488471779435 | 57.600488471779435 |
| n | 10000 | 10000 |

RMSE 改善=`2.716284848319365°`；仅改 duration 为 **10 s**，改善=`0.6318548707614973°`。实验库、教材、claim 与契约统一为有限窗口改善，明确共同启动峰值未消除，不再声称“曲线贴地”。原验收阈值（改善 ≥2°、拒绝 ≥100）不变。

### 9.4 已有验证回执，不冒充最终完整验收

- 磁盘回执记录本轮已执行 **`npx tsc --noEmit → npm run check（155 项基础检查＋全契约 0 FAIL）→ npm run build → npm run budget（18/18）`**。schema 为 106 PASS／0 FAIL；Ki、Gate 数字来自 `D:/test-artifacts/quaternion-attitude/_ops/fourth-check.log`。这是已有执行回执，本次文档回填没有重跑会生成产物／报告的流程。
- build／budget／体积回执分别为同目录 `fourth-build-final.log`、`fourth-budget.log`、`fourth-size-current.json`；基础门禁通过不等于 ≥4 KiB 余量达成，默认 evidencecheck／契约通过也不等于最终 strict 新绑定完成。
- **28 s 短测 PASS、2 次真实换源**：`D:/test-artifacts/quaternion-attitude/_ops/teaching-switch-short2.json`／`.log`。其身份是前一构建 `sourceDigest=e37334ff8259ef8dd87b3f48c051588c`、`buildId=e37334ff8259-cb4f57353a05173b`；两个 during.idx 为 3／14，runId 为 2→3→4、4→5→6，取消落定／旧 job 未回写、停载静默、控制台零错误。它只证明该次短路径，**不贴本轮冻结摘要、不替代最终 600 s**。

- **最终冻结构建教学 600 s 已通过**：`D:/凡/四元数姿态解算/docs/generated/soak-teaching-600-2d93cd3d-fourth.json` 的 sourceDigest／buildId／distHash／121 输入文件匹配第 9.1 节；117 个样本、116 次动作、9 次真实三阶段换源，during.idx=`[20,15,18,18,3,18,18,17,16]`，runId 由 2→3→4 连续推进至 18→19→20。11 次取消均 running-a→cancelled→300 ms 后 cancelled 且同 job，settled 为 0.5–1.3 ms；consoleErrors=0、actionErrors=0、elapsedMs=600088、maxGapMs=7056、同 run 时钟推进约 355.694 s，reviewMax=750、eventMax=512、stopQuiesced=true。
- **教学堆判据也通过，未豁免**：heapGrowMb=`2.472325325012207`、heapPeakGrowthMb=`26.810391426086426`、heapTrendMb=`3.445763618728946`、tailStatus=PASS、heapWaived=false。教学堆判据也通过，未豁免，见第 9.5 节完整闭环。

### 9.5 最终证据状态与未覆盖边界（回填时）

| 项目 | 状态 | 结案要求／限制 |
|---|---|---|
| 最终冻结构建教学 600 s | **已通过，9 次真实换源** | 正式报告 `docs/generated/soak-teaching-600-2d93cd3d-fourth.json`，身份匹配、三阶段／取消／停载／堆判据通过；仅结案教学单项，不代替 strict 登记和其它证据 |
| Windows 五轮稳定性 | **已通过** | 每轮 app＋devices **117/117**，零失败／warning／未计划重启；`generated/stability-local-windows-2d93cd3d-fourth.json` 身份匹配且解析器 `completeness=[]` |
| visual | **11 张采集、模型逐图复核与严格登记已通过** | 报告为 `generated/visual-evidence-2d93cd3d5131d3eb6eeb9f594c4346c6-2d93cd3d5131-15c789e0829d1fe9-2c61c8f4-26c8-451b-a90b-9084b96838eb.json`。早期同会话工具不支持图像输入的错误保留；后续图像输入成功，已 Read 实际查看全部桌面、320/390/768、200% 缩放、三视图、文档及打印，未见意外重叠、横向溢出或空白画布，控制台 0。这不扩大为所有者逐图确认或读屏通过，不上传外部视觉服务 |
| perf | **已通过** | `generated/perf-report-2d93cd3d-fourth.json` 与冻结构建一致；墙钟 33.3 fps、输入 p95 4.97 ms、request→runner 18.1 ms、Worker 路径完成、控制台 0 |
| batch／reconnect 600 s | **已通过** | 批量 116 样本、3/3 批、水位 +2.747 MB、峰值 27.218 MB、趋势 6.910 MB、仿真时钟 371.302 s；重连 122 样本、66/66 恢复、水位 +9.316 MB、峰值 26.331 MB、趋势 18.476 MB、仿真时钟 351.356 s；均末段／覆盖 PASS、未豁免、控制台 0 |
| strict evidence 新绑定 | **已通过** | 7 条 current 新证据与源码 `2d93cd3d…`（121 文件）、产物 `15c789e0829d1fe9`、buildId `2d93cd3d5131-15c789e0829d1fe9` 一致；索引 79 条、current 8 条，丢失原件只记 note |
| CI／线上核验／发布 | **未授权、未执行** | 不提交、推送或触发发布，不计评分加分 |

最终重采已安排串行 runner；首次辅助 runner 遇到 Windows ESM 的 `d:` 导入路径错误，已在 `_ops/` 辅助脚本中改用 `pathToFileURL`，未改产品源码。该次辅助编排错误**不计产品失败，也不计测试通过**。教学 600 s、正式五轮 117 项稳定性、性能、11 张截图采集及模型逐图复核、批量／重连 600 s 与 strict 新绑定随后均通过。至此本机冻结候选证据闭环完成；剩余 4 KiB 演进余量目标未达、CI／发布未授权，不能宣称项目全部完成。
