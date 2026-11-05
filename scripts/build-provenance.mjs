/**
 * 构建溯源（SW-06）：产物必须能证明"我是由这份源码构建出来的"。
 *
 * 为什么需要它：`sourceDigest`（源码摘要）与 `distHash`（产物摘要）并列记录，**并不能**证明
 * 后者由前者构建——"改了源码忘记重建、拿旧 dist 跑测试、给报告贴新源码摘要"这种组合
 * 在旧实现里完全可以通过所有检查（复核 SW-06）。
 * 现在构建结束时写出 `dist/build-provenance.json`，把源码摘要、工具版本与产物摘要绑在一起；
 * 采集脚本读到它就能声明"我测的就是这个 build id"。
 *
 * `distHash` **只有一个算法**（本文件）：相对路径（统一 `/`）+ NUL + 文件内容，按路径排序；
 * 并排除 `build-provenance.json` 自己（否则写溯源会改自己的哈希，形成自引用）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceDigest, worktreeState } from "./source-digest.mjs";

export const PROVENANCE_FILE = "build-provenance.json";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** 产物摘要（16 位十六进制）。distDir 不存在时返回 null。 */
export function distHashOf(distDir) {
  if (!existsSync(distDir)) return null;
  const h = createHash("sha256");
  for (const f of walk(distDir)) {
    const rel = f.slice(distDir.length + 1).split("\\").join("/");
    if (rel.endsWith(PROVENANCE_FILE)) continue;
    h.update(rel);
    h.update("\0");
    try { h.update(readFileSync(f)); } catch { h.update("<unreadable>"); }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** 写 dist/build-provenance.json（由 vite 插件在 writeBundle 阶段调用）。 */
export function writeProvenance(root, distDir, extra = {}) {
  const source = sourceDigest(root);
  const payload = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    buildId: `${source.digest.slice(0, 12)}-${distHashOf(distDir) ?? "nodist"}`,
    sourceDigest: source.digest,
    sourceFiles: source.files,
    commit: (() => {
      try {
        return process.env.GITHUB_SHA?.slice(0, 12) || null;
      } catch { return null; }
    })(),
    worktree: worktreeState(root),
    distHash: distHashOf(distDir),
    node: process.version,
    ...extra,
  };
  writeFileSync(join(distDir, PROVENANCE_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/** 读 dist/build-provenance.json（不存在或损坏返回 null，调用方按"未溯源"处理）。 */
export function readProvenance(distDir) {
  const p = join(distDir, PROVENANCE_FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
