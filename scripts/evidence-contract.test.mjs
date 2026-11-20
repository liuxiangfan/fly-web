/**
 * 证据索引校验器的**永久反例**（SW-06）：把校验器跑在临时现场上，看它抓不抓得住作弊。
 *
 * 为什么必须这么测：索引是"对报告的声明"，只核 sha256 的实现会被下面这些组合完整骗过——
 * 报告正文 FAIL／源码换了／平台换了／产物重建了／截图错了，而索引照样能声明 PASS。
 * 这里每条用例都对应一种"看起来像真证据"的构造，只有校验器真的拒它，结论才算有依据。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { testArtifactTempDir, cleanupArtifactDir, DEFAULT_TEST_ARTIFACT_ROOT, testArtifactRoot, pruneTestArtifacts } from './test-artifacts.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from './source-digest.mjs';
import { distHashOf } from './build-provenance.mjs';
import { reserveVisualCapture } from './visual-evidence.mjs';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'evidencecheck.mjs');
const BASELINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const sha256of = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sceneRoots = [];
after(() => { for (const root of sceneRoots) cleanupArtifactDir(root); });

/** 造一个临时现场：真 git 仓库 + 产品输入 + PROJECT-STATE + dist，好让校验器整条链路都能跑。 */
function scene() {
  const root = testArtifactTempDir("evidence-contract", "evc-");
  sceneRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const write = (rel, content) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    return { rel, file: p, sha256: sha256of(p) };
  };
  write('index.html', '<!doctype html><title>夹具</title>\n');
  write('src/main.ts', 'export const v = 1;\n');
  write('docs/PROJECT-STATE.md', `# 状态\n<!-- baseline: ${BASELINE} -->\n`);
  write('dist/assets/app.js', 'console.log(1);\n');
  // 先落一个提交：临时现场也应当是"有历史"的仓库（否则 HEAD 无意义、supersedes 的 git 引用无从核对）
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: root });
  const digest = sourceDigest(root).digest;
  const distHash = distHashOf(join(root, 'dist'));
  const buildId = `${digest.slice(0, 12)}-${distHash}`;
  /** 按需写出索引：`entries` 已经拿到各自文件的 sha256 后再落盘。 */
  const commit = (entries) => write('docs/generated/evidence-manifest.json', { schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', reviewCommit: BASELINE, entries });
  const provenance = (over = {}) => write('dist/build-provenance.json', { schemaVersion: 1, builtAt: '2026-01-01T00:00:00.000Z', buildId, sourceDigest: digest, sourceFiles: sourceDigest(root).files, distHash, ...over });
  const run = (...args) => {
    try {
      const out = execFileSync(process.execPath, [CHECKER, `--root=${root}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  // digest/distHash 用 getter：夹具里改了源码或产物之后，取到的必须是**新**摘要
  // （否则"源码变了但证据没重跑"这条用例会因为取到旧摘要而假通过）
  return {
    root, write, commit, provenance, run, buildId,
    get digest() { return sourceDigest(root).digest; },
    get distHash() { return distHashOf(join(root, 'dist')); },
  };
}

/** 一份"看起来合格"的长稳报告：600 s、批量判据通过、堆判据通过、结论 PASS。 */
function soakReport(s, over = {}) {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    commit: BASELINE,
    sourceDigest: s.digest,
    sourceFiles: sourceDigest(s.root).files,
    worktree: 'dirty',
    distHash: s.distHash,
    buildId: s.buildId,
    browserVersion: 'Edg/1.0.0.0',
    seconds: 600,
    withBatch: true,
    withReconnect: false,
    verdict: {
      pass: true, batchOk: true, reconnectOk: true, heapGateOk: true, heapMeasured: true, errorsOk: true,
      // SW-08：采样覆盖 + 末段判据是长稳验收的一部分（夹具必须和真实报告同口径）
      coverageOk: true, coverageProblems: [], tailStatus: "PASS", tailSuspect: false,
      problems: [], consoleErrors: [],
    },
    tailPhase: { ran: false, seconds: 0, samples: 0, settledMb: null, baseFloorMb: null, fellBack: null, note: "未触发（末段水位不可疑）" },
    servedProblems: [],
    driftProblems: [],
    samples: [],
    ...over,
  };
}

/** 一份"看起来合格"的五轮稳定性摘要：两个分片、每轮零失败零 warning。 */
function stabilityReport(s, over = {}) {
  const results = [1, 2, 3, 4, 5].map((index) => ({ index, code: 0, passes: 96, fails: 0, warns: 0 }));
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    shard: 'both',
    runs: 5,
    commit: BASELINE,
    sourceDigest: s.digest,
    distHash: s.distHash,
    buildId: s.buildId,
    browserVersion: 'Edg/1.0.0.0',
    runnerOs: 'win32 x64',
    results,
    verdict: 'pass',
    ...over,
  };
}

/** 索引条目：只保留该 kind 该有的溯源字段，避免"缺字段"掩盖真正要判的那一条。 */
function entry(s, kind, file, over = {}) {
  const base = {
    id: `e-${kind}`, kind, path: file.rel, sha256: file.sha256, result: 'PASS',
    provenanceComplete: true, localOnly: false, current: true, supersedes: [],
    notes: '夹具条目：用于校验器反例，不代表任何真实验收。',
  };
  if (/^software-soak/.test(kind)) Object.assign(base, { sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0' });
  if (kind === 'software-smoke-stability') Object.assign(base, { sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0', runnerOs: 'win32 x64', runs: 5 });
  if (kind === 'visual-screenshot') Object.assign(base, { sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0' });
  return { ...base, ...over };
}

const keyLine = (out, needle) => out.split(/\r?\n/).find((l) => l.includes(needle)) ?? '';

test('合格现场：报告正文与索引一致时通过，且通过的是默认模式', () => {
  const s = scene();
  const f = s.write('docs/generated/soak-batch-600-x.json', soakReport(s));
  s.commit([entry(s, 'software-soak-batch', f)]);
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('证据索引校验通过'), r.out);
});

test('manifest 写 PASS 而报告正文是 FAIL：必须拒，并且说清是谁在撒谎', () => {
  const s = scene();
  const f = s.write('docs/generated/stability-x.json', stabilityReport(s, { verdict: 'fail', results: [{ index: 1, code: 1, passes: 90, fails: 6, warns: 0 }, ...stabilityReport(s).results.slice(1)] }));
  s.commit([entry(s, 'software-smoke-stability', f, { result: 'PASS' })]);
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(keyLine(r.out, '报告正文结论是 FAIL'), r.out);
  assert.ok(!r.out.includes('证据索引校验通过'), '坏报告绝不能走到"校验通过"');
});

test('报告自己写的结论与逐轮原始数据不符：判定不可自证，必须拒', () => {
  const s = scene();
  const f = s.write('docs/generated/stability-x.json', stabilityReport(s, { verdict: 'pass', results: [{ index: 1, code: 0, passes: 96, fails: 3, warns: 0 }, ...stabilityReport(s).results.slice(1)] }));
  s.commit([entry(s, 'software-smoke-stability', f, { result: 'PASS' })]);
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(keyLine(r.out, '复算是 FAIL'), r.out);
});

test('只伪造索引 metadata（哈希不动）：源码摘要、平台、浏览器、产物摘要、轮次逐项都要被抓住', () => {
  const s = scene();
  const soak = s.write('docs/generated/soak-batch-600-x.json', soakReport(s));
  for (const [field, bad, needle] of [
    ['sourceDigest', 'deadbeefdeadbeefdeadbeefdeadbeef', 'sourceDigest 与报告不一致'],
    ['distHash', 'ffffffffffffffff', 'distHash 与报告不一致'],
    ['browserVersion', 'Edg/9.9.9.9', 'browserVersion 与报告不一致'],
    ['sourceCommit', 'f'.repeat(40), 'sourceCommit 与报告不一致'],
    ['buildId', 'fake-build-id', 'buildId 与报告不一致'],
  ]) {
    s.commit([entry(s, 'software-soak-batch', soak, { [field]: bad })]);
    const r = s.run();
    assert.equal(r.code, 1, `${field} 不一致却通过了：${r.out}`);
    assert.ok(keyLine(r.out, needle), `${field} 没有报出字段名：${r.out}`);
  }
  // 平台与轮次只有稳定性摘要会写：同样必须逐项对上
  const stability = s.write('docs/generated/stability-x.json', stabilityReport(s));
  for (const [field, bad, needle] of [
    ['runnerOs', 'linux', 'runnerOs 与报告不一致'],
    ['runs', 3, 'runs 与报告不一致'],
    ['browserVersion', 'Edg/9.9.9.9', 'browserVersion 与报告不一致'],
  ]) {
    s.commit([entry(s, 'software-smoke-stability', stability, { [field]: bad })]);
    const r = s.run();
    assert.equal(r.code, 1, `${field} 不一致却通过了：${r.out}`);
    assert.ok(keyLine(r.out, needle), `${field} 没有报出字段名：${r.out}`);
  }
  // 索引漏写报告里有的字段，却又声称 provenanceComplete：同样要拒（"只贴一半"不算溯源完整）
  const { browserVersion, ...withoutBrowser } = entry(s, 'software-soak-batch', soak);
  s.commit([withoutBrowser]);
  const r = s.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(keyLine(r.out, 'browserVersion'), r.out);
});

test('结构层：空 entries、重复 current、断裂 supersedes 都要给出明确失败', () => {
  const s = scene();
  const f = s.write('docs/generated/soak-batch-600-x.json', soakReport(s));
  s.commit([]);
  assert.equal(s.run().code, 1);
  assert.ok(s.run().out.includes('空'), s.run().out);

  s.commit([entry(s, 'software-soak-batch', f), entry(s, 'software-soak-batch', f, { id: 'e-dup' })]);
  const dup = s.run();
  assert.equal(dup.code, 1, dup.out);
  assert.ok(dup.out.includes('条 current'), dup.out);

  s.commit([entry(s, 'software-soak-batch', f, { supersedes: ['nosuchid'] })]);
  const broken = s.run();
  assert.equal(broken.code, 1, broken.out);
  assert.ok(broken.out.includes('不存在的 id'), broken.out);

  // git:<path>@<sha> 必须真实存在（历史引用不能凭想象写）
  s.commit([entry(s, 'software-soak-batch', f, { supersedes: ['git:docs/generated/nope.json@a1b2c3d'] })]);
  const ghost = s.run();
  assert.equal(ghost.code, 1, ghost.out);
  // 夹具仓库里没有这个提交 → 报"无法核对（多为浅克隆）"并要求 fetch-depth: 0
  assert.ok(ghost.out.includes('fetch-depth'), ghost.out);

  // 提交存在、但该提交里没有这个文件 → 才是"历史引用造假"
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.root, encoding: 'utf8' }).trim();
  s.commit([entry(s, 'software-soak-batch', f, { supersedes: [`git:docs/generated/nope.json@${head}`] })]);
  const missingPath = s.run();
  assert.equal(missingPath.code, 1, missingPath.out);
  assert.ok(missingPath.out.includes('在该提交里找不到'), missingPath.out);
});

test('视觉证据：像素哈希错、current 缺图都必须拒；历史条目缺图只提示', () => {
  const s = scene();
  const png = s.write('screenshots/x/desktop.png', 'not-a-real-png-but-fixed-bytes\n');
  const shots = [{ name: 'desktop', file: png.rel, note: '桌面', viewport: { width: 1440, height: 900 }, sha256: png.sha256, bytes: 31 }];
  const good = s.write('docs/generated/visual-x.json', { pass: true, sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0', shots, consoleErrors: [] });
  s.commit([entry(s, 'visual-screenshot', good, { localOnly: true })]);
  assert.equal(s.run().code, 0, s.run().out);

  const wrong = s.write('docs/generated/visual-x.json', { pass: true, sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0', shots: [{ ...shots[0], sha256: '0'.repeat(64) }], consoleErrors: [] });
  s.commit([entry(s, 'visual-screenshot', wrong, { localOnly: true })]);
  const bad = s.run();
  assert.equal(bad.code, 1, bad.out);
  assert.ok(keyLine(bad.out, '像素哈希与报告不符'), bad.out);

  // 缺图分两档：localOnly（图本来就不随仓库走）记 note；非 localOnly（声称可分发）必须判失败。
  const absent = s.write('docs/generated/visual-y.json', { pass: true, sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId, browserVersion: 'Edg/1.0.0.0', shots: [{ ...shots[0], file: 'screenshots/never/desktop.png' }], consoleErrors: [] });
  s.commit([entry(s, 'visual-screenshot', absent, { localOnly: true })]);
  const localOnly = s.run();
  assert.equal(localOnly.code, 0, `localOnly 缺图不应判红：${localOnly.out}`);
  assert.ok(keyLine(localOnly.out, '仅核了条目与哈希声明'), localOnly.out);

  s.commit([entry(s, 'visual-screenshot', absent)]);
  const gone = s.run();
  assert.equal(gone.code, 1, gone.out);
  assert.ok(keyLine(gone.out, '不存在'), gone.out);

  s.commit([entry(s, 'visual-screenshot', absent, { current: false, localOnly: true })]);
  const historical = s.run();
  assert.equal(historical.code, 0, historical.out);
  assert.ok(keyLine(historical.out, '[note]'), historical.out);
});

test('--require-source：改写源码后拿着旧摘要的"current"证据必须失效，只有真摘要才放行', () => {
  const s = scene();
  const f = s.write('docs/generated/soak-batch-600-x.json', soakReport(s));
  s.commit([entry(s, 'software-soak-batch', f, { sourceDigest: '0'.repeat(32) })]);
  const stale = s.run('--require-source');
  assert.equal(stale.code, 1, stale.out);
  assert.ok(keyLine(stale.out, '源码已变'), stale.out);

  // 真·改了源码（不动报告）：报告里的摘要就成了旧源码的，同样必须失效
  s.write('src/main.ts', 'export const v = 2;\n');
  const f2 = s.write('docs/generated/soak-batch-600-y.json', soakReport(s, { sourceDigest: '0'.repeat(32) }));
  s.commit([entry(s, 'software-soak-batch', f2, { sourceDigest: '0'.repeat(32) })]);
  assert.equal(s.run('--require-source').code, 1, '源码变了但证据没重跑，不能算验收');

  // 重跑后摘要一致 → 放行
  const fresh = s.write('docs/generated/soak-batch-600-z.json', soakReport(s));
  s.commit([entry(s, 'software-soak-batch', fresh)]);
  const ok = s.run('--require-source');
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.out.includes('--require-source：1 条'), ok.out);
});

test('--require-build：产物重建、buildId 不匹配、缺溯源文件都必须失效', () => {
  const s = scene();
  s.provenance();
  const f = s.write('docs/generated/soak-batch-600-x.json', soakReport(s));
  s.commit([entry(s, 'software-soak-batch', f)]);
  assert.equal(s.run('--require-build').code, 0, s.run('--require-build').out);

  // 报告采集中途 dist 被重建：provenance 里记的产物摘要与现在这份不符
  s.provenance({ distHash: 'ffffffffffffffff' });
  const rebuilt = s.run('--require-build');
  assert.equal(rebuilt.code, 1, rebuilt.out);
  assert.ok(keyLine(rebuilt.out, 'dist 已被重建'), rebuilt.out);

  // 产物换了但报告没重跑：buildId 与溯源不一致
  s.provenance();
  s.commit([entry(s, 'software-soak-batch', f, { buildId: 'stale-build-id' })]);
  const stale = s.run('--require-build');
  assert.equal(stale.code, 1, stale.out);
  assert.ok(keyLine(stale.out, '≠ 当前产物'), stale.out);

  // 没有 build-provenance.json：不能说"测的就是当前产物"
  const s2 = scene();
  const f2 = s2.write('docs/generated/soak-batch-600-w.json', soakReport(s2));
  s2.commit([entry(s2, 'software-soak-batch', f2)]);
  const missing = s2.run('--require-build');
  assert.equal(missing.code, 1, missing.out);
  assert.ok(keyLine(missing.out, 'build-provenance.json'), missing.out);
});

test('默认模式与严格模式证明范围不同：默认只核索引与正文，严格才绑定当前源码与产物', () => {
  const s = scene();
  const f = s.write('docs/generated/soak-batch-600-x.json', soakReport(s, { sourceDigest: '0'.repeat(32) }));
  s.commit([entry(s, 'software-soak-batch', f, { sourceDigest: '0'.repeat(32) })]);
  const loose = s.run();
  assert.equal(loose.code, 0, '默认模式不管"是不是当前源码"，只管索引与正文自洽');
  assert.ok(!loose.out.includes('--require-source'), loose.out);
  assert.equal(s.run('--require-source').code, 1, '严格模式才要求绑定当前源码');
});

test('教学 v2 登记：旧假换源不许 current；真实三阶段通过，active/sourceKind/runId/idx/数量失配均拒', () => {
  const s = scene();
  const phases = {
    imported: 'ok: 10 frames', error: null,
    before: { active: false, sourceKind: 'simulation', runId: 1, idx: 0, reviewActive: false },
    during: { active: true, sourceKind: 'replay', runId: 2, idx: 1, reviewActive: false },
    after: { active: false, sourceKind: 'simulation', runId: 3, idx: 0, reviewActive: false },
  };
  const base = soakReport(s, { withBatch: false, withTeaching: true, loadSchema: 'teaching-load/v2',
    sourceTransitions: [phases], samples: [{ at: 0 }, { at: 600000 }] });
  base.verdict = { ...base.verdict, teachingOk: true, clockAdvanced: true, stopQuiesced: true, sourceSwitches: 1, actionErrors: 0 };
  const file = s.write('docs/generated/teaching.json', base);
  const e = entry(s, 'software-soak-teaching', file);
  s.commit([e]);
  assert.equal(s.run().code, 0, s.run().out);
  const registrar = join(dirname(CHECKER), 'register-local-evidence.mjs');
  const register = () => {
    try { execFileSync(process.execPath, [registrar, `--root=${s.root}`, `--soak-teaching=${file.rel}`], { stdio: 'pipe' }); return 0; }
    catch (err) { return err.status; }
  };
  assert.equal(register(), 0, '合格 v2 可登记');
  const candidates = [
    { ...base, loadSchema: undefined, sourceTransitions: undefined, verdict: { ...base.verdict, sourceSwitches: 11 } },
    ...[['active', false], ['sourceKind', 'simulation'], ['runId', 1], ['idx', 0]].map(([field, value]) => ({ ...base, sourceTransitions: [{ ...phases, during: { ...phases.during, [field]: value } }] })),
    { ...base, verdict: { ...base.verdict, sourceSwitches: 11 } },
    { ...base, verdict: { ...base.verdict, actionErrors: 1 } },
    { ...base, samples: [{ at: 0 }, { at: 1000 }] },
  ];
  for (const raw of candidates) {
    const bad = s.write(file.rel, raw);
    s.commit([{ ...e, sha256: bad.sha256 }]);
    assert.equal(s.run().code, 1, JSON.stringify(raw.sourceTransitions));
    assert.equal(register(), 1, '量具不合格必须拒绝登记 current');
  }
});

function visualReport(s, shots, over = {}) {
  return { pass: true, sourceCommit: BASELINE, sourceDigest: s.digest, distHash: s.distHash, buildId: s.buildId,
    browserVersion: 'Edg/1.0.0.0', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    shots, consoleErrors: [], ...over };
}

test('本地视觉 current：clone 无图仅核声明；本机有图严格核，localOnly false 与 hash mismatch 都拒', () => {
  const s = scene();
  const png = s.write('screenshots/local/desktop.png', 'fixed-pixels\n');
  const shots = [{ name: 'desktop', file: png.rel, viewport: { width: 1440, height: 900 }, sha256: png.sha256 }];
  const f = s.write('docs/generated/visual-local.json', visualReport(s, shots));
  const e = entry(s, 'visual-screenshot', f, { localOnly: true });
  s.provenance();
  s.commit([e]);
  assert.equal(s.run('--require-source', '--require-build').code, 0);
  s.commit([{ ...e, localOnly: false }]);
  assert.match(s.run().out, /本机有图不等于 clone/);
  s.commit([e]);
  rmSync(png.file); // 只删本测试夹具，模拟干净 clone 的 gitignored PNG。
  const clone = s.run('--require-source', '--require-build');
  assert.equal(clone.code, 0, clone.out);
  assert.match(clone.out, /仅核了条目与哈希声明/);
  s.write(png.rel, 'tampered-pixels\n');
  const mismatch = s.run();
  assert.equal(mismatch.code, 1, mismatch.out);
  assert.match(mismatch.out, /像素哈希与报告不符/);
  s.commit([entry(s, 'visual-screenshot', png, { localOnly: true })]);
  assert.equal(s.run().code, 1, 'current 不能改指 PNG 而跳过报告正文');
});

test('视觉登记：自动 localOnly、同 digest 新采集保留旧条目/报告；复用路径或坏像素拒绝', () => {
  const s = scene();
  s.commit([]);
  const registrar = join(dirname(CHECKER), 'register-local-evidence.mjs');
  const register = (rel) => {
    try { return { code: 0, out: execFileSync(process.execPath, [registrar, `--root=${s.root}`, `--visual=${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (err) { return { code: err.status, out: `${err.stdout}${err.stderr}` }; }
  };
  const a = s.write('screenshots/a/x.png', 'a');
  const shots = [{ name: 'x', file: a.rel, viewport: { width: 320, height: 568 }, sha256: a.sha256 }];
  const first = s.write('docs/generated/visual-a.json', visualReport(s, shots));
  assert.equal(register(first.rel).code, 0);
  const manifest = () => JSON.parse(readFileSync(join(s.root, 'docs/generated/evidence-manifest.json'), 'utf8'));
  const old = manifest().entries[0];
  assert.equal(old.localOnly, true);
  const second = s.write('docs/generated/visual-b.json', visualReport(s, shots, { startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z' }));
  assert.equal(register(second.rel).code, 0);
  const entries = manifest().entries;
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(entries[0].current, false);
  assert.equal(entries[0].sha256, old.sha256);
  assert.equal(entries[0].path, old.path);
  assert.equal(sha256of(first.file), old.sha256);
  assert.equal(register(first.rel).code, 0);
  assert.equal(manifest().entries[0].current, false, '再次登记旧报告不得抹掉历史/重新升 current');
  s.write(first.rel, visualReport(s, shots, { note: 'overwrite' }));
  assert.equal(register(first.rel).code, 1, '同路径新报告不能覆盖旧条目');
  const before = readFileSync(join(s.root, 'docs/generated/evidence-manifest.json'), 'utf8');
  s.write(a.rel, 'wrong');
  assert.equal(register(second.rel).code, 1, '本机像素 mismatch 必须拒绝登记');
  assert.equal(readFileSync(join(s.root, 'docs/generated/evidence-manifest.json'), 'utf8'), before);
});

test('视觉采集预留：sourceDigest/buildId/唯一 id 分目录，同 digest 重采不可覆盖旧 PNG/报告', () => {
  const s = scene();
  const source = { digest: s.digest };
  const provenance = { buildId: s.buildId };
  const aId = '00000000-0000-4000-8000-000000000001';
  const bId = '00000000-0000-4000-8000-000000000002';
  const a = reserveVisualCapture(s.root, source, provenance, { captureId: aId });
  const png = s.write(join(relative(s.root, a.outDir), 'x.png'), 'original');
  s.write(relative(s.root, a.reportPath), '{}');
  const b = reserveVisualCapture(s.root, source, provenance, { captureId: bId });
  assert.notEqual(a.outDir, b.outDir);
  assert.ok(a.outDir.includes(s.digest) && a.outDir.includes(s.buildId) && a.outDir.includes(aId));
  assert.throws(() => reserveVisualCapture(s.root, source, provenance, { captureId: aId }), /拒绝覆盖/);
  assert.throws(() => reserveVisualCapture(s.root, source, provenance, { captureId: bId, report: a.reportPath }), /拒绝覆盖/);
  assert.equal(readFileSync(png.file, 'utf8'), 'original');
});

test('历史像素覆盖：同路径、报告 hash、覆盖者、时间逐跳核验；布尔或错误关联不能放过 mismatch', () => {
  const s = scene();
  const png = s.write('screenshots/old/x.png', 'old');
  const shots = [{ name: 'x', file: png.rel, viewport: { width: 320, height: 568 }, sha256: png.sha256 }];
  const old = s.write('docs/generated/visual-old.json', visualReport(s, shots));
  const replacement = s.write(png.rel, 'new');
  const next = s.write('docs/generated/visual-next.json', visualReport(s, [{ ...shots[0], sha256: replacement.sha256 }], { startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z' }));
  const a = entry(s, 'visual-screenshot', old, { id: 'old', current: false, localOnly: true, pixelsOverwritten: true, pixelsOverwrittenBy: 'next', pixelsOverwrittenAt: '2026-01-02' });
  const b = entry(s, 'visual-screenshot', next, { id: 'next', localOnly: true });
  s.commit([a, b]);
  assert.equal(s.run().code, 0, s.run().out);
  for (const patch of [{ pixelsOverwrittenBy: 'old' }, { pixelsOverwrittenAt: '2026-01-03' }, { sha256: '0'.repeat(64) }, { current: true }]) {
    s.commit([{ ...a, ...patch }, b]);
    assert.equal(s.run().code, 1, JSON.stringify(patch));
  }
  s.commit([a, { ...b, sha256: '0'.repeat(64) }]);
  assert.equal(s.run().code, 1, '覆盖者 hash mismatch 不许放过');
  const unrelated = s.write('docs/generated/unrelated.json', visualReport(s, [{ ...shots[0], file: 'screenshots/other/x.png' }], { startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z' }));
  s.commit([a, entry(s, 'visual-screenshot', unrelated, { id: 'next', localOnly: true })]);
  assert.equal(s.run().code, 1, '覆盖者必须覆盖同一原路径');
  s.commit([a, b]);
  s.write(png.rel, 'unexplained');
  assert.equal(s.run().code, 1, '实际像素必须匹配覆盖者，不许任意篡改');
  const latestPixels = s.write(png.rel, 'latest');
  const latest = s.write('docs/generated/visual-latest.json', visualReport(s, [{ ...shots[0], sha256: latestPixels.sha256 }], { startedAt: '2026-01-03T00:00:00.000Z', finishedAt: '2026-01-03T00:01:00.000Z' }));
  const c = entry(s, 'visual-screenshot', latest, { id: 'latest', localOnly: true });
  const chain = [a, { ...b, current: false, pixelsOverwritten: true, pixelsOverwrittenBy: 'latest', pixelsOverwrittenAt: '2026-01-03' }, c];
  s.commit(chain);
  assert.equal(s.run().code, 0, '多轮覆盖须逐跳核验，不能丢掉中间历史');
  rmSync(png.file);
  assert.equal(s.run().code, 0, 'clone 无图仍能核验完整原报告覆盖链');
  s.commit([a, { ...chain[1], pixelsOverwrittenBy: 'old' }, c]);
  assert.equal(s.run().code, 1, '覆盖链循环必须拒绝');
});

test('历史报告丢失：目录/空 sha/PASS 均拒；不可恢复仅 OBSERVED，保留原路径与旧 hash', () => {
  const s = scene();
  const png = s.write('screenshots/history/x.png', 'x');
  const shots = [{ name: 'x', file: png.rel, viewport: { width: 320, height: 568 }, sha256: png.sha256 }];
  const originalPath = 'docs/generated/visual-original.json';
  const next = s.write('docs/generated/visual-next.json', visualReport(s, shots, { startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z' }));
  const b = entry(s, 'visual-screenshot', next, { id: 'next', localOnly: true, originalReportPath: originalPath });
  const a = entry(s, 'visual-screenshot', { rel: originalPath, sha256: 'a'.repeat(64) }, { id: 'lost', current: false, localOnly: true });
  s.commit([a, b]);
  assert.equal(s.run().code, 1, '丢失 JSON 不能因 localOnly 历史 PASS');
  s.commit([{ ...a, path: 'screenshots/history', sha256: '' }, b]);
  const directory = s.run();
  assert.equal(directory.code, 1, directory.out);
  assert.match(directory.out, /空 sha|目录不能/);
  const observed = { ...a, result: 'OBSERVED', provenanceComplete: false, reportUnavailable: true, recoveryStatus: 'unrecoverable', reportOverwrittenBy: 'next', reportOverwrittenAt: '2026-01-02', startedAt: null, finishedAt: null };
  s.commit([observed, b]);
  const ok = s.run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /不可复核.*不能计作 PASS/);
  for (const patch of [{ result: 'PASS' }, { current: true }, { path: 'screenshots/history' }, { sha256: '' }, { reportOverwrittenBy: 'nope' }, { reportOverwrittenAt: '2026-01-03' }]) {
    s.commit([{ ...observed, ...patch }, b]);
    assert.equal(s.run().code, 1, JSON.stringify(patch));
  }
  s.commit([{ ...observed, sha256: null }, b]);
  assert.equal(s.run().code, 0, '原 hash 确实不可恢复时必须 null，不编新 hash');
  const unknown = { ...observed, reportOverwrittenBy: null, reportOverwrittenAt: null };
  s.commit([unknown, b]);
  const unknownResult = s.run();
  assert.equal(unknownResult.code, 0, unknownResult.out);
  assert.match(unknownResult.out, /覆盖者与覆盖采集时间未知.*不构成 PASS/);
  for (const patch of [{ current: true }, { result: 'PASS' }, { provenanceComplete: true }, { localOnly: false }, { sha256: '' }]) {
    s.commit([{ ...unknown, ...patch }, b]);
    assert.equal(s.run().code, 1, '未知关联豁免绝不适用于current/PASS/完整证据或空hash');
  }
  s.commit([{ ...unknown, sha256: null }, b]);
  assert.equal(s.run().code, 0, '完整 hash/关联都丢失只能明确不可恢复观察');
  s.write(originalPath, 'tampered existing report');
  s.commit([unknown, b]);
  assert.equal(s.run().code, 1, '未知关联不能绕过原路径现有文件 hash mismatch');
  s.commit([observed, b]);
  assert.equal(s.run().code, 1, '丢失标记不能绕过原路径上未知内容的 hash mismatch');
  rmSync(join(s.root, originalPath));
  s.commit([{ ...observed, recoveryStatus: undefined, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' }, b]);
  assert.equal(s.run().code, 0, '原时间/hash已知的丢失报告必须核时间与覆盖关联');
  s.commit([{ ...observed, recoveryStatus: undefined, startedAt: '2026-01-03T00:00:00.000Z', finishedAt: '2026-01-03T00:01:00.000Z' }, b]);
  assert.equal(s.run().code, 1, '覆盖者早于旧采集结束必须拒绝');
});

// ── 测试现场归属（不是产品行为）：默认 D 盘、独立目录、幂等清理 ──────────────────

test('测试现场：默认根目录在 Windows 固定 D 盘，其他平台跟随系统临时目录', () => {
  assert.equal(
    DEFAULT_TEST_ARTIFACT_ROOT,
    process.platform === 'win32' ? 'D:/test-artifacts/quaternion-attitude' : tmpdir(),
  );
});

test('测试现场：环境变量覆盖根目录，并按 kind 分目录', () => {
  const saved = process.env.QUAT_TEST_ARTIFACT_ROOT;
  const base = testArtifactTempDir('contracts', 'root-');
  try {
    process.env.QUAT_TEST_ARTIFACT_ROOT = base;
    const alpha = testArtifactRoot('alpha');
    assert.equal(alpha, resolve(base, 'alpha'));
    assert.ok(existsSync(alpha), '根目录必须真的建出来');
    assert.equal(existsSync(join(base, 'beta')), false, '未请求的 kind 不应被创建');
  } finally {
    if (saved === undefined) delete process.env.QUAT_TEST_ARTIFACT_ROOT;
    else process.env.QUAT_TEST_ARTIFACT_ROOT = saved;
    cleanupArtifactDir(base);
  }
});

test('测试现场：每次任务独立目录，清理只删自己', () => {
  const a = testArtifactTempDir('contracts', 'task-');
  const b = testArtifactTempDir('contracts', 'task-');
  assert.notEqual(a, b, '两个并行任务不得共用同一 profile');
  assert.ok(existsSync(a) && existsSync(b));
  assert.equal(cleanupArtifactDir(a), true);
  assert.equal(existsSync(a), false);
  assert.ok(existsSync(b), '清理 a 不得波及 b');
  assert.equal(cleanupArtifactDir(b), true);
});

test('测试现场：清理不存在的目录是幂等的', () => {
  assert.equal(cleanupArtifactDir(join(testArtifactRoot('contracts'), 'does-not-exist')), true);
});

test('测试现场：自动清理只删过期临时目录，新目录与归档/报告/真机授权全部保留', () => {
  const base = testArtifactTempDir('contracts', 'prune-root-');
  const now = Date.now();
  const make = (rel, old) => {
    const dir = join(base, rel);
    mkdirSync(dir, { recursive: true });
    const sec = (now - (old ? 5000 : 0)) / 1000;
    utimesSync(dir, sec, sec);
    return dir;
  };
  try {
    const old = make('smoke/old-task', true);
    const recent = make('smoke/new-task', false);
    const retained = [
      make('_migrated-c-temp/smoke/old-task', true),
      make('_ops/old-report', true),
      make('hw-soak/hw-profile-serial', true),
    ];
    const result = pruneTestArtifacts({ root: base, maxAgeMs: 1000, now, isInUse: () => false });
    assert.equal(existsSync(old), false, '过期临时目录必须删除');
    assert.ok(existsSync(recent), '新目录不能误删');
    for (const dir of retained) assert.ok(existsSync(dir), `保留目录不得自动删除：${dir}`);
    assert.equal(result.skippedRetained.length, 3);
  } finally {
    cleanupArtifactDir(base);
  }
});

test('测试现场：自动清理遇到活跃目录或占用查询失败都跳过，不杀进程', () => {
  const base = testArtifactTempDir('contracts', 'prune-in-use-');
  const old = join(base, 'soak', 'old-task');
  mkdirSync(old, { recursive: true });
  const past = (Date.now() - 5000) / 1000;
  utimesSync(old, past, past);
  try {
    for (const isInUse of [() => true, () => { throw new Error('查询失败'); }]) {
      const result = pruneTestArtifacts({ root: base, maxAgeMs: 1000, isInUse });
      assert.ok(existsSync(old), '活跃/无法确认占用的目录必须保留');
      assert.equal(result.skippedInUse.length, 1);
      assert.equal(result.deleted.length, 0);
    }
  } finally {
    cleanupArtifactDir(base);
  }
});
