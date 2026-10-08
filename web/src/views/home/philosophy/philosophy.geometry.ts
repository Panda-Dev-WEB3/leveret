/**
 * Every measurement block 3 takes from Figma, in one place.
 *
 * Source: Get Layers, file WINXFW2nTM7zYwd5dGgm1T
 *   1653:964  — state A, scroll progress 0
 *   1653:1003 — state B, scroll progress 1
 * Both frames are 1440×800 and are the same block, not two blocks.
 *
 * Like block 2 this is a **container-query scene**: the stage declares
 * `container-type: size` at 1440×800 and every child is placed in `cqw`, so the
 * composition is 1:1 with the file at any width. Type sizes are `cqw` too —
 * there are deliberately no rem tokens for them, for the reason globals.css
 * gives: a token beside these numbers would be a second, contradicting source.
 *
 * 📖 Docs: obsidian/frontend/philosophy.md
 */

/** Figma frame width (px) every offset below is measured against. */
export const FRAME_WIDTH = 1440;
/** Figma frame height (px). */
export const FRAME_HEIGHT = 800;

/*
 * Every `cqw` below is its Figma pixel ÷ 1440 × 100 — 446 reads back as
 * 30.9722, 251 as 17.4306. No helper: the values are literals in the class
 * strings, because Tailwind's scanner has to see them whole.
 */

/**
 * The pan itself, as a percentage of the backdrop's own height.
 *
 * −50% is not a taste value: the box is 1600 tall over an 800 window, so half
 * of it is exactly the travel available. State A is therefore the untranslated
 * top of the photograph and state B its bottom.
 *
 * Verified against the file rather than eyeballed — the horizon is the sharpest
 * luminance drop in the image, and a column-averaged scan puts it at y=584 of
 * the 1600px drawing and at y=584 of frame 1653:964. The two agree exactly, so
 * state A is the photograph at offset 0.
 */
export const BACKDROP_PAN = { from: "0%", to: "-50%" } as const;

/**
 * Progress at which the opening finishes and the content starts.
 *
 * **0.55 → 0.30.** It was half the timeline because the heading spent that half
 * travelling and the words spent it writing; both of those now happen during the
 * lead-in, *behind block 2*, and the heading is already in place on the frame
 * the cards clear the screen. What was left on this side of the handover was the
 * backdrop pan alone — and a reader watching 82vh of pinned scrolling for a
 * photograph to slide is watching an empty block.
 *
 * At 0.30 the content starts as soon as the block is its own, and the whole
 * sequence — pan, collage, two asides, sign-off — lands at **0.73** rather than
 * 0.98, which is what let the track come down with it. See `CLASS.section`.
 */
export const HANDOVER = 0.14;

/**
 * The heading writes itself in, one word at a time, across the same opening
 * the heading travels through.
 *
 * The block already had a stagger — `REVEAL_ORDER` walks the collage, the two
 * asides and the sign-off across the *back* half — and this is its counterpart
 * for the front half. Nothing else needed changing: both are the same
 * smoothstep sampled at different offsets of the one 0 → 1 the section runs on.
 *
 * Six words in three lines, so the last one starts at 5 × `WORD_STAGGER` and
 * finishes at 0.15 + 0.14 = **0.29**, just inside `HANDOVER`. The line is done
 * writing exactly as the opening finishes, and the rest of the timeline is clear
 * for the content — the two staggers never overlap.
 *
 * Both numbers came down with `HANDOVER` (0.07/0.18 → 0.03/0.14) to keep that
 * relationship, which is the only thing about them that was ever load-bearing.
 * On the desktop base the words run on the **lead-in** rather than this
 * timeline — the heading has to emerge from under block 2 already written — so
 * there they simply finish sooner inside a window that is scrolled past anyway.
 */
export const WORD_STAGGER = 0.03;
/** Length of a single word's fade. */
export const WORD_DURATION = 0.14;

/**
 * How far a word rises into place, in `em` of the display size it is set in.
 *
 * `em`, not `cqw` or px, and that is the whole reason it needs no breakpoint of
 * its own: the heading is 4.4444cqw on desktop, 48px on a tablet and 36px on a
 * phone, and 0.28em is the same fraction of the letter at all three. The block's
 * other travels use `--b3-travel` because they move boxes across a composition;
 * this one moves type against its own line, so it is measured in type.
 *
 * Small on purpose. The heading as a whole is already travelling 17.4306cqw
 * over this same window, and a word that also lifted a long way would read as
 * two separate movements fighting rather than one arrival.
 */
export const WORD_TRAVEL_EM = 0.28;

/**
 * Both travels are carried by a custom property rather than written straight
 * into the spring's string, so one code path can express two units.
 *
 * On desktop they are `cqw` — the scene is a size container and everything
 * else is `cqw`, so the travel scales with the composition. Below the desktop
 * base the scene drops `container-type` and `cqw` has nothing to resolve
 * against, so the same property switches to px. The spring only ever writes
 * `calc(var(--b3-travel) * k)`, which is valid either way.
 *
 * The heading's desktop travel is Figma's own: top 351 in state A against top
 * 100 in state B, so the element is pinned at 100 and pushed down by 251
 * (17.4306cqw). In the flow column there is no such pair to honour, and 46 —
 * the hero's ladder — is the distance that reads as movement without shoving
 * the heading into the collage.
 */
/**
 * How far the collage turns across the block, in degrees, end to end.
 *
 * It rides the **raw** progress — the block's whole track, lead-in included —
 * rather than the staged timeline, because the brief is the whole block's
 * scroll and not the part of it this collage happens to own. Linear, for the
 * same reason the backdrop pan is: a turn that eases is a turn that has a
 * beginning and an end, and this one is meant to read as the pile settling under
 * its own weight for as long as you are here.
 *
 * ±7 sounds larger than it is. The lead-in is spent behind block 2, so the
 * visible sweep is roughly −0.5° to +7° — enough that a reader who scrolls back
 * can see it moved, and small enough that no single frame looks crooked. The
 * pile is already drawn at an angle; this leans on that rather than fighting it.
 */
export const COLLAGE_TURN = 7;

export const REVEAL_TRAVEL_VAR =
  "[--b3-travel:1.3889cqw] max-lg:[--b3-travel:20px]";

/**
 * The reveal is staggered after the handover. Each group gets `REVEAL_DURATION`
 * of progress from its own offset, so the last one lands at
 * 0.30 + 3×0.05 + 0.28 = **0.73** — and the 0.27 left over is the tail the
 * shortened track cuts, not dead time added to it.
 */
export const REVEAL_ORDER = [
  "collage",
  "asideLeft",
  "asideRight",
  "signOff",
] as const;

export type RevealGroup = (typeof REVEAL_ORDER)[number];

/**
 * How long a revealed group takes to arrive, in ms.
 *
 * A duration, because the whole group is **cued** by the scroll rather than
 * scrubbed by it — see the note in `philosophy.tsx`. 900ms is the page's own
 * reveal length (`REVEAL.duration` in `reveal-text.tsx`), so the collage and the
 * sign-off arrive at the same pace as the words inside the paragraphs between
 * them.
 */
export const REVEAL_MS = 900;

/** Progress offset between consecutive groups. */
export const REVEAL_STAGGER = 0.05;
/** Length of a single group's fade. */
export const REVEAL_DURATION = 0.28;

/** Start progress for a group, derived from its place in `REVEAL_ORDER`. */
export const revealStart = (group: RevealGroup): number =>
  HANDOVER + REVEAL_ORDER.indexOf(group) * REVEAL_STAGGER;

/**
 * Smoothstep. The brief asks for movement with no hard edges at either end, and
 * this is the cheapest curve with zero first derivative at 0 and 1 — the
 * heading eases out of state A and settles into state B rather than arriving at
 * speed and stopping.
 */
export const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** 0→1 reveal factor for a group at a given timeline progress, eased. */
export const groupEase = (progress: number, group: RevealGroup): number =>
  smooth((progress - revealStart(group)) / REVEAL_DURATION);

/** 0→1 reveal factor for the nth word of the heading, eased. */
export const wordEase = (progress: number, index: number): number =>
  smooth((progress - index * WORD_STAGGER) / WORD_DURATION);

/** 0→1 factor for the heading and the backdrop, which share the first half. */
export const openingEase = (progress: number): number =>
  smooth(progress / HANDOVER);

/**
 * The heading's own curve while it is being **uncovered** by block 2.
 *
 * `openingEase` is over at `HANDOVER` — 55% of its input — because it shares
 * that stretch with the backdrop pan and hands the rest of the timeline to the
 * collage. Fed the lead-in instead, that puts the heading home when block 2 has
 * only pulled back 55% of a screen, which is still 250px *below* the heading's
 * resting top: measured, it arrived at its place while completely hidden and
 * then simply appeared. The whole point of the move is that it is seen to move.
 *
 * So the heading spends the **whole** lead-in on it. Same `smooth` curve, no
 * divisor: still at both ends, and its last frame is the frame the cards clear
 * the top of the screen.
 */
export const emergeEase = (progress: number): number => smooth(progress);

/**
 * Positions as class strings, so Tailwind's scanner can see them. Coordinates
 * are the Figma numbers ÷ 1440 × 100; each comment carries the raw pixels.
 *
 * Horizontal centring is the `translate` property (`-translate-x-1/2`), never
 * `transform` — the scroll reveal and the collage's hover both write
 * `transform`, and the two properties compose instead of overwriting. This is
 * the same split block 2's polaroids use.
 *
 * ── Below the desktop base ─────────────────────────────────────────────────
 *
 * The scene stops being a scene, exactly as block 2's does, and **tablet and
 * phone share one vertical scheme** — heading, first paragraph, collage, second
 * paragraph, sign-off. A three-column row was tried at 768 and reverted: the
 * two side columns come out at 158 and 182, which turns both paragraphs into
 * narrow off-cuts. The only differences between the two sizes are scale.
 *
 *   heading    64/51.2 → 40/32 → 36/28.8   block 2's own ladder, same base size
 *   paragraphs 18/21.6 → 14/16.8           14 is the established small size;
 *                                          1.2 is block 3's own leading ratio
 *   sign-off   24/24 tablet, 16/16 phone   pinned to the floor on both
 *   inset      `px-page`                   block 2's one horizontal inset
 *   from the top
 *              100 tablet                  stated, not centred: the tablet pins
 *                                          its column to the top so the number
 *                                          is the number. `min(100px, 10dvh)`,
 *                                          so a short window gives up margin
 *                                          before the collage gives up size —
 *                                          at 1024 tall the 100 binds and
 *                                          nothing changes
 *   to the bottom
 *              32 tablet                   from the sign-off's *ink*, so the
 *                                          declared offset is 39 — 32 plus
 *                                          Caveat's 7px descender at 24px
 *
 * With both ends stated, the slack has to go somewhere, and left alone it all
 * collected above the sign-off while the three middle elements hung off the
 * heading. Two `margin-bottom: auto` — one on the heading, one on the last
 * paragraph — split it in half instead, so the paragraph · collage · paragraph
 * group sits between its two anchors rather than under one of them.
 *   gaps       46 tablet / 34 phone        the hero's ladder (24·34·46·88)
 *   under the heading
 *              46 tablet / 46 phone        the column gap on a tablet, one rung
 *                                          above it on a phone
 *   above the sign-off
 *              not a gap at all            the sign-off is pinned, so what sits
 *                                          above it is whatever the reserve
 *                                          leaves — equal to the top margin
 *   collage    40dvh tablet / 36dvh phone  a tablet has the height to spare
 *
 * The reading order is `order`, not markup: the DOM keeps the desktop sequence
 * so the `cqw` coordinates above stay where they belong.
 *
 * **The sign-off is reserved for, not centred around.** It is absolute below
 * the desktop base, so it never counts towards the flow column's height, and
 * centring what was left pushed the composition up — 350px of sky over 60 of
 * floor on a tablet, 159 over 24 on a phone. Pinning the column to the top
 * instead made the two *edges* equal but pooled every spare pixel into one
 * 230px hole above the sign-off.
 *
 * So the scene carries a **`padding-bottom` the size of the sign-off plus its
 * own offset**, measured at runtime, and the column centres in what is left.
 * The air then falls in two equal parts — above the heading and between the
 * last paragraph and the sign-off — instead of collecting anywhere.
 *
 * Padding is the right tool because it does not move the sign-off: an
 * absolutely positioned element resolves `bottom` against its containing
 * block's **padding box**, whose bottom edge padding does not touch. The ink
 * stays exactly where the hero's button is.
 *
 * The two travels move to custom properties so the same spring string can
 * carry a `cqw` value on desktop and a px one below it: `cqw` needs a size
 * container, and there is none once the scene drops `container-type`.
 */
export const CLASS = {
  /**
   * 250vh of track, scaled below the desktop base by the hero's own factors —
   * ×0.8 and ×0.733, the same steps that take its pin from 300 to 240 to 220.
   * A phone scrolls a shorter track for the same timeline, which is what keeps
   * the block from reading as an endless swipe on a small screen. The tablet's
   * 170 is a floor found by feel, not by ratio: at 140 the usable travel on a
   * 1024×768 screen was 307px and the whole timeline went past in one flick.
   *
   * **`vh`, not `dvh`, and that matters on touch.** The track is the
   * denominator of the progress value. `dvh` changes the moment a mobile
   * browser retracts its address bar, so the denominator would change *during*
   * a flick — progress jumps, and the block stutters exactly when the reader is
   * moving fastest. `vh` is the large viewport and never moves. The sticky
   * inside stays `dvh` because it has to fill what is actually on screen; this
   * is the same split the hero uses (`h-[300vh]` over `min-h-viewport`).
   * Above the desktop base the two units are identical, so nothing changes
   * there.
   */
  /*
   * **The desktop track opens a screen early, underneath block 2.**
   *
   * `-mt-[100dvh]` pulls the track up by exactly the height of the destinations
   * block, and `z-0` against that block's `z-10` puts this one *behind* it. The
   * sticky screen is therefore already pinned, and already painting, while the
   * cards are still covering the window — and as they scroll off, the picture
   * under them is uncovered from the bottom edge up. The heading, which sits
   * near the top of the screen, comes out from under the cards last, rising as
   * it is uncovered. That is the effect: one layer leaving over another that was
   * there all along, rather than a second screen arriving from below.
   *
   * **The extra screen is added back to the track**, 250vh → 350vh, and that is
   * what makes this cost nothing. The pin lasts `track − sticky`, so 350 − 100
   * is 250vh of pinning, of which the first 100 is spent behind the cards: the
   * *visible* pinned stretch is the same 150vh it always was. The page is the
   * same length too — a screen taken off by the margin, a screen given back to
   * the track.
   *
   * The block's own timeline is untouched in page coordinates: the progress
   * value is remapped past the lead-in by the same fraction (see `philosophy.tsx`),
   * so every keyframe still lands on the scroll position it used to.
   *
   * Desktop only. Below the base the cards block is a flow column of whatever
   * height its content comes to — 515px on a tablet — so there is no screen of
   * overlap to hide behind, and pulling this track up by one would drag it over
   * the hero instead.
   */
  /*
   * **The track came down with the timeline: 350vh → 280vh.**
   *
   * The sequence now lands at 0.73 rather than 0.98 (see `HANDOVER`), so the
   * last quarter of the old track was a finished picture holding the page. What
   * is left is the shape the block actually needs, in three parts:
   *
   *   100vh  lead-in, spent behind block 2 and shared with its exit
   *    80vh  the timeline: content starts at 24vh into it and lands at 58
   *   100vh  the stretch block 4 spends rising over it — added in ADR-0030,
   *          because without it the two overlaps ate the block from both ends
   *          and its own picture had barely a moment of clear screen
   *   100vh  the sticky's own height, which is not scroll
   *
   * So the block adds **180vh** to the page against 250 before — 28% shorter —
   * and the reader waits 24vh for the first thing to arrive rather than 82.
   *
   * The 22vh after the sequence lands is deliberate, not slack: the assembled
   * picture is the block's second Figma frame and it needs a beat to be read
   * before it leaves.
   */
  /**
   * **One track and one seam, at every width.**
   *
   * It used to be `h-[460vh] max-lg:h-[155vh] max-md:h-[165vh] lg:-mt-[100dvh]`
   * — a different length *and* no overlap below the desktop base. That second
   * half is what made the narrow range feel like another block entirely: the
   * `lg:` on the negative margin meant block 2 did not uncover this one and
   * block 4 did not cover it, so where the desktop has a window that content
   * rises into and is clipped out of, a phone had four sections simply abutting.
   * Reported, accurately, as "the animations are completely different".
   *
   * The height is one number now because the shape is a *ratio*, not a distance:
   * 460vh is 100 of lead-in behind block 2, 160 of clear pinned scroll, 100
   * under block 4 and 100 of sticky, which is the same six-and-a-half screens on
   * a phone as on a desktop. `lead` comes out at 0.278 either way, so every
   * keyframe in the block lands at the same fraction of the same journey.
   */
  section: "relative z-0 h-[460vh] -mt-[100dvh]",

  /** One screen, pinned, with the scene centred in it. */
  sticky:
    "bg-surface-gallery sticky top-0 grid h-dvh w-full place-items-center overflow-hidden",

  /**
   * 1440 × 800, and `container-type: size` so `cqw` resolves against it.
   *
   * **The 1600 cap is gone, so this heading is the size block 2's is.** Both are
   * `4.4444cqw` — 64px at their frame's own width — so they only ever differ by
   * how wide their scenes are allowed to grow. Block 2's cap came off in
   * ADR-0021 and this one's did not, which is the whole of why the same heading
   * drew at 85px there and 71px here on a 1920 monitor. Now both scale with the
   * window and the two read as one typographic size.
   *
   * The height ceiling stays and is the only term left: the scene has to fit
   * inside one screen and width drives its height through the aspect ratio, so
   * `100dvh × 1440/800` is what a short window imposes. It only binds below
   * about 1.8:1 — at 1920×1080 it is 1944 against a 1920 window, so the width
   * wins and the two headings land within a pixel of each other.
   *
   * Below the desktop base it fills the sticky instead and becomes the flow
   * column. It has to *fill* it rather than keep an aspect ratio, because the
   * backdrop is sized as a percentage of this box and has to stay twice the
   * screen for the pan to keep covering it.
   */
  scene:
    "relative w-[min(100%,calc(100dvh*1440/800))] aspect-[1440/800] [container-type:size] overflow-hidden max-lg:aspect-auto max-lg:h-full max-lg:w-full max-lg:[container-type:normal] max-lg:flex max-lg:flex-col max-lg:items-center max-lg:justify-center max-lg:gap-[46px] max-lg:px-page md:max-lg:justify-start md:max-lg:pt-[min(100px,10dvh)] max-md:gap-[34px]",

  /**
   * The photograph's box, **twice the sticky tall**.
   *
   * It hangs off the sticky rather than off the scene, so it reaches every edge
   * of the screen. Inside the scene it was clipped to 1440×800 on desktop and
   * left 50px bands of `--surface-gallery` above and below at 1440×900, more on
   * a taller window — the scene is the composition's coordinate system, not the
   * frame the picture is meant to fill.
   *
   * The photograph is 5760×6400, ratio 0.9 against the scene's 1.8, so a plain
   * `object-cover` of the scene would throw away three quarters of its height
   * and leave nothing to pan. At twice the height `cover` resolves to 0.25 on
   * *both* axes (1440/5760 = 1600/6400) and the file is drawn whole.
   *
   * That is what makes the pan a pure `translateY`: the box is exactly two
   * screens, so sliding it up by half of itself walks the frame from the top of
   * the photograph to the bottom while never uncovering the window — and a
   * transform stays on the compositor where `object-position` would not.
   *
   * On a screen taller than 1.8 the cover fit now crops horizontally instead of
   * vertically — 180px at 1440×900 — which is the price of reaching the edges,
   * and it takes it off a photograph that is 5760 wide.
   */
  backdrop: "absolute inset-x-0 top-0 h-[200%]",

  /** rgba(0,0,0,0.4) over the photograph, under everything else. Present in
   *  both states — the file carries it at progress 0 too, so it never animates. */
  scrim: "bg-scrim-scene pointer-events-none absolute inset-0",

  /** 64/51.2 centred, width 446, top 100 in state B. */
  title:
    "text-foreground-accent font-display text-trim absolute left-1/2 top-[6.9444cqw] w-[30.9722cqw] -translate-x-1/2 text-center text-[4.4444cqw] leading-[3.5556cqw] [--b3-travel:17.4306cqw] max-lg:static max-lg:order-1 max-lg:w-full md:max-lg:mb-auto max-lg:translate-x-0 max-lg:text-[48px] max-lg:leading-[38.4px] max-lg:[--b3-travel:46px] max-md:mb-[12px] max-md:text-[36px] max-md:leading-[28.8px]",

  /**
   * 376 × 404 at top 251, centred.
   *
   * Below the desktop base it is sized from the **height** rather than the
   * width — `min(404px, 36dvh)` with its own ratio — because the column has to
   * fit inside one pinned screen and the collage is by far its tallest part.
   * At 360×640, the tightest phone worth supporting, 36dvh is 230 and the whole
   * column lands around 600 of the 640 available. A width-driven size would
   * have overflowed there and been clipped by the sticky.
   *
   * The tablet's 40 is bounded by the *landscape* shape, not the portrait one:
   * at 768×1024 the 404 cap binds and dvh never enters, but at 1024×768 the
   * column is the whole screen bar a margin, and each point of `dvh` here costs
   * that margin about 8px on each side.
   */
  collage: `absolute left-1/2 top-[17.4306cqw] h-[28.0556cqw] w-[26.1111cqw] -translate-x-1/2 max-lg:static max-lg:order-3 max-lg:aspect-[376/404] max-lg:h-[min(404px,40dvh)] max-lg:w-auto max-lg:translate-x-0 max-md:h-[min(404px,36dvh)] ${REVEAL_TRAVEL_VAR}`,

  /** 18/21.6 uppercase, cream at half. Shared by both side paragraphs. */
  aside: `font-ui text-foreground-accent-soft text-trim absolute top-[29.2014cqw] text-[1.25cqw] leading-[1.5cqw] uppercase max-lg:static max-lg:w-full max-lg:max-w-[60%] max-lg:text-center max-lg:text-[16px] max-lg:leading-[19.2px] max-md:max-w-[42ch] max-md:text-[14px] max-md:leading-[16.8px] ${REVEAL_TRAVEL_VAR}`,

  /** Right edge on x=492 over a 258 column, so the left edge is 234. */
  asideLeft:
    "left-[16.25cqw] w-[17.9167cqw] text-right max-lg:order-2 max-lg:w-full",

  /** left 948, width 297. */
  asideRight:
    "left-[65.8333cqw] w-[20.625cqw] text-left max-lg:order-4 max-lg:w-full md:max-lg:mb-auto",

  /**
   * Caveat 20/20, centred, top 708.
   *
   * On a phone it pins to the floor at the hero's EXPLORE offset — but at
   * **29px, not the hero's 24**, and the extra 5 are not a fudge. `text-trim`
   * cuts this paragraph's box to the alphabetic baseline, so the descenders of
   * "being there." hang below it: at 24 the box lands correctly and the ink
   * reads 19 from the edge, against the hero's rule at exactly 24. The hero's
   * link has no trim, so its box bottom *is* its ink. Measured, not guessed —
   * 5px is the descender depth of Caveat at 16px, and what a reader compares is
   * the ink, not the boxes.
   */
  signOff: `text-foreground-accent font-hand text-trim absolute left-1/2 top-[49.1667cqw] w-full -translate-x-1/2 text-center text-[1.3889cqw] leading-[1.3889cqw] max-lg:top-auto max-lg:bottom-[calc(var(--spacing-page)+7px)] md:max-lg:bottom-[39px] max-lg:text-[24px] max-lg:leading-[24px] max-md:bottom-[calc(29px+env(safe-area-inset-bottom))] max-md:text-[16px] max-md:leading-[16px] ${REVEAL_TRAVEL_VAR}`,
} as const;
