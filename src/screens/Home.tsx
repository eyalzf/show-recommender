import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ListItem, Profile, Rating, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { ShowCard } from '../components/ShowCard';
import { RatingDialog, RemoveDialog } from '../components/Dialogs';

interface Props {
  lang: UiLang;
  profile: Profile;
  onOpenShow: (tmdbId: number) => void;
  onAdhoc: () => void;
}

/**
 * Mock 3 — Home. Two Top 10 lists, nothing more. Both quick actions remove
 * the show from the list (spec §7); rating removes it from BOTH lists.
 */
export function Home({ lang, profile, onOpenShow, onAdhoc }: Props) {
  const [casual, setCasual] = useState<ListItem[]>([]);
  const [deep, setDeep] = useState<ListItem[]>([]);
  const [stub, setStub] = useState(false);
  const [stale, setStale] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [casualReason, setCasualReason] = useState<string | null>(null);
  const [deepReason, setDeepReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateTarget, setRateTarget] = useState<ListItem | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ListItem | null>(null);

  const load = useCallback(
    (forceRefresh = false) => {
      setGenerating(forceRefresh);
      setNotice(null);
      api
        .lists(profile.id, lang, forceRefresh)
        .then((res) => {
          setCasual(res.casual);
          setDeep(res.deep);
          setStub(Boolean(res.stub));
          setStale(Boolean(res.stale));
          setUpdatedAt(res.updatedAt);
          setCasualReason(res.casualShortReason ?? res.shortReason);
          setDeepReason(res.deepShortReason ?? res.shortReason);
          if (res.stale) setNotice(t(lang, 'listsStale'));
        })
        .catch((err: unknown) => {
          setNotice(
            err instanceof ApiError && err.code === 'tmdb_not_configured'
              ? t(lang, 'tmdbMissing')
              : t(lang, 'engineFailed'),
          );
        })
        .finally(() => setGenerating(false));
    },
    [profile.id, lang],
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
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
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

  const renderList = (title: string, items: ListItem[], reason: string | null) => (
    <section>
      <h2>{title}</h2>
      {items.length === 0 ? <p>{reason ?? t(lang, 'shortListReason')}</p> : null}
      {items.map((item) => (
        <ShowCard
          key={`${title}-${item.tmdbId}-${item.rank}`}
          item={item}
          lang={lang}
          onRemove={setRemoveTarget}
          onRate={setRateTarget}
          onOpen={(i) => onOpenShow(i.tmdbId)}
        />
      ))}
    </section>
  );

  return (
    <div>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <p>
        {t(lang, 'updated')}: {updatedAt ?? t(lang, 'neverUpdated')}{' '}
        <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={generating}>
          {t(lang, 'refresh')}
        </button>
      </p>
      {generating ? <p>{t(lang, 'listsGenerating')}</p> : null}
      {renderList(t(lang, 'casualTitle'), casual, casualReason)}
      {renderList(t(lang, 'deepTitle'), deep, deepReason)}
      <button type="button" className="btn" onClick={onAdhoc}>
        {t(lang, 'askAdhoc')}
      </button>

      {rateTarget ? (
        <RatingDialog
          lang={lang}
          title={rateTarget.title}
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
