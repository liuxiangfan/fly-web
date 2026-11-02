import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSoakArgs, heapVerdict, validateReconnectEvents, validateBatch, validateSamples } from './soak-contract.mjs';

test('CLI uses strict booleans, finite positive numbers and rejects combined modes', () => {
  const x = parseSoakArgs(['--batch=false', '--reconnect', '--allow-no-heap=false', '--seconds=600', '--drop-every=3', '--output=out/reconnect.json']);
  assert.equal(x.batch, false); assert.equal(x.reconnect, true); assert.equal(x.allowNoHeap, false);
  assert.equal(x.dropEvery, 3); assert.equal(x.output, 'out/reconnect.json');
  assert.equal(parseSoakArgs(['--batch', '--seeds=3']).seeds, 3);
  for (const args of [['--batch', '--reconnect'], ['--batch=no'], ['--seconds=NaN'], ['--interval=0'], ['--seconds=-1'], ['--seeds=1.5'], ['--drop-every=Infinity'], ['--heap-limit-mb=-1'], ['--unknown']]) assert.throws(() => parseSoakArgs(args));
});
test('heap exemption is NOT_MEASURED, may continue gate, never erases measurements', () => {
  const empty = heapVerdict([null, null], 24, false);
  assert.equal(empty.heapMeasured, false); assert.equal(empty.heapOk, false);
  assert.equal(empty.heapStatus, 'NOT_MEASURED'); assert.equal(empty.heapWaived, false); assert.equal(empty.heapGateOk, false);
  assert.equal(empty.heapGrowMb, null); assert.equal(empty.heapPeakGrowthMb, null); assert.equal(empty.heapTrendMb, null);
  assert.equal(empty.heapPeakLimitMb, 48, '峰值上限默认是增长上限的两倍');
  const waived = heapVerdict([null, null], 24, true);
  assert.equal(waived.heapStatus, 'NOT_MEASURED'); assert.equal(waived.heapOk, false); assert.equal(waived.heapGateOk, true); assert.equal(waived.heapWaived, true);
  assert.equal(heapVerdict([10, 10, 40], 24, true).heapGateOk, false);
  assert.equal(heapVerdict([10, 11, 12], 24, true).heapMeasured, true);
  assert.equal(heapVerdict([NaN, Infinity], 24, true).heapGateOk, false);
  assert.equal(heapVerdict(['10', '11'], 24, true).heapGateOk, false);
});
test('heap verdict checks start→end growth, transient peak and linear trend together', () => {
  // ① 中途尖峰后回落：起终点差为 0，靠「峰值增量」兜住（只看终点差会漏）
  const spike = heapVerdict([10, 20, 60, 20, 20, 20], 24, false);
  assert.equal(spike.heapGrowMb, 0);
  assert.equal(spike.heapPeakGrowthMb, 40);
  assert.equal(spike.heapGateOk, true, '40 MB 峰值增量在 2×上限（48）内属可接受波动');
  // ② 单调爬升：起终点差、峰值增量与趋势三项全部超限
  const runaway = heapVerdict([10, 20, 60, 90, 120], 24, false);
  assert.equal(runaway.heapGrowMb, 100);
  assert.equal(runaway.heapGateOk, false);
  assert.ok(runaway.heapTrendMb > 24, `趋势必须超限：${runaway.heapTrendMb}`);
  // ③ 慢泄漏被末点 GC 掩盖：起终点差只有 10 MB、峰值增量 48 未超 2×上限，
  //    但趋势（拟合窗口内总增长）反映持续爬升 → 必须判失败
  const masked = heapVerdict([10, 20, 30, 40, 60, 68, 68, 30], 24, false);
  assert.equal(masked.heapGrowMb, 10);
  assert.equal(masked.heapPeakOk, true);
  assert.ok(masked.heapTrendMb > 24, `趋势必须抓出慢泄漏：${masked.heapTrendMb}`);
  assert.equal(masked.heapGateOk, false);
  // ④ 只有两点时无法拟合趋势：不假装有结论，但起点→终点仍然生效
  const twoPoint = heapVerdict([10, 11], 24, false);
  assert.equal(twoPoint.heapTrendMb, null);
  assert.equal(twoPoint.heapTrendOk, true);
});
test('heap growth never compares the last sample with itself (two-point samples)', () => {
  // 两点样本：必须从第一个实测点算，[10,200] 是真增长 190 MB，不能算成 0 MB
  const two = heapVerdict([10, 200], 24, true);
  assert.equal(two.heapMeasured, true); assert.equal(two.heapGrowMb, 190); assert.equal(two.heapGateOk, false);
  assert.equal(heapVerdict([null, 10, 200], 24, true).heapGrowMb, 190);
  assert.equal(heapVerdict([200, 10], 24, true).heapGrowMb, -190);
  assert.equal(heapVerdict([200, 10], 24, true).heapGateOk, true, '堆下降是好事');
  // 三点及以上才跳过首个 warm-up 点
  assert.equal(heapVerdict([10, 20, 30], 24, false).heapGrowMb, 10);
  assert.equal(heapVerdict([10, 200, 210], 24, false).heapGrowMb, 10);
  assert.equal(heapVerdict([10, 20, 200], 24, false).heapGateOk, false);
});
const snapshot = (count, at, t) => ({ count, at, t });
const events = () => [
  {type:'open', segment:1, at:0, consumption:snapshot(0,0,0)},
  {type:'firstFrame', segment:1, at:10, consumption:snapshot(1,10,.01)},
  {type:'drop', segment:1, at:100, consumption:snapshot(10,90,.1)},
  {type:'open', segment:2, at:1100, consumption:snapshot(10,90,.1)},
  {type:'firstFrame', segment:2, at:1110, consumption:snapshot(11,1110,.11)},
];
test('every dropped segment requires its own open and actual consumed first frame', () => {
  assert.equal(validateReconnectEvents(events()).ok, true);
  const bad = events(); bad[4].consumption.count = 10;
  assert.equal(validateReconnectEvents(bad).ok, false);
  assert.equal(validateReconnectEvents(events().filter(e=>e.type!=='firstFrame')).ok, false);
  assert.equal(validateReconnectEvents(events().slice(0,3)).ok, false);
  const hidden = events(); hidden.splice(4,0,{type:'drop',segment:2,at:1200,consumption:snapshot(10,90,.1)},{type:'open',segment:3,at:2200,consumption:snapshot(10,90,.1)}); hidden[6].segment=3; hidden[6].at=2210; hidden[6].consumption.at=2210;
  assert.equal(validateReconnectEvents(hidden).ok, false);
  const wrongTime=events(); wrongTime[4].consumption.at=1000;
  assert.equal(validateReconnectEvents(wrongTime).ok,false);
  const noDrop=events().slice(0,2); assert.equal(validateReconnectEvents(noDrop).ok,false);
});
const batch = () => ({outcome:'completed', genBefore:3, genStarted:4, genAfter:4, runningAfter:false, requestedSeeds:3, seedsDeclared:true, algorithms:['pure','comp','mahony','madg','kalman'], rows:5, metrics:Array.from({length:5},()=>[1,2,1,0,1,2])});
test('batch demands five algorithms, exact requested seeds, matching generation and batch count', () => {
  assert.equal(validateBatch([batch()],3,1).ok,true);
  assert.equal(validateBatch([batch(),batch(),batch()],3).ok,true);
  assert.equal(validateBatch([batch()],3).ok,false, '只跑成一批不得判 PASS');
  assert.equal(validateBatch([batch(),batch()],3,3).ok,false);
  assert.equal(validateBatch([batch(),batch(),batch(),batch()],3,3).ok,false);
  for(const changes of [{genAfter:2},{genStarted:5,genAfter:5},{rows:1},{algorithms:['pure','pure','mahony','madg','kalman']},{requestedSeeds:10},{seedsDeclared:false},{metrics:[[NaN]]},{runningAfter:true}]) assert.equal(validateBatch([{...batch(),...changes}],3,1).ok,false);
  assert.equal(validateBatch([],3).ok,false);
});
test('capacity and serial counters must be finite, positive and monotonic', () => {
  const s={t:1,at:1,logRows:0,logRowsCap:10,rawRows:0,rawRowsCap:10,charts:[0],chartCaps:[10],insTrail:0,insTrailCap:10,serialQueue:0,serialQueueCap:128,serialFrames:10,consumedFrames:10};
  assert.equal(validateSamples([s,{...s,t:2,at:2,serialFrames:11,consumedFrames:11}]).ok,true);
  for(const changes of [{logRowsCap:0},{charts:[]},{serialFrames:0},{t:0},{insTrail:NaN},{serialQueueCap:0}]) assert.equal(validateSamples([s,{...s,at:2,...changes}]).ok,false);
});
