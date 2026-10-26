import { defineConfig } from "vite";

/**
 * 构建配置：把 Three.js 单独拆成 vendor chunk。
 * 三个理由：① 应用代码（教学 UI/算法）改动频繁，three 版本稳定，拆开后
 * 浏览器缓存命中率更高；② 首屏并行下载；③ 单 chunk 体积告警只对 three 生效。
 */
export default defineConfig({
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
          return undefined;
        },
      },
    },
  },
});
