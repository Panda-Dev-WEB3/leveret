"use client";

/**
 * The interface, laid over the footage.
 *
 * Everything here is driven by the section's single assembly value: each group
 * fades and slides in on its own slice of it, staggered in the order
 * `UI_ORDER` gives. Nothing switches state — every group is a continuous
 * interpolation of the same number.
 *
 * **The window comes first and alone**, and every other group waits for it: the
 * text is placed relative to the window, so it waits for the window to be there
 * to be placed relative to. See `UI_ORDER`.
 *
 * Paint order, bottom to top: card window → its captions → display headings →
 * chrome (wordmark, nav, explore, destinations, switcher). The headings sit
 * ABOVE the card on purpose: `#ffedc3` is brand identity and must never be
 * washed out by the window's brightness/saturation filter.
 *
 * The card and its captions are the only elements whose `transform` is written
 * imperatively, by `usePointerFollow` — see that file for why the card must
 * carry exactly one transform and no wrapper.
 *
 * 📖 Docs: obsidian/frontend/hero.md
 */

import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  animated,
  easings,
  to,
  useSpring,
  type AnimatedProps,
  type Interpolation,
  type SpringValue,
} from "@react-spring/web";

import { useChrome } from "@/components/common/site-chrome";
import { subscribeToTicker } from "@/lib/animation/ticker";

import type { HeroTuning } from "./hero.tuning";
import { Hover } from "@/components/animation/springs/hover";
import { ArrowIcon, DotIcon } from "./hero-icons";
import { RevealTitle } from "@/components/ui/reveal-text";
import {
  CLASS,
  groupEase,
  REC,
  REVEAL_TRAVEL,
  type UiGroup,
  uiStart,
} from "./hero.geometry";
import { SegmentedText } from "@/components/ui/segmented-text";
import type { HeroContent } from "./hero.types";

/**
 * A style object whose values may be react-spring interpolations rather than
 * plain CSS values — the card animates `backdrop-filter` this way.
 */
type AnimatableStyle = AnimatedProps<{ style: CSSProperties }>["style"];

/** Animated elements the reveal wrapper is allowed to render. */
const REVEAL_TAGS = {
  div: animated.div,
  nav: animated.nav,
  p: animated.p,
  span: animated.span,
} as const;

interface RevealProps {
  progress: SpringValue<number>;
  group: UiGroup;
  /** Entry offset in rem — the element travels from here to 0. */
  from?: { x?: number; y?: number };
  as?: keyof typeof REVEAL_TAGS;
  className?: string;
  style?: AnimatableStyle;
  /**
   * Marks a group that contains controls. Pointer events stay off until the
   * group has all but arrived, so a link cannot be hovered or clicked while it
   * is still transparent.
   */
  interactive?: boolean;
  /**
   * A second 0→1 multiplied into this group's opacity, for a group that can be
   * asked to stand down after the flight is over — the fixed chrome, when the
   * footer arrives. Absent for every group that only ever plays the timeline.
   */
  gate?: SpringValue<number> | Interpolation<number, number>;
  children?: ReactNode;
}

/** Fades and translates one UI group in on its slice of the timeline. */
const Reveal = ({
  progress,
  group,
  from = { y: REVEAL_TRAVEL },
  as = "div",
  className,
  style,
  interactive = false,
  gate,
  children,
}: RevealProps) => {
  const travel = progress.to((p) => groupEase(p, group));

  /*
   * The gate multiplies the group's *visibility* and nothing else. Folding it
   * into `travel` as well would send the element back up its entry offset on
   * the way out, which is a different animation from standing down — the fixed
   * chrome fades where it is and comes back where it was.
   */
  const shown = gate ? to([travel, gate], (v, open) => v * open) : travel;
  const Tag = REVEAL_TAGS[as];

  return (
    <Tag
      className={className}
      style={{
        ...style,
        opacity: shown,
        transform: travel.to(
          (v) =>
            `translate3d(${(1 - v) * (from.x ?? 0)}rem, ${(1 - v) * (from.y ?? 0)}rem, 0)`,
        ),
        ...(interactive
          ? { pointerEvents: shown.to((v) => (v > 0.9 ? "auto" : "none")) }
          : null),
      }}
    >
      {children}
    </Tag>
  );
};

/**
 * One focus treatment for every control in the section. Cream on a photograph
 * needs the offset to stay legible against whatever is behind it.
 */
const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground-accent";

/** Token-backed timing for the discrete hover states (ADR-0014). */
const hoverTiming = "duration-[var(--duration-fast)] ease-entrance";

const smallType = "max-lg:text-[14px] max-lg:leading-[11.2px]";

const captionClass = `font-ui text-caption leading-caption text-foreground-accent text-trim ${smallType}`;
const bodyClass = `font-ui text-body leading-body text-foreground-accent text-trim ${smallType}`;

export interface HeroOverlayProps {
  content: HeroContent;
  /** 0–1 assembly progress for the section's interface. */
  progress: SpringValue<number>;
  tuning: HeroTuning;
  /** False under reduced motion: nothing loops, everything is simply placed. */
  animate: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  captionTopRef: RefObject<HTMLParagraphElement | null>;
  captionBottomRef: RefObject<HTMLParagraphElement | null>;
}

export const HeroOverlay = ({
  content,
  progress,
  tuning,
  animate,
  cardRef,
  captionTopRef,
  captionBottomRef,
}: HeroOverlayProps) => {
  /**
   * The fixed chrome stands down over the footer, which prints the same
   * wordmark and the same four links as its own content.
   *
   * A spring rather than a class swap: this is a real fade over a real distance
   * in time, and it can be interrupted halfway by scrolling back up — which is
   * exactly the case ADR-0014 reserves springs for. Slightly slower out than the
   * flight's own reveals, because nothing is asking for it and a header that
   * snaps away draws more attention leaving than it did staying.
   */
  /**
   * The beat the display letters land on, as a **cue** rather than a delay.
   *
   * It used to be `uiStart("titles") × FLIGHT_MS` handed to `RevealTitle` as a
   * `startDelay`, which was only ever correct while the timeline began at mount.
   * It no longer does — it begins when a four-second video ends, and how long
   * that takes depends on the preloader, the network and whether autoplay was
   * allowed at all. So the assembly says *when* and the letters play from there.
   *
   * A latch, not a threshold read every frame: the phrase is not un-written by
   * anything, and it rides the ticker the section is already running.
   */
  const [titlesCued, setTitlesCued] = useState(false);
  const cuedRef = useRef(false);

  useEffect(
    () =>
      subscribeToTicker(() => {
        if (cuedRef.current || progress.get() < uiStart("titles")) return;
        cuedRef.current = true;
        setTitlesCued(true);
      }, () => 0),
    [progress],
  );

  const footerInView = useChrome((state) => state.footerInView);
  const { chromeGate } = useSpring({
    chromeGate: footerInView ? 0 : 1,
    config: { tension: 170, friction: 30 },
  });

  /**
   * The card is a hole in the veil, not a second copy of the footage: the veil
   * multiplies the backdrop by (1 − 0.5·s), so brightening by the reciprocal
   * restores the original pixels exactly. Because `backdrop-filter` resamples
   * whatever is painted behind the element at its *current* position, the view
   * through the window stays registered with the frame for free — at any
   * viewport, and while the card is moving and scaling.
   *
   * It is a plain string rather than an interpolation now. The veil used to ramp
   * across this same value and the correction had to ramp with it; the veil
   * belongs to the video's beat and is long since full by the time the window
   * opens, so the number it has to undo is a constant.
   */
  /**
   * The tally lamp's blink.
   *
   * `loop: { reverse: true }` turns at each end rather than jumping back to the
   * start, so the lamp rises and falls instead of snapping — and it never goes
   * fully out (see `REC.dim`): a dot that vanishes is a dot that has been
   * removed, one that drops to 0.18 is the same lamp, dark for a beat.
   *
   * A spring rather than a CSS animation, per ADR-0002 — and paused under
   * reduced motion, where a blinking indicator is exactly the kind of repeating
   * movement the preference is asking not to see.
   */
  const [{ blink }] = useSpring(
    () => ({
      from: { blink: 1 },
      to: { blink: REC.dim },
      loop: { reverse: true },
      config: { duration: REC.pulseMs, easing: easings.easeInOutSine },
      pause: !animate,
    }),
    [animate],
  );

  const undoScrim = 1 / (1 - 0.5 * tuning.scrimOpacity);
  const cardFilter = `brightness(${undoScrim * tuning.brightness}) saturate(${tuning.saturation})`;

  const cardOpacity = progress.to((p) => groupEase(p, "card"));
  /**
   * The captions are their own group now.
   *
   * They used to ride the card's, which was right while the card was fifth in
   * the order and the whole interface arrived together. It is first now and
   * arrives alone, and a caption is text *about* the window — it cannot arrive
   * before there is a window for it to be about.
   */
  const captionOpacity = progress.to((p) => groupEase(p, "captions"));

  /** The whole link drives the arrow, so `<Hover>` watches it rather than the
   *  icon it animates. */
  const exploreRef = useRef<HTMLAnchorElement>(null);

  /** Below the desktop base the four nav items collapse behind a MENU
   *  disclosure, exactly as the reference does at its own 991px line. */
  const [menuOpen, setMenuOpen] = useState(false);

  /** Which view the switcher is on. Seeded from the content's own default. */
  const [viewMode, setViewMode] = useState(
    () => content.viewModes.find((mode) => mode.active)?.label ?? "",
  );

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* ── The window itself. Transform is owned by usePointerFollow. ── */}
      <animated.div
        ref={cardRef}
        className={CLASS.card}
        style={{
          opacity: cardOpacity,
          backdropFilter: cardFilter,
          WebkitBackdropFilter: cardFilter,
        }}
      >
        {/* The viewfinder's own mark. See CLASS.crosshair. */}
        <span className={CLASS.crosshair} aria-hidden>
          <span className={CLASS.crosshairBar} />
          <span className={CLASS.crosshairBarVertical} />
        </span>

        {/*
          The tally lamp. Two values multiplied: the group's arrival, so it turns
          on only once the window has finished opening, and its own blink.

          `aria-hidden`, because it says something about the *picture* rather than
          about the page — a screen reader has no viewfinder to be told is
          recording, and announcing a blinking dot would be noise.
        */}
        <animated.span
          className={CLASS.rec}
          aria-hidden
          style={{ opacity: to([captionOpacity, blink], (v, b) => v * b) }}
        />
      </animated.div>

      {/* Captions travel with the card on a slower lerp, so they trail it. */}
      <animated.p
        ref={captionTopRef}
        className={`${captionClass} ${CLASS.cardCaptionTop} flex items-center justify-between`}
        style={{ opacity: captionOpacity }}
      >
        {content.cardCaptionTop.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </animated.p>

      <animated.p
        ref={captionBottomRef}
        className={`${captionClass} ${CLASS.cardCaptionBottom} flex items-center justify-between`}
        style={{ opacity: captionOpacity }}
      >
        {content.cardCaptionBottom.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </animated.p>

      {/*
        One heading for the whole phrase. The element itself has no box — it
        only hosts the two display blocks, which slide in from opposite edges
        towards each other. Above the card: the cream must stay unfiltered.
      */}
      <h1 className="absolute inset-0">
        {/*
          **The two lines no longer slide in from opposite edges — their letters
          do, and the two sweeps are mirrors of each other.**

          Left line right-to-left, right line left-to-right: each runs outward
          from the middle of the screen towards its own edge, so the phrase opens
          from its centre. The old block travel is gone (`from` is zero) because
          two movements on one element is one too many — the letters are the
          arrival now, and the group's own reveal is left doing nothing but
          holding them until the flight reaches them.

          `open` is that beat — see `titlesCued` above. In view is not a usable
          cue here: the hero is on screen from the first frame, so the letters
          would arrive several seconds before the picture they sit on.
        */}
        <Reveal
          progress={progress}
          group="titles"
          as="span"
          from={{}}
          className={`text-foreground-accent font-display text-trim block ${CLASS.titleType} ${CLASS.titleStart}`}
        >
          <RevealTitle
            segments={content.titleStart}
            direction="rtl"
            open={titlesCued}
          />
        </Reveal>

        <Reveal
          progress={progress}
          group="titles"
          as="span"
          from={{}}
          className={`text-foreground-accent font-display text-trim block ${CLASS.titleType} ${CLASS.titleEnd}`}
        >
          {/*
            Figma breaks this heading over two lines at 1440, and the markup
            keeps that. Below the desktop base it reads as one line instead, so
            the line boxes go inline and a space — itself only shown there —
            joins them.
          */}
          {content.titleEnd.map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? (
                <span className="hidden max-lg:inline"> </span>
              ) : null}
              <span className="block max-lg:inline">
                <RevealTitle
                  segments={line}
                  direction="ltr"
                  open={titlesCued}
                />
              </span>
            </Fragment>
          ))}
        </Reveal>
      </h1>

      {/* ── Chrome, above everything ── */}

      <Reveal
        progress={progress}
        group="wordmark"
        as="p"
        gate={chromeGate}
        className={`text-foreground-accent font-display text-trim ${CLASS.wordmarkType} ${CLASS.wordmark}`}
      >
        <SegmentedText segments={content.wordmark} />
      </Reveal>

      <Reveal
        progress={progress}
        group="nav"
        as="nav"
        interactive
        gate={chromeGate}
        className={CLASS.nav}
      >
        {/*
          The type classes belong on the `li`, not the `a`: the `li` is what
          forms the line box, so leaving it with the inherited 16px/24px strut
          made every item 24px tall instead of 11.2 and inflated the whole block
          to 126px against Figma's 74.8.
        */}
        {/*
          Open, the control becomes "Close" and drops to the muted cream the
          design already uses for anything inactive (LIST, the country names) —
          a tint from the palette rather than an arbitrary opacity, so it reads
          as "not the thing you want next" while staying legible on the photo.
        */}
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className={`${bodyClass} hidden cursor-pointer uppercase max-lg:ml-auto max-lg:block ${hoverTiming} transition-colors ${focusRing} ${
            menuOpen ? "text-foreground-accent-muted" : ""
          }`}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>

        {/*
          The open list is spaced in px, not rem. The items are a fixed 14px,
          but the root font-size climbs from 12 on a tablet to 17.3 on a phone
          — so a rem gap opened the phone menu half again as wide as the tablet
          one and pulled it apart. 21 / 10.8 are the tablet's rendered values.
        */}
        <ul
          className={`flex flex-col gap-sm max-lg:mt-[21px] max-lg:items-end max-lg:gap-[10.8px] ${menuOpen ? "" : "max-lg:hidden"}`}
        >
          {content.nav.map((link) => (
            <li key={link.href} className={bodyClass}>
              {/* The rule wipes in from the left — "underline" is the one
                  transform ADR-0014 lists as fair game for a CSS transition. */}
              <a
                href={link.href}
                className={`group relative inline-block ${focusRing}`}
              >
                {link.label}
                <span
                  aria-hidden
                  className={`bg-foreground-accent absolute -bottom-1 left-0 block h-px w-full origin-left scale-x-0 transition-transform ${hoverTiming} group-hover:scale-x-100 group-focus-visible:scale-x-100`}
                />
              </a>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal
        progress={progress}
        group="explore"
        interactive
        gate={chromeGate}
        className={CLASS.explore}
      >
        {/*
          Node 876:74 is `flex gap-[12px] items-center` with both children
          `shrink-0`: the arrow sits at the left edge and the label follows a
          12px gap later, the pair measuring the full 181px of the rule. The
          rule itself is 6px below the 12px-tall row (Figma puts Line 3 at
          y=18), which is the bottom padding plus the border here.
        */}
        {/*
          The tap zone grows upward, never downward: the rule is the element's
          own bottom border and the 6.5px above it is the gap Figma draws, so
          padding-bottom would detach the underline from the label. Padding-top
          is free — the box is anchored by `bottom`, so everything visible keeps
          its distance from the floor and only the hit area moves. The row below
          it measures 19.5px at a 16px root — 12 for the arrow, 6.5 for the gap
          Figma draws under it, 1 for the rule — so 29 clears 48 rather than
          landing on it, and clears it by more as the adaptive root grows.
        */}
        <a
          ref={exploreRef}
          href={content.explore.href}
          className={`border-foreground-accent flex flex-col border-b pb-xs max-md:pt-[29px] ${focusRing}`}
        >
          <span className="flex items-center gap-md">
            {/*
              The arrow travels left to right and never comes back: a 12px
              window over a 24px track holding two arrows. At rest the track
              sits at −50%, showing the second; on hover it springs to 0, which
              carries that one out past the right edge while the first arrives
              from the left. Because the departure and the arrival are two
              different glyphs, the movement only ever reads in one direction —
              a single arrow sliding right would have to slide back.

              This is a real transform over a real distance, driven from a
              different element, so it is a spring via `<Hover>` rather than a
              CSS transition (ADR-0014 draws that line).
            */}
            <span
              aria-hidden
              className="text-foreground-accent block size-3 shrink-0 overflow-hidden"
            >
              <Hover
                tag="span"
                trigger={exploreRef}
                from={{ transform: "translateX(-50%)" }}
                to={{ transform: "translateX(0%)" }}
                config={{ tension: 240, friction: 26 }}
                className="flex w-6 items-center"
              >
                <ArrowIcon className="size-3 shrink-0" />
                <ArrowIcon className="size-3 shrink-0" />
              </Hover>
            </span>
            <span className={`${bodyClass} shrink-0 uppercase`}>
              {content.explore.label}
            </span>
          </span>
        </a>
      </Reveal>

      <Reveal
        progress={progress}
        group="destinations"
        interactive
        className={`${CLASS.destinations} flex flex-col gap-sm`}
      >
        <p className={`${bodyClass} flex items-center gap-xs`}>
          <DotIcon className="shrink-0" />
          {content.destinationsLabel}
        </p>
        {/* The four names go below the desktop base: on a tablet the column ran
            off the bottom edge, and on a phone the whole group is gone anyway.
            The label stays and still links onward via EXPLORE DESTINATIONS. */}
        <ul className="flex flex-col gap-sm max-lg:hidden">
          {content.destinations.map((link) => (
            <li
              key={link.href}
              className={`font-ui text-body leading-body text-foreground-accent-muted text-trim uppercase ${smallType}`}
            >
              <a
                href={link.href}
                className={`transition-colors ${hoverTiming} hover:text-foreground-accent focus-visible:text-foreground-accent ${focusRing}`}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal
        progress={progress}
        group="viewModes"
        as="p"
        interactive
        className={`${captionClass} ${CLASS.viewModes}`}
      >
        {content.viewModes.map((mode, index) => (
          <Fragment key={mode.label}>
            {index > 0 ? <span aria-hidden>{" / "}</span> : null}
            <button
              type="button"
              aria-pressed={viewMode === mode.label}
              onClick={() => setViewMode(mode.label)}
              className={`cursor-pointer transition-colors ${hoverTiming} ${focusRing} ${
                viewMode === mode.label
                  ? ""
                  : "text-foreground-accent-muted hover:text-foreground-accent"
              }`}
            >
              {mode.label}
            </button>
          </Fragment>
        ))}
      </Reveal>
    </div>
  );
};
