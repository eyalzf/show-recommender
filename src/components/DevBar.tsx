import { t } from '../i18n';
import type { DevProviderChoice } from '../api';
import type { UiLang } from '../types';

/**
 * Dev-deployment bar — rendered ONLY when the Worker reports dev=true
 * via /api/health (see App). Same bundle serves production, where this
 * component never mounts. The switch picks the LLM provider for this
 * tab's session: the deterministic mock (zero neurons) or the cheap
 * 8B model. The backend honors the choice only on the dev Worker.
 */
export function DevBar({
  lang,
  serverProvider,
  choice,
  onChoice,
}: {
  lang: UiLang;
  serverProvider: string;
  choice: DevProviderChoice | null;
  onChoice: (choice: DevProviderChoice) => void;
}) {
  const effective = choice ?? (serverProvider === 'mock' ? 'mock' : null);
  return (
    <div className="dev-wrap" role="note" aria-label="DEV">
      <div className="dev-banner">{t(lang, 'devBanner')}</div>
      <div className="dev-bar">
        <span className="dev-label">{t(lang, 'devProviderLabel')}</span>
        <div className="dev-switch" role="group" aria-label={t(lang, 'devProviderLabel')}>
          <button
            type="button"
            className={effective === 'mock' ? 'btn btn-primary' : 'btn'}
            onClick={() => onChoice('mock')}
          >
            {t(lang, 'devMock')}
          </button>
          <button
            type="button"
            className={effective === 'cheap' ? 'btn btn-primary' : 'btn'}
            onClick={() => onChoice('cheap')}
          >
            {t(lang, 'devCheap')}
          </button>
        </div>
        <span className="dev-meta muted">
          {t(lang, 'devDefault')}: {serverProvider}
        </span>
        <span className="dev-meta muted">{t(lang, 'devProviderNote')}</span>
      </div>
      <div className="dev-watermark" aria-hidden="true">
        DEV
      </div>
    </div>
  );
}
