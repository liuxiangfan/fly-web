// 从 public/favicon.svg 生成 PWA 图标（192/512）与 Apple Touch Icon。
// 运行：npm run icons（需要 devDependency sharp）
import sharp from "sharp";

const bg = { r: 3, g: 7, b: 18, alpha: 1 };
for (const size of [192, 512]) {
  await sharp("public/favicon.svg", { density: 384 })
    .resize(size, size, { fit: "contain", background: bg })
    .flatten({ background: "#030712" })
    .png({ compressionLevel: 9 })
    .toFile(`public/icon-${size}.png`);
  console.log(`icon-${size}.png`);
}
await sharp("public/favicon.svg", { density: 384 })
  .resize(180, 180, { fit: "contain", background: bg })
  .flatten({ background: "#030712" })
  .png()
  .toFile("public/apple-touch-icon.png");
console.log("apple-touch-icon.png");
