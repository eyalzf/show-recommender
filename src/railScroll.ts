/**
 * Pure direction helpers for the horizontal Top 10 rails. No DOM, no
 * React: unit-tested in scripts/selftest.mjs for both LTR and RTL.
 *
 * Scrolling fact the helpers encode: `scrollBy({ left })` moves the
 * viewport in the same physical direction in every browser's RTL
 * scroll model (Chrome/Firefox negative scrollLeft, Safari
 * positive-descending). In LTR, forward (reveal the next cards) is a
 * positive left delta; in RTL, forward is a negative left delta — the
 * content overflows to the inline-end side (left in RTL), and a
 * negative delta reveals it in all models. So the sign flips on
 * direction alone, with no per-browser scrollLeft detection.
 */

/** Pixel delta for `scrollBy({ left })`: forward reveals the next cards. */
export function railScrollDelta(direction: 'ltr' | 'rtl', forward: boolean, amount: number): number {
  const sign = direction === 'rtl' ? -1 : 1;
  return (forward ? sign : -sign) * amount;
}

/** Arrow glyphs: the forward arrow points LEFT in RTL, RIGHT in LTR. */
export function railArrowGlyphs(lang: 'en' | 'he'): { forward: string; back: string } {
  return lang === 'he' ? { forward: '‹', back: '›' } : { forward: '›', back: '‹' };
}
