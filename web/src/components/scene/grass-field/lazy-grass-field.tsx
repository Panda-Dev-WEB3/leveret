// 📖 Docs: obsidian/frontend/components/scene.md
"use client";

/**
 * Lazy client wrapper for the grass field.
 *
 * `dynamic({ ssr: false })` does two jobs: it keeps `three` (~600 KB raw) out of
 * the page's first-load JS manifest, fetching it only when the scene actually
 * mounts, and it keeps the canvas off the server render — the scene needs
 * `window` and a WebGL context, neither of which exists there.
 *
 * Mirrors the `LazyCookie` pattern in `components/common/Cookie/`.
 */

import dynamic from "next/dynamic";

import type { GrassFieldProps } from "./grass-field";

const GrassField = dynamic(
  () => import("./grass-field").then((m) => ({ default: m.GrassField })),
  { ssr: false, loading: () => null },
);

export function LazyGrassField(props: GrassFieldProps) {
  return <GrassField {...props} />;
}
