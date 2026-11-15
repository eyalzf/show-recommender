import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UiLang } from '../types';
import { t } from '../i18n';
import { railArrowGlyphs, railScrollDelta } from '../railScroll';

interface Props {
  lang: UiLang;
  label: string;
  children: ReactNode;
}

/**
 * One horizontal scroll rail. The viewport is a native horizontal
 * scroller (touch swipe works; focusing it enables arrow-key scrolling)
 * with scroll-snap proximity. Arrow buttons (desktop) scroll by ~80%
 * of the visible width via the direction-tested helper in railScroll.ts,
 * so RTL scrolls the right way in every browser's scroll model. Edge
 * fades are pure CSS with logical properties, so they mirror in RTL.
 * Arrows stay enabled at the ends — a click past the end is a harmless
 * no-op — which avoids fragile RTL scrollLeft end-detection entirely.
 */
export function Rail({ lang, label, children }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setCanScroll(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  const scroll = (forward: boolean) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollBy({
      left: railScrollDelta(lang === 'he' ? 'rtl' : 'ltr', forward, Math.round(el.clientWidth * 0.8)),
      behavior: 'smooth',
    });
  };

  const glyphs = railArrowGlyphs(lang);

  return (
    <div className="rail">
      <div
        className="rail-viewport"
        ref={viewportRef}
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <div className="rail-track">{children}</div>
      </div>
      {canScroll ? (
        <>
          <div className="rail-fade rail-fade-start" aria-hidden="true" />
          <div className="rail-fade rail-fade-end" aria-hidden="true" />
          <button
            type="button"
            className="rail-arrow rail-arrow-back"
            onClick={() => scroll(false)}
            aria-label={t(lang, 'scrollBack')}
          >
            {glyphs.back}
          </button>
          <button
            type="button"
            className="rail-arrow rail-arrow-forward"
            onClick={() => scroll(true)}
            aria-label={t(lang, 'scrollNext')}
          >
            {glyphs.forward}
          </button>
        </>
      ) : null}
    </div>
  );
}
