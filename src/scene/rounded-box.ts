import { BoxGeometry, type BufferGeometry } from "three";

/** 轻量圆角盒：把分段盒表面顶点投影到内盒 + 半径球面，保留实体/轮廓外观。 */
export function roundedBox(width: number, height: number, depth: number, radius: number, segments = 3): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth, segments, segments, segments);
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  for (let i = 0; i < positions.count; i++) {
    const p = [positions.getX(i), positions.getY(i), positions.getZ(i)];
    const c = p.map((v, axis) => Math.max(-[width, height, depth][axis] / 2 + radius, Math.min([width, height, depth][axis] / 2 - radius, v)));
    const n = p.map((v, axis) => v - c[axis]);
    const length = Math.hypot(...n);
    if (length) {
      const rounded = c.map((v, axis) => v + n[axis] / length * radius);
      positions.setXYZ(i, rounded[0], rounded[1], rounded[2]);
      normals.setXYZ(i, n[0] / length, n[1] / length, n[2] / length);
    }
  }
  return geometry;
}
