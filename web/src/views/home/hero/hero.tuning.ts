/**
 * The hero window's feel, in one place.
 *
 * These were dialled in on a slider panel and signed off; the panel is gone and
 * the values below are simply what ships. Nothing reads them at runtime beyond
 * module load, so changing one here is the whole edit.
 *
 * 📖 Docs: obsidian/frontend/hero.md
 */

export interface HeroTuning {
  /**
   * Lerp coefficient for the card. Lower = heavier, lags further behind.
   * The captions share this — they move on the card's own vector.
   */
  cardLerp: number;
  /** Extra brightness inside the window, on top of undoing the page scrim. */
  brightness: number;
  /** Saturation inside the window. */
  saturation: number;
  /** Multiplier on the page scrim outside the window. */
  scrimOpacity: number;
  /** Time (ms) to glide back to centre when the pointer leaves. */
  returnMs: number;
}

export const HERO_TUNING: HeroTuning = {
  cardLerp: 0.08,
  brightness: 1.18,
  saturation: 1.25,
  scrimOpacity: 1,
  returnMs: 800,
};
