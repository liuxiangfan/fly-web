/**
 * 目录外部化契约（Node，无 DOM）：
 *
 *  1. public/data 下四份 JSON 都能解析为顶层数组；
 *  2. 每份 JSON 与 TS 真源逐项深相等（experiments / challenges / TOUR_STEPS / activities）；
 *  3. 序列化是确定性的：稳定键序、2 空格缩进、末尾恰好一个换行；
 *  4. id 非空且唯一，条数为 19 实验 / 3 挑战 / 13 引导步骤 / 5 学习活动；
 *  5. 必填字段与跨目录引用（tour.exp → experiments.id、activity.evidence.experimentId）完整。
 *
 * 运行：npx tsx scripts/catalog-contract.test.ts（已并入 npm run contracts）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXPERIMENTS, type ExperimentSpec } from "../src/ui/experiments";
import { CHALLENGES, type ChallengeSpec } from "../src/ui/challenges";
import { LEARNING_ACTIVITIES } from "../src/ui/learning-activity-data";
import type { EvidencePredicate, LearningActivity } from "../src/ui/learning-activities";
import { COMPARISON_VARIABLE_IDS } from "../src/core/comparison-config";
import {
  LEARNING_CLAIMS,
  claimsForPage,
  findClaim,
  type LearningClaimAction,
} from "../src/ui/learning-claims";
import {
  CATALOG_FILES,
  TOUR_STEPS,
  catalogDocuments,
  serializeCatalog,
} from "./emit-catalog";
import type { TourStep } from "../src/ui/tour";

let pass = 0;
let fail = 0;
function test(name: string, body: () => void): void {
  try {
    body();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

type CatalogKey = keyof typeof CATALOG_FILES;
const KEYS = Object.keys(CATALOG_FILES) as CatalogKey[];

const fileOf = (key: CatalogKey): URL => new URL(`../public/data/${CATALOG_FILES[key]}`, import.meta.url);
const textOf = (key: CatalogKey): string => readFileSync(fileOf(key), "utf8");
const valueOf = (key: CatalogKey): unknown => JSON.parse(textOf(key));
const arrayOf = (key: CatalogKey): unknown[] => {
  const value = valueOf(key);
  assert.ok(Array.isArray(value), `${CATALOG_FILES[key]} 顶层不是数组`);
  return value;
};
const idsOf = (items: unknown[]): string[] =>
  items.map((item, i) => {
    assert.ok(item && typeof item === "object" && !Array.isArray(item), `第 ${i} 项不是对象`);
    const id = (item as Record<string, unknown>).id;
    assert.equal(typeof id, "string", `第 ${i} 项缺少字符串 id`);
    assert.ok((id as string).length > 0, `第 ${i} 项 id 为空`);
    return id as string;
  });

const docs = catalogDocuments();

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const docPageIds = new Set([...indexHtml.matchAll(/data-doc-page="([^"]+)"/g)].map((m) => m[1]));
const labsPageStart = indexHtml.indexOf('<article id="labs"');
const labsPageEnd = indexHtml.indexOf('<article id="guide"', labsPageStart);
assert.ok(labsPageStart >= 0 && labsPageEnd > labsPageStart, "index.html 的 labs 文档页边界不完整");
const labsHtml = indexHtml.slice(labsPageStart, labsPageEnd);
const claimPlaceholders = [...labsHtml.matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]);

test("TS 源就是生成源（catalogDocuments 与全部数组一致）", () => {
  assert.deepStrictEqual(docs.experiments, EXPERIMENTS);
  assert.deepStrictEqual(docs.challenges, CHALLENGES);
  assert.deepStrictEqual(docs.tour, TOUR_STEPS);
  assert.deepStrictEqual(docs.activities, LEARNING_ACTIVITIES);
});

for (const key of KEYS) {
  test(`${CATALOG_FILES[key]} 可解析为顶层数组`, () => {
    const items = arrayOf(key);
    assert.ok(items.length > 0, "数组为空");
  });

  test(`${CATALOG_FILES[key]} 与 TS 源逐项深相等`, () => {
    assert.deepStrictEqual(valueOf(key), docs[key]);
  });

  test(`${CATALOG_FILES[key]} 序列化确定（稳定键序 / 2 空格 / 末尾换行）`, () => {
    const text = textOf(key);
    assert.equal(text, serializeCatalog(docs[key]), "文件内容不是 TS 源的确定性序列化结果");
    assert.equal(text, serializeCatalog(JSON.parse(text)), "反序列化后重排结果发生变化");
    assert.ok(text.endsWith("\n"), "缺少末尾换行");
    assert.ok(!text.endsWith("\n\n"), "末尾换行多于一个");
    const first = JSON.parse(text)[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    assert.deepStrictEqual(keys, [...keys].sort(), "对象键没有按稳定顺序输出");
  });

  test(`${CATALOG_FILES[key]} 的 id 非空且唯一`, () => {
    const ids = idsOf(arrayOf(key));
    assert.equal(new Set(ids).size, ids.length, `存在重复 id：${ids.join(", ")}`);
  });
}

test("预期条数：19 个实验 / 3 个挑战 / 13 步引导 / 5 道学习活动", () => {
  assert.equal(arrayOf("experiments").length, 19);
  assert.equal(arrayOf("challenges").length, 3);
  assert.equal(arrayOf("tour").length, 13);
  assert.equal(arrayOf("activities").length, 5);
});

test("实验必填字段完整", () => {
  const required = ["id", "name", "tag", "observe"] as const;
  for (const raw of arrayOf("experiments") as ExperimentSpec[]) {
    for (const key of required) {
      assert.equal(typeof raw[key], "string", `${raw.id}: ${key} 不是字符串`);
      assert.ok((raw[key] as string).length > 0, `${raw.id}: ${key} 为空`);
    }
    for (const key of ["sliders", "checks", "selects"] as const) {
      const map = raw[key];
      if (map !== undefined) assert.equal(typeof map, "object", `${raw.id}: ${key} 不是对象`);
    }
    if (raw.view !== undefined) assert.ok(["attitude", "gimbal", "quat"].includes(raw.view), `${raw.id}: 未知 view`);
  }
});

test("挑战必填字段与评分口径完整", () => {
  for (const raw of arrayOf("challenges") as ChallengeSpec[]) {
    for (const key of ["id", "name", "scene", "goal", "hint"] as const) {
      assert.equal(typeof raw[key], "string", `${raw.id}: ${key} 不是字符串`);
      assert.ok((raw[key] as string).length > 0, `${raw.id}: ${key} 为空`);
    }
    assert.ok(["comp", "mahony", "madg", "kalman"].includes(raw.grade.est), `${raw.id}: 未知评分算法`);
    assert.ok(Number.isFinite(raw.grade.limit) && raw.grade.limit > 0, `${raw.id}: 阈值非法`);
  }
});

test("学习活动必填字段、证据引用与选项判定口径完整", () => {
  const experimentIds = new Set((arrayOf("experiments") as ExperimentSpec[]).map((e) => e.id));
  const estimatorIds = new Set(["pure", "comp", "mahony", "madg", "kalman"]);
  const metricKeys = new Set([
    "n",
    "mean",
    "rmse",
    "max",
    "p50",
    "p95",
    "steadyRmse",
    "tiltRmse",
    "yawRmse",
    "convergedAt",
    "gateRejects",
  ]);
  for (const raw of arrayOf("activities") as LearningActivity[]) {
    for (const key of ["id", "title", "prompt", "conditionsText", "explanation"] as const) {
      assert.equal(typeof raw[key], "string", `${raw.id}: ${key} 不是字符串`);
      assert.ok((raw[key] as string).trim().length > 0, `${raw.id}: ${key} 为空`);
    }
    assert.ok(Number.isInteger(raw.version) && raw.version >= 1, `${raw.id}: version 非法`);
    assert.ok(["single", "multiple", "range"].includes(raw.answerKind), `${raw.id}: answerKind 非法`);
    assert.ok(metricKeys.has(raw.evidence.metric), `${raw.id}: metric 未登记`);
    assert.ok(estimatorIds.has(raw.evidence.estimatorId), `${raw.id}: estimatorId 非法`);
    if (raw.evidence.kind === "live") {
      assert.ok(raw.evidence.experimentId, `${raw.id}: live 证据缺 experimentId`);
      assert.ok(
        experimentIds.has(raw.evidence.experimentId!),
        `${raw.id}: 引用了不存在的实验 ${raw.evidence.experimentId}`,
      );
    } else {
      assert.ok(raw.evidence.comparisonVariableId, `${raw.id}: comparison 证据缺变量`);
    }
    assert.ok(raw.doc.page.trim().length > 0, `${raw.id}: doc.page 为空`);
    if (raw.doc.anchor !== undefined) assert.ok(raw.doc.anchor.trim().length > 0, `${raw.id}: anchor 为空`);
    if (raw.answerKind === "range") {
      assert.ok(raw.expectedRange, `${raw.id}: 数值题缺 expectedRange`);
      assert.ok(
        raw.expectedRange!.min < raw.expectedRange!.max,
        `${raw.id}: expectedRange 边界非法`,
      );
    } else {
      const choiceIds = new Set((raw.choices ?? []).map((choice) => choice.id));
      assert.ok(choiceIds.size >= 2, `${raw.id}: 选项不足`);
      assert.ok(Array.isArray(raw.correctChoiceIds) && raw.correctChoiceIds.length > 0, `${raw.id}: 缺 correctChoiceIds`);
      for (const choiceId of raw.correctChoiceIds!) {
        assert.ok(choiceIds.has(choiceId), `${raw.id}: correctChoiceIds 引用未知选项 ${choiceId}`);
      }
      if (raw.answerKind === "single") {
        assert.equal(raw.correctChoiceIds!.length, 1, `${raw.id}: 单选题正确项必须恰好一个`);
      }
    }
  }
});

test("学习活动证据模型：patch/predicate 完整且与正确项一致", () => {
  const estimatorIds = new Set(["pure", "comp", "mahony", "madg", "kalman"]);
  const metricKeys = new Set([
    "n",
    "mean",
    "rmse",
    "max",
    "p50",
    "p95",
    "steadyRmse",
    "tiltRmse",
    "yawRmse",
    "convergedAt",
    "gateRejects",
  ]);
  let patched = 0;
  let multiRun = 0;
  for (const raw of arrayOf("activities") as LearningActivity[]) {
    const runIds = new Set(["A"]);
    if (raw.evidencePatch) {
      patched++;
      const patch = raw.evidencePatch;
      assert.ok(
        Number.isFinite(patch.durationSec) && patch.durationSec > 0,
        `${raw.id}: patch.durationSec 非法`,
      );
      if (patch.scenario !== undefined) {
        assert.ok(typeof patch.scenario === "string" && patch.scenario.length > 0);
      }
      if (patch.imu) {
        for (const [key, value] of Object.entries(patch.imu)) {
          assert.ok(Number.isFinite(value as number), `${raw.id}: imu.${key} 非有限数值`);
        }
      }
      if (patch.estimators) {
        for (const [id, estPatch] of Object.entries(patch.estimators)) {
          assert.ok(estimatorIds.has(id), `${raw.id}: patch 未知算法 ${id}`);
          if (estPatch?.params) {
            for (const [key, value] of Object.entries(estPatch.params)) {
              assert.ok(Number.isFinite(value), `${raw.id}: patch ${id}.params.${key} 非有限数值`);
            }
          }
        }
      }
      if (patch.initialAttitude) {
        assert.ok(
          ["level", "fixed-axis", "random"].includes(patch.initialAttitude.kind),
          `${raw.id}: 初始姿态 kind 非法`,
        );
      }
    }
    for (const run of raw.evidenceRuns ?? []) {
      assert.ok(typeof run.id === "string" && run.id.length > 0, `${raw.id}: run.id 为空`);
      assert.equal(runIds.has(run.id), false, `${raw.id}: run.id 重复或占用 A`);
      runIds.add(run.id);
    }
    if (raw.evidenceRuns && raw.evidenceRuns.length > 0) {
      multiRun++;
      assert.ok(raw.evidencePatch, `${raw.id}: evidenceRuns 需要 evidencePatch 基线`);
    }
    if (raw.evidence.run !== undefined) {
      assert.ok(runIds.has(raw.evidence.run), `${raw.id}: evidence.run 指向不存在的运行`);
    }
    if (raw.evidencePredicates) {
      assert.notEqual(raw.answerKind, "range", `${raw.id}: 数值题不应带选项谓词`);
      const choices = new Map((raw.choices ?? []).map((choice) => [choice.id, choice]));
      assert.deepStrictEqual(
        Object.keys(raw.evidencePredicates).sort(),
        [...choices.keys()].sort(),
        `${raw.id}: 谓词必须覆盖全部选项`,
      );
      let hasMetric = false;
      for (const [choiceId, predicate] of Object.entries(raw.evidencePredicates)) {
        assert.ok(choices.has(choiceId), `${raw.id}: 谓词引用未知选项 ${choiceId}`);
        if (predicate.kind === "always-true" || predicate.kind === "always-false") continue;
        hasMetric = true;
        assert.ok(estimatorIds.has(predicate.estimator), `${raw.id}: 谓词 estimator 非法`);
        assert.ok(metricKeys.has(predicate.metric), `${raw.id}: 谓词 metric 未登记`);
        if (predicate.kind === "metric-range") {
          assert.ok(
            predicate.min !== undefined || predicate.max !== undefined,
            `${raw.id}: metric-range 缺边界`,
          );
        }
        if (predicate.kind === "metric-compare") {
          assert.ok(["gt", "lt", "eq"].includes(predicate.op), `${raw.id}: 未知比较算子`);
          assert.ok(Number.isFinite(predicate.value), `${raw.id}: 比较值非有限`);
        }
        if (predicate.kind === "metric-compare-runs") {
          assert.ok(["gt", "lt", "eq"].includes(predicate.op), `${raw.id}: 未知比较算子`);
          assert.ok(runIds.has(predicate.run), `${raw.id}: 谓词 run 未声明`);
          assert.ok(runIds.has(predicate.otherRun), `${raw.id}: 谓词 otherRun 未声明`);
          assert.notEqual(predicate.run, predicate.otherRun);
        }
      }
      if (hasMetric) assert.ok(raw.evidencePatch, `${raw.id}: 数值谓词需要 evidencePatch`);
      for (const choice of raw.choices ?? []) {
        const predicate: EvidencePredicate = raw.evidencePredicates[choice.id];
        const isCorrect = (raw.correctChoiceIds ?? []).includes(choice.id);
        if (isCorrect) {
          assert.notEqual(
            predicate.kind,
            "always-false",
            `${raw.id}: 正确项 ${choice.id} 不能 always-false`,
          );
        } else {
          assert.equal(
            predicate.kind,
            "always-false",
            `${raw.id}: 错误项 ${choice.id} 必须 always-false`,
          );
        }
      }
    }
  }
  assert.equal(patched, 4, "4 道数值/选项题需要 runner patch；几何题不需要");
  assert.equal(multiRun, 2, "Ki 题与偏航题需要多次运行");
});

test("引导步骤必填字段与实验引用完整", () => {
  const experimentIds = new Set((arrayOf("experiments") as ExperimentSpec[]).map((e) => e.id));
  for (const raw of arrayOf("tour") as TourStep[]) {
    for (const key of ["id", "title", "body", "look"] as const) {
      assert.equal(typeof raw[key], "string", `${raw.id}: ${key} 不是字符串`);
      assert.ok((raw[key] as string).length > 0, `${raw.id}: ${key} 为空`);
    }
    assert.ok(Number.isFinite(raw.sec) && raw.sec > 0, `${raw.id}: sec 非法`);
    if (raw.view !== undefined) assert.ok(["attitude", "gimbal", "quat"].includes(raw.view), `${raw.id}: 未知 view`);
    if (raw.exp !== undefined) assert.ok(experimentIds.has(raw.exp), `${raw.id}: 引用了不存在的实验 ${raw.exp}`);
    if (raw.doc !== undefined) {
      assert.equal(typeof raw.doc.page, "string", `${raw.id}: doc.page 不是字符串`);
      assert.equal(typeof raw.doc.label, "string", `${raw.id}: doc.label 不是字符串`);
    }
  }
});

test("学习 claim 注册表：id 唯一、目标存在、动作类型匹配、文档页与锚点存在", () => {
  const experimentIds = new Set(EXPERIMENTS.map((item) => item.id));
  const activityIds = new Set(LEARNING_ACTIVITIES.map((item) => item.id));
  const comparisonIds = new Set<string>(COMPARISON_VARIABLE_IDS);
  const targetSets: Record<LearningClaimAction, ReadonlySet<string>> = {
    "run-experiment": experimentIds,
    "run-prediction": activityIds,
    "run-comparison": comparisonIds,
  };

  const ids = LEARNING_CLAIMS.map((claim) => claim.id);
  assert.equal(new Set(ids).size, ids.length, `claim id 重复：${ids.join(", ")}`);
  assert.equal(LEARNING_CLAIMS.length, 13, "教材 claim 应覆盖 13 条主要结论");

  for (const claim of LEARNING_CLAIMS) {
    assert.ok(claim.id.trim().length > 0, "claim id 为空");
    assert.ok(claim.label.trim().length > 0, `${claim.id}: label 为空`);
    assert.ok(docPageIds.has(claim.docPage), `${claim.id}: 文档页不存在 ${claim.docPage}`);
    assert.ok(htmlIds.has(claim.docAnchor), `${claim.id}: 文档锚点不存在 ${claim.docAnchor}`);
    const targets = targetSets[claim.action];
    assert.ok(targets, `${claim.id}: 未知动作 ${claim.action}`);
    assert.ok(
      targets.has(claim.targetId),
      `${claim.id}: ${claim.action} 的目标不存在于对应目录：${claim.targetId}`,
    );
    if (claim.expectation) {
      assert.ok(claim.expectation.estimatorId.length > 0, `${claim.id}: 期望缺少 estimatorId`);
      assert.ok(claim.expectation.metric.length > 0, `${claim.id}: 期望缺少 metric`);
      assert.ok(claim.expectation.minGain > 0, `${claim.id}: 期望 minGain 必须为正`);
      assert.ok(
        ["run-comparison", "run-experiment"].includes(claim.action),
        `${claim.id}: 只有对照/实验动作才能声明因果期望`,
      );
    }
    if (claim.baselineExperimentId) {
      assert.ok(
        experimentIds.has(claim.baselineExperimentId),
        `${claim.id}: 基线实验不存在：${claim.baselineExperimentId}`,
      );
    }
  }
});

test("claim 查询：findClaim 不符合项返回 undefined，claimsForPage 只返回该页", () => {
  assert.equal(findClaim("claim-drift-linear")?.targetId, "drift-linear-10s");
  assert.equal(findClaim("claim-not-registered"), undefined);
  assert.deepEqual(
    claimsForPage("labs").map((claim) => claim.id),
    LEARNING_CLAIMS.map((claim) => claim.id),
  );
  assert.deepEqual(claimsForPage("no-such-page"), []);
});

test("index.html 的 data-claim 占位与注册表一一对应（无未知、无遗漏）", () => {
  assert.equal(new Set(claimPlaceholders).size, claimPlaceholders.length, "存在重复 data-claim 占位");
  assert.deepEqual(
    [...claimPlaceholders].sort(),
    LEARNING_CLAIMS.map((claim) => claim.id).sort(),
    "labs 页的占位与 LEARNING_CLAIMS 不一致",
  );
  for (const id of claimPlaceholders) {
    assert.ok(findClaim(id), `index.html 出现未注册的 claim 占位：${id}`);
  }
});

test("TR-04 门控目录与教材：同一有限窗口，不承诺贴地或峰值降低", () => {
  const gate = EXPERIMENTS.find((experiment) => experiment.id === "gate")!;
  const generatedGate = (arrayOf("experiments") as ExperimentSpec[]).find((experiment) => experiment.id === gate.id)!;
  const paragraph = indexHtml.match(/<p><span class="k k3">改了会怎样<\/span>用「方向门控救场」实验：[\s\S]*?<\/p>/)?.[0];
  const row = labsHtml.match(/<tr><td>方向门控救场<\/td>[\s\S]*?<\/tr>/)?.[0];
  assert.ok(paragraph && row, "必须保留门控教材段落与索引行");
  for (const text of [gate.observe, generatedGate.observe, paragraph, row]) {
    assert.doesNotMatch(text, /贴地/, "不能用实际仍有大峰值的窗口承诺贴地");
    assert.match(text, /20 s/);
    assert.match(text, /15\.2°.*12\.5°/);
    assert.match(text, /8272/);
    assert.match(text, /57\.6°/, "RMSE 改善不等于峰值也下降");
    assert.match(text, /启动 ramp/, "同一生产条件必须保留启动 ramp");
  }
});

test("契约测试不依赖 DOM", () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
});

console.log(fail === 0 ? `\n目录契约全部通过 ✅（${pass} 项）` : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
