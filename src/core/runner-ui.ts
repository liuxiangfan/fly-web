/** UI 按需使用的 runner 出口；避免把诊断/测试专用导出暴露为动态入口。 */
export {
  resultDigest,
  runExperiment,
  runExperimentAsync,
  runExperimentDetailedAsync,
  runMonteCarlo,
  runTrace,
  seedSequence,
  summarizeMetricsLists,
  summarizeRuns,
} from "./runner";
