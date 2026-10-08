/**
 * Content shape for the hero section.
 *
 * 📖 Docs: obsidian/frontend/hero.md
 */

import type { TitleSegment } from "@/types/typography";

export interface HeroLink {
  label: string;
  href: string;
}

export interface HeroContent {
  /** Wordmark, top-left. Segmented for the italic/roman alternation. */
  wordmark: TitleSegment[];
  /** Primary navigation, top-right column. */
  nav: HeroLink[];
  /** Call to action in the top-right corner. */
  explore: HeroLink;
  /** Display line that enters from the left edge. */
  titleStart: TitleSegment[];
  /** Display lines that enter from the right edge. */
  titleEnd: TitleSegment[][];
  /** Caption row directly above the centre card. */
  cardCaptionTop: string[];
  /** Caption row directly below the centre card. */
  cardCaptionBottom: string[];
  /** Heading of the destination list, bottom-right. */
  destinationsLabel: string;
  /** Destinations under the heading. */
  destinations: HeroLink[];
  /** View switcher, bottom-left. `active` is rendered at full opacity. */
  viewModes: { label: string; active: boolean }[];
  media: {
    /**
     * The footage the section opens on, in place of the two stills Figma drew
     * as placeholders for it. `alt` labels the element rather than replacing it
     * — a video has no `alt`, so it goes on `aria-label`.
     */
    video: { src: string; alt: string; width: number; height: number };
    /**
     * The clip's last frame at full resolution, dissolved over the video the
     * moment the footage stops (`STILL_MS`).
     *
     * No `alt`, and no `width`/`height`: it is the same shot the `<video>`
     * already names for a screen reader, so it is rendered decorative, and it
     * fills the footage's box rather than carrying a size of its own.
     */
    still: { src: string };
    /** The photo used by both edge thumbnails. */
    thumbnail: { src: string; alt: string; width: number; height: number };
  };
}
