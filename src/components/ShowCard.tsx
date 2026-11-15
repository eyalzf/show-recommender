import type { ListItem, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  item: ListItem;
  lang: UiLang;
  onRemove: (item: ListItem) => void;
  onRate: (item: ListItem) => void;
  onOpen: (item: ListItem) => void;
}

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';

/** Top 10 card: full classification chip set + rationale + Remove/Rate. */
export function ShowCard({ item, lang, onRemove, onRate, onOpen }: Props) {
  const chips: string[] = [
    item.type,
    ...item.genres,
    item.tone,
    item.pace,
    item.structure,
  ];
  if (item.episodeMinutes > 0) chips.push(`${item.episodeMinutes} ${t(lang, 'minEps')}`);
  if (item.seasons > 0 || item.totalHours > 0) {
    const parts: string[] = [];
    if (item.seasons > 0) parts.push(`${item.seasons} ${t(lang, 'seasons')}`);
    if (item.totalHours > 0) parts.push(`${item.totalHours}h ${t(lang, 'totalHours')}`);
    chips.push(parts.join(' · '));
  }
  const langCountry = [item.language, item.country].filter(Boolean).join(' · ');
  if (langCountry) chips.push(langCountry);
  chips.push(item.status === 'ongoing' ? t(lang, 'ongoing') : t(lang, 'ended'));
  return (
    <article className="card">
      <div className="card-rank">{item.rank}</div>
      {item.posterPath ? (
        <img
          className="card-poster"
          src={`${TMDB_IMAGE_BASE}${item.posterPath}`}
          alt=""
          width="62"
          height="93"
          loading="lazy"
        />
      ) : null}
      <div className="card-body">
        <h3 className="card-title">
          <button type="button" className="linklike" onClick={() => onOpen(item)}>
            {item.title}
          </button>
        </h3>
        <div className="chips">
          {chips.map((chip) => (
            <span key={chip} className="chip">{chip}</span>
          ))}
        </div>
        <p className="rationale">{item.rationale}</p>
        {item.risk ? (
          <p className="risk">{t(lang, 'detailRisk')}: {item.risk}</p>
        ) : null}
        <div className="card-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onRemove(item)}>
            {t(lang, 'remove')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onRate(item)}>
            {t(lang, 'rate')}
          </button>
        </div>
      </div>
    </article>
  );
}
