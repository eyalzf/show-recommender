import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile, Rating, ShowDetail, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profile: Profile;
  tmdbId: number;
  onBack: () => void;
}

/**
 * Mock 4 — Show detail + feedback. Full metadata, providers listed (never
 * filtered), like/dislike/dropped with an optional reason. NO "Want to
 * watch" anywhere (spec §7). Saving a rating removes the show from both
 * lists (the Home screen reflects that on its next load).
 */
export function ShowDetail({ lang, profile, tmdbId, onBack }: Props) {
  const [show, setShow] = useState<ShowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState<Rating>('liked');
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .show(tmdbId, lang)
      .then((res) => setShow(res.show))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.code === 'tmdb_not_configured'
            ? t(lang, 'tmdbMissing')
            : t(lang, 'searchError'),
        );
      });
  }, [tmdbId, lang]);

  const save = async () => {
    if (!show) return;
    try {
      await api.feedback(profile.id, tmdbId, rating, reason, show.title, show.originalLanguage);
      setSaved(true);
      setSaveNotice(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setSaveNotice(t(lang, 'notSaved'));
      } else {
        setSaveNotice(t(lang, 'searchError'));
      }
    }
  };

  if (error) {
    return (
      <section>
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t(lang, 'back')}</button>
        <p className="error-note" role="alert">{error}</p>
      </section>
    );
  }
  if (!show) return <p>{t(lang, 'loading')}</p>;

  const totalHours =
    show.numberOfEpisodes && show.episodeRunTime?.[0]
      ? Math.round((show.numberOfEpisodes * show.episodeRunTime[0]) / 60)
      : null;

  return (
    <section>
      <button type="button" className="btn btn-ghost" onClick={onBack}>{t(lang, 'back')}</button>
      <h2>{show.title}</h2>
      {show.posterPath ? (
        <img
          src={`https://image.tmdb.org/t/p/w185${show.posterPath}`}
          alt=""
          width="124"
          height="186"
          loading="lazy"
        />
      ) : null}
      {show.originalTitle !== show.title ? <p className="muted">{show.originalTitle}</p> : null}
      <div className="chips">
        {show.genres.map((g) => (
          <span key={g} className="chip">{g}</span>
        ))}
        {show.firstAirDate ? <span className="chip">{show.firstAirDate.slice(0, 4)}</span> : null}
        {show.numberOfSeasons != null ? <span className="chip">{show.numberOfSeasons} {t(lang, 'seasons')}</span> : null}
        {show.numberOfEpisodes != null ? <span className="chip">{show.numberOfEpisodes} {t(lang, 'episodes')}</span> : null}
        {show.episodeRunTime?.[0] ? <span className="chip">{show.episodeRunTime[0]} {t(lang, 'minEps')}</span> : null}
        {totalHours != null ? <span className="chip">{totalHours}h {t(lang, 'totalHours')}</span> : null}
        <span className="chip">{show.originalLanguage} · {show.originCountry.join(', ')}</span>
        {show.status ? <span className="chip">{show.status}</span> : null}
        {show.autoTranslated ? <span className="chip">auto-translated</span> : null}
      </div>
      <p>{show.overview}</p>
      <p>
        <strong>{t(lang, 'detailWatchOn')}:</strong>{' '}
        {show.originLabel ?? '—'}
        {show.providers.length > 0 ? ` · ${show.providers.join(' · ')}` : ''}
      </p>

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
      {saved ? <p className="ok-note">{t(lang, 'save')}</p> : null}
      {saveNotice ? <p className="notice" role="status">{saveNotice}</p> : null}
    </section>
  );
}
