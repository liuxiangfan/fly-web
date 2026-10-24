import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { makeTextSprite } from "./labels";

export interface QuadModel {
  group: THREE.Group;
  props: THREE.Group[]; // 螺旋桨组，用于旋转动画
}

export interface QuadOptions {
  /** 是否添加机体轴箭头与 x/y/z 字母标签，默认 true（万向环内嵌的小四轴用 false） */
  axes?: boolean;
}

function armDirs(): Array<[number, number]> {
  return [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
}

/**
 * 程序化四轴模型（PBR 质感版）。显示坐标系：机头 +X，机体右 +Z，上 +Y。
 * ghost = true 时以青灰轮廓线（EdgesGeometry）呈现「真实姿态幻影」。
 * 外形包络与旧版一致（桨尖径向 ≈0.68），保证万向环内嵌不穿模断言不变。
 */
export function buildQuad(ghost: boolean, opts: QuadOptions = {}): QuadModel {
  const withAxes = opts.axes !== false;
  const group = new THREE.Group();
  const props: THREE.Group[] = [];

  // ---- 材质库（实体）----
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x232b3a, metalness: 0.55, roughness: 0.32,
    clearcoat: 0.7, clearcoatRoughness: 0.25, // 碳纤亮漆
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x141a26, metalness: 0.5, roughness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0xff8c3b, metalness: 0.35, roughness: 0.35, emissive: 0x944012, emissiveIntensity: 0.35,
  });
  const armMat = new THREE.MeshStandardMaterial({ color: 0x1c2330, metalness: 0.7, roughness: 0.38 });
  const motorMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.9, roughness: 0.25 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0c1220, metalness: 0.1, roughness: 0.08,
    transparent: true, opacity: 0.85,
  });
  const propMat = new THREE.MeshStandardMaterial({
    color: 0x2c3442, metalness: 0.3, roughness: 0.45,
  });
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x9fd8e8, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  // ghost：轮廓线材质（同几何体，只画棱边）
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.5 });

  /** 实体网格 → ghost 时转为轮廓线段 */
  const addPart = (
    geom: THREE.BufferGeometry,
    solidMat: THREE.Material,
    pos: [number, number, number] = [0, 0, 0],
  ): THREE.Object3D => {
    let obj: THREE.Object3D;
    if (ghost) {
      obj = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 24), edgeMat);
    } else {
      const m = new THREE.Mesh(geom, solidMat);
      m.castShadow = true;
      obj = m;
    }
    obj.position.set(pos[0], pos[1], pos[2]);
    group.add(obj);
    return obj;
  };

  // ---- 机身 ----
  addPart(new RoundedBoxGeometry(0.46, 0.1, 0.3, 3, 0.035), bodyMat);
  // 机头：橙色鼻锥（圆柱侧放，指向 +X）+ 前视相机云台
  const nose = addPart(new THREE.CylinderGeometry(0.052, 0.062, 0.1, 20), accentMat, [0.255, 0, 0]);
  nose.rotation.z = -Math.PI / 2;
  addPart(new THREE.SphereGeometry(0.055, 20, 16), darkMat, [0.16, -0.075, 0]); // 云台球
  const lens = addPart(new THREE.CylinderGeometry(0.026, 0.03, 0.03, 16), glassMat, [0.205, -0.075, 0]);
  lens.rotation.z = -Math.PI / 2;
  // 顶部航电舱 + GPS「蘑菇头」
  addPart(new RoundedBoxGeometry(0.2, 0.07, 0.16, 2, 0.025), darkMat, [0.02, 0.075, 0]);
  addPart(new THREE.CylinderGeometry(0.008, 0.01, 0.05, 10), motorMat, [-0.06, 0.13, 0]);
  const gpsPuck = addPart(new THREE.SphereGeometry(0.022, 14, 10), darkMat, [-0.06, 0.155, 0]);
  void gpsPuck;

  // ---- 机臂 / 电机 / 螺旋桨 ----
  // 前臂航行灯：白青；后臂：红（与真实无人机导航灯惯例一致）
  const ledFront = new THREE.MeshStandardMaterial({
    color: 0x9ff5ff, emissive: 0x67e8f9, emissiveIntensity: 2.2,
  });
  const ledRear = new THREE.MeshStandardMaterial({
    color: 0xffb3b0, emissive: 0xff4438, emissiveIntensity: 2.0,
  });

  for (const [sx, sz] of armDirs()) {
    const dirX = sx / Math.SQRT2;
    const dirZ = sz / Math.SQRT2;
    const angle = -Math.atan2(dirZ, dirX);
    // 机臂：锥形圆柱（电机端略细），略微上翘
    const armLen = 0.42;
    const arm = addPart(
      new THREE.CylinderGeometry(0.017, 0.023, armLen, 12),
      armMat,
      [dirX * (armLen / 2 + 0.1), 0.012, dirZ * (armLen / 2 + 0.1)],
    );
    arm.rotation.z = Math.PI / 2 - 0.06;
    arm.rotation.y = angle;
    // 电机：铃形（两层圆柱）
    const motorPos: [number, number, number] = [dirX * 0.5, 0.045, dirZ * 0.5];
    addPart(new THREE.CylinderGeometry(0.05, 0.056, 0.055, 20), motorMat, motorPos);
    addPart(new THREE.CylinderGeometry(0.02, 0.02, 0.016, 12), darkMat,
      [motorPos[0], motorPos[1] + 0.034, motorPos[2]]);
    // 航行灯（非 ghost）
    if (!ghost) {
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.014, 10, 8),
        sx > 0 ? ledFront : ledRear,
      );
      led.position.set(motorPos[0] - dirX * 0.045, motorPos[1] - 0.018, motorPos[2] - dirZ * 0.045);
      group.add(led);
    }
    // 螺旋桨：两片桨叶 + 高速旋转的半透明桨盘
    const prop = new THREE.Group();
    prop.position.set(motorPos[0], motorPos[1] + 0.048, motorPos[2]);
    if (ghost) {
      const blades = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.34, 0.006, 0.028), 24), edgeMat,
      );
      prop.add(blades);
    } else {
      for (const rot of [0, Math.PI / 2]) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.006, 0.032), propMat);
        blade.rotation.y = rot;
        blade.castShadow = true;
        prop.add(blade);
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.125, 28), discMat);
      disc.rotation.x = -Math.PI / 2;
      prop.add(disc);
    }
    group.add(prop);
    props.push(prop);
  }

  // ---- 机体轴指示（仅实体模型）：前 红、右 绿、下 蓝 ----
  if (!ghost && withAxes) {
    group.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 0.52, 0xff5f56, 0.08, 0.05));
    group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.52, 0x7ee787, 0.08, 0.05));
    group.add(new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0), 0.52, 0x58a6ff, 0.08, 0.05));

    // 轴字母标签：作为 group 子节点，随机体一起转动（NED：x 前、y 右、z 下）
    const axisLabel = (text: string, color: string, pos: [number, number, number]) => {
      const label = makeTextSprite(text, color, { size: 0.12, bold: false });
      label.position.set(pos[0], pos[1], pos[2]);
      group.add(label);
    };
    axisLabel("x", "#ff8a80", [0.66, 0.04, 0]);
    axisLabel("y", "#8fe39a", [0, 0.04, 0.66]);
    axisLabel("z", "#7cbcff", [0, -0.66, 0]);
  }

  return { group, props };
}
