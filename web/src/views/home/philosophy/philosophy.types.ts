import type { TitleSegment } from "@/types/typography";

/** One image with the alt text it needs. */
export interface PhilosophyMedia {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface PhilosophyContent {
  /**
   * "Go Somewhere That Stays With You.", segmented so the first letter of every
   * word takes the italic cut — the same alternation the hero's display type
   * uses, and the reason this is a segment list rather than a string.
   *
   * **One entry per line-fragment**, so the break can fall in two different
   * places: "Go Somewhere That" · "Stays" · "With You." A phone breaks after
   * the first, a tablet after the second, and the desktop breaks nowhere — it
   * wraps on its own, which at 1440 lands after "That" anyway. Which fragment
   * carries which break is the component's business, not the content's.
   */
  title: TitleSegment[][];
  /**
   * The two supporting paragraphs, left then right, uppercased in CSS.
   *
   * **One entry per line-fragment**, joined by a break that only a tablet
   * shows. Below and above that range the fragments run together and wrap on
   * their own — each carries its own trailing space so they read as one
   * sentence when the break is not painted.
   */
  asideLeft: string[];
  asideRight: string[];
  /** The handwritten sign-off, one entry per line. */
  signOff: string[];
  media: {
    /** The photograph the whole block sits on; panned by the scroll. */
    backdrop: PhilosophyMedia;
    /** The polaroid collage, alpha-cut, revealed in the second half. */
    collage: PhilosophyMedia;
  };
}
