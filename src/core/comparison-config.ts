/**
 * 单变量对照的配置生成与差异检查（纯函数，不 import DOM / Three.js）。
 *
 * 设计目标
 * --------
 * 1. **白名单**：对照变量用类型化联合声明，每个 id 对应唯一 setter 与唯一受影响路径集合；
 *    不提供任意字符串路径写入器，因此不存在 `__proto__` / 任意容器替换之类的入口。
 * 2. **只改声明字段**：A/B 都由 `cloneExperimentConfig` 生成，setter 只写声明路径，
 *    随后重新走 `experimentConfigProblems` 全量校验并规范化。
 * 3. **差异可证明**：`comparisonDiff` 给出规范化配置的**叶子路径**差异；构建时要求实际差异
 *    与声明路径集合完全相同。全局广播变量（accel-gate / mag-enabled）必须声明全部算法路径，
 *    不允许声称只改了一个叶子。
 *
 * 语义约定
 * --------
 * - `a` / `b` 是变量在两个对照侧的目标取值，A/B 都以冻结的 `base` 为起点应用；
 * - 返回的 `aPaths` / `bPaths` 分别表示「规范化基线 → A」与「规范化基线 → B」的叶子差异，
 *   用于 UI 展示每一侧相对基线漂移了哪些字段；
 * - `comparisonDiff(a, b)` 则直接给出两侧之间的差异，构建时它必须精确等于声明路径。
 */
import {
  canonicalizeExperimentConfig,
  cloneExperimentConfig,
  experimentConfigProblems,
  type ExperimentConfig,
} from "./experiment-config";

/** 允许参与对照的变量 id 白名单。 */
export const COMPARISON_VARIABLE_IDS = [
  "accel-gate",
  "mag-enabled",
  "solve-rate",
  "sensor-delay",
  "observation-noise",
] as const;

export type ComparisonVariableId = (typeof COMPARISON_VARIABLE_IDS)[number];

/**
 * 声明式对照变量。
 *
 * `affectedPaths` 是调用方对作用域的显式声明；构建时会与白名单逐项核对，
 * 不一致立即拒绝。这样 UI 不会在“全局广播”时只展示一个算法、漏报其它被改字段。
 */
export type ComparisonVariable =
  | { id: "accel-gate"; label: string; a: boolean; b: boolean; affectedPaths: readonly string[] }
  | { id: "mag-enabled"; label: string; a: boolean; b: boolean; affectedPaths: readonly string[] }
  | { id: "solve-rate"; label: string; a: number; b: number; affectedPaths: readonly string[] }
  | { id: "sensor-delay"; label: string; a: number; b: number; affectedPaths: readonly string[] }
  | { id: "observation-noise"; label: string; a: number; b: number; affectedPaths: readonly string[] };

/**
 * 白名单路径表（按字典序排列，与 `comparisonDiff` 的输出顺序一致）。
 *
 * 全局广播说明：
 * - accel-gate 同时写 comp / mahony / madg 三个算法的 `accelGate`（kalman 不使用该门控）；
 * - mag-enabled 同时写 comp / mahony / madg / kalman 四个算法的 `magEnabled`；
 *   pure 没有磁观测，必须保持 false，因此永远不在广播范围内。
 */
export const COMPARISON_AFFECTED_PATHS: Readonly<Record<ComparisonVariableId, readonly string[]>> = {
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

export type ComparisonPairResult =
  | { ok: true; a: ExperimentConfig; b: ExperimentConfig; aPaths: string[]; bPaths: string[] }
  | { ok: false; error: string; path?: string };

function isComparisonVariableId(value: unknown): value is ComparisonVariableId {
  return typeof value === "string" && (COMPARISON_VARIABLE_IDS as readonly string[]).includes(value);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

const MISSING = Symbol("comparison-missing");

function addPath(path: string, out: Set<string>): void {
  out.add(path || "config");
}

/** 一侧整体缺失/类型不符时，把对象/数组展开成全部叶子路径。 */
function addLeaves(value: unknown, path: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      addPath(path, out);
      return;
    }
    value.forEach((item, index) => addLeaves(item, `${path}[${index}]`, out));
    return;
  }
  if (isContainer(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) {
      addPath(path, out);
      return;
    }
    for (const key of keys) addLeaves(record[key], path ? `${path}.${key}` : key, out);
    return;
  }
  addPath(path, out);
}

function walkDiff(a: unknown, b: unknown, path: string, out: Set<string>): void {
  if (Object.is(a, b)) return;
  if (a === MISSING) {
    addLeaves(b, path, out);
    return;
  }
  if (b === MISSING) {
    addLeaves(a, path, out);
    return;
  }
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  const aObject = isContainer(a);
  const bObject = isContainer(b);
  if (aObject && bObject) {
    // 数组与对象结构不同：容器本身是一条差异，不再猜测如何对齐下标/键。
    if (aArray !== bArray) {
      addPath(path, out);
      return;
    }
    if (aArray) {
      const aa = a as unknown[];
      const bb = b as unknown[];
      const length = Math.max(aa.length, bb.length);
      for (let i = 0; i < length; i++) {
        walkDiff(i < aa.length ? aa[i] : MISSING, i < bb.length ? bb[i] : MISSING, `${path}[${i}]`, out);
      }
      return;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const key of keys) {
      const inA = Object.prototype.hasOwnProperty.call(ao, key);
      const inB = Object.prototype.hasOwnProperty.call(bo, key);
      walkDiff(
        inA ? ao[key] : MISSING,
        inB ? bo[key] : MISSING,
        path ? `${path}.${key}` : key,
        out,
      );
    }
    return;
  }
  if (aObject || bObject) {
    // 一侧是容器、另一侧是标量/缺失：展开容器一侧的叶子。
    addLeaves(aObject ? a : b, path, out);
    return;
  }
  addPath(path, out);
}

/**
 * 规范化配置的叶子路径差异（确定性：键排序、数组按值、结果字典序、去重）。
 *
 * 数组按元素逐个比较（缺失元素用哨兵展开），对象按键名并集递归；`null` 视作叶子值。
 */
export function comparisonDiff(a: ExperimentConfig, b: ExperimentConfig): string[] {
  const out = new Set<string>();
  walkDiff(a, b, "", out);
  return [...out].sort();
}

function samePathSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const want = new Set(expected);
  const seen = new Set<string>();
  for (const path of actual) {
    if (!want.has(path) || seen.has(path)) return false;
    seen.add(path);
  }
  return true;
}

function firstPathMismatch(actual: readonly string[], expected: readonly string[]): string | undefined {
  const want = new Set(expected);
  const unexpected = actual.find(path => !want.has(path));
  if (unexpected !== undefined) return unexpected;
  const have = new Set(actual);
  return expected.find(path => !have.has(path));
}

function parseDeclaredPaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const path of raw) {
    if (typeof path !== "string" || path.length === 0) return null;
    out.push(path);
  }
  return new Set(out).size === out.length ? out : null;
}

interface NumberRule {
  min: number;
  max?: number;
  minExclusive?: boolean;
  integer?: boolean;
  unit: string;
}

function numberProblem(
  value: unknown,
  side: "a" | "b",
  path: string,
  label: string,
  rule: NumberRule,
): ComparisonPairResult | null {
  const where = side === "a" ? "A" : "B";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `${where} 侧${label}必须是有限数值`, path };
  }
  const belowMin = rule.minExclusive ? value <= rule.min : value < rule.min;
  if (belowMin) {
    return {
      ok: false,
      error: `${where} 侧${label}必须${rule.minExclusive ? "大于" : "不小于"} ${rule.min}${rule.unit}`,
      path,
    };
  }
  if (rule.max !== undefined && value > rule.max) {
    return { ok: false, error: `${where} 侧${label}必须不超过 ${rule.max}${rule.unit}`, path };
  }
  if (rule.integer && !Number.isInteger(value)) {
    return { ok: false, error: `${where} 侧${label}必须是整数${rule.unit}`, path };
  }
  return null;
}

function valueProblem(variable: ComparisonVariable): ComparisonPairResult | null {
  let problem: ComparisonPairResult | null = null;
  switch (variable.id) {
    case "accel-gate":
    case "mag-enabled": {
      const id = variable.id;
      // 运行时输入可能来自 JSON/消息，静态类型为 boolean 也要按 unknown 复核。
      const a: unknown = variable.a;
      const b: unknown = variable.b;
      if (typeof a !== "boolean") {
        problem = { ok: false, error: `${id} 的 A 侧取值必须是布尔值`, path: "a" };
      } else if (typeof b !== "boolean") {
        problem = { ok: false, error: `${id} 的 B 侧取值必须是布尔值`, path: "b" };
      }
      break;
    }
    case "solve-rate": {
      const rule: NumberRule = { min: 0, max: 1000, minExclusive: true, integer: true, unit: " Hz" };
      problem =
        numberProblem(variable.a, "a", "solveRateHz", "解算频率", rule) ??
        numberProblem(variable.b, "b", "solveRateHz", "解算频率", rule);
      break;
    }
    case "sensor-delay": {
      const rule: NumberRule = { min: 0, max: 30, unit: " ms" };
      problem =
        numberProblem(variable.a, "a", "imu.sensorDelayMs", "传感器群延迟", rule) ??
        numberProblem(variable.b, "b", "imu.sensorDelayMs", "传感器群延迟", rule);
      break;
    }
    case "observation-noise": {
      // 只校验教学下限；上限等更宽的 schema 边界交给 experimentConfigProblems。
      const rule: NumberRule = { min: 0, minExclusive: true, unit: "" };
      problem =
        numberProblem(variable.a, "a", "estimators.kalman.params.obsNoise", "观测噪声", rule) ??
        numberProblem(variable.b, "b", "estimators.kalman.params.obsNoise", "观测噪声", rule);
      break;
    }
  }
  if (problem) return problem;
  if (Object.is(variable.a, variable.b)) {
    return { ok: false, error: "A 与 B 取值相同，未形成单变量对照", path: "b" };
  }
  return null;
}

/** 只写白名单声明的标量路径；没有通用路径写入入口。 */
function applyComparisonValue(cfg: ExperimentConfig, variable: ComparisonVariable, side: "a" | "b"): void {
  switch (variable.id) {
    case "accel-gate":
      for (const id of ["comp", "mahony", "madg"] as const) cfg.estimators[id].accelGate = variable[side];
      return;
    case "mag-enabled":
      for (const id of ["comp", "mahony", "madg", "kalman"] as const) cfg.estimators[id].magEnabled = variable[side];
      return;
    case "solve-rate":
      cfg.solveRateHz = variable[side];
      return;
    case "sensor-delay":
      cfg.imu.sensorDelayMs = variable[side];
      return;
    case "observation-noise":
      // 只改观测噪声，gyroNoiseDps 保持基线值：这不是“Q/R 参数组”对照。
      cfg.estimators.kalman.params.obsNoise = variable[side];
      return;
  }
}

/**
 * 以冻结基线生成 A/B 规范形配置。
 *
 * 失败情形（都返回字段路径，不抛异常）：
 * - 基线未通过 `experimentConfigProblems`；
 * - 变量 id 不在白名单、label/affectedPaths 声明不合法；
 * - 数值非有限 / 超出教学范围 / 与 schema 冲突；
 * - 应用后的某一侧未通过全量校验；
 * - 实际差异与声明路径不精确一致（含“全局广播只声明一个叶子”）。
 */
export function buildComparisonPair(base: ExperimentConfig, variable: ComparisonVariable): ComparisonPairResult {
  // 1. 基线优先：无效基线不允许进入建组流程。
  const baseProblems = experimentConfigProblems(base);
  if (baseProblems.length > 0) {
    const first = baseProblems[0];
    return { ok: false, error: `基线配置无效：${first.message}`, path: first.path };
  }
  if (variable === null || typeof variable !== "object") {
    return { ok: false, error: "对照变量必须是对象", path: "variable" };
  }

  // 2. id / 声明路径必须落在白名单内。
  const idValue: unknown = (variable as { id?: unknown }).id;
  if (!isComparisonVariableId(idValue)) {
    return { ok: false, error: `未知对照变量 id：${String(idValue)}`, path: "id" };
  }
  if (typeof variable.label !== "string" || variable.label.length === 0) {
    return { ok: false, error: "对照变量 label 必须是非空字符串", path: "label" };
  }
  const expected = [...COMPARISON_AFFECTED_PATHS[idValue]].sort();
  const declared = parseDeclaredPaths(variable.affectedPaths);
  if (!declared || !samePathSet(declared, expected)) {
    return {
      ok: false,
      error: `affectedPaths 必须精确声明白名单路径：${expected.join(", ")}`,
      path: "affectedPaths",
    };
  }

  // 3. pure 没有磁观测：mag-enabled 广播不得覆盖它，也不能在 true 基线上假装“保持 false”。
  if (variable.id === "mag-enabled" && base.estimators.pure.magEnabled !== false) {
    return {
      ok: false,
      error: "pure 没有磁观测，mag-enabled 对照要求基线 estimators.pure.magEnabled 为 false",
      path: "estimators.pure.magEnabled",
    };
  }

  // 4. 取值本身先做路径明确的检查，再交给全量 schema 校验兜底。
  const badValue = valueProblem(variable);
  if (badValue) return badValue;

  // 5. 两侧都从基线深拷贝，setter 只写声明路径；两侧与基线互不共享可变对象。
  const a = cloneExperimentConfig(base);
  const b = cloneExperimentConfig(base);
  applyComparisonValue(a, variable, "a");
  applyComparisonValue(b, variable, "b");

  const aProblems = experimentConfigProblems(a);
  if (aProblems.length > 0) {
    const first = aProblems[0];
    return { ok: false, error: `A 侧配置无效：${first.message}`, path: first.path };
  }
  const bProblems = experimentConfigProblems(b);
  if (bProblems.length > 0) {
    const first = bProblems[0];
    return { ok: false, error: `B 侧配置无效：${first.message}`, path: first.path };
  }

  // 6. 规范化后再比较：键顺序、可选字段形态等表示差异不得影响结论。
  const canonicalBase = canonicalizeExperimentConfig(cloneExperimentConfig(base));
  const canonicalA = canonicalizeExperimentConfig(a);
  const canonicalB = canonicalizeExperimentConfig(b);

  const diff = comparisonDiff(canonicalA, canonicalB);
  if (!samePathSet(diff, expected)) {
    const path = firstPathMismatch(diff, expected);
    return {
      ok: false,
      error: `A/B 实际差异路径 ${JSON.stringify(diff)} 与声明 ${JSON.stringify(expected)} 不一致`,
      ...(path !== undefined ? { path } : {}),
    };
  }

  // 7. 每一侧相对基线的漂移也必须落在声明集合内，且合起来覆盖全部声明路径。
  const aPaths = comparisonDiff(canonicalBase, canonicalA);
  const bPaths = comparisonDiff(canonicalBase, canonicalB);
  const extra = [...aPaths, ...bPaths].find(path => !expected.includes(path));
  if (extra !== undefined) {
    return { ok: false, error: `基线到 A/B 出现声明外差异：${extra}`, path: extra };
  }
  const covered = new Set([...aPaths, ...bPaths]);
  const missing = expected.find(path => !covered.has(path));
  if (missing !== undefined) {
    return { ok: false, error: `基线到 A/B 未覆盖声明路径：${missing}`, path: missing };
  }

  return { ok: true, a: canonicalA, b: canonicalB, aPaths, bPaths };
}

/** 交换 A/B 取值；返回新对象，不修改输入，也不共享 affectedPaths 数组。 */
export function swapComparisonVariable(variable: ComparisonVariable): ComparisonVariable {
  const affectedPaths = [...variable.affectedPaths];
  switch (variable.id) {
    case "accel-gate":
      return { id: variable.id, label: variable.label, a: variable.b, b: variable.a, affectedPaths };
    case "mag-enabled":
      return { id: variable.id, label: variable.label, a: variable.b, b: variable.a, affectedPaths };
    case "solve-rate":
      return { id: variable.id, label: variable.label, a: variable.b, b: variable.a, affectedPaths };
    case "sensor-delay":
      return { id: variable.id, label: variable.label, a: variable.b, b: variable.a, affectedPaths };
    case "observation-noise":
      return { id: variable.id, label: variable.label, a: variable.b, b: variable.a, affectedPaths };
  }
}
