/** 单变量对照配置契约：白名单 setter、精确差异、基线不可变与规范化。 */
import assert from "node:assert/strict";
import {
  COMPARISON_AFFECTED_PATHS,
  COMPARISON_VARIABLE_IDS,
  buildComparisonPair,
  comparisonDiff,
  swapComparisonVariable,
  type ComparisonPairResult,
  type ComparisonVariable,
  type ComparisonVariableId,
} from "../src/core/comparison-config";
import {
  canonicalizeExperimentConfig,
  cloneExperimentConfig,
  defaultExperimentConfig,
  type ExperimentConfig,
} from "../src/core/experiment-config";

let passed = 0, failed = 0;
function test(name: string, body: () => void): void {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

type PairOk = Extract<ComparisonPairResult, { ok: true }>;
type PairFail = Extract<ComparisonPairResult, { ok: false }>;

function mustOk(result: ComparisonPairResult): PairOk {
  if (!result.ok) throw new Error(`预期成功，实际失败：${result.error}`);
  return result;
}
function mustFail(result: ComparisonPairResult): PairFail {
  if (result.ok) throw new Error("预期失败，实际成功");
  return result;
}

/** 测试独立写死白名单路径，避免直接复述生产常量造成自证。 */
const TEST_PATHS: Record<ComparisonVariableId, readonly string[]> = {
  "accel-gate": [
    "estimators.comp.accelGate",
    "estimators.madg.accelGate",
    "estimators.mahony.accelGate",
  ],
  "mag-enabled": [
    "estimators.comp.magEnabled",
    "estimators.kalman.magEnabled",
    "estimators.madg.magEnabled",
    "estimators.mahony.magEnabled",
  ],
  "solve-rate": ["solveRateHz"],
  "sensor-delay": ["imu.sensorDelayMs"],
  "observation-noise": ["estimators.kalman.params.obsNoise"],
};

/** 默认基线上每类变量的 A=基线值、B=变化值。 */
const VARIABLES: ComparisonVariable[] = [
  { id: "accel-gate", label: "方向门控", a: true, b: false, affectedPaths: TEST_PATHS["accel-gate"] },
  { id: "mag-enabled", label: "磁修正", a: true, b: false, affectedPaths: TEST_PATHS["mag-enabled"] },
  { id: "solve-rate", label: "解算频率", a: 500, b: 50, affectedPaths: TEST_PATHS["solve-rate"] },
  { id: "sensor-delay", label: "传感器群延迟", a: 0, b: 25, affectedPaths: TEST_PATHS["sensor-delay"] },
  { id: "observation-noise", label: "观测噪声", a: 0.05, b: 0.2, affectedPaths: TEST_PATHS["observation-noise"] },
];

function makeVariable(
  id: ComparisonVariableId,
  a: unknown,
  b: unknown,
  affectedPaths: unknown = TEST_PATHS[id],
): ComparisonVariable {
  return { id, label: `契约-${id}`, a, b, affectedPaths } as unknown as ComparisonVariable;
}

/** 测试侧独立构造期望配置：只改声明路径，其余字段必须与基线一致。 */
function expectedSide(base: ExperimentConfig, variable: ComparisonVariable, side: "a" | "b"): ExperimentConfig {
  const cfg = cloneExperimentConfig(base);
  switch (variable.id) {
    case "accel-gate":
      for (const id of ["comp", "mahony", "madg"] as const) cfg.estimators[id].accelGate = variable[side];
      break;
    case "mag-enabled":
      for (const id of ["comp", "mahony", "madg", "kalman"] as const) cfg.estimators[id].magEnabled = variable[side];
      break;
    case "solve-rate":
      cfg.solveRateHz = variable[side];
      break;
    case "sensor-delay":
      cfg.imu.sensorDelayMs = variable[side];
      break;
    case "observation-noise":
      cfg.estimators.kalman.params.obsNoise = variable[side];
      break;
  }
  return canonicalizeExperimentConfig(cfg);
}

function sparseBase(): ExperimentConfig {
  const base = defaultExperimentConfig();
  delete base.manualTargetDeg;
  delete base.ab;
  delete base.magTargetUts;
  delete base.steadyFromSec;
  delete base.autoCoarseAlign;
  delete base.magCalibrationApplied;
  delete base.accelCalibrationApplied;
  delete base.accelCalibration;
  delete base.estimators.kalman.kalmanGate;
  delete base.estimators.kalman.kalmanChi2;
  delete base.estimators.kalman.kalmanResetCov;
  return base;
}

test("白名单 id 与路径表固定", () => {
  assert.deepEqual([...COMPARISON_VARIABLE_IDS], [
    "accel-gate",
    "mag-enabled",
    "solve-rate",
    "sensor-delay",
    "observation-noise",
  ]);
  for (const id of COMPARISON_VARIABLE_IDS) {
    assert.deepEqual(COMPARISON_AFFECTED_PATHS[id], TEST_PATHS[id], `${id} 路径表必须与契约一致`);
  }
});

for (const variable of VARIABLES) {
  test(`${variable.id}: 差异精确、其余字段深等、基线不变`, () => {
    const base = defaultExperimentConfig();
    const before = cloneExperimentConfig(base);
    const result = mustOk(buildComparisonPair(base, variable));

    assert.deepEqual(comparisonDiff(result.a, result.b), TEST_PATHS[variable.id], "A/B 差异必须精确等于声明路径");
    assert.deepEqual(result.aPaths, [], "A 取基线值时相对基线无变化");
    assert.deepEqual(result.bPaths, TEST_PATHS[variable.id], "B 相对基线只改声明路径");
    assert.deepEqual(result.a, expectedSide(base, variable, "a"), "A 除声明路径外必须与基线一致");
    assert.deepEqual(result.b, expectedSide(base, variable, "b"), "B 除声明路径外必须与基线一致");
    assert.deepEqual(canonicalizeExperimentConfig(result.a), result.a, "A 必须是规范形");
    assert.deepEqual(canonicalizeExperimentConfig(result.b), result.b, "B 必须是规范形");
    assert.deepEqual(base, before, "构建不得修改基线");
    assert.equal(JSON.stringify(base), JSON.stringify(before), "基线的键顺序也不得变化");
  });
}

test("accel-gate: 只广播 comp/mahony/madg，kalman 保持基线", () => {
  const base = defaultExperimentConfig();
  const result = mustOk(buildComparisonPair(base, VARIABLES[0]));
  for (const id of ["comp", "mahony", "madg"] as const) {
    assert.equal(result.a.estimators[id].accelGate, true);
    assert.equal(result.b.estimators[id].accelGate, false);
  }
  assert.equal(result.a.estimators.kalman.accelGate, base.estimators.kalman.accelGate);
  assert.equal(result.b.estimators.kalman.accelGate, base.estimators.kalman.accelGate);
});

test("mag-enabled: 广播四算法，pure 两侧保持 false", () => {
  const base = defaultExperimentConfig();
  const result = mustOk(buildComparisonPair(base, VARIABLES[1]));
  for (const id of ["comp", "mahony", "madg", "kalman"] as const) {
    assert.equal(result.a.estimators[id].magEnabled, true);
    assert.equal(result.b.estimators[id].magEnabled, false);
  }
  assert.equal(result.a.estimators.pure.magEnabled, false);
  assert.equal(result.b.estimators.pure.magEnabled, false);
  assert.equal(base.estimators.pure.magEnabled, false);
  assert.ok(!comparisonDiff(result.a, result.b).some(path => path.includes("pure")), "广播不得改 pure");
});

test("solve-rate / sensor-delay / observation-noise: 单字段值精确", () => {
  const base = defaultExperimentConfig();
  const solve = mustOk(buildComparisonPair(base, VARIABLES[2]));
  assert.equal(solve.a.solveRateHz, 500);
  assert.equal(solve.b.solveRateHz, 50);

  const delay = mustOk(buildComparisonPair(base, VARIABLES[3]));
  assert.equal(delay.a.imu.sensorDelayMs, 0);
  assert.equal(delay.b.imu.sensorDelayMs, 25);

  const noise = mustOk(buildComparisonPair(base, VARIABLES[4]));
  assert.equal(noise.a.estimators.kalman.params.obsNoise, 0.05);
  assert.equal(noise.b.estimators.kalman.params.obsNoise, 0.2);
  assert.equal(noise.a.estimators.kalman.params.gyroNoiseDps, base.estimators.kalman.params.gyroNoiseDps);
  assert.equal(noise.b.estimators.kalman.params.gyroNoiseDps, base.estimators.kalman.params.gyroNoiseDps);
});

test("混合基线：aPaths/bPaths 分别记录两侧漂移，合起来覆盖声明路径", () => {
  const base = defaultExperimentConfig();
  // 基线的三个 accelGate 不一致：A 只修 mahony，B 只改 comp/madg。
  base.estimators.comp.accelGate = true;
  base.estimators.mahony.accelGate = false;
  base.estimators.madg.accelGate = true;
  const variable = makeVariable("accel-gate", true, false);
  const result = mustOk(buildComparisonPair(base, variable));

  assert.deepEqual(result.aPaths, ["estimators.mahony.accelGate"]);
  assert.deepEqual(result.bPaths, ["estimators.comp.accelGate", "estimators.madg.accelGate"]);
  assert.deepEqual(comparisonDiff(result.a, result.b), TEST_PATHS["accel-gate"]);
  assert.deepEqual(result.a, expectedSide(base, variable, "a"));
  assert.deepEqual(result.b, expectedSide(base, variable, "b"));
});

test("合法边界：不限制在 UI 下拉档位，接受内核范围与浮点延迟", () => {
  const base = defaultExperimentConfig();
  for (const [a, b] of [[500, 333], [1000, 10]] as const) {
    const result = mustOk(buildComparisonPair(base, makeVariable("solve-rate", a, b)));
    assert.equal(result.a.solveRateHz, a);
    assert.equal(result.b.solveRateHz, b);
  }
  for (const [a, b] of [[0, 30], [12.5, 0.5]] as const) {
    const result = mustOk(buildComparisonPair(base, makeVariable("sensor-delay", a, b)));
    assert.equal(result.a.imu.sensorDelayMs, a);
    assert.equal(result.b.imu.sensorDelayMs, b);
  }
  const noise = mustOk(buildComparisonPair(base, makeVariable("observation-noise", 1e-6, 1e6)));
  assert.equal(noise.a.estimators.kalman.params.obsNoise, 1e-6);
  assert.equal(noise.b.estimators.kalman.params.obsNoise, 1e6);
});

const BAD_VALUES: Array<[string, ComparisonVariable, string]> = [
  ["solve-rate NaN", makeVariable("solve-rate", NaN, 50), "solveRateHz"],
  ["solve-rate Infinity", makeVariable("solve-rate", 500, Infinity), "solveRateHz"],
  ["solve-rate 负数", makeVariable("solve-rate", -1, 50), "solveRateHz"],
  ["solve-rate 0", makeVariable("solve-rate", 0, 50), "solveRateHz"],
  ["solve-rate 超过 1000", makeVariable("solve-rate", 1001, 50), "solveRateHz"],
  ["solve-rate 非整数", makeVariable("solve-rate", 500.5, 50), "solveRateHz"],
  ["solve-rate 字符串", makeVariable("solve-rate", "500", 50), "solveRateHz"],
  ["sensor-delay 负数", makeVariable("sensor-delay", -0.1, 25), "imu.sensorDelayMs"],
  ["sensor-delay 超过 30ms", makeVariable("sensor-delay", 0, 30.1), "imu.sensorDelayMs"],
  ["sensor-delay NaN", makeVariable("sensor-delay", NaN, 25), "imu.sensorDelayMs"],
  ["sensor-delay Infinity", makeVariable("sensor-delay", 0, Infinity), "imu.sensorDelayMs"],
  ["sensor-delay 字符串", makeVariable("sensor-delay", "25", 0), "imu.sensorDelayMs"],
  ["observation-noise 0", makeVariable("observation-noise", 0, 0.2), "estimators.kalman.params.obsNoise"],
  ["observation-noise 负数", makeVariable("observation-noise", -0.1, 0.2), "estimators.kalman.params.obsNoise"],
  ["observation-noise NaN", makeVariable("observation-noise", NaN, 0.2), "estimators.kalman.params.obsNoise"],
  ["observation-noise Infinity", makeVariable("observation-noise", 0.05, Infinity), "estimators.kalman.params.obsNoise"],
  ["accel-gate A 非布尔", makeVariable("accel-gate", 1, false), "a"],
  ["accel-gate B 非布尔", makeVariable("accel-gate", true, 0), "b"],
  ["mag-enabled A 非布尔", makeVariable("mag-enabled", "true", false), "a"],
  ["mag-enabled B 非布尔", makeVariable("mag-enabled", true, null), "b"],
];

for (const [name, variable, path] of BAD_VALUES) {
  test(`非法取值拒绝：${name}`, () => {
    const base = defaultExperimentConfig();
    const before = cloneExperimentConfig(base);
    const failure = mustFail(buildComparisonPair(base, variable));
    assert.equal(failure.path, path, `错误路径应为 ${path}，实际 ${String(failure.path)}`);
    assert.ok(failure.error.length > 0, "错误必须带说明");
    assert.deepEqual(base, before, "失败路径也不得修改基线");
  });
}

test("schema 全量校验兜底：越界仍返回具体字段路径", () => {
  const base = defaultExperimentConfig();
  // 5 Hz 通过“有限且 > 0”的教学检查，但低于内核 10 Hz 下限，由 experimentConfigProblems 拒绝。
  const lowRate = mustFail(buildComparisonPair(base, makeVariable("solve-rate", 5, 50)));
  assert.equal(lowRate.path, "solveRateHz");
  // 2e6 通过 > 0 检查，但超过 schema 的 1e6 上限。
  const highNoise = mustFail(buildComparisonPair(base, makeVariable("observation-noise", 0.05, 2_000_000)));
  assert.equal(highNoise.path, "estimators.kalman.params.obsNoise");
});

test("非法基线优先拒绝并给出路径", () => {
  const edits: Array<[string, (base: ExperimentConfig) => void]> = [
    ["seed", base => { base.seed = -1; }],
    ["imu.gyroBiasDps", base => { base.imu.gyroBiasDps = NaN; }],
    ["solveRateHz", base => { base.solveRateHz = 0; }],
  ];
  for (const [path, edit] of edits) {
    const base = defaultExperimentConfig();
    edit(base);
    const before = cloneExperimentConfig(base);
    const failure = mustFail(buildComparisonPair(base, VARIABLES[2]));
    assert.equal(failure.path, path);
    assert.deepEqual(base, before);
  }
});

test("未知 id / 固定条件不能作为对照变量", () => {
  const base = defaultExperimentConfig();
  for (const id of ["seed", "scenario", "durationSec", "magModel", "initialAttitude"]) {
    const failure = mustFail(buildComparisonPair(base, makeVariable(id as ComparisonVariableId, 0, 1, [id])));
    assert.equal(failure.path, "id", `${id} 不得成为白名单变量`);
  }
});

test("affectedPaths 必须精确声明完整作用域", () => {
  const base = defaultExperimentConfig();
  // 全局广播只声明一个叶子：拒绝。
  const singleLeaf = mustFail(buildComparisonPair(base, makeVariable("accel-gate", true, false, ["estimators.comp.accelGate"])));
  assert.equal(singleLeaf.path, "affectedPaths");
  // 借合法 id 夹带固定条件：拒绝。
  const smuggled = mustFail(buildComparisonPair(base, makeVariable("solve-rate", 500, 50, ["seed"])));
  assert.equal(smuggled.path, "affectedPaths");
  // 额外声明 pure：拒绝。
  const extraLeaf = mustFail(buildComparisonPair(
    base,
    makeVariable("mag-enabled", true, false, [...TEST_PATHS["mag-enabled"], "estimators.pure.magEnabled"]),
  ));
  assert.equal(extraLeaf.path, "affectedPaths");
  // 重复路径：拒绝。
  const duplicate = mustFail(buildComparisonPair(base, makeVariable("solve-rate", 500, 50, ["solveRateHz", "solveRateHz"])));
  assert.equal(duplicate.path, "affectedPaths");
  // 顺序不影响集合语义。
  const shuffled = mustOk(buildComparisonPair(
    base,
    makeVariable("accel-gate", true, false, [...TEST_PATHS["accel-gate"]].reverse()),
  ));
  assert.deepEqual(comparisonDiff(shuffled.a, shuffled.b), TEST_PATHS["accel-gate"]);
});

test("A 与 B 相同不构成单变量对照", () => {
  const base = defaultExperimentConfig();
  for (const variable of [
    makeVariable("solve-rate", 500, 500),
    makeVariable("accel-gate", true, true),
    makeVariable("observation-noise", 0.1, 0.1),
  ]) {
    const failure = mustFail(buildComparisonPair(base, variable));
    assert.equal(failure.path, "b");
  }
});

test("mag-enabled 在 pure=true 基线上拒绝，而不是悄悄保留 true", () => {
  const base = defaultExperimentConfig();
  base.estimators.pure.magEnabled = true;
  const failure = mustFail(buildComparisonPair(base, VARIABLES[1]));
  assert.equal(failure.path, "estimators.pure.magEnabled");
});

test("非规范但合法基线：两侧输出均为规范形", () => {
  const base = sparseBase();
  // 稀疏基线不能用 cloneExperimentConfig 快照（克隆会补齐默认值），用 JSON 保留原始形态。
  const before = JSON.parse(JSON.stringify(base)) as ExperimentConfig;
  const variable = VARIABLES[2];
  const result = mustOk(buildComparisonPair(base, variable));
  const canonicalBase = canonicalizeExperimentConfig(base);

  assert.deepEqual(result.a, canonicalBase, "A 必须补齐全部可选字段的文档默认值");
  assert.equal(JSON.stringify(result.a), JSON.stringify(canonicalBase), "规范化键顺序也必须稳定");
  assert.deepEqual(result.b, expectedSide(base, variable, "b"));
  assert.deepEqual(comparisonDiff(result.a, canonicalizeExperimentConfig(result.a)), [], "规范形必须幂等");
  assert.equal(result.a.steadyFromSec, null);
  assert.equal(result.a.autoCoarseAlign, true);
  assert.deepEqual(result.a.manualTargetDeg, [0, 0, 0]);
  assert.deepEqual(base, before, "规范化不得修改输入基线");
  assert.equal(JSON.stringify(base), JSON.stringify(before));
  assert.equal(Object.prototype.hasOwnProperty.call(base, "manualTargetDeg"), false, "基线必须保持稀疏形态");
});

test("返回值与基线/彼此不共享可变对象，构建不修改输入", () => {
  const base = defaultExperimentConfig();
  base.magCalibration = {
    offset: [1, 2, 3],
    scale: [1, 1, 1],
    field: 50,
    residual: 0.01,
    count: 20,
    kind: "diag",
  };
  base.magCalibrationApplied = true;
  const before = cloneExperimentConfig(base);
  const variable = VARIABLES[4];
  const variableBefore = { ...variable, affectedPaths: [...variable.affectedPaths] };
  const result = mustOk(buildComparisonPair(base, variable));

  assert.deepEqual(base, before, "构建不得修改基线");
  assert.deepEqual(variable, variableBefore, "构建不得修改输入变量");
  assert.ok(result.a.magCalibration);
  assert.ok(result.b.magCalibration);
  assert.notEqual(result.a.magCalibration, base.magCalibration);
  assert.notEqual(result.b.magCalibration, base.magCalibration);
  assert.notEqual(result.a.magCalibration, result.b.magCalibration);
  assert.notEqual(result.a.magCalibration.offset, result.b.magCalibration.offset);
  assert.notEqual(result.a.estimators, result.b.estimators);
  assert.notEqual(result.a.estimators.kalman.params, result.b.estimators.kalman.params);
  assert.notEqual(result.a.imu, result.b.imu);
  assert.notEqual(result.a.manualTargetDeg, result.b.manualTargetDeg);

  result.a.imu.gyroBiasDps = 99;
  result.a.estimators.kalman.params.obsNoise = 999;
  result.a.magCalibration!.offset[0] = 99;
  result.a.manualTargetDeg![0] = 99;
  assert.equal(base.imu.gyroBiasDps, before.imu.gyroBiasDps);
  assert.equal(base.estimators.kalman.params.obsNoise, before.estimators.kalman.params.obsNoise);
  assert.equal(base.magCalibration!.offset[0], 1);
  assert.deepEqual(base.manualTargetDeg, before.manualTargetDeg);
  assert.equal(result.b.estimators.kalman.params.obsNoise, 0.2);
  assert.equal(result.b.magCalibration!.offset[0], 1);
  assert.deepEqual(result.b.manualTargetDeg, before.manualTargetDeg);
});

for (const variable of VARIABLES) {
  test(`${variable.id}: swap 只交换两侧`, () => {
    const base = defaultExperimentConfig();
    const beforeA = variable.a;
    const beforeB = variable.b;
    const original = mustOk(buildComparisonPair(base, variable));
    const swappedVariable = swapComparisonVariable(variable);

    assert.notEqual(swappedVariable, variable);
    assert.equal(swappedVariable.id, variable.id);
    assert.equal(swappedVariable.label, variable.label);
    assert.deepEqual(swappedVariable.affectedPaths, variable.affectedPaths);
    assert.notEqual(swappedVariable.affectedPaths, variable.affectedPaths, "swap 不得共享路径数组");
    assert.equal(swappedVariable.a, beforeB);
    assert.equal(swappedVariable.b, beforeA);
    assert.equal(variable.a, beforeA, "swap 不得修改原变量");
    assert.equal(variable.b, beforeB);

    const swapped = mustOk(buildComparisonPair(base, swappedVariable));
    assert.deepEqual(swapped.a, original.b, "交换后 A 必须是原 B");
    assert.deepEqual(swapped.b, original.a, "交换后 B 必须是原 A");
    assert.deepEqual(comparisonDiff(swapped.a, swapped.b), TEST_PATHS[variable.id]);
    assert.deepEqual(swapped.aPaths, original.bPaths, "交换后 A 相对基线的漂移等于原 B");
    assert.deepEqual(swapped.bPaths, original.aPaths, "交换后 B 相对基线的漂移等于原 A");

    const back = swapComparisonVariable(swappedVariable);
    assert.equal(back.a, beforeA);
    assert.equal(back.b, beforeB);
    assert.equal(back.id, variable.id);
  });
}

test("comparisonDiff：相同配置为空（键顺序无关）", () => {
  const a = defaultExperimentConfig();
  const b = cloneExperimentConfig(a);
  assert.deepEqual(comparisonDiff(a, b), []);
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as ExperimentConfig;
  assert.deepEqual(comparisonDiff(a, reordered), [], "顶层键顺序不得产生差异");
  const nested = cloneExperimentConfig(a);
  nested.estimators = Object.fromEntries(Object.entries(nested.estimators).reverse()) as typeof nested.estimators;
  assert.deepEqual(comparisonDiff(a, nested), [], "嵌套键顺序不得产生差异");
});

test("comparisonDiff：捕获额外对象/数组字段并确定性排序", () => {
  const a = defaultExperimentConfig();

  const phantom = cloneExperimentConfig(a);
  (phantom as unknown as Record<string, unknown>).phantom = { nested: 1 };
  assert.deepEqual(comparisonDiff(a, phantom), ["phantom.nested"]);

  const array = cloneExperimentConfig(a);
  array.manualTargetDeg = [0, 0, 5];
  assert.deepEqual(comparisonDiff(a, array), ["manualTargetDeg[2]"]);

  const shortArray = cloneExperimentConfig(a);
  const longArray = cloneExperimentConfig(a);
  (shortArray as unknown as Record<string, unknown>).extraArray = [1, 2];
  (longArray as unknown as Record<string, unknown>).extraArray = [1, 2, 3];
  assert.deepEqual(comparisonDiff(shortArray, longArray), ["extraArray[2]"]);

  const emptyObject = cloneExperimentConfig(a);
  (emptyObject as unknown as Record<string, unknown>).emptyExtra = {};
  assert.deepEqual(comparisonDiff(a, emptyObject), ["emptyExtra"]);

  const objectSide = cloneExperimentConfig(a);
  const scalarSide = cloneExperimentConfig(a);
  (objectSide as unknown as Record<string, unknown>).mixed = { x: 1 };
  (scalarSide as unknown as Record<string, unknown>).mixed = 7;
  assert.deepEqual(comparisonDiff(objectSide, scalarSide), ["mixed.x"]);

  const arraySide = cloneExperimentConfig(a);
  const recordSide = cloneExperimentConfig(a);
  (arraySide as unknown as Record<string, unknown>).struct = [1];
  (recordSide as unknown as Record<string, unknown>).struct = { 0: 1 };
  assert.deepEqual(comparisonDiff(arraySide, recordSide), ["struct"], "数组/对象结构不同只报容器路径");

  const multiple = cloneExperimentConfig(a);
  multiple.seed = 1;
  multiple.durationSec = 10;
  multiple.solveRateHz = 50;
  assert.deepEqual(comparisonDiff(a, multiple), ["durationSec", "seed", "solveRateHz"], "多路径必须字典序且去重");
});

console.log(`comparison-config-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
