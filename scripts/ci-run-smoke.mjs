/**
 * CI 用的冒烟驱动器：起 preview → 等它就绪 → 连跑 N 次冒烟 → 收尾。
 *
 * 为什么要有这个文件（而不是在 workflow 里写 shell）：
 *  · Windows 与 Ubuntu 的 shell 语法不同（`&` / `Start-Process` / curl 有无），
 *    CI 里最不该出现的就是「同一段验证在两个 runner 上行为不同」；
 *  · 「连续 N 次全绿、零 warning、零重启」这条验收要求**逐次**留证：每次的输出单独落盘，
 *    并在结尾汇总，任何一次失败都让整步失败（不能只看最后一次）。
 *
 * 用法：
 *   node scripts/ci-run-smoke.mjs --runs=5 [--shard=app|devices|all] [--out=dir] [--port=4173]
 *
 * 退出码：0 = N 次全绿；1 = 有失败；2 = 参数/环境错误（起不来 preview 等）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const runs = Number(arg.runs ?? 1);
const shard = String(arg.shard ?? "all").toLowerCase();
const port = Number(arg.port ?? 4173);
const outDir = resolve(root, arg.out ?? ".audit-smoke/ci");
if (!Number.isSafeInteger(runs) || runs < 1) { console.error("[FAIL] --runs 必须是正整数"); process.exit(2); }
if (!["all", "app", "devices"].includes(shard)) { console.error("[FAIL] --shard 只支持 all / app / devices"); process.exit(2); }
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("[FAIL] 找不到 dist/index.html——先 npm run build 再跑本脚本");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const url = `http://127.0.0.1:${port}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 起 preview。直接用 node 跑 vite 的 bin（不经 shell）：
 *  · Windows 上 `spawn("npx", …, {shell:true})` 会触发 DEP0190（参数未转义），
 *    而显式走 node + bin 路径在两个系统上完全一致；
 *  · `--host 127.0.0.1` 是必须的：vite preview 默认绑 `localhost`，
 *    在部分环境里只绑到 ::1，于是 `http://127.0.0.1:<port>` 探活会一直失败（实测踩到）。
 */
function startPreview() {
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.on("data", (b) => process.stdout.write(`[preview] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[preview] ${b}`));
  return child;
}

/** 等 preview 真的能返回 200（不是「进程起来了」）。 */
async function waitForPreview(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await wait(500);
  }
  return false;
}

/** 跑一次冒烟，输出落盘，返回是否通过。 */
async function runSmokeOnce(index) {
  const logPath = join(outDir, `smoke-${shard}-run${index}.log`);
  const child = spawn(process.execPath, [join(root, "scripts", "browser-smoke.mjs")], {
    cwd: root,
    env: { ...process.env, SMOKE_URL: url, SMOKE_SHARD: shard },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let out = "";
  child.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
  child.stderr.on("data", (b) => { out += b; process.stderr.write(b); });
  const code = await new Promise((r) => child.on("close", r));
  writeFileSync(logPath, out, "utf8");
  const lines = out.split(/\r?\n/);
  const passes = lines.filter((l) => l.startsWith("[PASS]")).length;
  const fails = lines.filter((l) => l.startsWith("[FAIL]")).length;
  const warns = lines.filter((l) => l.includes("[warn]")).length;
  console.log(`[ci] run ${index}: exit=${code} · ${passes} PASS / ${fails} FAIL / ${warns} warn → ${logPath}`);
  return { index, code, passes, fails, warns, logPath };
}

const preview = startPreview();
try {
  if (!(await waitForPreview())) {
    console.error(`[FAIL] preview 在 90 s 内没有就绪（${url}）`);
    process.exit(2);
  }
  console.log(`[ci] preview 就绪：${url}；分片 SMOKE_SHARD=${shard}；计划连跑 ${runs} 次`);
  const results = [];
  for (let i = 1; i <= runs; i++) results.push(await runSmokeOnce(i));

  const bad = results.filter((r) => r.code !== 0 || r.fails > 0 || r.warns > 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    shard,
    runs,
    url,
    commit: (() => { try { return readFileSync(join(root, ".git", "HEAD"), "utf8").trim(); } catch { return null; } })(),
    results: results.map(({ index, code, passes, fails, warns }) => ({ index, code, passes, fails, warns })),
  };
  writeFileSync(join(outDir, `summary-${shard}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[ci] 汇总：${results.map((r) => `${r.passes}P/${r.fails}F/${r.warns}W`).join(" · ")}`);
  if (bad.length) {
    console.error(`[FAIL] ${bad.length}/${runs} 次没有达到「全绿且零 warning」：run ${bad.map((b) => b.index).join(", ")}`);
    process.exit(1);
  }
  console.log(`[PASS] 连续 ${runs} 次冒烟全绿（分片 ${shard}，零 warning、零重启）`);
} finally {
  try { preview.kill(); } catch { /* 已退出 */ }
  await wait(500);
}
