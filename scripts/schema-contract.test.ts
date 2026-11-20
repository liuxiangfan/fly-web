/** 档案/schema 与校准入口契约；独立计数，不改变历史 selftest 门禁。 */
import assert from "node:assert/strict";
import { parseArchive, buildArchive, type ArchiveRunInfo } from "../src/core/experiment-archive";
import { defaultExperimentConfig, parseMagCalibration, parseAccelCalibration, validateExperimentConfig, archiveExpressibilityProblems, archiveRoundTripProblems, cloneExperimentConfig, cloneMagCalibration, cloneAccelCalibration } from "../src/core/experiment-config";
import { copyCalibration } from "../src/core/calibration-validation";
import { calibrateAccel, synthesizeAccelSamples, type AccelCalibration } from "../src/core/accelcal";
import { applyMagCalibration, calibrateMag, calibrateMagFull, calibrateMagWithValidation } from "../src/core/magcal";
import { DEG, type V3 } from "../src/core/quat";
import { IMU_EXPORT_COLUMNS, serializeAttitudeCsv, serializeRawImuCsv, type LogRow } from "../src/core/csv-export";
import { parseImuCsv } from "../src/core/replay";

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

test("canonical form：默认配置 buildArchive→JSON→parse→再导出 达到逐字节等价", () => {
  // 唯一的规范形态：默认配置自己必须满足「导出→导入→再导出」不变。
  // 复核反例：默认档案曾出现 pure.magEnabled false→true、kalmanResetCov 缺失→false、
  // magTargetUts 50→缺失——导入一次就悄悄换了一份配置。
  const cfg = defaultExperimentConfig();
  const arch = buildArchive(cfg, run);
  const wire = JSON.parse(JSON.stringify(arch)) as Record<string, any>;
  const p = parseArchive(wire);
  assert.equal(p.ok, true, p.ok ? "" : `默认档案被自家解析器拒绝：${p.error}`);
  if (!p.ok) return;
  // ① 解析结果与默认配置深等价（含可选字段的「有/无」形态）
  assert.deepEqual(p.config, cfg, "解析后的配置必须与默认配置深等价");
  // ② 再导出逐字节一致（键顺序也一致：JSON.stringify 保留插入顺序）
  const again = JSON.parse(JSON.stringify(buildArchive(p.config, run)));
  assert.equal(JSON.stringify(again), JSON.stringify(wire), "导出→导入→再导出必须逐字节等价");
  // ③ 可选字段的显式形态：缺一个导入后就会变成默认值，往返就不再等价
  assert.equal(cfg.estimators.pure.magEnabled, false, "纯积分没有磁观测，默认必须是 false");
  assert.equal(cfg.estimators.kalman.kalmanResetCov, false, "kalmanResetCov 必须显式存在");
  assert.equal(cfg.magTargetUts, 50, "magTargetUts 必须显式存在");
  assert.equal(cfg.autoCoarseAlign, true);
  assert.equal(cfg.steadyFromSec, null);
  // ④ 校准 kind / matrix / 目标场强同构：diag 不得带 matrix，full 必须带 matrix
  const diagCfg = defaultExperimentConfig();
  diagCfg.magCalibration = { offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 20, kind: "diag" };
  diagCfg.magModel = "diag";
  const fullCfg = defaultExperimentConfig();
  fullCfg.magCalibration = { offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 20, kind: "full", matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  fullCfg.magModel = "full";
  for (const c of [diagCfg, fullCfg]) {
    const w = JSON.parse(JSON.stringify(buildArchive(c, run)));
    const r = parseArchive(w);
    assert.equal(r.ok, true, r.ok ? "" : `${c.magModel} 档案被拒：${r.error}`);
    if (r.ok) {
      assert.deepEqual(r.config, c);
      assert.equal(JSON.stringify(JSON.parse(JSON.stringify(buildArchive(r.config, run)))), JSON.stringify(w));
    }
  }
});
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
  // schema 层只守内核物理范围 [10,1000] Hz；「UI 下拉能否表达」在界面层判定（见下一条）
  reject(a => { a.config.solveRateHz = 5000; }, "solveRateHz");
  reject(a => { a.config.solveRateHz = 0; }, "solveRateHz");
  reject(a => { a.config.solveRateHz = 200.5; }, "solveRateHz");
  reject(a => { a.config.manualTargetDeg = [999, 0, 0]; }, "manualTargetDeg");
  reject(a => { a.restore = "full"; }, "restore");
});

test("内核频率与 UI 档位分层：200 Hz 内核可跑，界面层才拒绝非下拉档位", () => {
  // 内核能力：runner 的 200 Hz 在 500 Hz 仿真下正确（3/2 交替），schema 不该把它当非法值
  const a = archive(); a.config.solveRateHz = 200;
  const p = parseArchive(a);
  assert.equal(p.ok, true, p.ok ? "" : `200 Hz 属内核范围，不该被 schema 拒绝：${p.error}`);
  if (p.ok) {
    assert.equal(p.config.solveRateHz, 200);
    // 界面层：200 Hz 不在下拉档位里 → 必须由可表达性检查指出，导入不可静默夹成 500
    const probs = archiveExpressibilityProblems(p.config);
    assert.ok(probs.some((q) => q.path === "solveRateHz"), `界面层必须指出 200 Hz：${JSON.stringify(probs)}`);
  }
  // 走 UI 导入事务的坏档案（333 Hz）由同一把尺子拦下，而不是靠 schema 层
  const bad = archive(); bad.config.solveRateHz = 333;
  const pb = parseArchive(bad);
  assert.equal(pb.ok, true, "schema 层不应以 UI 档位为准");
  if (pb.ok) assert.ok(archiveExpressibilityProblems(pb.config).some((q) => q.path === "solveRateHz"));
  // 下拉档位自身永远合法
  for (const hz of [50, 100, 125, 250, 500]) {
    const c = defaultExperimentConfig(); c.solveRateHz = hz;
    assert.deepEqual(archiveExpressibilityProblems(c).filter((q) => q.path === "solveRateHz"), []);
  }
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

test("往返比较指出会被界面改写/丢失的字段（durationSec 除外）", () => {
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
  // 只有 durationSec 是「本次已跑时长」，不参与往返比较
  want.durationSec = 12.5; got.durationSec = 30;
  assert.deepEqual(archiveRoundTripProblems(want, got), []);
  // steadyFromSec / autoCoarseAlign 会改变 RMSE 与姿态，必须是真字段：丢失/被改写要报出来
  want.steadyFromSec = 4; got.steadyFromSec = undefined;
  want.autoCoarseAlign = false; got.autoCoarseAlign = true;
  const probs = archiveRoundTripProblems(want, got);
  assert.ok(probs.some((p) => p.path === "steadyFromSec"), `steadyFromSec 必须参与往返：${JSON.stringify(probs)}`);
  assert.ok(probs.some((p) => p.path === "autoCoarseAlign"), `autoCoarseAlign 必须参与往返：${JSON.stringify(probs)}`);
  got.steadyFromSec = 4; got.autoCoarseAlign = false;
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
/**
 * SW-04：schema、克隆、规范化与实际被消费的字段必须一致。
 *
 * 复核反例（都已在本机跑过）：
 *  · `estimators.extension = null` 通过 schema（只校验五个已知算法），却在克隆时读 `null.params` 抛 TypeError；
 *  · `params.unknownKernelParam = 3` 被 schema 放行、被规范化保留，但估计器只读 alpha ——
 *    "解析成功、运行无视、读回比较失败"三件事同时发生；
 *  · 缺 `kind` 的 full 磁模型第一次复制得到 `…count,matrix,kind`、第二次变成 `…count,kind,matrix`，
 *    导出字节首轮就不稳定（规范形本该幂等）。
 */
test("SW-04 未知 estimator 容器键：受控结果，不得抛异常（null / 对象 / 数组）", () => {
  for (const bad of [null, {}, [], 7, "x"]) {
    const a = archive();
    a.config.estimators.extension = bad;
    let parsed: ReturnType<typeof parseArchive>;
    assert.doesNotThrow(() => { parsed = parseArchive(a); }, `estimators.extension=${JSON.stringify(bad)} 不得抛异常`);
    assert.equal(parsed!.ok, false, `未知算法 id 必须被拒绝：${JSON.stringify(bad)}`);
    if (!parsed!.ok) assert.ok(parsed!.error.includes("estimators.extension"), `错误须含字段路径：${parsed!.error}`);
  }
});

test("SW-04 未知参数键：当前 schema 拒绝；旧 schema 迁移改为 notes 且不落盘", () => {
  const strictCase = archive();
  strictCase.config.estimators.comp.params.unknownKernelParam = 3;
  const rejected = parseArchive(strictCase);
  assert.equal(rejected.ok, false, "当前 schema 的未知参数键必须拒绝");
  if (!rejected.ok) assert.ok(rejected.error.includes("estimators.comp.params.unknownKernelParam"), rejected.error);

  const legacy = archive();
  legacy.config = { schemaVersion: 2, seed: 7, durationSec: 5, estimators: { comp: { params: { alpha: 2, unknownKernelParam: 3 } } } };
  const migrated = parseArchive(legacy);
  assert.equal(migrated.ok, true, migrated.ok ? "" : migrated.error);
  if (migrated.ok) {
    assert.ok(migrated.notes.some((n) => n.includes("unknownKernelParam")), `迁移必须把被丢弃的键写进 notes：${JSON.stringify(migrated.notes)}`);
    assert.equal("unknownKernelParam" in migrated.config.estimators.comp.params, false, "迁移结果不得留下内核不读的参数");
    assert.equal(migrated.config.estimators.comp.params.alpha, 2, "认识的参数仍要迁移过去");
  }
});

test("SW-04 磁校准键序：缺省 kind 的 full 模型首次复制即字节稳定", () => {
  const withoutKind = { offset: [0, 0, 0], scale: [1, 1, 1], field: 50, residual: 0, count: 20, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const once = copyCalibration("mag", withoutKind as unknown as Record<string, unknown>);
  const twice = copyCalibration("mag", once as unknown as Record<string, unknown>);
  assert.equal(JSON.stringify(once), JSON.stringify(twice), "复制必须幂等（键序不能因补默认值而变）");
  assert.equal(once.kind, "full", "带 matrix 的模型必须补成 full");
  assert.deepEqual(Object.keys(once), ["offset", "scale", "field", "residual", "count", "kind", "matrix"], "键序必须固定");

  // 导出→导入→再导出在首轮就必须逐字节稳定，并且与显式 kind 的档案收敛到同一份配置
  const run = { elapsedSec: 1, dataSource: "模拟", reference: "groundTruth", finishedAtIso: "2026-11-05T00:00:00.000Z", metrics: [{ id: "mahony", n: 1, mean: 1, rmse: 1, max: 1, convergedAt: 1 }] };
  const implicit = archive();
  implicit.config.magCalibration = { ...withoutKind } as unknown as typeof implicit.config.magCalibration;
  implicit.config.magModel = "full";
  const explicit = archive();
  explicit.config.magCalibration = { ...withoutKind, kind: "full" } as unknown as typeof explicit.config.magCalibration;
  explicit.config.magModel = "full";
  const a = parseArchive(implicit), b = parseArchive(explicit);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(buildArchive(a.config, run)), JSON.stringify(buildArchive(b.config, run)), "省略 kind 与显式 kind 必须收敛到同一规范形");
  const one = JSON.stringify(buildArchive(a.config, run));
  const again = parseArchive(JSON.parse(one));
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(JSON.stringify(buildArchive(again.config, run)), one, "再导出必须逐字节一致");
});

test("SW-04 克隆是全函数：缺条目 / 多余键 / 空 params 都不抛异常且补齐默认", () => {
  const base = defaultExperimentConfig();
  const broken = { ...base, estimators: { comp: { ...base.estimators.comp, params: undefined as unknown as Record<string, number> }, extension: null } } as unknown as typeof base;
  const tryClone = (c: typeof base): typeof base | null => { try { return cloneExperimentConfig(c); } catch { return null; } };
  const cloned = tryClone(broken);
  assert.ok(cloned, "克隆不得抛异常");
  if (!cloned) return;
  for (const id of ["pure", "comp", "mahony", "madg", "kalman"] as const) {
    assert.ok(cloned.estimators[id], `克隆必须补齐 ${id}`);
  }
  assert.deepEqual(Object.keys(cloned.estimators), ["pure", "comp", "mahony", "madg", "kalman"], "克隆只保留已知算法 id");
  // 空 params 也不能把克隆带崩，而且必须补回默认参数（否则内核读到 undefined）
  assert.deepEqual(cloned.estimators.comp.params, defaultExperimentConfig().estimators.comp.params);
});

test("校准快照共用克隆：未知键、缺省 kind、可选字段存在性与嵌套隔离不变", () => {
  const fittedWith = { at: "2026-11-06", crossAxis: 0, nonlin: 0, noise: 0.1, extension: "保留" };
  const sourceMag = {
    ...mag,
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    validation: {
      residual: 0.1, count: 30, maxErrUt: 2, ratio: null,
      late: { residual: 0.2, count: 10, maxErrUt: 3, ratio: null, extension: "后段扩展" },
      extension: "验证扩展",
    },
    fittedWith,
    extension: "模型扩展",
  };
  delete (sourceMag as Partial<typeof sourceMag>).kind;
  const sourceAccel = {
    ...accel,
    validation: { meanNormErrMs2: 0.1, maxNormErrMs2: 0.2, heldOutFaces: 6, extension: "验证扩展" },
    fittedWith,
    extension: "模型扩展",
  };
  const cfg = defaultExperimentConfig();
  cfg.magCalibration = sourceMag as any;
  cfg.accelCalibration = sourceAccel;
  const snapshot = cloneExperimentConfig(cfg);
  const copyMag = cloneMagCalibration(cfg.magCalibration!) as unknown as typeof sourceMag;
  const copyAccel = cloneAccelCalibration(sourceAccel) as typeof sourceAccel;
  assert.deepEqual(copyMag, sourceMag);
  assert.deepEqual(copyAccel, sourceAccel);
  assert.equal(JSON.stringify(snapshot.magCalibration), JSON.stringify(copyMag));
  assert.equal(JSON.stringify(snapshot.accelCalibration), JSON.stringify(copyAccel));
  assert.equal(Object.prototype.hasOwnProperty.call(copyMag, "kind"), false, "克隆不得补缺省 kind");
  for (const key of ["offset", "scale", "matrix", "validation", "fittedWith"] as const) assert.notEqual(copyMag[key], sourceMag[key]);
  assert.notEqual(copyMag.validation.late, sourceMag.validation.late);
  for (const key of ["M", "bias", "rmse", "faces", "validation", "fittedWith"] as const) assert.notEqual(copyAccel[key], sourceAccel[key]);
  copyMag.offset[0] = 99;
  copyMag.validation.late.residual = 99;
  copyMag.fittedWith.noise = 99;
  copyAccel.M[0] = 99;
  copyAccel.faces[0] = "-x";
  assert.equal(sourceMag.offset[0], 1);
  assert.equal(sourceMag.validation.late.residual, 0.2);
  assert.equal(fittedWith.noise, 0.1);
  assert.equal(sourceAccel.M[0], 1.02);
  assert.equal(sourceAccel.faces[0], "+x");
  for (const optional of [{}, { validation: undefined, fittedWith: undefined }, { validation: null, fittedWith: null }]) {
    const input = { ...mag, ...optional } as any;
    const copy = cloneMagCalibration(input);
    assert.deepEqual(copy, input);
    assert.deepEqual(Object.keys(copy), Object.keys(input));
  }
});

test("CSV 快照序列化：三种参考与全部列开关保持旧格式逐字节等价", () => {
  const ids = ["pure", "comp", "mahony", "madg", "kalman"];
  const imu = { gyro: [0.1, -0.2, 0.3] as V3, accel: [1, 2, 9.81] as V3, mag: [30, 4, 50] as V3 };
  const row: LogRow = {
    t: 0.04, euler: Array.from({ length: 6 }, (_, i) => [i - 180, i * 12.3, -i]),
    err: [0.2, 0.3, NaN, Infinity, -Infinity],
    quats: ids.map((_, i) => ({ w: 0.8, x: i * 0.1, y: -0.2, z: 0.3 })),
    qTrue: { w: 1, x: 0, y: 0, z: 0 }, imu,
    imuConsumed: { ...imu, mag: [25, 3, 49] }, consumedSolveT: 0.039, sourceCalibrated: false,
  };
  const rows = [row, { ...row, t: 0.08, imu: null, imuConsumed: null, sourceCalibrated: true }];
  // 旧 main.ts 的列序与逐行格式冻结在测试侧；不得与被测 helper 共用构造逻辑。
  for (const ref of ["groundTruth", "external", "mahony"] as const) {
    const refLabel = ref === "groundTruth" ? "truth" : ref === "external" ? "external_ref" : "mahony_ref";
    for (const quatOn of [false, true]) for (const imuOn of [false, true]) for (const consumed of [false, true]) {
      for (const meta of [[], ["# quaternion-attitude-demo export", "# imu=calibrated", "# imu_note=记录时刻快照，不随后续改标定变化"]]) {
        for (const input of [[], rows]) {
          const header = [
            "t_s",
            ...[0, 1, 2].map((k) => `${refLabel}_${["roll", "pitch", "yaw"][k]}_deg`),
            ...ids.flatMap((id) => [0, 1, 2].map((k) => `${id}_${["roll", "pitch", "yaw"][k]}_deg`)),
            ...ids.map((id) => `err_${id}_deg`),
            ...(quatOn ? ids.flatMap((id) => ["w", "x", "y", "z"].map((k) => `${id}_q${k}`)) : []),
            ...(quatOn ? ["w", "x", "y", "z"].map((k) => `${refLabel}_q${k}`) : []),
            ...(imuOn ? IMU_EXPORT_COLUMNS : []),
          ];
          const lines = [header.join(",")];
          for (const r of input) {
            const values = [r.t];
            for (const e of r.euler) values.push(e[0], e[1], e[2]);
            values.push(...r.err);
            if (quatOn) {
              for (const q of r.quats) values.push(q.w, q.x, q.y, q.z);
              values.push(r.qTrue.w, r.qTrue.x, r.qTrue.y, r.qTrue.z);
            }
            if (imuOn) {
              const sample = consumed ? r.imuConsumed : r.imu;
              values.push(...(sample ? [...sample.gyro.map((v) => v * DEG), ...sample.accel, ...sample.mag] : new Array<number>(9).fill(NaN)));
            }
            lines.push(values.map((v) => Number.isFinite(v) ? v.toFixed(6) : "").join(","));
          }
          assert.equal(serializeAttitudeCsv(input, ids, ref, quatOn, imuOn, consumed, meta), `\ufeff${meta.join("\n")}\n${lines.join("\n")}\n`);
        }
      }
    }
  }
});

test("CSV 纯函数：源与消费快照、四元数、列开关与元数据不修改入参", () => {
  const imu = { gyro: [0.1, 0.2, 0.3] as V3, accel: [0, 0, 9.81] as V3, mag: [30, 0, 50] as V3 };
  const rows: LogRow[] = [{
    t: 0.04, euler: [[1, 2, 3], [4, 5, 6]], err: [NaN],
    quats: [{ w: -1, x: 0, y: 0, z: 0 }], qTrue: { w: 1, x: 0, y: 0, z: 0 },
    imu, imuConsumed: { ...imu, mag: [25, 0, 50] }, consumedSolveT: 0.039, sourceCalibrated: true,
  }];
  const rawRows = [{ t: 0.04, ...imu }], ids = ["mahony"], meta = ["# imu=calibrated"];
  const before = structuredClone({ rows, rawRows, ids, meta });
  const source = serializeAttitudeCsv(rows, ids, "external", true, true, false, meta);
  const consumed = serializeAttitudeCsv(rows, ids, "external", true, true, true, meta);
  serializeRawImuCsv(rawRows, meta);
  assert.notEqual(source, consumed, "源读数与记录时刻消费读数必须可区分");
  assert.ok(source.includes("-1.000000"), "q/−q 必须原样序列化，不从欧拉角重算");
  assert.deepEqual({ rows, rawRows, ids, meta }, before);
});

test("全帧 CSV：十列、六位小数/BOM/末尾换行与回放校准语义兼容", () => {
  const columns = ["gyro_x_dps", "gyro_y_dps", "gyro_z_dps", "accel_x_ms2", "accel_y_ms2", "accel_z_ms2", "mag_x_ut", "mag_y_ut", "mag_z_ut"];
  assert.deepEqual(IMU_EXPORT_COLUMNS, columns);
  const rows = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.002, gyro: [0.1, -0.2, 0.3] as V3, accel: [0, 0, 9.81] as V3, mag: [25, 3, 49] as V3 }));
  for (const calibrated of [false, true]) {
    const meta = [`# imu=${calibrated ? "calibrated" : "raw"}`];
    const lines = [["t_s", ...columns].join(","), ...rows.map((r) => [r.t, ...r.gyro.map((v) => v * DEG), ...r.accel, ...r.mag].map((v) => v.toFixed(6)).join(","))];
    const csv = serializeRawImuCsv(rows, meta);
    assert.equal(csv, `\ufeff${meta.join("\n")}\n${lines.join("\n")}\n`);
    const parsed = parseImuCsv(csv);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.frames.length, rows.length);
    assert.equal(parsed.imuCalibrated, calibrated, "calibrated 日志必须保持禁止二次校准的标注");
    assert.ok(Math.abs(parsed.frames[0].gyroDps[0] / DEG - rows[0].gyro[0]) < 1e-8, "CSV 的度每秒回放后须可还原 rad/s");
    assert.deepEqual(parsed.frames[0].accelMs2, rows[0].accel);
    assert.deepEqual(parsed.frames[0].magUt, rows[0].mag);
  }
});

console.log(`schema-contract: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
