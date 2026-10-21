import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildQuad, type QuadModel } from "./quad";
import { buildGimbal, type GimbalRig } from "./gimbal";
import { buildQuatView, type QuatViewRig } from "./quatview";
import { makeTextSprite } from "./labels";
import { toDisplayQ } from "../core/gimbal";
import type { Quat } from "../core/quat";
import type { UiView } from "../ui/mode";

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  quad: QuadModel;
  ghost: QuadModel;
  gimbal: GimbalRig;
  quatView: QuatViewRig;
  /** NED 姿态四元数 → Three.js 显示四元数（S·q·S⁻¹），与万向环演示同源 */
  toDisplay: (qNed: Quat) => THREE.Quaternion;
  /** 切换视图：显隐对应模型并重置相机取景。ghostEnabled 为幻影复选框当前状态 */
  setView: (view: UiView, ghostEnabled: boolean) => void;
  /** 只同步模型显隐，不动相机（用于幻影开关等不该打断观察角度的场景） */
  syncVisibility: (view: UiView, ghostEnabled: boolean) => void;
  /** 玻璃盒：挂在显示四轴上的两根重力方向箭头（白=预测、品红=实测） */
  gravityArrows: {
    group: THREE.Group;
    predicted: THREE.ArrowHelper;
    measured: THREE.ArrowHelper;
  };
  /** 磁航向指示：水平面内指向估计姿态的机头方位（琥珀色），挂四轴组（随偏航转） */
  headingArrow: THREE.ArrowHelper;
}

/** 两个视图各自的取景 */
const VIEW_FRAMING: Record<UiView, { target: [number, number, number]; pos: [number, number, number] }> = {
  attitude: { target: [0, 0.9, 0], pos: [1.9, 1.35, 2.4] },
  gimbal: { target: [0, 1.15, 0], pos: [2.3, 1.75, 2.5] },
  quat: { target: [0, 1.0, 0], pos: [0, 1.6, 3.2] },
};

export function createScene(container: HTMLElement): SceneHandles {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // 与 CSS 设计令牌 --bg (#030712) 保持一致，让 3D 视口与页面无缝衔接
  scene.background = new THREE.Color(0x030712);
  scene.fog = new THREE.FogExp2(0x030712, 0.032);

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
    new THREE.MeshStandardMaterial({ color: 0x0a1020, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(12, 24, 0x2d3c5e, 0x16203a);
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

  // 玻璃盒：两根重力方向箭头，挂在显示四轴上随机体一起转。
  // 白色 = 算法预测的「下」（Rᵀ·ẑ）；品红 = 加计实测的「下」。
  // 收敛时两箭头重合；纯积分时白箭头缓慢转偏、品红纹丝不动——漂移的直观形态。
  // 长度取 0.34：比机体轴箭头（0.52）短，避免视觉混淆；起点略高于机身中心。
  const arrowOrigin = new THREE.Vector3(0, 0.08, 0);
  const predictedArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0), arrowOrigin, 0.34, 0xf1f5f9, 0.062, 0.04,
  );
  const measuredArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0), arrowOrigin, 0.34, 0xe879f9, 0.062, 0.04,
  );
  const gravityArrows = {
    group: new THREE.Group(),
    predicted: predictedArrow,
    measured: measuredArrow,
  };
  gravityArrows.group.add(predictedArrow, measuredArrow);
  gravityArrows.group.visible = false; // 默认关闭，由 UI 开关控制
  quad.group.add(gravityArrows.group);

  // 磁航向指示：挂在**场景**（不随机体滚转/俯仰），从四轴高度沿水平面指向
  // 「估计姿态的机头方位在水平面上的投影」。MARG 关：随陀螺漂移偏离真北罗盘箭头；
  // MARG 开：被磁场拉回与罗盘对齐。由 main.ts 每帧更新位置与朝向。
  const headingArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1.0, 0), 0.9, 0xffb454, 0.11, 0.07,
  );
  headingArrow.position.set(0, 1.0, 0);
  scene.add(headingArrow);

  // 万向节锁演示装置（默认隐藏，由 setView 控制）
  const gimbal = buildGimbal();
  gimbal.group.position.y = 1.15;
  gimbal.group.visible = false;
  scene.add(gimbal.group);

  // 四元数可视化视图（默认隐藏，由 setView 控制）；初始为差异最大的姿态对
  const quatView = buildQuatView();
  quatView.group.position.y = 1.0;
  quatView.group.visible = false;
  scene.add(quatView.group);
  quatView.setInterpolation([0, 0, 0], [140, 70, 160], 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 10;
  controls.maxPolarAngle = 1.65;

  // 基变换统一由 core/gimbal 提供，保证主视图与万向环演示严格同源
  const tmpOut = new THREE.Quaternion();
  const toDisplay = (qNed: Quat): THREE.Quaternion => {
    const r = toDisplayQ(qNed);
    return tmpOut.set(r.x, r.y, r.z, r.w);
  };

  const syncVisibility = (view: UiView, ghostEnabled: boolean): void => {
    quad.group.visible = view === "attitude";
    ghost.group.visible = view === "attitude" && ghostEnabled;
    gimbal.group.visible = view === "gimbal";
    quatView.group.visible = view === "quat";
  };

  const setView = (view: UiView, ghostEnabled: boolean): void => {
    syncVisibility(view, ghostEnabled);
    const f = VIEW_FRAMING[view];
    controls.target.set(f.target[0], f.target[1], f.target[2]);
    camera.position.set(f.pos[0], f.pos[1], f.pos[2]);
    controls.update();
  };

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

  return {
    renderer, scene, camera, controls, quad, ghost, gimbal, quatView, gravityArrows, headingArrow,
    toDisplay, setView, syncVisibility,
  };
}
