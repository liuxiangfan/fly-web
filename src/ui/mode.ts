/**
 * 视图（四轴姿态 / 万向节锁）的状态与策略。
 *
 * 设计要点：纯策略函数不碰 DOM，可在 Node 自检脚本里直接测试；
 * 只有 applyViewDom 会写 body 属性。视图显隐全部交给 CSS（body[data-view]）。
 */

export type UiView = "attitude" | "gimbal" | "quat";

/** 写 body[data-view] */
export function applyViewDom(view: UiView, doc: Document = document): void {
  doc.body.dataset.view = view;
}

/** 万向节锁视图的解说文案 */
export function narrateGimbal(pitchDeg: number, locked: boolean): string {
  if (locked) {
    return `俯仰 θ = ${pitchDeg.toFixed(0)}°：内外环轴重合 → 横滚与偏航变成同一个动作（万向节锁，只剩 2 个自由度）`;
  }
  if (Math.abs(Math.abs(pitchDeg) - 90) < 25) {
    return `俯仰 θ = ${pitchDeg.toFixed(0)}°：正在接近 ±90°，注意内外环的轴逐渐靠拢`;
  }
  return `俯仰 θ = ${pitchDeg.toFixed(0)}°：三轴正交，横滚与偏航各自独立`;
}
