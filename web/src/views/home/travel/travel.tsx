"use client";

/**
 * How We Travel — four ways of travelling, as a column accordion.
 *
 * Point at a column (or tap it, or tab to it, or arrow across) and its
 * photograph slides **up** into view while the last one slides up and out — one
 * continuous upward conveyor, one in and one out, never two crossing. The copy
 * swaps on the same movement, the open column widens, and the three others turn
 * back down to the strength the file draws them at.
 *
 * **This block used to be scrolled.** It was 400vh of track with the strip
 * pinned inside it and a five-stop keyframe table read by a pure
 * `poseAt(progress)`; every frame was an interpolation of the scroll and there
 * was no "current panel" anywhere. It is now one screen with one piece of state,
 * which is the whole of the difference: the reader chooses a panel instead of
 * scrolling past four of them, and the page is four screens shorter for it.
 *
 * Nothing about the *content* moved — the same four names, sentences,
 * handwritten lines and photographs, and the same heading over them.
 *
 * 📖 Docs: obsidian/frontend/travel.md
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import Image from "next/image";
import { animated, useSpring } from "@react-spring/web";

import {
  RevealTitle,
  RevealWords,
  SweepWords,
} from "@/components/ui/reveal-text";
import { SegmentedText } from "@/components/ui/segmented-text";
import { subscribeToTicker } from "@/lib/animation/ticker";

import {
  CLASS,
  HEAD_CUE,
  MEDIA_TRAVEL,
  STACK,
  STACK_PARALLAX,
  NARROW_QUERY,
  PANEL_SIZES,
  SLIDE,
  toRestDim,
  toShare,
  toWeight,
  WIDEN,
} from "./travel.geometry";
import type { TravelContent, TravelPanel } from "./travel.types";

/** The panel open on arrival, exactly as the file's second frame draws it. */
const START = 0;

/**
 * True once the section has risen far enough to be looked at.
 *
 * A latch off the shared ticker rather than an `IntersectionObserver`, for the
 * reason `HEAD_CUE` gives: this section is pulled up a whole screen so it can
 * slide over block 3, so its **box** is in the viewport a screen before the
 * section is. "Intersecting" answers the wrong question here — it was answering
 * it a screen early, and the heading spent its entire reveal underneath another
 * block. A rect read per frame until it fires, and then nothing.
 */
const useRisen = (ref: RefObject<HTMLElement | null>): boolean => {
  const [risen, setRisen] = useState(false);
  const latched = useRef(false);

  useEffect(() => {
    if (latched.current) return;
    const element = ref.current;
    if (!element) return;

    return subscribeToTicker(
      () => {
        if (latched.current) return;
        if (element.getBoundingClientRect().top > window.innerHeight * HEAD_CUE) {
          return;
        }
        latched.current = true;
        setRisen(true);
      },
      () => 0,
    );
  }, [ref]);

  return risen;
};

/** SSR-safe read of a media query. */
const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );

/**
 * A device with a pointer that can hover.
 *
 * Read once, not per event: on a touch screen the browser synthesises a
 * `pointerenter` on tap, and reacting to it would open a panel the reader was
 * only scrolling past. Tap, focus and the arrow keys all still work there — the
 * `click` handler is what a tap lands on.
 */
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * Where a sliding layer is, on the conveyor.
 *
 * `below` is the resting place of every layer that is not showing: under the
 * floor, ready to come up. Nothing ever goes there by animating — it is only
 * ever *put* there.
 */
type Phase = "below" | "in" | "out";

/**
 * The upward conveyor, for one layer.
 *
 * One rule: **a layer always enters from below and always leaves through the
 * top.** So the position is not "open ? 0 : below" — a layer that is leaving has
 * to reach the top before it is put back under the floor, and that return has to
 * be silent or the reader would watch it fall back down.
 *
 * The phase is derived **during render** from `open`, not in an effect, and that
 * is load-bearing rather than stylistic: an effect only runs when its
 * dependencies change, so a spring re-created underneath it — a Fast Refresh
 * does exactly this — would sit at its initial value with no dependency change
 * to bring it back, and the layer would simply never arrive. Measured: after a
 * hot reload the open panel's copy stayed under the floor until another panel
 * was clicked. A target re-applied every render cannot get stuck that way.
 *
 * > [!important] Re-opening a panel mid-exit **reverses**; it does not reset
 * > There used to be a fourth phase for this. Point at a column, leave before it
 * > has arrived, come back: the layer is above the frame on its way out, and the
 * > rule above says a layer never comes *down* into place — so it was dropped
 * > below with `immediate` for a frame and sent up again, which is what the
 * > reference's "kill the transition, move it, force a reflow, put it back"
 * > buys.
 * >
 * > It buys a **whole panel height of snap** in the middle of a movement the
 * > reader is watching, and switching quickly is nothing but that case. The rule
 * > it protects is about how a layer *arrives*, and a layer that is being pulled
 * > back is not arriving — it is the same layer changing its mind, and coming
 * > back the way it left is the honest picture of that. With a spring it also
 * > keeps its velocity through the turn, so there is no stop at the reversal.
 * >
 * > What is left is three phases, and `below` is the only immediate one — a park
 * > off the top of a box that clips, so nobody ever sees it happen.
 */
const useConveyor = (open: boolean, travel: number, interactive: boolean) => {
  const [phase, setPhase] = useState<Phase>(open ? "in" : "below");
  const [wasOpen, setWasOpen] = useState(open);

  /*
   * Adjusting state during render — React's own documented alternative to an
   * effect for state that is derived from props. It re-renders immediately, so
   * nothing downstream ever sees the stale phase.
   */
  if (open !== wasOpen) {
    setWasOpen(open);
    setPhase(open ? "in" : phase === "below" ? "below" : "out");
  }

  const { y } = useSpring({
    y: phase === "in" ? 0 : phase === "out" ? -travel : travel,
    /* `below` is the park, and it is off the top of a clipped box either way. */
    immediate: phase === "below" || !interactive,
    config: SLIDE,
    onRest: ({ finished }) => {
      /*
       * **Only a finished `out` parks the panel below.**
       *
       * react-spring calls this for an interrupted animation too, with
       * `finished: false` — and this closure still has `phase === "out"` from
       * the render that made it. So re-opening a panel mid-exit used to park it
       * *below* a frame after it had been told to come back, which is a snap of
       * a whole panel height in the middle of a movement the reader is watching.
       */
      if (finished && phase === "out") setPhase("below");
    },
  });

  return y;
};

interface PanelProps {
  panel: TravelPanel;
  index: number;
  open: number;
  interactive: boolean;
  widen: number;
  /** False on a touch screen, where a tap synthesises `pointerenter` too. */
  canHover: boolean;
  onOpen: (index: number) => void;
  onKey: (event: KeyboardEvent<HTMLDivElement>, index: number) => void;
  register: (index: number, element: HTMLDivElement | null) => void;
}

/**
 * One column: a resting photograph, a sliding one over it, and its name.
 *
 * The photograph is on screen twice on purpose — see `CLASS.rest`. The reference
 * this is built from has bare paper under its sliding art, which cannot be right
 * here: the four photographs *are* the content, and three of them going blank
 * between one pointer move and the next would take the block's picture off the
 * screen. So the resting copy stays at the strength the file draws a shut panel,
 * and the conveyor carries the same frame at full strength.
 */
const Panel = ({
  panel,
  index,
  open,
  interactive,
  widen,
  canHover,
  onOpen,
  onKey,
  register,
}: PanelProps) => {
  const isOpen = index === open;
  const y = useConveyor(isOpen, MEDIA_TRAVEL, interactive);

  /*
   * `lit` is not derived from `dim` any more, and that is the one place the new
   * model reads differently from the old. It used to be: the photograph's own
   * strength, remapped — because under a scroll the picture *was* the state. The
   * picture is now split across two layers, and the resting one is dim whether
   * or not the panel is open, so the question "is this panel lit" has a simpler
   * answer than any opacity: it is open.
   */
  const spring = useSpring({
    share: toShare(toWeight(isOpen, widen), widen),
    dim: toRestDim(index, open),
    lit: isOpen ? 1 : 0,
    open: isOpen ? 1 : 0,
    config: SLIDE,
    immediate: !interactive,
  });

  /*
   * How tall this panel's copy is, in px, measured rather than stated: the four
   * sentences are written to four different measures and wrap to different line
   * counts, so each name has to rise by its own copy's height. A
   * `ResizeObserver` rather than one reading, because the number changes when
   * the display face finishes loading and again on every resize.
   */
  const copyRef = useRef<HTMLDivElement>(null);
  const [copyHeight, setCopyHeight] = useState(0);
  useEffect(() => {
    const element = copyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setCopyHeight(Math.round(entry?.contentRect.height ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <animated.div
      ref={(element: HTMLDivElement | null) => {
        /* A callback ref that returns a value is read by React 19 as a cleanup
           function, and an arrow with an expression body returns one. */
        register(index, element);
      }}
      role="tab"
      aria-selected={isOpen}
      aria-label={panel.title.map(segment=>segment.text).join('')}
      tabIndex={0}
      className={`${CLASS.panel} ${CLASS.focusRing} ${
        index === 0 ? CLASS.panelLead : CLASS.panelFollow
      }`}
      style={
        {
          "--b4-share": spring.share,
          ...(index === 0 ? { "--b4-lit": spring.lit } : null),
        } as CSSProperties
      }
      onPointerEnter={canHover ? () => onOpen(index) : undefined}
      onClick={() => onOpen(index)}
      onFocus={() => onOpen(index)}
      onKeyDown={(event) => onKey(event, index)}
    >
      {/* The ground: the same photograph, turned down, never moving. */}
      <animated.div className={CLASS.rest} style={{ opacity: spring.dim }}>
        <Image
          src={panel.media.src}
          alt=""
          fill
          sizes={PANEL_SIZES}
          className={`object-cover ${index === 0 ? CLASS.photoLead : ""}`}
        />
      </animated.div>

      {/* The layer that slides, at full strength, with the file's two veils. */}
      <animated.div
        className={CLASS.media}
        style={{ transform: y.to((value) => `translateY(${value}%)`) }}
      >
        <Image
          src={panel.media.src}
          alt=""
          fill
          sizes={PANEL_SIZES}
          className={`object-cover ${index === 0 ? CLASS.photoLead : ""}`}
        />
        {/* Two layers because the file has two, each one thing: the fall from
            the top over the full height, and the rise from the foot over 521 of
            800. */}
        <div className={CLASS.veilTop} aria-hidden />
        <div className={CLASS.veilFoot} aria-hidden />
      </animated.div>

      {/*
        The foot: the name, and the copy that comes out from under it. Both read
        the one `--b4-open` set here, so the lift and the rise are the same
        movement rather than two that happen to overlap.
      */}
      <animated.div
        className={CLASS.foot}
        style={
          {
            "--b4-open": spring.open,
            "--b4-copy-height": `${copyHeight}px`,
          } as CSSProperties
        }
      >
        <h3 className={CLASS.heading}>
          <SegmentedText segments={panel.title} />
        </h3>

        <div className={CLASS.copyClip}>
          <div className={CLASS.copy} ref={copyRef} aria-hidden={!isOpen}>
            {/*
              The sentence arrives a word at a time on the panel's own
              `open` — the same number the name's lift and the copy's rise
              already run on, so all three are one movement rather than a
              block of text sliding up with nothing happening inside it.
            */}
            <p
              className={CLASS.body}
              style={
                { "--b4-copy": `${panel.bodyWidth / 16}rem` } as CSSProperties
              }
            >
              <SweepWords text={panel.body} progress={spring.open} />
            </p>
            <p className={CLASS.signOff}>
              <SweepWords text={panel.signOff} progress={spring.open} />
            </p>
          </div>
        </div>
      </animated.div>
    </animated.div>
  );
};

/**
 * One card in the narrow stack: a photograph that drifts, and its copy.
 *
 * No open state, no conveyor, no measured copy height — see `STACK`. The only
 * moving part is the photograph, and it is written straight to the DOM off the
 * shared ticker rather than through a spring: it is a pure function of where the
 * card is on screen, so there is nothing for a spring to settle onto.
 */
const StackedCard = ({
  panel,
  animate,
}: {
  panel: TravelPanel;
  animate: boolean;
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!animate) return;
    const card = cardRef.current;
    const photo = photoRef.current;
    if (!card || !photo) return;

    return subscribeToTicker(
      () => {
        const rect = card.getBoundingClientRect();
        const { innerHeight } = window;
        /*
         * −1 when the card is just below the fold, +1 when it is just above it,
         * 0 when its centre is the screen's. Both halves of the denominator are
         * needed: without the card's own height a tall card would run past ±1
         * long before it left.
         */
        const centre = rect.top + rect.height / 2;
        const span = (innerHeight + rect.height) / 2;
        const t = Math.max(-1, Math.min(1, (centre - innerHeight / 2) / span));
        photo.style.transform = `translate3d(0, ${(t * rect.height * STACK_PARALLAX).toFixed(1)}px, 0)`;
      },
      () => 0,
    );
  }, [animate]);

  return (
    <div className={STACK.card} ref={cardRef}>
      <div className={STACK.photo} ref={photoRef}>
        <Image
          src={panel.media.src}
          alt={panel.media.alt}
          fill
          sizes={PANEL_SIZES}
          className="object-cover"
        />
      </div>

      <div className={CLASS.veilTop} aria-hidden />
      <div className={CLASS.veilFoot} aria-hidden />

      <div className={STACK.foot}>
        <h3 className={STACK.heading}>
          <SegmentedText segments={panel.title} />
        </h3>
        <p className={CLASS.body}>{panel.body}</p>
        <p className={CLASS.signOff}>{panel.signOff}</p>
      </div>
    </div>
  );
};

export interface TravelProps {
  content: TravelContent;
}

export const Travel = ({ content }: TravelProps) => {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const canHover = useMediaQuery(HOVER_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const widen = narrow ? WIDEN.narrow : WIDEN.wide;

  /**
   * Which panel is open — the block's whole state, where there used to be a
   * scroll position and a five-stop table.
   *
   * It starts at `-1` rather than at `START` so that the opening slide is a
   * slide: every layer is below the floor on first paint and the first panel
   * rises into place, which is what the reference's two-frame delay before
   * `setActive(0)` buys. Here one state change after mount does the same, and
   * the effect below is that change.
   */
  const [open, setOpen] = useState(-1);
  useEffect(() => setOpen(START), []);

  const panels = useRef<(HTMLDivElement | null)[]>([]);
  /*
   * A block body, not an expression: a callback ref that *returns* something is
   * read by React 19 as a cleanup function, and an assignment expression returns
   * the value it assigned.
   */
  const register = useCallback((index: number, element: HTMLDivElement | null) => {
    panels.current[index] = element;
  }, []);

  const count = content.panels.length;

  const focusPanel = useCallback((index: number) => {
    panels.current[index]?.focus();
  }, []);

  /**
   * Left/Up and Right/Down walk the strip and take focus with them, wrapping at
   * both ends — which is what `role="tab"` promises a keyboard reader.
   *
   * The selection is set here **as well as** left to the focus handler, and the
   * belt and braces are deliberate: `focus()` only dispatches an event while the
   * document itself has focus, so a panel moved to by a key in a window that has
   * just been restored would otherwise widen a beat late or not at all. Setting
   * it directly costs one no-op state write in the ordinary case.
   */
  const onKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !back) return;
      event.preventDefault();
      const next = forward ? (index + 1) % count : (index - 1 + count) % count;
      setOpen(next);
      focusPanel(next);
    },
    [count, focusPanel],
  );

  const interactive = !prefersReducedMotion;

  /* The heading waits for the section to be seen — see `useRisen`. */
  const sectionRef = useRef<HTMLElement>(null);
  const risen = useRisen(sectionRef);
  const headOpen = !interactive || risen;

  /**
   * The heading group only fades on a phone, where it floats on the first
   * photograph and that photograph is only tall enough to carry it while the
   * first panel is open. `CLASS.header` holds a floor of 1 above the phone
   * range, so this value is ignored everywhere else — it is written on the same
   * clock as everything else so that where it *does* apply it moves with the
   * panel rather than switching under it.
   */
  const { headLit } = useSpring({
    headLit: (open < 0 ? START : open) === START ? 1 : 0,
    config: SLIDE,
    immediate: !interactive,
  });

  /*
   * Below the desktop base the block is a stack rather than an accordion — see
   * `STACK` for why the interaction is the part that does not survive the width.
   * A whole separate tree, not a pile of `max-lg:` overrides: the two share
   * their content and almost nothing else, and pretending otherwise is how a
   * responsive layout becomes unreadable in both directions.
   */
  if (narrow) {
    return (
      <section
        aria-label="Product families"
        className={STACK.section}
        ref={sectionRef}
      >
        <div className={STACK.header}>
          <h2 className={CLASS.title}>
            <RevealTitle
              segments={content.title}
              animate={interactive}
              open={headOpen}
            />
          </h2>
          <p className={CLASS.subtitle}>
            <RevealWords
              text={content.subtitle}
              animate={interactive}
              open={headOpen}
            />
          </p>
        </div>

        <div className={STACK.cards}>
          {content.panels.map((panel) => (
            <StackedCard key={panel.id} panel={panel} animate={interactive} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Product families"
      className={CLASS.section}
      ref={sectionRef}
    >
      <div
        className={CLASS.strip}
        role="tablist"
        aria-label="Product families"
        aria-orientation="horizontal"
      >
        {content.panels.map((panel, index) => (
          <Panel
            key={panel.id}
            panel={panel}
            index={index}
            open={open < 0 ? START : open}
            interactive={interactive}
            widen={widen}
            canHover={canHover}
            onOpen={setOpen}
            onKey={onKey}
            register={register}
          />
        ))}
      </div>

      {/*
        The heading group, over the strip. It only fades on a phone, where it
        floats on the first photograph and that photograph is only tall enough
        to carry it while the first panel is open — the floor holds it at 1
        everywhere else. Same rule as before; what drives it is now the open
        panel rather than a scroll position.
      */}
      <animated.div
        className={CLASS.header}
        style={{ "--b4-head-lit": headLit } as CSSProperties}
      >
        <h2 className={CLASS.title}>
          <RevealTitle
            segments={content.title}
            animate={interactive}
            open={headOpen}
          />
        </h2>
        <p className={CLASS.subtitle}>
          <RevealWords
            text={content.subtitle}
            animate={interactive}
            open={headOpen}
          />
        </p>
      </animated.div>

    </section>
  );
};
