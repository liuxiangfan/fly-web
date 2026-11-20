/** 报告面板的具名动态入口：避免主包静态引入整个 tools-ui chunk。 */
export { mountReportPanel } from "./report-panel";
export type { ReportPanelApi, ReportPanelDeps } from "./report-panel";
