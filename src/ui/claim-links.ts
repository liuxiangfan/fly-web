/**
 * 教材 claim → 装置动作的 DOM 接线（FIX-06）。
 *
 * 注册表本身在 `learning-claims.ts`（纯数据、由目录契约测试校验）。本模块只做三件事：
 * 1. 把文档里的 `[data-claim]` 占位渲染成按钮；
 * 2. 点击后执行对应动作（实验 / 预测题 / 对照变量），并把来源页、锚点、滚动位置与焦点记下来；
 * 3. 在任务条上提供「返回教材」，恢复页/锚点/滚动/焦点。
 *
 * 学习面板本身已经在 labs 页里，所以预测动作不关闭文档；实验装载在右侧栏、对照台在侧栏，
 * 这两个动作会关闭文档并展开对应分区。所有文案走 textContent，不拼 innerHTML。
 */
import type { LearningClaim } from "./learning-claims";
import type { TaskDescriptor } from "./task-strip";

export interface ClaimLinkDeps {
  /** 学习面板宿主；同时提供 ownerDocument，避免依赖全局 document。 */
  root: HTMLElement;
  openDocs(page: string, anchor?: string): void;
  setActivity(id: string): void;
  toast(msg: string, color?: string): void;
  closeDocs?(): void;
  /** 装载实验（实验 id）；由主入口接到 applyExperimentById。 */
  loadExperiment?(id: string): Promise<void>;
  ensureComparison?(): Promise<{
    freeze(): void;
    selectVariable(id: string): void;
    setWindow?(durationSec: number): void;
  }>;
  onTask?(task: TaskDescriptor): void;
  ensureTaskStrip?(): Promise<unknown>;
}

interface DocLocation {
  page: string;
  anchor: string;
  scrollTop: number;
  triggerId: string;
}

const RETURN_BTN_ID = "task-strip-return";

export function mountClaimLinks(deps: ClaimLinkDeps): void {
  const doc = deps.root.ownerDocument;
  const hosts = [...doc.querySelectorAll<HTMLElement>("[data-claim]")];
  if (hosts.length === 0) return;

  const restore = (loc: DocLocation): void => {
    deps.openDocs(loc.page, loc.anchor);
    // openDocs 自己会在下一帧按锚点定位；等它完成后再精确恢复滚动与焦点。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const pages = doc.querySelector<HTMLElement>(".doc-pages");
        if (pages) pages.scrollTop = loc.scrollTop;
        doc.getElementById(loc.triggerId)?.focus();
      });
    });
  };

  const showReturn = async (loc: DocLocation): Promise<void> => {
    try {
      await deps.ensureTaskStrip?.();
    } catch {
      // 任务条是辅助入口；加载失败不阻断 claim 动作本身。
    }
    const head = doc.querySelector<HTMLElement>("#task-strip .task-strip-head");
    if (!head) return;
    doc.getElementById(RETURN_BTN_ID)?.remove();
    const button = doc.createElement("button");
    button.id = RETURN_BTN_ID;
    button.className = "pt-btn";
    button.textContent = "返回教材";
    button.addEventListener("click", () => {
      button.remove();
      restore(loc);
    });
    head.append(button);
  };

  const showError = (error: unknown): void => {
    deps.toast(`失败：${error instanceof Error ? error.message : String(error)}`, "#f85149");
  };

  for (const host of hosts) {
    const id = host.dataset.claim ?? "";
    const action = host.dataset.claimAction;
    const targetId = host.dataset.claimTarget ?? "";
    const docAnchor = host.closest("section")?.id ?? "";
    const label = (host.textContent ?? "").trim();
    if (!id || !targetId || !docAnchor || !label ||
      (action !== "run-experiment" && action !== "run-prediction" && action !== "run-comparison")) continue;
    const claim: LearningClaim = {
      id, docPage: "labs", docAnchor, label, action, targetId,
      ...(host.dataset.claimBaseline ? { baselineExperimentId: host.dataset.claimBaseline } : {}),
      // 窗口是唯一需要进入运行时的期望字段；其余期望由目录契约在构建期核对。
      ...(host.dataset.claimWindow
        ? { expectation: { durationSec: Number(host.dataset.claimWindow), estimatorId: "mahony", metric: "rmse", minGain: 1 } }
        : {}),
    };
    const button = doc.createElement("button");
    button.className = "btn";
    button.id = `claim-action-${claim.id}`;
    button.textContent = claim.label;
    button.addEventListener("click", () => {
      const pages = doc.querySelector<HTMLElement>(".doc-pages");
      const loc: DocLocation = {
        page: claim.docPage,
        anchor: claim.docAnchor,
        scrollTop: pages?.scrollTop ?? 0,
        triggerId: button.id,
      };
      try {
        if (claim.action === "run-prediction") {
          deps.setActivity(claim.targetId);
          deps.onTask?.({
            kind: "learning",
            id: claim.targetId,
            title: claim.label,
            conditions: "教材 → 固定证据",
            variable: "先预测再运行",
            observe: "预测 vs 实测",
            next: "提交预测并运行",
            allowedIds: [],
          });
          requestAnimationFrame(() => {
            doc.querySelector<HTMLElement>("[data-learning-panel-host]")?.scrollIntoView({ block: "start" });
          });
          void showReturn(loc);
          return;
        }
        if (claim.action === "run-experiment") {
          deps.closeDocs?.();
          void (async () => {
            try {
              if (!deps.loadExperiment) throw new Error("实验入口不可用");
              await deps.loadExperiment(claim.targetId);
              await showReturn(loc);
            } catch (error) {
              showError(error);
            }
          })();
          return;
        }
        if (claim.action === "run-comparison") {
          deps.closeDocs?.();
          const section = doc.querySelector<HTMLElement>("#sec-compare");
          if (section) {
            if (section.classList.contains("collapsed")) {
              section.querySelector<HTMLButtonElement>(".panel-toggle")?.click();
            }
            section.scrollIntoView({ block: "center" });
          }
          void (async () => {
            try {
              // 先装载 claim 声明的基线实验；否则“方向门控对照”只会在 hover 轻扰下跑，
              // 虽然导航成功，却没有复现教材所指的线加速度污染与拒绝事件。
              if (claim.baselineExperimentId) {
                if (!deps.loadExperiment) throw new Error("实验入口不可用");
                await deps.loadExperiment(claim.baselineExperimentId);
              }
              // 「方向门控（关→开）」的 A 侧必须是关闭态；基线实验默认开启，先关掉再冻结。
              if (claim.targetId === "accel-gate") {
                const gate = doc.getElementById("gate-toggle");
                if (gate instanceof HTMLInputElement && gate.checked) {
                  gate.checked = false;
                  gate.dispatchEvent(new Event("change", { bubbles: true }));
                }
              }
              const panel = await deps.ensureComparison?.();
              if (!panel) throw new Error("对照台不可用");
              // claim 声明了因果验收窗口时，两侧必须用同一窗口才可比。
              if (claim.expectation?.durationSec) panel.setWindow?.(claim.expectation.durationSec);
              panel.freeze();
              panel.selectVariable(claim.targetId);
              await showReturn(loc);
            } catch (error) {
              showError(error);
            }
          })();
          return;
        }
        throw new Error(`未知教材动作：${claim.action}`);
      } catch (error) {
        showError(error);
      }
    });
    host.replaceChildren(button);
  }
}
