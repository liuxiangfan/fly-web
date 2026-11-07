/** 公式复制契约：无真实时钟/权限弹窗，迟到 Promise 与已清理回调都可精确触发。 */
import assert from "node:assert/strict";
import { createFormulaCopy, formulaText, selectFormulaText, type FormulaCopyPorts, type FormulaCopyState, type FormulaCopyTarget } from "../src/ui/formula-copy";

let pass = 0;
let fail = 0;
async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.error(`FAIL ${name}:`, error); }
}
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
function deferred(): { promise: Promise<void>; resolve(): void; reject(): void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = () => no(new Error("denied")); });
  return { promise, resolve, reject };
}
class Clock {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  cleared: number[] = [];
  setTimer = (callback: () => void, ms: number): number => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + ms, callback });
    return id;
  };
  clearTimer = (id: number): void => { this.cleared.push(id); this.tasks.delete(id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const task = [...this.tasks].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!task) break;
      this.tasks.delete(task[0]);
      this.now = task[1].at;
      task[1].callback();
    }
    this.now = end;
  }
}
function target(selected = true): FormulaCopyTarget & { states: FormulaCopyState[]; selections: number } {
  return {
    states: [], selections: 0,
    readText: () => "q = w + x·i + y·j + z·k",
    select() { this.selections++; return selected; },
    show(state) { this.states.push(state); },
  };
}
function rig(writeText?: FormulaCopyPorts["writeText"]) {
  const clock = new Clock();
  const copy = createFormulaCopy({ writeText, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const ui = target();
  return { clock, copy, ui };
}

await test("成功：正文不混入按钮文案，超时清理，反馈 1200ms 后归位", async () => {
  const texts: string[] = [];
  const { copy, clock, ui } = rig((text) => { texts.push(text); return Promise.resolve(); });
  copy.copy(ui);
  assert.deepEqual(ui.states, ["pending"]);
  assert.equal(clock.tasks.size, 1);
  await flush();
  assert.deepEqual(texts, ["q = w + x·i + y·j + z·k"]);
  assert.deepEqual(ui.states, ["pending", "copied"]);
  assert.deepEqual(clock.cleared, [1]);
  assert.equal(ui.selections, 0);
  clock.advance(1199);
  assert.equal(ui.states[ui.states.length - 1], "copied");
  clock.advance(1);
  assert.equal(ui.states[ui.states.length - 1], "idle");
  assert.equal(clock.tasks.size, 0);
});

await test("API 缺失：同步回退且提示保持，手动 Ctrl+C 不受定时器干扰", () => {
  const { copy, clock, ui } = rig();
  copy.copy(ui);
  assert.deepEqual(ui.states, ["pending", "selected"]);
  assert.equal(ui.selections, 1);
  assert.equal(clock.tasks.size, 0);
  clock.advance(100_000);
  assert.equal(ui.states[ui.states.length - 1], "selected");
});

await test("方法缺失、API/getter 抛错、writeText 同步抛错均可回退", () => {
  const navigatorCases = [
    {}, { clipboard: {} },
    { get clipboard(): never { throw new Error("blocked getter"); } },
    { clipboard: { writeText(): never { throw new Error("sync write"); } } },
  ];
  for (const nav of navigatorCases) {
    const { copy, clock, ui } = rig((text) => (nav as unknown as Navigator).clipboard.writeText(text));
    assert.doesNotThrow(() => copy.copy(ui));
    assert.equal(ui.states[ui.states.length - 1], "selected");
    assert.equal(ui.selections, 1);
    assert.equal(clock.tasks.size, 0);
  }
});

await test("拒绝：处理 rejection、清掉超时并仅选中一次", async () => {
  const { copy, clock, ui } = rig(() => Promise.reject(new Error("denied")));
  copy.copy(ui);
  await flush();
  assert.deepEqual(ui.states, ["pending", "selected"]);
  assert.equal(ui.selections, 1);
  assert.equal(clock.tasks.size, 0);
  clock.advance(1500);
  assert.equal(ui.selections, 1);
});

await test("挂起：1499ms 不抢选区，1500ms 回退，不再留计时器", () => {
  const pending = deferred();
  const { copy, clock, ui } = rig(() => pending.promise);
  copy.copy(ui);
  clock.advance(1499);
  assert.equal(ui.states[ui.states.length - 1], "pending");
  assert.equal(ui.selections, 0);
  clock.advance(1);
  assert.equal(ui.states[ui.states.length - 1], "selected");
  assert.equal(ui.selections, 1);
  assert.equal(clock.tasks.size, 0);
});

for (const late of ["resolve", "reject"] as const) {
  await test(`超时后迟到 ${late} 不改手动提示/选区`, async () => {
    const pending = deferred();
    const { copy, clock, ui } = rig(() => pending.promise);
    copy.copy(ui);
    clock.advance(1500);
    pending[late]();
    await flush();
    assert.deepEqual(ui.states, ["pending", "selected"]);
    assert.equal(ui.selections, 1);
    assert.equal(clock.tasks.size, 0);
  });
  await test(`重复点击另一公式：旧 ${late} 与旧超时不能污染新操作`, async () => {
    const old = deferred();
    const next = deferred();
    let writes = 0;
    const { copy, clock, ui } = rig(() => (++writes === 1 ? old : next).promise);
    const other = target();
    copy.copy(ui);
    const stale = [...clock.tasks.values()][0].callback;
    copy.copy(other);
    assert.equal(ui.states[ui.states.length - 1], "idle");
    assert.deepEqual(clock.cleared, [1]);
    old[late]();
    stale(); // 即使 clearTimeout 后任务已经排队，代次仍隔离。
    await flush();
    assert.deepEqual(other.states, ["pending"]);
    assert.equal(ui.selections, 0);
    assert.equal(other.selections, 0);
    next.resolve();
    await flush();
    assert.deepEqual(other.states, ["pending", "copied"]);
    clock.advance(1200);
    assert.equal(other.states[other.states.length - 1], "idle");
    assert.equal(clock.tasks.size, 0);
  });
}

await test("同一按钮重复点击：上一成功的归位回调不清除新反馈", async () => {
  const next = deferred();
  let writes = 0;
  const { copy, clock, ui } = rig(() => ++writes === 1 ? Promise.resolve() : next.promise);
  copy.copy(ui);
  await flush();
  const staleReset = [...clock.tasks.values()][0].callback;
  clock.advance(500);
  copy.copy(ui);
  staleReset();
  clock.advance(700);
  assert.equal(ui.states[ui.states.length - 1], "pending");
  next.resolve();
  await flush();
  assert.equal(ui.states[ui.states.length - 1], "copied");
  clock.advance(1199);
  assert.equal(ui.states[ui.states.length - 1], "copied");
  clock.advance(1);
  assert.equal(ui.states[ui.states.length - 1], "idle");
  assert.equal(clock.tasks.size, 0);
});

await test("dispose 清理并隔离迟到拒绝；可继续新操作", async () => {
  const pending = deferred();
  const { copy, clock, ui } = rig(() => pending.promise);
  copy.copy(ui);
  const stale = [...clock.tasks.values()][0].callback;
  copy.dispose();
  copy.dispose();
  pending.reject();
  stale();
  await flush();
  assert.deepEqual(ui.states, ["pending", "idle"]);
  assert.equal(ui.selections, 0);
  assert.equal(clock.tasks.size, 0);
  copy.copy(ui);
  await flush();
  assert.equal(ui.states[ui.states.length - 1], "selected");
});

await test("selection 不可用/抛错：诚实显示手动选择提示，不声称已选中", () => {
  for (const select of [() => false, () => { throw new Error("no selection"); }]) {
    const { copy, clock } = rig();
    const ui = target(false);
    ui.select = select;
    copy.copy(ui);
    assert.deepEqual(ui.states, ["pending", "manual"]);
    assert.equal(clock.tasks.size, 0);
  }
});

await test("读取正文抛错也进入有界回退", () => {
  const { copy, clock, ui } = rig(() => Promise.resolve());
  ui.readText = () => { throw new Error("detached body"); };
  copy.copy(ui);
  assert.equal(ui.states[ui.states.length - 1], "selected");
  assert.equal(clock.tasks.size, 0);
});

await test("正文提取：Unicode/换行不丢，innerText 空时读 textContent，不依赖反馈标签", () => {
  const body = { innerText: "  q₁ ⊗ q₂\n\n\n\nα + β  ", textContent: "wrong" } as HTMLElement;
  assert.equal(formulaText(body), "q₁ ⊗ q₂\n\nα + β");
  body.innerText = "";
  body.textContent = "  q = [w, v]  ";
  assert.equal(formulaText(body), "q = [w, v]");
  body.textContent = null;
  assert.equal(formulaText(body), "");
});

/** 小型 DOM 端口：核对的 Range 必须是正文，不能只检查调用过 addRange。 */
function selectionFixture() {
  const node = {};
  const range = {
    startContainer: node, endContainer: node, startOffset: 0, endOffset: 2,
    selectNodeContents(body: unknown) { assert.equal(body, fixture.body); },
  };
  const selection = {
    rangeCount: 0, isCollapsed: true,
    removeAllRanges() { this.rangeCount = 0; },
    addRange(value: unknown) { assert.equal(value, range); this.rangeCount = 1; this.isCollapsed = false; },
    getRangeAt: () => range,
  };
  const doc = { defaultView: { getSelection: (): typeof selection | null => selection }, createRange: () => range };
  const fixture = {
    body: { ownerDocument: doc, focus(options: unknown) { assert.deepEqual(options, { preventScroll: true }); } } as unknown as HTMLElement,
    doc, selection, range,
  };
  return fixture;
}

await test("真实选区端口：存在且范围一致才返回 true，正文焦点允许 Ctrl+C", () => {
  const { body } = selectionFixture();
  assert.equal(selectFormulaText(body), true);
});

await test("真实选区端口：无 API/方法、获取或 addRange 抛错均返回 false", () => {
  const changes = [
    (f: ReturnType<typeof selectionFixture>) => { f.doc.defaultView.getSelection = () => null; },
    (f: ReturnType<typeof selectionFixture>) => { f.doc.defaultView.getSelection = () => { throw new Error("getSelection"); }; },
    (f: ReturnType<typeof selectionFixture>) => { f.doc.defaultView.getSelection = undefined as unknown as typeof f.doc.defaultView.getSelection; },
    (f: ReturnType<typeof selectionFixture>) => { f.doc.createRange = undefined as unknown as typeof f.doc.createRange; },
    (f: ReturnType<typeof selectionFixture>) => { f.selection.addRange = () => { throw new Error("addRange"); }; },
  ];
  for (const change of changes) {
    const fixture = selectionFixture();
    change(fixture);
    assert.equal(selectFormulaText(fixture.body), false);
  }
});

await test("真实选区端口：addRange 静默失败/折叠/范围错位不报已选中", () => {
  for (const change of [
    (f: ReturnType<typeof selectionFixture>) => { f.selection.addRange = () => {}; },
    (f: ReturnType<typeof selectionFixture>) => { f.selection.addRange = () => { f.selection.rangeCount = 1; }; },
    (f: ReturnType<typeof selectionFixture>) => { f.selection.getRangeAt = () => ({ ...f.range, endOffset: 1 }); },
  ]) {
    const fixture = selectionFixture();
    change(fixture);
    assert.equal(selectFormulaText(fixture.body), false);
  }
});

console.log(`formula-copy-contract: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
