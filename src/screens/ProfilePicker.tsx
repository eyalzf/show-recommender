import type { Profile, UiLang } from '../types';
import { t } from '../i18n';
import { ProfileIcon } from '../components/ProfileIcon';

interface Props {
  lang: UiLang;
  profiles: Profile[];
  stub: boolean;
  onSelect: (profile: Profile) => void;
  onCreateNew: () => void;
}

/** Profile picker. Creation lives in the onboarding flow; picking an
 * incomplete profile resumes it (the gate lives in App). No personal vs.
 * joint types. */
export function ProfilePicker({ lang, profiles, stub, onSelect, onCreateNew }: Props) {
  return (
    <section>
      <h2>{t(lang, 'whoWatching')}</h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}
      <div className="profile-grid">
        {profiles.map((p) => {
          const incomplete = p.bootstrap && !p.bootstrap.complete;
          return (
            <button key={p.id} type="button" className="profile-card" onClick={() => onSelect(p)}>
              <ProfileIcon profile={p} />
              <span className="profile-name">{p.name}</span>
              {incomplete ? (
                <span className="profile-meta">{t(lang, 'setupIncomplete')}</span>
              ) : null}
            </button>
          );
        })}
        <button type="button" className="profile-card profile-card-new" onClick={onCreateNew}>
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
