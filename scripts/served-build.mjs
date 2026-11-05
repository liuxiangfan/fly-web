/**
 * 「被服务的产物是不是本地产物」这一条链（SW-06）——长稳/稳定性/视觉三类采集共用。
 *
 * 旧实现只能回答「我本地 dist 的哈希是多少」和「页面报的提交号是多少」，两者拼不到一起：
 *   ① 提交号相同的两份产物（改了源码没提交、或改了 dist 没改源码）无法区分；
 *   ② 采集过程中重建了 dist，报告照样给旧结果贴新摘要。
 * 这里给出两个纯函数 + 一个取回函数，把这两条都变成明确判定：
 *   · `fetchServedProvenance`  从被测地址取回产物自报的 buildId；
 *   · `identityProblems`       服务端产物身份 vs 本地溯源 vs 页面页脚三方对齐；
 *   · `captureDriftProblems`   采集结束时重算源码/产物摘要，变了就整次验收作废（不贴新摘要）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { distHashOf } from "./build-provenance.mjs";
import { sourceDigest } from "./source-digest.mjs";

const short = (v, n = 18) => String(v ?? "（缺失）").slice(0, n);

/** 从被测地址取回 `build-provenance.json`（不存在/不合法返回 { ok:false, error }，不抛）。 */
export async function fetchServedProvenance(url, timeoutMs = 5000) {
  let href;
  try {
    href = new URL("build-provenance.json", url).href;
  } catch (err) {
    return { ok: false, error: `地址不可解析：${err.message}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(href, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}（${href}）` };
    const body = await res.json();
    if (!body || typeof body !== "object" || typeof body.buildId !== "string" || !body.buildId) {
      return { ok: false, error: `溯源文件缺少 buildId（${href}）` };
    }
    return { ok: true, href, provenance: body };
  } catch (err) {
    return { ok: false, error: `${err.name === "AbortError" ? `${timeoutMs} ms 超时` : err.message}（${href}）` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 三方对齐：本地 `dist/build-provenance.json`、被测服务自报的溯源、页面页脚。
 * 返回问题清单（空数组 = 三方一致）。`pageBuild` 是页面 `attitudeDemo.build()` 的返回值。
 */
export function identityProblems({ localProvenance, served, pageBuild, distDir }) {
  const problems = [];
  if (!localProvenance) {
    problems.push("本地缺少 dist/build-provenance.json（先 npm run build）");
    return problems;
  }
  // 本地溯源与当前 dist 必须自洽：溯源写完又被改动过，说明有人重建过产物
  const localDist = distHashOf(distDir);
  if (localProvenance.distHash !== localDist) {
    problems.push(`本地产物与溯源不一致（溯源 ${short(localProvenance.distHash)} / 实测 ${short(localDist)}）——请重新构建后再采集`);
  }
  if (!served.ok) {
    problems.push(`取不到被测服务的构建溯源：${served.error}`);
    return problems;
  }
  if (served.provenance.buildId !== localProvenance.buildId) {
    problems.push(`被测服务跑的不是本地产物（服务端 ${short(served.provenance.buildId)} / 本地 ${short(localProvenance.buildId)}）`);
  }
  if (pageBuild && typeof pageBuild === "object") {
    const pageBuildId = pageBuild.buildId ?? null;
    if (!pageBuildId) problems.push("页面没报出产物 buildId（页面未加载 build-provenance.json）");
    else if (pageBuildId !== localProvenance.buildId) {
      problems.push(`页面自报 buildId 与服务端溯源不一致（页面 ${short(pageBuildId)} / 本地 ${short(localProvenance.buildId)}）`);
    }
    const pageCommit = String(pageBuild.commit ?? "").toLowerCase();
    const commit = String(localProvenance.commit ?? "").toLowerCase();
    if (commit && pageCommit && !sameCommit(pageCommit, commit)) {
      problems.push(`页面页脚提交号与产物溯源不一致（页面 ${short(pageCommit, 12)} / 溯源 ${short(commit, 12)}）`);
    }
  }
  return problems;
}

/**
 * 两个提交标识是否指向同一个提交（**双向**前缀比较）。
 *
 * 为什么必须有这条：页面页脚/`attitudeDemo.build()` 里的 commit 是 `GITHUB_SHA.slice(0, 12)`，
 * 而部署 workflow 传的是完整 40 位 SHA。旧实现写的是 `commit.startsWith(expect)`——
 * 12 位永远不可能以 40 位开头，于是**每次部署后 smoke 都判失败**（线上其实完全正常）。
 * 规则：两边都必须是 ≥7 位的十六进制，且一方是另一方的前缀。
 */
export function sameCommit(a, b) {
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const x = norm(a), y = norm(b);
  if (!/^[0-9a-f]{7,40}$/.test(x) || !/^[0-9a-f]{7,40}$/.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** 采集开始时记下的身份快照；结束时重算，变了就把整次验收作废。 */
export function captureIdentity(root, distDir = join(root, "dist")) {
  return { sourceDigest: sourceDigest(root).digest, distHash: distHashOf(distDir) };
}

export function captureDriftProblems(root, before, distDir = join(root, "dist")) {
  const problems = [];
  const now = sourceDigest(root).digest;
  if (now !== before.sourceDigest) {
    problems.push(`采集期间源码发生了变化（开始 ${short(before.sourceDigest, 32)} / 结束 ${short(now, 32)}）——本次结果作废，请在源码冻结后重跑`);
  }
  const distNow = distHashOf(distDir);
  if (distNow !== before.distHash) {
    problems.push(`采集期间产物被重建（开始 ${short(before.distHash)} / 结束 ${short(distNow)}）——本次结果作废`);
  }
  if (!existsSync(join(distDir, "build-provenance.json"))) problems.push("结束时 dist/build-provenance.json 已不存在");
  else {
    try {
      const p = JSON.parse(readFileSync(join(distDir, "build-provenance.json"), "utf8"));
      if (p.distHash !== before.distHash) problems.push("产物溯源文件与开始时记下的产物摘要不一致（中途重建过）");
    } catch { problems.push("结束时 dist/build-provenance.json 无法解析"); }
  }
  return problems;
}
