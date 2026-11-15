import type { ListItem, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  item: ListItem;
  lang: UiLang;
  onRemove: (item: ListItem) => void;
  onRate: (item: ListItem) => void;
  onOpen: (item: ListItem) => void;
}

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

type ChipVariant = 'gold' | 'purple' | 'grey' | 'teal' | 'red';

interface ChipDef {
  label: string;
  variant: ChipVariant;
}

/**
 * Top 10 card, NEXUS film-card style: full-bleed 2:3 poster on top with a
 * rank badge, then title, muted meta line, coloured classification chips,
 * rationale, and Remove/Rate. Same props and behaviour as before — only
 * the markup and classes changed.
 */
export function ShowCard({ item, lang, onRemove, onRate, onOpen }: Props) {
  const chips: ChipDef[] = [
    { label: item.type, variant: 'gold' },
    ...item.genres.map((g): ChipDef => ({ label: g, variant: 'purple' })),
    { label: item.tone, variant: 'grey' },
    { label: item.pace, variant: 'grey' },
    { label: item.structure, variant: 'grey' },
  ];
  if (item.episodeMinutes > 0) {
    chips.push({ label: `${item.episodeMinutes} ${t(lang, 'minEps')}`, variant: 'grey' });
  }
  const metaParts: string[] = [];
  if (item.seasons > 0) metaParts.push(`${item.seasons} ${t(lang, 'seasons')}`);
  if (item.totalHours > 0) metaParts.push(`${item.totalHours}h ${t(lang, 'totalHours')}`);
  const langCountry = [item.language, item.country].filter(Boolean).join(' · ');
  if (langCountry) metaParts.push(langCountry);
  metaParts.push(item.status === 'ongoing' ? t(lang, 'ongoing') : t(lang, 'ended'));

  return (
    <article className="show-card">
      <div className="show-card-poster-wrap">
        {item.posterPath ? (
          <img
            className="show-card-poster"
            src={`${TMDB_IMAGE_BASE}${item.posterPath}`}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="show-card-poster-fallback" aria-hidden="true">
            {item.title.charAt(0)}
          </div>
        )}
        <span className="show-card-rank">#{item.rank}</span>
      </div>
      <div className="show-card-body">
        <h3 className="show-card-title">
          <button type="button" className="linklike" onClick={() => onOpen(item)}>
            {item.title}
          </button>
        </h3>
        <div className="show-card-meta">{metaParts.join(' · ')}</div>
        <div className="chips">
          {chips.map((chip) => (
            <span key={chip.label} className={`chip chip-${chip.variant}`}>
              {chip.label}
            </span>
          ))}
        </div>
        <p className="rationale">{item.rationale}</p>
        {item.risk ? (
          <p className="risk">{t(lang, 'detailRisk')}: {item.risk}</p>
        ) : null}
        <div className="card-actions">
          <button type="button" className="btn" onClick={() => onRemove(item)}>
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
