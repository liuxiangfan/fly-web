/** 本项目测试临时现场的统一归属；不改全局 TEMP，不共享浏览器 profile。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_TEST_ARTIFACT_ROOT = process.platform === "win32"
  ? "D:/test-artifacts/quaternion-attitude"
  : tmpdir();
export const DEFAULT_TEST_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 只有这些是「可再生、任务结束即可删」的临时现场；归档/报告/真机授权永不在自动清理内。 */
const TRANSIENT_KINDS = new Set([
  "smoke", "soak", "evidence-contract", "build-probes", "perf", "visual",
  "postdeploy", "screenshots", "ci-downloads", "contracts",
]);
let pruneAttempted = false;
const artifactRootBase = () => resolve(process.env.QUAT_TEST_ARTIFACT_ROOT ?? DEFAULT_TEST_ARTIFACT_ROOT);

export function testArtifactRoot(kind) {
  if (!pruneAttempted) {
    pruneAttempted = true;
    const configured = Number(process.env.QUAT_TEST_ARTIFACT_MAX_AGE_MS ?? DEFAULT_TEST_ARTIFACT_MAX_AGE_MS);
    const maxAgeMs = Number.isFinite(configured) ? configured : DEFAULT_TEST_ARTIFACT_MAX_AGE_MS;
    // <=0 显式关闭自动清理；自动清理失败只影响磁盘，不影响测试结论。
    if (maxAgeMs > 0) {
      try { pruneTestArtifacts({ maxAgeMs }); } catch { /* 下轮再清 */ }
    }
  }
  const root = resolve(artifactRootBase(), kind);
  mkdirSync(root, { recursive: true });
  return root;
}

/** 每次任务独立目录，禁止两个浏览器或并行分片共用 profile。 */
export function testArtifactTempDir(kind, prefix) {
  return mkdtempSync(join(testArtifactRoot(kind), prefix));
}

/**
 * 删除仍被**本次测试启动的浏览器**占用的目录。
 *
 * 为什么必须按目录杀进程：候选浏览器启动失败时 Puppeteer 会抛错，但它拉起的
 * msedge/chrome 进程可能还活着（实测 Edge 启动失败后仍留下整棵进程树），
 * 于是 profile 里的 crashpad/journal 文件被锁，rmSync 永远 EPERM。
 * 只杀命令行里带着这个唯一 profile 路径的进程，不碰用户浏览器。
 */
function browserProcessesQuery(dir) {
  const quoted = dir.replace(/\//g, "\\").replace(/'/g, "''");
  // 只匹配浏览器进程，且排除当前 PowerShell 自己（它的命令行也包含 $d，误杀会中断整条清理）。
  return `$d='${quoted}'; $self=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.Name -in @('msedge.exe','chrome.exe','crashpad_handler.exe') -and $_.CommandLine -and $_.CommandLine.Contains($d) }`;
}

function killProcessesUsing(dir) {
  if (process.platform !== "win32") return;
  const script = `${browserProcessesQuery(dir)} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", timeout: 20000 });
  } catch {
    /* 进程可能已退出；继续尝试删除 */
  }
}

/** 自动清理只跳过活跃目录，绝不借「清理旧文件」杀掉仍在跑的任务；查询失败也按占用处理。 */
function artifactInUse(dir) {
  if (process.platform !== "win32") return false;
  const script = `@(${browserProcessesQuery(dir)} | Select-Object -First 1).Count`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10000 });
    return Number(out.trim()) > 0;
  } catch {
    return true;
  }
}

/** 同步等待：cleanup 是同步收尾，不能靠 await；Windows 释放文件句柄需要一点时间。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 收尾是**尽力而为**：Windows 上刚关闭的浏览器仍可能锁住 crashpad 文件。 */
export function cleanupArtifactDir(dir) {
  if (!existsSync(dir)) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (process.platform === "win32") {
      // 失败候选的浏览器可能比异常晚一步出现，并且会**重新创建**已删除的 profile；
      // 所以每次删之前都先按目录杀一遍，等它落定再删。
      killProcessesUsing(dir);
      sleepSync(600);
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch {
      /* 下一轮先杀进程再删 */
    }
  }
  console.warn(`[warn] 测试目录清理失败（可下次启动前人工删除）：${dir}`);
  return false;
}

/**
 * 清理异常退出留下的**过期单任务目录**。正常收尾仍由 cleanupArtifactDir 负责。
 *
 * 边界（由契约测试锁定）：
 *   · 只看测试根 / 白名单 kind / 单任务目录这三层，绝不递归到根外；
 *   · `_migrated-c-temp`、`_ops`、`hw-soak` 等不在白名单，永不自动删；
 *   · 新目录与仍在被浏览器使用的目录跳过；占用查询失败同样跳过。
 */
export function pruneTestArtifacts({
  root = artifactRootBase(),
  maxAgeMs = DEFAULT_TEST_ARTIFACT_MAX_AGE_MS,
  now = Date.now(),
  isInUse = artifactInUse,
} = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("maxAgeMs 必须是非负有限数");
  const summary = { deleted: [], skippedRecent: [], skippedInUse: [], skippedRetained: [], failed: [] };
  if (!existsSync(root)) return summary;
  for (const kind of readdirSync(root, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    const kindDir = join(root, kind.name);
    if (!TRANSIENT_KINDS.has(kind.name)) {
      summary.skippedRetained.push(kindDir);
      continue;
    }
    for (const task of readdirSync(kindDir, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      const dir = join(kindDir, task.name);
      try {
        if (now - statSync(dir).mtimeMs < maxAgeMs) {
          summary.skippedRecent.push(dir);
          continue;
        }
        let inUse = true;
        try { inUse = isInUse(dir); } catch { inUse = true; }
        if (inUse) {
          summary.skippedInUse.push(dir);
          continue;
        }
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        summary.deleted.push(dir);
      } catch (error) {
        summary.failed.push({ dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return summary;
}
