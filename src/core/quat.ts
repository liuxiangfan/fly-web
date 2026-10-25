export type V3 = [number, number, number];

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export function qId(): Quat {
  return { w: 1, x: 0, y: 0, z: 0 };
}

export function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function qConj(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

export function qDot(a: Quat, b: Quat): number {
  return a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
}

export function qNorm(q: Quat): Quat {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

/** q ← q + ½·q⊗(0,ω)·dt，再归一化（一阶积分，500 Hz 下足够精确） */
export function qIntegrate(q: Quat, omega: V3, dt: number): Quat {
  const h = 0.5 * dt;
  const d = qMul(q, { w: 0, x: omega[0] * h, y: omega[1] * h, z: omega[2] * h });
  return qNorm({ w: q.w + d.w, x: q.x + d.x, y: q.y + d.y, z: q.z + d.z });
}

/** 欧拉角（ZYX：偏航 ψ 绕 z、俯仰 θ 绕 y、横滚 φ 绕 x，NED 航空约定）→ 四元数，单位弧度 */
export function qFromEuler(roll: number, pitch: number, yaw: number): Quat {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  };
}

/** 绕单位轴 axis 旋转 angle（弧度）的四元数。axis 必须已归一化 */
export function qFromAxisAngle(axis: V3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return { w: Math.cos(h), x: axis[0] * s, y: axis[1] * s, z: axis[2] * s };
}

/**
 * 四元数 → 轴角表示（qFromAxisAngle 的逆）。
 * angle ∈ [0, π]；q 与 −q 返回完全相同的 axis/angle——
 * 这是「双覆盖」的直接体现：两个四元数表示同一旋转，轴角表示却只有一个。
 * 零旋转（虚部≈0）时 axis 返回 [1,0,0]、angle=0（轴无定义，任取单位轴）。
 */
export function qToAxisAngle(q: Quat): { axis: V3; angle: number } {
  // 落到短路径：w ≥ 0（q 与 −q 中取 w 非负的那个），保证 angle ∈ [0, π]
  const s = q.w < 0 ? -1 : 1;
  const w = s * q.w;
  const v: V3 = [s * q.x, s * q.y, s * q.z];
  const angle = 2 * Math.acos(Math.min(1, w));
  const vn = Math.hypot(v[0], v[1], v[2]);
  if (vn < 1e-12) return { axis: [1, 0, 0], angle: 0 }; // 零旋转
  return { axis: [v[0] / vn, v[1] / vn, v[2] / vn], angle };
}

/**
 * 欧拉角分量线性插值（对照组）：qToEuler → 各分量 lerp → qFromEuler。
 * 这是「直觉做法」——但路径穿过欧拉角空间而非旋转群，
 * 在多轴复合旋转下明显偏离球面大圆（与 qSlerp 对比即教学点）。
 */
export function eulerLerp(a: Quat, b: Quat, t: number): Quat {
  const ea = qToEuler(a);
  const eb = qToEuler(b);
  return qFromEuler(
    ea.roll + (eb.roll - ea.roll) * t,
    ea.pitch + (eb.pitch - ea.pitch) * t,
    ea.yaw + (eb.yaw - ea.yaw) * t,
  );
}

export interface Euler {
  roll: number;
  pitch: number;
  yaw: number;
}

/**
 * 四元数 → 欧拉角（弧度），与 qFromEuler 互逆。
 * 复合顺序 R = R_z(ψ)·R_y(θ)·R_x(φ)（ZYX：先偏航再俯仰后横滚的内旋序，
 * 等价于绕固定轴先横滚、再俯仰、后偏航）。
 * pitch 用 atan2 双参数形式而非 asin：在 ±90°（万向节锁）附近数值更稳——
 * asin 在 |参数|→1 处导数发散，atan2 两侧始终良态（Wikipedia 收录的稳定公式）。
 */
export function qToEuler(q: Quat): Euler {
  const d = Math.max(-0.5, Math.min(0.5, q.w * q.y - q.z * q.x)); // ½·sin(pitch)
  return {
    roll: Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)),
    pitch: 2 * Math.atan2(Math.sqrt(1 + 2 * d), Math.sqrt(1 - 2 * d)) - Math.PI / 2,
    yaw: Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)),
  };
}

/** 两姿态间的夹角（弧度） */
export function qAngleBetween(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b))));
}

/** v 沿 q 旋转（体→世界）：v + 2w(u×v) + 2u×(u×v) */
export function qRot(q: Quat, v: V3): V3 {
  const u: V3 = [q.x, q.y, q.z];
  const cross = (a: V3, b: V3): V3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const uxv = cross(u, v);
  const uxuxv = cross(u, uxv);
  return [
    v[0] + 2 * q.w * uxv[0] + 2 * uxuxv[0],
    v[1] + 2 * q.w * uxv[1] + 2 * uxuxv[1],
    v[2] + 2 * q.w * uxv[2] + 2 * uxuxv[2],
  ];
}

/** v 沿 q 的共轭旋转（世界→体），即 Rᵀ·v */
export function qRotInv(q: Quat, v: V3): V3 {
  return qRot(qConj(q), v);
}

/** 球面线性插值，短路径 */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = qDot(a, b);
  const bb = d < 0 ? { w: -b.w, x: -b.x, y: -b.y, z: -b.z } : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    return qNorm({
      w: a.w + (bb.w - a.w) * t,
      x: a.x + (bb.x - a.x) * t,
      y: a.y + (bb.y - a.y) * t,
      z: a.z + (bb.z - a.z) * t,
    });
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return {
    w: a.w * wa + bb.w * wb,
    x: a.x * wa + bb.x * wb,
    y: a.y * wa + bb.y * wb,
    z: a.z * wa + bb.z * wb,
  };
}

/**
 * 单位四元数的对数：log(q) = v̂·(θ/2)（纯四元数向量部分；acos(w) 恰为半角）。
 * q 与 −q 取同值（落 w≥0 短路径）；零旋转返回 [0,0,0]。
 * Squad 内积切线与「Slerp 导数 = log(q₁q₀⁻¹)·½ω」分析都用它。
 */
export function qLog(q: Quat): V3 {
  const n = Math.hypot(q.x, q.y, q.z);
  if (n < 1e-12) return [0, 0, 0];
  const s = q.w < 0 ? -1 : 1;
  const angle = Math.acos(Math.min(1, s * q.w));
  return [(s * q.x / n) * angle, (s * q.y / n) * angle, (s * q.z / n) * angle];
}

/** qLog 的逆映射：exp(v) = [cos‖v‖, v̂·sin‖v‖]（单位四元数）。qExp(qLog(q)) ≈ q */
export function qExp(v: V3): Quat {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-12) return qId();
  return {
    w: Math.cos(n),
    x: (v[0] / n) * Math.sin(n),
    y: (v[1] / n) * Math.sin(n),
    z: (v[2] / n) * Math.sin(n),
  };
}

/**
 * Squad 内积切线（Shoemake / Dam 等报告的标准形式）：
 * sᵢ = qᵢ ⊗ exp(−(log(qᵢ⁻¹qᵢ₊₁) + log(qᵢ⁻¹qᵢ₋₁)) / 4)
 * 几何含义：把两侧相邻段的对数平均「预旋」进 qᵢ，让相邻段的角速度在关键帧处衔接平滑。
 */
export function squadTangent(prev: Quat, cur: Quat, next: Quat): Quat {
  const inv = qConj(cur);
  const lNext = qLog(qMul(inv, next));
  const lPrev = qLog(qMul(inv, prev));
  const t: V3 = [-(lNext[0] + lPrev[0]) / 4, -(lNext[1] + lPrev[1]) / 4, -(lNext[2] + lPrev[2]) / 4];
  return qMul(cur, qExp(t));
}

/**
 * Squad（球面四边形插值）：四关键帧 q₀,q₁,q₂,q₃ 之间 q₁→q₂ 段的 C¹ 光滑插值。
 * squad(q₁,q₂,s₁,s₂,t) = slerp( slerp(q₁,q₂,t), slerp(s₁,s₂,t), 2t(1−t) )
 * 外层 2t(1−t) 在两端为 0 → 端点严格等于 q₁/q₂，中途把内层两个 slerp 按抛物线权重混合。
 */
export function squad(q1: Quat, q2: Quat, s1: Quat, s2: Quat, t: number): Quat {
  const a = qSlerp(q1, q2, t);
  const b = qSlerp(s1, s2, t);
  return qSlerp(a, b, 2 * t * (1 - t));
}

/**
 * 四元数 → 方向余弦矩阵（DCM，行主序 3×3）：C = R(q)，机体系→世界系，
 * 即 world = C · body（与 qRot 严格一致，qRotInv 等价于 Cᵀ·v）。
 * DCM 是惯性导航里与四元数并列的标准姿态表示（见文档·四种姿态表示）。
 */
export function qToMatrix(q: Quat): number[] {
  const { w, x, y, z } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
