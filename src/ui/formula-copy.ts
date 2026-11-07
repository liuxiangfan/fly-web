/** 正文容器不含复制按钮；保留 Unicode、行分隔与原有数学标记。 */
export function formulaText(body: HTMLElement): string {
  return (body.innerText || body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 建立并核对正文选区；缺 API、空选区或浏览器拒绝都不能报「已选中」。 */
export function selectFormulaText(body: HTMLElement): boolean {
  try {
    const doc = body.ownerDocument;
    const selection = doc.defaultView?.getSelection();
    if (!selection) return false;
    body.focus({ preventScroll: true }); // 正文 tabindex=-1；Ctrl+C 不被复制按钮的焦点干扰。
    const range = doc.createRange();
    range.selectNodeContents(body);
    selection.removeAllRanges();
    selection.addRange(range);
    if (selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const actual = selection.getRangeAt(0);
    return actual.startContainer === range.startContainer && actual.startOffset === range.startOffset
      && actual.endContainer === range.endContainer && actual.endOffset === range.endOffset;
  } catch { return false; }
}

export type FormulaCopyState = "idle" | "pending" | "copied" | "selected" | "manual";
export interface FormulaCopyTarget {
  readText(): string;
  select(): boolean;
  show(state: FormulaCopyState): void;
}
export interface FormulaCopyPorts {
  writeText?: (text: string) => PromiseLike<void>;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/** 一组按钮共用控制器：新点击撤销旧 UI 所有权，同时清掉超时/反馈计时器。 */
export function createFormulaCopy(ports: FormulaCopyPorts): {
  copy(target: FormulaCopyTarget): void;
  dispose(): void;
} {
  let generation = 0;
  let timer: number | undefined;
  let active: FormulaCopyTarget | undefined;
  const clear = (): void => {
    if (timer !== undefined) ports.clearTimer(timer);
    timer = undefined;
  };
  const dispose = (): void => {
    generation++;
    clear();
    active?.show("idle");
    active = undefined;
  };
  return {
    dispose,
    copy(target): void {
      dispose();
      active = target;
      const own = generation;
      let settled = false;
      const live = (): boolean => own === generation && !settled;
      const finish = (state: FormulaCopyState): void => {
        if (!live()) return;
        settled = true;
        clear();
        target.show(state);
        // 手动复制提示不自动消失：读者有足够时间按 Ctrl+C。
        if (state === "copied") timer = ports.setTimer(() => {
          if (own === generation) dispose();
        }, 1200);
      };
      const fallback = (): void => {
        if (!live()) return;
        let selected = false;
        try { selected = target.select(); } catch { /* 仍给出诚实的手动提示 */ }
        finish(selected ? "selected" : "manual");
      };
      target.show("pending");
      timer = ports.setTimer(fallback, 1500);
      try {
        if (!ports.writeText) { fallback(); return; }
        // 原生 clipboard 写入无法取消，超时/重复点击只隔离迟到 UI，不保证剪贴板不会迟到写入。
        Promise.resolve(ports.writeText(target.readText())).then(() => finish("copied"), fallback);
      } catch { fallback(); } // API/方法缺失、getter 或同步调用抛错。
    },
  };
}
