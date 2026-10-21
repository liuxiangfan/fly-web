import * as THREE from "three";
import { buildQuad, type QuadModel } from "./quad";
import { makeTextSprite } from "./labels";
import { toDisplayQ, toDisplayVec } from "../core/gimbal";
import { eulerLerp, qFromEuler, qRot, qSlerp, qConj, qMul, qToAxisAngle, type Quat } from "../core/quat";

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

export interface QuatViewRig {
  group: THREE.Group;
  /** 插值演示的当前姿态四轴（由 t 驱动） */
  quad: QuadModel;
  /**
   * 设置插值演示：姿态对（NED 欧拉角，度）与进度 t。
   * 重建两条弧线几何、移动当前四轴到插值姿态、更新轴角箭头。
   */
  setInterpolation(fromDeg: [number, number, number], toDeg: [number, number, number], t: number): void;
  /** q 与 −q 演示：给定姿态（NED 欧拉角，度），两个四轴分别按 q 与 −q 摆位 */
  setNegation(rollDeg: number, pitchDeg: number, yawDeg: number): void;
  /** 切换插值组 / q−q 组的可见性 */
  showNegation(show: boolean): void;
  /** 供 scenecheck 检视的内部结构 */
  parts: {
    interpGroup: THREE.Group;
    negGroup: THREE.Group;
    slerpLine: THREE.Line;
    eulerLine: THREE.Line;
    startQuad: QuadModel;
    endQuad: QuadModel;
    negA: QuadModel;
    negB: QuadModel;
    axisArrow: THREE.ArrowHelper;
  };
}

const SLERP_COLOR = 0xf1f5f9; // 白 = 理想路径（大圆）
const EULER_COLOR = 0xe879f9; // 品红 = 欧拉插值（扭曲线）
const ARC_SAMPLES = 64;

/**
 * 四元数可视化视图：
 *  - 插值组：起点/终点线框四轴 + Slerp（白）/欧拉（品红）两条机头轨迹弧 + 当前进度实体四轴 + 轴角箭头
 *  - q−q 组：同一姿态的两个四轴（分别按 q 与 −q 摆放），始终重合
 */
export function buildQuatView(): QuatViewRig {
  const group = new THREE.Group();

  // ---------------- 插值组 ----------------
  const interpGroup = new THREE.Group();
  group.add(interpGroup);

  // 起点（半透明蓝）/ 终点（半透明橙）线框四轴
  const startQuad = buildQuad(true);
  tintGhost(startQuad, 0x58a6ff, 0.4);
  const endQuad = buildQuad(true);
  tintGhost(endQuad, 0xffa657, 0.4);
  interpGroup.add(startQuad.group, endQuad.group);

  // 两条弧线
  const slerpLine = makeArcLine(SLERP_COLOR);
  const eulerLine = makeArcLine(EULER_COLOR);
  interpGroup.add(slerpLine, eulerLine);

  // 当前姿态四轴（实体，跟随 t）
  const quad = buildQuad(false);
  interpGroup.add(quad.group);

  // 轴角箭头：从原点指向当前姿态的旋转轴（角度用弧长刻度示意）
  const axisArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 0.85, 0x22d3ee, 0.1, 0.06,
  );
  interpGroup.add(axisArrow);

  // ---------------- q 与 −q 组 ----------------
  const negGroup = new THREE.Group();
  negGroup.visible = false;
  group.add(negGroup);
  const negA = buildQuad(false);
  const negB = buildQuad(false);
  // 两个实体四轴完全重合——这正是要演示的
  negGroup.add(negA.group, negB.group);
  const labelA = makeTextSprite("q", "#8dbdf0", { size: 0.24 });
  const labelB = makeTextSprite("−q", "#e0bc80", { size: 0.24 });
  labelA.position.set(0.55, 0.42, 0);
  labelB.position.set(-0.55, -0.42, 0);
  negGroup.add(labelA, labelB);

  return {
    group,
    quad,
    parts: { interpGroup, negGroup, slerpLine, eulerLine, startQuad, endQuad, negA, negB, axisArrow },
    setInterpolation(fromDeg, toDeg, t) {
      const qFrom = quatFromEulerDeg(fromDeg);
      const qTo = quatFromEulerDeg(toDeg);

      // 端点四轴摆位
      applyDisplayQuat(startQuad.group, qFrom);
      applyDisplayQuat(endQuad.group, qTo);

      // 采样两条弧：参考方向取机头 +X，插值四元数把单位 X 转到哪里
      const slerpPts: THREE.Vector3[] = [];
      const eulerPts: THREE.Vector3[] = [];
      for (let i = 0; i <= ARC_SAMPLES; i++) {
        const u = i / ARC_SAMPLES;
        const qs = qSlerp(qFrom, qTo, u);
        const qe = eulerLerp(qFrom, qTo, u);
        slerpPts.push(vecToDisplay(qRot(qs, [1, 0, 0])));
        eulerPts.push(vecToDisplay(qRot(qe, [1, 0, 0])));
      }
      slerpLine.geometry.setFromPoints(slerpPts);
      eulerLine.geometry.setFromPoints(eulerPts);

      // 当前姿态四轴
      const qCur = qSlerp(qFrom, qTo, clamp01(t));
      applyDisplayQuat(quad.group, qCur);

      // 轴角箭头：qFrom → qCur 的增量旋转
      const delta = quatDeltaNed(qFrom, qCur);
      const { axis, angle } = axisAngleOf(delta);
      if (angle > 1e-6) {
        axisArrow.visible = true;
        axisArrow.setDirection(vecToDisplay(axis).normalize());
        axisArrow.setLength(Math.min(1.1, 0.35 + angle * 0.5), 0.1, 0.06);
      } else {
        axisArrow.visible = false;
      }
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
    },
  };
}

// ---------------- 内部工具 ----------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 给 ghost 四轴整体换色（覆盖线框材质颜色与透明度） */
function tintGhost(model: QuadModel, color: number, opacity: number): void {
  model.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const basic = m as THREE.MeshBasicMaterial;
      if (basic.isMeshBasicMaterial) {
        basic.color.setHex(color);
        basic.opacity = opacity;
      }
    }
  });
}

function makeArcLine(color: number): THREE.Line {
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const geom = new THREE.BufferGeometry();
  const line = new THREE.Line(geom, mat);
  line.renderOrder = 5;
  return line;
}

/** NED 欧拉角（度）→ NED 四元数（core/quat.qFromEuler 的度数封装） */
function quatFromEulerDeg(d: [number, number, number]): Quat {
  const k = Math.PI / 180;
  return qFromEuler(d[0] * k, d[1] * k, d[2] * k);
}

/** delta = qFrom⁻¹ ⊗ qCur（体坐标系增量旋转） */
function quatDeltaNed(qFrom: Quat, qCur: Quat): Quat {
  return qMul(qConj(qFrom), qCur);
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

/** 轴角提取（core/quat.qToAxisAngle 的内联调用，V3 → 元组） */
function axisAngleOf(q: Quat): { axis: [number, number, number]; angle: number } {
  const { axis, angle } = qToAxisAngle(q);
  return { axis, angle };
}
