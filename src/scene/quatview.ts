import * as THREE from "three";
import { buildQuad, type QuadModel } from "./quad";
import { makeTextSprite } from "./labels";
import { toDisplayQ, toDisplayVec } from "../core/gimbal";
import { eulerLerp, qFromEuler, qRot, qSlerp, squad, squadTangent, type Quat } from "../core/quat";

export interface QuatPosePair {
  id: string;
  name: string;
  /** 度（NED 欧拉角） */
  from: [number, number, number];
  to: [number, number, number];
  /** 四关键帧路径（Squad 演示）：[p0, p1=from, p2=to, p3]，缺省无 Squad 弧 */
  path?: Array<[number, number, number]>;
}

/**
 * 预设姿态对：多轴复合旋转下 Slerp（大圆）与欧拉插值（扭曲线）分叉最明显。
 * from/to 为 (横滚, 俯仰, 偏航)，单位度；带 path 的预设额外画 Squad 弧（琥珀）。
 */
export const QUAT_POSE_PAIRS: QuatPosePair[] = [
  { id: "combo", name: "偏航+俯仰+横滚（差异最大）", from: [0, 0, 0], to: [140, 70, 160] },
  { id: "flip", name: "俯仰翻越 90°", from: [0, -60, 0], to: [80, 120, 90] },
  { id: "roll", name: "纯横滚 180°（两者几乎重合）", from: [0, 0, 0], to: [180, 0, 0] },
  {
    id: "squad",
    name: "四关键帧路径（Squad vs Slerp）",
    from: [0, 0, 0],
    to: [140, 70, 160],
    path: [[-40, 20, 30], [0, 0, 0], [140, 70, 160], [175, 100, 205]],
  },
];

/** 参考球半径：所有轨迹弧贴着这个球面 */
export const SPHERE_RADIUS = 0.85;
/** 4D 投影模式专用球半径：缩小给下方「姿态舞台」和 −q 钳制位留出画面 */
export const PROJ_RADIUS = 0.62;
/** 参考向量：机头方向（NED +X）。弧线 = 该向量末端在球面上的轨迹 */
const REF_VEC: [number, number, number] = [1, 0, 0];

export interface QuatViewRig {
  group: THREE.Group;
  /** 插值演示的当前姿态四轴（由 t 驱动） */
  quad: QuadModel;
  /**
   * 设置插值演示：姿态对（NED 欧拉角，度）与进度 t。
   * 重建两条弧线几何、移动当前四轴到插值姿态、更新轴角箭头与滑动 marker。
   * path（四关键帧 [p0,p1=from,p2=to,p3]）缺省时不画 Squad 弧；提供时额外采样 Squad。
   */
  setInterpolation(
    fromDeg: [number, number, number],
    toDeg: [number, number, number],
    t: number,
    path?: Array<[number, number, number]>,
  ): void;
  /** q 与 −q 演示：给定姿态（NED 欧拉角，度），并排两个四轴分别按 q 与 −q 摆位 */
  setNegation(rollDeg: number, pitchDeg: number, yawDeg: number): void;
  /** 切换插值组 / q−q 组的可见性 */
  showNegation(show: boolean): void;
  /** 4D 立体投影演示：把单位四元数 q 投到 3D（q 球内青点 / −q 球外品红点 + 轨迹） */
  setProjection(q: Quat): void;
  /** 清空 q 与 −q 的投影轨迹（重置时调用，回到干净画面） */
  clearProjectionTrails(): void;
  /** 切换 4D 投影组与其它组的可见性 */
  showProjection(show: boolean): void;
  /** 供 scenecheck 检视的内部结构 */
  parts: {
    interpGroup: THREE.Group;
    negGroup: THREE.Group;
    projGroup: THREE.Group;
    /** 采样点数组（显示坐标，N=ARC_SAMPLES+1）：弧线几何由这些点生成 */
    slerpPoints: THREE.Vector3[];
    eulerPoints: THREE.Vector3[];
    /** Squad 弧采样点（仅带 path 的预设填充；供 scenecheck 断言） */
    squadPoints: THREE.Vector3[];
    negA: QuadModel;
    negB: QuadModel;
    axisArrow: THREE.ArrowHelper;
    sphere: THREE.Mesh;
    /** 4D 投影：q 与 −q 的投影位置（显示坐标），供 scenecheck 断言 */
    projQPos: THREE.Vector3;
    projNegPos: THREE.Vector3;
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
  // Squad 弧（琥珀，仅四关键帧预设显示）：多关键帧的 C¹ 光滑插值对照组
  const SQUAD_COLOR = 0xf0c674;
  const squadLine = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      color: SQUAD_COLOR,
      emissive: new THREE.Color(SQUAD_COLOR).multiplyScalar(0.35),
      roughness: 0.4,
    }),
  );
  squadLine.visible = false;
  interpGroup.add(slerpLine, eulerLine, squadLine);

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
  const squadPoints: THREE.Vector3[] = [];

  // ---------------- 4D 立体投影组 ----------------
  // S³ 上点 (w,x,y,z) 从南极 (−1,0,0,0) 投影到 w=0 三维空间：p = (x,y,z)/(1+w)。
  // 性质：赤道 w=0 投影恰为单位球面（与参考球重合）；w>0 在球内、w<0 在球外；
  // 对径点 q/−q 的投影满足 |p(q)|·|p(−q)| = 1（一对倒易点）。
  const projGroup = new THREE.Group();
  projGroup.visible = false;
  group.add(projGroup);

  const projSphereMat = new THREE.MeshBasicMaterial({
    color: 0x2a3b5e, transparent: true, opacity: 0.1, depthWrite: false,
  });
  const projSphere = new THREE.Mesh(new THREE.SphereGeometry(PROJ_RADIUS, 48, 32), projSphereMat);
  projGroup.add(projSphere);
  const projEquator = new THREE.Mesh(
    new THREE.TorusGeometry(PROJ_RADIUS, 0.006, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x3d5080, transparent: true, opacity: 0.4 }),
  );
  projEquator.rotation.x = Math.PI / 2;
  projGroup.add(projEquator);

  /** 上一次有效投影方向：q 逼近极点（v→0）时延续它，避免终点跳到任意方向 */
  let lastDir: [number, number, number] = [1, 0, 0];
  /** S³ → 3D 投影（含 3R 长度钳制），返回显示坐标 */
  const project4d = (w: number, x: number, y: number, z: number): THREE.Vector3 => {
    const n = Math.hypot(x, y, z);
    if (n > 1e-9) lastDir = [x / n, y / n, z / n];
    else lastDir = [1, 0, 0]; // 恰在极点（单位/负单位姿态）：钳制方向规范化——重置后 −q 落点永远一致
    const dir = lastDir;
    const denom = 1 + w; // 南极 w=−1 为投影极点
    const len = denom < 1e-6 ? Infinity : n / denom;
    const L = Math.min(len, 3) * PROJ_RADIUS; // 单位球尺度 → 投影球尺度（钳制在 3R 内）
    return vecToDisplay([dir[0] * L, dir[1] * L, dir[2] * L]);
  };

  // q（青）/ −q（品红）标记与连线
  const projQ = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color: 0x22d3ee }),
  );
  const projNeg = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe879f9 }),
  );
  projGroup.add(projQ, projNeg);
  const projTie = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x546a99, transparent: true, opacity: 0.55 }),
  );
  projGroup.add(projTie);
  const projLabelQ = makeTextSprite("q", "#7fe3f5", { size: 0.22 });
  const projLabelNeg = makeTextSprite("−q", "#f0a6e8", { size: 0.22 });
  projGroup.add(projLabelQ, projLabelNeg);

  // 轨迹：q 投影点走过的路径（青色细线，最近 240 点）
  const projTrailPts: THREE.Vector3[] = [];
  const projTrail = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.4 }),
  );
  const projTrailNegPts: THREE.Vector3[] = [];
  const projTrailNeg = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.22 }),
  );
  projGroup.add(projTrail, projTrailNeg);

  // 基向量架：1 投影到原点；i/j/k（w=0）恰落在球面上
  const projOne = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 10, 8), new THREE.MeshBasicMaterial({ color: 0x93a2bb }),
  );
  projGroup.add(projOne);
  const projOneLabel = makeTextSprite("1", "#7f8da6", { size: 0.13 });
  projOneLabel.position.set(0.07, -0.075, 0);
  projGroup.add(projOneLabel);
  // w 语义锚点：球内=北半球（w>0），球外=南半球（w<0）——投影的「内外有别」一眼可读
  const wInLabel = makeTextSprite("球内 · w > 0", "#8a9ab5", { size: 0.14 });
  wInLabel.position.set(0, PROJ_RADIUS * 0.52, 0);
  const wOutLabel = makeTextSprite("球外 · w < 0", "#8a9ab5", { size: 0.14 });
  wOutLabel.position.set(0, PROJ_RADIUS + 0.3, 0);
  projGroup.add(wInLabel, wOutLabel);
  const projBasis = new THREE.Group();
  projGroup.add(projBasis);
  const BASIS: Array<[string, [number, number, number]]> = [
    ["i", [1, 0, 0]], ["j", [0, 1, 0]], ["k", [0, 0, 1]],
  ];
  for (const [name, v] of BASIS) {
    const p = vecToDisplay(v).multiplyScalar(PROJ_RADIUS);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 12, 10), new THREE.MeshBasicMaterial({ color: 0x58a6ff }),
    );
    m.position.copy(p);
    const l = makeTextSprite(name, "#8dbdf0", { size: 0.19 });
    l.position.copy(p.clone().multiplyScalar(1.14));
    projBasis.add(m, l);
  }

  // 姿态舞台：球下方的小四轴同步显示 q 代表的 3D 姿态——与球内 4D 点分离，互不遮挡
  const projQuad = buildQuad(false, { axes: false });
  projQuad.group.scale.setScalar(0.42);
  projQuad.group.position.set(0, -0.98, 0);
  projGroup.add(projQuad.group);
  const projQuadLabel = makeTextSprite("3D 姿态（与 q 同步）", "#8a9ab5", { size: 0.14 });
  projQuadLabel.position.set(0, -1.24, 0);
  projGroup.add(projQuadLabel);

  const projQPos = new THREE.Vector3();
  const projNegPos = new THREE.Vector3();

  return {
    group,
    quad,
    parts: {
      interpGroup,
      negGroup,
      projGroup,
      slerpPoints,
      eulerPoints,
      squadPoints,
      negA,
      negB,
      axisArrow,
      sphere,
      projQPos,
      projNegPos,
    },
    setInterpolation(fromDeg, toDeg, t, path) {
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

      // Squad 弧（琥珀）：四关键帧的内积切线 + squad 混合；无 path 时隐藏
      squadPoints.length = 0;
      if (path && path.length === 4) {
        const p0 = quatFromEulerDeg(path[0]);
        const p1 = quatFromEulerDeg(path[1]);
        const p2 = quatFromEulerDeg(path[2]);
        const p3 = quatFromEulerDeg(path[3]);
        const s1 = squadTangent(p0, p1, p2);
        const s2 = squadTangent(p1, p2, p3);
        for (let i = 0; i <= ARC_SAMPLES; i++) {
          const u = i / ARC_SAMPLES;
          const qs = squad(p1, p2, s1, s2, u);
          squadPoints.push(vecToDisplay(qRot(qs, REF_VEC)).multiplyScalar(r0));
        }
        squadLine.geometry.dispose();
        squadLine.geometry = new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(squadPoints), 96, 0.012, 10, false,
        );
        squadLine.visible = true;
      } else {
        squadLine.geometry.dispose();
        squadLine.geometry = new THREE.BufferGeometry();
        squadLine.visible = false;
      }

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
      if (show) projGroup.visible = false;
    },
    setProjection(q) {
      // 归一化输入，保证点在 S³ 上
      const n = Math.hypot(q.w, q.x, q.y, q.z);
      const qw = q.w / n, qx = q.x / n, qy = q.y / n, qz = q.z / n;
      const pq = project4d(qw, qx, qy, qz);
      const pn = project4d(-qw, -qx, -qy, -qz);
      projQPos.copy(pq);
      projNegPos.copy(pn);
      projQ.position.copy(pq);
      projNeg.position.copy(pn);
      // 标签沿径向外推；q 近原点时给最小竖直偏移，避免与原点「1」重叠
      projLabelQ.position.copy(
        pq.length() > 0.14 ? pq.clone().multiplyScalar(1.18) : pq.clone().add(new THREE.Vector3(0, 0.13, 0)),
      );
      projLabelNeg.position.copy(pn.clone().multiplyScalar(1.07));
      projTie.geometry.setFromPoints([pq, pn]);
      // 双轨迹：q（青）与 −q（品红）各留一条——对径点的内外互换一目了然
      const last = projTrailPts[projTrailPts.length - 1];
      if (!last || last.distanceTo(pq) > 0.012) {
        projTrailPts.push(pq.clone());
        if (projTrailPts.length > 240) projTrailPts.shift();
        projTrail.geometry.dispose();
        projTrail.geometry = new THREE.BufferGeometry().setFromPoints(projTrailPts);
      }
      const lastNeg = projTrailNegPts[projTrailNegPts.length - 1];
      if (!lastNeg || lastNeg.distanceTo(pn) > 0.012) {
        projTrailNegPts.push(pn.clone());
        if (projTrailNegPts.length > 240) projTrailNegPts.shift();
        projTrailNeg.geometry.dispose();
        projTrailNeg.geometry = new THREE.BufferGeometry().setFromPoints(projTrailNegPts);
      }
      applyDisplayQuat(projQuad.group, { w: qw, x: qx, y: qy, z: qz });
    },
    clearProjectionTrails() {
      projTrailPts.length = 0;
      projTrailNegPts.length = 0;
      projTrail.geometry.dispose();
      projTrail.geometry = new THREE.BufferGeometry();
      projTrailNeg.geometry.dispose();
      projTrailNeg.geometry = new THREE.BufferGeometry();
    },
    showProjection(show) {
      projGroup.visible = show;
      if (show) {
        interpGroup.visible = false;
        negGroup.visible = false;
        sphere.visible = false;
      }
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
