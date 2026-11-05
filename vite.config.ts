import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
// 构建溯源（SW-06）：产物必须能证明"由这份源码构建"。纯 JS 模块，可被 Node 脚本与 CI 复用。
import { writeProvenance } from "./scripts/build-provenance.mjs";

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
  plugins: [
    {
      name: "quat-build-provenance",
      // 产物写完再写溯源：外面能按 buildId 把"哪份源码 → 哪份产物"钉在一起
      writeBundle(outputOptions) {
        const outDir = outputOptions.dir ?? resolve(__dirname ?? ".", "dist");
        writeProvenance(process.cwd(), outDir, { commit: stamp.commit, builtAt: stamp.builtAt });
      },
    },
  ],
  build: {
    target: "esnext",
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
