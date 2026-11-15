import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ListItem, Profile, Rating, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { RailCard } from '../components/ShowCard';
import { Rail } from '../components/Rail';
import { RatingDialog, RemoveDialog } from '../components/Dialogs';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
  onOpenShow: (tmdbId: number, item?: ListItem) => void;
  onAdhoc: () => void;
}

/**
 * Mock 3 — Home. Two Top 10 lists, nothing more. Both quick actions remove
 * the show from the list (spec §7); rating removes it from BOTH lists.
 */
export function Home({ lang, profile, onOpenShow, onAdhoc }: Props) {
  const { notify, dismiss } = useNotify();
  const [casual, setCasual] = useState<ListItem[]>([]);
  const [deep, setDeep] = useState<ListItem[]>([]);
  const [stub, setStub] = useState(false);
  const [stale, setStale] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [casualReason, setCasualReason] = useState<string | null>(null);
  const [deepReason, setDeepReason] = useState<string | null>(null);
  const [rateTarget, setRateTarget] = useState<ListItem | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ListItem | null>(null);

  const load = useCallback(
    (forceRefresh = false) => {
      // Generation is one call producing both lists, so both sections
      // show the building state until it resolves — including the
      // first-ever generation after onboarding completes.
      setGenerating(true);
      setLoadFailed(false);
      dismiss('lists-error');
      api
        .lists(profile.id, lang, forceRefresh)
        .then((res) => {
          setCasual(res.casual);
          setDeep(res.deep);
          setStub(Boolean(res.stub));
          setStale(Boolean(res.stale));
          setUpdatedAt(res.updatedAt);
          setCasualReason(res.casualShortReason);
          setDeepReason(res.deepShortReason);
          if (res.stale) notify(t(lang, 'listsStale'), { key: 'lists-stale' });
        })
        .catch((err: unknown) => {
          setLoadFailed(true);
          notify(
            err instanceof ApiError && err.code === 'tmdb_not_configured'
              ? t(lang, 'tmdbMissing')
              : t(lang, 'engineFailed'),
            {
              kind: 'error',
              sticky: true,
              key: 'lists-error',
              action: { label: t(lang, 'retry'), onClick: () => load(true) },
            },
          );
        })
        .finally(() => {
          setGenerating(false);
          setHasLoaded(true);
        });
    },
    [profile.id, lang, notify, dismiss],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const dropFromLists = (tmdbId: number) => {
    setCasual((prev) => prev.filter((i) => i.tmdbId !== tmdbId));
    setDeep((prev) => prev.filter((i) => i.tmdbId !== tmdbId));
  };

  /** Persist best-effort; in demo mode the server says so and we say so. */
  const persist = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
    }
  };

  const submitRating = (rating: Rating, reason: string) => {
    if (!rateTarget) return;
    const target = rateTarget;
    setRateTarget(null);
    dropFromLists(target.tmdbId);
    void persist(() => api.feedback(profile.id, target.tmdbId, rating, reason, target.title));
  };

  const submitRemoveDislike = (reason: string) => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    dropFromLists(target.tmdbId);
    void persist(() => api.feedback(profile.id, target.tmdbId, 'disliked', reason, target.title));
  };

  const submitRemoveNoReason = () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    dropFromLists(target.tmdbId);
    void persist(() => api.deny(profile.id, target.tmdbId));
  };

  const renderBuilding = () => (
    <div role="status" aria-live="polite">
      <p className="building-line">
        <span className="spinner" aria-hidden="true" />
        {t(lang, 'listsGenerating')}
      </p>
      <div className="rail-skeletons" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="skeleton-card rail-skeleton" key={i}>
            <div className="skeleton-poster" />
            <div className="skeleton-body">
              <div className="skeleton-bar skeleton-bar-title" />
              <div className="skeleton-bar skeleton-bar-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderList = (title: string, subEn: string, items: ListItem[], reason: string | null) => (
    <section className="list-section">
      <div className="section-head">
        <h2>{title}</h2>
        {lang === 'he' ? <div className="section-sub">{subEn}</div> : null}
        <div className="hairline" aria-hidden="true" />
      </div>
      {generating && items.length === 0 ? (
        renderBuilding()
      ) : items.length === 0 ? (
        // On a failed load the error toast + retry action explains the
        // empty section; never show the generic short-list fallback.
        loadFailed ? null : (
          <p>{reason ?? t(lang, 'shortListReason')}</p>
        )
      ) : (
        <>
          {generating ? (
            <p className="building-line" role="status">
              <span className="spinner" aria-hidden="true" />
              {t(lang, 'buildingList')}
            </p>
          ) : null}
          <Rail lang={lang} label={title}>
            {items.map((item) => (
              <RailCard
                key={`${title}-${item.tmdbId}-${item.rank}`}
                item={item}
                lang={lang}
                onRemove={setRemoveTarget}
                onRate={setRateTarget}
                onOpen={(i) => onOpenShow(i.tmdbId, i)}
              />
            ))}
          </Rail>
          {reason && items.length < 10 && !generating ? (
            <p className="short-reason">{reason}</p>
          ) : null}
        </>
      )}
    </section>
  );

  return (
    <div>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      <div className="eyebrow">{t(lang, 'listsEyebrow')}</div>
      {renderList(t(lang, 'casualTitle'), 'Casual Top 10', casual, casualReason)}
      {renderList(t(lang, 'deepTitle'), 'Deep Focus Top 10', deep, deepReason)}
      <p className="lists-meta">
        {t(lang, 'updated')}: {hasLoaded ? (updatedAt ?? t(lang, 'neverUpdated')) : t(lang, 'loading')}{' '}
        <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={generating}>
          {t(lang, 'refresh')}
        </button>
      </p>
      <button type="button" className="btn" onClick={onAdhoc}>
        {t(lang, 'askAdhoc')}
      </button>

      {rateTarget ? (
        <RatingDialog
          lang={lang}
          title={rateTarget.title}
          posterPath={rateTarget.posterPath}
          onSubmit={submitRating}
          onClose={() => setRateTarget(null)}
        />
      ) : null}
      {removeTarget ? (
        <RemoveDialog
          lang={lang}
          title={removeTarget.title}
          onDislike={submitRemoveDislike}
          onNoReason={submitRemoveNoReason}
          onClose={() => setRemoveTarget(null)}
        />
      ) : null}
    </div>
  );
}
