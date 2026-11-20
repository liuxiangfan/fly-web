import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FONT_TIER_STORAGE_KEY,
  applyFontTier,
  isFontTier,
  loadFontTier,
  saveFontTier,
  type FontTierStorage,
} from "../src/ui/preferences";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/style.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const main = readFileSync(join(root, "src/main.ts"), "utf8");

let totalPass = 0;
let totalFail = 0;
function group(name: string, run: () => void): void {
  try {
    run();
    console.log(`font-scale-contract: ${name} PASS`);
    totalPass++;
  } catch (err) {
    totalFail++;
    console.error(`font-scale-contract: ${name} FAIL — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// 1. style.css 不得残留 `font-size: Npx` 字面量；根字号三档用 `calc(N * 1px)` 承载（豁免正则见下）。
group("无残留 px font-size（根档 calc 与 max(...rem) 为唯一形态）", () => {
  const leftovers = [...css.matchAll(/font-size\s*:\s*[^;\n]*\d+px/g)]
    .map((m) => m[0])
    .filter((s) => !/^font-size:\s*calc\(\s*(14|17|20)\s*\*\s*1px$/.test(s));
  assert.deepEqual(leftovers, [], `残留 px 字号：${JSON.stringify(leftovers)}`);
});

// 2. 三档根字号规则存在、值正确且严格递增（14 → 17 → 20 px）。
group("html[data-font] 三档规则存在且递增", () => {
  const tiers = [...css.matchAll(/html\[data-font="(large|xlarge)"\]\s*\{[^}]*font-size:\s*calc\((\d+)\s*\*\s*1px\)/g)];
  assert.deepEqual(tiers.map((m) => m[1]), ["large", "xlarge"]);
  const base = /(?:^|\n)html\s*\{[^}]*font-size:\s*calc\(14\s*\*\s*1px\)/.test(css);
  assert.ok(base, "缺少标准档 html { font-size: calc(14 * 1px) }");
  const sizes = [14, ...tiers.map((m) => Number(m[2]))];
  assert.deepEqual(sizes, [14, 17, 20]);
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2]);
});

// 3. 偏好模块：白名单、回退、容错与可注入 storage。
group("preferences 白名单/容错/回退/注入 storage", () => {
  assert.deepEqual(["standard", "large", "xlarge"].map((t) => isFontTier(t)), [true, true, true]);
  assert.deepEqual(["", "big", "XLarge", null, undefined, 7].map((t) => isFontTier(t)), [false, false, false, false, false, false]);

  const fake = (() => {
    const map = new Map<string, string>();
    return {
      store: map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
      } as FontTierStorage,
    };
  })();
  assert.equal(loadFontTier(fake.storage), "standard", "空存储应回退 standard");
  assert.equal(saveFontTier("large", fake.storage), true);
  assert.equal(fake.store.get(FONT_TIER_STORAGE_KEY), "large");
  assert.equal(loadFontTier(fake.storage), "large", "合法值应读回");
  fake.store.set(FONT_TIER_STORAGE_KEY, "huge");
  assert.equal(loadFontTier(fake.storage), "standard", "非法存储值应回退 standard");

  const throwing: FontTierStorage = {
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(loadFontTier(throwing), "standard", "getItem 抛异常应回退 standard");
  assert.equal(saveFontTier("xlarge", throwing), false, "setItem 抛异常应返回 false");

  assert.equal(loadFontTier(null), "standard", "无 storage 应回退 standard");
  assert.equal(saveFontTier("large", null), false);
  assert.equal(saveFontTier("huge" as Parameters<typeof saveFontTier>[0], fake.storage), false, "save 必须校验白名单");
  assert.equal(loadFontTier(), "standard", "Node（无 window）下默认读取应安全回退 standard");
});

// 4. applyFontTier：三档一致写属性，返回是否真的变化。
group("applyFontTier 写 data-font 且返回变化", () => {
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  assert.equal(applyFontTier("standard", el), true);
  assert.equal(applyFontTier("standard", el), false);
  assert.equal(applyFontTier("xlarge", el), true);
  assert.equal(el.dataset.font, "xlarge");
});

// 5. index.html：有带三档选项的 font-tier select，且未进入实验深链列表。
group("index.html 有 font-tier 三档且不进深链", () => {
  const sel = /<select id="font-tier"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(sel, "缺少 #font-tier 下拉");
  const opts = [...sel![1].matchAll(/<option value="(standard|large|xlarge)"/g)].map((m) => m[1]);
  assert.deepEqual(opts, ["standard", "large", "xlarge"]);
  const deepSels = /const DEEP_SELS = \[([\s\S]*?)\];/.exec(main)?.[1] ?? "";
  const deepChecks = /const DEEP_CHECKS = \[([\s\S]*?)\];/.exec(main)?.[1] ?? "";
  assert.ok(!deepSels.includes("font-tier") && !deepChecks.includes("font-tier"), "font-tier 不得进入实验深链");
  assert.ok(/font-tier/.test(main), "main.ts 应接线 #font-tier");
});

console.log(`font-scale-contract: ${totalPass} PASS / ${totalFail} FAIL（共 ${totalPass + totalFail} 组）`);
