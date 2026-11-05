import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSoakArgs, heapVerdict, sampleCoverageProblems, tailVerdict, validateReconnectEvents, validateBatch, validateSamples } from './soak-contract.mjs';

test('CLI uses strict booleans, finite positive numbers and rejects combined modes', () => {
  const x = parseSoakArgs(['--batch=false', '--reconnect', '--allow-no-heap=false', '--seconds=600', '--drop-every=3', '--output=out/reconnect.json']);
  assert.equal(x.batch, false); assert.equal(x.reconnect, true); assert.equal(x.allowNoHeap, false);
  assert.equal(x.dropEvery, 3); assert.equal(x.output, 'out/reconnect.json');
  assert.equal(parseSoakArgs(['--batch', '--seeds=3']).seeds, 3);
  // SW-08：追加观察阶段可显式关闭（0），默认 90 s；负数/非数必须被拒
  assert.equal(parseSoakArgs(['--batch']).tailObserve, 90);
  assert.equal(parseSoakArgs(['--batch', '--tail-observe-seconds=0']).tailObserve, 0);
  for (const bad of ['--tail-observe-seconds=-1', '--tail-observe-seconds=abc']) assert.throws(() => parseSoakArgs(['--batch', bad]));
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
  // 去掉基准点后只有 5 个点，不足 6 → 无窗口可言，退回首→末差（末点回到 20，故为 0）
  const spike = heapVerdict([10, 20, 60, 20, 20, 20], 24, false);
  assert.equal(spike.heapGrowMb, 0);
  assert.equal(spike.heapEndpointMb, 0, '端点差单独记录（窗口不足时它就是判据本身）');
  assert.equal(spike.heapPeakGrowthMb, 40);
  assert.ok(spike.heapPeakOk, '40 MB 峰值增量在 2×上限（48）内属可接受波动');
  // 6 个实测点做不了末段判据：判"证据不足"（SW-08 起不再默认通过），并说明原因
  assert.equal(spike.tailStatus, 'INSUFFICIENT');
  assert.equal(spike.heapGateOk, false, '样本不足不许默认通过（要追加观察或跑满时长）');
  assert.ok(spike.tailEvidence[0].includes('证据不足'), spike.tailEvidence[0]);
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

test('堆判据必须对 GC 锯齿波的相位不敏感（否则稳定性门禁变成掷骰子）', () => {
  // 真实反例（2026-11-03 实测）：同一份代码三次 600 s 的「首→末」差是 +15.5 / +14.9 / +25.0 MB（上限 24）——
  // 第三次只是起点落在波谷、终点落在波峰（那次常驻水位只从 15.2 升到 18.7 MB）。
  const saw = [15, 15];
  for (let i = 0; i < 20; i++) saw.push(i % 2 ? 40 : 15);
  saw.push(41); // 结尾停在波峰
  const v = heapVerdict(saw, 24, false);
  assert.ok(v.heapEndpointMb > 24, `端点差确实超限：${v.heapEndpointMb}`);
  assert.ok(v.heapGrowMb <= 24, `水位没有抬升：${v.heapGrowMb}`);
  assert.equal(v.heapGateOk, true, '锯齿波相位不得把稳定运行的堆判成泄漏');

  // 反向对照：水位真的抬升（首窗最低 15 → 尾窗最低 60）必须判失败
  const rising = [15, 15, 20, 25, 30, 35, 55, 60, 62, 60, 61, 60];
  const r = heapVerdict(rising, 24, false);
  assert.ok(r.heapGrowMb > 24, `水位抬升必须被抓出：${r.heapGrowMb}`);
  assert.equal(r.heapGateOk, false);

  // 少于 6 个实测点时没有窗口可言：退回首→末差（历史语义），不能因此放行真增长
  assert.equal(heapVerdict([15, 41], 24, false).heapGrowMb, 26);
  assert.equal(heapVerdict([15, 41], 24, false).heapGateOk, false);
  assert.equal(heapVerdict([15, 15, 20, 25, 41], 24, false).heapGrowMb, 26, '5 个点仍用首→末差');
});

test('SW-08 末段翘尾：最后 5 个点跳 +40 MB 不能被水位/峰值/趋势三项放过', () => {
  // 复核给的原反例：warm-up 15，随后 95 个 15，最后 5 个 55（上限 24）。
  // 水位差 0、峰值增量 40（< 48）、全程趋势 ≈11.3 → 旧判据 PASS。
  const leak = [15, ...Array(95).fill(15), ...Array(5).fill(55)];
  const v = heapVerdict(leak, 24, false);
  assert.ok(v.heapGrowMb <= 24, `水位判据确实看不见它：${v.heapGrowMb}`);
  assert.ok(v.heapPeakOk, '峰值增量在 2×上限内');
  assert.ok(v.heapTrendMb <= 24, `全程趋势也不超限：${v.heapTrendMb}`);
  assert.equal(v.tailStatus, 'SUSPECT', '末段水位抬升 + 持续超阈 + 不回落 → 必须进入追加观察');
  assert.equal(v.heapGateOk, false, '未做回落观察前不能判通过');
  assert.ok(v.tailFloorRiseMb > 24, `尾窗水位抬升要报出来：${v.tailFloorRiseMb}`);
  assert.ok(v.tailSustained >= 3, `持续超阈样本数：${v.tailSustained}`);
  assert.ok(v.tailEvidence.some((e) => e.includes('回落观察')), '必须写清"要追加停载后回落观察"');

  // 追加观察后仍高 → 仍判失败
  const stillHigh = heapVerdict(leak, 24, false, { tailResolved: false });
  assert.equal(stillHigh.heapGateOk, false);
  // 停载后回落到水位附近 → 按预设规则判为峰值波动，放行（并留下"已回落"的证据）
  const fellBack = heapVerdict(leak, 24, false, { tailResolved: true });
  assert.equal(fellBack.tailStatus, 'SUSPECT_RESOLVED');
  assert.equal(fellBack.heapGateOk, true, '回落观察确认后才是通过');
});

test('SW-08 末段判据不得把 GC 锯齿判成泄漏（不同首尾相位、阶跃、短峰后回落）', () => {
  // ① 交替锯齿（振幅 25 > 上限 24），尾窗停在波峰：水位没抬升 → 不 SUSPECT
  const sawPeak = [15, 15, ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 40 : 15)), 41];
  const a = heapVerdict(sawPeak, 24, false);
  assert.equal(a.tailStatus, 'PASS', `锯齿波停在波峰不得判 SUSPECT：${JSON.stringify(a.tailEvidence)}`);
  assert.equal(a.heapGateOk, true);
  // ② 同一段锯齿，尾窗停在波谷 → 同样不得误报
  const sawFloor = [41, 40, ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 40 : 15))];
  assert.equal(heapVerdict(sawFloor, 24, false).heapGateOk, true);
  // ③ 平台阶跃（前半 15、后半 40，抬升 25 > 上限）→ 水位判据自己就抓住，且末段也 SUSPECT
  const step = [...Array(50).fill(15), ...Array(50).fill(40)];
  const b = heapVerdict(step, 24, false);
  assert.equal(b.heapGateOk, false);
  assert.equal(b.tailStatus, 'SUSPECT');
  // ④ 短峰后回落（末段冲到 60 又回到 15）：尾窗有回落样本 → 不 SUSPECT
  const spike = [...Array(95).fill(15), 60, 60, 60, 15, 15];
  const c = heapVerdict(spike, 24, false);
  assert.equal(c.tailStatus, 'PASS', `末段回落属于峰值波动：${JSON.stringify(c.tailEvidence)}`);
  // ⑤ 平滑爬升（每个点 +0.4 MB，全程 +40）：峰值增量超限 → 失败
  const smooth = Array.from({ length: 101 }, (_, i) => 15 + i * 0.4);
  const d = heapVerdict(smooth, 24, false);
  assert.equal(d.heapGateOk, false);
  // ⑥ 末点恰逢 GC（前 4 个尾窗点高、最后一点回到水位）：不 SUSPECT，且水位判据也不过限
  const gcTail = [...Array(96).fill(15), 55, 55, 55, 55, 15];
  const e = heapVerdict(gcTail, 24, false);
  assert.ok(e.heapGrowMb <= 24, `水位差不过限：${e.heapGrowMb}`);
  assert.equal(e.tailStatus, 'PASS', `末点回落到水位应按预设规则处理：${JSON.stringify(e.tailEvidence)}`);
});

test('SW-08 采样不足/时长不足不许默认通过，采样覆盖问题要逐条说清', () => {
  // 样本不足：判 INSUFFICIENT 并写明原因，不判 SUSPECT、也不判 PASS
  const few = heapVerdict(Array(12).fill(20), 24, false);
  assert.equal(few.tailStatus, 'INSUFFICIENT');
  assert.equal(few.heapGateOk, false);
  assert.ok(few.tailEvidence[0].includes('证据不足'));
  // 显式豁免堆测量时仍可继续门禁，但豁免≠通过（历史语义不许被这次改动改写）
  const waived = heapVerdict([null, null], 24, true);
  assert.equal(waived.heapWaived, true);
  assert.equal(waived.heapStatus, 'NOT_MEASURED');

  // 采样覆盖：墙钟跨度、仿真时钟推进下限、采样空洞、样本数、时钟不可用
  // 口径（本轮实测校准）：墙钟必须覆盖请求时长；仿真时钟只需 ≥30%（软件渲染 + 批量评测下
  // 本机 600 s 实测只推进 283.3 s / 0.47，拿"仿真时间跑满墙钟"当判据会把正常长稳判红）
  const at = (i) => i * 5000;
  const good = Array.from({ length: 30 }, (_, i) => ({ t: i * 5, at: at(i) }));
  assert.deepEqual(sampleCoverageProblems(good, { seconds: 145, interval: 5000 }), []);
  // 仿真时钟推进低于 30%：主循环被阻塞/页面冻结
  assert.ok(sampleCoverageProblems(good.map((s) => ({ ...s, t: s.t * 0.1 })), { seconds: 145, interval: 5000 }).some((p) => p.includes('仿真时钟只推进')));
  // 墙钟没跑满（提前结束/中途失联）
  const short = good.filter((s) => s.at <= 60000);
  assert.ok(sampleCoverageProblems(short, { seconds: 145, interval: 5000 }).some((p) => p.includes('墙钟只覆盖了')));
  // 真实本机 600 s 长稳的那组数字必须通过（回归：不许再把正常运行判红）
  const realish = Array.from({ length: 117 }, (_, i) => ({ t: i * 2.42, at: i * 5128 }));
  assert.deepEqual(sampleCoverageProblems(realish, { seconds: 600, interval: 5000 }), []);
  const gapped = good.map((s, i) => (i >= 20 ? { ...s, at: s.at + 60000 } : s));
  assert.ok(sampleCoverageProblems(gapped, { seconds: 145, interval: 5000 }).some((p) => p.includes('采样最大空洞')));
  assert.ok(sampleCoverageProblems(good.slice(0, 8), { seconds: 600, interval: 5000 }).some((p) => p.includes('样本数只有')));
  assert.ok(sampleCoverageProblems([{ t: NaN, at: 0 }, { t: 1, at: 1 }], { seconds: 10, interval: 1000 }).some((p) => p.includes('时钟不可用')));
  assert.ok(sampleCoverageProblems([], { seconds: 10, interval: 1000 }).some((p) => p.includes('样本不足')));
});
test('heap growth never compares the last sample with itself (two-point samples)', () => {
  // 两点样本：必须从第一个实测点算，[10,200] 是真增长 190 MB，不能算成 0 MB
  const two = heapVerdict([10, 200], 24, true);
  assert.equal(two.heapMeasured, true); assert.equal(two.heapGrowMb, 190); assert.equal(two.heapGateOk, false);
  assert.equal(heapVerdict([null, 10, 200], 24, true).heapGrowMb, 190);
  assert.equal(heapVerdict([200, 10], 24, true).heapGrowMb, -190);
  // 堆下降是好事，但两点样本没有末段证据：判"证据不足"而不是"通过"（SW-08）
  assert.equal(heapVerdict([200, 10], 24, true).tailStatus, 'INSUFFICIENT');
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
