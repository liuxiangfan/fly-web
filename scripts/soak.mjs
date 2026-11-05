/** Long soak acceptance. Run batch/reconnect separately; --output preserves distinct reports. */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSoakArgs, heapVerdict, sampleCoverageProblems, validateReconnectEvents, validateBatch, validateSamples, ALGORITHMS, SOAK_BATCH_RUNS } from './soak-contract.mjs';
import { sourceDigest, worktreeState } from './source-digest.mjs';
import { distHashOf, readProvenance } from './build-provenance.mjs';
import { captureIdentity, captureDriftProblems, fetchServedProvenance, identityProblems } from './served-build.mjs';

let args;
try { args=parseSoakArgs(process.argv.slice(2)); } catch(e) { console.error(`[FAIL] ${e.message}`); process.exit(2); }
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,args.output);
const url=args.url??process.env.SHOT_URL??'http://127.0.0.1:4173/';
const candidates=[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Users/32988/AppData/Local/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean);
const executablePath=candidates.find(p=>existsSync(p));
if(!executablePath) {console.error('找不到 Chrome/Edge，可用 CHROME_PATH 指定');process.exit(2);}
// Chromium profile never falls back to C: TEMP on this D:-hosted project.
const tempRoot=resolve(args.profileRoot??(/^[dD]:[\\/]/.test(process.env.TEMP??'')?process.env.TEMP:join(root,'.audit-current','soak-profiles')));
if(process.platform==='win32'&&!/^[dD]:[\\/]/.test(tempRoot)) {console.error('[FAIL] profileRoot 必须在 D 盘');process.exit(2);}
mkdirSync(tempRoot,{recursive:true});
const profile=mkdtempSync(join(tempRoot,'profile-'));
const samples=[], batchLog=[], consoleErrors=[];
/** 追加观察阶段的样本与结论（SW-08）：与主阶段分开记录，不能替代 600 s 连续负载 */
const tailSamples=[];
let tailPhase={ran:false,seconds:0,samples:0,settledMb:null,baseFloorMb:null,fellBack:null,note:'未触发（末段水位不可疑）'};
let reconnectEvents=[],browser;
let failure=null;
/**
 * 报告溯源（复核 6.5）：长稳报告必须能绑定「哪份代码、哪份产物、哪个浏览器、什么时间窗」。
 * 旧报告只有参数与样本，无法回答「这份 600 s 结论对应哪个 commit / 哪次构建」。
 */
const startedAt=new Date().toISOString();
/**
 * 源码摘要（复核 6.5 的加强版）：commit SHA 只能指向"某个提交"，未提交的工作树会让它撒谎。
 * sourceDigest 覆盖全部参与构建的源码文件（含未跟踪的新文件），dirty/clean 另记一栏。
 */
const source = sourceDigest(root);
const worktree = worktreeState(root);
const gitCommit=(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{return null;}})();
// 产物摘要用**统一算法**（scripts/build-provenance.mjs），并与构建期写下的溯源交叉核对：
// 不一致说明"报告跑的 dist"和"它声称的源码"不是同一次构建（复核 SW-06）。
const distHash = distHashOf(join(root,'dist'));
const provenance = readProvenance(join(root,'dist'));
const buildId = provenance?.buildId ?? null;
const provenanceProblems = provenance
  ? [
      provenance.distHash !== distHash ? `产物摘要不一致（溯源 ${provenance.distHash} / 实测 ${distHash}）` : null,
      provenance.sourceDigest !== source.digest ? `源码摘要不一致（溯源 ${String(provenance.sourceDigest).slice(0,12)} / 实测 ${source.digest.slice(0,12)}）` : null,
    ].filter(Boolean)
  : ['缺少 dist/build-provenance.json：本次采集无法绑定构建'];
if (provenanceProblems.length) console.warn(`[warn] 构建溯源有问题：${provenanceProblems.join('；')}`);
// 采集起点的身份快照：结束时重算，源码或产物变了就把整次验收作废（复核 SW-06：不给旧结果贴新摘要）
const identityBefore = captureIdentity(root);
let servedProblems = [];
let driftProblems = [];
let browserVersion=null;
try {
  browser=await puppeteer.launch({executablePath,userDataDir:profile,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  browserVersion=await browser.version();
  const page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text().slice(0,300));});
  page.on('pageerror',e=>consoleErrors.push(`pageerror: ${String(e).slice(0,300)}`));
  // 开跑前先核对「被测服务跑的产物」与本地刚构建的产物是同一份，并取回页面自报的 buildId
  servedProblems = identityProblems({
    localProvenance: provenance, served: await fetchServedProvenance(url), distDir: join(root,'dist'),
    pageBuild: await page.evaluate(()=>window.attitudeDemo?.build?.()??null),
  });
  if (servedProblems.length) console.warn(`[warn] 被测产物身份核对：${servedProblems.join('；')}`);
  if(args.reconnect) await page.evaluateOnNewDocument(dropEveryMs=>{
    const enc=new TextEncoder();
    let tick=0,stream=null,timer=0,segment=0;
    const state=window.__soak={opens:0,drops:0,events:[],freezeDrops:false,current:null,readConsumption:()=>({count:0,at:0,t:0})};
    const record=(type,consumption=state.readConsumption())=>{
      const at=type==='firstFrame'?consumption.at:Date.now();
      state.events.push({type,segment,at,consumption:{...consumption}});
    };
    state.consume=consumption=>{
      if(state.current&&!state.current.first&&consumption.count>state.current.baseline) {
        state.current.first=true;record('firstFrame',consumption);
      }
    };
    const port={
      open:async()=>{
        clearInterval(timer);segment++;state.opens++;
        const baseline=state.readConsumption();state.current={baseline:baseline.count,first:false};record('open',baseline);
        const openedAt=Date.now();
        stream=new ReadableStream({start(controller){
          timer=setInterval(()=>{
            if(!state.freezeDrops&&Date.now()-openedAt>=dropEveryMs) {
              clearInterval(timer);timer=0;state.drops++;record('drop');state.current=null;
              controller.error(new Error('device disconnected'));return;
            }
            tick+=.01;
            try {controller.enqueue(enc.encode(`${tick.toFixed(3)},1.5,-2.5,0.3,0.1,0.2,9.8,32.8,0,37.7\n`));}
            catch {clearInterval(timer);timer=0;}
          },10);
        },cancel(){clearInterval(timer);timer=0;}});
      },
      close:async()=>{clearInterval(timer);timer=0;},
      get readable(){return stream;},
    };
    Object.defineProperty(navigator,'serial',{configurable:true,value:{requestPort:async()=>port}});
  },args.dropEvery*1000);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.getElementById('fps')?.textContent!=='-- fps',{timeout:20000});
  await page.evaluate(wantReconnect=>{
    const api=window.attitudeDemo;
    if(wantReconnect) {
      if(typeof api.serialConsumption!=='function'||typeof api.installSerialConsumptionObserver!=='function') throw new Error('缺少真实串口消费观测 API，请重新构建');
      window.__soak.readConsumption=()=>api.serialConsumption();
      api.installSerialConsumptionObserver(snapshot=>window.__soak.consume(snapshot));
    }
    const set=(id,value)=>{const el=document.getElementById(id);if(!el) throw new Error(`缺少控件 ${id}`);if(el.type==='checkbox'){if(el.checked!==value) el.click();return;}el.value=String(value);el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));};
    set('raw-record-toggle',true);set('solve-rate',500);set('imu-delay',8);set('imu-delay-skew',6);set('imu-bandwidth',40);set('imu-sample-rate',100);
    document.getElementById('sec-imu')?.classList.remove('collapsed');
    if(wantReconnect){set('serial-protocol','text');document.getElementById('btn-serial').click();}
  },args.reconnect);
  const sample=async()=>page.evaluate(()=>{
    const api=window.attitudeDemo,s=api.sizes(),p=api.plumbing();
    const consumption=api.serialConsumption?.()??{count:0,at:0,t:0};
    const heap=performance.memory?.usedJSHeapSize??null;
    return {at:Date.now(),t:s.simTime,logRows:s.logRows,logRowsCap:s.logRowsCap,rawRows:s.rawRows,rawRowsCap:s.rawRowsCap,charts:s.charts.map(c=>c.count),chartCaps:s.charts.map(c=>c.cap),insTrail:s.insTrailMax,insTrailCap:s.insTrailCap,serialQueue:s.serialQueue,serialQueueCap:s.serialQueueCap,heapMb:heap===null?null:heap/1024/1024,fps:document.getElementById('fps')?.textContent??'',serialFrames:p.frames,consumedFrames:consumption.count,consumption,reconnects:p.reconnects,serialRunning:p.serial,reconnectPending:p.reconnectPending,sourceKind:p.sourceKind,drops:window.__soak?.drops??0,opens:window.__soak?.opens??0,batchGeneration:api.experiment.batchState().generation};
  });
  const t0=Date.now();samples.push(await sample());
  while(Date.now()-t0<args.seconds*1000) {
    await new Promise(r=>setTimeout(r,Math.min(args.interval,Math.max(1,args.seconds*1000-(Date.now()-t0)))));
    if(args.batch&&batchLog.length<SOAK_BATCH_RUNS&&(Date.now()-t0)>Math.min(10000,args.seconds*100)) {
      const startedAt=Date.now();
      const genBefore=await page.evaluate(()=>window.attitudeDemo.experiment.batchState().generation);
      const start=await page.evaluate(seeds=>{
        const sel=document.getElementById('batch-runs');
        const value=String(seeds);
        if(![...sel.options].some(o=>o.value===value)) sel.add(new Option(`${seeds} 次 × 10 s`,value));
        sel.value=value;sel.dispatchEvent(new Event('change'));
        document.getElementById('btn-batch').click();
        return window.attitudeDemo.experiment.batchState();
      },args.seeds);
      let outcome=start.running&&start.generation===genBefore+1?'timeout':'not-started';
      if(outcome==='timeout') try {
        await page.waitForFunction(gen=>{
          const s=window.attitudeDemo.experiment.batchState();
          return s.generation===gen&&!s.running&&(document.getElementById('batch-status')?.textContent??'').startsWith('完成');
        },{timeout:120000},start.generation);outcome='completed';
      } catch {outcome='timeout';}
      const after=await page.evaluate(()=>({state:window.attitudeDemo.experiment.batchState(),result:window.attitudeDemo.experiment.batchResult?.()??null,status:document.getElementById('batch-status')?.textContent??'',cells:[...document.querySelectorAll('#batch-table tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()))}));
      const labels=await page.evaluate(()=>window.attitudeDemo.experiment.run(0.002).metrics.map(m=>({id:m.id,label:m.label})));
      const algorithms=after.cells.map(row=>labels.find(m=>m.label===row[0])?.id??'UNKNOWN');
      const metrics=after.cells.map(row=>row.slice(1).map(cell=>/^\d+(?:\.\d+)?[°%]$/.test(cell)?Number(cell.slice(0,-1)):NaN));
      const entry={index:batchLog.length+1,outcome,elapsedMs:Date.now()-startedAt,genBefore,genStarted:start.generation,genAfter:after.state.generation,runningAfter:after.state.running,requestedSeeds:args.seeds,rows:after.cells.length,algorithms,metrics,seedsDeclared:new RegExp(`^完成：${args.seeds} 个种子 ×`).test(after.status),resultGeneration:after.result?.generation??null,resultSeeds:after.result?.seeds??null,resultAlgorithms:after.result?.summary?.map(m=>m.id)??null};
      // API result evidence is mandatory, DOM rows alone cannot prove this batch owns them.
      if(entry.resultAlgorithms?.join(',')!==ALGORITHMS.join(',')) entry.outcome='invalid-result';
      batchLog.push(entry);
    }
    const s=await sample();samples.push(s);
    console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] t=${s.t.toFixed(1)} log=${s.logRows}/${s.logRowsCap} raw=${s.rawRows}/${s.rawRowsCap} heap=${s.heapMb===null?'n/a':s.heapMb.toFixed(1)+'MB'} frames=${s.serialFrames} consumed=${s.consumedFrames} drops=${s.drops}`);
  }
  if(args.reconnect) {
    // Stop new injections; resolve every already emitted drop, not just aggregate reconnect count.
    await page.evaluate(()=>{window.__soak.freezeDrops=true;});
    try {await page.waitForFunction(()=>{const s=window.__soak;return s.drops>0&&s.current?.first===true;},{timeout:10000});}catch { /* pure contract reports missing recovery */ }
    await page.evaluate(()=>{
      const s=window.__soak,c=s.readConsumption();
      if(s.current) s.events.push({type:'end',segment:s.opens,at:Date.now(),consumption:{...c}});
    });
    samples.push(await sample());
    reconnectEvents=await page.evaluate(()=>window.__soak.events);
  }
  /**
   * 末段翘尾的**追加观察**（SW-08）：主负载跑完后若末段水位可疑（SUSPECT），
   * 就再跑一段"停载后的回落观察"——不再发起新的批量评测，只让页面主循环继续跑，
   * 并按同样的间隔采样。停载后回落到水位附近=峰值波动；仍停在高位=真泄漏。
   *
   * 这是一个**独立尾随阶段**（`--tail-observe-seconds`，默认 90 s）：它**不代替**
   * 要求的连续 600 s 负载（时长判据只看主阶段），也只在可疑时才跑——稳定运行的长稳不会因此变长。
   */
  const loadHeap=heapVerdict(samples.map(s=>s.heapMb),args.heapLimitMb,args.allowNoHeap);
  if(loadHeap.tailSuspect&&args.tailObserve>0&&!failure) {
    console.log(`[tail] 末段水位可疑（${loadHeap.tailEvidence.join('；')}）→ 停载后回落观察 ${args.tailObserve} s`);
    const tStop=Date.now();
    while(Date.now()-tStop<args.tailObserve*1000) {
      await new Promise(r=>setTimeout(r,Math.min(args.interval,Math.max(1,args.tailObserve*1000-(Date.now()-tStop)))));
      const s=await sample();
      tailSamples.push(s);
      console.log(`[tail ${((Date.now()-tStop)/1000).toFixed(1)}s] heap=${s.heapMb===null?'n/a':s.heapMb.toFixed(1)+'MB'} t=${s.t.toFixed(1)}`);
    }
    const observed=tailSamples.map(s=>s.heapMb).filter(v=>typeof v==='number'&&Number.isFinite(v));
    const floor=loadHeap.baseFloorMb;
    const settled=observed.length?Math.min(...observed):null;
    tailPhase={ran:true,seconds:args.tailObserve,samples:observed.length,settledMb:settled,baseFloorMb:floor,
      fellBack:settled!==null&&floor!==null&&settled<=floor+args.heapLimitMb/2,
      note:'停载=不再发起新的批量评测；页面主循环继续跑（它本来就是负载的一部分）。'};
    console.log(`[tail] 停载后最低水位 ${settled===null?'n/a':settled.toFixed(1)+'MB'}（前段水位 ${floor===null?'n/a':floor.toFixed(1)+'MB'}）→ ${tailPhase.fellBack?'已回落（判为峰值波动）':'仍未回落（判为泄漏）'}`);
  }
} catch(e) {failure=e instanceof Error?e.message:String(e);consoleErrors.push(failure);}
finally {if(browser) await browser.close();}

driftProblems = captureDriftProblems(root, identityBefore);
const provenanceAllProblems = [...provenanceProblems, ...servedProblems, ...driftProblems];
const heap=heapVerdict(samples.map(s=>s.heapMb),args.heapLimitMb,args.allowNoHeap,{tailResolved:tailPhase.ran===true&&tailPhase.fellBack===true});
/** 采样覆盖（SW-08 第 5 条）：墙钟推进、采样空洞、样本数——「样本不少」必须是事实而不是观感 */
const coverageProblems=sampleCoverageProblems(samples,{seconds:args.seconds,interval:args.interval});
const coverageOk=coverageProblems.length===0;
const capacity=validateSamples(samples);
const recovery=args.reconnect?validateReconnectEvents(reconnectEvents):{ok:true,problems:[],drops:0,recovered:0};
const batch=args.batch?validateBatch(batchLog,args.seeds,SOAK_BATCH_RUNS):{ok:true,problems:[]};
const first=samples[0],last=samples.at(-1);
const clockAdvanced=!!first&&!!last&&capacity.ok&&(args.reconnect?last.t>first.t:last.t-first.t>args.seconds*.3);
const errorsOk=consoleErrors.length===0;
const identityOk = provenanceAllProblems.length === 0;
const verdict={errorsOk,identityOk,coverageOk,coverageProblems,capped:capacity.ok,...heap,clockAdvanced,clockGrowthSec:first&&last?last.t-first.t:null,reconnectOk:recovery.ok,reconnectRecoveryOk:recovery.ok,actualDrops:recovery.drops,recoveredSegments:recovery.recovered,batchOk:batch.ok,problems:[...capacity.problems,...recovery.problems,...batch.problems,...coverageProblems],identityProblems:provenanceAllProblems,consoleErrors,pass:errorsOk&&identityOk&&coverageOk&&capacity.ok&&heap.heapGateOk&&clockAdvanced&&recovery.ok&&batch.ok};
const report={generatedAt:new Date().toISOString(),commit:gitCommit,sourceDigest:source.digest,sourceFiles:source.files,worktree,buildId,distHash,provenanceProblems,servedProblems,driftProblems,browserVersion,startedAt,finishedAt:new Date().toISOString(),url,seconds:args.seconds,intervalMs:args.interval,withBatch:args.batch,withReconnect:args.reconnect,expectedSeeds:args.seeds,batchesExpected:args.batch?SOAK_BATCH_RUNS:0,dropEverySec:args.dropEvery,heapLimitMb:args.heapLimitMb,allowNoHeap:args.allowNoHeap,tailObserveSeconds:args.tailObserve,output,profile,samples,tailSamples,tailPhase,batchLog,reconnectEvents,failure,verdict};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
console.log(`溯源：commit ${gitCommit??'未知'}（工作树 ${worktree??'未知'}）、源码摘要 ${source.digest}（${source.files} 个文件）、构建 ${buildId??'（未溯源）'}、dist ${distHash??'未知'}、浏览器 ${browserVersion??'未知'}、窗口 ${startedAt} → ${report.finishedAt}`);
console.log(`[${heap.heapStatus}] 堆：常驻水位 ${heap.heapGrowMb===null?'无足够测量':heap.heapGrowMb.toFixed(1)+' MB'}`+
  `（首尾窗口最低点之差；同一段数据的端点差是 ${heap.heapEndpointMb===null?'n/a':heap.heapEndpointMb.toFixed(1)+' MB'}——`+
  `GC 锯齿波的相位不影响判定）`+
  `；峰值增量 ${heap.heapPeakGrowthMb===null?'n/a':heap.heapPeakGrowthMb.toFixed(1)+' MB（上限 '+heap.heapPeakLimitMb+'）'}`+
  `；线性趋势 ${heap.heapTrendMb===null?'样本不足，未拟合':heap.heapTrendMb.toFixed(1)+' MB（上限 '+args.heapLimitMb+'）'}`+
  `${heap.heapWaived?'（显式豁免，仅 gate 继续；不是 PASS）':''}`);
console.log(`[末段] ${heap.tailStatus}`+
  (heap.tailFloorMb===null?'':
    `：尾窗水位 ${heap.tailFloorMb.toFixed(1)} MB（前段 ${heap.baseFloorMb.toFixed(1)} MB，抬升 ${heap.tailFloorRiseMb.toFixed(1)} MB）、`+
    `持续超阈 ${heap.tailSustained} 个、回到水位占比 ${(heap.tailAtFloor*100).toFixed(0)}%`)+
  (heap.tailEvidence.length?`（${heap.tailEvidence.join('；')}）`:''));
if(tailPhase.ran) console.log(`[末段观察] 停载后 ${tailPhase.seconds} s：最低 ${tailPhase.settledMb===null?'n/a':tailPhase.settledMb.toFixed(1)+' MB'} → ${tailPhase.fellBack?'已回落':'未回落'}`);
console.log(`[采样覆盖] ${coverageOk?'PASS':'FAIL'}：${samples.length} 个样本 / 仿真时钟推进 ${((samples.at(-1)?.t??0)-(samples[0]?.t??0)).toFixed(1)} s`+(coverageOk?'':`（${coverageProblems.join('；')}）`));
console.log(`[${verdict.pass?'PASS':'FAIL'}] 长稳门禁${verdict.problems.length?'：'+verdict.problems.join('；'):''}`);
console.log(`报告：${output}`);process.exit(verdict.pass?0:1);
