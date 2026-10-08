"use client";

/**
 * One numbered column of countries.
 *
 * The design draws two of them, mirrored about the scene: 01–08 anchored to the
 * left page margin with the number first, 09–16 anchored to the right margin
 * with the number last. One component, one `align` prop.
 *
 * **Both** columns are live now. In the old frame the right-hand one was set
 * entirely in the muted cream with no active state, because the pile it would
 * have driven only existed for the left twelve; every country has a card of its
 * own on the scene now, so every name points at one.
 *
 * 📖 Docs: obsidian/frontend/destinations.md
 */

import { CLASS } from "./destinations.geometry";
import type { Destination } from "./destinations.types";

export interface DestinationListProps {
  countries: Destination[];
  /** Index of the first country, so the numbering continues across columns. */
  startIndex: number;
  align: "left" | "right";
  activeId: string;
  onActivate: (id: string) => void;
  /**
   * Whether pointing at a name is enough to select it.
   *
   * False on a device that reports `(hover: none)`, where the only pointer
   * event before a tap is a synthesised one — hovering there would select a
   * country the reader was only scrolling past. Tap and focus still work, so
   * nothing is lost.
   */
  hoverActivates: boolean;
}

/** Token-backed timing for the one discrete state change here — ADR-0014. */
const stateTiming =
  "transition-colors duration-[var(--duration-fast)] ease-entrance motion-reduce:transition-none";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground-accent";

/** `01.` … `16.` — the file prints a leading zero and a full stop. */
const ordinal = (index: number): string =>
  `${String(index + 1).padStart(2, "0")}.`;

export const DestinationList = ({
  countries,
  startIndex,
  align,
  activeId,
  onActivate,
  hoverActivates,
}: DestinationListProps) => {
  const isRight = align === "right";
  const column = isRight ? CLASS.listRight : CLASS.listLeft;

  return (
    <ul className={`${CLASS.list} ${CLASS.listType} ${column}`}>
      {countries.map((country, index) => {
        const isActive = country.id === activeId;
        const number = (
          <span className={CLASS.listNumber} aria-hidden>
            {ordinal(startIndex + index)}
          </span>
        );
        const name = <span className={CLASS.listName}>{country.name}</span>;
        /*
         * `text-left` / `text-right` are not decoration: a `<button>` carries
         * `text-align: center` from the UA sheet, which centred every name
         * inside its own fixed-width column instead of setting it flush
         * against the page margin the way the file does.
         */
        const row = `${CLASS.listRow} ${isRight ? "text-right" : "text-left"}`;
        const body = isRight ? (
          <>
            {name}
            {number}
          </>
        ) : (
          <>
            {number}
            {name}
          </>
        );

        return (
          <li key={country.id}>
            {/*
              A real control, not a styled span: the card it points at is
              reachable by keyboard this way, and `onFocus` gives tab users the
              same switch that `onMouseEnter` gives the pointer. There is
              deliberately no leave handler — the brief asks for the last
              country hovered to stay.
            */}
            <button
              type="button"
              aria-pressed={isActive}
              onMouseEnter={
                hoverActivates ? () => onActivate(country.id) : undefined
              }
              onFocus={() => onActivate(country.id)}
              onClick={() => onActivate(country.id)}
              className={`${row} cursor-pointer ${stateTiming} ${focusRing} ${
                isActive
                  ? "text-foreground-accent"
                  : "text-foreground-accent-muted hover:text-foreground-accent"
              }`}
            >
              {body}
            </button>
          </li>
        );
      })}
    </ul>
  );
};
