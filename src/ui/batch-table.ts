/**
 * 批量评测表格与状态文案（纯格式化，无 DOM 依赖）。
 *
 * 抽出来的动机：这批字符串曾经埋在 main.ts 的 `batchRowsHtml` 里，
 * 与「跑评测」的调度逻辑混在一个文件里；现在它是纯函数，可以在 Node 里直接断言
 * 「7 列口径、SO(3) 指标、稳态窗口措辞」是否符合文档承诺。
 */
import type { BatchEstimatorSummary } from "../core/runner";

/** 表格行需要的展示信息（调用方从颜色/标签表里取） */
export interface BatchRowStyle {
  id: string;
  label: string;
  color: string;
  /** 参考行（真实数据源下的 Mahony 基准行）加高亮 */
  isRef?: boolean;
}

const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : "—");

/** 批量结果表体 HTML（7 列：RMSE P50/P95、稳态 P95、未收敛、SO(3) 倾角/偏航 P95） */
export function batchRowsHtml(summary: BatchEstimatorSummary[], styles: BatchRowStyle[]): string {
  return summary
    .map((s) => {
      const st = styles.find((x) => x.id === s.id);
      const color = st?.color ?? "#e6edf3";
      const label = st?.label ?? s.label;
      return (
        `<tr${st?.isRef ? ' class="ref"' : ""}>` +
        `<td><span class="m-dot" style="background:${color}"></span>${label}</td>` +
        `<td>${fmt(s.rmseP50)}°</td><td>${fmt(s.rmseP95)}°</td><td>${fmt(s.steadyRmseP95)}°</td>` +
        `<td>${fmt(s.nonConvergedPct, 0)}%</td>` +
        `<td>${fmt(s.tiltSo3P95 ?? s.tiltRmseP95)}°</td><td>${fmt(s.yawSo3P95 ?? s.yawRmseP95)}°</td></tr>`
      );
    })
    .join("");
}

/** 完成后的状态行文案（把统计口径写在用户眼前，而不是只写在文档里） */
export function batchStatusText(args: {
  count: number;
  durationSec: number;
  baseSeed: number;
  lastSeed: number;
  steadyFromSec?: number | null;
  mode: "worker" | "main";
  /** 有心跳/长跑进入近似口径时，状态行必须说清楚（否则用户以为 P95 是精确值） */
  approximate?: boolean;
}): string {
  const steady = args.steadyFromSec != null ? `从 ${args.steadyFromSec} s 起` : "末段 40%";
  return (
    `完成：${args.count} 个种子 × ${args.durationSec} s（seed ${args.baseSeed} → ${args.lastSeed}）· ` +
    `P50/P95 为跨种子分布；稳态 = 每次运行${steady}（* 倾角/偏航为 SO(3) 小角分解，不受欧拉奇点影响）；` +
    `未收敛率 = 单次 ${args.durationSec} s 内未连续 1 s 总误差 <2° 的比例` +
    (args.approximate
      ? "；⚠ 有运行超过 6 万样本：分位数改用定长蓄水池（等概率抽样）、稳态窗口仍按预定切点精确累计"
      : "；统计口径：精确（逐样本）") +
    (args.mode === "worker"
      ? "；本批在 Web Worker 中执行（评测期间界面不卡）"
      : "；本批在主线程分片执行（Worker 不可用时的回退路径）")
  );
}
