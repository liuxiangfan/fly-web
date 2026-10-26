/**
 * 场景图校验（Node 下运行，无需浏览器/WebGL）
 *
 * 直接构建真实的万向环装置与四轴模型，校验三级层级的世界姿态、三个圆环的几何朝向、
 * 死锁时内外环轴是否真的重合、以及机体轴字母标签是否挂在正确的轴上。
 *
 * 为什么要这个脚本：浏览器的 rAF 在某些环境下会被节流（页面被遮挡时），导致无法渲染
 * 也无法截图，3D 部分就失去视觉验证。这里用"校验真实场景图"替代截图，反而更严格——
 * 截图只能看出"像不像"，而这些断言能证明圆环朝向与轴标签的数学正确性。
 *
 * 运行：npm run scenecheck
 */
import * as THREE from "three";
import { buildGimbal, GIMBAL_GEOM } from "../src/scene/gimbal";
import { buildQuad } from "../src/scene/quad";
import { buildQuatView, PROJ_RADIUS, SPHERE_RADIUS } from "../src/scene/quatview";
import { gimbalAxisAlign, toDisplayQ } from "../src/core/gimbal";
import { qFromEuler, RAD } from "../src/core/quat";
import { mulberry32 } from "../src/core/rng";

// makeTextSprite 需要 canvas 2D 上下文；打一个最小桩，避免引入真实 DOM
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    width: 64,
    height: 64,
    getContext: () => ({
      font: "",
      textAlign: "",
      textBaseline: "",
      fillStyle: "",
      measureText: (t: string) => ({ width: Math.max(1, t.length) * 40 }),
      fillText: () => {},
    }),
  }),
};

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

const fmt = (v: THREE.Vector3) => `(${v.toArray().map((a) => a.toFixed(3)).join(", ")})`;

/** 四元数分量最大偏差（先对齐 q 与 −q 的符号） */
function quatDiff(a: THREE.Quaternion, b: { w: number; x: number; y: number; z: number }): number {
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  return Math.max(
    Math.abs(a.x - s * b.x),
    Math.abs(a.y - s * b.y),
    Math.abs(a.z - s * b.z),
    Math.abs(a.w - s * b.w),
  );
}

// ============ 1. 万向环：内环世界姿态 ≡ toDisplay(qFromEuler(φ,θ,ψ)) ============
const rig = buildGimbal();
{
  const rnd = mulberry32(20261011);
  let maxDiff = 0;
  for (let i = 0; i < 200; i++) {
    const roll = (rnd() * 2 - 1) * Math.PI;
    const pitch = (rnd() * 2 - 1) * (Math.PI / 2);
    const yaw = (rnd() * 2 - 1) * Math.PI;
    rig.setAngles(roll, pitch, yaw);
    rig.group.updateWorldMatrix(true, true);
    const q = new THREE.Quaternion();
    rig.parts.rollGroup.getWorldQuaternion(q);
    maxDiff = Math.max(maxDiff, quatDiff(q, toDisplayQ(qFromEuler(roll, pitch, yaw))));
  }
  check(
    "真实场景图：内环世界姿态 ≡ toDisplay(qFromEuler)",
    maxDiff < 1e-9,
    `200 组随机角度，最大分量偏差 ${maxDiff.toExponential(2)}`,
  );
}

// ============ 2. 三个圆环的孔轴朝向（决定环面是否包含自己的旋转轴） ============
{
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  // TorusGeometry 的孔轴在局部为 +Z；取世界朝向
  const holeAxis = (mesh: THREE.Mesh) => {
    const q = new THREE.Quaternion();
    mesh.getWorldQuaternion(q);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  };
  // 平衡环架排布：三环面两两垂直，每环的旋转轴都是自身环面的一条直径
  //   外环（偏航，轴 Y）环面 YZ → 孔轴 ±X
  //   中环（俯仰，轴 Z）环面 XZ → 孔轴 ±Y
  //   内环（横滚，轴 X）环面 XY → 孔轴 ±Z
  const cases: Array<[string, THREE.Mesh, THREE.Vector3, THREE.Vector3]> = [
    ["外环（偏航）", rig.parts.yawRing, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    ["中环（俯仰）", rig.parts.pitchRing, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
    ["内环（横滚）", rig.parts.rollRing, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)],
  ];
  const bad: string[] = [];
  const detail: string[] = [];
  for (const [name, mesh, wantHole, rotAxis] of cases) {
    const hole = holeAxis(mesh);
    // 孔轴应与期望方向平行（允许反向）
    if (Math.abs(hole.dot(wantHole)) < 0.9999) bad.push(`${name}孔轴 ${fmt(hole)}`);
    // 且必须垂直于自身旋转轴——即旋转轴位于环面内，环才能绕它转
    const perp = Math.abs(hole.dot(rotAxis));
    if (perp > 1e-6) bad.push(`${name}轴未落在环面内（孔轴·旋转轴=${perp.toFixed(4)}）`);
    detail.push(`${name}孔轴 ${fmt(hole)} ⟂ 旋转轴 ${fmt(rotAxis)}`);
  }
  check("圆环朝向：环面包含自身旋转轴", bad.length === 0, bad.length === 0 ? detail.join("；") : bad.join("；"));
}

// ============ 2b. 枢轴轴承连通性：每个轴承必须真正跨越相邻两环的环带 ============
{
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);

  // 轴承是环带状的短圆柱（局部孔轴 +Z），其两端应分别落在两个环的半径上
  const spans = rig.parts.pivots.map(({ mesh, rInner, rOuter }) => {
    const q = new THREE.Quaternion();
    mesh.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const center = new THREE.Vector3();
    mesh.getWorldPosition(center);
    const half = (mesh.geometry as THREE.CylinderGeometry).parameters.height / 2;
    const a = center.clone().addScaledVector(dir, -half);
    const b = center.clone().addScaledVector(dir, half);
    return {
      rMin: Math.min(a.length(), b.length()),
      rMax: Math.max(a.length(), b.length()),
      rInner,
      rOuter,
    };
  });

  const broken = spans.filter((s) => !(s.rMin <= s.rInner && s.rMax >= s.rOuter));
  // 环带净空：相邻环的半径差必须大于两环半厚之和（否则环带会互相穿模）
  const gapOuterMid = GIMBAL_GEOM.R_OUTER - GIMBAL_GEOM.R_MID - 2 * GIMBAL_GEOM.BAND_T;
  const gapMidInner = GIMBAL_GEOM.R_MID - GIMBAL_GEOM.R_INNER - 2 * GIMBAL_GEOM.BAND_T;
  check(
    "枢轴轴承真正连接相邻环",
    rig.parts.pivots.length === 4 && broken.length === 0 && gapOuterMid > 0 && gapMidInner > 0,
    `${rig.parts.pivots.length} 个轴承；` +
      spans
        .map((s) => `跨越 ${s.rMin.toFixed(3)}→${s.rMax.toFixed(3)}（需含 ${s.rInner}/${s.rOuter}）`)
        .join("；") +
      `；环带净空 外↔中 ${gapOuterMid.toFixed(3)}、中↔内 ${gapMidInner.toFixed(3)}（须 >0）`,
  );
}

// ============ 3. 死锁：内外环轴在世界系下真的重合 ============
{
  const outerAxis = new THREE.Vector3(0, 1, 0); // 外环绕自身 Y 转，而 Y 始终为世界 Y
  const innerAxisWorld = (pitch: number) => {
    rig.setAngles(0, pitch, 0);
    rig.group.updateWorldMatrix(true, true);
    const q = new THREE.Quaternion();
    rig.parts.pitchGroup.getWorldQuaternion(q); // 内环的旋转轴是中环坐标系的 +X
    return new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  };
  const at90 = Math.abs(innerAxisWorld(Math.PI / 2).dot(outerAxis));
  const at0 = Math.abs(innerAxisWorld(0).dot(outerAxis));
  const analytic = gimbalAxisAlign(Math.PI / 2);
  check(
    "死锁：±90° 时内外环轴几何重合",
    at90 > 0.9999 && at0 < 1e-9 && Math.abs(at90 - analytic) < 1e-9,
    `90° 时 |轴·轴|=${at90.toFixed(6)}，0° 时 ${at0.toFixed(6)}；与解析式 gimbalAxisAlign(90°)=${analytic.toFixed(6)} 一致`,
  );
  rig.setAngles(0, 0, 0);
}

// ============ 4. 载荷：挂在横滚环下、自身无额外旋转（姿态完全由三级环链条决定） ============
{
  const q = rig.quad.group.quaternion;
  const isIdentity = Math.abs(q.w - 1) < 1e-12 && Math.abs(q.x) < 1e-12 && Math.abs(q.y) < 1e-12 && Math.abs(q.z) < 1e-12;
  // 四轴现在是「载荷组」的子节点（载荷组再加机体轴箭头），载荷组必须直接挂在横滚环下
  const payloadUnderRoll = rig.parts.payload.parent === rig.parts.rollGroup;
  const quadUnderPayload = rig.quad.group.parent === rig.parts.payload;
  check(
    "载荷挂在横滚环下且四轴无额外旋转",
    payloadUnderRoll && quadUnderPayload && isIdentity,
    `载荷父节点=${payloadUnderRoll ? "横滚环" : "异常"}；四轴父节点=载荷组 ${quadUnderPayload}；自身四元数=(${q.x}, ${q.y}, ${q.z}, ${q.w})`,
  );
}

// ============ 4b. 内嵌四轴不得穿出内环（桨尖半径 < 内环内表面） ============
{
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  // 忽略轴标签 sprite，只算实体网格的径向最大延伸
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let maxR = 0;
  rig.quad.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    box.setFromObject(mesh);
    for (const corner of [
      [box.min.x, box.min.y, box.min.z],
      [box.min.x, box.min.y, box.max.z],
      [box.min.x, box.max.y, box.min.z],
      [box.min.x, box.max.y, box.max.z],
      [box.max.x, box.min.y, box.min.z],
      [box.max.x, box.min.y, box.max.z],
      [box.max.x, box.max.y, box.min.z],
      [box.max.x, box.max.y, box.max.z],
    ] as Array<[number, number, number]>) {
      v.set(corner[0], corner[1], corner[2]);
      maxR = Math.max(maxR, Math.hypot(v.x, v.z));
    }
  });
  const innerSurface = GIMBAL_GEOM.R_INNER - GIMBAL_GEOM.BAND_T;
  check(
    "内嵌四轴不穿出内环",
    maxR < innerSurface,
    `四轴最大径向延伸 ${maxR.toFixed(3)} < 内环内表面 ${innerSurface.toFixed(3)}（间隙 ${(innerSurface - maxR).toFixed(3)}）`,
  );
}

// ============ 5. 机体轴字母标签：挂在正确的轴上（x 前 +X、y 右 +Z、z 下 −Y） ============
{
  const quadModel = buildQuad(false);
  const sprites = quadModel.group.children.filter(
    (c): c is THREE.Sprite => (c as THREE.Sprite).isSprite === true,
  );
  const dirs = sprites.map((s) => s.position.clone().normalize());
  // 标签为了避开箭头有轻微抬高，故用角度容差（≈11°）而非严格平行
  const expect = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, -1, 0),
  ];
  const matched = new Set<number>();
  for (const v of expect) {
    const i = dirs.findIndex((d, idx) => !matched.has(idx) && d.dot(v) > 0.98);
    if (i >= 0) matched.add(i);
  }
  check(
    "轴字母标签方向正确（x 前 +X、y 右 +Z、z 下 −Y）",
    sprites.length === 3 && matched.size === 3,
    `找到 ${sprites.length} 个标签，方向 ${dirs.map(fmt).join(" ")}，与 3 条机体轴一一对应=${matched.size === 3}`,
  );
}

// ============ 4c. 轴标签的层级语义：标签落在自己的旋转轴上 ============
// 数学上「轴上一点绕该轴旋转不动」，所以正确的断言不是「转自己的轴会移动」，
// 而是：① 标签分别挂在 基座 / 外环 / 中环 下（层级正确）；
//        ② 绕**上级**轴转动时标签跟着走（说明它在父坐标系里）；
//        ③ 标签落在自己轴的方向上（不会漂到环外误导读者）。
{
  const posOf = (obj: THREE.Object3D) => {
    const p = new THREE.Vector3();
    obj.getWorldPosition(p);
    return p;
  };
  const { yaw: yawLab, pitch: pitchLab, roll: rollLab } = rig.parts.axisLabels;
  const allPresent = !!(yawLab && pitchLab && rollLab);
  const parentsOk =
    yawLab.parent === rig.group &&
    pitchLab.parent === rig.parts.yawGroup &&
    rollLab.parent === rig.parts.pitchGroup;

  // 绕外环（偏航）转 60°：俯仰轴标签（在 Z 轴上）应移动，偏航轴标签（在 Y 轴上）不动
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const pitchBefore = posOf(pitchLab);
  const yawBefore = posOf(yawLab);
  rig.setAngles(0, 0, 60 * (Math.PI / 180));
  rig.group.updateWorldMatrix(true, true);
  const pitchMovedByYaw = pitchBefore.distanceTo(posOf(pitchLab));
  const yawStillByYaw = yawBefore.distanceTo(posOf(yawLab));

  // 绕中环（俯仰，轴 Z）转 40°：横滚轴标签（在 X 轴上）应移动
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const rollBefore = posOf(rollLab);
  rig.setAngles(0, 40 * (Math.PI / 180), 0);
  rig.group.updateWorldMatrix(true, true);
  const rollMovedByPitch = rollBefore.distanceTo(posOf(rollLab));

  // 标签方向：必须落在自己那根轴的方向上（允许 ±），且半径大于所属环
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const dirOf = (s: THREE.Sprite) => posOf(s).normalize();
  const axisOk =
    dirOf(yawLab).y > 0.999 &&
    Math.abs(dirOf(pitchLab).z) > 0.999 &&
    Math.abs(dirOf(rollLab).x) > 0.999;
  const radiusOf = (s: THREE.Sprite) => Math.hypot(...posOf(s).toArray());
  const radiiOk =
    radiusOf(yawLab) > GIMBAL_GEOM.R_OUTER &&
    radiusOf(pitchLab) > GIMBAL_GEOM.R_MID &&
    radiusOf(rollLab) > GIMBAL_GEOM.R_INNER;

  check(
    "轴标签层级与方向正确",
    allPresent && parentsOk && pitchMovedByYaw > 0.1 && yawStillByYaw < 1e-9 &&
      rollMovedByPitch > 0.1 && axisOk && radiiOk,
    `层级 基座/外环/中环=${parentsOk}；` +
      `转偏航 60°：俯仰轴标签随动 ${pitchMovedByYaw.toFixed(2)}（须 >0.1）、偏航轴标签不动 ${yawStillByYaw.toExponential(1)}；` +
      `转俯仰 40°：横滚轴标签随动 ${rollMovedByPitch.toFixed(2)}（须 >0.1）；` +
      `标签方向沿各自轴=${axisOk}；半径 ${radiusOf(yawLab).toFixed(2)}/${radiusOf(pitchLab).toFixed(2)}/${radiusOf(rollLab).toFixed(2)}`,
  );
  rig.setAngles(0, 0, 0);
}

// ============ 6. 四元数视图：弧线端点 = 起终点机头方向；q 与 −q 组姿态恒等 ============
{
  const rig = buildQuatView();
  const from = [0, 0, 0] as [number, number, number];
  const to = [140, 70, 160] as [number, number, number];
  const path = [
    [-40, 20, 30], [0, 0, 0], [140, 70, 160], [175, 100, 205],
  ] as Array<[number, number, number]>;
  rig.setInterpolation(from, to, 0.5, path);

  // 弧线采样点（显示坐标）应落在参考球面上：机头方向 × 球面半径，
  // 且两端点分别等于起/终点姿态的机头方向 × 半径
  const noseOf = (deg: [number, number, number]) => {
    const q = qFromEuler(deg[0] * RAD, deg[1] * RAD, deg[2] * RAD);
    const r = toDisplayQ(q);
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return dir.multiplyScalar(SPHERE_RADIUS); // 球面半径（非单位向量）
  };
  const slerpPts = rig.parts.slerpPoints;
  const eulerPts = rig.parts.eulerPoints;
  const pStart = noseOf(from);
  const pEnd = noseOf(to);
  // 欧拉插值终点经 qToEuler→qFromEuler 往返，浮点误差约 1e-8，故容差取 1e-6
  const close = (v: THREE.Vector3, want: THREE.Vector3) =>
    v.distanceTo(want) < 1e-6;
  const endpointsOk =
    close(slerpPts[0], pStart) && close(eulerPts[0], pStart) &&
    close(slerpPts[slerpPts.length - 1], pEnd) &&
    close(eulerPts[eulerPts.length - 1], pEnd);

  // 两条弧线点数一致（同一采样数）
  const sameCount = slerpPts.length === eulerPts.length && slerpPts.length >= 3;

  // Squad 弧（四关键帧）：端点 = p1/p2 机头、点数一致
  const squadPts = rig.parts.squadPoints;
  const qvPathOk =
    squadPts.length === slerpPts.length &&
    close(squadPts[0], pStart) &&
    close(squadPts[squadPts.length - 1], pEnd);

  // q 与 −q 组：两个四轴世界姿态应恒等（双覆盖的可视化证明）
  rig.setNegation(35, -52, 128);
  rig.group.updateWorldMatrix(true, true);
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  rig.parts.negA.group.getWorldQuaternion(qa);
  rig.parts.negB.group.getWorldQuaternion(qb);
  const d = qa.dot(qb);
  const s = d < 0 ? -1 : 1;
  const negIdentity =
    Math.abs(qa.x - s * qb.x) < 1e-12 &&
    Math.abs(qa.y - s * qb.y) < 1e-12 &&
    Math.abs(qa.z - s * qb.z) < 1e-12 &&
    Math.abs(qa.w - s * qb.w) < 1e-12;

  check(
    "四元数视图：弧线端点正确、q/−q 恒等",
    endpointsOk && sameCount && negIdentity && qvPathOk,
    `弧线端点=起终点机头=${endpointsOk}；两弧同点数 ${slerpPts.length}=${eulerPts.length}=${sameCount}；` +
      `Squad 弧端点/点数=${qvPathOk}；` +
      `q 与 −q 组世界姿态恒等=${negIdentity}`,
  );
}

// 9. 4D 立体投影：单位 q 投到原点、基向量投到球面、q/−q 为倒易点对（|p|·|p'|=1）
{
  const qv = buildQuatView();
  const R = PROJ_RADIUS;
  // a) q = 单位 → 投影在原点
  qv.setProjection({ w: 1, x: 0, y: 0, z: 0 });
  const idOk = qv.parts.projQPos.length() < 1e-9;
  // b) 基向量 i（w=0）→ 投影恰在球面上
  qv.setProjection({ w: 0, x: 1, y: 0, z: 0 });
  const basisOk = Math.abs(qv.parts.projQPos.length() - R) < 1e-9;
  // c) 随机 q（w>0）：q 在球内、−q 在球外，且 |p(q)|·|p(−q)| = R²（倒易点对）
  let maxInvErr = 0;
  let inOutOk = true;
  for (let i = 0; i < 30; i++) {
    // 直接以归一化后的 w ∈ [0.2, 0.6] 构造（配 |v| = √(1−w²)）：
    // −q 投影长度 ≤ √(1.6/0.4) = 2R，远离 3R 钳制
    const wn = 0.2 + 0.4 * ((i * 37) % 11) / 10;
    const sc = Math.sqrt(1 - wn * wn);
    const vn = Math.hypot(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9));
    qv.setProjection({
      w: wn,
      x: (sc * Math.sin(i * 1.7)) / vn,
      y: (sc * Math.cos(i * 2.3)) / vn,
      z: (sc * Math.sin(i * 0.9)) / vn,
    });
    const pq = qv.parts.projQPos.length();
    const pn = qv.parts.projNegPos.length();
    maxInvErr = Math.max(maxInvErr, Math.abs(pq * pn - R * R));
    if (!(pq < R && pn > R)) inOutOk = false;
  }
  check(
    "四元数视图：4D 立体投影几何",
    idOk && basisOk && inOutOk && maxInvErr < 1e-6,
    `单位q→原点=${idOk}；基向量i→球面=${basisOk}；q内/−q外=${inOutOk}；倒易性 |p|·|p′| 最大偏差 ${maxInvErr.toExponential(1)}`,
  );
}

console.log(failures === 0 ? "\n场景图校验全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
