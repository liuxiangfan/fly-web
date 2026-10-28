/**
 * 惯性导航俯视图（北-东平面）的绘制与米数格式化。
 *
 * 与 main.ts 的分工：本模块**不持有状态**，只接一份「每条通道的当前位置与轨迹」
 * 与量程设置，画完返回本次实际使用的量程。状态（积分器、轨迹缓冲、量程选择）
 * 留在装配层——那是它该待的地方，也便于把绘制单独测/改。
 */
import { fitInsetCanvas } from "./canvas-util";

export interface InsMapRow {
  label: string;
  color: string;
  /** 北向位置（米，正 = 北） */
  north: number;
  /** 东向位置（米，正 = 东） */
  east: number;
  /** 轨迹点：扁平的 [north, east, north, east, ...]（25 Hz 记录） */
  trail: readonly number[];
}

/** 米数的可读格式（跨越 0.001 m – 10 km） */
export function fmtMeters(v: number): string {
  const a = Math.abs(v);
  if (a >= 10000) return `${(v / 1000).toFixed(0)} km`;
  if (a >= 1000) return `${(v / 1000).toFixed(1)} km`;
  if (a >= 100) return `${v.toFixed(0)} m`;
  if (a >= 10) return `${v.toFixed(1)} m`;
  if (a >= 1) return `${v.toFixed(2)} m`;
  return `${v.toFixed(3)} m`;
}

/**
 * 画俯视图。
 * 自动量程跟随最大漂移——小漂移的算法会缩成原点附近一点，这恰恰是要传达的信息：
 * 「纯积分跑出屏幕时，卡尔曼几乎还在原点」。想看清早期演化就把量程固定小一点。
 * @param scale "auto" 或固定米数（字符串，与 <select> 的取值一致）
 * @returns 本次使用的量程（米），供调用方显示
 */
export function drawInsMap(
  canvas: HTMLCanvasElement | null,
  rows: readonly InsMapRow[],
  scale: string,
): number {
  if (!canvas) return 0;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const { w: W, h: H } = fitInsetCanvas(canvas, 1.1, 320);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a1020";
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const maxPix = Math.min(W, H) / 2 - 22;

  let maxDrift = 0;
  for (const r of rows) maxDrift = Math.max(maxDrift, Math.hypot(r.north, r.east));
  const range = scale === "auto" ? Math.max(maxDrift * 1.15, 1) : Number(scale);
  const k = maxPix / range; // m → px

  // 刻度环 + 米数标签（标签放环顶：避开横轴与轨迹簇）
  ctx.font = '10px "Fira Code", Consolas, monospace';
  ctx.strokeStyle = "#1f2c46";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#5b6b86";
  ctx.textAlign = "center";
  for (const frac of [1 / 3, 2 / 3, 1]) {
    const r = maxPix * frac;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(fmtMeters(range * frac), cx, cy - r + 11);
  }
  // 北/东轴
  ctx.strokeStyle = "#243453";
  ctx.beginPath();
  ctx.moveTo(cx, cy - maxPix);
  ctx.lineTo(cx, cy + maxPix);
  ctx.moveTo(cx - maxPix, cy);
  ctx.lineTo(cx + maxPix, cy);
  ctx.stroke();
  ctx.fillStyle = "#7b8aa3";
  ctx.textAlign = "left";
  ctx.fillText("北", cx + 5, cy - maxPix + 12);
  ctx.textAlign = "right";
  ctx.fillText("东", cx + maxPix - 5, cy - 6);

  // 轨迹 + 当前位置（显示坐标：上 = 北，右 = 东）
  for (const r of rows) {
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.75;
    if (r.trail.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < r.trail.length; i += 2) {
        const x = cx + r.trail[i + 1] * k;
        const y = cy - r.trail[i] * k;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(cx + r.east * k, cy - r.north * k, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // 真值原点（始终在原点）画在最上层
  ctx.fillStyle = "#e6edf3";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.fillStyle = "#7b8aa3";
  ctx.fillText(`量程 ±${fmtMeters(range)}`, 6, 13);
  return range;
}
