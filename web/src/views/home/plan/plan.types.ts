import type { TitleSegment } from "@/types/typography";

/** One image in the scene. */
export interface PlanMedia {
  src: string;
  alt: string;
}

/** A footer link. */
export interface PlanLink {
  label: string;
  href: string;
}

/** One of the footer's three link columns. Widths live in the geometry. */
export interface PlanLinkColumn {
  /** Column heading — already the case it is drawn in. */
  title: string;
  links: PlanLink[];
}

export interface PlanContent {
  /** "Plan a Journey" — italic P and J. */
  title: TitleSegment[];
  /**
   * The handwritten promise on the note, uppercased in CSS — **one entry per
   * line**, in the wrap Figma draws at its 273px width.
   *
   * Split rather than wrapped because each line is written on its own: a single
   * clip over a wrapped paragraph would uncover all three at once.
   */
  note: string[];
  /** The small line under it. */
  noteAside: string;
  /** The call to action. */
  action: PlanLink;

  footer: {
    /** "WanderLust" — italic W and L, the hero's own wordmark. */
    wordmark: TitleSegment[];
    /** Exactly three, left to right. */
    columns: PlanLinkColumn[];
    /** The line above the e-mail field, uppercased in CSS. */
    newsletter: string;
    /** Placeholder for the e-mail field, uppercased in CSS. */
    emailPlaceholder: string;
    /** Accessible name for the field's submit control. */
    emailAction: string;
    social: Array<PlanMedia & { href: string }>;
    copyright: string;
  };

  media: {
    /**
     * The full-frame photograph everything else is layered over — the only
     * opaque plate in the scene, and the reason the cut-outs above it have a
     * sky to stand against.
     */
    backdrop: PlanMedia;
    /**
     * The mountains. **Wider than the frame** — 1642 against 1440 — and that
     * overhang is the parallax's headroom, not a crop to trim.
     */
    far: PlanMedia;
    /** The steam plate, drawn for `screen`: its black is meant to fall away. */
    steam: PlanMedia;
    /** The foreground ridge, alpha-cut. */
    foreground: PlanMedia;
    /** The pinned note the invitation is written on. */
    note: PlanMedia;
    /** The two hand-drawn underlines under the note's promise. */
    underlines: [PlanMedia, PlanMedia];
    /** The 12×12 arrow, used by the button and the e-mail field. */
    arrow: PlanMedia;
  };
}
