import type { Profile, UiLang } from '../types';
import { t } from '../i18n';

interface Props {
  lang: UiLang;
  profiles: Profile[];
  stub: boolean;
  onSelect: (profile: Profile) => void;
}

/** Mock 1 — Profile picker. No personal vs. joint types. */
export function ProfilePicker({ lang, profiles, stub, onSelect }: Props) {
  return (
    <section>
      <h2>{t(lang, 'whoWatching')}</h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      <div className="profile-grid">
        {profiles.map((p) => (
          <button key={p.id} type="button" className="profile-card" onClick={() => onSelect(p)}>
            <span className="profile-icon" aria-hidden="true">
              {p.name.trim().charAt(0).toUpperCase()}
            </span>
            <span className="profile-name">{p.name}</span>
            <span className="profile-meta">
              {p.noteCount ?? 0} · {p.listsUpdatedAt ?? t(lang, 'neverUpdated')}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="profile-card profile-card-new"
          onClick={() => window.alert(t(lang, 'newProfile') + ' — milestone 2')}
        >
          <span className="profile-icon" aria-hidden="true">+</span>
          <span className="profile-name">{t(lang, 'newProfile')}</span>
        </button>
      </div>
      {profiles.length > 0 ? (
        <button type="button" className="btn btn-primary" onClick={() => onSelect(profiles[0])}>
          {t(lang, 'continueAs')} {profiles[0].name}
        </button>
      ) : null}
    </section>
  );
}
