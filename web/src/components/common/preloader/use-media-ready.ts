"use client";

/**
 * Tracks how much of a page's hero media is actually ready to be seen yet.
 *
 * It watches the **rendered `<img>` elements**, not a list of URLs. Those images
 * go through the Next image optimiser, so their real request is
 * `/_next/image?url=…&w=…&q=…` — preloading the raw `/assets/**` path would warm
 * a different cache entry and report ready while the visible image was still
 * decoding. Matching on filename covers both spellings, encoded or not.
 *
 * Polling rather than binding load handlers keeps this correct when an image is
 * already complete from cache before this hook runs, which is the common case on
 * a second visit.
 *
 * It polls on `setInterval`, deliberately **not** on the shared rAF ticker:
 * `requestAnimationFrame` stops in a backgrounded tab, which would freeze both
 * the readiness check and its own timeout and leave the card up over a page that
 * had finished loading. `setInterval` is throttled there rather than halted, so
 * the card is already gone when the reader comes back.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import { useEffect, useState } from "react";

/** How often to re-check, in ms. Loading is not a per-frame concern. */
const POLL_INTERVAL = 100;

export interface MediaReadyState {
  /** 0–1 across the tracked images. */
  progress: number;
  /** True once every image is decoded, or the timeout has elapsed. */
  ready: boolean;
}

const isPainted = (image: HTMLImageElement): boolean =>
  image.complete && image.naturalWidth > 0;

/**
 * The bar for a video, and it is deliberately not "downloaded".
 *
 * `HAVE_FUTURE_DATA` (3) means there are frames for the current position *and*
 * at least one after it — the clip can be painted and can start playing. Waiting
 * for `HAVE_ENOUGH_DATA` would hold the card on a several-megabyte file the
 * reader is about to watch stream anyway, and waiting for the `load` event would
 * hold it on the whole thing.
 *
 * The important half is that this matches what the hero does with the same
 * element: it calls `play()` the moment this reports ready, so the two agree
 * about what "loaded" means rather than each guessing.
 */
const HAVE_FUTURE_DATA = 3;

const isPlayable = (video: HTMLVideoElement): boolean =>
  video.readyState >= HAVE_FUTURE_DATA;

/** Anything that has to be decoded before the card can lift. */
const VIDEO_PATTERN = /\.(mp4|webm|mov)$/i;

/**
 * @param filenames - substrings identifying the media to wait for; anything
 *                    ending `.mp4`/`.webm`/`.mov` is looked for among the
 *                    document's `<video>` elements rather than its images
 * @param timeoutMs - never hold the page longer than this, whatever happens
 */
export const useMediaReady = (
  filenames: readonly string[],
  timeoutMs = 8000,
): MediaReadyState => {
  const [state, setState] = useState<MediaReadyState>({
    progress: 0,
    ready: filenames.length === 0,
  });

  // Join rather than pass the array: a literal prop would be a new reference on
  // every render and restart the subscription each time.
  const key = filenames.join("|");

  useEffect(() => {
    const wanted = key ? key.split("|") : [];
    if (wanted.length === 0) {
      setState({ progress: 1, ready: true });
      return;
    }

    const startedAt = performance.now();
    let best = 0;

    const check = () => {
      const painted = wanted.filter((name) =>
        VIDEO_PATTERN.test(name)
          ? Array.from(document.querySelectorAll("video")).some(
              (video) => video.currentSrc.includes(name) && isPlayable(video),
            )
          : Array.from(document.images).some(
              (image) => image.src.includes(name) && isPainted(image),
            ),
      ).length;

      // Never let the count fall. The Next optimiser re-requests an image at a
      // different `w=` when the layout settles, and a swapped `src` reports
      // `complete === false` again — which would run the counter backwards
      // after it had already reached 100.
      best = Math.max(best, painted);

      const timedOut = performance.now() - startedAt > timeoutMs;
      const ready = best === wanted.length || timedOut;

      setState({ progress: best / wanted.length, ready });

      if (ready) clearInterval(timer);
    };

    // Check straight away: on a repeat visit every image can already be decoded
    // before the first tick would land.
    const timer = setInterval(check, POLL_INTERVAL);
    check();

    return () => clearInterval(timer);
  }, [key, timeoutMs]);

  return state;
};
