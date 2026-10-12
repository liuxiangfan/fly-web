/**
 * 界面模式（精简/完整）与视图（四轴姿态/万向节锁）的状态与策略。
 *
 * 设计要点：纯策略函数（resolve*、estimatorMask、narrate*、loadMode）不碰 DOM，
 * 因此可以在 Node 自检脚本里直接测试；只有 apply*Dom 会写 body 属性。
 * 精简模式的显隐全部交给 CSS（body[data-mode] / body[data-view]），
 * 避免逐个 JS 切换元素时漏掉某一处。
 */

export type UiMode = "basic" | "full";
export type UiView = "attitude" | "gimbal";

export interface KvStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MODE_KEY = "qad.mode";

/** 精简模式允许的模型姿态来源 */
export const BASIC_SOURCES = ["truth", "pure", "mahony"] as const;
/** 精简模式允许的机动剧本 */
export const BASIC_SCENARIOS = ["hover", "manual", "roll360"] as const;
/** 精简模式保留的估计器：纯陀螺积分 + Mahony，构成「漂移 vs 融合」两条故事线 */
export const BASIC_ESTIMATORS = ["pure", "mahony"] as const;

function defaultStore(): KvStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式等场景下访问 localStorage 会抛异常
  }
}

/** 读取界面模式：缺失或非法值一律回落 basic（面向初学者的默认） */
export function loadMode(store: KvStore | null = defaultStore()): UiMode {
  const v = store?.getItem(MODE_KEY);
  return v === "full" ? "full" : "basic";
}

export function saveMode(mode: UiMode, store: KvStore | null = defaultStore()): void {
  try {
    store?.setItem(MODE_KEY, mode);
  } catch {
    // 写入失败（隐私模式、配额）不影响本次使用
  }
}

/** 精简模式把不允许的显示源收敛到 Mahony */
export function resolveSource(source: string, mode: UiMode): string {
  if (mode === "full") return source;
  return (BASIC_SOURCES as readonly string[]).includes(source) ? source : "mahony";
}

/** 精简模式把不允许的机动收敛到悬停微扰 */
export function resolveScenario(id: string, mode: UiMode): string {
  if (mode === "full") return id;
  return (BASIC_SCENARIOS as readonly string[]).includes(id) ? id : "hover";
}

/** 按模式给出各估计器的可见性掩码（与用户自己勾选的可见性按位与后生效） */
export function estimatorMask(mode: UiMode, ids: readonly string[]): boolean[] {
  return ids.map((id) => mode === "full" || (BASIC_ESTIMATORS as readonly string[]).includes(id));
}

/** 写 body[data-mode]，由 CSS 控制区块显隐 */
export function applyModeDom(mode: UiMode, doc: Document = document): void {
  doc.body.dataset.mode = mode;
}

/** 写 body[data-view] */
export function applyViewDom(view: UiView, doc: Document = document): void {
  doc.body.dataset.view = view;
}

/** 解说栏文案（四轴姿态视图）：把数字换成一句人话 */
export function narrateAttitude(pureErrDeg: number, mahonyErrDeg: number): string {
  const p = Number.isFinite(pureErrDeg) ? pureErrDeg : 0;
  const m = Number.isFinite(mahonyErrDeg) ? mahonyErrDeg : 0;
  return `纯陀螺积分（红）：角度已漂移 ${p.toFixed(1)}° ｜ Mahony（蓝）：误差被拉回到 ${m.toFixed(1)}°`;
}

/** 解说栏文案（万向节锁视图） */
export function narrateGimbal(pitchDeg: number, locked: boolean): string {
  if (locked) {
    return `俯仰 θ = ${pitchDeg.toFixed(0)}°：内外环轴重合 → 横滚与偏航变成同一个动作（万向节锁，只剩 2 个自由度）`;
  }
  if (Math.abs(Math.abs(pitchDeg) - 90) < 25) {
    return `俯仰 θ = ${pitchDeg.toFixed(0)}°：正在接近 ±90°，注意内外环的轴逐渐靠拢`;
  }
  return `俯仰 θ = ${pitchDeg.toFixed(0)}°：三轴正交，横滚与偏航各自独立`;
}
