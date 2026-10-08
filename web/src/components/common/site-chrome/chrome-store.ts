"use client";

/**
 * One boolean shared between the page's two ends: is the footer on screen?
 *
 * The wordmark and the nav are **fixed** — they leave the hero on the first
 * scroll and ride the top of the window for the whole page (see
 * `hero.geometry.ts`, `CLASS.wordmark` / `CLASS.nav`). At the very bottom that
 * stops being useful and starts being duplication: the footer prints the same
 * wordmark and the same four links, larger, as its own content. So the fixed
 * pair steps aside when the footer arrives.
 *
 * A store rather than a prop, because the two ends of this are the **first** and
 * the **last** block on the page and neither owns the other. Threading a
 * boolean from block 5 up through the home view and back down into block 1's
 * overlay would put a piece of block 5's state in three files that have no
 * other reason to know about it.
 *
 * Zustand, like `cookieStore`: the store *is* the hook, so the reader is a
 * one-line subscription and the writer is a one-line call with no provider
 * anywhere.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import { create } from "zustand";

export interface ChromeState {
  /**
   * The footer is in view, so the fixed chrome should stand down.
   *
   * Named for the *cause*, not the effect — what a reader of this flag wants to
   * know is why the header went away, and "the footer is here" answers that
   * where "hidden" would only restate it.
   */
  footerInView: boolean;
  setFooterInView: (value: boolean) => void;
}

export const useChrome = create<ChromeState>((set) => ({
  footerInView: false,
  setFooterInView: (footerInView) =>
    /*
     * Guarded: the observer fires on every threshold crossing and this is read
     * by the hero on the other side of the page, so writing an unchanged value
     * would re-render block 1 for nothing.
     */
    set((state) =>
      state.footerInView === footerInView ? state : { footerInView },
    ),
}));
