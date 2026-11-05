import assert from "node:assert/strict";
import { NotificationSession, SerialTransportSession, TransportSession } from "../src/core/transport-session";

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

await test("close 永不落定：dispose 有界返回，端口恢复后重试能真正关闭", async () => {
  let closeCalls = 0;
  let hang = true;
  let closed = 0;
  const port = {
    readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
    async open() {},
    close() {
      closeCalls++;
      if (hang) return new Promise<void>(() => {}); // 驱动异常：永不落定
      closed++;
      return Promise.resolve();
    },
  };
  const s = new SerialTransportSession(port, 1, () => {}, () => {});
  assert.equal(await s.open(115200), true);
  const t0 = Date.now();
  assert.equal(await s.dispose(), false, "close 挂住时不能谎称已关闭");
  assert.ok(Date.now() - t0 < 5000, `dispose 必须有界返回（实测 ${Date.now() - t0} ms）`);
  hang = false;
  assert.equal(await s.dispose(), true, "端口恢复后重试必须成功");
  assert.equal(closed, 1);
  assert.ok(closeCalls >= 2);
});

await test("同一 tick 内 dispose：setup 直接作废，端口不会被真正打开", async () => {
  let opened = 0;
  const port = {
    readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
    async open() { opened++; },
    async close() {},
  };
  const s = new SerialTransportSession(port, 1, () => {}, () => {});
  const opening = s.open(115200);
  assert.equal(await s.dispose(), true, "连 open 都还没开始，没有句柄需要释放");
  assert.equal(await opening, false, "setup 应被作废而不是假装打开成功");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opened, 0, "作废后不得再调用 port.open");
});

await test("open 永不落定：dispose 有界返回；迟到的 open 必须自行关闭，不泄漏句柄", async () => {
  let releaseOpen!: () => void;
  let opened = 0;
  let closes = 0;
  const port = {
    readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
    open() { return new Promise<void>((resolve) => { releaseOpen = () => { opened++; resolve(); }; }); },
    async close() { closes++; },
  };
  const s = new SerialTransportSession(port, 1, () => {}, () => {});
  const opening = s.open(115200);
  // 让 open 真正进入 await port.open（同一 tick 里 dispose 会把 setup 直接判为作废，端口根本不会打开）
  await new Promise((r) => setTimeout(r, 0));
  const t0 = Date.now();
  assert.equal(await s.dispose(), false, "open 挂起时不能声称已打开+已关闭");
  assert.ok(Date.now() - t0 < 5000, `dispose 必须有界返回（实测 ${Date.now() - t0} ms）`);
  releaseOpen();
  await assert.rejects(opening, /会话已作废|未能释放/, "迟到的 open 必须失败");
  assert.equal(opened, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closes, 1, "迟到的 open 必须自行 close，不得泄漏已打开端口");
});

await test("主动连接动作本身必须超时：open 永不落定时连接在有限时间内失败并进入错误状态", async () => {
  // 复核 P1：dispose 的有界等待只保护"释放"，不保护"连接"。旧实现里
  // `SerialPort.open()` 挂住 → 连接按钮永远停在"正在连接"，用户不主动断开就再无入口。
  const saved = TransportSession.setupTimeoutMs;
  TransportSession.setupTimeoutMs = 150;
  try {
    let opened = 0, closes = 0, releaseOpen!: () => void;
    const port = {
      readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
      open() { return new Promise<void>((resolve) => { releaseOpen = () => { opened++; resolve(); }; }); },
      async close() { closes++; },
    };
    const s = new SerialTransportSession(port, 1, () => {}, () => {});
    const t0 = Date.now();
    await assert.rejects(s.open(115200), /超时/, "open 挂起必须在 setupTimeoutMs 内失败");
    const ms = Date.now() - t0;
    assert.ok(ms < 1200, `失败必须有界（实测 ${ms} ms）`);
    // 迟到的 open 仍要自行关闭句柄，不能泄漏端口
    releaseOpen();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(opened, 1);
    assert.equal(closes, 1, "迟到的 open 必须自行 close");
    // 超时后不允许把会话当成"已释放"：dispose 必须如实返回 false 并交给隔离队列
    assert.equal(await s.dispose(), true, "已作废且端口未打开时，释放本身是成功的（迟到的 open 已自行关闭）");
  } finally {
    TransportSession.setupTimeoutMs = saved;
  }
});

await test("SW-05 底层操作未落定：dispose 不得谎称已释放，落定后重试才成功", async () => {
  const saved = TransportSession.setupTimeoutMs;
  TransportSession.setupTimeoutMs = 120;
  try {
    const device = { id: "dev" };
    let closes = 0;
    let releaseRaw!: () => void;
    const lease = new TransportSession(device, 1, async () => { closes++; return true; });
    const t0 = Date.now();
    await assert.rejects(
      lease.setup(async () => { await new Promise<void>((resolve) => { releaseRaw = resolve; }); }), // 服务发现永不落定
      /连接动作|超时/,
    );
    assert.ok(Date.now() - t0 < 1000, "服务发现超时必须有界");
    assert.equal(lease.disposed, true, "超时后会话必须作废，不允许后续提交状态");
    // 关键：外层等待超时 ≠ 底层动作结束。此时清理过了，但**不能**声称"已释放"——
    // 句柄可能稍后才被打开，必须先留在隔离队列里（旧实现这里返回 true，于是新会话可以接管同一句柄）。
    assert.equal(await lease.dispose(), false, "底层动作未落定时不得声称已释放");
    assert.equal(closes >= 1, true, "仍要尽力清理");
    // 底层动作终于落定 → 重试必须成功，句柄可以交还
    releaseRaw();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await lease.dispose(), true, "底层动作落定后重试必须成功释放");
    assert.equal(lease.rawOperationSettled, true);
  } finally {
    TransportSession.setupTimeoutMs = saved;
  }
});

await test("SW-05 未落定的旧会话阻塞同句柄接管；迟到 open 由原会话自行关闭", async () => {
  const saved = TransportSession.setupTimeoutMs;
  TransportSession.setupTimeoutMs = 100;
  try {
    let physicalOpen = false;
    let opens = 0;
    let closes = 0;
    let releaseAck!: () => void;
    const port = {
      readable: null,
      async open() {
        opens++;
        physicalOpen = true;
        // 第一次 open 把端口打开了，但**确认迟迟不返回**（驱动/蓝牙栈挂起）
        if (opens === 1) await new Promise<void>((resolve) => { releaseAck = resolve; });
      },
      async close() { closes++; physicalOpen = false; },
    };
    const a = new SerialTransportSession(port, 1, () => {}, () => {});
    await assert.rejects(a.open(115200), /超时|连接动作/);
    // 外层等待已经超时，但底层 open 仍在飞 → 不得声称已释放（旧实现返回 true，句柄就此失控）
    assert.equal(await a.dispose(), false, "底层 open 未落定 → 旧会话仍在隔离");
    const b = new SerialTransportSession(port, 2, () => {}, () => {});
    await assert.rejects(b.open(115200), /未能释放/, "旧句柄未真正释放前，新会话不得接管");
    assert.equal(opens, 1, "失败的接管不得触碰物理端口");
    releaseAck(); // 迟到的确认终于到达
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closes, 1, "迟到的 open 必须由原会话自行关闭，否则端口泄漏");
    assert.equal(physicalOpen, false, "端口必须真的关掉");
    // 原会话关闭并交还句柄后，**新的**会话可以正常接管
    // （b 的 setup 结果被缓存为失败，这是刻意的：一次失败的连接尝试不该被自动重试）
    const c = new SerialTransportSession(port, 3, () => {}, () => {});
    assert.equal(await c.open(115200), true, "交还后新会话必须能接管");
    assert.equal(opens, 2);
    assert.equal(physicalOpen, true);
    await c.dispose();
    assert.equal(physicalOpen, false);
  } finally {
    TransportSession.setupTimeoutMs = saved;
  }
});

await test("SW-05 两次 close 交错完成：onClose(true) 只允许记一次", async () => {
  let closeCalls = 0;
  let physicalOpen = false;
  const first = (() => { let done!: () => void; const p = new Promise<void>((r) => { done = r; }); return { p, done }; })();
  const events: boolean[] = [];
  const port = {
    readable: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
    async open() { physicalOpen = true; },
    close() {
      closeCalls++;
      // 第一次 close 挂起（超时），第二次成功；随后第一次也成功 → 两次成功分支都会跑
      if (closeCalls === 1) return first.p.then(() => { physicalOpen = false; });
      physicalOpen = false;
      return Promise.resolve();
    },
  };
  const s = new SerialTransportSession(port, 1, () => {}, (ok) => events.push(ok));
  await s.open(115200);
  // 缩短等待窗口：只用一次 dispose 就能走到第二次尝试（CLOSE_WAIT_MS 是静态量）
  const original = SerialTransportSession.CLOSE_WAIT_MS;
  (SerialTransportSession as unknown as { CLOSE_WAIT_MS: number }).CLOSE_WAIT_MS = 30;
  try {
    const disposed = await s.dispose();
    first.done();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(disposed, true, "第二次 close 成功 → 释放成功");
    assert.equal(physicalOpen, false, "端口必须真的关上");
    assert.equal(closeCalls >= 2, true, "两次尝试都发过 close");
    assert.deepEqual(events, [true], `成功关闭只允许记一次，实测 ${JSON.stringify(events)}`);
  } finally {
    (SerialTransportSession as unknown as { CLOSE_WAIT_MS: number }).CLOSE_WAIT_MS = original;
  }
});

await test("SW-05 迟到的 start 落定后必须补偿退订（已放弃的订阅不得复活）", async () => {
  const saved = NotificationSession.notifyTimeoutMs;
  NotificationSession.notifyTimeoutMs = 60;
  try {
    let releaseStart!: () => void;
    let notifying = false;
    let stops = 0;
    const attached = new Set<unknown>();
    const char = {
      startNotifications() { return new Promise((resolve) => { releaseStart = () => { notifying = true; resolve(char); }; }); },
      async stopNotifications() { stops++; notifying = false; return char; },
    };
    const session = new NotificationSession<typeof char>({
      valid: () => true, attach: (c) => attached.add(c), detach: (c) => attached.delete(c), notify: () => {},
    });
    await assert.rejects(session.subscribe(char), /超时/);
    await session.dispose();
    assert.equal(notifying, false, "超时当下通知还没开");
    releaseStart(); // 迟到的成功：真把通知打开了
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(notifying, false, "迟到的 start 必须被补偿退订，不能留下活跃通知");
    assert.ok(stops >= 1, "必须真的调用过 stopNotifications");
    assert.equal(attached.size, 0, "不得挂上监听");
    assert.equal(session.current, null, "不得提交订阅");
  } finally {
    NotificationSession.notifyTimeoutMs = saved;
  }
});

await test("SW-05 迟到的 stop 不得停掉已提交的新订阅：先隔离，等不到就明确拒绝", async () => {
  const saved = NotificationSession.notifyTimeoutMs;
  NotificationSession.notifyTimeoutMs = 60;
  try {
    let releaseStop!: () => void;
    let stopCalls = 0;
    let notifying = false;
    const listeners = new Set<Function>();
    const char = {
      async startNotifications() { notifying = true; return char; },
      stopNotifications() {
        stopCalls++;
        if (stopCalls === 1) return new Promise((resolve) => { releaseStop = () => { notifying = false; resolve(char); }; });
        notifying = false;
        return Promise.resolve(char);
      },
      emit() { if (notifying) for (const cb of listeners) cb({ target: char }); },
    };
    let seen = 0;
    const session = new NotificationSession<typeof char>({
      valid: () => true,
      attach: (_c, cb) => listeners.add(cb as Function),
      detach: (_c, cb) => listeners.delete(cb as Function),
      notify: () => { seen++; },
    });
    assert.equal(await session.subscribe(char), true);
    // 重订阅同一个特征：旧的 stop 会超时挂起 → 必须等待/拒绝，绝不让 start 与迟到 stop 交错
    await assert.rejects(session.subscribe(char), /关闭中|未落定/, "旧 stop 未落定时不得冒交错风险订阅");
    assert.equal(session.current, null, "拒绝时不得留下已提交的订阅");
    // 旧 stop 落定 → 重订阅必须成功，并且通知真的会来
    releaseStop();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await session.subscribe(char), true, "旧 stop 落定后必须能重新订阅");
    seen = 0;
    char.emit();
    assert.equal(seen, 1, "重新订阅后通知必须能到达");
    assert.equal(notifying, true);
    await session.dispose();
  } finally {
    NotificationSession.notifyTimeoutMs = saved;
  }
});

await test("startNotifications 永不落定：订阅主动超时并报错（不得谎称已订阅）", async () => {
  const saved = NotificationSession.notifyTimeoutMs;
  NotificationSession.notifyTimeoutMs = 120;
  try {
    class Stuck { async startNotifications(): Promise<this> { return new Promise<this>(() => {}); } async stopNotifications(): Promise<this> { return this; } }
    const seen: string[] = [];
    const session = new NotificationSession<Stuck>({
      valid: () => true, attach: () => {}, detach: () => {}, notify: () => seen.push("x"),
    });
    const t0 = Date.now();
    await assert.rejects(session.subscribe(new Stuck()), /超时/);
    assert.ok(Date.now() - t0 < 1000, `订阅必须有界失败（实测 ${Date.now() - t0} ms）`);
    assert.equal(session.current, null, "超时后不得提交任何订阅");
    await session.dispose();
  } finally {
    NotificationSession.notifyTimeoutMs = saved;
  }
});

await test("stopNotifications 永不落定：退订不阻塞、监听先摘除（旧回调不得再进队列）", async () => {
  const saved = NotificationSession.notifyTimeoutMs;
  NotificationSession.notifyTimeoutMs = 120;
  try {
    const attached = new Set<unknown>();
    class Stuck {
      async startNotifications(): Promise<this> { return this; }
      async stopNotifications(): Promise<this> { return new Promise<this>(() => {}); }
    }
    const session = new NotificationSession<Stuck>({
      valid: () => true,
      attach: (c) => attached.add(c), detach: (c) => attached.delete(c), notify: () => {},
    });
    const char = new Stuck();
    assert.equal(await session.subscribe(char), true);
    assert.equal(attached.size, 1);
    const t0 = Date.now();
    await session.dispose();
    assert.ok(Date.now() - t0 < 1000, `dispose 必须有界（实测 ${Date.now() - t0} ms）`);
    assert.equal(attached.size, 0, "退订前必须先摘监听：stopNotifications 卡住也不许旧回调继续投递");
    assert.equal(session.current, null);
  } finally {
    NotificationSession.notifyTimeoutMs = saved;
  }
});

console.log(`lifecycle-contract: ${pass} PASS / 0 FAIL`);
