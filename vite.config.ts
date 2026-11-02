import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

/**
 * 构建标识：线上页面要能回答「我现在看的是哪个提交」。
 * CI 里优先用 GITHUB_SHA；本地用 git 的短 SHA；再退化成时间戳（例如无 .git 的打包环境）。
 */
function buildStamp(): { commit: string; builtAt: string } {
  let commit = process.env.GITHUB_SHA?.slice(0, 12) ?? "";
  if (!commit) {
    try { commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* 无 git */ }
  }
  return { commit: commit || "unknown", builtAt: new Date().toISOString() };
}
const stamp = buildStamp();

/**
 * 构建配置：把 Three.js 单独拆成 vendor chunk。
 * 三个理由：① 应用代码（教学 UI/算法）改动频繁，three 版本稳定，拆开后
 * 浏览器缓存命中率更高；② 首屏并行下载；③ 单 chunk 体积告警只对 three 生效。
 */
export default defineConfig({
  // 注入成编译期常量：运行时不再读环境（Worker/离线包也一致）
  define: {
    __BUILD_COMMIT__: JSON.stringify(stamp.commit),
    __BUILD_TIME__: JSON.stringify(stamp.builtAt),
  },
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
