import { useCallback, useEffect, useState } from 'react';
import { api, type Mood } from '../api';
import type { ListItem, Profile, Rating, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { formatRule } from '../formatRule';
import { RailCard } from '../components/ShowCard';
import { Rail } from '../components/Rail';
import { RatingDialog, RemoveDialog } from '../components/Dialogs';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
  onOpenShow: (tmdbId: number, item?: ListItem) => void;
  onProfileChanged?: (profile: Profile) => void;
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
 */
export function Home({ lang, profile, onOpenShow, onProfileChanged }: Props) {
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
  const [moods, setMoods] = useState<Mood[]>([]);
  const [genreLabels, setGenreLabels] = useState<Record<string, string>>({});
  const [activeMoodId, setActiveMoodId] = useState<string | null>(profile.activeMoodId ?? null);
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
  }, [profile.activeMoodId]);

  const activeMood = activeMoodId ? (moods.find((m) => m.id === activeMoodId) ?? null) : null;

  const rulesSummary = (mood: Mood): string =>
    mood.rules.length > 0
      ? mood.rules.map((r) => formatRule(lang, r, genreLabels)).join(' · ')
      : t(lang, 'moodNoRules');

  const switchMood = async (moodId: string | null) => {
    if (moodId === activeMoodId) {
      setSheetOpen(false);
      return;
    }
    const prev = activeMoodId;
    setActiveMoodId(moodId);
    setSheetOpen(false);
    load(false, moodId ?? '');
    try {
      const res = await api.setActiveMood(profile.id, moodId);
      onProfileChanged?.(res.profile);
      const m = await api.moods(profile.id, lang);
      setMoods(m.moods);
      setGenreLabels(m.genreLabels ?? {});
    } catch (err) {
      setActiveMoodId(prev);
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
        onProfileChanged?.({ ...profile, activeMoodId: null });
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
          <Rail label={title}>
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

      <div className="mood-row-head">
        <span className="mood-label">{t(lang, 'moodLabel')}</span>
        <button type="button" className="btn btn-ghost" onClick={() => setSheetOpen(true)}>
          {t(lang, 'moodManage')}
        </button>
      </div>
      <div className="mood-chips" role="group" aria-label={t(lang, 'moodLabel')}>
        <button
          type="button"
          className={activeMoodId === null ? 'mood-chip active' : 'mood-chip'}
          aria-pressed={activeMoodId === null}
          onClick={() => void switchMood(null)}
        >
          {t(lang, 'moodMain')}
        </button>
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
      {addOpen ? renderAddRow() : null}

      {activeMood ? (
        <div className="mood-banner">
          <div>
            <b>
              {t(lang, 'moodActivePrefix')}: {activeMood.text}
            </b>
            <div className="mood-banner-rules">{rulesSummary(activeMood)}</div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => void switchMood(null)}>
            {t(lang, 'moodBackToMain')}
          </button>
        </div>
      ) : null}

      {renderList(t(lang, 'casualTitle'), 'Casual Top 10', casual, casualReason)}
      {renderList(t(lang, 'deepTitle'), 'Deep Focus Top 10', deep, deepReason)}
      <p className="lists-meta">
        {t(lang, 'updated')}: {hasLoaded ? (updatedAt ?? t(lang, 'neverUpdated')) : t(lang, 'loading')}{' '}
        <button type="button" className="btn btn-ghost" onClick={() => load(true, activeMoodId ?? '')} disabled={generating}>
          {t(lang, 'refresh')}
        </button>
      </p>

      {sheetOpen ? (
        <>
          <div className="mood-scrim" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <div className="mood-sheet" role="dialog" aria-label={t(lang, 'moodSheetTitle')}>
            <div className="mood-sheet-grab" aria-hidden="true" />
            <h3>{t(lang, 'moodSheetTitle')}</h3>
            <p className="mood-sheet-hint">{t(lang, 'moodSheetHint')}</p>
            <button
              type="button"
              className={activeMoodId === null ? 'mood-srow sel' : 'mood-srow'}
              onClick={() => void switchMood(null)}
            >
              <span className="mood-radio" aria-hidden="true" />
              <span className="mood-srow-grow">
                <span className="mood-srow-name">{t(lang, 'moodMain')}</span>
                <br />
                <span className="mood-srow-rules">{t(lang, 'moodMainSub')}</span>
              </span>
            </button>
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
