/**
 * Every measurement the hero takes from Figma, in one place.
 *
 * Source: Get Layers, file WINXFW2nTM7zYwd5dGgm1T
 *   frame 1 — 863:1005 "Hero 2 (Image 1 for Video after Preloader)"
 *   frame 2 — 868:1094 "Hero 2 (Image 2 for Video after Preloader)"
 *   frame 3 — 774:254  "Hero 2"            ← the layout below
 *
 * Frames 1 and 2 say what they are for in their own names: they are two stills
 * standing in **for a video after the preloader**. The footage exists now, so
 * they are gone and it plays in their place — the zoom between them was always a
 * rehearsal of a camera move that a video does properly.
 *
 * All three frames are 1440×800. Absolute offsets are converted to rem against
 * a 16px root, so the adaptive grid (see grid.config.ts) scales the whole
 * design proportionally while the numbers stay equal to the Figma pixels at
 * 1440. Colours, type sizes and line-heights are NOT here — those are design
 * tokens and live in globals.css.
 */

/*
 * ── The Figma record ───────────────────────────────────────────────────────
 *
 * None of the numbers below are read by the code. `CLASS`, at the bottom of
 * this file, carries the live values, and it has to: they are written as
 * Tailwind classes because tablet and phone override them inside media
 * queries, which an exported object cannot do.
 *
 * They stay here as prose because this is the only place the hero's own
 * measurements are written down, each against the node it came from. Every
 * `left`/`top` in `CLASS` is one of these divided by 16 — 24px is `1.5rem`,
 * 994px is `62.125rem` — so this table is how you check a class against the
 * file without opening Figma.
 *
 *   FRAME_WIDTH   1440          FRAME_HEIGHT  800
 *   rem(px)       px / 16 + "rem"
 *
 *   margin              24                  uniform page inset — logo, nav,
 *                                           explore, toggle, destination list
 *   wordmark   854:950  left 24, top 24     top-left
 *   nav        881:9    left 994, top 24, width 92
 *                                           right-hand column, shares its left
 *                                           edge with the titles below
 *   explore    881:3    left 1235, top 24, width 181
 *                                           flush right: 1440 − 24 − 181
 *   card       854:952  left 470, width 500, height 315,
 *                       top calc(50% − 157.5)
 *                                           vertically centred: top 242 +
 *                                           height 315 ⇒ centre 399.5 ≈ 400,
 *                                           held as a centre offset so it stays
 *                                           centred at any viewport height
 *   cardCaptionTop
 *              857:998  left 470, width 500, top calc(50% − 178.5)
 *                                           21px above the card
 *   cardCaptionBottom
 *              857:997  left 470, width 500, top calc(50% + 169.5)
 *                                           12px below the card
 *   titleTop   854:953  calc(50% − 69)      both display blocks are two lines
 *              854:954                      of 72px leading sharing top 331
 *   titleStart          right 1440 − 446 = 994, width 238
 *   titleEnd            left 994, width 340.138
 *                                           446 + 994 = 1440: the two blocks
 *                                           mirror about the centre line
 *   thumbnail  856:990  left 607, width 227, heights 132 (top) / 133 (bottom)
 *              856:989                      centred, bleeding off both edges
 *   destinations
 *              869:1122 left 994, bottom 24 bottom-right, shares the 994 edge
 *   viewModes  856:988  left 24, bottom 24  bottom-left
 */

/**
 * How long the darkening takes to come up over the footage, in ms.
 *
 * It starts with the video rather than waiting for it. The reader is handed a
 * moving picture the instant the preloader lifts and the veil closes over it
 * across the first second — so the hero opens *bright* and settles into its own
 * mood, rather than opening on something already dimmed and giving the reader
 * nothing to notice happening.
 */
export const VEIL_MS = 900;

/**
 * How long the assembly takes, in ms — the mask, then everything around it.
 *
 * The flight's 2.5s cut down: the flight had a zoom, a cross-dissolve and an
 * interface to get through, and this has only the interface. The mask takes the
 * first `PHASE.maskDuration` of it (720ms) and the eight groups around it share
 * the rest.
 */
/**
 * How fast the clip runs.
 *
 * 2× — the footage is a slow aerial and at 1× the hero spent four seconds saying
 * one thing before the page would start. Doubling it keeps every frame and
 * halves the wait, which on an establishing shot reads as confidence rather than
 * as haste.
 */
export const VIDEO_RATE = 2;

/**
 * How far before the clip's last frame the interface starts arriving, in
 * **media seconds** (so it halves in wall clock at `VIDEO_RATE`).
 *
 * Waiting for `ended` put a beat of nothing between the shot finishing and the
 * window opening — the video stops, and then, separately, the page begins. At
 * 0.4 the two overlap: the mask starts opening while the last of the movement is
 * still on screen, so it reads as one gesture rather than two events.
 */
export const ASSEMBLY_LEAD_S = 0.4;

export const ASSEMBLY_MS = 2400;

/**
 * How long the full-resolution still takes to replace the clip's last frame,
 * in ms.
 *
 * The clip stops and holds its own last frame, and that frame is then the one
 * picture the reader is left looking at for the rest of the section — while
 * being the frame the encoder spent the fewest bits on, at the end of a long
 * push-in with nothing after it to predict from. A still of the same frame,
 * upscaled and graded, is dissolved over it the moment the footage stops.
 *
 * A dissolve rather than a cut, because the two are not the same bytes: the
 * still carries detail the encode threw away, and a cut would read as the
 * picture sharpening in one tick — a flicker with no cause behind it. Across
 * `STILL_MS` it reads as the shot settling instead. It runs while the mask is
 * still opening, which is the best cover a swap of this kind could ask for.
 */
export const STILL_MS = 520;

/**
 * How close to the last frame counts as being *at* it, in media seconds.
 *
 * `ended` is the ordinary cue and this is the ticker's own reading of the same
 * moment, for the clip that stops a hair short of its stated duration — which
 * happens whenever a container's declared duration and its last frame's
 * presentation time disagree, and leaves `ended` unfired. One frame at 30fps.
 */
export const STILL_LEAD_S = 1 / 30;

/**
 * What the optimiser is allowed to spend on the still.
 *
 * Above the project default of 75, and it is the one image on the page with a
 * case for it: this exists **only** because the frame underneath it is not
 * detailed enough, so re-encoding it at the setting everything else uses would
 * spend the upgrade on the way out. At 2560 wide in AVIF the difference between
 * 75 and 90 is a couple of hundred kilobytes on an image that loads while a
 * video is playing over it.
 *
 * `next.config.ts` has to allow the value — `images.qualities` is a whitelist
 * and anything outside it is a 400, so **the two move together.**
 */
export const STILL_QUALITY = 90;

/**
 * The assembly runs this long after the video is asked to play, whatever the
 * video does.
 *
 * Autoplay can be refused, a decode can stall, a tab can be backgrounded through
 * the whole clip — and `ended` arrives in none of those cases. The failure has
 * to land on **the interface being there**, not on a reader looking at silent
 * footage with no page around it (ADR-0031). 8s against a 4s clip leaves the
 * real ending a wide margin to win by.
 */
export const ASSEMBLY_FALLBACK_MS = 8000;

/**
 * Progress breakpoints for the assembly. Everything is interpolated against
 * these — no state switching, so any value in between is a valid picture.
 */
export const PHASE = {
  /**
   * The mask's own share of the assembly, and it runs from 0: the window is the
   * first thing to arrive and the only thing on screen while it does.
   */
  maskDuration: 0.3,
  /** Where everything else begins — exactly where the mask lands. */
  uiStart: 0.3,
  /** Progress offset between consecutive UI groups (≈132ms). */
  uiStagger: 0.055,
  /** Length of a single UI group's fade (≈480ms). */
  uiDuration: 0.2,
} as const;

/**
 * The window's entrance.
 *
 * It scales up into place rather than sliding in: it is a lens opening on the
 * footage, not a card being dealt onto it. 0.62 is small enough to read as an
 * aperture and large enough that the brightened backdrop inside it is legible
 * from the first frame — below about 0.5 the window is a bright dot before it is
 * a window, which reads as a flash rather than an opening.
 */
export const MASK = {
  from: 0.62,
} as const;

/**
 * The recording light inside the window.
 *
 * A camera's tally lamp. `pulseMs` is one half-cycle — the spring loops with
 * `reverse`, so a full blink is twice this. 620ms is the pace a tally light
 * actually keeps; slower reads as breathing, faster as an alarm.
 *
 * It never goes fully out. A dot that vanishes is a dot that has been removed;
 * one that drops to 0.18 is the same lamp, dark for a beat.
 */
export const REC = {
  pulseMs: 620,
  dim: 0.18,
} as const;

/**
 * Film grain over the footage.
 *
 * One noise tile, stepped between `steps` fixed offsets on a loop — **not**
 * smoothly drifted. Grain that slides is dust on the lens; grain that jumps is
 * grain. Stepping also means the tile is only ever translated, so the texture is
 * generated once and the animation costs a transform.
 *
 * `mix-blend-mode: overlay` rather than a flat alpha: overlay leaves the mid
 * tones alone and works into the shadows and the highlights, which is where film
 * grain actually lives. Over a dark, veiled frame that is what keeps it from
 * turning the whole picture grey.
 */
export const GRAIN = {
  /** One full cycle through every offset, in ms. */
  cycleMs: 800,
  steps: 8,
  opacity: 0.3,
  /** Tile size in px, and how far the tile travels between steps. */
  tile: 200,
  shift: 41,
} as const;

/**
 * The noise itself, as a data URI.
 *
 * `feTurbulence` rather than a PNG: a few hundred bytes instead of a request,
 * and `stitchTiles` makes the tile seamless so nothing shows a seam as it steps.
 * `numOctaves=3` at this frequency is where the grain stops looking like a
 * pattern and starts looking like emulsion.
 */
export const GRAIN_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)' opacity='0.9'/%3E%3C/svg%3E\")";

/**
 * UI groups in the order they assemble.
 *
 * **The card comes first now, and alone.** It used to be fifth — the chrome and
 * the headings arrived around an empty middle and the window then opened into a
 * page that was already assembled. The sequence reads the other way round: the
 * lens opens on the footage, and the interface gathers *around what it found*.
 * Everything after the card is text placed relative to that window, so all of it
 * waits for the window to be there to be placed relative to.
 */
export const UI_ORDER = [
  "card",
  "captions",
  "titles",
  "wordmark",
  "nav",
  "explore",
  "destinations",
  "viewModes",
  "thumbnails",
] as const;

export type UiGroup = (typeof UI_ORDER)[number];

/**
 * Start progress for a UI group.
 *
 * The card is the exception in both terms: it starts at 0, and the stagger for
 * everything else counts from *its* index rather than from the front of the
 * list. So the mask has the first 30% to itself, and the eight groups around it
 * begin on the frame it lands.
 */
export const uiStart = (group: UiGroup): number =>
  group === "card"
    ? 0
    : PHASE.uiStart + (UI_ORDER.indexOf(group) - 1) * PHASE.uiStagger;

/** How long a group takes. The mask takes longer than the text around it. */
const groupDuration = (group: UiGroup): number =>
  group === "card" ? PHASE.maskDuration : PHASE.uiDuration;

/** Smoothstep — still at both ends, so no group arrives at speed and stops. */
const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * A UI group's 0→1 reveal factor at a given assembly progress.
 *
 * Shared by the declarative reveals (which feed it to `opacity`) and by the
 * pointer-follow ticker, which needs the same number to fold the mask's scale
 * into the one transform it writes on the card.
 *
 * The curve lives **here** rather than on the master spring, which runs linearly.
 * That way `uiStagger` is a real interval in milliseconds and every group gets
 * the same shape whether it is first or last — put the easing on the master
 * instead and a group's local curve depends on where in the timeline it sits.
 */
export const groupEase = (progress: number, group: UiGroup): number =>
  smooth((progress - uiStart(group)) / groupDuration(group));

/** Entry travel (rem) for a revealing group. */
export const REVEAL_TRAVEL = 1.25;

/**
 * Positions as class strings rather than inline styles.
 *
 * Inline styles cannot be overridden by a media query, and tablet and mobile
 * need a genuinely different arrangement — so the desktop numbers moved here
 * verbatim and the small-screen layout hangs off `max-lg:` / `max-md:`, which
 * are pinned to the grid's own base widths (see globals.css).
 *
 * These must stay **literal strings** for Tailwind's scanner to see them.
 *
 * The small-screen arrangement follows the reference the design derives from
 * (jasonbergh.com): wordmark left and a MENU disclosure right along the top,
 * the switcher centred between them, display lines stacked and centred over a
 * full-bleed card, and a single bottom row — destinations left, explore right.
 *
 * The card is `min(100vw-3rem, 31.25rem, (100vh-36rem)/0.63)` wide — full bleed
 * between the page margins, never wider than the desktop card, and never so
 * tall that the stacked display lines above it run out of room. All three terms
 * were needed: without the second a 1024 tablet got a 976px card, larger than
 * on desktop; without the third a 1024×768 one pushed "Beyond Places." off the
 * top of the screen and into the switcher. The `max(...)` floors on the two
 * title tops are the same guard from the other side. ×0.315 is half the Figma 315/500 ratio, which
 * centres it vertically without a transform — the card cannot use
 * `-translate-y-1/2`, because its transform belongs to `usePointerFollow`.
 */
export const CLASS = {
  /*
   * **The wordmark and the nav are `fixed`, not `absolute`: they are the site's
   * header.**
   *
   * They are drawn in the hero's frame and they belong to it, but there is no
   * second header anywhere on the page — so the pair the hero reveals *is* the
   * one the reader keeps. `fixed` costs nothing to say and nothing to maintain:
   * the coordinates are unchanged (the hero is full-bleed and starts at x 0, so
   * the viewport and the section agree on every edge), the flight's own reveal
   * still plays on them, and no markup moves.
   *
   * **`z-50`, and the number matters.** Block 2 sits at `z-10` so block 3 can be
   * pulled underneath it (see `destinations.geometry.ts`), and a fixed element
   * with no z-index would lose to it and slide behind the polaroids. The hero's
   * own ancestors create no stacking context — `relative` with no z-index — so
   * this competes at the root, above everything on the page.
   *
   * > [!note] `overflow: hidden` on the stage does not clip these
   * > A fixed box is clipped by an ancestor's overflow only where that ancestor
   * > is also its containing block, which takes a `transform`, a `filter` or
   * > `will-change` on it. The stage has none — its animated layers are its
   * > children, not itself — so the chrome escapes the hero and rides the page.
   */
  wordmark: "fixed z-50 left-page top-page",

  nav: "fixed z-50 left-[62.125rem] top-page w-[5.75rem] max-lg:left-auto max-lg:right-page max-lg:w-auto max-lg:text-right",

  /*
   * Centred on a phone. It is the only thing left in the bottom row there —
   * the destinations group is gone — and a lone right-aligned block reads as a
   * layout that lost its other half. Centred it becomes the section's one call
   * to action.
   *
   * It is also pinned to the floor of the first screen rather than floating
   * above it. The offset is measured from the stage's bottom edge, and the
   * stage is `min-h-viewport` — `100dvh`, i.e. the height actually visible.
   * A bottom offset inside a dynamic-height box is therefore always that far
   * above the real edge, with or without the address bar; `100svh` would only
   * add the bar's height back as a gap whenever it is hidden. `env()` adds the
   * iPhone's gesture bar on top, and reads as 0 wherever there is none.
   *
   * Until this revision the offset was 5.5rem, to clear the bottom thumbnail
   * that used to sit on the same centre line. Both thumbnails are gone on a
   * phone now (see THUMBNAIL_CLASS), so the floor is free.
   */
  /**
   * **Fixed on desktop, absolute below it** — and the split is not a compromise,
   * it is where the control actually lives at each size.
   *
   * On desktop this is the third item in the top row: wordmark left, nav in the
   * middle, this flush right. All three are the site's chrome rather than the
   * hero's decoration, so all three stay with the reader and stand down together
   * at the footer (`chromeGate` in `hero-overlay.tsx`).
   *
   * Below `lg` it is not in that row at all — it drops to the foot of the hero,
   * and on a phone it is the section's one call to action, centred above the
   * safe area. Fixing it there would leave a button floating over five other
   * blocks that have their own, so it stays `absolute` and scrolls away with the
   * section it belongs to.
   */
  explore:
    "absolute left-[77.1875rem] top-page w-[11.3125rem] lg:fixed lg:z-50 max-lg:left-auto max-lg:right-page max-lg:top-auto max-lg:bottom-page max-lg:w-fit max-md:left-0 max-md:right-0 max-md:mx-auto max-md:bottom-[calc(24px+env(safe-area-inset-bottom))]",

  /**
   * The footage. Full-bleed and `object-cover`, so the frame is filled at any
   * viewport ratio — the clip is 16:9 and almost no window is.
   *
   * No `poster`. A poster would be a *different* picture for the first beat and
   * then cut to the video's own first frame, which is a jump the reader has no
   * reason for; the preloader already holds the page until the clip has frames
   * to give (see `use-media-ready.ts`), and the stage behind it is cinema black
   * either way.
   */
  video: "absolute inset-0 h-full w-full object-cover",

  /**
   * The still that takes the frame once the clip is done — see `STILL_MS`.
   *
   * Exactly the footage's box, so `object-cover` crops the two identically at
   * every viewport ratio and the dissolve is a change of resolution and nothing
   * else. The file is the clip's own last frame at the clip's own 2560×1440, so
   * "identically" is literal: same framing, same aspect, same pixels, more of
   * them.
   *
   * It sits directly over the video and **under** the veil, the vignette and the
   * grain — everything that was grading the footage goes on grading this, and
   * the window's `backdrop-filter` undoes the same 50% scrim it always did.
   */
  still: "pointer-events-none absolute inset-0",

  /**
   * The darkening.
   *
   * `bg-scrim-page` — the same 50% black the interface has always been read
   * against, which is why the window's `backdrop-filter` can undo it exactly.
   * It is a layer over the footage rather than a `brightness()` on it: a filter
   * on a video forces it onto its own composited layer for every frame, and the
   * result would be identical.
   */
  veil: "bg-scrim-page pointer-events-none absolute inset-0",

  /**
   * The grain.
   *
   * Inset **negatively** by more than `GRAIN.shift`, so the tile can step in any
   * direction without ever baring an edge inside the stage. `overlay` blending
   * is the whole reason it reads as emulsion rather than as a grey wash — see
   * `GRAIN`.
   */
  grain: "pointer-events-none absolute -inset-[6rem] [mix-blend-mode:overlay]",

  /**
   * The tally lamp, top-left **inside** the window.
   *
   * A child of the card, like the crosshair, which is safe: what a
   * `backdrop-filter` element must not have is an ancestor carrying a transform,
   * and a child carries nothing. Inset by the same 1rem on both axes so it reads
   * as sitting in the corner of the frame rather than on its edge — and the
   * offset is a rem, so it holds that relationship as the adaptive root scales.
   *
   * `size-[0.5rem]`, which is 8px at 1440. Large enough to be a lamp, small
   * enough that it never competes with the crosshair at the centre.
   */
  rec: "bg-foreground-signal pointer-events-none absolute left-[1rem] top-[1rem] size-[0.5rem] rounded-full max-lg:left-[12px] max-lg:top-[12px] max-lg:size-[7px]",

  /**
   * A crosshair at the centre of the window.
   *
   * The card is a hole in the page scrim — a viewfinder — and a viewfinder has a
   * mark at its centre. Two hairlines rather than a glyph, so it is the same
   * thickness at every size and owes nothing to a font.
   *
   * `pointer-events-none` because the card is not a control, and cream at 40%
   * because a mark that competes with the photograph is a mark in the way. It is
   * a **child of the card**, which is safe: what a `backdrop-filter` element
   * must not have is an ancestor carrying its own transform, and a child carries
   * nothing.
   */
  crosshair:
    "pointer-events-none absolute left-1/2 top-1/2 size-[1.5rem] -translate-x-1/2 -translate-y-1/2 opacity-40 max-lg:size-[20px]",
  crosshairBar:
    "bg-foreground-accent absolute left-1/2 top-1/2 h-px w-full -translate-x-1/2 -translate-y-1/2",
  crosshairBarVertical:
    "bg-foreground-accent absolute left-1/2 top-1/2 h-full w-px -translate-x-1/2 -translate-y-1/2",

  card: "rounded-media absolute left-[29.375rem] top-[calc(50%-9.84375rem)] h-[19.6875rem] w-[31.25rem] max-lg:left-0 max-lg:right-0 max-lg:mx-auto max-lg:w-[min(100vw-3rem,78vw,(100vh-36rem)/0.63)] max-lg:h-[calc(min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.63)] max-lg:top-[calc(50%-min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.315)] max-md:w-[min(100vw-3rem,(100vh-30rem)/0.63)] max-md:h-[calc(min(100vw-3rem,(100vh-30rem)/0.63)*0.63)] max-md:top-[calc(50%-min(100vw-3rem,(100vh-30rem)/0.63)*0.315)]",

  cardCaptionTop:
    "absolute left-[29.375rem] top-[calc(50%-11.15625rem)] w-[31.25rem] max-lg:left-0 max-lg:right-0 max-lg:mx-auto max-lg:w-[min(100vw-3rem,78vw,(100vh-36rem)/0.63)] max-lg:top-[calc(50%-min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.315-23.2px)] max-md:w-[min(100vw-3rem,(100vh-30rem)/0.63)] max-md:top-[calc(50%-min(100vw-3rem,(100vh-30rem)/0.63)*0.315-23.2px)]",

  cardCaptionBottom:
    "absolute left-[29.375rem] top-[calc(50%+10.59375rem)] w-[31.25rem] max-lg:left-0 max-lg:right-0 max-lg:mx-auto max-lg:w-[min(100vw-3rem,78vw,(100vh-36rem)/0.63)] max-lg:top-[calc(50%+min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.315+12px)] max-md:w-[min(100vw-3rem,(100vh-30rem)/0.63)] max-md:top-[calc(50%+min(100vw-3rem,(100vh-30rem)/0.63)*0.315+12px)]",

  /*
   * Below the desktop base the two display blocks straddle the card — "Beyond
   * Places." above it, "Into Moments." below — so each needs its own offset,
   * measured from the card's own edge rather than from the centre line.
   *
   * The phone numbers are px, not rem, on purpose: the type they space is
   * itself a fixed px size (see `titleType`), while the root font-size runs
   * from 14.2 to 28.4 across this range.
   *
   * Both offsets are read as the **gap they leave**, and both gaps are values
   * off the hero's own vertical ladder (24 · 34 · 46 · 5.5rem):
   *
   *   −87 → the heading's trimmed 30px line box sits **34** above the caption
   *         row, which starts at −23.2
   *   +69 → "Into Moments." starts **46** below the caption row, which ends at
   *         +12 plus its own 11.2 line
   *
   * The numbers that move are the offsets, never the gaps: 34 and 46 are two
   * consecutive rungs, and the pair is deliberately uneven. The upper gap
   * separates a heading from the caption *of the card below it*, the lower one
   * separates a caption from the heading *under it* — the second break is the
   * larger of the two because it is where the phrase resumes.
   *
   * Neither touches the card's own 21/12 caption gaps, which are Figma's.
   */
  titleStart:
    "absolute right-[62.125rem] top-[calc(50%-4.3125rem)] w-[14.875rem] text-right max-lg:right-page max-lg:left-page max-lg:w-auto max-lg:text-center max-lg:top-[calc(50%-min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.315-9.5rem)] max-md:top-[calc(50%-min(100vw-3rem,(100vh-30rem)/0.63)*0.315-87px)]",

  titleEnd:
    "absolute left-[62.125rem] top-[calc(50%-4.3125rem)] w-[21.258625rem] max-lg:left-page max-lg:right-page max-lg:w-auto max-lg:text-center max-lg:top-[calc(50%+min(100vw-3rem,78vw,(100vh-36rem)/0.63)*0.315+5.75rem)] max-md:top-[calc(50%+min(100vw-3rem,(100vh-30rem)/0.63)*0.315+69px)]",

  /*
   * Gone on a phone. Its country list is already hidden there, so all that is
   * left is the label — which sits in the same bottom row as EXPLORE
   * DESTINATIONS, ends exactly where that one begins, and says nearly the same
   * thing twice. The link survives: EXPLORE DESTINATIONS points at the same
   * place.
   */
  destinations:
    "absolute left-[62.125rem] bottom-page max-lg:left-page max-md:hidden",

  /*
   * Bottom-left on desktop, centred along the top row on a tablet, and gone on
   * a phone.
   *
   * It briefly lived under "Beyond Places." there. Both placements were wrong
   * for the same reason: the switcher is a control over the card, and on a
   * phone there is nowhere to put it that reads that way — in the top row it
   * became a third piece of chrome between the wordmark and MENU, and under
   * the heading it split the title from its own caption row. The card is
   * legible without it, and the reveal order is unaffected: `UI_ORDER` still
   * lists the group, the element is simply not painted.
   */
  viewModes:
    "absolute left-page bottom-page max-lg:left-0 max-lg:right-0 max-lg:bottom-auto max-lg:top-page max-lg:mx-auto max-lg:w-fit max-md:hidden",

  /** Display type does not scale with the viewport — it would vanish. The
   *  reference holds it at ~11% of the screen width on a phone against 6.25%
   *  on desktop, i.e. relatively larger, not smaller. 42px keeps either line
   *  on one row inside the 338px content column at 390. */
  titleType:
    "text-display leading-title max-lg:text-[56px] max-lg:leading-[44.8px] max-md:text-[42px] max-md:leading-[33.6px]",

  /** The wordmark is the one piece of display type that must NOT grow on a
   *  phone: at 1.5rem it rides the adaptive root up to 26px and takes a
   *  quarter of the screen width, against the reference's 18%. Pinned to the
   *  tablet's rendered 18px. */
  wordmarkType:
    "text-wordmark leading-wordmark max-md:text-[18px] max-md:leading-[16.2px]",
} as const;

/**
 * Thumbnails keep bleeding off the frame but take less room on a small screen.
 * Desktop is the Figma placement: 227×132/133 at x=607, i.e. centred.
 *
 * Gone entirely on a phone. At 6.5×4.4rem there is not enough of either
 * photograph left to read, and the pair was spending 152px of an 844px screen
 * on that — the top one crowding the wordmark row, the bottom one occupying
 * exactly the floor the call to action needed.
 */
export const THUMBNAIL_CLASS = {
  top: "absolute top-0 left-[37.9375rem] w-[14.1875rem] h-[8.25rem] max-lg:left-1/2 max-lg:-ml-[7rem] max-lg:w-[14rem] max-lg:h-[8.1rem] max-md:hidden",
  bottom:
    "absolute bottom-0 left-[37.9375rem] w-[14.1875rem] h-[8.3125rem] max-lg:left-1/2 max-lg:-ml-[7rem] max-lg:w-[14rem] max-lg:h-[8.1rem] max-md:hidden",
} as const;
