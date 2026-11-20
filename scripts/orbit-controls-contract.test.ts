import assert from "node:assert/strict";
import { PerspectiveCamera } from "three";
import { OrbitControls } from "../src/scene/orbit-controls";

class FakeElement {
  style: Record<string, string> = {};
  clientHeight = 600;
  private listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (event: any) => void): void { this.listeners.get(type)?.delete(fn); }
  setPointerCapture(): void {}
  fire(type: string, event: Record<string, unknown>): void {
    const value = { preventDefault() {}, ...event };
    (this as any)[`on${type}`]?.(value);
    for (const fn of this.listeners.get(type) ?? []) fn(value);
  }
  count(type: string): number { return (this as any)[`on${type}`] ? 1 : (this.listeners.get(type)?.size ?? 0); }
}

const camera = new PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(1.9, 1.35, 2.4);
const dom = new FakeElement();
const controls = new OrbitControls(camera, dom as unknown as HTMLElement);
controls.target.set(0, 0.9, 0);
controls.enableDamping = false;
controls.minDistance = 1.4;
controls.maxDistance = 10;
controls.maxPolarAngle = 1.65;
controls.update();
const distance = () => camera.position.distanceTo(controls.target);
const initialDistance = distance();

// 左键旋转保持半径并改变相机方位。
dom.fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
dom.fire("pointermove", { pointerId: 1, clientX: 160, clientY: 125, button: 0 });
controls.update();
assert.ok(Math.abs(camera.position.x - 1.9) > 0.01, "左键拖拽没有旋转相机");
assert.ok(Math.abs(distance() - initialDistance) < 1e-8, "旋转不应改变轨道半径");
dom.fire("pointerup", { pointerId: 1 });

// 滚轮缩放并严格遵守最小/最大距离。
const beforeWheel = distance();
dom.fire("wheel", { deltaY: 120 });
controls.update();
assert.ok(distance() > beforeWheel, "滚轮向下没有拉远相机");
dom.fire("wheel", { deltaY: 240 });
for (let i = 0; i < 20; i++) { dom.fire("wheel", { deltaY: 240 }); controls.update(); }
assert.equal(distance(), 10, "最大距离限制失效");
for (let i = 0; i < 80; i++) { dom.fire("wheel", { deltaY: -240 }); controls.update(); }
assert.equal(distance(), 1.4, "最小距离限制失效");

// 右键平移同时移动 target 与相机，保持轨道偏移。
const offsetBefore = camera.position.clone().sub(controls.target);
dom.fire("pointerdown", { pointerId: 2, clientX: 100, clientY: 100, button: 2 });
dom.fire("pointermove", { pointerId: 2, clientX: 140, clientY: 110, button: 2 });
controls.update();
assert.ok(controls.target.length() > 0.01, "右键拖拽没有平移 target");
assert.ok(camera.position.clone().sub(controls.target).distanceTo(offsetBefore) < 1e-8, "平移改变了轨道偏移");
dom.fire("pointerup", { pointerId: 2 });

// 双指捏合改变半径，抬指后剩余指针仍可继续旋转。
// 先把相机放到中间距离，避免把「已到下限仍被夹住」误报成捏合失效。
camera.position.sub(controls.target).setLength(4).add(controls.target);
controls.update();
dom.fire("pointerdown", { pointerId: 3, clientX: 100, clientY: 100, button: 0 });
dom.fire("pointerdown", { pointerId: 4, clientX: 200, clientY: 100, button: 0 });
const beforePinch = distance();
dom.fire("pointermove", { pointerId: 4, clientX: 240, clientY: 100, button: 0 });
controls.update();
assert.ok(Math.abs(distance() - beforePinch) > 0.01, "双指捏合没有缩放");
dom.fire("pointerup", { pointerId: 4 });
dom.fire("pointerup", { pointerId: 3 });

// 极角上限与 dispose 事件解绑。
dom.fire("pointerdown", { pointerId: 5, clientX: 0, clientY: 0, button: 0 });
dom.fire("pointermove", { pointerId: 5, clientX: 0, clientY: -100000, button: 0 });
controls.update();
const spherical = camera.position.clone().sub(controls.target);
assert.ok(Math.abs(Math.atan2(Math.hypot(spherical.x, spherical.z), spherical.y) - 1.65) < 1e-8, "极角上限失效");
dom.fire("pointerup", { pointerId: 5 });
controls.dispose();
assert.equal(dom.count("pointermove"), 0);
assert.equal(dom.count("wheel"), 0);
console.log("orbit-controls-contract: 6 PASS / 0 FAIL");
