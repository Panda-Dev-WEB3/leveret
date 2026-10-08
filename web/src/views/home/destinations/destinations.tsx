"use client";

/**
 * Destinations — a numbered index of countries, and sixteen polaroids laid out
 * across the frame.
 *
 * The whole block is one container-query scene: a box of `aspect-ratio 1440/687`
 * carrying `container-type: size`, with every child absolutely positioned in
 * `cqw` — Figma pixels ÷ 1440 × 100. The composition therefore scales 1:1 with
 * the file at any width, including above 1440 where a rem layout stops growing.
 *
 * **Every country has one card, and all sixteen are on the scene at once.** The
 * frame this replaces worked the other way: twenty-four countries, eight cards
 * belonging to whichever one was hovered, and a cross-fade swapping the whole
 * set. Nothing swaps now: pointing at a name turns that one card towards the
 * reader and takes the other fifteen down to 42%, pointing at a card lights its
 * name, and leaving the composition puts all sixteen back up. One piece of
 * state — the active id — drives both directions, which is what makes the link
 * two-way without a second mechanism.
 *
 * Leaving the block does nothing to the *selection*: the last country pointed at
 * stays lit in the list, and ICELAND is active on arrival. What leaving does put
 * back is the **composition** — the tilt, the dimming and the paint order all
 * hang off `engaged`, whether the pointer is in the scene at all, so a block
 * nobody is pointing at is the sixteen cards exactly as the file draws them
 * rather than one of them stuck mid-hover.
 *
 * **The pile assembles as you scroll to it, then spreads.** Two 0→1 values, one
 * after the other: across the section's approach the sixteen cards fly in from
 * the edges in sixteen overlapping slices, and across the screen of scrolling
 * that follows they drift apart, each by its own depth in the stack. Nothing
 * about the composition is animated — the destinations are the coordinates the
 * file gives; both movements are offsets from them.
 *
 * 📖 Docs: obsidian/frontend/destinations.md
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { animated, SpringValue, useTransition } from "@react-spring/web";

import { RevealTitle } from "@/components/ui/reveal-text";
import { useProgressTrigger } from "@/hooks/animation/use-progress-trigger";
import { subscribeToTicker } from "@/lib/animation/ticker";

import { DestinationList } from "./destination-list";
import {
  DestinationStack,
  SceneCard,
  SceneSticker,
  STACK_FIT,
  STACK_RATIO,
} from "./destination-card";
import {
  clamp01,
  CLASS,
  ENTRANCE_END,
  ENTRANCE_START,
  PARALLAX_END,
  PARALLAX_START,
  SWAP_CONFIG,
  SWAP_TRAVEL,
} from "./destinations.geometry";
import type { CardAsset, Destination, DestinationsContent } from "./destinations.types";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** A device with no hover to give: the list switches on tap only. */
const NO_HOVER_QUERY = "(hover: none)";

/** SSR-safe read of a media query. */
const useMedia = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );

/** The file splits the index in half: 01–08 on the left, 09–16 on the right. */
const COLUMN_LENGTH = 8;

export interface DestinationsProps {
  content: DestinationsContent;
}

export const Destinations = ({ content }: DestinationsProps) => {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const prefersReducedMotion = useMedia(REDUCED_MOTION_QUERY);
  const noHover = useMedia(NO_HOVER_QUERY);

  /*
   * The entrance, as one number.
   *
   * The section is a full screen tall, so the window below — its top edge
   * reaching the bottom of the viewport, to the section sitting centred in
   * it — is one screen of scrolling. The sixteen cards each read a slice of
   * this and fly in from the edge nearest them; see `ENTRANCE` in the geometry.
   */
  const { progress: rawProgress } = useProgressTrigger({
    elementRef: sectionRef,
    start: ENTRANCE_START,
    end: ENTRANCE_END,
    enabled: !prefersReducedMotion,
    frameInterval: 0,
  });

  /*
   * The second window, and the one the entrance hands over to: from the section
   * sitting centred to the section gone. The pile spreads across it — every
   * card up and outwards by its own depth — so the block keeps moving under the
   * reader for the whole screen of scrolling that follows the assembly instead
   * of freezing the moment it is built.
   */
  const { progress: rawDrift } = useProgressTrigger({
    elementRef: sectionRef,
    start: PARALLAX_START,
    end: PARALLAX_END,
    enabled: !prefersReducedMotion,
    frameInterval: 0,
  });

  /*
   * Both written unconditionally every frame from the raw scroll values, the
   * way block 4 does and for the reason it documents: a guarded spring can be
   * told a new target while frames are suppressed, record it, and never animate
   * to it — leaving the pile half-assembled with no way back. Setting the true
   * value every frame cannot strand, because one frame heals it.
   */
  const live = useMemo(() => new SpringValue(0), []);
  const sliding = useMemo(() => new SpringValue(0), []);
  useEffect(
    () =>
      subscribeToTicker(
        () => {
          live.set(clamp01(rawProgress.current));
          sliding.set(clamp01(rawDrift.current));
        },
        () => 0,
      ),
    [live, sliding, rawProgress, rawDrift],
  );

  /*
   * With reduced motion there is nothing to scrub and nothing to fly: the pile
   * is simply laid out, which is the state the whole animation exists to
   * arrive at, and it does not drift.
   */
  const settled = useMemo(() => new SpringValue(1), []);
  const still = useMemo(() => new SpringValue(0), []);
  const entrance = prefersReducedMotion ? settled : live;
  const drift = prefersReducedMotion ? still : sliding;

  /**
   * ICELAND is active on arrival, per the brief — and the one it displaced is
   * kept beside it.
   *
   * `previous` exists for one frame's worth of paint order: the card the
   * pointer just left lowers at `LOWERING_Z`, in front of the pile, rather than
   * snapping back underneath four of its neighbours the instant the next card
   * takes over. Two ids in one piece of state, because they change together and
   * a second `useState` could be one render behind.
   */
  const [selection, setSelection] = useState({
    id: content.countries[0]?.id ?? "",
    previous: "",
  });
  const { id: activeId, previous: previousId } = selection;

  /**
   * Whether the pointer is in the block at all.
   *
   * The dimming hangs off this rather than off `activeId`, which is never
   * empty: a country is active on arrival and stays active after the pointer
   * leaves, so dimming on the active id alone would leave fifteen cards at 42%
   * before the reader had touched anything — and again for as long as the page
   * was left open on the block.
   */
  const [engaged, setEngaged] = useState(false);

  const select = (id: string) => {
    setEngaged(true);
    setSelection((current) =>
      current.id === id ? current : { id, previous: current.id },
    );
  };

  /**
   * Leaving the composition: the fifteen come back up, and the card that was
   * lowering goes back to its own place in the paint order.
   *
   * `previous` has to be given back, or the last card the pointer touched would
   * sit at `LOWERING_Z` — on top of the pile — for as long as the page was left
   * open, which is a permanent change to a layering the frame draws. Inside the
   * block it gives itself back: A → B → C returns A the moment C is picked, and
   * that swap is masked by everything else moving at the time. Only the last one
   * has nothing to mask it, and this is that case — where sixteen cards are
   * fading back to full strength anyway.
   */
  const release = () => {
    setEngaged(false);
    setSelection((current) =>
      current.previous ? { ...current, previous: "" } : current,
    );
  };

  const activeIndex = Math.max(
    0,
    content.countries.findIndex((country) => country.id === activeId),
  );
  const active: Destination | undefined = content.countries[activeIndex];

  /*
   * The stack, back to front: the two countries *after* the selected one in the
   * 1–16 order, then the selected one on top. The list wraps, so ISTANBUL (16)
   * is backed by ICELAND (01) and NORWAY (02).
   *
   * The deeper of the two is the further one — +2 sits behind +1 — so the depth
   * of the stack reads as distance down the index rather than as an arbitrary
   * pair.
   */
  const stack: CardAsset[] = useMemo(() => {
    const count = content.countries.length;
    if (count === 0) return [];
    return [2, 1, 0]
      .map((offset) => content.countries[(activeIndex + offset) % count])
      .filter((country): country is Destination => Boolean(country))
      .map((country) => country.card);
  }, [content.countries, activeIndex]);

  /*
   * Only the narrow ranges cross-fade, because only they show one card at a
   * time. `initial` matches `enter`, so the first card is simply *there* on
   * first paint — without it the block would play an entrance it was never
   * designed to have.
   */
  const transitions = useTransition(active, {
    keys: (country: Destination | undefined) => country?.id ?? "",
    initial: { opacity: 1, y: 0 },
    from: { opacity: 0, y: SWAP_TRAVEL },
    enter: { opacity: 1, y: 0 },
    leave: { opacity: 0, y: -SWAP_TRAVEL },
    config: SWAP_CONFIG,
  });

  return (
    <section
      className={CLASS.section}
      aria-labelledby={headingId}
      ref={sectionRef}
    >
      {/*
        Leaving the *scene* — not the section — is what puts the fifteen back up
        to full strength. The section is a whole screen and mostly empty; the
        scene is the composition, and its edges are where the picture stops.
        Which country is active is untouched by this: the brief asks for the
        last one pointed at to stay, and it does.
      */}
      <div className={CLASS.scene} onMouseLeave={release}>
        <h2 id={headingId} className={CLASS.heading} aria-label="More ways, to trade.">
          {content.heading.map((line, index) => (
            <span key={index} className="block">
              <RevealTitle segments={line} animate={!prefersReducedMotion} />
            </span>
          ))}
        </h2>

        {/*
          The desktop scene: sixteen cards at their own coordinates, then the
          three marks above them. Both are placed in `cqw` of the frame, so the
          layer is simply the scene itself.
        */}
        <div className={CLASS.cards}>
          {content.countries.map((country) => (
            <SceneCard
              key={country.id}
              asset={country.card}
              interactive={!prefersReducedMotion}
              raised={engaged && country.id === activeId}
              onEnter={() => select(country.id)}
              entrance={entrance}
              drift={drift}
              count={content.countries.length}
              dimmed={engaged && country.id !== activeId}
              lowering={country.id === previousId}
            />
          ))}

          {content.stickers.map((sticker) => (
            <SceneSticker
              key={sticker.src}
              asset={sticker}
              entrance={entrance}
              drift={drift}
              dimmed={engaged}
            />
          ))}
        </div>

        {/*
          `contents` on desktop, where each child is absolutely positioned in the
          scene. On a tablet this is a real three-column row — list, card, list —
          and on a phone a column.
        */}
        <div className={CLASS.row}>
          {/*
            Below the desktop base the scene is not a scene: sixteen cards at
            768 would be ~100px of paper each. Both narrow ranges show the
            selected country's card alone, switched by tapping a name — the
            logic the block had before the redraw.
          */}
          <div className={CLASS.cardTablet}>
            {transitions((style, country) =>
              country ? (
                <animated.div
                  className="absolute inset-0"
                  style={{
                    opacity: style.opacity,
                    transform: style.y.to(
                      (value) => `translate3d(0, ${value}px, 0)`,
                    ),
                    pointerEvents: country.id === activeId ? "auto" : "none",
                  }}
                >
                  <DestinationStack
                    assets={stack}
                    fit={STACK_FIT.tablet}
                    containerRatio={STACK_RATIO.tablet}
                  />
                </animated.div>
              ) : null,
            )}
          </div>

          <div className={CLASS.cardMobile}>
            {transitions((style, country) =>
              country ? (
                <animated.div
                  className="absolute inset-0"
                  style={{
                    opacity: style.opacity,
                    transform: style.y.to(
                      (value) => `translate3d(0, ${value}px, 0)`,
                    ),
                    pointerEvents: country.id === activeId ? "auto" : "none",
                  }}
                >
                  <DestinationStack
                    assets={stack}
                    fit={STACK_FIT.mobile}
                    containerRatio={STACK_RATIO.mobile}
                  />
                </animated.div>
              ) : null,
            )}
          </div>

          {/*
            `display: contents` on desktop and tablet, so both lists are direct
            children of the row — absolutely positioned against the scene on one
            and flanking the card on the other. Only a phone gathers them into
            a row of their own.
          */}
          <div className={CLASS.listPair}>
            <DestinationList
              countries={content.countries.slice(0, COLUMN_LENGTH)}
              startIndex={0}
              align="left"
              activeId={activeId}
              onActivate={select}
              hoverActivates={!noHover}
            />
            <DestinationList
              countries={content.countries.slice(COLUMN_LENGTH)}
              startIndex={COLUMN_LENGTH}
              align="right"
              activeId={activeId}
              onActivate={select}
              hoverActivates={!noHover}
            />
          </div>
        </div>
      </div>
    </section>
  );
};
