import { defineConfig, type Plugin } from "vite";
import { ShaderChunk } from "three";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { minify as minifyHtml } from "html-minifier-terser";
import { minify as minifyJs } from "terser";
// 构建溯源（SW-06）：产物必须能证明"由这份源码构建"。纯 JS 模块，可被 Node 脚本与 CI 复用。
import { writeProvenance } from "./scripts/build-provenance.mjs";

/**
 * Worker 入口与主应用共享同一份数值内核（SW-09 结构性重复的修复）。
 *
 * 为什么不用标准 `?worker` / `new Worker(new URL(...))`：Vite 会为每个 Worker
 * **单独跑一次 Rollup**，runner/estimators 会被完整复制进 Worker chunk。这里把 Worker
 * 作为同一构建图里的 emitted chunk，主线程通过 `import.meta.ROLLUP_FILE_URL_*` 拿到
 * 带 hash 的 URL，于是主包与 Worker 引用同一个 shared chunk。
 *
 * 约束：
 *  - Worker 入口必须只 import worker-safe 的纯模块（不得拖入 DOM / Three.js / main）；
 *  - build 走虚拟 URL，dev 直接指向源码模块（由 Vite dev server 转换）；
 *  - 必须保留 hash 文件名，Service Worker 对 /assets/ 是 cache-first。
 */
const WORKER_ENTRIES = {
  batch: resolve(__dirname, "src/workers/batch.worker.ts"),
  comparison: resolve(__dirname, "src/workers/comparison.worker.ts"),
} as const;
type WorkerEntryName = keyof typeof WORKER_ENTRIES;

function sharedWorkerUrls(): Plugin {
  const refs = new Map<WorkerEntryName, string>();
  let command: "build" | "serve" = "build";
  return {
    name: "quat-shared-worker-urls",
    configResolved(config) {
      command = config.command;
    },
    buildStart() {
      if (command !== "build") return;
      for (const [name, id] of Object.entries(WORKER_ENTRIES) as Array<[WorkerEntryName, string]>) {
        refs.set(name, this.emitFile({ type: "chunk", id, name }));
      }
    },
    resolveId(id) {
      return id.startsWith("virtual:worker-url/") ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith("\0virtual:worker-url/")) return null;
      const name = id.slice("\0virtual:worker-url/".length) as WorkerEntryName;
      if (!(name in WORKER_ENTRIES)) throw new Error(`unknown worker-url: ${name}`);
      if (command === "serve") {
        const rel = name === "batch" ? "src/workers/batch.worker.ts" : "src/workers/comparison.worker.ts";
        return `export default import.meta.env.BASE_URL + ${JSON.stringify(rel)};`;
      }
      const ref = refs.get(name);
      if (!ref) throw new Error(`worker chunk 未发射: ${name}`);
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}

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
    sharedWorkerUrls(),
    {
      // 只处理与 Three 内置 ShaderChunk 完全相等的字面量；保留换行、宏和注释。
      name: "compact-three-glsl",
      apply: "build",
      transform(code, id) {
        if (!id.endsWith("/three/build/three.module.js")) return;
        const shaders = new Map(Object.values(ShaderChunk).filter(s => !s.includes("/*") && !s.includes("\\")).map(s => {
          const compact = s.split("\n").map(line => /^\s*#|\/\//.test(line) ? line : line.trimStart()
            .replace(/[ \t]*([(),;{}\[\]])[ \t]*|(?<=\w) ([=+*/<>-]) (?=\w)/g, "$1$2")).join("\n");
          return [JSON.stringify(s), JSON.stringify(compact)] as const;
        }));
        return code.replace(/^((?:var|const) [\w$]+ = )(".*");$/gm,
          (decl, prefix, literal) => shaders.has(literal) ? prefix + shaders.get(literal) + ";" : decl);
      },
    },
    {
      // 只压缩**构建产物**：源码 index.html 仍保持可读，便于教材维护与契约检查。
      // 内联文档占产物体积的大头，折叠空白/注释能同时缓解总产物与外壳预算。
      name: "quat-html-minify",
      apply: "build",
      async transformIndexHtml(html) {
        return await minifyHtml(html, {
          collapseWhitespace: true,
          conservativeCollapse: true,
          removeComments: true,
          removeRedundantAttributes: true,
          removeOptionalTags: true,
          removeAttributeQuotes: true,
          collapseBooleanAttributes: true,
          minifyCSS: true,
          sortAttributes: false,
          minifyJS: false,
          caseSensitive: true,
        });
      },
    },
    {
      name: "quat-build-provenance",
      // 产物写完再写溯源：外面能按 buildId 把"哪份源码 → 哪份产物"钉在一起
      async writeBundle(outputOptions) {
        const outDir = outputOptions.dir ?? resolve(__dirname ?? ".", "dist");
        // public/ 里的 SW 原样带注释发布；注释只服务源码阅读，运行时不需要。
        // 在这里、写溯源**之前**压掉，保证 buildId/distHash 与最终产物一致。
        const swPath = resolve(outDir, "sw.js");
        if (existsSync(swPath)) {
          const minified = await minifyJs(readFileSync(swPath, "utf8"), {
            module: true,
            compress: { passes: 2 },
            mangle: true,
            format: { comments: false },
          });
          if (minified.code) writeFileSync(swPath, minified.code);
        }
        writeProvenance(process.cwd(), outDir, { commit: stamp.commit, builtAt: stamp.builtAt });
      },
    },
  ],
  build: {
    // 懒加载 chunk 不应出现在首屏 modulepreload：Vite 默认会把入口的动态 import
    // 依赖也注入 <link rel=modulepreload>，等于提前下载整个教学 UI。
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((d) =>
          !/teaching-ui|doc-demos|tour-|runner-|trace-events|comparison-|experiments-|challenges-|tools-ui/.test(d),
        );
      },
    },
    // esbuild 默认压缩已很快，但预算按 gzip 字节计；terser 多遍折叠在本项目的
    // 大量纯函数/短字符串场景实测更小，且只在构建期运行（不进运行时）。
    minify: "terser",
    terserOptions: {
      module: true,
      compress: { passes: 5, toplevel: true, unsafe_arrows: true, unsafe_methods: true, pure_getters: true, unsafe: true },
      // module:true 会保留 ESM 导出名；顶层内部标识符可安全缩短。
      mangle: { toplevel: true },
      format: { comments: false },
    },
    target: "esnext",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // 动态入口默认保留整个导出表，会把仅测试用的 helper 一起打进 chunk。
      // 主入口只按名取用（并可被静态分析），因此允许 Rollup 摇掉未用导出。
      preserveEntrySignatures: false,
      output: {
        // emitFile 的 Worker 入口虽然 isEntry=true，但走 chunkFileNames；
        // 必须保留 `batch.worker-` 前缀，预算脚本与 size-report 靠它分类。
        chunkFileNames(chunk) {
          if (chunk.name === "batch") return "assets/batch.worker-[hash].js";
          if (chunk.name === "comparison") return "assets/comparison.worker-[hash].js";
          return "assets/[name]-[hash].js";
        },
        manualChunks(id) {
          if (id.includes("node_modules/three") || id.includes("/src/scene/orbit-controls")) return "three";
          // 主包与按需教学 chunk 共享的纯模块：必须放在首屏侧，
          // 否则 Rollup 会把它们塞进 teaching chunk，首屏就被迫预加载整个教学 UI。
          // experiment-archive 同理：main 与 tools-ui 共享的纯档案校验/构造逻辑，
          // 一旦落在按需 chunk 里，主包就会静态反向依赖它（实测：首屏曾因此加载 tools-ui）。
          if (
            id.includes("/src/core/html-escape") ||
            id.includes("/src/core/reconnect-schedule") ||
            id.includes("/src/ui/view-action") ||
            id.includes("/src/core/experiment-archive")
          ) return "app-shared";
          // 导出弹窗独立按需分类；实验报告并入 teaching-ui：与对照/学习面板共享
          // 「只读/报告/导出 JSON」等文案的 gzip 字典，且该 chunk 本就有空闲预取，
          // 报告点击通常零额外下载。Worker 不引用这些 UI/报告模块。
          if (
            id.includes("/src/ui/export-dialog") ||
            id.includes("/src/core/csv-export")
          ) return "tools-ui";
          if (
            id.includes("/src/ui/report-panel") ||
            id.includes("/src/ui/report-panel-ui") ||
            id.includes("/src/core/experiment-report")
          ) return "teaching-ui";
          // 纯数值内核：主包、Worker、按需教学 UI 三方共享同一份。
          // 不这么分时，Rollup 会把 experiment-config/scenarios 等塞进教学 chunk，
          // 结果 comparison Worker 反向 import 整个教学 UI，且三方各自重复一份字节。
          const pureCore = [
            "/src/core/quat",
            "/src/core/imu",
            "/src/core/world",
            "/src/core/scenarios",
            "/src/core/solve-loop",
            "/src/core/stats",
            "/src/core/rng",
            "/src/core/magcal",
            "/src/core/accelcal",
            "/src/core/calibration-validation",
            "/src/core/experiment-config",
            "/src/core/run-constants",
            "/src/core/tuning",
            "/src/core/comparison-config",
            "/src/core/trace-events",
            "/src/core/ins",
            "/src/core/truth-track",
            "/src/core/sensor-pipeline",
            "/src/core/serial",
            "/src/core/serial-queue",
            "/src/core/reconnect",
            "/src/core/transport-session",
            "/src/core/replay",
            "/src/core/replay-player",
            "/src/core/data-source",
            "/src/core/batch-protocol",
            "/src/core/calib-meta",
            "/src/core/calib-verify",
            "/src/core/allan",
            "/src/core/coning",
            "/src/core/attitude-determination",
            "/src/core/gimbal",
          ];
          if (id.includes("/src/estimators/") || pureCore.some((frag) => id.includes(frag))) return "worker-core";
          // 教学交互的按需 UI 合并成一个 chunk：它们互不常驻首屏，但共享大量
          // 中文文案与状态标签；分开 gzip 会重复字典。report 已与 runner 解耦
          // （只依赖类型与共享常量），可以安全并入；Worker 用的 comparison-config
          // 仍保持独立，避免把 UI 拖进 Worker。
          if (
            id.includes("/src/ui/telemetry-diagnostics") ||
            id.includes("/src/ui/observability-panel") ||
            id.includes("/src/ui/event-panel") ||
            id.includes("/src/ui/review-panel") ||
            id.includes("/src/ui/eskf-panel") ||
            id.includes("/src/core/event-recorder") ||
            id.includes("/src/core/event-timeline") ||
            id.includes("/src/core/observability") ||
            id.includes("/src/core/review-buffer")
          ) return "diagnostics-ui";
          if (id.includes("/src/core/runner-ui") || id.includes("/src/ui/runner-loader")) return "runner";
          if (id.includes("/src/ui/doc-demos") || id.includes("/src/ui/tour")) return "teaching-ui";
          if (id.includes("/src/ui/claim-links")) return "teaching-ui";
          if (
            id.includes("/src/ui/comparison-panel") ||
            id.includes("/src/ui/comparison-view") ||
            id.includes("/src/ui/task-strip") ||
            id.includes("/src/core/comparison-report") ||
            id.includes("/src/core/comparison-metrics")
          ) return "teaching-ui";
          if (
            id.includes("/src/ui/learning-panel") ||
            id.includes("/src/ui/learning-activities") ||
            id.includes("/src/ui/activity-state") ||
            id.includes("/src/ui/learning-activity-data") ||
            id.includes("/src/core/comparison-report") ||
            id.includes("/src/ui/telemetry-diagnostics") ||
            id.includes("/src/ui/observability-panel") ||
            id.includes("/src/ui/event-panel") ||
            id.includes("/src/ui/review-panel") ||
            id.includes("/src/ui/eskf-panel") ||
            id.includes("/src/core/event-recorder") ||
            id.includes("/src/core/event-timeline") ||
            id.includes("/src/core/observability") ||
            id.includes("/src/core/review-buffer")
          ) return "teaching-ui";
          return undefined;
        },
      },
    },
  },
});
