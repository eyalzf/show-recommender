import type { Profile, UiLang } from '../types';
import { t } from '../i18n';

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
      <div className="profile-grid">
        {profiles.map((p) => {
          const incomplete = p.bootstrap && !p.bootstrap.complete;
          return (
            <button key={p.id} type="button" className="profile-card" onClick={() => onSelect(p)}>
              {renderIcon(p)}
              <span className="profile-name">{p.name}</span>
              {incomplete ? (
                <span className="profile-meta">{t(lang, 'setupIncomplete')}</span>
              ) : (
                <span className="profile-meta">
                  {p.noteCount ?? 0} · {p.listsUpdatedAt ?? t(lang, 'neverUpdated')}
                </span>
              )}
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
