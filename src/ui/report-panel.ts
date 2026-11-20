/**
 * 只读实验报告面板：生成 → 查看 → 导出 JSON / 打印；或导入 JSON 只读查看。
 *
 * 只读是**结构性**保证：deps 里只有读取器（archive/build/events/comparison），
 * 没有任何「应用配置 / 重跑 / 改状态」入口，导入路径物理上无法触碰运行现场。
 *
 * 打印与文档打印共存：既有 @media print 规则会隐藏 #app-main 并强制显示文档层，
 * 所以打印报告时把视图克隆到顶层 #report-print-root，并给 body 打 data-print="report"
 * ——只有这个标记存在时才隐藏文档层、显示报告根，不影响既有文档打印用例。
 */
import {
  buildExperimentReport,
  serializeExperimentReport,
  validateExperimentReport,
  type ExperimentReport,
  type ReportBuildInfo,
} from "../core/experiment-report";
import type { ExperimentArchive } from "../core/experiment-archive";
import type { ComparisonReport } from "../core/comparison-report";
import type { LearningEvent } from "../core/event-timeline";

/** 事件表最多渲染的行数（完整数据始终在导出的 JSON 里，不在 DOM 里堆几千行）。 */
export const REPORT_EVENT_RENDER_CAP = 200;

export type ReportOrigin = { kind: "generated" } | { kind: "imported"; fileName: string };

export interface ReportViewModel {
  banner: string;
  meta: string[];
  runInfo: string[];
  metricsHeader: string[];
  metricsRows: string[][];
  eventsSummary: string;
  eventsRows: string[][];
  comparisonSummary: string;
  notes: string[];
  archiveJson: string;
  comparisonJson: string | null;
}

const EMPTY = "—";
const deg = (v: number | null): string => (v === null ? EMPTY : `${v.toFixed(4)}°`);
const sec = (v: number | null): string => (v === null ? EMPTY : `${v.toFixed(2)} s`);

/** 报告 → 纯视图模型（无 DOM，可离线契约测试；导入与生成共用同一渲染口径）。 */
export function reportViewModel(report: ExperimentReport, origin: ReportOrigin): ReportViewModel {
  const run = report.archive.run;
  const events = report.events;
  return {
    banner: origin.kind === "imported"
      ? `只读查看导入文件：${origin.fileName} —— 不应用配置、不改变当前运行。`
      : "本机生成的只读快照：配置与统计定格在生成时刻，后续操作不回写这份报告。",
    meta: [
      `生成时间：${report.createdAtIso}`,
      report.build
        ? `构建：${report.build.buildId} · sourceDigest ${report.build.sourceDigest}`
        : "构建：无构建信息（导入的报告未携带 build 字段）",
    ],
    runInfo: run
      ? [
          `数据源：${run.dataSource} · 误差参考：${run.reference} · 运行时长：${run.elapsedSec.toFixed(1)} s`,
          `档案完成于：${run.finishedAtIso}`,
        ]
      : ["档案未携带运行信息（run 为空）"],
    metricsHeader: ["算法", "样本 n", "均值", "RMSE", "峰值", "收敛于"],
    metricsRows: (run?.metrics ?? []).map((m) => [
      m.id,
      String(m.n),
      deg(m.mean),
      deg(m.rmse),
      deg(m.max),
      sec(m.convergedAt),
    ]),
    eventsSummary: events === null
      ? "本轮未开启诊断事件采集（events=null）——这不等于「没有事件」。"
      : events.length === 0
        ? "已开启事件采集，窗口内没有事件（events=[]）。"
        : `已采集 ${events.length} 条事件，下表列出前 ${Math.min(events.length, REPORT_EVENT_RENDER_CAP)} 条；完整内容以导出 JSON 为准。`,
    eventsRows: (events ?? []).slice(0, REPORT_EVENT_RENDER_CAP).map((e) => [
      `${e.t.toFixed(3)} s`,
      e.kind,
      e.summary,
    ]),
    comparisonSummary: report.comparison === null
      ? "本轮未创建单变量对照结果（comparison=null）。"
      : `已嵌入单变量对照：变量「${report.comparison.variable.label}」，A/B 各 ${report.comparison.a.metrics.length}/${report.comparison.b.metrics.length} 项指标；完整内容见下方 JSON。`,
    notes: [...report.notes],
    archiveJson: JSON.stringify(report.archive, null, 2),
    comparisonJson: report.comparison === null ? null : JSON.stringify(report.comparison, null, 2),
  };
}

export interface ReportPanelDeps {
  root: HTMLElement;
  fileInput: HTMLInputElement;
  archive: () => ExperimentArchive;
  build: () => ReportBuildInfo | null;
  /** null = 诊断事件采集未开启；[] = 已采集但窗口内无事件。 */
  events: () => LearningEvent[] | null;
  comparison: () => ComparisonReport | null;
  toast: (text: string, color?: string) => void;
  download: (contents: string, type: string, name: string, extension: string) => void;
  nowIso: () => string;
  print: () => void;
}

export interface ReportPanelApi {
  generate(): ExperimentReport | null;
  exportJson(): void;
  printReport(): void;
  pickFile(): void;
  importFile(file: File): Promise<boolean>;
  state(): { hasReport: boolean; origin: ReportOrigin | null };
  dispose(): void;
}

export function mountReportPanel(deps: ReportPanelDeps): ReportPanelApi {
  const doc = deps.root.ownerDocument;
  const win = doc.defaultView;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const wrap = el("div", "report-panel");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "只读实验报告");
  const head = el("div", "btn-row");
  const generateBtn = el("button", "btn", "生成实验报告");
  const exportBtn = el("button", "btn", "导出 JSON");
  const printBtn = el("button", "btn", "打印报告");
  const importBtn = el("button", "btn", "导入 JSON 只读查看");
  for (const b of [generateBtn, exportBtn, printBtn, importBtn]) {
    b.type = "button";
    b.dataset.reportAction = b === generateBtn ? "generate" : b === exportBtn ? "export" : b === printBtn ? "print" : "import";
  }
  head.append(generateBtn, exportBtn, printBtn, importBtn);
  const status = el("p", "report-status dim", "尚未生成或导入报告。报告为只读快照：导入不会应用配置，也不会改变当前运行。");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const view = el("div", "report-view");
  wrap.append(head, status, view);
  deps.root.replaceChildren(wrap);

  let current: ExperimentReport | null = null;
  let origin: ReportOrigin | null = null;

  function render(): void {
    if (!current || !origin) {
      view.replaceChildren();
      return;
    }
    const vm = reportViewModel(current, origin);
    view.replaceChildren();
    view.append(el("p", "report-banner", vm.banner));
    // 数据驱动的小构件：七个 section 共用同一套 section/table/details 生成逻辑。
    const section = (title: string, nodes: HTMLElement[]): void => {
      const s = el("section");
      s.append(el("h3", undefined, title), ...nodes);
      view.append(s);
    };
    const table = (header: string[], rows: string[][]): HTMLElement => {
      const t = el("table");
      const hr = el("tr");
      for (const h of header) hr.append(el("th", undefined, h));
      const tbody = el("tbody");
      for (const row of rows) {
        const tr = el("tr");
        for (const cell of row) tr.append(el("td", undefined, cell));
        tbody.append(tr);
      }
      const thead = el("thead");
      thead.append(hr);
      t.append(thead, tbody);
      return t;
    };
    const jsonDetails = (label: string, json: string): HTMLElement => {
      const d = el("details");
      d.append(el("summary", undefined, label), el("pre", undefined, json));
      return d;
    };
    section("构建与来源", vm.meta.map((l) => el("p", undefined, l)));
    section("运行概况", vm.runInfo.map((l) => el("p", undefined, l)));
    section("各算法本轮指标", [
      table(vm.metricsHeader, vm.metricsRows),
      ...(vm.metricsRows.length ? [] : [el("p", "dim", "本轮没有指标样本。")]),
    ]);
    section("事件时间轴", [
      el("p", undefined, vm.eventsSummary),
      ...(vm.eventsRows.length ? [table(["时刻", "类型", "摘要"], vm.eventsRows)] : []),
    ]);
    section("单变量对照", [
      el("p", undefined, vm.comparisonSummary),
      ...(vm.comparisonJson !== null ? [jsonDetails("对照报告完整 JSON", vm.comparisonJson)] : []),
    ]);
    const notes = el("ul");
    for (const note of vm.notes) notes.append(el("li", undefined, note));
    section("口径说明", [notes]);
    section("完整档案", [jsonDetails("配置 + 运行信息 JSON", vm.archiveJson)]);
  }

  /** 打印态清理：afterprint 触发（取消也会触发）；下次任何面板动作前先归位。 */
  function cleanupPrint(): void {
    doc.body.removeAttribute("data-print");
    doc.getElementById("report-print-root")?.replaceChildren();
  }

  function generate(): ExperimentReport | null {
    cleanupPrint();
    try {
      current = buildExperimentReport({
        createdAtIso: deps.nowIso(),
        build: deps.build(),
        archive: deps.archive(),
        events: deps.events(),
        comparison: deps.comparison(),
      });
      origin = { kind: "generated" };
      status.textContent = "已生成本机实验报告（只读快照）：可导出 JSON 或打印；报告内容不随后续运行回写。";
      render();
      return current;
    } catch (err) {
      deps.toast(`生成实验报告失败：${err instanceof Error ? err.message : String(err)}`, "#f85149");
      return null;
    }
  }

  function exportJson(): void {
    if (!current) {
      deps.toast("请先生成或导入一份实验报告", "#fbbf24");
      return;
    }
    deps.download(serializeExperimentReport(current), "application/json", "experiment-report", "json");
    deps.toast("已导出只读实验报告 JSON（可用「导入 JSON 只读查看」打开）");
  }

  function printReport(): void {
    if (!current) {
      deps.toast("请先生成或导入一份实验报告", "#fbbf24");
      return;
    }
    cleanupPrint();
    let printRoot = doc.getElementById("report-print-root");
    if (!printRoot) {
      printRoot = el("div");
      printRoot.id = "report-print-root";
      doc.body.appendChild(printRoot);
    }
    const printable = view.cloneNode(true);
    printRoot.replaceChildren(el("h1", undefined, "四元数姿态解算 · 只读实验报告"), printable);
    doc.body.setAttribute("data-print", "report");
    win?.addEventListener("afterprint", cleanupPrint, { once: true });
    deps.print();
  }

  async function importFile(file: File): Promise<boolean> {
    cleanupPrint();
    try {
      const raw: unknown = JSON.parse(await file.text());
      const report = validateExperimentReport(raw);
      current = report;
      origin = { kind: "imported", fileName: file.name };
      status.textContent = `已只读导入 ${file.name}：未应用配置、未改变当前运行；可打印或原样再导出。`;
      render();
      return true;
    } catch (err) {
      deps.toast(`导入失败（${file.name}）：${err instanceof Error ? err.message : String(err)}`, "#f85149");
      return false;
    }
  }

  generateBtn.addEventListener("click", generate);
  exportBtn.addEventListener("click", exportJson);
  printBtn.addEventListener("click", printReport);
  importBtn.addEventListener("click", () => deps.fileInput.click());
  const onFile = (): void => {
    const file = deps.fileInput.files?.[0];
    // 立刻清空，允许连续选同一个文件（与回放导入同一约定）。
    deps.fileInput.value = "";
    if (file) void importFile(file);
  };
  deps.fileInput.addEventListener("change", onFile);

  return {
    generate,
    exportJson,
    printReport,
    pickFile: () => deps.fileInput.click(),
    importFile,
    state: () => ({ hasReport: current !== null, origin }),
    dispose: () => {
      deps.fileInput.removeEventListener("change", onFile);
      cleanupPrint();
      deps.root.replaceChildren();
    },
  };
}
