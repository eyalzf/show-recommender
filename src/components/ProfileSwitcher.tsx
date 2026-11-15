import { useEffect, useRef, useState } from 'react';
import type { Profile, UiLang } from '../types';
import { t } from '../i18n';
import { ProfileIcon } from './ProfileIcon';

interface Props {
  lang: UiLang;
  profiles: Profile[];
  active: Profile;
  onSelect: (profile: Profile) => void;
}

/**
 * Profile switcher: a dropdown (a native <select> cannot show icons).
 * The button shows the current profile's icon + name; the menu lists
 * every profile with its icon. Closes on outside click, Escape, or
 * selection.
 */
export function ProfileSwitcher({ lang, profiles, active, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  return (
    <div className="profile-switcher" ref={rootRef}>
      <button
        type="button"
        className="profile-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(lang, 'whoWatching')}
      >
        <ProfileIcon profile={active} size={28} className="profile-icon profile-icon-sm" />
        <span className="profile-switcher-name">{active.name}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div className="profile-menu" role="menu">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={`profile-menu-item${p.id === active.id ? ' is-active' : ''}`}
              onClick={() => {
                setOpen(false);
                if (p.id !== active.id) onSelect(p);
              }}
            >
              <ProfileIcon profile={p} size={28} className="profile-icon profile-icon-sm" />
              <span className="profile-switcher-name">{p.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
