import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profile: Profile;
}

const ALL_LANGUAGES = [
  { code: 'he', labelEn: 'Hebrew', labelHe: 'עברית' },
  { code: 'en', labelEn: 'English', labelHe: 'אנגלית' },
  { code: 'es', labelEn: 'Spanish', labelHe: 'ספרדית' },
  { code: 'ko', labelEn: 'Korean', labelHe: 'קוריאנית' },
  { code: 'fr', labelEn: 'French', labelHe: 'צרפתית' },
  { code: 'de', labelEn: 'German', labelHe: 'גרמנית' },
];

/** Mock 5 — Taste profile: living summary, contradiction flow, hard filter. */
export function TasteProfile({ lang, profile }: Props) {
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
    message: string;
  } | null>(null);
  const [languages, setLanguages] = useState<string[]>(profile.languages);
  const [note, setNote] = useState('');
  const [consolidating, setConsolidating] = useState(false);

  useEffect(() => {
    api.taste(profile.id, lang).then((res) => {
      setSummary(res.summary);
      setDraft(res.summary);
      setStub(Boolean(res.stub));
      setContradiction(res.contradiction);
      setLanguageConflict(res.languageConflict);
      if (res.profile) setLanguages(res.profile.languages);
    });
  }, [profile.id, lang]);

  const toggleLanguage = (code: string) => {
    setLanguages((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const consolidate = async () => {
    setConsolidating(true);
    try {
      const res = await api.consolidate(profile.id, lang);
      setSummary(res.summary);
      setDraft(res.summary);
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

      {editing ? (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setSummary(draft);
              setEditing(false);
            }}
          >
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
            <button type="button" className="btn btn-primary" onClick={() => setContradiction(null)}>
              {t(lang, 'acceptMerge')}
            </button>
            <button type="button" className="btn" onClick={() => setContradiction(null)}>
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
        />
        <button type="button" className="btn" onClick={() => setNote('')} disabled={!note.trim()}>
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
            onClick={() => toggleLanguage(l.code)}
            aria-pressed={languages.includes(l.code)}
          >
            {lang === 'he' ? l.labelHe : l.labelEn}
          </button>
        ))}
      </div>
      {languageConflict ? (
        <p className="notice" role="status">
          {languageConflict.message}{' '}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const code = ALL_LANGUAGES.find((l) => l.labelEn === languageConflict.praisedLanguage)?.code;
              if (code) setLanguages((prev) => [...new Set([...prev, code])]);
              setLanguageConflict(null);
            }}
          >
            {t(lang, 'addLanguage')} {languageConflict.praisedLanguage}
          </button>
        </p>
      ) : null}
    </section>
  );
}
