/**
 * 单帧姿态确定：TRIAD 与 Wahba/QUEST（Davenport q-方法）。
 *
 * 坐标约定与全项目一致：
 *   q / R(q) 是**机体系 → 世界系**；`body`（bᵢ）是机体系实测方向，`world`（rᵢ）是世界系参考方向。
 *   Wahba 代价：min Σ wᵢ‖rᵢ − R·bᵢ‖²，等价于 max Σ wᵢ rᵢᵀ R bᵢ。
 *
 * 与滤波器的关系：单帧解只用当前观测、不含时间记忆，因此没有增益、没有零偏状态；
 * 它适合做初始粗对准，也适合把「观测权重/共线退化」讲清楚。
 */
import { qAngleBetween, qFromAxisAngle, qNorm, qRot, type Quat, type V3 } from "./quat";

export interface VectorObservation {
  /** 世界系参考方向（例如重力方向、磁北方向），无需归一化 */
  world: V3;
  /** 机体系实测方向（对应同一物理量），无需归一化 */
  body: V3;
  /** 相对权重，>0；越大表示越信这条观测 */
  weight?: number;
}

export interface AttitudeSolution {
  q: Quat;
  /** Wahba 代价 Σ wᵢ‖rᵢ − R·bᵢ‖²（未归一化观测会带尺度，比较时保持同一组观测即可） */
  cost: number;
  /** 观测几何退化（向量共线/零向量）时为 true：此时不存在唯一三轴解 */
  degenerate: boolean;
}

const EPS = 1e-9;

function norm(v: V3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function unit(v: V3): V3 {
  const n = norm(v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 旋转矩阵（行主序，body→world）→ 四元数；trace 法，对 180° 附近用最大对角分支 */
export function qFromMatrix(m: number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return qNorm({ w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qNorm({ w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qNorm({ w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qNorm({ w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s });
}

/** 两向量是否接近共线（叉积模长 < 1e-6 视为退化） */
export function observationsDegenerate(a: VectorObservation, b: VectorObservation): boolean {
  const na = norm(a.body), nb = norm(b.body);
  const ra = norm(a.world), rb = norm(b.world);
  if (na < EPS || nb < EPS || ra < EPS || rb < EPS) return true;
  return norm(cross(unit(a.body), unit(b.body))) < 1e-6 || norm(cross(unit(a.world), unit(b.world))) < 1e-6;
}

/** TRIAD：用两条观测各构造一组右手正交基，两基之间的变换即姿态（body→world） */
export function triad(obs: [VectorObservation, VectorObservation]): AttitudeSolution | null {
  const [o1, o2] = obs;
  if (observationsDegenerate(o1, o2)) return null;
  const b1 = unit(o1.body);
  const b2o = cross(cross(b1, unit(o2.body)), b1); // o2 对 b1 正交化
  const b3 = cross(b1, unit(b2o));
  const r1 = unit(o1.world);
  const r2o = cross(cross(r1, unit(o2.world)), r1);
  const r3 = cross(r1, unit(r2o));
  // 列向量基：Mb = [b1 b2 b3]，Mw = [r1 r2 r3]，R = Mw·Mbᵀ
  const Mb = [b1[0], b2o[0], b3[0], b1[1], b2o[1], b3[1], b1[2], b2o[2], b3[2]];
  const Mw = [r1[0], r2o[0], r3[0], r1[1], r2o[1], r3[1], r1[2], r2o[2], r3[2]];
  const R = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      R[i * 3 + j] = Mw[i * 3] * Mb[j * 3] + Mw[i * 3 + 1] * Mb[j * 3 + 1] + Mw[i * 3 + 2] * Mb[j * 3 + 2];
  const q = qFromMatrix(R);
  return { q, cost: wahbaCost(q, obs), degenerate: false };
}

/** Wahba 代价（未归一化观测保留原始尺度，仅用于同一组观测间比较） */
export function wahbaCost(q: Quat, obs: readonly VectorObservation[]): number {
  let cost = 0;
  for (const o of obs) {
    const w = o.weight ?? 1;
    const p = qRot(q, o.body);
    cost += w * ((p[0] - o.world[0]) ** 2 + (p[1] - o.world[1]) ** 2 + (p[2] - o.world[2]) ** 2);
  }
  return cost;
}

/**
 * Davenport q-方法 / QUEST 的等价形式：构造 4×4 对称矩阵 K，最大特征值对应的特征向量即最优 q。
 * 这里用幂迭代求主特征向量（对 4×4、教学场景足够稳定；不引入特征分解依赖）。
 */
export function wahbaQuest(obs: readonly VectorObservation[]): AttitudeSolution | null {
  if (obs.length < 2 || observationsDegenerate(obs[0], obs[1])) return null;
  // B = Σ w·r·bᵀ（行=world，列=body）。Davenport 标准式使用 B_std = Σ w·b·rᵀ = Bᵀ。
  const Bw = new Array<number>(9).fill(0);
  for (const o of obs) {
    const w = o.weight ?? 1;
    const r = unit(o.world);
    const b = unit(o.body);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Bw[i * 3 + j] += w * r[i] * b[j];
  }
  // B = Σ w·b·rᵀ（Davenport 标准式：行=body、列=world）
  const B = [Bw[0], Bw[3], Bw[6], Bw[1], Bw[4], Bw[7], Bw[2], Bw[5], Bw[8]];
  const sigma = B[0] + B[4] + B[8];
  const S = [B[0] + B[0], B[1] + B[3], B[2] + B[6], B[3] + B[1], B[4] + B[4], B[5] + B[7], B[6] + B[2], B[7] + B[5], B[8] + B[8]];
  const z: V3 = [B[5] - B[7], B[6] - B[2], B[1] - B[3]];
  // K = [[σ, zᵀ],[z, S − σI]]
  const K = [
    sigma, z[0], z[1], z[2],
    z[0], S[0] - sigma, S[1], S[2],
    z[1], S[3], S[4] - sigma, S[5],
    z[2], S[6], S[7], S[8] - sigma,
  ];
  // 幂迭代的直接问题：K 的最大特征值为 +Σw|r||b|，而**对应反向旋转的特征值是 −Σw|r||b|**，
  // 两者模长相同；初值里同时含这两个分量时普通幂迭代会来回翻号、不收敛。
  // 用谱上界做正平移（K' = K + bound·I），把正特征值整体抬到 [0, 2·bound] 且最大唯一。
  const bound =
    obs.reduce((s, o) => s + (o.weight ?? 1) * norm(o.world) * norm(o.body), 0) + 1e-9;
  for (let i = 0; i < 4; i++) K[i * 4 + i] += bound;
  const seed = [1, 0.2, 0.3, 0.4];
  const seedN = Math.hypot(...seed) || 1;
  let v = seed.map((x) => x / seedN); // 必须从单位向量起步，否则首轮的 dot 检验会误判为已收敛
  for (let iter = 0; iter < 500; iter++) {
    const nv = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) nv[i] += K[i * 4 + j] * v[j];
    const n = Math.hypot(nv[0], nv[1], nv[2], nv[3]) || 1;
    for (let i = 0; i < 4; i++) nv[i] /= n;
    // 不做「点积接近 1 就提前退出」：浮点下 1−1e-14 对应的残差仍可达 1e-7，
    // 会让教学页读到 1e-5° 的假误差。500 次幂迭代在 4×4 上开销可忽略。
    v = nv;
  }
  const qCand = qNorm({ w: v[0], x: v[1], y: v[2], z: v[3] });
  // Davenport/QUEST 的特征向量与「body→world」还是其逆，取决于 Hamilton/JPL 约定；
  // 两种符号都算一次代价，取代价更小的那个——数值上等价于按本项目的坐标约定落定方向。
  const qInv: Quat = { w: qCand.w, x: -qCand.x, y: -qCand.y, z: -qCand.z };
  const q = wahbaCost(qCand, obs) <= wahbaCost(qInv, obs) ? qCand : qInv;
  return { q, cost: wahbaCost(q, obs), degenerate: false };
}

/** 把「参考方向 + 权重」渲染成自检/文档读数用的简短姿态误差 */
export function attitudeErrorDeg(a: Quat, b: Quat): number {
  return qAngleBetween(a, b) * (180 / Math.PI);
}

/** 由真实姿态反推两条观测（body = Rᵀ·world + 确定性小扰动，便于复现实验） */
export function syntheticObservations(
  qTrue: Quat,
  refs: [V3, V3],
  noiseDeg: [number, number] = [0, 0],
  axisJitter: [number, number] = [0, 0],
): [VectorObservation, VectorObservation] {
  const obs = refs.map((r, k) => {
    const clean = unit(r);
    const axis = k === 0 ? ([0, 1, 0] as V3) : ([1, 0, 0] as V3);
    const perturbed = axisJitter[k] ? qRot(qFromAxisAngle(unit(axis), (axisJitter[k] * Math.PI) / 180), clean) : clean;
    // 真值映射：world = R(qTrue)·body ⇒ body = Rᵀ·world（本装置 qRotInv）
    const body = qRotInvLike(qTrue, perturbed);
    const noisy = noiseDeg[k] ? qRot(qFromAxisAngle(unit(axis), ((noiseDeg[k] * 0.5) * Math.PI) / 180), body) : body;
    return { world: unit(r), body: unit(noisy), weight: 1 };
  }) as [VectorObservation, VectorObservation];
  return obs;
}

/** 避免与 quat.ts 的命名混淆：world→body 用共轭旋转 */
function qRotInvLike(q: Quat, v: V3): V3 {
  return qRot({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v);
}

/** 权重对照：同一组观测下把第二条观测权重从 1 改到 w，观察最优解偏向谁 */
export function weightedSolution(obs: [VectorObservation, VectorObservation], w2: number): AttitudeSolution | null {
  const o2b: VectorObservation = { ...obs[1], weight: w2 };
  return wahbaQuest([obs[0], o2b]);
}

/** 供演示：常用参考方向（世界 NED：重力向下、磁北水平） */
export const REF_GRAVITY_NED: V3 = [0, 0, 1];
export const REF_MAG_NORTH_NED: V3 = [1, 0, 0];
