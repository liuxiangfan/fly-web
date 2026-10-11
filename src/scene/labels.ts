import * as THREE from "three";

export interface LabelOptions {
  /** canvas 内字号（像素），默认 76 */
  fontSize?: number;
  /** 标签高度（世界单位），默认 0.42 */
  size?: number;
  bold?: boolean;
  /** 是否始终显示在最前（不做深度遮挡），默认 false */
  alwaysOnTop?: boolean;
}

/**
 * 生成始终朝向相机的文字标签 sprite。
 * canvas 宽度按文字实际宽度自适应，因此支持多字标签（如「偏航」）。
 * 注意：Sprite 永远面向相机，父节点的旋转只影响其位置、不影响可读性。
 */
export function makeTextSprite(text: string, color: string, opts: LabelOptions = {}): THREE.Sprite {
  const fontSize = opts.fontSize ?? 76;
  const size = opts.size ?? 0.42;
  const font = `${opts.bold === false ? "" : "bold "}${fontSize}px 'PingFang SC', 'Microsoft YaHei', sans-serif`;

  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 16;
  const h = Math.ceil(fontSize * 1.32);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: !opts.alwaysOnTop,
    }),
  );
  if (opts.alwaysOnTop) sprite.renderOrder = 10;
  sprite.scale.set((size * w) / h, size, 1);
  return sprite;
}
