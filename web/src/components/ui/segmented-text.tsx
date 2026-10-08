// 📖 Docs: obsidian/frontend/components/common.md

import type { TitleSegment } from "@/types/typography";

export interface SegmentedTextProps {
  segments: TitleSegment[];
}

/**
 * Renders a display line, alternating the italic and roman cuts of the
 * display face. Carries no styling of its own — size, colour and leading come
 * from the element it is rendered into.
 */
export const SegmentedText = ({ segments }: SegmentedTextProps) => (
  <>
    {segments.map((segment, index) => (
      <span key={index} className={segment.italic ? "italic" : undefined}>
        {segment.text}
      </span>
    ))}
  </>
);

/**
 * The same line, cut into words.
 *
 * A segment is a **style run, not a word**. The display face sets each word's
 * first letter in the italic cut, so "Somewhere" arrives as an italic `S`
 * followed by a roman `omewhere`, and a word can therefore span two segments —
 * while a single segment ("o Somewhere That ") can just as easily span three
 * words. Anything that animates per word has to re-cut the line along its
 * spaces without losing which characters belong to which cut.
 *
 * That is all this does: walk the segments once, break on whitespace, and hand
 * back each word as its own little list of segments, ready to be rendered by
 * `SegmentedText`. Whitespace itself is dropped — the caller puts the spaces
 * back between the words it renders, because a word that is going to be
 * `inline-block` cannot carry its own trailing space and still sit on the
 * baseline correctly.
 *
 * Empty words never come back: two spaces in a row, or a segment that is
 * nothing but a space, collapse the way they already do in HTML.
 */
export const toWords = (segments: TitleSegment[]): TitleSegment[][] => {
  const words: TitleSegment[][] = [];
  let current: TitleSegment[] = [];

  const flush = () => {
    if (current.length > 0) words.push(current);
    current = [];
  };

  for (const segment of segments) {
    // `split` on the space keeps the empty strings that mark where the breaks
    // fall, which is exactly what tells us when to close a word.
    const pieces = segment.text.split(/(\s+)/);
    for (const piece of pieces) {
      if (piece === "") continue;
      if (/^\s+$/.test(piece)) {
        flush();
        continue;
      }
      current.push({ ...segment, text: piece });
    }
  }
  flush();

  return words;
};
