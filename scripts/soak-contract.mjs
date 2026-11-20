/** Pure soak acceptance contracts, shared by runner and negative tests. */
export const ALGORITHMS = ['pure','comp','mahony','madg','kalman'];
export function parseSoakArgs(argv) {
  const raw={};
  const allowed=new Set(['url','seconds','interval','heapLimitMb','allowNoHeap','seeds','batch','reconnect','teaching','dropEvery','output','profileRoot','tailObserveSeconds']);
  for(const arg of argv) {
    const m=/^--([a-zA-Z][a-zA-Z-]*)(?:=(.*))?$/.exec(arg);
    if(!m) throw new Error(`非法 CLI 参数 ${arg}`);
    const k=m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(!allowed.has(k) || Object.hasOwn(raw,k)) throw new Error(`未知或重复参数 ${k}`);
    raw[k]=m[2]??'true';
  }
  // tailObserveSeconds 允许为 0（= 不做追加观察）；其余数值参数必须为正
  const nonNegative=(k,fallback)=>{const value=raw[k]??String(fallback);if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${k} 必须是非负数`);const n=Number(value);if(!Number.isFinite(n)||n<0) throw new Error(`${k} 必须是非负数`);return n;};const bool=k=> { const v=raw[k]??'false'; if(v!=='true'&&v!=='false') throw new Error(`${k} 必须是 true/false`); return v==='true'; };
  const num=(k,fallback,integer=false)=> {
    const value=raw[k]??String(fallback);
    if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${k} 必须是有限正数`);
    const n=Number(value); if(!Number.isFinite(n)||n<=0||(integer&&!Number.isSafeInteger(n))) throw new Error(`${k} 必须是${integer?'正整数':'有限正数'}`);
    return n;
  };
  const result={url:raw.url,seconds:num('seconds',120),interval:num('interval',5000),heapLimitMb:num('heapLimitMb',24),allowNoHeap:bool('allowNoHeap'),seeds:num('seeds',10,true),batch:bool('batch'),reconnect:bool('reconnect'),teaching:bool('teaching'),dropEvery:num('dropEvery',8),output:raw.output??'docs/generated/soak.json',profileRoot:raw.profileRoot,tailObserve:nonNegative('tailObserveSeconds',90)};
  if([result.batch,result.reconnect,result.teaching].filter(Boolean).length>1) throw new Error('--batch / --reconnect / --teaching 只能选一种负载');
  if(result.seeds>1000) throw new Error('seeds 超过 1000');
  if(!result.output.trim() || result.output==='true') throw new Error('output 必须是路径');
  return result;
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const counter=v=>Number.isSafeInteger(v)&&v>=0;
/** 批量 soak 必须跑满的批次数：验收的是「连续多批不串世代/不残留隐藏资源」，
 *  只跑成一批就判 PASS 等于把「时间不够」伪装成「通过」。 */
export const SOAK_BATCH_RUNS = 3;
/**
 * 末段判据的参数（**先定好再测**，见 SW-08）：
 *   · `TAIL_MIN_SAMPLES = 20`：实测点少于 20（≈100 s @5 s）时不做末段判据——
 *     样本太少的序列分不清"尾窗相位"与"真增长"，此时写"证据不足"，**不默认通过**；
 *     真实验收（600 s @5 s = 120 点）永远落在判据生效区间，且器集脚本另有采样覆盖检查兜底。
 *   · `TAIL_MIN_SUSTAINED = 3`：尾窗里**持续**高于「前段水位 + 增长上限」的样本数下限。
 *   · `TAIL_AT_FLOOR_MAX = 0.2`：尾窗里"回到水位附近"的样本占比上限——锯齿波总会回落，
 *     真泄漏不会。
 */
export const TAIL_MIN_SAMPLES = 20;
export const TAIL_MIN_SUSTAINED = 3;
export const TAIL_AT_FLOOR_MAX = 0.2;
const median=(arr)=>{const a=[...arr].sort((x,y)=>x-y);const n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
const windowSlope=(arr)=>{const n=arr.length;if(n<3) return null;const xm=(n-1)/2,ym=arr.reduce((a,b)=>a+b,0)/n;let num=0,den=0;for(let i=0;i<n;i++){num+=(i-xm)*(arr[i]-ym);den+=(i-xm)**2;}return (den>0?num/den:0)*(n-1);};
/**
 * 末段"翘尾"判据（SW-08）：只靠水位/峰值/全程趋势会漏掉下面这种真泄漏——
 * **前 95 个点都 15 MB，最后 5 个跳到 55 MB**（上限 24）：水位差 0、峰值增量 40（< 2×上限）、
 * 全程趋势约 11.3，三项全部通过，但尾巴明显翘起来了。
 *
 * 判据只看"末段的水位是否整体抬高"，用四件事互相印证（都是稳健统计量）：
 *   · `tailFloorRiseMb` = 尾窗最低点 − 前段最低点（水位；锯齿的相位不影响最低点）；
 *   · `tailSustained`   = 末段 10% 窗口里高于「前段水位 + 上限」的样本数；
 *   · `tailAtFloor`     = 尾窗里回到水位附近的样本占比（锯齿波会回落，泄漏不会）；
 *   · 末两点是否仍在高位（末点刚好被 GC 回收时要按回落处理）。
 * 四者同时成立才判 **SUSPECT**——不是直接判失败，而是要求器集脚本追加「停载后的回落观察」：
 * 停载后回落 → 峰值波动；停载后仍高 → 泄漏。这样既抓得住翘尾，也不会把 GC 相位判成泄漏。
 * 样本不足 → INSUFFICIENT：报告必须写"证据不足/继续观察"，不默认通过。
 */
export function tailVerdict(values,limit) {
  const measured=Array.isArray(values)?values.filter(finite):[];
  const threshold=finite(limit)&&limit>0?limit:null;
  const base={tailMeasured:false,tailSuspect:false,tailStatus:'INSUFFICIENT',tailWindow:null,tailFloorMb:null,baseFloorMb:null,tailFloorRiseMb:null,tailSustained:null,tailAtFloor:null,tailMedianMb:null,tailTrendMb:null,tailEvidence:[]};
  if(measured.length<2) return {...base,tailEvidence:['实测点不足两个，无法做末段判据——证据不足，不能据此判通过']};
  const baselineIdx=measured.length>=3?1:0;
  const windowed=measured.slice(baselineIdx);
  if(windowed.length<TAIL_MIN_SAMPLES||threshold===null) {
    return {...base,tailEvidence:[`实测点只有 ${windowed.length} 个（末段判据需要 ≥ ${TAIL_MIN_SAMPLES} 个且需要有效的增长上限 ${String(limit)}）——证据不足，不能据此判通过`]};
  }
  const k=Math.max(5,Math.round(windowed.length*0.05));
  const tail=windowed.slice(-k);
  const head=windowed.slice(0,Math.max(k,Math.floor(windowed.length/2)));
  const tailFloor=Math.min(...tail), baseFloor=Math.min(...head);
  const floorRise=tailFloor-baseFloor;
  const recent=windowed.slice(-Math.max(5,Math.round(windowed.length*0.1)));
  const sustained=recent.filter(v=>v>baseFloor+threshold).length;
  const atFloor=tail.filter(v=>v<=baseFloor+threshold/2).length/tail.length;
  const lastTwoElevated=Math.min(...tail.slice(-2))>baseFloor+threshold/2;
  const evidence=[];
  if(floorRise>threshold) evidence.push(`尾窗水位 ${tailFloor.toFixed(1)} MB 比前段水位 ${baseFloor.toFixed(1)} MB 高 ${floorRise.toFixed(1)} MB（上限 ${threshold} MB）`);
  if(sustained>=TAIL_MIN_SUSTAINED) evidence.push(`末段 ${recent.length} 个样本里有 ${sustained} 个高于「前段水位 + 上限」`);
  const suspect=floorRise>threshold&&sustained>=TAIL_MIN_SUSTAINED&&atFloor<TAIL_AT_FLOOR_MAX&&lastTwoElevated;
  return {tailMeasured:true,tailSuspect:suspect,tailStatus:suspect?'SUSPECT':'PASS',tailWindow:k,tailFloorMb:tailFloor,baseFloorMb:baseFloor,tailFloorRiseMb:floorRise,tailSustained:sustained,tailAtFloor:atFloor,tailMedianMb:median(tail),tailTrendMb:windowSlope(tail),
    tailEvidence:suspect?[...evidence,'必须追加「停载后的回落观察」：停载后回落=峰值波动，停载后仍高=泄漏（不能只凭这一次就放行）']:[]};
}
/**
 * 采样覆盖（SW-08 第 5 条）：**墙钟**必须真的被覆盖到，而不是只数样本个数。
 *
 * 三个数各有含义，混用就会误判（本轮实测踩到过）：
 *   · **墙钟跨度**（`at`）：必须覆盖请求时长（≥95%）——这是"真的跑了 600 s"的判据；
 *   · **仿真时钟推进**（`t`）：软件渲染 + 批量评测占主线程时，仿真时钟只能推进到墙钟的
 *     30%~50%（本机 600 s 实测 283.3 s / 0.47）。所以这里用**历史一致的下限 30%**，
 *     目的是抓"主循环被卡死/标签页被冻结"（推进趋近 0），不是要求仿真时间跑满墙钟;
 *   · **采样最大空洞**（`at`）：单次间隔超过 4 倍采样周期（且 >5 s）说明中途失联。
 * 判据只看事实，不改结论——但拿错阈值会把一次正常长稳判成失败，所以阈值写在这里并写清来源。
 */
export const SIM_CLOCK_MIN_RATIO = 0.3;
export function sampleCoverageProblems(samples,{seconds,interval}={}) {
  const problems=[];
  if(!Array.isArray(samples)||samples.length<2) return ['样本不足两个'];
  const times=samples.map(s=>s?.t).filter(finite);
  const walls=samples.map(s=>s?.at).filter(finite);
  if(times.length>=2) {
    const simSpan=times[times.length-1]-times[0];
    const wallSpan=walls.length>=2?(walls[walls.length-1]-walls[0])/1000:null;
    if(finite(seconds)&&wallSpan!==null && wallSpan<seconds*0.95) {
      problems.push(`墙钟只覆盖了 ${wallSpan.toFixed(1)} s（期望 ≥ ${(seconds*0.95).toFixed(0)} s）——中途失联或被提前结束`);
    }
    if(finite(seconds)&&simSpan<seconds*SIM_CLOCK_MIN_RATIO) {
      problems.push(`仿真时钟只推进了 ${simSpan.toFixed(1)} s（期望 ≥ ${(seconds*SIM_CLOCK_MIN_RATIO).toFixed(0)} s，即墙钟的 ${(SIM_CLOCK_MIN_RATIO*100).toFixed(0)}%）——主循环可能被阻塞`);
    }
  } else {
    problems.push('样本里的仿真时钟不可用');
  }
  let maxGap=0, maxGapAt=0;
  for(let i=1;i<samples.length;i++) {
    const prev=samples[i-1]?.at, cur=samples[i]?.at;
    if(!finite(prev)||!finite(cur)) continue;
    const gap=(cur-prev)/1000;
    if(gap>maxGap){maxGap=gap;maxGapAt=i;}
  }
  if(finite(interval)&&maxGap>Math.max(interval/1000*4,5)) problems.push(`采样最大空洞 ${maxGap.toFixed(1)} s（第 ${maxGapAt} 点，期望 < ${Math.max(interval/1000*4,5)} s）`);
  if(finite(seconds)&&finite(interval)) {
    const expected=Math.floor(seconds/(interval/1000))+1;
    if(samples.length<expected*0.6) problems.push(`样本数只有 ${samples.length} 个（${seconds} s / ${interval/1000} s 期望约 ${expected} 个）`);
  }
  return problems;
}
export function heapVerdict(values,limit,allowNoHeap=false,{tailResolved=false}={}) {
  const malformed=!Array.isArray(values)||values.some(v=>v!==null&&!finite(v));
  const measured=Array.isArray(values)?values.filter(finite):[];
  const heapMeasured=measured.length>=2;
  // 跳过首个 warm-up 点需要**至少 3 个**实测点；只有两个点时从第一个实测值算。
  // 旧实现一律用 measured[1] 当基线：两点样本 [10,200] 会算成 0 MB 增长并 PASS。
  const baselineIdx=heapMeasured?(measured.length>=3?1:0):0;
  const baseline=heapMeasured?measured[baselineIdx]:null;
  const windowed=heapMeasured?measured.slice(baselineIdx):[];
  /**
   * 「常驻水位」增长：比较**首尾窗口各自的最低点**，而不是单看首尾两个采样。
   *
   * 为什么必须改（2026-11-03 实测）：`performance.memory.usedJSHeapSize` 是 GC 锯齿波——
   * 同一份代码三次 600 s 跑的「首→末」差分别是 +15.5 / +14.9 / **+25.0 MB**（上限 24）：
   * 第三次只是恰好起点落在波谷、终点落在波峰（那次水位只从 15.2 升到 18.7 MB）。
   * 用端点做判据，门禁就变成"掷骰子"，而这正是稳定性验收最不该有的性质。
   * 锯齿波里代表"常驻集"的是**每段窗口的最低点**（GC 刚回收后的水位）；
   * 真正的泄漏会让水位整体抬升，而相位噪声不会。
   *
   * 保留原语义的边界：实测点少于 6 个时没有"窗口"可言，退回首→末差（短序列用例与
   * 历史语义一致）；峰值增量与线性趋势两个判据照旧，慢泄漏仍然跑不掉。
   */
  const endpointMb=heapMeasured?measured[measured.length-1]-baseline:null;
  const heapGrowMb=(()=>{
    if(!heapMeasured) return null;
    if(windowed.length<6) return endpointMb;
    const k=Math.max(3,Math.round(windowed.length*0.2));
    const head=windowed.slice(0,k), tail=windowed.slice(-k);
    return Math.min(...tail)-Math.min(...head);
  })();
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
  /**
   * 末段判据（SW-08）与前三个判据**并列**：翘尾（SUSPECT）时不算通过，
   * 除非器集脚本追加了「停载后的回落观察」并观察到回落（`tailResolved`）。
   * 样本不足（INSUFFICIENT）也不算通过，但不把短序列（契约测试、百秒级冒烟长稳）
   * 判成泄漏——真实验收的采样覆盖由 `sampleCoverageProblems` 与器集脚本一起守住，
   * 于是"靠少采样躲开末段判据"这条捷径不成立。
   */
  const tail=tailVerdict(values,limit);
  const tailOk=tail.tailStatus==='PASS'||(tail.tailStatus==='SUSPECT'&&tailResolved===true);
  const tailRequired=tail.tailSuspect&&tailResolved!==true;
  const heapOk=!malformed&&heapGrowOk&&heapPeakOk&&heapTrendOk&&!tailRequired&&tailOk;
  const heapWaived=!malformed&&!heapMeasured&&allowNoHeap===true;
  return {heapMeasured,heapOk,heapStatus:malformed?'INVALID':heapMeasured?(heapOk?'PASS':'FAIL'):'NOT_MEASURED',heapWaived,heapGateOk:heapOk||heapWaived,heapGrowMb,heapEndpointMb:endpointMb,heapPeakGrowthMb,heapTrendMb,heapPeakOk,heapTrendOk,heapPeakLimitMb:peakLimit,
    // 末段判据原样带出去：报告要能回答"为什么这次算/不算通过"
    tailStatus:tail.tailSuspect&&tailResolved?'SUSPECT_RESOLVED':tail.tailStatus,tailSuspect:tail.tailSuspect,tailResolved:tailResolved===true,tailRequired,tailMeasured:tail.tailMeasured,tailWindow:tail.tailWindow,tailFloorMb:tail.tailFloorMb,baseFloorMb:tail.baseFloorMb,tailFloorRiseMb:tail.tailFloorRiseMb,tailSustained:tail.tailSustained,tailAtFloor:tail.tailAtFloor,tailMedianMb:tail.tailMedianMb,tailTrendMb:tail.tailTrendMb,tailEvidence:tail.tailEvidence};
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
