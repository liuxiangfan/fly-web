import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
// 构建溯源（SW-06）：产物必须能证明"由这份源码构建"。纯 JS 模块，可被 Node 脚本与 CI 复用。
import { writeProvenance } from "./scripts/build-provenance.mjs";

/**
 * 构建标识：线上页面要能回答「我现在看的是哪个提交」。
 * CI 里优先用 GITHUB_SHA；本地用 git 的短 SHA；再退化成时间戳（例如无 .git 的打包环境）。
 *
 * `builtAt` 必须**可复现**（SW-06 的产物绑定靠它）：它会被注入 index.html 与页脚，
 * 用 `new Date()` 的话同一份源码每构建一次 `distHash` 就变一次，于是"证据对应的那份产物"
 * 永远只能存活到下一次构建——重建一次就把 600 s 长稳的结论判成失效，这是把"可复现"当成运气。
 * 优先级：显式 `BUILD_TIME`（重放/对齐用）→ git 提交时间（同一提交恒定）→ 当前时间（无 git 时）。
 */
function buildStamp(): { commit: string; builtAt: string } {
  let commit = process.env.GITHUB_SHA?.slice(0, 12) ?? "";
  if (!commit) {
    try { commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* 无 git */ }
  }
  const fromEnv = process.env.BUILD_TIME?.trim();
  let builtAt = fromEnv && !Number.isNaN(Date.parse(fromEnv)) ? new Date(fromEnv).toISOString() : "";
  if (!builtAt) {
    // 提交时间：`%cI` 是 ISO 8601（带时区），同一提交永远相同 → 构建可复现
    try { builtAt = new Date(execFileSync("git", ["log", "-1", "--format=%cI"], { encoding: "utf8" }).trim()).toISOString(); } catch { /* 无 git */ }
  }
  return { commit: commit || "unknown", builtAt: builtAt || new Date().toISOString() };
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
