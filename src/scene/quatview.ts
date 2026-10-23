import * as THREE from "three";
import { buildQuad, type QuadModel } from "./quad";
import { makeTextSprite } from "./labels";
import { toDisplayQ, toDisplayVec } from "../core/gimbal";
import { eulerLerp, qFromEuler, qRot, qSlerp, type Quat } from "../core/quat";

export interface QuatPosePair {
  id: string;
  name: string;
  /** 度（NED 欧拉角） */
  from: [number, number, number];
  to: [number, number, number];
}

/**
 * 预设姿态对：多轴复合旋转下 Slerp（大圆）与欧拉插值（扭曲线）分叉最明显。
 * from/to 为 (横滚, 俯仰, 偏航)，单位度。
 */
export const QUAT_POSE_PAIRS: QuatPosePair[] = [
  { id: "combo", name: "偏航+俯仰+横滚（差异最大）", from: [0, 0, 0], to: [140, 70, 160] },
  { id: "flip", name: "俯仰翻越 90°", from: [0, -60, 0], to: [80, 120, 90] },
  { id: "roll", name: "纯横滚 180°（两者几乎重合）", from: [0, 0, 0], to: [180, 0, 0] },
];

/** 参考球半径：所有轨迹弧贴着这个球面 */
export const SPHERE_RADIUS = 0.85;
/** 参考向量：机头方向（NED +X）。弧线 = 该向量末端在球面上的轨迹 */
const REF_VEC: [number, number, number] = [1, 0, 0];

export interface QuatViewRig {
  group: THREE.Group;
  /** 插值演示的当前姿态四轴（由 t 驱动） */
  quad: QuadModel;
  /**
   * 设置插值演示：姿态对（NED 欧拉角，度）与进度 t。
   * 重建两条弧线几何、移动当前四轴到插值姿态、更新轴角箭头与滑动 marker。
   */
  setInterpolation(fromDeg: [number, number, number], toDeg: [number, number, number], t: number): void;
  /** q 与 −q 演示：给定姿态（NED 欧拉角，度），并排两个四轴分别按 q 与 −q 摆位 */
  setNegation(rollDeg: number, pitchDeg: number, yawDeg: number): void;
  /** 切换插值组 / q−q 组的可见性 */
  showNegation(show: boolean): void;
  /** 供 scenecheck 检视的内部结构 */
  parts: {
    interpGroup: THREE.Group;
    negGroup: THREE.Group;
    /** 采样点数组（显示坐标，N=ARC_SAMPLES+1）：弧线几何由这些点生成 */
    slerpPoints: THREE.Vector3[];
    eulerPoints: THREE.Vector3[];
    negA: QuadModel;
    negB: QuadModel;
    axisArrow: THREE.ArrowHelper;
    sphere: THREE.Mesh;
  };
}

const SLERP_COLOR = 0xf1f5f9; // 白 = 理想路径（大圆）
const EULER_COLOR = 0xe879f9; // 品红 = 欧拉插值（扭曲线）
const ARC_SAMPLES = 64;

/**
 * 四元数可视化视图（球面参考方案）：
 *  - 半透明参考球：插值轨迹贴着球面走，「旋转路径在球面上」一眼可读
 *  - Slerp（白管）/欧拉（品红管）两条管状弧 + 起终点小球 + 双滑动 marker
 *  - 中央实体四轴（缩小）+ 机头向量箭头 + 轴角箭头
 *  - q−q 并排组：两个四轴沿 X 轴偏移，姿态恒等（双覆盖可视化）
 */
export function buildQuatView(): QuatViewRig {
  const group = new THREE.Group();

  // ---------------- 插值组 ----------------
  const interpGroup = new THREE.Group();
  group.add(interpGroup);

  // 参考球：低透明度球面 + 赤道环 + 极轴
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0x2a3b5e,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_RADIUS, 48, 32), sphereMat);
  interpGroup.add(sphere);
  const equator = new THREE.Mesh(
    new THREE.TorusGeometry(SPHERE_RADIUS, 0.005, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x3d5080, transparent: true, opacity: 0.35 }),
  );
  equator.rotation.x = Math.PI / 2; // 赤道环放平（XZ 平面）
  interpGroup.add(equator);
  const polarAxis = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -SPHERE_RADIUS, 0),
      new THREE.Vector3(0, SPHERE_RADIUS, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0x3d5080, transparent: true, opacity: 0.3 }),
  );
  interpGroup.add(polarAxis);

  // 起点（蓝球）/ 终点（橙球）标记
  const startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff }),
  );
  const endMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa657 }),
  );
  interpGroup.add(startMarker, endMarker);

  // 两条管状弧（TubeGeometry 由 setInterpolation 重建）
  const slerpLine = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: SLERP_COLOR,
      emissive: new THREE.Color(SLERP_COLOR).multiplyScalar(0.35),
      roughness: 0.4,
    }),
  );
  const eulerLine = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: EULER_COLOR,
      emissive: new THREE.Color(EULER_COLOR).multiplyScalar(0.35),
      roughness: 0.4,
    }),
  );
  interpGroup.add(slerpLine, eulerLine);

  // 双滑动 marker：白球沿 Slerp 弧、品红球沿欧拉弧
  const slerpMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  const eulerMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xe879f9 }),
  );
  interpGroup.add(slerpMarker, eulerMarker);

  // 当前姿态四轴（实体，缩小避免遮挡球体）
  const quad = buildQuad(false, { axes: false });
  quad.group.scale.setScalar(0.55);
  interpGroup.add(quad.group);

  // 轴角箭头
  const axisArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 0.85, 0x22d3ee, 0.1, 0.06,
  );
  interpGroup.add(axisArrow);

  // ---------------- q 与 −q 组 ----------------
  const negGroup = new THREE.Group();
  negGroup.visible = false;
  group.add(negGroup);
  const negA = buildQuad(false, { axes: false });
  const negB = buildQuad(false, { axes: false });
  negA.group.position.x = -0.95;
  negB.group.position.x = 0.95;
  negGroup.add(negA.group, negB.group);
  const labelA = makeTextSprite("q", "#8dbdf0", { size: 0.26 });
  const labelB = makeTextSprite("−q", "#e0bc80", { size: 0.26 });
  labelA.position.set(-0.95, 0.52, 0);
  labelB.position.set(0.95, 0.52, 0);
  negGroup.add(labelA, labelB);
  // 两个并排姿态之间画一条「姿态相同」的提示虚线
  const tie = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.55, 0.25, 0), new THREE.Vector3(0.55, 0.25, 0)]),
    new THREE.LineBasicMaterial({ color: 0x3d5080, transparent: true, opacity: 0.5 }),
  );
  negGroup.add(tie);

  const slerpPoints: THREE.Vector3[] = [];
  const eulerPoints: THREE.Vector3[] = [];

  return {
    group,
    quad,
    parts: {
      interpGroup,
      negGroup,
      slerpPoints,
      eulerPoints,
      negA,
      negB,
      axisArrow,
      sphere,
    },
    setInterpolation(fromDeg, toDeg, t) {
      const qFrom = quatFromEulerDeg(fromDeg);
      const qTo = quatFromEulerDeg(toDeg);
      const r0 = SPHERE_RADIUS;

      // 端点标记贴球面
      const noseFrom = vecToDisplay(qRot(qFrom, REF_VEC)).multiplyScalar(r0);
      const noseTo = vecToDisplay(qRot(qTo, REF_VEC)).multiplyScalar(r0);
      startMarker.position.copy(noseFrom);
      endMarker.position.copy(noseTo);

      // 采样两条弧：参考方向 = 机头 +X，插值四元数把机头转到球面上的新位置
      slerpPoints.length = 0;
      eulerPoints.length = 0;
      for (let i = 0; i <= ARC_SAMPLES; i++) {
        const u = i / ARC_SAMPLES;
        const qs = qSlerp(qFrom, qTo, u);
        const qe = eulerLerp(qFrom, qTo, u);
        slerpPoints.push(vecToDisplay(qRot(qs, REF_VEC)).multiplyScalar(r0));
        eulerPoints.push(vecToDisplay(qRot(qe, REF_VEC)).multiplyScalar(r0));
      }
      slerpLine.geometry.dispose();
      slerpLine.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(slerpPoints), 96, 0.012, 10, false,
      );
      eulerLine.geometry.dispose();
      eulerLine.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(eulerPoints), 96, 0.012, 10, false,
      );

      // 滑动 marker：当前 t 在两条路径上的位置
      slerpMarker.position.copy(slerpPoints[Math.round(clamp01(t) * ARC_SAMPLES)]);
      eulerMarker.position.copy(eulerPoints[Math.round(clamp01(t) * ARC_SAMPLES)]);

      // 当前姿态四轴
      const qCur = qSlerp(qFrom, qTo, clamp01(t));
      applyDisplayQuat(quad.group, qCur);

      // 机头向量箭头：从球心指向当前 Slerp 机头方向（长度随进度呼吸，中点最长）
      const curNose = vecToDisplay(qRot(qCur, REF_VEC));
      axisArrow.setDirection(curNose.clone().normalize());
      axisArrow.setLength(0.6 + 0.25 * Math.sin(clamp01(t) * Math.PI), 0.1, 0.06);
    },
    setNegation(rollDeg, pitchDeg, yawDeg) {
      const q = quatFromEulerDeg([rollDeg, pitchDeg, yawDeg]);
      const qn: Quat = { w: -q.w, x: -q.x, y: -q.y, z: -q.z };
      applyDisplayQuat(negA.group, q);
      applyDisplayQuat(negB.group, qn);
    },
    showNegation(show) {
      negGroup.visible = show;
      interpGroup.visible = !show;
      sphere.visible = !show;
    },
  };
}

// ---------------- 内部工具 ----------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** NED 欧拉角（度）→ NED 四元数（core/quat.qFromEuler 的度数封装） */
function quatFromEulerDeg(d: [number, number, number]): Quat {
  const k = Math.PI / 180;
  return qFromEuler(d[0] * k, d[1] * k, d[2] * k);
}

/** NED 世界系向量 → 显示坐标系 three.js 向量 */
function vecToDisplay(v: [number, number, number]): THREE.Vector3 {
  const d = toDisplayVec(v);
  return new THREE.Vector3(d[0], d[1], d[2]);
}

/** 把 NED 四元数应用到 three.js 组（S·q·S⁻¹ 基变换） */
function applyDisplayQuat(g: THREE.Group, qNed: Quat): void {
  const r = toDisplayQ(qNed);
  g.quaternion.set(r.x, r.y, r.z, r.w);
}
