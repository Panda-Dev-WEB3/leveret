"use client";

/**
 * Holds the page on a brand card until the hero imagery is actually painted.
 *
 * The hero opens on a multi-megabyte photograph; without this the first frames
 * are a black rectangle while it decodes. The Figma source assumes it too — the
 * opening frame is named "Hero 2 (Image 1 for Video after Preloader)".
 *
 * Composed entirely from the design's own parts: the wordmark sits at exactly
 * the coordinates it occupies in the hero (24/24), so the card lifting reads as
 * the same object staying put; the counter is set in the display face at the
 * heading size; and the rule along the bottom is the same 1px cream as the one
 * under EXPLORE DESTINATIONS. All motion is spring-based.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { animated, easings, SpringValue, useSpring } from "@react-spring/web";

import { SegmentedText } from "@/components/ui/segmented-text";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import type { TitleSegment } from "@/types/typography";

import { useMediaReady } from "./use-media-ready";

/**
 * Beat between hitting 100 and lifting, so the full count is legible.
 *
 * It now *is* that beat. It used to be measured from the media being ready,
 * which is a different moment entirely: the counter is a spring and it was still
 * climbing when the card began to fade, so **"100" appeared behind a card that
 * was already leaving** and flashed for a frame or two as it went. The exit
 * waits for `counted` as well as for `ready`, so this delay starts where its
 * name says it does.
 */
const HOLD_MS = 340;

/**
 * How long the digits take to travel to a new reading.
 *
 * **A duration, not a spring, and that is the whole point.** The card may only
 * leave once the count has landed — otherwise "100" arrives behind a card that
 * is already fading and flashes for a frame as it goes, which is exactly what
 * was reported. Knowing when it has landed means knowing how long it takes, and
 * a spring does not tell you that: it rests when it feels like it, and a
 * backstop guessing on its behalf fired mid-count and put the flash back.
 *
 * So the climb is `COUNT_MS` of wall clock and the card's exit is scheduled off
 * the same number. `easeOutCubic` keeps the shape a spring gave it — quick away,
 * settling into the last few digits — without the open-ended tail.
 */
const COUNT_MS = 1200;

/** How long the card takes to clear the top of the screen. */
const LIFT_MS = 780;

/**
 * The card is never on screen for less than this.
 *
 * Loading time is not the same thing as a **reveal**, and this card is both. On
 * a warm cache the media is ready before the counter has drawn a single digit,
 * and the card then flashes: the reader registers that something appeared and
 * left without ever reading it, which is worse than not showing it at all.
 *
 * So the floor is the card's own length rather than the network's. It is spent
 * counting — the spring below is slow enough that 0→100 fills it — so nothing is
 * *waiting*; the count is simply given the time to be seen happening.
 */
const MIN_SHOW_MS = 2200;
/**
 * Whether this document has already shown the card.
 *
 * On `window` rather than in component state because the component can remount
 * — Strict Mode does it once on purpose, and every Fast Refresh does it again —
 * and a remount resets state, bringing the card back over a hero the reader had
 * already been handed. One document, one preloader.
 */
const SHOWN_FLAG = "__preloaderShown";

type FlaggedWindow = Window & { [SHOWN_FLAG]?: boolean };

const alreadyShown = (): boolean =>
  typeof window !== "undefined" &&
  Boolean((window as FlaggedWindow)[SHOWN_FLAG]);

const markShown = (): void => {
  (window as FlaggedWindow)[SHOWN_FLAG] = true;
};

export interface PreloaderProps {
  /** Brand mark, rendered in the display face at its hero position. */
  wordmark: TitleSegment[];
  /** Filenames of the images to wait for. */
  assets: readonly string[];
}

export const Preloader = ({ wordmark, assets }: PreloaderProps) => {
  const { progress, ready } = useMediaReady(assets);
  const [dismissed, setDismissed] = useState(false);

  const stopScroll = useScroll((state) => state.stop);
  const startScroll = useScroll((state) => state.start);

  // The page must not scroll underneath the card, and must be back at the top
  // when it lifts — the hero timeline reads from scroll position zero.
  useEffect(() => {
    stopScroll();
    return () => startScroll();
  }, [stopScroll, startScroll]);

  /**
   * The counter.
   *
   * Slack and heavily damped — 46/26 against the 90/26 it ran at — so the digits
   * climb at a pace you can read rather than blurring to 100. Overdamped on
   * purpose: a counter that overshoots and comes back is a counter that counts
   * past what it is counting.
   */
  /**
   * The counter, as a bare `SpringValue` rather than through `useSpring`.
   *
   * This is the page's own pattern — every scroll-driven block here holds its
   * progress the same way — and here it is also a **fix**. `useSpring(() => ({
   * value: 0, … }))` keeps that literal as a declarative target, and a re-render
   * re-applies it: `setCounted(true)` alone was enough to send the counter back
   * down to zero. Measured, from the frame the count landed: 1 → 0.578 → 0.296 →
   * 0.125 → 0.037 → 0, on the same 1.2s curve it had climbed.
   *
   * That is almost certainly what "100 appears for a millisecond and then
   * disappears" was: the digits reached 100 and were immediately walked back
   * behind a card that was already fading. A `SpringValue` has no declarative
   * half to be re-applied — it only ever holds what it was last told.
   */
  const value = useMemo(() => new SpringValue(0), []);

  /** True `COUNT_MS` after the count was last given a full reading to travel
   *  to — i.e. once the digits have certainly landed on 100. See `HOLD_MS`. */
  const [counted, setCounted] = useState(false);

  /**
   * True from the frame the lift begins.
   *
   * `markShown()` is called at the same moment — it has to be, or a remount
   * mid-lift would start the whole card over — and `alreadyShown()` below would
   * then return `null` on the very next render and cut the lift off at its
   * first frame. Nothing re-renders this component during the lift today, which
   * is exactly the kind of thing that is true until it is not.
   */
  const [lifting, setLifting] = useState(false);

  /**
   * When the card went up — the floor below is measured from here.
   *
   * Stamped in an effect rather than in the ref's initialiser: a render must be
   * pure, and `performance.now()` in one is a value that changes if the
   * component happens to render again. The effect runs once, before paint is
   * of any consequence here, and a millisecond of mount time is not what this
   * floor is measuring.
   */
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);

  useEffect(() => {
    void value.start({
      to: progress,
      config: { duration: COUNT_MS, easing: easings.easeOutCubic },
    });
    if (progress < 1) return;

    /*
     * A timer rather than `onRest`, and for the reason `COUNT_MS` gives: the
     * decision must not depend on the frame loop that draws the digits. A tab
     * that drops frames still passes `COUNT_MS` of wall clock, and the `set`
     * below lands the reading whatever the animation managed in the meantime.
     */
    const timer = setTimeout(() => {
      /*
       * `start(…, immediate)` and **not** `set()`.
       *
       * `set()` writes the current value and leaves the animation's target
       * alone — and in imperative mode the target it falls back on is the one
       * the props function declares, which is `0`. So `set({ value: 1 })` put
       * 100 on screen and then the spring walked it back down to zero over the
       * next second. Measured: value 1 at the `set`, 0.67 · 0.42 · 0.24 · 0.12
       * over the following 600ms, with `animation.to` reading 0 throughout.
       *
       * That is very likely what "100 appears for a millisecond and disappears"
       * was all along, in its earlier form: the count landing just as the card
       * began to fade. `start` moves the target, so nothing can pull it back.
       */
      value.set(1);
      setCounted(true);
    }, COUNT_MS);
    return () => clearTimeout(timer);
  }, [progress, value]);

  /**
   * **The card lifts.** It used to drift toward the viewer and fade — which was
   * written for a hero that flew a camera forward, and that hero is gone: the
   * section underneath is footage now, and a fade is not an exit, it is an
   * absence arriving gradually.
   *
   * A full viewport of upward travel, so the reveal sweeps from the floor of the
   * screen to its ceiling and the footage is uncovered rather than faded up to.
   * No opacity in it at all: a curtain that goes transparent on its way out is
   * two exits happening at once, and the reader only needs to read one.
   *
   * `from`, not a bare literal — see the note on `value` above: a literal here
   * is a declarative target that a re-render would re-apply, which on this
   * spring would mean the card sliding back down halfway out.
   */
  const [exit, exitApi] = useSpring(() => ({
    from: { lift: 0 },
  }));

  useEffect(() => {
    /* Three conditions, and the card leaves when the last of them is met: the
       media is in, the counter has arrived, and the card has been on screen
       long enough to have been read. */
    if (!ready || !counted) return;
    /* Whichever is later: the floor, or the count that just finished. */
    const waited = performance.now() - shownAt.current;
    const remaining = Math.max(0, MIN_SHOW_MS - waited);
    const timer = setTimeout(() => {
      markShown();
      setLifting(true);
      startScroll();
      exitApi.start({
        lift: -100,
        /*
         * A duration rather than a spring, and the one place on this page that
         * is the right way round: a spring settles *onto* its target, and this
         * target is off screen — the settle would be spent where nobody can see
         * it while the card's last visible moments ran at the spring's slowest.
         * `easeInCubic` leaves gently and accelerates away, which is the shape
         * of something being lifted rather than something being pulled.
         */
        config: { duration: LIFT_MS, easing: easings.easeInCubic },
        onRest: () => setDismissed(true),
      });
    }, remaining + HOLD_MS);
    return () => clearTimeout(timer);
  }, [ready, counted, exitApi, startScroll]);

  if (dismissed || (alreadyShown() && !lifting)) return null;

  return (
    <>
      {/* Without scripting nothing can ever dismiss this, so never show it. */}
      <noscript>
        <style>{`[data-preloader]{display:none!important}`}</style>
      </noscript>

      <animated.div
        data-preloader
        role="status"
        aria-live="polite"
        aria-label="Loading"
        className="bg-surface-cinema fixed inset-0 z-50 overflow-hidden"
        style={{
          transform: exit.lift.to((y) => `translate3d(0, ${y.toFixed(3)}%, 0)`),
        }}
      >
        {/* Exactly where the hero puts it, so it does not appear to move. */}
        <p className="text-foreground-accent font-display text-wordmark leading-wordmark text-trim absolute top-page left-page max-lg:text-[20px] max-lg:leading-[18px]">
          <SegmentedText segments={wordmark} />
        </p>

        <div className="absolute inset-0 flex items-center justify-center">
          <animated.p className="text-foreground-accent font-display text-display leading-title text-trim tabular-nums max-lg:text-[72px] max-lg:leading-[57.6px] max-md:text-[56px] max-md:leading-[44.8px]">
            {value.to((v) => String(Math.round(v * 100)).padStart(2, "0"))}
          </animated.p>
        </div>

        {/* Same 1px cream rule as the EXPLORE underline, filled by progress. */}
        <span className="bg-foreground-accent-muted absolute bottom-page left-page right-page block h-px overflow-hidden">
          <animated.span
            className="bg-foreground-accent absolute inset-0 block origin-left"
            style={{ transform: value.to((v) => `scaleX(${v})`) }}
          />
        </span>
      </animated.div>
    </>
  );
};
