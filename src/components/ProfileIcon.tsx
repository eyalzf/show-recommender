import type { Profile } from '../types';

/**
 * The one profile-icon renderer, shared by the picker, the header
 * switcher, and any other surface that lists profiles: an uploaded
 * image (R2-backed, served via the icon route), a preset emoji icon,
 * or a styled initial — never a blank or broken image.
 */
export function ProfileIcon({
  profile,
  size = 48,
  className = 'profile-icon',
}: {
  profile: Profile;
  size?: number;
  className?: string;
}) {
  if (profile.iconKind === 'image' && profile.iconRef) {
    return (
      <img
        className="profile-icon-img"
        src={`/api/profiles/${encodeURIComponent(profile.id)}/icon`}
        alt=""
        width={size}
        height={size}
      />
    );
  }
  if (profile.iconKind === 'icon' && profile.iconRef) {
    return (
      <span className={className} aria-hidden="true">
        {profile.iconRef}
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {profile.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
