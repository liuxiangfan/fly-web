/** 档案/schema 与校准入口契约；独立计数，不改变历史 selftest 门禁。 */
import assert from "node:assert/strict";
import { parseArchive, buildArchive, type ArchiveRunInfo } from "../src/core/experiment-archive";
import { defaultExperimentConfig, parseMagCalibration, parseAccelCalibration, validateExperimentConfig, archiveExpressibilityProblems, archiveRoundTripProblems } from "../src/core/experiment-config";
import { calibrateAccel, synthesizeAccelSamples, type AccelCalibration } from "../src/core/accelcal";
import { applyMagCalibration, calibrateMag, calibrateMagFull, calibrateMagWithValidation } from "../src/core/magcal";
import type { V3 } from "../src/core/quat";

let passed = 0, failed = 0;
function test(name: string, body: () => void): void {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}
const run: ArchiveRunInfo = {
  elapsedSec: 12.5, dataSource: "模拟", reference: "groundTruth", finishedAtIso: "2026-11-01T00:00:00.000Z",
  metrics: [{ id: "mahony", n: 10, mean: 1, rmse: 1.2, max: 2, convergedAt: 1.5 }],
};
function archive(): Record<string, any> { return JSON.parse(JSON.stringify(buildArchive(defaultExperimentConfig(), run))); }
function reject(edit: (a: Record<string, any>) => void, path: string): void {
  const a = archive(); edit(a); const before = JSON.stringify(a);
  const parsed = parseArchive(a);
  assert.equal(parsed.ok, false, `应拒绝 ${path}`);
  if (!parsed.ok) assert.ok(parsed.error.includes(path), `错误须含字段路径 ${path}：${parsed.error}`);
  assert.equal(JSON.stringify(a), before, "解析不能修改输入");
}
const mag = { offset: [1, 2, 3], scale: [1, 1, 1], field: 50, residual: 0.01, count: 120, kind: "diag" };
const M = [1.02, 0.02, -0.01, -0.015, 0.98, 0.03, 0.02, -0.012, 1.01];
const accel: AccelCalibration = { M, bias: [0.05, -0.03, 0.08], rmse: [0.01, 0.02, 0.01], count: 6, faces: ["+x", "-x", "+y", "-y", "+z", "-z"] };

test("v3 完整合法档案往返", () => { assert.equal(parseArchive(archive()).ok, true); });
for (const k of ["seed", "scenario", "durationSec", "solveRateHz", "imu", "estimators", "initialAttitude", "magModel", "magCalibration"]) {
  test(`v3 必需顶层 ${k}`, () => reject(a => { delete a.config[k]; }, k));
}
test("v3 空 imu 不得补默认值", () => reject(a => { a.config.imu = {}; }, "imu.gyroBiasDps"));
test("v3 空 estimators 不得补默认值", () => reject(a => { a.config.estimators = {}; }, "estimators.pure"));
test("v3 缺 initial.kind", () => reject(a => { a.config.initialAttitude = {}; }, "initialAttitude.kind"));
for (const [id, key] of [["comp", "alpha"], ["mahony", "kp"], ["mahony", "ki"], ["madg", "beta"], ["kalman", "gyroNoiseDps"], ["kalman", "obsNoise"]]) {
  test(`v3 算法必需参数 ${id}.${key}`, () => reject(a => { delete a.config.estimators[id].params[key]; }, `estimators.${id}.params.${key}`));
}
for (const [key, value] of [["enabled", "true"], ["magMode", "other"], ["gateDeg", 181], ["gateMagPct", 0], ["kalmanGate", "other"], ["kalmanChi2", "11"], ["kalmanChi2", 0], ["kalmanResetCov", "false"]]) {
  test(`v3 算法已知类型/枚举/范围 ${key}=${value}`, () => reject(a => { a.config.estimators.kalman[key] = value; }, `estimators.kalman.${key}`));
}
for (const value of ["fork", 7, [], {}, { mode: "other" }, { mode: false }]) {
  test(`v3 ab 非法 ${JSON.stringify(value)}`, () => reject(a => { a.config.ab = value; }, typeof value === "object" && !Array.isArray(value) ? "ab.mode" : "ab"));
}
test("v3 固定轴缺 angle 不得默认 30", () => reject(a => { a.config.initialAttitude = { kind: "fixed-axis", axis: [1, 0, 0] }; }, "initialAttitude.angleDeg"));
test("v3 非固定轴已声明 angle 也验范围", () => reject(a => { a.config.initialAttitude.angleDeg = -1; }, "initialAttitude.angleDeg"));
test("v3 IMU 已知字段错类型", () => reject(a => { a.config.imu.gyroNoiseDps = "oops"; }, "imu.gyroNoiseDps"));
test("v3 非法 scenario 枚举", () => reject(a => { a.config.scenario = "future-motion"; }, "scenario"));
test("v3 非法参数范围", () => reject(a => { a.config.estimators.comp.params.alpha = -1; }, "estimators.comp.params.alpha"));
for (const version of ["3", null, true, 0, -1, 1.5, NaN, Infinity, 4]) {
  test(`坏 schemaVersion ${String(version)} 不得迁移`, () => reject(a => { a.config.schemaVersion = version; }, "schemaVersion"));
}
for (const version of [undefined, 1, 2]) {
  test(`合法旧版 ${String(version)} 白名单迁移+notes`, () => {
    const a = archive(); a.config = { seed: 7, durationSec: 5, imu: { gyroNoiseDps: 0.3, unknownExtra: "ignore" }, magCalibration: { ...mag } };
    if (version !== undefined) a.config.schemaVersion = version;
    const p = parseArchive(a); assert.equal(p.ok, true);
    if (p.ok) { assert.equal(p.config.seed, 7); assert.ok(p.config.magCalibration); assert.ok(p.notes.length); assert.equal((p.config.imu as any).unknownExtra, undefined); }
  });
}
test("旧版错类型可降级但 notes 必须含路径", () => {
  const a = archive(); a.config = { schemaVersion: 2, seed: "bad", ab: { mode: "bad" }, estimators: { kalman: { kalmanChi2: "bad" } } };
  const p = parseArchive(a); assert.equal(p.ok, true);
  if (p.ok) { for (const path of ["seed", "ab.mode", "estimators.kalman.kalmanChi2"]) assert.ok(p.notes.some(n => n.includes(path))); }
});
for (const [path, value] of [["elapsedSec", "12"], ["elapsedSec", -1], ["dataSource", []], ["reference", "unknown"], ["finishedAtIso", 123], ["metrics", {}]] as Array<[string, unknown]>) {
  test(`run 结构字段 ${path}`, () => reject(a => { a.run[path] = value; }, `run.${path}`));
}
for (const [path, value] of [["id", 7], ["n", 1.5], ["mean", "1"], ["rmse", -1], ["max", Infinity], ["convergedAt", "1"]]) {
  test(`run.metrics 结构字段 ${path}`, () => reject(a => { a.run.metrics[0][path] = value; }, `run.metrics[0].${path}`));
}
test("run 非对象必须拒绝", () => reject(a => { a.run = []; }, "run"));
test("零样本指标：n=0 时统计量显式为 null，自家导出的档案必须能导回", () => {
  const a = archive();
  a.run.metrics = [{ id: "mahony", n: 0, mean: null, rmse: null, max: null, convergedAt: null }];
  const p = parseArchive(a);
  assert.equal(p.ok, true, p.ok ? "" : p.error);
});
test("n=0 不得声称统计量（数字、NaN 都拒绝）", () => {
  reject(a => { a.run.metrics = [{ id: "mahony", n: 0, mean: 0, rmse: null, max: null, convergedAt: null }]; }, "run.metrics[0].mean");
  reject(a => { a.run.metrics = [{ id: "mahony", n: 0, mean: null, rmse: null, max: NaN, convergedAt: null }]; }, "run.metrics[0].max");
});

test("strict 拒绝界面无法表达的值（seed/解算频率/手动目标角/restore）", () => {
  reject(a => { a.config.seed = 1.5; }, "seed");
  reject(a => { a.config.seed = -1; }, "seed");
  reject(a => { a.config.seed = 2 ** 40; }, "seed");
  reject(a => { a.config.solveRateHz = 333; }, "solveRateHz");
  reject(a => { a.config.solveRateHz = 0; }, "solveRateHz");
  reject(a => { a.config.manualTargetDeg = [999, 0, 0]; }, "manualTargetDeg");
  reject(a => { a.restore = "full"; }, "restore");
});

test("界面无法表达的配置在导入前被指出（固定轴初始姿态、关闭单个算法）", () => {
  const cfg = defaultExperimentConfig();
  assert.deepEqual(archiveExpressibilityProblems(cfg), []);
  cfg.initialAttitude = { kind: "fixed-axis", axis: [0, 0, 1], angleDeg: 30 };
  assert.ok(archiveExpressibilityProblems(cfg).some((p) => p.path === "initialAttitude.kind"));
  cfg.initialAttitude = { kind: "level" };
  cfg.estimators.madg.enabled = false;
  assert.ok(archiveExpressibilityProblems(cfg).some((p) => p.path === "estimators.madg.enabled"));
});

test("往返比较指出会被界面改写/丢失的字段，并跳过界面不可调整的字段", () => {
  const want = defaultExperimentConfig(), got = defaultExperimentConfig();
  assert.deepEqual(archiveRoundTripProblems(want, got), []);
  want.solveRateHz = 333; got.solveRateHz = 500;
  assert.ok(archiveRoundTripProblems(want, got).some((p) => p.path === "solveRateHz"));
  want.solveRateHz = 500;
  want.imu.gyroBiasDps = 999999; got.imu.gyroBiasDps = 5;
  assert.ok(archiveRoundTripProblems(want, got).some((p) => p.path === "imu.gyroBiasDps"));
  want.imu.gyroBiasDps = got.imu.gyroBiasDps;
  want.initialAttitude = { kind: "random" }; got.initialAttitude = { kind: "level" };
  assert.ok(archiveRoundTripProblems(want, got).some((p) => p.path === "initialAttitude.kind"));
  want.initialAttitude = { kind: "level" };
  want.durationSec = 12.5; got.durationSec = 30;
  want.steadyFromSec = 4; got.steadyFromSec = undefined;
  want.autoCoarseAlign = false; got.autoCoarseAlign = true;
  assert.deepEqual(archiveRoundTripProblems(want, got), []);
});
test("run 缺字段必须给路径", () => reject(a => { delete a.run.metrics; }, "run.metrics"));
test("缺 run/null 保留 config-only 兼容", () => { const a = archive(); delete a.run; assert.equal(parseArchive(a).ok, true); a.run = null; assert.equal(parseArchive(a).ok, true); });
for (const k of ["offset", "scale", "field", "residual", "count"]) {
  test(`mag raw 必需字段 ${k}`, () => { const c: any = { ...mag }; delete c[k]; assert.equal(parseMagCalibration(c), null); });
}
for (const k of ["M", "bias", "rmse", "count", "faces"]) {
  test(`accel raw 必需字段 ${k}`, () => { const c: any = { ...accel }; delete c[k]; assert.equal(parseAccelCalibration(c), null); });
}
test("mag 未知 kind 不能清洗为 diag", () => { assert.equal(parseMagCalibration({ ...mag, kind: "bad" }), null); });
test("mag diag 已声明坏 matrix 不能静默丢弃", () => { assert.equal(parseMagCalibration({ ...mag, matrix: [1, "bad"] }), null); });
test("diag 携带合法 matrix 也拒绝（模型标签必须与解算路径一致）", () => {
  assert.equal(parseMagCalibration({ ...mag, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }), null);
});
test("旧版未声明 kind 且带矩阵：按 full 解释，不得标成 diag", () => {
  const c: Record<string, unknown> = { ...mag, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  delete c.kind;
  const p = parseMagCalibration(c);
  assert.ok(p);
  assert.equal(p!.kind, "full");
});
test("应用路径按 kind 分派：diag 绝不使用 matrix", () => {
  const cal = {
    offset: [0, 0, 0] as V3, scale: [1, 1, 1] as V3, field: 50, residual: 0, count: 100,
    kind: "diag" as "diag" | "full", matrix: [2, 0, 0, 0, 2, 0, 0, 0, 2],
  };
  assert.deepEqual(applyMagCalibration([1, 0, 0], cal), [1, 0, 0]);
  cal.kind = "full";
  assert.deepEqual(applyMagCalibration([1, 0, 0], cal), [2, 0, 0]);
});
test("mag full matrix 必需", () => { assert.equal(parseMagCalibration({ ...mag, kind: "full" }), null); });
test("accel 非法 face 元素不能过滤", () => { assert.equal(parseAccelCalibration({ ...accel, faces: [...accel.faces, 1] }), null); assert.equal(parseAccelCalibration({ ...accel, faces: [...accel.faces, "bad"] }), null); });
test("mag validation 错类型/缺字段不能默认化", () => { assert.equal(parseMagCalibration({ ...mag, validation: { residual: 0.1, count: 20, maxErrUt: 1, ratio: "bad" } }), null); assert.equal(parseMagCalibration({ ...mag, validation: { residual: 0.1 } }), null); });
test("accel validation 已声明方向错类型不能丢弃", () => { assert.equal(parseAccelCalibration({ ...accel, validation: { meanNormErrMs2: 0.1, maxNormErrMs2: 0.2, heldOutFaces: 6, meanDirErrDeg: "bad" } }), null); });
test("fittedWith 缺字段不能默认为 0", () => { assert.equal(parseMagCalibration({ ...mag, fittedWith: { at: "2026-11-01" } }), null); assert.equal(parseAccelCalibration({ ...accel, fittedWith: { at: "2026-11-01" } }), null); });
test("合法 metadata 完整往返与输入隔离", () => {
  const c = { ...accel, fittedWith: { at: "2026-11-01", crossAxis: 0.01, nonlin: 0, noise: 0.1 }, validation: { meanNormErrMs2: 0.01, maxNormErrMs2: 0.02, heldOutFaces: 6, meanDirErrDeg: 0.1, maxDirErrDeg: 0.2 } };
  const p = parseAccelCalibration(c); assert.ok(p); assert.deepEqual(p, c); p!.faces.push("+x"); assert.equal(c.faces.length, 6);
});
test("加计允许真实非对称交叉轴与 benchmark 合成", () => {
  const fit = calibrateAccel(synthesizeAccelSamples(M, [0.05, -0.03, 0.08], 0.02, 99)); assert.ok(fit);
  assert.ok(parseAccelCalibration(JSON.parse(JSON.stringify(fit))));
  const c = defaultExperimentConfig(); c.accelCalibration = fit; assert.equal(validateExperimentConfig(c).length, 0);
});
test("拟合和 parse 必须共用交叉轴上限", () => {
  const excessive = [1, 0.55, 0, 0, 1, 0, 0, 0, 1];
  const fit = calibrateAccel(synthesizeAccelSamples(excessive, [0, 0, 0]));
  assert.equal(fit, null, "当前拟合接受 Mxy=.55 但 parse 拒绝，必须统一");
  assert.equal(parseAccelCalibration({ ...accel, M: excessive }), null);
});
test("磁 SPD 与加计 nearidentity 分流", () => {
  assert.equal(parseMagCalibration({ ...mag, kind: "full", matrix: M }), null);
  assert.ok(parseAccelCalibration(accel));
  assert.equal(parseAccelCalibration({ ...accel, M: [-1, 0, 0, 0, -1, 0, 0, 0, 1] }), null);
});
test("合法磁 diag/full 生产拟合能导入", () => {
  const points: V3[] = Array.from({ length: 240 }, (_, i) => {
    const z = 1 - 2 * (i + 0.5) / 240, r = Math.sqrt(1 - z * z), az = i * Math.PI * (3 - Math.sqrt(5));
    return [50 * r * Math.cos(az) + 1, 50 * r * Math.sin(az) + 2, 50 * z + 3];
  });
  for (const cal of [calibrateMag(points), calibrateMagFull(points), calibrateMagWithValidation(points)]) {
    assert.ok(cal); assert.ok(parseMagCalibration(JSON.parse(JSON.stringify(cal))));
  }
});
console.log(`schema-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
