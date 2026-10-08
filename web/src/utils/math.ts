/**
 * @fileoverview Utility function to transform a value from one range to another
 * Takes a value and maps it from its original min/max range to a new min/max range
 * Clamps the input value to the original range before transforming
 */
export const transformRange = (
  value: number,
  min: number,
  max: number,
  newMin: number,
  newMax: number,
) => {
  const normalized = (Math.min(Math.max(value, min), max) - min) / (max - min);
  return newMin + normalized * (newMax - newMin);
};

/**
 * @fileoverview Linear interpolation (lerp) function for smooth transitions
 * Calculates intermediate value between start and end based on interpolation factor
 * Commonly used for animations and gradual value changes
 * @param start Starting value
 * @param end Ending value
 * @param t Interpolation factor (0-1)
 * @returns Interpolated value
 */
export const lerp = (start: number, end: number, t: number): number => {
  return start * (1 - t) + end * t;
};

/**
 * @fileoverview Debounce utility to limit how often a function can be called
 * Creates a debounced version of the provided function that delays execution
 * Useful for handling frequent events like resize or scroll
 */
export const debounce = <T extends (...args: any[]) => void>(
  func: T,
  delay: number,
): T => {
  let timeout: NodeJS.Timeout;
  return ((...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), delay);
  }) as T;
};
