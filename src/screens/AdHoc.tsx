import { useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profile: Profile;
  onOpenShow: (tmdbId: number) => void;
}

/**
 * Mock 7 — Ad-hoc flow. Free-text in, one explained pick out. Fully
 * independent: the request changes neither the taste summary nor the
 * lists (spec §7, build rule 8). Rating the show afterwards counts as
 * normal feedback.
 */
export function AdHoc({ lang, profile, onOpenShow }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    tmdbId: number;
    title: string;
    originalLanguage: string;
    firstAirDate: string;
    posterPath: string | null;
    genres: string[];
    rationale: string;
  } | null>(null);
  const [history, setHistory] = useState<{ query: string; title: string }[]>([]);

  const ask = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.adhoc(profile.id, query.trim(), lang);
      setResult(res.result);
      setHistory((prev) => [{ query: query.trim(), title: res.result.title }, ...prev]);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'tmdb_not_configured'
          ? t(lang, 'tmdbMissing')
          : t(lang, 'searchError'),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2>{t(lang, 'adhocTitle')}</h2>
      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t(lang, 'adhocPlaceholder')}
        aria-label={t(lang, 'adhocTitle')}
        rows={3}
      />
      <button type="button" className="btn btn-primary" onClick={ask} disabled={loading || !query.trim()}>
        {loading ? t(lang, 'loading') : t(lang, 'adhocGet')}
      </button>
      {error ? <p className="error-note" role="alert">{error}</p> : null}
      {result ? (
        <article className="card">
          {result.posterPath ? (
            <img
              className="card-poster"
              src={`https://image.tmdb.org/t/p/w185${result.posterPath}`}
              alt=""
              width="62"
              height="93"
              loading="lazy"
            />
          ) : null}
          <div className="card-body">
            <h3 className="card-title">
              <button type="button" className="linklike" onClick={() => onOpenShow(result.tmdbId)}>
                {result.title}
              </button>
            </h3>
            <div className="chips">
              <span className="chip">{result.originalLanguage}</span>
              {result.genres.map((g) => (
                <span key={g} className="chip">{g}</span>
              ))}
              {result.firstAirDate ? <span className="chip">{result.firstAirDate.slice(0, 4)}</span> : null}
            </div>
            <p className="rationale">{result.rationale}</p>
          </div>
        </article>
      ) : null}
      <p className="muted">{t(lang, 'adhocNote')}</p>

      {history.length > 0 ? (
        <>
          <h3>{t(lang, 'adhocHistory')}</h3>
          <ul className="inbox">
            {history.map((h, i) => (
              <li key={i}>“{h.query}” → <strong>{h.title}</strong></li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
