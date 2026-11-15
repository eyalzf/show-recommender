import { useEffect, useState } from 'react';
import { api } from './api';
import type { Profile, ScreenName, UiLang } from './types';
import { detectLang, t } from './i18n';
import { ProfilePicker } from './screens/ProfilePicker';
import { Bootstrap } from './screens/Bootstrap';
import { Home } from './screens/Home';
import { ShowDetail } from './screens/ShowDetail';
import { TasteProfile } from './screens/TasteProfile';
import { Recommendations } from './screens/Recommendations';
import { AdHoc } from './screens/AdHoc';

const NAV: { screen: ScreenName; labelKey: 'navHome' | 'navBootstrap' | 'navTaste' | 'navRecs' | 'navAdhoc' }[] = [
  { screen: 'home', labelKey: 'navHome' },
  { screen: 'bootstrap', labelKey: 'navBootstrap' },
  { screen: 'taste', labelKey: 'navTaste' },
  { screen: 'recommendations', labelKey: 'navRecs' },
  { screen: 'adhoc', labelKey: 'navAdhoc' },
];

export function App() {
  const [lang, setLang] = useState<UiLang>(() => detectLang());
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesStub, setProfilesStub] = useState(false);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [screen, setScreen] = useState<ScreenName>('picker');
  const [detailId, setDetailId] = useState<number | null>(null);

  // Bilingual by design (spec §8): default from the browser, switchable,
  // layout mirrors fully in RTL.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.title = t(lang, 'appName');
  }, [lang]);

  useEffect(() => {
    api
      .profiles()
      .then((res) => {
        setProfiles(res.profiles);
        setProfilesStub(Boolean(res.stub));
      })
      .catch(() => setProfiles([]));
  }, []);

  const openShow = (tmdbId: number) => {
    setDetailId(tmdbId);
    setScreen('detail');
  };

  const switchProfile = (p: Profile) => {
    // Switching re-scopes the entire app (spec §2): lists, taste, and
    // history change together. Nothing leaks between profiles.
    setActiveProfile(p);
    setScreen('home');
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
                  if (p) switchProfile(p);
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
              className={screen === n.screen ? 'btn btn-primary' : 'btn'}
              onClick={() => setScreen(n.screen)}
            >
              {t(lang, n.labelKey)}
            </button>
          ))}
        </nav>
      ) : null}

      <main>
        {screen === 'picker' || !activeProfile ? (
          <ProfilePicker lang={lang} profiles={profiles} stub={profilesStub} onSelect={switchProfile} />
        ) : screen === 'home' ? (
          <Home lang={lang} profile={activeProfile} onOpenShow={openShow} onAdhoc={() => setScreen('adhoc')} />
        ) : screen === 'bootstrap' ? (
          <Bootstrap lang={lang} profile={activeProfile} onDone={() => setScreen('home')} />
        ) : screen === 'detail' && detailId != null ? (
          <ShowDetail lang={lang} profile={activeProfile} tmdbId={detailId} onBack={() => setScreen('home')} />
        ) : screen === 'taste' ? (
          <TasteProfile lang={lang} profile={activeProfile} />
        ) : screen === 'recommendations' ? (
          <Recommendations lang={lang} profile={activeProfile} />
        ) : (
          <AdHoc lang={lang} profile={activeProfile} onOpenShow={openShow} />
        )}
      </main>

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
