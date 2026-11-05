/**
 * 档案界面事务的**离线模型契约**（独立计数，不改变历史 selftest 门禁）。
 *
 * 覆盖三件事：
 *  1. 绑定表与 index.html 不漂移：`archiveUiSteps` 用到的每个控件 id 都真实存在，
 *     且控件约束（min/max/step/选项）能从 HTML 直接解析出来喂给离线模型。
 *  2. 离线判定判得准：越界、下拉枚举外、全局开关广播不一致、模型标签不匹配
 *     都必须在**不写控件**的前提下被判出来（现场零副作用的前提）。
 *  3. 合法配置判得过：默认配置、以及把每个字段都设成"恰好在控件网格上"的配置，
 *     离线判定必须为空——不能把能导入的档案误判成不能导入。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { archiveControlRoundTripProblems, archiveUiSteps, predictedArchiveReadback, snapSliderValue, type ControlSpecs } from "../src/core/archive-ui";
import { canonicalizeExperimentConfig, defaultExperimentConfig, type ExperimentConfig } from "../src/core/experiment-config";
import { parseArchive, buildArchive, type ArchiveRunInfo } from "../src/core/experiment-archive";

let pass = 0, fail = 0;
function test(name: string, body: () => void): void {
  try { body(); pass++; console.log(`PASS ${name}`); }
  catch (err) { fail++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`); }
}

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

/** 从 index.html 解析全部 range / select / checkbox 控件约束（与运行时 DOM 同源）。 */
function specsFromHtml(): ControlSpecs {
  const specs: ControlSpecs = {};
  for (const m of html.matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "id");
    if (!id) continue;
    const type = attr(tag, "type");
    if (type === "range") {
      specs[id] = {
        kind: "slider",
        min: parseFloat(attr(tag, "min") ?? "0"),
        max: parseFloat(attr(tag, "max") ?? "100"),
        step: parseFloat(attr(tag, "step") ?? "") || 0.01,
      };
    } else if (type === "checkbox") {
      specs[id] = { kind: "check" };
    }
  }
  for (const m of html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
    const id = attr(m[1], "id");
    if (!id) continue;
    const options = [...m[2].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((o) => attr(o[1], "value") ?? o[2].trim());
    specs[id] = { kind: "select", options };
  }
  return specs;
}
const specs = specsFromHtml();
const run: ArchiveRunInfo = {
  elapsedSec: 3, dataSource: "模拟", reference: "groundTruth", finishedAtIso: "2026-11-03T00:00:00.000Z",
  metrics: [{ id: "mahony", n: 5, mean: 1, rmse: 1, max: 2, convergedAt: 1 }],
};
const clone = (c: ExperimentConfig): ExperimentConfig => JSON.parse(JSON.stringify(c)) as ExperimentConfig;

test("绑定表不漂移：archiveUiSteps 的每个控件 id 都必须存在于 index.html", () => {
  const ids = new Set(archiveUiSteps(defaultExperimentConfig()).map((s) => s.id));
  assert.ok(ids.size >= 30, `档案绑定表只有 ${ids.size} 个控件，疑似漏写`);
  const missing = [...ids].filter((id) => !specs[id]);
  assert.deepEqual(missing, [], `这些控件在 index.html 里找不到（写入会被静默跳过）：${missing.join(", ")}`);
  // 复选框/滑块/下拉三种类型都要覆盖到，否则模型会整片漏判
  const kinds = new Set([...ids].map((id) => specs[id]!.kind));
  assert.deepEqual([...kinds].sort(), ["check", "select", "slider"]);
});

test("默认配置：离线判定为空，且预测读回与规范形逐字段一致", () => {
  const cfg = defaultExperimentConfig();
  assert.deepEqual(archiveControlRoundTripProblems(cfg, specs), []);
  assert.deepEqual(predictedArchiveReadback(canonicalizeExperimentConfig(cfg), specs), canonicalizeExperimentConfig(cfg));
});

test("越界数值必须被判出：滑块范围外、下拉枚举外、模型标签不一致", () => {
  const big = clone(defaultExperimentConfig());
  big.imu.gyroBiasDps = 999999; // 滑块上限 5
  const p1 = archiveControlRoundTripProblems(big, specs);
  assert.ok(p1.some((p) => p.path === "imu.gyroBiasDps"), `越界滑块未被判出：${JSON.stringify(p1)}`);

  const hz = clone(defaultExperimentConfig());
  hz.solveRateHz = 333; // 下拉只有 500/250/125/100/50
  const p2 = archiveControlRoundTripProblems(hz, specs);
  assert.ok(p2.some((p) => p.path === "solveRateHz"), `枚举外解算频率未被判出：${JSON.stringify(p2)}`);

  const model = clone(defaultExperimentConfig());
  model.magCalibration = { offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 20, kind: "full", matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  model.magModel = "diag"; // schema 直接拦下（模型标签必须与解算路径一致）
  const p3 = archiveControlRoundTripProblems(model, specs);
  assert.ok(p3.length > 0, "kind=full 却声明 magModel=diag 必须被拒");
});

test("全局开关广播：逐算法分叉必须被判出（界面只有一个总开关）", () => {
  const cfg = clone(defaultExperimentConfig());
  cfg.estimators.mahony.magEnabled = !cfg.estimators.comp.magEnabled;
  const p = archiveControlRoundTripProblems(cfg, specs);
  assert.ok(p.some((x) => x.path === "estimators.mahony.magEnabled"), `广播分叉未被判出：${JSON.stringify(p)}`);

  const gate = clone(defaultExperimentConfig());
  gate.estimators.madg.gateDeg = gate.estimators.comp.gateDeg + 7;
  const p2 = archiveControlRoundTripProblems(gate, specs);
  assert.ok(p2.some((x) => x.path === "estimators.madg.gateDeg"), `门控阈值广播分叉未被判出：${JSON.stringify(p2)}`);

  const mode = clone(defaultExperimentConfig());
  mode.estimators.madg.magMode = mode.estimators.mahony.magMode === "full" ? "yaw" : "full";
  const p3 = archiveControlRoundTripProblems(mode, specs);
  assert.ok(p3.some((x) => x.path === "estimators.madg.magMode"), `磁形态广播分叉未被判出：${JSON.stringify(p3)}`);
});

test("合法改动判得过：每个字段都设成控件网格上的邻居值", () => {
  const cfg = clone(defaultExperimentConfig());
  cfg.imu.gyroBiasDps = snapSliderValue(specs["imu-gyro-bias"], 2.3);
  cfg.imu.accelCrossAxis = snapSliderValue(specs["imu-cross-axis"], 1.7) / 100;
  cfg.solveRateHz = 250;
  cfg.scenario = "manual";
  cfg.manualTargetDeg = [10, -20, 30];
  cfg.steadyFromSec = 4;
  cfg.autoCoarseAlign = false;
  cfg.ab = { mode: "online-fork" };
  cfg.estimators.comp.magEnabled = false;
  for (const id of ["mahony", "madg", "kalman"] as const) cfg.estimators[id].magEnabled = false;
  cfg.estimators.mahony.magMode = "full";
  cfg.estimators.madg.magMode = "full";
  cfg.estimators.kalman.kalmanGate = "mahalanobis";
  cfg.estimators.kalman.kalmanResetCov = true;
  cfg.initialAttitude = { kind: "random" };
  assert.deepEqual(archiveControlRoundTripProblems(cfg, specs), [], "合法配置被误判为不可表达");
});

test("模型与真实写步骤一致：网格邻居值原样保留，网格外值被夹到网格上", () => {
  const spec = specs["imu-gyro-bias"]!;
  assert.equal(snapSliderValue(spec, 2.3), 2.3);
  assert.equal(snapSliderValue(spec, 99), spec.max);
  assert.equal(snapSliderValue(spec, -99), spec.min);
  const readback = predictedArchiveReadback(canonicalizeExperimentConfig(defaultExperimentConfig()), specs);
  // 写步骤的顺序语义：mag-enable 广播到 comp/mahony/madg/kalman，pure 恒为 false
  assert.equal(readback.estimators.pure.magEnabled, false);
  assert.equal(readback.estimators.kalman.magMode, "yaw", "comp/kalman 不吃 mag-mode 下拉");
});

test("规范形：省略可选字段的合法 v3 档案解析后与默认档案逐字节一致", () => {
  const full = JSON.parse(JSON.stringify(buildArchive(defaultExperimentConfig(), run))) as Record<string, any>;
  const minimal = JSON.parse(JSON.stringify(full));
  for (const k of ["magTargetUts", "autoCoarseAlign", "steadyFromSec", "manualTargetDeg", "ab"]) delete minimal.config[k];
  minimal.config.estimators.kalman = { ...minimal.config.estimators.kalman };
  delete minimal.config.estimators.kalman.kalmanGate;
  delete minimal.config.estimators.kalman.kalmanChi2;
  delete minimal.config.estimators.kalman.kalmanResetCov;
  const a = parseArchive(full), b = parseArchive(minimal);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(buildArchive(a.config, run)), JSON.stringify(buildArchive(b.config, run)),
    "省略可选字段与显式默认值必须收敛到同一规范形（逐字节）");
  // 再导出稳定：parse → build 的字节必须与原导出一致
  assert.equal(JSON.stringify(buildArchive(b.config, run)), JSON.stringify(full));
});

test("规范形：等价表示被归一并保持幂等，未知参数键被明确拒绝（SW-04）", () => {
  const raw = JSON.parse(JSON.stringify(buildArchive(defaultExperimentConfig(), run))) as Record<string, any>;
  raw.config.initialAttitude = { kind: "level", axis: [1, 0, 0], angleDeg: 30 };
  raw.config.magCalibration = null;
  const p = parseArchive(raw);
  assert.equal(p.ok, true, p.ok ? "" : p.error);
  if (!p.ok) return;
  // 非固定轴不得携带 axis：多一种表示就多一种"同一语义"，规范形必须只有一种
  assert.deepEqual(p.config.initialAttitude, { kind: "level" });
  const once = JSON.stringify(buildArchive(p.config, run));
  const again = parseArchive(JSON.parse(once) as Record<string, any>);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(JSON.stringify(buildArchive(again.config, run)), once, "规范形必须幂等");

  // 未知参数键：旧实现"解析成功但内核不读"，现在当前 schema 直接拒绝并给出字段路径
  const bogus = JSON.parse(JSON.stringify(buildArchive(defaultExperimentConfig(), run))) as Record<string, any>;
  bogus.config.estimators.comp.params.unknownKernelParam = 3;
  const rejected = parseArchive(bogus);
  assert.equal(rejected.ok, false, "未知参数键必须被拒绝，而不是静默保留");
  if (!rejected.ok) assert.ok(rejected.error.includes("params.unknownKernelParam"), `错误须含字段路径：${rejected.error}`);
});

test("SW-03 量化必须落在范围内**合法网格**上：越界值不能夹成不在网格的最大值", () => {
  // 用户把步距框改成 2、区间 0…5 时，合法网格只有 0/2/4。
  // 旧实现 round 得到 6 再夹成 5 —— 5 不在网格上，于是离线模型预测"读回 5"、
  // 真实控件读回 4，读回比较要么误放行、要么把合法档案判成不可恢复。
  const spec = { kind: "slider" as const, min: 0, max: 5, step: 2 };
  assert.equal(snapSliderValue(spec, 5), 4, "越界到 5 必须落到范围内最大网格点 4");
  assert.equal(snapSliderValue(spec, 4), 4);
  assert.equal(snapSliderValue(spec, 3), 4, "半格向上取整（3 → 4）");
  assert.equal(snapSliderValue(spec, -10), 0);
  assert.equal(snapSliderValue(spec, 100), 4, "远大于 max 也只到网格点 4");
  // 非零 min 与小数步距同样成立
  const shifted = { kind: "slider" as const, min: 0.1, max: 0.5, step: 0.15 };
  for (const raw of [0.1, 0.25, 0.4, 0.5, 9]) {
    const v = snapSliderValue(shifted, raw);
    assert.ok(v >= 0.1 - 1e-9 && v <= 0.5 + 1e-9, `结果必须在范围内：${v}`);
    assert.ok(Math.abs((v - 0.1) / 0.15 - Math.round((v - 0.1) / 0.15)) < 1e-6, `结果必须落在网格上：${v}`);
  }
  // 网格能整除区间时行为不变（回归）
  const plain = { kind: "slider" as const, min: 0, max: 5, step: 0.1 };
  assert.equal(snapSliderValue(plain, 999999), 5);
  assert.equal(snapSliderValue(plain, 2.3), 2.3);
});

test("SW-03 自定义步距下：合法网格外的档案必须被判为不可表达（模型与控件同口径）", () => {
  // 只覆盖目标控件的约束，其余沿用 index.html 实测约束（否则"缺控件"会掩盖真正要判的那一条）
  const specs: ControlSpecs = { ...specsFromHtml(), "imu-gyro-bias": { kind: "slider", min: 0, max: 5, step: 2 } };
  const cfg = clone(defaultExperimentConfig());
  cfg.imu.gyroBiasDps = 5; // 不在 0/2/4 网格上
  const problems = archiveControlRoundTripProblems(cfg, specs);
  assert.ok(problems.some((p) => p.path === "imu.gyroBiasDps"), `网格外取值必须被判出：${JSON.stringify(problems)}`);
  const ok = clone(defaultExperimentConfig());
  ok.imu.gyroBiasDps = 4;
  assert.deepEqual(archiveControlRoundTripProblems(ok, specs), [], "网格上的取值必须判为可表达");
});

console.log(`archive-ui-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
