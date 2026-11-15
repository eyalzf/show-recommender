import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile, TasteContradiction, TasteSectionKey, TasteSections, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { ALL_LANGUAGES } from '../profileMeta';

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
  const [sections, setSections] = useState<TasteSections>({ shared: '', casual: '', deep: '' });
  const [editingSection, setEditingSection] = useState<TasteSectionKey | null>(null);
  const [draft, setDraft] = useState('');
  const [stub, setStub] = useState(false);
  const [contradiction, setContradiction] = useState<TasteContradiction | null>(null);
  const [languageConflict, setLanguageConflict] = useState<{
    praisedLanguage: string;
    languageCode?: string;
    message: string;
  } | null>(null);
  const [languages, setLanguages] = useState<string[]>(profile.languages);
  const [notes, setNotes] = useState<{ id: string; kind: string; text: string }[]>([]);
  const [note, setNote] = useState('');
  const [noteKind, setNoteKind] = useState<'like' | 'dislike'>('like');
  const [consolidating, setConsolidating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.taste(profile.id, lang).then((res) => {
      setSections(sectionsFromResponse(res));
      setStub(Boolean(res.stub));
      setContradiction(res.contradiction);
      setLanguageConflict(res.languageConflict);
      setNotes(res.notes);
      if (res.profile) setLanguages(res.profile.languages);
    });
  }, [profile.id, lang]);

  const saveSections = async (next: TasteSections) => {
    setSections(next);
    setEditingSection(null);
    try {
      await api.updateTaste(profile.id, lang, next);
      setNotice(t(lang, 'tasteSaved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
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
      setNotice(t(lang, 'languagesSaved'));
      onProfileChanged?.(res.profile);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
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
    const next = [...new Set([...languages, code])];
    setLanguages(next);
    setLanguageConflict(null);
    try {
      const res = await api.updateProfile(profile.id, { languages: next });
      onProfileChanged?.(res.profile);
    } catch {
      // Language chips already reflect the choice locally; the notice
      // below covers the unsaved case.
      setNotice(t(lang, 'notSaved'));
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    const text = note.trim();
    setNote('');
    try {
      await api.addNote(profile.id, noteKind, text);
      setNotes((prev) => [{ id: `local-${Date.now()}`, kind: noteKind, text }, ...prev]);
      setNotice(t(lang, 'noteSaved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
      }
    }
  };

  const consolidate = async () => {
    setConsolidating(true);
    try {
      const res = await api.consolidate(profile.id, lang);
      setSections(sectionsFromResponse(res));
      setContradiction(res.contradictions[0] ?? null);
      if (res.languageConflict) {
        setLanguageConflict({
          praisedLanguage: res.languageConflict.languageName,
          languageCode: res.languageConflict.languageCode,
          message:
            res.languageConflict.message ??
            (lang === 'he'
              ? `ההערות משבחות ${res.languageConflict.languageName}, אבל השפה לא במסנן השפות של הפרופיל.`
              : `Your notes praise ${res.languageConflict.languageName}, but it is not in this profile's language filter.`),
        });
      }
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <section>
      <h2>
        {t(lang, 'tasteTitle')} — {profile.name}
      </h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}

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
              {sections[key].trim() ? (
                <p className="summary-text">{sections[key]}</p>
              ) : (
                <p className="summary-empty">{t(lang, 'tasteEmptySection')}</p>
              )}
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
      <button type="button" className="btn" onClick={consolidate} disabled={consolidating}>
        {consolidating ? t(lang, 'loading') : t(lang, 'refresh')}
      </button>

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
        <div className="rating-row" role="group">
          <button
            type="button"
            className={noteKind === 'like' ? 'btn btn-primary' : 'btn'}
            onClick={() => setNoteKind('like')}
          >
            {t(lang, 'noteKindLike')}
          </button>
          <button
            type="button"
            className={noteKind === 'dislike' ? 'btn btn-primary' : 'btn'}
            onClick={() => setNoteKind('dislike')}
          >
            {t(lang, 'noteKindDislike')}
          </button>
        </div>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t(lang, 'addNotePlaceholder')}
          aria-label={t(lang, 'addNotePlaceholder')}
        />
        <button type="button" className="btn" onClick={addNote} disabled={!note.trim()}>
          {t(lang, 'addNote')}
        </button>
      </div>

      {notes.length > 0 ? (
        <ul className="inbox">
          {notes.map((n) => (
            <li key={n.id}>
              <strong>{n.kind}</strong> — {n.text}
            </li>
          ))}
        </ul>
      ) : null}

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
      {languageConflict ? (
        <p className="notice" role="status">
          {languageConflict.message}{' '}
          <button type="button" className="btn btn-ghost" onClick={addLanguageFromConflict}>
            {t(lang, 'addLanguage')} {languageConflict.praisedLanguage}
          </button>
        </p>
      ) : null}
    </section>
  );
}
