/**
 * A run of characters inside a display line.
 *
 * The brand sets the leading capital of each word in the italic cut of
 * Instrument Serif and the rest in the roman cut, so a display line cannot be a
 * plain string. Shared because both the hero and the preloader render it.
 */
export interface TitleSegment {
  text: string;
  italic?: boolean;
}
