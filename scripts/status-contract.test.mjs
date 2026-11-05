import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCurrentRegion, validateGateManifest, validateStatusClaims, validateDocFacts } from './status-contract.mjs';
const actual={experiments:19,demos:8,selftest:124,smoke:88,docpages:15,scene:10,html:15,doc:4,budget:13};
const pkg={check:'npm run selftest && npm run scenecheck && npm run htmlcheck && npm run doccheck && npm run contracts && npm run statuscheck'};
const manifest='<!-- verify: check=153 contracts=yes status=yes smoke=88 budget=13 -->\n';
const current=`<!-- counts: experiments=19 demos=8 selftest=124 smoke=88 docpages=15 -->\n${manifest}> 数值自检 124 + 场景几何 10 + HTML 契约 15 + 文档基准 4\n- \`npm run check\` = four, 共 **153 项**\n- \`npm run budget\` = **13 项上限**\n`;
const doc=(text=current)=>`header\n<!-- history:begin old -->\n数值自检 999 + 场景几何 999 + HTML 契约 999 + 文档基准 999\n<!-- counts: experiments=999 -->\n<!-- history:end -->\n<!-- current:begin -->\n${text}<!-- current:end -->\n<!-- history:begin -->\n- \`npm run budget\` = 999 项\n<!-- history:end -->`;
test('one current region excludes multiple historical blocks, never validates old values',()=>{
  assert.equal(extractCurrentRegion(doc()),current);
  assert.deepEqual(validateStatusClaims(doc(),actual),[]);
  assert.deepEqual(validateStatusClaims(doc().replaceAll('999','777'),actual),[]);
});
test('gate manifest is machine-checked against real counts and the check chain',()=>{
  assert.deepEqual(validateGateManifest(doc(),actual,pkg),[]);
  for(const text of [
    manifest.replace('check=153','check=161'),           // 过期总数（顶部曾经写 161）
    manifest.replace('smoke=88','smoke=999'),
    manifest.replace('budget=13','budget=11'),
    manifest.replace('contracts=yes','contracts=no'),     // 与 check 链不一致
    manifest.replace('status=yes','status=no'),
    manifest.replace('contracts=yes','contracts=maybe'),
    manifest.replace(' budget=13',''),
    manifest.replace(' budget=13',' extra=1'),
    manifest+manifest,                                    // 清单必须唯一
    manifest.replace('<!-- verify','<!-- verifyX'),
  ]) assert.ok(validateGateManifest(doc(text),actual,pkg).length>0,text);
  // check 链里没有 contracts 时，清单必须写 no（否则文档在撒谎）
  assert.ok(validateGateManifest(doc(),actual,{check:'npm run selftest'}).length>0);
  assert.deepEqual(validateGateManifest(doc(manifest.replace('contracts=yes status=yes','contracts=no status=no')),actual,{check:'npm run selftest'}),[]);
});
test('current region may not smuggle unverifiable pass counts',()=>{
  assert.ok(validateGateManifest(doc(current+'本轮 check 161 PASS / 0 FAIL\n'),actual,pkg).length>0);
  assert.ok(validateGateManifest(doc(current+'冒烟 88 PASS / 0 FAIL\n'),actual,pkg).length===0,'冒烟实测数允许出现');
  assert.ok(validateGateManifest(doc(current+'契约 119 PASS\n'),actual,pkg).length>0);
});
const factsBody = (body = '数值自检 124 + 场景几何 10 + HTML 契约 15 + 文档基准 4 → 13 项产物预算 → 88 项浏览器冒烟（app / devices 两片）\n' + manifest) =>
  `head\n<!-- facts:begin -->\n${body}<!-- facts:end -->\ntail\n`;

test('README / in-app facts region is machine-checked, and prose numbers must match the same measurements', () => {
  assert.deepEqual(validateDocFacts(factsBody(), actual, pkg, 'README'), []);
  // 历史表格里的旧数字不算漂移（只在 facts 区域内校验）
  assert.deepEqual(validateDocFacts(`历史：80 项自检、9 项上限、51 项冒烟\n${factsBody()}`, actual, pkg, 'README'), []);
  for (const text of [
    factsBody().replace('数值自检 124','数值自检 125'),            // README 语序：数值自检 N
    factsBody().replace('数值自检 124','125 项数值自检'),           // 应用内语序：N 项数值自检
    factsBody().replace('13 项产物预算','9 项产物预算'),
    factsBody().replace('88 项浏览器冒烟','91 项浏览器冒烟'),
    factsBody().replace('场景几何 10','场景几何 9'),
    factsBody().replace('<!-- facts:begin -->',''),                 // 缺 facts 区域
    factsBody() + '<!-- facts:begin -->x<!-- facts:end -->',        // 区域必须唯一
    factsBody().replace(manifest,''),                               // 缺清单
    factsBody().replace('check=153','check=154'),                   // 清单与实测不一致
    factsBody().replace('budget=13','budget=12'),
  ]) assert.ok(validateDocFacts(text, actual, pkg, 'README').length > 0, text.slice(0, 60));
  // 英文 README 的同义写法同样受管
  const en = `head\n<!-- facts:begin -->\n124 numeric + 10 scene-geometry + 15 HTML-contract + 4 doc-benchmark checks → 13 bundle budgets → 88 browser checks (two shards)\n${manifest}<!-- facts:end -->\n`;
  assert.deepEqual(validateDocFacts(en, actual, pkg, 'README.en'), []);
  assert.ok(validateDocFacts(en.replace('88 browser checks','91 browser checks'), actual, pkg, 'README.en').length > 0);
  assert.ok(validateDocFacts(en.replace('13 bundle budgets','9 ceilings'), actual, pkg, 'README.en').length > 0);
  // 「N 项上限」这类散落数字：直接抓 README 里那两处真实漂移
  assert.ok(validateDocFacts(factsBody('产物预算（8 项上限）\n'), actual, pkg, 'README').length > 0);
});

test('boundaries are strict, unique, correctly ordered and non-nested',()=>{
  for(const text of [doc().replace('<!-- current:begin -->',''),doc().replace('<!-- current:end -->',''),doc()+'<!-- current:begin -->x<!-- current:end -->',doc().replace('<!-- current:begin -->','<!-- current:end -->'),doc().replace('<!-- history:end -->',''),doc().replace('<!-- current:end -->','<!-- history:end --><!-- current:end -->'),doc().replace(current,'<!-- history:begin -->x<!-- history:end -->'+current),doc().replace('<!-- current:begin -->','<!-- current:beginX -->')]) assert.throws(()=>extractCurrentRegion(text));
});
test('all required claims must exist exactly once inside current, reject duplicate keys and malformed numbers',()=>{
  for(const text of [current.replace(/<!-- counts:.*-->/,''),current.replace('experiments=19','experiments=19 experiments=19'),current.replace('demos=8','demos=NaN'),current.replace('demos=8','demos=8.0'),current.replace('demos=8','demos=8 extra=1'),current+current,current.replace(/> 数值自检.*\n/,''),current.replace(/- `npm run budget`.*\n/,''),current.replace('153 项','999 项'),current.replace('13 项','999 项'),current.replace('文档基准 4','文档基准 3')]) assert.ok(validateStatusClaims(doc(text),actual).length>0,text);
  assert.ok(validateStatusClaims(doc(current.replace(/<!-- counts:.*-->/,''))+'\n<!-- counts: experiments=19 demos=8 selftest=124 smoke=88 docpages=15 -->',actual).length>0);
});
