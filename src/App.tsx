import { useEffect, useState } from 'react';
import { api } from './api';
import type { Profile, ScreenName, UiLang } from './types';
import { detectLang, t } from './i18n';
import { ProfilePicker } from './screens/ProfilePicker';
import { Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { ShowDetail } from './screens/ShowDetail';
import { TasteProfile } from './screens/TasteProfile';
import { Recommendations } from './screens/Recommendations';
import { AdHoc } from './screens/AdHoc';
import { ShowPicker } from './components/ShowPicker';

const NAV: { screen: ScreenName; labelKey: 'navHome' | 'navTaste' | 'navRecs' | 'navAdhoc' }[] = [
  { screen: 'home', labelKey: 'navHome' },
  { screen: 'taste', labelKey: 'navTaste' },
  { screen: 'recommendations', labelKey: 'navRecs' },
  { screen: 'adhoc', labelKey: 'navAdhoc' },
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
  const [addWatchedOpen, setAddWatchedOpen] = useState(false);
  const [homeKey, setHomeKey] = useState(0);

  // Bilingual by design (spec §8): default from the browser, switchable,
  // layout mirrors fully in RTL.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.title = t(lang, 'appName');
  }, [lang]);

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

  const openShow = (tmdbId: number) => {
    setDetailId(tmdbId);
    setScreen('detail');
  };

  /**
   * The onboarding gate: entering a profile that has not completed the
   * bootstrap minimum resumes the creation flow instead of the main
   * screen. The main nav and switcher stay hidden until it completes.
   */
  const enterProfile = (p: Profile) => {
    setDetailId(null);
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
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>{t(lang, 'appName')}</h1>
          <p className="muted">{t(lang, 'tagline')}</p>
        </div>
        <div className="header-controls">
          {activeProfile ? (
            <label className="profile-switcher">
              <select
                value={activeProfile.id}
                onChange={(e) => {
                  const p = profiles.find((x) => x.id === e.target.value);
                  if (p) enterProfile(p);
                }}
                aria-label={t(lang, 'whoWatching')}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
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
              {t(lang, n.labelKey)}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setAddWatchedOpen(true)}
          >
            + {t(lang, 'navAddWatched')}
          </button>
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
            onAdhoc={() => setScreen('adhoc')}
          />
        ) : screen === 'detail' && detailId != null && activeProfile ? (
          <ShowDetail lang={lang} profile={activeProfile} tmdbId={detailId} onBack={() => setScreen('home')} />
        ) : screen === 'taste' && activeProfile ? (
          <TasteProfile lang={lang} profile={activeProfile} onProfileChanged={handleProfileChanged} />
        ) : screen === 'recommendations' && activeProfile ? (
          <Recommendations lang={lang} profile={activeProfile} />
        ) : activeProfile ? (
          <AdHoc lang={lang} profile={activeProfile} onOpenShow={openShow} />
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
        <div className="dialog-backdrop" onClick={closeAddWatched}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t(lang, 'addWatchedTitle')}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{t(lang, 'addWatchedTitle')}</h2>
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
  );
}
