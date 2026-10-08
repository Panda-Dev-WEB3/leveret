"use client";

/**
 * The two edge thumbnails of frame 3 — 856:990 (top) and 856:989 (bottom).
 *
 * Both bleed off the frame, so each is rounded only on the edge that stays
 * inside it. They share one photo at two different crops; the percentages below
 * are the image transforms straight out of Figma. The top layer is flipped
 * twice in the file (once on the frame, once on the fill), which cancels — so
 * it is placed here as an upright image with the net offset.
 *
 * 📖 Docs: obsidian/frontend/components/common.md
 */

import Image from "next/image";
import { animated, to, type SpringValue } from "@react-spring/web";

import { PHASE, THUMBNAIL_CLASS, uiStart } from "./hero.geometry";
import type { HeroContent } from "./hero.types";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Figma fill transforms, as percentages of each thumbnail box. */
const CROP = {
  top: { width: "444.3%", left: "-191.52%", top: "-152.58%" },
  bottom: { width: "313.54%", left: "-213.75%", top: "-36.8%" },
} as const;

/**
 * How far the pair parts as the hero is scrolled away, in rem.
 *
 * They are the two halves of one composition, so they leave as one gesture read
 * in two directions: the top one up and out, the bottom one down and out. A
 * fixed distance rather than a fraction of the screen, because what they are
 * leaving is not the screen but each other.
 */
const PART_TRAVEL = 9;

export interface HeroThumbnailsProps {
  media: HeroContent["media"]["thumbnail"];
  progress: SpringValue<number>;
  /** 0→1 as the hero scrolls away. The pair parts across it. */
  exit: SpringValue<number>;
}

export const HeroThumbnails = ({
  media,
  progress,
  exit,
}: HeroThumbnailsProps) => {
  const start = uiStart("thumbnails");
  const eased = progress.to((p) => clamp01((p - start) / PHASE.uiDuration));

  /*
   * Entry and exit on one transform, because one element carries one transform.
   * `direction` is −1 for the top thumbnail and +1 for the bottom, and it means
   * the same thing at both ends: the entry comes *from* that side, and the exit
   * leaves *towards* it.
   */
  const enter = (direction: -1 | 1) => ({
    opacity: eased,
    transform: to(
      [eased, exit],
      (v: number, out: number) =>
        `translate3d(0, ${((1 - v) * 1.25 + out * PART_TRAVEL) * direction}rem, 0)`,
    ),
  });

  return (
    <>
      <animated.div
        className={`rounded-b-media overflow-hidden ${THUMBNAIL_CLASS.top}`}
        style={enter(-1)}
      >
        <Image
          src={media.src}
          alt={media.alt}
          width={media.width}
          height={media.height}
          sizes="70vw"
          className="absolute max-w-none"
          style={{ ...CROP.top, height: "auto" }}
        />
        <div className="bg-scrim-media absolute inset-0" />
      </animated.div>

      <animated.div
        className={`rounded-t-media overflow-hidden ${THUMBNAIL_CLASS.bottom}`}
        style={enter(1)}
      >
        <Image
          src={media.src}
          alt=""
          width={media.width}
          height={media.height}
          sizes="50vw"
          className="absolute max-w-none"
          style={{ ...CROP.bottom, height: "auto" }}
        />
        <div className="bg-scrim-media absolute inset-0" />
      </animated.div>
    </>
  );
};
