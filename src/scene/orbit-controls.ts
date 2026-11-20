import { MathUtils, Vector3, type PerspectiveCamera } from "three";

/** 教学视图实际使用的轨道控制子集：旋转、平移、滚轮缩放与阻尼。 */
export class OrbitControls {
  readonly target = new Vector3();
  enableDamping = true;
  dampingFactor = 0.08;
  minDistance = 1.4;
  maxDistance = 10;
  maxPolarAngle = 1.65;
  enabled = true;
  private readonly offset = new Vector3();
  private readonly panOffset = new Vector3();
  private theta = 0;
  private phi = 0;
  private radiusScale = 1;
  private readonly pointers = new Map<number, { x: number; y: number; button: number }>();
  private pinchDistance = 0;

  constructor(private readonly camera: PerspectiveCamera, private readonly domElement: HTMLElement) {
    domElement.style.touchAction = "none";
    domElement.oncontextmenu = this.onContextMenu;
    domElement.onpointerdown = this.onPointerDown;
    domElement.onpointermove = this.onPointerMove;
    domElement.onpointerup = this.onPointerUp;
    domElement.onpointercancel = this.onPointerUp;
    domElement.onwheel = this.onWheel;
    this.update();
  }

  private readonly onContextMenu = () => false;

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.domElement.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
    this.pinchDistance = this.distanceBetweenPointers();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const previous = this.pointers.get(event.pointerId);
    if (!this.enabled || !previous) return;
    const oldDistance = this.pinchDistance;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: previous.button });
    if (this.pointers.size > 1) {
      this.pinchDistance = this.distanceBetweenPointers();
      if (oldDistance && this.pinchDistance) this.radiusScale *= oldDistance / this.pinchDistance;
      return;
    }
    if (previous.button === 0) {
      const height = Math.max(1, this.domElement.clientHeight);
      this.theta -= 2 * Math.PI * dx / height;
      this.phi -= 2 * Math.PI * dy / height;
    } else {
      this.pan(dx, dy);
    }
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    this.pinchDistance = this.distanceBetweenPointers();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.radiusScale *= Math.exp(MathUtils.clamp(event.deltaY, -240, 240) * 0.001);
  };

  private distanceBetweenPointers(): number {
    const points = [...this.pointers.values()];
    return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  private pan(dx: number, dy: number): void {
    this.camera.updateMatrixWorld();
    const distance = this.camera.position.distanceTo(this.target);
    const scale = 2 * distance * Math.tan(MathUtils.degToRad(this.camera.fov * 0.5)) / Math.max(1, this.domElement.clientHeight);
    const e = this.camera.matrix.elements;
    this.panOffset.x += (-dx * e[0] + dy * e[4]) * scale;
    this.panOffset.y += (-dx * e[1] + dy * e[5]) * scale;
    this.panOffset.z += (-dx * e[2] + dy * e[6]) * scale;
  }

  update(): void {
    if (!this.enabled) return;
    const factor = this.enableDamping ? this.dampingFactor : 1;
    this.offset.copy(this.camera.position).sub(this.target);
    const radius = Math.hypot(this.offset.x, this.offset.y, this.offset.z);
    const theta = (radius ? Math.atan2(this.offset.x, this.offset.z) : 0) + this.theta * factor;
    const phi = MathUtils.clamp((radius ? Math.acos(MathUtils.clamp(this.offset.y / radius, -1, 1)) : 0) + this.phi * factor, 0.001, this.maxPolarAngle);
    const r = MathUtils.clamp(radius * this.radiusScale, this.minDistance, this.maxDistance);
    const sinPhi = Math.sin(phi);
    this.camera.position.set(
      this.target.x + r * sinPhi * Math.sin(theta),
      this.target.y + r * Math.cos(phi),
      this.target.z + r * sinPhi * Math.cos(theta),
    ).addScaledVector(this.panOffset, factor);
    this.target.addScaledVector(this.panOffset, factor);
    this.camera.lookAt(this.target);
    const decay = this.enableDamping ? 1 - this.dampingFactor : 0;
    this.theta *= decay;
    this.phi *= decay;
    this.radiusScale = 1;
    this.panOffset.multiplyScalar(decay);
  }

  dispose(): void {
    const d = this.domElement;
    d.oncontextmenu = d.onpointerdown = d.onpointermove = d.onpointerup = d.onpointercancel = d.onwheel = null;
  }
}
