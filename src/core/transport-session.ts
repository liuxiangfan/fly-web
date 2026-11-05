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
  /**
   * **主动连接动作**的上限（serial open / GATT connect / 服务与特征发现）。
   *
   * 为什么必须有它：`SETUP_WAIT_MS` 只保护「释放」，不保护「连接」。
   * `SerialPort.open()`、`gatt.connect()`、`getPrimaryService()`、`getCharacteristics()`
   * 在驱动、USB 转串口芯片或蓝牙栈异常时**可以永不落定**——旧实现下连接按钮会永远停在
   * 「正在连接…」，句柄一直悬空，用户若不主动断开就再没有别的入口能把它收回来（复核 P1）。
   * 超时即判定失败、抛出明确错误进入错误状态；迟到的成功也会走到 work 内部的
   * `if (this.disposed)` 分支自行关闭句柄，不漏端口。
   */
  static setupTimeoutMs = 8000;
  disposed = false;
  disposePromise: Promise<boolean> | null = null;
  private setupPromise: Promise<boolean> | null = null;
  /**
   * 底层 open/connect 是否**真的**落定。
   *
   * 为什么必须与"外层等待"分开存（复核 SW-05）：`await Promise.race([run, timeout])` 结束时
   * 只说明"我们不等了"，底层 Promise 可能仍在飞。旧实现拿这个结果当"setup 已结束"，
   * 于是 `dispose()` 会把仍未落定的句柄**当成已释放**（删除 owner、返回 true），
   * 新会话因此可以接管同一个句柄——而迟到的 open 完成时又会去关掉这个（已属于新会话的）端口。
   */
  private rawSettled = true;
  /** 底层动作的落定信号（永不拒绝）：dispose 等它，而不是等外层 race 的结果 */
  private rawSettlePromise: Promise<void> | null = null;

  constructor(
    readonly handle: H,
    readonly generation: number,
    private readonly cleanup: (ownsHandle: boolean) => Promise<boolean>,
  ) {}

  get rawOperationSettled(): boolean { return this.rawSettled; }
  /** 本会话此刻是否仍持有该句柄（迟到清理必须据此决定"能不能碰这个端口"） */
  ownsHandle(): boolean { return handleOwners.get(this.handle) === (this as unknown as TransportSession<object>); }
  /** 交还句柄所有权（仅在本会话已经自行关闭句柄之后调用） */
  releaseOwnership(): void { if (this.ownsHandle()) handleOwners.delete(this.handle); }

  setup(work: () => Promise<void>): Promise<boolean> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = serializeHandle(this.handle, async () => {
      const previous = handleOwners.get(this.handle);
      if (previous && previous !== this && !(await previous.dispose())) {
        throw new Error("上一会话的设备句柄未能释放");
      }
      if (this.disposed) return false;
      handleOwners.set(this.handle, this as unknown as TransportSession<object>);
      // work() 的拒绝必须原样上抛；超时必须与"拒绝"区分开，否则"连接失败"会被当成成功。
      let settled = false;
      let failure: unknown = null;
      this.rawSettled = false;
      const run = work().then(
        () => { settled = true; this.rawSettled = true; },
        (err: unknown) => { settled = true; this.rawSettled = true; failure = err; },
      );
      this.rawSettlePromise = run;
      let expired = false;
      let fireTimeout!: () => void;
      const timeout = new Promise<void>((resolve) => { fireTimeout = resolve; });
      setTimeout(() => { if (!settled) { expired = true; fireTimeout(); } }, TransportSession.setupTimeoutMs);
      await Promise.race([run, timeout]);
      if (expired) {
        // 标为作废：迟到的 open/connect 完成时，work 内部会看到 disposed 并自行关闭句柄。
        this.disposed = true;
        throw new Error(`连接动作超时（${TransportSession.setupTimeoutMs} ms 内未完成：open / GATT 连接 / 服务发现无响应）`);
      }
      if (failure) throw failure;
      return !this.disposed;
    });
    return this.setupPromise;
  }

  dispose(): Promise<boolean> {
    this.disposed = true; // Invalidate callbacks before the first await.
    if (this.disposePromise) return this.disposePromise;
    const run = (async () => {
      // 只等**底层动作真的落定**（有界）：外层 race 的超时只说明"我们不等了"，不代表句柄安全。
      // 未落定时仍照常尝试清理，但不会声称"已释放"——调用方（隔离队列）保留引用并重试。
      if (!this.rawSettled && this.rawSettlePromise) {
        await Promise.race([
          this.rawSettlePromise.then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TransportSession.SETUP_WAIT_MS)),
        ]);
      }
      const mine = this.ownsHandle();
      let closed = false;
      try { closed = await this.cleanup(mine); } catch { /* Keep failed lease. */ }
      if (mine && closed && this.rawSettled && this.ownsHandle()) {
        handleOwners.delete(this.handle);
      }
      // 底层动作未落定 → 句柄可能稍后才被打开/接管，不能声称"已释放"；调用方应保留引用并重试。
      return closed && this.rawSettled;
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
        if (outcome) { this.settleClosed(); return true; }
        // 超时后 close 仍可能在后台成功：补记"已关闭"。
        // 记账必须**幂等**：第一次尝试的迟到成功与第二次尝试的成功都会走到这里，
        // 旧实现各记一次 onClose(true)，会把另一个仍在使用的端口计数一起减掉（复核 SW-05）。
        void closing.then((ok) => { if (ok) this.settleClosed(); });
      }
      // 端口仍开着：保留 reader/opened，下一次 dispose 会按当时的锁状态重试 close。
      this.onClose(false);
      return false;
    });
  }

  /** 关闭记账必须幂等：一次 opened → closed 只允许回调一次（两次 close 交错完成时旧实现记两次）。 */
  private settleClosed(): void {
    if (!this.opened) return;
    this.opened = false;
    this.reader = null;
    this.onClose(true);
  }

  get disposed(): boolean { return this.lease.disposed; }
  get disposePromise(): Promise<boolean> | null { return this.lease.disposePromise; }

  open(baudRate: number): Promise<boolean> {
    return this.lease.setup(async () => {
      await this.port.open({ baudRate });
      // 迟到的 open：会话在等待期间已被释放——不能再把端口据为己有并泄漏一个已打开句柄。
      if (this.disposed) {
        // **只有句柄仍归本会话时**才由我们关闭：若它已经被新会话接管，关掉的就是别人的端口
        // （复核 SW-05：旧会话迟到完成会把新连接的端口一起关掉）。所有权仍归我时才自行清理。
        if (this.lease.ownsHandle()) {
          try { await settleWithin(Promise.resolve(this.port.close()), SerialTransportSession.CLOSE_WAIT_MS); } catch { /* 尽力 */ }
          this.lease.releaseOwnership();
        }
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

/**
 * 有界等待一次可能永不落定的蓝牙动作，并**区分**三种结局：
 * 成功 / 失败（原样带出错误）/ 超时（timedOut）。
 *
 * 为什么不能只做 `race + 吞掉错误`：那样"startNotifications 被拒绝"会被当成成功提交，
 * 界面显示"已订阅"、实际一条数据都不会来（生命周期契约里的回滚用例就是抓这个）。
 */
async function boundedNotify(
  p: Promise<unknown>,
  ms: number,
): Promise<{ timedOut: boolean; error: unknown; raw: Promise<void> }> {
  let settled = false;
  let failure: unknown = null;
  const run = Promise.resolve(p).then(() => { settled = true; }, (err: unknown) => { settled = true; failure = err; });
  let expired = false;
  let fireTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => { fireTimeout = resolve; });
  setTimeout(() => { if (!settled) { expired = true; fireTimeout(); } }, ms);
  await Promise.race([run, timeout]);
  // raw 也要带出去：超时后**原始动作仍可能落定**，调用方需要据此做补偿清理（复核 SW-05）
  return { timedOut: expired, error: failure, raw: run };
}

/** Serialize start/stop/rollback, including same-characteristic rapid selections. */
export class NotificationSession<C extends NotificationHandle> {
  /**
   * `startNotifications()` / `stopNotifications()` 的上限：蓝牙栈异常时它们同样可以
   * 永不落定，于是订阅按钮永远停在等待、句柄一直悬空（复核 P1）。
   */
  static notifyTimeoutMs = 5000;
  current: C | null = null;
  private version = 0;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * 超时但仍未落定的 stop：该特征先**隔离**，直到原始 stop 真正结束。
   *
   * 复核 SW-05：旧实现超时后直接让队列继续，重新订阅同一个特征时 start 会与迟到的 stop 交错——
   * 表现为"界面显示已订阅、实际通知已被关掉"。隔离 + 等待把这种情况变成确定的结果：
   * 要么等到旧 stop 落定再订阅，要么明确报"暂不可订阅"。
   */
  private pendingStops = new Map<C, Promise<void>>();
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

  /**
   * 退订一个特征：**先摘监听**（卡住也不会再有回调打进队列），再有界等待 stop；
   * 超时则把该特征隔离到原始 stop 落定为止。
   */
  private async stop(target: C): Promise<boolean> {
    this.hooks.detach(target, this.listener);
    const res = await boundedNotify(Promise.resolve(target.stopNotifications()), NotificationSession.notifyTimeoutMs);
    if (res.timedOut) {
      const raw = res.raw;
      this.pendingStops.set(target, raw);
      void raw.then(() => { if (this.pendingStops.get(target) === raw) this.pendingStops.delete(target); });
      return false;
    }
    return true;
  }

  /** 等一个被隔离的特征真正关闭；超时返回 false（调用方据此明确拒绝，而不是冒交错的风险） */
  private async waitPendingStop(char: C): Promise<boolean> {
    const pending = this.pendingStops.get(char);
    if (!pending) return true;
    return Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), NotificationSession.notifyTimeoutMs)),
    ]);
  }

  subscribe(char: C, belongs: () => boolean = this.hooks.valid): Promise<boolean> {
    const version = ++this.version;
    const valid = (): boolean => !this.disposed && version === this.version && this.hooks.valid() && belongs();
    return this.enqueue(async () => {
      if (!valid()) return false;
      // 同一个特征上一次 stop 还没落定：先等（隔离），等不到就明确拒绝——不能让 start 与迟到 stop 交错
      if (!(await this.waitPendingStop(char))) {
        throw new Error("该特征的通知仍在关闭中（stopNotifications 未落定），暂不可订阅");
      }
      if (!valid()) return false;
      const previous = this.current;
      this.current = null;
      if (previous && !(await this.stop(previous))) {
        // 上一个特征的通知还没真正关掉：此刻 start 会与迟到的 stop 交错（表现是"已订阅但不来数据"），
        // 因此明确拒绝，并让该特征留在隔离表里等下一次订阅（复核 SW-05）。
        throw new Error("上一个特征的通知仍在关闭中（stopNotifications 未落定），暂不可订阅");
      }
      if (!valid()) return false;
      try {
        const started = await boundedNotify(Promise.resolve(char.startNotifications()), NotificationSession.notifyTimeoutMs);
        if (started.timedOut) {
          // 迟到的 start 仍可能真把通知打开：等它落定后补一次 stop，别让"已放弃的订阅"复活
          void started.raw.then(() => this.stop(char), () => undefined);
          throw new Error(`startNotifications 超时（${NotificationSession.notifyTimeoutMs} ms 无响应）`);
        }
        if (started.error) throw started.error;
        if (!valid()) { await this.stop(char); return false; }
        this.hooks.attach(char, this.listener);
        this.current = char;
        return true;
      } catch (error) {
        await this.stop(char); // A failed start may still have enabled notifications.
        if (!valid()) return false;
        if (previous) {
          const back = await boundedNotify(Promise.resolve(previous.startNotifications()), NotificationSession.notifyTimeoutMs);
          if (back.timedOut || back.error) {
            if (back.timedOut) void back.raw.then(() => this.stop(previous), () => undefined);
            await this.stop(previous);
            if (!valid()) return false;
          } else {
            if (!valid()) { await this.stop(previous); return false; }
            this.hooks.attach(previous, this.listener);
            this.current = previous;
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
      await this.stop(char); // 结果不参与返回值：超时已登记进隔离表，交给后续重试
    });
  }
}
