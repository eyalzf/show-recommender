import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile, UiLang } from '../types';
import { ApiError } from '../types';
import { t } from '../i18n';
import { useNotify } from '../components/Notifications';

interface Props {
  lang: UiLang;
  profile: Profile;
}

/**
 * Mock 6 — External recommendations: personal (1+ names, auto-fill from
 * previous names) or generic (no named source); inbox + people ranking.
 * Trust is learned implicitly — no stars, sliders, or tiers anywhere.
 */
export function Recommendations({ lang, profile }: Props) {
  const { notify } = useNotify();
  const [kind, setKind] = useState<'personal' | 'generic'>('personal');
  const [showTitle, setShowTitle] = useState('');
  const [names, setNames] = useState<string[]>(['']);
  const [note, setNote] = useState('');
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [inbox, setInbox] = useState<
    { id: string; showTitle: string; kind: string; names: string[]; note: string; outcome: string | null; retrospective: boolean }[]
  >([]);
  const [ranking, setRanking] = useState<
    { name: string; recommended: number; liked: number; disliked: number; dropped: number }[]
  >([]);
  const [stub, setStub] = useState(false);

  const load = () => {
    api.recommendations(profile.id).then((res) => {
      setInbox(res.inbox);
      setRanking(res.peopleRanking);
      setKnownNames(res.knownNames);
      setStub(Boolean(res.stub));
    });
  };

  useEffect(() => {
    load();
  }, [profile.id]);

  const save = async () => {
    const cleanNames = kind === 'personal' ? [...new Set(names.map((n) => n.trim()).filter(Boolean))] : [];
    if (!showTitle.trim() || (kind === 'personal' && cleanNames.length === 0)) return;
    try {
      await api.addRecommendation(profile.id, showTitle.trim(), kind, cleanNames, note);
      setShowTitle('');
      setNames(['']);
      setNote('');
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'database_not_configured') {
        notify(t(lang, 'notSaved'), { kind: 'error' });
      } else {
        notify(t(lang, 'searchError'), { kind: 'error' });
      }
    }
  };

  return (
    <section>
      <h2>{t(lang, 'recsTitle')}</h2>
      {stub ? <p className="demo-badge">{t(lang, 'demoData')}</p> : null}

      <h3>{t(lang, 'recsAdd')}</h3>
      <div className="rating-row" role="group">
        <button type="button" className={kind === 'personal' ? 'btn btn-primary' : 'btn'} onClick={() => setKind('personal')}>
          {t(lang, 'recsPersonal')}
        </button>
        <button type="button" className={kind === 'generic' ? 'btn btn-primary' : 'btn'} onClick={() => setKind('generic')}>
          {t(lang, 'recsGeneric')}
        </button>
      </div>
      <input
        type="text"
        value={showTitle}
        onChange={(e) => setShowTitle(e.target.value)}
        placeholder={t(lang, 'recsShowPlaceholder')}
        aria-label={t(lang, 'recsShowPlaceholder')}
      />
      {kind === 'personal' ? (
        <>
          <datalist id="known-names">
            {knownNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {names.map((name, i) => (
            <input
              key={i}
              type="text"
              list="known-names"
              value={name}
              onChange={(e) => setNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
              placeholder={t(lang, 'recsWhoPlaceholder')}
              aria-label={t(lang, 'recsWhoPlaceholder')}
            />
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => setNames((prev) => [...prev, ''])}>
            {t(lang, 'recsAddName')}
          </button>
        </>
      ) : null}
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t(lang, 'recsNotePlaceholder')}
        aria-label={t(lang, 'recsNotePlaceholder')}
      />
      <button type="button" className="btn btn-primary" onClick={save}>
        {t(lang, 'recsSave')}
      </button>

      <h3>{t(lang, 'recsInbox')}</h3>
      <ul className="inbox">
        {inbox.map((item) => (
          <li key={item.id}>
            <strong>{item.showTitle}</strong>
            {item.kind === 'personal' ? ` — ${item.names.join(' + ')}` : ` — ${t(lang, 'recsGeneric')}`}
            {item.note ? ` · ${item.note}` : ''}
            {item.outcome ? ` · ${t(lang, item.outcome as 'liked' | 'disliked' | 'dropped')}` : ''}
          </li>
        ))}
      </ul>

      <h3>{t(lang, 'peopleRanking')}</h3>
      <ol className="ranking">
        {ranking.map((p) => (
          <li key={p.name}>
            <strong>{p.name}</strong> — {p.recommended} · {p.liked} {t(lang, 'liked')} · {p.disliked}{' '}
            {t(lang, 'disliked')} · {p.dropped} {t(lang, 'dropped')}
          </li>
        ))}
      </ol>
    </section>
  );
}
