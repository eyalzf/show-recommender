import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profile: Profile;
  onProfileChanged?: (profile: Profile) => void;
}

const ALL_LANGUAGES = [
  { code: 'he', labelEn: 'Hebrew', labelHe: 'עברית' },
  { code: 'en', labelEn: 'English', labelHe: 'אנגלית' },
  { code: 'es', labelEn: 'Spanish', labelHe: 'ספרדית' },
  { code: 'ko', labelEn: 'Korean', labelHe: 'קוריאנית' },
  { code: 'fr', labelEn: 'French', labelHe: 'צרפתית' },
  { code: 'de', labelEn: 'German', labelHe: 'גרמנית' },
];

/** Taste profile: living summary, contradiction flow, hard filter. */
export function TasteProfile({ lang, profile, onProfileChanged }: Props) {
  const [summary, setSummary] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [stub, setStub] = useState(false);
  const [contradiction, setContradiction] = useState<{
    oldText: string;
    newText: string;
    proposedMerge: string;
  } | null>(null);
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
      setSummary(res.summary);
      setDraft(res.summary);
      setStub(Boolean(res.stub));
      setContradiction(res.contradiction);
      setLanguageConflict(res.languageConflict);
      setNotes(res.notes);
      if (res.profile) setLanguages(res.profile.languages);
    });
  }, [profile.id, lang]);

  const saveSummary = async (text: string) => {
    setSummary(text);
    setDraft(text);
    setEditing(false);
    try {
      await api.updateTaste(profile.id, lang, text);
      setNotice(t(lang, 'tasteSaved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
      }
    }
  };

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
      setSummary(res.summary);
      setDraft(res.summary);
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

      {editing ? (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />
          <button type="button" className="btn btn-primary" onClick={() => void saveSummary(draft)}>
            {t(lang, 'save')}
          </button>
        </>
      ) : (
        <>
          <p className="summary-text">{summary}</p>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {t(lang, 'edit')}
          </button>
        </>
      )}
      <button type="button" className="btn" onClick={consolidate} disabled={consolidating}>
        {consolidating ? t(lang, 'loading') : t(lang, 'refresh')}
      </button>

      {contradiction ? (
        <div className="contradiction">
          <h3>{t(lang, 'contradictionTitle')}</h3>
          <p><strong>Old:</strong> {contradiction.oldText}</p>
          <p><strong>New:</strong> {contradiction.newText}</p>
          <p><strong>Proposed merge:</strong> {contradiction.proposedMerge}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setContradiction(null);
                void saveSummary(contradiction.proposedMerge);
              }}
            >
              {t(lang, 'acceptMerge')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setContradiction(null);
                void saveSummary(contradiction.newText);
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
