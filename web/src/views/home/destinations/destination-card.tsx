"use client";

/**
 * One polaroid on the scene, and the single card the narrow ranges show.
 *
 * Every file is a **finished** card: paper, caption, grain and rotation are in
 * the pixels. So this component only ever places a box and points an `<img>` at
 * it — there is no background, no radius, no padding, no caption and no blend
 * mode anywhere in here, and there must not be. What it *does* correct for is
 * the transparent margin the exports carry, which is what `toSceneBox` is for.
 *
 * 📖 Docs: obsidian/frontend/destinations.md
 */

import { useMemo } from "react";
import Image from "next/image";
import { animated, to, useSpring } from "@react-spring/web";
import type { SpringValue } from "@react-spring/web";

import {
  CARD_DIM,
  CARD_TILT,
  LOWERING_Z,
  RAISED_Z,
  STACK,
  STACK_FIT,
  TOUCH_PRESS,
  TOUCH_TARGET,
  toCardDrift,
  toCardTilt,
  toCardTransform,
  toEntranceOpacity,
  toEntrancePhase,
  toEntranceTravel,
  toFrameBox,
  toSceneBox,
  toShade,
  toStackBox,
  toStickerOpacity,
  toStickerTransform,
} from "./destinations.geometry";
import type { CardAsset, StickerAsset } from "./destinations.types";

/**
 * The scene is as wide as the screen lets it be, and the widest card lays out at
 * about 16% of it. The files are ~3× exports, so there is real resolution behind
 * that even on a 2560 monitor, where 16vw is 410px of paper.
 */
const CARD_SIZES = "(max-width: 1024px) 60vw, 16vw";

/** The single card below the desktop base gets most of its own box. */
const SINGLE_SIZES = "(max-width: 640px) 240px, 40vw";

export interface SceneCardProps {
  asset: CardAsset;
  /** Off under reduced motion, so the lift does not become an instant jump. */
  interactive: boolean;
  /** This card is the one being pointed at, from either the list or the scene. */
  raised: boolean;
  onEnter: () => void;
  /**
   * The block's own 0→1 across its approach. Every card is handed the same
   * value and reads its own slice out of it — one spring for the section rather
   * than sixteen, and a stagger that cannot fall out of step with itself.
   */
  entrance: SpringValue<number>;
  /** The second 0→1, for the screen of scrolling *after* the pile is built. */
  drift: SpringValue<number>;
  /** How many cards share the stagger, so the last one lands exactly at 1. */
  count: number;
  /** Something else in the block is raised, and this card is not it. */
  dimmed: boolean;
  /** This is the card the pointer just left; it lowers in front of the pile. */
  lowering: boolean;
}

/**
 * The box and the transform are two elements on purpose.
 *
 * The outer div owns the placement, the paint order and the dimming; the inner
 * one carries the lift. `left`/`top` name the card's **centre**, so the box is
 * pulled back by half itself — Tailwind writes that with the `translate`
 * property, which is separate from `transform`, so the lift on the inner
 * element cannot collide with it.
 *
 * **The lift is driven by `raised`, not by this card's own pointer.** It used to
 * come from `<Hover>` watching the box's ref, which is right when a card is the
 * only thing that can raise itself — and wrong here, because a name in either
 * list raises it too. Measured: pointing at CANADA raised the card's z but left
 * `scale(1)`, because the pointer was never over the paper. One piece of state
 * now feeds both, so either end of the link produces the same movement.
 *
 * **A card that is not raised falls back to 42%, and only while the pointer is
 * in the composition.** For two passes it was not touched at all, on the
 * reasoning that a scene of sixteen photographs should read as a table somebody
 * laid out rather than as a control with a selection. That held while the lift
 * was a flat 6px; it stopped holding when the card started turning towards the
 * reader, because a card in front of the pile needs the pile to be behind it.
 * `dimmed` is `engaged && !raised` — never `!raised` alone, or the fifteen would
 * sit at 42% on arrival and stay there after the pointer left.
 *
 * The numbers are not this component's to invent: `toCardTilt` gives this card
 * its own pair of transform strings from its paint order, and `CARD_HOVER` — the
 * flat lift block 3's collage and block 5's button share — is left alone.
 *
 * **Three elements, two clocks.** The outer div places the card, owns the paint
 * order and carries the dimming. The middle one carries everything the page's
 * scroll does — the entrance *and* the drift, added, because they are the same
 * clock and never overlap. The inner one carries the hover, which is a spring
 * watching one piece of state. Each writes `transform` on an element nobody
 * else writes to, so the movements compose in the browser's transform stack
 * instead of overwriting each other's frames — which is exactly what one merged
 * string would do.
 */
export const SceneCard = ({
  asset,
  interactive,
  raised,
  onEnter,
  entrance,
  drift,
  count,
  dimmed,
  lowering,
}: SceneCardProps) => {
  /* This card's own tilt, flight and drift — all derived, none stored. */
  const tilt = useMemo(() => toCardTilt(asset.z), [asset.z]);
  const travel = useMemo(() => toEntranceTravel(asset), [asset]);
  const phase = useMemo(
    () => toEntrancePhase(asset.z - 1, count),
    [asset.z, count],
  );
  const parallax = useMemo(() => toCardDrift(asset, count), [asset, count]);

  /*
   * The tilt. `RAISED_Z` is applied without a spring: paint order is not a
   * thing you can be halfway through, and animating it would only decide the
   * winner late. `LOWERING_Z` is what softens the swap instead.
   */
  const spring = useSpring({
    transform: raised ? tilt.to : tilt.from,
    config: CARD_TILT.config,
    immediate: !interactive,
  });

  /*
   * The dimming, on the outer element so it multiplies with the entrance's own
   * fade on the wrapper below rather than fighting it for the same property.
   */
  const dim = useSpring({
    shade: dimmed ? CARD_DIM.rest : 1,
    config: CARD_DIM.config,
    immediate: !interactive,
  });

  return (
    <animated.div
      className={`group absolute -translate-x-1/2 -translate-y-1/2 ${TOUCH_TARGET}`}
      style={{
        ...toSceneBox(asset),
        zIndex: raised ? RAISED_Z : lowering ? LOWERING_Z : asset.z,
        filter: dim.shade.to(toShade),
      }}
      onMouseEnter={onEnter}
    >
      <animated.div
        className="relative h-full w-full"
        style={{
          transform: to([entrance, drift], (flight, slide) =>
            toCardTransform(travel, phase, parallax, flight, slide),
          ),
          opacity: entrance.to((value) => toEntranceOpacity(phase, value)),
        }}
      >
        <animated.div
          className={`template-art-card relative h-full w-full ${TOUCH_PRESS}`}
          style={{ transform: spring.transform }}
        >
          <Image
            src={asset.src}
            alt={asset.alt}
            fill
            sizes={CARD_SIZES}
            className="object-contain"
          />
        </animated.div>
      </animated.div>
    </animated.div>
  );
};

/**
 * A sticker: centre-placed like a card, but by its file box. No pointer.
 *
 * It only fades in, and only once the pile is nearly built — the three marks are
 * laid *on* the finished picture, and one flying in from an edge would read as
 * a seventeenth card rather than as a mark on the pile. It drifts with the
 * middle of the pile afterwards, for the same reason: a mark that stayed pinned
 * while the sixteen cards under it spread would come off the collage.
 *
 * `transform` and the `-translate-*` classes are different properties in
 * Tailwind v4, so the drift composes with the centring instead of replacing it.
 */
export const SceneSticker = ({
  asset,
  entrance,
  drift,
  dimmed,
}: {
  asset: StickerAsset;
  entrance: SpringValue<number>;
  drift: SpringValue<number>;
  dimmed: boolean;
}) => {
  const dim = useSpring({
    shade: dimmed ? CARD_DIM.stickers : 1,
    config: CARD_DIM.config,
  });

  return (
    <animated.div
      aria-hidden
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
      style={{
        ...toFrameBox(asset),
        zIndex: asset.z,
        transform: drift.to(toStickerTransform),
        filter: dim.shade.to(toShade),
        opacity: entrance.to(toStickerOpacity),
      }}
    >
      <Image
        src={asset.src}
        alt=""
        fill
        sizes={CARD_SIZES}
        className="object-contain"
      />
    </animated.div>
  );
};

/**
 * The three-card stack the tablet and the phone show.
 *
 * `assets` arrives back-to-front — deepest first — and is paired off with
 * `STACK` in that order, so the array's shape *is* the depth. The front card is
 * the selected country; the two behind it are its next two neighbours in the
 * 1–16 order, wrapped, and they are decoration: they carry no pointer and no
 * caption of their own beyond what is in their pixels.
 *
 * `containerRatio` has to be passed in because the two boxes are different
 * shapes — 4/3 on a tablet, 4/5 on a phone — and a slot's vertical offset is
 * measured down a box whose height the width does not tell you.
 */
export const DestinationStack = ({
  assets,
  fit,
  containerRatio,
}: {
  assets: CardAsset[];
  fit: number;
  containerRatio: number;
}) => (
  <>
    {assets.map((asset, index) => {
      const slot = STACK[index];
      if (!slot) return null;
      const box = toStackBox(slot, asset, fit, containerRatio);
      const isFront = index === STACK.length - 1;

      return (
        <div
          key={asset.src}
          className={`group absolute -translate-x-1/2 -translate-y-1/2 ${
            isFront ? TOUCH_TARGET : "pointer-events-none"
          }`}
          style={box}
          aria-hidden={!isFront}
        >
          <div className={`relative h-full w-full ${isFront ? TOUCH_PRESS : ""}`}>
            <Image
              src={asset.src}
              alt={isFront ? asset.alt : ""}
              fill
              sizes={SINGLE_SIZES}
              className="object-contain"
            />
          </div>
        </div>
      );
    })}
  </>
);

/** The tablet's box is 4/3, the phone's 4/5. */
export const STACK_RATIO = { tablet: 4 / 3, mobile: 8 / 7 } as const;

/** Re-exported so the section can read the fit factors without a second import. */
export { STACK_FIT };
