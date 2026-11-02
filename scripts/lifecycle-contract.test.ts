import assert from "node:assert/strict";
import { NotificationSession, SerialTransportSession } from "../src/core/transport-session";

let pass = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`); throw err; }
};

await test("原生ReadableStream：dispose等待挂起read结束、释放锁后才close", async () => {
  let lockedAtClose: boolean | null = null, opened = 0, closed = 0;
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() {} });
  const port = { readable: stream, async open() { opened++; }, async close() { lockedAtClose = stream.locked; if (stream.locked) throw new Error("stream locked"); closed++; } };
  const s = new SerialTransportSession(port, 1, () => {}, () => {});
  assert.equal(await s.open(115200), true);
  const read = s.read(() => true, () => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stream.locked, true);
  assert.equal(await s.dispose(), true);
  await read;
  assert.equal(lockedAtClose, false);
  assert.equal(stream.locked, false);
  assert.equal(closed, 1);
  assert.equal(opened, 1);
});

await test("旧reader迟到value/done不污染新会话", async () => {
  let ca!: ReadableStreamDefaultController<Uint8Array>;
  let cb!: ReadableStreamDefaultController<Uint8Array>;
  const make = (set: (c: ReadableStreamDefaultController<Uint8Array>) => void) => new ReadableStream<Uint8Array>({ start: set, cancel() {} });
  const pa = { readable: make((c) => { ca = c; }), async open() {}, async close() {} };
  const pb = { readable: make((c) => { cb = c; }), async open() {}, async close() {} };
  let current = 1; const seen: number[] = [];
  const a = new SerialTransportSession(pa, 1, () => {}, () => {});
  const b = new SerialTransportSession(pb, 2, () => {}, () => {});
  await a.open(1); const ra = a.read(() => current === 1, (v) => seen.push(v[0]));
  current = 2; await b.open(1); const rb = b.read(() => current === 2, (v) => seen.push(v[0]));
  ca.enqueue(new Uint8Array([7])); ca.close(); cb.enqueue(new Uint8Array([9]));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, [9]);
  await a.dispose(); await ra;
  await b.dispose(); await rb;
});

class Char extends EventTarget {
  notifying = false; fail = false; starts = 0; stops = 0;
  async startNotifications(): Promise<this> { this.starts++; if (this.fail) throw new Error("notify rejected"); this.notifying = true; return this; }
  async stopNotifications(): Promise<this> { this.stops++; this.notifying = false; return this; }
  emit(): void { if (this.notifying) this.dispatchEvent(new Event("value")); }
}
const notification = () => {
  const seen: string[] = [];
  const session = new NotificationSession<Char>({
    valid: () => true,
    attach: (c, cb) => c.addEventListener("value", cb as unknown as EventListener),
    detach: (c, cb) => c.removeEventListener("value", cb as unknown as EventListener),
    notify: (e) => seen.push(e.target === a ? "a" : "b"),
  });
  const a = new Char(), b = new Char();
  return { session, a, b, seen };
};

await test("同特征快速重订阅最终通知仍活跃", async () => {
  const { session, a, seen } = notification();
  const p1 = session.subscribe(a); const p2 = session.subscribe(a);
  await Promise.all([p1, p2]); a.emit();
  assert.deepEqual(seen, ["a"]);
  assert.equal(a.notifying, true);
  await session.dispose();
});

await test("新特征失败回滚到旧特征，无未处理拒绝", async () => {
  const { session, a, b, seen } = notification();
  await session.subscribe(a); b.fail = true;
  await assert.rejects(session.subscribe(b), /notify rejected/);
  a.emit(); b.emit();
  assert.deepEqual(seen, ["a"]);
  assert.equal(session.current, a);
  assert.equal(a.notifying, true);
  await session.dispose();
});

await test("close 失败不被永久缓存：锁释放后再次 dispose 必须真能关掉端口", async () => {
  const events: boolean[] = [];
  let locked = true, closed = 0;
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() {} });
  const port = {
    readable: stream,
    async open() {},
    async close() { if (locked) throw new Error("stream locked"); closed++; },
  };
  const s = new SerialTransportSession(port, 1, () => {}, (ok) => events.push(ok));
  assert.equal(await s.open(115200), true);
  const read = s.read(() => true, () => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await s.dispose(), false, "读锁未释放时不得谎称已关闭");
  assert.deepEqual(events, [false], "失败必须如实记账");
  locked = false;
  assert.equal(await s.dispose(), true, "锁释放后必须能真正关闭（旧实现把 false 永久缓存）");
  assert.equal(closed, 1);
  assert.deepEqual(events, [false, true]);
  assert.equal(await s.dispose(), true);
  assert.equal(closed, 1, "已关闭的端口不得重复 close");
  await read;
});

await test("旧 read 永不结束也不无限阻塞：dispose 有界返回，端口按实际结果重试关闭", async () => {
  let closed = 0, closeAttempts = 0;
  const stuckReader = {
    read: () => new Promise(() => {}), // 永不完结
    cancel: () => new Promise(() => {}), // 驱动异常：连 cancel 都不落定
    releaseLock: () => { throw new Error("still locked"); },
  };
  const port = {
    readable: { getReader: () => stuckReader } as unknown as ReadableStream<Uint8Array>,
    async open() {},
    async close() { closeAttempts++; if (closeAttempts <= 2) throw new Error("stream locked"); closed++; },
  };
  const s = new SerialTransportSession(port, 1, () => {}, () => {});
  assert.equal(await s.open(115200), true);
  void s.read(() => true, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const t0 = Date.now();
  assert.equal(await s.dispose(), false, "锁与 read 都僵住时不能谎称已关闭");
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `dispose 必须有界返回（实测 ${ms} ms）`);
  const t1 = Date.now();
  assert.equal(await s.dispose(), true, "端口恢复可用后重试必须成功");
  assert.equal(closed, 1);
  assert.ok(Date.now() - t1 < 4000);
});

await test("句柄复用：旧会话未释放时新会话拒绝 open；旧会话迟到的 dispose 不碰新端口", async () => {
  let opens = 0, closes = 0, locked = true;
  const port = {
    readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
    async open() { opens++; },
    async close() { if (locked) throw new Error("stream locked"); closes++; },
  };
  const a = new SerialTransportSession(port, 1, () => {}, () => {});
  assert.equal(await a.open(115200), true);
  const ra = a.read(() => true, () => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await a.dispose(), false);
  const b = new SerialTransportSession(port, 2, () => {}, () => {});
  await assert.rejects(b.open(115200), /未能释放/, "旧端口未关掉之前不得再次 open");
  assert.equal(opens, 1, "失败的接管不得触碰物理端口");
  locked = false;
  const c = new SerialTransportSession(port, 3, () => {}, () => {});
  assert.equal(await c.open(115200), true);
  assert.equal(opens, 2);
  assert.equal(closes, 1, "接管时把旧会话那一次 close 补上");
  assert.equal(await a.dispose(), true, "已失去租约的旧会话再次 dispose 是空操作");
  assert.equal(closes, 1, "不得关掉新会话的端口");
  assert.equal(await c.dispose(), true);
  assert.equal(closes, 2);
  await ra;
});

console.log(`lifecycle-contract: ${pass} PASS / 0 FAIL`);
