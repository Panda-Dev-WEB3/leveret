/**
 * Every measurement block 4 takes from Figma, in one place.
 *
 * Source: Get Layers, file WINXFW2nTM7zYwd5dGgm1T — five frames, all 1440×800,
 * all the same block at five points of what used to be one scroll:
 *   1678:1116 — the opening, four equal panels
 *   1680:1248 — panel 1 open
 *   1680:1323 — panel 2 open
 *   1686:1365 — panel 3 open
 *   1686:1393 — panel 4 open
 *
 * **The block is no longer scrolled — it is pointed at.** Four of those five
 * frames are still exactly what is drawn; what changed is what moves between
 * them. The scroll track, the five-stop keyframe table and the pure
 * `poseAt(progress)` that read it are gone, and in their place is one piece of
 * state — which panel is open — and a slide that runs on a pointer, a tap, a
 * focus or an arrow key. See `SLIDE` and [[travel]] for the whole shape of it.
 *
 * **Unlike blocks 2 and 3 this is not a container-query scene.** Those two are
 * compositions that sit inside one screen and keep the 1440×800 aspect; this one
 * is a full-bleed strip whose panels have to touch all four edges at any window
 * size, so there is no fixed-ratio box for `cqw` to resolve against.
 *
 * What replaces it is the file's own arithmetic. Every horizontal number in the
 * design is a clean fraction of 1440 — 720 is a half, 240 is a sixth, 360 is a
 * quarter — so the strip is expressed in percentages and is exact at any width.
 * Everything else is rem, which the adaptive grid (globals.css) already scales
 * by viewport, so a 64px heading is 64px at 1440 and proportional below it.
 *
 * 📖 Docs: obsidian/frontend/travel.md
 */

/** Figma frame width (px) every offset below is measured against. */
export const FRAME_WIDTH = 1440;
/** Figma frame height (px). */
export const FRAME_HEIGHT = 800;

/** Four panels, and the arithmetic only closes for four. */
export const PANEL_COUNT = 4;

/**
 * How much of the strip the open panel takes, as a flex weight against the
 * other three at 1.
 *
 * The file's own arithmetic was a share table — 720 of 1440 for the open panel
 * and 240 for each shut one, a half and three sixths — and this is the same
 * thing said as a weight: 2.5 against 3×1 puts the open panel at 45.5% where the
 * file draws 50. The narrow strip runs vertically and the open panel has to hold
 * a heading over a body and a sign-off rather than a column beside three unused
 * ones, so it takes more: 3.4 against 3 is 53%, against the file's 60.
 *
 * Weights rather than the share table because the panel is now *chosen*, not
 * interpolated: there is no in-between state to keep summing to 100, so the one
 * number that says "the open one is this much bigger" is the whole rule.
 */
export const WIDEN = { wide: 2.5, narrow: 3.4 } as const;

/** The four weights, with `open` carrying `WIDEN` and the rest at 1. */
export const toWeight = (isOpen: boolean, widen: number): number =>
  isOpen ? widen : 1;

/** A weight as a percentage of the strip, so `flex-basis` can stay exact. */
export const toShare = (weight: number, widen: number): number =>
  (weight / (widen + PANEL_COUNT - 1)) * 100;

/**
 * How far a shut panel's photograph is turned down: a quarter if it has already
 * been read, and less — 0.15 — if it is still ahead. The design uses the
 * difference as a reading direction, so what is behind you stays a little more
 * present than what is in front.
 *
 * The file breaks its own rule twice: in the opening frame and in "panel 1
 * open", the second panel is drawn at 0.25 although it sits to the *right* of
 * the open one. Both are artefacts of the mock — the rule is applied instead,
 * on instruction, so panel 2 reads 0.15 in those two states.
 *
 * These are the **resting** layer's numbers now. The photograph is on screen
 * twice: once turned down like this, always, as the panel's own ground; and once
 * at full strength on the layer that slides. See `CLASS.rest` / `CLASS.media`.
 */
const DIM_READ = 0.25;
const DIM_AHEAD = 0.15;

/** What a panel's resting photograph is worth, given which one is open. */
export const toRestDim = (index: number, open: number): number =>
  index < open ? DIM_READ : DIM_AHEAD;

/**
 * The conveyor's travel, in percent of the layer's own height.
 *
 * 101 rather than 100 so a sub-pixel rounding at the seam cannot leave a
 * hairline of the layer showing at either end.
 *
 * The copy needs no constant of its own: it travels exactly 100% of a window
 * that is exactly its own height, written in the class as
 * `calc(100% * (1 - var(--b4-open)))`. See `CLASS.copyClip`.
 */
export const MEDIA_TRAVEL = 101;

/**
 * The one config every part of the swap runs on.
 *
 * **A spring, and it used to be a duration.** The duration was chosen for a good
 * reason and it was the wrong tool for this: four things move at once here — the
 * photograph in, the last photograph out, the shares, the copy — and they read as
 * one movement only if they *are* one movement. A shared 900ms clock gave that
 * for free, as long as the swap ran uninterrupted.
 *
 * Rapid switching is nothing but interruption, and it is where a duration comes
 * apart in two ways at once:
 *
 * 1. **A restarted duration begins at zero velocity.** `cubic-bezier(.76,0,.18,1)`
 *    is a hard ease-in-out, so every change of mind planted a full stop in the
 *    middle of a movement that was already going. The stop-start is the "jerky"
 *    in the report.
 * 2. **The clock stops being shared.** Two panels that restarted at different
 *    moments are on different clocks, and `Σ share` is then no longer 100 —
 *    which is the invariant the flex row was built on. See `CLASS.panel` for the
 *    other half of this fix; between them, the sum can no longer matter.
 *
 * A spring carries velocity through an interruption, which is the whole property
 * being asked for. It also keeps the "one movement" the duration was chosen for:
 * a linear second-order system settles in a time set by its **config**, not by
 * its distance, so four values on one config still arrive together whatever their
 * magnitudes — 101 percent of travel and 25 of flex alike.
 *
 * `{130, 28}` is overdamped (critical friction at this tension is ~22.8), so
 * nothing overshoots — this is a conveyor, and a conveyor that bounces at the end
 * is a conveyor with a fault. It settles in about the 900ms the duration took, so
 * the weight of the movement is unchanged.
 */
export const SLIDE = {
  tension: 130,
  friction: 28,
} as const;

/**
 * How far the section has to have risen before its heading is allowed to arrive,
 * as a share of the viewport measured from the top of the window.
 *
 * The section is pulled up a whole screen (`lg:-mt-[100dvh]`) so it can slide
 * over block 3, which means its **box enters the viewport a screen before the
 * reader can see any of it**. Entering view is therefore not a cue here — it is
 * a cue for something happening underneath another block, and the heading was
 * spending its whole reveal there. By the time block 4 was actually on screen
 * the letters had long since landed, so the heading simply existed: reported as
 * "this heading doesn't animate", which is exactly what an animation that played
 * out of sight looks like.
 *
 * 0.55 is the section's top edge just past the middle of the window — over half
 * of it showing, so the heading is unambiguously being looked at.
 */
export const HEAD_CUE = 0.55;

export const CLASS = {
  /**
   * **One screen. No track, no pin.**
   *
   * It was 400vh of scroll — four transitions plus an opening hold, roughly a
   * screen each — with the strip pinned inside it. The accordion is driven by
   * the pointer now, so a track would be four screens of scrolling that changed
   * nothing, and a pin would hold the page still while it did. The block is
   * simply a screen you arrive at, like block 2.
   *
   * `dvh` and not `vh`: the reason the track needed `vh` was that it was the
   * denominator of a progress value and a retracting address bar would move it
   * mid-flick. Nothing measures this box any more — it only has to fill what is
   * actually on screen, which is what `dvh` is.
   *
   * `isolate` is load-bearing and stays: the two gradients blend with
   * `multiply`, and without a stacking context here they would reach past their
   * own panel and multiply against its neighbours.
   *
   * **The block opens a screen early and over block 3.** `-mt-[100dvh]` and
   * `z-10` against that block's `z-0` are the same pair block 2 uses over it —
   * the seam is now the same shape at both ends of block 3. What it buys is that
   * block 3's pin releases exactly as this block's top edge reaches the bottom
   * of the window, so its picture **carries on scrolling** while this one rises
   * over it and cuts it off from the bottom, instead of holding still until it
   * is replaced.
   *
   * Desktop only. Below the base block 3 is a flow column of its own height,
   * with no screen of pin to overlap.
   */
  section:
    "bg-surface-gallery relative z-10 h-dvh w-full overflow-hidden isolate -mt-[100dvh]",

  /**
   * The four panels, edge to edge. A row on desktop, a column below it.
   *
   * A tablet takes the heading group out of the strip and gives it its own band;
   * **a phone does not**. There the strip fills the screen again and the heading
   * floats over the first photograph the way the desktop's does — a band of flat
   * `--surface-gallery` above four pictures reads as a gap in the page rather
   * than as the top of this block.
   */
  strip:
    "absolute inset-0 flex max-lg:flex-col",

  /**
   * One panel. `isolate` again, per panel, so each pair of gradients multiplies
   * against its own photograph and nothing else.
   *
   * `grow-0 shrink-0` because the size is written to `flex-basis` every frame:
   * left free to grow or shrink, flex would quietly renormalise the four shares
   * and the arithmetic above would stop being the arithmetic on screen.
   */
  /**
   * **`flex-grow`, not `flex-basis` — the share is a ratio, not a width.**
   *
   * It was `grow-0 shrink-0 basis-[calc(var(--b4-share)*1%)]`, which asks the
   * four shares to sum to exactly 100 at every instant or the row gaps at its
   * right edge. `toShare` does guarantee that at rest, and a shared 900ms clock
   * guaranteed it in flight — every panel's eased progress was the same number,
   * so `Σ start` and `Σ end` both being 100 made `Σ` 100 all the way across.
   *
   * Rapid switching breaks the clock. Two panels that restarted at different
   * moments have different progresses, `Σ` is no longer 100, and with `shrink-0`
   * the remainder lands on the **last** panel — which is exactly where the report
   * says the jerk is worst.
   *
   * As grow factors on a zero basis the sum cannot matter: whatever the four
   * numbers are at any frame, flex divides the row by their ratio and the four
   * always fill it exactly. The invariant stops being *temporal* — something the
   * animation has to keep holding — and becomes **structural**, which is
   * something nothing can break.
   *
   * `min-w-0` because a flex item's automatic minimum size is its content, and a
   * shut panel's name is wider than its share.
   */
  panel:
    "group relative shrink self-stretch min-w-0 basis-0 [flex-grow:var(--b4-share)] cursor-pointer overflow-hidden isolate outline-none [--b4-share:25]",

  /**
   * The focus ring, as the panel's own inset outline.
   *
   * A panel is a `role="tab"` with `tabindex="0"` and no border of its own, so
   * there is nothing for a default outline to draw around that would read at the
   * seam between two full-bleed photographs. An inset ring on a pseudo-element
   * above the art is what the reference does and it is right for the same
   * reason: it is inside the clip, so it never overlaps a neighbour.
   *
   * `focus-visible`, so a pointer never draws it — this element takes focus on
   * click as well as on Tab.
   */
  focusRing:
    "after:pointer-events-none after:absolute after:inset-0 after:z-[3] after:transition-[box-shadow] after:duration-[var(--duration-normal)] after:ease-entrance after:[box-shadow:inset_0_0_0_2px_transparent] focus-visible:after:[box-shadow:inset_0_0_0_2px_var(--color-foreground-accent)] motion-reduce:after:transition-none",

  /**
   * The layer that slides: the photograph at full strength, with the two
   * darkening gradients over it.
   *
   * It is clipped by the panel, starts a hair past the bottom edge, and leaves
   * a hair past the top — one continuous upward conveyor, one panel in as the
   * last one goes out. `will-change` because this is the block's one large
   * moving surface and it moves 900ms at a time.
   */
  media: "absolute inset-0 z-[1] will-change-transform",

  /**
   * The layer that does not: the same photograph, turned down, always there.
   *
   * The reference has nothing under its sliding art — a shut column is bare
   * paper. This block cannot be that: the four photographs *are* the content,
   * and three of them going blank would take the block's whole picture off the
   * screen between one pointer move and the next. So the panel keeps its
   * resting photograph at `DIM_READ` / `DIM_AHEAD` exactly as the file draws it,
   * and what the conveyor carries is the same frame at full strength.
   *
   * Same `src` as the sliding copy, so it is one download and one decode.
   */
  rest: "absolute inset-0 z-0",

  /**
   * The first panel, on a phone only: tall enough to carry the heading group.
   *
   * **The floor is tied to how lit the panel is, not to whether it is open.**
   * That distinction is the whole design here, and it comes from the picture:
   * the group of travellers stands from roughly 37% of the photograph down, and
   * the heading group ends at 153. For the two never to touch, the panel has to
   * be about 540 tall — but a floor that high held *permanently* would leave the
   * other three only 100px between them, and whichever of those is open needs
   * 234 for its own name, body and sign-off. The two demands do not fit in one
   * phone screen.
   *
   * They do not have to. The travellers are only *visible* while this panel is
   * lit — the moment another one opens it drops to a quarter and the picture
   * goes dark enough that the heading reads cleanly over it. So the floor is:
   *
   *   248 dimmed — the sum of what has to clear its own name: 88 to the title
   *                (block 2's own mobile inset), 65 for the title over its
   *                handwritten line, 46 of air on the hero's ladder, the 21 the
   *                name occupies, and the page margin under it.
   *   560 lit    — the raised flag sits at 35.5% of the photograph, measured off
   *                the render, so 560 puts it at 199 — a clear 46 below the
   *                handwritten line, on the hero's ladder. This is the size in
   *                the two states where the picture is at full strength: the
   *                opening, and this panel open.
   *
   * `min(560px, 70dvh)` so a short screen gives up the air before it gives up
   * the other three panels. Past about 750px of window the 560 binds and the air
   * is the full 46; below that it narrows, and at 360×640 — the smallest phone
   * worth supporting — the floor lands at 448 and the flag at 159, six clear of
   * the line. A screen that short cannot both show a whole photograph and hold
   * its subject clear of the type; six is what it has.
   *
   * The component writes `calc(lead + lit × <how lit>)`, where "how lit" is this
   * panel's own dimming remapped to 0→1, so the floor breathes with the picture
   * instead of switching under it. Both vars are 0 outside the phone range, so
   * `calc` resolves to nothing and desktop and tablet keep their arithmetic.
   */
  panelLead:
    "[--b4-lit:0] min-h-[calc(var(--b4-lead)_+_var(--b4-lead-lit)*var(--b4-lit))] [--b4-lead:0px] [--b4-lead-lit:0px] max-lg:[--b4-lead:248px] max-lg:[--b4-lead-lit:calc(max(248px,min(664px,65dvh))-248px)] max-md:[--b4-lead-lit:calc(max(248px,min(560px,70dvh))-248px)]",

  /**
   * The other three, on a phone only: allowed to shrink.
   *
   * The four shares always sum to 100, so a floor under one of them has to come
   * out of the others or the strip overflows its screen. Letting exactly these
   * three shrink takes it out of them **in proportion to their own shares**, so
   * the 3:1 ratio between an open panel and a shut one survives intact — the
   * accordion still reads as an accordion, it just runs under a taller first
   * picture.
   */
  panelFollow: "max-lg:shrink",

  /** The photograph, cropped to whatever width the panel currently has. */
  photo: "absolute inset-0",

  /**
   * The first photograph keeps its **top** below the desktop base, not its
   * centre.
   *
   * On a tablet the panel is wide, so `cover` scales by width and the picture
   * comes out much taller than the row — 853 of a 664-tall row at 768, 1138 of
   * 499 at 1024×768 — and a centred crop throws away the sky and lifts the
   * travellers to the top of the frame, right under the heading. At 1024×768 the
   * raised flag landed at 85 against a heading group ending at 161. Anchoring
   * the top keeps the sky and puts the flag at 404.
   *
   * On a phone it does nothing at all: the height floor there is taller than the
   * picture's cover height, so the whole image is already shown and there is no
   * vertical crop left to position.
   */
  photoLead: "max-lg:object-top",

  /**
   * The two darkening gradients, both `multiply`, both Figma layers kept as
   * separate elements so each one is one thing: black at half strength falling
   * to nothing over the full height, and the same rising 521 of 800 — 65.125% —
   * from the foot, which is what holds the copy off the picture.
   *
   * **The foot one gets a floor below the desktop base, and it is a legibility
   * fix, not a taste one.** 65.125% is a share of the panel, but the copy is a
   * fixed height above the foot — so on a short row the gradient shrinks out from
   * under the text while the text stays put. Measured on a 360×640 phone, the
   * body sat at a multiply factor of 0.653 against the desktop's 0.557, and the
   * contrast of cream-at-half over the four photographs fell to 2.76–3.86 from
   * the desktop's 3.13–4.12 — worst on the snow. A 300px floor restores
   * 3.23–4.18, so a phone reads at least as well as the signed-off desktop
   * without touching a single colour.
   */
  veilTop:
    "pointer-events-none absolute inset-0 mix-blend-multiply bg-[linear-gradient(to_bottom,var(--color-scrim-panel),transparent)]",
  veilFoot:
    "pointer-events-none absolute inset-x-0 bottom-0 h-[65.125%] mix-blend-multiply bg-[linear-gradient(to_top,var(--color-scrim-panel),transparent)] max-lg:h-[max(65.125%,300px)]",

  /**
   * The block's heading group: "How We Travel." over the handwritten line, 32
   * apart, centred on the frame at top 100.
   *
   * The file draws the group at left 553 with no transform in one frame and
   * centred in the others; 553 + 334/2 is 720, so the two are the same thing and
   * the centre is what is built.
   *
   * A tablet gives it its own band above the strip. **A phone puts it back on
   * the photograph**, floating at 88 from the top — block 2's own mobile inset,
   * not a number invented here — over a first panel that is tall enough to hold
   * it (see `panelLead`).
   *
   * **On a phone it also leaves when the first card closes**, on the same factor
   * that governs that panel's height: the two belong together, because the
   * heading only has a picture to sit on while the first panel is lit. The floor
   * keeps the opacity at 1 above the phone range, where the heading is in every
   * frame of the file and never fades.
   */
  header:
    "pointer-events-none absolute left-1/2 top-[6.25rem] z-[5] flex w-max -translate-x-1/2 flex-col items-center gap-[2rem] text-center [--b4-header-floor:1] [--b4-head-lit:1] opacity-[max(var(--b4-header-floor),var(--b4-head-lit))] max-lg:top-[88px] max-lg:w-full max-lg:px-page max-lg:gap-[24px] max-lg:[--b4-header-floor:0]",

  /** Instrument Serif 64/51.2, cream. */
  title:
    "text-foreground-accent font-display text-trim text-[4rem] leading-[3.2rem] whitespace-nowrap max-lg:whitespace-normal max-lg:text-[48px] max-lg:leading-[38.4px] max-md:text-[36px] max-md:leading-[28.8px]",

  /** Caveat 24, cream at 0.4. */
  subtitle:
    "text-foreground-accent-muted font-hand text-trim text-[1.5rem] leading-[1.5rem] max-lg:text-[24px] max-lg:leading-[24px]",

  /**
   * The foot of a column: the name, and the copy that comes out from under it.
   *
   * A box of no height, anchored at the page margin, that only exists to hold
   * the two of them and to carry the **one factor** they both read.
   * `--b4-open` is 0 shut and 1 open, on the block's own 900ms curve, and it
   * drives the name's lift and the copy's rise from the same number — so the two
   * cannot fall out of step: the copy arrives exactly as fast as the name gets
   * out of its way.
   *
   * `--b4-copy-height` is measured, because the four sentences wrap to different
   * heights and each name has to rise by its own copy's, not by an average.
   */
  foot: "absolute inset-x-page bottom-page z-[2] text-center [--b4-open:0] [--b4-copy-height:0px] [--b4-heading-gap:2rem] max-lg:[--b4-heading-gap:32px]",

  /**
   * A panel's name, which is what the copy comes out from under.
   *
   * Shut, it sits on the page margin at the foot of its column — the position
   * the file draws and the one it has always had. Open, it lifts by exactly the
   * copy's height plus the 32 above it, which is the same arithmetic the
   * scroll-driven version used and the same two Figma frames as its ends; what
   * has changed is that one boolean drives it rather than a scroll position.
   *
   * `inset-x-0` with `text-center` rather than `left-1/2` and a centring
   * `translateX`: the transform is spoken for by the lift, and a name that is
   * wider than a shut column has to overflow evenly to both sides.
   *
   * The colour is the one CSS transition in this block — muted cream shut, full
   * cream open, on token-backed timing off `aria-selected`. ADR-0014's own
   * example of what a transition is for.
   */
  heading:
    "text-foreground-accent-muted font-display text-trim absolute inset-x-0 bottom-0 z-[1] whitespace-nowrap text-[1.75rem] leading-[1.4rem] transition-colors duration-[var(--duration-normal)] ease-entrance group-aria-selected:text-foreground-accent [transform:translate3d(0px,calc((var(--b4-copy-height)_+_var(--b4-heading-gap))*-1*var(--b4-open)),0px)] max-lg:text-[28px] max-lg:leading-[22.4px] max-md:text-[24px] max-md:leading-[19.2px] motion-reduce:transition-none",

  /**
   * The window the copy comes up through.
   *
   * Its height is the copy's own, written from the measurement, so the inner
   * layer's `translateY(100%)` puts it exactly one copy-height below the window
   * and out of sight. That equality is the whole reason the height is stated
   * rather than left to `auto`: a percentage travel is a percentage of the
   * *moving* element, and only a window the same size as it can be cleared by
   * 100%.
   *
   * > [!warning] The window is a rem taller than the copy, for the same reason
   * > `.body` and `.signOff` carry `text-trim`, so their **boxes are smaller
   * > than their ink** — measured, a two-line body at 16/19.2 lays out a box of
   * > 31px against 38.4 of line. A window exactly as tall as the copy therefore
   * > cuts the ascenders of the first line along its top edge, which is what a
   * > reader sees as the text being clipped. The extra rem goes at the **top**,
   * > which is where the overshoot is: the copy is anchored to the window's
   * > bottom so its baseline stays on the page margin the file draws it at, and
   * > the clearance opens above it.
   * >
   * > The name's lift does not change with it — that is measured from the copy's
   * > box, and the box is where the copy sits, not where its ink reaches.
   *
   * > [!warning] 100% is not quite enough, because the box is trimmed
   * > The copy travels `100% + 1rem`, and the extra is not a fudge. `.body` and
   * > `.signOff` both carry `text-trim` — `text-box-trim`, which cuts the line
   * > box down to the cap height — so the element's **box is smaller than its
   * > ink**, and ascenders paint above their own top edge. Translated by exactly
   * > its own height the copy's box cleared the window while that overshoot did
   * > not: measured, a legible line of every shut column's sentence sat in the
   * > page-margin band under its name. Proved by turning one of them red.
   * >
   * > The same reasoning as `MEDIA_TRAVEL`'s 101% — travel a hair further than
   * > the arithmetic says, because the arithmetic is about boxes and what shows
   * > is ink.
   */
  copyClip:
    "absolute inset-x-0 bottom-0 isolate h-[calc(var(--b4-copy-height)_+_1rem)] overflow-hidden max-lg:h-[calc(var(--b4-copy-height)_+_16px)]",

  /**
   * The copy itself: the sentence over its handwritten line, 40 apart as the
   * file draws them, rising on the same `--b4-open` the name falls back on.
   *
   * No fade. The reference's conveyor does not cross-dissolve anything — a layer
   * is either in the window or out of it — and a copy that faded as well would
   * read as two effects on one movement.
   */
  copy:
    "absolute inset-x-0 bottom-0 flex flex-col items-center gap-[2.5rem] [transform:translate3d(0px,calc((100%_+_1rem)*(1_-_var(--b4-open))),0px)] max-lg:gap-[24px]",

  /**
   * Inter Tight Medium 16/19.2 uppercase, cream at half — **at 0.8 below the
   * desktop base**, and that is the one colour this block changes.
   *
   * It is the only text here that is not full-strength cream, and it is the only
   * one that fails to carry on a small screen. Measured against the four
   * photographs under both gradients, cream-at-half reads 3.2–4.2 on a 360×640
   * phone; 0.8 takes it to 5.6–8.2, clear of the 4.5 a 16px line is held to.
   * Darkening the picture further does not help — the copy is semi-transparent,
   * so it darkens with its own background and the ratio barely moves. Raising
   * the ink is the only lever that does.
   *
   * The heading and the sign-off need nothing: both are already full cream.
   */
  body: `mx-auto font-ui text-foreground-accent-soft text-trim w-[var(--b4-copy)] text-[1rem] leading-[1.2rem] uppercase max-lg:text-foreground-accent-strong max-lg:w-auto max-lg:text-[16px] max-lg:leading-[19.2px] max-md:text-[14px] max-md:leading-[16.8px]`,

  /**
   * Caveat 18, cream — one rung up to 20 below the desktop base. Caveat is a
   * handwriting face and loses legibility faster than the other two as the
   * screen shrinks; block 3 learned the same thing and took its sign-off *up* on
   * a tablet rather than down.
   */
  signOff: `text-foreground-accent font-hand text-trim text-[1.125rem] leading-[1.125rem] whitespace-nowrap max-lg:text-[20px] max-lg:leading-[20px] max-md:text-[16px] max-md:leading-[16px]`,
} as const;

/** Everything below the desktop base runs the strip vertically. */
/**
 * The narrow layout: four cards, one under another, and nothing to open.
 *
 * > [!important] Below the desktop base this block stops being an accordion
 * > A column accordion asks the reader to *choose* — hover, tap, arrow — and on
 * > a phone the gesture that reaches it is the same one they are already using
 * > to scroll past. So three quarters of the block's content sat behind an
 * > interaction that a scrolling thumb triggers by accident, inside a section
 * > pinned to one screen with `overflow: hidden`.
 * >
 * > Stacked, every card is a card: its photograph, its name, its sentence, its
 * > sign-off, all present, all readable, in the order the file draws them. The
 * > section grows to fit them instead of clipping them. Nothing animates except
 * > the photographs, which drift against their frames as the page moves — see
 * > `STACK_PARALLAX`.
 * >
 * > This is not a reduced version of the desktop behaviour. It is the same
 * > content with the interaction taken out, because the interaction was the part
 * > that did not survive the width.
 */
export const STACK = {
  /**
   * The stack rises over block 3 exactly as the desktop strip does — `-mt` at
   * every width, not `lg:`. The overlap is the page's grammar, not a desktop
   * flourish: it is what makes block 3 a window that content is clipped out of
   * rather than a section that simply ends.
   */
  section: "bg-surface-gallery relative z-10 w-full -mt-[100dvh]",

  /** The heading group, in the flow above the cards rather than floating. */
  header: "px-page pt-[104px] pb-[48px] text-center max-md:pt-[88px]",

  cards: "flex flex-col",

  /**
   * One card. Tall enough for the photograph to be a photograph and short
   * enough that four of them are a stack rather than four screens.
   */
  card: "relative isolate h-[62dvh] min-h-[26rem] overflow-hidden max-md:h-[56dvh] max-md:min-h-[22rem]",

  /**
   * The photograph, oversized on both ends so the drift has somewhere to go.
   * 120% tall at −10% leaves a tenth of the card's height of slack each way
   * against `STACK_PARALLAX`'s 0.08.
   */
  photo: "absolute inset-x-0 top-[-10%] h-[120%] will-change-transform",

  /**
   * Name, sentence and sign-off — **centred in the card**, not sat at its foot.
   *
   * At the foot they read as a caption under a photograph. Centred they are the
   * card's content and the photograph is its ground, which is what these four
   * are: a name, what it means, and a line in the author's own hand.
   *
   * The gaps are wide on purpose — 32px against the 16 they had. Three lines in
   * three different faces need air between them or they read as one block that
   * changes typeface twice.
   */
  foot: "absolute inset-x-page inset-y-0 z-[2] flex flex-col items-center justify-center gap-[32px] text-center max-md:gap-[24px]",

  heading:
    "text-foreground-accent font-display text-trim text-[28px] leading-[22.4px] max-md:text-[24px] max-md:leading-[19.2px]",
} as const;

export const NARROW_QUERY = "(max-width: 1024px)";

/**
 * How far a stacked photograph drifts against its card, as a share of the
 * card's own height, end to end.
 *
 * 0.08 against the 0.10 of slack the photo box carries on each side
 * (`stackPhoto` is 120% tall at −10%), so the frame can never bare an edge no
 * matter where in the viewport the card sits. It is the only motion left in the
 * narrow layout, and that is the point: everything else there is simply *there*.
 */
export const STACK_PARALLAX = 0.08;

/** What each panel asks the browser to fetch: half the window, or all of it. */
export const PANEL_SIZES = "(max-width: 1024px) 100vw, 50vw";
