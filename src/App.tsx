import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { ListItem, Profile, ScreenName, UiLang } from './types';
import { detectLang, t } from './i18n';
import { ProfilePicker } from './screens/ProfilePicker';
import { Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { ShowDetail } from './screens/ShowDetail';
import { TasteProfile } from './screens/TasteProfile';
import { Recommendations } from './screens/Recommendations';
import { ShowPicker } from './components/ShowPicker';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { DevBar } from './components/DevBar';
import { NotificationProvider } from './components/Notifications';

/** Tab icons, shown in the mobile bottom bar (hidden on desktop). */
const NAV_ICONS: Record<ScreenName, ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </svg>
  ),
  taste: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </svg>
  ),
  recommendations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 21 12z" />
    </svg>
  ),
  picker: null,
  onboarding: null,
  detail: null,
};

const NAV: { screen: ScreenName; labelKey: 'navHome' | 'navTaste' | 'navRecs' }[] = [
  { screen: 'home', labelKey: 'navHome' },
  { screen: 'taste', labelKey: 'navTaste' },
  { screen: 'recommendations', labelKey: 'navRecs' },
];

/** A profile gates to onboarding until the bootstrap minimum is complete. */
function isIncomplete(p: Profile): boolean {
  return Boolean(p.bootstrap && !p.bootstrap.complete);
}

export function App() {
  const [lang, setLang] = useState<UiLang>(() => detectLang());
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesStub, setProfilesStub] = useState(false);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [onboardingProfile, setOnboardingProfile] = useState<Profile | null>(null);
  const [screen, setScreen] = useState<ScreenName>('picker');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailItem, setDetailItem] = useState<ListItem | null>(null);
  const [addWatchedOpen, setAddWatchedOpen] = useState(false);
  const [homeKey, setHomeKey] = useState(0);
  // Dev-deployment identity, from the Worker's runtime flag (same
  // bundle serves production and dev — nothing here is build-time).
  const [isDev, setIsDev] = useState(false);
  const [serverProvider, setServerProvider] = useState('unknown');

  useEffect(() => {
    // The health check decides dev identity; a failed check means
    // "not dev" (never show dev UI on an unknown deployment).
    api
      .health()
      .then((res) => {
        setIsDev(Boolean(res.dev));
        setServerProvider(res.llmProvider ?? 'unknown');
      })
      .catch(() => {
        setIsDev(false);
      });
  }, []);

  // Bilingual by design (spec §8): default from the browser, switchable,
  // layout mirrors fully in RTL.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.title = (isDev ? '[DEV] ' : '') + t(lang, 'appName');
  }, [lang, isDev]);

  useEffect(() => {
    void loadProfiles();
  }, []);

  const loadProfiles = (): Promise<Profile[]> => {
    return api
      .profiles()
      .then((res) => {
        setProfiles(res.profiles);
        setProfilesStub(Boolean(res.stub));
        return res.profiles;
      })
      .catch(() => {
        setProfiles([]);
        return [];
      });
  };

  const handleProfileChanged = (updated: Profile) => {
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setActiveProfile((prev) => (prev && prev.id === updated.id ? updated : prev));
  };

  const openShow = (tmdbId: number, item?: ListItem) => {
    setDetailId(tmdbId);
    // The list item carries the rationale + classification chips, which
    // live in detail now that rail cards are compact. Opened from
    // anywhere else (search), there is no list context.
    setDetailItem(item ?? null);
    setScreen('detail');
  };

  /**
   * The onboarding gate: entering a profile that has not completed the
   * bootstrap minimum resumes the creation flow instead of the main
   * screen. The main nav and switcher stay hidden until it completes.
   */
  const enterProfile = (p: Profile) => {
    setDetailId(null);
    setDetailItem(null);
    if (isIncomplete(p)) {
      setActiveProfile(null);
      setOnboardingProfile(p);
      setScreen('onboarding');
      return;
    }
    setOnboardingProfile(null);
    setActiveProfile(p);
    setScreen('home');
  };

  const exitToPicker = () => {
    setActiveProfile(null);
    setOnboardingProfile(null);
    setDetailId(null);
    setDetailItem(null);
    setScreen('picker');
    void loadProfiles();
  };

  const handleOnboardingDone = (profile: Profile) => {
    void loadProfiles().then((fresh) => {
      const updated = fresh.find((p) => p.id === profile.id) ?? profile;
      setOnboardingProfile(null);
      setActiveProfile(updated);
      setScreen('home');
    });
  };

  const closeAddWatched = () => {
    setAddWatchedOpen(false);
    // Home remounts and reloads its lists (cheap when stored; a fresh
    // generation when the new ratings invalidated them).
    setHomeKey((k) => k + 1);
  };

  return (
    <NotificationProvider lang={lang}>
    <div className="app">
      {isDev ? (
        <DevBar lang={lang} serverProvider={serverProvider} />
      ) : null}
      <header className="header">
        <div className="header-title">
          <h1>{t(lang, 'appName')}</h1>
          {lang === 'he' ? <div className="header-sub">SHOW RECOMMENDER</div> : null}
          <p className="muted">{t(lang, 'tagline')}</p>
        </div>
        <div className="header-controls">
          {activeProfile ? (
            <ProfileSwitcher
              lang={lang}
              profiles={profiles}
              active={activeProfile}
              onSelect={enterProfile}
            />
          ) : null}
          <div className="lang-toggle" role="group" aria-label="Language / שפה">
            <button
              type="button"
              className={lang === 'en' ? 'btn btn-primary' : 'btn'}
              onClick={() => setLang('en')}
            >
              EN
            </button>
            <button
              type="button"
              className={lang === 'he' ? 'btn btn-primary' : 'btn'}
              onClick={() => setLang('he')}
            >
              HE
            </button>
          </div>
        </div>
      </header>

      {activeProfile && screen !== 'picker' ? (
        <nav className="nav" aria-label={t(lang, 'appName')}>
          {NAV.map((n) => (
            <button
              key={n.screen}
              type="button"
              className={screen === n.screen || (n.screen === 'home' && screen === 'detail') ? 'btn btn-primary' : 'btn'}
              onClick={() => setScreen(n.screen)}
            >
              {NAV_ICONS[n.screen]}
              <span>{t(lang, n.labelKey)}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <main>
        {screen === 'picker' || (!activeProfile && screen !== 'onboarding') ? (
          <ProfilePicker
            lang={lang}
            profiles={profiles}
            stub={profilesStub}
            onSelect={enterProfile}
            onCreateNew={() => {
              setOnboardingProfile(null);
              setScreen('onboarding');
            }}
          />
        ) : screen === 'onboarding' ? (
          <Onboarding
            lang={lang}
            onLangChange={setLang}
            profile={onboardingProfile}
            onDone={handleOnboardingDone}
            onExit={exitToPicker}
          />
        ) : screen === 'home' && activeProfile ? (
          <Home
            key={homeKey}
            lang={lang}
            profile={activeProfile}
            onOpenShow={openShow}
            onProfileChanged={handleProfileChanged}
            onRateShow={() => setAddWatchedOpen(true)}
          />
        ) : screen === 'detail' && detailId != null && activeProfile ? (
          <ShowDetail lang={lang} profile={activeProfile} tmdbId={detailId} listItem={detailItem} onBack={() => setScreen('home')} />
        ) : screen === 'taste' && activeProfile ? (
          <TasteProfile lang={lang} profile={activeProfile} onProfileChanged={handleProfileChanged} />
        ) : screen === 'recommendations' && activeProfile ? (
          <Recommendations lang={lang} profile={activeProfile} />
        ) : activeProfile ? (
          <Home
            key={homeKey}
            lang={lang}
            profile={activeProfile}
            onOpenShow={openShow}
            onProfileChanged={handleProfileChanged}
            onRateShow={() => setAddWatchedOpen(true)}
          />
        ) : (
          <ProfilePicker
            lang={lang}
            profiles={profiles}
            stub={profilesStub}
            onSelect={enterProfile}
            onCreateNew={() => {
              setOnboardingProfile(null);
              setScreen('onboarding');
            }}
          />
        )}
      </main>

      {addWatchedOpen && activeProfile ? (
        <div className="dialog-backdrop dialog-backdrop--top" onClick={closeAddWatched}>
          <div
            className="dialog dialog--anchored"
            role="dialog"
            aria-modal="true"
            aria-label={t(lang, 'rateShow')}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{t(lang, 'rateShow')}</h2>
            <ShowPicker lang={lang} profile={activeProfile} mode="add" onClose={closeAddWatched} />
          </div>
        </div>
      ) : null}

      <footer className="footer">
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
          <img
            src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
            alt="The Movie Database (TMDB)"
            width="92"
            height="13"
          />
        </a>
        <p className="muted">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
      </footer>
    </div>
    </NotificationProvider>
  );
}
