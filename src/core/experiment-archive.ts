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
  experimentConfigProblems,
  cloneExperimentConfig,
  canonicalizeExperimentConfig,
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
    /**
     * 无样本（n=0）时必须是 null：既不能声称一个 0 统计量，也不能写 NaN——
     * `JSON.stringify` 会把 NaN 变成 null，于是「刚复位就导出」的档案会被自家解析器
     * 以 `run.metrics[0].mean 须为非负有限数` 拒绝（复核反例）。
     */
    mean: number | null;
    rmse: number | null;
    max: number | null;
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

/**
 * 构造档案对象（纯函数：调用方负责提供配置与运行信息）。
 * 配置先过 `canonicalizeExperimentConfig`：导出即规范形，`导出 → 导入 → 再导出` 逐字节稳定。
 */
export function buildArchive(config: ExperimentConfig, run: ArchiveRunInfo): ExperimentArchive {
  return { schema: ARCHIVE_SCHEMA, kind: ARCHIVE_KIND, restore: "config-only", config: canonicalizeExperimentConfig(config), run };
}

/** run 也属于不可信档案输入：声明了就完整校验，返回具体字段路径。 */
function runProblem(raw: unknown): string | null {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!obj(raw)) return "run 须为对象";
  if (!num(raw.elapsedSec)) return "run.elapsedSec 须为非负有限数";
  if (typeof raw.dataSource !== "string" || !raw.dataSource) return "run.dataSource 须为非空字符串";
  if (!["groundTruth", "mahony", "external", "none"].includes(raw.reference as string)) return "run.reference 未知误差参考";
  if (typeof raw.finishedAtIso !== "string" || !raw.finishedAtIso || !Number.isFinite(Date.parse(raw.finishedAtIso))) return "run.finishedAtIso 须为合法时间字符串";
  if (!Array.isArray(raw.metrics)) return "run.metrics 须为数组";
  for (let i = 0; i < raw.metrics.length; i++) {
    const m = raw.metrics[i], p = `run.metrics[${i}]`;
    if (!obj(m)) return `${p} 须为对象`;
    if (typeof m.id !== "string" || !m.id) return `${p}.id 须为非空字符串`;
    if (!num(m.n) || !Number.isInteger(m.n)) return `${p}.n 须为非负整数`;
    // n=0（还没有样本）时统计量只能是 null；n>0 时必须是非负有限数。
    // 两种情况分开判，避免「NaN 序列化成 null 后恰好通过」这种假合法。
    if (m.n === 0) {
      for (const k of ["mean", "rmse", "max"]) {
        if (m[k] !== null) return `${p}.${k} 在 n=0 时必须为 null（无样本不得声称统计量）`;
      }
    } else {
      for (const k of ["mean", "rmse", "max"]) if (!num(m[k])) return `${p}.${k} 须为非负有限数`;
    }
    if (m.convergedAt !== null && !num(m.convergedAt)) return `${p}.convergedAt 须为非负有限数或 null`;
  }
  return null;
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
  // restore 是**能力声明**，不是装饰字段：本页只能还原配置（不还原时刻/曲线/A-B 分叉）。
  // 旧实现不校验它，于是 restore:"full" 的档案也返回 ok:true——用户以为整个现场都恢复了。
  if (o.restore !== "config-only") {
    return { ok: false, error: '档案 restore 须为 "config-only"（本页只还原配置，不还原当前时刻/曲线；逐帧复现请用全帧 IMU CSV）' };
  }
  // 原始结构先验（ROUND11 P1）：旧实现直接调用宽松迁移，于是「durationSec 是字符串」
  // 「initialAttitude.axis 里是字符串」这类坏输入被静默修好并以 ok=true 返回，
  // 用户看到的是"成功恢复同一配置"。现在当前 schema 的档案按字段类型严格验，
  // 未来版本直接拒绝，旧版本才允许迁移（但把被修正的字段记进 notes）。
  if (o.config === null || typeof o.config !== "object" || Array.isArray(o.config)) {
    return { ok: false, error: "档案缺少 config 对象（不是对象或为数组）" };
  }
  const rawCfg = o.config as unknown as Record<string, unknown>;
  const version = rawCfg.schemaVersion;
  if (version !== undefined && (typeof version !== "number" || !Number.isFinite(version) || !Number.isInteger(version) || version < 1)) {
    return { ok: false, error: "schemaVersion 非法：须为支持的正整数版本" };
  }
  const declaredVersion = version as number | undefined;
  if (declaredVersion !== undefined && declaredVersion > EXPERIMENT_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion v${declaredVersion} 来自更新版本（支持到 v${EXPERIMENT_SCHEMA_VERSION}）——请升级页面` };
  }
  const strict = declaredVersion === EXPERIMENT_SCHEMA_VERSION;
  const problems = experimentConfigProblems(rawCfg, strict);
  if (strict && problems.length) return { ok: false, error: `档案配置不合法：${problems[0].path} ${problems[0].message}` };
  // v3 直接复制已经验证的原始配置，不经过 migration 补默认值。
  const config = strict ? cloneExperimentConfig(rawCfg as unknown as ExperimentConfig) : migrateExperimentConfig(rawCfg);
  const notes: string[] = [];
  if (!strict) {
    for (const p of problems) notes.push(`旧版字段已迁移/修正：${p.path} ${p.message}`);
    notes.push(declaredVersion !== undefined ? `档案 schema v${declaredVersion} → 已迁移到 v${EXPERIMENT_SCHEMA_VERSION}` : `档案未声明 schemaVersion → 旧版迁移到 v${EXPERIMENT_SCHEMA_VERSION}`);
    if (rawCfg.magCalibration != null && config.magCalibration === null) notes.push("磁校准模型不可用，已丢弃");
    if (rawCfg.accelCalibration != null && !config.accelCalibration) notes.push("加计校准模型不可用，已丢弃");
    const migratedProblems = experimentConfigProblems(config);
    if (migratedProblems.length) return { ok: false, error: `迁移后的档案配置不合法：${migratedProblems[0].path} ${migratedProblems[0].message}` };
  }
  const runError = o.run == null ? null : runProblem(o.run);
  if (runError) return { ok: false, error: `档案运行信息不合法：${runError}` };
  const run = o.run == null ? null : { ...o.run, metrics: o.run.metrics.map(m => ({ ...m })) };

  // 两条路径都收敛到**规范形**：任何合法档案只有一种表示，
  // 于是「导出 → 导入 → 再导出」逐字节稳定（含可选字段补齐与键顺序）。
  const canonical = canonicalizeExperimentConfig(config);
  return { ok: true, config: canonical, run, ...(strict ? {} : { migratedFrom: declaredVersion ?? undefined }), notes };
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
