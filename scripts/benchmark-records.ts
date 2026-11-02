/**
 * 文档基准生成器：把「会漂移的手写数字」变成可复算的 JSON。
 *
 * 运行：npm run benchmark
 * 产物：docs/generated/benchmarks.json（提交进仓库；CI 只跑小规模 doccheck，不重跑全量）
 *
 * 每条记录必须带：配置、种子列表、时间窗、样本量、指标。
 * 文档通过 `data-benchmark="id"` 引用 id；`npm run doccheck` 会校验引用存在，
 * 避免出现「文档引用了不存在的基准」或「基准更新了但文档仍写旧值」。
 */
import { defaultExperimentConfig } from "../src/core/experiment-config";
import { runExperiment, runMonteCarlo } from "../src/core/runner";
import { coningSweep } from "../src/core/coning";
import {
  REF_GRAVITY_NED,
  REF_MAG_NORTH_NED,
  syntheticObservations,
  triad,
  wahbaQuest,
  attitudeErrorDeg,
} from "../src/core/attitude-determination";
import { calibrateAccel, synthesizeAccelSamples } from "../src/core/accelcal";
import { qFromEuler, RAD } from "../src/core/quat";

const round = (v: number, d = 6): number => (Number.isFinite(v) ? Number(v.toFixed(d)) : NaN);
const roundRec = <T extends Record<string, unknown>>(o: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === "number" ? round(v) : v;
  return out as T;
};

/**
 * 每条基准一个**惰性构造器**：只有真的需要时才计算。
 * 这一点对门禁很重要——doccheck 静态 import 本模块只为拿渲染函数，
 * 若记录在模块加载时就算，`npm run doccheck` 会白白多花 8 s（复核实测）。
 */
const builders: Record<string, () => unknown> = {};

// 1) 悬停默认配置：多种子配对 RMSE 分布（五种算法）
builders["hover-default-30s"] = () => {
  const cfg = defaultExperimentConfig();
  cfg.durationSec = 30;
  cfg.seed = 0x5eed;
  const batch = runMonteCarlo(cfg, 10);
  return {
    config: { scenario: cfg.scenario, durationSec: cfg.durationSec, solveRateHz: cfg.solveRateHz, seed: cfg.seed },
    seeds: batch.seeds,
    window: { startSec: 0, endSec: cfg.durationSec },
    samplesPerRun: Math.round(cfg.durationSec * cfg.solveRateHz),
    metrics: batch.summary.map((s) => roundRec({
      id: s.id,
      rmseP50: s.rmseP50,
      rmseP95: s.rmseP95,
      steadyRmseP95: s.steadyRmseP95,
      nonConvergedPct: s.nonConvergedPct,
      tiltRmseP95: s.tiltRmseP95,
      yawRmseP95: s.yawRmseP95,
    })),
  };
};

// 2) 卡尔曼统计一致性：NIS/NEES（有真值的仿真）
builders["kalman-consistency-30s"] = () => {
  const cfg = defaultExperimentConfig();
  cfg.durationSec = 30;
  cfg.seed = 0x1234;
  const r = runExperiment(cfg);
  const k = r.metrics.find((m) => m.id === "kalman")!;
  return {
    config: { scenario: cfg.scenario, durationSec: cfg.durationSec, seed: cfg.seed, gate: "angle40" },
    metrics: roundRec({
      rmse: k.rmse,
      neesThetaMean: k.neesThetaMean ?? NaN,
      neesBiasMean: k.neesBiasMean ?? NaN,
      nisAccelMean: k.nisAccelMean ?? NaN,
      nisMagMean: k.nisMagMean ?? NaN,
      accelAcceptPct: k.accelAcceptPct ?? NaN,
    }),
    note: "NEES 姿态自由度为 3、零偏自由度为 3；NIS 观测自由度为 3。严重大于自由度说明滤波器过度自信（协方差偏小或 R 偏小）。",
  };
};

// 3) 圆锥误差 sweep
builders["coning-sweep"] = () => {
  return {
    config: { freqHz: 12, ampDps: 120, durationSec: 4, refHz: 20000 },
    points: coningSweep({ freqHz: 12, ampDps: 120, durationSec: 4 }),
  };
};

// 4) TRIAD / Wahba 干净解
builders["wahba-clean"] = () => {
  const qTrue = qFromEuler(25 * RAD, -35 * RAD, 70 * RAD);
  const obs = syntheticObservations(qTrue, [REF_GRAVITY_NED, REF_MAG_NORTH_NED]);
  const tri = triad(obs);
  const que = wahbaQuest(obs);
  return {
    config: { eulerDeg: [25, -35, 70], noiseDeg: [0, 0] },
    metrics: {
      triadErrDeg: tri ? attitudeErrorDeg(tri.q, qTrue) : NaN,
      questErrDeg: que ? attitudeErrorDeg(que.q, qTrue) : NaN,
    },
  };
};

// 5) 加速度计六面校准恢复精度
builders["accel-six-face"] = () => {
  const M = [1.02, 0.02, -0.01, -0.015, 0.98, 0.03, 0.02, -0.012, 1.01];
  const cal = calibrateAccel(synthesizeAccelSamples(M, [0.05, -0.03, 0.08], 0.02, 99));
  return {
    config: { model: "raw=M·true+bias", noiseMs2: 0.02, seed: 99 },
    metrics: {
      rmseX: cal ? cal.rmse[0] : NaN,
      rmseY: cal ? cal.rmse[1] : NaN,
      rmseZ: cal ? cal.rmse[2] : NaN,
      faces: cal ? cal.faces.length : 0,
    },
  };
};


/**
 * 构造基准记录（纯函数、确定性）。
 * @param cheapOnly 只算「秒内可复算」的三条（TRIAD/Wahba、六面加计、圆锥 sweep）——
 *   `npm run check` 里的 doccheck 用它做只读复算；全量（含 10 种子蒙特卡洛）留给
 *   `npm run doccheck -- --recompute` 与 CI。
 */
export function buildBenchmarkRecords(cheapOnly = false): Record<string, unknown> {
  const keep = ["coning-sweep", "wahba-clean", "accel-six-face"];
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(builders)) {
    if (cheapOnly && !keep.includes(k)) continue;
    out[k] = f();
  }
  return out;
}

/* --------------------------------------------------------------------------
   正文数字绑定：把存档渲染成一段可被 doccheck 逐字核对的 HTML 片段。
   -------------------------------------------------------------------------- */
export const BENCH_BLOCK_BEGIN = "<!-- BENCH:BEGIN 由 npm run benchmark 生成；改算法/参数后重跑，不要手改 -->";
export const BENCH_BLOCK_END = "<!-- BENCH:END -->";

const fmt = (v: unknown, d = 2): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");

/**
 * 由存档渲染文档里的「可复算基准数字」块。
 *
 * 为什么要有它（复核 6.3）：`data-benchmark` 只是"引用了某个 id"，正文里的数字
 * 仍然可以手工写着旧值而没人发现。这里让正文数字**由存档生成**，
 * doccheck 再用同一个渲染函数核对一遍——正文与存档只能一起改。
 */
export function renderBenchmarkBlock(recordsIn: Record<string, unknown>): string {
  const R = recordsIn as Record<string, Record<string, unknown>>;
  const rows: string[] = [];
  const hover = R["hover-default-30s"]?.metrics as Array<Record<string, number | string>> | undefined;
  const mahony = hover?.find((m) => m.id === "mahony");
  const kalmanRow = hover?.find((m) => m.id === "kalman");
  if (mahony) {
    // 参数（时长/种子数/样本量）必须来自**记录本身**，不能是手写常量——
    // 否则改了生成器（例如 5 s×50 Hz）而正文仍宣称"30 s/10 种子/15000 样本"也能通过（ROUND12）
    const hoverCfg = R["hover-default-30s"] as Record<string, unknown>;
    const cfg = (hoverCfg.config ?? {}) as Record<string, number>;
    const seedCount = Array.isArray(hoverCfg.seeds) ? (hoverCfg.seeds as unknown[]).length : 0;
    const samples = Number(hoverCfg.samplesPerRun ?? 0);
    const dur = Number(cfg.durationSec ?? 0);
    rows.push(
      `<li><b>悬停 ${dur} s</b>（${seedCount} 种子配对，${samples} 样本/次）：Mahony RMSE P50 <span class="mono">${fmt(mahony.rmseP50)}°</span>、` +
        `稳态 P95 <span class="mono">${fmt(mahony.steadyRmseP95)}°</span>；` +
        `卡尔曼 RMSE P50 <span class="mono">${fmt(kalmanRow?.rmseP50)}°</span>、` +
        `稳态 P95 <span class="mono">${fmt(kalmanRow?.steadyRmseP95)}°</span></li>`,
    );
  }
  const kRec = R["kalman-consistency-30s"] as Record<string, unknown> | undefined;
  const k = kRec?.metrics as Record<string, number> | undefined;
  if (k) {
    // 时长同样取自记录配置：正文写死 30 s 时，把生成器改成 20 s 再重跑也能"通过"（复核 8）
    const kDur = Number((kRec?.config as Record<string, number> | undefined)?.durationSec ?? 0);
    rows.push(
      `<li><b>卡尔曼一致性</b>（${kDur} s）：姿态 NEES <span class="mono">${fmt(k.neesThetaMean)}</span>（自由度 3）、` +
        `重力 NIS <span class="mono">${fmt(k.nisAccelMean)}</span>、` +
        `重力接受率 <span class="mono">${fmt(k.accelAcceptPct, 1)}%</span></li>`,
    );
  }
  const cRec = R["coning-sweep"] as Record<string, { freqHz?: number; ampDps?: number; durationSec?: number } | number | unknown[]> | undefined;
  const pts = cRec?.points as Array<{ rateHz: number; errDeg: number }> | undefined;
  if (pts) {
    // 圆锥剧本的激励（频率/幅值/时长）也必须来自记录：写死 12 Hz / 120°/s 时改生成器测不出（复核 8）
    const cCfg = (cRec?.config ?? {}) as Record<string, number>;
    const sorted = [...pts].sort((a, b) => b.rateHz - a.rateHz);
    rows.push(
      `<li><b>圆锥误差-采样率</b>（${fmt(cCfg.freqHz, 0)} Hz / ${fmt(cCfg.ampDps, 0)}°/s，${fmt(cCfg.durationSec, 0)} s，以 ${fmt(cCfg.refHz, 0)} Hz 为参考）：` +
        sorted.map((p) => `${p.rateHz} Hz <span class="mono">${fmt(p.errDeg, 3)}°</span>`).join(" → ") +
        `——误差随采样率下降而单调上升</li>`,
    );
  }
  const w = R["wahba-clean"]?.metrics as Record<string, number> | undefined;
  if (w) {
    rows.push(
      `<li><b>TRIAD / QUEST 干净解</b>：误差 <span class="mono">${fmt(w.triadErrDeg, 6)}°</span> / ` +
        `<span class="mono">${fmt(w.questErrDeg, 6)}°</span>（1e-12 量级）</li>`,
    );
  }
  const aRec = R["accel-six-face"] as Record<string, unknown> | undefined;
  const a = aRec?.metrics as Record<string, number> | undefined;
  if (a) {
    // 「几面」取自记录（合成样本数 / 6 面），不再写死
    const aCfg = (aRec?.config ?? {}) as Record<string, number>;
    const faces = Number.isFinite(a.faces) ? a.faces : Number.isFinite(aCfg.faces) ? Number(aCfg.faces) : 6;
    rows.push(
      `<li><b>六面加计校准恢复</b>：残差 RMS x/y/z = <span class="mono">${fmt(a.rmseX, 4)}</span> / ` +
        `<span class="mono">${fmt(a.rmseY, 4)}</span> / <span class="mono">${fmt(a.rmseZ, 4)}</span> m/s²（${faces} 面）</li>`,
    );
  }
  return [BENCH_BLOCK_BEGIN, `<ul class="bench-numbers">`, ...rows, `</ul>`, BENCH_BLOCK_END].join("\n");
}
