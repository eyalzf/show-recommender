import type { ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
}

/**
 * One horizontal scroll rail. The viewport is a native horizontal
 * scroller: touch swipe, trackpad, and arrow-key scrolling (the
 * viewport is focusable) work with no added affordances. There are
 * deliberately no scroll indicators: the below-card arrow controls
 * were removed (2026-11-15) because they were not noticeable, and
 * edge fades were rejected earlier because they overlapped the cards.
 */
export function Rail({ label, children }: Props) {
  return (
    <div className="rail">
      <div
        className="rail-viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <div className="rail-track">{children}</div>
      </div>
    </div>
  );
}
