export interface ChartSeries {
  label: string;
  color: string;
  /** 虚线样式（A/B 对比的 B 组用）；缺省实线 */
  dash?: number[];
}

/** 滚动时序折线图（Canvas 2D 手绘，深色主题） */
export class RollingChart {
  private ctx: CanvasRenderingContext2D;
  private cap: number;
  private times: Float64Array;
  private vals: Float64Array;
  private count = 0;
  private head = 0;
  private visible: boolean[];
  private windowSec: number;
  private unit: string;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  /** 共享时间游标（秒）；null = 不画。由主程序在暂停/悬停时设置 */
  private cursorT: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private series: ChartSeries[],
    opts: { windowSec?: number; unit?: string } = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.windowSec = opts.windowSec ?? 30;
    this.unit = opts.unit ?? "";
    this.cap = Math.ceil(this.windowSec * 25) + 8; // 25 Hz 记录
    this.times = new Float64Array(this.cap);
    this.vals = new Float64Array(this.cap * series.length);
    this.visible = series.map(() => true);
    this.observeResize();
  }

  /** 只读尺寸：长跑自检用（环形缓冲的 count 必须封顶在 cap，不能随时间增长） */
  get size(): { count: number; cap: number } {
    return { count: this.count, cap: this.cap };
  }

  setVisible(mask: boolean[]): void {
    this.visible = mask;
    this.render();
  }

  /** 运行时换色（色觉友好配色切换用）：只改系列颜色并重绘，不动数据 */
  setSeriesColors(colors: (string | undefined)[]): void {
    colors.forEach((c, i) => {
      if (c && this.series[i]) this.series[i].color = c;
    });
    this.render();
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    this.cursorT = null;
    this.render();
  }

  /** 设置共享时间游标（秒）；Charts 之间由主程序同步同一个 t */
  setCursor(t: number | null): void {
    this.cursorT = t !== null && Number.isFinite(t) ? t : null;
    this.render();
  }

  /** 当前可见时间窗 [t0, t1]（秒） */
  timeRange(): { t0: number; t1: number } {
    const t1 = this.count > 0 ? this.times[(this.head - 1 + this.cap) % this.cap] : 0;
    return { t0: t1 - this.windowSec, t1 };
  }

  /** 时间 t 处各系列的最接近样本；无数据返回 null */
  sampleAt(t: number): { t: number; values: number[] } | null {
    if (this.count === 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < this.count; k++) {
      const idx = (this.head - this.count + k + this.cap) % this.cap;
      const d = Math.abs(this.times[idx] - t);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
    const values: number[] = [];
    for (let s = 0; s < this.series.length; s++) values.push(this.vals[s * this.cap + best]);
    return { t: this.times[best], values };
  }

  push(t: number, values: number[]): void {
    this.times[this.head] = t;
    for (let s = 0; s < this.series.length; s++) {
      this.vals[s * this.cap + this.head] = values[s] ?? NaN;
    }
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
  }

  private observeResize(): void {
    const sync = () => {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (w === 0 || h === 0) return;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.render();
    };
    new ResizeObserver(sync).observe(this.canvas);
  }

  render(): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 44;
    const padR = 8;
    const padT = 8;
    const padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    const t1 = this.count > 0 ? this.times[(this.head - 1 + this.cap) % this.cap] : 1;
    const t0 = t1 - this.windowSec;

    // 可见范围 y 极值
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let s = 0; s < this.series.length; s++) {
      if (!this.visible[s]) continue;
      for (let k = 0; k < this.count; k++) {
        const idx = (this.head - this.count + k + this.cap) % this.cap;
        const t = this.times[idx];
        if (t < t0) continue;
        const v = this.vals[s * this.cap + idx];
        if (Number.isFinite(v)) {
          if (v < ymin) ymin = v;
          if (v > ymax) ymax = v;
        }
      }
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) {
      ymin = -1;
      ymax = 1;
    }
    if (ymin >= 0) ymin = 0; // 误差图等从 0 起
    if (ymax - ymin < 1e-9) {
      ymax += 1;
      ymin -= 1;
    }
    const padY = (ymax - ymin) * 0.08;
    ymin -= padY;
    ymax += padY;

    const xOf = (t: number) => padL + ((t - t0) / this.windowSec) * plotW;
    const yOf = (v: number) => padT + plotH - ((v - ymin) / (ymax - ymin)) * plotH;

    // 网格与坐标
    // 网格与坐标：与 CSS 设计令牌 --border / --text-faint 对齐
    ctx.font = `10.5px "Fira Code", "Cascadia Code", Consolas, monospace`;
    ctx.strokeStyle = "#1a2540";
    ctx.fillStyle = "#7b8aa3";
    ctx.lineWidth = 1;
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const v = ymin + ((ymax - ymin) * i) / gridN;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(this.fmt(v), padL - 5, y + 3.5);
    }
    for (let s = 5; s <= this.windowSec; s += 5) {
      const x = Math.round(xOf(t1 - s)) + 0.5;
      // 刚开始记录时 −25s/−30s 落在绘图区左侧之外：不画屏外刻度，
      // 否则文字会压到 y 轴标签或画布边缘
      if (x < padL + 2) continue;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(`-${s}s`, x, h - 6);
    }

    // 零线加亮
    if (ymin < 0 && ymax > 0) {
      ctx.strokeStyle = "#2d3c5e";
      ctx.beginPath();
      const y0 = Math.round(yOf(0)) + 0.5;
      ctx.moveTo(padL, y0);
      ctx.lineTo(w - padR, y0);
      ctx.stroke();
    }

    // 数据折线
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    for (let s = 0; s < this.series.length; s++) {
      if (!this.visible[s]) continue;
      ctx.strokeStyle = this.series[s].color;
      ctx.setLineDash(this.series[s].dash ?? []);
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < this.count; k++) {
        const idx = (this.head - this.count + k + this.cap) % this.cap;
        const t = this.times[idx];
        if (t < t0) continue;
        const v = this.vals[s * this.cap + idx];
        if (!Number.isFinite(v)) continue;
        const x = xOf(t);
        const y = yOf(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 共享时间游标：竖线 + 各可见系列的采样点（暂停后逐帧分析用）
    if (this.cursorT !== null && this.cursorT >= t0 && this.cursorT <= t1 + 1e-9) {
      const cx = Math.round(xOf(this.cursorT)) + 0.5;
      ctx.strokeStyle = "#e6edf3";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let s = 0; s < this.series.length; s++) {
        if (!this.visible[s]) continue;
        const sample = this.sampleAt(this.cursorT);
        const v = sample?.values[s] ?? NaN;
        if (!Number.isFinite(v)) continue;
        ctx.fillStyle = this.series[s].color;
        ctx.beginPath();
        ctx.arc(cx, yOf(v), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private fmt(v: number): string {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }

  latest(): number[] {
    const out: number[] = [];
    const last = (this.head - 1 + this.cap) % this.cap;
    for (let s = 0; s < this.series.length; s++) {
      out.push(this.count > 0 ? this.vals[s * this.cap + last] : NaN);
    }
    return out;
  }

  get unitLabel(): string {
    return this.unit;
  }
}
