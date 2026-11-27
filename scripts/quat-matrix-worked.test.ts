import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { qConj, qFromEuler, qIntegrate, qMul, qRot, qRotInv, qToMatrix, type Quat, type V3 } from "../src/core/quat";

const parts = (q: Quat) => [q.w, q.x, q.y, q.z];
function near(actual: number[], expected: number[], label: string): void {
  assert.equal(actual.length, expected.length, label);
  assert.ok(actual.every((x, i) => Math.abs(x - expected[i]) < 1e-12), `${label}: [${actual}] ≠ [${expected}]`);
}

test("教材两张 4×4 的每一列分别是 q⊗p 和 p⊗q（乘积保留符号）", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const block = html.match(/<pre\b[^>]*\bdata-quat-products\b[^>]*>([^<]+)<\/pre>/u)?.[1];
  assert.ok(block, "未找到教材左右乘矩阵");
  const q = { w: 2, x: -3, y: 5, z: 7 };
  const rows = [...block.matchAll(/\[([^\]]+)\]/gu)].map(([, row]) => row.trim().split(/\s+/u).map(token => {
    assert.match(token, /^−?[wxyz]$/u);
    return (token.startsWith("−") ? -1 : 1) * q[token.slice(-1) as keyof Quat];
  }));
  assert.equal(rows.length, 8, "同一行左、右矩阵各有一组系数");
  for (const row of rows) assert.equal(row.length, 4);
  for (const [col, key] of (["w", "x", "y", "z"] as const).entries()) {
    const p = { w: 0, x: 0, y: 0, z: 0, [key]: 1 };
    near([0, 2, 4, 6].map(r => rows[r][col]), parts(qMul(q, p)), `L₄ 的 ${key} 列`);
    near([1, 3, 5, 7].map(r => rows[r][col]), parts(qMul(p, q)), `R₄ 的 ${key} 列`);
  }
});

test("朝东再绕机体 x 轴滚转：指数更新、夹乘、DCM 列与世界重力回投一致", () => {
  const s = Math.SQRT1_2, east = { w: s, x: 0, y: 0, z: s }, roll = { w: s, x: s, y: 0, z: 0 };
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // 前、右、下 → 东、下、北
  const products = [qMul(east, roll), qIntegrate(east, [Math.PI / 2, 0, 0], 1)];
  for (const q of products) {
    const sign = q.w < 0 ? -1 : 1;
    near(parts(q).map(x => sign * x), [0.5, 0.5, 0.5, 0.5], "只接受整体变号");
    for (const pose of [q, { w: -q.w, x: -q.x, y: -q.y, z: -q.z }]) {
      near(qToMatrix(pose), [0, 0, 1, 1, 0, 0, 0, 1, 0], "行主序 DCM");
      for (const [i, [x, y, z]] of axes.entries()) {
        const result = axes[(i + 1) % 3];
        near(parts(qMul(qMul(pose, { w: 0, x, y, z }), qConj(pose))), [0, ...result], `夹乘机体轴 ${i}`);
        near(qRot(pose, axes[i]), result, `机体轴 ${i} 在 NED 的方向`);
      }
      near(qRotInv(pose, [0, 0, 1]), [0, 1, 0], "Rᵀ 投影世界的下，不是 R");
    }
  }
  near(qRot(qMul(roll, east), [1, 0, 0]), [0, 0, 1], "误把机体增量放在左边，机头指下而非朝东");
});

test("俯仰 ±90°：世界的下沿机体 ∓x，改变横滚和偏航不改变投影", () => {
  for (const sign of [1, -1]) {
    for (const [roll, yaw] of [[0, 0], [0.63, 0], [-1.28, 0.81]]) {
      const q = qFromEuler(roll, sign * Math.PI / 2, yaw);
      near(qRotInv(q, [0, 0, 1]), [-sign, 0, 0], "锁点重力投影");
    }
  }
});
