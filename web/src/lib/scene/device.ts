/**
 * Device tiering — the single source of every per-device scene decision.
 *
 * Ported from the `optimize-3d-scene` skill's canonical `device.ts`
 * (helion/mycelia). DPR, frame budget, pointer listening, instance and particle
 * counts and post-pass budgets all read the tier from here, so they can never
 * drift apart.
 *
 * 📖 Docs: obsidian/workflows/optimize-3d-scene.md
 */

export type DeviceTier = "mobile" | "tablet" | "desktop";

const TABLET_MAX = 1180;
const MOBILE_MAX = 768;

/**
 * The media-query half of the tier. Subscribe to it: DevTools emulation and a
 * mouse plugged into a tablet flip it without any `resize` event.
 */
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

export const isCoarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(COARSE_POINTER_QUERY).matches;

/**
 * Read at scene construction and held in a mutable slot. Never recompute per
 * frame — but DO re-read it when the width or the pointer media query changes,
 * or a window dragged across a breakpoint keeps the phone tier on a desktop
 * viewport until reload.
 */
export const deviceTier = (): DeviceTier => {
  if (typeof window === "undefined") return "desktop";
  const width = window.innerWidth;
  if (width < MOBILE_MAX || isCoarsePointer()) return "mobile";
  if (width < TABLET_MAX) return "tablet";
  return "desktop";
};

/**
 * Clamped device pixel ratio. The skill's 0.85 mobile ceiling is for soft point
 * sprites; this scene is hair-thin blades, which alias visibly below 1.0, so
 * mobile stops at 1.0 — the skill's own exception for hard-edged geometry.
 */
export const clampedPixelRatio = (tier: DeviceTier = deviceTier()): number => {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio || 1;
  if (tier === "mobile") return Math.min(dpr, 1);
  if (tier === "tablet") return Math.min(Math.max(dpr, 0.75), 1.25);
  return Math.min(Math.max(dpr, 0.75), 1.5);
};

/**
 * Minimum ms between scene frames. The ticker skips while `time - last <=
 * budget`, so a flat `1000 / 30` lands at ~26 fps on a 120 Hz display; the
 * 1 ms margin makes the stated rate the real one.
 */
export const frameBudgetMs = (tier: DeviceTier = deviceTier()): number => {
  if (tier === "mobile") return 1000 / 30 - 1;
  if (tier === "tablet") return 1000 / 45 - 1;
  return 0;
};

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Best-effort "spend less here". Data Saver is the nearest web-exposed proxy
 * for iOS Low Power Mode, which has no API.
 */
export const isEnergySaver = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData === true) return true;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory > 0) {
    return nav.deviceMemory <= 2;
  }
  return false;
};

/**
 * Play the entrance, then stop drawing on a settled frame. WebGL keeps the last
 * frame on the canvas, so a frozen scene costs nothing.
 */
export const sceneShouldFreeze = (tier: DeviceTier = deviceTier()): boolean =>
  prefersReducedMotion() || (tier === "mobile" && isEnergySaver());

/** Whether to attach pointer listeners at all. */
export const wantsPointer = (tier: DeviceTier = deviceTier()): boolean =>
  tier !== "mobile";

export const byTier = <T,>(tier: DeviceTier, values: Record<DeviceTier, T>): T =>
  values[tier];
