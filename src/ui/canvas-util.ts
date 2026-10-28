/**
 * 画布工具：面板 / 文档里所有 inset 画布共用的「尺寸同步」。
 *
 * 为什么单独成模块：它是「用 CSS 像素坐标绘制」这一约定的实现点，
 * 主视图的 S³ 剖面、惯性导航俯视图、文档里的 5 个演示都靠它。
 * 早期版本把它散在 main.ts 里，画布一旦长在滚动容器里就容易被改错。
 */
/**
 * 画布尺寸同步（所有 inset 演示共用）：按元素当前 CSS 宽度 × DPR 写回 bitmap，
 * 并把 2D 上下文预缩放，使**所有绘制代码都可以直接用 CSS 像素坐标**。
 *
 * 为什么必须有它：canvas 的绘制表面由 width/height **属性**决定，与 CSS 尺寸无关。
 * 只写 `width:100%` 的 CSS 会让位图固定在内联属性尺寸上（本项目 #proj-section 曾是 520×120），
 * 于是在窄容器里横向溢出、被栏边裁掉。这里每帧调用一次，只在尺寸真变时才重设位图
 * （避免每帧清空 bitmap 造成闪烁）。
 *
 * @param aspect    目标宽高比（w / h）
 * @param fallbackW 容器不可见（clientWidth = 0）时的兜底 CSS 宽度
 */
export function fitInsetCanvas(
  c: HTMLCanvasElement,
  aspect: number,
  fallbackW = 320,
): { w: number; h: number } {
  const cssW = Math.max(120, Math.round(c.clientWidth || fallbackW));
  const cssH = Math.round(cssW / aspect);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (c.width !== bw || c.height !== bh) {
    c.width = bw;
    c.height = bh;
  }
  const ctx = c.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH };
}

