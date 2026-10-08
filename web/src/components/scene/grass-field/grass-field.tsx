// 📖 Docs: obsidian/frontend/components/scene.md
"use client";

/**
 * The grass field WebGL leaf.
 *
 * A client leaf by necessity — it owns a canvas, a WebGL context and pointer
 * listeners. Everything above it stays a Server Component (hard rule #7); mount
 * it through `LazyGrassField` so `three` lands in its own chunk.
 *
 * Per-frame work goes through the app-wide ticker rather than a private
 * `requestAnimationFrame`, so the page runs one loop no matter how many
 * animated things are on it — see obsidian/frontend/animation-system.md.
 *
 * Device budgets follow `src/lib/scene/device.ts` (the optimize-3d-scene skill,
 * ADR-0042): the tier is read at construction, re-read on a real viewport
 * change, and the loop only draws while the canvas is visible.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeToTicker } from "@/lib/animation/ticker";
import {
  COARSE_POINTER_QUERY,
  deviceTier,
  frameBudgetMs,
  isCoarsePointer,
  sceneShouldFreeze,
  wantsPointer,
  type DeviceTier,
} from "@/lib/scene/device";

import {
  createGrassScene,
  type GrassSceneHandle,
  type SceneColorControl,
  type SceneNumberControl,
} from "./create-grass-scene";

// The tuning panel is a development tool: it is only fetched when `controls`
// is set, so it never ships in the page's scene chunk otherwise.
const SceneControls = dynamic(
  () => import("./scene-controls").then((m) => ({ default: m.SceneControls })),
  { ssr: false, loading: () => null },
);

export interface GrassFieldProps {
  /** Preserve the scene while another hero view is showing, without drawing. */
  active?: boolean;
  /** Classes for the canvas element itself. */
  className?: string;
  /** Show the live tuning panel (development only — it is lazy-loaded). */
  controls?: boolean;
  /** Fraction (0–1) of the scene's assets that have loaded. */
  onLoadProgress?: (fraction: number) => void;
  /**
   * The first frame with every asset in it has been drawn — or the scene could
   * not start at all (no WebGL). Either way there is nothing left to wait for.
   */
  onReady?: () => void;
  /** No WebGL context could be created: show a static fallback instead. */
  onUnavailable?: () => void;
  /** Flip to `true` to blow one strong gust across the field (it then calms). */
  gust?: boolean;
}

/** Frames kept drawing after the entrance before a freeze-tier scene stops. */
const FREEZE_SETTLE_MS = 1200;
/** How long the reveal gust takes to die away (attack + ~3 × calm). */
const GUST_SETTLE_MS = 8000;

export function GrassField({
  active = true,
  className,
  controls = false,
  onLoadProgress,
  onReady,
  onUnavailable,
  gust = false,
}: GrassFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GrassSceneHandle | null>(null);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const freezeRef = useRef(false);
  const revealedAtRef = useRef<number | null>(null);
  const [colorControls, setColorControls] = useState<SceneColorControl[]>([]);
  const [numberControls, setNumberControls] = useState<SceneNumberControl[]>([]);
  // Latest callbacks, read through refs so a parent re-render never rebuilds
  // the scene.
  const onLoadProgressRef = useRef(onLoadProgress);
  const onReadyRef = useRef(onReady);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onLoadProgressRef.current = onLoadProgress;
    onReadyRef.current = onReady;
    onUnavailableRef.current = onUnavailable;
  }, [onLoadProgress, onReady, onUnavailable]);

  // Reads the scene through a ref rather than closing over it, so the panel
  // survives the effect re-running (Strict Mode mounts it twice in dev).
  const handleColorChange = useCallback((key: string, hex: string) => {
    sceneRef.current?.setColor(key, hex);
  }, []);

  const handleNumberChange = useCallback((key: string, value: number) => {
    sceneRef.current?.setNumber(key, value);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let tier: DeviceTier = deviceTier();
    let scene: GrassSceneHandle;
    try {
      scene = createGrassScene(canvas, {
        tier,
        onLoadProgress: (fraction) => onLoadProgressRef.current?.(fraction),
        onReady: () => onReadyRef.current?.(),
      });
      sceneRef.current = scene;
      setColorControls(scene.colorControls);
      setNumberControls(scene.numberControls);
    } catch {
      // No WebGL, or context creation refused.
      onUnavailableRef.current?.();
      onReadyRef.current?.();
      return;
    }

    /* ------------------------------------------------------------ pointer */

    const handlePointerMove = (event: PointerEvent) =>
      scene.setPointer(event.clientX, event.clientY);
    const handlePointerLeave = () => scene.parkPointer();
    let pointerBound = false;
    // Bound or unbound per tier — never "attach and ignore" on a touch device.
    const setPointerBinding = (bind: boolean): void => {
      if (bind === pointerBound) return;
      pointerBound = bind;
      if (bind) {
        canvas.addEventListener("pointermove", handlePointerMove, { passive: true });
        canvas.addEventListener("pointerleave", handlePointerLeave, { passive: true });
      } else {
        canvas.removeEventListener("pointermove", handlePointerMove);
        canvas.removeEventListener("pointerleave", handlePointerLeave);
        scene.parkPointer();
      }
    };
    setPointerBinding(wantsPointer(tier));

    /* -------------------------------------------------------------- tiers */

    let budget = frameBudgetMs(tier);
    freezeRef.current = sceneShouldFreeze(tier);
    const retune = (nextTier: DeviceTier): void => {
      tier = nextTier;
      budget = frameBudgetMs(tier);
      freezeRef.current = sceneShouldFreeze(tier);
      setPointerBinding(wantsPointer(tier));
      scene.retune(tier);
    };

    /* ------------------------------------------------------------- resize */

    // rAF-coalesced, on every tier. On a coarse pointer a height-only change is
    // the iOS URL bar collapsing: the canvas is `lvh`-sized, so nothing is
    // uncovered and rebuilding the framebuffer would flash the whole scene.
    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    let resizeFrame: number | null = null;
    const handleViewportChange = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const heightOnly = width === lastWidth && height !== lastHeight;
      lastWidth = width;
      lastHeight = height;
      if (heightOnly && isCoarsePointer()) return;
      const nextTier = deviceTier();
      if (nextTier !== tier) retune(nextTier);
      else scene.resize();
    };
    const handleResize = (): void => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        handleViewportChange();
      });
    };
    const pointerQuery =
      typeof window.matchMedia === "function" ? window.matchMedia(COARSE_POINTER_QUERY) : null;
    window.addEventListener("resize", handleResize, { passive: true });
    window.addEventListener("orientationchange", handleResize, { passive: true });
    pointerQuery?.addEventListener("change", handleResize);

    /* --------------------------------------------------------- visibility */

    // Draw only while the tab is visible and the canvas is on (or within a
    // viewport of) the screen.
    let onScreen = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(canvas);

    const unsubscribe = subscribeToTicker(
      () => {
        if (document.hidden || !onScreen || !activeRef.current) return;
        // Freeze tier: keep drawing through the entrance, then hold the last
        // settled frame — WebGL keeps it on the canvas at no cost.
        const revealedAt = revealedAtRef.current;
        if (
          freezeRef.current &&
          revealedAt !== null &&
          performance.now() - revealedAt > FREEZE_SETTLE_MS
        ) {
          return;
        }
        scene.render();
      },
      () => budget,
    );

    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      pointerQuery?.removeEventListener("change", handleResize);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      setPointerBinding(false);
      sceneRef.current = null;
      scene.dispose();
    };
  }, []);

  useEffect(() => {
    if (!gust) return;
    // A freeze-tier device (reduced motion, energy saver) skips the gust and
    // settles straight away; everyone else gets the gust and keeps drawing.
    if (freezeRef.current) {
      revealedAtRef.current = performance.now();
      return;
    }
    sceneRef.current?.gust();
    revealedAtRef.current = performance.now() + GUST_SETTLE_MS;
  }, [gust]);

  return (
    <>
      <canvas ref={canvasRef} className={className} aria-hidden="true" />
      {controls && (
        <SceneControls
          controls={colorControls}
          numbers={numberControls}
          onColorChange={handleColorChange}
          onNumberChange={handleNumberChange}
        />
      )}
    </>
  );
}
