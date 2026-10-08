"use client";

/**
 * Drives the hero card (and its caption group) after the pointer.
 *
 * **The card follows and does not turn.** It used to take a tilt off its own
 * velocity — up to `maxTilt` degrees, eased in and out with the inertia — and
 * on a window into a photograph that reads as the window itself being crooked
 * rather than as the view moving. The lean belongs to block 5's plates, where
 * what turns is a photograph and not a frame; here the card is a hole in the
 * scrim and a hole has no business rotating.
 *
 * The pointer handler only records coordinates — all the arithmetic happens on
 * the shared ticker, once per frame. Transforms are written straight to the DOM
 * rather than through React state, so following costs no re-renders.
 *
 * The card and its captions share **one** position vector. They used to hold
 * separate ones on separate lerps, with a leash bounding how far apart they
 * could get; a single vector makes drift impossible by construction instead of
 * bounding it after the fact.
 *
 * The card's **entrance scale** is folded into the same transform string: the
 * card must carry exactly ONE transform, because any wrapper that had its own
 * would become a backdrop root and clip what its `backdrop-filter` can sample.
 * So the window's opening cannot live on a parent — it has to be written here,
 * multiplied into the follow, on the same frame.
 *
 * 📖 Docs: obsidian/frontend/hero.md
 */

import { RefObject, useEffect, useRef } from "react";
import type { SpringValue } from "@react-spring/web";

import { subscribeToTicker } from "@/lib/animation/ticker";
import { debounce } from "@/utils/math";

import type { HeroTuning } from "./hero.tuning";
import { groupEase, MASK, REVEAL_TRAVEL } from "./hero.geometry";

/** Below this offset delta (px) the card counts as settled. */
const SETTLED_EPSILON = 0.05;

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

interface Vec {
  x: number;
  y: number;
}

export interface UsePointerFollowProps {
  /** Element that defines both the coordinate space and the clamp bounds. */
  boundsRef: RefObject<HTMLElement | null>;
  cardRef: RefObject<HTMLElement | null>;
  captionRefs: RefObject<HTMLElement | null>[];
  /** Section timeline progress, used to fold in the entry translate. */
  progress: SpringValue<number>;
  tuning: HeroTuning;
  /** False on touch, coarse pointers, and reduced motion — card stays centred. */
  enabled: boolean;
}

export const usePointerFollow = ({
  boundsRef,
  cardRef,
  captionRefs,
  progress,
  tuning,
  enabled,
}: UsePointerFollowProps): void => {
  const card = useRef<Vec>({ x: 0, y: 0 });
  const target = useRef<Vec>({ x: 0, y: 0 });
  const isMoving = useRef(false);

  /** Set while gliding home after the pointer leaves. */
  const returning = useRef<{ from: Vec; start: number } | null>(null);

  const bounds = useRef({ width: 0, height: 0, left: 0, top: 0, rem: 16 });

  useEffect(() => {
    const element = boundsRef.current;
    if (!element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      bounds.current = {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    };
    measure();

    // Only the clamp bounds need re-measuring — the window/backdrop registration
    // has no compensation maths to keep in sync, so nothing else reacts here.
    const onResize = debounce(measure, 150);
    window.addEventListener("resize", onResize, { passive: true });

    const cardElement = cardRef.current;

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const { left, top, width, height } = bounds.current;
      const half = cardElement
        ? { x: cardElement.offsetWidth / 2, y: cardElement.offsetHeight / 2 }
        : { x: 0, y: 0 };

      // The card's design position is the centre of the bounds, so the offset
      // is simply cursor − centre, clamped so the card stays fully inside.
      const limitX = Math.max(0, width / 2 - half.x);
      const limitY = Math.max(0, height / 2 - half.y);

      target.current = {
        x: Math.max(
          -limitX,
          Math.min(limitX, event.clientX - left - width / 2),
        ),
        y: Math.max(
          -limitY,
          Math.min(limitY, event.clientY - top - height / 2),
        ),
      };
      returning.current = null;
    };

    const onPointerLeave = () => {
      returning.current = {
        from: { ...card.current },
        start: performance.now(),
      };
      target.current = { x: 0, y: 0 };
    };

    // Without a fine pointer the card stays centred, but the ticker still runs:
    // it owns the card's entry translate, which would otherwise never apply.
    if (enabled) {
      element.addEventListener("pointermove", onPointerMove, { passive: true });
      element.addEventListener("pointerleave", onPointerLeave, {
        passive: true,
      });
    }

    const unsubscribe = subscribeToTicker(
      (time) => {
        const config = tuning;

        const glide = returning.current;
        if (!enabled) {
          card.current = { x: 0, y: 0 };
        } else if (glide) {
          const t = Math.min(1, (time - glide.start) / config.returnMs);
          const eased = easeOutCubic(t);
          card.current = {
            x: glide.from.x * (1 - eased),
            y: glide.from.y * (1 - eased),
          };
          if (t >= 1) returning.current = null;
        } else {
          card.current = {
            x:
              card.current.x +
              (target.current.x - card.current.x) * config.cardLerp,
            y:
              card.current.y +
              (target.current.y - card.current.y) * config.cardLerp,
          };
        }

        const moved =
          Math.abs(target.current.x - card.current.x) > SETTLED_EPSILON ||
          Math.abs(target.current.y - card.current.y) > SETTLED_EPSILON ||
          glide !== null;

        if (moved !== isMoving.current) {
          isMoving.current = moved;
          const hint = moved ? "transform" : "auto";
          if (cardRef.current) cardRef.current.style.willChange = hint;
          captionRefs.forEach((ref) => {
            if (ref.current) ref.current.style.willChange = hint;
          });
        }

        const p = progress.get();

        /*
         * The window's entrance, in the same string — see the note at the top.
         * It scales rather than translating: a lens opening on the footage, not
         * a card being dealt onto it. The follow is written first so the scale
         * applies about the card's own centre wherever the pointer has taken it.
         */
        const opening = groupEase(p, "card");
        const scale = MASK.from + (1 - MASK.from) * opening;

        if (cardRef.current) {
          cardRef.current.style.transform = `translate3d(${card.current.x}px, ${card.current.y}px, 0) scale(${scale.toFixed(4)})`;
        }

        /*
         * The captions still take the **card's** position vector, so the group
         * cannot drift apart: same number, same frame. Only their entry offset
         * is their own — they are a group behind the window in the order now,
         * and they rise into place rather than scaling with it.
         */
        const entry =
          (1 - groupEase(p, "captions")) * REVEAL_TRAVEL * bounds.current.rem;

        captionRefs.forEach((ref) => {
          if (ref.current) {
            ref.current.style.transform = `translate3d(${card.current.x}px, ${card.current.y + entry}px, 0)`;
          }
        });
      },
      () => 0,
    );

    return () => {
      unsubscribe();
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [boundsRef, cardRef, captionRefs, progress, tuning, enabled]);
};
