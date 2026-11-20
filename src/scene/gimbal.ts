import * as THREE from "three";
import { buildQuad, type QuadModel } from "./quad";
import { makeTextSprite } from "./labels";
import { gimbalAxisAlign, gimbalLocked } from "../core/gimbal";

export interface GimbalRig {
  group: THREE.Group;
  /** 内嵌小四轴（螺旋桨可供转动动画） */
  quad: QuadModel;
  /**
   * 设置三个环的角度（弧度），**立即生效**（自检脚本用它做精确几何断言）。
   * 偏航绕显示 +Y 转 −yaw、俯仰绕显示 +Z 转 pitch、横滚绕显示 +X 转 roll，
   * 与 core/gimbal.ts 的 gimbalInnerQuat 严格同约定。
   */
  setAngles(roll: number, pitch: number, yaw: number): void;
  /** 设置目标角度并交给阻尼跟随（UI 用）：滑块/演示不再瞬跳，而是「丝滑」地追上 */
  setTargetAngles(roll: number, pitch: number, yaw: number): void;
  /** 每帧推进阻尼跟随（dt 秒）；返回是否仍在运动 */
  step(dt: number): boolean;
  /** 死锁可视化：locked 时两根重合轴与外/内环变红，intensity 0..1 控制强度 */
  setLockVisual(locked: boolean, intensity: number): void;
  /** 外环轴与内环轴对齐度：0 正交，1 重合 */
  axisAlign(): number;
  isLocked(): boolean;
  /** 当前显示角度（弧度，阻尼后的实际值） */
  currentAngles(): { roll: number; pitch: number; yaw: number };
  /** 供自检脚本检视的内部结构（无浏览器时也能校验场景图） */
  parts: {
    yawGroup: THREE.Group;
    pitchGroup: THREE.Group;
    rollGroup: THREE.Group;
    yawRing: THREE.Mesh;
    pitchRing: THREE.Mesh;
    rollRing: THREE.Mesh;
    /** 枢轴轴承：连接相邻两环（每个元素带它应连接的两个环半径），供几何连通性校验 */
    pivots: Array<{ mesh: THREE.Mesh; rInner: number; rOuter: number }>;
    /** 三根旋转轴的可见轴杆（世界系方向随父环） */
    axles: { yaw: THREE.Group; pitch: THREE.Group; roll: THREE.Group };
    /** 载荷（四轴 + 机体轴三箭头） */
    payload: THREE.Group;
    /** 三根轴的文字标签（随各自父级转动，用来验证层级） */
    axisLabels: { yaw: THREE.Sprite; pitch: THREE.Sprite; roll: THREE.Sprite };
  };
}

/**
 * 平衡环架的几何参数。环体做成**环带**（有宽度与厚度的金属圈）而不是细线圆环，
 * 这样才有真实云台/惯性平台的结构感；三环带宽不同、逐层内收，
 * 相邻环带之间留有 0.03 以上的净空（scenecheck 校验不穿模）。
 */
export const GIMBAL_GEOM = {
  R_OUTER: 1.0,
  R_MID: 0.855,
  R_INNER: 0.71,
  /** 环带宽度（沿旋转轴方向） */
  BAND_OUTER: 0.085,
  BAND_MID: 0.075,
  BAND_INNER: 0.065,
  /** 环带厚度（径向） */
  BAND_T: 0.026,
  PIN_R: 0.016,
  /** 轴向杆半径 */
  AXLE_R: 0.012,
} as const;

const { R_OUTER, R_MID, R_INNER, BAND_OUTER, BAND_MID, BAND_INNER, BAND_T, PIN_R, AXLE_R } = GIMBAL_GEOM;

const LOCK_COLOR = 0xf85149;
const PIN_COLOR = 0xcfd9e6;
const POST_COLOR = 0x39445a;

/**
 * 三个环各用一个可区分的颜色，标签文字取同色系更亮的版本。
 * 环与标签同色 + 标签随环转动，两者共同保证「一眼看出标签属于哪个环」。
 */
const RING_COLOR = {
  yaw: 0x3f7fd0,
  pitch: 0xd4a24a,
  roll: 0x36b389,
} as const;
const LABEL_COLOR = {
  yaw: "#8dbdf0",
  pitch: "#e6c48c",
  roll: "#88dcc0",
} as const;
/** 环架中心离地高度（group.position.y），底座立柱据此接到外环底部 */
const HUB_HEIGHT = 1.18;

interface TintTarget {
  mat: THREE.MeshStandardMaterial;
  base: THREE.Color;
  /** 死锁时的自发光强度基准 */
  baseEmissive: number;
}

/**
 * 三层平衡环架（阿波罗 IMU / 云台式排布），带真实结构的重建：
 *
 *  - 每个环是**环带**（带宽 × 壁厚），内外侧带倒角亮边——不是一根细线
 *  - 每根旋转轴有可见**轴杆**与两端**轴承座**：轴杆固定在外层环上，内层环绕着它转
 *    （这正是真实环架的受力结构：外环承载中环、中环承载内环）
 *  - 三根轴用细虚线 + 端点标签标出（偏航 ψ / 俯仰 θ / 横滚 φ），死锁时两根重合轴变红
 *  - 载荷是带机体轴三箭头的四轴，姿态 = 三级环链条的组合结果
 *
 * 枢轴约束与环面朝向：
 *   外环（偏航，轴 +Y）环面 YZ，轴杆在 ±Z（承载中环）、±Y（接底座立柱）
 *   中环（俯仰，轴 +Z）环面 XZ，轴杆在 ±X（承载内环）
 *   内环（横滚，轴 +X）环面 XY
 * 三个环面两两垂直；scenecheck 会验证连通性、环面包含自身旋转轴、以及姿态一致性。
 */
export function buildGimbal(): GimbalRig {
  const group = new THREE.Group();

  /** 环带：局部孔轴 +Z 的金属圈（带 + 两侧倒角亮边） */
  const makeBand = (radius: number, width: number, color: number): { obj: THREE.Group; mesh: THREE.Mesh; target: TintTarget } => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.45,
      roughness: 0.3,
      emissive: new THREE.Color(color).multiplyScalar(0.3),
    });
    const holder = new THREE.Group();
    // 环带本体：圆柱侧壁（无顶盖），轴向沿 Z
    const bandGeom = new THREE.CylinderGeometry(radius, radius, width, 128, 1, true);
    bandGeom.rotateX(Math.PI / 2);
    const band = new THREE.Mesh(bandGeom, mat);
    band.castShadow = true;
    band.receiveShadow = true;
    holder.add(band);
    // 两侧倒角亮边：细圆环，勾出环带的边缘轮廓（视觉上「像加工过的金属圈」）
    const rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.62),
      metalness: 0.7,
      roughness: 0.2,
      emissive: new THREE.Color(color).multiplyScalar(0.45),
    });
    rimMat.envMapIntensity = 1.2;
    for (const s of [1, -1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, BAND_T * 0.32, 8, 128), rimMat);
      rim.position.z = (s * width) / 2;
      holder.add(rim);
    }
    return { obj: holder, mesh: band, target: { mat, base: new THREE.Color(color), baseEmissive: 0.3 } };
  };

  const metalMat = (color: number, metalness = 0.95, roughness = 0.2): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    m.envMapIntensity = 1.5;
    return m;
  };

  /** 轴杆：沿局部 +Z 的细圆柱，中心在 z=0，长度 len */
  const makeAxleRod = (len: number, mat: THREE.Material): THREE.Mesh => {
    const g = new THREE.CylinderGeometry(AXLE_R, AXLE_R, len, 16);
    g.rotateX(Math.PI / 2);
    return new THREE.Mesh(g, mat);
  };

  /** 轴承座：套在轴杆上的短粗圆柱（外圈）+ 内圈 */
  const makeBearing = (mat: THREE.Material): THREE.Group => {
    const holder = new THREE.Group();
    const g = new THREE.CylinderGeometry(PIN_R * 1.75, PIN_R * 1.75, PIN_R * 1.5, 20);
    g.rotateX(Math.PI / 2);
    const outer = new THREE.Mesh(g, mat);
    holder.add(outer);
    const innerGeom = new THREE.CylinderGeometry(PIN_R * 1.1, PIN_R * 1.1, PIN_R * 1.9, 18);
    innerGeom.rotateX(Math.PI / 2);
    const inner = new THREE.Mesh(innerGeom, metalMat(0x8b98ab, 0.9, 0.3));
    holder.add(inner);
    return holder;
  };

  const lockTargets: TintTarget[] = [];
  const axisPinTargets: TintTarget[] = [];
  const pivots: Array<{ mesh: THREE.Mesh; rInner: number; rOuter: number }> = [];

  const pinMat = metalMat(PIN_COLOR, 0.95, 0.16);
  const pinTint: TintTarget = { mat: pinMat, base: new THREE.Color(PIN_COLOR), baseEmissive: 0 };
  axisPinTargets.push(pinTint);

  /**
   * 环间连接轴：一根沿局部 +Z 的细轴，**真正跨过两环之间的净空**（rInner→rOuter），
   * 中点套一个轴承。真实环架就是「外环上的轴承托住内环的轴」——
   * 只有跨过间隙的实体轴，结构上才讲得通；scenecheck 会断言它覆盖两端半径。
   */
  const makeLinkAxle = (rInner: number, rOuter: number): { group: THREE.Group; rod: THREE.Mesh } => {
    const len = rOuter - rInner + 0.03;
    const mid = (rInner + rOuter) / 2;
    const holder = new THREE.Group();
    const rodGeom = new THREE.CylinderGeometry(AXLE_R * 0.85, AXLE_R * 0.85, len, 14);
    rodGeom.rotateX(Math.PI / 2);
    const rod = new THREE.Mesh(rodGeom, pinMat);
    rod.position.z = mid;
    holder.add(rod);
    const b = makeBearing(pinMat);
    b.position.z = mid;
    holder.add(b);
    return { group: holder, rod };
  };

  // ---- 外环：偏航，绕显示 +Y。环面 YZ（孔轴 X），承载中环（轴杆沿 Z） ----
  const yawGroup = new THREE.Group();
  const yawRing = makeBand(R_OUTER, BAND_OUTER, RING_COLOR.yaw);
  yawRing.obj.rotation.y = Math.PI / 2; // 孔轴 Z→X，环面变为 YZ
  yawGroup.add(yawRing.obj);
  lockTargets.push(yawRing.target);
  // 环体上不再放「偏航/俯仰/横滚」文字精灵：死锁时两环重合，文字必然叠在一起。
  // 环的识别交给「同色 + 轴端标签（ψ 轴/θ 轴/φ 轴）+ 面板图例」，文字位置始终稳定。

  // 偏航轴：垂直轴杆（固定在基座上，不随外环转）→ 放在 group 下
  const yawAxleGroup = new THREE.Group();
  const yawRod = makeAxleRod(R_OUTER * 2 + 0.2, metalMat(0xa9b6c8, 0.95, 0.22));
  yawAxleGroup.add(yawRod);
  // 上下两个轴承：上端是自由端，下端接底座立柱
  const yawBearingTop = makeBearing(pinMat);
  yawBearingTop.position.y = R_OUTER;
  yawBearingTop.rotation.x = Math.PI / 2; // 轴承孔轴 → Y
  yawAxleGroup.add(yawBearingTop);
  const yawBearingBottom = makeBearing(pinMat);
  yawBearingBottom.position.y = -R_OUTER;
  yawBearingBottom.rotation.x = Math.PI / 2;
  yawAxleGroup.add(yawBearingBottom);
  group.add(yawAxleGroup);

  // 俯仰轴杆：沿 Z，固定在外环上（随偏航转），承载中环
  const pitchAxleGroup = new THREE.Group();
  const pitchRod = makeAxleRod((R_OUTER + R_MID) / 2 * 2 + 0.1, metalMat(0xa9b6c8, 0.95, 0.22));
  pitchAxleGroup.add(pitchRod);
  for (const s of [1, -1]) {
    const link = makeLinkAxle(R_MID, R_OUTER);
    link.group.position.z = s * 0.0001; // 保持两个实例彼此独立的位置记录
    link.group.scale.z = s; // 镜像到 ±Z 两侧
    pitchAxleGroup.add(link.group);
    pivots.push({ mesh: link.rod, rInner: R_MID, rOuter: R_OUTER });
  }
  yawGroup.add(pitchAxleGroup);

  // ---- 中环：俯仰，绕显示 +Z。环面 XZ（孔轴 Y），承载内环（轴杆沿 X） ----
  const pitchGroup = new THREE.Group();
  const pitchRing = makeBand(R_MID, BAND_MID, RING_COLOR.pitch);
  pitchRing.obj.rotation.x = Math.PI / 2; // 孔轴 Z→Y，环面变为 XZ
  pitchGroup.add(pitchRing.obj);
  // 环带与轴杆之间的连接耳（让「环确实骑在轴上」看得见）
  for (const s of [1, -1]) {
    const lug = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.075, 0.045),
      metalMat(RING_COLOR.pitch, 0.8, 0.32),
    );
    lug.position.set(0, 0, s * (R_MID + BAND_T * 0.4));
    pitchGroup.add(lug);
  }

  // 横滚轴杆：沿 X，固定在中环上，承载内环
  const rollAxleGroup = new THREE.Group();
  const rollRod = makeAxleRod(((R_MID + R_INNER) / 2) * 2 + 0.08, metalMat(0xa9b6c8, 0.95, 0.22));
  rollAxleGroup.add(rollRod);
  for (const s of [1, -1]) {
    const link = makeLinkAxle(R_INNER, R_MID);
    link.group.scale.z = s;
    rollAxleGroup.add(link.group);
    pivots.push({ mesh: link.rod, rInner: R_INNER, rOuter: R_MID });
  }
  rollAxleGroup.rotation.y = Math.PI / 2; // 轴杆 Z→X
  pitchGroup.add(rollAxleGroup);

  // ---- 内环：横滚，绕显示 +X。环面 XY（孔轴 Z） ----
  const rollGroup = new THREE.Group();
  const rollRing = makeBand(R_INNER, BAND_INNER, RING_COLOR.roll);
  rollGroup.add(rollRing.obj);
  lockTargets.push(rollRing.target);
  for (const s of [1, -1]) {
    const lug = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.07, 0.05),
      metalMat(RING_COLOR.roll, 0.8, 0.32),
    );
    lug.position.set(s * (R_INNER + BAND_T * 0.4), 0, 0);
    rollGroup.add(lug);
  }

  // 载荷：四轴（缩小）＋机体轴三箭头。姿态 = 三级环链条组合结果。
  const payload = new THREE.Group();
  const quad = buildQuad(false, { axes: false });
  quad.group.scale.setScalar(0.92);
  payload.add(quad.group);
  const axisDefs: Array<[string, [number, number, number], number, string]> = [
    ["x", [1, 0, 0], 0xff6b62, "#ff8a80"],
    ["y", [0, 0, 1], 0x7ee787, "#8fe39a"],
    ["z", [0, -1, 0], 0x58a6ff, "#7cbcff"],
  ];
  for (const [name, dir, color, labelColor] of axisDefs) {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(dir[0], dir[1], dir[2]),
      new THREE.Vector3(0, 0, 0),
      0.44,
      color,
      0.07,
      0.04,
    );
    payload.add(arrow);
    const lab = makeTextSprite(name, labelColor, { size: 0.1, bold: false });
    lab.position.set(dir[0] * 0.52, dir[1] * 0.52, dir[2] * 0.52);
    payload.add(lab);
  }
  rollGroup.add(payload);

  // 三级嵌套
  pitchGroup.add(rollGroup);
  yawGroup.add(pitchGroup);
  group.add(yawGroup);

  // ---- 轴指示：三根旋转轴的延长虚线 + 端点标签（死锁时一眼看出哪两根重合） ----
  const makeAxisIndicator = (color: number): { line: THREE.Line; mat: THREE.LineDashedMaterial } => {
    const mat = new THREE.LineDashedMaterial({
      color,
      dashSize: 0.06,
      gapSize: 0.045,
      transparent: true,
      opacity: 0.75,
    });
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
    ]);
    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    return { line, mat };
  };

  // 偏航轴（世界 Y）：固定在基座
  const yawAxis = makeAxisIndicator(RING_COLOR.yaw);
  yawAxis.line.rotation.x = -Math.PI / 2; // 局部 +Z → +Y
  yawAxis.line.scale.z = R_OUTER + 0.42;
  group.add(yawAxis.line);

  // 俯仰轴（随偏航转的 Z 轴）
  const pitchAxis = makeAxisIndicator(RING_COLOR.pitch);
  pitchAxis.line.scale.z = R_MID + 0.5;
  yawGroup.add(pitchAxis.line);

  // 横滚轴（随俯仰转的 X 轴）
  const rollAxis = makeAxisIndicator(RING_COLOR.roll);
  rollAxis.line.rotation.y = Math.PI / 2; // 局部 +Z → +X
  rollAxis.line.scale.z = R_INNER + 0.5;
  pitchGroup.add(rollAxis.line);

  // 轴端标签（跟着各自的轴系转，但不被环体遮挡）
  const yawAxisLabel = makeTextSprite("偏航轴 ψ", LABEL_COLOR.yaw, { size: 0.1, alwaysOnTop: true });
  yawAxisLabel.position.set(0, R_OUTER + 0.52, 0);
  group.add(yawAxisLabel);
  const pitchAxisLabel = makeTextSprite("俯仰轴 θ", LABEL_COLOR.pitch, { size: 0.1, alwaysOnTop: true });
  pitchAxisLabel.position.set(0, 0, R_MID + 0.62);
  yawGroup.add(pitchAxisLabel);
  const rollAxisLabel = makeTextSprite("横滚轴 φ", LABEL_COLOR.roll, { size: 0.1, alwaysOnTop: true });
  rollAxisLabel.position.set(R_INNER + 0.64, 0, 0);
  pitchGroup.add(rollAxisLabel);

  // ---- 死锁提示环：两根轴重合处的一圈红色脉冲 ----
  const lockHalo = new THREE.Mesh(
    new THREE.TorusGeometry(0.085, 0.012, 10, 40),
    new THREE.MeshBasicMaterial({ color: LOCK_COLOR, transparent: true, opacity: 0 }),
  );
  lockHalo.visible = false;
  group.add(lockHalo);

  // 底座（不随偏航旋转）：立柱顶到外环底部的下轴承，底盘落在地面上
  const postMat = new THREE.MeshStandardMaterial({ color: POST_COLOR, metalness: 0.45, roughness: 0.55 });
  const postLen = HUB_HEIGHT - R_OUTER;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.036, postLen, 18), postMat);
  post.position.y = -(R_OUTER + postLen / 2);
  post.receiveShadow = true;
  group.add(post);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 20), metalMat(0x7d8a9e, 0.9, 0.3));
  collar.position.y = -R_OUTER - 0.03;
  group.add(collar);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.032, 32), postMat);
  base.position.y = -(HUB_HEIGHT - 0.016);
  base.receiveShadow = true;
  group.add(base);
  // 底盘刻度环：让底座不只是个黑饼
  const baseRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.155, 0.006, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x4a5a72, transparent: true, opacity: 0.85 }),
  );
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = -(HUB_HEIGHT - 0.034);
  group.add(baseRing);

  const lockColor = new THREE.Color(LOCK_COLOR);

  // 阻尼跟随状态：current → target，指数趋近（临界阻尼观感，无过冲）
  const cur = { roll: 0, pitch: 0, yaw: 0 };
  const target = { roll: 0, pitch: 0, yaw: 0 };
  const SMOOTH_K = 14;

  const apply = (): void => {
    yawGroup.rotation.y = -cur.yaw;
    pitchGroup.rotation.z = cur.pitch;
    rollGroup.rotation.x = cur.roll;
  };

  return {
    group,
    quad,
    setAngles(roll: number, pitch: number, yaw: number): void {
      cur.roll = roll;
      cur.pitch = pitch;
      cur.yaw = yaw;
      target.roll = roll;
      target.pitch = pitch;
      target.yaw = yaw;
      apply();
    },
    setTargetAngles(roll: number, pitch: number, yaw: number): void {
      target.roll = roll;
      target.pitch = pitch;
      target.yaw = yaw;
    },
    step(dt: number): boolean {
      const k = 1 - Math.exp(-SMOOTH_K * Math.min(0.1, dt));
      let moving = false;
      for (const key of ["roll", "pitch", "yaw"] as const) {
        const d = target[key] - cur[key];
        if (Math.abs(d) > 1e-5) {
          cur[key] += d * k;
          moving = true;
        } else {
          cur[key] = target[key];
        }
      }
      apply();
      return moving;
    },
    setLockVisual(locked: boolean, intensity: number): void {
      const t = locked ? Math.max(0.4, Math.min(1, intensity)) : 0;
      for (const target of [...lockTargets, ...axisPinTargets]) {
        target.mat.color.copy(target.base).lerp(lockColor, t);
        target.mat.emissive.copy(lockColor).multiplyScalar(t * (target.baseEmissive > 0 ? 0.55 : 0.35));
      }
      // 两根重合轴：偏航轴与横滚轴一起变红并加粗观感（提高不透明度）
      yawAxis.mat.color.setHex(locked ? LOCK_COLOR : RING_COLOR.yaw);
      rollAxis.mat.color.setHex(locked ? LOCK_COLOR : RING_COLOR.roll);
      yawAxis.mat.opacity = locked ? 1 : 0.75;
      rollAxis.mat.opacity = locked ? 1 : 0.75;
      // 重合点脉冲环：落在横滚轴与偏航轴的交点（环心）
      lockHalo.visible = locked;
      lockHalo.material.opacity = t * 0.85;
      lockHalo.scale.setScalar(1 + 0.35 * t);
    },
    axisAlign(): number {
      return gimbalAxisAlign(cur.pitch);
    },
    isLocked(): boolean {
      return gimbalLocked(cur.pitch);
    },
    currentAngles(): { roll: number; pitch: number; yaw: number } {
      return { ...cur };
    },
    parts: {
      yawGroup,
      pitchGroup,
      rollGroup,
      yawRing: yawRing.mesh,
      pitchRing: pitchRing.mesh,
      rollRing: rollRing.mesh,
      pivots,
      axles: { yaw: yawAxleGroup, pitch: pitchAxleGroup, roll: rollAxleGroup },
      payload,
      axisLabels: { yaw: yawAxisLabel, pitch: pitchAxisLabel, roll: rollAxisLabel },
    },
  };
}
