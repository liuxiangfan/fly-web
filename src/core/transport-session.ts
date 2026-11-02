/** Per-handle serialization: a reused device object is not a session identity. */
const handleTails = new WeakMap<object, Promise<unknown>>();
const handleOwners = new WeakMap<object, TransportSession<object>>();

function serializeHandle<T>(handle: object, work: () => Promise<T>): Promise<T> {
  const previous = handleTails.get(handle) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  handleTails.set(handle, tail);
  void tail.then(() => {
    if (handleTails.get(handle) === tail) handleTails.delete(handle);
  });
  return next;
}

/** Setup and cleanup share one lease and one awaited, idempotent disposal. */
export class TransportSession<H extends object> {
  /** 外部 open/GATT 发现的上限：超过后仍继续清理，不让释放永久挂起。 */
  private static readonly SETUP_WAIT_MS = 1000;
  disposed = false;
  disposePromise: Promise<boolean> | null = null;
  private setupPromise: Promise<boolean> | null = null;

  constructor(
    readonly handle: H,
    readonly generation: number,
    private readonly cleanup: (ownsHandle: boolean) => Promise<boolean>,
  ) {}

  setup(work: () => Promise<void>): Promise<boolean> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = serializeHandle(this.handle, async () => {
      const previous = handleOwners.get(this.handle);
      if (previous && previous !== this && !(await previous.dispose())) {
        throw new Error("上一会话的设备句柄未能释放");
      }
      if (this.disposed) return false;
      handleOwners.set(this.handle, this as TransportSession<object>);
      await work();
      return !this.disposed;
    });
    return this.setupPromise;
  }

  dispose(): Promise<boolean> {
    this.disposed = true; // Invalidate callbacks before the first await.
    if (this.disposePromise) return this.disposePromise;
    const run = (async () => {
      // setup（open / GATT 发现）也可能永不落定：无界等待会让释放事务永久挂住。
      // 有界等待后照常尝试清理；若 setup 之后才完成，setup 内部会看到 disposed 并自行关闭。
      let setupSettled = true;
      if (this.setupPromise) {
        setupSettled = await Promise.race([
          this.setupPromise.then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TransportSession.SETUP_WAIT_MS)),
        ]);
      }
      const mine = handleOwners.get(this.handle) === this;
      let closed = false;
      try { closed = await this.cleanup(mine); } catch { /* Keep failed lease. */ }
      if (mine && closed && handleOwners.get(this.handle) === this) {
        handleOwners.delete(this.handle);
      }
      // setup 未落定 → 句柄可能稍后才被打开，不能声称"已释放"；调用方应保留引用并重试。
      return closed && setupSettled;
    })();
    this.disposePromise = run;
    // 失败（典型：读锁未释放导致 close 被拒）**不能永久缓存**：否则同一会话之后再怎么
    // dispose 都只是拿到同一个 false，端口永远关不掉，后续 open 永远 "already open"。
    // 成功才锁定结果；失败时清掉缓存，让下一次调用按当时的实际情况重试。
    void run.then((closed) => {
      if (!closed && this.disposePromise === run) this.disposePromise = null;
    });
    return run;
  }
}

export interface SerialTransportPort {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

/**
 * 有界等待一个「可能永不落定」的承诺。
 *
 * Web Serial 正常路径里 `reader.cancel()` 会让挂起的 read 立刻以 done 结束；但驱动异常、
 * 设备掉电时 read 可能永远不 settle。无限等待会把自动重连永久钉死在「重连中」
 * （实测：拔线 2.8 s 后仍 serial=false、重连次数 0）。这里只等有界时间，之后**照常尝试**
 * 释放并 close；close 失败会如实记账并返回 false，绝不在没关掉端口时谎称已释放。
 */
function settleWithin(p: Promise<unknown> | null | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  return Promise.race([
    Promise.resolve(p).then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/** Reader, read completion, port and generation are owned by the same session. */
export class SerialTransportSession {
  readonly lease: TransportSession<SerialTransportPort>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readDone: Promise<void> = Promise.resolve();
  private opened = false;
  /** 读锁释放窗口：只防「永不结束的 read」卡死重连，不缩短正常路径的等待。 */
  private static readonly RELEASE_WAIT_MS = 600;
  /** port.close() 的等待上限：驱动异常时 close 可能永不落定。 */
  static readonly CLOSE_WAIT_MS = 800;

  constructor(
    readonly port: SerialTransportPort,
    readonly generation: number,
    private readonly onOpen: () => void,
    private readonly onClose: (closed: boolean) => void,
  ) {
    this.lease = new TransportSession(port, generation, async (mine) => {
      const reader = this.reader;
      try {
        await settleWithin(reader?.cancel(), SerialTransportSession.RELEASE_WAIT_MS);
        await settleWithin(this.readDone, SerialTransportSession.RELEASE_WAIT_MS);
      } catch { /* cancel/read 的失败只在下面按 close 的实际结果记账。 */ }
      try { reader?.releaseLock(); } catch { /* 读仍未结束：锁还在，close 会失败并如实计数。 */ }
      if (!mine || !this.opened) {
        this.reader = null;
        return true;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        // close 本身也可能永不落定（驱动/蓝牙栈异常）。有界等待后如实返回 false；
        // 若它在后台稍后成功，补记"已关闭"，避免端口计数永久泄漏。
        const closing = Promise.resolve(port.close()).then(() => true, () => false);
        const outcome = await Promise.race([
          closing,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SerialTransportSession.CLOSE_WAIT_MS)),
        ]);
        if (outcome) {
          this.opened = false;
          this.reader = null;
          this.onClose(true);
          return true;
        }
        // 超时后 close 仍可能在后台成功：补记"已关闭"，否则 openPorts 会永久多 1。
        // 若它本来就已拒绝，这个回调是空操作。
        void closing.then((ok) => {
          if (ok && this.opened) {
            this.opened = false;
            this.reader = null;
            this.onClose(true);
          }
        });
      }
      // 端口仍开着：保留 reader/opened，下一次 dispose 会按当时的锁状态重试 close。
      this.onClose(false);
      return false;
    });
  }

  get disposed(): boolean { return this.lease.disposed; }
  get disposePromise(): Promise<boolean> | null { return this.lease.disposePromise; }

  open(baudRate: number): Promise<boolean> {
    return this.lease.setup(async () => {
      await this.port.open({ baudRate });
      // 迟到的 open：会话在等待期间已被释放——不能再把端口据为己有并泄漏一个已打开句柄。
      if (this.disposed) {
        try { await settleWithin(Promise.resolve(this.port.close()), SerialTransportSession.CLOSE_WAIT_MS); } catch { /* 尽力 */ }
        throw new Error("会话已作废：open 迟于 dispose");
      }
      this.opened = true;
      this.onOpen();
    });
  }

  async read(isCurrent: () => boolean, consume: (value: Uint8Array) => void): Promise<void> {
    if (this.disposed || !isCurrent() || !this.port.readable) return;
    const reader = this.port.readable.getReader();
    this.reader = reader;
    let complete!: () => void;
    this.readDone = new Promise<void>((resolve) => { complete = resolve; });
    try {
      while (!this.disposed && isCurrent()) {
        const { value, done } = await reader.read();
        if (this.disposed || !isCurrent() || done) break;
        if (value) consume(value);
      }
    } finally {
      complete(); // dispose waits here before releaseLock / close.
    }
  }

  dispose(): Promise<boolean> { return this.lease.dispose(); }
}

export interface NotificationHandle {
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
}

/** Serialize start/stop/rollback, including same-characteristic rapid selections. */
export class NotificationSession<C extends NotificationHandle> {
  current: C | null = null;
  private version = 0;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listener: (ev: { target: C }) => void;

  constructor(private readonly hooks: {
    valid: () => boolean;
    attach: (char: C, listener: (ev: { target: C }) => void) => void;
    detach: (char: C, listener: (ev: { target: C }) => void) => void;
    notify: (ev: { target: C }) => void;
  }) {
    this.listener = (ev) => {
      if (!this.disposed && this.hooks.valid() && this.current === ev.target) this.hooks.notify(ev);
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  subscribe(char: C, belongs: () => boolean = this.hooks.valid): Promise<boolean> {
    const version = ++this.version;
    const valid = (): boolean => !this.disposed && version === this.version && this.hooks.valid() && belongs();
    const stop = async (target: C): Promise<void> => {
      this.hooks.detach(target, this.listener);
      try { await target.stopNotifications(); } catch { /* Disconnected. */ }
    };
    return this.enqueue(async () => {
      if (!valid()) return false;
      const previous = this.current;
      this.current = null;
      if (previous) await stop(previous);
      if (!valid()) return false;
      try {
        await char.startNotifications();
        if (!valid()) { await stop(char); return false; }
        this.hooks.attach(char, this.listener);
        this.current = char;
        return true;
      } catch (error) {
        await stop(char); // A failed start may still have enabled notifications.
        if (!valid()) return false;
        if (previous) {
          try {
            await previous.startNotifications();
            if (!valid()) { await stop(previous); return false; }
            this.hooks.attach(previous, this.listener);
            this.current = previous;
          } catch {
            await stop(previous);
            if (!valid()) return false;
          }
        }
        throw error;
      }
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    ++this.version;
    return this.enqueue(async () => {
      const char = this.current;
      this.current = null;
      if (!char) return;
      this.hooks.detach(char, this.listener);
      try { await char.stopNotifications(); } catch { /* Disconnected. */ }
    });
  }
}
