/**
 * 文档全文搜索（SW-12 从装配层拆出）：**索引构建 / 打分 / 片段 / HTML 生成**都是纯函数，
 * DOM 只出现在"从页面里收集块"这一处入口。
 *
 * 为什么拆：这块原来是 main.ts 里一段 150 行的内联实现，两个后果——
 *   ① 打分与 AND 语义没有任何测试（全文搜索是文档层的头号便利功能，却处在覆盖之外）；
 *   ② 拼接 HTML 时只对**片段**做了 `<` 转义，而**查询串**被直接插进空态文案里——
 *      `Ctrl+K` 输入 `<img src=x onerror=…>` 会把标签注入到结果容器里。
 * 拆出来之后：纯函数由 `scripts/doc-search-contract.test.ts` 逐条钉住（含转义反例），
 * 装配层只负责事件与焦点。
 */

export interface DocBlock {
  /** 所属文档页 id（data-doc-page） */
  page: string;
  /** 页面标题（导航与人读） */
  pageName: string;
  /** 章节锚点 id（跳转用；空串表示只能跳到页首） */
  id: string;
  title: string;
  text: string;
}

export interface DocHit {
  block: DocBlock;
  snippet: string;
  score: number;
}

/** HTML 转义：搜索框里的内容是**用户输入**，任何插进结果容器的字符串都必须先转义。 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把一页切成「标题 + 正文」块：h1/h2/h3（带 id）起新块，section 递归进去。 */
export function collectDocBlocks(page: HTMLElement, pageId: string, pageName: string, out: DocBlock[]): void {
  let cur: DocBlock | null = null;
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const id = (child as HTMLElement).id;
      if (tag === "h1" || tag === "h2" || (tag === "h3" && id)) {
        if (cur) out.push(cur);
        const secId = id || (child.parentElement as HTMLElement | null)?.id || "";
        cur = { page: pageId, pageName, id: secId, title: (child.textContent ?? "").trim(), text: "" };
        continue;
      }
      if (tag === "section") {
        walk(child);
        continue;
      }
      if (cur) cur.text += " " + (child.textContent ?? "");
    }
  };
  walk(page);
  if (cur) out.push(cur);
}

/** 从全部文档页建立索引（空白归一化，避免 DOM 折行把词切断）。 */
export function buildDocIndex(pages: readonly HTMLElement[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const page of pages) {
    const pageId = page.dataset.docPage ?? "";
    const pageName = page.querySelector("h1")?.textContent?.trim() ?? pageId;
    collectDocBlocks(page, pageId, pageName, out);
  }
  for (const b of out) b.text = b.text.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * 打分：标题命中权重高、正文命中按次数；片段取首个命中点前后各 32 字。
 * 语义：**AND**——所有词都要在这一块里出现；任一词缺席只跳过这一块，不影响其它块。
 */
export function searchDocBlocks(blocks: readonly DocBlock[], query: string, limit = 14): DocHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (!terms.length) return [];
  const hits: DocHit[] = [];
  for (const block of blocks) {
    const text = block.text.toLowerCase();
    const titleLower = block.title.toLowerCase();
    let score = 0;
    let firstAt = -1;
    let allPresent = true;
    for (const t of terms) {
      const inTitle = titleLower.split(t).length - 1;
      let idx = text.indexOf(t);
      let count = 0;
      let first = -1;
      while (idx >= 0) {
        if (first < 0) first = idx;
        count++;
        idx = text.indexOf(t, idx + t.length);
      }
      if (inTitle === 0 && count === 0) {
        allPresent = false;
        break;
      }
      score += inTitle * 8 + Math.min(count, 6);
      if (first >= 0 && (firstAt < 0 || first < firstAt)) firstAt = first;
    }
    if (!allPresent || score === 0) continue;
    const from = Math.max(0, firstAt - 32);
    const snippet =
      (from > 0 ? "…" : "") +
      block.text.slice(from, Math.min(block.text.length, firstAt + 64)) +
      (firstAt + 64 < block.text.length ? "…" : "");
    hits.push({ block, snippet, score });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** 结果列表 HTML（**全部**字段转义）：空态也要转义查询串。 */
export function hitsHtml(hits: readonly DocHit[], query: string): string {
  if (!hits.length) return `<div class="dsh-empty">没有匹配「${escapeHtml(query)}」的章节</div>`;
  return hits
    .map(
      (h, i) =>
        `<button type="button" class="dsh-item" role="option" aria-selected="${i === 0}" data-page="${escapeHtml(h.block.page)}" data-sec="${escapeHtml(h.block.id)}">` +
        `<span class="dsh-path">${escapeHtml(h.block.pageName)}</span>` +
        `<span class="dsh-title">${escapeHtml(h.block.title)}</span>` +
        `<span class="dsh-snip">${escapeHtml(h.snippet)}</span>` +
        `</button>`,
    )
    .join("");
}

/** 方向键在结果列表里移动选择（纯函数：装配层只负责把结果写回 DOM）。 */
export function movedSelection(current: number, total: number, key: "ArrowDown" | "ArrowUp"): number {
  if (total <= 0) return -1;
  if (key === "ArrowDown") return Math.min(total - 1, current + 1);
  return Math.max(0, current - 1);
}

/** 搜索词下限：一个字就搜会让结果噪音过大（输入框提示与此一致）。 */
export const MIN_QUERY_LENGTH = 2;
