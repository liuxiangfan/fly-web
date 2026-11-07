import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildQuad, type QuadModel } from "./quad";
import { buildGimbal, type GimbalRig } from "./gimbal";
import { buildQuatView, type QuatViewRig } from "./quatview";
import { makeTextSprite } from "./labels";
import { toDisplayQ } from "../core/gimbal";
import type { Quat } from "../core/quat";
import type { UiView } from "../ui/mode";

export interface SceneHandles {
  /** WebGL 渲染器；环境不支持 WebGL 时为 null（场景对象仍在，只是不渲染） */
  renderer: THREE.WebGLRenderer | null;
  /** 画质档：软件光栅化（无 GPU）自动降到 "software"（无 MSAA/阴影/IBL），其余为 "high" */
  quality: "high" | "software";
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
  /** 等效旋转轴指示（轴角表示，青色）：挂场景、从机体中心沿世界系旋转轴伸出，
   *  长度随转角缩放。由 main.ts 每帧更新（开关控制显隐） */
  axisArrow: THREE.ArrowHelper;
  /** 卡尔曼不确定度椭球（机体系 3σ 姿态协方差）：挂四轴，随玻璃盒开关显隐 */
  covEllipsoid: THREE.Mesh;
  /** 椭球的线框叠层（与 covEllipsoid 共用变换，只为形状可读） */
  covWire: THREE.Mesh;
}

/** 两个视图各自的取景 */
const VIEW_FRAMING: Record<UiView, { target: [number, number, number]; pos: [number, number, number] }> = {
  attitude: { target: [0, 0.9, 0], pos: [1.9, 1.35, 2.4] },
  // 环架半径 1.0、中心高 1.18：相机要退到 4 单位外，顶部环带才不会被裁
  gimbal: { target: [0, 1.2, 0], pos: [2.85, 2.1, 3.05] },
  quat: { target: [0, 0.95, 0], pos: [0, 1.75, 3.75] },
};

/**
 * 是否是「软件光栅化」环境（无 GPU 加速）：SwiftShader / llvmpipe / 基础显示驱动。
 *
 * 为什么要降档而不是照常画：这些环境里 800×600 的 MSAA + 1024² 阴影贴图 + IBL
 * 每帧要几百毫秒，实测（CI 2 vCPU、SwiftShader）单帧 JS 172 ms、timer p95 326 ms、
 * 点击到 handler 302 ms——真实用户在无 GPU 的机器上就是 3 fps 且点不动。
 * 降档只关「像素成本」项（MSAA/阴影/IBL/像素比），几何、动画、数据、交互全部不变。
 * 用刚创建的上下文读渲染器名称，命中就换一个无 MSAA 的渲染器（一次性开销）。
 */
function softwareGl(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "");
  } catch {
    return false;
  }
}

export function createScene(container: HTMLElement): SceneHandles {
  /**
   * WebGL 兜底：拿不到上下文时 `new WebGLRenderer()` 会抛异常。
   * 这里降级为「无 3D 的可用应用」——所有场景对象照常构建（THREE 的 Group/Mesh/
   * ArrowHelper 都不需要 GL 上下文），只把 renderer 置空：渲染调用被跳过，
   * 曲线、统计、文档演示、面板交互全部照常运转。
   */
  let lowEnd = false;
  let renderer: THREE.WebGLRenderer | null = null;
  let canvasEl: HTMLElement;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    lowEnd = softwareGl(renderer);
    if (lowEnd) {
      renderer.forceContextLoss();
      renderer.dispose();
      renderer = new THREE.WebGLRenderer({ antialias: false });
    }
    renderer.setPixelRatio(lowEnd ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = !lowEnd;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    canvasEl = renderer.domElement;
  } catch (err) {
    console.error("WebGL 上下文创建失败，3D 视图降级为停用：", err);
    const ph = document.createElement("div");
    ph.className = "no-webgl-note";
    ph.innerHTML =
      `<b>此环境无法创建 WebGL 上下文</b>，3D 视图（四轴 / 万向环架 / 四元数）已停用。<br />` +
      `曲线、评测表、算法内部量、磁力计校准、实验库与文档页不受影响，仍可正常使用。<br />` +
      `<span class="dim">常见原因：浏览器禁用硬件加速、远程桌面 / 虚拟机无 GPU、显卡驱动被列入屏蔽名单。</span>`;
    container.appendChild(ph);
    canvasEl = ph;
  }

  const scene = new THREE.Scene();
  // 与 CSS 设计令牌 --bg (#030712) 保持一致，让 3D 视口与页面无缝衔接
  scene.background = new THREE.Color(0x030712);
  scene.fog = new THREE.FogExp2(0x030712, 0.032);

  // 环境光照（IBL）：程序化房间环境 → PMREM。所有 MeshStandard/Physical 材质
  // 自动获得反射与 ambient，金属件立刻有了「质感」——无需外部 HDR 文件。
  // 无渲染器时跳过（PMREMGenerator 必须有 GL 上下文）；软件光栅化下 IBL 是纯像素成本，同样跳过
  if (renderer && !lowEnd) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = 0.35; // 深色舞台基调，反射作点缀而非主光
    envScene.dispose();
    pmrem.dispose();
  }

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(1.9, 1.35, 2.4);

  // 光照：半球环境光 + 带阴影的方向光
  const hemi = new THREE.HemisphereLight(0x9db4d6, 0x1a1f29, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
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
  // 冷色轮廓补光（无阴影，便宜）：从左后勾出金属件边缘
  const rim = new THREE.DirectionalLight(0x7aa8ff, 0.8);
  rim.position.set(-5, 3, -4);
  scene.add(rim);
  scene.add(rim.target);

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
  // 罗盘长度与标签位置收在画布安全区内（默认取景下不被右侧面板裁切）
  // 只在「四轴姿态」视图显示——万向节锁 / 四元数视图有自己的坐标系，罗盘会抢镜
  const compass = new THREE.Group();
  const north = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.01, 0), 1.42, 0xf0c674, 0.13, 0.065);
  compass.add(north);
  const nLabel = makeTextSprite("北", "#f0c674");
  nLabel.position.set(1.62, 0.3, 0);
  compass.add(nLabel);
  const east = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.01, 0), 1.42, 0x6fb3d2, 0.13, 0.065);
  compass.add(east);
  const eLabel = makeTextSprite("东", "#6fb3d2");
  eLabel.position.set(0, 0.3, 1.62);
  compass.add(eLabel);
  scene.add(compass);

  // 四轴模型：实体（解算姿态）+ 幻影（真实姿态）
  const quad = buildQuad(false);
  quad.group.position.y = 1.0;
  scene.add(quad.group);
  const ghost = buildQuad(true);
  ghost.group.position.y = 1.0;
  scene.add(ghost.group);

  // 卡尔曼的「不确定度椭球」：3×3 姿态协方差块特征分解后的可视化。
  // 挂在四轴上（不是场景上）——协方差定义在**机体系**，椭球必须跟着机体转，
  // 这样它的形状才代表「机体各轴方向上的姿态不确定度」。半透明、深色舞台里可辨认。
  // 两个网格共用同一个 4×4 变换：实心面给「体量」，线框给「形状」。
  // 只用实心面在深色舞台上太糊、只用线框又太虚，叠起来最接近教科书里的置信椭球。
  const covGeo = new THREE.SphereGeometry(1, 18, 12);
  const covEllipsoid = new THREE.Mesh(
    covGeo,
    new THREE.MeshBasicMaterial({
      color: 0xe05fb0, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  const covWire = new THREE.Mesh(
    covGeo,
    new THREE.MeshBasicMaterial({ color: 0xff9ad8, wireframe: true, transparent: true, opacity: 0.3, depthWrite: false }),
  );
  for (const m of [covEllipsoid, covWire]) {
    m.matrixAutoUpdate = false;
    m.visible = false;
    m.renderOrder = 2;
    quad.group.add(m);
  }

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

  // 等效旋转轴（轴角表示）：q 从单位姿态转到当前姿态所绕的世界系固定轴。
  // 青色与「四元数」视图的轴角箭头同色系——两个视图互相印证「瞬时旋转轴在哪」。
  // 挂场景（不随机体转动）：轴角的世界系轴在旋转过程中方向恒定（Slerp 大圆的几何根源）。
  const axisArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 1.4, 0x22d3ee, 0.12, 0.07,
  );
  axisArrow.position.set(0, 1.0, 0);
  axisArrow.visible = false; // 默认关闭，由 UI 开关控制
  scene.add(axisArrow);

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

  const controls = new OrbitControls(camera, canvasEl);
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
    compass.visible = view === "attitude";
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
    renderer?.setSize(w, h);
  };
  resize();
  new ResizeObserver(resize).observe(container);

  return {
    renderer, quality: lowEnd ? "software" : "high", scene, camera, controls, quad, ghost, gimbal, quatView, gravityArrows, headingArrow, axisArrow,
    covEllipsoid, covWire, toDisplay, setView, syncVisibility,
  };
}
