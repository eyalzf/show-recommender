import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Profile, Rating, SearchHit, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { RatingDialog } from './Dialogs';
import { useNotify } from './Notifications';

const POSTER_THUMB = 'https://image.tmdb.org/t/p/w92';
const POSTER_GRID = 'https://image.tmdb.org/t/p/w185';

interface ShowPickerProps {
  lang: UiLang;
  profile: Profile;
  /** bootstrap: progress + taste note + Build button. add: rate-and-close. */
  mode: 'bootstrap' | 'add';
  onDone?: () => void;
  onClose?: () => void;
}

interface RatedEntry {
  tmdbId: number;
  title: string;
  originalLanguage: string;
  rating: Rating;
  reason: string;
}

type RateTarget = Pick<SearchHit, 'tmdbId' | 'title' | 'originalLanguage' | 'posterPath'>;

function yearOf(firstAirDate: string): string {
  return firstAirDate ? firstAirDate.slice(0, 4) : '';
}

/** One rich result row: poster thumbnail, titles, year, genres, origin, vote. */
function SearchRow({
  hit,
  lang,
  ratedRating,
  onRate,
}: {
  hit: SearchHit;
  lang: UiLang;
  ratedRating: Rating | null;
  onRate: (hit: SearchHit) => void;
}) {
  const year = yearOf(hit.firstAirDate);
  const meta = [
    year,
    hit.genres.slice(0, 3).join(', '),
    hit.originCountry.join(', '),
    hit.originalLanguage,
    hit.voteCount > 0 ? `★ ${hit.voteAverage.toFixed(1)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="search-row">
      {hit.posterPath ? (
        <img src={`${POSTER_THUMB}${hit.posterPath}`} alt="" width="46" height="69" loading="lazy" />
      ) : (
        <span className="poster-thumb-fallback" aria-hidden="true" />
      )}
      <span className="search-row-title">
        <span className="search-row-name">{hit.title}</span>
        {hit.originalTitle && hit.originalTitle !== hit.title ? (
          <span className="search-row-sub">{hit.originalTitle}</span>
        ) : null}
        {meta ? <span className="search-row-meta">{meta}</span> : null}
      </span>
      <button type="button" className="btn" onClick={() => onRate(hit)}>
        {ratedRating ? t(lang, ratedRating) : t(lang, 'rate')}
      </button>
    </li>
  );
}

/** One quick-pick poster card: full-bleed poster, title, year + vote, Rate. */
function QuickPickCard({
  hit,
  lang,
  ratedRating,
  onRate,
}: {
  hit: SearchHit;
  lang: UiLang;
  ratedRating: Rating | null;
  onRate: (hit: SearchHit) => void;
}) {
  const year = yearOf(hit.firstAirDate);
  const meta = [year, hit.voteCount > 0 ? `★ ${hit.voteAverage.toFixed(1)}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="quick-card">
      {hit.posterPath ? (
        <img className="quick-card-poster" src={`${POSTER_GRID}${hit.posterPath}`} alt="" loading="lazy" />
      ) : (
        <div className="quick-card-fallback" aria-hidden="true">
          {hit.title.charAt(0)}
        </div>
      )}
      <div className="quick-card-body">
        <div className="quick-card-title">{hit.title}</div>
        {meta ? <div className="quick-card-meta">{meta}</div> : null}
        <button type="button" className="btn btn-sm" onClick={() => onRate(hit)}>
          {ratedRating ? t(lang, ratedRating) : t(lang, 'rate')}
        </button>
      </div>
    </article>
  );
}

/**
 * The one show picker, shared by profile onboarding and "Add a show I
 * watched": debounced live search with rich rows, the shared rating
 * dialog, and (onboarding only) all-time quick picks. Ratings persist
 * immediately (the onboarding gate reads real server state, so resuming
 * works). "Add a show" is free-text search only — no popular list.
 */
export function ShowPicker({ lang, profile, mode, onDone, onClose }: ShowPickerProps) {
  const { notify, dismiss } = useNotify();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickPicks, setQuickPicks] = useState<SearchHit[] | null>(null);
  const [rated, setRated] = useState<Map<number, RatedEntry>>(new Map());
  const [ratingTarget, setRatingTarget] = useState<RateTarget | null>(null);
  const [note, setNote] = useState('');
  const [noteBaseline, setNoteBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | null>(null);

  // Quick picks are an onboarding affordance only: the add-a-show
  // modal is free-text search, and never fetches or lists them.
  const showQuickPicks = mode === 'bootstrap' && query.trim().length < 2;

  // Existing ratings: mark rows, drive progress, and make onboarding
  // resume exactly where it left off.
  useEffect(() => {
    api
      .feedbackList(profile.id)
      .then((res) => {
        const map = new Map<number, RatedEntry>();
        for (const f of res.feedback) {
          if (f.tmdbId == null || !f.rating || map.has(f.tmdbId)) continue;
          map.set(f.tmdbId, {
            tmdbId: f.tmdbId,
            title: f.showTitle ?? '',
            originalLanguage: f.originalLanguage ?? '',
            rating: f.rating as Rating,
            reason: f.reason,
          });
        }
        setRated(map);
      })
      .catch(() => setRated(new Map()));
  }, [profile.id]);

  // All-time quick picks (server blends popular + top-rated) — bootstrap only.
  useEffect(() => {
    if (mode !== 'bootstrap') return;
    setQuickPicks(null);
    api
      .quickPicks(profile.id, lang)
      .then((res) => setQuickPicks(res.results))
      .catch(() => notify(t(lang, 'searchError'), { kind: 'error', key: 'quickpicks-error' }));
  }, [mode, profile.id, lang, notify]);

  // Bootstrap: prefill the taste note from the latest saved note, so a
  // resumed session shows (and doesn't duplicate) what was already written.
  useEffect(() => {
    if (mode !== 'bootstrap') return;
    api
      .taste(profile.id, lang)
      .then((res) => {
        const existing = res.notes.find((n) => n.kind === 'note');
        if (existing) {
          setNote(existing.text);
          setNoteBaseline(existing.text);
        }
      })
      .catch(() => {});
  }, [mode, profile.id, lang]);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      dismiss('search-error');
      return;
    }
    setSearching(true);
    timer.current = window.setTimeout(() => {
      api
        .search(q, lang)
        .then((res) => {
          setHits(res.results);
          dismiss('search-error');
        })
        .catch((err: unknown) => {
          setHits([]);
          notify(
            err instanceof ApiError && err.code === 'tmdb_not_configured'
              ? t(lang, 'tmdbMissing')
              : t(lang, 'searchError'),
            { kind: 'error', key: 'search-error' },
          );
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, lang, notify, dismiss]);

  const ratedList = [...rated.values()];
  const negatives = ratedList.filter((r) => r.rating !== 'liked').length;
  const reached = ratedList.length >= 5 && negatives >= 1 && note.trim().length > 0;

  // "Minimum reached" is a one-time event, delivered through the single
  // notification system when the threshold is first crossed.
  const reachedRef = useRef(false);
  useEffect(() => {
    if (mode !== 'bootstrap') return;
    if (reached && !reachedRef.current) {
      notify(t(lang, 'bootstrapReached'), { kind: 'success' });
    }
    reachedRef.current = reached;
  }, [reached, mode, lang, notify]);

  const submitRating = async (rating: Rating, reason: string) => {
    if (!ratingTarget) return;
    const target = ratingTarget;
    setRatingTarget(null);
    const prev = rated.get(target.tmdbId);
    const entry: RatedEntry = {
      tmdbId: target.tmdbId,
      title: target.title,
      originalLanguage: target.originalLanguage,
      rating,
      reason,
    };
    setRated((m) => new Map(m).set(target.tmdbId, entry));
    try {
      await api.feedback(profile.id, target.tmdbId, rating, reason, target.title, target.originalLanguage);
      if (mode === 'add') notify(t(lang, 'watchedSaved'), { kind: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        // Demo mode: keep the rating locally and say so.
        notify(t(lang, 'notSaved'), { kind: 'error' });
        if (mode === 'add') notify(t(lang, 'watchedSaved'), { kind: 'success' });
        return;
      }
      notify(t(lang, 'searchError'), { kind: 'error' });
      setRated((m) => {
        const next = new Map(m);
        if (prev) next.set(target.tmdbId, prev);
        else next.delete(target.tmdbId);
        return next;
      });
    }
  };

  /** Bootstrap finish: persist the taste note if it changed, then continue. */
  const buildLists = async () => {
    setSaving(true);
    try {
      const text = note.trim();
      if (text && text !== noteBaseline) {
        await api.addNote(profile.id, text);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    onDone?.();
  };

  return (
    <div className={mode === 'add' ? 'picker-add' : undefined}>
      {mode === 'bootstrap' ? (
        <p>
          {ratedList.length} {t(lang, 'bootstrapProgress')}
          {negatives === 0 ? ` · ${t(lang, 'bootstrapNeedNegative')}` : ''}
        </p>
      ) : (
        <p className="muted">{t(lang, 'addWatchedHint')}</p>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t(lang, 'searchPlaceholder')}
        aria-label={t(lang, 'searchPlaceholder')}
      />

      <div className="picker-results">
        {showQuickPicks ? (
          <>
            <h3>{t(lang, 'quickPicksTitle')}</h3>
            {quickPicks === null ? <p>{t(lang, 'loading')}</p> : null}
            {quickPicks !== null && quickPicks.length === 0 ? <p>{t(lang, 'quickPicksEmpty')}</p> : null}
            {quickPicks !== null && quickPicks.length > 0 ? (
              <div className="quick-grid">
                {quickPicks.map((hit) => (
                  <QuickPickCard
                    key={hit.tmdbId}
                    hit={hit}
                    lang={lang}
                    ratedRating={rated.get(hit.tmdbId)?.rating ?? null}
                    onRate={(h) => setRatingTarget(h)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : query.trim().length >= 2 ? (
          <>
            {searching ? <p>{t(lang, 'loading')}</p> : null}
            {!searching && hits.length === 0 ? <p>{t(lang, 'noResults')}</p> : null}
            <ul className="search-results">
              {hits.map((hit) => (
                <SearchRow
                  key={hit.tmdbId}
                  hit={hit}
                  lang={lang}
                  ratedRating={rated.get(hit.tmdbId)?.rating ?? null}
                  onRate={(h) => setRatingTarget(h)}
                />
              ))}
            </ul>
          </>
        ) : null}

        {mode === 'bootstrap' && ratedList.length > 0 ? (
          <>
            <h3>{t(lang, 'ratedListTitle')}</h3>
            <ul className="search-results">
              {ratedList.map((r) => (
                <li key={r.tmdbId} className="search-row">
                  <span className="search-row-title">{r.title}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setRatingTarget({ tmdbId: r.tmdbId, title: r.title, originalLanguage: r.originalLanguage, posterPath: null })
                    }
                  >
                    {t(lang, r.rating)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {mode === 'bootstrap' ? (
        <>
          <label className="field-label">
            {t(lang, 'bootstrapNoteLabel')}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!reached || saving}
            onClick={buildLists}
          >
            {saving ? t(lang, 'bootstrapSaving') : t(lang, 'bootstrapBuild')}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t(lang, 'close')}
        </button>
      )}

      {ratingTarget ? (
        <RatingDialog
          lang={lang}
          title={ratingTarget.title}
          posterPath={ratingTarget.posterPath}
          onSubmit={submitRating}
          onClose={() => setRatingTarget(null)}
        />
      ) : null}
    </div>
  );
}
