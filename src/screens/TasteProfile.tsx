import { useEffect, useRef, useState } from 'react';
import { api, type PreferenceRule } from '../api';
import type { Profile, TasteContradiction, TasteSectionKey, TasteSections, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { formatRule } from '../formatRule';
import { ALL_LANGUAGES } from '../profileMeta';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
  onProfileChanged?: (profile: Profile) => void;
}

const SECTION_KEYS: TasteSectionKey[] = ['shared', 'casual', 'deep'];

function sectionLabel(lang: UiLang, key: TasteSectionKey): string {
  if (key === 'casual') return t(lang, 'tasteCasual');
  if (key === 'deep') return t(lang, 'tasteDeep');
  return t(lang, 'tasteShared');
}

function sectionsFromResponse(res: {
  sections?: TasteSections;
  summary: string;
}): TasteSections {
  // Older payloads carry only the combined string: it reads as Shared.
  if (res.sections && typeof res.sections === 'object') {
    return {
      shared: res.sections.shared ?? '',
      casual: res.sections.casual ?? '',
      deep: res.sections.deep ?? '',
    };
  }
  return { shared: res.summary ?? '', casual: '', deep: '' };
}

/** Taste profile: sectioned living summary, contradiction flow, hard filter. */
export function TasteProfile({ lang, profile, onProfileChanged }: Props) {
  const { notify, dismiss } = useNotify();
  const [sections, setSections] = useState<TasteSections>({ shared: '', casual: '', deep: '' });
  const [editingSection, setEditingSection] = useState<TasteSectionKey | null>(null);
  const [draft, setDraft] = useState('');
  const [stub, setStub] = useState(false);
  const [contradiction, setContradiction] = useState<TasteContradiction | null>(null);
  const [rules, setRules] = useState<PreferenceRule[]>([]);
  const [genreLabels, setGenreLabels] = useState<Record<string, string>>({});
  const [languageConflict, setLanguageConflict] = useState<{
    praisedLanguage: string;
    languageCode?: string;
    message: string;
  } | null>(null);
  const [languages, setLanguages] = useState<string[]>(profile.languages);
  const [note, setNote] = useState('');
  const [updating, setUpdating] = useState(false);
  const [loadingTaste, setLoadingTaste] = useState(true);
  // Guards the post-note polling loop against unmount.
  const aliveRef = useRef(true);
  // Fresh languages for the conflict toast action, whose closure is
  // frozen when the toast is shown (see the conflict effect below).
  const languagesRef = useRef(languages);
  languagesRef.current = languages;
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLoadingTaste(true);
    api
      .taste(profile.id, lang)
      .then((res) => {
        setSections(sectionsFromResponse(res));
        setStub(Boolean(res.stub));
        setContradiction(res.contradiction);
        setRules(res.rules ?? []);
        setGenreLabels(res.genreLabels ?? {});
        setLanguageConflict(res.languageConflict);
        if (res.profile) setLanguages(res.profile.languages);
      })
      .catch(() => {})
      .finally(() => {
        if (aliveRef.current) setLoadingTaste(false);
      });
  }, [profile.id, lang]);

  const saveSections = async (next: TasteSections) => {
    setSections(next);
    setEditingSection(null);
    try {
      await api.updateTaste(profile.id, lang, next);
      notify(t(lang, 'tasteSaved'), { kind: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
    }
  };

  const saveSection = (key: TasteSectionKey, text: string) =>
    saveSections({ ...sections, [key]: text });

  const toggleLanguage = async (code: string) => {
    const next = languages.includes(code) ? languages.filter((c) => c !== code) : [...languages, code];
    setLanguages(next);
    try {
      const res = await api.updateProfile(profile.id, { languages: next });
      notify(t(lang, 'languagesSaved'), { kind: 'success' });
      onProfileChanged?.(res.profile);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
    }
  };

  const addLanguageFromConflict = async () => {
    if (!languageConflict) return;
    const code =
      languageConflict.languageCode ??
      ALL_LANGUAGES.find((l) => l.labelEn === languageConflict.praisedLanguage)?.code;
    if (!code) {
      setLanguageConflict(null);
      return;
    }
    const next = [...new Set([...languagesRef.current, code])];
    setLanguages(next);
    setLanguageConflict(null);
    try {
      const res = await api.updateProfile(profile.id, { languages: next });
      onProfileChanged?.(res.profile);
    } catch {
      // Language chips already reflect the choice locally; the toast
      // below covers the unsaved case.
      notify(t(lang, 'notSaved'), { kind: 'error' });
    }
  };

  // The language conflict is an event message with an action, so it
  // goes through the single notification system (sticky, until the
  // conflict clears or the user dismisses it). The language chips
  // below remain the persistent way to change languages.
  useEffect(() => {
    if (!languageConflict) {
      dismiss('language-conflict');
      return;
    }
    notify(languageConflict.message, {
      key: 'language-conflict',
      sticky: true,
      action: {
        label: `${t(lang, 'addLanguage')} ${languageConflict.praisedLanguage}`,
        onClick: () => void addLanguageFromConflict(),
      },
    });
    // The toast action reads the conflict through the closure on
    // purpose: the conflict it resolves is the one that was current
    // when the toast appeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageConflict]);

  const addNote = async () => {
    if (!note.trim() || updating) return;
    const text = note.trim();
    const before = JSON.stringify(sections);
    setNote('');
    try {
      await api.addNote(profile.id, text);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
      return;
    }
    // Consolidation is deferred and fingerprint-gated: the note
    // write itself schedules nothing post-bootstrap, so the first
    // poll below schedules it (the taste self-heal), and the
    // server's claim-guard dedupes the overlapping polls into a
    // single run. The cards show the calculating state (below)
    // while a sticky toast carries the progress message; both
    // retire when the fresh sections arrive. Poll until the
    // sections change or a sane timeout, then show whatever the
    // server returns — never hang.
    notify(t(lang, 'noteUpdating'), { key: 'note-updating', sticky: true });
    setUpdating(true);
    try {
      const deadline = Date.now() + 30000;
      let latest: TasteSections | null = null;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!aliveRef.current) return;
        try {
          const res = await api.taste(profile.id, lang);
          latest = sectionsFromResponse(res);
          if (JSON.stringify(latest) !== before || Date.now() >= deadline) {
            setSections(latest);
            setContradiction(res.contradiction);
            setRules(res.rules ?? []);
            setGenreLabels(res.genreLabels ?? {});
            setLanguageConflict(res.languageConflict);
            break;
          }
        } catch {
          if (Date.now() >= deadline) break;
        }
        if (Date.now() >= deadline) break;
      }
      if (latest && aliveRef.current) notify(t(lang, 'noteSaved'), { kind: 'success' });
    } finally {
      dismiss('note-updating');
      if (aliveRef.current) setUpdating(false);
    }
  };

  // Calculating covers the initial load AND the post-note refresh: in
  // both cases every card says so instead of appearing empty. Once the
  // calculation settles, a genuinely empty section keeps its minimal
  // empty presentation.
  const calculating = loadingTaste || updating;

  // Derived preference rules, shown read-only: they come from the
  // notes, and a new note is what changes them. Hard rules filter
  // the lists; soft rules nudge the ranking.

  return (
    <section>
      <h2>
        {t(lang, 'tasteTitle')} — {profile.name}
      </h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}

      <p className="taste-hint">{t(lang, 'tasteSectionsHint')}</p>
      {SECTION_KEYS.map((key) => (
        <div className="taste-section" key={key}>
          <h3>{sectionLabel(lang, key)}</h3>
          {editingSection === key ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                aria-label={sectionLabel(lang, key)}
              />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void saveSection(key, draft)}
                >
                  {t(lang, 'save')}
                </button>
                <button type="button" className="btn" onClick={() => setEditingSection(null)}>
                  {t(lang, 'cancel')}
                </button>
              </div>
            </>
          ) : (
            <>
              {calculating ? (
                <p className="building-line" role="status">
                  <span className="spinner" aria-hidden="true" />
                  {t(lang, 'tasteCalculating')}
                </p>
              ) : null}
              {sections[key].trim() ? (
                <p className={calculating ? 'summary-text is-stale' : 'summary-text'}>{sections[key]}</p>
              ) : !calculating ? (
                <p className="summary-empty">{t(lang, 'tasteEmptySection')}</p>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDraft(sections[key]);
                  setEditingSection(key);
                }}
              >
                {t(lang, 'edit')}
              </button>
            </>
          )}
        </div>
      ))}

      {rules.length > 0 ? (
        <div className="taste-section">
          <h3>{t(lang, 'tasteRules')}</h3>
          {rules.map((rule, i) => (
            <p key={`${rule.dimension}-${rule.operator}-${rule.value}-${rule.mode}-${i}`} className="summary-text">
              {formatRule(lang, rule, genreLabels)}
            </p>
          ))}
          <p className="taste-hint">{t(lang, 'tasteRulesHint')}</p>
        </div>
      ) : null}

      {contradiction ? (
        <div className="contradiction">
          <h3>{t(lang, 'contradictionTitle')}</h3>
          <p>
            <strong>{t(lang, 'contradictionScope')}:</strong>{' '}
            {sectionLabel(lang, contradiction.scope)}
          </p>
          <p><strong>Old:</strong> {contradiction.oldText}</p>
          <p><strong>New:</strong> {contradiction.newText}</p>
          <p><strong>Proposed merge:</strong> {contradiction.proposedMerge}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setContradiction(null);
                void saveSection(contradiction.scope, contradiction.proposedMerge);
              }}
            >
              {t(lang, 'acceptMerge')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setContradiction(null);
                void saveSection(contradiction.scope, contradiction.newText);
              }}
            >
              {t(lang, 'replace')}
            </button>
            <button type="button" className="btn" onClick={() => setContradiction(null)}>
              {t(lang, 'keepOld')}
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t(lang, 'addNotePlaceholder')}
          aria-label={t(lang, 'addNotePlaceholder')}
          disabled={updating}
        />
        <button type="button" className="btn" onClick={addNote} disabled={!note.trim() || updating}>
          {t(lang, 'addNote')}
        </button>
      </div>

      <h3>{t(lang, 'languagesLabel')}</h3>
      <div className="chips">
        {ALL_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            className={languages.includes(l.code) ? 'chip chip-on' : 'chip chip-btn'}
            onClick={() => void toggleLanguage(l.code)}
            aria-pressed={languages.includes(l.code)}
          >
            {lang === 'he' ? l.labelHe : l.labelEn}
          </button>
        ))}
      </div>
    </section>
  );
}
