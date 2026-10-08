/**
 * Content shape for the destinations block.
 *
 * 📖 Docs: obsidian/frontend/destinations.md
 */

import type { TitleSegment } from "@/types/typography";

/**
 * How much transparent margin one exported PNG carries, and where its ink sits
 * inside it.
 *
 * Every file in this block is a **finished polaroid** — paper, caption, grain
 * and rotation are in the pixels — but the exports are not tight crops. Figma
 * gave each card the bounding box of its own rotated artwork *plus* whatever
 * padding the group around it had, and that padding runs from 0.4% of the file
 * (Spain, Italy) to 36.6% (Austria). Placed by the file box, a card with a third
 * of its width in transparency would draw its paper a third too small.
 *
 * So the design's width is treated as the width of the **ink**, and these five
 * numbers convert it back into a box for the file:
 *
 *   `box`  — file width ÷ ink width. Multiply the design width by this and the
 *            ink comes out exactly the size the file draws it.
 *   `boxY` — file height ÷ ink height, the same correction down the page.
 *   `fx`   — where the ink's centre sits across the file, 0–1. 0.5 is centred.
 *   `fy`   — the same down the file. Three files are **not** centred — Austria
 *            sits at 0.427, New Zealand at 0.590 across — and without these two
 *            those cards would land that far off their marks.
 *   `ratio`— the ink's own width ÷ height, which is what decides the card's
 *            height once its width is set.
 *
 * All five are **measured**, not read off the file: the alpha channel is scanned
 * for the bounding box of every pixel above 8/255. See the table in
 * `destinations.geometry.ts`.
 */
export interface InkMetrics {
  box: number;
  boxY: number;
  fx: number;
  fy: number;
  ratio: number;
}

/**
 * One card on the scene.
 *
 * Positioned by the **centre of its ink**, in Figma frame coordinates (px
 * against the 1440×687 frame 1784:1916). A centre is invariant under rotation,
 * so it is the one anchor a baked-in rotation cannot throw off — which a
 * top-left corner demonstrably can, see the warning in the geometry file.
 *
 * `width` is the ink's width in those same frame pixels. Its height is not
 * stored: it follows from `ink.ratio`, so a card can never be drawn to a shape
 * its own photograph does not have.
 *
 * Rotation is NOT here, for the same reason the paper and the caption are not:
 * every file was exported already turned, at the size of its rotated box.
 * Applying `rotate()` on top would turn it a second time.
 */
export interface CardAsset {
  src: string;
  alt: string;
  /** Ink centre, in frame coordinates. */
  cx: number;
  cy: number;
  /** Ink width, in frame coordinates. */
  width: number;
  /** Paint order at rest; higher sits on top. */
  z: number;
  ink: InkMetrics;
}

/**
 * A sticker: placed by its centre like a card, and **not** ink-corrected.
 *
 * The correction exists because a card's export is its artwork's bounding box
 * plus whatever padding its group carried, so the file is bigger than the paper
 * it draws. A sticker's is not: measured, all three files have exactly the ratio
 * the frame gives their box — the flag is 105×87 against a 35×29 box, both
 * 1.207, and the lupin 164×199 against 54.613×66.319, both 0.824. The
 * transparent margin inside a sticker is part of how it is drawn, not packaging
 * around it, so the box goes to the file whole and the height is stated rather
 * than derived.
 */
export interface StickerAsset {
  src: string;
  alt: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  z: number;
}

export interface Destination {
  id: string;
  /** As printed in the list — the design sets it uppercase in the file. */
  name: string;
  /** The one card this country has. There is no longer a pile per country. */
  card: CardAsset;
}

export interface DestinationsContent {
  /** Two display lines, segmented for the italic/roman alternation. */
  heading: TitleSegment[][];
  /**
   * All sixteen countries, in the order the design numbers them. The first
   * eight fill the left-hand column, the rest the right-hand one.
   */
  countries: Destination[];
  /** Three marks that sit above every card and belong to no country. */
  stickers: StickerAsset[];
}
