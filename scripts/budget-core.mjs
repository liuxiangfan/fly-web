/**
 * 产物预算的**判定核心**（SW-09）：纯函数，与"怎么测量"分开。
 *
 * 为什么要拆出来：旧实现把判定写在 CLI 的循环里，契约测试只能去匹配源码字符串
 * （`assert.match(src, /m\.value <= m\.limit \* \(1 - MIN_MARGIN\)/)`）——那种测试
 * **证明的是"代码里有这句话"，不是"边界值判得对"**。这里给出可测的判定：
 * 恰好落在有效门槛上算过、再多 1 字节算不过、以及与冻结基线的增量。
 *
 * 口径（三个数必须同时被看到，否则"余量"会被读成"已经减了传输量"）：
 *   · 名义上限 `limit`：政策里写的数字；
 *   · 有效门槛 `effectiveLimit = limit × (1 − margin)`：真正不能越过的线；
 *   · 剩余字节 `remaining = effectiveLimit − value`：距离判红还有多少。
 */

/** 余量要求：占用率必须 ≤ 90%（= 至少 10% 余量）。 */
export const MIN_MARGIN = 0.1;

const fmt = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * 单项判定。`count` 为计数型指标（如字体文件数）：百分比余量对它没有工程含义，只查名义上限。
 * `baseline` 是冻结基线的实测值（同一指标、同一口径），用于报告"相对基线增了多少"。
 */
export function budgetVerdict({ value, limit, margin = MIN_MARGIN, count = false, baseline = null }) {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, valid: false, reason: `数值非法（value=${value}，limit=${limit}）` };
  }
  const withinLimit = value <= limit;
  // 有效门槛向下取整：这样"恰好等于门槛"算过、门槛 +1 字节算不过（边界必须是确定的整数）
  const effectiveLimit = count ? limit : Math.floor(limit * (1 - margin));
  const headroomOk = count ? true : value <= effectiveLimit;
  const ok = withinLimit && headroomOk;
  return {
    ok,
    valid: true,
    count,
    value,
    limit,
    effectiveLimit,
    withinLimit,
    headroomOk,
    occupancy: value / limit,
    marginPct: 1 - value / limit,
    /** 距离有效门槛还剩多少字节（负数 = 已经越过有效门槛） */
    remaining: effectiveLimit - value,
    /** 距离名义上限还剩多少字节 */
    limitRemaining: limit - value,
    deltaVsBaseline: baseline === null ? null : value - baseline,
    reason: ok
      ? null
      : !withinLimit
        ? `超出名义上限 ${fmt(value - limit)}`
        : `有效门槛内只剩 ${fmt(value - effectiveLimit)}（要求余量 ≥${(margin * 100).toFixed(0)}%，即不得超过 ${fmt(effectiveLimit)}）`,
  };
}

/**
 * 修复提示：**只给减重方向，不给"抬上限"**。
 * 旧提示把"把上限抬到 X KB"写在第一条，等于把预算当橡皮筋（复核点名的正是这句）。
 */
export function reductionHint(verdict) {
  if (verdict?.ok !== false || verdict.valid === false) return null;
  if (!verdict.withinLimit) return `先减重：至少降 ${fmt(verdict.value - verdict.limit)} 才回到名义上限内（抬上限不算修复）`;
  return `先减重：至少降 ${fmt(verdict.value - verdict.effectiveLimit + 1)} 才回到有效门槛内（抬上限不算修复）`;
}

/** 基线增量文案：`Δ vs 冻结基线 +11.0 KB`。 */
export function baselineText(verdict) {
  if (verdict?.deltaVsBaseline === null || verdict?.deltaVsBaseline === undefined) return "Δ 基线：无记录";
  const d = verdict.deltaVsBaseline;
  return `Δ 冻结基线 ${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))}`;
}

/** 一行报告：名义上限 / 有效门槛 / 占用 / 剩余 / 基线增量。 */
export function verdictLine(name, verdict) {
  if (verdict.valid === false) return `[FAIL] ${name} — ${verdict.reason}`;
  const unit = verdict.count ? "个" : "KB";
  const value = verdict.count ? `${verdict.value} 个` : fmt(verdict.value);
  const limit = verdict.count ? `${verdict.limit} 个` : fmt(verdict.limit);
  const head = `[${verdict.ok ? "PASS" : "FAIL"}] ${name} — ${value}（名义上限 ${limit}，占用 ${(verdict.occupancy * 100).toFixed(0)}%`;
  const tail = verdict.count
    ? `）`
    : `，有效门槛 ${fmt(verdict.effectiveLimit)}，剩余 ${fmt(verdict.remaining)}，${baselineText(verdict)}）`;
  const hint = reductionHint(verdict);
  return `${head}${tail}${hint ? ` —— ${hint}` : ""}${unit === "个" ? "" : ""}`;
}

/** 全部通过时的结论行：最紧的一项 + 总剩余。 */
export function headroomSummary(rows) {
  const bounded = rows.filter((r) => r.verdict.valid !== false && !r.verdict.count);
  if (!bounded.length) return "\n产物预算：没有可比项";
  const worst = bounded.reduce((a, b) => (a.verdict.occupancy > b.verdict.occupancy ? a : b));
  const tightest = bounded.reduce((a, b) => (a.verdict.remaining < b.verdict.remaining ? a : b));
  return `\n产物预算全部通过 ✅（每项占用率 ≤ ${((1 - MIN_MARGIN) * 100).toFixed(0)}%）` +
    `\n  占用最高：「${worst.name}」${(worst.verdict.occupancy * 100).toFixed(0)}%（剩余 ${fmt(worst.verdict.remaining)}，${baselineText(worst.verdict)}）` +
    `\n  余量最少：「${tightest.name}」剩 ${fmt(tightest.verdict.remaining)}`;
}
