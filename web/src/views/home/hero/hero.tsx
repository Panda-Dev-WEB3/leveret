"use client";

/**
 * Hero — a piece of footage, darkened, and a viewfinder that opens on it.
 *
 * Three beats, in order, and each one waits for the one before it:
 *
 *   1  the preloader lifts        the video plays, and the veil closes over it
 *   2  the video ends             the mask scales open and follows the cursor,
 *                                 and a full-resolution still of the last frame
 *                                 dissolves over the footage
 *   3  the mask lands             the interface gathers around it
 *
 * This replaced a fly-through built from two photographs — a composite zoomed
 * 1 → 1.9632 and cross-dissolved into a landscape. The Figma frames it came
 * from are named "Image 1 for Video after Preloader" and "Image 2 for Video
 * after Preloader": they were always stills standing in for footage, and the
 * zoom between them was a rehearsal of a camera move a video does properly.
 *
 * Beat 3 is still one 0→1 value with every layer interpolated off it — stop it
 * anywhere and the frame is meaningful. Only `transform` and `opacity` animate.
 *
 * 📖 Docs: obsidian/frontend/hero.md
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Image from "next/image";
import { animated, easings, useSpring, SpringValue } from "@react-spring/web";

import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import { useProgressTrigger } from "@/hooks/animation/use-progress-trigger";
import { subscribeToTicker } from "@/lib/animation/ticker";

import { HERO_TUNING } from "./hero.tuning";
import { HeroOverlay } from "./hero-overlay";
import { HeroThumbnails } from "./hero-thumbnails";
import { usePointerFollow } from "./use-pointer-follow";
import {
  ASSEMBLY_FALLBACK_MS,
  ASSEMBLY_LEAD_S,
  ASSEMBLY_MS,
  CLASS,
  GRAIN,
  GRAIN_URI,
  STILL_LEAD_S,
  STILL_MS,
  STILL_QUALITY,
  VEIL_MS,
  VIDEO_RATE,
} from "./hero.geometry";
import type { HeroContent } from "./hero.types";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** A real mouse or trackpad — not touch, not a stylus, not a TV remote. */
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
/**
 * The desktop range, matching the grid's own base width (grid.config.ts).
 * The pointer-follow card is a desktop-only idea, so it is gated on width and
 * not only on pointer capability — a tablet with a mouse attached reports a
 * fine pointer and would otherwise switch it on.
 */
const DESKTOP_QUERY = "(min-width: 1025px)";

const mediaStore = (query: string) => ({
  subscribe: (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  },
  get: () => window.matchMedia(query).matches,
});

const reducedMotion = mediaStore(REDUCED_MOTION_QUERY);
const finePointer = mediaStore(FINE_POINTER_QUERY);
const desktop = mediaStore(DESKTOP_QUERY);

/** SSR-safe read of the OS "reduce motion" preference. */
const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(reducedMotion.subscribe, reducedMotion.get, () => false);

/** SSR-safe pointer-capability check; false during SSR so touch is the default. */
const useHasFinePointer = (): boolean =>
  useSyncExternalStore(finePointer.subscribe, finePointer.get, () => false);

/** SSR-safe desktop-width check; false during SSR so small screens are default. */
const useIsDesktop = (): boolean =>
  useSyncExternalStore(desktop.subscribe, desktop.get, () => false);

/**
 * Where the grain tile sits at each step, on the golden angle.
 *
 * The angle is the same 137.508° block 2 spreads its card tilts on, and for the
 * same reason: consecutive steps land as far from each other as the circle
 * allows, so eight of them never fall into a pattern the eye can follow back.
 * Random numbers would do as well and would differ between renders — this is
 * deterministic, which matters when the thing being generated is *texture*.
 */
const GRAIN_OFFSETS = Array.from({ length: GRAIN.steps }, (_, index) => {
  const angle = (index * 137.508 * Math.PI) / 180;
  return {
    x: Math.cos(angle) * GRAIN.shift,
    y: Math.sin(angle) * GRAIN.shift,
  };
});

export interface HeroProps {
  content: HeroContent;
}

export const Hero = ({ content }: HeroProps) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captionTopRef = useRef<HTMLParagraphElement>(null);
  const captionBottomRef = useRef<HTMLParagraphElement>(null);
  const captionRefs = useMemo(() => [captionTopRef, captionBottomRef], []);

  /* Written every frame off the shared ticker, the way the other blocks do. */
  const exit = useMemo(() => new SpringValue(0), []);

  /**
   * 0→1 as the hero is scrolled away — the pair of thumbnails parts across it,
   * the top one up and out and the bottom one down and out.
   *
   * The hero plays on a clock rather than on the scroll, so this is the only
   * scroll-linked value in the block: from the section sitting at the top of the
   * window to the section gone.
   */
  const { progress: rawExit } = useProgressTrigger({
    elementRef: trackRef,
    start: "top top",
    end: "bottom top",
    frameInterval: 0,
  });

  const prefersReducedMotion = usePrefersReducedMotion();
  const hasFinePointer = useHasFinePointer();
  const isDesktop = useIsDesktop();

  /**
   * The assembly — the value every element of the interface is interpolated
   * from, **played, not scrubbed.**
   *
   * It runs **linearly**. The shaping is per group, inside `groupEase`, so that
   * `PHASE.uiStagger` is a real interval in milliseconds and a group's curve
   * does not depend on where in the timeline it happens to sit.
   */
  const progress = useMemo(() => new SpringValue(0), []);

  /** The darkening over the footage. Its own value: it belongs to beat 1. */
  const veil = useMemo(() => new SpringValue(0), []);

  /**
   * The two conditions the dissolve to the still needs, and it needs **both**.
   *
   * `clipEnded` is the footage having nothing left to play. `stillPainted` is
   * the image having actually decoded — started against one the browser has not
   * painted, the dissolve would fade the footage out to a blank rectangle and
   * bring the still in behind it. They can arrive in either order: on a repeat
   * visit the image is out of cache long before the clip is over, and on a cold
   * one it may well be the other way round.
   */
  const [clipEnded, setClipEnded] = useState(false);
  const [stillPainted, setStillPainted] = useState(false);

  /**
   * When to start.
   *
   * The preloader holds the page still until the clip has frames to give, and
   * releases it at the moment it begins to lift. That release is the handover,
   * so the video hangs on it rather than on mount: played on mount it would run
   * underneath the card and be over before anyone saw it.
   *
   * On a repeat visit the card never appears and scrolling is already enabled,
   * so this is true on the first pass and the video starts at once.
   *
   * > [!warning] `isEnableScroll` starts **`true`**, so this fires once before
   * > the preloader has said anything
   * > The store's initial value is `true` and the preloader's `stop()` runs in an
   * > effect, so the hero's first effect — which captured the value from a render
   * > that happened before any effect ran — sees `true` and plays. The store then
   * > flips to `false`, this effect re-runs and returns early, and the clip is
   * > left playing **under the card**. Invisible while the card was ~1.2s and the
   * > clip was 4s; fatal once the card had a 2.2s floor and the clip ran at 2×,
   * > because the whole thing was over before the card lifted and the reader was
   * > handed a still.
   * >
   * > Hence the two rules below: **cleanup pauses**, so a run that turns out not
   * > to be the handover stops within a frame, and **every run resets**, so the
   * > run that *is* the handover starts from nothing regardless of what happened
   * > before it. Neither depends on effect ordering, which is what made this
   * > invisible in the first place.
   */
  const handedOver = useScroll((state) => state.isEnableScroll);

  useEffect(() => {
    if (prefersReducedMotion || !handedOver) return;

    const video = videoRef.current;

    /*
     * Every run starts from nothing. An earlier run may have played under the
     * preloader and taken the veil with it; what the reader watches is this one,
     * so this one owns the whole sequence from zero.
     *
     * `clipEnded` is reset here for the same reason and not only in cleanup:
     * it is React state rather than an effect-local `let`, so it survives a
     * cleanup that the locals do not — and left standing it would hold the
     * still over a clip that is about to start again from frame 0.
     */
    progress.set(0);
    veil.set(0);
    setClipEnded(false);
    if (video) {
      video.playbackRate = VIDEO_RATE;
      video.currentTime = 0;
    }

    /**
     * Beat 2 → 3, and it can be reached three ways.
     *
     * The ordinary cue is `ASSEMBLY_LEAD_S` before the end, read off the ticker.
     * `ended` backs it up for a clip whose `duration` is `NaN` — a stream, a
     * failed metadata load — and a timer backs up both, because the interface
     * must never fail to arrive: neither event fires for a clip that was refused
     * autoplay, stalled mid-decode, or backgrounded through its own length. The
     * failure lands on the page being assembled, not on a reader looking at
     * silent footage with no page around it.
     *
     * `done` is local to this effect run rather than a ref, on purpose: Strict
     * Mode mounts effects twice and a ref would survive the first cleanup and
     * make the second run a no-op, which is the flight never playing at all.
     */
    let done = false;
    let ended = false;
    let unwatch: (() => void) | undefined;

    /* The ticker carries both cues, so it is only spent once both have fired. */
    const settle = () => {
      if (done && ended) unwatch?.();
    };

    const assemble = () => {
      if (done) return;
      done = true;
      settle();
      progress.start({
        to: 1,
        config: { duration: ASSEMBLY_MS, easing: easings.linear },
      });
    };

    /**
     * Beat 2′ — the footage stops and the full-resolution still takes over.
     *
     * Separate from `assemble`, and it has to be: the assembly deliberately
     * starts `ASSEMBLY_LEAD_S` **before** the last frame, over footage that is
     * still moving. Dissolving a still into a moving picture ghosts, so this
     * one may only happen when there is genuinely nothing left to play.
     */
    const freeze = () => {
      if (ended) return;
      ended = true;
      settle();
      setClipEnded(true);
    };

    /**
     * Both cues at once.
     *
     * On the ordinary path that is what `ended` means: the interface arrives
     * (if the ticker has not already brought it) and the still takes the frame.
     * On every other path — autoplay refused, a decode stalled, an `error`, a
     * tab backgrounded through the whole clip — it is the answer to a clip that
     * is not going to reach its own end, and the still is then simply the best
     * picture available, which for an `error` is the only one.
     */
    const finish = () => {
      assemble();
      freeze();
    };

    veil.start({
      to: 1,
      config: { duration: VEIL_MS, easing: easings.easeOutCubic },
    });

    /*
     * The fallback is re-armed from the moment playback actually **starts**,
     * not from the moment it is asked to.
     *
     * The two are the same on a warm connection and are not on a cold one: a
     * phone that ignores `preload` and streams from the tap can spend seconds
     * getting to its first frame, and a deadline measured from the request would
     * then be counting down through a clip that has not begun. Measured from
     * `playing`, the margin is always a margin over the clip itself.
     */
    let fallback = setTimeout(finish, ASSEMBLY_FALLBACK_MS);
    const rearm = () => {
      clearTimeout(fallback);
      fallback = setTimeout(finish, ASSEMBLY_FALLBACK_MS);
    };

    if (video) {
      // A refusal is not an error here — the fallback is what answers it.
      void video.play().catch(() => {});
      video.addEventListener("ended", finish);
      /* A clip that cannot decode paints nothing at all; the still is then the
         only picture the section has. */
      video.addEventListener("error", finish);
      video.addEventListener("playing", rearm);

      /*
       * The interface starts arriving a beat **before** the last frame.
       *
       * On the ticker rather than on `timeupdate`, which fires about four times
       * a second: at 2× that is half a second of footage between readings, and
       * the lead being aimed at is 0.4. A frame-accurate read of a number the
       * ticker is already awake for costs nothing.
       *
       * `ended` stays attached underneath. A clip whose `duration` is `NaN`
       * — a stream, a failed metadata load — never satisfies this and falls
       * through to it, which is the right way round.
       */
      unwatch = subscribeToTicker(() => {
        const remaining = video.duration - video.currentTime;
        /*
         * The still's own reading of the last frame, and it is guarded on
         * finiteness where the line below is deliberately not: a `NaN` duration
         * fails the comparison and so falls through to `assemble`, which is
         * what that cue wants and the opposite of what this one does — an
         * unguarded reading would put the still up before a frame had played.
         */
        if (Number.isFinite(remaining) && remaining <= STILL_LEAD_S) freeze();
        if (remaining > ASSEMBLY_LEAD_S) return;
        assemble();
      }, () => 0);
    }

    return () => {
      clearTimeout(fallback);
      unwatch?.();
      video?.removeEventListener("ended", finish);
      video?.removeEventListener("error", finish);
      video?.removeEventListener("playing", rearm);
      /* A run that turns out not to be the handover must not leave a clip
         playing behind the card — see the warning above. */
      video?.pause();
      progress.stop();
    };
  }, [handedOver, prefersReducedMotion, progress, veil]);

  const staticFrame = prefersReducedMotion;

  /**
   * The dissolve to the full-resolution still — beat 2′.
   *
   * It is off under reduced motion, and by construction rather than by a flag:
   * the sequence effect returns before it starts anything, so `clipEnded` never
   * becomes true. That is the right answer and not just the convenient one. The
   * clip is a long push-in, its **first** frame is a wide establishing shot and
   * its last is an over-the-shoulder close, and the reduced-motion frame is the
   * wide one, held from the start. Swapping in a still of the close would not be
   * a quality change there — it would be a different picture, chosen for a
   * reader who asked to be shown no movement at all.
   */
  const [stillFade] = useSpring(
    () => ({
      opacity: clipEnded && stillPainted ? 1 : 0,
      config: { duration: STILL_MS, easing: easings.easeOutCubic },
    }),
    [clipEnded, stillPainted],
  );

  /**
   * The grain's clock: one linear pass, looped, read as a step index.
   *
   * `Math.floor` is the whole trick — the value is continuous and the tile's
   * position is not, so the texture jumps eight times a cycle instead of
   * sliding. Grain that slides is dust on the lens.
   */
  const [grain] = useSpring(
    () => ({
      from: { t: 0 },
      to: { t: 1 },
      loop: true,
      config: { duration: GRAIN.cycleMs, easing: easings.linear },
      pause: staticFrame,
    }),
    [staticFrame],
  );

  const grainShift = grain.t.to((t) => {
    const step = Math.min(GRAIN.steps - 1, Math.floor(t * GRAIN.steps));
    const { x, y } = GRAIN_OFFSETS[step];
    return `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  });

  useEffect(
    () =>
      subscribeToTicker(
        () => exit.set(staticFrame ? 0 : Math.min(1, Math.max(0, rawExit.current))),
        () => 0,
      ),
    [exit, rawExit, staticFrame],
  );

  /**
   * With reduced motion there is nothing to play, so the interface is handed a
   * progress parked at the end — fully assembled, immediately, over the clip's
   * first frame.
   */
  const settled = useMemo(() => new SpringValue(1), []);
  const uiProgress = staticFrame ? settled : progress;

  usePointerFollow({
    boundsRef: stageRef,
    cardRef,
    captionRefs,
    progress: uiProgress,
    tuning: HERO_TUNING,
    enabled: isDesktop && hasFinePointer && !prefersReducedMotion,
  });

  return (
    <section
      aria-label="Beyond Places, Into Moments"
      className="relative"
      ref={trackRef}
    >
      <div
        ref={stageRef}
        className="min-h-viewport bg-surface-cinema relative overflow-hidden"
      >
        {/*
          The footage. Muted and `playsInline` because neither is optional —
          without both, a browser will not start a video without a gesture, and
          this one has to start on the preloader's handover.

          `preload="auto"` so the clip is buffering while the card is still
          counting; `use-media-ready` waits on the same element's `readyState`,
          so the two agree about what "loaded" means.
        */}
        <video
          ref={videoRef}
          className={CLASS.video}
          src={content.media.video.src}
          width={content.media.video.width}
          height={content.media.video.height}
          muted
          playsInline
          preload="auto"
          aria-label={content.media.video.alt}
        />

        {/*
          The clip's last frame at full resolution, dissolved over the footage
          the moment it stops — the picture the reader is then left with for the
          rest of the section, at a fidelity the end of a long push-in is exactly
          where an encoder stops being able to give.

          Not a `poster`, which is the same idea pointed the wrong way: a poster
          is what a video shows *before* it plays. This is a sibling layer on the
          same box, so `object-cover` crops the two identically at every viewport
          ratio and the dissolve changes resolution and nothing else.

          Left to load **lazily**, deliberately. It is inside the viewport from
          mount, so the browser starts on it straight away but behind the clip
          the preloader is actually waiting for — and because the dissolve is
          gated on `onLoad`, arriving late costs a beat of the video's own last
          frame rather than a flash of nothing.
        */}
        <animated.div
          aria-hidden
          className={CLASS.still}
          style={{ opacity: stillFade.opacity }}
        >
          <Image
            src={content.media.still.src}
            alt=""
            fill
            sizes="100vw"
            quality={STILL_QUALITY}
            className="object-cover"
            onLoad={() => setStillPainted(true)}
          />
        </animated.div>

        {/* The darkening — beat 1, and it stays for the rest of the section. */}
        <animated.div
          aria-hidden
          className={CLASS.veil}
          style={{ opacity: staticFrame ? 1 : veil }}
        />

        {/*
          A vignette on the same value. It is not the fly-through's old one,
          which peaked mid-zoom and was pinned to 0 at both photographic
          keyframes; there are no keyframes to honour now, so it simply arrives
          with the veil and stays — a lens closing down around the frame.
        */}
        <animated.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            opacity: staticFrame ? 0.45 : veil.to((v) => v * 0.45),
            background:
              "radial-gradient(ellipse at 50% 50%, transparent 40%, black 125%)",
          }}
        />

        {/*
          Grain, over the darkened frame and under everything else — so the
          window's `backdrop-filter` samples it too and the texture carries on
          *inside* the viewfinder, brightened, instead of stopping at its edge.
        */}
        <animated.div
          aria-hidden
          className={CLASS.grain}
          style={{
            backgroundImage: GRAIN_URI,
            backgroundSize: `${GRAIN.tile}px ${GRAIN.tile}px`,
            opacity: GRAIN.opacity,
            transform: staticFrame ? undefined : grainShift,
            willChange: staticFrame ? "auto" : "transform",
          }}
        />

        <HeroThumbnails
          media={content.media.thumbnail}
          progress={uiProgress}
          exit={exit}
        />

        <HeroOverlay
          content={content}
          progress={uiProgress}
          tuning={HERO_TUNING}
          animate={!staticFrame}
          cardRef={cardRef}
          captionTopRef={captionTopRef}
          captionBottomRef={captionBottomRef}
        />
      </div>
    </section>
  );
};
