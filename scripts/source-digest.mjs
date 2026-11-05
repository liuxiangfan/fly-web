/**
 * 源码摘要：把「这次证据对应哪一份源码」变成可复算的哈希。
 *
 * 为什么不用 commit SHA 一个字段就够了：复核现场经常是**未提交的工作树**
 * （改了、还没提交，但确实跑了 600 s 长稳）。此时 `git rev-parse HEAD` 会指向
 * 上一版代码——拿它当溯源等于让证据撒谎。这里对
 * 「git 跟踪的 + 未忽略的未跟踪文件」的**路径与内容**一起做 sha256，
 * 于是未提交的现状也有确定摘要，而文档/证据文件本身（在 docs/、screenshots/ 之外的忽略项）
 * 不会因为「重跑一次长稳」就改变摘要。
 *
 * 排除项（见下）：不需要参与摘要的产物与本地目录：dist、.audit-* 本地审计目录、
 * screenshots 截图、node_modules 依赖。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 参与**构建**的路径白名单：摘要要回答的是「这份长稳/视觉证据对应哪一套**产品**代码」。
 *
 *  · 在：src/、public/、入口 index.html（内联着应用内文档，改它就是改产品）、构建配置与依赖锁。
 *  · 不在：docs/ 与 README（文档正文，不该让 600 s 的结论失效），
 *    以及 **scripts/**——那是量具，不是被测对象。量具自身的正确性由它自己的契约测试、
 *    `statuscheck` 的计数校验与 `budget-contract` 守住；把量具算进摘要，会让
 *    「修一个 flaky 断言」这种纯量具改动也要求重跑二十分钟长稳，反而逼人不敢改量具（实测三次）。
 */
const INCLUDE = /^(src\/|public\/|index\.html$|package(-lock)?\.json$|tsconfig\.json$|vite\.config\.ts$|wrangler\.jsonc$)/;

export function sourceFiles(root) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return out.split("\0").filter(Boolean).filter((f) => INCLUDE.test(f)).sort();
}

/** 返回 { digest, files }：digest 覆盖每个文件的路径与内容。 */
export function sourceDigest(root) {
  const files = sourceFiles(root);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    try {
      h.update(readFileSync(join(root, f)));
    } catch {
      h.update("<unreadable>");
    }
    h.update("\0");
  }
  return { digest: h.digest("hex").slice(0, 32), files: files.length };
}

/** 工作树是否有未提交改动（null = 不是 git 工作树）。 */
export function worktreeState(root) {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return porcelain.trim().length > 0 ? "dirty" : "clean";
  } catch {
    return null;
  }
}
