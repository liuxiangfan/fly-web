import * as THREE from "three";
import { buildQuad, type QuadModel } from "./quad";
import { makeTextSprite } from "./labels";
import { gimbalAxisAlign, gimbalLocked } from "../core/gimbal";

export interface GimbalRig {
  group: THREE.Group;
  /** 内嵌小四轴（螺旋桨可供转动动画） */
  quad: QuadModel;
  /**
   * 设置三个环的角度（弧度）。
   * 偏航绕显示 +Y 转 −yaw、俯仰绕显示 +Z 转 pitch、横滚绕显示 +X 转 roll，
   * 与 core/gimbal.ts 的 gimbalInnerQuat 严格同约定。
   */
  setAngles(roll: number, pitch: number, yaw: number): void;
  /** 死锁可视化：locked 时外环、内环及其轴销变红，intensity 0..1 控制强度 */
  setLockVisual(locked: boolean, intensity: number): void;
  /** 外环轴与内环轴对齐度：0 正交，1 重合 */
  axisAlign(): number;
  isLocked(): boolean;
  /** 供自检脚本检视的内部结构（无浏览器时也能校验场景图） */
  parts: {
    yawGroup: THREE.Group;
    pitchGroup: THREE.Group;
    rollGroup: THREE.Group;
    yawRing: THREE.Mesh;
    pitchRing: THREE.Mesh;
    rollRing: THREE.Mesh;
    /** 枢轴销：连接相邻两环，供几何连通性校验 */
    pivots: THREE.Mesh[];
  };
}

/**
 * 平衡环架的几何参数。三环紧密嵌套，中心线间距仅 0.06，环管半径 0.018，
 * 因此相邻环的表面间隙约 0.024——远紧于此前的 0.096，看起来才像真正的环架。
 */
export const GIMBAL_GEOM = {
  R_OUTER: 0.96,
  R_MID: 0.90,
  R_INNER: 0.84,
  TUBE: 0.018,
  PIN_R: 0.014,
} as const;

const { R_OUTER, R_MID, R_INNER, TUBE, PIN_R } = GIMBAL_GEOM;

const LOCK_COLOR = 0xf85149;
const PIN_COLOR = 0xd6e0ec;
const POST_COLOR = 0x3a4657;

/**
 * 三个环各用一个可区分的颜色，标签文字取同色系更亮的版本。
 * 环与标签同色 + 标签随环转动，两者共同保证「一眼看出标签属于哪个环」。
 */
const RING_COLOR = {
  yaw: 0x5a8ac0,
  pitch: 0xc09a5a,
  roll: 0x5ab89a,
} as const;
const LABEL_COLOR = {
  yaw: "#8dbdf0",
  pitch: "#e0bc80",
  roll: "#82d6bc",
} as const;
/** 环架中心离地高度（group.position.y），底座立柱据此接到外环底部 */
const HUB_HEIGHT = 1.15;

interface TintTarget {
  mat: THREE.MeshStandardMaterial;
  base: THREE.Color;
}

interface TintableMesh {
  mesh: THREE.Mesh;
  target: TintTarget;
}

/**
 * 三层平衡环架（阿波罗 IMU 式排布）。
 *
 * 枢轴销必须真正连接相邻两环，这约束了各环的平面朝向——每环的旋转轴必须是该环的
 * 一条直径，且枢轴点要落在相邻环上，于是：
 *   外环（偏航，轴 +Y）环面 YZ，枢轴在 ±Z（接中环）、±Y（接底座立柱）
 *   中环（俯仰，轴 +Z）环面 XZ，枢轴在 ±Z（接外环）、±X（接内环）
 *   内环（横滚，轴 +X）环面 XY，枢轴在 ±X（接中环）
 * 三个环面两两垂直，与真实环架一致；自检脚本会验证连通性与姿态一致性。
 */
export function buildGimbal(): GimbalRig {
  const group = new THREE.Group();

  const makeRing = (radius: number, color: number): TintableMesh => {
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.8,
      roughness: 0.28,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      emissive: new THREE.Color(color).multiplyScalar(0.14),
    });
    mat.envMapIntensity = 1.35; // 环境反射打亮金属环——质感主要来源
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, TUBE, 20, 120), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, target: { mat, base: new THREE.Color(color) } };
  };

  const makePin = (length: number): TintableMesh => {
    const mat = new THREE.MeshStandardMaterial({ color: PIN_COLOR, metalness: 0.95, roughness: 0.18 });
    mat.envMapIntensity = 1.5;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(PIN_R, PIN_R, length, 14), mat);
    return { mesh, target: { mat, base: new THREE.Color(PIN_COLOR) } };
  };

  const makeLabel = (text: string, color: string, pos: [number, number, number]): THREE.Sprite => {
    const s = makeTextSprite(text, color, { size: 0.15, bold: false, alwaysOnTop: true });
    s.position.set(pos[0], pos[1], pos[2]);
    return s;
  };

  /** 死锁时轴重合的是偏航轴与横滚轴，故高亮外环、内环以及承载这两根轴的轴销 */
  const lockTargets: TintTarget[] = [];
  const axisPinTargets: TintTarget[] = [];
  const pivots: THREE.Mesh[] = [];

  // ---- 外环：偏航，绕显示 +Y（垂直轴）。环面 YZ，枢轴在 ±Z（接中环）、±Y（接底座）----
  const yawGroup = new THREE.Group();
  const yawRing = makeRing(R_OUTER, RING_COLOR.yaw);
  yawRing.mesh.rotation.y = Math.PI / 2; // 环孔轴 Z→X，环面变为 YZ
  yawGroup.add(yawRing.mesh);
  lockTargets.push(yawRing.target);
  for (const s of [1, -1]) {
    // 垂直轴销：承载偏航轴，向下与底座立柱相接
    const pin = makePin(0.12);
    pin.mesh.position.set(0, s * R_OUTER, 0);
    yawGroup.add(pin.mesh);
    axisPinTargets.push(pin.target);
  }
  // 标签贴在环体上随环转动。方位角按相机取景（约 +X+Z 方向俯视）挑选，
  // 让三个标签落在各自环上视觉最清晰、彼此不重叠的位置：
  // 外环（YZ 平面）标签放在顶部偏左；中环（水平面）放在左前；内环（XY 平面）放在顶部
  yawGroup.add(makeLabel("偏航", LABEL_COLOR.yaw, [0, R_OUTER * 0.72, R_OUTER * 0.7]));

  // ---- 中环：俯仰，绕显示 +Z。环面 XZ（水平），枢轴在 ±Z（接外环）、±X（接内环）----
  const pitchGroup = new THREE.Group();
  const pitchRing = makeRing(R_MID, RING_COLOR.pitch);
  pitchRing.mesh.rotation.x = Math.PI / 2; // 环孔轴 Z→Y，环面变为 XZ
  pitchGroup.add(pitchRing.mesh);
  for (const s of [1, -1]) {
    // 与外环的枢轴：沿 Z 轴横跨两环间隙，两端插入环管
    const pin = makePin(R_OUTER - R_MID + 0.05);
    pin.mesh.position.set(0, 0, (s * (R_OUTER + R_MID)) / 2);
    pin.mesh.rotation.x = Math.PI / 2; // 圆柱轴 Y→Z
    pitchGroup.add(pin.mesh);
    pivots.push(pin.mesh);
  }
  // 标签贴在环体上随环转动：位于环面内的 −X 方向（中环水平面左侧）
  pitchGroup.add(makeLabel("俯仰", LABEL_COLOR.pitch, [-(R_MID + 0.13), 0, 0]));

  // ---- 内环：横滚，绕显示 +X。环面 XY，枢轴在 ±X（接中环）----
  const rollGroup = new THREE.Group();
  const rollRing = makeRing(R_INNER, RING_COLOR.roll);
  rollGroup.add(rollRing.mesh); // 默认环面即 XY，孔轴 Z
  lockTargets.push(rollRing.target);
  for (const s of [1, -1]) {
    // 与中环的枢轴：沿 X 轴横跨两环间隙
    const pin = makePin(R_MID - R_INNER + 0.05);
    pin.mesh.position.set((s * (R_MID + R_INNER)) / 2, 0, 0);
    pin.mesh.rotation.z = Math.PI / 2; // 圆柱轴 Y→X
    rollGroup.add(pin.mesh);
    pivots.push(pin.mesh);
    axisPinTargets.push(pin.target);
  }
  // 标签贴在环体上随环转动。半径取「所属环半径 + 小偏移」并保持在外环之内，
  // 这样标签绕到任何方位都仍紧贴自己的环，不会飘到整个环架外面去。
  // 配色上三环三色、标签与所属环同色，因此归属一目了然。
  rollGroup.add(makeLabel("横滚", LABEL_COLOR.roll, [0, R_INNER + 0.08, 0]));

  // 内嵌小四轴：不做任何额外旋转，其姿态就等于三级环链条的组合结果。
  // 不带自己的轴标签，避免环心处文字堆叠（环本身已经表达了三个旋转轴）。
  // 缩放上限受内环约束：桨尖半径 0.67 × scale 必须小于内环内表面 0.822，
  // 故取 1.15（=0.77）留出安全间隙；scenecheck 会校验这一点。
  const quad = buildQuad(false, { axes: false });
  quad.group.scale.setScalar(1.15);
  // 环内被环体遮挡、光线偏暗，且桨叶默认 50% 透明会糊成一片灰板，
  // 故针对环架内的这个实例提亮机身并提高桨叶不透明度，让它在环心清晰可辨
  quad.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) continue;
      if (std.transparent) {
        std.opacity = 0.82; // 螺旋桨
        std.color.setHex(0xc3cdd9);
      } else {
        std.color.lerp(new THREE.Color(0xffffff), 0.28); // 机身提亮
      }
      std.emissive = std.color.clone().multiplyScalar(0.3);
    }
  });
  rollGroup.add(quad.group);
  // 三级嵌套
  pitchGroup.add(rollGroup);
  yawGroup.add(pitchGroup);
  group.add(yawGroup);

  // 底座（不随偏航旋转）：立柱顶到外环底部的垂直轴销，底盘落在地面上
  const postMat = new THREE.MeshStandardMaterial({ color: POST_COLOR, metalness: 0.4, roughness: 0.6 });
  const postLen = HUB_HEIGHT - R_OUTER;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, postLen, 14), postMat);
  post.position.y = -(R_OUTER + postLen / 2);
  post.receiveShadow = true;
  group.add(post);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.03, 28), postMat);
  base.position.y = -(HUB_HEIGHT - 0.016);
  base.receiveShadow = true;
  group.add(base);

  // 三个环的标签分别挂在各自的环 group 下（见上文），随环一起转动，
  // 加上环与标签同色，因此能直接看出每个标签属于哪个环。

  const lockColor = new THREE.Color(LOCK_COLOR);

  return {
    group,
    quad,
    setAngles(roll: number, pitch: number, yaw: number): void {
      yawGroup.rotation.y = -yaw;
      pitchGroup.rotation.z = pitch;
      rollGroup.rotation.x = roll;
    },
    setLockVisual(locked: boolean, intensity: number): void {
      const t = locked ? Math.max(0.4, Math.min(1, intensity)) : 0;
      for (const target of [...lockTargets, ...axisPinTargets]) {
        target.mat.color.copy(target.base).lerp(lockColor, t);
        target.mat.emissive.copy(lockColor).multiplyScalar(t * 0.35);
      }
    },
    axisAlign(): number {
      return gimbalAxisAlign(pitchGroup.rotation.z);
    },
    isLocked(): boolean {
      return gimbalLocked(pitchGroup.rotation.z);
    },
    parts: {
      yawGroup,
      pitchGroup,
      rollGroup,
      yawRing: yawRing.mesh,
      pitchRing: pitchRing.mesh,
      rollRing: rollRing.mesh,
      pivots,
    },
  };
}
