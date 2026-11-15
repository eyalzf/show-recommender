import type { ListItem, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  item: ListItem;
  lang: UiLang;
  onRemove: (item: ListItem) => void;
  onRate: (item: ListItem) => void;
  onOpen: (item: ListItem) => void;
}

/** Top 10 card: full classification chip set + rationale + Remove/Rate. */
export function ShowCard({ item, lang, onRemove, onRate, onOpen }: Props) {
  const chips = [
    item.type,
    ...item.genres,
    item.tone,
    item.pace,
    item.structure,
    `${item.episodeMinutes} ${t(lang, 'minEps')}`,
    `${item.seasons} ${t(lang, 'seasons')} · ${item.totalHours}h ${t(lang, 'totalHours')}`,
    `${item.language} · ${item.country}`,
    item.status === 'ongoing' ? t(lang, 'ongoing') : t(lang, 'ended'),
  ];
  return (
    <article className="card">
      <div className="card-rank">{item.rank}</div>
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
