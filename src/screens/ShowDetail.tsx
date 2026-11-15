import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ListItem, Profile, Rating, ShowDetail, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { yearRangeLabel } from '../showMeta';
import { Rail } from '../components/Rail';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
  tmdbId: number;
  /** Present when opened from a Top 10 rail: carries the rationale, risk,
   * and classification chips that no longer fit on the compact card. */
  listItem?: ListItem | null;
  onBack: () => void;
}

/**
 * Mock 4 — Show detail + feedback. Full metadata, providers listed (never
 * filtered), like/dislike/dropped with an optional reason. NO "Want to
 * watch" anywhere (spec §7). Saving a rating removes the show from both
 * lists (the Home screen reflects that on its next load).
 */
export function ShowDetail({ lang, profile, tmdbId, listItem, onBack }: Props) {
  const { notify } = useNotify();
  const [show, setShow] = useState<ShowDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rating, setRating] = useState<Rating>('liked');
  const [reason, setReason] = useState('');

  useEffect(() => {
    setLoadFailed(false);
    api
      .show(tmdbId, lang)
      .then((res) => setShow(res.show))
      .catch((err: unknown) => {
        setLoadFailed(true);
        notify(
          err instanceof ApiError && err.code === 'tmdb_not_configured'
            ? t(lang, 'tmdbMissing')
            : t(lang, 'searchError'),
          { kind: 'error', sticky: true, key: 'show-error' },
        );
      });
  }, [tmdbId, lang, notify]);

  const save = async () => {
    if (!show) return;
    try {
      await api.feedback(profile.id, tmdbId, rating, reason, show.title, show.originalLanguage);
      notify(t(lang, 'save'), { kind: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
    }
  };

  if (loadFailed) {
    return (
      <section>
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t(lang, 'back')}</button>
      </section>
    );
  }
  if (!show) return <p>{t(lang, 'loading')}</p>;

  const totalHours =
    show.numberOfEpisodes && show.episodeRunTime?.[0]
      ? Math.round((show.numberOfEpisodes * show.episodeRunTime[0]) / 60)
      : null;
  const yearOf = (date: string): number | null => {
    const year = Number(date.slice(0, 4));
    return Number.isInteger(year) && year > 0 ? year : null;
  };
  const ongoing = show.status === 'Returning Series' || show.status === 'In Production';
  const years = yearRangeLabel(yearOf(show.firstAirDate), yearOf(show.lastAirDate ?? ''), ongoing);

  return (
    <section>
      <button type="button" className="btn btn-ghost" onClick={onBack}>{t(lang, 'back')}</button>
      <div className="detail-hero">
        {show.posterPath ? (
          <img
            className="detail-poster"
            src={`https://image.tmdb.org/t/p/w185${show.posterPath}`}
            alt=""
            width="168"
            height="252"
            loading="lazy"
          />
        ) : null}
        <div className="detail-info">
          <h2>{show.title}</h2>
          {show.originalTitle !== show.title ? <p className="detail-sub">{show.originalTitle}</p> : null}
          <div className="chips">
            {show.genres.map((g) => (
              <span key={g} className="chip chip-purple">{g}</span>
            ))}
            {years ? <span className="chip">{years}</span> : null}
            {show.numberOfSeasons != null ? <span className="chip">{show.numberOfSeasons} {t(lang, 'seasons')}</span> : null}
            {show.numberOfEpisodes != null ? <span className="chip">{show.numberOfEpisodes} {t(lang, 'episodes')}</span> : null}
            {show.episodeRunTime?.[0] ? <span className="chip">{show.episodeRunTime[0]} {t(lang, 'minEps')}</span> : null}
            {totalHours != null ? <span className="chip">{totalHours}h {t(lang, 'totalHours')}</span> : null}
            <span className="chip chip-teal">{show.originalLanguage} · {show.originCountry.join(', ')}</span>
            {show.status ? <span className="chip">{show.status}</span> : null}
            {show.autoTranslated ? <span className="chip">auto-translated</span> : null}
          </div>
          <p>{show.overview}</p>
          {listItem ? (
            <div className="detail-why">
              <h3>{t(lang, 'whyRecommended')}</h3>
              <p className="rationale">{listItem.rationale}</p>
              {listItem.risk ? (
                <p className="risk">{t(lang, 'detailRisk')}: {listItem.risk}</p>
              ) : null}
              <div className="chips">
                <span className="chip chip-gold">{listItem.type}</span>
                <span className="chip">{listItem.tone}</span>
                <span className="chip">{listItem.pace}</span>
                <span className="chip">{listItem.structure}</span>
                {listItem.episodeMinutes > 0 ? (
                  <span className="chip">{listItem.episodeMinutes} {t(lang, 'minEps')}</span>
                ) : null}
              </div>
            </div>
          ) : null}
          <p>
            <strong>{t(lang, 'detailWatchOn')}:</strong>{' '}
            {show.originLabel ?? '—'}
            {show.providers.length > 0 ? ` · ${show.providers.join(' · ')}` : ''}
          </p>
        </div>
      </div>

      {(show.cast ?? []).length > 0 ? (
        <>
          <h3>{t(lang, 'castTitle')}</h3>
          <Rail lang={lang} label={t(lang, 'castTitle')}>
            {(show.cast ?? []).map((m) => (
              <article className="cast-card" key={m.tmdbId}>
                {m.profilePath ? (
                  <img
                    className="cast-photo"
                    src={`https://image.tmdb.org/t/p/w185${m.profilePath}`}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <div className="cast-photo-fallback" aria-hidden="true">
                    {m.name.charAt(0)}
                  </div>
                )}
                <div className="cast-name">{m.name}</div>
                {m.character ? <div className="cast-character">{m.character}</div> : null}
              </article>
            ))}
          </Rail>
        </>
      ) : null}

      <h3>{t(lang, 'rate')}</h3>
      <div className="rating-row" role="group" aria-label={t(lang, 'rate')}>
        {(['liked', 'disliked', 'dropped'] as Rating[]).map((r) => (
          <button
            key={r}
            type="button"
            className={rating === r ? 'btn btn-primary' : 'btn'}
            onClick={() => setRating(r)}
          >
            {t(lang, r)}
          </button>
        ))}
      </div>
      <label className="field-label">
        {t(lang, 'whyOptional')}
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </label>
      <button type="button" className="btn btn-primary" onClick={save}>
        {t(lang, 'saveFeedback')}
      </button>
    </section>
  );
}
