"use client";

import { useEffect, useRef, useState } from "react";
import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import { scrollTo } from "@/utils/scroll-to";
import { useShallow } from "zustand/react/shallow";

/**
 * Whether this document has already been sent to the top.
 *
 * It lives on `window`, not in a module variable, because the effect below
 * re-runs more often than the page actually loads: React Strict Mode mounts it
 * twice, and every Fast Refresh re-runs it too — and a module-level flag is
 * reset by the refresh itself. A fresh document gets a fresh `window`, which is
 * exactly the lifetime we want.
 */
const SCROLL_RESET_FLAG = "__scrollLayoutDidReset";

const hasResetScroll = (): boolean =>
  Boolean((window as Window & { [SCROLL_RESET_FLAG]?: boolean })[SCROLL_RESET_FLAG]);

const markScrollReset = (): void => {
  (window as Window & { [SCROLL_RESET_FLAG]?: boolean })[SCROLL_RESET_FLAG] = true;
};

export function ScrollLayout({ children }: { children: React.ReactNode }) {
  // Server-safe rendering
  return (
    <div className="scroll-layout">
      {/* Static content that can be rendered on server */}
      <div className="scroll-layout-content">{children}</div>

      {/* Client-only functionality */}
      <ScrollController />
    </div>
  );
}

function ScrollController() {
  const isEnableScroll = useScroll((state) => state.isEnableScroll);
  const [hash, setHash] = useState<string>("");
  const [lenis, setLenis] = useScroll(
    useShallow((state) => [state.lenis, state.setLenis]),
  );
  const pathname = usePathname();
  const savedPathname = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") return;

    // The browser restores the previous scroll position on reload, and it does
    // so on the `load` event — i.e. AFTER this effect has already reset to the
    // top and handed Lenis a scroll of 0. The page then jumps down while Lenis
    // still believes it is at the top, and the first wheel gesture is spent
    // resyncing the two instead of driving anything. Opting out of restoration
    // keeps them in step from the first frame.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    // Only once per document. Re-running this on a Strict Mode remount or a
    // Fast Refresh would yank the reader back to the top mid-scroll — which
    // looks exactly like the animation rolling itself back.
    if (!hasResetScroll()) {
      window.scrollTo(0, 0);
      markScrollReset();
    }

    /**
     * `lerp`, not `duration`.
     *
     * Lenis defaults to a **duration** model: every wheel notch starts a fresh
     * 1.2-second ease-out towards a target. Notches arrive far faster than that,
     * so each one restarts the curve from wherever the last had got to, and the
     * page is permanently in the slow tail of an animation that never finishes.
     * That is what reads as the scroll braking — measured, it is not frames:
     * wheeling through the whole page holds a 16.7ms median with nothing over
     * 32ms, so nothing is being dropped. It is the easing.
     *
     * `lerp` is the other model: close a twelfth of the remaining distance every
     * frame, with no fixed length. Response is ~8 frames (~130ms) instead of
     * 1200, the page tracks the wheel closely, and the smoothing that made the
     * scroll worth having in the first place is still there — the
     * scroll-scrubbed blocks all read off `scrollY`, so they get the same
     * smoothing for free.
     */
    const lenis = new Lenis({
      smoothWheel: true,
      /*
       * 0.12 → 0.085. Twelve percent of the remaining distance a frame answers
       * the wheel in about eight frames, which is responsive and, on a page
       * where every block is now a scroll-linked composition, reads as barely
       * smoothed at all. At 0.085 it takes about twelve — still a third of the
       * 1.2-second default's tail, but with enough glide that a wheel notch
       * arrives rather than lands.
       */
      lerp: 0.085,
      /*
       * Touch is smoothed too. Without it a phone falls back to the platform's
       * own momentum, which is a different feel halfway down the same page —
       * and the scroll-scrubbed blocks read `scrollY`, so they inherit whatever
       * the touch path does.
       */
      syncTouch: true,
    });
    (window as typeof window & { lenis: Lenis }).lenis = lenis;
    setLenis(lenis);

    let rafId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    return () => {
      // Cancel the loop before destroying Lenis — otherwise it keeps calling
      // `raf` on a destroyed instance after unmount/HMR.
      cancelAnimationFrame(rafId);
      lenis.destroy();
      setLenis(null);
    };
  }, [setLenis]);

  useEffect(() => {
    if (isEnableScroll) {
      lenis?.start();
    } else {
      lenis?.stop();
    }
  }, [isEnableScroll, lenis]);

  useEffect(() => {
    if (lenis && hash) {
      setTimeout(() => {
        scrollTo(hash, true);
      }, 300);
    }
  }, [lenis, hash]);

  useEffect(() => {
    if (savedPathname.current !== pathname) {
      savedPathname.current = pathname;
      if (pathname.includes("#")) {
        const hash = pathname.split("#").pop();
        if (hash) {
          setHash(hash);
        }
      }
    }
  }, [pathname, setHash]);

  return null; // This component doesn't render anything visible
}
