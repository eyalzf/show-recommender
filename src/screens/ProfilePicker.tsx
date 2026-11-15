import { useRef, useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profiles: Profile[];
  stub: boolean;
  onSelect: (profile: Profile) => void;
  onProfilesChanged: () => void;
}

const ICON_PRESETS = ['🎬', '📺', '🍿', '🎭', '⭐', '❤️'];

const ALL_LANGUAGES = [
  { code: 'he', labelEn: 'Hebrew', labelHe: 'עברית' },
  { code: 'en', labelEn: 'English', labelHe: 'אנגלית' },
  { code: 'es', labelEn: 'Spanish', labelHe: 'ספרדית' },
  { code: 'ko', labelEn: 'Korean', labelHe: 'קוריאנית' },
  { code: 'fr', labelEn: 'French', labelHe: 'צרפתית' },
  { code: 'de', labelEn: 'German', labelHe: 'גרמנית' },
];

/** Profile picker + creation. No personal vs. joint types. */
export function ProfilePicker({ lang, profiles, stub, onSelect, onProfilesChanged }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [languages, setLanguages] = useState<string[]>(['he', 'en']);
  const [icon, setIcon] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const toggleLanguage = (code: string) => {
    setLanguages((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await api.createProfile(
        name.trim(),
        languages,
        lang,
        icon ? 'icon' : 'initials',
        icon,
      );
      const file = fileRef.current?.files?.[0];
      if (file) {
        await api.uploadIcon(res.profile.id, file);
      }
      setCreating(false);
      setName('');
      setIcon(null);
      setNotice(t(lang, 'profileCreated'));
      onProfilesChanged();
      onSelect(res.profile);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setNotice(t(lang, 'notSaved'));
      } else {
        setNotice(t(lang, 'searchError'));
      }
    } finally {
      setSaving(false);
    }
  };

  const renderIcon = (p: Profile) => {
    if (p.iconKind === 'image' && p.iconRef) {
      return (
        <img
          className="profile-icon-img"
          src={`/api/profiles/${encodeURIComponent(p.id)}/icon`}
          alt=""
          width="48"
          height="48"
        />
      );
    }
    if (p.iconKind === 'icon' && p.iconRef) {
      return <span className="profile-icon" aria-hidden="true">{p.iconRef}</span>;
    }
    return (
      <span className="profile-icon" aria-hidden="true">
        {p.name.trim().charAt(0).toUpperCase()}
      </span>
    );
  };

  return (
    <section>
      <h2>{t(lang, 'whoWatching')}</h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <div className="profile-grid">
        {profiles.map((p) => (
          <button key={p.id} type="button" className="profile-card" onClick={() => onSelect(p)}>
            {renderIcon(p)}
            <span className="profile-name">{p.name}</span>
            <span className="profile-meta">
              {p.noteCount ?? 0} · {p.listsUpdatedAt ?? t(lang, 'neverUpdated')}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="profile-card profile-card-new"
          onClick={() => setCreating((v) => !v)}
        >
          <span className="profile-icon" aria-hidden="true">+</span>
          <span className="profile-name">{t(lang, 'newProfile')}</span>
        </button>
      </div>

      {creating ? (
        <div className="create-profile">
          <label className="field-label">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(lang, 'profileNamePlaceholder')}
              aria-label={t(lang, 'profileNamePlaceholder')}
            />
          </label>
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
          <h3>{t(lang, 'iconChoice')}</h3>
          <div className="chips">
            {ICON_PRESETS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={icon === emoji ? 'chip chip-on' : 'chip chip-btn'}
                onClick={() => setIcon(icon === emoji ? null : emoji)}
                aria-pressed={icon === emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label className="field-label">
            {t(lang, 'uploadImage')}
            <input ref={fileRef} type="file" accept="image/*" />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={create}
            disabled={saving || !name.trim()}
          >
            {saving ? t(lang, 'creatingProfile') : t(lang, 'createProfile')}
          </button>
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <button type="button" className="btn btn-primary" onClick={() => onSelect(profiles[0])}>
          {t(lang, 'continueAs')} {profiles[0].name}
        </button>
      ) : null}
    </section>
  );
}
