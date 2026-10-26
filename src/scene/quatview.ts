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
const ARC_SAMPLES = 72;

export interface QuatViewRig {
  group: THREE.Group;
  /** 插值演示的当前姿态四轴（由 t 驱动） */
  quad: QuadModel;
  /**
   * 设置姿态对并重建轨迹几何（**只在姿态对变化时调用**）。
   * path（四关键帧 [p0,p1=from,p2=to,p3]）缺省时不画 Squad 弧；提供时额外采样 Squad。
   */
  setPair(
    fromDeg: [number, number, number],
    toDeg: [number, number, number],
    path?: Array<[number, number, number]>,
  ): void;
  /** 只更新进度 t（轻量：移动 marker/四轴/轴角箭头，不重建几何） */
  setProgress(t: number): void;
  /** 兼容旧 API：设置姿态对 + 进度（内部会判断是否需要重建） */
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
  /** 当前进度与弧长信息（面板读数用） */
  arcInfo(): { t: number; slerpDeg: number; eulerDeg: number; deviationDeg: number };
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
    /** 起点/终点姿态的线框四轴（让「插的是姿态，不是箭头」一眼可见） */
    ghostFrom: QuadModel;
    ghostTo: QuadModel;
  };
}

const SLERP_COLOR = 0xf1f5f9; // 白 = 理想路径（大圆）
const EULER_COLOR = 0xe879f9; // 品红 = 欧拉插值（扭曲线）
const SQUAD_COLOR = 0xf0c674; // 琥珀 = Squad 多关键帧
const DEVIATION_COLOR = 0x7f5af0; // 偏差带

// ---------------- 内部工具 ----------------

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** NED 欧拉角（度）→ NED 四元数 */
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
function applyDisplayQuat(g: THREE.Object3D, qNed: Quat): void {
  const r = toDisplayQ(qNed);
  g.quaternion.set(r.x, r.y, r.z, r.w);
}

/** 参考球上的经纬网格线（比贴图便宜、比实心球清楚） */
function buildSphereGrid(radius: number, color: number, opacity: number): THREE.LineSegments {
  const pts: number[] = [];
  const seg = 72;
  // 纬线：每 30°，赤道单独加亮（另建）
  for (let lat = -60; lat <= 60; lat += 30) {
    const phi = (lat * Math.PI) / 180;
    const r = Math.cos(phi) * radius;
    const y = Math.sin(phi) * radius;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
    }
  }
  // 经线：每 45°
  for (let lon = 0; lon < 180; lon += 45) {
    const th = (lon * Math.PI) / 180;
    for (let i = 0; i < seg / 2; i++) {
      const p0 = (i / (seg / 2)) * Math.PI * 2 - Math.PI / 2;
      const p1 = ((i + 1) / (seg / 2)) * Math.PI * 2 - Math.PI / 2;
      pts.push(
        Math.cos(p0) * Math.cos(th) * radius, Math.sin(p0) * radius, Math.cos(p0) * Math.sin(th) * radius,
        Math.cos(p1) * Math.cos(th) * radius, Math.sin(p1) * radius, Math.cos(p1) * Math.sin(th) * radius,
      );
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(
    geom,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

/** 采样一条弧（NED 四元数序列 → 显示坐标点） */
function sampleArc(quats: Quat[], radius: number, out: THREE.Vector3[]): void {
  out.length = 0;
  for (const q of quats) out.push(vecToDisplay(qRot(q, REF_VEC)).multiplyScalar(radius));
}

/** 两条弧之间的「偏差带」：三角形条带，宽度 = 两条路径在该处的角距离 */
function buildDeviationRibbon(a: THREE.Vector3[], b: THREE.Vector3[]): THREE.BufferGeometry {
  const n = Math.min(a.length, b.length);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.push(a[i].x, a[i].y, a[i].z);
    pos.push(b[i].x, b[i].y, b[i].z);
  }
  for (let i = 0; i < n - 1; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 四元数可视化视图（重做版）：
 *  - 参考球 = S² 上的机头方向空间（经纬网格 + 高亮赤道 + 极点标记）
 *  - 白色 Slerp 弧 = 旋转群上的大圆；品红欧拉弧 = 欧拉角逐分量插值的扭曲线
 *  - 两弧之间铺一层半透明**偏差带**：分叉多少一眼可量（角距离）
 *  - 起点/终点各一个**线框四轴**，插值的是姿态本身而不是一个点
 *  - 滑动 marker 带一个机头小锥，指示「此刻机头指向」
 *  - 中心轴角箭头 = 当前姿态的等效旋转轴（与姿态视图的青色箭头同源）
 */
export function buildQuatView(): QuatViewRig {
  const group = new THREE.Group();

  // ---------------- 插值组 ----------------
  const interpGroup = new THREE.Group();
  group.add(interpGroup);

  // 球面：极淡的实心壳（提供体积感）+ 经纬网格（提供读数参考）
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0x1b2b47,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_RADIUS, 48, 32), sphereMat);
  interpGroup.add(sphere);
  const grid = buildSphereGrid(SPHERE_RADIUS, 0x33507a, 0.5);
  interpGroup.add(grid);

  // 赤道（机头水平方向集合）加亮
  const equator = new THREE.Mesh(
    new THREE.TorusGeometry(SPHERE_RADIUS, 0.006, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x4c6f9f, transparent: true, opacity: 0.55 }),
  );
  equator.rotation.x = Math.PI / 2;
  interpGroup.add(equator);

  // 极点：北极 = 机头朝上（俯仰 +90°），南极 = 朝下
  const poleMat = new THREE.MeshBasicMaterial({ color: 0x6f8bb5 });
  for (const [y, label] of [[1, "机头朝上"], [-1, "机头朝下"]] as Array<[number, string]>) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), poleMat);
    dot.position.set(0, y * SPHERE_RADIUS, 0);
    interpGroup.add(dot);
    const l = makeTextSprite(label, "#6f8bb5", { size: 0.075, bold: false });
    l.position.set(0, y * (SPHERE_RADIUS + 0.075), 0);
    interpGroup.add(l);
  }

  // 起点/终点标记球
  const startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff }),
  );
  const endMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffa657 }),
  );
  interpGroup.add(startMarker, endMarker);

  // 起点/终点姿态的线框四轴：**放在球外两侧的「姿态展示位」**，
  // 不压在球面上（旧版贴 0.62R 处，和弧线、网格混在一起像噪点）
  const ghostFrom = buildQuad(true, { axes: false });
  const ghostTo = buildQuad(true, { axes: false });
  ghostFrom.group.scale.setScalar(0.46);
  ghostTo.group.scale.setScalar(0.46);
  ghostFrom.group.position.set(-1.12, 0.3, 0);
  ghostTo.group.position.set(1.12, 0.3, 0);
  interpGroup.add(ghostFrom.group, ghostTo.group);
  const ghostFromLabel = makeTextSprite("起点姿态", "#8fb8d8", { size: 0.1, bold: false });
  ghostFromLabel.position.set(-1.12, -0.24, 0);
  const ghostToLabel = makeTextSprite("终点姿态", "#e0bc80", { size: 0.1, bold: false });
  ghostToLabel.position.set(1.12, -0.24, 0);
  interpGroup.add(ghostFromLabel, ghostToLabel);

  // 两条管状弧
  const makeTubeMat = (color: number, emissiveScale: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(emissiveScale),
      roughness: 0.35,
      metalness: 0.1,
    });
  const slerpLine = new THREE.Mesh(new THREE.BufferGeometry(), makeTubeMat(SLERP_COLOR, 0.4));
  const eulerLine = new THREE.Mesh(new THREE.BufferGeometry(), makeTubeMat(EULER_COLOR, 0.45));
  const squadLine = new THREE.Mesh(new THREE.BufferGeometry(), makeTubeMat(SQUAD_COLOR, 0.4));
  squadLine.visible = false;
  interpGroup.add(slerpLine, eulerLine, squadLine);

  // 偏差带：两条弧之间的半透明面，宽度 = 该处的角差
  const ribbon = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: DEVIATION_COLOR,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  interpGroup.add(ribbon);

  // 双滑动 marker：白球沿 Slerp、品红球沿欧拉；各带一个机头小锥
  const makeMarker = (color: number): { ball: THREE.Mesh; cone: THREE.Mesh; group: THREE.Group } => {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 16, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.022, 0.075, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    // ConeGeometry 的轴是 +Y，转到 +Z 后用 lookAt 对准球心→外侧方向
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 0.05;
    g.add(ball, cone);
    return { ball, cone, group: g };
  };
  const slerpMarker = makeMarker(0xffffff);
  const eulerMarker = makeMarker(EULER_COLOR);
  interpGroup.add(slerpMarker.group, eulerMarker.group);

  // 中心：当前姿态四轴
  const quad = buildQuad(false, { axes: false });
  quad.group.scale.setScalar(0.5);
  interpGroup.add(quad.group);

  // 中心→marker 的机头向量（细线，强化「弧线是机头尖端轨迹」）。
  // 位置属性**复用**：播放时每帧只改两个顶点，不再 dispose/新建几何
  const noseGeom = new THREE.BufferGeometry();
  noseGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const noseLine = new THREE.Line(
    noseGeom,
    new THREE.LineBasicMaterial({ color: 0x9fb4d0, transparent: true, opacity: 0.5 }),
  );
  interpGroup.add(noseLine);

  // 轴角箭头
  const axisArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 0.85, 0x22d3ee, 0.1, 0.06,
  );
  interpGroup.add(axisArrow);

  // 弧线标签（固定在弧中点外侧）
  const slerpLabel = makeTextSprite("Slerp", "#dfe8f5", { size: 0.085, bold: false });
  const eulerLabel = makeTextSprite("欧拉插值", "#f0a6e8", { size: 0.085, bold: false });
  interpGroup.add(slerpLabel, eulerLabel);

  // ---------------- q 与 −q 组 ----------------
  const negGroup = new THREE.Group();
  negGroup.visible = false;
  group.add(negGroup);
  const negA = buildQuad(false, { axes: false });
  const negB = buildQuad(false, { axes: false });
  negA.group.position.x = -0.95;
  negB.group.position.x = 0.95;
  negGroup.add(negA.group, negB.group);
  const labelA = makeTextSprite("q", "#8dbdf0", { size: 0.22 });
  const labelB = makeTextSprite("−q", "#e0bc80", { size: 0.22 });
  labelA.position.set(-0.95, 0.5, 0);
  labelB.position.set(0.95, 0.5, 0);
  negGroup.add(labelA, labelB);
  const tie = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.55, 0.24, 0), new THREE.Vector3(0.55, 0.24, 0)]),
    new THREE.LineBasicMaterial({ color: 0x3d5080, transparent: true, opacity: 0.5 }),
  );
  negGroup.add(tie);
  const sameLabel = makeTextSprite("同一姿态", "#7b8aa3", { size: 0.09, bold: false });
  sameLabel.position.set(0, 0.36, 0);
  negGroup.add(sameLabel);

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
    color: 0x1b2b47, transparent: true, opacity: 0.14, depthWrite: false,
  });
  const projSphere = new THREE.Mesh(new THREE.SphereGeometry(PROJ_RADIUS, 48, 32), projSphereMat);
  projGroup.add(projSphere);
  projGroup.add(buildSphereGrid(PROJ_RADIUS, 0x33507a, 0.42));
  const projEquator = new THREE.Mesh(
    new THREE.TorusGeometry(PROJ_RADIUS, 0.007, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x4c6f9f, transparent: true, opacity: 0.6 }),
  );
  projEquator.rotation.x = Math.PI / 2;
  projGroup.add(projEquator);

  /** 上一次有效投影方向：q 逼近极点（v→0）时延续它，避免终点跳到任意方向 */
  let lastDir: [number, number, number] = [1, 0, 0];
  /** S³ → 3D 投影（含 3R 长度钳制），返回显示坐标 */
  const project4d = (w: number, x: number, y: number, z: number): THREE.Vector3 => {
    const n = Math.hypot(x, y, z);
    if (n > 1e-9) lastDir = [x / n, y / n, z / n];
    else lastDir = [1, 0, 0]; // 恰在极点：方向规范化——重置后 −q 落点永远一致
    const dir = lastDir;
    const denom = 1 + w; // 南极 w=−1 为投影极点
    const len = denom < 1e-6 ? Infinity : n / denom;
    const L = Math.min(len, 3) * PROJ_RADIUS; // 单位球尺度 → 投影球尺度（钳制在 3R 内）
    return vecToDisplay([dir[0] * L, dir[1] * L, dir[2] * L]);
  };

  // q（青）/ −q（品红）标记与连线
  const projQ = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 18, 14), new THREE.MeshBasicMaterial({ color: 0x22d3ee }),
  );
  const projNeg = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 18, 14), new THREE.MeshBasicMaterial({ color: 0xe879f9 }),
  );
  projGroup.add(projQ, projNeg);
  const projTie = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x546a99, transparent: true, opacity: 0.55 }),
  );
  projGroup.add(projTie);
  const projLabelQ = makeTextSprite("q", "#7fe3f5", { size: 0.18 });
  const projLabelNeg = makeTextSprite("−q", "#f0a6e8", { size: 0.18 });
  projGroup.add(projLabelQ, projLabelNeg);

  // 轨迹：q 投影点走过的路径（青色细线，最近 240 点）
  const projTrailPts: THREE.Vector3[] = [];
  const projTrail = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45 }),
  );
  const projTrailNegPts: THREE.Vector3[] = [];
  const projTrailNeg = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.22 }),
  );
  projGroup.add(projTrail, projTrailNeg);

  // 基向量架：1 投影到原点；i/j/k（w=0）恰落在球面上
  const projOne = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshBasicMaterial({ color: 0x93a2bb }),
  );
  projGroup.add(projOne);
  const projOneLabel = makeTextSprite("1", "#7f8da6", { size: 0.11, alwaysOnTop: true });
  projOneLabel.position.set(0.09, -0.1, 0);
  projGroup.add(projOneLabel);
  // 「球内 / 球外」的语义交给面板图例（3D 里的浮动文字会和 q 标记、网格打架）

  const projBasis = new THREE.Group();
  projGroup.add(projBasis);
  const BASIS: Array<[string, [number, number, number]]> = [
    ["i", [1, 0, 0]], ["j", [0, 1, 0]], ["k", [0, 0, 1]],
  ];
  for (const [name, v] of BASIS) {
    const p = vecToDisplay(v).multiplyScalar(PROJ_RADIUS);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 12, 10), new THREE.MeshBasicMaterial({ color: 0x58a6ff }),
    );
    m.position.copy(p);
    const l = makeTextSprite(name, "#8dbdf0", { size: 0.15, alwaysOnTop: true });
    // 标签沿径向外推到球外，避免与球心的 q/−q 标记在屏幕上叠字
    l.position.copy(p.clone().multiplyScalar(1.42));
    projBasis.add(m, l);
  }

  // 姿态舞台：球下方的小四轴同步显示 q 代表的 3D 姿态
  const projQuad = buildQuad(false, { axes: false });
  projQuad.group.scale.setScalar(0.4);
  projQuad.group.position.set(0, -0.98, 0);
  projGroup.add(projQuad.group);
  const projQuadLabel = makeTextSprite("3D 姿态（与 q 同步）", "#8a9ab5", { size: 0.12 });
  projQuadLabel.position.set(0, -1.2, 0);
  projGroup.add(projQuadLabel);

  const projQPos = new THREE.Vector3();
  const projNegPos = new THREE.Vector3();

  // ---------------- 状态：当前姿态对 + 进度 ----------------
  let curFrom: Quat = qFromEuler(0, 0, 0);
  let curTo: Quat = qFromEuler(0, 0, 0);
  let curT = 0;
  let curSlerpDeg = 0;
  let curEulerDeg = 0;
  let curDeviationDeg = 0;
  let pairKey = "";

  /** 重建两条弧（含偏差带、Squad、端点 ghost）——只在姿态对变化时调用 */
  const rebuildArcs = (path?: Array<[number, number, number]>): void => {
    const r0 = SPHERE_RADIUS;
    const slerpQs: Quat[] = [];
    const eulerQs: Quat[] = [];
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const u = i / ARC_SAMPLES;
      slerpQs.push(qSlerp(curFrom, curTo, u));
      eulerQs.push(eulerLerp(curFrom, curTo, u));
    }
    sampleArc(slerpQs, r0, slerpPoints);
    sampleArc(eulerQs, r0, eulerPoints);

    // 端点标记贴球面
    startMarker.position.copy(slerpPoints[0]);
    endMarker.position.copy(slerpPoints[slerpPoints.length - 1]);
    // 端点姿态线框：固定在球外两侧展示位，只更新姿态
    applyDisplayQuat(ghostFrom.group, curFrom);
    applyDisplayQuat(ghostTo.group, curTo);

    slerpLine.geometry.dispose();
    slerpLine.geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(slerpPoints), 96, 0.013, 8, false,
    );
    eulerLine.geometry.dispose();
    eulerLine.geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(eulerPoints), 96, 0.011, 8, false,
    );
    ribbon.geometry.dispose();
    ribbon.geometry = buildDeviationRibbon(slerpPoints, eulerPoints);

    // 弧标签放在中点外侧
    const mid = Math.floor(ARC_SAMPLES / 2);
    slerpLabel.position.copy(slerpPoints[mid].clone().multiplyScalar(1.22));
    eulerLabel.position.copy(eulerPoints[mid].clone().multiplyScalar(1.3));

    // Squad 弧（琥珀）：四关键帧的内积切线 + squad 混合；无 path 时隐藏
    squadPoints.length = 0;
    if (path && path.length === 4) {
      const p0 = quatFromEulerDeg(path[0]);
      const p1 = quatFromEulerDeg(path[1]);
      const p2 = quatFromEulerDeg(path[2]);
      const p3 = quatFromEulerDeg(path[3]);
      const s1 = squadTangent(p0, p1, p2);
      const s2 = squadTangent(p1, p2, p3);
      const qs: Quat[] = [];
      for (let i = 0; i <= ARC_SAMPLES; i++) qs.push(squad(p1, p2, s1, s2, i / ARC_SAMPLES));
      sampleArc(qs, r0, squadPoints);
      squadLine.geometry.dispose();
      squadLine.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(squadPoints), 96, 0.012, 8, false,
      );
      squadLine.visible = true;
    } else {
      squadLine.geometry.dispose();
      squadLine.geometry = new THREE.BufferGeometry();
      squadLine.visible = false;
    }

    // 弧长信息：两端总转角与中点分叉角
    curSlerpDeg = 2 * Math.acos(Math.min(1, Math.abs(curFrom.w * curTo.w + curFrom.x * curTo.x + curFrom.y * curTo.y + curFrom.z * curTo.z))) * 180 / Math.PI;
    let eSum = 0;
    for (let i = 1; i <= ARC_SAMPLES; i++) {
      const a = eulerQs[i - 1], b = eulerQs[i];
      const d = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
      eSum += 2 * Math.acos(Math.min(1, d));
    }
    curEulerDeg = eSum * 180 / Math.PI;
    const qm1 = qSlerp(curFrom, curTo, 0.5);
    const qm2 = eulerLerp(curFrom, curTo, 0.5);
    curDeviationDeg = 2 * Math.acos(Math.min(1, Math.abs(qm1.w * qm2.w + qm1.x * qm2.x + qm1.y * qm2.y + qm1.z * qm2.z))) * 180 / Math.PI;
  };

  /** 轻量更新：marker / 四轴 / 轴角箭头 / 机头连线 */
  const applyProgress = (t: number): void => {
    const u = clamp01(t);
    curT = u;
    const i = Math.round(u * ARC_SAMPLES);
    const pS = slerpPoints[i];
    const pE = eulerPoints[i];
    slerpMarker.group.position.copy(pS);
    eulerMarker.group.position.copy(pE);
    // marker 的机头锥朝外（球心→marker 方向）
    for (const m of [slerpMarker, eulerMarker]) {
      m.group.lookAt(m.group.position.clone().multiplyScalar(2));
    }

    const qCur = qSlerp(curFrom, curTo, u);
    applyDisplayQuat(quad.group, qCur);

    // 机头向量：球心 → 当前 Slerp marker（就地写顶点，零分配）
    const npos = noseLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    npos.setXYZ(0, 0, 0, 0);
    npos.setXYZ(1, pS.x, pS.y, pS.z);
    npos.needsUpdate = true;
    noseLine.geometry.computeBoundingSphere();

    // 轴角箭头：当前姿态的等效旋转轴
    const curNose = vecToDisplay(qRot(qCur, REF_VEC));
    axisArrow.setDirection(curNose.clone().normalize());
    axisArrow.setLength(0.52 + 0.22 * Math.sin(u * Math.PI), 0.09, 0.055);
  };

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
      ghostFrom,
      ghostTo,
    },
    setPair(fromDeg, toDeg, path) {
      const key = `${fromDeg.join(",")}|${toDeg.join(",")}|${path ? path.map((p) => p.join(",")).join(";") : ""}`;
      curFrom = quatFromEulerDeg(fromDeg);
      curTo = quatFromEulerDeg(toDeg);
      if (key === pairKey) return; // 同一姿态对：不重建几何（播放时每帧调用也不掉帧）
      pairKey = key;
      rebuildArcs(path);
      applyProgress(curT);
    },
    setProgress(t) {
      if (slerpPoints.length === 0) return;
      applyProgress(t);
    },
    setInterpolation(fromDeg, toDeg, t, path) {
      this.setPair(fromDeg, toDeg, path);
      applyProgress(t);
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
      const n = Math.hypot(q.w, q.x, q.y, q.z);
      const qw = q.w / n, qx = q.x / n, qy = q.y / n, qz = q.z / n;
      const pq = project4d(qw, qx, qy, qz);
      const pn = project4d(-qw, -qx, -qy, -qz);
      projQPos.copy(pq);
      projNegPos.copy(pn);
      projQ.position.copy(pq);
      projNeg.position.copy(pn);
      // q 标签避让：靠近原点时左上让位；落在球面（= 某个基向量位置）时
      // 沿切向偏移，避免与 i/j/k 标签叠字——这是「按一次 i 之后 q 和 i 重合」的场景。
      const onShell = Math.abs(pq.length() - PROJ_RADIUS) < 0.02 * PROJ_RADIUS;
      if (pq.length() < 0.18) {
        projLabelQ.position.copy(pq.clone().add(new THREE.Vector3(-0.16, 0.17, 0)));
      } else if (onShell) {
        projLabelQ.position.copy(pq.clone().multiplyScalar(1.02).add(new THREE.Vector3(0, 0.17, 0)));
      } else {
        projLabelQ.position.copy(pq.clone().multiplyScalar(1.2));
      }
      projLabelNeg.position.copy(pn.clone().multiplyScalar(1.07));
      projTie.geometry.dispose();
      projTie.geometry = new THREE.BufferGeometry().setFromPoints([pq, pn]);
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
    arcInfo() {
      return { t: curT, slerpDeg: curSlerpDeg, eulerDeg: curEulerDeg, deviationDeg: curDeviationDeg };
    },
  };
}
