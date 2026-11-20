# 教学扩展实施缺陷修复方案

> 文档性质：**可执行修复工单**。整理日期：2026-11-16。
> 依据：对 `feat/teaching-interaction-ab` 分支的独立评估（评分 62/100），含浏览器实测、代码审查与数值验证。
> 执行状态（2026-11-17）：FIX-01～FIX-13、FIX-17 已完成；FIX-14 经项目所有者明确为**范围外（不需要读屏功能）**；FIX-15 经项目所有者人工确认功能正常、无问题；仅 FIX-16（CI/线上/发布）待授权。
> 当前构建与证据数字以 [`PROJECT-STATE.md`](PROJECT-STATE.md) 的 current 区域为准（本文不复制易漂移的摘要）。
> 本文修复完成后预期评分 80–88/100（剩余扣分来自人工验收边界）。
> 教学设计规格见 [`TEACHING-INTERACTION-EXPANSION-PLAN.md`](TEACHING-INTERACTION-EXPANSION-PLAN.md)；
> C/D 预算决策见 [`CD-WIRING-DECISION-PLAN.md`](CD-WIRING-DECISION-PLAN.md)；
> 当前项目事实见 [`PROJECT-STATE.md`](PROJECT-STATE.md)。
>
> **后续独立复核（2026-11-17）**：既有 FIX 修复与门禁通过，但固定练习的现场隔离、因果判据、教材门控场景及历史 ESKF 联动仍有新增反例；不要把本页“FIX 已完成”理解为整个教学方案已闭合。评分和 TQ-01～TQ-09 整改要求见 [`TEACHING-REVIEW-2026-11-17.md`](TEACHING-REVIEW-2026-11-17.md)。保留本页原执行记录，后续修复按 TQ 编号追踪。

## 0. 执行纪律

1. **先复现，再修复**：每项修复必须先写出能在当前代码上失败的测试/浏览器断言，再改生产代码。
2. **不删功能、不删测试、不抬预算、不改数值门槛**。
3. **不自行提交、推送、发布或触发远端工作流**。
4. **标记为「待人工决策」的项不得自行执行**，即使技术上可以做。
5. 每项修复完成后跑 `npx tsc --noEmit && npm run check && npm run build && npm run budget`。
6. UI 改动必须重新 build、强刷预览、截图并检查控制台零错误。
7. 修复完成后更新本文对应项状态、PROJECT-STATE 与 CHANGELOG。
8. 不修改已通过的既有测试来适配新代码；新代码必须满足既有测试。

### 0.1 执行结果摘要（2026-11-17）

| 分组 | 状态 | 关键验证 |
|---|---|---|
| FIX-01/09 | ✅ 完成 | 五题证据 patch、选项读实测指标、`shouldCancel` 贯穿证据运行；`learning-activity` 17、`learning-panel` 17 |
| FIX-02/03/08 | ✅ 完成 | 重置雅可比反例（正确 ≈1.27e-7 vs 旧符号 ≈2.14e-5）、固定增益/奇异更新显式状态；33 项诊断契约 |
| FIX-04/07 | ✅ 完成 | 回看帧保留 `accelState/magState/reason`，ESKF 快照；五算法事件独立边沿；回看/遥测契约全绿 |
| FIX-05/11 | ✅ 完成 | stale 传播、8 行指标（含 SO(3) 倾角/偏航、接受率）与覆盖说明；对照报告/UI 契约全绿 |
| FIX-06/10 | ✅ 完成 | claim 注册表→教材按钮→动作→任务条返回/页锚点滚动聚焦；学习记录 JSON 导出；任务条冒泡阶段重置时序 |
| FIX-12/13 | ✅ 完成 | 浏览器完整集合 115/115；新增对照/学习/回看/claim 四条完整路径；课程首步根因修复 |
| FIX-14 | ➖ 范围外 | 项目所有者 2026-11-17 明确不需要读屏功能，不做该项验收 |
| FIX-15 | ✅ 所有者确认 | 项目所有者 2026-11-17 人工确认功能正常、无问题 |
| FIX-16 | ⏸️ 待授权 | 推送/CI/部署/Release 需项目所有者授权 |
| FIX-17 | ✅ 完成 | 五题逐题跑证据+正反例+种子/初始姿态扫描；整改见 §15.1 |

体积处理（未抬任何既有上限）：诊断 UI 拆为独立按需 chunk（新预算行 64 KiB），教学交互再拆为对照台/预测学习两个按需 chunk；目录 JSON 改紧凑序列化（约 −5.8 KB 总产物）；构建期压缩 `public/sw.js` 注释与空白（约 −0.8 KB gzip）；HTML 构建压缩启用可选标签/冗余属性清理。FIX-14 之前不再改动预算数值。

## 1. 缺陷总表与优先级

| ID | 优先级 | 缺陷 | 影响 | 需要人工？ |
|---|---|---|---|---|
| FIX-01 | **P0** | 预测题证据模型：题面条件与实际运行不一致；选项题判定不读证据 | 核心教学闭环不成立 | 否（模型自主） |
| FIX-02 | **P0** | ESKF 协方差重置雅可比符号相反 | 完整 ESKF 对照教学方向错误 | 否（模型自主） |
| FIX-03 | **P1** | 固定增益算法正常路径遥测为 unrecorded | 可观性面板对最常见工况无教学价值 | 否（模型自主） |
| FIX-04 | **P1** | 回看帧丢失观测状态字段 | 回看面板显示「未记录」 | 否（模型自主） |
| FIX-05 | **P1** | 对照结果 stale 不传播 | 旧报告冒充当前配置结论 | 否（模型自主） |
| FIX-06 | **P1** | F-08 教材双向链接基本未实现 | 教材→实验→教材闭环不存在 | 否（模型自主） |
| FIX-07 | **P2** | 事件只记录当前选中算法 | 方案要求五算法分别归并 | 否（模型自主） |
| FIX-08 | **P2** | ESKF 奇异更新被误标为「门控拒绝」 | 事件因果错误 | 否（模型自主） |
| FIX-09 | **P2** | 学习运行取消不传 shouldCancel | 切题后旧计算继续到结束 | 否（模型自主） |
| FIX-10 | **P2** | 任务条重置反馈时序 + 双任务模型 | 反馈可能错配 | 否（模型自主） |
| FIX-11 | **P2** | 对照主表缺倾角/偏航/接受率/覆盖说明 | 统计边界不可见 | 否（模型自主） |
| FIX-12 | **P2** | 浏览器冒烟教学路径不足 | 完整用户路径未验收 | 否（模型自主） |
| FIX-13 | **P2** | 课程第 1 步超时（110/111） | 需单独复现判定根因 | 否（模型自主） |
| FIX-14 | **范围外** | 真实读屏验收 | 所有者明确不需要读屏功能 | 否（已豁免） |
| FIX-15 | **已完成** | 人工视觉最终判定 | 所有者确认功能正常 | 否（已完成） |
| FIX-16 | **待人工** | CI 五轮 + 线上核验 + 发布 | 阶段 E 闭合 | **是，待用户决策** |
| FIX-17 | **已完成** | 预测题教学合理性复核 | 题目区间/解释是否适合目标学习者 | 否（已完成） |

---

## 2. FIX-01（P0）：预测题证据模型修复

### 2.1 问题描述

**浏览器实测证据**（`.audit-current/teaching-review/drift-learning.json`）：

- 题面：「陀螺零偏 2°/s、纯陀螺积分、初始姿态无偏差。10 s 时姿态误差最可能落在哪个范围？」
- 实际运行：装载 `drift` 实验（gyroBiasDps=3, gyroNoiseDps=0.2），固定 5s。
- 结果：峰值误差 14.94°，不在题面合理区间 15–25° 内。
- verdict：`undetermined`（无法判断）。

**根因**：`learning-panel.ts` 的 `run()` 调用 `deps.applyExperiment(experimentId)` 装载实验库默认参数，然后 `evidenceConfig()` 只改时长为 5s。题面声明的条件（2°/s、噪声归零、10s）从未被写入运行配置。

**选项题问题**：`choicePassed()` 只比较用户选择与 `correctChoiceIds`，完全不使用实测指标。运行数据对选项题只是展示用途。

**Ki 题问题**：题面要求对比 Ki=0 与 Ki=0.05，实际只装载一次 `drift`、读取一个 `steadyRmse`。

### 2.2 修复方案

#### A. 每题建立不可变证据配置

在 `learning-activity-data.ts` 的每个 `LearningActivity` 中新增字段：

```ts
interface LearningActivity {
  // ...existing fields...
  /** 本题证据运行的完整配置 patch（相对于默认配置）。
   *  不依赖实验库的默认参数；题面条件由此字段唯一决定。 */
  evidencePatch?: {
    durationSec: number;
    scenario?: string;
    imu?: Partial<ImuParams>;
    estimators?: Partial<Record<EstimatorId, Partial<EstimatorTuning>>>;
    magEnabled?: boolean;
    autoCoarseAlign?: boolean;
    initialAttitude?: InitialAttitudeSpec;
  };
  /** 选项题的实测判定谓词（替代 correctChoiceIds 直接比对）。
   *  每个选项对应一个可从 runner 结果计算的布尔条件。 */
  evidencePredicates?: Record<string, EvidencePredicate>;
}

type EvidencePredicate =
  | { kind: "metric-range"; estimator: EstimatorId; metric: string; min?: number; max?: number }
  | { kind: "metric-compare"; estimator: EstimatorId; metric: string; op: "gt" | "lt" | "eq"; value: number }
  | { kind: "always-true" }   // 纯几何事实，不需要数值验证
  | { kind: "always-false" }; // 明确错误的选项
```

#### B. 五道题的具体 patch

| 题目 | evidencePatch | 判定方式 |
|---|---|---|
| drift-linear-10s | durationSec=10, imu.gyroBiasDps=2, gyroNoiseDps=0, linAccel=0, vibration=0, scenario=hover, estimators.pure.enabled=true | 数值范围：pure.max ∈ [15,25] |
| accel-yaw-unobservable | durationSec=10, magEnabled=false, initialAttitude=random, estimators.mahony.magEnabled=false | 选项谓词：tilt-fixable→mahony.tiltRmse<5; yaw-fixable→always-false; gravity-axis→always-true; gain-fix→always-false; external-heading→mahony.yawRmse>10 |
| mahony-ki-bias | **需要两次运行**：A=Ki0, B=Ki0.05；durationSec=20, imu.gyroBiasDps=2, scenario=hover | 选项谓词：integral-removes-step→B.steadyRmse < A.steadyRmse; 其余→always-false |
| gimbal-lock-two-controls | 几何题，不需要 runner；使用现有万向节演示的 qAngleBetween | 选项谓词：same-pose→always-true（几何事实）; 其余→always-false |
| sensor-delay-omega-tau | durationSec=5, imu.sensorDelayMs=25, gyroBiasDps=0, gyroNoiseDps=0, scenario=violent, estimators.pure.enabled=true | 数值范围：pure.max ∈ [4,8] |

#### C. 修改 `learning-panel.ts` 的 `run()`

```
1. 不再调用 deps.applyExperiment(experimentId)。
2. 从 deps.currentConfig() 取基线，应用 activity.evidencePatch。
3. 对需要双条件的题（mahony-ki-bias），调用 deps.runEvidence 两次。
4. 选项题：用 evidencePredicates 对实测结果逐项求值，产生 passed。
5. 数值题：保持现有 comparePrediction 逻辑，但配置来自 evidencePatch。
6. attempt 绑定配置摘要（canonicalize 后的 JSON hash），不仅是 runRef。
```

#### D. 修改 `LearningPanelDeps`

```ts
interface LearningPanelDeps {
  // 移除 applyExperiment（不再需要）
  runEvidence(config: ExperimentConfig, activity: LearningActivity): Promise<...>;
  currentConfig(): ExperimentConfig;
  openDocs(page: string, anchor?: string): void;
  toast(msg: string, color?: string): void;
}
```

#### E. 修改 `main.ts` 接线

- 移除 `applyExperiment: (id) => applyExperimentById(id)`。
- `runEvidence` 保持现有 `runner.runExperimentDetailedAsync` 调用。
- 对双条件题，面板内部调用两次 `runEvidence`。

### 2.3 永久反例

- [ ] drift-linear-10s：配置 gyroBiasDps=2, durationSec=10, gyroNoiseDps=0；pure.max ∈ [15,25]。
- [ ] accel-yaw-unobservable：magEnabled=false；mahony.yawRmse > 10 且 tiltRmse < 5。
- [ ] mahony-ki-bias：两次运行，B.steadyRmse < A.steadyRmse。
- [ ] sensor-delay-omega-tau：pure.max ∈ [4,8]。
- [ ] 选项题 passed 由谓词产生，不读 correctChoiceIds。
- [ ] 修改现场参数后重新运行，证据配置不变（来自 evidencePatch，不来自现场）。
- [ ] 旧 attempt 的 runRef 不能完成新 attempt（既有测试保留）。

### 2.4 验收命令

```bash
npx tsx scripts/learning-activity-contract.test.ts
npx tsx scripts/learning-panel-contract.test.ts
npx tsc --noEmit && npm run check && npm run build && npm run budget
# 浏览器：五道题全部 run() 成功，verdict 不为 undetermined
```

---

## 3. FIX-02（P0）：ESKF 协方差重置雅可比符号

### 3.1 问题描述

`src/estimators/index.ts:1535-1551`：

```ts
// 当前代码（错误）
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) G[i * 6 + j] += 0.5 * sk[i * 3 + j];
}
```

右乘误差 `q_true ≈ q ⊗ Exp(δθ)`，注入 `q⁺ = q ⊗ Exp(δθ̂)` 后：
`δθ⁺ ≈ (I − ½[δθ̂]×)δθ`

**数值验证**（`.audit-current/teaching-review` 中执行）：
- δθ̂ = [0.03, -0.04, 0.05], δθ = [0.05, -0.02, 0.03]
- 正确 post = δθ − ½·cross(δθ̂, δθ) = [0.0501, -0.0208, 0.0293]
- 代码用 + 号得到 [0.0499, -0.0192, 0.0307]（方向相反）

### 3.2 修复

```ts
// 修正：右乘误差注入后残差雅可比为 I − ½[δθ̂]×
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) G[i * 6 + j] -= 0.5 * sk[i * 3 + j];
}
```

同步更新注释（第 1532 行）：`G = I − ½[δθ̂]×`。

### 3.3 永久反例

新增测试（`scripts/estimator-diagnostics-contract.test.ts` 或 `scripts/selftest.ts`）：

```
给定非零三轴 δθ̂ = [0.03, -0.04, 0.05]：
1. 构造 q_est, q_true = q_est ⊗ Exp(δθ_true)
2. 执行 applyUpdate 得到 δθ̂（或直接注入）
3. 计算解析残差 δθ⁺ = Log(Exp(-δθ̂) ⊗ Exp(δθ_true))
4. 计算 G·δθ_true（用修正后的 G）
5. 断言 ||δθ⁺ − G·δθ_true|| < 1e-6（一阶近似误差）
6. 断言旧 G（+号）不满足上述条件
```

### 3.4 影响范围

- 默认 `resetCovOnInject=false`，普通 ESKF 演示不受影响。
- 只影响开启「完整 ESKF 对照」后的协方差重置步骤。
- 修复后既有 selftest 中 `kalR.resetCovOnInject = true` 的测试仍须通过（P 对称正定）。
- 诊断快照中 `covarianceResetApplied` 标志不变。

### 3.5 验收命令

```bash
npx tsx scripts/estimator-diagnostics-contract.test.ts
npm run selftest
npx tsc --noEmit && npm run check && npm run build
```

---

## 4. FIX-03（P1）：固定增益算法补显式观测状态

### 4.1 问题描述

**浏览器实测**：互补滤波正常更新后 `accelState="unrecorded", magState="unrecorded"`。

**根因**：`src/estimators/index.ts` 中 comp/mahony/madg 的正常更新分支（门控放行、观测有效、实际执行了融合）没有设置 `accelState/magState`。只有早退分支（invalid/rejected）设置了显式状态。

`observability.ts:181-182` 的 fallback 逻辑：没有显式字段时返回 `unrecorded`。

### 4.2 修复

在三个固定增益估计器的**正常更新路径末尾**（`this.telemetry = {...}` 赋值处），补充：

```ts
accelState: "applied",
accelReasonCode: "applied",
magState: this.magEnabled && magActuallyUsed ? "applied" : (this.magEnabled ? "unrecorded" : "disabled"),
magReasonCode: this.magEnabled && magActuallyUsed ? "applied" : (this.magEnabled ? "mag-not-evaluated" : "mag-disabled"),
```

**零增益反例**：当 alpha=0 / kp=ki=0 / beta=0 时，观测虽然通过门控但实际修正量为零。此时应报告 `accepted-not-applied`：

```ts
// 在正常分支内判断实际修正是否非零
const correctionNonZero = Math.hypot(correction[0], correction[1], correction[2]) > 1e-12;
accelState: correctionNonZero ? "applied" : "accepted-not-applied",
```

对 Madgwick：当 `sNorm <= 1e-9`（梯度退化）时同样报告 `accepted-not-applied`。

### 4.3 永久反例

- [ ] comp alpha=1 正常更新：accelState="applied"。
- [ ] comp alpha=0：accelState="accepted-not-applied"。
- [ ] mahony kp=ki=0：accelState="accepted-not-applied"。
- [ ] madg beta=0：accelState="accepted-not-applied"。
- [ ] madg 梯度退化（sNorm≤1e-9）：accelState="accepted-not-applied"。
- [ ] 磁关闭：magState="disabled"。
- [ ] 磁开启但加计早退：magState="unrecorded"。
- [ ] 既有 invalid/rejected 分支不受影响。

### 4.4 验收命令

```bash
npx tsx scripts/estimator-diagnostics-contract.test.ts
npx tsx scripts/event-observability-contract.test.ts
npm run selftest
npx tsc --noEmit && npm run check && npm run build
# 浏览器：选 comp，打开可观性面板，确认显示「已应用」而非「未记录」
```

---

## 5. FIX-04（P1）：回看帧补全观测状态字段

### 5.1 问题描述

`src/core/review-buffer.ts:181-200` 的 `cloneTelemetry` 只复制 `accelAccepted/magAccepted`，不复制 `accelState/magState/accelReasonCode/magReasonCode`。

回看面板（`review-panel.ts:335-336`）读 `frame.telemetry.accelAccepted`，对固定增益算法该字段为 undefined→显示「未记录」。

### 5.2 修复

在 `cloneTelemetry` 中补充：

```ts
if (value.accelState !== undefined) out.accelState = cloneObservationState(value.accelState);
if (value.magState !== undefined) out.magState = cloneObservationState(value.magState);
if (value.accelReasonCode !== undefined) out.accelReasonCode = String(value.accelReasonCode);
if (value.magReasonCode !== undefined) out.magReasonCode = String(value.magReasonCode);
```

新增 `cloneObservationState` 校验函数（白名单：applied/accepted-not-applied/rejected/invalid/disabled/unrecorded/not-applicable）。

同步修改 `review-panel.ts` 的遥测显示：优先读 `accelState`，fallback 到 `accelAccepted`。

### 5.3 ESKF 快照写入 ReviewFrame

`BuildReviewFrameInput` 新增可选字段 `eskf?: KalmanStepSnapshot | null`。
`buildReviewFrame` 将其写入 `frame.eskf`。
`telemetry-diagnostics.ts` 的 `buildFrame` 在 ESKF 采集开启时传入最新快照。

### 5.4 永久反例

- [ ] 完整帧往返：push 含 accelState/magState/reasonCode 的帧→list 取回→字段逐项相等。
- [ ] 修改取回帧的 accelState 不影响缓冲内原帧。
- [ ] 非法 accelState 值被拒绝。
- [ ] ESKF 帧含 eskf 快照→取回后快照字段完整。
- [ ] 既有测试（坏帧拒绝、容量、runId 隔离）不受影响。

### 5.5 验收命令

```bash
npx tsx scripts/review-buffer-contract.test.ts
npx tsx scripts/review-eskf-ui-contract.test.ts
npx tsc --noEmit && npm run check && npm run build
# 浏览器：开启回看→记录→回看模式→确认遥测显示「已应用」
```

---

## 6. FIX-05（P1）：对照结果 stale 传播

### 6.1 问题描述

**浏览器实测**：完成对照后修改 `imu-gyro-bias`，任务条 `deviation=true`，但对照面板仍 `state="done", reportReady=true`。

### 6.2 修复方案

#### A. 引入 configRevision

在 `main.ts` 中维护单调递增的 `configRevision`：

```ts
let configRevision = 0;
// 在以下时机递增：
// - 用户参数提交（task-strip handleControl 检测到实际变化后）
// - 实验装载完成
// - 档案导入 commit 成功
// - 对照 applyB 成功
// - resetSim（如果改变了配置）
```

#### B. 对照面板记录来源版本

`ComparisonPanelDeps` 新增 `getConfigRevision(): number`。
`freeze()` 时记录 `frozenRevision = deps.getConfigRevision()`。
`finishReport()` 时记录 `reportRevision = frozenRevision`。

#### C. stale 检测

新增 `ComparisonPanelApi.markStaleIfChanged()`：

```ts
function markStaleIfChanged(): void {
  if (currentState === "done" && deps.getConfigRevision() !== reportRevision) {
    setState("stale", {}, "现场配置已变化，旧对照结果不再代表当前配置。可重新冻结基线并运行。");
  }
}
```

在 `main.ts` 的参数提交/实验装载/档案导入出口调用 `comparisonPanel?.markStaleIfChanged()`。

#### D. stale 状态下禁用「应用 B」

`renderControls()` 中 `btnApply.disabled` 增加 `currentState === "stale"` 条件。

### 6.3 永久反例

- [ ] 完成对照→改参数→state 变为 stale→btnApply 禁用。
- [ ] 完成对照→不改参数→state 保持 done。
- [ ] stale 后重新 freeze+run→新报告 done。
- [ ] 档案导入后旧对照标 stale。
- [ ] 既有取消/重启/交换测试不受影响。

### 6.4 验收命令

```bash
npx tsx scripts/comparison-ui-contract.test.ts
npx tsc --noEmit && npm run check && npm run build
# 浏览器：完成对照→改零偏→确认 state=stale
```

---

## 7. FIX-06（P1）：F-08 教材双向链接最小实现

### 7.1 问题描述

当前无 claimId 注册表、无教材→实验按钮、无返回阅读位置、无学习记录导出入口。

### 7.2 修复方案（最小可行）

#### A. claim 注册表

新建 `src/ui/learning-claims.ts`（首版 3 条，2026-11-17 扩到 13 条覆盖实验索引主要结论）：

```ts
export interface LearningClaim {
  id: string;
  docPage: string;
  docAnchor: string;
  label: string;
  action: "run-experiment" | "run-prediction" | "run-comparison";
  targetId: string; // experimentId / activityId / comparisonVariableId
}

export const LEARNING_CLAIMS: readonly LearningClaim[] = [
  { id: "claim-drift-linear", docPage: "labs", docAnchor: "l-exercise", label: "运行：零偏线性漂移", action: "run-prediction", targetId: "drift-linear-10s" },
  { id: "claim-yaw-unobservable", docPage: "labs", docAnchor: "l-exercise", label: "运行：偏航不可观", action: "run-prediction", targetId: "accel-yaw-unobservable" },
  { id: "claim-gate-rescue", docPage: "labs", docAnchor: "l-index", label: "运行：方向门控对照", action: "run-comparison", targetId: "accel-gate" },
];
```

#### B. 教材按钮渲染

在 `index.html` 的 `labs` 页对应位置插入 `<div data-claim="claim-drift-linear"></div>` 占位。
`main.ts` 在文档层打开时，扫描 `[data-claim]` 并渲染按钮。
按钮点击→关闭文档→执行对应动作→记录来源位置。

#### C. 返回阅读位置

```ts
interface DocReturnLocation {
  page: string;
  anchor: string;
  scrollTop: number;
  triggerElementId: string;
}
let docReturn: DocReturnLocation | null = null;
```

执行动作前保存；动作完成后在任务条显示「返回教材」按钮；点击→恢复文档页/锚点/滚动/焦点。

#### D. 学习记录导出入口

在 `learning-panel.ts` 的 `renderResult` 中新增「导出学习记录」按钮，调用已有的 `exportActivityRecord()`。

#### E. 静态检查

`scripts/catalog-contract.test.ts` 新增：所有 claim 的 targetId 必须存在于对应目录；docPage/docAnchor 必须存在于 index.html。

### 7.3 永久反例

- [ ] 教材按钮点击→正确动作执行→任务条出现。
- [ ] 返回教材→恢复正确页/锚点/焦点。
- [ ] 未知 claimId→构建检查失败。
- [ ] 导出学习记录→JSON 包含 activityId/version/prediction/evidence。
- [ ] 窄屏下按钮不溢出。

### 7.4 验收命令

```bash
npx tsx scripts/catalog-contract.test.ts
npx tsc --noEmit && npm run check && npm run build
# 浏览器：教材→按钮→实验→返回教材→焦点恢复
```

### 7.5 实际实现（2026-11-17）

- 渲染/动作/返回逻辑在 `src/ui/claim-links.ts`，由已懒加载的 `learning-panel.ts` 挂载；动作回调由主入口注入，未把 claim UI 塞回主包。
- 预测题 claim 在 labs 页内切换活动并写入任务上下文（面板本身就在该页，不关闭文档）；对照 claim 关闭文档、展开并冻结 `#sec-compare`；方向门控 claim 在 A 侧已开启时先关闭门控，保证 A/B 有差异。
- 返回按钮直接挂在 `#task-strip`，恢复页/锚点、`.doc-pages.scrollTop` 与触发按钮焦点；学习记录导出按钮在结果区，导出的 JSON 含活动 id/version、预测、证据、判定与反思。
- 浏览器用例「教材 claim 往返」覆盖预测+实验+对照三条动作、任务条返回、文档恢复与焦点恢复；claim 注册表已扩到 13 条（新增 10 条 run-experiment）。

---

## 8. FIX-07（P2）：事件记录五算法

### 8.1 问题

`telemetry-diagnostics.ts:280-282` 只传当前选中算法给 `eventRecorder.sample()`。

### 8.2 修复

改为传入全部五个估计器（与 `diagnostics-controller.ts:176-181` 一致）：

```ts
const estimators: RecorderEstimator[] = deps.getEstimators()
  .filter(e => e.id !== "truth")
  .map(e => ({ id: e.id as EstimatorId, label: e.label, telemetry: e.telemetry }));
```

需要在 `TelemetryDiagnosticsDeps` 中新增 `getEstimators()` 或复用现有接口。

### 8.3 反例

- [ ] 五算法同时有门控拒绝时，事件列表包含五条独立边沿。
- [ ] 切换选中算法不丢失其他算法的事件。

---

## 9. FIX-08（P2）：ESKF 奇异更新独立语义

### 9.1 问题

`src/estimators/index.ts:1351-1353`：`accelReject === "degenerate"` 时设 `accelState = "rejected"`。
`event-recorder.ts:231-257`：`state === "rejected"` 生成 `gate-reject` 事件。
因果错误：已通过门控的数值失败被讲成门控拦截。

### 9.2 修复

新增观测状态 `"update-failed"`（或复用 `"accepted-not-applied"`）：

```ts
} else if (accelReject === "degenerate") {
  accelState = "accepted-not-applied";
  accelReasonCode = "update-degenerate";
}
```

`event-recorder.ts` 中 `sampleChannel` 只对 `state === "rejected"` 生成 gate-reject 边沿；`accepted-not-applied` 不生成门控事件（可选生成独立的 `update-failed` 瞬时事件）。

`observability.ts` 的 `describeObservation` 已有 `accepted-not-applied` 分支，文案正确。

### 9.3 反例

- [ ] obsNoise=0 导致 S 奇异：accelState="accepted-not-applied"，不生成 gate-reject 事件。
- [ ] 正常门控拒绝：仍生成 gate-reject 事件。
- [ ] 既有诊断快照测试中 `gate.accepted=true, applied=false` 不变。

---

## 10. FIX-09（P2）：学习运行取消传 shouldCancel

### 10.1 问题

`learning-panel.ts:457-469` 的 `cancelActiveRun` 只标 `token.cancelled=true`。
`main.ts:7606-7612` 的 `runEvidence` 未传 `shouldCancel`。

### 10.2 修复

`LearningPanelDeps.runEvidence` 签名新增可选 `shouldCancel?: () => boolean`。
面板在调用时传入 `() => !isActive(token)`。
`main.ts` 接线将其传给 `runner.runExperimentDetailedAsync(config, { shouldCancel, ... })`。

### 10.3 反例

- [ ] 运行中切题→旧 runner 在下一片停止→termination.reason="cancelled"。
- [ ] 旧结果不绑定新 attempt。

---

## 11. FIX-10（P2）：任务条重置反馈时序

### 11.1 问题

`task-strip.ts:148-163` 在 document **捕获阶段**读取 `sawReset`。
真正的 `resetSim()` 在控件目标处理器中稍后执行。
首次解算频率变化只能显示「按登记行为会重置」，随后留下的 `sawReset` 可能被下一次无重置参数修改消费。

### 11.2 修复

将 `handleControl` 从捕获阶段改为**冒泡阶段**（去掉 `true` 参数），或在目标处理器完成后用 `queueMicrotask` 延迟读取 `sawReset`。

推荐方案：改为冒泡阶段监听（`document.addEventListener("input", handler)` 不带 `true`），确保目标处理器先执行。

### 11.3 反例

- [ ] 改解算频率→反馈显示「已重置」。
- [ ] 紧接着改陀螺噪声（不重置）→反馈不显示「已重置」。
- [ ] 实验装载→只有一条聚合反馈。

---

## 12. FIX-11（P2）：对照主表补充指标与覆盖说明

### 12.1 问题

`comparison-metrics.ts` 只有五条指标（RMSE、稳态 RMSE、峰值、收敛时间、样本数）。
方案要求倾角/偏航 RMS、观测接受率、终止时刻/pending tail。
`comparisonCoverageNotes()` 已实现但面板未调用。

### 12.2 修复

- `METRIC_DEFS` 新增：tiltSo3Rmse、yawSo3Rmse、accelAcceptPct（有真值/适用时）。
- 面板 `renderReportViews()` 末尾调用 `comparisonCoverageNotes(report)` 并渲染为折叠说明区。
- 无真值时新增指标显示「不可用（无真值）」，不补 0。

### 12.3 反例

- [ ] 有真值对照：倾角/偏航列有有限数值。
- [ ] 截断/近似/early-stop：覆盖说明可见。
- [ ] 无真值：新增列显示不可用。

---

## 13. FIX-12（P2）：浏览器冒烟教学完整路径

### 13.1 问题

当前冒烟对教学功能只测：
- 对照：冻结+选变量（不测完成→取消→重启→导出→应用 B→stale）。
- 学习：五题加载+预测前不泄露（不测 run→verdict→反思→导出）。
- 诊断：四面板挂载+回看帧有界（不测回看模式→帧内容→返回实时）。

### 13.2 修复

在 `scripts/browser-smoke.mjs` 中新增用例（同步更新 `smoke-manifest.json`）：

1. **对照完整路径**：freeze→selectVariable→run→等待 done→改参数→确认 stale→重新 freeze→run→导出→应用 B。
2. **学习完整路径**：选第一题→提交预测→run→确认 verdict≠undetermined→保存反思→导出记录。
3. **回看完整路径**：开启记录→等待帧→进入回看→确认帧内容含 accelState→上一帧/下一帧→返回实时→确认实时状态恢复。
4. **教材往返**：打开文档→点击 claim 按钮→确认动作执行→返回教材→确认焦点恢复。

### 13.3 注意

- 新增用例必须同步更新 `scripts/smoke-manifest.json` 和 `statuscheck` 的计数。
- 不删除既有用例。
- 对照 run 需要等待 Worker 完成（有界等待，不盲等）。
- 2026-11-17 执行结果：清单 app 91→95、合计 111→115，四条完整路径均在真实浏览器通过。

---

## 14. FIX-13（P2）：课程第 1 步超时复现

### 14.1 问题

完整浏览器套件 110/111，唯一失败：「引导课程：13 步逐条装载现场」第 1 步 3000ms 超时。

### 14.2 修复步骤

1. 单独运行课程用例（`SMOKE_SHARD=app`），确认是否可复现。
2. 如果可复现：检查第 1 步的等待条件（`tour-card` 可见 + 标题非空 + 实验装载完成）。
3. 如果是冷加载 chunk 延迟：增大等待上限或改为有界状态等待（等 `tour-counter` 文本变化）。
4. 如果不可复现（慢渲染/并发负载）：记录为环境偶发，不修改产品代码，但在冒烟中增加重试或更宽松的有界等待。
5. 无论根因如何，修复后完整套件必须 111/111（或新计数）。

### 14.3 实际根因与修复（2026-11-17）

第 1 步并非单纯冷加载慢：等 8 s 后标题与卡片已就绪，但断言仍失败在 `document.body.dataset.imuMode === "sim"`。生产代码只在**数据源切换**时调用 `applyDataSourceSemantics()` 写这个属性，首屏从未写过，所以属性是 `undefined`。修复两处：

1. `main.ts` 启动 `resetSim()` 后显式写初始 `data-imu-mode`（不调用会二次复位的完整语义函数）；
2. 冒烟首步与重开首步改用 8 s 有界等待，其余 12 步仍为 3 s，避免冷 chunk 下载被 3 s 误杀。

修复后课程 13 步全装载、浏览器完整集合 115/115、等待失败 0。

---

## 15. 待人工决策项（不执行）

以下各项**标记为待完成，等用户决策后再做**。模型不得自行执行。

### FIX-14：真实读屏验收

- **内容**：Windows Narrator 或 NVDA，覆盖主控制区、姿态读数、三视图切换、文档搜索、导出弹窗、批量运行状态、新增教学面板。
- **预计时间**：15–30 分钟人工操作。
- **前置条件**：FIX-01～FIX-13 全部完成。
- **产出**：`ACCESSIBILITY-ACCEPTANCE.md` 中读屏行从「未测」改为实际结论。
- **状态**：➖ 范围外（项目所有者 2026-11-17 明确不需要读屏功能）。

### FIX-15：人工视觉最终判定

- **内容**：逐张查看当前构建的视觉截图（含新增教学面板），确认无遮挡/截字/布局问题。
- **前置条件**：FIX-01～FIX-13 全部完成 + 重新采集视觉证据。
- **产出**：视觉验收记录。
- **状态**：✅ 已完成（项目所有者 2026-11-17 人工确认功能正常、无问题）。

### FIX-16：CI 五轮 + 线上核验 + 发布

- **内容**：推送分支→触发 CI→五轮稳定性→合并→部署→线上 postdeploy smoke→Release。
- **前置条件**：FIX-01～FIX-13 全部完成 + FIX-14/15 完成或明确标未测 + 用户授权推送。
- **产出**：CI 登记、线上构建标识一致、Release。
- **状态**：⏸️ 待授权。

### FIX-17：预测题教学合理性复核

- **内容**：教师/领域复核者确认五道题的理解层次、数值区间、解释文案是否适合目标学习者。
- **前置条件**：FIX-01 完成（题目能正确运行后才有复核意义）。
- **产出**：教学适用性确认或修改建议。
- **状态**：✅ 已完成（2026-11-17）：五题正确/错误预测均能判对/判错；修复数值题未钉初始姿态、偏航题随机种子翻转、Ki 解释过度承诺、锁点题歧义。

### 15.1 FIX-17 实际整改

| 题 | 复核发现 | 整改 |
|---|---|---|
| 零偏 10 s 漂移 | 未钉初始姿态；现场随机初始偏差会把峰值从 19.83° 拉到 41–47°，15–25° 正确答案被判错 | `evidencePatch` 固定 `initialAttitude: level`；条件文本写明“初始姿态水平” |
| 加速度计能修哪个轴 | 用 `random` 初始姿态，60 个种子里 18 个 yaw RMSE < 10°，正确选项被判错 | 改为固定纯偏航 `fixed-axis [0,0,1] 30°`；实测 yaw 31.92° / tilt 0.99°；条件文本说明随机偏差只用于观察同类现象 |
| Mahony Ki | 判定指标本身稳健（30/30 种子 B<A），但解释说“台阶最终归零”，20 s 内实际只从 2.67° 降到 1.50° | 固定初始水平；解释补“本题 20 s 窗口只降到约 1.50°，完全归零更慢” |
| 锁点两个滑块 | “横滚 +60° 与偏航 −60°”未说明其余角为 0，存在歧义 | 题面/条件明确“只把横滚 +60°（偏航 0）与只把偏航 −60°（横滚 0）” |
| 延迟多少度 | 未钉初始姿态；随机初始偏差会把峰值从 6.02° 拉到 34–37°，4–8° 正确答案被判错 | `evidencePatch` 固定 `initialAttitude: level`；条件文本写明“初始姿态水平” |

验证：五题正确预测全部 `consistent`、典型错误预测全部 `inconsistent`、控制台零错误；证据实测值分别为 19.83° / 31.92°（yaw）/ 2.67°→1.50° / 几何 / 6.02°。

---

## 16. 执行顺序与依赖

```text
FIX-02（ESKF 符号）── 独立，可最先做
     │
FIX-03（遥测状态）── 独立，可与 FIX-02 并行
     │
FIX-04（回看帧字段）── 依赖 FIX-03（需要正确的 accelState 才有意义）
     │
FIX-01（预测证据模型）── 独立，最大工作量
     │
FIX-05（对照 stale）── 独立
     │
FIX-08（奇异语义）── 依赖 FIX-03（状态枚举扩展）
     │
FIX-07（五算法事件）── 独立
     │
FIX-09（学习取消）── 依赖 FIX-01（run 接口变化）
     │
FIX-10（任务条时序）── 独立
     │
FIX-11（对照指标）── 独立
     │
FIX-06（教材链接）── 依赖 FIX-01（prediction 动作需要正确的 run）
     │
FIX-12（浏览器路径）── 依赖 FIX-01/05/06/04 全部完成
     │
FIX-13（课程超时）── 独立，可与任何项并行
     │
全部完成 → 重采证据 → FIX-14/15/16/17（待人工）
```

**推荐首批**：FIX-02 + FIX-03 + FIX-01（三项解决 P0 和最关键 P1，预计 +14 分）。

---

## 17. 修复后预期评分

| 修复项 | 预计加分 | 累计 |
|---|---:|---:|
| FIX-01 | +8 | 70 |
| FIX-02 | +2 | 72 |
| FIX-03 + FIX-04 | +4 | 76 |
| FIX-05 + FIX-11 | +3 | 79 |
| FIX-06 | +3 | 82 |
| FIX-07/08/09/10 | +2 | 84 |
| FIX-12/13 | +2 | 86 |
| FIX-14/15/16（人工） | +5 | 91 |
| FIX-17（人工） | +1 | 92 |

剩余扣分：单种子统计局限（-2）、主包装配层未拆（-2）、纯文字放大不生效（-2）、第三方数值对拍未做（-2）。

---

## 18. 交付模板

每项修复完成后填写：

```text
FIX-ID：
修复前反例（测试名/浏览器断言）：
修复内容（文件/行/变更摘要）：
修复后测试输出：
tsc / check / build / budget：
浏览器验证（若 UI 改动）：
截图路径：
控制台错误数：
既有测试是否全部保留：
未覆盖边界：
状态：已完成 / 部分完成 / 阻塞（原因）
```
