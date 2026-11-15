import { useRef, useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { ALL_LANGUAGES, ICON_PRESETS } from '../profileMeta';
import { ShowPicker } from '../components/ShowPicker';

interface Props {
  lang: UiLang;
  onLangChange: (lang: UiLang) => void;
  /** Null for a brand-new profile; set when resuming an incomplete one. */
  profile: Profile | null;
  onDone: (profile: Profile) => void;
  onExit: () => void;
}

/**
 * Profile creation as a stepped flow: details first, then the bootstrap
 * show-picking minimum. A profile that has not completed the minimum
 * cannot reach the main screen — selecting it resumes this flow at the
 * show-picking step (the gate lives in App; this screen is the flow).
 */
export function Onboarding({ lang, onLangChange, profile, onDone, onExit }: Props) {
  const [step, setStep] = useState<1 | 2>(profile ? 2 : 1);
  const [workingProfile, setWorkingProfile] = useState<Profile | null>(profile);
  const [name, setName] = useState(profile?.name ?? '');
  const [languages, setLanguages] = useState<string[]>(profile?.languages ?? ['he', 'en']);
  const [icon, setIcon] = useState<string | null>(
    profile?.iconKind === 'icon' ? profile.iconRef : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const toggleLanguage = (code: string) => {
    setLanguages((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const submitDetails = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const iconKind = icon ? 'icon' : 'initials';
      let saved: Profile;
      if (workingProfile) {
        const res = await api.updateProfile(workingProfile.id, {
          name: name.trim(),
          languages,
          uiLanguage: lang,
          iconKind,
          iconRef: icon,
        });
        saved = res.profile;
      } else {
        const res = await api.createProfile(name.trim(), languages, lang, iconKind, icon);
        saved = res.profile;
      }
      const file = fileRef.current?.files?.[0];
      if (file) {
        const uploaded = await api.uploadIcon(saved.id, file);
        saved = { ...saved, iconKind: 'image', iconRef: uploaded.iconRef };
      }
      setWorkingProfile(saved);
      setStep(2);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        setError(t(lang, 'notSaved'));
      } else {
        setError(t(lang, 'searchError'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <p className="muted">
        {step === 1 ? <strong>1. {t(lang, 'onboardingDetails')}</strong> : <>1. {t(lang, 'onboardingDetails')}</>}
        {' — '}
        {step === 2 ? <strong>2. {t(lang, 'onboardingShows')}</strong> : <>2. {t(lang, 'onboardingShows')}</>}
      </p>

      {profile ? <p className="notice" role="status">{t(lang, 'onboardingResume')}</p> : null}

      {step === 1 ? (
        <>
          <h2>{profile ? profile.name : t(lang, 'onboardingNewTitle')}</h2>
          <div className="create-profile">
            <label className="field-label">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(lang, 'profileNamePlaceholder')}
                aria-label={t(lang, 'profileNamePlaceholder')}
                autoFocus
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

            <h3>{t(lang, 'uiLanguageLabel')}</h3>
            <div className="lang-toggle" role="group" aria-label={t(lang, 'uiLanguageLabel')}>
              <button
                type="button"
                className={lang === 'en' ? 'btn btn-primary' : 'btn'}
                onClick={() => onLangChange('en')}
              >
                EN
              </button>
              <button
                type="button"
                className={lang === 'he' ? 'btn btn-primary' : 'btn'}
                onClick={() => onLangChange('he')}
              >
                HE
              </button>
            </div>
          </div>

          {error ? <p className="error-note" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onExit}>
              {t(lang, 'back')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitDetails}
              disabled={saving || !name.trim()}
            >
              {saving ? t(lang, 'bootstrapSaving') : t(lang, 'onboardingContinue')}
            </button>
          </div>
        </>
      ) : workingProfile ? (
        <>
          <h2>
            {t(lang, 'onboardingShows')} — {workingProfile.name}
          </h2>
          <div className="rating-row">
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
              {t(lang, 'back')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onExit}>
              {t(lang, 'whoWatching')}
            </button>
          </div>
          <ShowPicker
            lang={lang}
            profile={workingProfile}
            mode="bootstrap"
            onDone={() => onDone(workingProfile)}
          />
        </>
      ) : null}
    </section>
  );
}
