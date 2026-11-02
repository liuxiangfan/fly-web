/** Dynamic counts: every current declaration is validated in one explicit region. */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Pure JS contract is independently covered by node:test.
import { validateStatusClaims, validateGateManifest } from './status-contract.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=(path:string):string=>readFileSync(resolve(root,path),'utf8');
function countChecks(src:string):number {
  return src.split(/\r?\n/).filter(l=>/^\s+check\(/.test(l)).length;
}
const printedItems=(script:string):number|null=>{
  try {
    const out=execFileSync(process.execPath,['--import','tsx',resolve(root,script)],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const passes=out.split(/\r?\n/).filter(l=>l.startsWith('[PASS]')).length;
    const summary=/校验通过 ✅（(\d+) 项）/.exec(out.replace(/\n/g,' '));
    return passes>0&&(!summary||Number(summary[1])===passes)?passes:null;
  }catch {return null;}
};
const path=resolve(root,'docs/PROJECT-STATE.md');
if(!existsSync(path)){console.error('[FAIL] 找不到 docs/PROJECT-STATE.md');process.exit(2);}
const htmlItems=printedItems('scripts/htmlcheck.ts');
const docItems=printedItems('scripts/doccheck.ts');
if(htmlItems===null||docItems===null){console.error(`[FAIL] 无法读取子检查项数（html=${htmlItems??'?'}、doc=${docItems??'?'}）`);process.exit(1);}
const actual={
  experiments:(read('src/ui/experiments.ts').match(/id:\s*"[a-zA-Z0-9_-]+"/g)??[]).length,
  demos:(read('index.html').match(/<canvas id="fig-[a-z0-9-]+"/g)??[]).length,
  selftest:countChecks(read('scripts/selftest.ts')),
  smoke:countChecks(read('scripts/browser-smoke.mjs')),
  docpages:(read('index.html').match(/<article[^>]*data-doc-page/g)??[]).length,
  scene:countChecks(read('scripts/scenecheck.ts')),
  html:htmlItems,doc:docItems,
  budget:(read('scripts/distbudget.mjs').match(/name:\s*"/g)??[]).length,
};
const failures:string[]=validateStatusClaims(readFileSync(path,'utf8'),actual);
const pkg=JSON.parse(read('package.json')) as {scripts?:Record<string,string>};
// 门禁清单：check/smoke/budget 三个数字与实测对齐，contracts/status 两个开关与 package.json
// 的 check 链对齐——「check 里到底有没有契约」不再由文档自己说了算。
const gateFailures:string[]=validateGateManifest(readFileSync(path,'utf8'),actual,{check:pkg.scripts?.check??''});
failures.push(...gateFailures);
if(failures.length){for(const problem of failures) console.log(`[FAIL] ${problem}`);}
else {
  console.log(`[PASS] 当前 counts — ${Object.entries(actual).slice(0,5).map(([k,v])=>`${k}=${v}`).join(' ')}`);
  console.log(`[PASS] 子检查项数取自实际输出 — HTML ${actual.html}、文档 ${actual.doc}`);
  console.log(`[PASS] 当前四项验证口径 — ${actual.selftest}/${actual.scene}/${actual.html}/${actual.doc}`);
  console.log(`[PASS] 当前 check 合计 — ${actual.selftest+actual.scene+actual.html+actual.doc} 项`);
  console.log(`[PASS] 当前预算 — ${actual.budget} 项`);
  console.log(`[PASS] 门禁清单 — check/冒烟/预算与实测一致，contracts/status 开关与 package.json 的 check 链一致`);
  console.log('[PASS] 唯一 current 区域与全部 history 边界完整，历史数值不参与当前校验');
}
console.log(failures.length?`\n${failures.length} 项不一致`:'\n动态计数校验通过');
process.exit(failures.length?1:0);
