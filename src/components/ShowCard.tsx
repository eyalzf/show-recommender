import type { ListItem, UiLang } from '../types';
import { t } from '../i18n';
import { cardMetaLine } from '../showMeta';

interface Props {
  item: ListItem;
  lang: UiLang;
  onRemove: (item: ListItem) => void;
  onRate: (item: ListItem) => void;
  onOpen: (item: ListItem) => void;
}

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_RAIL_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

/**
 * Compact Top 10 rail card, NEXUS style: 2:3 poster with a rank badge,
 * title + small English subtitle (where the original title differs),
 * ★ TMDB rating, a compact meta line (years · seasons · episodes), and
 * the settled Remove/Rate quick actions in compact form. Rationale,
 * risk, and classification chips live in the show detail view, not on
 * the card. Poster and title both open detail.
 *
 * On mobile (max-width: 640px) the card is poster-only: the body is
 * hidden by CSS and the tap opens the bottom sheet instead of detail.
 * The poster fallback therefore shows the full show title, not just
 * its first letter — on a poster-only card it is the only title.
 */
export function RailCard({ item, lang, onRemove, onRate, onOpen }: Props) {
  const showSubtitle = item.originalTitle && item.originalTitle !== item.title;
  const meta = cardMetaLine(lang, item);
  return (
    <article className="rail-card">
      <div className="rail-card-poster-wrap">
        <button
          type="button"
          className="rail-card-poster-btn"
          onClick={() => onOpen(item)}
          aria-label={item.title}
        >
          {item.posterPath ? (
            <img
              className="rail-card-poster"
              src={`${TMDB_RAIL_IMAGE_BASE}${item.posterPath}`}
              alt=""
              loading="lazy"
            />
          ) : (
            <div className="rail-card-poster-fallback" aria-hidden="true">
              <span>{item.title}</span>
            </div>
          )}
        </button>
        <span className="show-card-rank">#{item.rank}</span>
      </div>
      <div className="rail-card-body">
        <h3 className="rail-card-title">
          <button type="button" className="linklike" onClick={() => onOpen(item)}>
            {item.title}
          </button>
        </h3>
        {showSubtitle ? <div className="rail-card-sub">{item.originalTitle}</div> : null}
        {item.voteAverage > 0 ? (
          <div className="rail-card-rating">★ {item.voteAverage.toFixed(1)}</div>
        ) : null}
        {meta ? <div className="rail-card-meta">{meta}</div> : null}
        <div className="rail-card-actions">
          <button type="button" className="btn btn-sm" onClick={() => onRemove(item)}>
            {t(lang, 'remove')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onRate(item)}>
            {t(lang, 'rate')}
          </button>
        </div>
      </div>
    </article>
  );
}
