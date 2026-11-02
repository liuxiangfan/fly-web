/** Pure soak acceptance contracts, shared by runner and negative tests. */
export const ALGORITHMS = ['pure','comp','mahony','madg','kalman'];
export function parseSoakArgs(argv) {
  const raw={};
  const allowed=new Set(['url','seconds','interval','heapLimitMb','allowNoHeap','seeds','batch','reconnect','dropEvery','output','profileRoot']);
  for(const arg of argv) {
    const m=/^--([a-zA-Z][a-zA-Z-]*)(?:=(.*))?$/.exec(arg);
    if(!m) throw new Error(`非法 CLI 参数 ${arg}`);
    const k=m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(!allowed.has(k) || Object.hasOwn(raw,k)) throw new Error(`未知或重复参数 ${k}`);
    raw[k]=m[2]??'true';
  }
  const bool=k=> { const v=raw[k]??'false'; if(v!=='true'&&v!=='false') throw new Error(`${k} 必须是 true/false`); return v==='true'; };
  const num=(k,fallback,integer=false)=> {
    const value=raw[k]??String(fallback);
    if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${k} 必须是有限正数`);
    const n=Number(value); if(!Number.isFinite(n)||n<=0||(integer&&!Number.isSafeInteger(n))) throw new Error(`${k} 必须是${integer?'正整数':'有限正数'}`);
    return n;
  };
  const result={url:raw.url,seconds:num('seconds',120),interval:num('interval',5000),heapLimitMb:num('heapLimitMb',24),allowNoHeap:bool('allowNoHeap'),seeds:num('seeds',10,true),batch:bool('batch'),reconnect:bool('reconnect'),dropEvery:num('dropEvery',8),output:raw.output??'docs/generated/soak.json',profileRoot:raw.profileRoot};
  if(result.batch&&result.reconnect) throw new Error('--batch 与 --reconnect 不可组合：真实模式无批量真值，请分别运行');
  if(result.seeds>1000) throw new Error('seeds 超过 1000');
  if(!result.output.trim() || result.output==='true') throw new Error('output 必须是路径');
  return result;
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const counter=v=>Number.isSafeInteger(v)&&v>=0;
/** 批量 soak 必须跑满的批次数：验收的是「连续多批不串世代/不残留隐藏资源」，
 *  只跑成一批就判 PASS 等于把「时间不够」伪装成「通过」。 */
export const SOAK_BATCH_RUNS = 3;
export function heapVerdict(values,limit,allowNoHeap=false) {
  const malformed=!Array.isArray(values)||values.some(v=>v!==null&&!finite(v));
  const measured=Array.isArray(values)?values.filter(finite):[];
  const heapMeasured=measured.length>=2;
  // 跳过首个 warm-up 点需要**至少 3 个**实测点；只有两个点时从第一个实测值算。
  // 旧实现一律用 measured[1] 当基线：两点样本 [10,200] 会算成 0 MB 增长并 PASS。
  const baselineIdx=heapMeasured?(measured.length>=3?1:0):0;
  const baseline=heapMeasured?measured[baselineIdx]:null;
  const windowed=heapMeasured?measured.slice(baselineIdx):[];
  const heapGrowMb=heapMeasured?measured[measured.length-1]-baseline:null;
  // 峰值增量：窗口内最高点相对基线。只看「起点→终点」会漏掉「中途冲到 60 MB 又跌回来」
  // 这类真实泄漏形态（复核 6.5：堆判定必须同时看起点→终点、线性趋势和峰值）。
  const heapPeakGrowthMb=heapMeasured?Math.max(...windowed)-baseline:null;
  // 线性趋势：窗口内最小二乘斜率 × (n-1) = 拟合出的「窗口内总增长」。
  // 慢泄漏在起终点上可能只差几 MB，但趋势会稳定为正；只看终点差会被一次 GC 抵消掉。
  let heapTrendMb=null;
  if(heapMeasured&&windowed.length>=3) {
    const n=windowed.length, xm=(n-1)/2, ym=windowed.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for(let i=0;i<n;i++) { num+=(i-xm)*(windowed[i]-ym); den+=(i-xm)**2; }
    heapTrendMb=(den>0?num/den:0)*(n-1);
  }
  const peakLimit=finite(limit)&&limit>0?limit*2:null;
  const heapGrowOk=heapMeasured&&finite(limit)&&limit>0&&heapGrowMb<=limit;
  const heapPeakOk=heapMeasured&&peakLimit!==null&&heapPeakGrowthMb<=peakLimit;
  const heapTrendOk=heapTrendMb===null?heapMeasured:heapTrendMb<=limit;
  const heapOk=!malformed&&heapGrowOk&&heapPeakOk&&heapTrendOk;
  const heapWaived=!malformed&&!heapMeasured&&allowNoHeap===true;
  return {heapMeasured,heapOk,heapStatus:malformed?'INVALID':heapMeasured?(heapOk?'PASS':'FAIL'):'NOT_MEASURED',heapWaived,heapGateOk:heapOk||heapWaived,heapGrowMb,heapPeakGrowthMb,heapTrendMb,heapPeakOk,heapTrendOk,heapPeakLimitMb:peakLimit};
}
export function validateSamples(samples) {
  const problems=[];
  if(!Array.isArray(samples)||samples.length<2) return {ok:false,problems:['至少两个样本']};
  for(let i=0;i<samples.length;i++) {
    const s=samples[i];
    if(!s||typeof s!=='object') {problems.push(`sample ${i} 不是对象`);continue;}
    for(const [count,cap] of [['logRows','logRowsCap'],['rawRows','rawRowsCap'],['insTrail','insTrailCap'],['serialQueue','serialQueueCap']]) if(!counter(s[count])||!counter(s[cap])||s[cap]===0||s[count]>s[cap]) problems.push(`${i}.${count}/${cap} 非法或超容量`);
    if(!Array.isArray(s.charts)||!s.charts.length||!Array.isArray(s.chartCaps)||s.charts.length!==s.chartCaps.length||s.charts.some((n,j)=>!counter(n)||!counter(s.chartCaps[j])||s.chartCaps[j]===0||n>s.chartCaps[j])) problems.push(`${i}.charts 非法或超容量`);
    for(const key of ['t','at']) if(!finite(s[key])||s[key]<0) problems.push(`${i}.${key} 非法`);
    for(const key of ['serialFrames','consumedFrames']) if(!counter(s[key])) problems.push(`${i}.${key} 非法`);
    if(i) for(const key of ['t','at','serialFrames','consumedFrames']) if(s[key]<samples[i-1]?.[key]) problems.push(`${i}.${key} 倒退`);
  }
  return {ok:problems.length===0,problems};
}
export function validateReconnectEvents(events) {
  const problems=[];
  if(!Array.isArray(events)||!events.length) return {ok:false,problems:['缺少重连事件'],drops:0,recovered:0};
  let segment=null, drops=0, recovered=0, lastAt=-Infinity, lastCount=0, lastT=0, nextId=1;
  for(const e of events) {
    const c=e?.consumption;
    if(!e||!finite(e.at)||e.at<lastAt||!c||!counter(c.count)||!finite(c.at)||!finite(c.t)||c.count<lastCount||c.t<lastT||c.at>e.at) {problems.push('事件/实际消费快照非法或倒退');continue;}
    lastAt=e.at; lastCount=c.count; lastT=c.t;
    if(e.type==='open') {
      if(segment&&!segment.dropped) problems.push('未断线却重复 open');
      if(e.segment!==nextId++) problems.push('连接段 ID 不连续');
      segment={id:e.segment,openAt:e.at,baseline:c.count,t:c.t,first:false,dropped:false};
    } else if(e.type==='firstFrame') {
      if(!segment||segment.id!==e.segment||segment.first||segment.dropped||c.count<=segment.baseline||c.at<segment.openAt||c.at!==e.at||c.t<=segment.t) problems.push('每段 firstFrame 必须来自本段实际消费时刻');
      else {segment.first=true;if(drops) recovered++;}
    } else if(e.type==='drop'||e.type==='end') {
      if(!segment||segment.id!==e.segment||segment.dropped||!segment.first||c.count<=segment.baseline||c.at<segment.openAt) problems.push('连接段缺少实际首帧消费/重复断线');
      if(e.type==='drop') {drops++;if(segment) segment.dropped=true;}
    } else problems.push(`未知事件 ${e.type}`);
  }
  if(drops<1||recovered!==drops||!segment?.first||segment?.dropped) problems.push('每次断线都必须在后续独立段 open 并消费首帧');
  return {ok:problems.length===0,problems,drops,recovered};
}
export function validateBatch(log,expectedSeeds,expectedBatches=SOAK_BATCH_RUNS) {
  const problems=[];
  if(!Array.isArray(log)||!log.length) return {ok:false,problems:['没有批量评测']};
  if(!Number.isSafeInteger(expectedBatches)||expectedBatches<1) problems.push('期望批次数非法');
  else if(log.length!==expectedBatches) problems.push(`批量批次不足：${log.length}/${expectedBatches}`);
  for(const [i,b] of log.entries()) {
    if(b.outcome!=='completed'||!counter(b.genBefore)||b.genStarted!==b.genBefore+1||b.genAfter!==b.genStarted||b.runningAfter!==false) problems.push(`batch ${i} 未完成或世代不匹配`);
    if(b.requestedSeeds!==expectedSeeds||b.seedsDeclared!==true) problems.push(`batch ${i} 种子规模不匹配`);
    if(b.rows!==5||!Array.isArray(b.algorithms)||b.algorithms.join(',')!==ALGORITHMS.join(',')) problems.push(`batch ${i} 算法身份/顺序不完整`);
    if(!Array.isArray(b.metrics)||b.metrics.length!==5||b.metrics.some(row=>!Array.isArray(row)||row.length!==6||row.some(n=>!finite(n)||n<0)||row[0]>row[1]||row[3]>100)) problems.push(`batch ${i} 五算法指标不合法`);
    if(b.resultGeneration!==undefined&&b.resultGeneration!==b.genStarted) problems.push(`batch ${i} 结果来自旧世代`);
    if(b.resultSeeds!==undefined&&(!Array.isArray(b.resultSeeds)||b.resultSeeds.length!==expectedSeeds||b.resultSeeds.some(n=>!counter(n))||new Set(b.resultSeeds).size!==expectedSeeds)) problems.push(`batch ${i} 结果种子无效`);
  }
  return {ok:problems.length===0,problems};
}
