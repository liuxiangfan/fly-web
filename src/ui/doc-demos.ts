/**
 * 文档页内的六个交互小演示（互补滤波三路对比 / 旋转顺序 / 校准舞蹈 /
 * Allan 方差 / 一维卡尔曼 / 互补频域）。
 *
 * 与主仿真完全解耦：不参与主状态机，只在文档层打开、且停留在对应页时运转
 * （由宿主经 {@link DocDemoHost.isVisible} 告知）。两个静态演示只在控件变化
 * 时重绘；四个动画演示由主循环每帧调用 step(dt) 推进。
 */
import { qFromEuler, qRotInv, RAD, type Quat, type V3 } from "../core/quat";
import { mulberry32 } from "../core/rng";
import { allanDeviation, synthesizeGyroAngle } from "../core/allan";

export interface DocDemoHost {
  /** 文档层已打开、且当前停留的正是 page 时返回 true */
  isVisible(page: string): boolean;
}

export interface DocDemos {
  /** 主循环每帧调用：推进当前可见页的动画演示 */
  step(dt: number): void;
  /** 文档层开合 / 翻页后调用：重算各演示的运转开关 */
  refresh(): void;
}

/** 由 initDocDemos 注入（本模块只服务一个文档层，故用模块级单例） */
let hostVisible: (page: string) => boolean = () => false;

/* ==========================================================================
   文档内交互演示：静态两类（一维卡尔曼 / 互补频域）——只在控件变化时重绘
   ========================================================================== */


/** 取文档演示控件（无 id，靠 data-dock 键区分，故不参与主滑杆系统与深链） */
function dockInput(fig: HTMLElement | null, key: string): HTMLInputElement | null {
  return fig ? fig.querySelector<HTMLInputElement>(`input[data-dock="${key}"]`) : null;
}

/** 文档演示里的浅色主题配色（与内联 SVG 图一致） */
const DOC_COLORS = {
  ink: "#16202f",
  dim: "#58667b",
  grid: "#e5eaf2",
  prior: "#94a3b8",
  obs: "#d97706",
  post: "#059669",
  hp: "#0b688a",
  lp: "#7c3aed",
  band: "#eef2f8",
};

/** 一维卡尔曼最优加权：先验 × 观测 → 后验（高斯乘积） */
function drawKf1d(): void {
  const fig = document.getElementById("fig-kf1d-demo")?.closest("figure") as HTMLElement | null;
  const c = document.getElementById("fig-kf1d-demo") as HTMLCanvasElement | null;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const W = c.width, H = c.height;
  const s1 = Number(dockInput(fig, "kf-s1")?.value ?? 1.2);
  const s2 = Number(dockInput(fig, "kf-s2")?.value ?? 0.8);
  const x1 = 0; // 先验均值（当前信念）
  const x2 = 4; // 观测读数（故意与先验差得远，便于看清「谁被拉向谁」）

  // 高斯融合 —— 就是卡尔曼更新的一维形式
  const w1 = 1 / (s1 * s1);
  const w2 = 1 / (s2 * s2);
  const postVar = 1 / (w1 + w2);
  const postMean = (x1 * w1 + x2 * w2) * postVar;
  const postSd = Math.sqrt(postVar);
  const K = (s1 * s1) / (s1 * s1 + s2 * s2); // 观测权重（卡尔曼增益）

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const L = 52, R = 236, T = 26, B = 34;
  const xMin = -5, xMax = 7;
  const plotW = W - L - R, plotH = H - T - B;
  const X = (x: number): number => L + ((x - xMin) / (xMax - xMin)) * plotW;
  const Y = (v: number): number => T + plotH - v * plotH; // v ∈ [0,1] 归一化高度
  const gauss = (x: number, mu: number, sd: number): number =>
    Math.exp(-((x - mu) * (x - mu)) / (2 * sd * sd));

  // 网格与横轴
  ctx.strokeStyle = DOC_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  for (const gx of [-4, -2, 0, 2, 4, 6]) {
    const px = Math.round(X(gx)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, T);
    ctx.lineTo(px, T + plotH);
    ctx.stroke();
    ctx.fillStyle = DOC_COLORS.dim;
    ctx.textAlign = "center";
    ctx.fillText(String(gx), px, T + plotH + 16);
  }
  ctx.strokeStyle = "#b9c6d8";
  ctx.beginPath();
  ctx.moveTo(L, T + plotH + 0.5);
  ctx.lineTo(W - R, T + plotH + 0.5);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = DOC_COLORS.dim;
  ctx.fillText("状态值 x", L, T + plotH + 30);

  const curve = (mu: number, sd: number, color: string, fill: boolean): void => {
    ctx.beginPath();
    for (let i = 0; i <= 220; i++) {
      const x = xMin + ((xMax - xMin) * i) / 220;
      const y = Y(gauss(x, mu, sd) * 0.92);
      if (i === 0) ctx.moveTo(X(x), y);
      else ctx.lineTo(X(x), y);
    }
    if (fill) {
      ctx.save();
      ctx.lineTo(X(xMax), Y(0));
      ctx.lineTo(X(xMin), Y(0));
      ctx.closePath();
      ctx.fillStyle = color + "22";
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  curve(x1, s1, DOC_COLORS.prior, false);
  curve(x2, s2, DOC_COLORS.obs, false);
  curve(postMean, postSd, DOC_COLORS.post, true);

  // 后验均值竖线
  ctx.strokeStyle = DOC_COLORS.post;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(X(postMean), T + 6);
  ctx.lineTo(X(postMean), T + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // 图例与数值读数（图外右侧）
  const lx = W - R + 16;
  let ly = T + 12;
  const legend: Array<[string, string]> = [
    [DOC_COLORS.prior, `先验 N(${x1}, σ₁=${s1.toFixed(2)})`],
    [DOC_COLORS.obs, `观测 N(${x2}, σ₂=${s2.toFixed(2)})`],
    [DOC_COLORS.post, `后验 N(${postMean.toFixed(2)}, ${postSd.toFixed(2)})`],
  ];
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 7, 14, 3);
    ctx.fillStyle = DOC_COLORS.dim;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 20, ly - 2);
    ly += 19;
  }
  ctx.fillStyle = DOC_COLORS.ink;
  ctx.font = "600 13px ui-monospace, monospace";
  ctx.fillText(`K = ${K.toFixed(3)}`, lx, ly + 14);
  ctx.font = "11.5px sans-serif";
  ctx.fillStyle = DOC_COLORS.dim;
  ctx.fillText(`后验方差 ${postVar.toFixed(3)}`, lx, ly + 32);
  ctx.fillText(`（先验 ${(s1 * s1).toFixed(2)} · 观测 ${(s2 * s2).toFixed(2)}）`, lx, ly + 48);
  ctx.fillText(K > 0.85 ? "→ 更信观测" : K < 0.15 ? "→ 更信先验（K→0 即纯预测）" : "→ 势均力敌", lx, ly + 68);

  const v1 = fig?.querySelector<HTMLElement>('[data-dockval="kf-s1"]');
  const v2 = fig?.querySelector<HTMLElement>('[data-dockval="kf-s2"]');
  if (v1) v1.textContent = `σ₁² = ${(s1 * s1).toFixed(2)}`;
  if (v2) v2.textContent = `σ₂² = ${(s2 * s2).toFixed(2)}`;
}

/** 互补滤波的频域互补：陀螺高通 + 加计低通，交点是截止频率 */
function drawBode(): void {
  const fig = document.getElementById("fig-bode-demo")?.closest("figure") as HTMLElement | null;
  const c = document.getElementById("fig-bode-demo") as HTMLCanvasElement | null;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const W = c.width, H = c.height;
  const alpha = Number(dockInput(fig, "bode-alpha")?.value ?? 1);
  const fc = alpha / (2 * Math.PI); // Hz：一阶互补的转折频率
  const tau = 1 / alpha; // s：等效时间常数

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const L = 54, R = 216, T = 26, B = 40;
  const f0 = 0.01, f1 = 100;
  const plotW = W - L - R, plotH = H - T - B;
  const X = (f: number): number =>
    L + ((Math.log10(f) - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0))) * plotW;
  const Y = (v: number): number => T + plotH - v * plotH;

  // 两个典型信号频带（机动 / 电机振动）
  const band = (a: number, b: number, label: string): void => {
    ctx.fillStyle = DOC_COLORS.band;
    ctx.fillRect(X(a), T, X(b) - X(a), plotH);
    if (label) {
      ctx.fillStyle = DOC_COLORS.dim;
      ctx.font = "10.5px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, (X(a) + X(b)) / 2, T + 12);
    }
  };
  band(0.1, 1, "机动");
  band(25, 45, "振动");
  band(45, 100, "");

  // 网格：频率十进位 + 幅度参考线
  ctx.strokeStyle = DOC_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = "10.5px sans-serif";
  for (const f of [0.01, 0.1, 1, 10, 100]) {
    const px = Math.round(X(f)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, T);
    ctx.lineTo(px, T + plotH);
    ctx.stroke();
    ctx.fillStyle = DOC_COLORS.dim;
    ctx.textAlign = "center";
    ctx.fillText(f < 1 ? f.toFixed(2) : String(f), px, T + plotH + 15);
  }
  for (const v of [0, 0.5, 0.707, 1]) {
    const py = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L, py);
    ctx.lineTo(W - R, py);
    ctx.stroke();
    ctx.fillStyle = DOC_COLORS.dim;
    ctx.textAlign = "right";
    ctx.fillText(v === 0.707 ? "0.707" : v.toFixed(1), L - 5, py + 3.5);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = DOC_COLORS.dim;
  ctx.fillText("频率 f（Hz）", L, H - 8);
  ctx.save();
  ctx.translate(14, T + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("通道增益", 0, 0);
  ctx.restore();

  const draw = (fn: (f: number) => number, color: string): void => {
    ctx.beginPath();
    for (let i = 0; i <= 260; i++) {
      const f = Math.pow(10, Math.log10(f0) + (Math.log10(f1) - Math.log10(f0)) * (i / 260));
      const y = Y(fn(f));
      if (i === 0) ctx.moveTo(X(f), y);
      else ctx.lineTo(X(f), y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  };
  const lp = (f: number): number => 1 / Math.sqrt(1 + (f / fc) ** 2);
  const hp = (f: number): number => (f / fc) / Math.sqrt(1 + (f / fc) ** 2);
  draw(lp, DOC_COLORS.lp);
  draw(hp, DOC_COLORS.hp);

  // 交叉点（两线相等 = 1/√2 ≈ 0.707）
  const px = X(Math.min(Math.max(fc, f0), f1));
  const py = Y(0.7071);
  ctx.strokeStyle = DOC_COLORS.ink;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px, T + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = DOC_COLORS.ink;
  ctx.beginPath();
  ctx.arc(px, py, 3.6, 0, Math.PI * 2);
  ctx.fill();

  // 图例与读数
  const lx = W - R + 14;
  let ly = T + 12;
  const legend: Array<[string, string]> = [
    [DOC_COLORS.hp, "陀螺仪通道：高通"],
    [DOC_COLORS.lp, "加速度计通道：低通"],
  ];
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 7, 14, 3);
    ctx.fillStyle = DOC_COLORS.dim;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 20, ly - 2);
    ly += 19;
  }
  ctx.fillStyle = DOC_COLORS.ink;
  ctx.font = "600 12.5px ui-monospace, monospace";
  ctx.fillText(`α = ${alpha.toFixed(1)} 1/s`, lx, ly + 14);
  ctx.fillText(`f_c = ${fc < 0.1 ? fc.toFixed(3) : fc.toFixed(2)} Hz`, lx, ly + 32);
  ctx.font = "11.5px sans-serif";
  ctx.fillStyle = DOC_COLORS.dim;
  ctx.fillText(`τ = 1/α = ${tau.toFixed(2)} s`, lx, ly + 50);
  ctx.fillText("交点偏左：", lx, ly + 72);
  ctx.fillText("更信加计（跟得慢）", lx, ly + 88);
  ctx.fillText("交点偏右：", lx, ly + 108);
  ctx.fillText("更信陀螺（漂得快）", lx, ly + 124);

  const dv = fig?.querySelector<HTMLElement>('[data-dockval="bode-alpha"]');
  if (dv) dv.textContent = `f_c = ${fc.toFixed(2)} Hz`;
}

/** 绑定两个文档演示的控件；首次加载时各绘一次 */
function initDocDockDemos(): void {
  const kfFig = document.getElementById("fig-kf1d-demo")?.closest("figure") as HTMLElement | null;
  const bodeFig = document.getElementById("fig-bode-demo")?.closest("figure") as HTMLElement | null;
  for (const key of ["kf-s1", "kf-s2"]) {
    dockInput(kfFig, key)?.addEventListener("input", () => drawKf1d());
  }
  dockInput(bodeFig, "bode-alpha")?.addEventListener("input", () => drawBode());
  drawKf1d();
  drawBode();
}

// ---------- 文档页小演示：互补滤波三路信号实时对比 ----------
const compDemoCanvas = document.getElementById("fig-comp-demo") as HTMLCanvasElement | null;
const compDemoCtx = compDemoCanvas ? compDemoCanvas.getContext("2d") : null;
let compDemoRunning = false;
let compDemoT = 0;
const cdState = { gyro: 0, fused: 0 };
const cdBuf: number[][] = [[], [], [], []];
const CD_N = 560; // 一轮样本数（画满即停顿重播，起点永远在左端）
const CD_HOLD = 1.4; // 画满后的停顿秒数
let cdHoldT = 0;
const CD_COLORS = ["#16202f", "#e5484d", "#94a3b8", "#d97706"];

/** 演示运转开关：文档层开着且停留在对应页才运转（翻页/开合时刷新，主循环每帧读） */
function refreshDocDemoRun(): void {
  compDemoRunning = hostVisible("filters") && compDemoCtx !== null;
  orderDemoRunning = hostVisible("math") && orderDemoCtx !== null;
  calibDemoRunning = hostVisible("math") && calibDemoCtx !== null;
  if (hostVisible("math")) drawAllan(); // 惰性一次绘制
}

function stepCompDemo(dt: number): void {
  if (!compDemoCtx || !compDemoCanvas) return;
  if (cdBuf[0].length >= CD_N) {
    // 停顿相位：冻结画面，倒计时结束后清空从头重播
    cdHoldT += dt;
    if (cdHoldT < CD_HOLD) return;
    cdHoldT = 0;
    compDemoT = 0;
    cdState.gyro = 0;
    cdState.fused = 0;
    for (const b of cdBuf) b.length = 0;
    drawCompDemo();
    return;
  }
  compDemoT += dt;
  const truth = 16 * Math.sin(0.55 * compDemoT) + 7 * Math.sin(0.17 * compDemoT);
  const dTruth =
    16 * 0.55 * Math.cos(0.55 * compDemoT) + 7 * 0.17 * Math.cos(0.17 * compDemoT);
  const gyroRate = dTruth + 0.8 + (Math.random() - 0.5) * 4; // 陀螺仪：零偏 0.8°/s + 噪声
  const accel = truth + (Math.random() - 0.5) * 26; // 加速度计：重噪声、不漂
  cdState.gyro += gyroRate * dt;
  cdState.fused += gyroRate * dt + 1.4 * (accel - cdState.fused) * dt; // 互补 α=1.4
  cdBuf[0].push(truth);
  cdBuf[1].push(cdState.gyro);
  cdBuf[2].push(accel);
  cdBuf[3].push(cdState.fused);
  drawCompDemo();
}

function drawCompDemo(): void {
  if (!compDemoCtx || !compDemoCanvas) return;
  const ctx = compDemoCtx;
  const W = compDemoCanvas.width;
  const H = compDemoCanvas.height;
  const L = 40, T = 34, B = 16, R = 8; // 顶部 34px 留给图例，曲线不与图例重叠
  const mid = T + (H - T - B) / 2;
  const sc = (H - T - B) / 2 / 40;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#e5eaf2";
  ctx.lineWidth = 1;
  for (const v of [-30, -15, 15, 30]) {
    ctx.beginPath();
    ctx.moveTo(L, mid - v * sc);
    ctx.lineTo(W - R, mid - v * sc);
    ctx.stroke();
  }
  ctx.strokeStyle = "#c9d4e4";
  ctx.beginPath();
  ctx.moveTo(L, mid);
  ctx.lineTo(W - R, mid);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, H - B);
  ctx.stroke();
  const n = cdBuf[0].length;
  if (n >= 2) {
    // 绘制顺序：噪声→陀螺仪→融合（半透明）→真实（最后画、最粗，保证黑线可见）
    const widths = [2.2, 1.5, 1, 2.2];
    const alphas = [1, 1, 1, 0.8];
    for (const k of [2, 1, 3, 0]) {
      const buf = cdBuf[k];
      ctx.strokeStyle = CD_COLORS[k];
      ctx.lineWidth = widths[k];
      ctx.globalAlpha = alphas[k];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = L + ((W - L - R) * i) / (CD_N - 1);
        const y = mid - Math.max(-38, Math.min(38, buf[i])) * sc;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  // 当前时刻圆点（描画笔头）：四路信号各自的最新点
  if (n >= 1) {
    cdBuf.forEach((buf, k) => {
      const x = L + ((W - L - R) * (n - 1)) / (CD_N - 1);
      const y = mid - Math.max(-38, Math.min(38, buf[n - 1])) * sc;
      ctx.beginPath();
      ctx.arc(x, y, k === 3 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = CD_COLORS[k];
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    });
  }
  // 起点：左端刻度（图例行下方，不再与图例挤在一行）
  ctx.strokeStyle = "#b9c6d8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(L, 24);
  ctx.lineTo(L, H - B);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText("起点", L + 5, 30);
  ctx.fillStyle = "#58667b";
  ctx.fillText("起点", L + 5, 30);
  // 底部进度条：本轮画到哪了
  const prog = n / CD_N;
  ctx.fillStyle = "#e5eaf2";
  ctx.fillRect(L, H - 8, W - L - R, 3);
  ctx.fillStyle = "#d97706";
  ctx.fillRect(L, H - 8, (W - L - R) * prog, 3);
  // 图例最后绘制并加白色描边光晕，压线也可读
  const legend = ["真实角", "陀螺仪积分（漂移）", "加速度计（噪声）", "融合"];
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "alphabetic";
  legend.forEach((t, i) => {
    const x = L + 10 + i * 152;
    const y = 20;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.strokeText(t, x, y);
    ctx.fillStyle = CD_COLORS[i];
    ctx.fillText(t, x, y);
  });
  const scaleLabel = "±30°";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText(scaleLabel, 6, mid - 28 * sc + 4);
  ctx.fillStyle = "#58667b";
  ctx.fillText(scaleLabel, 6, mid - 28 * sc + 4);
}

// ---------- 文档页小演示：旋转顺序不可交换（两颗骰子） ----------
// 同一对「偏航 ψ（绕竖直轴）+ 横滚 φ（绕水平轴）」按不同先后施加，终姿态不同——
// 四元数乘法 q₁⊗q₂ ≠ q₂⊗q₁ 的几何现场。ψ = φ 随时间平滑往返 0°..90°。
const orderDemoCanvas = document.getElementById("fig-order-demo") as HTMLCanvasElement | null;
const orderDemoCtx = orderDemoCanvas ? orderDemoCanvas.getContext("2d") : null;
let orderDemoRunning = false;
let orderDemoT = 0;

/** 行主序 3×3 乘法 */
function odMul3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      o[i * 3 + j] = a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

/** 固定视角正交投影：x 向右，y 向上，z 向左上（画面坐标 y 向下为正，故取负） */
function odProject(v: number[]): [number, number] {
  return [v[0] - 0.55 * v[2], -v[1] + 0.35 * v[2]];
}

const OD_CORNERS: number[][] = [];
for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) OD_CORNERS.push([x, y, z]);
const OD_EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7],
  [4, 5], [4, 6], [5, 7], [6, 7],
];

function odHaloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, font = "12px sans-serif"): void {
  ctx.font = font;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function odDrawPanel(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, label: string, M: number[],
): void {
  const S = 58;
  // 世界系坐标轴（两个面板完全相同）：x 红（横滚轴）、y 绿（偏航轴·竖直）、z 紫
  const axes: Array<[string, number[], number, string]> = [
    ["横滚轴 x", [1, 0, 0], 74, "#e5484d"],
    ["偏航轴 y", [0, 1, 0], 74, "#059669"],
    ["z", [0, 0, 1], 60, "#7c3aed"],
  ];
  for (const [, dir, len, color] of axes) {
    const [px, py] = odProject(dir);
    const x2 = cx + px * len, y2 = cy + py * len;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // 小箭头（沿方向反向张开的两短线）
    const dx = x2 - cx, dy = y2 - cy, dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 7 * ux + 3.5 * uy, y2 - 7 * uy - 3.5 * ux);
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 7 * ux - 3.5 * uy, y2 - 7 * uy + 3.5 * ux);
    ctx.stroke();
  }
  // 骰子（线框立方体），顶点经 M 变换后投影
  const pts = OD_CORNERS.map((v) => {
    const tv = [
      M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
      M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
      M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
    ];
    const [px, py] = odProject(tv);
    return [cx + px * S * 1.6, cy + py * S * 1.6] as [number, number];
  });
  ctx.strokeStyle = "#16202f";
  ctx.lineWidth = 1.8;
  ctx.lineJoin = "round";
  for (const [a, b] of OD_EDGES) {
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  }
  odHaloText(ctx, label, cx, cy - 86, "#16202f", "12.5px sans-serif");
}

function drawOrderDemo(angDeg: number): void {
  if (!orderDemoCtx || !orderDemoCanvas) return;
  const ctx = orderDemoCtx;
  const W = orderDemoCanvas.width, H = orderDemoCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const a = (angDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // 世界系旋转：先偏航（绕 y）再横滚（绕 x）= Rx·Ry；先横滚再偏航 = Ry·Rx
  const Ry = [c, 0, s, 0, 1, 0, -s, 0, c];
  const Rx = [1, 0, 0, 0, c, -s, 0, s, c];
  const A = odMul3(Rx, Ry);
  const B = odMul3(Ry, Rx);
  // 两姿态的相对旋转角：R_rel = A·Bᵀ，θ = acos((tr−1)/2)
  const Bt = [B[0], B[3], B[6], B[1], B[4], B[7], B[2], B[5], B[8]];
  const R = odMul3(A, Bt);
  const tr = R[0] + R[4] + R[8];
  const relDeg = (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;

  odDrawPanel(ctx, 185, 118, "先偏航 ψ · 再横滚 φ", A);
  odDrawPanel(ctx, 535, 118, "先横滚 φ · 再偏航 ψ", B);
  // 中缝分隔
  ctx.strokeStyle = "#e2e8f2";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(360, 18);
  ctx.lineTo(360, 210);
  ctx.stroke();

  odHaloText(ctx, `ψ = φ = ${angDeg.toFixed(0)}°`, 360, 20, "#16202f", "13px sans-serif");
  const rel =
    relDeg < 0.05
      ? "两姿态暂时重合（角度为 0，顺序还看不出差别）"
      : `两个终姿态的夹角 ${relDeg.toFixed(1)}° —— 顺序不同，结果就不同`;
  odHaloText(ctx, rel, 360, 224, relDeg < 0.05 ? "#58667b" : "#c026a3", "12.5px sans-serif");
}

function stepOrderDemo(dt: number): void {
  if (!orderDemoCtx || !orderDemoCanvas) return;
  orderDemoT += dt;
  const sweep = 90 * (0.5 - 0.5 * Math.cos(orderDemoT * 0.55)); // 0..90° 平滑往返
  drawOrderDemo(sweep);
}

// ---------- 文档页小演示：磁力计「校准舞蹈」（畸变椭球 → 标定后收圆） ----------
// 合成已知的硬铁偏移 + 软铁刻度（真实标定靠椭球拟合反推这三个参数），
// 虚拟机体做「六面翻滚舞蹈」采集点云：左面板原始读数（偏移椭球），右面板标定后（居中球面）。
const calibDemoCanvas = document.getElementById("fig-calib-demo") as HTMLCanvasElement | null;
const calibDemoCtx = calibDemoCanvas ? calibDemoCanvas.getContext("2d") : null;
let calibDemoRunning = false;
let calibDemoT = 0;
let calibHoldT = 0;
const CAL_N = 240;
const CAL_HOLD = 1.6;
const CAL_HARD: V3 = [9, -6, 13]; // 硬铁偏移（μT）——点云椭球中心离开原点
const CAL_SOFT: V3 = [1.18, 0.88, 1.0]; // 软铁刻度（三轴不一致）——椭球轴向伸缩
const CAL_B: V3 = [32.8, 0, 37.7]; // 世界磁场 NED（与模拟 IMU 的磁倾角 49° 一致）
const calibRaw: Array<[number, number, number]> = [];
const calibCal: Array<[number, number, number]> = [];

/** 校准舞蹈的姿态脚本：三轴 Lissajous 翻滚 + 确定性伪随机抖动——
 *  纯轨迹是条曲线，加抖动才能让采样方向铺满球面（覆盖度反馈才有意义） */
function calibPose(i: number): Quat {
  const t = (i / CAL_N) * Math.PI * 2;
  const rnd = (k: number): number => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x); // [0,1) 确定性伪随机（同帧序列可复现）
  };
  return qFromEuler(
    (38 * Math.sin(1.0 * t + 0.9) + 52 * (rnd(1) - 0.5)) * RAD,
    (42 * Math.sin(0.62 * t + 2.1) + 52 * (rnd(2) - 0.5)) * RAD,
    (55 * Math.sin(0.83 * t + 4.0) + 62 * (rnd(3) - 0.5)) * RAD,
  );
}

function calibSample(i: number): void {
  const mBody = qRotInv(calibPose(i), CAL_B);
  const raw: [number, number, number] = [
    CAL_SOFT[0] * mBody[0] + CAL_HARD[0],
    CAL_SOFT[1] * mBody[1] + CAL_HARD[1],
    CAL_SOFT[2] * mBody[2] + CAL_HARD[2],
  ];
  const cal: [number, number, number] = [
    (raw[0] - CAL_HARD[0]) / CAL_SOFT[0],
    (raw[1] - CAL_HARD[1]) / CAL_SOFT[1],
    (raw[2] - CAL_HARD[2]) / CAL_SOFT[2],
  ];
  calibRaw.push(raw);
  calibCal.push(cal);
}

function calibReset(): void {
  calibRaw.length = 0;
  calibCal.length = 0;
  calibHoldT = 0;
}

function drawCalibCloud(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, pts: Array<[number, number, number]>,
  color: string, label: string,
): void {
  // 坐标轴十字（μT 值 × 2.2 缩放：50μT 场强 → 半径 ~50px，硬铁偏移 ~13μT 清晰可见）
  const K = 2.2;
  for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]) {
    const [px, py] = odProject(d);
    ctx.strokeStyle = "#d7dfeb";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - px * K * 26, cy - py * K * 26);
    ctx.lineTo(cx + px * K * 26, cy + py * K * 26);
    ctx.stroke();
  }
  for (const p of pts) {
    const [px, py] = odProject(p);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + px * K, cy + py * K, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  odHaloText(ctx, label, cx, cy - 88, "#16202f", "12.5px sans-serif");
}

function drawCalibDemo(): void {
  if (!calibDemoCtx || !calibDemoCanvas) return;
  const ctx = calibDemoCtx;
  const W = calibDemoCanvas.width, H = calibDemoCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const n = calibRaw.length;
  drawCalibCloud(ctx, 185, 122, calibRaw, "#e5484d", "原始读数：偏移 + 伸缩的椭球");
  drawCalibCloud(ctx, 535, 122, calibCal, "#059669", "标定后：球心回原点、三轴等宽");
  // 中缝与状态
  ctx.strokeStyle = "#e2e8f2";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(360, 18);
  ctx.lineTo(360, 218);
  ctx.stroke();
  odHaloText(ctx, `校准舞蹈：已采 ${n} / ${CAL_N} 点`, 360, 20, "#16202f", "13px sans-serif");
  const done = n >= CAL_N;
  odHaloText(
    ctx,
    done ? "点云铺满球面 → 拟合出硬铁偏移与软铁刻度，反解补偿即可" : "继续翻滚采集……覆盖度不足时拟合会把误差抄进参数",
    360, 232,
    done ? "#059669" : "#58667b",
    "12.5px sans-serif",
  );
  // 底部进度条（覆盖度）
  const L = 40, R = 8;
  ctx.fillStyle = "#e5eaf2";
  ctx.fillRect(L, H - 9, W - L - R, 4);
  ctx.fillStyle = "#d97706";
  ctx.fillRect(L, H - 9, ((W - L - R) * n) / CAL_N, 4);
}

function stepCalibDemo(dt: number): void {
  if (!calibDemoCtx || !calibDemoCanvas) return;
  const n = calibRaw.length;
  if (n >= CAL_N) {
    calibHoldT += dt;
    if (calibHoldT < CAL_HOLD) return;
    calibReset();
    drawCalibDemo();
    return;
  }
  calibDemoT += dt;
  // 每帧补 2 个样本：约 2s 采满一轮
  for (let k = 0; k < 2 && calibRaw.length < CAL_N; k++) calibSample(calibRaw.length);
  drawCalibDemo();
}

// ---------- 文档页小演示：Allan 方差（把手册噪声数字变成曲线） ----------
// 合成 655s @50Hz 的陀螺序列（已知白噪声密度 N 与速率随机游走 K），计算重叠 Allan 偏差
// σ(τ) 的 log-log 曲线：−½ 斜率段=白噪声（N=σ(1)），+½ 段=速率随机游走——「零偏随机游走」
// 滑块对应的 K 系数在这里现出原形。
const allanCanvas = document.getElementById("fig-allan-demo") as HTMLCanvasElement | null;
let allanDrawn = false;
const ALLAN_FS = 50; // Hz（合成用低采样率：Allan 方差只关心 τ 谱形）
const ALLAN_N = 1 << 15; // 32768 样本 ≈ 655 s

function allanCompute(): { taus: number[]; sigmas: number[] } {
  // 合成一段已知 N/K 的陀螺静态数据，再用 core/allan.ts 算 σ(τ)——
  // 数值部分（合成 + 非重叠 Allan + 斜率拟合）都在那个纯模块里，也有自检覆盖，
  // 这里只负责把数据源定成「MPU-9250 手册值」并交给它。
  const { theta, dt } = synthesizeGyroAngle({
    n: ALLAN_N,
    fs: ALLAN_FS,
    arw: 0.01, // °/s/√Hz（MPU-9250 噪声密度手册值）
    rrw: 0.0035, // °/s/√s（速率随机游走）
    rand: mulberry32(2026),
  });
  return allanDeviation(theta, dt);
}

function drawAllan(): void {
  if (!allanCanvas || allanDrawn) return;
  const ctx = allanCanvas.getContext("2d");
  if (!ctx) return;
  allanDrawn = true;
  const W = allanCanvas.width, H = allanCanvas.height;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const { taus, sigmas } = allanCompute();
  const L = 56, T = 26, B = 30, R = 12;
  const lx = (tau: number): number => L + ((Math.log10(tau) - Math.log10(taus[0])) / (Math.log10(taus[taus.length - 1]) - Math.log10(taus[0]))) * (W - L - R);
  // y 域：σ 范围 ~5e-4..5e-2（°/s），跨 3 个十进位量级
  const yLo = -4, yHi = -1;
  const ly = (s: number): number => T + ((yHi - Math.log10(s)) / (yHi - yLo)) * (H - T - B);
  // 网格
  ctx.strokeStyle = "#e5eaf2";
  ctx.lineWidth = 1;
  ctx.font = "10.5px sans-serif";
  ctx.fillStyle = "#58667b";
  for (let e = yLo; e <= yHi; e++) {
    const y = ly(Math.pow(10, e));
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(`1e${e}`, L - 5, y + 3.5);
  }
  for (const tau of [0.02, 0.1, 0.5, 2, 10]) {
    const x = lx(tau);
    ctx.strokeStyle = "#eef2f8";
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, H - B);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(`${tau}s`, x, H - B + 14);
  }
  // 参考斜率线（解析形状）：白噪声 σ = ARW/√τ；速率随机游走 σ = (K/√3)·√τ
  const drawGuide = (fn: (t: number) => number, t0: number, t1: number, label: string, tLabel: number): void => {
    ctx.strokeStyle = "#94a3b8";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(lx(t0), ly(fn(t0)));
    ctx.lineTo(lx(t1), ly(fn(t1)));
    ctx.stroke();
    ctx.setLineDash([]);
    odHaloText(ctx, label, lx(tLabel), ly(fn(tLabel)) - 10, "#58667b");
  };
  drawGuide((t) => 0.00707 / Math.sqrt(t), 0.02, 1.2, "白噪声（斜率 −½）→ σ(1s) ≈ N", 0.035);
  drawGuide((t) => 0.00202 * Math.sqrt(t), 2.5, 10, "零偏随机游走（斜率 +½）", 5.5);
  // 曲线
  ctx.strokeStyle = "#0b688a";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  taus.forEach((tau, i) => {
    const x = lx(tau), y = ly(sigmas[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  taus.forEach((tau, i) => {
    const x = lx(tau), y = ly(sigmas[i]);
    ctx.fillStyle = "#0b688a";
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });
  odHaloText(ctx, "σ(τ)（°/s）— log-log", L + 6, 16, "#16202f", "12.5px sans-serif");
  odHaloText(ctx, "τ（平均时长）", W - R - 60, H - 8, "#58667b");
}

/* ==========================================================================
   组装：绑定静态演示控件，并交回主循环需要的步进器
   ========================================================================== */

/** 初始化六个文档演示；返回值交给主循环（step）与文档翻页逻辑（refresh） */
export function initDocDemos(host: DocDemoHost): DocDemos {
  hostVisible = (page) => host.isVisible(page);
  initDocDockDemos();
  refreshDocDemoRun();
  return {
    step(dt) {
      if (compDemoRunning) stepCompDemo(dt);
      if (orderDemoRunning) stepOrderDemo(dt);
      if (calibDemoRunning) stepCalibDemo(dt);
    },
    refresh: refreshDocDemoRun,
  };
}
