/**
 * 实验档案（配置复现）的纯逻辑：构造与解析。
 *
 * 从 main.ts 抽出来的动机：档案的**格式与校验规则**是可被 Node 自检的纯逻辑，
 * 而 main.ts 里剩下的部分只该负责「把控件读成配置」与「把配置写回控件」。
 * 抽出来之后，「档案能不能被正确解析/拒绝」有了独立用例，而不是只能靠浏览器点一遍。
 *
 * 能力边界（写进文件里，避免二次误读）：`restore: "config-only"` 表示导入只还原配置，
 * **不还原**当前时刻、曲线、原始记录与 A/B 分叉状态；要逐帧复现请用「全帧原始 IMU」CSV 回放。
 */
import {
  EXPERIMENT_SCHEMA_VERSION,
  migrateExperimentConfig,
  parseAccelCalibration,
  parseMagCalibration,
  validateExperimentConfig,
  type ExperimentConfig,
} from "./experiment-config";

export const ARCHIVE_KIND = "quaternion-attitude-demo/archive";
export const ARCHIVE_SCHEMA = 1;

export interface ArchiveRunInfo {
  /** 实际运行时长（秒） */
  elapsedSec: number;
  /** 数据源可读名（模拟 / 真实 IMU / 离线回放） */
  dataSource: string;
  /** 误差参考类型（groundTruth / mahony / external / none） */
  reference: string;
  finishedAtIso: string;
  metrics: Array<{
    id: string;
    n: number;
    mean: number;
    rmse: number;
    max: number;
    convergedAt: number | null;
  }>;
}

export interface ExperimentArchive {
  schema: number;
  kind: string;
  restore: "config-only";
  config: ExperimentConfig;
  run: ArchiveRunInfo;
}

/** 构造档案对象（纯函数：调用方负责提供配置与运行信息） */
export function buildArchive(config: ExperimentConfig, run: ArchiveRunInfo): ExperimentArchive {
  return { schema: ARCHIVE_SCHEMA, kind: ARCHIVE_KIND, restore: "config-only", config, run };
}

/**
 * 原始配置的字段类型检查（只看"声明了但类型不对"的字段）。
 * 当前 schema 的档案出现任何一条都不再导入；旧版本降级为 notes（并已用默认值）。
 */
function configTypeProblems(cfg: Record<string, unknown>): string[] {
  const isObj = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);
  const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const isTriple = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNum);
  if (cfg.schemaVersion !== undefined && !isNum(cfg.schemaVersion)) {
    return [`schemaVersion 应为数值（实际 ${typeof cfg.schemaVersion}）`];
  }
  const checks: Array<[string, (v: unknown) => boolean, string]> = [
    ["seed", isNum, "数值"],
    ["durationSec", (v) => isNum(v) && (v as number) > 0, "正数"],
    ["solveRateHz", (v) => isNum(v) && (v as number) > 0, "正数"],
    ["magTargetUts", (v) => isNum(v) && (v as number) > 0, "正数"],
    ["scenario", (v) => typeof v === "string" && v.length > 0, "非空字符串"],
    ["magModel", (v) => v === "diag" || v === "full", "diag/full"],
    ["magCalibrationApplied", (v) => typeof v === "boolean", "布尔"],
    ["accelCalibrationApplied", (v) => typeof v === "boolean", "布尔"],
    ["autoCoarseAlign", (v) => typeof v === "boolean", "布尔"],
    ["manualTargetDeg", isTriple, "3 个有限数"],
    ["steadyFromSec", (v) => v === null || isNum(v), "数值或 null"],
    ["imu", isObj, "对象"],
    ["estimators", isObj, "对象"],
    ["initialAttitude", isObj, "对象"],
  ];
  const out: string[] = [];
  for (const [k, ok, want] of checks) {
    if (cfg[k] !== undefined && !ok(cfg[k])) out.push(`${k} 应为${want}（实际 ${typeof cfg[k]}）`);
  }
  const ia = cfg.initialAttitude as Record<string, unknown> | undefined;
  if (ia && isObj(ia)) {
    const kind = ia.kind;
    if (kind !== undefined && kind !== "level" && kind !== "fixed-axis" && kind !== "random") {
      out.push(`initialAttitude.kind 未知：${String(kind)}`);
    }
    if (ia.axis !== undefined && !isTriple(ia.axis)) out.push("initialAttitude.axis 应为 3 个有限数");
    if (ia.angleDeg !== undefined && !isNum(ia.angleDeg)) out.push("initialAttitude.angleDeg 应为数值");
  }
  // **递归**校验（ROUND12）：旧实现只看顶层已声明字段，于是 imu.gyroNoiseDps="oops"、
  // mahony.params.kp="oops"、空 imu/estimators 对象都会被静默补成默认值并 ok=true
  const imu = cfg.imu;
  if (imu !== undefined) {
    if (!isObj(imu)) out.push("imu 应为对象");
    else {
      for (const [k, v] of Object.entries(imu as Record<string, unknown>)) {
        if (!isNum(v)) out.push(`imu.${k} 应为数值（实际 ${typeof v}）`);
      }
    }
  }
  const ests = cfg.estimators;
  if (ests !== undefined) {
    if (!isObj(ests)) out.push("estimators 应为对象");
    else {
      for (const [id, t] of Object.entries(ests as Record<string, unknown>)) {
        if (!isObj(t)) {
          out.push(`estimators.${id} 应为对象`);
          continue;
        }
        const r = t as Record<string, unknown>;
        for (const k of ["enabled", "magEnabled", "accelGate", "gateRecovery", "rampEnabled"]) {
          if (r[k] !== undefined && typeof r[k] !== "boolean") out.push(`estimators.${id}.${k} 应为布尔`);
        }
        if (r.gateDeg !== undefined && !isNum(r.gateDeg)) out.push(`estimators.${id}.gateDeg 应为数值`);
        if (r.gateMagPct !== undefined && !isNum(r.gateMagPct)) out.push(`estimators.${id}.gateMagPct 应为数值`);
        if (r.magMode !== undefined && r.magMode !== "yaw" && r.magMode !== "full") {
          out.push(`estimators.${id}.magMode 未知：${String(r.magMode)}`);
        }
        if (r.params !== undefined) {
          if (!isObj(r.params)) out.push(`estimators.${id}.params 应为对象`);
          else {
            for (const [pk, pv] of Object.entries(r.params as Record<string, unknown>)) {
              if (!isNum(pv)) out.push(`estimators.${id}.params.${pk} 应为数值（实际 ${typeof pv}）`);
            }
          }
        }
      }
    }
  }
  return out;
}

export type ArchiveParse =
  | { ok: true; config: ExperimentConfig; run: ArchiveRunInfo | null; migratedFrom?: number; notes: string[] }
  | { ok: false; error: string };

/**
 * 解析并校验档案。两条路径**明确分流**（复核 P1-E）：
 *
 *  · `config.schemaVersion === 当前` 的档案按**严格**模式解析：声明了校准对象却解析不出可用模型
 *    （退化矩阵/字段缺失/被条件数拦下）→ 直接报错，而不是「静默丢掉模型 + ok:true」。
 *    否则用户看到「档案恢复成功」，实际校准没了、「应用校准」还亮着。
 *  · 更早的 schema 走迁移（在默认配置上覆盖已知字段），并把「丢了什么」记进 notes 返回，
 *    由调用方决定怎么提示——迁移要宽容，但不能无声。
 */
export function parseArchive(raw: unknown): ArchiveParse {
  if (!raw || typeof raw !== "object") return { ok: false, error: "档案不是 JSON 对象" };
  const o = raw as Partial<ExperimentArchive> & { config?: unknown };
  if (o.kind !== ARCHIVE_KIND || o.schema !== ARCHIVE_SCHEMA) {
    return { ok: false, error: `档案格式不识别（需要 schema=${ARCHIVE_SCHEMA} 的 ${ARCHIVE_KIND}）` };
  }
  // 原始结构先验（ROUND11 P1）：旧实现直接调用宽松迁移，于是「durationSec 是字符串」
  // 「initialAttitude.axis 里是字符串」这类坏输入被静默修好并以 ok=true 返回，
  // 用户看到的是"成功恢复同一配置"。现在当前 schema 的档案按字段类型严格验，
  // 未来版本直接拒绝，旧版本才允许迁移（但把被修正的字段记进 notes）。
  if (o.config === null || typeof o.config !== "object" || Array.isArray(o.config)) {
    return { ok: false, error: "档案缺少 config 对象（不是对象或为数组）" };
  }
  const rawCfg = o.config as unknown as Record<string, unknown>;
  const declaredVersion = typeof rawCfg.schemaVersion === "number" ? rawCfg.schemaVersion : null;
  if (declaredVersion !== null && declaredVersion > EXPERIMENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `档案来自更新的 schema v${declaredVersion}（本装置支持到 v${EXPERIMENT_SCHEMA_VERSION}）——请升级页面后再导入`,
    };
  }
  const strict = declaredVersion === EXPERIMENT_SCHEMA_VERSION;
  const typeProblems = configTypeProblems(rawCfg);
  if (strict) {
    // 当前 schema 的档案必须是**完整**配置：缺字段不再"补默认值当成功"（ROUND12）
    const required = ["seed", "scenario", "durationSec", "solveRateHz", "imu", "estimators", "initialAttitude"];
    const missing = required.filter((k) => rawCfg[k] === undefined);
    if (missing.length) return { ok: false, error: `档案缺少必需字段：${missing.join(", ")}` };
    if (typeProblems.length) return { ok: false, error: `档案字段类型不合法：${typeProblems[0]}` };
  }
  if (strict) {
    // 严格模式：校准字段只要"声明了"就必须解析成功
    if (rawCfg.magCalibration != null && parseMagCalibration(rawCfg.magCalibration) === null) {
      return { ok: false, error: "档案的磁校准模型不可用（奇异/镜像/条件数过大或字段缺失）——请在源端重新拟合并导出" };
    }
    if (rawCfg.accelCalibration != null && parseAccelCalibration(rawCfg.accelCalibration) === null) {
      return { ok: false, error: "档案的加计校准模型不可用（M 奇异/镜像/条件数过大或字段缺失）——请在源端重新拟合并导出" };
    }
  }
  const config = migrateExperimentConfig(o.config);
  const problems = validateExperimentConfig(config);
  if (problems.length) return { ok: false, error: `档案配置不合法：${problems[0].path} ${problems[0].message}` };
  const notes: string[] = [];
  if (!strict) {
    for (const p of typeProblems) notes.push(`字段类型不合法（已用默认值）：${p}`);
    notes.push(
      declaredVersion !== null
        ? `档案 schema v${declaredVersion} → 已迁移到 v${EXPERIMENT_SCHEMA_VERSION}`
        : `档案未声明 schemaVersion → 按当前 v${EXPERIMENT_SCHEMA_VERSION} 迁移`,
    );
    if (rawCfg && rawCfg.magCalibration != null && config.magCalibration === null) notes.push("磁校准模型不可用，已丢弃");
    if (rawCfg && rawCfg.accelCalibration != null && !config.accelCalibration) notes.push("加计校准模型不可用，已丢弃");
  }
  const run = o.run && typeof o.run === "object" && !Array.isArray(o.run) ? (o.run as ArchiveRunInfo) : null;
  return { ok: true, config, run, ...(strict ? {} : { migratedFrom: declaredVersion ?? undefined }), notes };
}

/** 档案里记录的运行信息 → 一句人类可读的补充说明（导入提示用） */
export function describeArchiveRun(run: ArchiveRunInfo | null): string {
  if (!run || typeof run !== "object") return "";
  // 元数据也是**不可信输入**（ROUND11 P1）：旧实现直接 elapsedSec.toFixed()，
  // 类型不对时会在配置已经应用之后抛错——界面提示失败、状态却已改变。
  const elapsed = Number(run.elapsedSec);
  const sec = Number.isFinite(elapsed) ? `${elapsed.toFixed(1)} s` : "未知时长";
  const src = typeof run.dataSource === "string" && run.dataSource ? run.dataSource : "未知来源";
  const ref = run.reference === "groundTruth" ? "模拟真值" : run.reference === "external" ? "外部真值" : "Mahony 基准";
  return `；档案记录的是 ${sec} / ${src}（${ref}）`;
}
