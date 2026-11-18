import { useCallback, useEffect, useState } from 'react';
import { api, type Mood } from '../api';
import type { ListItem, Profile, Rating, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { formatRule } from '../formatRule';
import { RailCard } from '../components/ShowCard';
import { Rail } from '../components/Rail';
import { ShowSheet } from '../components/ShowSheet';
import { RatingDialog, RemoveDialog } from '../components/Dialogs';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
  onOpenShow: (tmdbId: number, item?: ListItem) => void;
  onProfileChanged?: (profile: Profile) => void;
  onRateShow: () => void;
}

/**
 * Mobile viewport (max-width: 640px), matching the CSS breakpoint where
 * rail cards go poster-only. The card tap opens the bottom sheet on
 * mobile and the detail view above it.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

/**
 * Mock 3 — Home. Two Top 10 lists, nothing more. Both quick actions remove
 * the show from the list (spec §7); rating removes it from BOTH lists.
 *
 * Moods: one overlay at a time on the main list. The chip row switches
 * (stored lists are fetched, not regenerated, unless stale); the
 * manage sheet holds the full list, delete, and creation; the "+"
 * chip is the quick-add. The selection persists on the profile
 * server-side until the user picks the main list or deletes the mood.
 *
 * Mobile: rail cards are poster-only and the tap opens a bottom sheet
 * (ShowSheet) with the title, rating, rationale, and quick actions;
 * "Full details" in the sheet opens the regular detail view.
 */
export function Home({ lang, profile, onOpenShow, onProfileChanged, onRateShow }: Props) {
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
  const [sheetItem, setSheetItem] = useState<ListItem | null>(null);
  const isMobile = useIsMobile();

  // A sheet left open across a resize to desktop unmounts with the
  // breakpoint; clear the stale selection with it.
  useEffect(() => {
    if (!isMobile) setSheetItem(null);
  }, [isMobile]);
  const [moods, setMoods] = useState<Mood[]>([]);
  const [genreLabels, setGenreLabels] = useState<Record<string, string>>({});
  const [activeMoodId, setActiveMoodId] = useState<string | null>(profile.activeMoodId ?? null);
  const [activeMoodExpiresAt, setActiveMoodExpiresAt] = useState<number | null>(
    profile.activeMoodExpiresAt ?? null,
  );
  const [moodExpanded, setMoodExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newMoodText, setNewMoodText] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    (forceRefresh = false, moodId = '') => {
      // Generation is one call producing both lists, so both sections
      // show the building state until it resolves — including the
      // first-ever generation after onboarding completes.
      setGenerating(true);
      setLoadFailed(false);
      dismiss('lists-error');
      api
        .lists(profile.id, lang, forceRefresh, moodId)
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
              action: { label: t(lang, 'retry'), onClick: () => load(true, moodId) },
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
    const active = profile.activeMoodId ?? null;
    setActiveMoodId(active);
    setActiveMoodExpiresAt(profile.activeMoodExpiresAt ?? null);
    api
      .moods(profile.id, lang)
      .then((res) => {
        setMoods(res.moods);
        setGenreLabels(res.genreLabels ?? {});
      })
      .catch(() => {
        // Mood list failure leaves the main list usable; the chips
        // simply show the main list until the next load.
      });
    load(false, active ?? '');
  }, [profile.id, lang, load]);

  // Keep the local selection in sync if the profile object updates
  // (e.g. after the active-mood call returns the updated profile).
  useEffect(() => {
    setActiveMoodId(profile.activeMoodId ?? null);
    setActiveMoodExpiresAt(profile.activeMoodExpiresAt ?? null);
  }, [profile.activeMoodId, profile.activeMoodExpiresAt]);

  // A mood selection lapses 3 hours after selection. The server
  // enforces that on every read; the timer below keeps a long-lived
  // session honest, falling back to the main list silently when the
  // clock runs out (and clearing the stored selection best-effort).
  const clearExpiredMood = useCallback(() => {
    setActiveMoodId(null);
    setActiveMoodExpiresAt(null);
    onProfileChanged?.({ ...profile, activeMoodId: null, activeMoodExpiresAt: null });
    load(false, '');
    void api.setActiveMood(profile.id, null).catch(() => undefined);
  }, [load, onProfileChanged, profile]);

  useEffect(() => {
    if (activeMoodId === null || activeMoodExpiresAt === null) return;
    const remaining = activeMoodExpiresAt - Date.now();
    if (remaining <= 0) {
      clearExpiredMood();
      return;
    }
    const timer = setTimeout(clearExpiredMood, remaining);
    return () => clearTimeout(timer);
  }, [activeMoodId, activeMoodExpiresAt, clearExpiredMood]);

  // Timers don't fire reliably across sleep/suspension; re-check
  // whenever the view regains focus.
  useEffect(() => {
    const recheck = () => {
      if (activeMoodId !== null && activeMoodExpiresAt !== null && activeMoodExpiresAt <= Date.now()) {
        clearExpiredMood();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeMoodId, activeMoodExpiresAt, clearExpiredMood]);

  const activeMood = activeMoodId ? (moods.find((m) => m.id === activeMoodId) ?? null) : null;

  const rulesSummary = (mood: Mood): string =>
    mood.rules.length > 0
      ? mood.rules.map((r) => formatRule(lang, r, genreLabels)).join(' · ')
      : t(lang, 'moodNoRules');

  const switchMood = async (moodId: string | null) => {
    // Tapping the active mood deselects it (toggle) — there is no
    // explicit "main list" option anymore. Selecting stamps a fresh
    // 3-hour expiry on the server; the local expiry stays unknown
    // until the response arrives, so a stale timer can't clear the
    // new selection early.
    const target = moodId === activeMoodId ? null : moodId;
    const prev = activeMoodId;
    const prevExpiresAt = activeMoodExpiresAt;
    setActiveMoodId(target);
    setActiveMoodExpiresAt(null);
    setSheetOpen(false);
    load(false, target ?? '');
    try {
      const res = await api.setActiveMood(profile.id, target);
      onProfileChanged?.(res.profile);
      // Deliberately no moods refetch here: the server bumps
      // last_used_at, but the chip order stays as loaded until the
      // next view mount (refresh / navigation away and back), when
      // the mount effect fetches the new recency order.
    } catch (err) {
      setActiveMoodId(prev);
      setActiveMoodExpiresAt(prevExpiresAt);
      load(false, prev ?? '');
      notify(
        err instanceof ApiError && err.code === 'database_not_configured'
          ? t(lang, 'notSaved')
          : t(lang, 'searchError'),
        { kind: 'error' },
      );
    }
  };

  const createMood = async () => {
    const text = newMoodText.trim();
    if (!text || creating) return;
    setCreating(true);
    try {
      const { mood } = await api.createMood(profile.id, text);
      setMoods((prev) => [mood, ...prev.filter((m) => m.id !== mood.id)]);
      setNewMoodText('');
      setAddOpen(false);
      // Creating a mood activates it; its lists generate on first fetch.
      await switchMood(mood.id);
    } catch (err) {
      notify(
        err instanceof ApiError && err.code === 'database_not_configured'
          ? t(lang, 'notSaved')
          : t(lang, 'searchError'),
        { kind: 'error' },
      );
    } finally {
      setCreating(false);
    }
  };

  const deleteMood = async (moodId: string) => {
    const wasActive = moodId === activeMoodId;
    try {
      await api.deleteMood(profile.id, moodId);
      setMoods((prev) => prev.filter((m) => m.id !== moodId));
      if (wasActive) {
        // The server already cleared the active selection; mirror it
        // locally and fall back to the main list.
        setActiveMoodId(null);
        setActiveMoodExpiresAt(null);
        onProfileChanged?.({ ...profile, activeMoodId: null, activeMoodExpiresAt: null });
        load(false, '');
      }
    } catch (err) {
      notify(
        err instanceof ApiError && err.code === 'database_not_configured'
          ? t(lang, 'notSaved')
          : t(lang, 'searchError'),
        { kind: 'error' },
      );
    }
  };

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
      {generating ? (
        renderBuilding()
      ) : items.length === 0 ? (
        // On a failed load the error toast + retry action explains the
        // empty section; never show the generic short-list fallback.
        loadFailed ? null : (
          <p>{reason ?? t(lang, 'shortListReason')}</p>
        )
      ) : (
        <>
          <Rail label={title}>
            {items.map((item) => (
              <RailCard
                key={`${title}-${item.tmdbId}-${item.rank}`}
                item={item}
                lang={lang}
                onRemove={setRemoveTarget}
                onRate={setRateTarget}
                onOpen={(i) => {
                  if (isMobile) setSheetItem(i);
                  else onOpenShow(i.tmdbId, i);
                }}
              />
            ))}
          </Rail>
          {reason && items.length < 10 ? (
            <p className="short-reason">{reason}</p>
          ) : null}
        </>
      )}
    </section>
  );

  const renderAddRow = () => (
    <div className="mood-addrow">
      <input
        type="text"
        value={newMoodText}
        onChange={(e) => setNewMoodText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void createMood();
        }}
        placeholder={t(lang, 'moodAddPlaceholder')}
        maxLength={120}
        disabled={creating}
        aria-label={t(lang, 'moodAddPlaceholder')}
      />
      <button type="button" className="btn btn-primary" onClick={() => void createMood()} disabled={creating || !newMoodText.trim()}>
        {creating ? t(lang, 'moodCreating') : t(lang, 'moodAdd')}
      </button>
    </div>
  );

  return (
    <div>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      <div className="eyebrow">{t(lang, 'listsEyebrow')}</div>

      <div className={moodExpanded ? 'mood-card' : 'mood-card collapsed'}>
        <div className="mood-row-head">
          <button
            type="button"
            className="mood-head-toggle"
            onClick={() => {
              setMoodExpanded((v) => !v);
              setAddOpen(false);
            }}
            aria-expanded={moodExpanded}
          >
            <span className="mood-label">
              <span aria-hidden="true" className={activeMood ? 'mood-label-icon' : 'mood-label-icon dim'}>
                🎭{' '}
              </span>
              {t(lang, 'moodLabel')}
            </span>
            <span className="mood-head-right">
              {!moodExpanded && activeMood ? (
                <span className="mood-head-mood">{activeMood.text}</span>
              ) : null}
              <span className="chev" aria-hidden="true">
                {moodExpanded ? '▴' : '▾'}
              </span>
            </span>
          </button>
          {moodExpanded ? (
            <button type="button" className="btn btn-ghost" onClick={() => setSheetOpen(true)}>
              {t(lang, 'moodManage')}
            </button>
          ) : null}
        </div>
        {moodExpanded ? (
          <div className="mood-chips" role="group" aria-label={t(lang, 'moodLabel')}>
            {moods.map((mood) => (
              <button
                type="button"
                key={mood.id}
                className={mood.id === activeMoodId ? 'mood-chip active' : 'mood-chip'}
                aria-pressed={mood.id === activeMoodId}
                onClick={() => void switchMood(mood.id)}
              >
                {mood.text}
              </button>
            ))}
            <button
              type="button"
              className="mood-chip mood-chip-add"
              onClick={() => setAddOpen((v) => !v)}
              aria-expanded={addOpen}
            >
              {t(lang, 'moodNew')}
            </button>
          </div>
        ) : null}
        {moodExpanded && addOpen ? renderAddRow() : null}
      </div>

      {renderList(t(lang, 'casualTitle'), 'Casual Top 10', casual, casualReason)}
      {renderList(t(lang, 'deepTitle'), 'Deep Focus Top 10', deep, deepReason)}
      <p className="lists-meta">
        {t(lang, 'updated')}: {hasLoaded ? (updatedAt ?? t(lang, 'neverUpdated')) : t(lang, 'loading')}{' '}
        <button type="button" className="btn btn-ghost" onClick={() => load(true, activeMoodId ?? '')} disabled={generating}>
          {t(lang, 'refresh')}
        </button>
      </p>
      <button type="button" className="rate-btn" onClick={onRateShow}>
        + {t(lang, 'rateShow')}
      </button>

      {sheetOpen ? (
        <>
          <div className="mood-scrim" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <div className="mood-sheet" role="dialog" aria-label={t(lang, 'moodSheetTitle')}>
            <div className="mood-sheet-grab" aria-hidden="true" />
            <h3>{t(lang, 'moodSheetTitle')}</h3>
            <p className="mood-sheet-hint">{t(lang, 'moodSheetHint')}</p>
            {moods.map((mood) => (
              <div key={mood.id} className={mood.id === activeMoodId ? 'mood-srow sel' : 'mood-srow'}>
                <button
                  type="button"
                  className="mood-srow-select"
                  onClick={() => void switchMood(mood.id)}
                  aria-pressed={mood.id === activeMoodId}
                >
                  <span className="mood-radio" aria-hidden="true" />
                  <span className="mood-srow-grow">
                    <span className="mood-srow-name">{mood.text}</span>
                    <br />
                    <span className="mood-srow-rules">{rulesSummary(mood)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mood-srow-del"
                  aria-label={`${t(lang, 'moodDelete')}: ${mood.text}`}
                  onClick={() => void deleteMood(mood.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {renderAddRow()}
            <button type="button" className="btn btn-ghost" onClick={() => setSheetOpen(false)}>
              {t(lang, 'close')}
            </button>
          </div>
        </>
      ) : null}

      {isMobile && sheetItem ? (
        <ShowSheet
          item={sheetItem}
          lang={lang}
          onClose={() => setSheetItem(null)}
          onRemove={(i) => {
            setSheetItem(null);
            setRemoveTarget(i);
          }}
          onRate={(i) => {
            setSheetItem(null);
            setRateTarget(i);
          }}
          onFullDetails={(i) => {
            setSheetItem(null);
            onOpenShow(i.tmdbId, i);
          }}
        />
      ) : null}

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
