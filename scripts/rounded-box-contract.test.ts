import assert from "node:assert/strict";
import { roundedBox } from "../src/scene/rounded-box";

const g = roundedBox(0.46, 0.1, 0.3, 0.035, 3);
g.computeBoundingSphere();
assert.ok(g.attributes.position.count > 0);
assert.ok(Number.isFinite(g.boundingSphere?.radius));
for (let i = 0; i < g.attributes.position.count; i++) {
  const p = [g.attributes.position.getX(i), g.attributes.position.getY(i), g.attributes.position.getZ(i)];
  const n = [g.attributes.normal.getX(i), g.attributes.normal.getY(i), g.attributes.normal.getZ(i)];
  assert.ok(p.every(Number.isFinite), "圆角顶点必须有限");
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6, "圆角法线必须归一");
  assert.ok(Math.abs(p[0]) <= 0.230001 && Math.abs(p[1]) <= 0.050001 && Math.abs(p[2]) <= 0.150001, "顶点不得超出盒包络");
}
console.log("rounded-box-contract: 3 PASS / 0 FAIL");
