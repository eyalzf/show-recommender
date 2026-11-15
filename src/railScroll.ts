/**
 * Pure direction helpers for the horizontal rails. No DOM, no React:
 * unit-tested in scripts/selftest.mjs.
 *
 * The rail arrows are PHYSICAL, not reading-order, controls: the
 * right-pointing arrow always moves the visible window rightward
 * (revealing the cards to the right) and the left-pointing arrow
 * always moves it leftward — identically in English (LTR) and Hebrew
 * (RTL). The glyphs are never mirrored and the behavior never swaps
 * between languages. The helpers therefore deliberately take no
 * direction or language argument: a locale-dependent regression
 * cannot be expressed through this API.
 *
 * Scrolling fact the helpers encode: `scrollBy({ left })` deltas are
 * physical in every browser's scroll model (Chrome/Firefox negative
 * scrollLeft, Safari positive-descending) — a positive delta moves
 * the viewport rightward and a negative delta moves it leftward, in
 * both LTR and RTL. So the delta depends only on which arrow was
 * pressed, never on document direction.
 */

/** Right-pointing arrow glyph — identical in both languages. */
export const RAIL_ARROW_RIGHT = '›';

/** Left-pointing arrow glyph — identical in both languages. */
export const RAIL_ARROW_LEFT = '‹';

/**
 * Pixel delta for `scrollBy({ left })`. `moveRight` is the right
 * arrow: the window moves rightward. `false` is the left arrow.
 */
export function railScrollDelta(moveRight: boolean, amount: number): number {
  return (moveRight ? 1 : -1) * amount;
}
