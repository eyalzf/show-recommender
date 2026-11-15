import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UiLang } from '../types';
import { t } from '../i18n';
import { RAIL_ARROW_LEFT, RAIL_ARROW_RIGHT, railScrollDelta } from '../railScroll';

interface Props {
  lang: UiLang;
  label: string;
  children: ReactNode;
}

/**
 * One horizontal scroll rail. The viewport is a native horizontal
 * scroller (touch swipe works; focusing it enables arrow-key scrolling)
 * with scroll-snap proximity. The arrow buttons live in a control row
 * BELOW the cards — never overlaid on them — and are physical,
 * directional controls: the right arrow always moves the window
 * rightward and the left arrow always leftward, with identical glyphs
 * in English and Hebrew (see railScroll.ts). The controls show only
 * on hover-capable pointers; touch devices swipe. Arrows stay enabled
 * at the ends — a click past the end is a harmless no-op — which
 * avoids fragile RTL scrollLeft end-detection entirely.
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

  const scroll = (moveRight: boolean) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollBy({
      left: railScrollDelta(moveRight, Math.round(el.clientWidth * 0.8)),
      behavior: 'smooth',
    });
  };

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
        <div className="rail-controls">
          <button
            type="button"
            className="rail-arrow"
            onClick={() => scroll(false)}
            aria-label={t(lang, 'scrollLeft')}
          >
            {RAIL_ARROW_LEFT}
          </button>
          <button
            type="button"
            className="rail-arrow"
            onClick={() => scroll(true)}
            aria-label={t(lang, 'scrollRight')}
          >
            {RAIL_ARROW_RIGHT}
          </button>
        </div>
      ) : null}
    </div>
  );
}
