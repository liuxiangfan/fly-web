import * as THREE from "three";

export interface QuadModel {
  group: THREE.Group;
  props: THREE.Group[]; // 螺旋桨组，用于旋转动画
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
 * 程序化四轴模型。显示坐标系：机头 +X，机体右 +Z，上 +Y。
 * ghost = true 时用线框材质做「真实姿态幻影」。
 */
export function buildQuad(ghost: boolean): QuadModel {
  const group = new THREE.Group();
  const props: THREE.Group[] = [];

  const solid = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, ...extra });
  const wire = () =>
    new THREE.MeshBasicMaterial({
      color: 0x8b949e,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
  const mat = (color: number, extra?: Partial<THREE.MeshStandardMaterialParameters>) =>
    ghost ? wire() : solid(color, extra);

  const addMesh = (
    geom: THREE.BufferGeometry,
    material: THREE.Material,
    pos: [number, number, number] = [0, 0, 0],
    rotY = 0,
  ) => {
    const m = new THREE.Mesh(geom, material);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.y = rotY;
    if (!ghost) {
      m.castShadow = true;
    }
    group.add(m);
    return m;
  };

  // 机身
  addMesh(new THREE.BoxGeometry(0.46, 0.09, 0.3), mat(0x2a3140), [0, 0, 0]);
  // 机头指向 +X（橙色鼻锥）
  addMesh(new THREE.BoxGeometry(0.1, 0.07, 0.18), mat(0xff8c3b), [0.26, 0, 0]);
  // 顶部航电舱
  addMesh(new THREE.BoxGeometry(0.2, 0.07, 0.16), mat(0x39414f), [0.02, 0.075, 0]);

  const armMat = mat(0x39414f);
  const motorMat = mat(0x1c222c);
  const propMat = ghost
    ? wire()
    : new THREE.MeshStandardMaterial({
        color: 0x9aa4b2,
        transparent: true,
        opacity: 0.5,
        roughness: 0.4,
      });

  for (const [sx, sz] of armDirs()) {
    const dirX = sx / Math.SQRT2;
    const dirZ = sz / Math.SQRT2;
    const angle = -Math.atan2(dirZ, dirX);
    // 机臂
    const arm = new THREE.BoxGeometry(0.52, 0.035, 0.05);
    addMesh(arm, armMat, [dirX * 0.24, 0, dirZ * 0.24], angle);
    // 电机
    const motorPos: [number, number, number] = [dirX * 0.5, 0.045, dirZ * 0.5];
    addMesh(new THREE.CylinderGeometry(0.048, 0.055, 0.06, 20), motorMat, motorPos);
    // 螺旋桨（两片交叉薄板，随动画旋转）
    const prop = new THREE.Group();
    prop.position.set(motorPos[0], motorPos[1] + 0.04, motorPos[2]);
    for (const rot of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.006, 0.028), propMat);
      blade.rotation.y = rot;
      prop.add(blade);
    }
    group.add(prop);
    props.push(prop);
  }

  // 机体轴指示（仅实体模型）：前 红、右 绿、下 蓝
  if (!ghost) {
    group.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 0.52, 0xff5f56, 0.08, 0.05));
    group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.52, 0x7ee787, 0.08, 0.05));
    group.add(new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0), 0.52, 0x58a6ff, 0.08, 0.05));
  }

  return { group, props };
}
