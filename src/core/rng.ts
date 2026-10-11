/** 高斯随机数（Box–Muller，带缓存）；rand 可注入确定性种子 */
export class Gauss {
  private spare: number | null = null;
  constructor(private rand: () => number = Math.random) {}

  next(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0, v = 0;
    while (u === 0) u = this.rand();
    while (v === 0) v = this.rand();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** mulberry32 确定性伪随机，供自检脚本复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
