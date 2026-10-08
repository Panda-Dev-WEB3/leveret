"use client";

/**
 * Philosophy — one pinned block read as two states of the same picture.
 *
 * There is a single 0→1 scroll progress value and everything is a continuous
 * interpolation of it, exactly as the hero works: stop anywhere and the frame
 * is meaningful. The first 55% moves the heading up and walks the photograph
 * from its horizon down into the valley; the rest brings the collage and the
 * three texts in, staggered.
 *
 * The two Figma frames are the ends of that one timeline, not two blocks:
 *   p = 0  1653:964  — heading at top 351, nothing else
 *   p = 1  1653:1003 — heading at top 100, collage and copy arrived
 *
 * 📖 Docs: obsidian/frontend/philosophy.md
 */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties } from "react";
import Image from "next/image";
import { animated, easings, SpringValue, to, useSpring } from "@react-spring/web";

import { Hover } from "@/components/animation/springs/hover";
import { RevealWords, SweepTitle } from "@/components/ui/reveal-text";
import { SegmentedText } from "@/components/ui/segmented-text";
import type { TitleSegment } from "@/types/typography";
import { useProgressTrigger } from "@/hooks/animation/use-progress-trigger";
import { subscribeToTicker } from "@/lib/animation/ticker";
import { useWindowWidth } from "@/hooks/use-window-size";

/*
 * The collage lifts on hover exactly as block 2's polaroids do, so the values
 * are imported from block 2 rather than copied: −6px and 1.025 on a
 * tension 300 / friction 30 spring, with the same `(hover: none)` press
 * fallback. Copying the numbers would let the two drift apart on the next edit;
 * importing cannot. Nothing in block 2 is modified by reading from it.
 */
import {
  CARD_HOVER,
  TOUCH_PRESS,
  TOUCH_TARGET,
} from "@/views/home/destinations/destinations.geometry";

import {
  BACKDROP_PAN,
  CLASS,
  COLLAGE_TURN,
  REVEAL_MS,
  REVEAL_ORDER,
  groupEase,
  REVEAL_DURATION,
  revealStart,
  emergeEase,
  HANDOVER,
  openingEase,
  type RevealGroup,
} from "./philosophy.geometry";
import type { PhilosophyContent } from "./philosophy.types";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * SSR-safe read of the OS "reduce motion" preference. Declared here rather than
 * imported from the hero: the hero keeps its copy private, and reaching into
 * another section for a four-line hook would couple two blocks that otherwise
 * share nothing.
 */
const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(REDUCED_MOTION_QUERY);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );

/** The collage is 376 wide at the 1440 base — 26% of the scene, capped at 1600. */
const COLLAGE_SIZES = "(min-width: 1600px) 418px, 26vw";

/**
 * Where the copy is allowed to break, and on which screens.
 *
 * Nothing here changes what the text *is* — every break is a `<br>` that is
 * `display: none` outside its own range, so the desktop keeps the natural wrap
 * Figma draws and each smaller layout states the break its column needs.
 *
 * `md:max-lg:inline` is the tablet band alone, 641–1024: `max-lg` on its own
 * would reach the phone too, which wants its break somewhere else.
 */
const TABLET_ONLY = "hidden md:max-lg:inline";

/**
 * The heading breaks in two different places: a phone after "Go Somewhere
 * That", a tablet a word later, after "Stays". One entry per gap between the
 * content's three fragments.
 */

/** Both paragraphs break once, on a tablet only. */
const Paragraph = ({
  parts,
  open,
  animate,
}: {
  parts: string[];
  open: boolean;
  animate: boolean;
}) => (
  <>
    {parts.map((part, index) => (
      <Fragment key={index}>
        {index > 0 ? <>{" "}<br className={TABLET_ONLY} /></> : null}
        <RevealWords text={part} open={open} animate={animate} />
      </Fragment>
    ))}
  </>
);

interface RevealProps {
  /** True once the scroll has reached this group's place in the order. */
  cued: boolean;
  /** False under reduced motion: everything is placed, nothing travels. */
  animate: boolean;
  /**
   * Raw block progress, for a group that also turns.
   *
   * Only the collage passes it. The rotation has to live in the **same**
   * transform string as the reveal's travel — two transforms on one element is
   * one too many, and the second would simply overwrite the first — so it is
   * folded in here rather than wrapped around the outside. `to([a, b], …)`
   * rather than `a.to(…)` reading `b.get()`: an interpolation only recomputes
   * when something it is *attached* to changes, and the one-sided form would
   * freeze the turn the moment the reveal finished.
   */
  turn?: SpringValue<number>;
}

/**
 * Fade and lift for one revealed group — **cued by the scroll, then played.**
 *
 * It used to be scrubbed: a pure function of progress, so the group faded in and
 * out with the wheel. That was the block's rule and it broke the moment the two
 * paragraphs stopped being scrubbed too — the paragraphs latch and play on their
 * own clock, so they would arrive at full strength while the collage they belong
 * around was still at 8% opacity, and scrolling back up left them hanging over a
 * collage that had faded out from under them. The block was half one model and
 * half the other, which is a worse thing to be than either.
 *
 * So the whole revealed group is cued now. The scroll says *when*, in
 * `REVEAL_ORDER`, and each group plays out over `REVEAL_MS` and stays. That is
 * also what fixes the narrow layout, where the mismatch was plainest: the column
 * showed two paragraphs with a hole between them where the collage should be.
 *
 * The heading's sweep is deliberately **not** part of this. It is a fill rather
 * than an arrival — it is meant to track the scroll — and it is the one thing
 * here whose whole point is that it answers the wheel.
 *
 * The travel is written into `transform` while horizontal centring lives on the
 * separate `translate` property (see `CLASS`), so the two never overwrite each
 * other. The distance comes from `--b3-travel`, a custom property the class sets
 * — `cqw` on desktop, px below it, where there is no size container left for
 * `cqw` to resolve against. The spring only writes the multiplier.
 */
const useReveal = ({ cued, animate, turn }: RevealProps) => {
  const { shown } = useSpring({
    shown: cued ? 1 : 0,
    config: { duration: REVEAL_MS, easing: easings.easeOutCubic },
    immediate: !animate,
  });

  const rise = (v: number) =>
    `translate3d(0px, calc(var(--b3-travel) * ${(1 - v).toFixed(4)}), 0px)`;

  return {
    opacity: shown,
    transform: turn
      ? to(
          [shown, turn],
          (v, raw) =>
            `${rise(v)} rotate(${((raw - 0.5) * COLLAGE_TURN * 2).toFixed(3)}deg)`,
        )
      : shown.to(rise),
  };
};

export interface PhilosophyProps {
  content: PhilosophyContent;
}

/** Everything below the desktop base lays out in flow rather than by `cqw`. */
const FLOW_QUERY = "(max-width: 1024px)";

/**
 * How far the heading has to start below its resting place for state A to put
 * it in the **middle of the screen**, the way the desktop does.
 *
 * On desktop that distance is Figma's own — top 351 against top 100 — and 351
 * plus half the heading's 97px box is 399.5, the exact centre of the 800 scene.
 * In the flow column there is no such pair to read off, so it is stated
 * directly: **the scene's centre minus the heading's own**.
 *
 * That is deliberately not `(columnHeight − headingHeight) / 2`, which is what
 * this used to be. The two agree only while the column is centred in the *whole*
 * scene — and it is not: the scene reserves a footer's worth of padding for the
 * pinned sign-off, so the column centres in what is left and sits above the
 * screen's own middle. The general form holds either way.
 *
 * Measured from `offsetTop`/`offsetHeight`, never from `getBoundingClientRect`:
 * the layout is what matters here and those are transform-free, so a
 * measurement taken mid-animation still reports the resting geometry. Elements
 * that leave the flow — the pinned sign-off — are skipped by the
 * `position: static` filter rather than by name.
 */
const useFlowTravel = (
  sceneRef: React.RefObject<HTMLDivElement | null>,
  pinnedRef: React.RefObject<HTMLParagraphElement | null>,
) => {
  const [travel, setTravel] = useState<number | null>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const measure = () => {
      if (!window.matchMedia(FLOW_QUERY).matches) {
        scene.style.paddingBottom = "";
        setTravel(null);
        return;
      }

      /*
       * Room kept at the foot of the scene for the pinned sign-off: its own
       * height plus the gap it holds below itself. The column then centres in
       * what is actually left, so the air falls in two equal parts instead of
       * pooling above it.
       *
       * Padding rather than a margin, because an absolutely positioned child
       * resolves `bottom` against its containing block's **padding box**, whose
       * bottom edge padding does not move. The sign-off's ink stays exactly
       * where the hero's button is.
       *
       * Written here rather than through React state on purpose: it has to land
       * *before* the heading's position is read, or the travel below would be
       * measured against a layout this write is about to change and would need a
       * second pass to settle. Reading `offsetTop` after the write forces the
       * reflow that makes one pass enough.
       */
      const pinned = pinnedRef.current;
      const reserve =
        pinned && getComputedStyle(pinned).position === "absolute"
          ? Math.round(
              pinned.offsetHeight +
                (parseFloat(getComputedStyle(pinned).bottom) || 0),
            )
          : 0;
      /*
       * When the column is pinned to the top rather than centred, its last
       * child has no gap after it while its first has one before — so the two
       * `margin-bottom: auto` that centre the middle group would split the
       * slack unevenly, by exactly one gap. Adding that gap to the reserve
       * evens it out. Read from the computed `row-gap` rather than written as a
       * number, so it cannot drift from the class that sets it.
       */
      const style = getComputedStyle(scene);
      const trailingGap =
        style.justifyContent === "flex-start"
          ? parseFloat(style.rowGap) || 0
          : 0;
      scene.style.paddingBottom = `${reserve + trailingGap}px`;

      const flow = [...scene.children].filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          getComputedStyle(el).position === "static",
      );
      if (flow.length < 2) {
        setTravel(null);
        return;
      }

      const heading = flow[0];
      const headingCentre = heading.offsetTop + heading.offsetHeight / 2;
      setTravel(
        Math.max(0, Math.round(scene.clientHeight / 2 - headingCentre)),
      );
    };

    measure();

    // The column's height moves for reasons the window never sees — a webfont
    // arriving and re-wrapping a paragraph, the collage resolving its `dvh`
    // cap — so every flow child is watched, not just the viewport.
    const observer = new ResizeObserver(measure);
    observer.observe(scene);
    for (const child of scene.children) observer.observe(child);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [sceneRef, pinnedRef]);

  return travel;
};

export const Philosophy = ({ content }: PhilosophyProps) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const collageRef = useRef<HTMLDivElement>(null);
  const signOffRef = useRef<HTMLParagraphElement>(null);
  const flowTravel = useFlowTravel(sceneRef, signOffRef);

  const prefersReducedMotion = usePrefersReducedMotion();
  const staticFrame = prefersReducedMotion;

  const { progress: rawProgress } = useProgressTrigger({
    elementRef: trackRef,
    start: "top top",
    end: "bottom bottom",
    enabled: !staticFrame,
    frameInterval: 0,
  });

  /**
   * Written unconditionally every frame from the raw scroll value, for the
   * reason hero.tsx spells out at length: a guarded spring can be told a new
   * target while frames are suppressed, record it, and never animate to it,
   * leaving the block parked at the wrong state with no way back. Writing the
   * true value every frame cannot strand — one frame heals it.
   */
  /**
   * How much of the track is spent **underneath block 2**, as a fraction of the
   * progress value — measured, not declared.
   *
   * The desktop track starts a screen early and behind the cards (see
   * `CLASS.section`), and that screen has to come off the front of every
   * keyframe in this block or the whole sequence would play a screen early,
   * half of it hidden. The denominator is `offsetHeight − innerHeight`, not the
   * track's height: `top top → bottom bottom` runs across the track *minus one
   * viewport*, which is what the hook measures between those two positions.
   *
   * Read off `getComputedStyle` rather than hard-coded, so the one number lives
   * in the class string and cannot fall out of step with it — and so the
   * narrow ranges, which have no negative margin, come back 0 and behave
   * exactly as they did before.
   */
  const [lead, setLead] = useState(0);
  const width = useWindowWidth();
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const marginTop = parseFloat(getComputedStyle(track).marginTop) || 0;
    const overlap = Math.max(0, -marginTop);
    const span = track.offsetHeight - window.innerHeight;
    setLead(span > 0 ? Math.min(0.95, overlap / span) : 0);
  }, [width, staticFrame]);

  const live = useMemo(() => new SpringValue(0), []);

  /**
   * The raw progress, unsplit — the only thing in this block that is scroll
   * *itself* rather than a stage of it.
   *
   * The backdrop rides it, and nothing else does. See `backdropPan`.
   */
  const whole = useMemo(() => new SpringValue(0), []);

  /**
   * The lead-in as its own 0→1: the screen of scrolling in which block 2 slides
   * off this one. The heading rides it, so it rises into place exactly as the
   * cards uncover it. Everything else waits for `live`.
   *
   * Where there is no overlap it *is* `live`, so the heading keeps the reveal it
   * has always had below the desktop base.
   */
  const reveal = useMemo(() => new SpringValue(0), []);

  /**
   * The asides' cue — a latch, not a scrub.
   *
   * The two lines used to be scrubbed word by word off this same progress, which
   * meant they only moved while the wheel did: stop halfway and they stopped
   * halfway, a sentence frozen mid-word. Copy does not read that way. So the
   * scroll now only says **when**, and the words play out on their own clock
   * from there — the site's standard word reveal, the one every subtitle uses.
   *
   * It rides the ticker that is already here rather than an observer of its own:
   * this block is pinned, so its paragraphs are on screen for the whole 380vh
   * and "in view" would fire at the very top, before the heading has even
   * finished filling.
   */
  const [cuedCount, setCuedCount] = useState(0);
  const cuedRef = useRef(0);

  useEffect(
    () =>
      subscribeToTicker(
        () => {
          const raw = Math.min(1, Math.max(0, rawProgress.current));
          const staged = lead > 0 ? Math.max(0, (raw - lead) / (1 - lead)) : raw;
          live.set(staged);
          whole.set(raw);
          reveal.set(lead > 0 ? Math.min(1, raw / lead) : staged);

          /*
           * How many groups the scroll has reached, in `REVEAL_ORDER`. One
           * counter rather than four booleans: the order is the whole point, so
           * a group cannot be cued while the one before it has not been.
           */
          let reached = cuedRef.current;
          while (
            reached < REVEAL_ORDER.length &&
            staged >= revealStart(REVEAL_ORDER[reached])
          ) {
            reached += 1;
          }
          if (reached !== cuedRef.current) {
            cuedRef.current = reached;
            setCuedCount(reached);
          }
        },
        () => 0,
      ),
    [live, whole, reveal, rawProgress, lead],
  );

  /**
   * With reduced motion there is nothing to scrub, so the block is handed a
   * progress parked at the end: state B, fully assembled, immediately.
   */
  const settled = useMemo(() => new SpringValue(1), []);
  const progress = staticFrame ? settled : live;
  /**
   * Has the scroll reached this group yet?
   *
   * Reduced motion is handed the whole order at once: there is nothing to
   * stagger when nothing travels.
   */
  const isCued = (group: RevealGroup): boolean =>
    staticFrame || REVEAL_ORDER.indexOf(group) < cuedCount;

  /**
   * The heading rides the lead-in rather than the block's own timeline: it has
   * to finish rising exactly as block 2 finishes uncovering it, and block 2 is
   * gone before the timeline starts.
   */
  const emerging = staticFrame ? settled : reveal;

  /**
   * The window the heading's letters come up to strength across, in **raw**
   * progress — the block's whole track, lead-in included.
   *
   * It used to run on the lead-in alone, which put the whole fill behind
   * block 2: the letters were at full strength before the cards had finished
   * uncovering them, so the one thing the sweep exists to be seen doing happened
   * where nobody could see it. It now starts once the heading is genuinely
   * clearing — `0.72` of the lead-in — and ends where the collage begins, which
   * is `HANDOVER` of the staged timeline converted back into raw progress.
   *
   * Both ends are derived rather than typed: `lead` is measured, `HANDOVER` is
   * the block's own constant, so the sweep cannot fall out of step with either.
   */
  const sweepFrom = lead > 0 ? lead * 0.72 : 0;
  const sweepTo = lead > 0 ? lead + HANDOVER * (1 - lead) : HANDOVER;

  /**
   * The photograph drifts at **one constant rate for the whole block**, and both
   * halves of that sentence are the fix.
   *
   * It used to run `openingEase` — a smoothstep — over the first 30% of the
   * block's own timeline. Three things were wrong with that from the reader's
   * seat, and all three are the same complaint: the picture eased *in*, eased
   * *out*, and then stopped dead while the scroll carried on for another 70% of
   * the block. A background that changes speed twice and then parks is the one
   * thing in a pinned block that can make a steady scroll feel like it is
   * accelerating and braking, because it is the only surface still moving with
   * the wheel once the block is pinned.
   *
   * So: **linear**, and against the **raw** progress rather than the staged one,
   * so the drift starts the moment the block begins to be uncovered by block 2
   * and ends as it leaves. No curve, no handover, no stop — a constant rate from
   * the first frame of the block to the last.
   *
   * What that costs is that the photograph reaches its −50% as the block ends
   * rather than at the handover, so the assembled state is read against ~85% of
   * the pan instead of all of it. The file's two frames are the ends of the
   * travel and both are still hit; only where between them the collage lands has
   * moved, and a background offset is the cheapest thing in this block to spend.
   */
  const backdropPan = (staticFrame ? settled : whole).to((p) => {
    const to = parseFloat(BACKDROP_PAN.to);
    return `translate3d(0px, ${(p * to).toFixed(4)}%, 0px)`;
  });

  /**
   * Which curve the heading rides depends on whether it has a block above it to
   * come out from under. With a lead-in it spends the whole of it emerging
   * (`emergeEase`); without one — every range below the desktop base — it keeps
   * the opening curve it shares with the backdrop, on the block's own timeline.
   * The measured `lead` decides, so the choice follows a resize across the
   * breakpoint on the render that measures it.
   */
  const titleShift = emerging.to((p) => {
    const eased = lead > 0 ? emergeEase(p) : openingEase(p);
    return `translate3d(0px, calc(var(--b3-travel) * ${(1 - eased).toFixed(4)}), 0px)`;
  });

  /**
   * Cast on its own rather than on the whole style object: `transform` there is
   * a spring interpolation, not a `CSSProperties` value, and widening the pair
   * together would throw that type away.
   */
  const travelOverride =
    flowTravel === null
      ? undefined
      : ({ "--b3-travel": `${flowTravel}px` } as CSSProperties);

  const collage = useReveal({
    cued: isCued("collage"),
    animate: !staticFrame,
    turn: whole,
  });
  const signOff = useReveal({
    cued: isCued("signOff"),
    animate: !staticFrame,
  });

  return (
    <section
      aria-label="One balance. A world of possibility."
      className={staticFrame ? "relative" : CLASS.section}
      ref={trackRef}
    >
      <div className={CLASS.sticky}>
        {/* The photograph fills the **screen**, not the scene: it lives in the
            sticky so it reaches every edge at any window height. The scene
            below is only the coordinate system the composition is placed in.
            The box is twice the sticky tall — see CLASS.backdrop. */}
        <animated.div
          className={CLASS.backdrop}
          style={{ transform: backdropPan }}
        >
          <Image
            src={content.media.backdrop.src}
            alt={content.media.backdrop.alt}
            fill
            sizes="100vw"
            className="object-cover"
          />
        </animated.div>

        <div className={CLASS.scrim} aria-hidden />

        <div className={`${CLASS.scene} philosophy-scene`} ref={sceneRef}>

          {/*
            The measured travel is written as the same custom property the
            class sets, so the desktop keeps its `cqw` value and only the flow
            column is overridden — one mechanism, two magnitudes.

            The line break exists only on a phone. Everywhere else the two
            lines run together and wrap on their own, which at 1440 lands on
            exactly this break; in a 312px column it does not.
          */}
          <animated.h2
            className={`${CLASS.title} philosophy-title`}
            style={{ transform: titleShift, ...travelOverride }}
          >
            {content.title.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? (
                  <>
                    {/* The space belongs to the line, not to a word: the cut
                        drops whitespace, and at widths where the <br /> is
                        `display: none` this is the only thing keeping the last
                        word of one line off the first of the next. Where the
                        break does show, it collapses at the end of the line. */}
                    {" "}
                    <br className="philosophy-line-break" />
                  </>
                ) : null}
                {/*
                  Each line takes its own slice of the one sweep, so it crosses
                  the heading once from end to end rather than restarting on
                  every line — the same reason the word stagger it replaces
                  counted across the whole heading rather than per line.
                */}
                <SweepTitle
                  segments={line}
                  progress={staticFrame ? settled : whole}
                  from={
                    sweepFrom +
                    ((sweepTo - sweepFrom) * lineIndex) / content.title.length
                  }
                  to={
                    sweepFrom +
                    ((sweepTo - sweepFrom) * (lineIndex + 1)) /
                      content.title.length
                  }
                />
              </Fragment>
            ))}
          </animated.h2>

          {/*
            Box and transform are two elements on purpose, the pattern block 2's
            polaroids use: the outer one owns the placement, the reveal and the
            ref, and `<Hover>` animates the inner one while watching that ref.
            Driving `<Hover>` from an explicit `trigger` attaches the listener
            natively instead of going through React's mouseenter synthesis.
          */}
          <animated.div
            ref={collageRef}
            className={`group philosophy-collage ${CLASS.collage} ${TOUCH_TARGET}`}
            style={collage}
          >
            <Hover
              tag="div"
              trigger={collageRef}
              enabled={!prefersReducedMotion}
              from={{ transform: CARD_HOVER.from }}
              to={{ transform: CARD_HOVER.to }}
              config={CARD_HOVER.config}
              className={`relative h-full w-full ${TOUCH_PRESS}`}
            >
              <Image
                src={content.media.collage.src}
                alt={content.media.collage.alt}
                fill
                sizes={COLLAGE_SIZES}
                className="object-contain"
              />
            </Hover>
          </animated.div>

          <p className={`${CLASS.aside} ${CLASS.asideLeft}`}>
            <Paragraph
              parts={content.asideLeft}
              open={isCued("asideLeft")}
              animate={!staticFrame}
            />
          </p>

          <p className={`${CLASS.aside} ${CLASS.asideRight}`}>
            <Paragraph
              parts={content.asideRight}
              open={isCued("asideRight")}
              animate={!staticFrame}
            />
          </p>

          <animated.p
            ref={signOffRef}
            className={CLASS.signOff}
            style={signOff}
          >
            {content.signOff.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </animated.p>
        </div>
      </div>
    </section>
  );
};
