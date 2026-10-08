/**
 * Every measurement block 5 takes from Figma, in one place.
 *
 * Source: Get Layers, file WINXFW2nTM7zYwd5dGgm1T, frame 1705:253
 *   "Hero 2 (Block 5: CTA)" — 1440×1077.
 *
 * Like blocks 2 and 3 this is a **container-query scene**: the stage declares
 * `container-type: size` at 1440×1077 and every child is placed in `cqw` —
 * Figma pixels ÷ 1440 × 100 — type sizes included. A container query unit is
 * always a fraction of the container's *width*, so vertical numbers are divided
 * by 1440 too; the scene holds its aspect ratio, so the two are one picture.
 *
 * 📖 Docs: obsidian/frontend/plan.md
 */

/*
 * The one thing imported from another block rather than copied: block 3's
 * smoothstep is the curve the whole page eases with, and two literal copies
 * would drift apart on the next edit. Block 4 reads from block 3 the same way,
 * and nothing in block 3 is modified by being read from.
 */
import { smooth } from "@/views/home/philosophy/philosophy.geometry";

/** Figma frame width (px) every offset below is measured against. */
export const FRAME_WIDTH = 1440;
/** Figma frame height (px). */
export const FRAME_HEIGHT = 1077;

/*
 * Every `cqw` below is its Figma pixel ÷ 1440 × 100 — 561 reads back as
 * 38.9583, 1642 as 114.0278. No helper: the values are literals in the class
 * strings, because Tailwind's scanner has to see them whole.
 */

/**
 * How far each layer drifts against the cursor, in px at rest.
 *
 * Against, not with — the layers lean away from the pointer, which is what
 * makes a flat photograph read as depth. The three amplitudes are the depth
 * order: the mountains barely move, the ridge in front of you moves most.
 *
 * Px rather than `cqw` on purpose. This is a physical gesture answering a
 * physical device, and 28px of travel is 28px whether the scene is drawn at 1440
 * or filling a 2560 monitor — scaling it with the composition would make the
 * effect grow on exactly the screens where it is already most visible.
 */
export const PARALLAX = {
  far: { x: 8, y: 5 },
  steam: { x: 16, y: 10 },
  foreground: { x: 28, y: 16 },
} as const;

/**
 * The pointer spring. Soft and slow — the brief asks for "barely moving", and
 * the inertia is what separates that from a layer glued to the cursor.
 */
export const PARALLAX_CONFIG = { tension: 90, friction: 30 } as const;

/**
 * The steam is a still photograph, so its life is two loops of different
 * length running over it.
 *
 * **Two, and deliberately not one.** A single loop reads as a loop within a
 * couple of passes; 28s against 25s comes back into phase once every 700
 * seconds, which is longer than anyone stands here. That is what the brief
 * means by offsetting the phases.
 *
 * Both are `loop: { reverse: true }` on an `easeInOutSine`, so each end is a
 * turn rather than a stop — no pause, no snap back to the start.
 */
export const STEAM_DRIFT_MS = 28_000;
export const STEAM_PULSE_MS = 25_000;

/** Drift across, as a share of the layer's own width: ±1.5% is the brief's 3%. */
export const STEAM_DRIFT = 1.5;

/**
 * The scale breathes 1.00 → 1.04 **twice** per drift, peaking at each end of
 * the drift rather than in the middle of it.
 *
 * That is load-bearing, not decoration. The plate is exactly as wide as the
 * frame, so a 1.5% drift with no scale behind it would walk its edge into
 * view. Tying the peak to the extremes means the layer is always at least as
 * over-size as it is off-centre — 2% of overhang against 1.5% of travel — and
 * the seam can never open. It also gives the loop a second rhythm for free.
 */
export const STEAM_SCALE = 0.04;

/** Opacity floor; the pulse runs from here to 1, before `STEAM_STRENGTH`. */
export const STEAM_OPACITY = 0.85;

/**
 * How much of the steam plate actually reaches the picture. **This is the knob
 * for "cleaner or thicker".**
 *
 * At full strength the layer greys the whole composition instead of reading as
 * vapour, and the reason is the plate itself: its ink is a mid grey — RGB 110 —
 * spread thin over a wide, soft alpha, mean 61 of 255. Screened at full weight
 * that broad low alpha lifts *everything* by the same few points rather than
 * lighting up where the wisps are, and a uniform lift over a bright sky is what
 * the eye reads as dirt rather than as fog.
 *
 * Measured against Figma's own render of the frame, mean absolute difference
 * over the whole picture:
 *
 *   no steam at all   8.41   sky 189.1     ← the file's own look
 *   strength 0.25     8.43   sky 189.5
 *   **strength 0.40   8.55   sky 190.3**
 *   strength 0.60     8.97   sky 191.6
 *   strength 1.00    10.36   sky 196.1     ← +7 of milk over the whole sky
 *
 * 0.4 is the point where the layer is still a layer — it drifts, it breathes,
 * it catches the light where the wisps are dense — while the picture underneath
 * stays the picture Figma drew. Raise it if the stir should be more obvious;
 * every step costs clarity in the sky first.
 *
 * `screen` stays for the same reason it always did: it can only ever *add*
 * light, so however this is tuned the layer can never darken what is under it.
 */
export const STEAM_STRENGTH = 0.4;

/**
 * The curve that separates the wisps from the veil — and it is on **alpha**,
 * not on colour.
 *
 * The plate's problem was never its ink. Measured where the layer is actually
 * visible (alpha > 8), its RGB is **215.5** — very nearly white already. The
 * "mid grey, 110" figure that suggested otherwise was a mean taken over every
 * pixel including the fully transparent ones, where RGB is 0; it describes the
 * file's empty space, not its fog.
 *
 * That is why `filter: contrast() brightness()` cannot help here: both act on
 * the colour channels and leave alpha untouched, so they push an already-white
 * wisp to white and change nothing that reaches the screen. Swept from 1.4 to
 * 3.6 on both, every combination lands on the same numbers — MAD 8.66, sky
 * 190.3, peak lift 2.7 — against a no-filter baseline of 8.62 / 190.2 / 2.7.
 *
 * What is smeared is the **alpha**: mean 61 of 255 spread wide and soft. So the
 * curve goes there, through an SVG `feFuncA` — the one filter primitive that can
 * reshape a transfer function per channel:
 *
 *   a' = amplitude × a^exponent  ⇒  3 × a³
 *
 * At a = 0.24, the thin haze that veiled the sky, that is 0.04 — gone. At
 * a = 0.63, a dense clump, it is 0.75 — brighter than it was. Thin to
 * transparent, dense to solid, which is exactly the shape a body of vapour has.
 *
 * Scored against Figma's render, alongside the uncurved layer at the same 0.4
 * strength:
 *
 *   no curve         MAD 8.62   sky 190.2   veil 0.70   peak 2.7
 *   **3 × a³**       MAD 8.59   sky 190.2   veil 0.65   peak 3.7
 *
 * Better on the criterion, the same sky, *less* average veil, and half again
 * the peak. `color-interpolation-filters: sRGB` because the default is linear,
 * which would drag the colours through a conversion for no reason — only the
 * alpha channel is being touched.
 */
export const STEAM_ALPHA_GAMMA = { exponent: 3, amplitude: 3 } as const;

/**
 * The note writes itself when it comes into view.
 *
 * **A left-to-right wipe, not a stroke-draw.** The obvious technique for the two
 * red rules — `stroke-dasharray` walking a `stroke-dashoffset` — cannot work
 * here: both files are a single *filled* path (`fill="#EF000B"`, no stroke at
 * all), because they are traced outlines of a real pen mark rather than a line
 * with a width. There is no stroke to shorten.
 *
 * `clip-path: inset(0 X% 0 0)` gets the same reading for less: the mark appears
 * from its left end at whatever rate the curve dictates, which for a horizontal
 * gesture *is* the pen moving. It costs no layout — clip does not reflow — so a
 * centred line stays exactly where it was drawn while it is uncovered.
 *
 * The same wipe writes the text, one line at a time, which is why the copy is
 * three fragments rather than one string: a single clip over a wrapped paragraph
 * would uncover all three lines at once from the left, and nobody writes like
 * that.
 *
 * Windows overlap slightly so the hand does not stop between lines. The rules
 * come after all three, the way somebody goes back to underline what mattered,
 * and the handwritten aside signs off last.
 */
/**
 * The stretch of the section's arrival the note writes itself across, measured
 * as **how far its top edge has risen**, in viewports.
 *
 * `0` is the section's top touching the bottom of the window; `1` is it touching
 * the top, which on the last block is also the bottom of the page. So the pen
 * starts a third of the way into the arrival and is finished with 0.15 of a
 * screen still to go.
 *
 * > [!important] Position, not a clock — and that is what finally fixed it
 * > This block spent five passes on a timer, and every setting of it was wrong in
 * > one of two directions, because a timer and a reader are two clocks that never
 * > agree. Armed late, the note was **blank** when the reader got there. Armed
 * > early, the write **finished off screen** and the note simply existed —
 * > reported as "it appears abruptly". Split the difference and the write *began*
 * > on arrival and ran for seconds afterwards — reported as "too late". All three
 * > are one bug: the writing and the looking were not the same event.
 * >
 * > Driven off the section's own rise they cannot come apart. Scroll fast and the
 * > pen races you and is done as you land; scroll slowly and you watch every
 * > line; arrive from a deep link and the rise is already 1, so the note is
 * > written. There is no arm point to tune, no duration to outrun, and no safety
 * > net to need — the end state is a **position**, and the position is where the
 * > reader has to be.
 *
 * The upper bound is 0.85 rather than 1 for the one thing position-driving does
 * not give for free: the last screen of the page is the last screen, and a reader
 * who stops 100px short of the bottom must still be looking at a finished note.
 * 0.15 of a viewport of slack buys that.
 */
export const WRITE_WINDOW = [0.35, 0.85] as const;

/**
 * How much of the gap to the target the pen closes each frame.
 *
 * A pure function of scroll is only ever as smooth as the scroll is, and a wheel
 * is not smooth — it arrives in notches. Lenis evens out the *page*, but the
 * write is 450px of travel at 1440×900, so every notch was a visible step in the
 * ink. Lerping toward the position instead gives the pen its own momentum: it
 * trails the scroll slightly, glides through the notches, and keeps moving for a
 * beat after the wheel stops — which is what a hand does.
 *
 * 0.055 is heavy. It has to be: the whole point is that the pen does not
 * reproduce the input, and anything above about 0.12 starts to.
 *
 * The lag costs nothing at the end, because the target is a position and the
 * reader has to stop at the bottom of the page — where the target is 1 and the
 * pen has as long as it needs to reach it.
 */
export const WRITE_LERP = 0.055;

/** Below this the pen is close enough that the last hundredth is not worth a
 *  write to the DOM every frame. */
export const WRITE_EPSILON = 0.0004;


/**
 * The note swings on its pin.
 *
 * It is pinned paper, so the one thing it can honestly do is turn about the pin
 * — never slide, never scale. `origin` is where the pin's shaft enters the
 * paper, as a percentage of the element's own box: the export includes the pin
 * above the sheet, so the pivot is a tenth of the way down rather than at the
 * top edge.
 *
 * **`enter` is the fix for a note that reads as broken.** Early in the write the
 * card is a mostly blank white rectangle, which is indistinguishable from a card
 * whose content failed to load. A sheet that visibly *arrives*, swinging down
 * onto its pin as the first line starts, says "this is being written" instead.
 * Measured back when the write ran on a clock: the copy was never missing, the
 * clip ran 53% of the first line by 300ms and all three by 1.5s — what was
 * missing was any sign that something had begun.
 *
 * `hover` is the same gesture, smaller and the other way, so pointing at the
 * note nudges it the way a pinned sheet answers a touch.
 */
export const NOTE_TILT = {
  origin: "51% 10%",
  /**
   * **−3.2° → −9°, and a drop and a fade with it.**
   *
   * At 3.2° the arrival was arithmetically there and visually not: a sheet 900px
   * wide turning three degrees about a pivot near its own top edge moves its far
   * corner about 40px over 700ms, which is slower than the eye reads as
   * movement. Nine degrees is 110px of the same corner, and the pair it now
   * comes with — 6% of its own height of drop and a fade from 0 — is what turns
   * a tilt into an arrival.
   *
   * The drop is in percent of the note's own height rather than px, so it is the
   * same gesture on a 367px card at 1440 and a 240px one on a tablet.
   */
  enter: -9,
  rest: 0,
  hover: 2.6,
  /** How far it falls onto the pin, in percent of its own height. */
  drop: 6,
  /** Soft and a little slow — paper on a pin has weight and no snap. */
  config: { tension: 120, friction: 18 },
} as const;

/** Each element's slice of the 0→1 timeline. */
export const WRITE = {
  lines: [
    [0, 0.26],
    [0.22, 0.48],
    [0.44, 0.66],
  ],
  underlines: [
    [0.7, 0.86],
    [0.82, 0.98],
  ],
  aside: [0.9, 1],
} as const;

/** How far through its own window an element is, eased. */
export const writeEase = (
  progress: number,
  [start, end]: readonly [number, number],
): number => smooth((progress - start) / (end - start));

/**
 * The button's answer to a pointer: **the arrow runs, the button stays put.**
 *
 * This is the site's own gesture, taken from the hero's EXPLORE DESTINATIONS
 * link — a 12px window over a 24px track holding two arrows. At rest the track
 * sits at −50% and you see the second; on hover it springs to 0, which carries
 * that one out past the right edge while the first arrives from the left.
 * Because the departure and the arrival are two different glyphs the movement
 * only ever reads forwards; a single arrow sliding right would have to slide
 * back.
 *
 * The numbers are copied rather than imported, and only because the hero is
 * frozen: nothing is exported from `hero-overlay.tsx` to import, and adding an
 * export would mean editing a file that is signed off. If the hero is opened
 * again, this pair belongs in its geometry with block 5 importing it — the
 * arrangement block 3 and block 4 already have with block 2.
 *
 * What it replaces was block 2's card lift, which the first brief asked for:
 * right for a photograph that wants picking up, wrong for a button, and worse
 * for a text field — which has no business jumping or scaling while someone is
 * aiming a cursor at it.
 */
export const ARROW_SLIDE = {
  from: "translateX(-50%)",
  to: "translateX(0%)",
  config: { tension: 240, friction: 26 },
} as const;

/** The id the steam layer's filter is registered under. */
export const STEAM_FILTER_ID = "b5-steam-wisps";

/** Neither loop runs where a pointer cannot go, nor where motion is refused. */
export const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/** What the four plates ask the browser to fetch — all of them are full-bleed. */
export const SCENE_SIZES = "100vw";

/**
 * The note is not a plate: it is 23.75cqw of the scene, and the scene is the
 * viewport now that the cap is gone, so `100vw` would fetch four times the
 * pixels it draws. Below the desktop base it is a 342px column at most.
 */
export const NOTE_SIZES = "(max-width: 1024px) 342px, 24vw";

/**
 * Layout as class strings, so Tailwind's scanner can see them.
 *
 * ## The scene's width
 *
 * **The scene fills the width.** It was capped at 1600 — block 2's cap, for
 * block 2's reason: a composition left to fill the viewport keeps growing, and
 * a 64px heading drawn at 1.8× is not the heading that was designed.
 *
 * Both caps are gone now, and this one for a sharper reason than block 2's. That
 * block is a collage on a flat field, so a cap costs it nothing but margin. This
 * one is a **full-bleed photograph with the footer laid over it**, and a cap on
 * a full-bleed anything is a contradiction: at 2560 it drew the last block of
 * the page as a 1600px card with 480px of `--surface-gallery` down each side,
 * which is the one shape a footer must not have.
 *
 * The price is height — the scene is 1440:1077, so filling 2560 makes it 1914
 * tall against 1196 at the cap. It is the last block on the page and its bottom
 * *is* the bottom, so that height is scrolled once and then the page ends. The
 * type inside scales with it, as every `cqw` in the block does; it is one
 * composition and it stays internally the composition that was drawn.
 *
 * Block 2's *third* term — the one that caps width by the height available so
 * the scene fits one screen — is still deliberately **not** copied, and for the
 * same reason the cap is gone: it would hold the scene to 1203 wide in a 900px
 * window and open the same bands down each side.
 */
export const CLASS = {
  /**
   * The section is only a centring frame. `rgba(0,0,0,0.5)` under the whole
   * thing is Figma's own frame fill and it belongs to the scene, not here —
   * every photograph covers it, so it shows only through what they leave.
   */
  /**
   * **Exactly one screen, and nothing taller.**
   *
   * The block used to be as tall as its own frame — a full-width scene at
   * `aspect-[1440/1077]`, so 1077px at a 1440 window and 1914 at 2560 — and the
   * last block of a page standing half a screen taller than the screen is a
   * scroll nobody asked for. `h-dvh` with `overflow-hidden` settles it.
   *
   * Below the desktop base nothing changes: the block is a flow column there and
   * has to be as tall as what is in it, so the floor comes back as `min-h`.
   */
  section:
    "bg-surface-gallery relative grid h-dvh w-full place-items-center overflow-hidden max-lg:h-auto max-lg:min-h-dvh",

  /**
   * The photograph, and it **covers**.
   *
   * A fixed-ratio picture cannot both fill a window that is a different shape
   * and fit inside it, and the two halves of this block want opposite answers.
   * A photograph is cropped without complaint — that is what every full-bleed
   * image on the page already does. A composition is not: crop it and the
   * heading or the footer panel goes off the screen.
   *
   * So the picture is the larger of the two terms — `max(100%, one screen tall)`
   * — centred and clipped by the section, and the composition below is the
   * smaller. At 1440×900 the picture is 1440×1077 with 88px off the top and
   * bottom; at 2560×1440, 2560×1914 with 237 off each.
   *
   * It keeps the frame's aspect ratio and its own `container-type`, so all four
   * plates keep the `cqw` offsets they were measured at and the composite is the
   * one the file draws — only its edges are cut.
   *
   * `bg-scrim-page` — Figma's own frame fill — belongs here rather than on the
   * composition: every photograph covers it, so it shows only through what they
   * leave, and what they leave is this box.
   *
   * Below the desktop base it simply covers the section: the composition is a
   * flow column there, not a fixed-ratio box, so there is no ratio to cover
   * *against* and nothing to crop. `inset-0` rather than the desktop's centred
   * `max()` box — measured, leaving it `relative` made it a second grid item
   * with no content height, and the whole photograph vanished behind a flat
   * black column.
   */
  picture:
    "bg-scrim-page absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[max(100%,calc(100dvh*1440/1077))] aspect-[1440/1077] [container-type:size] max-lg:inset-0 max-lg:left-0 max-lg:top-0 max-lg:h-full max-lg:w-full max-lg:translate-x-0 max-lg:translate-y-0 max-lg:aspect-auto max-lg:[container-type:normal]",

  /**
   * The composition, and it **fits**.
   *
   * `min(100%, one screen tall)` against the picture's `max(…)`: the same two
   * terms, the other way round. The heading, the note, the button and the footer
   * panel are all placed in `cqw` of this box, so keeping its 1440:1077 ratio is
   * what keeps every one of them where the file puts it — the box simply comes
   * down to whatever size fits the screen.
   *
   * What it costs on a window wider than 1.337:1 is that the footer panel is
   * inset further from the screen's edges than 24px would be at 1440. That inset
   * is the file's own — the panel is drawn at `left 1.6667cqw` — and it is the
   * price of the block being exactly one screen. What it does **not** cost is
   * bands of flat colour down the sides: the picture behind it is full-bleed.
   *
   * Below the desktop base the scene stops being a scene, exactly as blocks 2
   * and 3 do: at 768 a 1:1 composition would set the 64px heading at 34 and the
   * 14px footer links at 7.5, which is not a footer any more. It becomes an
   * ordinary centred column — heading, note, button, footer — and the four
   * plates go on covering it from behind.
   *
   * `px-page` is the site's one horizontal inset, and it is also Figma's: the
   * footer panel is drawn 24 in from the frame edge, so a padded column puts it
   * exactly where the file does without a second number.
   *
   * **A tablet gets the whole screen.** `min-h-dvh`, not `h-dvh`: at 768 × 1024
   * the column measures 846 and the floor stretches it to exactly 1024, which is
   * what "100% of the height" asks for; at 1024 × 768 — an iPad turned on its
   * side — the same column cannot fit 768 without shrinking the note past
   * reading, so the block runs 870 and the page scrolls the last 102. A ceiling
   * would have had to take that out of the note. `justify-center` is what puts
   * the spare height into the composition rather than under the footer.
   */
  scene:
    "relative z-[1] w-[min(100%,calc(100dvh*1440/1077))] aspect-[1440/1077] [container-type:size] max-lg:aspect-auto max-lg:w-full max-lg:[container-type:normal] max-lg:flex max-lg:flex-col max-lg:items-center max-lg:gap-[46px] max-lg:px-page max-lg:pt-[46px] max-lg:pb-page max-md:gap-[34px] max-md:pt-[24px] md:max-lg:min-h-dvh md:max-lg:justify-center",

  /**
   * The photograph the whole scene stands on: the full frame, edge to edge, and
   * the only plate here that is **opaque**.
   *
   * Everything above it is a cut-out — the mountains, the steam and the ridge
   * all ship an alpha channel — so without a base there is nothing behind their
   * transparent sky but the scene's own near-black, and the composition reads as
   * a torn-out shape floating on a dark field. That is the seam.
   *
   * It is also what makes the steam's `screen` behave: screen against near-black
   * lifts to a flat grey slab, which is exactly what the top of the block turned
   * into before this plate existed. Against a real sky it does what it was drawn
   * to do.
   *
   * **Static, and that is deliberate.** It is exactly frame-sized with no
   * overhang, so any lean at all would walk its own edge into view — and a base
   * plate that can uncover the frame is not a base plate. The depth comes from
   * the three layers above it moving *over* it.
   */
  backdrop: "absolute inset-0",

  /**
   * The mountains: x −101, y −22, 1642 × 1099.
   *
   * The overhang is the point — 101px past the left edge and 1642 against the
   * frame's 1440 — so the layer can lean either way without uncovering the
   * frame. `object-cover` on a box that is already the drawing's aspect ratio
   * is a no-op that survives a source of any size.
   */
  far: "absolute left-[-7.0139cqw] top-[-1.5278cqw] h-[76.3194cqw] w-[114.0278cqw] will-change-transform max-lg:inset-0 max-lg:h-full max-lg:w-full",

  /**
   * The steam plate: x 0, y 0, 1440 × 964, `mix-blend-mode: screen`.
   *
   * Screen is what the plate was drawn for — its black falls away to nothing on
   * its own, so there is no alpha channel to ship and no matte to cut. The mode
   * sits on the positioned layer so its backdrop is the mountains beneath it
   * inside the scene, which is its own stacking context.
   */
  steam:
    "absolute left-0 top-0 h-[66.9444cqw] w-full mix-blend-screen will-change-transform max-lg:h-[55%]",

  /** The alpha curve, applied to the plate itself — see `STEAM_ALPHA_GAMMA`. */
  steamWisps: "[filter:url(#b5-steam-wisps)]",

  /** The ridge in front: x 0, y 113, 1440 × 964, alpha-cut. */
  /**
   * The ridge hugs the foot of the frame on desktop — 113 down of 1077, so its
   * 964 ends exactly on the bottom edge. Below the base it keeps that job by
   * anchoring to the bottom outright, since the column's height is no longer a
   * fixed 1077 to measure down from.
   *
   * **64% of the column, and that number is the button's.** On desktop the
   * button lands at 603 of 1077 — right on the ridge line, which is what a cream
   * hairline needs to be seen at all. The taller narrow column pushed it back up
   * onto the fog, where the same border measured 3.61 against its background and
   * read, correctly, as missing. Over the ridge it measures 16.59. 64% puts the
   * silhouette above the button at every size in the range, so the control has
   * something to sit on rather than dissolving into the sky.
   */
  foreground:
    "absolute left-0 top-[7.8472cqw] h-[66.9444cqw] w-full will-change-transform max-lg:top-auto max-lg:bottom-0 max-lg:h-[64%]",

  /** rgba(0,0,0,0.15) over all three, under everything that is read. */
  wash: "bg-scrim-cta pointer-events-none absolute inset-0",

  /**
   * "Plan a Journey" — 64/51.2, centred on 720, top 100, and **black**.
   *
   * The one place on the page where the display type is not cream: it is read
   * against a bright sky rather than against a dark photograph, and the brand
   * cream would disappear into it.
   */
  title:
    "text-foreground-ink font-display text-trim absolute left-[38.9583cqw] top-[6.9444cqw] w-[22.0833cqw] text-center text-[4.4444cqw] leading-[3.5556cqw] max-lg:static max-lg:w-full max-lg:text-[48px] max-lg:leading-[38.4px] max-md:text-[36px] max-md:leading-[28.8px]",

  /**
   * The pinned note: 549 / 196, 342 × 367 — and **a container of its own**.
   *
   * Everything written on it is placed in `cqw` of *the note's* 342 rather than
   * of the scene's 1440, which is what lets the whole object scale as one thing.
   * On desktop that changes nothing — 23.75cqw of 1440 is 342, so the inner
   * numbers land exactly where they landed before — and below the desktop base
   * it is the difference between re-deriving five coordinates per breakpoint and
   * choosing one width.
   *
   * The same trick block 2 uses for its fan, and for the same reason.
   *
   * Below the desktop base it is `relative`, not `static`: it joins the flow
   * either way, but everything written on it is absolutely positioned, and an
   * absolute child resolves against the nearest *positioned* ancestor. Left
   * static, the paper and all four pieces of writing escaped to the scene and
   * laid themselves out across the whole block.
   *
   * Which then costs a second line: `left` and `top` stop being coordinates on a
   * relative box and become *offsets from where it already is*. The desktop
   * 38.125cqw — with no container left to resolve against, so a fallback to the
   * viewport — pushed the note 149px off its own column. Both are reset to
   * `auto`.
   *
   * On a tablet it is also **the one part of the column that gives**. The scene
   * is at least a screen tall there, and the button and the footer panel are
   * `shrink-0` — they are a hit target and a block of 13px type, and neither has
   * anything to spare. So the note takes the difference: `flex-1` between a 240
   * floor and Figma's own 367, width from the aspect ratio rather than stated.
   * At 768 × 1024 it sits at the full 342 × 367; at 1024 × 768 it comes down to
   * 224 × 240, which still sets the handwriting at 15.7px.
   *
   * The 40 it rides up on is a **transform, not a margin**, and the button
   * carries the same one. A margin would have gone into the column's own height:
   * where the block is exactly a screen it would push the footer down, and at
   * 1024 × 768, where there is no spare height at all, it would simply have made
   * the block 40 taller and moved nothing. A translate lifts the pair off the
   * fog and leaves every other measurement where it was.
   *
   * A phone gets 34 of the same lift, and there it *is* a margin — the column
   * has no spare height to protect, so the pull shortens the block instead of
   * opening a hole under the button. 10 of it comes off the scene's top inset
   * (34 → 24) and 24 off the gap under the heading, which drops to the 10 the
   * link lists are set on.
   *
   * The heading itself does not move, and that is the whole reason the lift is
   * split this way: it is 36px display type, and lifting it with the note —
   * tried first — stood it 10 from the seam with the block above. Its 24 of
   * clearance is the last air left over the note; anything further has to come
   * out of that.
   */
  note: "absolute left-[38.125cqw] top-[13.6111cqw] h-[25.4861cqw] w-[23.75cqw] [container-type:size] max-lg:relative max-lg:left-auto max-lg:top-auto max-lg:h-auto max-lg:w-[min(342px,100%)] max-lg:aspect-[342/367] md:max-lg:w-auto md:max-lg:min-h-[240px] md:max-lg:max-h-[367px] md:max-lg:flex-1 md:max-lg:-translate-y-[40px] max-md:-mt-[24px]",

  /** The photograph of the note itself, filling its box. */
  notePaper: "absolute inset-0",

  /** Caveat Bold 24/28.8, black, uppercase, centred — 35 / 171 of the note, 273 wide. */
  notePromise:
    "text-foreground-ink font-hand text-trim absolute left-[10.2339cqw] top-[50cqw] w-[79.8246cqw] text-center text-[7.0175cqw] leading-[8.4211cqw] font-bold uppercase",

  /** One written line. `block` so the clip has a box to work on. */
  noteLine: "block",

  /**
   * Vector 27 — 612.973 / 386.344, 213.318 × 4.374.
   *
   * The box is the **path's** box, and the file is bigger than it: 216 × 7,
   * because a stroke has width and round caps, and half of it hangs outside the
   * geometry on every side. So the drawing is inset *negatively* by the file's
   * own overflow — top 27.17%, bottom 27.03%, left 0.47%, right 0.41% — which is
   * what puts the ink on the line Figma drew rather than squashing a 7px file
   * into a 4.4px box.
   */
  underlineOne:
    "pointer-events-none absolute left-[18.7054cqw] top-[55.6562cqw] h-[1.279cqw] w-[62.3737cqw]",
  underlineOneInk:
    "absolute inset-[-27.17%_-0.41%_-27.03%_-0.47%] block max-w-none",

  /** Vector 28 — 584.795 / 414.451, 129.205 × 1.684; the same bleed, its own numbers. */
  underlineTwo:
    "pointer-events-none absolute left-[10.4664cqw] top-[63.8744cqw] h-[0.4925cqw] w-[37.7793cqw]",
  underlineTwoInk:
    "absolute inset-[-66.42%_-0.77%_-72.19%_-0.77%] block max-w-none",

  /** Caveat 18/18 at 40% black, centred: 662 / 532, width 117. */
  noteAside:
    "text-foreground-ink-muted font-hand text-trim absolute left-[33.0409cqw] top-[98.2456cqw] w-[34.2105cqw] text-center text-[5.2632cqw] leading-[5.2632cqw]",

  /**
   * "Start planning": 636 / 603, 168 × 38, a cream hairline pill.
   *
   * The box is stated rather than hugged. Figma's 168 is what its auto-layout
   * measured from *its* rasteriser — 16 + 12 + 8 + 114 + 16 — and a browser
   * setting the same 14px face will land a pixel or two off that. Pinning the
   * box keeps the button where the file draws it and lets the content centre
   * inside it.
   *
   * Below the desktop base it joins the column, and it has to stay **positioned**
   * to do it. The four scene layers are `absolute`, and a positioned box paints
   * above a static one whatever the source order says — as `max-lg:static` the
   * button went *under* the fog and only the arrow, which the browser composites
   * on its own, came through. That is what read as "the button is missing"; the
   * scrim that seemed to fix it was really just a plate painted on top of the
   * fog. `relative` with no offsets puts it back over the scene and leaves the
   * column geometry untouched. The note carries the same `max-lg:relative` for
   * the same reason.
   *
   * On a phone it also carries the 46 that opens the gap to the footer to 80.
   * The column's own gap is 34 and every other pair in the block keeps it; this
   * one is the seam between the invitation and the site's small print, and it is
   * the only place asked to read as a break rather than a rhythm. 34 + 46 is two
   * rungs of the hero ladder rather than a number of its own, and 100 — tried
   * first — was a gap wide enough to read as the block having ended.
   */
  action:
    "absolute left-[44.1667cqw] top-[41.875cqw] block h-[2.6389cqw] w-[11.6667cqw] max-lg:relative max-lg:left-auto max-lg:top-auto max-lg:h-[38px] max-lg:w-[168px] md:max-lg:shrink-0 md:max-lg:-translate-y-[40px] max-md:mb-[46px]",

  /**
   * The pill itself, on the element the hover spring moves — the border has to
   * travel with the label, so it lives here and not on the anchor above, which
   * only holds the box in place. It does not move on hover: on this site a
   * button answers with its arrow. See `ARROW_SLIDE`.
   *
   * It is the file's own pill at every width — a 1px cream hairline, no fill,
   * 100px of radius below the desktop base — and it carries **no ground of its
   * own**. A scrim behind it does lift the cream off the fog, measured 2.4 to
   * 6.7, but it reads as a plate the design does not draw.
   *
   * Worth knowing where that leaves it: on desktop the button lands at 603 of
   * 1077, where the photograph has already turned, and the hairline reads
   * against it. The narrow column puts it at 47% of the scene, in the middle of
   * the fog — measured at RGB 157.5, 155.6, 144.7, cream on that is 2.41. The
   * shape is legible and the label is thin. Signed off as drawn.
   */
  actionPill:
    "border-foreground-accent flex h-full w-full items-center justify-center gap-[0.5556cqw] rounded-[6.9444cqw] border max-lg:gap-[8px] max-lg:rounded-[100px]",

  /**
   * The 12px window the arrow track runs behind. `overflow-hidden` is the whole
   * trick: the track is twice as wide and carries two arrows, so one leaves as
   * the other arrives.
   */
  arrowWindow: "block size-[0.8333cqw] shrink-0 overflow-hidden max-lg:size-[12px]",

  /** The track itself: 24 wide, two 12px arrows side by side. */
  arrowTrack: "flex w-[1.6667cqw] items-center max-lg:w-[24px]",

  /**
   * One arrow on the track, and its size has to be **stated**.
   *
   * `size-full` is wrong here and quietly so: inside a 24px track it resolves to
   * 24 × 24 for each glyph, so the pair overflows to 48 and the 12px window
   * shows the top-left corner of an arrow drawn at double size — a diagonal
   * sliver. Half the track, explicitly, is the only size that lines the glyphs
   * up with the window they run behind.
   */
  arrowMark: "block size-[0.8333cqw] shrink-0 max-lg:size-[12px]",

  /**
   * The arrow, 12 × 12. Used here and by the e-mail field.
   *
   * **Not rotated**, although Figma's generated markup wraps it in a
   * `rotate-90`. That rotation is already in the exported file: `Icon1.svg`
   * draws the turn-and-go glyph in its final orientation, so re-applying the
   * transform turns it a second time and the arrow ends up pointing down.
   * Checked against Figma's own render of both the button and the e-mail row —
   * the mark reads the same way in each.
   */
  actionArrow: "relative block size-[0.8333cqw]",

  /** Inter Tight Medium 14/11.2 uppercase, cream at every width. */
  actionLabel:
    "text-foreground-accent font-ui text-trim text-[0.9722cqw] leading-[0.7778cqw] uppercase max-lg:text-[14px] max-lg:leading-[11.2px]",
} as const;

/**
 * The footer, as its own class table.
 *
 * Its offsets are **relative to the panel** — the panel is `position: relative`
 * but not a query container, so `cqw` still resolves against the scene and 24px
 * is 1.6667cqw wherever it is measured from.
 */
export const FOOTER = {
  /**
   * The glass panel: 24 / 791, 1392 × 262, `rgba(12,12,12,0.1)` over a 5px
   * blur. It is the only backdrop-filter on the page, and it is what lets the
   * photograph carry on behind the small type instead of stopping at it.
   */
  /**
   * Below the desktop base the panel stops being a fixed 1392 × 262 pinned into
   * the frame and becomes the last block of the column: full width, its own
   * height, its six parts stacked in the order they already sit in the markup —
   * wordmark, links, newsletter, social, rule, copyright.
   *
   * A **phone** stacks it: one column, 34 apart on the hero's ladder.
   *
   * A **tablet**:
   *
   *   brand
   *   links links links
   *   newsletter
   *   rule
   *   legal    social
   *
   * The links and the newsletter were tried side by side and the width would not
   * carry it. 768 leaves 640 inside the padding; three columns are 308 of that
   * before a single gap, and the sentence needs 270 to stay in two lines — which
   * left 24 between the columns and 32 between the two groups, and read as one
   * slab rather than four things. Two columns of content is a desktop shape; a
   * tablet takes one, and spends the width on the row that can use it.
   *
   * So the social marks come up to face the brand, which is what keeps the top
   * row from being half empty, and everything below runs full width with room.
   * Rows are placed explicitly rather than left to flow, because the markup
   * order — brand, links, newsletter, social, rule, legal — is the *reading*
   * order and should not be bent to suit a layout.
   *
   * Padding is 46 here against Figma's 24: the panel is 732 wide on a tablet
   * against 1392 on a desktop, so the same 24 that framed the one crowds the
   * other.
   *
   * The inner padding stays Figma's own 24 at every size: it is the panel's
   * padding rather than the page's inset, and the two answer to different things.
   */
  /**
   * **The panel is a child of the section, and its own container.**
   *
   * The composition is sized to fit the screen's height, which on a window wider
   * than 1.337:1 makes it narrower than the window — and a footer that stops
   * short of both edges is the one thing this panel must not do. Out here it
   * spans the section at the site's own `page` inset, which stays 24px at every
   * width rather than growing with the screen the way a `cqw` inset would.
   *
   * `container-type: inline-size` re-bases everything inside it: every `cqw` in
   * the rows below is now a share of the **panel** rather than of the 1440
   * frame, so each one is its old value × 1440/1392 — the panel being 1392 of
   * that frame. At 1440 the two are the same picture to the pixel; wider, the
   * panel and its contents grow together.
   *
   * > [!warning] Scale the children, do not re-origin them
   * > A child's `left` was already relative to the panel, because the panel has
   * > always been its offset parent — the wordmark's `1.6667cqw` was the panel's
   * > own 24px of inner padding, not a coordinate on the frame. Subtracting the
   * > panel's offset as well put the wordmark, the rule and the legal line hard
   * > against the panel's left edge. The conversion is a **multiplication and
   * > nothing else**.
   *
   * > [!warning] The panel's own height cannot be `cqw`
   * > An element is **not its own container**: a container query unit inside one
   * > resolves against the nearest *ancestor* container, and out here the panel
   * > has none. `h-[18.8218cqw]` therefore fell back to the viewport and drew
   * > 271px against the 259 it asked for. `aspect-ratio` says the same thing in
   * > terms of the panel's own width, which is what was meant.
   */
  panel:
    "bg-surface-glass absolute inset-x-page bottom-page z-[2] aspect-[1392/262] [container-type:inline-size] backdrop-blur-[5px] max-lg:static max-lg:aspect-auto max-lg:[container-type:normal] max-lg:h-auto max-lg:w-full max-lg:p-[24px] md:max-lg:shrink-0 max-md:flex max-md:flex-col max-md:gap-[34px] md:max-lg:grid md:max-lg:grid-cols-4 md:max-lg:gap-x-[24px] md:max-lg:gap-y-[46px] md:max-lg:p-[46px]",

  /** Instrument Serif 24/21.6, cream: 24 / 24. */
  wordmark:
    "text-foreground-accent font-display text-trim absolute left-[1.7241cqw] top-[1.7241cqw] text-[1.7241cqw] leading-[1.5517cqw] max-lg:static max-lg:text-[24px] max-lg:leading-[21.6px] md:max-lg:row-start-1 md:max-lg:col-span-4",

  /** The three link columns: 353 / 24, 64 apart. */
  /**
   * Three columns across on a tablet, under the wordmark and sharing the left
   * zone with it. At 13px the row measures about 365 including two 46s, and the
   * left zone is 400 at 768 — the narrowest the band gets. A phone has 294 to
   * give and the same row wants more, so it folds to two columns there.
   */
  columns:
    "absolute left-[25.3592cqw] top-[1.7241cqw] flex gap-[4.5977cqw] items-start max-lg:static md:max-lg:row-start-2 md:max-lg:col-span-3 md:max-lg:grid md:max-lg:grid-cols-3 md:max-lg:gap-[24px] max-md:grid max-md:w-full max-md:grid-cols-2 max-md:gap-x-[24px] max-md:gap-y-[34px]",

  /**
   * One column: heading, 20, then the list 10 apart.
   *
   * 24 on a tablet. Figma's 20 is a desktop measure taken under a 16px heading;
   * the same 20 under a 14px one at this width read as too tight against the
   * 10 inside the list, and 34 — tried first — read as a hole. 24 is the step
   * between them on the hero ladder.
   */
  column:
    "flex flex-col gap-[1.4368cqw] items-start max-lg:gap-[20px] md:max-lg:gap-[24px]",

  /**
   * Figma's own measured widths — 110 / 103 / 95 — in the order the columns
   * are read. They are geometry, not content, so they live here rather than
   * beside the links; and they are stated rather than hugged because a
   * browser setting the same 14px face will not measure a word to the pixel
   * the file did, and the 64 between the columns has to stay 64.
   */
  columnWidths: ["7.9023cqw", "7.3995cqw", "6.8247cqw"],

  /**
   * The width is carried by a custom property rather than written straight into
   * the inline style, so a media query can drop it. `cqw` with no container to
   * resolve against falls back to the viewport, which would have made each
   * column a stray 7% of the screen below the desktop base.
   */
  columnBox: "w-[var(--b5-col)] max-lg:w-auto",

  /** Inter Tight Medium 16/16, cream. 14 below the desktop base, at both widths. */
  columnTitle:
    "text-foreground-accent font-ui text-trim text-[1.1494cqw] leading-[1.1494cqw] max-lg:text-[14px] max-lg:leading-[14px]",

  /** The list itself. */
  columnList: "flex flex-col gap-[0.7184cqw] items-start max-lg:gap-[10px]",

  /**
   * Inter Tight Medium 14/14 uppercase at 40% cream, lifting to full on hover.
   *
   * `--duration-fast` because it is a pointer answering, not a composition
   * moving; and `(hover: none)` swaps the trigger to `:active`, since a finger
   * has no hover to give.
   */
  columnLink:
    "text-foreground-accent-muted font-ui text-trim block text-[1.0057cqw] leading-[1.0057cqw] uppercase max-lg:text-[14px] max-lg:leading-[14px] md:max-lg:text-[13px] md:max-lg:leading-[13px] transition-opacity duration-[var(--duration-fast)] ease-entrance hover:text-foreground-accent [@media(hover:none)]:active:text-foreground-accent motion-reduce:transition-none",

  /** The newsletter block: 1059 / 24, width 309, 48 between its two parts. */
  /**
   * The newsletter block. **On a tablet it is the fourth link column**, not a
   * band of its own and not a zone beside the others: same track width, same
   * row, its copy playing the part the three headings play.
   *
   * It is a two-row grid, and the two rows answer to different edges. The copy
   * hangs from the top with the other three headings; the field is `self-end`
   * and hangs from the **bottom**, which is the line the lists finish on —
   * 9010.03 at 768, 7141.22 at 1024, the same to the hundredth as INDONESIA,
   * SLOW TRAVEL and CONTACT. The column stretches to the row rather than sitting
   * `self-start` inside it, which is what gives the field a bottom to find.
   *
   * The floor on row one is `minmax(21.19px, auto)`: 10.19 is what a 14/14
   * heading occupies once `text-trim` has taken the half-leading off it, and
   * 21.19 + the 13 row gap is the 34.19 that would put the field on the ICELAND
   * line if the sentence ever ran short enough to leave it there. It does not —
   * three lines at 13/15.6 measure 40.64 — so the bottom edge is what decides,
   * and the gap that falls out of it is 33.36.
   */
  aside:
    "absolute left-[76.0776cqw] top-[1.7241cqw] flex w-[22.2086cqw] flex-col gap-[3.4483cqw] max-lg:static max-lg:w-full max-lg:gap-[24px] md:max-lg:grid md:max-lg:grid-cols-[minmax(0,1fr)] md:max-lg:grid-rows-[minmax(21.19px,auto)_auto] md:max-lg:row-start-2 md:max-lg:col-start-4 md:max-lg:gap-y-[13px]",

  /**
   * Inter Tight Medium 16/19.2 uppercase, cream. 14/16.8 below the desktop base,
   * **13/15.6 on a tablet**, where it is the fourth column's heading.
   *
   * The step down is measured, not taste. The sentence is 417px set at 14, and
   * the quarter-width track at 768 is 142 — three lines' worth of room, but its
   * word boundaries fall so that it takes four, 60.58 tall. At 13 it breaks into
   * three and measures 40.64, the same at both tablet widths, which is what lets
   * the field below it land on a list line. Its colour and its top line are the
   * other three headings' exactly.
   *
   * `self-start` because row one is as tall as the tallest of the four headings;
   * left to stretch it would centre its lines in that height and stop sitting
   * level with the others.
   */
  asideCopy:
    "text-foreground-accent font-ui text-trim text-[1.1494cqw] leading-[1.3793cqw] uppercase max-lg:text-[14px] max-lg:leading-[16.8px] md:max-lg:text-[13px] md:max-lg:leading-[15.6px] md:max-lg:self-start",

  /**
   * The e-mail row: a cream hairline under it, the whole row at 40%, 10px of
   * air above the rule. Figma puts the opacity on the row rather than on the
   * border, so the placeholder and the arrow ride it too.
   */
  emailRow:
    "group border-foreground-accent flex w-full items-center justify-between border-b pb-[0.7184cqw] max-lg:pb-[10px] md:max-lg:self-end opacity-40 transition-opacity duration-[var(--duration-fast)] ease-entrance hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:active:opacity-100 motion-reduce:transition-none",

  /** Inter Tight Medium 14/11.2 uppercase, cream. */
  emailInput:
    "text-foreground-accent font-ui text-trim min-w-0 flex-1 bg-transparent text-[1.0057cqw] leading-[0.8046cqw] uppercase outline-none placeholder:text-foreground-accent max-lg:text-[14px] max-lg:leading-[11.2px]",

  /** The submit control: the same 12px window and running arrow the button has. */
  emailArrow: "block size-[0.8621cqw] shrink-0 overflow-hidden max-lg:size-[12px]",

  /** Three 24 × 24 marks, 12 apart: 1059 / 214. */
  social:
    "absolute left-[76.0776cqw] top-[15.3736cqw] flex items-center gap-[0.8621cqw] max-lg:static max-lg:gap-[12px] md:max-lg:row-start-4 md:max-lg:col-start-4 md:max-lg:justify-self-end md:max-lg:self-center md:max-lg:mt-[-24px]",
  /** Three 24 × 24 marks at full strength — they are the brand, not supporting copy. */
  socialIcon: "relative block size-[1.7241cqw] max-lg:size-[24px]",

  /**
   * The rule at 190, 1344 wide.
   *
   * Figma ships it as a one-pixel vector whose stroke colour the export does
   * not carry. Cream at 40% is what every other hairline and muted mark in this
   * panel is drawn in, so that is what it takes — see the note in plan.md.
   *
   * Below the desktop base it is row three of the grid, and it has to hang from
   * the top of that row. A grid item stretches by default, and a stretched box
   * answers a negative bottom margin by growing to match — measured, `mb-[-12px]`
   * left the gap under the rule exactly where it was. `self-start` keeps it the
   * one-pixel line it is drawn as; the legal row pulls itself up instead. See
   * `copyright`.
   *
   * The −12 on top is the same arithmetic pointing the other way: 46 over the
   * rule reads as a hole under a list whose last line already carries its own
   * descender space, and 34 is the step below on the hero ladder.
   */
  divider:
    "border-foreground-accent-muted absolute left-[1.7241cqw] top-[13.6494cqw] w-[96.5517cqw] border-t max-lg:static max-lg:w-full md:max-lg:row-start-3 md:max-lg:col-span-4 md:max-lg:mt-[-12px] md:max-lg:self-start",

  /**
   * Inter Tight Medium 14/14, cream: 24 / 228. A step down to 13 on a tablet.
   *
   * It and the social marks share row four and both pull up by 12. The panel's
   * row gap is 46 — right over the rule, too much under it — and 34 is the step
   * below on the hero ladder. The pull lives on the two items rather than on the
   * rule because the rule is a grid item too, and a stretched one grows to
   * swallow a negative margin instead of moving.
   */
  copyright:
    "text-foreground-accent font-ui text-trim absolute left-[1.7241cqw] top-[16.3793cqw] text-[1.0057cqw] leading-[1.0057cqw] max-lg:static max-lg:text-[14px] max-lg:leading-[14px] md:max-lg:row-start-4 md:max-lg:col-start-1 md:max-lg:col-span-2 md:max-lg:self-center md:max-lg:mt-[-24px] md:max-lg:text-[13px] md:max-lg:leading-[13px]",
} as const;
