/**
 * Every measurement the destinations block takes from Figma, in one place.
 *
 * Source: Get Layers, file WINXFW2nTM7zYwd5dGgm1T, frame 1784:1916
 *   "Hero 2 (Block 2: Destinations)" — 1440×687.
 *
 * The frame was redrawn: sixteen countries, one card each, all sixteen on the
 * scene at once. There is no pile per country any more and nothing swaps —
 * hovering a name lifts that country's card and dims the other fifteen.
 *
 * The frame carries no Figma Variables (`get_variable_defs` returns `{}`), so
 * colours and type sizes were read off the layers and live in globals.css as
 * ordinary tokens. What is left here is geometry.
 *
 * ## The scene
 *
 * The whole block is one **container query scene**: a box of `width: 100%` and
 * `aspect-ratio: 1440/687` carrying `container-type: size`, with every child
 * absolutely positioned in `cqw` — Figma pixels ÷ 1440 × 100. Type sizes too.
 *
 * That is what makes the composition scale 1:1 with the file at any width
 * instead of drifting: a rem layout stops growing above 1440 (the root
 * font-size is pinned at 16px there), so the page kept widening while the pile
 * stayed 888px, pulling the two lists out towards the edges and leaving the
 * cards stranded and small in the middle. `cqw` has no such ceiling.
 */

/** Figma frame width (px) every offset below is measured against. */
export const FRAME_WIDTH = 1440;
/** Figma frame height (px). */
export const FRAME_HEIGHT = 687;

/** A Figma pixel as a fraction of the scene's width. Rounded for readability. */
const cqw = (px: number): number =>
  Math.round((px / FRAME_WIDTH) * 100 * 10000) / 10000;

/** Four decimals is past the sub-pixel on any screen this runs on. */
const round = (value: number): number => Math.round(value * 10000) / 10000;

/**
 * Where a card sits **on the scene**, as CSS length strings.
 *
 * The old composition put its eight cards inside a sub-container — a "fan" of
 * 888×310 with its own `container-type` — because they clustered in the middle
 * of the frame. The new one does not cluster: it runs from x 58 (Switzerland's
 * left edge) to x 1484 (New Zealand's right), and three cards deliberately hang
 * off the top. There is no inner box to be `cqw` of, so every card is placed in
 * `cqw` of the scene's own 1440, like the heading and the two lists.
 */
export interface SceneBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * A plain centre-and-size box on the scene, in `cqw`.
 *
 * What the stickers use. They need no ink correction — see `StickerAsset` — so
 * this is the arithmetic without it: the frame's numbers, converted.
 */
export const toFrameBox = (asset: {
  cx: number;
  cy: number;
  width: number;
  height: number;
}): SceneBox => ({
  left: `${cqw(asset.cx)}cqw`,
  top: `${cqw(asset.cy)}cqw`,
  width: `${cqw(asset.width)}cqw`,
  height: `${cqw(asset.height)}cqw`,
});

/**
 * Turns a card's **ink** — the centre and width the design draws — into the box
 * its PNG has to occupy.
 *
 * Two corrections, both from `asset.ink`, both measured off the alpha channel:
 *
 *   size    the file is wider than its ink by `box` and taller by `boxY`, so
 *           the element is scaled up by exactly that much and the paper inside
 *           lands at the size the file specifies. Up to 1.58× for Austria, whose
 *           export is 36.6% transparent.
 *
 *   centre  the ink is not always in the middle of its file. Where it is not —
 *           New Zealand sits at 0.590 across, Austria at 0.427 down — the box is
 *           pushed the other way by the same offset, so the *ink's* centre lands
 *           on `cx`/`cy` rather than the file's.
 *
 * The element also carries `translate(-50%, -50%)`, which is what makes `left`
 * and `top` name a centre at all.
 */
export const toSceneBox = (asset: {
  cx: number;
  cy: number;
  width: number;
  ink: { box: number; boxY: number; fx: number; fy: number; ratio: number };
}): SceneBox => {
  const fileWidth = asset.width * asset.ink.box;
  const fileHeight = (asset.width / asset.ink.ratio) * asset.ink.boxY;

  return {
    left: `${cqw(asset.cx - (asset.ink.fx - 0.5) * fileWidth)}cqw`,
    top: `${cqw(asset.cy - (asset.ink.fy - 0.5) * fileHeight)}cqw`,
    width: `${cqw(fileWidth)}cqw`,
    height: `${cqw(fileHeight)}cqw`,
  };
};

/**
 * > [!warning] `get_metadata`'s `x` is not the left edge of a rotated leaf
 * > For a **rotated leaf node** Figma reports the x of the rotated rectangle's
 * > own corner, not the left edge of the axis-aligned box it occupies. The two
 * > differ by exactly `height × sin(rotation)`:
 * >
 * > | | metadata `x` | true left | h·sinθ |
 * > |---|---|---|---|
 * > | Sticker1, 19.17° | 433.72 | 415 | 57 × sin 19.17 = 18.72 |
 * > | Sticker2, 8.33° | 493.59 | 487 | 45.515 × sin 8.33 = 6.59 |
 * > | Sticker3, 17.09° | 631.76 | 620 | 40.001 × sin 17.09 = 11.76 |
 * > | Sticker4, 0° | 1080 | 1080 | 0 |
 * >
 * > All three rotated stickers therefore sat that far to the right. The eight
 * > polaroids never did: each is wrapped in a **Group**, and a group's x is the
 * > axis-aligned box. `get_design_context` reports the true edges for both
 * > kinds — it emitted `left-[calc(25%+55px)]` (= 415) for Sticker1 while the
 * > metadata said 433.72.
 * >
 * > Confirmed against a 1440×687 render of the frame: compositing the local
 * > PNGs and searching for the offset that minimises the pixel difference gives
 * > −18 / −6 / −12 / 0, and the diff falls by 70% / 42% / 63% / 0%.
 * >
 * > Storing centres rather than corners is what makes this class of error
 * > impossible to reintroduce: a centre does not move when a box rotates.
 */

/**
 * The hover lift: a few px up and a scale just over 1, on one transform written
 * by a spring — a real transform over a real distance is exactly what ADR-0014
 * reserves springs for.
 *
 * > [!warning] Both ends must carry the same unit
 * > react-spring interpolates a transform string by matching the numbers and
 * > reusing one side's template. Written as `0` → `-0.375rem` it kept the
 * > template's `px` and animated to **−0.375px** — a lift that compiles, runs,
 * > and is invisible. Hence the explicit `px` on every component of both
 * > strings, including the zeroes.
 */
export const CARD_HOVER = {
  from: "translate3d(0px, 0px, 0px) scale(1)",
  to: "translate3d(0px, -6px, 0px) scale(1.025)",
  /** Settles in ~250ms, the middle of the 200–300ms the brief asks for. */
  config: { tension: 300, friction: 30 },
} as const;

/**
 * The same lift, for a device that has no hover to give.
 *
 * `<Hover>` switches itself off below 768px and there is nothing to replace it
 * with — a spring needs a state to drive it, and `:active` is a state only CSS
 * can see. So this is the one place in the section that animates a transform
 * with a CSS transition rather than a spring. ADR-0014 allows exactly that for
 * a *discrete* state change on token-backed timing, which `:active` is, and
 * `--duration-normal` is 250ms — the same time the spring takes to settle.
 *
 * Everything is scoped to `(hover: none)` so it can never run alongside the
 * spring, which writes `transform` on this same element frame by frame. It
 * moves `translate` and `scale`, which Tailwind v4 writes as their own
 * properties, so the two compose instead of overwriting each other.
 */
/**
 * The press needs a cursor to exist at all on iOS.
 *
 * Safari only puts `:active` on a non-interactive element if it looks
 * clickable — a touch handler, or `cursor: pointer`. Without this the whole
 * `group-active` rule below is dead on an iPhone or iPad, which is exactly
 * where it is the only feedback there is. Scoped to `(hover: none)` so a
 * desktop pointer never turns into a hand over a decorative photograph.
 */
export const TOUCH_TARGET = "[@media(hover:none)]:cursor-pointer";

export const TOUCH_PRESS =
  "[@media(hover:none)]:transition-transform [@media(hover:none)]:duration-[var(--duration-normal)] [@media(hover:none)]:ease-entrance [@media(hover:none)]:group-active:-translate-y-[6px] [@media(hover:none)]:group-active:scale-[1.025] motion-reduce:transition-none";

/**
 * The hover, in three dimensions — and a different one for every card.
 *
 * `CARD_HOVER` above is the flat lift the *other* blocks import: block 3's
 * collage and block 5's button both take their −6px and 1.025 from it, and it
 * stays exactly as it was. What the scene's own polaroids do is a different
 * thing: the card comes up **off the table** rather than up the page — scaled a
 * little further, lifted in `cqw` rather than `px`, and turned about two axes
 * behind a `perspective()`, which is what makes a flat photograph read as a
 * piece of paper somebody has picked up.
 *
 * > [!important] Sixteen cards, sixteen tilts
 * > One tilt applied to all of them would read as a filter over the scene rather
 * > than as sixteen loose photographs. The angles come off the **golden angle**
 * > (137.508°) stepped by paint order and split into a sine and a cosine, so no
 * > two of the sixteen land on the same pair and the set is spread evenly around
 * > the circle rather than clustered wherever a hand-written table happened to
 * > put it. Change `tiltX`/`tiltY` and all sixteen move together, keeping their
 * > spread.
 *
 * The lift is in `cqw`, so it is the same fraction of the card at every monitor
 * size — a 6px lift is a shrug on a 2560 scene and a lurch on a 1280 one.
 *
 * > [!warning] Both ends must carry the same unit *and the same shape*
 * > react-spring interpolates a transform string by matching the numbers and
 * > reusing one side's template, so `from` and `to` here are the same eight
 * > numbers in the same eight places, units and all, down to the zeroes. Drop
 * > `rotateX(0deg)` from `from` and the spring pairs up the numbers it can and
 * > silently mismatches the rest.
 */
export const CARD_TILT = {
  /**
   * Eye distance the tilt is drawn against, in px. **Lower is more perspective**
   * — it is the denominator of the whole effect, and 900 was far enough away
   * that a 12° turn foreshortened by almost nothing. At 520 the same turn
   * separates the two vertical edges of a 240px card by about 8%, which is the
   * difference between a picture that is tilted and a picture that is *near*.
   */
  perspective: 520,
  /** How far the card comes off the table, in `cqw` so it scales with it. */
  lift: 0.7,
  /**
   * How far it comes **towards the reader**, in px.
   *
   * This is what replaced most of the old `scale(1.06)`, and it is the second
   * half of why the perspective now reads. A scale is a flat magnification: the
   * card gets bigger and stays exactly as far away. `translateZ` moves it up the
   * view frustum, so the magnification is *computed* from the distance — near
   * edge grows more than the far one, and the card visibly leaves the table
   * rather than being zoomed. At 520/40 it comes out at 1.083 overall.
   */
  rise: 40,
  /** A touch on top, so a card with a shallow tilt still answers the pointer. */
  scale: 1.015,
  /** Bounds on the two out-of-plane turns, in degrees. */
  tiltX: 14,
  tiltY: 18,
  /** A turn in the plane of the page too, so no card squares up to the grid. */
  roll: 2.5,
  /**
   * Softer than the flat lift's ~250ms: this is a bigger movement, and the same
   * spring that reads as crisp on 6px reads as a snap on a card that turns,
   * rises and grows at once. ~420ms, and critically damped enough not to wobble.
   */
  config: { tension: 190, friction: 26 },
} as const;

/**
 * What the other fifteen fall to while one is picked up.
 *
 * The block used to insist that **nothing** dims — every card at full strength
 * all the time, the scene reading as a table somebody laid out rather than as a
 * control with a selection. That was the right call for a flat lift of 6px, and
 * it is the wrong one now: a card that turns towards the reader is a card in
 * front of the others, and leaving the fifteen behind it at full strength is
 * what made the pile read as noise around it.
 *
 * Only while the pointer is actually in the block. ICELAND is active on arrival
 * and stays active after the pointer leaves, so dimming on `raised` alone would
 * have fifteen cards sitting at 42% before anyone touched anything, and again
 * for as long as the page was left.
 *
 * The marks come down with them, less far: they are laid *on* the pile rather
 * than being part of it, and pulling them to the cards' own level made the flag
 * and the stamp disappear from a scene that still had fifteen cards in it.
 *
 * > [!important] `brightness`, not `opacity` — the cards are **darkened**, not
 * > made transparent
 * > Dropping the opacity let the black behind show *through* the paper, which is
 * > a photograph going see-through rather than one lying in shadow: the pile
 * > read as ghosts of itself. What is wanted is a black sheet laid over the
 * > fifteen, and `filter: brightness(0.45)` is that sheet — it is exactly black
 * > at 55% over every lit pixel, and the card stays opaque.
 * >
 * > It cannot be an actual overlay element. These files are **finished polaroids
 * > with transparent margins** — up to 36.6% of Austria's box is nothing at all —
 * > so a black rectangle at the element's size would paint a black rectangle
 * > around the card. A filter follows the alpha channel; a rectangle does not.
 * > (A masked overlay would work too, at the cost of fetching every PNG a second
 * > time as a `mask-image`, unoptimised, for a result the filter already gives.)
 */
export const CARD_DIM = {
  rest: 0.45,
  stickers: 0.62,
  /** Slower than the tilt — the dimming is a background, not an event. */
  config: { tension: 150, friction: 26 },
} as const;

/** The shade, as the filter that produces it. */
export const toShade = (level: number): string =>
  `brightness(${round(level)})`;

/** 137.508° — the angle that spreads N samples most evenly around a circle. */
const GOLDEN_ANGLE = 137.508;

export interface CardTilt {
  from: string;
  to: string;
}

/**
 * One card's pair of transform strings, from its paint order.
 *
 * `order` is `asset.z` (1–16). Any integer works — the angle is taken modulo a
 * full turn — so the function is total and needs no table to look a card up in.
 */
export const toCardTilt = (order: number): CardTilt => {
  const angle = ((order * GOLDEN_ANGLE) % 360) * (Math.PI / 180);
  const rx = round(CARD_TILT.tiltX * Math.sin(angle));
  const ry = round(CARD_TILT.tiltY * Math.cos(angle));
  const rz = round(CARD_TILT.roll * Math.sin(2 * angle));

  return {
    from:
      `perspective(${CARD_TILT.perspective}px) translate3d(0cqw, 0cqw, 0px) ` +
      `rotateX(0deg) rotateY(0deg) rotate(0deg) scale(1)`,
    to:
      `perspective(${CARD_TILT.perspective}px) ` +
      `translate3d(0cqw, ${round(-CARD_TILT.lift)}cqw, ${CARD_TILT.rise}px) ` +
      `rotateX(${rx}deg) rotateY(${ry}deg) rotate(${rz}deg) scale(${CARD_TILT.scale})`,
  };
};

/**
 * The entrance: sixteen cards flown in from the edges and assembled into the
 * pile at the coordinates they already have.
 *
 * Nothing here invents a destination. Every card's resting place is still
 * `toSceneBox(asset)` on the element that owns the placement; the entrance lives
 * on a **wrapper inside it** and is an offset *from* that place, driven to zero.
 * So the pile the animation builds is the pile the file draws, to the pixel, and
 * it cannot drift — there is no second set of coordinates to keep in step with
 * the first.
 *
 * ## Which side a card comes from
 *
 * Its own. The card's ink centre is compared to the centre of the frame, the
 * larger of the two offsets picks the axis, and the card is pushed out along it
 * until it clears the scene's edge — which is why Switzerland and Norway drop in
 * from above, Morocco and Canada rise from below, Japan and Italy come in from
 * the left and the eastern half from the right. A table of directions would have
 * said the same thing and then gone stale the first time a card moved.
 *
 * The push is measured to the **edge plus the card's own half-size**, so every
 * card starts just outside the frame rather than at some shared far-away point:
 * the travel is 20–35 `cqw` rather than 80, and no card spends most of its
 * window invisible. The scene clips (`overflow: hidden`), so the part of the
 * flight that happens outside it is never seen.
 *
 * ## When
 *
 * Scroll-linked, not fire-and-forget: one 0→1 progress value across the
 * section's approach, and each card reads a `span`-wide slice of it, stepped by
 * paint order. So the pile assembles **bottom card first** — the order the frame
 * draws them in — and scrolling back up takes it apart in the order it was
 * built. The last card's slice ends exactly at 1, whatever the count.
 */
export const ENTRANCE = {
  /**
   * How much of the block's progress one card's own flight takes.
   *
   * **0.55 → 0.7**, which is the single biggest thing that took the harshness
   * out of the entrance. A card's travel is fixed by where it starts; the only
   * way to make it cross that distance more gently is to give it more of the
   * scroll to do it in. At 0.7 each card has ~630px of a 900px window to itself
   * — roughly 30% slower than before — and the sixteen slices overlap that much
   * more, so the pile builds as one movement rather than as sixteen darts.
   */
  span: 0.7,
  /** How far past the scene's edge a card starts, in `cqw`. */
  clearance: 3,
  /** Sideways drift on the axis the card is *not* flying along, in `cqw`. */
  drift: 6,
  /** The turn a card carries in and unwinds as it lands, in degrees. */
  rotate: 10,
  /** The size it arrives at, before it settles to 1. */
  scale: 0.88,
  /**
   * The fraction of a card's own slice its fade-in takes.
   *
   * Widened with the span: the fade is what covers the fastest part of the
   * flight, so it has to reach into it rather than being over before the card
   * has left the edge.
   */
  fade: 0.45,
  /**
   * Where the three marks start to appear.
   *
   * They belong to the finished picture, not to any one card — the lupin, the
   * stamp and the flag are laid *on* the pile — so they arrive last and only
   * fade: a sticker flying in from an edge would read as a seventeenth card.
   */
  stickers: 0.78,
} as const;

/** The scene's height in `cqw` — its own unit, since `cqw` is a width. */
const SCENE_HEIGHT = round((FRAME_HEIGHT / FRAME_WIDTH) * 100);

/** Where a card flies in from, as an offset from its resting place in `cqw`. */
export interface EntranceTravel {
  x: number;
  y: number;
  rotate: number;
}

/** The slice of the block's progress one card's flight occupies. */
export interface EntrancePhase {
  start: number;
  end: number;
}

export const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * Smootherstep — `6t⁵ − 15t⁴ + 10t³`. Zero velocity at **both** ends.
 *
 * It replaced a cubic ease-out, and that is the other half of why the entrance
 * stopped feeling harsh. An ease-out's fastest instant is its **first** one: the
 * card was leaving the edge at full speed the frame it started, which is what
 * reads as a dart. The cards with the longest travel — Iceland at 43cqw, Spain
 * at 50 — showed it worst, because speed is travel ÷ span and theirs is double
 * the pile's average.
 *
 * Smootherstep starts and ends still, so a card eases out of the edge, crosses
 * the frame, and eases into its place. Its second derivative is zero at both
 * ends too, so there is no visible corner where the movement begins or stops.
 */
const easeOut = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * The offset a card starts its flight at, from the card itself.
 *
 * Everything is in `cqw`, so the flight scales with the scene exactly as the
 * pile does — the card crosses the same fraction of the frame on a 1280 monitor
 * as on a 2560 one.
 */
export const toEntranceTravel = (asset: {
  cx: number;
  cy: number;
  width: number;
  z: number;
  ink: { ratio: number };
}): EntranceTravel => {
  const cx = cqw(asset.cx);
  const cy = cqw(asset.cy);
  const halfWidth = cqw(asset.width) / 2;
  const halfHeight = halfWidth / asset.ink.ratio;

  /* −1 … 1 across and down the frame. The bigger one picks the axis. */
  const nx = (asset.cx - FRAME_WIDTH / 2) / (FRAME_WIDTH / 2);
  const ny = (asset.cy - FRAME_HEIGHT / 2) / (FRAME_HEIGHT / 2);
  const horizontal = Math.abs(nx) >= Math.abs(ny);

  const outX =
    nx >= 0
      ? 100 + halfWidth + ENTRANCE.clearance - cx
      : -(halfWidth + ENTRANCE.clearance) - cx;
  const outY =
    ny >= 0
      ? SCENE_HEIGHT + halfHeight + ENTRANCE.clearance - cy
      : -(halfHeight + ENTRANCE.clearance) - cy;

  return {
    x: round(horizontal ? outX : nx * ENTRANCE.drift),
    y: round(horizontal ? ny * ENTRANCE.drift : outY),
    /* Alternating by paint order, so neighbours never turn the same way. */
    rotate: asset.z % 2 === 0 ? ENTRANCE.rotate : -ENTRANCE.rotate,
  };
};

/**
 * The slice of progress a card flies across.
 *
 * `count` rather than a constant 16: the step is solved so the **last** card's
 * slice ends at 1 whatever the content holds, which is the one property a
 * hand-tuned stagger loses the moment a country is added.
 */
export const toEntrancePhase = (
  order: number,
  count: number,
): EntrancePhase => {
  const step = count > 1 ? (1 - ENTRANCE.span) / (count - 1) : 0;
  const start = round(order * step);
  return { start, end: round(start + ENTRANCE.span) };
};

/** A card's own 0→1, read out of the block's. */
const phaseAt = (phase: EntrancePhase, progress: number): number =>
  phase.end === phase.start
    ? 1
    : clamp01((progress - phase.start) / (phase.end - phase.start));

/**
 * What each card does with the **rest** of the block's scroll.
 *
 * The entrance is over by the time the section is centred, and there is another
 * screen of scrolling after it while the block leaves. Everything holding
 * perfectly still through that is what makes a collage read as a flat picture
 * rather than as objects on a table, so the pile spreads: every card drifts up
 * and outwards, and **by how much is its own paint order**.
 *
 * That is the whole of the parallax — not a depth invented for the occasion but
 * the stacking the frame already draws. The card on top of the pile is the
 * nearest thing in it, so it travels furthest; the one at the bottom is the
 * furthest away and barely moves. Sixteen speeds, monotone in `z`, and the pile
 * opens along its own axis of depth as it goes.
 */
export const PARALLAX = {
  /**
   * How far the nearest card rises as the block leaves, in `cqw`.
   *
   * **5 → 11.** At 5 the spread was arithmetically correct and visually
   * invisible: 72px of travel at 1440 for the top card, spent over a whole
   * screen of scrolling, which is slower than the eye reads as movement at all.
   * 11 is 158px for the nearest card against 24 for the furthest — a ratio wide
   * enough that the pile is plainly coming apart in depth rather than sliding
   * as one sheet.
   */
  rise: 11,
  /** How far it also spreads away from the centre line, in `cqw`. */
  spread: 5.5,
  /**
   * The furthest card's share of both — never zero, or it looks pinned.
   *
   * Lowered with the rise: the point of a bigger number is a bigger *spread* of
   * speeds, and holding the floor at 0.22 would have moved the back of the pile
   * 2.4× further as well, keeping the ratio where it was.
   */
  floor: 0.15,
  /** The marks travel with the middle of the pile, since they lie on it. */
  stickers: 0.55,
} as const;

/** The window the drift is scrubbed across: centred, to gone. */
export const PARALLAX_START = "center center" as const;
export const PARALLAX_END = "bottom top" as const;

/** One card's share of the drift, in `cqw` at full progress. */
export interface CardDrift {
  x: number;
  y: number;
}

/**
 * How far this card drifts, from its paint order and its side of the frame.
 *
 * `count` for the same reason `toEntrancePhase` takes it: the depth is a
 * position in the stack, and a stack of a different size is a different set of
 * positions.
 */
export const toCardDrift = (
  asset: { cx: number; z: number },
  count: number,
): CardDrift => {
  const depth =
    count > 1
      ? PARALLAX.floor +
        (1 - PARALLAX.floor) * ((asset.z - 1) / (count - 1))
      : 1;
  const nx = (asset.cx - FRAME_WIDTH / 2) / (FRAME_WIDTH / 2);

  return {
    x: round(nx * depth * PARALLAX.spread),
    y: round(-depth * PARALLAX.rise),
  };
};

/**
 * Everything the page's scroll does to one card, as a single transform.
 *
 * Written on a wrapper of its own rather than folded into the hover string on
 * the element below it: the two run on different clocks — these two are the
 * page's scroll, the other is a spring watching the pointer — and a single
 * string would make each one overwrite the other's frames. Two nested elements
 * compose instead, which is what the browser's transform stack is for.
 *
 * The entrance and the drift *are* on the same clock, though — both are the
 * page — so they share one element and are simply added. They also never
 * overlap: `entrance` is spent by the time the section is centred, which is
 * exactly where `drift` starts.
 */
export const toCardTransform = (
  travel: EntranceTravel,
  phase: EntrancePhase,
  drift: CardDrift,
  entrance: number,
  driftProgress: number,
): string => {
  const t = easeOut(phaseAt(phase, entrance));
  const away = 1 - t;
  const d = clamp01(driftProgress);

  return (
    `translate3d(${round(travel.x * away + drift.x * d)}cqw, ` +
    `${round(travel.y * away + drift.y * d)}cqw, 0px) ` +
    `rotate(${round(travel.rotate * away)}deg) ` +
    `scale(${round(ENTRANCE.scale + (1 - ENTRANCE.scale) * t)})`
  );
};

/** The marks drift with the middle of the pile, and only up. */
export const toStickerTransform = (driftProgress: number): string =>
  `translate3d(0cqw, ${round(
    -clamp01(driftProgress) * PARALLAX.rise * PARALLAX.stickers,
  )}cqw, 0px)`;

/** The fade, over the opening `fade` of the card's own slice. */
export const toEntranceOpacity = (
  phase: EntrancePhase,
  progress: number,
): number => round(clamp01(phaseAt(phase, progress) / ENTRANCE.fade));

/** The marks' own fade, over the tail of the block's progress. */
export const toStickerOpacity = (progress: number): number =>
  round(clamp01((progress - ENTRANCE.stickers) / (1 - ENTRANCE.stickers)));

/**
 * The window the entrance is scrubbed across: from the section's top edge
 * touching the bottom of the screen to the section sitting centred in it.
 *
 * The section is a full screen tall, so that is one screen of scrolling — the
 * pile finishes assembling exactly as the block finishes arriving, and there is
 * no stretch of the approach where nothing happens.
 */
export const ENTRANCE_START = "top bottom" as const;
export const ENTRANCE_END = "center center" as const;

/**
 * Travel for the country cross-fade. The outgoing pile leaves upward and the
 * incoming one arrives from below, both on opacity — nothing in the layout
 * moves, because every pile is absolutely positioned inside the stage.
 */
export const SWAP_TRAVEL = 20;

/**
 * The cross-fade between two cards, in the narrow ranges.
 *
 * **A duration, not a spring** — the one shape of animation where that is
 * plainly right. Two elements have to be exactly complementary here: one fades
 * out while the other fades in, and a spring's settle tail is precisely the part
 * that is not symmetrical. At 190/26 the outgoing card lingered a beat past the
 * incoming one and the swap read as a stutter rather than a dissolve; both
 * halves now take the same 620ms and cross at the middle.
 *
 * `easeInOutCubic` is still at both ends, so neither card starts or stops
 * abruptly, and 620ms against the 12px of travel it used to have is why the
 * distance went up to 20: a slower move over the same distance reads as a
 * hesitation, not as a glide.
 */
export const SWAP_CONFIG = {
  duration: 620,
  easing: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
} as const;

/**
 * The z the hovered card is lifted to. Above the sixteen cards (1–16) and above
 * the stickers (20), so a raised card clears the lupin, the stamp and the flag
 * as well as its neighbours.
 */
export const RAISED_Z = 30;

/**
 * Where the card that was *just* released goes.
 *
 * One below the raised card and above all sixteen, so moving from one polaroid
 * to its neighbour lowers the first one **in front of** the pile instead of
 * snapping it back under four other cards on the frame the pointer left. Paint
 * order cannot be animated; this is the whole of what can be done about it, and
 * measured against the alternative it is the difference between a swap and a
 * cut.
 */
export const LOWERING_Z = RAISED_Z - 1;

/** Paint order for the three marks, which sit over every card at rest. */
export const STICKER_Z = 20;

/**
 * The three slots the narrow ranges stack their cards in.
 *
 * Below the desktop base there is no frame to be faithful to — sixteen cards at
 * 768 would be ~100px of paper each — so the block shows the selected country in
 * front with its next two neighbours behind it, as depth rather than as content.
 *
 * `cx`/`cy` are the centre of the slot and `width` the width of the card's
 * **ink**, all as percentages of the container. Same rule as the scene: the
 * exports carry up to 36.6% transparent margin, so a percentage handed straight
 * to the file box would draw Austria's paper a third too small next to Spain's.
 *
 * No rotation: every file is already turned.
 *
 * **They overlap, and each still reads whole.** Those are not in tension if the
 * overlap is arranged rather than allowed: the three run down a diagonal, so
 * each card is covered only on its inner-lower side and keeps its **outer top
 * corner and the two edges meeting there** entirely clear. A rectangle showing a
 * corner and two edges is read as a rectangle continuing behind; a rectangle
 * showing a strip with no corner is read as one that has been cut, which is what
 * every earlier arrangement produced.
 *
 * Laid out flat with no overlap at all the question also goes away, but the
 * cards drop to a third of the row and the collage stops being a collage. This
 * keeps both: 46% each, and measured across all sixteen states no card ever has
 * less than half of itself showing.
 */
export interface StackSlot {
  cx: number;
  cy: number;
  width: number;
  z: number;
}

export const STACK: readonly StackSlot[] = [
  { cx: 31, cy: 38, width: 46, z: 1 },
  { cx: 69, cy: 43, width: 46, z: 2 },
  { cx: 50, cy: 62, width: 46, z: 3 },
] as const;

/**
 * A per-range multiplier on the slot widths, kept at 1 in both.
 *
 * It exists as the knob to turn if a range ever needs the whole stack smaller,
 * and it is 1 because it does not: the phone's narrower 4/5 box is handled by
 * the slot-room bound below, which brings each card down by exactly what its own
 * shape needs rather than shrinking all sixteen for the sake of the tallest.
 */
export const STACK_FIT = { tablet: 1, mobile: 1 } as const;

/**
 * The margin a card's ink keeps from the container's edges, in percent.
 *
 * A slot width is a *wish*, not a guarantee: the cards are sixteen different
 * shapes, and 62% of the width is 105% of the height for New Zealand's 0.863
 * ink in a 4/3 box. Measured, it hung 48.8px out of a 267×200 stack.
 *
 * The room a card has is not the whole box either — it is what its own slot
 * leaves. A slot at `cy: 44` has 42 above it and 54 below, so the binding
 * constraint is the 42, not half of 100. Measuring against the centre instead
 * put Spain 8px over the top edge from the `cy: 44` slot, its 0.621 ink being
 * the most upright of the sixteen.
 */
const STACK_MARGIN = 2;

/** Where a stacked card sits inside its container, as CSS percentages. */
export interface StackBox {
  left: string;
  top: string;
  width: string;
  aspectRatio: string;
  zIndex: number;
}

/**
 * The slot rule, applied to one card in one container.
 *
 * `ratio` is the container's own width ÷ height, which is what turns a width
 * measured across the box into an offset measured down it: a card 40% of the
 * width is 40 × ratio percent of the height. Without it the `fy` correction
 * would be applied in the wrong unit and the off-centre exports — Austria at
 * 0.427 down its file — would miss their slots.
 */
export const toStackBox = (
  slot: StackSlot,
  asset: { ink: { box: number; boxY: number; fx: number; fy: number; ratio: number } },
  fit: number,
  containerRatio: number,
): StackBox => {
  /*
   * The ink first, because the ink is what has to fit and what the slot width
   * describes. Its height is measured across the box like its width — a `%`
   * width is a fraction of the container's width — so it is turned into a
   * fraction of the height by the container's own ratio before it is judged.
   */
  const wish = slot.width * fit;

  /*
   * The four edges the file must stay inside, solved rather than approximated.
   *
   * The element is not centred on the slot: it is offset so the *ink's* centre
   * lands there, by `(fx − 0.5)` of the file's own width. So its left edge sits
   * at `cx − w·fx` and its right at `cx + w·(1 − fx)`, and the two give
   * different limits on `w`. Taking `min(cx, 100 − cx)` instead assumes a
   * centred box, which is exactly what Austria is not — its ink is 0.427 down
   * its file, and the element ran 15px past the bottom of the container at 768
   * and 23 at 1024 while the arithmetic said it was inside.
   */
  /*
   * The bound is on the **ink**, which is what anyone can see. Bounding the file
   * shrank every card that carries a wide transparent margin — Austria by a
   * third — for no gain: measured from the image up, nothing in this subtree
   * clips, so a transparent margin reaching past the container costs nothing.
   *
   * The ink is centred on the slot by construction, so its room is simply what
   * the slot leaves on its tighter side.
   */
  const limitW = 2 * (Math.min(slot.cx, 100 - slot.cx) - STACK_MARGIN);
  const limitH = 2 * (Math.min(slot.cy, 100 - slot.cy) - STACK_MARGIN);

  /*
   * Nothing in this subtree clips, and that was worth proving rather than
   * assuming: walked from the `<img>` up, every ancestor to the section is
   * `overflow: visible` with no `clip-path`, no mask and no containment. What
   * reads as a straight cut on a back card is that card's **own edge** — a
   * rotated polaroid has four of them — with the rest of it behind the front
   * card. Austria's paper starts 181px into its file, which at the rendered
   * size is exactly the line that looked like a crop.
   */
  const inkWidth = Math.min(
    wish,
    limitW,
    (limitH * asset.ink.ratio) / containerRatio,
  );

  const fileWidth = inkWidth * asset.ink.box;
  const fileHeight = (inkWidth / asset.ink.ratio) * asset.ink.boxY;

  return {
    left: `${round(slot.cx - (asset.ink.fx - 0.5) * fileWidth)}%`,
    top: `${round(slot.cy - (asset.ink.fy - 0.5) * fileHeight * containerRatio)}%`,
    width: `${round(fileWidth)}%`,
    aspectRatio: `${round((asset.ink.box * asset.ink.ratio) / asset.ink.boxY)}`,
    zIndex: slot.z,
  };
};

/**
 * How much of the file is transparent margin, and where its ink sits, for each
 * of the nineteen PNGs. See `InkMetrics` for what the five numbers mean and
 * `toSceneBox` for what is done with them.
 *
 * Measured, not declared: every file was scanned for the bounding box of its
 * pixels above 8/255 alpha. Re-export a card and this row has to be measured
 * again — the same scan is three lines of `sharp`.
 *
 * The scan is also what caught three **clipped exports**. Greece, Austria and
 * New Zealand arrived with their artwork running into the edge of the file — 0
 * of margin on one side against 4, 120 and 101 on the others — which is a crop,
 * not a tight bounding box, and it was why their shapes disagreed with the frame
 * by 9–30%. Re-exported, all three now sit clear of their edges and their ink
 * ratios land within **0.2%** of the widths and heights the frame gives them,
 * the same agreement the other thirteen always had. The rows below are the
 * re-measured ones.
 */
export const INK = {
  "Iceland": { box: 1.0143, boxY: 1.0113, fx: 0.4992, fy: 0.5, ratio: 0.8845 },
  "Norway": { box: 1.2467, boxY: 1.3074, fx: 0.4992, fy: 0.5, ratio: 1.0881 },
  "Japan": { box: 1.0087, boxY: 1.011, fx: 0.4991, fy: 0.5, ratio: 1.0548 },
  "Morocco": { box: 1.3246, boxY: 1.1953, fx: 0.4993, fy: 0.5, ratio: 0.8309 },
  "Switzerland": { box: 1.5158, boxY: 1.2901, fx: 0.5, fy: 0.5, ratio: 0.8435 },
  "Italy": { box: 1.0036, boxY: 1.0026, fx: 0.5, fy: 0.5, ratio: 0.7112 },
  "France": { box: 1.0097, boxY: 1.0075, fx: 0.5, fy: 0.5, ratio: 0.7757 },
  "Portugal": { box: 1.0143, boxY: 1.0113, fx: 0.4992, fy: 0.5, ratio: 0.8845 },
  "Spain": { box: 1, boxY: 1, fx: 0.5, fy: 0.5, ratio: 0.6212 },
  "Greece": { box: 1.0143, boxY: 1.0113, fx: 0.4992, fy: 0.5, ratio: 0.8845 },
  "Austria": { box: 1.5764, boxY: 1.3102, fx: 0.5, fy: 0.4995, ratio: 0.8082 },
  "Canada": { box: 1.4007, boxY: 1.5313, fx: 0.5, fy: 0.5088, ratio: 1.1333 },
  "New Zealand": { box: 1.343, boxY: 1.469, fx: 0.5, fy: 0.5, ratio: 1.1051 },
  "Australia": { box: 1.0039, boxY: 1.0043, fx: 0.5, fy: 0.5, ratio: 1.1073 },
  "Slovenia": { box: 1.0097, boxY: 1.0087, fx: 0.5, fy: 0.4994, ratio: 0.774 },
  "Istanbul": { box: 1.3721, boxY: 1.5158, fx: 0.4994, fy: 0.4993, ratio: 1.1206 },
  "Sticker1-art": { box: 1.5327, boxY: 1.2284, fx: 0.4604, fy: 0.4623, ratio: 0.6605 },
  "Sticker3": { box: 1.0328, boxY: 1.007, fx: 0.4841, fy: 0.4965, ratio: 0.8592 },
  "Sticker4": { box: 1.0714, boxY: 1.0482, fx: 0.5048, fy: 0.523, ratio: 1.1807 },
} as const;

/**
 * Layout as class strings rather than inline styles.
 *
 * Inline styles cannot be overridden by a media query, and below the desktop
 * base the scene has to stop being a scene: at 768 a 1:1 composition puts the
 * country list at 8.5px and at 390 at 4.3px, which is not a list any more. So
 * `max-lg:` unwinds it into a flow column — heading, pile, both lists — and
 * pins the small type the way the hero does.
 *
 * These must stay **literal strings** for Tailwind's scanner to see them.
 */
export const CLASS = {
  /*
   * **The desktop section is one full screen, and the scene is centred in it.**
   *
   * It was previously as tall as its frame — no floor, no top padding — so that
   * the three cards the design hangs off the top edge would be cut exactly on
   * the seam with the hero. That is a real property and it is now gone on
   * purpose: the block is a screen you arrive at, like the hero before it and
   * block 3 after it, and a 727px strip between two full-viewport pins reads as
   * an off-cut. What the crop costs is a band of black above the cut cards on a
   * window taller than 15:7; what it buys is that the composition is sized by
   * the **whole** screen rather than by its width alone, which is the only way
   * the cards grow and shrink with the monitor in both directions.
   *
   * `min-height`, not `height`, so nothing is ever clipped: where the content is
   * taller than the screen the section grows past it and the centring stops
   * applying.
   *
   * Below the desktop base the scene stops being a scene and none of this
   * applies. The floor comes back for a phone, whose column runs past it anyway,
   * and the top band steps up the hero's own vertical ladder (… 24 · 34 · 46 ·
   * 5.5rem): **46** on a tablet and **88** on a phone, where the heading is
   * otherwise pressed against the block above.
   *
   * `dvh`, not `vh`: on a phone browser `100vh` is the *large* viewport, taller
   * than what is on screen while the address bar is out, which would leave the
   * block a bar's height too tall.
   *
   * **A tablet drops the floor too.** Same reasoning as the desktop, different
   * numbers: the stack measures 427 at 768, so `min-h: 700` left 273 of black to
   * `place-items-center` — 126 over the heading and 96 under the lists. Without
   * it the block is 519 and the bands are the 46 the other blocks open with.
   */
  /**
   * **At least one viewport tall, at every width — and that is a load-bearing
   * requirement, not a preference.**
   *
   * Block 3 is pulled `-100dvh` under this section so it is uncovered as this
   * one scrolls away (ADR-0037). The arithmetic only works while the block being
   * pulled under is *at least* that tall: at 700px in an 844px window, block 3's
   * top lands 144px **above** this section's own, and it covers the foot of the
   * hero with its opaque sticky. Measured at ~985×992, where this section's
   * content is about 700: the hero lost its last 290px — its second display
   * line, its call to action, and its floor.
   *
   * So the two caps that used to sit here are gone:
   * `max-lg:min-h-[min(100dvh,700px)]` and `md:max-lg:min-h-0`. They were there
   * to keep the pile from being stranded in a tall empty screen, which is a
   * legitimate worry and a much smaller one than eating the section above.
   * `place-items-center` spends the difference as air around the pile.
   *
   * > [!important] The rule, for any section a later one is pulled under
   * > A `-100dvh` seam is a contract between two blocks: the one above must be
   * > **≥ 100dvh**, or the one below does not slide under it — it slides past it.
   * > Today that names this section and block 3 (which is 460vh). Any new seam
   * > owes the same check.
   */
  section:
    "bg-surface-gallery relative z-10 grid min-h-[100dvh] w-full place-items-center overflow-x-clip py-[40px] max-lg:pt-[46px] md:max-lg:pb-[46px] max-md:pt-[88px]",

  /*
   * 1440 × 687, and `container-type: size` so `cqw` resolves against it.
   *
   * **Two terms, and the smaller of them wins — which is `object-fit: contain`
   * written in CSS.** The scene is the largest 1440:687 box that fits the screen
   * it is on, so the whole composition scales with the monitor in both
   * directions and every card scales with it: `cqw` is a fraction of the scene,
   * and the scene is now a fraction of the *screen* rather than of the page's
   * width alone.
   *
   * The **1600 cap is gone**. It was there because a scene left to fill the
   * width kept growing with the monitor — 1.78× the drawn size at 2560 — and
   * that is exactly what was asked for: the cards get bigger on a bigger screen.
   * Bounding the enlargement to 1.11× is what left a wide monitor with a strip
   * of picture and a field of black around it.
   *
   * The second term is what keeps a **short or portrait** window inside one
   * screen: width drives everything here and the aspect ratio turns it into
   * height, so the height available has to be converted back into a width —
   * `(100dvh − 80px) · 1440/687`, the 80 being the section's own 40 top and
   * bottom. Without the padding in the term the scene would be exactly one
   * screen tall with the two 40s hanging off the ends, and a window short enough
   * for the term to bite would still overflow by 80px.
   *
   * Contain, not cover: pushing the scene past the width instead would crop it,
   * and the two lists sit 24px from the frame's edges — 1.7% of the width — so
   * there is no crop worth having before ICELAND loses its I.
   *
   * Below the desktop base it drops the aspect ratio, stops being a query
   * container, and becomes an ordinary centred column.
   */
  /*
   * Heading to row: **88px** on tablet — one step up the hero's ladder from 46,
   * which is its `5.5rem` at the 1440 base (the lift that clears EXPLORE over
   * the bottom thumbnail). A phone keeps 34, the hero's own value there.
   * `px-page` is the hero's one horizontal inset.
   */
  scene:
    "relative w-[min(100%,calc((100dvh-80px)*1440/687))] aspect-[1440/687] overflow-hidden [container-type:size] max-lg:aspect-auto max-lg:w-full max-lg:overflow-visible max-lg:[container-type:normal] max-lg:flex max-lg:flex-col max-lg:items-center max-lg:gap-[88px] max-lg:px-page max-md:gap-[34px]",

  /*
   * 1600:34495 — left 438, top 100, w 564, 64/51.2 centred.
   *
   * Below the desktop base it is full width, not 564: the hero's display type
   * is centred on the whole column there too. Tablet is the hero's own scale
   * applied to this heading's 64 — the hero takes 90 → 56 → 42, i.e. ×0.622,
   * which gives 40/32. The phone was 30/24 by the same ×0.467 and has since
   * been opened up to 36, its leading following at the file's 0.8 ⇒ 28.8.
   */
  heading:
    "text-foreground-accent font-display text-trim absolute left-[30.4167cqw] top-[6.9444cqw] w-[39.1667cqw] text-center text-[4.4444cqw] leading-[3.5556cqw] max-lg:static max-lg:w-full max-lg:text-[48px] max-lg:leading-[38.4px] max-md:text-[36px] max-md:leading-[28.8px]",

  /*
   * The layer the sixteen cards and the three stickers are placed on: the scene
   * itself, edge to edge, so every `cqw` inside is a fraction of the frame's
   * 1440 rather than of some inner box.
   *
   * No `overflow` of its own: the **scene** is what clips, because the scene is
   * the frame. Switzerland, Greece and Austria are drawn hanging off the top of
   * it — their ink centres are at y 45, 48 and 106 against half-heights of 132,
   * 84 and 118 — and New Zealand hangs 44 off the right. In Figma that means
   * cropped at the frame's edge; on a page it meant spilling into the hero
   * above, over its landscape and its own UI, because the section only clipped
   * `x`. The cards are not pulled back inside — they are cut where the file
   * cuts them.
   *
   * Desktop only: sixteen cards want the width of the 1440 frame, and at 768
   * they would be ~100px each. Below the base a single card takes over —
   * `cardTablet` and `cardMobile`.
   */
  cards: "absolute inset-0 max-lg:hidden",

  /*
   * The row under the heading. `contents` on the desktop base, where every
   * child is absolutely positioned against the scene itself.
   *
   * On a tablet it becomes a real three-column row — list, stack, list — top
   * aligned, which is the desktop composition at a smaller size. On a phone
   * there is no room for three abreast, so it turns back into a column.
   */
  row: "contents max-lg:grid max-lg:w-full max-lg:grid-cols-[auto_minmax(0,1fr)_auto] max-lg:items-stretch max-lg:gap-[24px] max-md:flex max-md:grid-cols-none max-md:flex-col max-md:items-center max-md:gap-[24px]",

  /*
   * The tablet's card: the selected country's polaroid, alone in a 3/4 box.
   * Shown only between the phone and desktop bases.
   *
   * Sixteen cards is a desktop composition — at 768 each one is about 100px of
   * paper — so the narrow ranges keep the shape the block had before the
   * redraw: one card at a time, switched by tapping a name.
   *
   * **Sized by width, with a cap.** It used to take its height from the row and
   * derive its width from the aspect ratio, which made it exactly as tall as
   * the lists — 267 × 200 — and left **103px of empty column either side of it
   * at 768, and 225 at 1024**. Three cards inside that came out small.
   *
   * So it takes the width, and **all of it**: the box is the middle column of the
   * row, from one list to the other less the row's own 24 gap. That is the area
   * the design marks out for it — 424 × 318 at 768 and 668 × 501 at 1024 — and
   * three cards inside come out at the size they are drawn rather than at the
   * size a column of lists happens to be tall.
   *
   * A cap was tried at 340 and again at 400 and is gone: at 1024 it left the box
   * using barely two thirds of the room it had, centred in 134px of nothing
   * either side. The first revision of this block *was* unbounded and did swell
   * the section past a thousand pixels — but that was with the **height** driving,
   * 624 × 832. Width-driven at 4/3 the section reaches 571 and 754, which is a
   * block you scroll rather than one that runs away.
   *
   * `self-start` rather than `stretch`, which would otherwise pull the box to the
   * row's height and override the aspect ratio the width is supposed to drive.
   *
   * The **−44 top margin** does two things with one number, and both were asked
   * for: it lifts the stack that far up the row, and because a negative margin
   * comes out of the box's margin box, the row — and the section with it — gets
   * 44px shorter, so the lift does not simply reappear as space underneath.
   * One value for all sixteen states: the fan is one composition and the cards
   * differ only in how tall their own photographs are.
   */
  cardTablet:
    "relative mx-auto hidden aspect-[4/3] w-full max-lg:order-2 max-lg:block max-lg:self-start max-lg:-mt-[44px] max-md:hidden",

  /*
   * The phone's stack: a 4/5 box capped at **288**.
   *
   * It was 240, then 288, and three cards inside a box that size came out small — the
   * tallest of them are clamped by the box's vertical room before they ever
   * reach their slot width, so a portrait card like Spain was rendering at 42%
   * of the box rather than its slot's width. 320 is what the column actually has:
   * a 390 phone leaves 338 inside `px-page`, so the box still sits with air
   * either side, and at 375 the `100%` term simply lets it fill what is there.
   *
   * `object-contain` fits the whole file inside, so the transparent margin the
   * export carries becomes margin around the card rather than a crop of it —
   * which is why neither of these two boxes clips any more. On the scene that
   * margin is corrected away by `toSceneBox`; here there is nothing to correct
   * against, and letting the card sit a little smaller inside its box is the
   * right answer for a single card with room around it.
   */
  cardMobile:
    "relative mx-auto hidden aspect-[4/5] w-[min(100%,320px)] max-md:order-1 max-md:block max-md:aspect-[8/7]",

  /*
   * `contents` on desktop *and* tablet: both ranges want the two lists to be
   * direct children of the row, so they can sit either side of the stack. Only
   * a phone gathers them into a row of their own, under it.
   */
  listPair:
    "contents max-md:order-2 max-md:flex max-md:w-full max-md:justify-between",

  /* left 24, top 317, 147 × 202. */
  listLeft:
    "absolute left-[1.6667cqw] top-[22.0139cqw] w-[10.2083cqw] items-start max-lg:static max-lg:order-1 max-lg:w-auto max-lg:shrink-0",

  /* left 1269, top 317, 147 × 202, set to the right. */
  listRight:
    "absolute left-[88.125cqw] top-[22.0139cqw] w-[10.2083cqw] items-end text-right max-lg:static max-lg:order-3 max-lg:w-auto max-lg:shrink-0",

  /*
   * Eight rows on a **27px pitch**, which is what the frame's 202px column comes
   * to: 7 × 27 + one row. The gap is the pitch minus the row's own height, so it
   * had to be measured rather than assumed — the row renders 12.79 tall, not the
   * 11.63 the trimmed cap height suggests, and 14.21 is what is left. Written as
   * its `cqw`, 0.9868, because the pitch scales with the scene like everything
   * else here.
   */
  list: "flex flex-col gap-[0.9868cqw] max-lg:gap-[15.8px]",

  /*
   * Small UI type stops scaling below the desktop base, exactly as it does in
   * the hero: the 1024 grid base would render 16px as 12, and the 360 base
   * would swing it back up past the design. 14/11.2 is the size the hero pins
   * every small label to.
   */
  listType:
    "font-ui text-[1.1111cqw] leading-[0.8889cqw] max-lg:text-[14px] max-lg:leading-[11.2px]",

  /*
   * 25 wide for the number, 6 gap, 116 for the name.
   *
   * The padding-and-negative-margin pair below the desktop base is a tap
   * target, not spacing: 16.4 either side grows each row's box from its 11.2px
   * line to **44**, and the negative margin takes the growth straight back out
   * of layout, so the rows keep their positions to the pixel.
   *
   * > 44 and a 27px pitch cannot both be true without overlap. Each row's box
   * > reaches 8.5px into its neighbours', and the later sibling wins the tap, so
   * > the *effective* zone stays the 27px pitch for every row but the last,
   * > which gets its full 44. Raising the pitch is the only way to a real 44
   * > everywhere, and the pitch is the design's.
   */
  listRow:
    "flex items-start gap-[0.4167cqw] max-lg:gap-[6px] max-lg:py-[16.4px] max-lg:-my-[16.4px]",
  listNumber: "block w-[1.7361cqw] shrink-0 max-lg:w-[22px]",
  /*
   * `min-w`, not `w`: NEW ZEALAND and SOUTH AFRICA are wider than the 116
   * column in the file too, and the right-hand list is anchored to the page
   * margin, so they push their own row leftward instead of overrunning the
   * numbers.
   */
  listName: "block min-w-[8.0556cqw] whitespace-nowrap max-lg:min-w-[102px]",
} as const;

/*
 * `cqw` itself is deliberately not exported. Checking a class by hand needs no
 * function — every `cqw` value in this file is its Figma pixel ÷ 1440 × 100, so
 * 888 reads back as 61.6667 and 276 as 19.1667.
 */
