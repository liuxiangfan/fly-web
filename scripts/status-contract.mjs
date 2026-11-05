/** Pure current/history contract; no filesystem or subprocess effects. */
export function extractCurrentRegion(text) {
  if (typeof text !== 'string') throw new Error('状态文档必须是文本');
  const markers = [...text.matchAll(/<!--\s*(current|history):(begin|end)(?:\s+[^<>]*?)?\s*-->/g)];
  // Unknown/malformed boundary spellings must not silently disappear.
  const mentions = [...text.matchAll(/<!--\s*(?:current|history):[^>]*-->/g)];
  if (mentions.length !== markers.length) throw new Error('current/history 边界格式非法');
  let active = null, start = -1, result = null, currentCount = 0, historyCount = 0;
  for (const m of markers) {
    const [, kind, action] = m;
    if (action === 'begin') {
      if (active) throw new Error('current/history 区域不能嵌套或交叉');
      active = kind;
      if (kind === 'current') { currentCount++; start = m.index + m[0].length; }
      else historyCount++;
    } else {
      if (active !== kind) throw new Error('current/history 边界顺序不合法');
      if (kind === 'current') result = text.slice(start, m.index);
      active = null;
    }
  }
  if (active || currentCount !== 1 || historyCount < 1 || result === null) throw new Error('必须有唯一 current 区域与完整 history 区域');
  // Region content includes surrounding newlines, keep exact text rather than normalize.
  return result.startsWith('\n') ? result.slice(1) : result;
}

/**
 * 门禁清单（唯一）：把「跑过哪些门禁、各多少项」变成可被源码实测核对的一行。
 *
 * 为什么需要：顶部「最新一轮」原先写在 current 区域之外，于是 `161 PASS` / `88 PASS`
 * 这类声明可以任意过期而门禁全绿（复核反例：把 161/88 改成 999 仍然通过）。
 * 现在它们必须在 current 区域内，且 check/smoke/budget 三个数字与实测一致；
 * contracts/status 两个开关必须与 package.json 的 `npm run check` 链一致——
 * 「check 里到底有没有契约」不再靠文档自己说。
 */
export function validateGateManifest(text, actual, pkg) {
  const errors = [];
  let current;
  try { current = extractCurrentRegion(text); } catch (e) { return [e.message]; }
  const manifests = [...current.matchAll(/<!--\s*verify:\s*([^>]*?)\s*-->/g)];
  if (manifests.length !== 1) { errors.push('current 区域必须有唯一 verify 门禁清单'); return errors; }
  const fields = {};
  for (const token of manifests[0][1].trim().split(/\s+/)) {
    const m = /^([a-z]+)=(\S+)$/.exec(token);
    if (!m || Object.hasOwn(fields, m[1])) { errors.push(`verify 清单字段非法/重复：${token}`); continue; }
    fields[m[1]] = m[2];
  }
  const expectedKeys = ['check', 'contracts', 'status', 'smoke', 'budget'];
  const optionalKeys = ['evidence'];
  for (const k of expectedKeys) if (!Object.hasOwn(fields, k)) errors.push(`verify 清单缺少 ${k}`);
  for (const k of Object.keys(fields)) if (!expectedKeys.includes(k) && !optionalKeys.includes(k)) errors.push(`verify 清单多余字段 ${k}`);
  const numOf = (k) => (/^(0|[1-9]\d*)$/.test(fields[k] ?? '') ? Number(fields[k]) : null);
  const check = numOf('check');
  const sum = actual.selftest + actual.scene + actual.html + actual.doc;
  if (check === null || check !== sum) errors.push(`verify.check 声明 ${fields.check} ≠ 四项之和 ${sum}`);
  const smoke = numOf('smoke');
  if (smoke === null || smoke !== actual.smoke) errors.push(`verify.smoke 声明 ${fields.smoke} ≠ 实测 ${actual.smoke}`);
  const budget = numOf('budget');
  if (budget === null || budget !== actual.budget) errors.push(`verify.budget 声明 ${fields.budget} ≠ 实测 ${actual.budget}`);
  const chain = typeof pkg?.check === 'string' ? pkg.check : '';
  for (const [key, script] of [['contracts', 'npm run contracts'], ['status', 'npm run statuscheck'], ['evidence', 'npm run evidence:check']]) {
    if (key === 'evidence' && !Object.hasOwn(fields, key)) continue; // 可选：不声明就不判
    const inChain = chain.includes(script);
    if (!inChain && fields[key] !== 'no') errors.push(`verify.${key}=${fields[key]}，但 package.json 的 check 链${inChain ? '包含' : '不包含'} ${script}`);
    if (inChain && fields[key] !== 'yes') errors.push(`verify.${key}=${fields[key]}，但 package.json 的 check 链包含 ${script}（应写 yes）`);
  }
  // 「N PASS」只允许出现在历史区域/CHANGELOG：current 区域里出现就说明有人把会在门禁之外
  // 悄悄过期的通过数写回来了。
  for (const m of current.matchAll(/(\d+)\s*(?:PASS|项全绿)/g)) {
    const n = Number(m[1]);
    if (![actual.selftest, actual.scene, actual.html, actual.doc, actual.smoke, actual.budget, sum].includes(n)) {
      errors.push(`current 区域出现未受校验的通过数「${m[0]}」——门禁数字必须由 verify 清单/口径行声明`);
    }
  }
  return errors;
}

/**
 * README 与应用内「技术口径」的门禁数字：与 PROJECT-STATE 用**同一份实测值**校验。
 *
 * 为什么必须一起管（复核 P2）：三处文档各自维护数字，漂移了没人发现——README 里写着
 * 「9 项产物预算 / 8 项上限」而实际是 14 项，应用内写着「91 项冒烟（app 72 + devices 19）」
 * 而实际已经变了。正文里的数字最容易漂，所以校验必须覆盖正文，而不只是那句清单。
 *
 * 只扫描 `<!-- facts:begin -->…<!-- facts:end -->` 区域：历史表格里的旧数字（如
 * 「80 项自检」）是**冻结的历史事实**，不该被当成漂移。
 */
export function validateDocFacts(text, actual, pkg, label) {
  const errors = [];
  const begin = '<!-- facts:begin -->', end = '<!-- facts:end -->';
  const b = text.indexOf(begin), e = text.indexOf(end);
  if (b < 0 || e < 0 || e < b || text.indexOf(begin, b + 1) >= 0 || text.indexOf(end, e + 1) >= 0) {
    return [`${label} 必须有唯一 facts 区域（<!-- facts:begin -->…<!-- facts:end -->）`];
  }
  const region = text.slice(b + begin.length, e);
  const sum = actual.selftest + actual.scene + actual.html + actual.doc;

  const markers = [...region.matchAll(/<!--\s*verify:\s*([^>]*?)\s*-->/g)];
  if (markers.length !== 1) { errors.push(`${label} facts 区域必须有唯一 verify 门禁清单`); return errors; }
  const fields = {};
  for (const token of markers[0][1].trim().split(/\s+/)) {
    const m = /^([a-z]+)=(\S+)$/.exec(token);
    if (!m || Object.hasOwn(fields, m[1])) { errors.push(`${label} verify 清单字段非法/重复：${token}`); continue; }
    fields[m[1]] = m[2];
  }
  const expectedKeys = ['check', 'contracts', 'status', 'smoke', 'budget'];
  const optionalKeys = ['evidence'];
  for (const k of expectedKeys) if (!Object.hasOwn(fields, k)) errors.push(`${label} verify 清单缺少 ${k}`);
  for (const k of Object.keys(fields)) if (!expectedKeys.includes(k) && !optionalKeys.includes(k)) errors.push(`${label} verify 清单多余字段 ${k}`);
  const num = (k) => (/^(0|[1-9]\d*)$/.test(fields[k] ?? '') ? Number(fields[k]) : null);
  if (num('check') !== sum) errors.push(`${label} verify.check 声明 ${fields.check} ≠ 四项之和 ${sum}`);
  if (num('smoke') !== actual.smoke) errors.push(`${label} verify.smoke 声明 ${fields.smoke} ≠ 实测 ${actual.smoke}`);
  if (num('budget') !== actual.budget) errors.push(`${label} verify.budget 声明 ${fields.budget} ≠ 实测 ${actual.budget}`);
  const chain = typeof pkg?.check === 'string' ? pkg.check : '';
  for (const [key, script] of [['contracts', 'npm run contracts'], ['status', 'npm run statuscheck'], ['evidence', 'npm run evidence:check']]) {
    if (key === 'evidence' && !Object.hasOwn(fields, key)) continue;
    const inChain = chain.includes(script);
    if (inChain !== (fields[key] === 'yes')) {
      errors.push(`${label} verify.${key}=${fields[key]}，但 check 链${inChain ? '包含' : '不包含'} ${script}`);
    }
  }
  // 正文数字：漂移最容易发生在这里，必须逐个对齐同一份实测。
  // 两种语序都要覆盖：README 写「数值自检 125」，应用内写「125 项数值自检」。
  const claims = [
    [/(\d+)\s*项数值自检/g, actual.selftest, '数值自检'],
    [/数值自检\s*(\d+)/g, actual.selftest, '数值自检'],
    [/(\d+)\s*项(?:三维)?场景几何(?:自检)?/g, actual.scene, '场景几何'],
    [/场景几何(?:自检)?\s*(\d+)/g, actual.scene, '场景几何'],
    [/(\d+)\s*项 HTML[↔<]/g, actual.html, 'HTML 契约'],
    [/HTML 契约(?:检查)?\s*(\d+)/g, actual.html, 'HTML 契约'],
    [/(\d+)\s*项文档基准/g, actual.doc, '文档基准'],
    [/文档基准(?:检查)?\s*(\d+)/g, actual.doc, '文档基准'],
    [/(\d+)\s*项(?:浏览器(?:端到端)?)?冒烟/g, actual.smoke, '浏览器冒烟'],
    [/(\d+)\s*项产物预算/g, actual.budget, '产物预算'],
    [/产物预算（(\d+)\s*项/g, actual.budget, '产物预算'],
    [/(\d+)\s*项上限/g, actual.budget, '预算项上限'],
    // 英文 README 的同义写法（同一份实测值，另一种语言不该有第二套数字）
    [/(\d+)\s*numeric\b/g, actual.selftest, 'numeric self-checks'],
    [/(\d+)\s*scene-geometry\b/g, actual.scene, 'scene-geometry checks'],
    [/(\d+)\s*HTML-contract\b/g, actual.html, 'HTML-contract checks'],
    [/(\d+)\s*doc-benchmark\b/g, actual.doc, 'doc-benchmark checks'],
    [/(\d+)\s*(?:real-)?browser (?:end-to-end )?checks/g, actual.smoke, 'browser checks'],
    [/(\d+)\s*bundle budgets?/g, actual.budget, 'bundle budgets'],
    [/(\d+)\s*(?:abundance )?ceilings/g, actual.budget, 'ceilings'],
  ];
  for (const [re, want, what] of claims) {
    for (const m of region.matchAll(re)) {
      if (Number(m[1]) !== want) errors.push(`${label} 正文「${m[0].trim()}」≠ 实测 ${want}（${what}）`);
    }
  }
  return errors;
}

/** PROJECT-STATE 的 counts / 四项口径 / 合计 / 预算行校验（current 区域）。 */
export function validateStatusClaims(text, actual) {
  const errors = [];
  let current;
  try { current = extractCurrentRegion(text); } catch(e) { return [e.message]; }
  const counts = [...current.matchAll(/<!--\s*counts:\s*([^>]*?)\s*-->/g)];
  const keys = ['experiments','demos','selftest','smoke','docpages'];
  if (counts.length !== 1) errors.push('current 区域必须有唯一 counts 声明');
  else {
    const seen = new Set();
    for (const token of counts[0][1].trim().split(/\s+/)) {
      const m = /^([a-z]+)=(0|[1-9]\d*)$/.exec(token);
      if (!m || !keys.includes(m[1]) || seen.has(m[1])) { errors.push(`counts 非法/重复字段：${token}`); continue; }
      seen.add(m[1]);
      if (!Number.isSafeInteger(Number(m[2])) || Number(m[2]) !== actual[m[1]]) errors.push(`${m[1]} 声明 ${m[2]} ≠ 实测 ${actual[m[1]]}`);
    }
    for(const k of keys) if(!seen.has(k)) errors.push(`counts 缺少 ${k}`);
  }
  const scopes = [...current.matchAll(/数值自检\s*(\d+)\s*\+\s*场景几何\s*(\d+)\s*\+\s*HTML 契约\s*(\d+)\s*\+\s*文档基准\s*(\d+)/g)];
  if (scopes.length !== 1) errors.push('current 区域必须有唯一四项验证口径声明');
  else ['selftest','scene','html','doc'].forEach((k,i)=> { if(Number(scopes[0][i+1])!==actual[k]) errors.push(`验证口径 ${k} 声明不一致`); });
  const sum=actual.selftest+actual.scene+actual.html+actual.doc;
  const checkLines=current.split(/\r?\n/).filter(l=>/^\s*-\s*`npm run check`/.test(l));
  const totals=checkLines.flatMap(l=>[...l.matchAll(/共\s*\**\s*(\d+)\s*项\**/g)]);
  if(checkLines.length!==1 || totals.length!==1) errors.push('current 区域必须有唯一 npm run check 合计声明');
  else if(Number(totals[0][1])!==sum) errors.push(`check 合计 ≠ 四项之和 ${sum}`);
  for(const m of current.matchAll(/\*\*(\d+)\s*项\s*=/g)) if(Number(m[1])!==sum) errors.push(`当前标题合计 ${m[1]} ≠ ${sum}`);
  const budgetLines=current.split(/\r?\n/).filter(l=>/^\s*-\s*`npm run budget`/.test(l));
  const budgets=budgetLines.flatMap(l=>[...l.matchAll(/(\d+)\s*项/g)]);
  if(budgetLines.length!==1 || budgets.length!==1) errors.push('current 区域必须有唯一产物预算项数声明');
  else if(Number(budgets[0][1])!==actual.budget) errors.push(`产物预算 ${budgets[0][1]} ≠ 实测 ${actual.budget}`);
  for(const [key,value] of Object.entries(actual)) if(!Number.isSafeInteger(value) || value<=0) errors.push(`实测 ${key} 必须是正整数`);
  return errors;
}
