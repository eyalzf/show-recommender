import { useEffect } from 'react';
import type { ListItem, UiLang } from '../types';
import { t } from '../i18n';
import { cardMetaLine } from '../showMeta';

interface Props {
  item: ListItem;
  lang: UiLang;
  onClose: () => void;
  onRemove: (item: ListItem) => void;
  onRate: (item: ListItem) => void;
  onFullDetails: (item: ListItem) => void;
}

const TMDB_SHEET_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';

/**
 * Mobile-only bottom sheet for a Top 10 rail item (option B): the rail
 * card is poster-only on mobile, so the tap opens this sheet instead of
 * the detail view. Everything the card used to carry — title, rating,
 * meta line — plus the rationale, risk, and classification chips, all
 * from the ListItem already in hand (no extra fetch). Remove/Rate act
 * exactly like the card's quick actions; "Full details" opens the
 * regular detail view. Dismiss via scrim, close button, or Escape.
 * Geometry mirrors the mood manage sheet.
 */
export function ShowSheet({ item, lang, onClose, onRemove, onRate, onFullDetails }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const showSubtitle = item.originalTitle && item.originalTitle !== item.title;
  const meta = cardMetaLine(lang, item);

  return (
    <>
      <div className="show-scrim" onClick={onClose} aria-hidden="true" />
      <div className="show-sheet" role="dialog" aria-label={item.title}>
        <div className="show-sheet-grab" aria-hidden="true" />
        <button type="button" className="show-sheet-close" onClick={onClose} aria-label={t(lang, 'close')}>
          ×
        </button>
        <div className="show-sheet-top">
          {item.posterPath ? (
            <img
              className="show-sheet-poster"
              src={`${TMDB_SHEET_IMAGE_BASE}${item.posterPath}`}
              alt=""
              loading="lazy"
            />
          ) : null}
          <div className="show-sheet-head">
            <h3>{item.title}</h3>
            {showSubtitle ? <div className="show-sheet-sub">{item.originalTitle}</div> : null}
            {item.voteAverage > 0 ? (
              <div className="show-sheet-rating">★ {item.voteAverage.toFixed(1)}</div>
            ) : null}
            {meta ? <div className="show-sheet-meta">{meta}</div> : null}
          </div>
        </div>
        <div className="show-sheet-why">
          <h4>{t(lang, 'whyRecommended')}</h4>
          <p className="rationale">{item.rationale}</p>
          {item.risk ? (
            <p className="risk">
              {t(lang, 'detailRisk')}: {item.risk}
            </p>
          ) : null}
          <div className="chips">
            <span className="chip chip-gold">{item.type}</span>
            <span className="chip">{item.tone}</span>
            <span className="chip">{item.pace}</span>
            <span className="chip">{item.structure}</span>
            {item.episodeMinutes > 0 ? (
              <span className="chip">
                {item.episodeMinutes} {t(lang, 'minEps')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="show-sheet-actions">
          <button type="button" className="btn" onClick={() => onRemove(item)}>
            {t(lang, 'remove')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onRate(item)}>
            {t(lang, 'rate')}
          </button>
        </div>
        <button type="button" className="show-sheet-full" onClick={() => onFullDetails(item)}>
          {t(lang, 'fullDetails')}
        </button>
      </div>
    </>
  );
}
