import type { TitleSegment } from "@/types/typography";

/** The photograph behind one panel. */
export interface TravelMedia {
  src: string;
  alt: string;
}

/** One of the four ways of travelling — one panel of the accordion. */
export interface TravelPanel {
  /** Stable key; never rendered. */
  id: string;
  /**
   * "Small Group Trips" and friends, segmented so the leading capital of every
   * word takes the italic cut — the same alternation the hero and block 3 use,
   * which is why this is a segment list rather than a string.
   */
  title: TitleSegment[];
  /** The supporting sentence, uppercased in CSS. */
  body: string;
  /** The handwritten line under it. */
  signOff: string;
  /**
   * Width of the body column in Figma pixels at the 1440 frame — 390, 420, 400
   * and 490. It is content, not layout: each of the four is the **narrowest
   * measure that breaks its own sentence into two lines**, plus a few pixels so
   * a font-metric wobble cannot push it to three. Change the sentence and the
   * number has to be measured again. The component turns it into rem, so it
   * scales with the grid and keeps the same share of its panel at every width.
   *
   * They were 219 / 228 / 244 / 271 — the same rule against **four** lines, from
   * when the copy sat in a column at the foot of a panel rather than centred
   * under its name.
   */
  bodyWidth: number;
  media: TravelMedia;
}

export interface TravelContent {
  /** "How We Travel." — italic H, W, T. */
  title: TitleSegment[];
  /** The handwritten line under the heading. */
  subtitle: string;
  /** Exactly four, in the order they are read left to right. */
  panels: TravelPanel[];
}
