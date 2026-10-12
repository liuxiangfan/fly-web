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
import { gimbalAxisAlign, toDisplayQ } from "../src/core/gimbal";
import { qFromEuler } from "../src/core/quat";
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

// ============ 2b. 枢轴销连通性：每个销必须真正跨越相邻两环的环管 ============
{
  const { R_OUTER, R_MID, R_INNER } = GIMBAL_GEOM;
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);

  // 销的轴向为其局部 +Y（CylinderGeometry 的轴），取世界方向与两端点
  const spans = rig.parts.pivots.map((pin) => {
    const q = new THREE.Quaternion();
    pin.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const center = new THREE.Vector3();
    pin.getWorldPosition(center);
    const half = (pin.geometry as THREE.CylinderGeometry).parameters.height / 2;
    const a = center.clone().addScaledVector(dir, -half);
    const b = center.clone().addScaledVector(dir, half);
    return { rMin: Math.min(a.length(), b.length()), rMax: Math.max(a.length(), b.length()) };
  });

  // 前两个销连接 中环↔外环，后两个销连接 内环↔中环
  const gaps: Array<[string, { rMin: number; rMax: number }, number, number]> = [
    ["中环↔外环", spans[0], R_MID, R_OUTER],
    ["中环↔外环", spans[1], R_MID, R_OUTER],
    ["内环↔中环", spans[2], R_INNER, R_MID],
    ["内环↔中环", spans[3], R_INNER, R_MID],
  ];
  const broken = gaps.filter(([, s, rA, rB]) => !(s.rMin <= Math.min(rA, rB) && s.rMax >= Math.max(rA, rB)));
  const surfaceGap = Math.min(R_MID - R_INNER, R_OUTER - R_MID) - 2 * GIMBAL_GEOM.TUBE;
  check(
    "枢轴销真正连接相邻环",
    rig.parts.pivots.length === 4 && broken.length === 0 && surfaceGap > 0,
    `4 个销；` +
      gaps
        .map(([name, s, rA, rB]) => `${name} 跨越 ${s.rMin.toFixed(3)}→${s.rMax.toFixed(3)}（需含 ${rA}/${rB}）`)
        .join("；") +
      `；相邻环表面间隙 ${surfaceGap.toFixed(3)}（须 >0 即不穿模）`,
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

// ============ 4. 内嵌小四轴：直接挂在横滚环下且无额外旋转 ============
{
  const q = rig.quad.group.quaternion;
  const isIdentity = Math.abs(q.w - 1) < 1e-12 && Math.abs(q.x) < 1e-12 && Math.abs(q.y) < 1e-12 && Math.abs(q.z) < 1e-12;
  check(
    "内嵌四轴挂在横滚环下且自身无额外旋转",
    rig.quad.group.parent === rig.parts.rollGroup && isIdentity,
    `父节点=${rig.quad.group.parent === rig.parts.rollGroup ? "横滚环" : "异常"}，自身四元数=(${q.x}, ${q.y}, ${q.z}, ${q.w})`,
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
  const innerSurface = GIMBAL_GEOM.R_INNER - GIMBAL_GEOM.TUBE;
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

// ============ 4c. 环标签必须挂在各自的环下并随环转动 ============
{
  const labelUnder = (parent: THREE.Object3D): THREE.Sprite | null => {
    const found = parent.children.find(
      (c) => (c as THREE.Sprite).isSprite === true,
    ) as THREE.Sprite | undefined;
    return found ?? null;
  };
  const yawLabel = labelUnder(rig.parts.yawGroup);
  const pitchLabel = labelUnder(rig.parts.pitchGroup);
  const rollLabel = labelUnder(rig.parts.rollGroup);
  const allPresent = !!(yawLabel && pitchLabel && rollLabel);

  const posOf = (obj: THREE.Object3D) => {
    const p = new THREE.Vector3();
    obj.getWorldPosition(p);
    return p;
  };

  // 1) 只转外环（偏航）：三个标签都应跟着转（外环是最外层父节点）
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const yawBefore = allPresent ? posOf(yawLabel!) : null;
  const pitchBeforeYaw = allPresent ? posOf(pitchLabel!) : null;
  rig.setAngles(0, 0, 60 * (Math.PI / 180));
  rig.group.updateWorldMatrix(true, true);
  const yawMoved = yawBefore && allPresent ? yawBefore.distanceTo(posOf(yawLabel!)) : 0;
  const pitchMovedByYaw = pitchBeforeYaw && allPresent ? pitchBeforeYaw.distanceTo(posOf(pitchLabel!)) : 0;

  // 2) 只转中环（俯仰）：中环标签移动，而外环标签（父层级，未动）不动
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const yawBeforePitch = allPresent ? posOf(yawLabel!) : null;
  const pitchBeforePitch = allPresent ? posOf(pitchLabel!) : null;
  rig.setAngles(0, 40 * (Math.PI / 180), 0);
  rig.group.updateWorldMatrix(true, true);
  const pitchMoved = pitchBeforePitch && allPresent ? pitchBeforePitch.distanceTo(posOf(pitchLabel!)) : 0;
  const yawStill = yawBeforePitch && allPresent ? yawBeforePitch.distanceTo(posOf(yawLabel!)) : 0;

  // 3) 只转内环（横滚）：内环标签移动，外环标签不动
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const rollBefore = allPresent ? posOf(rollLabel!) : null;
  const yawBeforeRoll = allPresent ? posOf(yawLabel!) : null;
  rig.setAngles(50 * (Math.PI / 180), 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const rollMoved = rollBefore && allPresent ? rollBefore.distanceTo(posOf(rollLabel!)) : 0;
  const yawStillRoll = yawBeforeRoll && allPresent ? yawBeforeRoll.distanceTo(posOf(yawLabel!)) : 0;

  // 4) 标签位置须落在所属环之外（半径 > 环半径），确保不埋进环体
  rig.setAngles(0, 0, 0);
  rig.group.updateWorldMatrix(true, true);
  const radiusOf = (s: THREE.Sprite) => Math.hypot(...posOf(s).toArray());

  check(
    "环标签挂在各自环下并随环转动",
    allPresent &&
      yawMoved > 0.1 && pitchMovedByYaw > 0.1 &&
      pitchMoved > 0.1 && yawStill < 1e-9 &&
      rollMoved > 0.1 && yawStillRoll < 1e-9 &&
      radiusOf(yawLabel!) > GIMBAL_GEOM.R_OUTER &&
      radiusOf(pitchLabel!) > GIMBAL_GEOM.R_MID &&
      radiusOf(rollLabel!) > GIMBAL_GEOM.R_INNER,
    `三个标签均在位=${allPresent}；` +
      `转外环 60°：偏航标签移动 ${yawMoved.toFixed(2)}、俯仰标签随动 ${pitchMovedByYaw.toFixed(2)}（均须 >0.1）；` +
      `转中环 40°：俯仰标签移动 ${pitchMoved.toFixed(2)}（须 >0.1）、偏航标签静止 ${yawStill.toExponential(1)}（须 ≈0）；` +
      `转内环 50°：横滚标签移动 ${rollMoved.toFixed(2)}（须 >0.1）、偏航标签静止 ${yawStillRoll.toExponential(1)}（须 ≈0）；` +
      `标签半径 偏航 ${radiusOf(yawLabel!).toFixed(2)}>${GIMBAL_GEOM.R_OUTER}、俯仰 ${radiusOf(pitchLabel!).toFixed(2)}>${GIMBAL_GEOM.R_MID}、横滚 ${radiusOf(rollLabel!).toFixed(2)}>${GIMBAL_GEOM.R_INNER}`,
  );
  rig.setAngles(0, 0, 0);
}

console.log(failures === 0 ? "\n场景图校验全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
