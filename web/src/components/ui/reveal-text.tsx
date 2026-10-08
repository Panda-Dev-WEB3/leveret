"use client";

/**
 * Display type that arrives one letter at a time — and copy that arrives one
 * word at a time.
 *
 * Both do the same three things at once: **rise, unblur and fade in.** A letter
 * that only moved would read as mechanical; one that only faded would not read
 * as arriving from anywhere. The blur is what makes the pair feel like focus
 * being found rather than two properties being animated.
 *
 * ## Why this is not the text engine
 *
 * The vault's [[text-engine]] is the house answer for animated type, and
 * `spring-text-engine` is not a dependency of this project — the note is aspirational
 * rather than describing something installed. So this is built on the same
 * `@react-spring/web` everything else here uses, which is what ADR-0002 actually
 * requires.
 *
 * ## Why a duration and not a physical spring
 *
 * Twenty-six letters on twenty-six springs settle at twenty-six moments, and a
 * heading that finishes raggedly is exactly what "super smooth" is not. One
 * duration and one curve across the whole line makes the stagger the only thing
 * that differs between letters, so the line arrives as one movement read from
 * one end to the other. `cubic-bezier(0.16, 1, 0.3, 1)` is a hard ease-out: most
 * of the distance is covered early and the last tenth takes a third of the time,
 * which is what reads as a glide rather than a stop.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import { Fragment, useMemo } from "react";
import { animated, to, useInView, useSprings } from "@react-spring/web";
import type { SpringValue } from "@react-spring/web";

import { toWords } from "./segmented-text";
import type { TitleSegment } from "@/types/typography";

/** Which end of the line the stagger starts from. */
export type RevealDirection = "rtl" | "ltr";

/**
 * The shape of the arrival, in one place so every heading on the page agrees.
 *
 * `rise` is in `em` rather than px or `cqw`: the headings run from 24px in the
 * footer to 85 in block 2, and half a letter's height is the same *relationship*
 * at both. A fixed distance would be a shove on one and imperceptible on the
 * other.
 */
export const REVEAL = {
  /** How long one letter takes, in ms. */
  duration: 900,
  /** Between one letter and the next. 26 letters × 26ms is a 0.68s sweep. */
  stagger: 26,
  /** Between one word and the next, for the copy variant. */
  wordStagger: 90,
  /** How far it rises, in `em` of its own size. */
  rise: 0.62,
  /** How far out of focus it starts, in px. */
  blur: 14,
  /** Everything waits this long after the line enters the viewport. */
  delay: 80,
} as const;

/**
 * `cubic-bezier(0.16, 1, 0.3, 1)` — solved, because CSS curves are parametric.
 *
 * The x fed in and the y returned are both functions of a hidden parameter, so
 * x is solved for first and y is read at that parameter. Newton where the slope
 * is usable, bisection where it is not, which is what a browser does.
 */
const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  const at = (a: number, b: number, t: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  const slope = (a: number, b: number, t: number) =>
    3 * (1 - t) ** 2 * a + 6 * (1 - t) * t * (b - a) + 3 * t ** 2 * (1 - b);

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const dx = at(x1, x2, t) - x;
      if (Math.abs(dx) < 1e-6) return at(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let low = 0;
    let high = 1;
    t = x;
    while (high - low > 1e-6) {
      if (at(x1, x2, t) < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return at(y1, y2, t);
  };
};

const EASE = bezier(0.16, 1, 0.3, 1);

/** The config every reveal on the page shares. */
const CONFIG = { duration: REVEAL.duration, easing: EASE } as const;

/** One character, with the cut it belongs to. */
interface RevealChar {
  char: string;
  italic?: boolean;
}

/**
 * A line cut into words, and each word into characters.
 *
 * Words first, because a word is what must not break across a line — every
 * letter is `inline-block` to carry a transform, and a run of inline-blocks with
 * nothing holding them together wraps between any two letters. Wrapping the word
 * puts the break back where a break belongs.
 *
 * The italic flag rides each character, so the display face's leading capitals
 * survive being cut up. See `toWords` for why a segment is not a word.
 */
const toLetterWords = (segments: TitleSegment[]): RevealChar[][] =>
  toWords(segments).map((word) =>
    word.flatMap((segment) =>
      [...segment.text].map((char) => ({ char, italic: segment.italic })),
    ),
  );

/** The two ends of the arrival. Typed as plain numbers, not the literals
 *  `REVEAL`'s `as const` would otherwise narrow them to. */
interface RevealPose {
  opacity: number;
  y: number;
  blur: number;
}

const hidden: RevealPose = {
  opacity: 0,
  y: REVEAL.rise,
  blur: REVEAL.blur,
};

const shown: RevealPose = { opacity: 1, y: 0, blur: 0 };

/**
 * The style a reveal writes.
 *
 * `translate3d` in `em` and a `blur()` in px, written as one string each so
 * react-spring interpolates numbers rather than parsing units per frame.
 */
type RevealSpring = {
  opacity: SpringValue<number>;
  y: SpringValue<number>;
  blur: SpringValue<number>;
};

const toStyle = (spring: RevealSpring) => ({
  opacity: spring.opacity,
  transform: spring.y.to((value) => `translate3d(0, ${value}em, 0)`),
  filter: spring.blur.to((value) =>
    value < 0.05 ? "none" : `blur(${value}px)`,
  ),
});

export interface RevealTitleProps {
  segments: TitleSegment[];
  /**
   * Which end the sweep starts from. `rtl` is the page's default — the letters
   * arrive from the end of the line towards its beginning, so the eye is led
   * back to where reading starts.
   */
  direction?: RevealDirection;
  /** Off under reduced motion: everything is placed, nothing travels. */
  animate?: boolean;
  /**
   * The cue, when the line's own arrival on screen is the wrong one.
   *
   * Left out, the line watches itself and plays when it is seen. Passed, it
   * plays when the caller says so and its own visibility is ignored — the
   * hero's, where the letters belong to a sequence: the section is on screen
   * from the first frame, so "in view" would have the phrase arrive several
   * seconds before the picture it sits on.
   *
   * This replaced a `startDelay` in ms. A delay has to be *computed* from where
   * the moment sits in a timeline, which means it is only correct while the
   * timeline starts when the component mounts — and the hero's no longer does:
   * it starts when a video ends. A cue does not care what happened before it.
   */
  open?: boolean;
}

/**
 * A display line that arrives letter by letter.
 *
 * The stagger runs across the **whole line**, not per word: restarting it at
 * each word would start the first letter of every word at once and the line
 * would arrive in columns.
 */
export const RevealTitle = ({
  segments,
  direction = "rtl",
  animate = true,
  open,
}: RevealTitleProps) => {
  /**
   * The words, and where each one starts in the flat run of letters.
   *
   * The offsets are computed here rather than counted while rendering: a
   * running index mutated inside `map` is a variable reassigned after the render
   * that read it, which is the one thing a render must not do.
   */
  const { words, offsets, count } = useMemo(() => {
    const cut = toLetterWords(segments);
    const starts: number[] = [];
    let total = 0;
    for (const word of cut) {
      starts.push(total);
      total += word.length;
    }
    return { words: cut, offsets: starts, count: total };
  }, [segments]);

  const [ref, inView] = useInView({ once: true });
  const cued = open ?? inView;

  const [springs] = useSprings(
    count,
    (index) => ({
      from: hidden,
      to: cued || !animate ? shown : hidden,
      immediate: !animate,
      delay:
        REVEAL.delay +
        (direction === "rtl" ? count - 1 - index : index) * REVEAL.stagger,
      config: CONFIG,
    }),
    [cued, animate, count, direction],
  );

  return (
    <span ref={ref} className="inline">
      {words.map((word, wordIndex) => (
        <Fragment key={wordIndex}>
          {wordIndex > 0 ? " " : null}
          {/*
            `inline-block` on the word so it cannot break between its own
            letters, and `whitespace-nowrap` for the same reason — a run of
            inline-blocks is otherwise as breakable as a run of words.
          */}
          <span className="inline-block whitespace-nowrap">
            {word.map((letter, letterIndex) => (
              <animated.span
                key={letterIndex}
                className={`inline-block ${letter.italic ? "italic" : ""}`}
                style={toStyle(springs[offsets[wordIndex] + letterIndex])}
              >
                {letter.char}
              </animated.span>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
};

export interface RevealWordsProps {
  /** Plain copy — a subtitle or a sign-off, not a display line. */
  text: string;
  animate?: boolean;
  /**
   * The cue, when the copy's own arrival on screen is the wrong one.
   *
   * Left out, the line watches itself and plays when it is seen — right for a
   * subtitle under a heading. Passed, it plays when the caller says so and its
   * own visibility is ignored: a line inside a **pinned** block is on screen for
   * the whole of that block's scroll, so "in view" there means "the block
   * started", which is far too early for something that belongs in the middle of
   * a sequence. The animation still runs on its own clock either way — that is
   * the difference between this and a scrubbed reveal.
   */
  open?: boolean;
}

/**
 * The same arrival, one **word** at a time.
 *
 * Copy is read as words, so it arrives as words: a subtitle revealed letter by
 * letter reads as a machine printing rather than as a line settling. Left to
 * right, because that is the order it will be read in — the right-to-left sweep
 * belongs to display type, where the line is taken in as a shape first.
 */
export const RevealWords = ({
  text,
  animate = true,
  open,
}: RevealWordsProps) => {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const [ref, inView] = useInView({ once: true });
  const cued = open ?? inView;

  const [springs] = useSprings(
    words.length,
    (index) => ({
      from: hidden,
      to: cued || !animate ? shown : hidden,
      immediate: !animate,
      delay: REVEAL.delay + index * REVEAL.wordStagger,
      config: CONFIG,
    }),
    [cued, animate, words.length],
  );

  return (
    <span ref={ref} className="inline">
      {words.map((word, index) => (
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <animated.span
            className="inline-block whitespace-nowrap"
            style={toStyle(springs[index])}
          >
            {word}
          </animated.span>
        </Fragment>
      ))}
    </span>
  );
};

/**
 * How much of a letter is showing before the sweep reaches it.
 *
 * Not zero: this line is **read** while it is being revealed, not discovered by
 * it. At 0 the heading would arrive as a word being typed; at 0.28 it is a whole
 * sentence coming into strength, which is what a heading held under the
 * scroll should do.
 */
export const SWEEP_FLOOR = 0.28;

/** The share of the progress one letter spends coming up to full. */
const SWEEP_SPAN = 0.42;

/** Smoothstep — still at both ends, so no letter starts or stops abruptly. */
const smooth = (t: number): number => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

export interface SweepTitleProps {
  segments: TitleSegment[];
  /** 0→1, normally a scroll position. The sweep is a pure function of it. */
  progress: SpringValue<number>;
  /**
   * Where this line starts and ends inside the whole heading's sweep. A heading
   * of three lines hands each line a third, so the sweep crosses the block once
   * rather than three times over.
   */
  from?: number;
  to?: number;
}

/**
 * A display line whose letters come up to full strength **left to right, on the
 * scroll**.
 *
 * Not an entrance: every letter is on the page from the first frame at
 * `SWEEP_FLOOR`, and what the scroll does is bring them up. So there is no
 * trigger, no in-view, no state — the opacity of letter *i* is a pure function
 * of one number, which is the same property the scroll-driven blocks are built
 * on and the reason scrolling back plays exactly what scrolling down played.
 */
export const SweepTitle = ({
  segments,
  progress,
  from = 0,
  to: end = 1,
}: SweepTitleProps) => {
  const { words, offsets, count } = useMemo(() => {
    const cut = toLetterWords(segments);
    const starts: number[] = [];
    let total = 0;
    for (const word of cut) {
      starts.push(total);
      total += word.length;
    }
    return { words: cut, offsets: starts, count: total };
  }, [segments]);

  /* The stagger, solved so the last letter finishes exactly at this line's end. */
  const step = count > 1 ? (1 - SWEEP_SPAN) / (count - 1) : 0;
  const span = Math.max(1e-6, end - from);

  return (
    <>
      {words.map((word, wordIndex) => (
        <Fragment key={wordIndex}>
          {wordIndex > 0 ? " " : null}
          <span className="inline-block whitespace-nowrap">
            {word.map((letter, letterIndex) => {
              const start = (offsets[wordIndex] + letterIndex) * step;
              return (
                <animated.span
                  key={letterIndex}
                  className={`inline-block ${letter.italic ? "italic" : ""}`}
                  style={{
                    opacity: to([progress], (value: number) => {
                      const local = (value - from) / span;
                      return (
                        SWEEP_FLOOR +
                        (1 - SWEEP_FLOOR) *
                          smooth((local - start) / SWEEP_SPAN)
                      );
                    }),
                  }}
                >
                  {letter.char}
                </animated.span>
              );
            })}
          </span>
        </Fragment>
      ))}
    </>
  );
};

export interface SweepWordsProps {
  /** Plain copy — a paragraph or a sign-off, not a display line. */
  text: string;
  /** 0→1, normally a scroll position or the state of the block around it. */
  progress: SpringValue<number>;
  /** The slice of that value this paragraph occupies. */
  from?: number;
  to?: number;
}

/**
 * Copy whose **words arrive one after another**, driven by a value rather than
 * by entering the viewport.
 *
 * `RevealWords` is the in-view version and is right where a paragraph's own
 * arrival on screen is the cue. It is wrong inside a pinned block, where every
 * paragraph is technically in view from the moment the block is, and wrong
 * inside a panel that opens on a pointer — in both, the cue is the number the
 * rest of the block already runs on. Same three properties, same stagger; only
 * the clock differs.
 */
export const SweepWords = ({
  text,
  progress,
  from = 0,
  to: end = 1,
}: SweepWordsProps) => {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const step = words.length > 1 ? (1 - SWEEP_SPAN) / (words.length - 1) : 0;
  const span = Math.max(1e-6, end - from);

  return (
    <>
      {words.map((word, index) => {
        const start = index * step;
        const eased = to([progress], (value: number) =>
          smooth(((value - from) / span - start) / SWEEP_SPAN),
        );
        return (
          <Fragment key={index}>
            {index > 0 ? " " : null}
            <animated.span
              className="inline-block whitespace-nowrap"
              style={{
                opacity: eased,
                transform: eased.to(
                  (v) => `translate3d(0, ${((1 - v) * REVEAL.rise).toFixed(4)}em, 0)`,
                ),
                filter: eased.to((v) =>
                  v > 0.995 ? "none" : `blur(${((1 - v) * REVEAL.blur).toFixed(2)}px)`,
                ),
              }}
            >
              {word}
            </animated.span>
          </Fragment>
        );
      })}
    </>
  );
};
