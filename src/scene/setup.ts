import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildQuad, type QuadModel } from "./quad";

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  quad: QuadModel;
  ghost: QuadModel;
  /** NED 姿态四元数 → Three.js 显示四元数（基变换 S·q·S⁻¹） */
  toDisplay: (qNed: { w: number; x: number; y: number; z: number }) => THREE.Quaternion;
}

function makeTextSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.font = "bold 76px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.42, 0.42, 1);
  return s;
}

export function createScene(container: HTMLElement): SceneHandles {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.FogExp2(0x0d1117, 0.03);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(1.9, 1.35, 2.4);

  // 光照：半球环境光 + 带阴影的方向光
  const hemi = new THREE.HemisphereLight(0x9db4d6, 0x1a1f29, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 6, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -3;
  sun.shadow.camera.right = 3;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -3;
  sun.shadow.camera.far = 20;
  scene.add(sun);
  scene.add(sun.target);

  // 地面 + 网格
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 64),
    new THREE.MeshStandardMaterial({ color: 0x141a24, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(12, 24, 0x2f3b4d, 0x1c2532);
  grid.position.y = 0.002;
  scene.add(grid);

  // 罗盘：北 +X、东 +Z（NED 的 N/E 经基变换后的方向）
  const north = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.01, 0), 1.7, 0xf0c674, 0.14, 0.07);
  scene.add(north);
  const nLabel = makeTextSprite("北", "#f0c674");
  nLabel.position.set(2.05, 0.3, 0);
  scene.add(nLabel);
  const east = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.01, 0), 1.7, 0x6fb3d2, 0.14, 0.07);
  scene.add(east);
  const eLabel = makeTextSprite("东", "#6fb3d2");
  eLabel.position.set(0, 0.3, 2.05);
  scene.add(eLabel);

  // 四轴模型：实体（解算姿态）+ 幻影（真实姿态）
  const quad = buildQuad(false);
  quad.group.position.y = 1.0;
  scene.add(quad.group);
  const ghost = buildQuad(true);
  ghost.group.position.y = 1.0;
  scene.add(ghost.group);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 10;
  controls.maxPolarAngle = 1.65;

  // NED(北东下) → Three(X=北, Y=上, Z=东)：R_t = S·R_n·Sᵀ，S = 绕 X 轴 +90°
  const S = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const SInv = S.clone().invert();
  const tmp = new THREE.Quaternion();
  const toDisplay = (qNed: { w: number; x: number; y: number; z: number }): THREE.Quaternion =>
    tmp.copy(S).multiply(new THREE.Quaternion(qNed.x, qNed.y, qNed.z, qNed.w)).multiply(SInv);

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  resize();
  new ResizeObserver(resize).observe(container);

  return { renderer, scene, camera, controls, quad, ghost, toDisplay };
}
