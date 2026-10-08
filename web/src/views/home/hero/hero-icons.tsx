/**
 * Vector assets exported from the Figma hero, inlined so they inherit
 * `currentColor` and cost no extra request.
 *
 * Source nodes: 876:72 (Icons/Arrow), 869:1129 (Ellipse 1), 881:2 (Line 3).
 */

export interface HeroIconProps {
  className?: string;
}

/**
 * The corner arrow beside "EXPLORE DESTINATIONS". Figma rotates the 12×12
 * source 90°, which is baked into the path here rather than applied as a
 * transform.
 */
export const ArrowIcon = ({ className }: HeroIconProps) => (
  <svg
    className={className}
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <g transform="rotate(90 6 6)">
      <path
        d="M1.5 10.5H6.9V1.5M10.5 5.35714L6.9 1.5L3.3 5.35714"
        stroke="currentColor"
      />
    </g>
  </svg>
);

/** The 3px bullet in front of "ALL DESTINATIONS". */
export const DotIcon = ({ className }: HeroIconProps) => (
  <svg
    className={className}
    width="3"
    height="3"
    viewBox="0 0 3 3"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
  </svg>
);
