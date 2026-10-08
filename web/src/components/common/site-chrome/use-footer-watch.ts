"use client";

/**
 * Tells the store when the footer is on screen.
 *
 * An `IntersectionObserver`, not a scroll handler: this is a "yes or no" that
 * changes twice in a page, and asking the browser to tell us costs nothing per
 * frame. The shared ticker is for values that change *every* frame; a boolean
 * that flips at a boundary is exactly what the observer exists for.
 *
 * The margin pulls the trigger line **up by the height of the chrome plus its
 * page margin**, so the header is already gone by the time the footer's top
 * edge would slide under it, rather than crossing it on the way past.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import { useEffect } from "react";
import type { RefObject } from "react";

import { useChrome } from "./chrome-store";

/** Roughly the wordmark's line box plus `top-page`, in px at the 1440 base. */
const CHROME_CLEARANCE = 72;

export const useFooterWatch = (ref: RefObject<HTMLElement | null>): void => {
  const setFooterInView = useChrome((state) => state.setFooterInView);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setFooterInView(Boolean(entry?.isIntersecting)),
      { rootMargin: `-${CHROME_CLEARANCE}px 0px 0px 0px`, threshold: 0 },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      /*
       * Unmounting the footer — a route change — leaves the flag true and the
       * chrome hidden on a page that has no footer to justify it.
       */
      setFooterInView(false);
    };
  }, [ref, setFooterInView]);
};
