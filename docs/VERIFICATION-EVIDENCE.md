# 验证证据与证明边界

> 本轮（2026-11-05 · 软件工单实施轮）在本机 Windows 上重采了全部证据。
> 冻结构建：源码摘要 `a958b3483f31361ef9221a68700884a7`（82 个构建输入文件），构建标识 `a958b3483f31-c5ca62bf5ef97f56`，`distHash c5ca62bf5ef97f56`。
> 机器索引：[`generated/evidence-manifest.json`](generated/evidence-manifest.json)；软件评分与未完成项见 [`QUALITY-SOFTWARE-ONLY.md`](QUALITY-SOFTWARE-ONLY.md)。
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
| 产物 | `distHash` + `buildId`（`scripts/build-provenance.mjs`） | 构建结束时写 `dist/build-provenance.json`：源码摘要 + 产物摘要 + 工具版本；`distHash` 只有一个算法（相对路径 + 内容，排除溯源文件自身） |
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
| `npm run smoke` | **106 项**（app 86 + devices 20）0 FAIL / 0 warning | 结构化结果 + 完整集合比对（清单 `scripts/smoke-manifest.json`） |
| 本机 Windows `--shard=both --runs=5` | 见 §5 | 每轮 106 项完整集合 |
| `npm run evidence:verify` | PASS | 见 §2 的三层绑定 |

## 4. 软件长稳（当前源码，各 600 s）

| 文件 | 结果 | 能证明 | 不能证明 |
|---|---|---|---|
| `generated/soak-batch-600-a958b348.json` | PASS：600 s、3/3 批、常驻水位 +5.7 MB（端点差 +19.8 MB 属 GC 相位）、峰值增量 27.3 MB、趋势 11.6 MB、末段判据 PASS、采样覆盖 PASS（117 样本 / 仿真时钟 296.2 s / 墙钟 600 s） | 当前源码在连续多批批量评测下**容器封顶、无持续泄漏、无末段翘尾** | 不能证明真机，也不能替代跨平台稳定性 |
| `generated/soak-reconnect-600-a958b348.json` | PASS：600 s、66 次断线 66 次恢复（每个丢弃段都有独立 open 且真的消费过首帧）、水位 +4.6 MB、峰值 24.8 MB、趋势 16.1 MB、末段与采样覆盖 PASS | mock 传输层长时间断连／恢复不残留资源 | **不是真机**：真实驱动／蓝牙栈行为需真机报告（硬件不在本轮范围） |
| `generated/soak-batch-600-7f0b5966.json`、`generated/soak-reconnect-600-7f0b5966.json` | 历史观测（前一版源码，无末段／采样覆盖字段） | 早期某次 600 s 通过 | 不是当前源码；按新口径不能充当当前证据（索引里已标为历史） |
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
| 本机 Windows `--shard=both --runs=5`（当前源码） | 见 `generated/stability-local-windows-a958b348.json` | 版本化摘要（`verdict.kind` + 每轮完整集合与耗时）+ `.audit-current/stability-final3/`（各轮日志与结构化结果，本地） |
| CI（Ubuntu / Windows）5× | **未跑** | 需要一次 push 或 workflow_dispatch（本轮未获授权）；`scripts/register-ci-run.mjs` 已强化为"workflow/job/attempt + 冒烟步骤真的执行 + 产物五轮完整集合 + 摘要绑定 head_sha"后才会登记 |
| 历史：Windows CI 5×（`830e4e3`） | **FAIL** | GitHub run `41555321631`：gate 与单轮分片通过，5× 稳定性作业死于**基础设施超时**，无一条产品断言失败 |
| 历史：Ubuntu CI 5×（`e8e6a8e`） | PASS | GitHub run `41530523646`（祖先提交，不证明当前 SHA） |

驱动器的判定口径（本轮落地）：每轮必须给出**结构化结果**（逐项状态、跳过、重复、`completed` 标记），
验收比对**完整集合**（app 86 + devices 20 = 106），并把失败分成四类——断言失败／执行未完成／环境失败／根因未知；
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
| `generated/perf-report.json` | 真实墙钟指标：首次可交互、rAF 帧间隔（墙钟帧率）、长任务、输入延迟 p95、批量（Worker）耗时、**主线程降级取消延迟**、堆峰值 | PASS：控制台零错误、输入延迟 p95 ≤200 ms、取消延迟约 9 ms、Worker 路径写表 5 行 |
| `generated/size-report.json` | sourcemap 定量归因（独立重建到 `dist-size/`，不动 `dist/`）：chunk 级 raw/gzip + 主包按职责分组 | three（vendor）513.1 KB / 128.8 gzip、主包 281.8 KB / 105.0 gzip、Worker 43.0 / 15.4、文档演示 22.3 / 9.1、引导课程 11.7 / 6.4 |

**性能口径（不许混用）**：`perf-report` 的 fps 来自真实 rAF 墙钟间隔；界面读数里的 fps 用被夹到 50 ms 的仿真 dt 计算，
**不能**当性能指标。headless + swiftshader 是软件渲染，数值是下限参照；同环境前后对比才有意义。

## 8. 本轮仍未完成的事（不许被上面的表格掩盖）

1. **跨平台 CI 五轮**：需要一次授权推送（或 workflow_dispatch），随后用 `register-ci-run.mjs` 登记；
   在此之前"双平台各 5 轮完整集合"这条验收**保持未完成**。
2. **实质减重**：冻结基线的聚合预算目标（10% 余量 ≈ 244.8 KiB gzip）未达成（当前 266 KiB）；
   主包名义上限内仅剩 1.1 KB。下一步是把校准栈与其余装配层流程改成按需加载（SW-12 范围），
   并按 SW-09 第 6 条做 before/after 对照。
3. **纯文字放大 200%**：实测本装置版式为 px 计量，浏览器"字体大小"设置不改变排版；
   覆盖的放大路径是**页面缩放**（已验收）。要真正支持字体放大需要把正文排版迁到相对单位并重新验收遮挡。
4. **读屏与人工视觉判定**：本机没有可自动化的读屏环境；人工视觉判定未做（见 `ACCESSIBILITY-ACCEPTANCE.md`）。
