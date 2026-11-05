/**
 * 文档全文搜索的**纯函数契约**（SW-12 从装配层拆出的对拍）。
 *
 * 为什么必须有：全文搜索是文档层的头号便利功能（Ctrl/⌘+K），此前没有任何测试；
 * 打分、AND 语义、片段窗口、结果上限、**转义**都只靠人肉点过。
 * 其中转义是实打实的安全问题：查询串来自输入框，会被插进结果容器的 HTML 里。
 */
import assert from "node:assert/strict";
import { hitsHtml, MIN_QUERY_LENGTH, movedSelection, searchDocBlocks, type DocBlock } from "../src/ui/doc-search";

let pass = 0;
let fail = 0;
function test(name: string, body: () => void): void {
  try { body(); pass++; console.log(`PASS ${name}`); }
  catch (err) { fail++; console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

const block = (over: Partial<DocBlock> = {}): DocBlock => ({
  page: "math", pageName: "数学原理", id: "sec-quat", title: "四元数乘法", text: "四元数的乘法不满足交换律，这一点与旋转顺序有关。", ...over,
});
const blocks: DocBlock[] = [
  block(),
  block({ page: "filters", pageName: "滤波算法", id: "sec-mahony", title: "Mahony 滤波", text: "互补滤波与 Mahony 都用 PI 修正，欧拉角在重力方向可观测。" }),
  block({ page: "labs", pageName: "实验", id: "sec-euler", title: "欧拉角与万向节锁", text: "万向节锁发生在俯仰 90 度，此时欧拉角只剩两个自由度。" }),
];

test("AND 语义：所有词都要在同一块里出现（缺一个只跳过这块，不影响其它块）", () => {
  assert.equal(searchDocBlocks(blocks, "欧拉").length, 2, "「欧拉」在两块里出现");
  const both = searchDocBlocks(blocks, "欧拉 万向节");
  assert.equal(both.length, 1, "两个词都命中的只有一块");
  assert.equal(both[0].block.id, "sec-euler");
  assert.deepEqual(searchDocBlocks(blocks, "欧拉 不存在的词"), [], "任一词缺失则无结果");
  assert.deepEqual(searchDocBlocks(blocks, "   "), [], "空白查询不返回结果");
  assert.equal(MIN_QUERY_LENGTH, 2, "输入框与渲染都按同一阈值（装配层不许各写一个数）");
});

test("打分：标题命中权重高于正文，结果按分数降序且受限", () => {
  const hits = searchDocBlocks(blocks, "四元数");
  assert.equal(hits[0].block.title, "四元数乘法", "标题命中排在最前");
  assert.ok(hits[0].score >= hits[hits.length - 1].score, "分数必须降序");
  const limited = searchDocBlocks(blocks, "欧拉", 1);
  assert.equal(limited.length, 1, "limit 必须生效");
  // 标题里的命中权重 8，比正文多次命中的上限 6 高
  const titleHit = searchDocBlocks(blocks, "万向节锁")[0];
  assert.ok(titleHit.score >= 8, `标题命中权重应 ≥8，实际 ${titleHit.score}`);
});

test("片段：以首个命中点为中心取窗口，两侧按需加省略号", () => {
  const long = block({ title: "长文", text: `${"前".repeat(80)}关键字${"后".repeat(80)}` });
  const [hit] = searchDocBlocks([long], "关键字");
  assert.ok(hit.snippet.includes("关键字"), "片段必须包含命中词");
  assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"), `两侧都该有省略号：${hit.snippet}`);
  assert.ok(hit.snippet.length <= 32 + 64 + 3, `片段长度受限：${hit.snippet.length}`);
  const short = searchDocBlocks([block({ title: "短", text: "开头就有 欧拉角" })], "欧拉")[0];
  assert.ok(!short.snippet.startsWith("…"), "命中点在开头时不加前省略号");
});

test("HTML 转义：查询串与内容都会注入结果容器，必须全部转义", () => {
  const payload = `<img src=x onerror="alert(1)">`;
  // ① 空态文案里带查询串（旧实现直接插值 → 可注入）
  const empty = hitsHtml([], payload);
  assert.ok(!empty.includes("<img"), `空态文案不得注入标签：${empty}`);
  assert.ok(empty.includes("&lt;img"), "尖括号必须被转义");
  // ② 命中条目里的标题/片段/页面名同样要转义
  const evil = searchDocBlocks([block({ title: `标题<script>`, text: `正文<img src=x> 关键字` })], "关键字");
  const html = hitsHtml(evil, "关键字");
  assert.ok(!html.includes("<script"), "标题里的标签必须被转义");
  assert.ok(!html.includes("<img"), "正文片段里的标签必须被转义");
  assert.ok(html.includes("&lt;script&gt;") && html.includes("&lt;img"), "转义结果应可见地为实体");
  // ③ 引号与单引号（属性上下文）也要转义
  const quoted = hitsHtml(searchDocBlocks([block({ title: `a"b'c`, text: "关键字" })], "关键字"), "关键字");
  assert.ok(!quoted.includes(`a"b`), "属性/文本里的双引号必须转义");
});

test("键盘选择移动是纯函数：越界夹紧、空列表返回 -1", () => {
  assert.equal(movedSelection(0, 3, "ArrowDown"), 1);
  assert.equal(movedSelection(2, 3, "ArrowDown"), 2, "到底不再往下");
  assert.equal(movedSelection(0, 3, "ArrowUp"), 0, "到顶不再往上");
  assert.equal(movedSelection(-1, 3, "ArrowDown"), 0, "还没选中时按↓选第一条");
  assert.equal(movedSelection(0, 0, "ArrowDown"), -1, "没有结果时没有可选项");
});

test("结果条目带有跳转所需的页/章节标识，且第一项默认选中", () => {
  const html = hitsHtml(searchDocBlocks(blocks, "欧拉"), "欧拉");
  assert.ok(html.includes('data-page="labs"') && html.includes('data-sec="sec-euler"'), "跳转标识必须写进条目");
  assert.ok(html.includes('aria-selected="true"'), "第一项默认选中（键盘 Enter 有落点）");
  assert.ok((html.match(/role="option"/g) ?? []).length === 2, "每条结果都要有 role=option");
});

console.log(`doc-search-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
