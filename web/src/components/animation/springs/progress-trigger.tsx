// 📖 Docs: obsidian/frontend/components/animation-springs.md
/**
 * @fileoverview The trigger-position vocabulary for scroll-linked progress.
 *
 * A `TriggerPos` is read as "<point on the element> <point on the viewport>":
 * `"top bottom"` fires when the element's top reaches the bottom of the screen,
 * `"bottom top"` when its bottom reaches the top. A start and an end position
 * together define the window a progress value runs 0 → 1 across.
 *
 * This file used to also export a `ProgressTrigger` component that wrapped the
 * hook in a rendered tag. Nothing on the site used it — the three scroll-linked
 * blocks call `useProgressTrigger` directly against a ref they already hold —
 * so the component is gone and the vocabulary it was built on stayed, because
 * the hook's own signature is written in it.
 *
 * @see {@link file://../../../hooks/animation/use-progress-trigger.ts}
 */

export type TriggerPos =
  | "top top"
  | "center top"
  | "bottom top"
  | "top center"
  | "center center"
  | "bottom center"
  | "top bottom"
  | "center bottom"
  | "bottom bottom";
