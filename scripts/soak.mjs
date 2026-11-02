/** Long soak acceptance. Run batch/reconnect separately; --output preserves distinct reports. */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSoakArgs, heapVerdict, validateReconnectEvents, validateBatch, validateSamples, ALGORITHMS, SOAK_BATCH_RUNS } from './soak-contract.mjs';

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
let reconnectEvents=[],browser;
let failure=null;
/**
 * 报告溯源（复核 6.5）：长稳报告必须能绑定「哪份代码、哪份产物、哪个浏览器、什么时间窗」。
 * 旧报告只有参数与样本，无法回答「这份 600 s 结论对应哪个 commit / 哪次构建」。
 */
const startedAt=new Date().toISOString();
const gitCommit=(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{return null;}})();
const distHash=(()=>{
  try {
    const walk=d=>readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)
      .flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);
    const h=createHash('sha256');
    for(const f of walk(join(root,'dist'))) h.update(f.slice(root.length)).update(readFileSync(f));
    return h.digest('hex').slice(0,16);
  } catch { return null; }
})();
let browserVersion=null;
try {
  browser=await puppeteer.launch({executablePath,userDataDir:profile,headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  browserVersion=await browser.version();
  const page=await browser.newPage();
  await page.setViewport({width:1280,height:900});
  page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text().slice(0,300));});
  page.on('pageerror',e=>consoleErrors.push(`pageerror: ${String(e).slice(0,300)}`));
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
} catch(e) {failure=e instanceof Error?e.message:String(e);consoleErrors.push(failure);}
finally {if(browser) await browser.close();}

const heap=heapVerdict(samples.map(s=>s.heapMb),args.heapLimitMb,args.allowNoHeap);
const capacity=validateSamples(samples);
const recovery=args.reconnect?validateReconnectEvents(reconnectEvents):{ok:true,problems:[],drops:0,recovered:0};
const batch=args.batch?validateBatch(batchLog,args.seeds,SOAK_BATCH_RUNS):{ok:true,problems:[]};
const first=samples[0],last=samples.at(-1);
const clockAdvanced=!!first&&!!last&&capacity.ok&&(args.reconnect?last.t>first.t:last.t-first.t>args.seconds*.3);
const errorsOk=consoleErrors.length===0;
const verdict={errorsOk,capped:capacity.ok,...heap,clockAdvanced,clockGrowthSec:first&&last?last.t-first.t:null,reconnectOk:recovery.ok,reconnectRecoveryOk:recovery.ok,actualDrops:recovery.drops,recoveredSegments:recovery.recovered,batchOk:batch.ok,problems:[...capacity.problems,...recovery.problems,...batch.problems],consoleErrors,pass:errorsOk&&capacity.ok&&heap.heapGateOk&&clockAdvanced&&recovery.ok&&batch.ok};
const report={generatedAt:new Date().toISOString(),commit:gitCommit,distHash,browserVersion,startedAt,finishedAt:new Date().toISOString(),url,seconds:args.seconds,intervalMs:args.interval,withBatch:args.batch,withReconnect:args.reconnect,expectedSeeds:args.seeds,batchesExpected:args.batch?SOAK_BATCH_RUNS:0,dropEverySec:args.dropEvery,heapLimitMb:args.heapLimitMb,allowNoHeap:args.allowNoHeap,output,profile,samples,batchLog,reconnectEvents,failure,verdict};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
console.log(`溯源：commit ${gitCommit??'未知'}、dist ${distHash??'未知'}、浏览器 ${browserVersion??'未知'}、窗口 ${startedAt} → ${report.finishedAt}`);
console.log(`[${heap.heapStatus}] 堆：起点→终点 ${heap.heapGrowMb===null?'无足够测量':heap.heapGrowMb.toFixed(1)+' MB'}`+
  `；峰值增量 ${heap.heapPeakGrowthMb===null?'n/a':heap.heapPeakGrowthMb.toFixed(1)+' MB（上限 '+heap.heapPeakLimitMb+'）'}`+
  `；线性趋势 ${heap.heapTrendMb===null?'样本不足，未拟合':heap.heapTrendMb.toFixed(1)+' MB（上限 '+args.heapLimitMb+'）'}`+
  `${heap.heapWaived?'（显式豁免，仅 gate 继续；不是 PASS）':''}`);
console.log(`[${verdict.pass?'PASS':'FAIL'}] 长稳门禁${verdict.problems.length?'：'+verdict.problems.join('；'):''}`);
console.log(`报告：${output}`);process.exit(verdict.pass?0:1);
