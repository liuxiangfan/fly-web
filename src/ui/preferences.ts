export const FONT_TIER_STORAGE_KEY = "quat-demo:font-tier:v1";

const FONT_TIERS = ["standard", "large", "xlarge"] as const;
export type FontTier = (typeof FONT_TIERS)[number];

export interface FontTierStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isFontTier(value: unknown): value is FontTier {
  return typeof value === "string" && (FONT_TIERS as readonly string[]).includes(value);
}

function defaultStorage(): FontTierStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadFontTier(storage?: FontTierStorage | null): FontTier {
  try {
    const value = (storage === undefined ? defaultStorage() : storage)?.getItem(FONT_TIER_STORAGE_KEY);
    return isFontTier(value) ? value : "standard";
  } catch {
    return "standard";
  }
}

export function saveFontTier(tier: FontTier, storage?: FontTierStorage | null): boolean {
  if (!isFontTier(tier)) return false;
  try {
    const target = storage === undefined ? defaultStorage() : storage;
    if (!target) return false;
    target.setItem(FONT_TIER_STORAGE_KEY, tier);
    return true;
  } catch {
    return false;
  }
}

/** 应用根字号档位；返回 data-font 是否真的变化。standard 同样显式写属性，三档口径一致。 */
export function applyFontTier(tier: FontTier, root: HTMLElement = document.documentElement): boolean {
  const changed = root.dataset.font !== tier;
  root.dataset.font = tier;
  return changed;
}
