import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Profile, Rating, SearchHit, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { RatingDialog } from '../components/Dialogs';

interface Props {
  lang: UiLang;
  profile: Profile;
  onDone: () => void;
}

interface Rated {
  hit: SearchHit;
  rating: Rating;
  reason: string;
}

const QUICK_PICKS = ['Fauda', 'Shtisel', 'Tehran', 'Kupa Rashit', 'Srugim'];

/**
 * Mock 2 — Bootstrap. Free-text search filters the list as you type
 * (debounced live search against the real TMDB route). Minimum: 5 rated
 * shows including at least one dislike/drop, plus one taste note.
 */
export function Bootstrap({ lang, profile, onDone }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [rated, setRated] = useState<Rated[]>([]);
  const [note, setNote] = useState('');
  const [ratingTarget, setRatingTarget] = useState<SearchHit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    timer.current = window.setTimeout(() => {
      api
        .search(q, lang)
        .then((res) => {
          setHits(res.results);
          setSearchError(null);
        })
        .catch((err: unknown) => {
          setHits([]);
          setSearchError(
            err instanceof ApiError && err.code === 'tmdb_not_configured'
              ? t(lang, 'tmdbMissing')
              : t(lang, 'searchError'),
          );
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, lang]);

  const negatives = rated.filter((r) => r.rating !== 'liked').length;
  const reached = rated.length >= 5 && negatives >= 1 && note.trim().length > 0;

  const submitRating = (rating: Rating, reason: string) => {
    if (!ratingTarget) return;
    setRated((prev) => {
      const rest = prev.filter((r) => r.hit.tmdbId !== ratingTarget.tmdbId);
      return [...rest, { hit: ratingTarget, rating, reason }];
    });
    setRatingTarget(null);
  };

  /** Persist every rating + the taste note, then build the lists. */
  const buildLists = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      for (const r of rated) {
        await api.feedback(profile.id, r.hit.tmdbId, r.rating, r.reason, r.hit.title, r.hit.originalLanguage);
      }
      await api.addNote(profile.id, 'note', note.trim());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        // Demo mode: nothing persists, but the flow still continues.
        setSaveError(t(lang, 'notSaved'));
        setSaving(false);
        onDone();
        return;
      }
      setSaveError(t(lang, 'searchError'));
      setSaving(false);
      return;
    }
    setSaving(false);
    onDone();
  };

  return (
    <section>
      <h2>
        {t(lang, 'bootstrapTitle')} — {profile.name}
      </h2>
      <p>
        {rated.length} {t(lang, 'bootstrapProgress')}
        {negatives === 0 ? ` · ${t(lang, 'bootstrapNeedNegative')}` : ''}
      </p>
      {reached ? <p className="ok-note">{t(lang, 'bootstrapReached')}</p> : null}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t(lang, 'searchPlaceholder')}
        aria-label={t(lang, 'searchPlaceholder')}
      />
      <div className="quick-picks">
        <span>{t(lang, 'quickPicks')}:</span>
        {QUICK_PICKS.map((qp) => (
          <button key={qp} type="button" className="chip chip-btn" onClick={() => setQuery(qp)}>
            {qp}
          </button>
        ))}
      </div>

      {searching ? <p>{t(lang, 'loading')}</p> : null}
      {searchError ? <p className="error-note" role="alert">{searchError}</p> : null}
      {!searching && !searchError && query.trim().length >= 2 && hits.length === 0 ? (
        <p>{t(lang, 'noResults')}</p>
      ) : null}
      <ul className="search-results">
        {hits.map((hit) => {
          const existing = rated.find((r) => r.hit.tmdbId === hit.tmdbId);
          return (
            <li key={hit.tmdbId} className="search-row">
              <span className="search-row-title">
                {hit.title}
                {hit.firstAirDate ? ` (${hit.firstAirDate.slice(0, 4)})` : ''}
              </span>
              <button type="button" className="btn" onClick={() => setRatingTarget(hit)}>
                {existing ? t(lang, existing.rating) : t(lang, 'rate')}
              </button>
            </li>
          );
        })}
      </ul>

      <label className="field-label">
        {t(lang, 'bootstrapNoteLabel')}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </label>

      <button type="button" className="btn btn-primary" disabled={!reached || saving} onClick={buildLists}>
        {saving ? t(lang, 'bootstrapSaving') : t(lang, 'bootstrapBuild')}
      </button>
      {saveError ? <p className="error-note" role="alert">{saveError}</p> : null}

      {ratingTarget ? (
        <RatingDialog
          lang={lang}
          title={ratingTarget.title}
          onSubmit={submitRating}
          onClose={() => setRatingTarget(null)}
        />
      ) : null}
    </section>
  );
}
