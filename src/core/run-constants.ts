/**
 * 运行内核的固定时间基（UI 与 runner 共用）。
 *
 * 单独成文件的原因：`main.ts` 只需要这个常数，不应为了一个数字把整个
 * runner/estimators 静态拖进首屏。runner 继续从这里导入并对外重导出。
 */
export const RUN_HZ = 500;
export const RUN_H = 1 / RUN_HZ;

/** 精确统计上限：超过后分位数改用定长蓄水池（长跑内存封顶）。 */
export const STATS_CAP = 60_000;
/** 详细误差序列上限（交互诊断才保留完整序列）。 */
export const SERIES_CAP = 200_000;
